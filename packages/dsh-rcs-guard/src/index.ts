/**
 * dsh-rcs-guard —— 危险操作的横切安全层。
 *
 * ## 为什么权限逻辑不写在工具里
 *
 * 官方建议就是这样：把 allow/deny/ask 放进 `tools/pre-execute` 钩子。
 * 好处是策略可扩展、可审计，而且**新的 rcs 工具天然被纳入管控**，
 * 不用每个工具各写一遍。
 *
 * ## 两处与文档示例不同的真实 API（已对照 rc.6 的 .d.ts 核实）
 *
 *   1. `tools/pre-execute` 是 **waterfall**，签名是
 *      `(exec, next) => Promise<PreToolDecision>`，不是简单的 bail。
 *      `next()` 代表委托给下游/默认放行。
 *   2. `PreToolDecision` 是**对象**：`{kind:'allow'} | {kind:'deny',reason} | {kind:'ask',reason?}`。
 *
 * ## 这一层能做什么、不能做什么
 *
 * 它只会**要求人工确认**，不会拒绝任何调用 —— 赛场模式删除后已没有硬性拒绝，
 * 因此也不再注册 `ctx.tools.guard()`。
 *
 * 更要紧的是它的**覆盖面**：判定按工具名精确匹配，只认 `rcs_*`。
 * profile 里同时装着宿主自带的 `bash` / `pwsh` / `write` / `edit`，
 * 那些**不经过本插件**。所以这一层挡不住 `bash python swd_flash.py --write`，
 * 它是给 rcs 工具加的一道提醒，不是沙箱。别把它当边界来依赖。
 *
 * 并且：**软件保护永远不替代硬件急停**（规则 12.2 强制要求红色急停按钮）。
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { decide, levelOf, DEFAULT_DANGER_RULES } from '../../rcs-core/src/danger.ts'
import type { GuardConfig, GuardMode } from '../../rcs-core/src/danger.ts'

export const name = 'rcs-guard'
export const inject = ['tools']

export interface Config {
  /**
   * dev      L2 物理动作需人工确认
   * training 同 dev，另加：L2 的确认文案更重、LG 代码生成需过闸门
   */
  mode: GuardMode
  /** 额外提升为 L2 的工具名。 */
  extraL2: string[]
}

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['dev', 'training'] as const).default('dev'),
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

  // 这里**不注册** `ctx.tools.guard()`（不可绕过的单调拒绝）。
  // 那道机制是给「一律拒绝」用的，而现存两种模式都只到 ask 为止：
  // 培训的约束是人在回路里确认，不是拦死 —— 学生要烧代码、要用 F407。
  // 要重新引入硬拒绝，先解决上面文件头写的覆盖面问题，否则挡不住 bash。

  // ---- 启动时把生效策略打出来 ----
  // 安全配置最怕「以为开了其实没开」，所以加载即自报家门。
  const l2 = DEFAULT_DANGER_RULES.filter((r) => levelOf(r.tool, guardConfig) === 'L2').map(
    (r) => r.tool,
  )
  const lg = DEFAULT_DANGER_RULES.filter((r) => levelOf(r.tool, guardConfig) === 'LG').map(
    (r) => r.tool,
  )
  const banner =
    config.mode === 'training'
      ? `[rcs-guard] 培训模式：${l2.length} 个物理动作工具需人工确认（烧录可用）；` +
        `构建与跑测试放行；${lg.length} 个代码生成工具需过闸门 —— ${lg.join(', ')}`
      : `[rcs-guard] 开发模式：${l2.length} 个物理动作工具需人工确认 —— ${l2.join(', ')}`
  console.info(banner)

  ctx.effect(() => {
    // 事件监听是经 ctx 注册的，插件卸载时框架自动回收。
    // 这里只留占位，将来若加外部审计上报，务必在此注销。
    return () => {}
  })
}
