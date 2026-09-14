/**
 * 改动小测的落盘 —— 读写 `<学员工作目录>/.records/`。
 *
 *     .records/ledger.json            还没出题的 Agent 改动（跨任务）
 *     .records/<任务>/snapshot.json    上次答题（或发基线）时的源文件
 *     .records/<任务>/<时间>.json      每一轮的题目与回答
 *
 * 判断逻辑都在 training-quiz.ts，这里只管读写。读失败一律当作「没有」：
 * 坏掉的旧文件不该挡住新的一轮。写失败照常抛出 —— 记录丢了要让人知道。
 *
 * 和 progress.json 一样放在学员工作目录，不进任何 git 仓库。
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { relPath, walkFiles } from './fsutil.ts'
import {
  BUNDLE_FORMAT,
  RECORDS_DIR,
  changeStat,
  diffSnapshots,
  isTrackedSource,
  parseLedger,
  parseRecord,
  parseSnapshot,
  quizzableChanges,
  recordFileName,
  takeEdits,
  withEdit,
} from './training-quiz.ts'
import type {
  AgentEdit,
  FileChange,
  Ledger,
  PendingTask,
  QuizRecord,
  RecordBundle,
  Snapshot,
} from './training-quiz.ts'
import { parseProgress } from './training-store.ts'

export function recordsRoot(root: string): string {
  return join(root, RECORDS_DIR)
}

const ledgerPath = (root: string): string => join(recordsRoot(root), 'ledger.json')
const taskRecordsDir = (root: string, taskId: string): string => join(recordsRoot(root), taskId)
const snapshotPath = (root: string, taskId: string): string =>
  join(taskRecordsDir(root, taskId), 'snapshot.json')

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/* ---------- 源文件 ---------- */

/** 单个源文件上限。超过的多半不是学员写的（生成物、数据表），不进快照。 */
const SOURCE_MAX_BYTES = 256 * 1024

/** 任务目录里的 C/C++ 源文件。构建目录、点目录一律跳过。 */
export function readTaskSources(root: string, taskId: string): Record<string, string> {
  const dir = join(root, taskId)
  const out: Record<string, string> = {}
  for (const file of walkFiles(dir, { skipDirs: ['cmake-build-debug', 'cmake-build-release', 'out'] })) {
    const rel = relPath(dir, file)
    if (rel.split('/').some((part) => part.startsWith('.'))) continue
    if (!isTrackedSource(rel)) continue
    try {
      if (statSync(file).size > SOURCE_MAX_BYTES) continue
      out[rel] = readFileSync(file, 'utf8')
    } catch {
      /* 读的时候被删了：当作没有 */
    }
  }
  return out
}

/** 工作目录根下的任务目录（一级子目录，不含 `.records` 这类点目录）。 */
export function taskDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

/* ---------- 台账与快照 ---------- */

export function loadLedger(root: string): Ledger {
  return parseLedger(readJson(ledgerPath(root)))
}

export function saveLedger(root: string, ledger: Ledger): void {
  writeJson(ledgerPath(root), ledger)
}

export function recordAgentEdit(root: string, edit: AgentEdit): void {
  saveLedger(root, withEdit(loadLedger(root), edit))
}

export function loadSnapshot(root: string, taskId: string): Snapshot | undefined {
  return parseSnapshot(readJson(snapshotPath(root, taskId)))
}

export function saveSnapshot(
  root: string,
  taskId: string,
  files: Record<string, string>,
  at: Date,
): void {
  const snapshot: Snapshot = { version: 1, taskId, at: at.toISOString(), files }
  writeJson(snapshotPath(root, taskId), snapshot)
}

/**
 * 把任务翻篇：`files` 记成新快照，台账里这个任务在 `at` 之前的条目取走并返回。
 * `files` 必须是 `at` 那一刻读到的 —— 之后的改动留给下一轮。
 */
export function advanceTask(
  root: string,
  taskId: string,
  files: Record<string, string>,
  at: Date,
): AgentEdit[] {
  const { taken, rest } = takeEdits(loadLedger(root), taskId, at.toISOString())
  saveSnapshot(root, taskId, files, at)
  saveLedger(root, rest)
  return taken
}

export type TaskChanges = {
  /** 没有快照就算不出「这次改了什么」，changes 恒为空。 */
  hasSnapshot: boolean
  files: Record<string, string>
  changes: FileChange[]
}

/** 当前源文件相对上次快照的改动。 */
export function currentChanges(root: string, taskId: string): TaskChanges {
  const files = readTaskSources(root, taskId)
  const snapshot = loadSnapshot(root, taskId)
  return snapshot === undefined
    ? { hasSnapshot: false, files, changes: [] }
    : { hasSnapshot: true, files, changes: diffSnapshots(snapshot.files, files) }
}

/* ---------- 记录 ---------- */

export function saveRecord(root: string, record: QuizRecord): string {
  const path = join(taskRecordsDir(root, record.taskId), recordFileName(new Date(record.at)))
  writeJson(path, record)
  return path
}

/** 读某个任务（省略则全部任务）的答题记录，按时间排序。认不出来的文件跳过。 */
export function listRecords(root: string, taskId?: string): QuizRecord[] {
  const base = recordsRoot(root)
  const taskIds = taskId !== undefined ? [taskId] : taskDirs(base)
  const out: QuizRecord[] = []
  for (const t of taskIds) {
    let names: string[]
    try {
      names = readdirSync(join(base, t))
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'snapshot.json') continue
      const record = parseRecord(readJson(join(base, t, name)))
      if (record !== undefined) out.push(record)
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

/* ---------- 导出 ---------- */

/**
 * 把工作目录里的全部记录打成一个文件的内容。只读，不改任何东西。
 * `student` 留空时用 progress.json 里的名字；两处都没有，就由调用方要求学员补上。
 */
export function buildBundle(
  root: string,
  options: { student?: string; now: Date },
): RecordBundle {
  const progress = parseProgress(readJson(join(root, 'progress.json')))
  const ledger = loadLedger(root)
  const taskIds = [
    ...new Set([...taskDirs(root), ...taskDirs(recordsRoot(root)), ...Object.keys(progress.tasks)]),
  ].sort()

  const pending: PendingTask[] = []
  for (const taskId of taskIds) {
    const { hasSnapshot, changes } = currentChanges(root, taskId)
    const open = hasSnapshot ? quizzableChanges(changes) : []
    const edits = ledger.edits.filter((e) => e.taskId === taskId)
    if (open.length > 0 || edits.length > 0) {
      pending.push({ taskId, changes: open.map(changeStat), agentEdits: edits })
    }
  }

  return {
    format: BUNDLE_FORMAT,
    version: 1,
    student: (options.student ?? '').trim() || progress.student,
    exportedAt: options.now.toISOString(),
    tasks: Object.values(progress.tasks).map((t) => ({
      taskId: t.taskId,
      scaffoldedAt: t.scaffoldedAt,
      reviews: t.reviews,
    })),
    records: listRecords(root),
    pending,
  }
}
