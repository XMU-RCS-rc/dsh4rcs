/**
 * 舵轮回环与运动学检查测试。
 *
 * 断言分两类：
 *   1. **参考实现**对着 `angle_loop.h` 的语义验算 —— 本机没有 cmake/gtest，
 *      跑不了队内那份 C++ 测试，这里用等价断言补上算法覆盖。
 *   2. **静态检查**对着真实工程，基准是手工核查出的结论（含两个真 bug 与
 *      一条已确认的误报），既防漏报也防误报。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'

import {
  regularFromInfTo0, regularFromInfTo180, normalizeFrom0ToInf,
  shortestAngleDeg, shortestAngleRad, angleLoopSelfCheck, stripComments,
  checkAngleLoop, checkKinematics,
} from '../src/kin-check.ts'

const SUPPORT = 'D:/code/RCS_code/demo/RCS/RCS_Support'
const R2 = 'D:/code/RCS_code/R2'
const hasSupport = existsSync(SUPPORT)
const hasR2 = existsSync(R2)

describe('angle_loop 参考实现（移植自 angle_loop.h）', () => {
  it('regular_from_inf_to_0 把角度收进 [-180,180)', () => {
    expect(regularFromInfTo0(0)).toBe(0)
    expect(regularFromInfTo0(190)).toBe(-170)
    expect(regularFromInfTo0(-190)).toBe(170)
    expect(regularFromInfTo0(540)).toBe(-180)
  })

  it('180 归到 -180（区间左闭右开）', () => {
    expect(regularFromInfTo0(180)).toBe(-180)
    expect(regularFromInfTo0(-180)).toBe(-180)
  })

  it('regular_from_inf_to_180 把角度收进 [0,360)', () => {
    expect(regularFromInfTo180(0)).toBe(0)
    expect(regularFromInfTo180(-90)).toBe(270)
    expect(regularFromInfTo180(360)).toBe(0)
    expect(regularFromInfTo180(-370)).toBe(350)
  })

  it('复刻队内 gtest 的 regularTest：[0,360) 区间逐度比对', () => {
    for (let x = 0; x < 360; x += 1) expect(regularFromInfTo180(x)).toBeCloseTo(x, 9)
    for (let x = 360; x < 720; x += 1) expect(regularFromInfTo180(x)).toBeCloseTo(x - 360, 9)
    for (let x = -360; x < 0; x += 1) expect(regularFromInfTo180(x)).toBeCloseTo(x + 360, 9)
  })

  it('复刻队内 gtest 的 normalizeTest：不过界时保持原值', () => {
    for (let ref = -1260; ref < 1260; ref += 7) {
      const input = ref + 120
      expect(shortestAngleDeg(input, ref)).toBeCloseTo(input, 9)
    }
  })

  it('复刻队内 gtest 的 normalizeTest：过界时走最短路', () => {
    for (let ref = -1260; ref < 1260; ref += 7) {
      // 目标在前方 200°，最短路应是往后 160°
      expect(shortestAngleDeg(ref + 200, ref)).toBeCloseTo(ref - 160, 9)
      expect(shortestAngleDeg(ref - 200, ref)).toBeCloseTo(ref + 160, 9)
    }
  })

  it('两种规范化接 normalize 后等价 —— 这条曾让我写出一条错误规则', () => {
    for (const ref of [-12600, -370, -1, 0, 1, 359, 12599]) {
      for (const d of [120, -120, 200, -200, 179, 181]) {
        const a = normalizeFrom0ToInf(regularFromInfTo0(ref + d), ref)
        const b = normalizeFrom0ToInf(regularFromInfTo180(ref + d), ref)
        expect(a).toBeCloseTo(b, 9)
      }
    }
  })

  it('自检全绿', () => {
    expect(angleLoopSelfCheck().ok).toBe(true)
  })
})

describe('弧度制最短路 —— 揭示单位错配的后果', () => {
  it('弧度版能正确回环', () => {
    expect(shortestAngleRad(3.0, -3.0)).toBeCloseTo(3.0 - 2 * Math.PI, 9)
  })

  it('角度版对弧度输入是空操作：轮子会走远路', () => {
    // 这正是 kin_chassis.cpp 当前的行为
    const wrong = shortestAngleDeg(3.0, -3.0)
    expect(wrong).toBe(3.0) // 完全没变
    const travelWrong = Math.abs(wrong - -3.0)
    const travelRight = Math.abs(shortestAngleRad(3.0, -3.0) - -3.0)
    expect(travelWrong).toBeCloseTo(6.0, 9)
    expect(travelRight).toBeLessThan(0.3)
    // 走了 20 倍以上的路 —— 就是「轮子擦地卡死」
    expect(travelWrong / travelRight).toBeGreaterThan(20)
  })
})

describe('stripComments', () => {
  it('剥掉行注释但保留行数，行号不会错位', () => {
    expect(stripComments('a\n//x && y\nb').split('\n').length).toBe(3)
    expect(stripComments('a\n//x && y\nb')).not.toContain('&&')
  })

  it('剥掉块注释', () => {
    expect(stripComments('a /* || && */ b')).not.toContain('&&')
  })

  it('块注释跨行时行数不变', () => {
    const src = 'a\n/* x\n y */\nb'
    expect(stripComments(src).split('\n').length).toBe(src.split('\n').length)
  })
})

describe.skipIf(!hasSupport)('对真实 RCS_Support 工程', () => {
  it('抓到弧度/角度单位错配（find_nearest 实际是空操作）', () => {
    const r = checkAngleLoop(SUPPORT)
    const hit = r.findings.find((f) => f.rule === 'angle-loop-unit-mismatch')
    expect(hit).toBeDefined()
    expect(hit?.file).toContain('kin_chassis.cpp')
    expect(hit?.severity).toBe('error')
  })

  it('抓到 rcs_omni4::inv_kin 返回未初始化的栈内存', () => {
    const r = checkKinematics(SUPPORT)
    const hit = r.findings.find((f) => f.rule === 'kin-uninitialized-return')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('error')
  })

  it('抓到 ||/&& 优先级混用', () => {
    const r = checkKinematics(SUPPORT)
    expect(r.findings.some((f) => f.rule === 'kin-precedence-mix')).toBe(true)
  })

  it('总量必须很小 —— 太吵等于没有', () => {
    const total = checkAngleLoop(SUPPORT).findings.length + checkKinematics(SUPPORT).findings.length
    expect(total).toBeLessThanOrEqual(5)
  })

  it('不得对 angle_loop.h 自身的定义报错', () => {
    const r = checkAngleLoop(SUPPORT)
    expect(r.findings.filter((f) => f.file?.endsWith('angle_loop.h'))).toEqual([])
  })

  it('不得对 angle_loop_test.cpp 报错 —— 它是被测函数的正当用法', () => {
    const r = checkAngleLoop(SUPPORT)
    expect(r.findings.filter((f) => f.file?.includes('angle_loop_test'))).toEqual([])
  })
})

describe.skipIf(!hasR2)('对 R2（防误报基准）', () => {
  it('Ch_Ctrl.c:293 的 && 在 // 注释里，不得报优先级问题', () => {
    const r = checkKinematics(R2)
    const hit = r.findings.find((f) => f.file?.includes('Ch_Ctrl.c') && f.line === 293)
    expect(hit).toBeUndefined()
  })

  it('R2 不用 angle_loop，不该有任何回环告警', () => {
    expect(checkAngleLoop(R2).findings).toEqual([])
  })
})
