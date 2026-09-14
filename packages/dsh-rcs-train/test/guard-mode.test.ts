/**
 * guard → core → train 的模式传递 —— 用**真实 cordis**，三个真插件装进一个 Context。
 *
 * 改动小测跟着 guard 的模式开关，模式经 dsh-rcs-core 的 ctx.rcs 中转。
 * 这条链的每一环都发生在 cordis 里：`ctx.inject(['rcs'], …)` 什么时候回调、
 * 服务经 ctx 访问时状态还在不在、插件加载顺序反过来行不行 —— 桩 ctx 测不出这些。
 *
 * `tools` 服务照 guard 测试的做法用一个最小 Service 桩：只收下注册的工具。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'

const REPO = join(import.meta.dirname, '..', '..', '..')
const lib = (name: string): string => join(REPO, 'packages', name, 'lib', 'index.js')
const TEAM = join(REPO, 'config', 'team.json')
const ready =
  ['dsh-rcs-core', 'dsh-rcs-guard', 'dsh-rcs-train'].every((n) => existsSync(lib(n))) &&
  existsSync(TEAM)

interface RegisteredTool {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
}

let registered: RegisteredTool[] = []

/** 最小 tools 服务：只收下注册的工具。 */
class FakeTools extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
  register(tool: RegisteredTool): () => void {
    registered.push(tool)
    return () => {}
  }
  guard(): () => void {
    return () => {}
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300))
const load = (name: string): Promise<unknown> => import(pathToFileURL(lib(name)).href)

let workspace = ''
let logs: string[] = []

beforeEach(() => {
  registered = []
  workspace = mkdtempSync(join(tmpdir(), 'rcs-mode-'))
  logs = []
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(workspace, { recursive: true, force: true })
})

type Name = 'core' | 'guard' | 'train'

/** 按给定顺序一个个装插件，每装一个等它加载完 —— 这样顺序才真的有意义。 */
async function boot(mode: 'dev' | 'training', order: readonly Name[]): Promise<void> {
  const ctx = new Context()
  ctx.plugin(FakeTools)
  await settle()
  const configs: Record<Name, unknown> = {
    core: { teamConfig: TEAM },
    guard: { mode, extraL2: [] },
    train: { curriculum: '', workspaceRoot: workspace, student: '' },
  }
  const modules: Record<Name, string> = {
    core: 'dsh-rcs-core',
    guard: 'dsh-rcs-guard',
    train: 'dsh-rcs-train',
  }
  for (const name of order) {
    ctx.plugin((await load(modules[name])) as never, configs[name] as never)
    await settle()
  }
}

/** 试着出一题：关着时报「只在培训模式」，开着时走到下一步（空工作目录没有可出题的改动）。 */
function tryQuiz(): Promise<unknown> {
  const quiz = registered.find((t) => t.name === 'rcs_train_quiz')
  if (quiz === undefined) throw new Error('rcs_train_quiz 没有注册')
  return quiz.execute(
    { questions: [{ kind: 'why', file: 'a.c', line: 1 }] },
    { signal: new AbortController().signal },
  )
}

describe.skipIf(!ready)('改动小测跟着 guard 的模式（真实 cordis）', () => {
  it('training：开启，启动日志说清回答存哪、给谁看', async () => {
    await boot('training', ['core', 'guard', 'train'])
    expect(logs.some((l) => l.includes('[rcs-train] 改动小测已开启') && l.includes('老队员'))).toBe(
      true,
    )
    await expect(tryQuiz()).rejects.toThrow(/没有待答题的改动/)
  })

  it('train 先于 guard 加载也一样 —— 模式是订阅的，不是加载时读一次', async () => {
    await boot('training', ['core', 'train', 'guard'])
    await expect(tryQuiz()).rejects.toThrow(/没有待答题的改动/)
  })

  it('dev：关闭，启动日志也说关着', async () => {
    await boot('dev', ['core', 'guard', 'train'])
    expect(logs.some((l) => l.includes('[rcs-train] 改动小测：关闭'))).toBe(true)
    await expect(tryQuiz()).rejects.toThrow(/只在培训模式/)
  })

  it('没装 guard：按不是培训模式处理', async () => {
    await boot('training', ['core', 'train'])
    await expect(tryQuiz()).rejects.toThrow(/只在培训模式/)
  })

  it('没装 core：guard 的模式传不过来，同样不开', async () => {
    await boot('training', ['guard', 'train'])
    await expect(tryQuiz()).rejects.toThrow(/只在培训模式/)
  })
})
