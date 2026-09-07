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

/**
 * 危险级别。
 *
 * LG（代码生成）是为培训模式引入的**第四档**，它不涉及人身安全，而涉及**教学有效性**：
 * 一个会写代码的 Agent 是「什么都不学就让机器人动起来」的最快路径，
 * 而那恰恰取消了机器人比赛的意义。所以它单独成档，只在培训模式下受限。
 */
export type DangerLevel = 'L0' | 'L1' | 'L2' | 'LG'

/**
 * 运行模式。
 *
 *   dev       开发模式 —— 老队员日常使用：物理动作需人工确认，其余放行
 *   training  培训模式 —— 新生使用：本机写放行（学习循环要顺畅），
 *             物理动作需人工确认，代码生成需过闸门
 *
 * 曾经有第三档 `field`（赛场模式），把一切非只读操作硬性拒绝，理由是赛场
 * 网络不可靠、现场只该查不该改。**已删除**，因为那个前提不成立：队里确认
 * 赛场不会有太多网络方面的顾虑，为此保留一整套拒绝路径不值得。
 *
 * 它还带着一个说不出口的问题：guard 只按工具名精确匹配 `rcs_*`，而 profile
 * 里同时装着宿主自带的 `bash` / `pwsh` / `write`，赛场模式挡不住
 * `bash python swd_flash.py --write`。一条挡不住的红线比没有红线更危险 ——
 * 它让人以为自己被保护着。要重新引入受限模式，得先解决这个覆盖面问题。
 */
export type GuardMode = 'dev' | 'training'

export type DangerRule = {
  /** 工具名，精确匹配。 */
  tool: string
  level: DangerLevel
  /** 为什么危险 —— 会出现在拒绝原因里，让人知道被挡的理由。 */
  reason: string
}

/**
 * 判定结果。与 dsh 的 PreToolDecision 对齐：allow / deny / ask。
 *
 * `deny` 目前**没有任何代码路径会产生** —— 赛场模式删除后不再有硬性拒绝。
 * 保留它是因为本类型要对齐宿主的 PreToolDecision，不是为了留后路。
 */
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
  //
  // 注意：赛场模式删除后，**L1 在 dev 与 training 下都是放行**，
  // 也就是说它当前不改变任何一次判定，与 L0 的实际效果相同。
  // 仍然登记，是因为这份清单同时是「哪些工具会出网或落盘」的台账 ——
  // 启动横幅和人工审阅都读它。判定与台账是两件事，不要因为前者用不上就删后者。
  { tool: 'rcs_fw_build', level: 'L1', reason: '构建会改写产物目录' },
  {
    tool: 'rcs_kb_sync',
    level: 'L1',
    reason:
      '同步会联网拉取队内飞书文档并写入本地镜像 —— 既出网又落盘，' +
      '而且会按飞书当前状态删掉本地已不存在的文档',
  },
  { tool: 'rcs_support_test', level: 'L1', reason: '会在本机运行测试进程' },
  {
    tool: 'rcs_version_status',
    level: 'L1',
    reason:
      '新鲜度检查会联网（git ls-remote + npm registry）并写本地缓存 —— 与 rcs_kb_sync 同类',
  },
  { tool: 'rcs_serial_monitor', level: 'L1', reason: '会占用串口设备' },
  { tool: 'rcs_sim_launch', level: 'L1', reason: '会拉起仿真进程' },
  {
    tool: 'rcs_train_scaffold',
    level: 'L1',
    reason: '会把任务模板与测试写进学员的工作目录',
  },

  // ---- LG 代码生成 ----
  {
    tool: 'rcs_train_generate',
    level: 'LG',
    reason:
      '直接给出完整实现。培训模式下需过闸门并打水印 —— ' +
      '不是为了防止抄（新生完全可以另开网页版问，锁是拦不住的），' +
      '而是为了让「自己写」成为更省力的那条路，并让绕过留下痕迹',
  },
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
 *              dev              training
 *   L0 只读     放行             放行
 *   L1 本机写   放行             放行
 *   L2 物理     人工确认         人工确认（文案更重）
 *   LG 生成     放行             **人工确认 + 闸门**
 *
 * 没有任何一格是拒绝。培训与开发的差别只有两处：
 *   1. L2 的确认文案更重 —— 多一句「第一次做请让老队员在旁边」。新生正是
 *      最容易低估急停、使能线、限位的那批人，每次弹一下把要点重复成肌肉记忆。
 *   2. LG 代码生成要过闸门 —— 直接拿到答案会让那道题失去意义。
 *
 * L1 在两种模式下都放行：构建与跑测试是学习循环的核心，卡住它整套培训就失效了。
 */
export function decide(tool: string, config: GuardConfig): Decision {
  const level = levelOf(tool, config)
  if (level === 'L0') return { kind: 'allow' }

  const why = reasonOf(tool, config)

  if (config.mode === 'training') {
    if (level === 'L2') {
      // 培训一样要烧代码、也会用到 F407，所以这里**不能拦死** ——
      // 拦死就等于让整套培训跑不起来。
      //
      // 但确认这一步保留：烧录是物理动作，而新生正是最容易低估
      // 急停、使能线、限位的那批人。每次弹一下，把安全要点重复成肌肉记忆，
      // 这正是培训场景该做的事。
      return {
        kind: 'ask',
        reason:
          `${tool} 是物理动作：${why}。` +
          `执行前请确认周围无人、机构行程内无手、气路已泄压。` +
          `注意：软件停止不能替代硬件急停、驱动使能线和限位保护。` +
          `第一次做请让老队员在旁边，并当面指认急停按钮在哪里。`,
      }
    }
    if (level === 'LG') {
      return {
        kind: 'ask',
        reason:
          `${tool} 会直接给出完整实现：${why}。` +
          `确认前请先自问：骨架跑起来了吗？测试红在哪一行？` +
          `直接拿到答案会让这道题失去意义，而验收时老队员会追问每一行的理由。`,
      }
    }
    return { kind: 'allow' }
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
