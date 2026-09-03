/**
 * RCS 专属 UI 的**视图模型层**。
 *
 * 这一层是纯投影函数：检查结果 → 可渲染的视图数据。零依赖、可单测。
 * 之所以单独成层，是因为它要被两处共用：
 *
 *   Tier 1  工具呈现（presentCall / presentResult）—— 已接入，任何 UI 都吃得到
 *   Tier 2  客户端面板（ctx.slots.register + React）—— 队徽入口已接入，完整看板待实现
 *
 * 渲染细节（颜色值、DOM、React）一律不在这里，只产出**语义**。
 *
 * ## 为什么输入类型是"宽松"的
 *
 * `output.presentationMeta` 拿到的 value 类型由 schema 反推（`InferValue`），
 * 字段全是可选的；而 `presentResult` 在**回放**历史会话时跑，拿到的是从日志里
 * 反序列化的 JSON。两处都不保证字段齐全，且这两个钩子按契约**必须是全函数、
 * 不得抛异常**——一抛就会把整条消息的渲染搞崩。
 *
 * 所以这里统一收宽松类型 + 全程给默认值，而不是断言成严格类型图省事。
 */
import type { CheckResult, Severity } from '../../rcs-core/src/types.ts'

/** 宽松的 finding：字段都可能缺失。 */
export interface FindingLike {
  rule?: string | undefined
  severity?: string | undefined
  message?: string | undefined
  file?: string | undefined
  line?: number | undefined
  detail?: string | undefined
}

/** 宽松的检查结果。 */
export interface CheckResultLike {
  check?: string | undefined
  target?: string | undefined
  ok?: boolean | undefined
  /** schema 反推出来的是 JsonValue，故这里收 unknown，由消费方自行收窄。 */
  stats?: unknown
  findings?: readonly FindingLike[] | undefined
}

/** 把 stats 渲染成 `k=v` 串。非对象或非数值一律跳过，保证不抛。 */
export function statsLine(stats: unknown): string {
  if (typeof stats !== 'object' || stats === null) return ''
  return Object.entries(stats as Record<string, unknown>)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ')
}

/** 语义色调。具体色值由 theme.ts 给，这里只表达"这是什么性质"。 */
export type Tone = 'critical' | 'warning' | 'neutral' | 'success'

export function severityTone(s: Severity | string | undefined): Tone {
  if (s === 'error') return 'critical'
  if (s === 'warn') return 'warning'
  return 'neutral'
}

/** 固件工程的五个层次。按层着色，让人一眼看出问题出在哪一层。 */
export type RcsLayer = 'RCS_HAL' | 'RCS_Module' | 'RCS_Support' | 'RCS_Template' | 'user' | 'unknown'

const LAYER_ORDER: RcsLayer[] = ['RCS_HAL', 'RCS_Module', 'RCS_Support', 'RCS_Template', 'user']

/** 从相对路径推断所属层次。 */
export function layerOf(file: string | undefined): RcsLayer {
  if (!file) return 'unknown'
  const normalized = file.replace(/\\/g, '/')
  for (const l of LAYER_ORDER) {
    if (normalized.includes(`${l}/`) || normalized.startsWith(l)) return l
  }
  return 'unknown'
}

/** 按文件分组的发现，形状与 dsh 的 SearchFileMatches 对齐，可直接喂给搜索卡片。 */
export interface FileGroup {
  path: string
  layer: RcsLayer
  matches: { lineNumber: number; line: string }[]
}

/**
 * 把 findings 按文件分组。
 * 没有行号的发现给 lineNumber 1 —— dsh 的搜索卡片要求 1-based 行号，
 * 而分层违规里的传递依赖本来就定位不到具体行。
 */
export function groupByFile(findings: readonly FindingLike[]): FileGroup[] {
  const groups = new Map<string, FileGroup>()
  for (const f of findings) {
    const path = f.file ?? '(无文件)'
    let g = groups.get(path)
    if (!g) {
      g = { path, layer: layerOf(f.file), matches: [] }
      groups.set(path, g)
    }
    const msg = f.message ?? '(无说明)'
    g.matches.push({
      lineNumber: f.line ?? 1,
      line: f.detail ? `${msg} — ${f.detail}` : msg,
    })
  }
  return [...groups.values()]
}

/**
 * 污染源排名 —— **本套 UI 里最有价值的一个投影**。
 *
 * 分层违规的发现里，`detail` 会写明传递链（`X.h -> rcs_private_config.h -> ...`）。
 * 把「第一跳」聚合起来就能回答一个战队真正关心的问题：
 * **先修哪一个文件，能一次解锁最多的下游文件？**
 *
 * 实测数据上，修掉 `rcs_private_config.h` 一个文件，就能解除多个 RCS_Support
 * 文件的 PC 编译障碍 —— 这个结论不做聚合是看不出来的。
 */
export interface RootCause {
  header: string
  /** 受其影响的文件数。 */
  affectedFiles: number
  /** 样例文件，供 UI 展开。 */
  samples: string[]
}

export function rankRootCauses(findings: readonly FindingLike[]): RootCause[] {
  const map = new Map<string, Set<string>>()
  for (const f of findings) {
    // detail 形如 "a.cpp -> rcs_private_config.h -> {…}"，取中间那一跳
    const m = /->\s*([\w.\-]+\.h(?:pp)?)\s*->/.exec(f.detail ?? '')
    if (!m || !m[1]) continue
    const header = m[1]
    let set = map.get(header)
    if (!set) {
      set = new Set()
      map.set(header, set)
    }
    if (f.file) set.add(f.file)
  }
  return [...map.entries()]
    .map(([header, files]) => ({
      header,
      affectedFiles: files.size,
      samples: [...files].slice(0, 5),
    }))
    .sort((a, b) => b.affectedFiles - a.affectedFiles)
}

/** 例程完成度，按 step 分组 —— 对应 请读我.txt 的 step1~step8 培养路径。 */
export interface StepProgress {
  step: number
  done: number
  total: number
  /** 该 step 是否含有未完成的关键例程。 */
  blocked: boolean
}

export interface TemplateProgressVM {
  overall: { done: number; total: number; percent: number }
  steps: StepProgress[]
}

/** 从例程状态反推每个 step 的进度。 */
export function templateProgress(
  statuses: readonly { step: number; state: 'present' | 'alias' | 'missing'; critical: boolean }[],
): TemplateProgressVM {
  const byStep = new Map<number, StepProgress>()
  for (const s of statuses) {
    let p = byStep.get(s.step)
    if (!p) {
      p = { step: s.step, done: 0, total: 0, blocked: false }
      byStep.set(s.step, p)
    }
    p.total++
    if (s.state !== 'missing') p.done++
    else if (s.critical) p.blocked = true
  }
  const steps = [...byStep.values()].sort((a, b) => a.step - b.step)
  const done = steps.reduce((n, s) => n + s.done, 0)
  const total = steps.reduce((n, s) => n + s.total, 0)
  return {
    overall: { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) },
    steps,
  }
}

/**
 * 工程健康分（0~100）。
 *
 * 刻意设计成**粗粒度**：它的作用是给战队一个"这周比上周好还是差"的趋势信号，
 * 不是精确度量。任何试图把它调准的努力都跑偏了 —— 要精确就去看 findings。
 */
export interface HealthVM {
  score: number
  tone: Tone
  breakdown: { label: string; errors: number; warns: number }[]
}

function toneOf(score: number): Tone {
  return score >= 80 ? 'success' : score >= 50 ? 'warning' : 'critical'
}

function scoreOf(errors: number, warns: number): number {
  return Math.max(0, 100 - errors * 5 - warns * 1)
}

/** 从 findings 直接算健康分。presentationMeta 走这条路，不依赖 stats。 */
export function healthFromFindings(label: string, findings: readonly FindingLike[]): HealthVM {
  const errors = findings.filter((f) => f.severity === 'error').length
  const warns = findings.filter((f) => f.severity === 'warn').length
  const score = scoreOf(errors, warns)
  return { score, tone: toneOf(score), breakdown: [{ label, errors, warns }] }
}

/** 多个检查结果的合计健康分。面板与 CLI 用这个。 */
export function healthScore(results: readonly CheckResult[]): HealthVM {
  const breakdown = results.map((r) => ({
    label: r.check,
    errors: r.stats['error'] ?? 0,
    warns: r.stats['warn'] ?? 0,
  }))
  const errors = breakdown.reduce((n, b) => n + b.errors, 0)
  const warns = breakdown.reduce((n, b) => n + b.warns, 0)
  const score = scoreOf(errors, warns)
  return { score, tone: toneOf(score), breakdown }
}

/** 一次检查的卡片标题。短，因为 UI 会当作卡片头/日志行。 */
export function callTitle(check: string, target: string): string {
  const label: Record<string, string> = {
    'layer-lint': '分层红线检查',
    'template-gap': '例程缺口比对',
    'support-pairing': '头源配对检查',
    'repo-hygiene': '仓库卫生检查',
  }
  const tail = target.replace(/\\/g, '/').split('/').slice(-2).join('/')
  return `${label[check] ?? check} · ${tail}`
}

/** 结果卡片标题，带结论。 */
export function resultTitle(r: CheckResult): string {
  const base = callTitle(r.check, r.target)
  if (r.findings.length === 0) return `${base} — 通过`
  const e = r.stats['error'] ?? 0
  const w = r.stats['warn'] ?? 0
  const parts = [e > 0 ? `${e} 个错误` : '', w > 0 ? `${w} 个警告` : ''].filter(Boolean)
  return `${base} — ${parts.join('，')}`
}

/**
 * 持久化到会话日志的呈现元数据。
 *
 * `presentResult` 在**回放**时也会被调用，那时只拿得到 args 与 result，
 * 拿不到 execute 的返回值。所以凡是渲染需要、又无法从模型可见文本重建的结构化数据，
 * 都必须经 `output.presentationMeta` 落到 `result.meta` 里。
 */
export interface RcsPresentationMeta {
  kind: 'rcs-check'
  check: string
  target: string
  ok: boolean
  groups: FileGroup[]
  rootCauses: RootCause[]
  health: HealthVM
  /** 截断前的发现总数 —— dsh 的搜索卡片要求给出，好显示"已截断"指示。 */
  total: number
  truncated: boolean
}

/** 检查结果 → 呈现元数据。limit 防止一次塞爆 UI 与会话日志。 */
export function toPresentationMeta(r: CheckResultLike, limit = 50): RcsPresentationMeta {
  const findings = r.findings ?? []
  const shown = findings.slice(0, limit)
  const check = r.check ?? 'check'
  return {
    kind: 'rcs-check',
    check,
    target: r.target ?? '',
    ok: r.ok ?? false,
    groups: groupByFile(shown),
    rootCauses: rankRootCauses(findings),
    health: healthFromFindings(check, findings),
    total: findings.length,
    truncated: findings.length > limit,
  }
}

/** 运行期类型守卫 —— 回放时 result.meta 是 JsonValue，需要收窄。 */
export function isRcsMeta(v: unknown): v is RcsPresentationMeta {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return o['kind'] === 'rcs-check' && Array.isArray(o['groups']) && typeof o['total'] === 'number'
}
