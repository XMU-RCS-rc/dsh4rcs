/**
 * 危险度分级的纯逻辑 —— guard 插件的判定核心。
 *
 * ## 为什么要有这一层
 *
 * 机器人战队和普通软件项目最大的区别：**Agent 的一个错误动作可能伤人、损机。**
 * 本届规则下的危险源很具体：
 *   - 气动系统上限 600kPa（条款 11.14），气缸突然动作能夹伤手
 *   - 电池 24V / 电路 42V（11.12、11.13），大功率电机堵转能烧驱动
 *   - 规则强制要求红色急停按钮（12.2）——**软件保护永远不能替代硬件急停**
 *
 * 所以判定逻辑单独成层、单独测试，不埋在 dsh 适配层里。
 */

/** 危险级别。 */
export type DangerLevel = 'L0' | 'L1' | 'L2'

/** 运行模式。赛场模式下一切写操作与物理动作都禁止。 */
export type GuardMode = 'dev' | 'field'

export type DangerRule = {
  /** 工具名，精确匹配。 */
  tool: string
  level: DangerLevel
  /** 为什么危险 —— 会出现在拒绝原因里，让人知道被挡的理由。 */
  reason: string
}

/** 判定结果。与 dsh 的 PreToolDecision 对齐：allow / deny / ask。 */
export type Decision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string }

/**
 * 默认危险清单。
 *
 * L2 是**物理动作**：会让真实硬件动起来的操作。宁可多列 —— 漏列一个的代价
 * 是有人被夹伤，多列一个的代价只是多点一次确认。
 *
 * 注意这里列的工具**大多尚未实现**（烧录、电机使能、气路动作等要等工具链与
 * 实车信息）。提前登记是刻意的：等实现时它们天然就在管控之下，
 * 而不是「先做出来再补安全」。
 */
export const DEFAULT_DANGER_RULES: DangerRule[] = [
  // ---- L2 物理动作 ----
  { tool: 'rcs_fw_flash', level: 'L2', reason: '烧录会改写运行中的固件' },
  { tool: 'rcs_motor_enable', level: 'L2', reason: '电机使能会让机构立即运动' },
  { tool: 'rcs_pneumatic_fire', level: 'L2', reason: '气路动作 —— 600kPa 下气缸瞬间伸出，行程内有手会夹伤' },
  { tool: 'rcs_bus_write', level: 'L2', reason: '总线下发控制指令会直接驱动执行器' },
  { tool: 'rcs_serial_write', level: 'L2', reason: '串口下发可能触发下位机动作' },

  // ---- L1 本机写 ----
  { tool: 'rcs_fw_build', level: 'L1', reason: '构建会改写产物目录' },
  {
    tool: 'rcs_kb_sync',
    level: 'L1',
    reason:
      '同步会联网拉取队内飞书文档并写入本地镜像 —— 既出网又落盘。' +
      '赛场上禁止：网络不可靠，且赛场只该查已有镜像，不该改它',
  },
  { tool: 'rcs_support_test', level: 'L1', reason: '会在本机运行测试进程' },
  {
    tool: 'rcs_version_status',
    level: 'L1',
    reason:
      '新鲜度检查会联网（git ls-remote + npm registry）并写本地缓存 —— 与 rcs_kb_sync 同类。' +
      '赛场上拦掉：那时网络不可靠，而且「插件落后了两个提交」这种信息，' +
      '在检录台上既做不了什么也不该分散注意力',
  },
  { tool: 'rcs_serial_monitor', level: 'L1', reason: '会占用串口设备' },
  { tool: 'rcs_sim_launch', level: 'L1', reason: '会拉起仿真进程' },
]

export type GuardConfig = {
  mode: GuardMode
  rules: DangerRule[]
  /** 额外提升为 L2 的工具名（队内自定义工具用）。 */
  extraL2?: string[]
}

/** 未登记的工具默认按 L0 处理 —— 本套工具里绝大多数是只读检查。 */
export function levelOf(tool: string, config: GuardConfig): DangerLevel {
  if (config.extraL2?.includes(tool)) return 'L2'
  return config.rules.find((r) => r.tool === tool)?.level ?? 'L0'
}

function reasonOf(tool: string, config: GuardConfig): string {
  if (config.extraL2?.includes(tool)) return '队内自定义的高危工具'
  return config.rules.find((r) => r.tool === tool)?.reason ?? '未登记的高危操作'
}

/**
 * 判定一次工具调用。
 *
 *   L0  只读        → 放行
 *   L1  本机写      → dev 放行（由 dsh 自身的审批体系管），field 拒绝
 *   L2  物理动作    → dev 强制人工确认，field 一律拒绝
 */
export function decide(tool: string, config: GuardConfig): Decision {
  const level = levelOf(tool, config)
  if (level === 'L0') return { kind: 'allow' }

  const why = reasonOf(tool, config)

  if (config.mode === 'field') {
    return {
      kind: 'deny',
      reason:
        `赛场模式禁止 ${level} 操作：${tool} —— ${why}。` +
        `赛场上 Agent 只能查，不能改、不能烧录、不能动气路。`,
    }
  }

  if (level === 'L2') {
    return {
      kind: 'ask',
      reason:
        `${tool} 是物理动作：${why}。` +
        `执行前请确认周围无人、机构行程内无手、气路已泄压。` +
        `注意：软件停止不能替代硬件急停、驱动使能线和限位保护。`,
    }
  }

  return { kind: 'allow' }
}

/**
 * 赛场模式下的单调拒绝（对应 `ctx.tools.guard()`）。
 *
 * 返回拒绝原因字符串表示挡下，返回 undefined 表示不干预 ——
 * 这是 dsh 的 `ToolGuard` 契约，注意**不是布尔**。
 *
 * 它比 `tools/pre-execute` 更靠后且不可被其它插件绕过，
 * 所以赛场红线放在这里，而不是只放在事件里。
 */
export function fieldGuard(tool: string, config: GuardConfig): string | undefined {
  if (config.mode !== 'field') return undefined
  const level = levelOf(tool, config)
  if (level === 'L0') return undefined
  return `赛场模式：${tool}（${level}）已被硬性阻止 —— ${reasonOf(tool, config)}`
}
