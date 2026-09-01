/**
 * dsh-rcs-guard —— 危险操作的横切安全层。
 *
 * ## 为什么权限逻辑不写在工具里
 *
 * 官方建议就是这样：把 allow/deny/ask 放进 `tools/pre-execute` 钩子，
 * 把最终的单调拒绝放进 `ctx.tools.guard()`。好处是策略可扩展、可审计，
 * 而且**新工具天然被纳入管控**，不用每个工具各写一遍。
 *
 * ## 两处与文档示例不同的真实 API（已对照 rc.6 的 .d.ts 核实）
 *
 *   1. `tools/pre-execute` 是 **waterfall**，签名是
 *      `(exec, next) => Promise<PreToolDecision>`，不是简单的 bail。
 *      `next()` 代表委托给下游/默认放行。
 *   2. `PreToolDecision` 是**对象**：`{kind:'allow'} | {kind:'deny',reason} | {kind:'ask',reason?}`。
 *   3. `ToolGuard` 返回**拒绝原因字符串**（undefined 表示不干预），不是布尔。
 *
 * ## 红线
 *
 * `mode: 'field'` 下所有 L1/L2 工具一律拒绝。赛场上 Agent 只能查。
 * 并且：**软件保护永远不替代硬件急停**（规则 12.2 强制要求红色急停按钮）。
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { decide, fieldGuard, levelOf, DEFAULT_DANGER_RULES } from '../../rcs-core/src/danger.ts'
import type { GuardConfig, GuardMode } from '../../rcs-core/src/danger.ts'

export const name = 'rcs-guard'
export const inject = ['tools']

export interface Config {
  /** dev：L2 需人工确认；field：L1/L2 一律拒绝。 */
  mode: GuardMode
  /** 额外提升为 L2 的工具名。 */
  extraL2: string[]
}

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['dev', 'field'] as const).default('dev'),
  extraL2: Schema.array(Schema.string()).default([]),
})

/** dsh 的 pre-execute 决策类型（与 rc.6 的 PreToolDecision 对齐）。 */
type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

/** 只声明本插件用到的 exec 字段。 */
interface PendingCall {
  name: string
}

export function apply(ctx: Context, config: Config): void {
  const guardConfig: GuardConfig = {
    mode: config.mode,
    rules: DEFAULT_DANGER_RULES,
    extraL2: config.extraL2,
  }

  // ---- 第一道：可扩展的 allow / deny / ask ----
  // waterfall：不干预时必须 `await next()` 把决定权交下去，
  // 直接 return {kind:'allow'} 会**短路掉其它插件的审批**，那是错的。
  ctx.on(
    'tools/pre-execute',
    async (exec: PendingCall, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
      const d = decide(exec.name, guardConfig)
      if (d.kind === 'allow') return next()
      return d
    },
  )

  // ---- 第二道：赛场模式的单调拒绝 ----
  // guard 在 pre-execute 之后、且任何插件都绕不过。赛场红线放这里才算数。
  if (config.mode === 'field') {
    ctx.tools.guard((exec: PendingCall) => fieldGuard(exec.name, guardConfig))
  }

  // ---- 启动时把生效策略打出来 ----
  // 安全配置最怕「以为开了其实没开」，所以加载即自报家门。
  const l2 = DEFAULT_DANGER_RULES.filter((r) => levelOf(r.tool, guardConfig) === 'L2').map(
    (r) => r.tool,
  )
  const banner =
    config.mode === 'field'
      ? `[rcs-guard] 赛场模式：所有 L1/L2 工具一律拒绝（含 ${l2.length} 个物理动作工具）`
      : `[rcs-guard] 开发模式：${l2.length} 个物理动作工具需人工确认 —— ${l2.join(', ')}`
  console.info(banner)

  ctx.effect(() => {
    // 事件监听与 guard 都是经 ctx 注册的，插件卸载时框架自动回收。
    // 这里只留占位，将来若加外部审计上报，务必在此注销。
    return () => {}
  })
}
