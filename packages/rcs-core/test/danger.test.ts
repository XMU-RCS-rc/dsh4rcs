/**
 * 危险度判定测试。
 *
 * 这是整套插件里**唯一涉及人身安全**的模块，所以断言写得比别处密：
 * 每一个 L2 工具、每一种模式组合都要有明确覆盖，不靠"应该没问题"。
 */
import { describe, it, expect } from 'vitest'
import { decide, levelOf, DEFAULT_DANGER_RULES } from '../src/danger.ts'
import type { GuardConfig } from '../src/danger.ts'

const dev: GuardConfig = { mode: 'dev', rules: DEFAULT_DANGER_RULES }
const training: GuardConfig = { mode: 'training', rules: DEFAULT_DANGER_RULES }
const ALL_MODES: GuardConfig[] = [dev, training]

const LG_TOOLS = ['rcs_train_generate']

const L2_TOOLS = [
  'rcs_fw_flash',
  'rcs_motor_enable',
  'rcs_pneumatic_fire',
  'rcs_bus_write',
  'rcs_serial_write',
]
const L1_TOOLS = ['rcs_fw_build', 'rcs_support_test', 'rcs_serial_monitor', 'rcs_sim_launch']
const L0_TOOLS = ['rcs_lint_layer', 'rcs_rule_lookup', 'rcs_repo_hygiene', 'rcs_team_context']

describe('levelOf', () => {
  it('未登记的工具默认 L0（本套工具绝大多数是只读检查）', () => {
    for (const t of L0_TOOLS) expect(levelOf(t, dev)).toBe('L0')
    expect(levelOf('某个还没写的工具', dev)).toBe('L0')
  })

  it('物理动作工具全部为 L2', () => {
    for (const t of L2_TOOLS) expect(levelOf(t, dev)).toBe('L2')
  })

  it('本机写工具为 L1', () => {
    for (const t of L1_TOOLS) expect(levelOf(t, dev)).toBe('L1')
  })

  it('extraL2 能把队内自定义工具提升为 L2', () => {
    const c: GuardConfig = { ...dev, extraL2: ['team_custom_actuator'] }
    expect(levelOf('team_custom_actuator', c)).toBe('L2')
  })
})

describe('decide —— 开发模式', () => {
  it('L0 放行', () => {
    for (const t of L0_TOOLS) expect(decide(t, dev)).toEqual({ kind: 'allow' })
  })

  it('L1 放行（交给 dsh 自身的审批体系）', () => {
    for (const t of L1_TOOLS) expect(decide(t, dev).kind).toBe('allow')
  })

  it('每个 L2 工具都要求人工确认', () => {
    for (const t of L2_TOOLS) {
      const d = decide(t, dev)
      expect(d.kind, `${t} 必须 ask`).toBe('ask')
    }
  })

  it('L2 的确认提示包含现场安全要点与「软件不替代硬件急停」', () => {
    const d = decide('rcs_pneumatic_fire', dev)
    expect(d.kind).toBe('ask')
    if (d.kind !== 'ask') return
    expect(d.reason).toContain('周围无人')
    expect(d.reason).toContain('气路已泄压')
    expect(d.reason).toContain('软件停止不能替代硬件急停')
  })

  it('气路动作的理由点明 600kPa 的具体危险', () => {
    const d = decide('rcs_pneumatic_fire', dev)
    if (d.kind !== 'ask') throw new Error('应为 ask')
    expect(d.reason).toContain('600kPa')
  })
})

/**
 * 赛场模式（`field`）已删除。这一组守住删除后的不变量：**没有任何一条路径产生 deny。**
 *
 * 单独立一个 describe 而不是就此不测，是因为「谁也拒绝不了」现在是这套判定的
 * 一条实质承诺 —— guard 插件据此不再注册 `ctx.tools.guard()`。
 * 哪天有人加回一个 deny 分支却没有同时加回单调拒绝，这里会先炸。
 */
describe('删除赛场模式后：没有任何模式会拒绝', () => {
  it('每种模式 × 每个危险度，结果只可能是 allow 或 ask', () => {
    const everyTool = [...L0_TOOLS, ...L1_TOOLS, ...L2_TOOLS, ...LG_TOOLS, '没登记的工具']
    for (const config of ALL_MODES) {
      for (const t of everyTool) {
        expect(decide(t, config).kind, `${t} @ ${config.mode} 不该是 deny`).not.toBe('deny')
      }
    }
  })

  it('L1 在两种模式下都放行 —— 它当前是台账，不改变判定', () => {
    for (const config of ALL_MODES) {
      for (const t of L1_TOOLS) {
        expect(decide(t, config).kind, `${t} @ ${config.mode}`).toBe('allow')
      }
    }
  })

  it('L2 在两种模式下都要人工确认，谁也不放过', () => {
    for (const config of ALL_MODES) {
      for (const t of L2_TOOLS) {
        expect(decide(t, config).kind, `${t} @ ${config.mode}`).toBe('ask')
      }
    }
  })
})

describe('decide —— 培训模式', () => {
  it('L0 放行：新生要能查规则、查队内资料', () => {
    for (const t of L0_TOOLS) expect(decide(t, training)).toEqual({ kind: 'allow' })
  })

  it('L1 放行 —— 构建与跑测试是学习循环的核心，卡住它整套培训就失效', () => {
    for (const t of L1_TOOLS) {
      expect(decide(t, training).kind, `${t} 在培训模式必须放行`).toBe('allow')
    }
  })

  it('L2 物理动作需人工确认，**不是拒绝** —— 培训一样要烧代码、也用 F407', () => {
    for (const t of L2_TOOLS) {
      const d = decide(t, training)
      expect(d.kind, `${t} 在培训模式应为 ask 而非 deny`).toBe('ask')
    }
  })

  it('烧录在培训模式下可用 —— 拦死它整套培训就跑不起来', () => {
    expect(decide('rcs_fw_flash', training).kind).toBe('ask')
  })

  it('L2 确认文案保留急停/使能线/限位，并要求第一次有人在旁', () => {
    const d = decide('rcs_pneumatic_fire', training)
    if (d.kind !== 'ask') throw new Error('应为 ask')
    expect(d.reason).toContain('急停')
    expect(d.reason).toContain('限位')
    expect(d.reason).toContain('软件停止不能替代硬件急停')
    expect(d.reason).toContain('老队员在旁边')
  })

  it('LG 代码生成需要人工确认，而不是直接放行或直接拒死', () => {
    for (const t of LG_TOOLS) {
      const d = decide(t, training)
      expect(d.kind, `${t} 在培训模式应为 ask`).toBe('ask')
    }
  })

  it('LG 的确认提示是教学提问，不是恐吓', () => {
    const d = decide('rcs_train_generate', training)
    if (d.kind !== 'ask') throw new Error('应为 ask')
    expect(d.reason).toContain('骨架跑起来了吗')
    expect(d.reason).toContain('验收')
  })

  it('LG 在开发模式放行 —— 老队员用它备课不该被拦', () => {
    for (const t of LG_TOOLS) expect(decide(t, dev).kind).toBe('allow')
  })

  it('rcs_train_scaffold 属于 L1（会往学员目录写文件），培训模式放行', () => {
    expect(levelOf('rcs_train_scaffold', training)).toBe('L1')
    expect(decide('rcs_train_scaffold', training).kind).toBe('allow')
  })

  it('只读的培训工具不该被登记为危险', () => {
    const registered = new Set(DEFAULT_DANGER_RULES.map((r) => r.tool))
    for (const t of ['rcs_train_task', 'rcs_train_review', 'rcs_train_progress']) {
      expect(registered.has(t), `${t} 是只读工具，不该登记`).toBe(false)
      expect(decide(t, training).kind).toBe('allow')
    }
  })

  // 设计稿里它是 L0「出题与判分」；实现成了只记录不判分，但会把学员的回答写进工作目录，
  // 所以登记为 L1 —— 这份清单同时是「哪些工具会落盘」的台账。
  it('rcs_train_quiz 属于 L1（会把学员的回答写进工作目录），两种模式都放行', () => {
    expect(levelOf('rcs_train_quiz', training)).toBe('L1')
    expect(decide('rcs_train_quiz', training).kind).toBe('allow')
    expect(decide('rcs_train_quiz', dev).kind).toBe('allow')
  })

  it('rcs_train_hint 属于 L1（会把 Agent 对追问的回复写进 .records），两种模式都放行', () => {
    expect(levelOf('rcs_train_hint', training)).toBe('L1')
    expect(decide('rcs_train_hint', training).kind).toBe('allow')
    expect(decide('rcs_train_hint', dev).kind).toBe('allow')
  })
})

describe('清单本身的完整性', () => {
  it('没有重复登记的工具名', () => {
    const names = DEFAULT_DANGER_RULES.map((r) => r.tool)
    expect(new Set(names).size).toBe(names.length)
  })

  it('每条规则都写了理由 —— 拒绝时要能告诉人为什么', () => {
    for (const r of DEFAULT_DANGER_RULES) {
      expect(r.reason.length, `${r.tool} 缺少理由`).toBeGreaterThan(5)
    }
  })

  it('已实现的只读检查工具没有被误登记为危险', () => {
    const registered = new Set(DEFAULT_DANGER_RULES.map((r) => r.tool))
    for (const t of L0_TOOLS) expect(registered.has(t), `${t} 不该被登记`).toBe(false)
  })
})
