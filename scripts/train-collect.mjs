#!/usr/bin/env node
/**
 * 老队员这一侧：把新生交上来的记录文件汇总成报告。
 *
 *   npm run train:collect -- D:/收作业                    目录里所有 .json
 *   npm run train:collect -- a.json b.json --out D:/报告
 *
 * 每人一份 <名字>.md，外加一份 index.md 总表。默认写到 ./training-reports/
 * （已 gitignore —— 这是新生的个人数据，不入库）。
 *
 * 报告只摆事实：题目、回答原文、改动、还没答题的改动。**不判分** ——
 * 是否掌握以当面提问为准。认不出的文件跳过并报出来，不静默吞掉。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  bundleStats,
  parseBundle,
  renderCollectIndex,
  renderTraineeReport,
  safeFileName,
} from '../packages/rcs-core/src/training-quiz.ts'

const USAGE = [
  '用法：npm run train:collect -- <文件或目录…> [--out 报告目录]',
  '  目录只看第一层的 .json；--out 不写就是 ./training-reports/',
].join('\n')

function note(message) {
  process.stderr.write(`${message}\n`)
}

function main(args) {
  let outDir = 'training-reports'
  const inputs = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--out') {
      const value = args[++i]
      if (value === undefined || value.startsWith('--')) {
        note('--out 后面要跟一个目录')
        return 1
      }
      outDir = value
    } else if (arg.startsWith('--')) {
      note(`不认识的参数：${arg}`)
      note(USAGE)
      return 1
    } else {
      inputs.push(arg)
    }
  }
  if (inputs.length === 0) {
    note(USAGE)
    return 1
  }

  let skipped = 0
  const files = []
  for (const input of inputs) {
    const path = resolve(input)
    if (!existsSync(path)) {
      note(`找不到：${path}`)
      skipped++
      continue
    }
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (name.toLowerCase().endsWith('.json')) files.push(join(path, name))
      }
    } else {
      files.push(path)
    }
  }
  if (files.length === 0) {
    note('没有找到任何 .json 文件。')
    return 1
  }

  const rows = []
  const reports = []
  const used = new Set()
  for (const file of files) {
    let raw
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      note(`跳过 ${file}：不是合法的 JSON（${error instanceof Error ? error.message : String(error)}）`)
      skipped++
      continue
    }
    const parsed = parseBundle(raw)
    if (!parsed.ok) {
      note(`跳过 ${file}：${parsed.problems.join('；')}`)
      skipped++
      continue
    }
    if (parsed.dropped > 0) note(`注意：${file} 里有 ${parsed.dropped} 条记录格式不对，已略过`)
    const { bundle } = parsed
    // 同名（比如同一个人导出了两次）不互相覆盖，各留一份
    let base = safeFileName(bundle.student)
    for (let k = 2; used.has(base.toLowerCase()); k++) base = `${safeFileName(bundle.student)}-${k}`
    used.add(base.toLowerCase())
    const report = `${base}.md`
    reports.push({ report, text: renderTraineeReport(bundle) })
    rows.push({ student: bundle.student, exportedAt: bundle.exportedAt, report, ...bundleStats(bundle) })
  }
  if (rows.length === 0) {
    note('没有一份能读的记录，没有生成报告。')
    return 1
  }

  const out = resolve(outDir)
  mkdirSync(out, { recursive: true })
  for (const { report, text } of reports) writeFileSync(join(out, report), text, 'utf8')
  rows.sort((a, b) => a.student.localeCompare(b.student, 'zh'))
  writeFileSync(join(out, 'index.md'), renderCollectIndex(rows), 'utf8')

  note(`汇总了 ${rows.length} 份记录${skipped > 0 ? `，跳过 ${skipped} 个（原因见上）` : ''}`)
  note(`总表：${join(out, 'index.md')}`)
  note('报告只摆题目和回答原文，不打分；是否掌握，以当面提问为准。')
  return skipped > 0 ? 1 : 0
}

// 不用 process.exit()：stderr 指向管道时写入是异步的，强退可能截掉最后一行。
process.exitCode = main(process.argv.slice(2))
