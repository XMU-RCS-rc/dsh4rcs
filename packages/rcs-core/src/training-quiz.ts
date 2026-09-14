/**
 * 改动小测 —— 纯逻辑，不碰文件系统与 dsh。
 *
 * ## 做什么
 *
 * 培训模式下，Agent 改了学员工作目录里的代码，本轮结束前就**这次的改动**
 * 出 1–3 道开放题，学员在 dsh 的问答框里作答。回答原样存到工作目录的
 * `.records/`，培训结束后由 `npm run train:export` 导出、交给老队员。
 *
 * ## 三条约束
 *
 * 1. **题目不带答案、不判分。** training-design.md §5 的红线：让模型编嵌入式
 *    C 题，会产出看似合理、其实是错的标准答案。所以这里只有三种开放题型，
 *    每道题必须钉在这次改动过的某一行上 —— 模型只挑位置、给变体或情形，
 *    题干由模板生成，答案一律不写。
 * 2. **不瞒学员。** 记录就在学员自己的电脑上，瞒不住，也没必要瞒：问答框、
 *    启动横幅、领任务时都明说「回答会给老队员看」。能做到的只是界面上不回看、
 *    回答不回传进对话。
 * 3. **记录是给老队员挑追问方向用的，不是考试。** 学员让 Agent 替他答，拦不住；
 *    当面提问才是真正的检验 —— 与 rcs_train_review 不判定「学会了」是同一条原则。
 */
import { isAbsolute, relative } from 'node:path'

/* ---------- 常量 ---------- */

/** 记录目录，放在学员工作目录根下，与 progress.json 同级。 */
export const RECORDS_DIR = '.records'

/** 一轮最多几道题。多了学员会嫌烦，敷衍着答反而没用。 */
export const MAX_QUESTIONS = 3

/** 问答框里给学员看的那句话。各处说法要一致，所以只写一份。 */
export const QUIZ_NOTICE =
  '回答会原样存在你的培训目录里，培训结束后导出交给老队员看；这里不评分，写你自己的理解就好。'

/** 领任务、发基线时给学员的说明。 */
export const QUIZ_INTRO =
  `培训模式下有「改动小测」：Agent 改了你的代码后，会就这次改动问你 1–${MAX_QUESTIONS} 个问题。` +
  QUIZ_NOTICE

/* ---------- 哪些文件算数 ---------- */

/** 只看 C/C++ 源文件。改 CMakeLists、写笔记不出题 —— 培训要问的是代码。 */
const SOURCE_EXT = /\.(c|h|cc|cpp|cxx|hh|hpp|hxx)$/i

export function isTrackedSource(file: string): boolean {
  return SOURCE_EXT.test(file)
}

/**
 * 学员工作目录里的一个文件属于哪个任务。
 *
 * 任务目录是工作目录根下的一级子目录（`<根>/<任务id>/…`），与 taskWorkspace 一致。
 * 不在任何任务目录里、或者在 `.records` 这类点目录里的，返回 undefined。
 * `rel` 统一用正斜杠，记录里的路径跨平台一致。
 */
export function taskOfPath(
  root: string,
  file: string,
): { taskId: string; rel: string } | undefined {
  if (!isAbsolute(file)) return undefined
  const r = relative(root, file)
  if (r === '' || isAbsolute(r)) return undefined
  const parts = r.split(/[\\/]/).filter((p) => p !== '')
  if (parts.length < 2 || parts[0] === '..') return undefined
  const [taskId, ...rest] = parts
  if (taskId === undefined || taskId.startsWith('.')) return undefined
  if (rest.some((p) => p === '..' || p.startsWith('.'))) return undefined
  return { taskId, rel: rest.join('/') }
}

/* ---------- Agent 改动台账 ---------- */

/** 经 dsh 文件工具观测到的一次 Agent 改动。 */
export type AgentEdit = {
  taskId: string
  /** 任务目录内的相对路径，正斜杠。 */
  file: string
  /** 哪个宿主工具写的：write / edit / str_replace_editor。 */
  tool: string
  at: string
}

/** 自上次答题以来还没出题的 Agent 改动。答完一轮，就把那个任务的条目取走。 */
export type Ledger = { version: 1; edits: AgentEdit[] }

/** 台账最多留多少条。一轮里改几百次说明出了别的问题，不该让文件无限长。 */
const LEDGER_CAP = 500

export function emptyLedger(): Ledger {
  return { version: 1, edits: [] }
}

function isAgentEdit(value: unknown): value is AgentEdit {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Partial<AgentEdit>
  return (
    typeof e.taskId === 'string' &&
    typeof e.file === 'string' &&
    typeof e.tool === 'string' &&
    typeof e.at === 'string'
  )
}

/** 从磁盘读到的东西可能是任何形状。坏了就当空台账 —— 最多少问一轮，验收时还有兜底。 */
export function parseLedger(raw: unknown): Ledger {
  if (typeof raw !== 'object' || raw === null) return emptyLedger()
  const l = raw as Partial<Ledger>
  if (l.version !== 1 || !Array.isArray(l.edits)) return emptyLedger()
  return { version: 1, edits: l.edits.filter(isAgentEdit) }
}

export function withEdit(ledger: Ledger, edit: AgentEdit): Ledger {
  return { version: 1, edits: [...ledger.edits, edit].slice(-LEDGER_CAP) }
}

/**
 * 取走某个任务的条目。给了 `until` 就只取那个时刻（含）之前的 ——
 * 学员在问答框开着的时候又让 Agent 改了代码，那一笔属于下一轮，不能跟着这一轮翻篇。
 */
export function takeEdits(
  ledger: Ledger,
  taskId: string,
  until?: string,
): { taken: AgentEdit[]; rest: Ledger } {
  const hit = (e: AgentEdit): boolean =>
    e.taskId === taskId && (until === undefined || e.at <= until)
  return {
    taken: ledger.edits.filter(hit),
    rest: { version: 1, edits: ledger.edits.filter((e) => !hit(e)) },
  }
}

/** 台账里有改动的任务，按第一次出现的顺序。 */
export function pendingTaskIds(ledger: Ledger): string[] {
  return [...new Set(ledger.edits.map((e) => e.taskId))]
}

/* ---------- 快照 ---------- */

/** 上次答题（或发基线）时任务目录里源文件的样子。「这次改动」就是相对它算的。 */
export type Snapshot = {
  version: 1
  taskId: string
  at: string
  /** 任务目录内相对路径（正斜杠）→ 内容。 */
  files: Record<string, string>
}

export function parseSnapshot(raw: unknown): Snapshot | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const s = raw as Partial<Snapshot>
  if (
    s.version !== 1 ||
    typeof s.taskId !== 'string' ||
    typeof s.at !== 'string' ||
    typeof s.files !== 'object' ||
    s.files === null
  ) {
    return undefined
  }
  const files: Record<string, string> = {}
  for (const [k, v] of Object.entries(s.files)) if (typeof v === 'string') files[k] = v
  return { version: 1, taskId: s.taskId, at: s.at, files }
}

/* ---------- 差异 ---------- */

/**
 * 一行差异。`newLine` 是新文件里的行号（1 起）；
 * 删除行没有新行号，记的是「删除发生在新文件第几行之前」，出题时把它当作被碰过的位置。
 */
export type DiffOp = { kind: 'same' | 'add' | 'del'; text: string; newLine: number }

/** LCS 表的格数上限。培训文件都是几百行，超过它说明文件被整个换掉了，按整段替换处理。 */
const DIFF_CELLS_MAX = 4_000_000

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop() // 末尾换行不算一行
  return lines
}

/** 逐行差异。先剥掉相同的头尾，只对中间那段做 LCS —— 改动通常是局部的。 */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = splitLines(before)
  const b = splitLines(after)

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const ops: DiffOp[] = []
  let newCount = 0
  const same = (text: string): void => {
    newCount++
    ops.push({ kind: 'same', text, newLine: newCount })
  }
  const add = (text: string): void => {
    newCount++
    ops.push({ kind: 'add', text, newLine: newCount })
  }
  const del = (text: string): void => {
    ops.push({ kind: 'del', text, newLine: newCount + 1 })
  }

  for (let i = 0; i < start; i++) same(a[i] ?? '')

  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const n = midA.length
  const m = midB.length
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= DIFF_CELLS_MAX) {
    const w = m + 1
    const lcs = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          midA[i] === midB[j]
            ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
            : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        same(midA[i] ?? '')
        i++
        j++
      } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
        del(midA[i] ?? '')
        i++
      } else {
        add(midB[j] ?? '')
        j++
      }
    }
    while (i < n) del(midA[i++] ?? '')
    while (j < m) add(midB[j++] ?? '')
  } else {
    for (const line of midA) del(line)
    for (const line of midB) add(line)
  }

  for (let i = endA; i < a.length; i++) same(a[i] ?? '')
  return ops
}

/**
 * 去掉注释与所有空白后的代码。两版指纹相同，说明这次只改了注释、缩进或空行 —— 不值得出题。
 * 字符串里的 `//` 会被误当成注释，但两版按同一规则处理，只影响「相同与否」，不影响显示。
 */
export function codeFingerprint(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '')
}

export type FileChange = {
  file: string
  status: 'added' | 'modified' | 'deleted'
  /** 新文件里被这次改动碰过的行号（1 起）：新增的行，加上删除发生的位置。出题只能钉在这些行附近。 */
  touched: number[]
  added: number
  removed: number
  /** 只动了注释或空白 —— 不出题。 */
  trivial: boolean
  ops: DiffOp[]
}

export function diffSnapshots(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): FileChange[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const out: FileChange[] = []
  for (const file of names) {
    const a = before[file]
    const b = after[file]
    if (a === b) continue
    const ops = diffLines(a ?? '', b ?? '')
    const newLength = splitLines(b ?? '').length
    const touched = new Set<number>()
    let added = 0
    let removed = 0
    for (const op of ops) {
      if (op.kind === 'add') {
        added++
        touched.add(op.newLine)
      } else if (op.kind === 'del') {
        removed++
        if (newLength > 0) touched.add(Math.min(Math.max(op.newLine, 1), newLength))
      }
    }
    if (added === 0 && removed === 0) continue // 只差换行符（CRLF ↔ LF）
    out.push({
      file,
      status: a === undefined ? 'added' : b === undefined ? 'deleted' : 'modified',
      touched: [...touched].sort((x, y) => x - y),
      added,
      removed,
      trivial: codeFingerprint(a ?? '') === codeFingerprint(b ?? ''),
      ops,
    })
  }
  return out
}

/** 能出题的改动：真动了代码，而且文件还在（删掉的文件没有行可以钉）。 */
export function quizzableChanges(changes: readonly FileChange[]): FileChange[] {
  return changes.filter((c) => !c.trivial && c.status !== 'deleted')
}

/** 进记录、进验收单用的改动摘要。 */
export type ChangeStat = {
  file: string
  status: FileChange['status']
  added: number
  removed: number
}

export function changeStat(c: FileChange): ChangeStat {
  return { file: c.file, status: c.status, added: c.added, removed: c.removed }
}

/** [3, 4, 5, 9] → "3–5、9" */
export function lineRanges(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] ?? 0) + 1) j++
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`)
    i = j + 1
  }
  return parts.join('、')
}

const STATUS_LABEL: Record<FileChange['status'], string> = {
  added: '新文件',
  modified: '修改',
  deleted: '删除',
}

/** 改动前后各带几行上下文。 */
const DIFF_CONTEXT = 2

/** 把改动渲染成给人看的差异，带新文件行号。超过 maxLines 截断，并如实说省略了多少行。 */
export function renderChanges(changes: readonly FileChange[], maxLines = 160): string {
  const out: string[] = []
  for (const c of changes) {
    out.push(
      `--- ${c.file}（${STATUS_LABEL[c.status]}，+${c.added} / −${c.removed}` +
        `${c.trivial ? '，只动了注释或空白' : ''}）`,
    )
    const keep = new Set<number>()
    c.ops.forEach((op, i) => {
      if (op.kind === 'same') return
      const from = Math.max(0, i - DIFF_CONTEXT)
      const to = Math.min(c.ops.length - 1, i + DIFF_CONTEXT)
      for (let k = from; k <= to; k++) keep.add(k)
    })
    let last = -1
    for (const i of [...keep].sort((x, y) => x - y)) {
      if (last >= 0 && i > last + 1) out.push('  ⋯')
      const op = c.ops[i]
      if (op === undefined) continue
      const mark = op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' '
      const number = op.kind === 'del' ? '' : String(op.newLine)
      out.push(`${mark} ${number.padStart(4)} │ ${op.text}`)
      last = i
    }
  }
  if (out.length <= maxLines) return out.join('\n')
  return [...out.slice(0, maxLines), `…（其余 ${out.length - maxLines} 行省略）`].join('\n')
}

/** 取锚点前后几行，带行号，锚点那行用 ▶ 标出。 */
export function excerpt(source: string, line: number, radius = 3): string {
  const lines = splitLines(source)
  const from = Math.max(1, line - radius)
  const to = Math.min(lines.length, line + radius)
  const out: string[] = []
  for (let n = from; n <= to; n++) {
    out.push(`${n === line ? '▶' : ' '} ${String(n).padStart(4)} │ ${lines[n - 1] ?? ''}`)
  }
  return out.join('\n')
}

/* ---------- 出题 ---------- */

/**
 * 三种题型，全是开放题：
 *
 *   why      这一行为什么这样写
 *   what-if  换成另一种写法会怎样（模型给出 variant）
 *   edge     遇到某种情形会怎样（模型给出 situation）
 *
 * 刻意没有选择题和填空题 —— 那两种都需要标准答案，而标准答案正是 §5 红线不许模型写的东西。
 */
export type QuestionKind = 'why' | 'what-if' | 'edge'

const KINDS: readonly QuestionKind[] = ['why', 'what-if', 'edge']

/** 模型交来的一道题：只有位置和填空，没有题干。 */
export type QuestionRequest = {
  kind: QuestionKind
  file: string
  line: number
  variant?: string
  situation?: string
}

export type QuizQuestion = {
  id: string
  kind: QuestionKind
  file: string
  line: number
  /** 锚点那一行的代码（去掉首尾空白）。 */
  code: string
  /** 题干，由模板生成。 */
  text: string
  /** 锚点前后几行，问答框里给学员看。 */
  context: string
}

/** 锚点离改动最远几行还算「这次的改动」。模型数行号常差一两行，卡太死只会逼它瞎凑。 */
const ANCHOR_SLACK = 2

type Checked<T> = { ok: true } & T
type Problems = { ok: false; problems: string[] }

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 校验模型交来的题目参数。模型有时把数组序列化成字符串交过来，也收。 */
export function parseQuestionRequests(
  raw: unknown,
): Checked<{ requests: QuestionRequest[] }> | Problems {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return { ok: false, problems: ['questions 不是合法的 JSON 数组'] }
    }
  }
  if (!Array.isArray(value)) return { ok: false, problems: ['questions 必须是数组'] }
  if (value.length === 0) return { ok: false, problems: ['至少出 1 道题'] }
  if (value.length > MAX_QUESTIONS) {
    return { ok: false, problems: [`一轮最多 ${MAX_QUESTIONS} 道题，收到 ${value.length} 道`] }
  }

  const problems: string[] = []
  const requests: QuestionRequest[] = []
  value.forEach((item, i) => {
    const at = `第 ${i + 1} 题`
    if (typeof item !== 'object' || item === null) {
      problems.push(`${at} 不是对象`)
      return
    }
    const q = item as Record<string, unknown>
    const kind = q['kind']
    if (!KINDS.includes(kind as QuestionKind)) {
      problems.push(`${at} 的 kind 只能是 ${KINDS.join(' / ')}，收到 ${JSON.stringify(kind)}`)
      return
    }
    const file = typeof q['file'] === 'string' ? q['file'].trim() : ''
    const line = q['line']
    const variant = typeof q['variant'] === 'string' ? q['variant'].trim() : ''
    const situation = typeof q['situation'] === 'string' ? q['situation'].trim() : ''
    const before = problems.length
    if (file === '') problems.push(`${at} 缺少 file`)
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
      problems.push(`${at} 的 line 必须是正整数`)
    }
    if (kind === 'what-if' && variant === '') {
      problems.push(`${at} 是 what-if，要给出一个具体的替代写法 variant`)
    }
    if (kind === 'edge' && situation === '') {
      problems.push(`${at} 是 edge，要给出一个具体的情形 situation`)
    }
    if (variant.length > 160) problems.push(`${at} 的 variant 太长，写成一行代码或一句话`)
    if (situation.length > 80) problems.push(`${at} 的 situation 太长，写成一句话`)
    if (problems.length > before) return
    requests.push({
      kind: kind as QuestionKind,
      file,
      line: line as number,
      ...(variant !== '' ? { variant } : {}),
      ...(situation !== '' ? { situation } : {}),
    })
  })
  return problems.length > 0 ? { ok: false, problems } : { ok: true, requests }
}

function lastSegment(p: string): string {
  return p.split('/').pop() ?? p
}

/** 按路径找改动。模型可能给绝对路径、`./` 前缀或只给文件名，都认；只给文件名时必须唯一。 */
function matchChange(changes: readonly FileChange[], file: string): FileChange | undefined {
  const norm = file.split('\\').join('/').replace(/^\.\//, '')
  const exact = changes.find((c) => c.file === norm || norm.endsWith(`/${c.file}`))
  if (exact !== undefined) return exact
  const byName = changes.filter((c) => lastSegment(c.file) === lastSegment(norm))
  return byName.length === 1 ? byName[0] : undefined
}

/** 题干模板。题干只由这里生成，模型交来的只有位置和填空。 */
export function questionText(
  r: Pick<QuestionRequest, 'kind' | 'variant' | 'situation'> & { file: string; line: number },
): string {
  const where = `${r.file} 第 ${r.line} 行`
  switch (r.kind) {
    case 'why':
      return `${where}为什么这样写？它在这次改动里起什么作用？`
    case 'what-if':
      return `${where}如果改成「${r.variant ?? ''}」，运行起来会有什么不同？`
    case 'edge':
      return `${where}这段代码遇到「${r.situation ?? ''}」时会怎样？为什么？`
  }
}

/**
 * 把模型交来的位置变成题目。每道题都必须钉在这次改动过的行上 ——
 * 这是「就这次改动出题」唯一可以机器检查的部分，所以查得严。
 */
export function buildQuestions(
  requests: readonly QuestionRequest[],
  changes: readonly FileChange[],
  files: Readonly<Record<string, string>>,
): Checked<{ questions: QuizQuestion[] }> | Problems {
  const eligible = quizzableChanges(changes)
  const problems: string[] = []
  const questions: QuizQuestion[] = []
  const seen = new Set<string>()
  requests.forEach((r, i) => {
    const at = `第 ${i + 1} 题`
    const change = matchChange(eligible, r.file)
    if (change === undefined) {
      problems.push(`${at}：${r.file} 不在这次的改动里（或者只改了注释和空白）`)
      return
    }
    if (!change.touched.some((t) => Math.abs(t - r.line) <= ANCHOR_SLACK)) {
      problems.push(
        `${at}：${change.file} 第 ${r.line} 行没被这次改动碰过` +
          `（改动在第 ${lineRanges(change.touched)} 行）`,
      )
      return
    }
    const source = files[change.file] ?? ''
    const code = (splitLines(source)[r.line - 1] ?? '').trim()
    if (code === '') {
      problems.push(`${at}：${change.file} 第 ${r.line} 行是空行，换一行有代码的`)
      return
    }
    const key = `${change.file}:${r.line}:${r.kind}`
    if (seen.has(key)) {
      problems.push(`${at} 与前面的题重复`)
      return
    }
    seen.add(key)
    questions.push({
      id: `q${questions.length + 1}`,
      kind: r.kind,
      file: change.file,
      line: r.line,
      code: clip(code, 100),
      text: questionText({ ...r, file: change.file }),
      context: excerpt(source, r.line),
    })
  })
  return problems.length > 0 ? { ok: false, problems } : { ok: true, questions }
}

/* ---------- 回答与记录 ---------- */

export type QuizAnswer = { id: string; text: string }

/**
 * dsh 问答框的回答 → 按题目顺序的原文。
 * 没答的题记空串，不替学员补任何东西；也不做任何清洗 —— 原文就是记录的全部价值。
 */
export function answersFrom(questions: readonly QuizQuestion[], reply: unknown): QuizAnswer[] {
  const raw = (reply as { answers?: unknown } | null)?.answers
  const items = Array.isArray(raw) ? raw : []
  return questions.map((q) => {
    const hit = items.find((a) => (a as { id?: unknown } | null)?.id === q.id) as
      | { selected?: unknown; custom?: unknown }
      | undefined
    const custom = typeof hit?.custom === 'string' ? hit.custom : ''
    const selected = Array.isArray(hit?.selected)
      ? hit.selected.filter((s): s is string => typeof s === 'string')
      : []
    return { id: q.id, text: custom !== '' ? custom : selected.join('、') }
  })
}

/** 一轮小测的完整记录。 */
export type QuizRecord = {
  version: 1
  taskId: string
  student: string
  at: string
  /** 这一轮之前经 dsh 文件工具观测到的 Agent 改动。只看得到 write / edit / str_replace_editor。 */
  agentEdits: AgentEdit[]
  changes: ChangeStat[]
  /** 给人看的差异（renderChanges 的输出）。 */
  diff: string
  questions: QuizQuestion[]
  answers: QuizAnswer[]
}

/** 记录文件名：时间戳，冒号和点换成横线（Windows 文件名不能有冒号）。 */
export function recordFileName(at: Date): string {
  return `${at.toISOString().replace(/[:.]/g, '-')}.json`
}

function isChangeStat(value: unknown): value is ChangeStat {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Partial<ChangeStat>
  return (
    typeof c.file === 'string' &&
    (c.status === 'added' || c.status === 'modified' || c.status === 'deleted') &&
    typeof c.added === 'number' &&
    typeof c.removed === 'number'
  )
}

function isQuestion(value: unknown): value is QuizQuestion {
  if (typeof value !== 'object' || value === null) return false
  const q = value as Partial<QuizQuestion>
  return (
    typeof q.id === 'string' &&
    KINDS.includes(q.kind as QuestionKind) &&
    typeof q.file === 'string' &&
    typeof q.line === 'number' &&
    typeof q.code === 'string' &&
    typeof q.text === 'string' &&
    typeof q.context === 'string'
  )
}

function isAnswer(value: unknown): value is QuizAnswer {
  if (typeof value !== 'object' || value === null) return false
  const a = value as Partial<QuizAnswer>
  return typeof a.id === 'string' && typeof a.text === 'string'
}

/** 记录可能被手改过、或者是别的版本写的。缺了核心字段就整条不认，而不是拼出一条半真的记录。 */
export function parseRecord(raw: unknown): QuizRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Partial<QuizRecord>
  if (
    r.version !== 1 ||
    typeof r.taskId !== 'string' ||
    typeof r.at !== 'string' ||
    !Array.isArray(r.questions) ||
    !Array.isArray(r.answers)
  ) {
    return undefined
  }
  return {
    version: 1,
    taskId: r.taskId,
    student: typeof r.student === 'string' ? r.student : '',
    at: r.at,
    agentEdits: Array.isArray(r.agentEdits) ? r.agentEdits.filter(isAgentEdit) : [],
    changes: Array.isArray(r.changes) ? r.changes.filter(isChangeStat) : [],
    diff: typeof r.diff === 'string' ? r.diff : '',
    questions: r.questions.filter(isQuestion),
    answers: r.answers.filter(isAnswer),
  }
}

function blankAnswers(r: QuizRecord): number {
  return r.questions.filter((q) => (r.answers.find((a) => a.id === q.id)?.text ?? '').trim() === '')
    .length
}

/* ---------- 验收单用的汇总 ---------- */

export type QuizSummary = {
  /** 本次启动是不是培训模式 —— 不是就不会出新题，验收单要说清楚。 */
  enabled: boolean
  rounds: number
  questions: number
  /** 空着没答的题数。 */
  blank: number
  /** 观测到的 Agent 改动次数：已答题轮次里的，加上还在台账上的。 */
  agentEdits: number
  agentFiles: string[]
  /** 还没答题的改动。 */
  pending: ChangeStat[]
}

export function summarizeQuiz(
  records: readonly QuizRecord[],
  ledgerEdits: readonly AgentEdit[],
  pending: readonly FileChange[],
  enabled: boolean,
): QuizSummary {
  const edits = [...records.flatMap((r) => r.agentEdits), ...ledgerEdits]
  return {
    enabled,
    rounds: records.length,
    questions: records.reduce((n, r) => n + r.questions.length, 0),
    blank: records.reduce((n, r) => n + blankAnswers(r), 0),
    agentEdits: edits.length,
    agentFiles: [...new Set(edits.map((e) => e.file))].sort(),
    pending: quizzableChanges(pending).map(changeStat),
  }
}

/* ---------- 导出与汇总 ---------- */

export const BUNDLE_FORMAT = 'dsh4rcs-training-records'

/** 导出时还没答题的改动 —— 老队员据此知道哪些改动完全没被问过。 */
export type PendingTask = { taskId: string; changes: ChangeStat[]; agentEdits: AgentEdit[] }

export type TaskSummary = { taskId: string; scaffoldedAt: string | null; reviews: number }

/** 学员交上来的那个文件。 */
export type RecordBundle = {
  format: typeof BUNDLE_FORMAT
  version: 1
  student: string
  exportedAt: string
  tasks: TaskSummary[]
  records: QuizRecord[]
  pending: PendingTask[]
}

function isTaskSummary(value: unknown): value is TaskSummary {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Partial<TaskSummary>
  return (
    typeof t.taskId === 'string' &&
    (t.scaffoldedAt === null || typeof t.scaffoldedAt === 'string') &&
    typeof t.reviews === 'number'
  )
}

function isPendingTask(value: unknown): value is PendingTask {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Partial<PendingTask>
  return typeof p.taskId === 'string' && Array.isArray(p.changes) && Array.isArray(p.agentEdits)
}

/**
 * 校验交上来的文件。顶层不对就整份拒收；单条记录坏了只丢那一条，并报出丢了几条 ——
 * 静默丢数据最危险，但一条坏记录也不该让整个人的记录都看不了。
 */
export function parseBundle(
  raw: unknown,
): Checked<{ bundle: RecordBundle; dropped: number }> | Problems {
  if (typeof raw !== 'object' || raw === null) return { ok: false, problems: ['不是 JSON 对象'] }
  const b = raw as Partial<RecordBundle>
  const problems: string[] = []
  if (b.format !== BUNDLE_FORMAT) problems.push(`不是培训记录文件（format 应为 ${BUNDLE_FORMAT}）`)
  if (b.version !== 1) problems.push(`不认识的版本：${String(b.version)}`)
  if (typeof b.student !== 'string' || b.student.trim() === '') problems.push('缺少 student（学员名字）')
  if (typeof b.exportedAt !== 'string') problems.push('缺少 exportedAt（导出时间）')
  if (!Array.isArray(b.records)) problems.push('缺少 records 数组')
  if (problems.length > 0) return { ok: false, problems }

  const records: QuizRecord[] = []
  let dropped = 0
  for (const r of b.records as unknown[]) {
    const parsed = parseRecord(r)
    if (parsed === undefined) dropped++
    else records.push(parsed)
  }
  const pending = (Array.isArray(b.pending) ? b.pending : []).filter(isPendingTask).map((p) => ({
    taskId: p.taskId,
    changes: p.changes.filter(isChangeStat),
    agentEdits: p.agentEdits.filter(isAgentEdit),
  }))
  return {
    ok: true,
    dropped,
    bundle: {
      format: BUNDLE_FORMAT,
      version: 1,
      student: (b.student as string).trim(),
      exportedAt: b.exportedAt as string,
      tasks: (Array.isArray(b.tasks) ? b.tasks : []).filter(isTaskSummary),
      records: records.sort((x, y) => x.at.localeCompare(y.at)),
      pending,
    },
  }
}

export type BundleStats = {
  rounds: number
  questions: number
  blank: number
  agentEdits: number
  /** 导出时还没答题的改动文件数。 */
  pendingFiles: number
}

export function bundleStats(b: RecordBundle): BundleStats {
  let agentEdits = 0
  let pendingFiles = 0
  for (const r of b.records) agentEdits += r.agentEdits.length
  for (const p of b.pending) {
    agentEdits += p.agentEdits.length
    pendingFiles += p.changes.length
  }
  return {
    rounds: b.records.length,
    questions: b.records.reduce((n, r) => n + r.questions.length, 0),
    blank: b.records.reduce((n, r) => n + blankAnswers(r), 0),
    agentEdits,
    pendingFiles,
  }
}

/** 文件名里不能出现的字符换成下划线；名字为空时写「未署名」。 */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^[._]+/, '')
  return cleaned === '' ? '未署名' : cleaned
}

export function exportFileName(student: string, now: Date): string {
  return `rcs-training-records-${safeFileName(student)}-${now.toISOString().slice(0, 10).replace(/-/g, '')}.json`
}

/** 代码块用四个反引号：学员的代码里可能就有三个。 */
const FENCE = '````'

function quoteAnswer(text: string): string {
  const body = text.trim() === '' ? '（空着没答）' : text.trimEnd()
  return body
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n')
}

function describeEdits(edits: readonly AgentEdit[]): string {
  const count = new Map<string, number>()
  for (const e of edits) count.set(e.file, (count.get(e.file) ?? 0) + 1)
  return [...count].map(([file, n]) => `${file} ×${n}`).join('、')
}

const REPORT_DISCLAIMER = [
  '> 这份记录用来挑追问的方向，**不是成绩**。回答可能是 Agent 代写的；',
  '> Agent 用 bash 写的代码、从网页复制来的代码，这里都看不到。是否掌握，以当面提问为准。',
]

/** 一个学员的报告（Markdown）。只摆事实：题目、回答原文、改动、还没答题的改动。 */
export function renderTraineeReport(b: RecordBundle): string {
  const s = bundleStats(b)
  const L: string[] = []
  L.push(`# ${b.student} 的培训记录`, '')
  L.push(
    `导出时间：${b.exportedAt} · 改动小测 ${s.rounds} 轮 / ${s.questions} 题` +
      `${s.blank > 0 ? `（${s.blank} 题空着）` : ''} · 观测到 Agent 改代码 ${s.agentEdits} 次`,
    '',
  )
  L.push(...REPORT_DISCLAIMER)

  const taskIds = [
    ...new Set([
      ...b.tasks.map((t) => t.taskId),
      ...b.records.map((r) => r.taskId),
      ...b.pending.map((p) => p.taskId),
    ]),
  ]
  for (const taskId of taskIds) {
    L.push('', `## ${taskId}`, '')
    const t = b.tasks.find((x) => x.taskId === taskId)
    if (t !== undefined) {
      L.push(`领基线：${t.scaffoldedAt ?? '（没领）'} · 验收单生成过 ${t.reviews} 次`, '')
    }
    const records = b.records.filter((r) => r.taskId === taskId)
    if (records.length === 0) L.push('（这个任务没有答题记录）', '')
    for (const r of records) {
      L.push(`### ${r.at} · ${r.questions.length} 题`, '')
      L.push(
        r.agentEdits.length > 0
          ? `Agent 改动：${describeEdits(r.agentEdits)}`
          : 'Agent 改动：这一轮没观测到（可能是学员自己改的，也可能是 Agent 用 bash 写的）',
      )
      if (r.changes.length > 0) {
        L.push(`改动：${r.changes.map((c) => `${c.file}（+${c.added} / −${c.removed}）`).join('、')}`)
      }
      L.push('', '<details><summary>这一轮的改动</summary>', '', `${FENCE}text`, r.diff, FENCE, '')
      L.push('</details>', '')
      r.questions.forEach((q, i) => {
        const answer = r.answers.find((a) => a.id === q.id)
        L.push(`**${i + 1}. ${q.text}**`, '', `${FENCE}c`, q.context, FENCE, '')
        L.push(quoteAnswer(answer?.text ?? ''), '')
      })
    }
    const p = b.pending.find((x) => x.taskId === taskId)
    if (p !== undefined && (p.changes.length > 0 || p.agentEdits.length > 0)) {
      L.push('**导出时还没答题的改动：**', '')
      for (const c of p.changes) L.push(`- ${c.file}（+${c.added} / −${c.removed}）`)
      if (p.agentEdits.length > 0) L.push(`- 其中观测到的 Agent 改动：${describeEdits(p.agentEdits)}`)
      L.push('')
    }
  }
  return `${L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** 汇总表的一行。 */
export type CollectRow = BundleStats & { student: string; exportedAt: string; report: string }

function cell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

/** 汇总表（Markdown）。数字只说明问过什么、答没答，不代表掌握程度。 */
export function renderCollectIndex(rows: readonly CollectRow[]): string {
  const L = [
    '# 培训记录汇总',
    '',
    `共 ${rows.length} 份。数字只说明「问过什么、答没答」，**不代表掌握程度** —— 以当面提问为准。`,
    '',
    '| 学员 | 导出时间 | 答题轮数 | 题数 | 空着 | Agent 改代码 | 未答题的改动 | 报告 |',
    '|---|---|---|---|---|---|---|---|',
  ]
  for (const r of rows) {
    L.push(
      `| ${cell(r.student)} | ${r.exportedAt.slice(0, 16).replace('T', ' ')} | ${r.rounds} | ` +
        `${r.questions} | ${r.blank} | ${r.agentEdits} | ${r.pendingFiles} | ` +
        `[${cell(r.report)}](./${encodeURI(r.report)}) |`,
    )
  }
  return `${L.join('\n')}\n`
}
