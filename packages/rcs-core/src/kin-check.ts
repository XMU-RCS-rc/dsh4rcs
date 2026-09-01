/**
 * 舵轮角度回环与底盘运动学检查。
 *
 * ## 为什么值得单独做一个检查器
 *
 * 这两处是电控最容易出**沉默错误**的地方：代码能编译、能跑、不报错，
 * 但机器人在场上行为诡异。`kin_chassis.cpp` 自己的注释就写着：
 *
 * > 如果直接把 inv_kin 得到的值下发给电机，是不能让底盘边走边转的。
 * > 因为当底盘在 360 度和 180 度附近时，会挑选距离更远的路线，使得轮子擦地卡死。
 *
 * 这类问题在静态检查里能抓，在赛场上只会表现为「今天车有点怪」。
 *
 * ## 参考实现直接照搬 angle_loop.h
 *
 * 下面的 `regularFromInfTo0` 等函数是 `RCS_Support/inc/angle_loop.h` 的逐行移植，
 * **不是我另写的一套**。它们的用途是给工具提供可验算的基准（例如回答
 * 「当前角 -3.0、目标角 3.0，最短路应该是多少」），并让本机在没有
 * cmake/gtest 的情况下也能跑等价的回归测试。
 *
 * ⚠️ 移植版与原版一样是**角度制**。这一点正是下面第一条检查要抓的东西。
 */
import { join } from 'node:path'

import type { Finding, CheckResult } from './types.ts'
import { toResult } from './types.ts'
import { walkFiles, readText, relPath, isCppFile } from './fsutil.ts'

// ---------- angle_loop.h 的移植（角度制） ----------

/** 把 (-∞,+∞) 的角度转到 [-180,180)。移植自 `angle_loop::regular_from_inf_to_0`。 */
export function regularFromInfTo0(angleDeg: number): number {
  let r = angleDeg % 360
  if (r < 0) r += 360
  if (r > 180) r -= 360
  if (r === 180) r = -180
  return r
}

/** 把 (-∞,+∞) 的角度转到 [0,360)。移植自 `angle_loop::regular_from_inf_to_180`。 */
export function regularFromInfTo180(angleDeg: number): number {
  const r = regularFromInfTo0(angleDeg)
  return r < 0 ? r + 360 : r
}

/**
 * 给定规范化目标角与参考角，求最接近参考角的等价角。
 * 移植自 `angle_loop::normalize_from_0_to_inf`。
 */
export function normalizeFrom0ToInf(angleRegularDeg: number, refInfDeg: number): number {
  const k = Math.round((refInfDeg - angleRegularDeg) / 360)
  return angleRegularDeg + k * 360
}

/** 角度制的最短路：先规范化再回环。等价于 `find_nearest` 对单个轮子做的事。 */
export function shortestAngleDeg(targetDeg: number, currentDeg: number): number {
  return normalizeFrom0ToInf(regularFromInfTo0(targetDeg), currentDeg)
}

/**
 * 弧度制的最短路 —— **这是 `inv_kin` 的输出真正需要的版本**。
 *
 * `inv_kin` 用 `atan2f` 产生角度，单位是弧度；而 `angle_loop` 全套是角度制。
 * 两者直接对接时，`fmod(x,360)` 对 |x|≤π 是恒等变换、`round(diff/360)` 恒为 0，
 * 于是回环**整体退化为空操作**，而且不报任何错。
 */
export function shortestAngleRad(targetRad: number, currentRad: number): number {
  const TWO_PI = Math.PI * 2
  let r = targetRad % TWO_PI
  if (r < 0) r += TWO_PI
  if (r > Math.PI) r -= TWO_PI
  return r + Math.round((currentRad - r) / TWO_PI) * TWO_PI
}

// ---------- 静态检查 ----------

/** 厂商目录一律不看 —— 与 lint-embedded 保持一致。 */
const VENDOR_DIRS = ['Drivers', 'CMSIS', 'Middlewares', 'HAL_Driver', 'Third_Party', 'lib', 'build']

/** 弧度↔角度转换的常见写法。出现其一即认为作者已意识到单位问题。 */
const UNIT_CONVERSION = /57\.29|57\.3|180\.0?f?\s*\/\s*(M_)?PI|(M_)?PI\s*\/\s*180|RAD2DEG|DEG2RAD|rad2deg|deg2rad|radiansToDegrees|degreesToRadians/

function sourceFiles(root: string): string[] {
  return walkFiles(root, { extensions: ['.c', '.cpp', '.h', '.hpp'], skipDirs: VENDOR_DIRS }).filter(isCppFile)
}

/**
 * 剥掉注释，**保留行数**（注释行替换成等长空行，行号才不会错位）。
 *
 * 不做这一步就会踩到实测过的误报：R2 的 `Ch_Ctrl.c:293` 写着
 * `if (sign_front == 1 || time_state >= 3000) //&& sign_back == 0)`，
 * 被注释掉的 `&&` 触发了「混用 ||/&&」告警。注释里的代码不是代码。
 */
export function stripComments(source: string): string {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
  return out
}

/** 找出某个模式所在的行号（1-based）。找不到返回 undefined。 */
function lineOf(lines: string[], test: (l: string) => boolean): number | undefined {
  const i = lines.findIndex(test)
  return i < 0 ? undefined : i + 1
}

/**
 * 角度回环检查。
 *
 * 只报**能说清后果**的问题。诸如「这里可以用回环」之类的建议一概不报 ——
 * 本仓库反复付过学费：误报比漏报更伤，天天喊狼来了的检查没人看。
 */
export function checkAngleLoop(root: string): CheckResult {
  const findings: Finding[] = []

  for (const file of sourceFiles(root)) {
    const raw = readText(file)
    if (!raw) continue
    const rel = relPath(root, file)
    // 注释里的代码不是代码 —— 全部规则都对剥注释后的文本做判断
    const text = stripComments(raw)
    const lines = text.split(/\r?\n/)

    const usesAngleLoop = /angle_loop\s*::/.test(text)
    const usesAtan = /\batan2f?\s*\(/.test(text)

    // ① 单位错配：atan2 产生弧度，angle_loop 全套是角度制
    if (usesAngleLoop && usesAtan && !UNIT_CONVERSION.test(text)) {
      findings.push({
        rule: 'angle-loop-unit-mismatch',
        severity: 'error',
        file: rel,
        line: lineOf(lines, (l) => /angle_loop\s*::/.test(l)),
        message:
          '同一文件里 atan2 的输出（弧度）直接进了 angle_loop（角度制），且全文没有弧度↔角度转换',
        detail:
          'angle_loop 内部是 fmod(x,360) 与 round(diff/360)。对 |x|≤π 的弧度输入，' +
          'fmod 是恒等变换、round 恒为 0 —— 回环整体退化为空操作，且不报任何错。\n' +
          '实例：目标角 3.0 rad、当前角 -3.0 rad，期望走最短路 0.28 rad（16°），' +
          '实际会走 6.0 rad（344°），正是 kin_chassis.cpp 注释里说的「轮子擦地卡死」。\n' +
          '修法二选一：把角度在进 angle_loop 前转成角度制，或改用弧度制的回环实现。',
      })
    }

    // ② 只规范化、不回环 —— 「规范化」和「实现」是两步，少了后一步就没有最短路
    const regularAt = lineOf(lines, (l) => /angle_loop\s*::\s*regular_from_inf_to_(0|180)/.test(l))
    if (regularAt !== undefined && !/normalize_from_0_to_inf/.test(text) && /\binv_kin\s*\(|\bangle\s*\[/.test(text)) {
      findings.push({
        rule: 'angle-loop-no-normalize',
        severity: 'warn',
        file: rel,
        line: regularAt,
        message: '只调用了 regular_*（规范化），没有 normalize_from_0_to_inf（回环）—— 缺了求最短路这一步',
        detail:
          'angle_loop 的两步是分开的：规范化把角度收进有限区间，回环才把它映射到离当前角最近的等价角。' +
          '只做前一步，舵轮过边界时仍会走远路。',
      })
    }
  }

  /*
   * 曾经有第三条规则：「求最短路时用 regular_from_inf_to_180（[0,360)）是错的，
   * 应当用 regular_from_inf_to_0（[-180,180)）」。**这条规则是错的，已删除。**
   *
   * 验算表明两者接 normalize_from_0_to_inf 之后完全等价：两种规范化的结果恰好
   * 相差 360 的整数倍，而 normalize 会把它们映射到同一个值。队内自己的
   * `angle_loop_test.cpp::regular_180_to_normal_loop` 正是在断言这一点。
   *
   * 它上线时一次性喷出 15 条误报（全部落在 angle_loop.h 的定义处和它自己的测试里），
   * 把唯一一条真错误淹掉了。留这段注释是为了别有人凭「命名看着别扭」再把它加回来。
   */

  return toResult('angle-loop', root, findings)
}

/**
 * 底盘运动学检查。
 *
 * 覆盖 `kin_chassis.h` 里白纸黑字写下的约定：舵轮编号 0/1/2/3、X 轴为 0°、
 * 逆时针为正、含重心修正 bias_x/bias_y；以及 `find_nearest` 的正确用法。
 */
export function checkKinematics(root: string): CheckResult {
  const findings: Finding[] = []

  for (const file of sourceFiles(root)) {
    const raw = readText(file)
    if (!raw) continue
    const rel = relPath(root, file)
    // 注释里的代码不是代码 —— 全部规则都对剥注释后的文本做判断
    const text = stripComments(raw)
    const lines = text.split(/\r?\n/)

    // ① inv_kin 的结果没经过 find_nearest 就下发 —— 源码注释明确警告过
    if (/\binv_kin\s*\(/.test(text) && !/\bfind_nearest\s*\(/.test(text)) {
      findings.push({
        rule: 'kin-find-nearest-bypassed',
        severity: 'error',
        file: rel,
        line: lineOf(lines, (l) => /\binv_kin\s*\(/.test(l)),
        message: '调用了 inv_kin 但全文没有 find_nearest —— 舵轮角度未做最短路处理',
        detail:
          'kin_chassis.cpp 原注释：「如果直接把 inv_kin 得到的值下发给电机，是不能让底盘边走边转的。' +
          '因为当底盘在 360 度和 180 度附近时，会挑选距离更远的路线，使得轮子擦地卡死。」\n' +
          '正确顺序：inv_kin 得理论目标 → find_nearest 求最短路 → 下发给电机。',
      })
    }

    // ② 空壳实现：算了中间量却返回未初始化的 struct
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i] ?? ''
      const m = /^\s*\w[\w:<>,\s*&]*\b(\w+)::(inv_kin|kin)\s*\(/.exec(head)
      if (!m) continue
      // 取函数体（到下一个顶格 `}`）
      let end = i + 1
      while (end < lines.length && !/^\}/.test(lines[end] ?? '')) end++
      const body = lines.slice(i, end + 1).join('\n')
      const retVar = /^\s*[\w:]+\s+(\w+);\s*$/m.exec(body)?.[1]
      if (!retVar) continue
      const assigned = new RegExp(`\\b${retVar}\\s*\\.\\s*\\w+`).test(body)
      if (!assigned && new RegExp(`return\\s+${retVar}\\s*;`).test(body)) {
        findings.push({
          rule: 'kin-uninitialized-return',
          severity: 'error',
          file: rel,
          line: i + 1,
          message: `${m[1]}::${m[2]} 返回了从未赋值的 ${retVar} —— 调用方拿到的是未初始化的栈内存`,
          detail:
            '函数体里算了中间量却没有写进返回值。编译器不会报错，运行时得到随机数，' +
            '表现为「电机乱转」或「完全不动」，且每次上电不一样，极难定位。',
        })
      }
    }

    // ③ `a || b || c && d` —— && 优先级高于 ||，多半不是本意
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? ''
      if (!/\|\|/.test(l) || !/&&/.test(l)) continue
      if (/\(/.test(l.split('&&')[0]?.split('||').pop() ?? '')) continue // 已显式加括号
      findings.push({
        rule: 'kin-precedence-mix',
        severity: 'warn',
        file: rel,
        line: i + 1,
        message: '同一条件里混用 || 与 && 且未加括号 —— && 优先级更高，实际语义多半不是本意',
        detail:
          '例如 `a<0 || b<0 || c<0 && d<0` 会被解析成 `a<0 || b<0 || (c<0 && d<0)`，' +
          '于是只有 c、d 同时越界才报警，单独 c 越界会被漏掉。加括号即可消除歧义。',
      })
    }

    // ④ 重心修正传 0 —— 多半是还没量，属于提示不是错误
    const biasZero = /rcs_agv4\s*\w*\s*\(([^)]*)\)/.exec(text)
    if (biasZero) {
      const args = (biasZero[1] ?? '').split(',').map((s) => s.trim())
      if (args.length === 4 && /^0(\.0*f?)?$/.test(args[2] ?? '') && /^0(\.0*f?)?$/.test(args[3] ?? '')) {
        findings.push({
          rule: 'kin-bias-zero',
          severity: 'info',
          file: rel,
          line: lineOf(lines, (l) => /rcs_agv4\s*\w*\s*\(/.test(l)),
          message: 'rcs_agv4 的 bias_x / bias_y 都传了 0 —— 重心修正未启用',
          detail:
            '若重心确实在几何中心，这没问题；若只是还没量，底盘自转时会有额外的横向漂移。' +
            '单位是 mm，量一次即可。',
        })
      }
    }
  }

  return toResult('kinematics', root, findings)
}

/**
 * 数值自检：把移植版参考实现与已知结论对一遍。
 *
 * 工具可以调它回答「我这个角度该转到哪」，也可作为移植是否走样的自检。
 */
export function angleLoopSelfCheck(): { ok: boolean; cases: { name: string; got: number; want: number }[] } {
  const cases = [
    { name: 'regular(190) → -170', got: regularFromInfTo0(190), want: -170 },
    { name: 'regular(180) → -180', got: regularFromInfTo0(180), want: -180 },
    { name: 'regular(-190) → 170', got: regularFromInfTo0(-190), want: 170 },
    { name: 'regular180(-90) → 270', got: regularFromInfTo180(-90), want: 270 },
    { name: '最短路(deg): 目标 170，当前 -170 → -190', got: shortestAngleDeg(170, -170), want: -190 },
    { name: '最短路(deg): 目标 -170，当前 170 → 190', got: shortestAngleDeg(-170, 170), want: 190 },
  ]
  return { ok: cases.every((c) => Math.abs(c.got - c.want) < 1e-9), cases }
}

/** 供工具直接引用的工程路径推断：优先 template，其次 demo。 */
export function guessSupportRoot(repoRoot: string): string {
  return join(repoRoot, 'demo', 'RCS', 'RCS_Support')
}
