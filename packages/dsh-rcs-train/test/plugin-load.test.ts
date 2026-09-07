/**
 * 培训插件的加载与端到端测试 —— 不启动 dsh、不碰真实固件仓库。
 *
 * 桩 ctx 跑 `apply`，用**临时目录**当课程表、工作目录和固件仓库，
 * 走完「领任务 → 发基线 → 出验收单」整条链。
 *
 * 重点验的是那条**安全性质**：裁剪失败时必须拒绝发放。
 * 挖不干净就等于把答案发给学员，而且没人会举报自己拿到了答案。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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

let mod: PluginModule
let tools: CapturedTool[] = []
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
  const ctx = {
    tools: { register: (t: CapturedTool) => tools.push(t) },
    effect: (fn: () => unknown) => fn(),
  }
  // 让固件解析走临时目录
  process.env['RCS_CODE_ROOT'] = fwRoot
  mod.apply(ctx, { curriculum: curriculumPath, workspaceRoot: wsRoot, student: '小测' })
})

afterEach(() => {
  delete process.env['RCS_CODE_ROOT']
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!hasBundle)('培训插件加载', () => {
  it('注册了三个工具', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
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

  it('inject 只要 tools', () => {
    expect(mod.inject).toEqual(['tools'])
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
