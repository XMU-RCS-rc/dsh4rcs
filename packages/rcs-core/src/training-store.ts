/**
 * 培训进度存储与验收单渲染。
 *
 * ## 存哪
 *
 * 学员工作目录默认是**与 dsh4rcs 仓库同级**的 `rcs-training/<任务id>/`，
 * 即推荐布局里的第三个兄弟目录：
 *
 *     code/
 *     ├── dsh4rcs/       本仓库
 *     ├── RCS_code/      固件仓库
 *     └── rcs-training/  学员工作目录
 *
 * 早先默认放 `~/rcs-training`，理由是「跨平台、不依赖盘符」。**已改**：
 * Windows 上主目录必然在 C 盘，而队里的工作盘是 D，把三十多个新生的
 * 工作目录都堆到系统盘不合适。跟着仓库走既落在同一个盘，也仍然
 * 不和两个 git 仓库混在一起 —— 学员改坏了不会波及队内代码。
 *
 * 进度记录：`<学员工作目录>/progress.json`
 *   本地文件，不上传、不联网。它记的是"谁做到哪、跑过几次验收"，
 *   属于验收材料而非成绩单 —— 培训的原则是「重在培训，不在筛选」。
 *   刻意不放共享仓库：它是学员本机的个人数据，而且放仓库会让测试写脏 data/。
 *
 * ## 为什么记录 G2 使用次数
 *
 * 不是为了抓人。锁本来就拦不住（学员完全可以另开网页版问），
 * 记录的意义是让验收单**如实呈现**：老队员看到"这段是生成的"，
 * 就知道该往哪个方向提问。没有这条，前面的闸门都只是形式。
 */
import { dirname, join } from 'node:path'

import type { TrainingTask } from './training.ts'
import type { QuizSummary } from './training-quiz.ts'

/* ---------- 工作目录 ---------- */

/** 工作目录根的解析结果。`from` 会进启动横幅，让人知道这个路径是怎么来的。 */
export type WorkspaceResolution = { root: string; from: string }

/** 目录名固定，只有父目录随解析链变。 */
const WORKSPACE_DIR = 'rcs-training'

/**
 * 解析学员工作目录的根。
 *
 * 与 `paths.ts` 同一套路数：**逐级解析、每一级都说得出来源**。
 *
 *   1. 插件配置（profile patch 里显式设的）
 *   2. 环境变量 `RCS_TRAINING_HOME` —— 显式意图优先于推断，
 *      也是「我这台机器 D 盘满了」的逃生口
 *   3. 与 dsh4rcs 仓库同级的 `../rcs-training`（默认）
 *   4. 主目录兜底 —— 只在推不出仓库位置时（如 tgz 装到 profile）
 *
 * **本函数刻意是纯函数，`repoRoot` 由调用方传入。**
 * 不在这里自己调 `resolveRepoRoot()`：本文件会被打进
 * `dsh-rcs-train/lib/index.js`，那时 `import.meta.url` 指向的是产物位置，
 * tgz 布局下推出来的是 profile 根、校验不过，于是静默退回主目录 ——
 * 恰好是这次要改掉的行为，而且只在新生的机器上发生。
 */
export function resolveWorkspaceRoot(
  options: {
    explicit?: string
    env?: Record<string, string | undefined>
    /** dsh4rcs 仓库根。由调用方解析后传入；推不出来就不传。 */
    repoRoot?: string
    home?: string
  } = {},
): WorkspaceResolution {
  const explicit = options.explicit?.trim()
  if (explicit) return { root: explicit, from: '插件配置' }

  const fromEnv = options.env?.['RCS_TRAINING_HOME']?.trim()
  if (fromEnv) return { root: fromEnv, from: '环境变量 RCS_TRAINING_HOME' }

  if (options.repoRoot) {
    return {
      root: join(dirname(options.repoRoot), WORKSPACE_DIR),
      from: '与 dsh4rcs 仓库同级',
    }
  }

  if (options.home) {
    return { root: join(options.home, WORKSPACE_DIR), from: '主目录兜底（推不出仓库位置）' }
  }

  return { root: WORKSPACE_DIR, from: '当前目录兜底（既无仓库位置也无主目录）' }
}

/** 某个任务的工作目录。root 必须显式给 —— 默认值会把解析链绕过去。 */
export function taskWorkspace(taskId: string, root: string): string {
  return join(root, taskId)
}

/* ---------- 进度记录 ---------- */

export type TaskProgress = {
  taskId: string
  /** 首次领到基线的时间（ISO），null 表示还没开始。 */
  scaffoldedAt: string | null
  /** 跑过几次验收。用于"先交一次"那道闸门。 */
  reviews: number
  /** 用过几次 G2 完整生成。验收单要如实呈现。 */
  generated: number
  /** 完成时间。由老队员确认后写入 —— **工具不自动判定"学会了"**。 */
  completedAt: string | null
}

export type Progress = {
  version: 1
  /** 学员标识，本机自填，不做校验 —— 这不是账号系统。 */
  student: string
  tasks: Record<string, TaskProgress>
}

export function emptyProgress(student = ''): Progress {
  return { version: 1, student, tasks: {} }
}

export function emptyTaskProgress(taskId: string): TaskProgress {
  return { taskId, scaffoldedAt: null, reviews: 0, generated: 0, completedAt: null }
}

/**
 * 读一条任务进度，没有就返回空记录。
 * 刻意不返回 undefined —— 调用方少一处判空，也少一处忘记判空。
 */
export function taskProgressOf(p: Progress, taskId: string): TaskProgress {
  return p.tasks[taskId] ?? emptyTaskProgress(taskId)
}

/** 已完成的任务 id 列表，喂给 nextTask / unlockedTasks。 */
export function completedTaskIds(p: Progress): string[] {
  return Object.values(p.tasks)
    .filter((t) => t.completedAt !== null)
    .map((t) => t.taskId)
}

/** 不可变地更新一条任务进度。 */
export function withTaskProgress(
  p: Progress,
  taskId: string,
  patch: Partial<Omit<TaskProgress, 'taskId'>>,
): Progress {
  const cur = taskProgressOf(p, taskId)
  return {
    ...p,
    tasks: { ...p.tasks, [taskId]: { ...cur, ...patch, taskId } },
  }
}

/**
 * 从磁盘读到的东西可能是任何形状（手改坏了、版本旧了）。
 * 校验失败就当作空进度重新开始 —— 进度丢了只是重跑一次验收，
 * 而拿着一份半坏的记录去判断"这人做到哪了"会误导老队员。
 */
export function parseProgress(raw: unknown): Progress {
  if (typeof raw !== 'object' || raw === null) return emptyProgress()
  const p = raw as Partial<Progress>
  if (p.version !== 1 || typeof p.tasks !== 'object' || p.tasks === null) {
    return emptyProgress(typeof p.student === 'string' ? p.student : '')
  }

  const tasks: Record<string, TaskProgress> = {}
  for (const [id, t] of Object.entries(p.tasks)) {
    const v = t as Partial<TaskProgress>
    tasks[id] = {
      taskId: id,
      scaffoldedAt: typeof v.scaffoldedAt === 'string' ? v.scaffoldedAt : null,
      reviews: typeof v.reviews === 'number' && v.reviews >= 0 ? v.reviews : 0,
      generated: typeof v.generated === 'number' && v.generated >= 0 ? v.generated : 0,
      completedAt: typeof v.completedAt === 'string' ? v.completedAt : null,
    }
  }

  return { version: 1, student: typeof p.student === 'string' ? p.student : '', tasks }
}

/* ---------- 验收单 ---------- */

export type TestOutcome = {
  passed: number
  failed: number
  failures: string[]
  /** 无法开始时的原因（工具链缺失、静态库平台不符等）。 */
  blocked?: string
}

export type LintOutcome = {
  errors: number
  warnings: number
  findings: string[]
}

export type ReviewReport = {
  task: TrainingTask
  student: string
  /** pc-test 任务才有。 */
  tests?: TestOutcome
  lint?: LintOutcome
  /** 用过几次 G2。 */
  generated: number
  reviews: number
  /** 改动小测的汇总。不给就不出这一段（例如纯逻辑测试）。 */
  quiz?: QuizSummary
}

/**
 * 改动小测那几行。
 *
 * 回答原文刻意不上验收单：验收单是工具结果，会进对话 —— 原文进了对话，
 * 模型就看得到，学员也能对着改口。原文走 train:export 交给老队员。
 */
function renderQuiz(q: QuizSummary): string[] {
  if (!q.enabled && q.rounds === 0) {
    return ['改动小测：未开启 —— 用 npm run dsh:start:training 启动才会出题']
  }
  const L: string[] = []
  L.push(
    `改动小测：答了 ${q.rounds} 轮 / ${q.questions} 题` +
      (q.blank > 0 ? `（${q.blank} 题空着）` : '') +
      (q.followUps > 0 ? `，学员追问 ${q.followUps} 次` : '') +
      (q.enabled ? '' : '；这次不是用培训模式启动的，不会再出新题'),
  )
  L.push(
    q.agentEdits > 0
      ? `Agent 改代码：${q.agentEdits} 次，涉及 ${q.agentFiles.join('、')}`
      : 'Agent 改代码：没观测到',
  )
  L.push(
    '  （只看得到 dsh 的 write / edit / str_replace_editor；Agent 用 bash 写的、' +
      '从网页复制来的都看不到 —— 次数少不代表是自己写的）',
  )
  if (q.pending.length > 0) {
    L.push('还没答题的改动：')
    for (const c of q.pending) L.push(`  · ${c.file}（+${c.added} / −${c.removed}）`)
    if (q.enabled) L.push('  → 先调用 rcs_train_quiz 就这些改动补答，再重新生成这张验收单')
  }
  L.push('回答原文不在这张单上，培训结束后用 npm run train:export 导出给老队员')
  return L
}

/**
 * 渲染给**人**看的验收单。
 *
 * 刻意不给"通过/不通过"的总判定。知识体系原文写的是
 * 「老队员验收**+提问**」—— 提问那一半机器做不了，也不该假装能做。
 * 工具只把机械部分（测试过没过、规范干不干净、用没用过生成）摆出来，
 * 把老队员的时间省下来留给提问。
 */
export function renderReview(r: ReviewReport): string {
  const L: string[] = []
  const t = r.task

  L.push(`任务：${t.id}  ${t.title}`)
  L.push(`提交人：${r.student || '（未填）'}`)
  L.push(`验收方式：${t.kind === 'pc-test' ? 'PC 单元测试（可自动判定）' : '上板验证（需当面确认）'}`)
  L.push('')

  // ---- 测试 ----
  if (t.kind === 'pc-test') {
    if (r.tests === undefined) {
      L.push('测试：未运行')
    } else if (r.tests.blocked !== undefined) {
      L.push(`测试：**无法运行** —— ${r.tests.blocked}`)
    } else {
      const total = r.tests.passed + r.tests.failed
      L.push(`测试：${r.tests.passed}/${total} 通过`)
      for (const f of r.tests.failures) L.push(`  ✗ ${f}`)
    }
  } else {
    L.push('测试：本任务无 PC 测试（外设任务必须上板看现象）')
  }

  // ---- 规范 ----
  if (r.lint === undefined) {
    L.push('规范：未检查')
  } else if (r.lint.errors === 0 && r.lint.warnings === 0) {
    L.push('规范：干净')
  } else {
    L.push(`规范：${r.lint.errors} 个错误 / ${r.lint.warnings} 个警告`)
    for (const f of r.lint.findings) L.push(`  · ${f}`)
  }

  // ---- 生成记录 ----
  //
  // `generated` 目前**没有任何写入方** —— 计数它的 `rcs_train_generate` 还没实现。
  // 所以 0 不代表「学员自己补的」，只代表「没人记过」。早先这里直接写
  // 「生成档位：G1（自己补的）」，那是拿一个从未被更新的计数器冒充结论，
  // 老队员会据此少问几句 —— 正是本仓库「假绿比红更危险」要防的。
  L.push(
    r.generated === 0
      ? '生成档位：**无法判定** —— 本版没有接入生成工具，这一栏不构成「学员自己写的」的证据'
      : `生成档位：**G2 使用过 ${r.generated} 次** —— 请重点核对学员是否理解每一行`,
  )
  L.push(`验收次数：第 ${r.reviews} 次`)
  if (r.quiz !== undefined) L.push(...renderQuiz(r.quiz))
  L.push('')

  // ---- 要当面确认的现象 ----
  if (t.accept.observe.length > 0) {
    L.push('需当面确认：')
    for (const o of t.accept.observe) L.push(`  □ ${o}`)
    L.push('')
  }

  // ---- 建议追问 ----
  // 题目全部来自课程表，**不是现编的**。
  // 让模型编嵌入式 C 题会产出"看起来合理其实是错的"标准答案，
  // 把错误知识以权威形式教给新生，比不提问糟糕得多。
  const questions = t.accept.observe.filter((o) => o.startsWith('能'))
  if (questions.length > 0) {
    L.push('建议追问（取自课程表，非现编）：')
    for (const q of questions) L.push(`  - ${q.replace(/^能/, '请')}`)
    L.push('')
  }

  L.push('本单只列机械判定结果。是否掌握，由验收人提问后决定。')

  return L.join('\n')
}
