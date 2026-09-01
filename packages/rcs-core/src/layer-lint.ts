/**
 * 分层红线检查 —— 本套工具里价值最高的一个。
 *
 * 新模板（RCS_HAL / RCS_Module / RCS_Support / RCS_Template / user）的分层
 * 目前只靠 `请读我.txt` 的口头约定维持。R2 的教训是约定挡不住 deadline，
 * 主题代码最终混进了公共库。这个检查把约定变成机器可验证的规则。
 *
 * 三条规则：
 *   1. support-no-vendor  —— RCS_Support 不得依赖 HAL/RTOS（**支持传递依赖**）
 *   2. module-actor-base  —— 执行器必须继承 rcs_actor
 *   3. lib-no-theme-code  —— 主题代码只能待在 user/
 */
import { join } from 'node:path'
import type { CheckResult, Finding, Severity } from './types.ts'
import { toResult } from './types.ts'
import { walkFiles, readText, relPath, parseIncludes, fileName } from './fsutil.ts'

export interface PurityRule {
  id: string
  layer: string
  severity: Severity
  /** 是否追踪队内头文件的传递依赖。关掉会漏掉经 rcs_private_config.h 的污染。 */
  transitive: boolean
  /** 禁止的头文件名正则（针对 basename）。 */
  forbidHeaders: string[]
  /** 明确放行的头文件 basename。 */
  allowHeaders?: string[]
  message: string
}

export interface ActorRule {
  id: string
  severity: Severity
  dir: string
  baseClass: string
  exempt?: string[]
  message: string
}

export interface ThemeRule {
  id: string
  severity: Severity
  confineTo: string
  patterns: string[]
  message: string
}

export interface LayerRulesConfig {
  libRoot: string
  layers: { layer: string; dir: string; order: number; description: string }[]
  purityRules: PurityRule[]
  actorRule?: ActorRule
  themeRule?: ThemeRule
}

/** 建立 basename → 绝对路径 的队内头文件索引。解析不到的即视为系统/厂商头。 */
function buildHeaderIndex(libRoot: string): Map<string, string> {
  const index = new Map<string, string>()
  for (const f of walkFiles(libRoot, { extensions: ['.h', '.hpp'] })) {
    const name = fileName(f)
    // 同名头取第一个；真实工程里同名头本身就该避免
    if (!index.has(name)) index.set(name, f)
  }
  return index
}

interface Violation {
  header: string
  /** 从被检查文件到违规头的依赖链（basename 序列）。 */
  chain: string[]
  /** 直接依赖时的行号。 */
  line?: number
}

/**
 * 从一个源文件出发，找出所有命中 forbidHeaders 的依赖（可选传递）。
 * 用 BFS 并记录路径，好让报告能说清「经由谁污染的」。
 */
function findForbidden(
  entry: string,
  rule: PurityRule,
  headerIndex: Map<string, string>,
): Violation[] {
  const forbid = rule.forbidHeaders.map((p) => new RegExp(p, 'i'))
  const allow = new Set(rule.allowHeaders ?? [])
  const violations: Violation[] = []
  const seenHeader = new Set<string>()
  const visitedFile = new Set<string>([entry])

  // 队列元素：待解析的文件 + 到达它的链
  const queue: { file: string; chain: string[] }[] = [{ file: entry, chain: [] }]

  while (queue.length > 0) {
    const cur = queue.shift()
    if (!cur) break
    const includes = parseIncludes(readText(cur.file))

    for (const inc of includes) {
      const base = fileName(inc.header)
      if (allow.has(base)) continue

      if (forbid.some((re) => re.test(base))) {
        if (!seenHeader.has(base)) {
          seenHeader.add(base)
          violations.push({
            header: base,
            chain: [...cur.chain, base],
            line: cur.chain.length === 0 ? inc.line : undefined,
          })
        }
        continue
      }

      if (!rule.transitive) continue
      const resolved = headerIndex.get(base)
      if (resolved && !visitedFile.has(resolved)) {
        visitedFile.add(resolved)
        queue.push({ file: resolved, chain: [...cur.chain, base] })
      }
    }
  }
  return violations
}

function checkPurity(libRoot: string, rule: PurityRule, config: LayerRulesConfig): Finding[] {
  const layer = config.layers.find((l) => l.layer === rule.layer)
  if (!layer) return []
  const layerDir = join(libRoot, layer.dir)
  const headerIndex = buildHeaderIndex(libRoot)
  const findings: Finding[] = []

  for (const file of walkFiles(layerDir, { extensions: ['.c', '.cpp', '.h', '.hpp'] })) {
    const violations = findForbidden(file, rule, headerIndex)
    if (violations.length === 0) continue

    // 按「第一跳」聚合。不聚合的话，一个 rcs_private_config.h 会在每个文件上
    // 炸出 11 条重复发现（它自己 include 了 11 个厂商/RTOS 头），报告没法看。
    // 聚合后每个文件每个污染源只出一条，而修复动作恰恰也是按污染源来做的。
    const groups = new Map<string, Violation[]>()
    for (const v of violations) {
      const key = v.chain[0] ?? v.header
      const g = groups.get(key)
      if (g) g.push(v)
      else groups.set(key, [v])
    }

    for (const [firstHop, vs] of groups) {
      const head = vs[0]
      if (!head) continue
      const isDirect = head.chain.length === 1

      if (isDirect) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          message: `${rule.message}：直接 include ${head.header}`,
          file: relPath(libRoot, file),
          ...(head.line !== undefined ? { line: head.line } : {}),
          detail: '直接依赖 —— 删除该 include，或把需要 RTOS 的部分下沉到 RCS_HAL。',
        })
      } else {
        const leaves = vs.map((v) => v.header)
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          message: `${rule.message}：经 ${firstHop} 传递引入 ${leaves.length} 个厂商/RTOS 头`,
          file: relPath(libRoot, file),
          detail:
            `${fileName(file)} -> ${firstHop} -> {${leaves.slice(0, 4).join(', ')}` +
            `${leaves.length > 4 ? ` …共 ${leaves.length} 个` : ''}}。${firstHop} 本身是污染源。`,
        })
      }
    }
  }
  return findings
}

function checkActorBase(libRoot: string, rule: ActorRule): Finding[] {
  const dir = join(libRoot, rule.dir)
  const exempt = new Set(rule.exempt ?? [])
  const findings: Finding[] = []
  // 继承声明通常写在头文件里，故把实现文件映射回同名头一起看
  const headerIndex = buildHeaderIndex(libRoot)
  const baseRe = new RegExp(`:\\s*(public|protected|private)?\\s*${rule.baseClass}\\b`)

  for (const file of walkFiles(dir, { extensions: ['.cpp', '.c'] })) {
    const base = fileName(file)
    if (exempt.has(base)) continue

    const header = headerIndex.get(base.replace(/\.(cpp|c)$/, '.h'))
    const text = readText(file) + (header ? '\n' + readText(header) : '')
    if (!baseRe.test(text)) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        message: rule.message,
        file: relPath(libRoot, file),
        detail: `未找到继承 ${rule.baseClass} 的声明。绕过执行器总线会导致控制不连续。`,
      })
    }
  }
  return findings
}

function checkThemeCode(libRoot: string, rule: ThemeRule): Finding[] {
  const patterns = rule.patterns.map((p) => new RegExp(p, 'i'))
  const findings: Finding[] = []

  for (const file of walkFiles(libRoot, { extensions: ['.c', '.cpp', '.h', '.hpp'] })) {
    const rel = relPath(libRoot, file)
    if (rel.startsWith(rule.confineTo + '/')) continue
    const base = fileName(file)
    if (patterns.some((re) => re.test(base))) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        message: rule.message,
        file: rel,
        detail: `文件名命中主题代码特征。RCS/ 是跨赛季资产，主题相关代码应移入 ${rule.confineTo}/。`,
      })
    }
  }
  return findings
}

/**
 * 对一个工程执行全部分层检查。
 * @param projectRoot 仓库根目录（如 `D:/code/RCS_code`）
 * @param config 分层规则，来自 `config/layer-rules.json`
 */
export function lintLayers(projectRoot: string, config: LayerRulesConfig): CheckResult {
  const libRoot = join(projectRoot, config.libRoot)
  const findings: Finding[] = []

  for (const rule of config.purityRules) {
    findings.push(...checkPurity(libRoot, rule, config))
  }
  if (config.actorRule) findings.push(...checkActorBase(libRoot, config.actorRule))
  if (config.themeRule) findings.push(...checkThemeCode(libRoot, config.themeRule))

  const byRule: Record<string, number> = {}
  for (const f of findings) byRule[`rule:${f.rule}`] = (byRule[`rule:${f.rule}`] ?? 0) + 1

  return toResult('layer-lint', libRoot, findings, byRule)
}
