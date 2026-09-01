#!/usr/bin/env node
/**
 * 导入一份 ROBOCON 规则书 —— 命令行入口。
 *
 * 用法：
 *   node scripts/docx-to-rules.mjs <规则书.docx> <赛季> <版本> [--overwrite]
 *
 * 例：
 *   node scripts/docx-to-rules.mjs ./规则V1.docx 2027 V1
 *   node scripts/docx-to-rules.mjs ./2028规则.docx 2028 V0
 *
 * 产出 data/rules/<赛季>/<版本>/：
 *   source/…docx     原件归档
 *   rules.txt        纯文本全文（人看的，也便于 grep）
 *   clauses.json     结构化条款（diff 与检索的输入）
 *   meta.json        版本元信息
 *   constraints.json 数值约束表骨架（**需人工填写**，已存在则不动）
 *
 * 实现全在 `packages/rcs-core/src/rule-import.ts`，本文件只做参数解析 ——
 * dsh 工具 `rcs_rule_import` 调的是同一个模块，两条入口不会走偏。
 */
import { importRulebook } from '../packages/rcs-core/src/rule-import.ts'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const overwrite = argv.includes('--overwrite')
const [src, season, version] = argv.filter((a) => !a.startsWith('--'))

if (!src || !season || !version) {
  console.error('用法: node scripts/docx-to-rules.mjs <规则书.docx> <赛季> <版本> [--overwrite]')
  console.error('例  : node scripts/docx-to-rules.mjs ./规则V1.docx 2027 V1')
  process.exit(2)
}

let r
try {
  r = importRulebook(src, join(REPO, 'data', 'rules'), season, version, { overwrite })
} catch (e) {
  console.error(`导入失败：${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

console.log(`已导入 ${r.season}/${r.version}`)
console.log(`  段落 ${r.paragraphs}  条款 ${r.clauses}  字符 ${r.chars}`)
console.log(`  目录 ${r.dir}`)
if (r.overwrote) console.log('  （覆盖了已存在的版本）')

if (r.constraintsScaffolded) {
  console.log('')
  console.log(`  已生成 constraints.json 骨架，其中 ${r.constraintsPending} 个字段待填。`)
  console.log('  数值约束表不做自动提取 —— 规则解读错了代价是整套方案返工。')
  console.log('  请对照 clauses.json 逐条填写，并核对每个 clause 是否指向本版真实条款号。')
} else if (r.constraintsPending > 0) {
  console.log('')
  console.log(`  注意：已有的 constraints.json 还有 ${r.constraintsPending} 个字段是 null，尚未填完。`)
}

console.log('')
console.log('  下一步：跑 rcs_rule_diff 对比上一版，人工核对涉及机械/电控的改动。')
