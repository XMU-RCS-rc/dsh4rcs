/**
 * 拿一段设计描述比对规则约束，指出疑似违规点。
 *
 * ## 设计立场：只提示，不裁决
 *
 * 规则解读错误的代价是整套方案返工，所以本模块：
 *   - 每条结论都带**条款号**，让人能立刻回原文核对；
 *   - 措辞一律是「疑似/请核对」，不写「违规」——最终解释权在裁判组（13.1）；
 *   - 只做**数值与关键词**的机械比对，不做语义推断。宁可漏报也不误判。
 *
 * 数值来源是 `data/rules/<赛季>/<版本>/constraints.json`，
 * 那份文件由人工从条款提炼并逐条标注了 clause 溯源。
 */
import { readFileSync, existsSync } from 'node:fs'
import type { CheckResult, Finding } from './types.ts'
import { toResult } from './types.ts'

/** constraints.json 里带溯源的标量。 */
interface Limited {
  value: number
  clause: string
  note?: string
}

/** 只声明本模块用到的字段；constraints.json 里其余内容不影响解析。 */
export interface RuleConstraints {
  season: string
  version: string
  theme?: string
  robots: {
    massMaxKg: Limited
    startEnvelopeMm: { l: number; w: number; h: number; clause: string }
    extendedEnvelopeMm: Record<string, { w: number; l: number; h: number; clause: string }>
    autonomy?: Record<string, { mode: string; clause: string; note?: string }>
  }
  electrical: {
    batteryNominalVoltageMaxV: Limited
    circuitMaxVoltageV: Limited
    forbidden: { clause: string; items: string[] }
    laser: { standard: string; allowedClasses: number[]; clause: string }
    powerSources: { allowed: string[]; clause: string }
  }
  pneumatic: { maxPressureKPa: Limited }
  wireless: {
    allowed: string[]
    clause: string
    interRobotForbidden: { value: boolean; clause: string; note?: string }
  }
  safety: {
    emergencyStop: { required: boolean; spec: string; clause: string; note?: string }
    forbidAerial: { value: boolean; clause: string; note?: string }
  }
}

/**
 * 找出约束表里还没填的字段。
 *
 * 导入新规则书时生成的是**骨架**，数值全为 null，必须由人对照原文填写。
 * 拿着 null 去比数值会静默给出错误结论 —— 那比不检查更危险，所以直接拦下。
 * `$` 开头的键是注释/待办，不参与判断。
 */
function findUnfilled(v: unknown, path = ''): string[] {
  if (v === null) return [path || '(根)']
  if (Array.isArray(v)) return v.flatMap((x, i) => findUnfilled(x, `${path}[${i}]`))
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !k.startsWith('$'))
      .flatMap(([k, x]) => findUnfilled(x, path ? `${path}.${k}` : k))
  }
  return []
}

export function loadConstraints(file: string): RuleConstraints {
  if (!existsSync(file)) {
    throw new Error(
      `约束文件不存在：${file}\n` +
        `请先用 rcs_rule_import（或 scripts/docx-to-rules.mjs）导入该赛季版本的规则书，` +
        `导入时会自动生成 constraints.json 骨架。`,
    )
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as RuleConstraints

  const unfilled = findUnfilled(parsed)
  if (unfilled.length > 0) {
    throw new Error(
      `约束表尚未填写完成：${file}\n` +
        `还有 ${unfilled.length} 个字段是 null，例如：${unfilled.slice(0, 5).join('、')}\n` +
        `数值约束表不做自动提取（规则解读错了代价是整套方案返工），` +
        `请对照 clauses.json 逐条填写并核对条款号后再用本工具。`,
    )
  }
  return parsed
}

/** 文本里抽出的一个带单位数值。 */
export interface Quantity {
  /** 归一化后的数值。 */
  value: number
  /** 归一化后的单位：V / kPa / kg / mm */
  unit: 'V' | 'kPa' | 'kg' | 'mm'
  /** 原始写法，回显给用户看。 */
  raw: string
  /** 该数值前后的一小段上下文，用来判断它说的是什么。 */
  context: string
}

const NUMBER = String.raw`(\d+(?:\.\d+)?)`
const PATTERNS: { re: RegExp; unit: Quantity['unit']; scale: number }[] = [
  { re: new RegExp(`${NUMBER}\\s*(?:V|v|伏特?)\\b`, 'g'), unit: 'V', scale: 1 },
  { re: new RegExp(`${NUMBER}\\s*MPa`, 'gi'), unit: 'kPa', scale: 1000 },
  { re: new RegExp(`${NUMBER}\\s*kPa`, 'gi'), unit: 'kPa', scale: 1 },
  { re: new RegExp(`${NUMBER}\\s*bar`, 'gi'), unit: 'kPa', scale: 100 },
  { re: new RegExp(`${NUMBER}\\s*(?:kg|千克|公斤)`, 'gi'), unit: 'kg', scale: 1 },
  { re: new RegExp(`${NUMBER}\\s*(?:mm|毫米)`, 'gi'), unit: 'mm', scale: 1 },
  { re: new RegExp(`${NUMBER}\\s*(?:cm|厘米)`, 'gi'), unit: 'mm', scale: 10 },
]

/** 抽出文本里所有带单位的数值并归一化。 */
export function extractQuantities(text: string): Quantity[] {
  const out: Quantity[] = []
  for (const { re, unit, scale } of PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1])
      if (!Number.isFinite(n)) continue
      const start = Math.max(0, m.index - 18)
      out.push({
        value: n * scale,
        unit,
        raw: m[0].trim(),
        context: text.slice(start, m.index + m[0].length + 8).replace(/\s+/g, ' '),
      })
    }
  }
  return out
}

/**
 * 按标点切成小句。
 *
 * 用于「同一小句内才判定」的规则 —— 不分句的话，
 * 「BR 全自动，TR 手动遥控」这种完全合法的描述会被误报成 BR 违规。
 */
function splitClauses(text: string): string[] {
  return text.split(/[\u3002\uff1b;\uff0c,\n]/).filter((s) => s.trim().length > 0)
}

/** 关键词规则：命中就提示。 */
interface KeywordRule {
  id: string
  keywords: string[]
  severity: Finding['severity']
  clause: string
  message: string
}

function keywordRules(c: RuleConstraints): KeywordRule[] {
  return [
    {
      id: 'forbidden-power',
      keywords: c.electrical.forbidden.items.filter((s) => /电池|能源/.test(s)),
      severity: 'error',
      clause: c.electrical.forbidden.clause,
      message: '疑似使用被明令禁止的能源/电池',
    },
    {
      id: 'aerial-forbidden',
      keywords: ['飞行', '无人机', '旋翼', '螺旋桨'],
      severity: 'error',
      clause: c.safety.forbidAerial.clause,
      message: '疑似使用飞行机构 —— 出于安全与机构冲突，严格禁止',
    },
    {
      id: 'laser-class',
      keywords: ['激光', 'laser', 'LiDAR', '雷达'],
      severity: 'warn',
      clause: c.electrical.laser.clause,
      message: `使用激光须符合 ${c.electrical.laser.standard} 的 ${c.electrical.laser.allowedClasses.join('/')} 类，并实施相应安全措施`,
    },
    {
      id: 'inter-robot-wireless',
      keywords: ['TR与BR', 'TR和BR', 'BR与TR', '两车通信', '机器人间通信', '双机通信'],
      severity: 'error',
      clause: c.wireless.interRobotForbidden.clause,
      message: '疑似 TR 与 BR 之间无线互通 —— 比赛期间严禁',
    },
  ]
}

/**
 * 比对一段设计描述。
 *
 * @param text 设计描述，自然语言即可
 * @param c 约束表
 */
export function checkDesign(text: string, c: RuleConstraints): CheckResult {
  const findings: Finding[] = []
  const quantities = extractQuantities(text)

  const push = (
    rule: string,
    severity: Finding['severity'],
    message: string,
    clause: string,
    detail?: string,
  ): void => {
    findings.push({
      rule,
      severity,
      message,
      detail: `条款 ${clause}${detail ? ' · ' + detail : ''} · 以官方规则手册为准`,
    })
  }

  // ---- 数值比对 ----
  const battMax = c.electrical.batteryNominalVoltageMaxV
  const circMax = c.electrical.circuitMaxVoltageV
  const presMax = c.pneumatic.maxPressureKPa
  const massMax = c.robots.massMaxKg

  for (const q of quantities) {
    if (q.unit === 'V') {
      if (q.value > circMax.value) {
        push(
          'voltage-over-circuit',
          'error',
          `电压 ${q.raw} 超过电路上限 ${circMax.value}V`,
          circMax.clause,
          `上下文「${q.context}」`,
        )
      } else if (q.value > battMax.value) {
        push(
          'voltage-over-battery',
          'warn',
          `电压 ${q.raw} 超过电池标称上限 ${battMax.value}V —— 若指电池标称电压则违规，若指电路瞬时电压需 ≤${circMax.value}V`,
          `${battMax.clause}/${circMax.clause}`,
          `上下文「${q.context}」`,
        )
      }
    } else if (q.unit === 'kPa' && q.value > presMax.value) {
      push(
        'pressure-over',
        'error',
        `气压 ${q.raw}（=${q.value}kPa）超过上限 ${presMax.value}kPa`,
        presMax.clause,
        `上下文「${q.context}」`,
      )
    } else if (q.unit === 'kg' && q.value > massMax.value) {
      push(
        'mass-over',
        'error',
        `重量 ${q.raw} 超过上限 ${massMax.value}kg`,
        massMax.clause,
        `含电池、控制器与电缆 · 上下文「${q.context}」`,
      )
    } else if (q.unit === 'mm') {
      const start = c.robots.startEnvelopeMm
      const ext = c.robots.extendedEnvelopeMm['TR'] ?? c.robots.extendedEnvelopeMm['BR']
      const maxExt = ext ? Math.max(ext.w, ext.l, ext.h) : Infinity
      if (q.value > maxExt) {
        push(
          'size-over-extended',
          'error',
          `尺寸 ${q.raw} 超过运行时最大边 ${maxExt}mm`,
          ext?.clause ?? '11.5',
          `上下文「${q.context}」`,
        )
      } else if (q.value > start.l && /启动|初始|收拢|收起|入场/.test(q.context)) {
        push(
          'size-over-start',
          'warn',
          `尺寸 ${q.raw} 超过启动立方体 ${start.l}mm —— 上下文提到启动/收拢状态`,
          start.clause,
          `上下文「${q.context}」`,
        )
      }
    }
  }

  // ---- 关键词比对 ----
  for (const rule of keywordRules(c)) {
    const hit = rule.keywords.find((k) => text.includes(k))
    if (hit) push(rule.id, rule.severity, `${rule.message}（命中「${hit}」）`, rule.clause)
  }

  // ---- 必备项缺失 ----
  if (c.safety.emergencyStop.required && !/急停|急停按钮|E-?Stop|紧急停止/i.test(text)) {
    push(
      'estop-missing',
      'warn',
      `描述中未提到急停 —— 规则要求配备${c.safety.emergencyStop.spec}`,
      c.safety.emergencyStop.clause,
      '若设计中已有，忽略本条',
    )
  }

  const brAuto = c.robots.autonomy?.['BR']
  if (brAuto) {
    // 只在**同一小句**里同时出现 BR 与手动字样才判违规。
    // 不分句的话，「BR 全自动，TR 手动遥控」这种完全合法的描述会被误报 ——
    // TR 本来就允许手动（11.2）。误报比漏报更伤：一个天天喊狼来了的检查没人会看。
    const segments = splitClauses(text)
    const bad = segments.find(
      (seg) =>
        /\bBR\b|建筑机器人/.test(seg) &&
        /手动|遥控|手柄|操作手/.test(seg) &&
        !/\bTR\b|搬运机器人/.test(seg),
    )
    if (bad) {
      push(
        'br-must-be-auto',
        'error',
        `BR（建筑机器人）必须全自动，但描述中出现「${bad.trim()}」`,
        brAuto.clause,
      )
    }
  }

  return toResult('rule-check', `${c.season}/${c.version}`, findings, {
    quantities: quantities.length,
  })
}
