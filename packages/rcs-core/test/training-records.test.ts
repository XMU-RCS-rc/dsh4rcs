/**
 * 改动小测的落盘测试 —— 临时目录当学员工作目录，不碰真实的 rcs-training。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  advanceTask,
  buildBundle,
  currentChanges,
  listRecords,
  loadLedger,
  loadSnapshot,
  readTaskSources,
  recordAgentEdit,
  recordsRoot,
  saveRecord,
  saveSnapshot,
  taskDirs,
} from '../src/training-records.ts'
import { parseBundle } from '../src/training-quiz.ts'
import type { QuizRecord } from '../src/training-quiz.ts'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rcs-records-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function put(rel: string, text: string): void {
  const path = join(root, ...rel.split('/'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

const record = (at: string): QuizRecord => ({
  version: 1,
  taskId: 'demo',
  student: '小测',
  at,
  agentEdits: [],
  changes: [],
  diff: '',
  questions: [],
  answers: [],
})

describe('readTaskSources', () => {
  it('只读任务目录里的 C/C++ 源文件，跳过构建目录和点目录', () => {
    put('demo/a.c', 'int a;\n')
    put('demo/inc/a.h', '#pragma once\n')
    put('demo/CMakeLists.txt', 'project(x)\n')
    put('demo/build/gen.c', 'int g;\n')
    put('demo/.cache/x.c', 'int x;\n')
    put('demo/notes.md', '笔记\n')
    expect(Object.keys(readTaskSources(root, 'demo')).sort()).toEqual(['a.c', 'inc/a.h'])
  })

  it('任务目录不存在时返回空', () => {
    expect(readTaskSources(root, 'nope')).toEqual({})
  })
})

describe('快照、台账与翻篇', () => {
  it('没有快照时算不出改动', () => {
    put('demo/a.c', 'int a;\n')
    expect(currentChanges(root, 'demo')).toMatchObject({ hasSnapshot: false, changes: [] })
  })

  it('相对快照算改动；翻篇后清零，只取走给定时刻之前的台账', () => {
    put('demo/a.c', 'int a;\n')
    saveSnapshot(root, 'demo', readTaskSources(root, 'demo'), new Date('2026-09-15T00:00:00Z'))
    put('demo/a.c', 'int a = 1;\n')
    recordAgentEdit(root, { taskId: 'demo', file: 'a.c', tool: 'edit', at: '2026-09-15T01:00:00.000Z' })
    recordAgentEdit(root, { taskId: 'demo', file: 'a.c', tool: 'edit', at: '2026-09-15T03:00:00.000Z' })

    const now = currentChanges(root, 'demo')
    expect(now.changes.map((c) => c.file)).toEqual(['a.c'])

    const taken = advanceTask(root, 'demo', now.files, new Date('2026-09-15T02:00:00Z'))
    expect(taken).toHaveLength(1)
    expect(loadLedger(root).edits).toHaveLength(1)
    expect(currentChanges(root, 'demo').changes).toEqual([])
    expect(loadSnapshot(root, 'demo')?.at).toBe('2026-09-15T02:00:00.000Z')
  })

  it('台账文件坏了当空台账，不抛', () => {
    put('.records/ledger.json', '{坏')
    expect(loadLedger(root).edits).toEqual([])
  })
})

describe('记录', () => {
  it('按时间读回，认不出的文件跳过', () => {
    saveRecord(root, record('2026-09-15T02:00:00.000Z'))
    saveRecord(root, record('2026-09-15T01:00:00.000Z'))
    put('.records/demo/junk.json', '{"x":1}')
    saveSnapshot(root, 'demo', {}, new Date())
    expect(listRecords(root).map((r) => r.at)).toEqual([
      '2026-09-15T01:00:00.000Z',
      '2026-09-15T02:00:00.000Z',
    ])
    expect(listRecords(root, 'demo')).toHaveLength(2)
    expect(listRecords(root, 'other')).toEqual([])
  })

  it('记录落在工作目录的 .records 下', () => {
    const path = saveRecord(root, record('2026-09-15T02:00:00.000Z'))
    expect(path.startsWith(recordsRoot(root))).toBe(true)
  })

  it('taskDirs 不含 .records 这类点目录', () => {
    put('demo/a.c', '')
    saveSnapshot(root, 'demo', {}, new Date())
    expect(taskDirs(root)).toEqual(['demo'])
  })
})

describe('buildBundle —— 导出', () => {
  beforeEach(() => {
    put(
      'progress.json',
      JSON.stringify({
        version: 1,
        student: '小测',
        tasks: {
          demo: { taskId: 'demo', scaffoldedAt: '2026-09-14T00:00:00.000Z', reviews: 1, generated: 0, completedAt: null },
        },
      }),
    )
    put('demo/a.c', 'int a;\n')
    saveSnapshot(root, 'demo', readTaskSources(root, 'demo'), new Date('2026-09-15T00:00:00Z'))
    saveRecord(root, record('2026-09-15T01:00:00.000Z'))
    put('demo/a.c', 'int a = 1;\n')
  })

  it('带上记录、进度摘要和还没答题的改动；名字缺省取 progress.json', () => {
    const b = buildBundle(root, { now: new Date('2026-09-20T00:00:00Z') })
    expect(b.student).toBe('小测')
    expect(b.exportedAt).toBe('2026-09-20T00:00:00.000Z')
    expect(b.tasks).toEqual([{ taskId: 'demo', scaffoldedAt: '2026-09-14T00:00:00.000Z', reviews: 1 }])
    expect(b.records).toHaveLength(1)
    expect(b.pending).toEqual([
      { taskId: 'demo', changes: [{ file: 'a.c', status: 'modified', added: 1, removed: 1 }], agentEdits: [] },
    ])
  })

  it('--name 给的名字优先', () => {
    expect(buildBundle(root, { student: ' 张三 ', now: new Date() }).student).toBe('张三')
  })

  it('导出的内容收集那一侧读得回来', () => {
    const b = buildBundle(root, { now: new Date() })
    expect(parseBundle(JSON.parse(JSON.stringify(b))).ok).toBe(true)
  })
})
