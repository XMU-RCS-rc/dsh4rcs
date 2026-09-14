/**
 * dsh-rcs-kb —— 队内飞书资料的同步与离线检索。
 *
 * ## 三条设计约束
 *
 * 1. **同步与检索解耦。** 飞书 API 随时可能不可达、限频或改版，而查资料
 *    这件事不该受它牵连。所以检索永远读本地镜像，绝不实时打 API。
 *    同步是另一件事，另一个工具。
 *
 * 2. **范围收敛在本地白名单。** 实测应用能读到整个共享文件夹根目录（含机械、
 *    运营、赛务），飞书侧没有做到目录级隔离。于是 `feishu.sources` 这份清单
 *    **就是授权范围本身**，同步器只遍历它的子树，越界当场抛。
 *
 * 3. **同步是 L1 操作**（出网 + 落盘，见 `rcs-core/danger.ts`），检索是 L0。
 *    当前两种 guard 模式都放行 L1，这个分级眼下只是台账，不改变判定。
 *
 * 适配层照例做薄：判断逻辑全在 `@rcs/core` 的 `kb-sync` / `kb-index` 里，
 * 这里只负责包成 Tool 和渲染。
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView, ToolResult } from '@deepseek-ai/dsh-tools'

import { HttpFeishuClient, FeishuPermissionError, describeScopes } from '../../rcs-core/src/feishu.ts'
import { syncKnowledgeBase, DEFAULT_SYNC_POLICY } from '../../rcs-core/src/kb-sync.ts'
import type { KbSource, SyncPolicy, SyncResult } from '../../rcs-core/src/kb-sync.ts'
import { searchKb, kbStatus, queryTerms } from '../../rcs-core/src/kb-index.ts'
import type { KbHit, KbStatus } from '../../rcs-core/src/kb-index.ts'
import { TeamContext } from '../../rcs-core/src/team-context.ts'
import type { FeishuConfig } from '../../rcs-core/src/team-context.ts'
import { repoPaths } from '../../rcs-core/src/paths.ts'

export const name = 'rcs-kb'
export const inject = ['tools']

export interface Config {
  /** `config/team.json` 的路径。飞书配置从这里读 —— 单一真相来源。 */
  teamConfig: string
  /** 覆盖镜像目录；留空用 team.json 里的。 */
  cacheDir: string
  /** 存放 app_secret 的环境变量名。**密钥本身永远不进配置。** */
  appSecretEnv: string
}

export const Config: Schema<Config> = Schema.object({
  // 默认留空 —— 回落到本仓库的 config/team.json（见 rcs-core/paths.ts）。
  // 写死绝对路径在别人机器上一个都不存在，而且失败方式很难懂。
  teamConfig: Schema.string().default(''),
  cacheDir: Schema.string().default(''),
  appSecretEnv: Schema.string().default('FEISHU_APP_SECRET'),
})

const DISCLAIMER = '内容来自队内飞书镜像，可能落后于线上版本；关键结论请回原文核对。'

function callView(title: string, input: unknown): ToolCallView {
  return { card: 'generic', title, kind: 'search', rawInput: input }
}

// ---------- 渲染 ----------

/**
 * rcs_kb_sync 交给宿主的返回值。**不带 manifest** —— 那是整份镜像目录（几百 KB），
 * 既不该塞进模型上下文，也不在输出 schema 里：dsh 会以「未声明的字段」判整次调用失败。
 * 渲染要用的授权范围与按类型跳过数单独拎出来。
 */
export type SyncOutput = {
  stats: SyncResult['stats']
  failures: SyncResult['failures']
  sources: SyncResult['manifest']['sources']
  skippedByType: Record<string, number>
  permissionHint?: NonNullable<SyncResult['permissionHint']>
}

export function syncOutput(r: SyncResult): SyncOutput {
  return {
    stats: r.stats,
    failures: r.failures,
    sources: r.manifest.sources,
    skippedByType: r.manifest.skippedByType ?? {},
    ...(r.permissionHint ? { permissionHint: r.permissionHint } : {}),
  }
}

/**
 * 参数收宽松类型：render 拿到的是会话里存着的值，回放旧会话时可能是旧形状
 * （修之前 rcs_kb_sync 回传的是整份 manifest）。渲染钩子按契约不得抛异常，所以全程给默认值。
 */
function renderSync(r: Partial<SyncOutput> & { manifest?: Partial<SyncResult['manifest']> }): string {
  const s = { added: 0, updated: 0, unchanged: 0, failed: 0, removed: 0, folders: 0, ...(r.stats ?? {}) }
  const head =
    `飞书同步完成 —— 遍历 ${s.folders} 个目录\n` +
    `新增 ${s.added}  更新 ${s.updated}  未变 ${s.unchanged}  失败 ${s.failed}  已删除 ${s.removed}`

  const skipped = Object.entries(r.skippedByType ?? r.manifest?.skippedByType ?? {})
  const skipLine =
    skipped.length > 0
      ? `\n按类型跳过：${skipped.map(([k, n]) => `${k}×${n}`).join('  ')}（见 sync.excludeTypes）`
      : ''

  const scope = `\n授权范围：${(r.sources ?? r.manifest?.sources ?? []).map((x) => x.label).join('、')}`

  const failures = r.failures ?? []
  let fail = ''
  if (failures.length > 0) {
    const lines = failures.slice(0, 10).map((f) => `  · ${f.path} —— ${String(f.reason ?? '').slice(0, 120)}`)
    const more = failures.length > 10 ? `\n  … 另有 ${failures.length - 10} 条` : ''
    fail = `\n\n抓取失败 ${failures.length} 条：\n${lines.join('\n')}${more}`
  }

  let hint = ''
  if (r.permissionHint) {
    // 只呈现该开的那一个（只读）。飞书返回的是「任选其一」的候选集，
    // 原样列出会让人误以为读写版也要开 —— 那是本工具不需要的写权限。
    hint =
      '\n\n⚠️ 失败原因是权限不足。\n' +
      `   要开通的权限：${describeScopes(r.permissionHint.scopes)}\n` +
      (r.permissionHint.authLink ? `   申请链接（已指向只读版）：${r.permissionHint.authLink}\n` : '') +
      '   勾完需发版并等管理员审批。'
  }

  return `${head}${skipLine}${scope}${fail}${hint}\n\n${DISCLAIMER}`
}

/** 一句话说明这篇为什么被选中。宁可啰嗦，也不能把模糊匹配说成精确命中。 */
function whyMatched(h: KbHit): string {
  const m = h.matchedIn ?? []
  if (m.includes('name')) return '标题命中'
  if (m.includes('path')) return '目录名命中'
  if (m.includes('text')) return '正文命中'
  return '仅相关度匹配，未出现原词'
}

function renderSearch(query: string, hits: KbHit[]): string {
  if (hits.length === 0) {
    return (
      `本地镜像里没有检索到与「${query}」相关的内容。\n` +
      '注意：查不到可能是**还没同步**或**不在授权范围内**，不代表队里没有这份资料。\n' +
      '可以把检索词拆成空格分开的几个短词再查（连着写的长词要原样出现在原文里才命中），\n' +
      '或先用 rcs_kb_status 看镜像状态。'
    )
  }
  const terms = queryTerms(query)
  const body = hits
    .map((h) => {
      // 多个关键词时写明这篇命中了哪几个、没找到哪几个 —— 只沾一个词的和全都对上的不是一回事
      const matched = h.terms ?? []
      const missing = terms.filter((t) => !matched.includes(t))
      const which =
        terms.length > 1
          ? `  命中：${matched.join('、') || '—'}${missing.length > 0 ? `；没找到：${missing.join('、')}` : ''}`
          : ''
      const head = `[${h.doc.path}]${which}`
      // 没有片段时要**如实说明命中来源**。早先一律写成「标题命中」，
      // 于是靠模糊匹配捞上来的结果也被说成标题命中 —— 那是在骗读者。
      const snips =
        h.snippets.length > 0
          ? h.snippets.map((s) => `    ${s}`).join('\n')
          : `    （${whyMatched(h)}，正文无直接命中）`
      const link = h.doc.url ? `\n    原文：${h.doc.url}` : ''
      return `${head}\n${snips}${link}`
    })
    .join('\n\n')
  return `检索「${query}」，命中 ${hits.length} 篇：\n\n${body}\n\n${DISCLAIMER}`
}

/** 同 renderSync：收宽松类型、全程给默认值，回放旧会话时不得抛。 */
function renderStatus(s: Partial<KbStatus>): string {
  if (!s.ok) return `镜像不可用：${s.reason ?? '原因未知'}`
  const kb = ((s.bytes ?? 0) / 1024).toFixed(1)
  const skipped = Object.entries(s.skippedByType ?? {})
  return (
    `本地镜像状态\n` +
    `最后同步：${s.syncedAt ?? '未知'}\n` +
    `文档 ${s.total ?? 0} 篇（其中 ${s.failed ?? 0} 篇抓取失败）  正文合计 ${kb} KB\n` +
    `授权范围：${(s.sources ?? []).map((x) => x.label).join('、')}\n` +
    (skipped.length > 0 ? `按类型跳过：${skipped.map(([k, n]) => `${k}×${n}`).join('  ')}\n` : '') +
    `\n检索走本地镜像，不联网 —— 没网也能查。`
  )
}

// ---------- 结果卡片 ----------

/**
 * 检索结果套搜索卡片：一篇文档 = 一个可折叠分组，片段 = 匹配行。
 * 文档天然是「名字 + 若干片段」，与搜索卡片同构，白拿折叠与跳转。
 */
type SearchMeta = {
  kind: 'rcs-kb-search'
  query: string
  hits: { path: string; snippets: string[] }[]
}

function isSearchMeta(v: unknown): v is SearchMeta {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { kind?: unknown }).kind === 'rcs-kb-search' &&
    Array.isArray((v as { hits?: unknown }).hits)
  )
}

function searchResultView(result: ToolResult): ToolResultView | undefined {
  const meta = result.meta
  if (!isSearchMeta(meta)) return undefined
  if (meta.hits.length === 0) {
    return { card: 'generic', title: `知识库检索「${meta.query}」— 无命中` }
  }
  return {
    card: 'search',
    shape: 'matches',
    title: `知识库检索「${meta.query}」— ${meta.hits.length} 篇`,
    files: meta.hits.map((h) => ({
      path: h.path,
      matches: h.snippets.map((line, i) => ({ lineNumber: i + 1, line })),
    })),
    truncated: false,
    total: meta.hits.length,
  }
}

// ---------- 配置解析 ----------

/**
 * core 插件（`dsh-rcs-core`）共享上下文的最小结构。
 * 刻意不 import 它的类型 —— 一 import 就在构建期把两个插件绑死，
 * 而设计上它们要能各自独立安装。
 */
interface RcsShared {
  kbCacheDir?: string
  feishu?: FeishuConfig
}

/** 可选依赖：每次调用都重新探测，不缓存 —— core 可能比本插件晚加载或被重载。 */
function shared(ctx: Context): RcsShared | undefined {
  try {
    const get = (ctx as unknown as { get?: (n: string) => RcsShared | undefined }).get
    return typeof get === 'function' ? get.call(ctx, 'rcs') : undefined
  } catch {
    return undefined
  }
}

export function apply(ctx: Context, config: Config): void {
  /** 飞书配置：core 共享的优先，否则自己读 team.json。 */
  const feishuConfig = (): FeishuConfig => {
    const fromCore = shared(ctx)?.feishu
    if (fromCore) return fromCore
    const teamFile = config.teamConfig || repoPaths.teamConfig()
    const team = TeamContext.fromFile(teamFile)
    if (!team.feishu) {
      throw new Error(
        `${teamFile} 里没有 feishu 配置段。\n` +
          '需要 appId、appSecretEnv、sources、cacheDir —— 见 docs/feishu-setup.md。',
      )
    }
    return team.feishu
  }

  /** 镜像目录：插件配置 > core 共享 > team.json > 本仓库的 data/kb-cache。 */
  const cacheDir = (): string => {
    const fromConfigOrCore = config.cacheDir || shared(ctx)?.kbCacheDir
    if (fromConfigOrCore) return fromConfigOrCore
    const teamFile = config.teamConfig || repoPaths.teamConfig()
    return TeamContext.fromFile(teamFile).kbCacheDir
  }

  const policyOf = (fc: FeishuConfig): SyncPolicy => ({ ...DEFAULT_SYNC_POLICY, ...(fc.sync ?? {}) })

  ctx.tools.register(
    defineTool({
      name: 'rcs_kb_search',
      description:
        '检索队内飞书资料的**本地镜像**（电控组文档、历年技术积累、培训资料等）。' +
        '完全离线，不联网 —— 没网也照样能用。' +
        '查不到时要注意区分「镜像里没有」和「队里没有」：前者可能只是还没同步。',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: '检索关键词，支持中文。多个关键词用空格分开（如「Keil 安装」），各自匹配、命中多的排前',
        },
        limit: { type: 'number', description: '返回条数上限，默认 8' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', description: '检索词' },
            hits: { type: 'json', description: '命中的文档与片段' },
          },
        },
        render: (_args, value) => {
          const v = value as unknown as { query: string; hits: KbHit[] }
          return [{ type: 'text', text: renderSearch(v.query ?? '', v.hits ?? []) }]
        },
        presentationMeta: (_args, value) => {
          const v = value as unknown as { query: string; hits: KbHit[] }
          const meta: SearchMeta = {
            kind: 'rcs-kb-search',
            query: v.query ?? '',
            hits: (v.hits ?? []).map((h) => ({
              path: h.doc.path,
              snippets: h.snippets.length > 0 ? h.snippets : [h.doc.name],
            })),
          }
          return meta as unknown as never
        },
      },
      presentCall: (args) => callView('检索队内资料', args.query),
      presentResult: (_args, result) => searchResultView(result),
      async execute(args) {
        const hits = searchKb(cacheDir(), args.query, args.limit ?? 8)
        return { query: args.query, hits } as unknown as never
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rcs_kb_status',
      description:
        '查看本地飞书镜像的状态：上次同步时间、文档数、授权范围、按类型跳过的数量。' +
        '检索查不到东西时先看这个 —— 区分「没同步」和「真没有」。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          // 字段要和 kbStatus 的返回值一一对应：dsh 会校验返回值，多一个没声明的字段整次调用就判失败
          properties: {
            ok: { type: 'boolean', description: '镜像是否可用' },
            reason: { type: 'string', description: '镜像不可用时的原因与下一步' },
            total: { type: 'number', description: '文档数' },
            syncedAt: { type: 'string', description: '上次同步时间' },
            failed: { type: 'number', description: '抓取失败、正文缺失的条目数' },
            bytes: { type: 'number', description: '正文合计字节数' },
            sources: { type: 'json', description: '授权范围（同步来源目录）' },
            skippedByType: { type: 'json', description: '按类型跳过的数量' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderStatus(value as unknown as KbStatus) }],
      },
      presentCall: () => callView('查看镜像状态', cacheDirSafe()),
      async execute() {
        return kbStatus(cacheDir()) as unknown as never
      },
    }),
  )

  /** presentCall 不得抛异常（回放时也会调用），所以单独包一层。 */
  function cacheDirSafe(): string {
    try {
      return cacheDir()
    } catch {
      return '(未配置)'
    }
  }

  ctx.tools.register(
    defineTool({
      name: 'rcs_kb_sync',
      description:
        '把队内飞书资料同步到本地镜像。**联网 + 写盘**，属 L1 操作。' +
        '只遍历 config/team.json 里 feishu.sources 列出的目录子树 —— 那份清单就是授权范围。' +
        '增量同步：文档没改过就不重抓。',
      parameters: {
        force: { type: 'boolean', description: '忽略增量判断，全量重抓' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          // 返回的是 syncOutput 投影，字段与这里一一对应；整份 manifest 不回传
          properties: {
            stats: { type: 'json', description: '新增/更新/未变/失败计数' },
            failures: { type: 'json', description: '抓取失败的条目' },
            sources: { type: 'json', description: '授权范围（同步来源目录）' },
            skippedByType: { type: 'json', description: '按类型跳过的数量' },
            permissionHint: { type: 'json', description: '权限不足时要开的权限与申请链接' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderSync(value as unknown as SyncOutput) }],
      },
      presentCall: (args) => callView('同步飞书资料', args.force ? '全量' : '增量'),
      async execute(args) {
        const fc = feishuConfig()
        const secretEnv = fc.appSecretEnv || config.appSecretEnv
        const secret = process.env[secretEnv]
        if (!secret) {
          throw new Error(
            `环境变量 ${secretEnv} 没有值，拿不到 app_secret。\n` +
              '密钥只从环境变量读 —— 不放配置文件（会进 git）、不走命令行参数（会进 shell 历史）。\n' +
              '刚设过环境变量的话，要重开终端才生效。',
          )
        }

        const sources: KbSource[] = fc.sources ?? []
        // 限速可调：整次同步的耗时几乎全在目录列举上（实测 300 个目录 / 125 秒），
        // 而不是抓正文。飞书的配额其实宽裕，觉得慢就把 minIntervalMs 调小。
        const client = new HttpFeishuClient(
          { appId: fc.appId, appSecret: secret },
          { minIntervalMs: fc.minIntervalMs },
        )

        try {
          const result = await syncKnowledgeBase({
            client,
            sources,
            policy: policyOf(fc),
            cacheDir: cacheDir(),
            force: args.force === true,
          })
          return syncOutput(result) as unknown as never
        } catch (e) {
          if (e instanceof FeishuPermissionError) {
            throw new Error(
              `飞书权限不足。要开通的权限：${e.scopeAdvice}\n` +
                (e.authLink ? `申请链接（已指向只读版）：${e.authLink}\n` : '') +
                '勾完需发版并等管理员审批。跑 npm run feishu:check 可复查。',
            )
          }
          throw e
        }
      },
    }),
  )

  ctx.effect(() => {
    // 镜像是按需读盘的，没有常驻句柄；HttpFeishuClient 每次同步新建。
    // 将来若加内存索引或文件监听，务必在这里释放。
    return () => {}
  })
}
