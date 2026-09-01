/**
 * 车相关契约的测试。
 *
 * 这些能力**故意不实现**（等实车），所以测试的重点不是"算得对不对"，
 * 而是"**没配好时会不会假装能用**"—— 一张编造的 CAN 映射会让人相信
 * 一个看似合理的错误解读，那比工具缺失危险得多。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  loadBusMap, scaffoldBusMap, parseRobotLog, advisePid, PENDING_VEHICLE_CAPABILITIES,
} from '../src/vehicle-contract.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')

describe('loadBusMap 的拒绝行为', () => {
  it('空表拒绝，并说清为什么现在不该有表', () => {
    const r = loadBusMap(scaffoldBusMap('2027'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('还没填')
    expect(r.reason).toContain('底盘全新')
  })

  it('非对象输入拒绝', () => {
    expect(loadBusMap(null).ok).toBe(false)
    expect(loadBusMap('x').ok).toBe(false)
  })

  it('缺 season / chassis 时逐项列出', () => {
    const r = loadBusMap({ entries: [{ canId: '0x201', mechanism: 'a', actuator: 'rm3508', direction: 'feedback' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.missing).toContain('season')
  })

  it('条目字段缺失时拒绝', () => {
    const r = loadBusMap({
      season: '2027', chassis: '4舵轮',
      entries: [{ canId: '0x201', mechanism: '左前轮' }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.missing.join()).toContain('actuator')
  })

  it('canId 不是十六进制字符串时拒绝 —— 写成数字 513 与 0x201 极易混淆', () => {
    const r = loadBusMap({
      season: '2027', chassis: '4舵轮',
      entries: [{ canId: 513, mechanism: 'a', actuator: 'rm3508', direction: 'feedback' }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('十六进制')
  })

  it('跨赛季套用时拒绝 —— 这是本模块存在的首要理由', () => {
    const map = {
      season: '2026', chassis: '4舵轮',
      entries: [{ canId: '0x201', mechanism: '左前轮', actuator: 'rm3508', direction: 'feedback' }],
    }
    const r = loadBusMap(map, '2027')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('跨赛季')
  })

  it('填完整且赛季一致时才通过', () => {
    const map = {
      season: '2027', chassis: '4舵轮',
      entries: [
        { canId: '0x201', mechanism: '底盘左前轮', actuator: 'rm3508', direction: 'feedback', gearRatio: 19 },
        { canId: '0x205', mechanism: '抬升机构', actuator: 'rm2006', direction: 'feedback' },
      ],
    }
    const r = loadBusMap(map, '2027')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.map.entries).toHaveLength(2)
  })
})

describe('未实现的能力要明确抛错，不能返回空结果冒充成功', () => {
  it('日志解析：说清需要什么样本', () => {
    expect(() => parseRobotLog('anything')).toThrow(/日志样本/)
  })

  it('PID 建议：说清约束是「只建议不写参数」', () => {
    expect(() => advisePid([])).toThrow(/不自动写参数/)
  })
})

describe('待办清单', () => {
  it('三块能力各自写明缺什么、被什么卡住', () => {
    expect(PENDING_VEHICLE_CAPABILITIES).toHaveLength(3)
    for (const c of PENDING_VEHICLE_CAPABILITIES) {
      expect(c.needs.length).toBeGreaterThan(5)
      expect(c.blockedBy.length).toBeGreaterThan(5)
    }
  })
})

describe('仓库里的骨架文件', () => {
  it('config/bus-map.json 存在且当前是空表 —— 存在即入口，填了就生效', () => {
    const p = join(REPO, 'config', 'bus-map.json')
    if (!existsSync(p)) return
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { entries?: unknown[] }
    expect(raw.entries).toEqual([])
    expect(loadBusMap(raw).ok).toBe(false)
  })
})
