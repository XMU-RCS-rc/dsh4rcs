/**
 * 例程缺口比对 + RCS_Support 头源配对检查。
 *
 * 模板作者在 `请读我.txt` 里规划了 step1~step8 共 18 个例程，作为新人培养路径。
 * 例程缺一个，学习链就断一节。这个检查让缺口随时可见，而不是等新人卡住才发现。
 *
 * 配对检查的关键在于 **不误报**：`kin_diff.h`（模板类）与 `angle_loop.h`（内联）
 * 有头无源属正常设计，白名单化处理。
 */
import { join } from 'node:path'
import type { CheckResult, Finding } from './types.ts'
import { toResult } from './types.ts'
import { walkFiles, fileName, relPath } from './fsutil.ts'

export interface TemplateExample {
  step: number
  topic: string
  name: string
  /** 实际文件名与计划名不一致时的容错。 */
  aliases?: string[]
  /** 标记为关键节点，缺失时升级为 error。 */
  critical?: boolean
  note?: string
}

export interface TemplateManifest {
  source: string
  templateDir: string
  examples: TemplateExample[]
  supportDir: string
  /** 已核实「有头无源属正常设计」的白名单。 */
  headerOnly: string[]
}

export interface ExampleStatus {
  name: string
  step: number
  topic: string
  /** present=按计划名找到；alias=按别名找到；missing=缺失 */
  state: 'present' | 'alias' | 'missing'
  matchedFile?: string
  critical: boolean
  note?: string
}

/** 例程清单的详细状态，供工具渲染表格。 */
export interface TemplateGapReport {
  planned: number
  present: number
  missing: number
  statuses: ExampleStatus[]
}

function stemsOf(dir: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const f of walkFiles(dir, { extensions: ['.c', '.cpp', '.h', '.hpp'] })) {
    const stem = fileName(f).replace(/\.(c|cpp|h|hpp)$/, '')
    if (!map.has(stem)) map.set(stem, f)
  }
  return map
}

/** 只算状态，不生成 Finding —— 供工具直接渲染清单。 */
export function analyzeTemplateGap(projectRoot: string, manifest: TemplateManifest): TemplateGapReport {
  const dir = join(projectRoot, manifest.templateDir)
  const stems = stemsOf(dir)
  const statuses: ExampleStatus[] = []

  for (const ex of manifest.examples) {
    let state: ExampleStatus['state'] = 'missing'
    let matched: string | undefined

    if (stems.has(ex.name)) {
      state = 'present'
      matched = ex.name
    } else {
      const alias = (ex.aliases ?? []).find((a) => stems.has(a))
      if (alias) {
        state = 'alias'
        matched = alias
      }
    }

    statuses.push({
      name: ex.name,
      step: ex.step,
      topic: ex.topic,
      state,
      ...(matched ? { matchedFile: matched } : {}),
      critical: ex.critical === true,
      ...(ex.note ? { note: ex.note } : {}),
    })
  }

  return {
    planned: statuses.length,
    present: statuses.filter((s) => s.state !== 'missing').length,
    missing: statuses.filter((s) => s.state === 'missing').length,
    statuses,
  }
}

/** 例程缺口检查。关键例程缺失记 error，普通缺失记 warn，别名匹配记 info。 */
export function checkTemplateGap(projectRoot: string, manifest: TemplateManifest): CheckResult {
  const report = analyzeTemplateGap(projectRoot, manifest)
  const findings: Finding[] = []

  for (const s of report.statuses) {
    if (s.state === 'missing') {
      findings.push({
        rule: s.critical ? 'template-missing-critical' : 'template-missing',
        severity: s.critical ? 'error' : 'warn',
        message: `例程缺失：${s.name}（step${s.step} · ${s.topic}）`,
        file: `${manifest.templateDir}/${s.name}`,
        ...(s.note ? { detail: s.note } : {}),
      })
    } else if (s.state === 'alias') {
      findings.push({
        rule: 'template-name-mismatch',
        severity: 'info',
        message: `例程名与计划不一致：计划 ${s.name}，实际 ${s.matchedFile}`,
        file: `${manifest.templateDir}/${s.matchedFile}`,
        detail: '建议对齐命名，或在 template-manifest.json 中确认此别名。',
      })
    }
  }

  return toResult('template-gap', join(projectRoot, manifest.templateDir), findings, {
    planned: report.planned,
    present: report.present,
    missing: report.missing,
  })
}

/**
 * RCS_Support 头源配对检查：每个 .h 应有同名 .c/.cpp，
 * 除非在 headerOnly 白名单里（模板类、纯内联实现）。
 */
export function checkSupportPairing(projectRoot: string, manifest: TemplateManifest): CheckResult {
  const dir = join(projectRoot, manifest.supportDir)
  const incDir = join(dir, 'inc')
  const srcDir = join(dir, 'src')
  const allow = new Set(manifest.headerOnly)
  const findings: Finding[] = []

  const srcStems = new Set(
    walkFiles(srcDir, { extensions: ['.c', '.cpp'] }).map((f) =>
      fileName(f).replace(/\.(c|cpp)$/, ''),
    ),
  )

  for (const h of walkFiles(incDir, { extensions: ['.h', '.hpp'] })) {
    const base = fileName(h)
    if (allow.has(base)) continue
    const stem = base.replace(/\.(h|hpp)$/, '')
    if (!srcStems.has(stem)) {
      findings.push({
        rule: 'support-header-without-source',
        severity: 'warn',
        message: `${base} 有头无源`,
        file: relPath(projectRoot, h),
        detail: '若为模板类或纯内联实现，请加入 template-manifest.json 的 headerOnly 白名单。',
      })
    }
  }

  return toResult('support-pairing', dir, findings, { headerOnlyAllowed: allow.size })
}
