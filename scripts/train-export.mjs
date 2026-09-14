#!/usr/bin/env node
/**
 * 新生这一侧：把本机的培训记录打成一个文件，交给老队员。
 *
 *   npm run train:export                        名字取 progress.json 里的 student
 *   npm run train:export -- --name 张三
 *   npm run train:export -- --workspace E:/rcs-training --out D:/交作业/张三.json
 *
 * 只读：不清 .records、不动代码。导出的是改动小测每一轮的题目、你的回答原文、
 * 那一轮的代码改动，以及导出时还没答题的改动。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveWorkspaceRoot } from '../packages/rcs-core/src/training-store.ts'
import { buildBundle } from '../packages/rcs-core/src/training-records.ts'
import { bundleStats, exportFileName } from '../packages/rcs-core/src/training-quiz.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = [
  '用法：npm run train:export -- [--name 你的名字] [--workspace 培训目录] [--out 输出文件]',
  '  --name       记录上写的名字；不写就用 progress.json 里的 student',
  '  --workspace  培训工作目录；不写就按 RCS_TRAINING_HOME > 与本仓库同级的 rcs-training 找',
  '  --out        输出文件；不写就在当前目录生成 rcs-training-records-<名字>-<日期>.json',
].join('\n')

function note(message) {
  process.stderr.write(`${message}\n`)
}

/** 取 `--name 值` 这种参数。值缺失时返回错误说明，而不是悄悄当作没给。 */
function option(args, name) {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return { value: undefined }
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) return { error: `--${name} 后面要跟一个值` }
  return { value }
}

function main(args) {
  const known = new Set(['--name', '--workspace', '--out'])
  for (const arg of args) {
    if (arg.startsWith('--') && !known.has(arg)) {
      note(`不认识的参数：${arg}`)
      note(USAGE)
      return 1
    }
  }
  const name = option(args, 'name')
  const workspace = option(args, 'workspace')
  const out = option(args, 'out')
  for (const o of [name, workspace, out]) {
    if (o.error !== undefined) {
      note(o.error)
      note(USAGE)
      return 1
    }
  }

  const ws = resolveWorkspaceRoot({
    explicit: workspace.value ?? '',
    env: process.env,
    repoRoot: REPO,
    home: homedir(),
  })
  if (!existsSync(ws.root)) {
    note(`找不到培训工作目录：${ws.root}（来源：${ws.from}）`)
    note('装在别处就加 --workspace <目录>，或设环境变量 RCS_TRAINING_HOME。')
    return 1
  }

  const now = new Date()
  const bundle = buildBundle(ws.root, { student: name.value ?? '', now })
  if (bundle.student === '') {
    note('不知道这份记录是谁的：progress.json 里没有名字。请加上 --name，例如：')
    note('  npm run train:export -- --name 张三')
    return 1
  }

  const file = resolve(out.value ?? exportFileName(bundle.student, now))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')

  const s = bundleStats(bundle)
  note(`工作目录：${ws.root}（来源：${ws.from}）`)
  note(`学员：${bundle.student}`)
  note(
    `改动小测 ${s.rounds} 轮 / ${s.questions} 题${s.blank > 0 ? `（${s.blank} 题空着）` : ''}；` +
      `导出时还有 ${s.pendingFiles} 个文件的改动没答题`,
  )
  if (s.rounds === 0) {
    note('注意：一轮答题记录都没有。改动小测只在 npm run dsh:start:training 下开启 ——')
    note('      培训时用的若是 npm run dsh:start，就不会有记录。')
  }
  note('')
  note(`已导出：${file}`)
  note('把这个文件交给老队员。里面只有改动小测的题目、你的回答和对应的代码改动。')
  return 0
}

// 不用 process.exit()：stderr 指向管道时写入是异步的，强退可能截掉最后一行。
process.exitCode = main(process.argv.slice(2))
