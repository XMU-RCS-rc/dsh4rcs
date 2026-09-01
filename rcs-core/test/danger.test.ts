/**
 * 危险度判定测试。
 *
 * 这是整套插件里**唯一涉及人身安全**的模块，所以断言写得比别处密：
 * 每一个 L2 工具、每一种模式组合都要有明确覆盖，不靠"应该没问题"。
 */
import { describe, it, expect } from 'vitest'
import { decide, fieldGuard, levelOf, DEFAULT_DANGER_RULES } from '../src/danger.ts'
import type { GuardConfig } from '../src/danger.ts'

const dev: GuardConfig = { mode: 'dev', rules: DEFAULT_DANGER_RULES }
const field: GuardConfig = { mode: 'field', rules: DEFAULT_DANGER_RULES }

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

describe('decide —— 赛场模式（红线）', () => {
  it('L0 仍然放行：赛场上要能查规则、查知识', () => {
    for (const t of L0_TOOLS) expect(decide(t, field)).toEqual({ kind: 'allow' })
  })

  it('所有 L1 与 L2 一律拒绝', () => {
    for (const t of [...L1_TOOLS, ...L2_TOOLS]) {
      const d = decide(t, field)
      expect(d.kind, `${t} 在赛场模式必须 deny`).toBe('deny')
    }
  })

  it('拒绝原因说明赛场只读的边界', () => {
    const d = decide('rcs_fw_flash', field)
    if (d.kind !== 'deny') throw new Error('应为 deny')
    expect(d.reason).toContain('赛场模式')
    expect(d.reason).toContain('只能查')
  })
})

describe('fieldGuard —— 不可绕过的单调拒绝', () => {
  it('契约是返回拒绝原因字符串，不是布尔', () => {
    const r = fieldGuard('rcs_fw_flash', field)
    expect(typeof r).toBe('string')
    expect(r).toContain('rcs_fw_flash')
  })

  it('放行时返回 undefined 表示不干预', () => {
    expect(fieldGuard('rcs_lint_layer', field)).toBeUndefined()
  })

  it('开发模式下 guard 完全不干预（由 pre-execute 的 ask 负责）', () => {
    for (const t of [...L0_TOOLS, ...L1_TOOLS, ...L2_TOOLS]) {
      expect(fieldGuard(t, dev), `${t} 在 dev 模式不应被 guard 挡`).toBeUndefined()
    }
  })

  it('赛场模式挡住每一个 L2 工具', () => {
    for (const t of L2_TOOLS) {
      expect(fieldGuard(t, field), `${t} 必须被挡`).toBeTruthy()
    }
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
