/**
 * dsh-rcs-train —— 新生培训：任务发放、改动小测与验收。
 *
 * ## 四条设计约束
 *
 * 1. **不判定"学会了"。** 工具只把机械部分自动化（测试过没过、规范干不干净、
 *    用没用过生成），把老队员的时间省下来留给提问。知识体系原文写的是
 *    「老队员验收**+提问**」—— 提问那一半机器做不了，也不该假装能做。
 *
 * 2. **给能跑的基线，让学员改出更复杂的功能。** 不是挖空填空 ——
 *    对没写过嵌入式的新生，满屏 TODO 连从哪下手都不知道。基线一烧就有现象，
 *    改坏了立刻知道，goals 明确列出还差什么。
 *
 * 3. **裁剪失败绝不交付。** 挖不干净就等于把答案直接发给学员，而且没人会发现
 *    （学员不会举报自己拿到了答案）。所以 scaffold 宁可报错，也不发半成品。
 *
 * 4. **改动小测只记录、不判分，也不瞒学员。** 培训模式下 Agent 改了学员的代码，
 *    本轮结束前就这次改动出 1–3 道开放题；回答原样存进工作目录的 `.records/`，
 *    培训结束后导出，给老队员挑追问的方向。题目钉在改动过的行上、不带答案；
 *    问答框、启动横幅、领任务时都明说回答会给老队员看。学员看不懂题可以追问，模型只能经
 *    rcs_train_hint 回一段提示，提示原文同样进记录。细节见 rcs-core/training-quiz.ts。
 *
 * 适配层照例做薄：判断逻辑全在 `@rcs/core` 的 training / scaffold /
 * training-store / training-quiz 里，这里只负责包成 Tool、挂钩子、读写文件和渲染。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'

import { checkCurriculum, findTask, nextTask } from '../../rcs-core/src/training.ts'
import type { Curriculum, TrainingTask } from '../../rcs-core/src/training.ts'
import { scaffoldBanner, trimBaseline, workspaceCMake } from '../../rcs-core/src/scaffold.ts'
import {
  completedTaskIds,
  emptyProgress,
  parseProgress,
  renderReview,
  resolveWorkspaceRoot,
  taskProgressOf,
  taskWorkspace,
  withTaskProgress,
} from '../../rcs-core/src/training-store.ts'
import type { Progress, ReviewReport } from '../../rcs-core/src/training-store.ts'
import {
  FOLLOW_UP_ID,
  MAX_FOLLOW_UPS,
  MAX_HINT_CHARS,
  MAX_QUESTIONS,
  QUIZ_INTRO,
  RECORDS_DIR,
  answersFrom,
  buildQuestions,
  changeStat,
  checkHint,
  followUpFrom,
  followUpsLeft,
  hintsShown,
  isTrackedSource,
  lineRanges,
  mergeAnswers,
  openQuestions,
  parseQuestionRequests,
  pendingTaskIds,
  quizItems,
  quizzableChanges,
  renderChanges,
  summarizeQuiz,
  taskOfPath,
} from '../../rcs-core/src/training-quiz.ts'
import type { FileChange, QuizQuestion, QuizRecord } from '../../rcs-core/src/training-quiz.ts'
import {
  advanceTask,
  currentChanges,
  listRecords,
  loadLedger,
  loadSnapshot,
  readTaskSources,
  recordAgentEdit,
  saveRecord,
  saveSnapshot,
  taskDirs,
} from '../../rcs-core/src/training-records.ts'
import {
  firmwareNotFoundMessage,
  repoPaths,
  resolveFirmwareRoot,
  resolveRepoRoot,
} from '../../rcs-core/src/paths.ts'

export const name = 'rcs-train'
export const inject = ['tools']

export interface Config {
  /** 课程表路径。留空用 `config/training/curriculum.json`。 */
  curriculum: string
  /** 学员工作目录根。留空则按解析链找，默认与 dsh4rcs 仓库同级。 */
  workspaceRoot: string
  /** 学员标识，进验收单。不是账号系统，本机自填即可。 */
  student: string
}

export const Config: Schema<Config> = Schema.object({
  curriculum: Schema.string().default(''),
  workspaceRoot: Schema.string().default(''),
  student: Schema.string().default(''),
})

/* ---------- 宿主那一侧，本插件用到的最小形状（对照 0.1.5-rc.2 的 .d.ts） ---------- */

/** 一次宿主工具调用：名字、参数、调用它的 Agent。 */
interface HostCall {
  name: string
  arguments?: unknown
  agent?: HostAgent
}

/** Agent 上用到的两样：会话目录（解析相对路径）与 steer（本轮结束前提醒出题）。 */
interface HostAgent {
  session?: { header?: { cwd?: string } }
  steer?(message: unknown): void
}

/** ctx.rcs 上用到的那一个面（dsh-rcs-core 的 RcsService.watchGuardMode）。 */
interface GuardModeSource {
  watchGuardMode(watcher: (mode: string | undefined) => void): () => void
}

/** dsh 问答框服务（ctx.userQuestions）上用到的那一个方法。 */
interface QuestionService {
  ask(request: unknown): Promise<unknown>
}

type Listener = (...args: never[]) => unknown

function callView(title: string, input: unknown): ToolCallView {
  return { card: 'generic', title, kind: 'search', rawInput: input }
}

/** Windows 路径 → WSL 路径。gtest 库只能在 WSL 里链接，CMakeLists 里必须写 WSL 视角的路径。 */
function toWsl(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (m === null) return p.split('\\').join('/')
  return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.split('\\').join('/')}`
}

function textView(text: string): ToolResultView {
  return { card: 'generic', body: text } as unknown as ToolResultView
}

/**
 * 插件发给模型的一条提示。形状照宿主的 createUserMessage（dsh-repeat-tool-reminder 也是自己造的）；
 * 不为它引 dsh-llm —— 多一个宿主包，就多一处要联接到宿主实例的地方。
 */
function pluginNotice(text: string, summary: string): unknown {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: summary.slice(0, 120),
    }),
  })
}

export function apply(ctx: Context, config: Config): void {
  const curriculumPath = (): string =>
    config.curriculum !== ''
      ? config.curriculum
      : join(repoPaths.config(), 'training', 'curriculum.json')

  /**
   * 工作目录根。仓库位置在**这里**解析后传进去 —— training-store 是纯逻辑，
   * 而且它会被打进插件产物，在那边推 import.meta.url 会得到错的答案。
   */
  const workspace = (): { root: string; from: string } => {
    const repo = resolveRepoRoot()
    return resolveWorkspaceRoot({
      explicit: config.workspaceRoot,
      env: process.env,
      ...(repo.ok ? { repoRoot: repo.root } : {}),
      home: homedir(),
    })
  }

  const workspaceRoot = (): string => workspace().root

  /**
   * 进度文件放在**学员工作目录**里，不放共享仓库。
   *
   * 两个理由：
   *   1. 它是学员本机的个人数据，不该进版本控制，也不该被队友看到；
   *   2. 放仓库里会让测试和多人共用同一份进度 —— 实测踩过：
   *      跑一遍插件测试就把真实仓库的 data/ 写脏了。
   */
  const progressPath = (): string => join(workspaceRoot(), 'progress.json')

  /** 载入并校验课程表。校验失败直接抛 —— 拿一份坏课程表发任务比不发更糟。 */
  function loadCurriculum(): Curriculum {
    const p = curriculumPath()
    if (!existsSync(p)) {
      throw new Error(
        `找不到课程表：${p}\n` +
          `老队员需要先建好 config/training/curriculum.json（可参考仓库里的示例）。`,
      )
    }
    const r = checkCurriculum(JSON.parse(readFileSync(p, 'utf8')) as unknown)
    if (!r.ok) {
      throw new Error(`课程表有问题，已拒绝加载：\n  ${r.problems.join('\n  ')}`)
    }
    return r.curriculum
  }

  function loadProgress(): Progress {
    const p = progressPath()
    if (!existsSync(p)) return emptyProgress(config.student)
    try {
      return parseProgress(JSON.parse(readFileSync(p, 'utf8')) as unknown)
    } catch {
      // 文件坏了就当空进度重来。进度丢了只是重跑一次验收，
      // 拿半坏的记录去判断"这人做到哪了"会误导老队员。
      return emptyProgress(config.student)
    }
  }

  function saveProgress(p: Progress): void {
    const path = progressPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(p, null, 2), 'utf8')
  }

  /** 解析任务：给了 id 就取那个，没给就按前置关系推荐下一个。 */
  function pickTask(c: Curriculum, id: string | undefined, p: Progress): TrainingTask {
    if (id !== undefined && id !== '') {
      const t = findTask(c, id)
      if (t === undefined) {
        throw new Error(
          `没有这个任务：${id}\n可选：${c.tasks.map((x) => x.id).join(', ')}`,
        )
      }
      return t
    }
    const t = nextTask(c, completedTaskIds(p))
    if (t === undefined) {
      throw new Error('所有任务都已完成 —— 或者前置关系把剩下的都卡住了，请检查课程表。')
    }
    return t
  }

  // ---------- 改动小测：跟着 guard 的模式开关 ----------
  //
  // 模式只在 rcs-guard 的配置里设（dsh:start:training 的 overlay 把它固定成 training），
  // 这里经 ctx.rcs 读它，不自己再配一份 —— 两处各配一份迟早对不上。
  // 没装 dsh-rcs-core 或 guard 就读不到，按「不是培训模式」处理：不记录、不出题。

  let guardMode: string | undefined
  let announced: string | undefined | null = null
  const quizOn = (): boolean => guardMode === 'training'

  /** 模式一确定就在启动日志里说清楚 —— 以为在记其实没记、或者以为没记其实在记，都不行。 */
  function announce(): void {
    if (guardMode === announced) return
    announced = guardMode
    if (guardMode === 'training') {
      console.info(
        `[rcs-train] 改动小测已开启：Agent 改了学员工作目录里的 C/C++ 代码，` +
          `本轮结束前会就这次改动出 1–${MAX_QUESTIONS} 道开放题。` +
          `回答原样存在 ${join(workspaceRoot(), RECORDS_DIR)}，不评分；` +
          `培训结束后用 npm run train:export 导出交给老队员。`,
      )
    } else if (guardMode !== undefined) {
      console.info('[rcs-train] 改动小测：关闭（只在 npm run dsh:start:training 下开启）')
    }
  }

  ctx.inject(['rcs'], (scoped) => {
    const rcs = (scoped as unknown as { rcs?: Partial<GuardModeSource> }).rcs
    const watch = rcs?.watchGuardMode
    if (typeof watch !== 'function') return
    const stop = watch.call(rcs, (mode) => {
      guardMode = mode
      announce()
    })
    scoped.effect(() => () => {
      stop()
      guardMode = undefined
    })
  })

  const on = (event: string, listener: Listener): void => {
    ;(ctx as unknown as { on(event: string, listener: Listener): unknown }).on(event, listener)
  }

  /** 可选服务：没有就是 undefined。 */
  const optional = (service: string): unknown => {
    try {
      return (ctx as unknown as { get(name: string): unknown }).get(service)
    } catch {
      return undefined
    }
  }

  // ---------- 改动小测：观测 Agent 改了哪些文件 ----------

  /** 会改文件的宿主工具。bash / pwsh 也能写，但只看得到一条命令、看不出改了哪个文件 —— 不猜，如实不管。 */
  const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

  /** 这次调用写的是哪个文件（绝对路径）。相对路径按会话目录解析，与宿主 fs 工具同一条规则。 */
  function writtenFile(call: HostCall): string | undefined {
    if (!WRITE_TOOLS.has(call.name)) return undefined
    const args = (call.arguments ?? {}) as Record<string, unknown>
    if (call.name === 'str_replace_editor' && args['command'] === 'view') return undefined
    const raw = call.name === 'str_replace_editor' ? args['path'] : (args['file_path'] ?? args['path'])
    if (typeof raw !== 'string' || raw === '') return undefined
    if (isAbsolute(raw)) return raw
    const cwd = call.agent?.session?.header?.cwd
    return cwd === undefined ? undefined : resolve(cwd, raw)
  }

  /** 写的是不是某个任务目录里的源文件。 */
  function trainingTarget(call: HostCall): { taskId: string; rel: string } | undefined {
    const file = writtenFile(call)
    if (file === undefined) return undefined
    const hit = taskOfPath(workspaceRoot(), file)
    return hit !== undefined && isTrackedSource(hit.rel) ? hit : undefined
  }

  // 改之前先留一份快照。发基线时已经留过；这里补的是旧版本领的任务、或者 .records 被删了 ——
  // 没有「改之前」，就算不出「这次改了什么」。
  on('tools/pre-execute', async (call: HostCall, next: () => Promise<unknown>) => {
    try {
      const hit = quizOn() ? trainingTarget(call) : undefined
      if (hit !== undefined) {
        const root = workspaceRoot()
        if (loadSnapshot(root, hit.taskId) === undefined) {
          saveSnapshot(root, hit.taskId, readTaskSources(root, hit.taskId), new Date())
        }
      }
    } catch {
      /* 留不下快照只是少问一轮，不能挡住宿主工具 */
    }
    return next()
  })

  on(
    'tools/post-execute',
    async (call: HostCall, result: { isError?: boolean }, next: () => Promise<unknown>) => {
      const decision = await next()
      try {
        const hit = quizOn() && result.isError === false ? trainingTarget(call) : undefined
        if (hit !== undefined) {
          recordAgentEdit(workspaceRoot(), {
            taskId: hit.taskId,
            file: hit.rel,
            tool: call.name,
            at: new Date().toISOString(),
          })
        }
      } catch {
        /* 记账失败只少一条记录，不能让宿主工具跟着失败 */
      }
      return decision
    },
  )

  // ---------- 改动小测：本轮结束前提醒出题 ----------
  //
  // 每个 Agent 每轮最多提醒一次：模型没理会就算了，验收单会兜底。
  // 只提醒根 Agent —— 子 Agent 弹不了问答框（宿主不许被托管的 Agent 直接问人）。

  const steeredTurn = new WeakMap<object, number>()

  /**
   * 学员关掉问答框的时刻（按任务）。这之前的改动不再自动提醒：工具已经对模型说了
   * 「这一轮不用再弹」，提醒照发的话，学员刚关掉的框转眼又弹一次。验收单按快照算，照样兜底。
   */
  const declinedAt = new Map<string, string>()

  /**
   * 学员追问了、还等着模型回复的那一轮（按任务）。记录在追问那一刻就已存盘、改动也已翻篇，
   * 这里只是让 rcs_train_hint 接得上。只在内存里：dsh 重启就作废 —— 追问原文仍在记录里，
   * 只是没有回复，空着的题也不再重问。
   */
  const awaitingHint = new Map<string, QuizRecord>()

  function isRootAgent(agent: object): boolean {
    const registry = optional('agents') as { roots?: () => unknown[] } | undefined
    const roots = typeof registry?.roots === 'function' ? registry.roots() : undefined
    return roots === undefined || roots.includes(agent)
  }

  type Waiting = { taskId: string; changes: FileChange[]; agentFiles: Set<string> }

  /** 有 Agent 改动、且真改了代码的任务。只动了注释空白的直接翻篇，不打扰学员。 */
  function tasksAwaitingQuiz(): Waiting[] {
    const root = workspaceRoot()
    const ledger = loadLedger(root)
    const out: Waiting[] = []
    for (const taskId of pendingTaskIds(ledger)) {
      // 追问还等着回复的任务先不催出新题：rcs_train_quiz 这时会拒绝，新改动等回复完再出题
      if (awaitingHint.has(taskId)) continue
      const edits = ledger.edits.filter((e) => e.taskId === taskId)
      const declined = declinedAt.get(taskId)
      if (declined !== undefined && edits.every((e) => e.at <= declined)) continue
      const at = new Date()
      const { hasSnapshot, files, changes } = currentChanges(root, taskId)
      const open = quizzableChanges(changes)
      if (!hasSnapshot || open.length === 0) {
        advanceTask(root, taskId, files, at)
        continue
      }
      const agentFiles = new Set(edits.map((e) => e.file))
      out.push({ taskId, changes: open, agentFiles })
    }
    return out
  }

  function quizReminder(waiting: readonly Waiting[]): string {
    const L = ['[dsh4rcs 培训模式 · 改动小测] 学员工作目录里的代码这一轮有改动，还没出题：']
    for (const w of waiting) {
      for (const c of w.changes) {
        L.push(
          `  - 任务 ${w.taskId}：${c.file}（+${c.added} / −${c.removed}` +
            `${w.agentFiles.has(c.file) ? '，你改的' : ''}）第 ${lineRanges(c.touched)} 行`,
        )
      }
    }
    L.push('')
    L.push(`结束本轮前，请调用 rcs_train_quiz 就这些改动出 1–${MAX_QUESTIONS} 道题，每个任务调用一次：`)
    L.push('  - 每道题钉在上面列出的某一行（file + line），优先挑你改的、学员最该弄懂的地方；')
    L.push('  - 题型只有 why / what-if / edge：what-if 给一个具体的替代写法 variant，edge 给一个具体的情形 situation；')
    L.push('  - 不要附答案，也不要在对话里提示答案。学员的回答由工具直接存盘，你看不到。')
    L.push('学员可以直接关掉问答框不答，那也没关系，验收时会再问。')
    return L.join('\n')
  }

  function hintReminder(taskIds: readonly string[]): string {
    return (
      `[dsh4rcs 培训模式 · 改动小测] 学员在 ${taskIds.join('、')} 的小测里追问了，还没回复。` +
      '结束本轮前，请调用 rcs_train_hint 回一段提示 —— 只帮学员弄清题意、指出该看哪，不给答案；' +
      '工具会把提示连同空着的题再弹给学员。不要在对话里回答。'
    )
  }

  on('agent/turn-stopping', async (payload: { agent?: HostAgent; turn?: number }) => {
    try {
      const agent = payload.agent
      if (!quizOn() || agent === undefined || typeof agent.steer !== 'function') return
      if (steeredTurn.get(agent) === payload.turn || !isRootAgent(agent)) return
      const hints = [...awaitingHint.keys()]
      const waiting = tasksAwaitingQuiz()
      if (hints.length === 0 && waiting.length === 0) return
      steeredTurn.set(agent, payload.turn ?? -1)
      const text: string[] = []
      const summary: string[] = []
      if (hints.length > 0) {
        text.push(hintReminder(hints))
        summary.push(`${hints.join('、')} 的追问待回复`)
      }
      if (waiting.length > 0) {
        text.push(quizReminder(waiting))
        summary.push(`${waiting.map((w) => w.taskId).join('、')} 有改动待出题`)
      }
      agent.steer(pluginNotice(text.join('\n\n'), `改动小测：${summary.join('；')}`))
    } catch {
      /* 提醒失败就等验收单兜底 */
    }
  })

  /** 出题用哪个任务：给了就用；没给就取台账里唯一有改动的那个。 */
  function pickQuizTask(root: string, requested: string | undefined): string {
    if (requested !== undefined && requested !== '') {
      if (!existsSync(join(root, requested))) {
        throw new Error(`工作目录里没有任务 ${requested}：${join(root, requested)}`)
      }
      return requested
    }
    const fromLedger = pendingTaskIds(loadLedger(root))
    if (fromLedger.length === 1 && fromLedger[0] !== undefined) return fromLedger[0]
    if (fromLedger.length > 1) {
      throw new Error(
        `有 ${fromLedger.length} 个任务都有待答的改动（${fromLedger.join('、')}），` +
          '请用 taskId 指定，每个任务调用一次。',
      )
    }
    const withChanges = taskDirs(root).filter(
      (t) => quizzableChanges(currentChanges(root, t).changes).length > 0,
    )
    if (withChanges.length === 1 && withChanges[0] !== undefined) return withChanges[0]
    throw new Error(
      withChanges.length === 0
        ? '学员工作目录里没有待答题的改动。'
        : `有多个任务都有改动（${withChanges.join('、')}），请用 taskId 指定。`,
    )
  }

  /** 学员写了追问、还有空着的题时交给模型的话：追问原文、空着的题、回复的规矩。不含任何回答。 */
  function followUpBrief(record: QuizRecord, ask: string, open: readonly QuizQuestion[]): string {
    const left = followUpsLeft(record.followUps)
    const L = ['学员在追问栏里写了（原文，已存盘）：']
    for (const line of ask.trim().split(/\r?\n/)) L.push(`  > ${line}`)
    L.push('', '还空着、回复后会再问一次的题：')
    for (const q of open) {
      L.push(`  ${record.questions.findIndex((x) => x.id === q.id) + 1}. ${q.text}`)
    }
    L.push('')
    L.push(
      `请调用 rcs_train_hint（taskId: "${record.taskId}"）回一段提示，工具会把提示连同这几道题再弹给学员。规矩：`,
    )
    L.push('  - 只帮学员弄清题意：解释题目里的词、说清题目在问什么、指出该看哪几行，或者建议用 rcs_kb_search 查什么；')
    L.push(
      '  - 不许说出这一行为什么这样写、会发生什么，不许给改写后的代码或结论，' +
        '也不许判断学员的想法对不对 —— 那些就是答案；',
    )
    L.push(`  - 不超过 ${MAX_HINT_CHARS} 字、不贴代码；提示原文会存进记录，老队员会看；`)
    L.push('  - 不要在对话里回答学员，也不要问学员答了什么。')
    L.push(left > 0 ? `这一轮学员还能再追问 ${left} 次。` : '这是这一轮最后一次追问，回复之后不再给追问栏。')
    return L.join('\n')
  }

  /**
   * 一次作答存盘之后给模型的话。学员写了追问、还有空着的题，就等模型回复；
   * 题都答完了还写了追问，只存盘留给老队员 —— 没有要重问的题，也就没有要回复的，追问原文也不回传。
   */
  function settle(
    record: QuizRecord,
    ask: string,
    lead: string,
    recorded: number,
  ): { recorded: number; text: string } {
    const open = openQuestions(record.questions, record.answers)
    if (ask.trim() !== '' && open.length > 0) {
      awaitingHint.set(record.taskId, record)
      return { recorded, text: `${lead}\n\n${followUpBrief(record, ask, open)}` }
    }
    const note =
      ask.trim() !== ''
        ? '学员在追问栏里也写了内容，但题都答完了：追问已随记录存盘，留给老队员，你不用回复。'
        : ''
    return {
      recorded,
      text: `${lead}${note}不要追问学员答了什么，也不要评价对错 —— 那留给验收时的老队员。`,
    }
  }

  const NO_HINT_NOTE =
    '只有 rcs_train_quiz / rcs_train_hint 的结果里说学员追问了，才用它回复。' +
    '等回复的追问只在内存里，dsh 重启后作废（追问原文仍在记录里）。'

  /** 回复哪个任务的追问：给了就用；没给就取唯一在等回复的那个。 */
  function pickHintTask(requested: string | undefined): string {
    if (requested !== undefined && requested !== '') {
      if (awaitingHint.has(requested)) return requested
      throw new Error(`任务 ${requested} 没有等回复的追问。${NO_HINT_NOTE}`)
    }
    const ids = [...awaitingHint.keys()]
    if (ids.length === 1 && ids[0] !== undefined) return ids[0]
    if (ids.length > 1) {
      throw new Error(`有 ${ids.length} 个任务都有等回复的追问（${ids.join('、')}），请用 taskId 指定。`)
    }
    throw new Error(`现在没有等回复的追问。${NO_HINT_NOTE}`)
  }

  // ---------- rcs_train_task ----------

  ctx.tools.register(
    defineTool({
      name: 'rcs_train_task',
      description:
        '取一个培训任务：要做什么、要加出哪些功能、前置知识在队内哪份资料里。' +
        '不传 taskId 就按前置关系推荐下一个。' +
        '这是**只读**工具，不会往任何地方写文件。',
      parameters: {
        taskId: { type: 'string', description: '任务 id，省略则推荐下一个' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            task: { type: 'json', description: '任务定义' },
            text: { type: 'string', description: '给人看的任务说明' },
          },
        },
        render: (_args, value) => {
          const v = value as unknown as { text: string }
          return [{ type: 'text', text: v.text ?? '' }]
        },
      },
      presentCall: (args) => callView('取培训任务', args.taskId ?? '（下一个）'),
      presentResult: (_a, r) =>
        textView(String((r as { text?: string })?.text ?? '')),
      async execute(args) {
        const c = loadCurriculum()
        const p = loadProgress()
        const t = pickTask(c, args.taskId, p)
        const tp = taskProgressOf(p, t.id)

        const L: string[] = []
        L.push(`任务 ${t.id}：${t.title}`)
        L.push(`阶段：${t.stage}    验收方式：${t.kind === 'pc-test' ? 'PC 单元测试（不用板子）' : '上板看现象'}`)
        if (t.requires.length > 0) L.push(`前置任务：${t.requires.join(', ')}`)
        L.push('')
        L.push('你要加出来的功能：')
        for (const g of t.goals) L.push(`  - ${g}`)
        L.push('')
        L.push('队内资料（用 rcs_kb_search 查这几个关键词）：')
        for (const r of t.refs) L.push(`  · ${r}`)
        L.push('')
        if (t.kind === 'pc-test') {
          L.push(`验收判据：这些 gtest 用例必须全绿 —— ${t.accept.tests.join(', ')}`)
        } else {
          L.push('验收判据（需当面确认）：')
          for (const o of t.accept.observe) L.push(`  □ ${o}`)
        }
        L.push('')
        L.push(
          tp.scaffoldedAt === null
            ? '还没领基线。用 rcs_train_scaffold 领取。'
            : `基线已于 ${tp.scaffoldedAt} 发到 ${taskWorkspace(t.id, workspaceRoot())}`,
        )
        if (quizOn()) {
          L.push('')
          L.push(QUIZ_INTRO)
        }

        return { task: t, text: L.join('\n') } as unknown as never
      },
    }),
  )

  // ---------- rcs_train_scaffold ----------

  ctx.tools.register(
    defineTool({
      name: 'rcs_train_scaffold',
      description:
        '把任务的**基线模板**发到学员工作目录。基线是一份能跑但功能不全的代码，' +
        '学员的任务是把它扩展完整。' +
        '注意：仓库里存的是完整实现，发放时按课程表动态挖空 —— ' +
        '**挖空失败会拒绝交付**，绝不发半成品（那等于直接给答案）。',
      parameters: {
        taskId: { type: 'string', required: true, description: '任务 id' },
        force: { type: 'boolean', description: '目标目录已存在时是否覆盖，默认否' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            workspace: { type: 'string', description: '发放目录' },
            files: { type: 'json', description: '写出的文件' },
            text: { type: 'string', description: '给人看的结果' },
          },
        },
        render: (_args, value) => {
          const v = value as unknown as { text: string }
          return [{ type: 'text', text: v.text ?? '' }]
        },
      },
      presentCall: (args) => callView('发放培训基线', args.taskId),
      presentResult: (_a, r) =>
        textView(String((r as { text?: string })?.text ?? '')),
      async execute(args) {
        const c = loadCurriculum()
        const t = findTask(c, args.taskId)
        if (t === undefined) {
          throw new Error(`没有这个任务：${args.taskId}`)
        }

        const fw = resolveFirmwareRoot({})
        if (!fw.ok) {
          throw new Error(firmwareNotFoundMessage(fw.tried))
        }

        const src = join(fw.root, t.baseline)
        if (!existsSync(src)) {
          throw new Error(`基线文件不存在：${src}\n请检查课程表里 ${t.id} 的 baseline 路径。`)
        }

        // ---- 裁剪。失败就整体拒绝，绝不发半成品 ----
        const trimmed = trimBaseline(
          readFileSync(src, 'utf8'),
          t.strip,
          '让对应的测试变绿（跑一次测试，红的那条就是这里）',
        )
        if (!trimmed.ok) {
          throw new Error(
            `基线裁剪失败，**已拒绝发放**：\n  ${trimmed.problems.join('\n  ')}\n\n` +
              `挖不干净就等于把完整答案发给学员，所以这里宁可报错。` +
              `请老队员核对课程表里 ${t.id} 的 strip 列表与基线源码是否对得上。`,
          )
        }

        const ws = taskWorkspace(t.id, workspaceRoot())
        if (existsSync(ws) && args.force !== true) {
          throw new Error(
            `工作目录已存在：${ws}\n` +
              `直接覆盖会抹掉学员已经写的代码。确认要重发请传 force: true。`,
          )
        }
        mkdirSync(ws, { recursive: true })

        const files: string[] = []

        const banner = scaffoldBanner(t.id, new Date(), t.goals)
        const outSrc = join(ws, basename(t.baseline))
        writeFileSync(outSrc, banner + trimmed.source, 'utf8')
        files.push(outSrc)

        // 测试文件原样发（它就是"还差什么"的清单，不该挖空）
        const testNames: string[] = []
        if (t.testFile !== '') {
          const tsrc = join(fw.root, t.testFile)
          if (!existsSync(tsrc)) {
            throw new Error(
              `测试文件不存在：${tsrc}
` +
                `pc-test 任务缺了测试，学员就不知道"还差什么" —— 已拒绝发放。`,
            )
          }
          const outTest = join(ws, basename(t.testFile))
          writeFileSync(outTest, readFileSync(tsrc, 'utf8'), 'utf8')
          files.push(outTest)
          testNames.push(basename(t.testFile))
        }

        // 头文件等原样带上。少了它学员根本编不过，
        // 而报错会指向一个跟任务无关的方向，非常劝退。
        for (const inc of t.include) {
          const isrc = join(fw.root, inc)
          if (!existsSync(isrc)) {
            throw new Error(`include 里的文件不存在：${isrc}
请检查课程表里 ${t.id} 的 include。`)
          }
          const out = join(ws, basename(inc))
          writeFileSync(out, readFileSync(isrc, 'utf8'), 'utf8')
          files.push(out)
        }

        // 生成工作目录专用的 CMakeLists —— 仓库里那份的相对路径在扁平目录下不成立
        if (testNames.length > 0) {
          const gtestDir = toWsl(
            join(fw.root, 'template', 'RCS_Template_F407', 'RCS', 'RCS_Support', 'test', 'lib'),
          )
          const cmake = join(ws, 'CMakeLists.txt')
          writeFileSync(
            cmake,
            workspaceCMake(t.id, gtestDir, [basename(t.baseline)], testNames),
            'utf8',
          )
          files.push(cmake)
        }

        // 发出去的基线就是改动小测的第一份快照：之后每一轮的「这次改动」都相对它算。
        // 重发（force）时，台账里记在旧基线上的改动一并作废。
        try {
          const root = workspaceRoot()
          advanceTask(root, t.id, readTaskSources(root, t.id), new Date())
        } catch {
          /* 快照写不下去不影响发基线；第一次改代码前 pre-execute 钩子会再补 */
        }

        const p = withTaskProgress(loadProgress(), t.id, {
          scaffoldedAt: new Date().toISOString(),
        })
        saveProgress(p)

        const L: string[] = []
        L.push(`已发放：${t.id}  ${t.title}`)
        L.push(`目录：${ws}`)
        L.push('')
        L.push('文件：')
        for (const f of files) L.push(`  ${f}`)
        L.push('')
        if (trimmed.stripped.length > 0) {
          L.push(`挖空了 ${trimmed.stripped.length} 个函数，它们标着 TODO：`)
          for (const s of trimmed.stripped) L.push(`  · ${s}`)
          L.push('')
        }
        if (quizOn()) {
          L.push(QUIZ_INTRO)
          L.push('')
        }
        L.push('下一步：跑一次测试，红的那几条就是还差的功能。')

        return { workspace: ws, files, text: L.join('\n') } as unknown as never
      },
    }),
  )

  // ---------- rcs_train_quiz ----------

  ctx.tools.register(
    defineTool({
      name: 'rcs_train_quiz',
      description:
        '改动小测：就学员工作目录里**这次的改动**出 1–3 道开放题，弹出问答框让学员作答。' +
        '只在培训模式（npm run dsh:start:training）下可用；Agent 改了学员代码后，本轮结束前会收到提醒。' +
        '每道题钉在改动过的某一行上（file + line），题型只有 why（为什么这样写）、' +
        'what-if（改成 variant 会怎样）、edge（遇到 situation 会怎样），题干由工具生成。' +
        '**不要附答案，也不要在对话里暗示答案。** 学员的回答由工具原样存进工作目录的 .records，' +
        '不回传对话、不评分，培训结束后导出交给老队员。' +
        `问答框最后有一栏可选的追问（每轮最多 ${MAX_FOLLOW_UPS} 次）：学员写了追问，` +
        '结果里会给出追问原文和回复的规矩，按规矩用 rcs_train_hint 回复。',
      parameters: {
        taskId: { type: 'string', description: '任务 id；省略时取有待答改动的那个任务' },
        questions: {
          type: 'json',
          required: true,
          description:
            `1–${MAX_QUESTIONS} 道题，例如 [{"kind":"why","file":"ring_buffer.c","line":41},` +
            '{"kind":"what-if","file":"ring_buffer.c","line":52,"variant":"用 % 代替 & mask"},' +
            '{"kind":"edge","file":"ring_buffer.c","line":60,"situation":"缓冲区刚好满"}]',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recorded: { type: 'number', description: '有内容的回答条数' },
            text: { type: 'string', description: '结果说明（不含回答原文）' },
          },
        },
        render: (_args, value) => {
          const v = value as unknown as { text: string }
          return [{ type: 'text', text: v.text ?? '' }]
        },
      },
      presentCall: (args) => callView('改动小测', args.taskId ?? '（有待答改动的任务）'),
      presentResult: (_a, r) =>
        textView(String((r as { text?: string })?.text ?? '')),
      async execute(args, exec) {
        if (!quizOn()) {
          throw new Error(
            '改动小测只在培训模式下开启（npm run dsh:start:training）。现在不是培训模式，不出题。',
          )
        }
        const root = workspaceRoot()
        const taskId = pickQuizTask(root, args.taskId)
        if (awaitingHint.has(taskId)) {
          throw new Error(
            `学员在任务 ${taskId} 的小测里追问了，还没回复。` +
              '先调用 rcs_train_hint 回复（工具会把空着的题再问一次），再出新题。',
          )
        }
        const cutoff = new Date()
        const { hasSnapshot, files, changes } = currentChanges(root, taskId)
        if (!hasSnapshot) {
          advanceTask(root, taskId, files, cutoff)
          return {
            recorded: 0,
            text: `任务 ${taskId} 没有改动前的快照，算不出这次改了什么；已从现在开始记录，这次不出题。`,
          } as unknown as never
        }
        const open = quizzableChanges(changes)
        if (open.length === 0) {
          advanceTask(root, taskId, files, cutoff)
          return {
            recorded: 0,
            text: `任务 ${taskId} 自上次答题以来没有需要出题的改动（没改代码，或只动了注释和空白）。`,
          } as unknown as never
        }

        const parsed = parseQuestionRequests(args.questions)
        const built = parsed.ok ? buildQuestions(parsed.requests, open, files) : parsed
        if (!built.ok) {
          throw new Error(
            `题目不合格，没有弹给学员：\n  ${built.problems.join('\n  ')}\n\n` +
              `这次可以出题的位置：\n` +
              open.map((c) => `  ${c.file} 第 ${lineRanges(c.touched)} 行`).join('\n'),
          )
        }

        const service = optional('userQuestions') as Partial<QuestionService> | undefined
        if (typeof service?.ask !== 'function') {
          throw new Error('当前环境没有 dsh 的问答框（userQuestions 服务），出不了题。改动仍记为待答，验收时会再问。')
        }
        const total = built.questions.length
        let reply: unknown
        try {
          reply = await service.ask({
            questions: quizItems(built.questions, built.questions, []),
            ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
            signal: exec.signal,
          })
        } catch (error) {
          declinedAt.set(taskId, cutoff.toISOString())
          throw new Error(
            `学员没有作答（${error instanceof Error ? error.message : String(error)}）。` +
              '改动仍记为待答，验收时会再问；这一轮不用再弹。',
          )
        }

        // 有追问也先存盘、翻篇：已答的题不能因为模型没回复、或者 dsh 重启就丢。
        // 追问之后的重问改的是同一份记录（文件名按 at 取）。
        const answers = answersFrom(built.questions, reply)
        const ask = followUpFrom(reply)
        const agentEdits = loadLedger(root).edits.filter(
          (e) => e.taskId === taskId && e.at <= cutoff.toISOString(),
        )
        const record: QuizRecord = {
          version: 1,
          taskId,
          student: loadProgress().student || config.student,
          at: cutoff.toISOString(),
          agentEdits,
          changes: open.map(changeStat),
          diff: renderChanges(open),
          questions: built.questions,
          answers,
          ...(ask.trim() !== ''
            ? {
                followUps: [
                  {
                    ask,
                    hint: '',
                    open: openQuestions(built.questions, answers).map((q) => q.id),
                    at: new Date().toISOString(),
                  },
                ],
              }
            : {}),
        }
        saveRecord(root, record)
        advanceTask(root, taskId, files, cutoff)

        const filled = answers.filter((a) => a.text.trim() !== '').length
        return settle(
          record,
          ask,
          `学员答完了 ${total} 道题（${filled} 道有内容），回答已存盘，不回传对话、也不评分。`,
          filled,
        ) as unknown as never
      },
    }),
  )

  // ---------- rcs_train_hint ----------

  ctx.tools.register(
    defineTool({
      name: 'rcs_train_hint',
      description:
        '改动小测的追问回复：rcs_train_quiz（或上一次 rcs_train_hint）的结果说学员追问了，就用它回一段提示，' +
        '工具会把提示连同空着的题再弹给学员。' +
        '**只帮学员弄清题意、指出该看哪，不给答案**：不说这一行为什么这样写、会发生什么，' +
        '不给改写后的代码或结论，不判断学员的想法对不对。' +
        `不超过 ${MAX_HINT_CHARS} 字、不贴代码；提示原文存进 .records，给老队员核对。`,
      parameters: {
        taskId: { type: 'string', description: '任务 id；省略时取唯一在等回复的那个' },
        hint: {
          type: 'string',
          required: true,
          description: `给学员的提示：不超过 ${MAX_HINT_CHARS} 字、不贴代码、不给答案`,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recorded: { type: 'number', description: '这次新答上的题数' },
            text: { type: 'string', description: '结果说明（不含回答原文）' },
          },
        },
        render: (_args, value) => {
          const v = value as unknown as { text: string }
          return [{ type: 'text', text: v.text ?? '' }]
        },
      },
      presentCall: (args) => callView('回复学员的追问', args.taskId ?? '（在等回复的任务）'),
      presentResult: (_a, r) =>
        textView(String((r as { text?: string })?.text ?? '')),
      async execute(args, exec) {
        if (!quizOn()) {
          throw new Error(
            '改动小测只在培训模式下开启（npm run dsh:start:training）。现在不是培训模式，没有追问可回复。',
          )
        }
        const taskId = pickHintTask(args.taskId)
        const pending = awaitingHint.get(taskId)
        const followUps = pending?.followUps ?? []
        const last = followUps[followUps.length - 1]
        if (pending === undefined || last === undefined || last.hint !== '') {
          awaitingHint.delete(taskId)
          throw new Error(`任务 ${taskId} 没有等回复的追问。${NO_HINT_NOTE}`)
        }
        const checked = checkHint(args.hint)
        if (!checked.ok) {
          throw new Error(
            `提示没有弹给学员：\n  ${checked.problems.join('\n  ')}\n\n` +
              '改好再调用一次 rcs_train_hint：只说清题意、指出该看哪，不给答案。',
          )
        }
        const service = optional('userQuestions') as Partial<QuestionService> | undefined
        if (typeof service?.ask !== 'function') {
          throw new Error('当前环境没有 dsh 的问答框（userQuestions 服务），弹不出提示。学员的追问已在记录里。')
        }

        // 提示先进记录再弹框：弹出去就算给过学员了，哪怕接下来学员关框、dsh 退出
        const root = workspaceRoot()
        const hinted: QuizRecord = {
          ...pending,
          followUps: [...followUps.slice(0, -1), { ...last, hint: checked.hint }],
        }
        saveRecord(root, hinted)
        awaitingHint.delete(taskId)

        const open = openQuestions(hinted.questions, hinted.answers)
        const items = quizItems(hinted.questions, open, hinted.followUps ?? [])
        let reply: unknown
        try {
          reply = await service.ask({
            questions: items,
            ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
            signal: exec.signal,
          })
        } catch (error) {
          return {
            recorded: 0,
            text:
              `学员关掉了问答框（${error instanceof Error ? error.message : String(error)}）。` +
              '你的提示和之前的回答都已存盘，空着的题就空着，验收时老队员会当面问；这一轮不用再弹。',
          } as unknown as never
        }

        const answers = mergeAnswers(
          hinted.answers,
          answersFrom(open, reply),
          hintsShown(hinted.followUps),
        )
        // 追问栏没给出来（次数用完了）就不认回复里的追问
        const ask = items.some((i) => i.id === FOLLOW_UP_ID) ? followUpFrom(reply) : ''
        const stillOpen = openQuestions(hinted.questions, answers)
        const record: QuizRecord = {
          ...hinted,
          answers,
          ...(ask.trim() !== ''
            ? {
                followUps: [
                  ...(hinted.followUps ?? []),
                  { ask, hint: '', open: stillOpen.map((q) => q.id), at: new Date().toISOString() },
                ],
              }
            : {}),
        }
        saveRecord(root, record)

        const filled = open.length - stillOpen.length
        return settle(
          record,
          ask,
          `学员这次又答了 ${filled} 道（还空着 ${stillOpen.length} 道），回答已存盘，不回传对话、也不评分。`,
          filled,
        ) as unknown as never
      },
    }),
  )

  // ---------- rcs_train_review ----------

  ctx.tools.register(
    defineTool({
      name: 'rcs_train_review',
      description:
        '生成**给老队员看的验收单**：测试几比几、规范干不干净、用没用过 G2 生成、' +
        '改动小测答了几轮、需要当面确认哪些现象、建议追问什么。' +
        '刻意**不给通过/不通过的总判定** —— 是否掌握由验收人提问后决定。' +
        '测试与规范结果需由调用方先跑 rcs_support_test / rcs_lint_embedded 后传入。',
      parameters: {
        taskId: { type: 'string', required: true, description: '任务 id' },
        testsPassed: { type: 'number', description: 'gtest 通过数' },
        testsFailed: { type: 'number', description: 'gtest 失败数' },
        testFailures: { type: 'json', description: '失败用例名数组' },
        testBlocked: { type: 'string', description: '测试无法运行的原因（如工具链缺失）' },
        lintErrors: { type: 'number', description: 'lint 错误数' },
        lintWarnings: { type: 'number', description: 'lint 警告数' },
        lintFindings: { type: 'json', description: 'lint 发现条目数组' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', description: '验收单' } },
        },
        render: (_args, value) => {
          const v = value as unknown as { text: string }
          return [{ type: 'text', text: v.text ?? '' }]
        },
      },
      presentCall: (args) => callView('生成验收单', args.taskId),
      presentResult: (_a, r) =>
        textView(String((r as { text?: string })?.text ?? '')),
      async execute(args, exec) {
        const c = loadCurriculum()
        const t = findTask(c, args.taskId)
        if (t === undefined) throw new Error(`没有这个任务：${args.taskId}`)

        const p0 = loadProgress()
        const tp = taskProgressOf(p0, t.id)

        const report: ReviewReport = {
          task: t,
          student: p0.student || config.student,
          generated: tp.generated,
          reviews: tp.reviews + 1,
        }

        if (
          args.testsPassed !== undefined ||
          args.testsFailed !== undefined ||
          args.testBlocked !== undefined
        ) {
          report.tests = {
            passed: args.testsPassed ?? 0,
            failed: args.testsFailed ?? 0,
            failures: Array.isArray(args.testFailures) ? (args.testFailures as string[]) : [],
            ...(args.testBlocked !== undefined ? { blocked: args.testBlocked } : {}),
          }
        }

        if (args.lintErrors !== undefined || args.lintWarnings !== undefined) {
          report.lint = {
            errors: args.lintErrors ?? 0,
            warnings: args.lintWarnings ?? 0,
            findings: Array.isArray(args.lintFindings) ? (args.lintFindings as string[]) : [],
          }
        }

        // ---- 改动小测 ----
        const root = workspaceRoot()
        const { hasSnapshot, changes } = currentChanges(root, t.id)
        const open = hasSnapshot ? quizzableChanges(changes) : []
        report.quiz = summarizeQuiz(
          listRecords(root, t.id),
          loadLedger(root).edits.filter((e) => e.taskId === t.id),
          open,
          quizOn(),
        )

        // 兜底：还有没答题的改动，就让模型先补一轮。验收单上也写着，人和模型都看得到。
        if (quizOn() && open.length > 0) {
          const defer = (exec as unknown as { deferContext?: (message: unknown) => void })
            .deferContext
          if (typeof defer === 'function') {
            defer.call(
              exec,
              pluginNotice(
                `[dsh4rcs 培训模式 · 验收兜底] 任务 ${t.id} 还有没答题的改动：` +
                  open.map((x) => `${x.file} 第 ${lineRanges(x.touched)} 行`).join('；') +
                  `。请先调用 rcs_train_quiz（taskId: "${t.id}"）就这些改动出题，再重新生成验收单。不要附答案。`,
                `验收兜底：${t.id} 有改动待答题`,
              ),
            )
          }
        }

        saveProgress(withTaskProgress(p0, t.id, { reviews: tp.reviews + 1 }))

        return { text: renderReview(report) } as unknown as never
      },
    }),
  )

  // 横幅带上「这个路径是怎么来的」：默认值变过一次，
  // 而学员看到的第一手信息就是这一行。说不清来源，出问题时没人查得动。
  const ws = workspace()
  console.info(
    `[rcs-train] 培训插件已加载：课程表 ${curriculumPath()}，` +
      `工作目录 ${ws.root}（来源：${ws.from}）`,
  )
}
