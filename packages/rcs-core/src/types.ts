/**
 * 全套检查共用的结果类型。
 *
 * 设计要点：所有检查器都是 **纯函数**（输入路径 + 配置 → Finding[]），
 * 不依赖 dsh、不依赖网络、不写文件。这样才能：
 *   1. 用 vitest 直接对着真实工程跑，断言用手工核查出的已知结论；
 *   2. 在 dsh API 变动时不受影响（易碎的只有适配层）。
 */

/** 严重级别。error 会让 CI 失败，warn 只提示。 */
export type Severity = 'error' | 'warn' | 'info'

/** 一条检查发现。 */
export interface Finding {
  /** 规则 ID，如 `support-no-vendor`，便于按规则统计与豁免。 */
  rule: string
  severity: Severity
  /** 面向人的一句话说明。 */
  message: string
  /** 相对被检查根目录的路径。 */
  file?: string
  /** 1-based 行号。 */
  line?: number
  /** 补充细节，如传递依赖链。 */
  detail?: string
}

/** 一次检查的完整结果。 */
export interface CheckResult {
  /** 检查器名，如 `layer-lint`。 */
  check: string
  /** 被检查的根目录（绝对路径）。 */
  target: string
  /** 没有 error 级别发现即为 true。 */
  ok: boolean
  findings: Finding[]
  /** 按 severity 与自定义维度的计数，供工具渲染摘要。 */
  stats: Record<string, number>
}

/** 把 findings 汇总成 CheckResult。 */
export function toResult(check: string, target: string, findings: Finding[], extraStats: Record<string, number> = {}): CheckResult {
  const stats: Record<string, number> = {
    total: findings.length,
    error: findings.filter((f) => f.severity === 'error').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
    ...extraStats,
  }
  return {
    check,
    target,
    ok: (stats['error'] ?? 0) === 0,
    findings,
    stats,
  }
}
