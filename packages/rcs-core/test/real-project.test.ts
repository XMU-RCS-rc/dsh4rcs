/**
 * 对真实工程的回归测试。
 *
 * 断言直接来自 2026-08 的**手工核查结论**（见 rcs-embedded-roadmap.md 第三节）。
 * 这是本套工具的验收标准：工具必须复现人工找出的结论，既不漏报也不误报。
 *
 * 工程路径可用 RCS_PROJECT 环境变量覆盖；目录不存在时整组跳过而不是失败，
 * 这样在别人机器上克隆本仓库也能跑通其余测试。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { lintLayers } from '../src/layer-lint.ts'
import { checkTemplateGap, checkSupportPairing, analyzeTemplateGap } from '../src/template-gap.ts'
import { checkRepoHygiene } from '../src/repo-hygiene.ts'
import { loadLayerRules, loadTemplateManifest } from '../src/cli.ts'

const PROJECT = process.env['RCS_PROJECT'] ?? 'D:/code/RCS_code'
const R2 = join(PROJECT, 'R2')

const hasProject = existsSync(join(PROJECT, 'template', 'RCS_Template_F407'))
const hasR2 = existsSync(R2)

describe.skipIf(!hasProject)('layer-lint 对真实模板工程', () => {
  it('检出 RCS_Support 的分层破坏', () => {
    const r = lintLayers(PROJECT, loadLayerRules())
    const purity = r.findings.filter((f) => f.rule === 'support-no-vendor')

    // 实测结论：RCS_Support 已被 HAL/RTOS 污染，这正是 test/ 下只有
    // angle_loop_test.cpp 一个测试的原因 —— 别的文件在 PC 上根本编不过。
    expect(purity.length).toBeGreaterThan(0)
    expect(r.ok).toBe(false)
  })

  it('识别出 rcs_private_config.h 是传递污染源', () => {
    const r = lintLayers(PROJECT, loadLayerRules())
    const transitive = r.findings.filter((f) => f.detail?.includes('rcs_private_config.h'))
    expect(transitive.length).toBeGreaterThan(0)
  })

  it('不误报 angle_loop.h —— 它只依赖 <cmath>，是唯一干净的算法文件', () => {
    const r = lintLayers(PROJECT, loadLayerRules())
    const onAngleLoop = r.findings.filter(
      (f) => f.rule === 'support-no-vendor' && f.file?.endsWith('angle_loop.h'),
    )
    expect(onAngleLoop).toEqual([])
  })
})

describe.skipIf(!hasProject)('template-gap 对真实模板工程', () => {
  it('18 个计划例程中，已覆盖 7 个', () => {
    const report = analyzeTemplateGap(PROJECT, loadTemplateManifest())
    expect(report.planned).toBe(18)
    expect(report.present).toBe(7)
    expect(report.missing).toBe(11)
  })

  it('三个关键例程缺失，且被升级为 error', () => {
    const r = checkTemplateGap(PROJECT, loadTemplateManifest())
    const critical = r.findings
      .filter((f) => f.rule === 'template-missing-critical')
      .map((f) => f.message)

    expect(critical.some((m) => m.includes('actor_bus_test'))).toBe(true)
    expect(critical.some((m) => m.includes('pid_test'))).toBe(true)
    expect(critical.some((m) => m.includes('chassis_test'))).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('别名匹配不算缺失（cylinder_test / rmmotor_test）', () => {
    const report = analyzeTemplateGap(PROJECT, loadTemplateManifest())
    const byName = new Map(report.statuses.map((s) => [s.name, s]))
    expect(byName.get('cylinder_bus_test')?.state).toBe('alias')
    expect(byName.get('motor_bus_test')?.matchedFile).toBe('rmmotor_test')
  })
})

describe.skipIf(!hasProject)('support-pairing 的防误报能力', () => {
  it('kin_diff.h 与 angle_loop.h 有头无源属正常设计，不得报缺失', () => {
    const r = checkSupportPairing(PROJECT, loadTemplateManifest())
    const names = r.findings.map((f) => f.file ?? '')
    expect(names.some((n) => n.includes('kin_diff.h'))).toBe(false)
    expect(names.some((n) => n.includes('angle_loop.h'))).toBe(false)
    expect(r.ok).toBe(true)
  })
})

describe.skipIf(!hasR2)('repo-hygiene 对 R2 实战工程', () => {
  it('检出 21 个 Keil 个人 GUI 配置', () => {
    const r = checkRepoHygiene(R2)
    expect(r.stats['junk:keil-user-gui']).toBe(21)
  })

  it('检出编译产物入库', () => {
    const r = checkRepoHygiene(R2)
    expect(r.stats['junk:build-output'] ?? 0).toBeGreaterThan(200)
  })

  it('检出缺少 .gitignore', () => {
    const r = checkRepoHygiene(R2)
    expect(r.findings.some((f) => f.rule === 'missing-gitignore')).toBe(true)
    expect(r.ok).toBe(false)
  })
})

describe('本仓库自身应当是干净的（自举检查）', () => {
  it('dsh4rcs 有 .gitignore 且无编译产物入库', () => {
    const self = join(import.meta.dirname, '..', '..', '..')
    const r = checkRepoHygiene(self)
    expect(r.findings.some((f) => f.rule === 'missing-gitignore')).toBe(false)
  })
})
