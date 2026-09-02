/**
 * 版本新鲜度检查 —— 「你手上这份是不是已经过时了」。
 *
 * ## 三件不同的事
 *
 * 仓库里原本所有和版本有关的代码都是**一致性检查**（各处版本对不对得上），
 * 没有一处回答**新鲜度**（上游有没有更新的）。这三件事各自的可行性差别很大：
 *
 *   1. **规则书** —— 后果最严重，但**没法真正自动检测**。robocon.org.cn 没有
 *      API，爬竞赛官网的页面结构极其脆弱，而爬错了会给出更坏的「假确认」。
 *      所以这里只做**过期提醒**：超过 N 天没人确认过就提示去看一眼。
 *      是提醒人去查，不是假装自己知道。
 *   2. **插件自身** —— 最便宜。`git ls-remote` 一次网络往返就够，不需要
 *      额外授权（走已有的 credential helper），也不需要 fetch 整个仓库。
 *   3. **dsh 宿主** —— 只提示，**绝不建议自动升级**。rc.8 那次的教训写在
 *      README 里：前端漂到 rc.8、服务端还是 rc.6，网页端永远停在
 *      "Loading plugins…"，控制台里连报错都没有。
 *
 * ## 三条硬约束
 *
 *   - **不在插件加载时同步打网络。** 这套工具的核心前提是赛场断网可用，
 *     检索走本地镜像就是为这个。新鲜度检查只在显式调用时发生。
 *   - **失败一律静默降级为「查不到」**，绝不抛异常。离线是正常状态，
 *     不该让一个提示功能把工具调用搞崩。
 *   - **只报告，不改任何东西。** 不自动 pull、不自动升级、不自动改配置。
 *
 * 赛场模式下整个工具被 guard 拦在 L1（联网 + 落盘，与 `rcs_kb_sync` 同类）。
 */
import type { CommandRunner } from './toolchain.ts'
import { PINNED_DSH, DSH_PACKAGE } from './versions.ts'

/** 检查结论。`unknown` 是一等公民 —— 离线、非 git 工作区都会落到这里。 */
export type FreshnessStatus = 'ok' | 'stale' | 'unknown'

export type FreshnessItem = {
  id: 'rules' | 'plugin' | 'host'
  label: string
  status: FreshnessStatus
  /** 本地当前的版本/提交，人类可读。 */
  current: string
  /** 上游的版本/提交；查不到时省略。 */
  latest?: string
  /** 说明这个结论是怎么来的。 */
  detail: string
  /** 建议动作。没有可做的事就省略 —— 不要为了凑格式写「无需操作」。 */
  action?: string
}

// ---------------------------------------------------------------- semver

type ParsedVersion = { nums: number[]; pre: string[] }

function parseSemver(v: string): ParsedVersion | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  if (!m) return undefined
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  }
}

/**
 * 语义化版本比较：a < b 返回 -1，相等 0，a > b 返回 1；**任一侧解析不了返回
 * `undefined`**。
 *
 * 自己实现而不是拉一个 semver 依赖，是因为只需要比较这一个功能，而这套工具
 * 的依赖越少、队友装得越顺（`npm install` 已经因为 postinstall 卡过一次人）。
 *
 * 预发布规则按 semver 规范，这里必须正确 —— 我们要比的正是
 * `0.1.0-rc.6` 和 `0.1.0-rc.8` 这种：
 *   - 有预发布标识的**小于**同版本号的正式版（`1.0.0-rc.1 < 1.0.0`）；
 *   - 逐段比较，纯数字段按数值比，混合段按字典序；
 *   - 纯数字段**低于**含字母的段；
 *   - 前缀相同则段数少的更小。
 */
export function compareSemver(a: string, b: string): number | undefined {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (!x || !y) return undefined

  for (let i = 0; i < 3; i++) {
    const p = x.nums[i] as number
    const q = y.nums[i] as number
    if (p !== q) return p < q ? -1 : 1
  }

  if (x.pre.length === 0 && y.pre.length === 0) return 0
  // 正式版胜过预发布
  if (x.pre.length === 0) return 1
  if (y.pre.length === 0) return -1

  const n = Math.max(x.pre.length, y.pre.length)
  for (let i = 0; i < n; i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pNum = /^\d+$/.test(p)
    const qNum = /^\d+$/.test(q)
    if (pNum && qNum) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1
      continue
    }
    if (pNum !== qNum) return pNum ? -1 : 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

// ---------------------------------------------------------------- 规则书

export type RulesFreshnessInput = {
  currentVersion: string
  /** 上次**人工确认过**官网没有新版的日期，`YYYY-MM-DD`。 */
  lastCheckedAt?: string
  /** 超过多少天没确认就提醒，默认 30。 */
  checkIntervalDays?: number
  officialSite?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 规则书过期提醒 —— **纯函数，零网络**。
 *
 * 之所以是「提醒人去看」而不是「自动查」：本届规则 V0 是 ABU 原版翻译稿，
 * 官方前言明确说会有国内赛 V1。V1 出来若没人导入，`rcs_rule_lookup` 会拿
 * **过期条款**给出带条款号、看起来完全可信的答案 —— 那比查不到危险得多。
 * 而竞赛官网没有任何稳定接口可供轮询，所以只能把「该去看了」这件事变得显眼。
 */
export function checkRulesFreshness(input: RulesFreshnessInput, today: Date): FreshnessItem {
  const interval = input.checkIntervalDays ?? 30
  const site = input.officialSite ?? 'https://www.robocon.org.cn'
  const base = {
    id: 'rules' as const,
    label: '规则书版本',
    current: input.currentVersion,
  }
  const goLook = `去 ${site} 确认有没有新版；有就用 \`npm run rules:import\` 导入，没有就把 config/team.json 的 rules.lastCheckedAt 改成今天`

  if (!input.lastCheckedAt) {
    return {
      ...base,
      status: 'unknown',
      detail: '从没记录过确认时间，无法判断当前规则书是不是最新的。',
      action: goLook,
    }
  }

  const when = new Date(`${input.lastCheckedAt}T00:00:00Z`)
  if (Number.isNaN(when.getTime())) {
    return {
      ...base,
      status: 'unknown',
      detail: `config/team.json 里的 rules.lastCheckedAt 不是合法日期：${input.lastCheckedAt}（应形如 2026-09-02）。`,
      action: goLook,
    }
  }

  const days = Math.floor((today.getTime() - when.getTime()) / DAY_MS)
  if (days < 0) {
    return {
      ...base,
      status: 'unknown',
      detail: `记录的确认日期 ${input.lastCheckedAt} 在未来，多半是填错了。`,
      action: goLook,
    }
  }
  if (days >= interval) {
    return {
      ...base,
      status: 'stale',
      detail: `距上次确认已 ${days} 天（阈值 ${interval} 天）。规则书用错版本的代价是整套方案返工，值得花两分钟去看一眼。`,
      action: goLook,
    }
  }
  return {
    ...base,
    status: 'ok',
    detail: `${days} 天前确认过（阈值 ${interval} 天）。`,
  }
}

// ---------------------------------------------------------------- 插件自身

/**
 * 本地这份代码落后远端多少 —— 用 `git ls-remote`，不做 fetch。
 *
 * 选它的理由：一次网络往返、复用已有的 credential helper（私有库也不用另外
 * 授权）、不改动本地仓库的任何状态。而 `git fetch` 会写 remote-tracking ref，
 * 一个「提示功能」不该动别人的仓库。
 *
 * **落后与领先要分清楚。** 远端 SHA 和本地 HEAD 不同只说明两者不一致；
 * 再问一句「这个远端提交本地有没有」就能区分：本地已有 → 我们领先或分叉，
 * 不需要拉取；本地没有 → 确实落后了。少了这一步，每次本地有未推送的提交
 * 都会被误报成「过时」，提示就没人信了。
 */
export async function checkPluginFreshness(
  run: CommandRunner,
  repoRoot: string,
  branch = 'main',
): Promise<FreshnessItem> {
  const base = { id: 'plugin' as const, label: '插件代码（dsh4rcs）' }
  const opts = { cwd: repoRoot, timeoutMs: 20_000 }

  const head = await run('git', ['rev-parse', 'HEAD'], opts)
  if (head.code !== 0) {
    return {
      ...base,
      status: 'unknown',
      current: '（未知）',
      detail: '这个目录不是 git 工作区，或 git 不可用 —— 多半是直接下载 zip 而不是 clone 的。',
      action: '改用 `git clone` 取代压缩包，之后才能收到更新提示',
    }
  }
  const local = head.stdout.trim()
  const short = local.slice(0, 7)

  const remote = await run('git', ['ls-remote', 'origin', `refs/heads/${branch}`], opts)
  if (remote.code !== 0 || remote.stdout.trim() === '') {
    return {
      ...base,
      status: 'unknown',
      current: short,
      detail: '连不上远端仓库。离线时这是正常的，不影响任何本地功能。',
    }
  }
  const remoteSha = (remote.stdout.trim().split(/\s+/)[0] ?? '').trim()
  if (remoteSha === local) {
    return { ...base, status: 'ok', current: short, latest: short, detail: `与 origin/${branch} 一致。` }
  }

  // 远端那个提交本地有没有？有 → 我们领先或分叉，不是落后。
  const hasRemote = await run('git', ['cat-file', '-e', `${remoteSha}^{commit}`], opts)
  if (hasRemote.code === 0) {
    return {
      ...base,
      status: 'ok',
      current: short,
      latest: remoteSha.slice(0, 7),
      detail: `远端的 ${remoteSha.slice(0, 7)} 本地已有 —— 本地领先或已分叉，不需要拉取。`,
    }
  }

  return {
    ...base,
    status: 'stale',
    current: short,
    latest: remoteSha.slice(0, 7),
    detail: `origin/${branch} 上的 ${remoteSha.slice(0, 7)} 本地还没有，这份代码落后了。`,
    action: '`git pull` 之后跑 `npm install && npm run dsh:install`（依赖或工具可能一起变了）',
  }
}

// ---------------------------------------------------------------- dsh 宿主

/** 查 JSON 的最小接口。注入是为了测试不打网。 */
export type JsonFetcher = (url: string, timeoutMs: number) => Promise<unknown>

/**
 * 直接问 npm registry，而不是跑 `npm view`。
 *
 * 因为 `runner.ts` 的执行器刻意 `shell: false`（路径里的空格和中文交给 argv），
 * 而 Windows 上 `npm` 是 `npm.cmd` —— 不过 shell 根本起不来。
 * registry 的 HTTP 接口没有这个问题，还快得多。
 */
export const nodeFetchJson: JsonFetcher = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as unknown
}

/**
 * dsh 宿主是不是有新版了。
 *
 * **只提示，不建议升级。** 措辞上要克制：升级 dsh 是有真实代价的操作，
 * 上一次跟着上游漂就把网页端搞成了永久 "Loading plugins…"。
 */
export async function checkHostFreshness(
  fetchJson: JsonFetcher,
  pinned: string = PINNED_DSH,
): Promise<FreshnessItem> {
  const base = { id: 'host' as const, label: 'dsh 宿主', current: pinned }
  // 作用域包名里的斜杠要转义，否则会被当成路径分隔
  const url = `https://registry.npmjs.org/${DSH_PACKAGE.replace('/', '%2f')}/latest`

  let latest: string
  try {
    const body = (await fetchJson(url, 15_000)) as { version?: unknown }
    if (typeof body?.version !== 'string') throw new Error('registry 返回里没有 version 字段')
    latest = body.version
  } catch (e) {
    return {
      ...base,
      status: 'unknown',
      detail: `查不到 npm 上的最新版本（${(e as Error).message}）。离线时正常，不影响本地功能。`,
    }
  }

  const cmp = compareSemver(pinned, latest)
  if (cmp === undefined) {
    return {
      ...base,
      status: 'unknown',
      latest,
      detail: `上游 latest 是 ${latest}，但两者中至少一个不是合法的语义化版本，无法判断新旧。`,
    }
  }
  if (cmp < 0) {
    return {
      ...base,
      status: 'stale',
      latest,
      detail: `上游 latest 已经是 ${latest}，本套件锁定并验证过的是 ${pinned}。`,
      action:
        '不要直接升。先改 scripts/dsh.mjs 与 profile 的 pnpm-workspace.yaml，' +
        '再跑 `npm run verify` —— 服务端与前端版本不一致会让网页端静默停在 Loading plugins',
    }
  }
  return {
    ...base,
    status: 'ok',
    latest,
    detail: cmp === 0 ? `与上游 latest（${latest}）一致。` : `本地锁定的 ${pinned} 比上游 latest（${latest}）还新。`,
  }
}

// ---------------------------------------------------------------- 编排与缓存

export type FreshnessDeps = {
  run: CommandRunner
  fetchJson: JsonFetcher
}

/** 缓存读写。注入而非直接用 fs，是为了让 `npm run setup` 能选择**不落盘**。 */
export type FreshnessStore = {
  read: () => string | undefined
  write: (text: string) => void
}

type CacheShape = { checkedAt: string; items: FreshnessItem[] }

export type FreshnessOptions = {
  deps: FreshnessDeps
  repoRoot: string
  rules: RulesFreshnessInput
  now: Date
  /** 省略则不读也不写缓存 —— setup 走这条，它对外承诺「只读不写」。 */
  store?: FreshnessStore
  /** 缓存多久算新鲜，默认 24 小时。 */
  ttlHours?: number
  /** 强制重查，忽略缓存。 */
  refresh?: boolean
  branch?: string
  pinned?: string
}

export type FreshnessReport = {
  items: FreshnessItem[]
  /** 联网那两项是否来自缓存。规则那项永远是现算的。 */
  fromCache: boolean
  /** 联网那两项的检查时刻。 */
  checkedAt: string
}

/**
 * 跑完三项检查。
 *
 * 规则那项是纯函数，**每次都现算**（零成本，而且它是三项里后果最重的）；
 * 联网的两项走缓存，默认 24 小时内不重复打网。
 */
export async function checkFreshness(options: FreshnessOptions): Promise<FreshnessReport> {
  const { deps, repoRoot, rules, now } = options
  const ttlMs = (options.ttlHours ?? 24) * 60 * 60 * 1000
  const rulesItem = checkRulesFreshness(rules, now)

  if (!options.refresh && options.store) {
    const cached = readCache(options.store, now, ttlMs)
    if (cached) {
      return { items: [rulesItem, ...cached.items], fromCache: true, checkedAt: cached.checkedAt }
    }
  }

  // 两项互不依赖，并行 —— 串行会让最慢的那个决定整体耗时
  const [plugin, host] = await Promise.all([
    checkPluginFreshness(deps.run, repoRoot, options.branch ?? 'main').catch((e: Error) =>
      unknownItem('plugin', '插件代码（dsh4rcs）', e),
    ),
    checkHostFreshness(deps.fetchJson, options.pinned).catch((e: Error) =>
      unknownItem('host', 'dsh 宿主', e),
    ),
  ])

  const checkedAt = now.toISOString()
  options.store?.write(`${JSON.stringify({ checkedAt, items: [plugin, host] } satisfies CacheShape, null, 2)}\n`)
  return { items: [rulesItem, plugin, host], fromCache: false, checkedAt }
}

/** 兜底：即使检查函数自己抛了，也变成一条「查不到」而不是让调用方崩掉。 */
function unknownItem(id: FreshnessItem['id'], label: string, e: Error): FreshnessItem {
  return { id, label, status: 'unknown', current: '（未知）', detail: `检查失败：${e.message}` }
}

function readCache(store: FreshnessStore, now: Date, ttlMs: number): CacheShape | undefined {
  let raw: string | undefined
  try {
    raw = store.read()
  } catch {
    return undefined
  }
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as CacheShape
    if (!parsed?.checkedAt || !Array.isArray(parsed.items)) return undefined
    const age = now.getTime() - new Date(parsed.checkedAt).getTime()
    // 负数说明缓存时间在未来（改过系统时钟），当作失效重查
    if (!Number.isFinite(age) || age < 0 || age > ttlMs) return undefined
    return parsed
  } catch {
    // 缓存坏了就当没有 —— 缓存永远不该是失败的理由
    return undefined
  }
}

const MARK: Record<FreshnessStatus, string> = { ok: '✅', stale: '⚠️ ', unknown: '·  ' }

/** 渲染成人类可读的多行文本。工具与 `npm run setup` 共用，保证两处说法一致。 */
export function summarizeFreshness(report: FreshnessReport): string {
  const lines = report.items.map((i) => {
    const head = `${MARK[i.status]} ${i.label}：${i.current}${i.latest && i.latest !== i.current ? ` → ${i.latest}` : ''}`
    const detail = `     ${i.detail}`
    return i.action ? `${head}\n${detail}\n     → ${i.action}` : `${head}\n${detail}`
  })
  const stale = report.items.filter((i) => i.status === 'stale').length
  lines.push(
    stale === 0
      ? '\n没有发现过时项。'
      : `\n${stale} 项需要处理，见上面标 ⚠️ 的条目。这些都只是提示 —— 不会自动升级或拉取任何东西。`,
  )
  if (report.fromCache) lines.push(`（联网两项来自缓存，检查于 ${report.checkedAt}；要重查加 refresh 参数）`)
  return lines.join('\n')
}
