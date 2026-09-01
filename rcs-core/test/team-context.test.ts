/**
 * 队内上下文测试。
 *
 * 时间相关的函数一律**显式传入 today**：纯函数才好测，
 * 也避免"今天"这种隐式输入让断言随时间失效。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  TeamContext, loadTeamConfig, layerOfPath, daysUntil, nextMilestone,
} from '../src/team-context.ts'
import type { Milestone } from '../src/team-context.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')
const TEAM = join(REPO, 'config', 'team.json')
const hasConfig = existsSync(TEAM)

const LAYERS = ['RCS_HAL', 'RCS_Module', 'RCS_Support', 'RCS_Template', 'user']

describe('layerOfPath', () => {
  it('识别五个工程层次', () => {
    expect(layerOfPath('RCS_Support/inc/gps.h', LAYERS)).toBe('RCS_Support')
    expect(layerOfPath('RCS/RCS_Module/src/x.cpp', LAYERS)).toBe('RCS_Module')
    expect(layerOfPath('user/app_main.cpp', LAYERS)).toBe('user')
  })

  it('兼容反斜杠', () => {
    expect(layerOfPath('RCS\\RCS_HAL\\src\\rcs_can.c', LAYERS)).toBe('RCS_HAL')
  })

  it('识别不出返回 undefined，而不是瞎猜', () => {
    expect(layerOfPath('Core/Src/main.c', LAYERS)).toBeUndefined()
  })

  it('长层名优先，避免 user 误命中 RCS_Template 下的 user_test', () => {
    // RCS_Template 应该赢，因为路径里它是完整的一段
    expect(layerOfPath('RCS_Template/user_test.c', LAYERS)).toBe('RCS_Template')
  })
})

describe('daysUntil / nextMilestone', () => {
  const today = new Date('2027-01-01T12:00:00Z')
  const ms: Milestone[] = [
    { id: 'a', label: 'A', date: '2027-01-11', done: false },
    { id: 'b', label: 'B', date: '2027-07-15', done: false },
    { id: 'c', label: 'C', date: '2026-09-01', done: true },
    { id: 'd', label: 'D', date: null, done: false },
  ]

  it('算天数不受时分秒影响', () => {
    expect(daysUntil(ms[0]!, today)).toBe(10)
  })

  it('无日期返回 null，而不是 0 或今天', () => {
    expect(daysUntil(ms[3]!, today)).toBeNull()
  })

  it('下一个节点取最近的未完成且未过期项', () => {
    expect(nextMilestone(ms, today)?.id).toBe('a')
  })

  it('全部过期时返回 undefined', () => {
    expect(nextMilestone(ms, new Date('2028-01-01T00:00:00Z'))).toBeUndefined()
  })
})

describe('loadTeamConfig 错误处理', () => {
  it('文件不存在时给出可操作的错误', () => {
    expect(() => loadTeamConfig('D:/nowhere/team.json')).toThrow(/队内配置不存在/)
  })
})

describe.skipIf(!hasConfig)('TeamContext 对真实 config/team.json', () => {
  const ctx = TeamContext.fromFile(TEAM)
  const today = new Date('2027-01-01T00:00:00Z')

  it('赛季与主题正确', () => {
    expect(ctx.season).toBe('2027')
    expect(ctx.theme).toBe('女娲补天')
    expect(ctx.rulesVersion).toBe('V0')
  })

  it('机器人角色与规则一致：BR 必须全自动', () => {
    expect(ctx.robot('BR')?.autonomy).toBe('full-auto-required')
    expect(ctx.robot('TR')?.autonomy).toBe('manual-or-auto')
    expect(ctx.robot('br')?.id).toBe('BR') // 大小写不敏感
    expect(ctx.robot('XR')).toBeUndefined()
  })

  it('区域限制与规则 4.3 一致：TR 禁入 L1/L2', () => {
    expect(ctx.mayEnter('TR', 'L1')).toBe(false)
    expect(ctx.mayEnter('TR', 'ground')).toBe(true)
    expect(ctx.mayEnter('BR', 'L2')).toBe(true)
    expect(ctx.mayEnter('BR', 'ground')).toBe(false)
    expect(ctx.mayEnter('XR', 'L1')).toBeUndefined()
  })

  it('携带上限与规则 3.4 一致', () => {
    expect(ctx.robot('TR')?.carryLimit).toBe(3)
    expect(ctx.robot('BR')?.carryLimit).toBe(2)
  })

  it('倒计时按天数升序，已完成项被排除', () => {
    const cd = ctx.countdown(today)
    const days = cd.map((c) => c.days)
    expect(days).toEqual([...days].sort((a, b) => a - b))
    expect(cd.some((c) => c.milestone.id === 'theme')).toBe(false) // done: true
  })

  it('摘要包含赛季、主题与技术栈', () => {
    const s = ctx.summary(today)
    expect(s).toContain('2027')
    expect(s).toContain('女娲补天')
    expect(s).toContain('stm32f407')
  })

  it('工程层次识别可用', () => {
    expect(ctx.layerOf('RCS_Support/inc/sync_pid.h')).toBe('RCS_Support')
  })
})
