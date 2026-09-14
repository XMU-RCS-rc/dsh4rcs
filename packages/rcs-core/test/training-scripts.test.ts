/**
 * train:export → train:collect 走一遍 —— 真的起 node 进程跑两个脚本。
 *
 * 临时目录当学员工作目录。验的是交接那一环：新生导出的文件，老队员那边读得回来，
 * 报告里有回答原文；坏文件跳过并如实报出来，不拖垮其它人的报告。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { saveRecord, saveSnapshot } from '../src/training-records.ts'
import { BUNDLE_FORMAT } from '../src/training-quiz.ts'
import type { QuizRecord } from '../src/training-quiz.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')

let dir = ''
let ws = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rcs-train-scripts-'))
  ws = join(dir, 'rcs-training')
  mkdirSync(join(ws, 'demo'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(script: string, args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', script), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, RCS_TRAINING_HOME: '' },
  })
  return { status: r.status, stderr: r.stderr }
}

function progress(student: string): void {
  writeFileSync(
    join(ws, 'progress.json'),
    JSON.stringify({
      version: 1,
      student,
      tasks: { demo: { taskId: 'demo', scaffoldedAt: '2026-09-14T00:00:00.000Z', reviews: 1, generated: 0, completedAt: null } },
    }),
    'utf8',
  )
}

const record: QuizRecord = {
  version: 1,
  taskId: 'demo',
  student: '小测',
  at: '2026-09-15T12:00:00.000Z',
  agentEdits: [{ taskId: 'demo', file: 'demo.c', tool: 'edit', at: '2026-09-15T11:59:00.000Z' }],
  changes: [{ file: 'demo.c', status: 'modified', added: 4, removed: 0 }],
  diff: '--- demo.c（修改，+4 / −0）',
  questions: [
    {
      id: 'q1',
      kind: 'why',
      file: 'demo.c',
      line: 3,
      code: 'return v * 2;',
      text: 'demo.c 第 3 行为什么这样写？它在这次改动里起什么作用？',
      context: '▶    3 │     return v * 2;',
    },
  ],
  answers: [{ id: 'q1', text: '乘 2 就是左移一位' }],
}

describe('train:export → train:collect', () => {
  it('导出的文件收集那一侧读得回来，报告里有回答原文和还没答题的改动', () => {
    progress('小测')
    writeFileSync(join(ws, 'demo', 'demo.c'), 'int x;\n', 'utf8')
    saveSnapshot(ws, 'demo', { 'demo.c': 'int x;\n' }, new Date('2026-09-15T00:00:00Z'))
    saveRecord(ws, record)
    writeFileSync(join(ws, 'demo', 'demo.c'), 'int x = 1;\n', 'utf8') // 导出时还没答题的改动

    const exported = run('train-export.mjs', ['--workspace', ws, '--out', join(dir, 'inbox', 'a.json')])
    expect(exported.status, exported.stderr).toBe(0)
    expect(exported.stderr).toContain('已导出')
    const bundle = JSON.parse(readFileSync(join(dir, 'inbox', 'a.json'), 'utf8')) as {
      format: string
      student: string
    }
    expect(bundle).toMatchObject({ format: BUNDLE_FORMAT, student: '小测' })

    const collected = run('train-collect.mjs', [join(dir, 'inbox'), '--out', join(dir, 'reports')])
    expect(collected.status, collected.stderr).toBe(0)
    const report = readFileSync(join(dir, 'reports', '小测.md'), 'utf8')
    expect(report).toContain('> 乘 2 就是左移一位')
    expect(report).toContain('demo.c（+1 / −1）')
    expect(readFileSync(join(dir, 'reports', 'index.md'), 'utf8')).toContain('小测')
  })

  it('progress.json 里没有名字又没给 --name：拒绝导出，并说怎么补', () => {
    progress('')
    const r = run('train-export.mjs', ['--workspace', ws, '--out', join(dir, 'a.json')])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('--name')
    expect(existsSync(join(dir, 'a.json'))).toBe(false)
  })

  it('--name 覆盖 progress.json 里的名字', () => {
    progress('小测')
    const r = run('train-export.mjs', ['--workspace', ws, '--name', '张三', '--out', join(dir, 'a.json')])
    expect(r.status, r.stderr).toBe(0)
    expect((JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')) as { student: string }).student).toBe('张三')
  })

  it('一轮记录都没有时照常导出，但提醒只有培训模式才出题', () => {
    progress('小测')
    const r = run('train-export.mjs', ['--workspace', ws, '--out', join(dir, 'a.json')])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('dsh:start:training')
  })

  it('坏文件跳过并报出来，其它人的报告照常生成，退出码非 0', () => {
    progress('小测')
    saveRecord(ws, record)
    expect(run('train-export.mjs', ['--workspace', ws, '--out', join(dir, 'inbox', 'good.json')]).status).toBe(0)
    writeFileSync(join(dir, 'inbox', 'bad.json'), '{"format":"别的东西"}', 'utf8')

    const r = run('train-collect.mjs', [join(dir, 'inbox'), '--out', join(dir, 'reports')])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('跳过')
    expect(r.stderr).toContain('bad.json')
    expect(existsSync(join(dir, 'reports', '小测.md'))).toBe(true)
  })

  it('不认识的参数直接报错，不猜', () => {
    expect(run('train-export.mjs', ['--nmae', '张三']).stderr).toContain('不认识的参数')
    expect(run('train-collect.mjs', []).status).toBe(1)
  })
})
