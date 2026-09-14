/**
 * 改动小测的纯逻辑测试。
 *
 * 重点验三件事：
 *   1. 「这次改动」算得对 —— 行号、只改注释不出题、换行符不算改动；
 *   2. 题目钉不到改动上就拒绝 —— 这是「就这次改动出题」唯一能机器检查的部分；
 *   3. 回答原样进记录、原样进报告，报告不打分。
 */
import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUNDLE_FORMAT,
  FOLLOW_UP_ID,
  MAX_FOLLOW_UPS,
  MAX_HINT_CHARS,
  MAX_QUESTIONS,
  QUIZ_INTRO,
  QUIZ_NOTICE,
  SKIP_TO_ASK,
  answersFrom,
  buildQuestions,
  bundleStats,
  checkHint,
  diffLines,
  diffSnapshots,
  emptyLedger,
  exportFileName,
  followUpFrom,
  followUpsLeft,
  isTrackedSource,
  lineRanges,
  mergeAnswers,
  openQuestions,
  parseBundle,
  parseLedger,
  parseQuestionRequests,
  parseRecord,
  pendingTaskIds,
  questionText,
  quizItems,
  quizzableChanges,
  recordFileName,
  renderChanges,
  renderCollectIndex,
  renderTraineeReport,
  safeFileName,
  summarizeQuiz,
  takeEdits,
  taskOfPath,
  withEdit,
} from '../src/training-quiz.ts'
import type { QuizQuestion, QuizRecord, RecordBundle } from '../src/training-quiz.ts'

const BEFORE = ['int add(int a, int b)', '{', '    return 0;', '}', ''].join('\n')
const AFTER = ['int add(int a, int b)', '{', '    int s = a + b;', '    return s;', '}', ''].join(
  '\n',
)

describe('diffLines —— 逐行差异', () => {
  it('新增行带新文件行号，删除行保留原文', () => {
    const ops = diffLines(BEFORE, AFTER)
    expect(ops.filter((o) => o.kind === 'add').map((o) => o.newLine)).toEqual([3, 4])
    expect(ops.filter((o) => o.kind === 'del').map((o) => o.text)).toEqual(['    return 0;'])
  })

  it('完全相同时没有增删', () => {
    expect(diffLines(AFTER, AFTER).every((o) => o.kind === 'same')).toBe(true)
  })

  it('从空文件开始，全部是新增', () => {
    expect(diffLines('', 'a\nb\n').map((o) => o.kind)).toEqual(['add', 'add'])
  })
})

describe('diffSnapshots —— 这次改了什么', () => {
  it('touched 是新增的行加上删除的位置', () => {
    const [c] = diffSnapshots({ 'a.c': BEFORE }, { 'a.c': AFTER })
    expect(c).toMatchObject({ file: 'a.c', status: 'modified', added: 2, removed: 1, trivial: false })
    expect(c?.touched).toEqual([3, 4])
  })

  it('只改注释和缩进算 trivial —— 不值得出题', () => {
    const commented = AFTER.replace('    int s = a + b;', '        int s = a + b;   // 先求和')
    const changes = diffSnapshots({ 'a.c': AFTER }, { 'a.c': commented })
    expect(changes[0]?.trivial).toBe(true)
    expect(quizzableChanges(changes)).toEqual([])
  })

  it('只差换行符（CRLF ↔ LF）不算改动', () => {
    expect(diffSnapshots({ 'a.c': AFTER }, { 'a.c': AFTER.replace(/\n/g, '\r\n') })).toEqual([])
  })

  it('新文件能出题，删掉的文件没有行可钉', () => {
    const changes = diffSnapshots({ 'old.c': 'int x;\n' }, { 'new.c': 'int y;\n' })
    expect(changes.map((c) => [c.file, c.status])).toEqual([
      ['new.c', 'added'],
      ['old.c', 'deleted'],
    ])
    expect(quizzableChanges(changes).map((c) => c.file)).toEqual(['new.c'])
  })
})

describe('lineRanges', () => {
  it('连续的行号合并成区间', () => {
    expect(lineRanges([9, 3, 4, 5])).toBe('3–5、9')
    expect(lineRanges([])).toBe('')
  })
})

describe('taskOfPath —— 文件属于哪个任务', () => {
  const root = join(tmpdir(), 'rcs-training')

  it('任务目录下的文件，路径统一成正斜杠', () => {
    expect(taskOfPath(root, join(root, 'ring-buffer', 'ring_buffer.c'))).toEqual({
      taskId: 'ring-buffer',
      rel: 'ring_buffer.c',
    })
    expect(taskOfPath(root, join(root, 'ring-buffer', 'src', 'a.c'))?.rel).toBe('src/a.c')
  })

  it('工作目录外、根目录下的散文件、.records 里的都不算', () => {
    expect(taskOfPath(root, join(tmpdir(), 'elsewhere', 'a.c'))).toBeUndefined()
    expect(taskOfPath(root, join(root, 'progress.json'))).toBeUndefined()
    expect(taskOfPath(root, join(root, '.records', 'x', 'a.c'))).toBeUndefined()
  })

  it('相对路径不猜', () => {
    expect(taskOfPath(root, 'ring-buffer/a.c')).toBeUndefined()
  })
})

describe('isTrackedSource', () => {
  it('只认 C/C++ 源文件 —— 培训要问的是代码', () => {
    expect(isTrackedSource('a.c')).toBe(true)
    expect(isTrackedSource('inc/b.HPP')).toBe(true)
    expect(isTrackedSource('CMakeLists.txt')).toBe(false)
    expect(isTrackedSource('notes.md')).toBe(false)
  })
})

describe('台账', () => {
  const edit = (taskId: string, at: string) => ({ taskId, file: 'a.c', tool: 'edit', at })

  it('坏文件当空台账，坏条目丢掉', () => {
    expect(parseLedger(undefined)).toEqual(emptyLedger())
    expect(parseLedger({ version: 2, edits: [] })).toEqual(emptyLedger())
    const l = parseLedger({ version: 1, edits: [{ taskId: 1 }, edit('t', '2026-01-01T00:00:00.000Z')] })
    expect(l.edits).toHaveLength(1)
  })

  it('takeEdits 只取给定时刻之前的 —— 问答框开着时的改动留给下一轮', () => {
    let l = withEdit(emptyLedger(), edit('t', '2026-01-01T00:00:00.000Z'))
    l = withEdit(l, edit('t', '2026-01-01T00:10:00.000Z'))
    l = withEdit(l, edit('u', '2026-01-01T00:00:00.000Z'))
    const { taken, rest } = takeEdits(l, 't', '2026-01-01T00:05:00.000Z')
    expect(taken).toHaveLength(1)
    expect(rest.edits.map((e) => e.taskId)).toEqual(['t', 'u'])
    expect(pendingTaskIds(rest)).toEqual(['t', 'u'])
  })
})

describe('parseQuestionRequests —— 模型交来的题目参数', () => {
  const why = { kind: 'why', file: 'a.c', line: 3 }

  it('收数组，也收被序列化成字符串的数组', () => {
    expect(parseQuestionRequests([why]).ok).toBe(true)
    expect(parseQuestionRequests(JSON.stringify([why])).ok).toBe(true)
  })

  it(`至少 1 道，一轮最多 ${MAX_QUESTIONS} 道`, () => {
    expect(parseQuestionRequests([]).ok).toBe(false)
    expect(parseQuestionRequests(Array.from({ length: MAX_QUESTIONS + 1 }, () => why)).ok).toBe(false)
  })

  it('what-if 必须给 variant，edge 必须给 situation', () => {
    const r = parseQuestionRequests([
      { kind: 'what-if', file: 'a.c', line: 3 },
      { kind: 'edge', file: 'a.c', line: 4 },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems.join('\n')).toMatch(/variant[\s\S]*situation/)
  })

  it('没有选择题、填空题这类题型 —— 它们都要标准答案', () => {
    expect(parseQuestionRequests([{ kind: 'choice', file: 'a.c', line: 3 }]).ok).toBe(false)
  })
})

describe('buildQuestions —— 题目必须钉在这次改动上', () => {
  const changes = diffSnapshots({ 'src/a.c': BEFORE }, { 'src/a.c': AFTER })
  const files = { 'src/a.c': AFTER }
  const build = (raw: unknown) => {
    const parsed = parseQuestionRequests(raw)
    if (!parsed.ok) throw new Error(parsed.problems.join('\n'))
    return buildQuestions(parsed.requests, changes, files)
  }

  it('题干由模板生成，带文件、行号、锚点代码和上下文', () => {
    const r = build([{ kind: 'why', file: 'src/a.c', line: 3 }])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [q] = r.questions
    expect(q?.text).toBe(questionText({ kind: 'why', file: 'src/a.c', line: 3 }))
    expect(q?.code).toBe('int s = a + b;')
    expect(q?.context).toContain('▶    3 │     int s = a + b;')
  })

  it('what-if 与 edge 的填空进题干，但题干里没有答案', () => {
    const r = build([
      { kind: 'what-if', file: 'src/a.c', line: 4, variant: 'return a + b;' },
      { kind: 'edge', file: 'src/a.c', line: 3, situation: 'a + b 溢出' },
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.questions[0]?.text).toContain('「return a + b;」')
    expect(r.questions[1]?.text).toContain('「a + b 溢出」')
  })

  it('只给文件名（唯一时）或给绝对路径都认', () => {
    expect(build([{ kind: 'why', file: 'a.c', line: 4 }]).ok).toBe(true)
    expect(build([{ kind: 'why', file: 'D:/code/rcs-training/demo/src/a.c', line: 4 }]).ok).toBe(true)
  })

  it('离改动两行以内还算，再远就拒绝，并说出改动在哪几行', () => {
    expect(build([{ kind: 'why', file: 'a.c', line: 1 }]).ok).toBe(true)
    const far = build([{ kind: 'why', file: 'a.c', line: 7 }])
    expect(far.ok).toBe(false)
    if (!far.ok) expect(far.problems[0]).toContain('改动在第 3–4 行')
  })

  it('不在改动里的文件、重复的题、空行都拒绝', () => {
    expect(build([{ kind: 'why', file: 'b.c', line: 3 }]).ok).toBe(false)
    expect(
      build([
        { kind: 'why', file: 'a.c', line: 3 },
        { kind: 'why', file: 'src/a.c', line: 3 },
      ]).ok,
    ).toBe(false)

    const withBlank = ['int add(int a, int b)', '{', '    int s = a + b;', '', '    return s;', '}', ''].join('\n')
    const blank = buildQuestions(
      [{ kind: 'why', file: 'a.c', line: 4 }],
      diffSnapshots({ 'a.c': BEFORE }, { 'a.c': withBlank }),
      { 'a.c': withBlank },
    )
    expect(blank.ok).toBe(false)
    if (!blank.ok) expect(blank.problems[0]).toContain('空行')
  })

  it('只改了注释的文件不能出题', () => {
    const commented = AFTER.replace('    return s;', '    return s; // 返回和')
    const r = buildQuestions(
      [{ kind: 'why', file: 'a.c', line: 4 }],
      diffSnapshots({ 'a.c': AFTER }, { 'a.c': commented }),
      { 'a.c': commented },
    )
    expect(r.ok).toBe(false)
  })
})

describe('answersFrom —— 回答原样进记录', () => {
  const questions = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }] as QuizQuestion[]

  it('取自由文本，原文不清洗；没答的记空串，不替学员补任何东西', () => {
    const a = answersFrom(questions, {
      answers: [
        { id: 'q1', selected: [], custom: '  先求和\n再返回  ' },
        { id: 'q3', selected: ['其他'] },
      ],
    })
    expect(a).toEqual([
      { id: 'q1', text: '  先求和\n再返回  ' },
      { id: 'q2', text: '' },
      { id: 'q3', text: '其他' },
    ])
  })

  it('回复形状不对时每题都记空串，不抛', () => {
    expect(answersFrom(questions, null).every((a) => a.text === '')).toBe(true)
  })
})

describe('renderChanges', () => {
  const changes = diffSnapshots({ 'a.c': BEFORE }, { 'a.c': AFTER })

  it('带新文件行号，删除行不编行号', () => {
    const text = renderChanges(changes)
    expect(text).toContain('--- a.c（修改，+2 / −1）')
    expect(text).toContain('+    3 │     int s = a + b;')
    expect(text).toContain('-      │     return 0;')
  })

  it('超长截断时如实说省略了多少行', () => {
    expect(renderChanges(changes, 2)).toMatch(/其余 \d+ 行省略/)
  })
})

describe('给学员的说明', () => {
  it('明说回答会给老队员看、不评分 —— 不瞒学员', () => {
    expect(QUIZ_NOTICE).toContain('老队员')
    expect(QUIZ_NOTICE).toContain('不评分')
    expect(QUIZ_INTRO).toContain(QUIZ_NOTICE)
  })
})

const record: QuizRecord = {
  version: 1,
  taskId: 'ring-buffer',
  student: '小测',
  at: '2026-09-15T12:00:00.000Z',
  agentEdits: [{ taskId: 'ring-buffer', file: 'a.c', tool: 'edit', at: '2026-09-15T11:59:00.000Z' }],
  changes: [{ file: 'a.c', status: 'modified', added: 2, removed: 1 }],
  diff: '--- a.c（修改，+2 / −1）',
  questions: [
    { id: 'q1', kind: 'why', file: 'a.c', line: 3, code: 'int s = a + b;', text: 'a.c 第 3 行为什么这样写？', context: '▶    3 │ int s = a + b;' },
    { id: 'q2', kind: 'edge', file: 'a.c', line: 4, code: 'return s;', text: 'a.c 第 4 行遇到「溢出」时会怎样？', context: '▶    4 │ return s;' },
  ],
  answers: [
    { id: 'q1', text: '先求和再返回，\n少写一次 a + b' },
    { id: 'q2', text: '' },
  ],
}

const bundle: RecordBundle = {
  format: BUNDLE_FORMAT,
  version: 1,
  student: '小测',
  exportedAt: '2026-09-20T08:00:00.000Z',
  tasks: [{ taskId: 'ring-buffer', scaffoldedAt: '2026-09-14T00:00:00.000Z', reviews: 2 }],
  records: [record],
  pending: [
    { taskId: 'ring-buffer', changes: [{ file: 'b.c', status: 'added', added: 5, removed: 0 }], agentEdits: [] },
  ],
}

describe('记录与导出文件', () => {
  it('parseRecord 认得自己写的记录；缺核心字段就整条不认', () => {
    expect(parseRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
    expect(parseRecord({ ...record, questions: undefined })).toBeUndefined()
    expect(parseRecord({ ...record, version: 2 })).toBeUndefined()
  })

  it('记录文件名不含冒号（Windows 文件名）', () => {
    expect(recordFileName(new Date('2026-09-15T12:00:00.123Z'))).toBe('2026-09-15T12-00-00-123Z.json')
  })

  it('parseBundle 拒收不是记录的文件，并说清缺什么', () => {
    const r = parseBundle({ format: 'x', version: 1, records: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems.join('\n')).toMatch(/不是培训记录文件[\s\S]*student/)
  })

  it('parseBundle 丢掉坏记录并报出条数 —— 不静默吞掉', () => {
    const r = parseBundle({ ...bundle, records: [record, { version: 1 }] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.dropped).toBe(1)
      expect(r.bundle.records).toHaveLength(1)
    }
  })

  it('bundleStats 统计轮数、题数、空答、Agent 改动和未答题的改动', () => {
    expect(bundleStats(bundle)).toEqual({
      rounds: 1,
      questions: 2,
      blank: 1,
      followUps: 0,
      agentEdits: 1,
      pendingFiles: 1,
    })
  })

  it('文件名：去掉非法字符，没名字写「未署名」', () => {
    expect(safeFileName('张 三/x')).toBe('张_三_x')
    expect(safeFileName('  ')).toBe('未署名')
    expect(exportFileName('张三', new Date('2026-09-20T08:00:00Z'))).toBe(
      'rcs-training-records-张三-20260920.json',
    )
  })
})

describe('summarizeQuiz —— 验收单用的汇总', () => {
  it('合并已答轮次与台账里的 Agent 改动；待答改动只列能出题的', () => {
    const pending = diffSnapshots(
      { 'a.c': BEFORE, 'n.c': 'int x;\n' },
      { 'a.c': AFTER, 'n.c': 'int x; // 注释\n' },
    )
    const s = summarizeQuiz(
      [record],
      [{ taskId: 'ring-buffer', file: 'c.c', tool: 'write', at: '2026-09-15T13:00:00.000Z' }],
      pending,
      true,
    )
    expect(s).toMatchObject({ enabled: true, rounds: 1, questions: 2, blank: 1, agentEdits: 2 })
    expect(s.agentFiles).toEqual(['a.c', 'c.c'])
    expect(s.pending.map((c) => c.file)).toEqual(['a.c'])
  })
})

describe('报告 —— 只摆事实，不打分', () => {
  const report = renderTraineeReport(bundle)

  it('回答原文逐行原样引用，空着的题如实写空着', () => {
    expect(report).toContain('> 先求和再返回，\n> 少写一次 a + b')
    expect(report).toContain('> （空着没答）')
  })

  it('写明这不是成绩，也写明哪些来源看不到', () => {
    expect(report).toContain('不是成绩')
    expect(report).toContain('bash')
  })

  it('列出导出时还没答题的改动', () => {
    expect(report).toContain('b.c（+5 / −0）')
  })

  it('没有任何分数或通过与否的字样', () => {
    expect(report).not.toMatch(/得分|分数|通过率|及格|不合格/)
  })

  it('汇总表链接到每人的报告，并说明数字不代表掌握程度', () => {
    const index = renderCollectIndex([
      { student: '小测', exportedAt: bundle.exportedAt, report: '小测.md', ...bundleStats(bundle) },
    ])
    expect(index).toContain('[小测.md](./%E5%B0%8F%E6%B5%8B.md)')
    expect(index).toContain('不代表掌握程度')
  })
})

describe('追问 —— 看不懂题可以先问，Agent 只给提示', () => {
  const qs = record.questions

  it('追问栏的原文取自由文本；没写是空串', () => {
    expect(followUpFrom({ answers: [{ id: FOLLOW_UP_ID, selected: [], custom: '「溢出」是什么？' }] })).toBe(
      '「溢出」是什么？',
    )
    expect(followUpFrom({ answers: [{ id: 'q1', selected: [], custom: '回答' }] })).toBe('')
    expect(followUpFrom(null)).toBe('')
  })

  it('追问栏的内容不会被当成哪道题的回答', () => {
    const a = answersFrom(qs, { answers: [{ id: FOLLOW_UP_ID, selected: [], custom: '看不懂' }] })
    expect(a.every((x) => x.text === '')).toBe(true)
  })

  it('问答框：题目在前，追问栏在最后、不带选项；追问次数用完就不再给', () => {
    const first = quizItems(qs, qs, [])
    expect(first.map((i) => i.id)).toEqual(['q1', 'q2', FOLLOW_UP_ID])
    // dsh 的问答框每项都要作答或跳过才能提交，「看不懂先跳过」得写在题下面
    expect(first[0]?.detail).toBe(`${qs[0]?.context}\n\n${QUIZ_NOTICE}\n\n${SKIP_TO_ASK}`)
    expect(first[2]).not.toHaveProperty('options')
    expect(first[2]?.detail).toContain('不会给答案')
    expect(first[2]?.detail).toContain(`还能追问 ${MAX_FOLLOW_UPS} 次`)

    const used = Array.from({ length: MAX_FOLLOW_UPS }, () => ({
      ask: '？',
      hint: '看第 4 行',
      open: ['q2'],
      at: record.at,
    }))
    expect(followUpsLeft(used)).toBe(0)
    expect(quizItems(qs, [qs[1]!], used).map((i) => i.id)).toEqual(['q2'])
    expect(quizItems(qs, [qs[1]!], used)[0]?.detail).not.toContain(SKIP_TO_ASK)
  })

  it('重问只问空着的题，题号不变，之前的追问与提示附在题下', () => {
    const f = [{ ask: '「溢出」是什么？', hint: '指结果超出类型能表示的范围。', open: ['q2'], at: record.at }]
    const [again] = quizItems(qs, openQuestions(qs, record.answers), f)
    expect(again?.id).toBe('q2')
    expect(again?.header).toBe('改动小测 2/2 · 再问一次')
    expect(again?.detail).toContain('你的追问：「溢出」是什么？')
    expect(again?.detail).toContain('Agent 的提示：指结果超出类型能表示的范围。')
  })

  it('合并回答：答过的一个字不动，只补空着的，并标上作答前看过几条提示', () => {
    const merged = mergeAnswers(
      record.answers,
      [
        { id: 'q1', text: '想改掉原答案' },
        { id: 'q2', text: '会变成负数' },
      ],
      1,
    )
    expect(merged).toEqual([
      { id: 'q1', text: '先求和再返回，\n少写一次 a + b' },
      { id: 'q2', text: '会变成负数', hintsSeen: 1 },
    ])
  })

  it('checkHint：说清题意的一句话放行；空的、太长的、贴代码的拒收', () => {
    expect(checkHint('  「溢出」指结果超出 int 能表示的范围，可以查一下 int 的取值范围。  ')).toEqual({
      ok: true,
      hint: '「溢出」指结果超出 int 能表示的范围，可以查一下 int 的取值范围。',
    })
    expect(checkHint('   ').ok).toBe(false)
    expect(checkHint('很'.repeat(MAX_HINT_CHARS + 1)).ok).toBe(false)
    expect(checkHint('看这里：\n```c\nreturn a + b;\n```').ok).toBe(false)
    expect(checkHint('改成这样就行：\nreturn a << 1;').ok).toBe(false)
    expect(checkHint('if (x) {').ok).toBe(false)
    expect(checkHint('#include <stdint.h>').ok).toBe(false)
  })

  const withFollowUp: QuizRecord = {
    ...record,
    answers: [record.answers[0]!, { id: 'q2', text: '会变成负数', hintsSeen: 1 }],
    followUps: [
      { ask: '「溢出」是什么？', hint: '指结果超出类型能表示的范围。', open: ['q2'], at: '2026-09-15T12:01:00.000Z' },
      { ask: '我答得对吗？', hint: '', open: [], at: '2026-09-15T12:02:00.000Z' },
    ],
  }

  it('parseRecord 认得带追问的记录、丢掉坏条目；没有追问字段的旧记录照样认', () => {
    expect(parseRecord(JSON.parse(JSON.stringify(withFollowUp)))).toEqual(withFollowUp)
    const bad = parseRecord({ ...withFollowUp, followUps: [{ ask: 1 }, withFollowUp.followUps![0]] })
    expect(bad?.followUps).toHaveLength(1)
    expect(parseRecord(record)).not.toHaveProperty('followUps')
  })

  it('报告列出追问原文与 Agent 提示原文，看过提示才答的题标出来', () => {
    const b: RecordBundle = { ...bundle, records: [withFollowUp] }
    const text = renderTraineeReport(b)
    expect(text).toContain('> 「溢出」是什么？')
    expect(text).toContain('（当时空着第 2 题）')
    expect(text).toContain('> 指结果超出类型能表示的范围。')
    expect(text).toContain('> （没回复）')
    expect(text).toContain('（看过 1 条 Agent 提示后作答）')
    expect(text).toContain('追问 2 次')
    expect(bundleStats(b).followUps).toBe(2)
    const index = renderCollectIndex([
      { student: '小测', exportedAt: b.exportedAt, report: '小测.md', ...bundleStats(b) },
    ])
    expect(index).toContain('| 空着 | 追问 |')
  })

  it('验收单的汇总数得出追问次数', () => {
    expect(summarizeQuiz([withFollowUp], [], [], true).followUps).toBe(2)
  })

  it('给学员的说明里写明可以追问、不给答案', () => {
    expect(QUIZ_INTRO).toContain('追问')
    expect(QUIZ_INTRO).toContain('不给答案')
  })
})
