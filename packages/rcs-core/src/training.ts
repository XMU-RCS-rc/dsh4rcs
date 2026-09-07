/**
 * 培训课程的数据契约与校验 —— 纯逻辑，不碰文件系统与 dsh。
 *
 * ## 任务形态：给能跑的模板，要求改出更复杂的功能
 *
 * 不是「挖空 + 填空」。挖空的做法对完全没写过嵌入式的新生太陡：
 * 面对一个满是 TODO 的空文件，他们连从哪下手都不知道。
 *
 * 这里的形态是：
 *   1. 发给学员一份**大致能用的基线实现**（baseline），烧进去就有现象
 *   2. 同时发一组**进阶测试**：基线能过其中一部分，剩下的红着
 *   3. 学员的任务是扩展基线，直到红的也变绿
 *
 * 好处是每一步都有正反馈：一开始就能跑，改坏了立刻知道，
 * 而"还差哪些功能"由测试清单明确列出，不需要猜老队员想要什么。
 *
 * ## 为什么课程表是数据不是代码
 *
 * 老队员加任务只改 JSON，不动 TypeScript —— 与 config/team.json、
 * config/bus-map.json 一致。课程会随赛季调整，写死在代码里每次都要重新构建。
 */

/** 任务所属阶段。对应队内《软件知识体系、百事通》的培训分层。 */
export type TrainingStage =
  | 'keil-basics' // 基本常识 + Keil/CubeMX 使用
  | 'peripheral' // 外设：GPIO/UART/CAN/TIM/PWM
  | 'algorithm' // 算法：PID、滤波、状态机
  | 'kinematics' // 运动学：底盘、机械臂
  | 'robocon' // ROBOCON 特色

/**
 * 任务的验收方式。
 *
 *   pc-test    纯算法任务 —— 能在电脑上跑 gtest 判定，**不需要板子**，可自动验收
 *   on-target  外设任务 —— 必须烧进板子看现象，只能自动查规范，功能由老队员当面验收
 *
 * 分开是因为两者的验收单长得完全不同：前者能给出"8/8 通过"这种硬结论，
 * 后者只能给出"规范干净，现象请当面确认"。混在一起会让人以为外设任务也被自动验过了。
 */
export type TrainingKind = 'pc-test' | 'on-target'

/** 一条验收判据。 */
export type TrainingAcceptance = {
  /**
   * 必须变绿的 gtest 用例名（支持 gtest 的 `Suite.*` 通配）。
   * 基线**故意过不了**这些 —— 它们就是"还差的功能"清单。
   * on-target 任务没有 PC 测试，这里为空数组。
   */
  tests: string[]
  /** 必须干净的检查项。'embedded' → rcs_lint_embedded，'layer' → rcs_lint_layer。 */
  lint: ('embedded' | 'layer')[]
  /**
   * 需要老队员当面确认的现象。**on-target 任务必填** ——
   * 没有它，验收单就只剩"规范干净"，而那说明不了功能对不对。
   */
  observe: string[]
}

/** 一个培训任务。 */
export type TrainingTask = {
  /** 任务 id，全表唯一，也是 scaffold 目录名。 */
  id: string
  title: string
  stage: TrainingStage
  /** 验收方式，决定验收单的形态。 */
  kind: TrainingKind
  /** 前置任务 id。空数组表示可以直接开始。 */
  requires: string[]
  /**
   * 队内资料引用，形如 `文档名#小节`。
   * 由 rcs_train_task 交给 rcs_kb_search 解析成具体位置。
   */
  refs: string[]
  /**
   * 完整实现相对固件仓库根的路径。
   *
   * **仓库里存的永远是完整版**（固件要用它），发给学员前由 scaffold 按 `strip`
   * 动态裁剪成基线。这样只有一份真相，不会出现"改了完整版忘了同步裁剪版"。
   */
  baseline: string
  /**
   * 发给学员时要挖空的函数名。空数组表示原样发出。
   * 裁剪掉的部分就是这次任务要补的功能，应当与 goals 对得上。
   */
  strip: string[]
  /** 测试代码路径。on-target 任务没有 PC 测试，写空字符串。 */
  testFile: string
  /**
   * 需要一并原样发出的文件（头文件等），相对固件仓库根。
   *
   * 少了它，学员拿到 .c 和测试却缺头文件，**根本编不过** ——
   * 而报错会指向一个跟任务无关的方向，非常劝退。
   */
  include: string[]
  /** 这个任务要求学员**加出来**的功能，人话描述，进验收单。 */
  goals: string[]
  accept: TrainingAcceptance
}

export type Curriculum = {
  season: string
  tasks: TrainingTask[]
}

/** 校验结果。失败时把**所有**问题一次列全，不要改一个报一个。 */
export type CurriculumCheck =
  | { ok: true; curriculum: Curriculum }
  | { ok: false; problems: string[] }

const STAGES: readonly TrainingStage[] = [
  'keil-basics',
  'peripheral',
  'algorithm',
  'kinematics',
  'robocon',
]

/**
 * 校验课程表。
 *
 * 刻意检查得细：课程表是老队员手写的 JSON，写错一个 id
 * 表现为"这个任务永远取不出来"，而不是报错 —— 那种沉默失败最费时间。
 */
export function checkCurriculum(raw: unknown): CurriculumCheck {
  const problems: string[] = []

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, problems: ['课程表不是一个对象'] }
  }
  const c = raw as Partial<Curriculum>

  if (typeof c.season !== 'string' || c.season.length === 0) {
    problems.push('缺少 season（赛季），如 "2027"')
  }
  if (!Array.isArray(c.tasks)) {
    return { ok: false, problems: [...problems, '缺少 tasks 数组'] }
  }

  const ids = new Set<string>()
  for (const [i, t] of c.tasks.entries()) {
    const at = `tasks[${i}]`

    if (typeof t?.id !== 'string' || t.id.length === 0) {
      problems.push(`${at} 缺少 id`)
      continue
    }
    if (ids.has(t.id)) {
      problems.push(`${at} id 重复：${t.id}`)
    }
    ids.add(t.id)

    if (typeof t.title !== 'string' || t.title.length === 0) {
      problems.push(`${t.id} 缺少 title`)
    }
    if (!STAGES.includes(t.stage)) {
      problems.push(`${t.id} 的 stage 非法：${String(t.stage)}（应为 ${STAGES.join(' / ')}）`)
    }
    if (!Array.isArray(t.requires)) {
      problems.push(`${t.id} 的 requires 必须是数组（无前置就写 []）`)
    }
    if (!Array.isArray(t.refs) || t.refs.length === 0) {
      // 没有队内资料引用的任务，等于让新生去网上瞎搜 —— 那正是本套工具要避免的
      problems.push(`${t.id} 至少要有一条 refs（指向队内资料），否则学员无处可查`)
    }
    if (typeof t.baseline !== 'string' || t.baseline.length === 0) {
      problems.push(`${t.id} 缺少 baseline（能跑的模板路径）`)
    }
    if (!Array.isArray(t.strip)) {
      problems.push(`${t.id} 的 strip 必须是数组（原样发出就写 []）`)
    } else if (t.kind === 'pc-test' && t.strip.length === 0) {
      // pc-test 任务不挖空，等于把答案直接发给学员
      problems.push(`${t.id} 是 pc-test 任务，strip 不能为空 —— 否则等于把完整答案发出去`)
    }
    if (!Array.isArray(t.include)) {
      problems.push(`${t.id} 的 include 必须是数组（不需要额外文件就写 []）`)
    }
    if (typeof t.testFile !== 'string') {
      problems.push(`${t.id} 的 testFile 必须是字符串（on-target 任务没有 PC 测试就写 ""）`)
    } else if (t.kind === 'pc-test' && t.testFile.length === 0) {
      problems.push(`${t.id} 是 pc-test 任务，必须给出 testFile`)
    }
    if (!Array.isArray(t.goals) || t.goals.length === 0) {
      problems.push(`${t.id} 缺少 goals —— 学员必须知道"要加出什么功能"`)
    }
    if (t.kind !== 'pc-test' && t.kind !== 'on-target') {
      problems.push(`${t.id} 的 kind 非法：${String(t.kind)}（应为 pc-test 或 on-target）`)
    }
    if (!Array.isArray(t.accept?.tests)) {
      problems.push(`${t.id} 的 accept.tests 必须是数组`)
    } else if (t.kind === 'pc-test' && t.accept.tests.length === 0) {
      problems.push(`${t.id} 是 pc-test 任务，accept.tests 不能为空 —— 没有判据就没法自动验收`)
    }
    if (!Array.isArray(t.accept?.lint)) {
      problems.push(`${t.id} 的 accept.lint 必须是数组（不检查就写 []）`)
    }
    if (!Array.isArray(t.accept?.observe)) {
      problems.push(`${t.id} 的 accept.observe 必须是数组`)
    } else if (t.kind === 'on-target' && t.accept.observe.length === 0) {
      // 上板任务只查规范等于什么都没查 —— 必须写清楚要看什么现象
      problems.push(
        `${t.id} 是 on-target 任务，accept.observe 不能为空 —— ` +
          `否则验收单只剩"规范干净"，说明不了功能对不对`,
      )
    }
  }

  // 前置任务必须存在，且不能自引用
  for (const t of c.tasks) {
    if (typeof t?.id !== 'string' || !Array.isArray(t.requires)) continue
    for (const r of t.requires) {
      if (r === t.id) {
        problems.push(`${t.id} 的 requires 包含自己`)
      } else if (!ids.has(r)) {
        problems.push(`${t.id} 的前置任务不存在：${r}`)
      }
    }
  }

  const cycle = findCycle(c.tasks as TrainingTask[])
  if (cycle !== undefined) {
    problems.push(`前置关系成环：${cycle.join(' → ')}`)
  }

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, curriculum: c as Curriculum }
}

/**
 * 找出 requires 里的环。
 * 成环会让 unlockedTasks 永远返回不了这些任务，而且不会报错 —— 必须提前挡。
 */
function findCycle(tasks: TrainingTask[]): string[] | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const state = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []

  function walk(id: string): string[] | undefined {
    const s = state.get(id)
    if (s === 'done') return undefined
    if (s === 'visiting') return [...path.slice(path.indexOf(id)), id]

    state.set(id, 'visiting')
    path.push(id)

    for (const r of byId.get(id)?.requires ?? []) {
      if (!byId.has(r)) continue
      const found = walk(r)
      if (found !== undefined) return found
    }

    path.pop()
    state.set(id, 'done')
    return undefined
  }

  for (const t of tasks) {
    const found = walk(t.id)
    if (found !== undefined) return found
  }
  return undefined
}

/** 按 id 取任务。 */
export function findTask(c: Curriculum, id: string): TrainingTask | undefined {
  return c.tasks.find((t) => t.id === id)
}

/**
 * 给定已完成的任务集合，算出现在可以开始哪些。
 * @param done 已完成的任务 id
 */
export function unlockedTasks(c: Curriculum, done: readonly string[]): TrainingTask[] {
  const finished = new Set(done)
  return c.tasks.filter((t) => !finished.has(t.id) && t.requires.every((r) => finished.has(r)))
}

/**
 * 建议下一个任务：优先取阶段靠前、前置已满足的。
 * 返回 undefined 表示全做完了，或者被前置卡住（后者说明课程表有问题）。
 */
export function nextTask(c: Curriculum, done: readonly string[]): TrainingTask | undefined {
  const open = unlockedTasks(c, done)
  if (open.length === 0) return undefined
  return open.sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage))[0]
}
