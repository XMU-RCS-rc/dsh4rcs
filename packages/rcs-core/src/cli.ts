/**
 * 命令行入口 —— 验证阶梯的 L2：**不启动 dsh 也能跑全部检查**。
 *
 * 用法：
 *   node packages/rcs-core/src/cli.ts layer-lint    ../RCS_code
 *   node packages/rcs-core/src/cli.ts template-gap  ../RCS_code
 *   node packages/rcs-core/src/cli.ts pairing       ../RCS_code
 *   node packages/rcs-core/src/cli.ts hygiene       ../RCS_code/R2
 *   node packages/rcs-core/src/cli.ts lint-embedded ../RCS_code
 *   node packages/rcs-core/src/cli.ts all           ../RCS_code
 *
 * 加 --json 输出机器可读结果。
 */
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { CheckResult } from './types.ts'
import { lintLayers } from './layer-lint.ts'
import type { LayerRulesConfig } from './layer-lint.ts'
import { checkTemplateGap, checkSupportPairing } from './template-gap.ts'
import type { TemplateManifest } from './template-gap.ts'
import { checkRepoHygiene } from './repo-hygiene.ts'
import { lintEmbedded } from './lint-embedded.ts'
import { loadJsonConfig } from './index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** packages/rcs-core/src -> 仓库根 */
export const REPO_ROOT = resolve(HERE, '..', '..', '..')
export const CONFIG_DIR = join(REPO_ROOT, 'config')

export function loadLayerRules(): LayerRulesConfig {
  return loadJsonConfig<LayerRulesConfig>(join(CONFIG_DIR, 'layer-rules.json'))
}

export function loadTemplateManifest(): TemplateManifest {
  return loadJsonConfig<TemplateManifest>(join(CONFIG_DIR, 'template-manifest.json'))
}

const SEV_MARK: Record<string, string> = { error: '✗', warn: '!', info: '·' }

function render(result: CheckResult): string {
  const lines: string[] = []
  const flag = result.ok ? 'PASS' : 'FAIL'
  lines.push(`\n[${flag}] ${result.check}  ${result.target}`)

  const statLine = Object.entries(result.stats)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ')
  if (statLine) lines.push(`       ${statLine}`)

  if (result.findings.length === 0) {
    lines.push('       无发现')
    return lines.join('\n')
  }

  for (const f of result.findings) {
    const mark = SEV_MARK[f.severity] ?? '?'
    const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : ''
    lines.push(`  ${mark} [${f.rule}] ${f.message}`)
    if (loc) lines.push(`      ${loc}`)
    if (f.detail) lines.push(`      ${f.detail}`)
  }
  return lines.join('\n')
}

function runCheck(name: string, target: string): CheckResult[] {
  switch (name) {
    case 'layer-lint':
      return [lintLayers(target, loadLayerRules())]
    case 'template-gap':
      return [checkTemplateGap(target, loadTemplateManifest())]
    case 'pairing':
      return [checkSupportPairing(target, loadTemplateManifest())]
    case 'hygiene':
      return [checkRepoHygiene(target)]
    case 'lint-embedded':
      return [lintEmbedded(target)]
    case 'all':
      return [
        lintLayers(target, loadLayerRules()),
        checkTemplateGap(target, loadTemplateManifest()),
        checkSupportPairing(target, loadTemplateManifest()),
        checkRepoHygiene(target),
        lintEmbedded(target),
      ]
    default:
      throw new Error(`未知检查：${name}（可用：layer-lint / template-gap / pairing / hygiene / lint-embedded / all）`)
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const args = argv.filter((a) => !a.startsWith('--'))
  const [check, target] = args

  if (!check || !target) {
    console.error('用法: node cli.ts <layer-lint|template-gap|pairing|hygiene|lint-embedded|all> <工程路径> [--json]')
    process.exit(2)
  }

  const results = runCheck(check, resolve(target))

  if (asJson) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    for (const r of results) console.log(render(r))
    console.log('')
  }

  process.exit(results.every((r) => r.ok) ? 0 : 1)
}

// 仅在被直接执行时运行，被 import 时不触发
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
