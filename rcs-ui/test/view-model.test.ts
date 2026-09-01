/**
 * UI 视图模型测试。
 *
 * 重点有二：
 *   1. 投影函数**不得抛异常** —— presentCall/presentResult 按契约必须是全函数，
 *      一抛就把整条消息的渲染搞崩，而回放旧会话时输入完全不可控。
 *   2. `rankRootCauses` 在**真实数据**上要真能给出修复优先级，而不只是能跑。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  layerOf, groupByFile, rankRootCauses, templateProgress,
  healthFromFindings, toPresentationMeta, isRcsMeta, statsLine, severityTone,
} from '../src/index.ts'
import { lintLayers } from '../../rcs-core/src/layer-lint.ts'
import { loadLayerRules } from '../../rcs-core/src/cli.ts'

const PROJECT = process.env['RCS_PROJECT'] ?? 'D:/code/RCS_code'
const hasProject = existsSync(join(PROJECT, 'template', 'RCS_Template_F407'))

describe('layerOf', () => {
  it('从路径识别工程层次', () => {
    expect(layerOf('RCS_Support/inc/gps.h')).toBe('RCS_Support')
    expect(layerOf('RCS_Module/src/rcs_actor/rcs_cylinder.cpp')).toBe('RCS_Module')
    expect(layerOf('user/app_main.cpp')).toBe('user')
    expect(layerOf('somewhere/else.c')).toBe('unknown')
    expect(layerOf(undefined)).toBe('unknown')
  })

  it('兼容反斜杠路径（Windows）', () => {
    expect(layerOf('RCS_Support\\inc\\gps.h')).toBe('RCS_Support')
  })
})

describe('投影函数必须是全函数（不得抛）', () => {
  it('空输入不抛', () => {
    expect(() => groupByFile([])).not.toThrow()
    expect(() => rankRootCauses([])).not.toThrow()
    expect(() => toPresentationMeta({})).not.toThrow()
    expect(() => templateProgress([])).not.toThrow()
  })

  it('字段全缺失的 finding 不抛，且填上占位', () => {
    const g = groupByFile([{}])
    expect(g).toHaveLength(1)
    expect(g[0]?.path).toBe('(无文件)')
    expect(g[0]?.matches[0]?.lineNumber).toBe(1) // 搜索卡片要求 1-based
    expect(g[0]?.matches[0]?.line).toBe('(无说明)')
  })

  it('statsLine 面对任意垃圾输入都返回字符串', () => {
    expect(statsLine(null)).toBe('')
    expect(statsLine(undefined)).toBe('')
    expect(statsLine('not an object')).toBe('')
    expect(statsLine(42)).toBe('')
    expect(statsLine({ a: 1, b: 0, c: 'x' })).toBe('a=1') // 0 与非数值都跳过
  })

  it('severityTone 面对未知级别退化为 neutral', () => {
    expect(severityTone('error')).toBe('critical')
    expect(severityTone('warn')).toBe('warning')
    expect(severityTone('info')).toBe('neutral')
    expect(severityTone(undefined)).toBe('neutral')
    expect(severityTone('随便什么')).toBe('neutral')
  })
})

describe('toPresentationMeta 与回放守卫', () => {
  it('产出的 meta 能通过自己的类型守卫', () => {
    const meta = toPresentationMeta({
      check: 'layer-lint',
      target: 'D:/x',
      ok: false,
      findings: [{ severity: 'error', message: 'boom', file: 'a.c', line: 3 }],
    })
    expect(isRcsMeta(meta)).toBe(true)
    expect(meta.total).toBe(1)
    expect(meta.truncated).toBe(false)
  })

  it('超出 limit 时标记截断，且 total 是截断前的总数', () => {
    const findings = Array.from({ length: 120 }, (_, i) => ({
      severity: 'warn' as const,
      message: `m${i}`,
      file: `f${i}.c`,
    }))
    const meta = toPresentationMeta({ check: 'x', findings }, 50)
    expect(meta.total).toBe(120) // 搜索卡片靠它显示"已截断"
    expect(meta.truncated).toBe(true)
    expect(meta.groups).toHaveLength(50)
  })

  it('守卫拒绝非本插件的 meta', () => {
    expect(isRcsMeta(null)).toBe(false)
    expect(isRcsMeta({ kind: 'other' })).toBe(false)
    expect(isRcsMeta({ kind: 'rcs-check' })).toBe(false) // 缺 groups/total
  })
})

describe('healthFromFindings', () => {
  it('无发现是满分', () => {
    const h = healthFromFindings('x', [])
    expect(h.score).toBe(100)
    expect(h.tone).toBe('success')
  })

  it('error 权重高于 warn，且不会跌破 0', () => {
    expect(healthFromFindings('x', [{ severity: 'error' }]).score).toBe(95)
    expect(healthFromFindings('x', [{ severity: 'warn' }]).score).toBe(99)
    const many = Array.from({ length: 100 }, () => ({ severity: 'error' as const }))
    expect(healthFromFindings('x', many).score).toBe(0)
  })
})

describe('templateProgress', () => {
  it('按 step 分组，关键例程缺失标记为 blocked', () => {
    const vm = templateProgress([
      { step: 3, state: 'present', critical: false },
      { step: 3, state: 'missing', critical: true },
      { step: 5, state: 'alias', critical: false },
    ])
    expect(vm.overall).toEqual({ done: 2, total: 3, percent: 67 })
    expect(vm.steps.find((s) => s.step === 3)?.blocked).toBe(true)
    expect(vm.steps.find((s) => s.step === 5)?.blocked).toBe(false)
  })
})

describe.skipIf(!hasProject)('rankRootCauses 对真实工程', () => {
  it('把 rcs_private_config.h 排为首要污染源', () => {
    const r = lintLayers(PROJECT, loadLayerRules())
    const causes = rankRootCauses(r.findings)

    expect(causes.length).toBeGreaterThan(0)
    // 实测：rcs_private_config.h 自己 include 了 11 个厂商/RTOS 头，
    // 是 RCS_Support 多个文件无法 PC 编译的共同根因。
    const top = causes[0]
    expect(top?.header).toBe('rcs_private_config.h')
    expect(top?.affectedFiles).toBeGreaterThan(1)
  })

  it('排名给出的是修复优先级：先修的影响面最大', () => {
    const r = lintLayers(PROJECT, loadLayerRules())
    const causes = rankRootCauses(r.findings)
    const counts = causes.map((c) => c.affectedFiles)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
  })
})
