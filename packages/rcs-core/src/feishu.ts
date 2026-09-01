/**
 * 飞书云文档客户端 —— 纯逻辑层里唯一碰网络的模块。
 *
 * ## 为什么定义成接口
 *
 * `FeishuClient` 是接口、`HttpFeishuClient` 才是真实实现。同步逻辑
 * （`kb-sync.ts`）只依赖接口，于是能用假 client 完整单测：遍历、白名单、
 * 增量判定这些容易出错的地方全都不需要网络就能验证。
 *
 * ## 凭证只从环境变量来
 *
 * `app_secret` 绝不进配置文件、绝不进命令行参数（会落 shell 历史）。
 * 构造函数要求显式传入，由调用方负责从环境变量读 —— 这样"密钥从哪来"
 * 这件事在代码里是显式的，不会被某个默认值悄悄兜住。
 */

/** 云盘节点。字段名对齐飞书返回，但转成驼峰。 */
export type DriveNode = {
  token: string
  name: string
  /** folder | docx | doc | sheet | bitable | file | shortcut | mindnote | slides */
  type: string
  parentToken: string
  url?: string
  /** unix 秒，字符串形式（飞书就是这么返回的）。增量同步靠它。 */
  modifiedTime?: string
}

export type FolderPage = {
  files: DriveNode[]
  hasMore: boolean
  nextPageToken?: string
}

/** 同步逻辑依赖的最小能力集。 */
export interface FeishuClient {
  listFolder(token: string, pageToken?: string): Promise<FolderPage>
  /** 新版文档（docx）正文纯文本。 */
  docxRawContent(token: string): Promise<string>
  /** 旧版文档（doc）正文。2023 年前建的文档是这种。 */
  legacyDocContent(token: string): Promise<string>
}

/** 权限不足。单独成类型，因为处理方式和别的错完全不同：要引导人去开权限。 */
export class FeishuPermissionError extends Error {
  readonly scopes: string[]
  readonly appId?: string

  constructor(message: string, scopes: string[], appId?: string) {
    super(message)
    this.name = 'FeishuPermissionError'
    this.scopes = scopes
    this.appId = appId
  }

  /** 该申请的那一个 scope —— 只读优先。 */
  get suggestedScope(): string {
    return recommendScope(this.scopes).scope
  }

  /** 面向人的一句话说明：申请哪个、别申请哪个。 */
  get scopeAdvice(): string {
    return describeScopes(this.scopes)
  }

  get authLink(): string | undefined {
    if (!this.appId || !this.suggestedScope) return undefined
    return (
      `https://open.feishu.cn/app/${this.appId}/auth` +
      `?q=${this.suggestedScope}&op_from=openapi&token_type=tenant`
    )
  }
}

/**
 * 从飞书的缺失 scope 候选集里挑出该申请的那一个。
 *
 * 飞书返回的是**「任选其一即可」**的候选集（msg 里写着「开通任一权限即可」），
 * 通常同时含读写版 `docx:document` 与只读版 `docx:document:readonly`。
 * 原样把整个列表打给人看，会让人以为两个都要开 —— 而读写版给的是本工具
 * 根本不需要的写权限。所以**只推荐只读那一个**。
 *
 * 候选集里没有只读项时如实退回第一个，并由 `describeScopes` 标明这一点，
 * 免得静默地推荐了一个写权限。
 */
export function recommendScope(scopes: string[]): { scope: string; readonly: boolean; others: string[] } {
  const ro = scopes.find((s) => s.endsWith(':readonly'))
  const scope = ro ?? scopes[0] ?? ''
  return { scope, readonly: ro !== undefined, others: scopes.filter((s) => s !== scope) }
}

/** 把候选集渲染成一句「申请这个，别申请那些」。 */
export function describeScopes(scopes: string[]): string {
  const { scope, readonly, others } = recommendScope(scopes)
  if (!scope) return '（飞书没有返回具体的权限名）'
  if (readonly) {
    const tail =
      others.length > 0
        ? `（飞书列出的另外 ${others.length} 个是读写权限，任选其一即可 —— **只开这个只读的**）`
        : ''
    return `${scope}${tail}`
  }
  return `${scope} ⚠️ 候选里没有只读版本，开通前请确认它给出的写权限是否可接受`
}

export class FeishuApiError extends Error {
  readonly code: number

  constructor(message: string, code: number) {
    super(message)
    this.name = 'FeishuApiError'
    this.code = code
  }
}

export type FeishuCredentials = {
  appId: string
  /** 由调用方从环境变量读取后传入 —— 本模块不自己碰 process.env。 */
  appSecret: string
}

export type HttpClientOptions = {
  /** 相邻请求最小间隔（毫秒）。飞书有 QPS 限制，串行 + 限速最省心。 */
  minIntervalMs?: number
  /** 网络错误重试次数。实测飞书偶发 ECONNRESET。 */
  retries?: number
  /** 注入 fetch，便于测试。默认用全局 fetch。 */
  fetchImpl?: typeof fetch
  baseUrl?: string
}

const DENIED = 99991672
/** 频率限制。飞书对高频调用返回这个，退避后重试即可。 */
const RATE_LIMITED = 99991400

type ApiEnvelope = {
  code?: number
  msg?: string
  data?: Record<string, unknown>
  tenant_access_token?: string
  expire?: number
}

/** 从 99991672 的 msg 里解析出缺失的 scope 列表。 */
function parseScopes(msg: string | undefined): string[] {
  const inner = /\[([^\]]+)\]/.exec(msg ?? '')?.[1]
  return inner ? inner.split(',').map((s) => s.trim()).filter(Boolean) : []
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class HttpFeishuClient implements FeishuClient {
  readonly appId: string
  readonly #secret: string
  readonly #base: string
  readonly #fetch: typeof fetch
  readonly #minInterval: number
  readonly #retries: number

  #token?: string
  /** token 到期时刻（ms）。提前 60s 视为过期，避免边界上刚好失效。 */
  #tokenExpiry = 0
  /** 上一次请求发出的时刻，用于限速。请求是串行的。 */
  #lastCall = 0

  constructor(creds: FeishuCredentials, options: HttpClientOptions = {}) {
    if (!creds.appId) throw new Error('缺少 app_id')
    if (!creds.appSecret) {
      throw new Error(
        '缺少 app_secret。它必须从环境变量读取（默认 FEISHU_APP_SECRET），' +
          '不放配置文件、不走命令行参数 —— 前者会进 git，后者会进 shell 历史。',
      )
    }
    this.appId = creds.appId
    this.#secret = creds.appSecret
    this.#base = options.baseUrl ?? 'https://open.feishu.cn/open-apis'
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#minInterval = options.minIntervalMs ?? 120
    this.#retries = options.retries ?? 2
  }

  async #accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#tokenExpiry) return this.#token

    const r = await this.#fetch(`${this.#base}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.#secret }),
    })
    const j = (await r.json()) as ApiEnvelope
    if (j.code !== 0 || !j.tenant_access_token) {
      throw new FeishuApiError(
        `获取 tenant_access_token 失败：code=${j.code} ${j.msg ?? ''}。` +
          '检查 app_id 与 app_secret 是否匹配、secret 是否刚重置过。',
        j.code ?? -1,
      )
    }
    this.#token = j.tenant_access_token
    this.#tokenExpiry = Date.now() + Math.max(0, (j.expire ?? 7200) - 60) * 1000
    return this.#token
  }

  /** 串行 + 限速 + 重试的 GET。所有读接口都走这里。 */
  async #get(path: string): Promise<Record<string, unknown>> {
    const token = await this.#accessToken()

    for (let attempt = 0; ; attempt++) {
      const wait = this.#lastCall + this.#minInterval - Date.now()
      if (wait > 0) await sleep(wait)
      this.#lastCall = Date.now()

      let j: ApiEnvelope
      try {
        const r = await this.#fetch(`${this.#base}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        j = (await r.json()) as ApiEnvelope
      } catch (e) {
        // 网络层错误：退避重试。超出次数才抛。
        if (attempt >= this.#retries) {
          throw new FeishuApiError(`网络错误（已重试 ${attempt} 次）：${(e as Error).message}`, -1)
        }
        await sleep(400 * (attempt + 1))
        continue
      }

      if (j.code === 0) return j.data ?? {}

      if (j.code === DENIED) {
        throw new FeishuPermissionError(
          `权限不足：${path}`,
          parseScopes(j.msg),
          this.appId,
        )
      }

      if (j.code === RATE_LIMITED && attempt < this.#retries) {
        await sleep(1000 * (attempt + 1))
        continue
      }

      throw new FeishuApiError(`飞书接口错误 code=${j.code}：${j.msg ?? ''}`, j.code ?? -1)
    }
  }

  async listFolder(token: string, pageToken?: string): Promise<FolderPage> {
    const qs = `folder_token=${encodeURIComponent(token)}&page_size=50` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '')
    const data = await this.#get(`/drive/v1/files?${qs}`)
    const raw = (data['files'] ?? []) as Record<string, string | undefined>[]
    return {
      // 缺字段就退化成空串而不是 undefined —— 下游用 token 当键，
      // 一个 undefined 键会静默污染整份清单。
      files: raw.map((f) => ({
        token: f['token'] ?? '',
        name: f['name'] ?? '(未命名)',
        type: f['type'] ?? 'unknown',
        parentToken: f['parent_token'] ?? token,
        url: f['url'],
        modifiedTime: f['modified_time'],
      })).filter((f) => f.token !== ''),
      hasMore: Boolean(data['has_more']),
      nextPageToken: data['next_page_token'] as string | undefined,
    }
  }

  async docxRawContent(token: string): Promise<string> {
    const data = await this.#get(`/docx/v1/documents/${encodeURIComponent(token)}/raw_content`)
    return (data['content'] as string) ?? ''
  }

  async legacyDocContent(token: string): Promise<string> {
    const data = await this.#get(`/doc/v2/${encodeURIComponent(token)}/content`)
    // 旧版接口返回的是序列化的富文本 JSON，这里只做最朴素的取文本。
    const content = data['content']
    if (typeof content !== 'string') return ''
    return extractLegacyText(content)
  }
}

/**
 * 从旧版文档的富文本 JSON 里抽纯文本。
 *
 * 旧版格式嵌套很深且字段随块类型变化，与其精确建模，不如递归找所有
 * `text` 字段 —— 检索只需要文本，结构信息用不上。
 * 解析失败时返回空串而不是抛：一篇老文档读不出来不该让整次同步失败。
 */
export function extractLegacyText(json: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return ''
  }
  const out: string[] = []
  const visit = (v: unknown): void => {
    if (typeof v === 'string') return
    if (Array.isArray(v)) {
      for (const x of v) visit(x)
      return
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'text' && typeof x === 'string') out.push(x)
        else visit(x)
      }
    }
  }
  visit(parsed)
  return out.join('').replace(/\n{3,}/g, '\n\n').trim()
}
