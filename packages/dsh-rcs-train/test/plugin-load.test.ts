/**
 * 培训插件的加载与端到端测试 —— 不启动 dsh、不碰真实固件仓库。
 *
 * 桩 ctx 跑 `apply`，用**临时目录**当课程表、工作目录和固件仓库，
 * 走完「领任务 → 发基线 → 改动小测 → 出验收单」整条链。
 *
 * 重点验两条性质：
 *   1. 裁剪失败时必须拒绝发放。挖不干净就等于把答案发给学员，而且没人会举报自己拿到了答案。
 *   2. 改动小测只在培训模式下记录；回答只落盘、不回传对话。模式由 guard 经 ctx.rcs
 *      告诉本插件，桩里用一个假的 watchGuardMode 模拟；宿主的钩子由桩收下后手动触发。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = join(import.meta.dirname, '..', '..', '..')
const BUNDLE = join(REPO, 'packages', 'dsh-rcs-train', 'lib', 'index.js')
const hasBundle = existsSync(BUNDLE)

interface CapturedTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: unknown; render(a: unknown, v: unknown): { type: string; text?: string }[] }
  execute(args: unknown, exec: unknown): Promise<unknown>
  presentCall?(args: unknown): unknown
  presentResult?(args: unknown, result: unknown): unknown
}

interface PluginModule {
  name: string
  inject: string[]
  Config: (config?: unknown) => unknown
  apply(ctx: unknown, config: unknown): void
}

type Listener = (...args: unknown[]) => unknown

let mod: PluginModule
let tools: CapturedTool[] = []
let listeners = new Map<string, Listener[]>()
let setMode: (mode: string | undefined) => void = () => {}
let asked: unknown[] = []
let reply: ((request: unknown) => Promise<unknown>) | undefined
let root = ''
let fwRoot = ''
let wsRoot = ''
let curriculumPath = ''

const exec = { signal: new AbortController().signal }
const tool = (n: string): CapturedTool | undefined => tools.find((t) => t.name === n)

/** 一份完整实现，其中 add / peek 会被挖空。 */
const BASELINE = `
#include "demo.h"

rcs_err_t demo_init(demo_t *d)
{
    d->n = 0;
    return RCS_OK;
}

int demo_add(demo_t *d, int v)
{
    d->n += v;
    return d->n;
}

bool demo_peek(const demo_t *d)
{
    return d->n > 0;
}
`

function seed(): void {
  root = mkdtempSync(join(tmpdir(), 'rcs-train-'))
  fwRoot = join(root, 'RCS_code')
  wsRoot = join(root, 'ws')

  // 固件仓库：放一份完整实现和一个测试文件
  mkdirSync(join(fwRoot, 'tpl', 'src'), { recursive: true })
  writeFileSync(join(fwRoot, 'tpl', 'src', 'demo.c'), BASELINE, 'utf8')
  writeFileSync(join(fwRoot, 'tpl', 'src', 'demo_test.cpp'), '// tests here\n', 'utf8')
  writeFileSync(join(fwRoot, 'tpl', 'src', 'demo.h'), '#pragma once\n', 'utf8')

  // scaffold 会为 pc-test 任务生成 CMakeLists，里面指向 F407 模板下的 gtest 库目录
  mkdirSync(join(fwRoot, 'template', 'RCS_Template_F407', 'RCS', 'RCS_Support', 'test', 'lib'), {
    recursive: true,
  })

  // 课程表
  curriculumPath = join(root, 'curriculum.json')
  writeFileSync(
    curriculumPath,
    JSON.stringify({
      season: '2027',
      tasks: [
        {
          id: 'demo',
          title: '示例任务',
          stage: 'algorithm',
          kind: 'pc-test',
          requires: [],
          refs: ['某文档#某节'],
          baseline: 'tpl/src/demo.c',
          strip: ['demo_add', 'demo_peek'],
          testFile: 'tpl/src/demo_test.cpp',
          include: ['tpl/src/demo.h'],
          goals: ['补出 demo_add', '补出 demo_peek'],
          accept: { tests: ['Demo.*'], lint: ['embedded'], observe: [] },
        },
        {
          id: 'bad-strip',
          title: '故意写错 strip 的任务',
          stage: 'algorithm',
          kind: 'pc-test',
          requires: [],
          refs: ['某文档#某节'],
          baseline: 'tpl/src/demo.c',
          strip: ['demo_this_does_not_exist'],
          testFile: 'tpl/src/demo_test.cpp',
          include: [],
          goals: ['应当发不出来'],
          accept: { tests: ['X.*'], lint: [], observe: [] },
        },
      ],
    }),
    'utf8',
  )
}

beforeAll(async () => {
  if (!hasBundle) return
  mod = (await import(pathToFileURL(BUNDLE).href)) as unknown as PluginModule
})

beforeEach(() => {
  if (!hasBundle) return
  seed()
  tools = []
  listeners = new Map()
  asked = []
  reply = undefined

  // 假的 ctx.rcs：只有 guard 模式的订阅面。setMode 模拟 guard 写入模式。
  let mode: string | undefined
  let watcher: ((m: string | undefined) => void) | undefined
  const fakeRcs = {
    watchGuardMode(w: (m: string | undefined) => void) {
      watcher = w
      w(mode)
      return () => {
        watcher = undefined
      }
    },
  }
  setMode = (m) => {
    mode = m
    watcher?.(m)
  }

  // 假的问答框：记下弹了什么，按 reply 作答
  const userQuestions = {
    async ask(request: unknown) {
      asked.push(request)
      if (reply === undefined) throw new Error('测试没有配置回答')
      return reply(request)
    },
  }

  const ctx = {
    tools: { register: (t: CapturedTool) => tools.push(t) },
    effect: (fn: () => unknown) => fn(),
    on: (name: string, fn: Listener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn])
    },
    inject: (deps: string[], callback: (scoped: unknown) => void) => {
      if (deps.includes('rcs')) callback({ rcs: fakeRcs, effect: () => {} })
    },
    get: (name: string) => (name === 'userQuestions' ? userQuestions : undefined),
  }
  // 让固件解析走临时目录
  process.env['RCS_CODE_ROOT'] = fwRoot
  mod.apply(ctx, { curriculum: curriculumPath, workspaceRoot: wsRoot, student: '小测' })
})

afterEach(() => {
  delete process.env['RCS_CODE_ROOT']
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

/* ---------- 触发宿主钩子的小工具 ---------- */

const DOWNSTREAM = { kind: 'accept' }
/** Agent 加的一段真代码。 */
const TWICE = '\nint demo_twice(int v)\n{\n    return v * 2;\n}\n'

const srcFile = (): string => join(wsRoot, 'demo', 'demo.c')

function listener(name: string): Listener {
  const fn = listeners.get(name)?.[0]
  if (fn === undefined) throw new Error(`插件没有挂 ${name}`)
  return fn
}

const preExecute = (call: object): unknown =>
  listener('tools/pre-execute')(call, async () => ({ kind: 'allow' }))

const postExecute = (call: object, result: object = { isError: false }): unknown =>
  listener('tools/post-execute')(call, result, async () => DOWNSTREAM)

async function turnStopping(agent: object, turn: number): Promise<void> {
  await listener('agent/turn-stopping')({ agent, turn, signal: new AbortController().signal })
}

/** 模拟 Agent 用 edit 工具在学员的源文件末尾加一段：先过 pre-execute，写盘，再过 post-execute。 */
async function agentWrites(extra: string): Promise<unknown> {
  const call = { name: 'edit', arguments: { file_path: srcFile() } }
  await preExecute(call)
  writeFileSync(srcFile(), readFileSync(srcFile(), 'utf8') + extra, 'utf8')
  return postExecute(call)
}

function lineOf(text: string): number {
  return readFileSync(srcFile(), 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1
}

function ledger(): { file: string; tool: string }[] {
  const path = join(wsRoot, '.records', 'ledger.json')
  if (!existsSync(path)) return []
  return (JSON.parse(readFileSync(path, 'utf8')) as { edits: { file: string; tool: string }[] }).edits
}

function records(): { answers: unknown; agentEdits: { file: string }[]; student: string }[] {
  const dir = join(wsRoot, '.records', 'demo')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json') && n !== 'snapshot.json')
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')))
}

function fakeAgent(): { steered: unknown[]; steer(message: unknown): void } {
  const steered: unknown[] = []
  return { steered, steer: (message: unknown) => void steered.push(message) }
}

const quiz = (questions: unknown): Promise<unknown> =>
  tool('rcs_train_quiz')!.execute({ taskId: 'demo', questions }, exec)

describe.skipIf(!hasBundle)('培训插件加载', () => {
  it('注册了四个工具', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'rcs_train_quiz',
      'rcs_train_review',
      'rcs_train_scaffold',
      'rcs_train_task',
    ])
  })

  it('Config 三个字段都有默认值 —— 别人 clone 下来不用改配置', () => {
    const c = mod.Config({}) as Record<string, string>
    expect(c['curriculum']).toBe('')
    expect(c['workspaceRoot']).toBe('')
    expect(c['student']).toBe('')
  })

  it('inject 只要 tools —— rcs 与问答框都是可选的', () => {
    expect(mod.inject).toEqual(['tools'])
  })

  it('挂了改动小测要用的三个宿主钩子', () => {
    expect([...listeners.keys()].sort()).toEqual([
      'agent/turn-stopping',
      'tools/post-execute',
      'tools/pre-execute',
    ])
  })
})

describe.skipIf(!hasBundle)('rcs_train_task —— 领任务', () => {
  it('不传 id 时推荐下一个', async () => {
    const r = (await tool('rcs_train_task')!.execute({}, exec)) as { text: string }
    expect(r.text).toContain('示例任务')
    expect(r.text).toContain('你要加出来的功能')
  })

  it('列出队内资料，指向 rcs_kb_search', async () => {
    const r = (await tool('rcs_train_task')!.execute({ taskId: 'demo' }, exec)) as { text: string }
    expect(r.text).toContain('某文档#某节')
    expect(r.text).toContain('rcs_kb_search')
  })

  it('pc-test 任务列出 gtest 判据', async () => {
    const r = (await tool('rcs_train_task')!.execute({ taskId: 'demo' }, exec)) as { text: string }
    expect(r.text).toContain('Demo.*')
    expect(r.text).toContain('不用板子')
  })

  it('还没领基线时提示去领', async () => {
    const r = (await tool('rcs_train_task')!.execute({ taskId: 'demo' }, exec)) as { text: string }
    expect(r.text).toContain('还没领基线')
  })

  it('任务不存在时报错并列出可选项', async () => {
    await expect(tool('rcs_train_task')!.execute({ taskId: '不存在' }, exec)).rejects.toThrow(
      /可选/,
    )
  })
})

describe.skipIf(!hasBundle)('rcs_train_scaffold —— 发基线', () => {
  it('挖空指定函数后写到学员目录', async () => {
    const r = (await tool('rcs_train_scaffold')!.execute({ taskId: 'demo' }, exec)) as {
      workspace: string
      files: string[]
    }
    expect(existsSync(r.workspace)).toBe(true)

    const src = readFileSync(join(r.workspace, 'demo.c'), 'utf8')
    // 挖空的函数只剩 TODO
    expect(src).toContain('TODO(demo_add)')
    expect(src).toContain('TODO(demo_peek)')
    expect(src).not.toContain('d->n += v;')
    expect(src).not.toContain('return d->n > 0;')
    // 没点名的保持完整
    expect(src).toContain('d->n = 0;')
  })

  it('文件头横幅说明这是基线而非完整实现', async () => {
    const r = (await tool('rcs_train_scaffold')!.execute({ taskId: 'demo' }, exec)) as {
      workspace: string
    }
    const src = readFileSync(join(r.workspace, 'demo.c'), 'utf8')
    expect(src).toContain('dsh4rcs:training')
    expect(src).toContain('可以跑但功能不全')
    expect(src).toContain('补出 demo_add')
  })

  it('测试文件原样发出 —— 它就是"还差什么"的清单，不该挖空', async () => {
    const r = (await tool('rcs_train_scaffold')!.execute({ taskId: 'demo' }, exec)) as {
      files: string[]
    }
    expect(r.files.some((f) => f.endsWith('demo_test.cpp'))).toBe(true)
  })

  it('**裁剪失败时拒绝发放**，且不留下任何文件', async () => {
    await expect(
      tool('rcs_train_scaffold')!.execute({ taskId: 'bad-strip' }, exec),
    ).rejects.toThrow(/拒绝发放/)

    // 关键：目录不能被创建出来，半成品一个字节都不能落地
    expect(existsSync(join(wsRoot, 'bad-strip'))).toBe(false)
  })

  it('裁剪失败的报错要说清为什么这么严格', async () => {
    await expect(
      tool('rcs_train_scaffold')!.execute({ taskId: 'bad-strip' }, exec),
    ).rejects.toThrow(/把完整答案发给学员/)
  })

  it('目录已存在时默认拒绝覆盖 —— 不能抹掉学员写的代码', async () => {
    await tool('rcs_train_scaffold')!.execute({ taskId: 'demo' }, exec)
    await expect(tool('rcs_train_scaffold')!.execute({ taskId: 'demo' }, exec)).rejects.toThrow(
      /已存在/,
    )
  })

  it('传 force 才允许重发', async () => {
    await tool('rcs_train_scaffold')!.execute({ taskId: 'demo' }, exec)
    const r = (await tool('rcs_train_scaffold')!.execute(
      { taskId: 'demo', force: true },
      exec,
    )) as { workspace: string }
    expect(existsSync(r.workspace)).toBe(true)
  })

  it('发放后再领任务，会显示已发放的位置', async () => {
    await tool('rcs_train_scaffold')!.execute({ taskId: 'demo' }, exec)
    const r = (await tool('rcs_train_task')!.execute({ taskId: 'demo' }, exec)) as { text: string }
    expect(r.text).toContain('基线已于')
  })
})

describe.skipIf(!hasBundle)('rcs_train_review —— 验收单', () => {
  it('汇总测试与规范结果', async () => {
    const r = (await tool('rcs_train_review')!.execute(
      {
        taskId: 'demo',
        testsPassed: 6,
        testsFailed: 2,
        testFailures: ['Demo.Add', 'Demo.Peek'],
        lintErrors: 0,
        lintWarnings: 0,
      },
      exec,
    )) as { text: string }

    expect(r.text).toContain('6/8 通过')
    expect(r.text).toContain('Demo.Add')
    expect(r.text).toContain('规范：干净')
  })

  it('不给通过/不通过的总判定', async () => {
    const r = (await tool('rcs_train_review')!.execute(
      { taskId: 'demo', testsPassed: 8, testsFailed: 0 },
      exec,
    )) as { text: string }
    expect(r.text).toContain('由验收人提问后决定')
  })

  it('验收次数会累计', async () => {
    await tool('rcs_train_review')!.execute({ taskId: 'demo' }, exec)
    const r = (await tool('rcs_train_review')!.execute({ taskId: 'demo' }, exec)) as {
      text: string
    }
    expect(r.text).toContain('第 2 次')
  })

  it('没传测试结果时说未运行，不谎报 0 通过', async () => {
    const r = (await tool('rcs_train_review')!.execute({ taskId: 'demo' }, exec)) as {
      text: string
    }
    expect(r.text).toContain('测试：未运行')
  })
})

describe.skipIf(!hasBundle)('改动小测 —— 培训模式', () => {
  beforeEach(async () => {
    setMode('training')
    await tool('rcs_train_scaffold')!.execute({ taskId: 'demo' }, exec)
  })

  it('发基线时就留下第一份快照', () => {
    expect(existsSync(join(wsRoot, '.records', 'demo', 'snapshot.json'))).toBe(true)
  })

  it('post-execute 记下 Agent 改了哪个文件，宿主的决定原样交回', async () => {
    expect(await agentWrites(TWICE)).toBe(DOWNSTREAM)
    expect(ledger().map((e) => [e.file, e.tool])).toEqual([['demo.c', 'edit']])
  })

  it('相对路径按会话目录解析，与宿主 fs 工具同一条规则', async () => {
    writeFileSync(srcFile(), readFileSync(srcFile(), 'utf8') + TWICE, 'utf8')
    await postExecute({
      name: 'write',
      arguments: { file_path: 'demo.c' },
      agent: { session: { header: { cwd: join(wsRoot, 'demo') } } },
    })
    expect(ledger()).toHaveLength(1)
  })

  it('不记：工作目录外的文件、view、失败的调用、bash', async () => {
    await postExecute({ name: 'write', arguments: { file_path: join(root, 'elsewhere.c') } })
    await postExecute({ name: 'str_replace_editor', arguments: { command: 'view', path: srcFile() } })
    await postExecute({ name: 'edit', arguments: { file_path: srcFile() } }, { isError: true })
    await postExecute({ name: 'bash', arguments: { command: `echo x >> ${srcFile()}` } })
    expect(ledger()).toEqual([])
  })

  it('本轮结束前提醒一次出题，同一轮不重复，下一轮还没答就再提醒', async () => {
    await agentWrites(TWICE)
    const agent = fakeAgent()
    await turnStopping(agent, 1)
    await turnStopping(agent, 1)
    expect(agent.steered).toHaveLength(1)

    const message = agent.steered[0] as {
      role: string
      source: { kind: string; plugin: string }
      content: { text: string }[]
    }
    expect(message.role).toBe('user')
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'rcs-train' })
    expect(message.content[0]?.text).toContain('rcs_train_quiz')
    expect(message.content[0]?.text).toContain('demo.c')
    expect(message.content[0]?.text).toContain('不要附答案')

    await turnStopping(agent, 2)
    expect(agent.steered).toHaveLength(2)
  })

  it('只改了注释：不提醒，直接翻篇', async () => {
    await agentWrites('\n// 这里以后再补\n')
    const agent = fakeAgent()
    await turnStopping(agent, 1)
    expect(agent.steered).toHaveLength(0)
    expect(ledger()).toEqual([])
  })

  it('题目钉不到改动上：不弹框，并告诉模型哪些行可以出题', async () => {
    await agentWrites(TWICE)
    await expect(quiz([{ kind: 'why', file: 'demo.c', line: 1 }])).rejects.toThrow(
      /没被这次改动碰过[\s\S]*可以出题的位置/,
    )
    expect(asked).toHaveLength(0)
  })

  it('学员作答后：回答原样存盘，结果里不带原文，改动翻篇', async () => {
    await agentWrites(TWICE)
    reply = async () => ({ answers: [{ id: 'q1', selected: [], custom: '乘 2 就是左移一位' }] })
    const r = (await quiz([{ kind: 'why', file: 'demo.c', line: lineOf('return v * 2;') }])) as {
      recorded: number
      text: string
    }
    expect(r.recorded).toBe(1)
    expect(r.text).not.toContain('左移')

    // 问答框里有锚点代码，并明说回答会给老队员看
    const request = asked[0] as { questions: { question: string; detail: string }[] }
    expect(request.questions[0]?.question).toContain('demo.c 第')
    expect(request.questions[0]?.detail).toContain('return v * 2;')
    expect(request.questions[0]?.detail).toContain('老队员')

    const [saved] = records()
    expect(saved?.answers).toEqual([{ id: 'q1', text: '乘 2 就是左移一位' }])
    expect(saved?.agentEdits.map((e) => e.file)).toEqual(['demo.c'])
    expect(saved?.student).toBe('小测')

    // 翻篇：台账清空，不再提醒，也没有可出题的改动
    expect(ledger()).toEqual([])
    const agent = fakeAgent()
    await turnStopping(agent, 3)
    expect(agent.steered).toHaveLength(0)
    const again = (await quiz([{ kind: 'why', file: 'demo.c', line: 1 }])) as { text: string }
    expect(again.text).toContain('没有需要出题的改动')
  })

  it('学员关掉问答框：不写记录，改动仍记为待答', async () => {
    await agentWrites(TWICE)
    reply = async () => {
      throw new Error('ASK_ABORTED')
    }
    await expect(
      quiz([{ kind: 'why', file: 'demo.c', line: lineOf('return v * 2;') }]),
    ).rejects.toThrow(/没有作答/)
    expect(records()).toEqual([])
    expect(ledger()).toHaveLength(1)
  })

  it('验收单兜底：列出没答题的改动，并单独提醒模型先补答', async () => {
    await agentWrites(TWICE)
    const deferred: unknown[] = []
    const r = (await tool('rcs_train_review')!.execute(
      { taskId: 'demo' },
      { ...exec, deferContext: (m: unknown) => deferred.push(m) },
    )) as { text: string }
    expect(r.text).toContain('还没答题的改动')
    expect(r.text).toContain('demo.c')
    expect(r.text).toContain('Agent 改代码：1 次')
    expect(deferred).toHaveLength(1)
    expect(JSON.stringify(deferred[0])).toContain('rcs_train_quiz')
  })

  it('领任务时告诉学员有改动小测、回答会给老队员看', async () => {
    const r = (await tool('rcs_train_task')!.execute({ taskId: 'demo' }, exec)) as { text: string }
    expect(r.text).toContain('改动小测')
    expect(r.text).toContain('老队员')
  })
})

describe.skipIf(!hasBundle)('改动小测 —— 不是培训模式', () => {
  for (const mode of ['dev', undefined]) {
    describe(`guard 模式：${mode ?? '（没装 guard）'}`, () => {
      beforeEach(async () => {
        setMode(mode)
        await tool('rcs_train_scaffold')!.execute({ taskId: 'demo' }, exec)
      })

      it('不记账、不提醒、不出题', async () => {
        await agentWrites(TWICE)
        const agent = fakeAgent()
        await turnStopping(agent, 1)
        expect(ledger()).toEqual([])
        expect(agent.steered).toHaveLength(0)
        await expect(quiz([{ kind: 'why', file: 'demo.c', line: 1 }])).rejects.toThrow(
          /只在培训模式/,
        )
      })

      it('验收单写明没开', async () => {
        const r = (await tool('rcs_train_review')!.execute({ taskId: 'demo' }, exec)) as {
          text: string
        }
        expect(r.text).toContain('改动小测：未开启')
      })
    })
  }
})

describe.skipIf(!hasBundle)('课程表坏了要拒绝加载', () => {
  it('课程表不合法时报错并列出全部问题', async () => {
    writeFileSync(curriculumPath, JSON.stringify({ season: '', tasks: [{ id: '' }] }), 'utf8')
    await expect(tool('rcs_train_task')!.execute({}, exec)).rejects.toThrow(/已拒绝加载/)
  })

  it('课程表不存在时给出可操作的指引', async () => {
    rmSync(curriculumPath)
    await expect(tool('rcs_train_task')!.execute({}, exec)).rejects.toThrow(/curriculum\.json/)
  })
})
