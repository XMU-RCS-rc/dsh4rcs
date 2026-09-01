/**
 * 知识库插件的加载与端到端测试 —— 不启动 dsh、不联网。
 *
 * 桩 ctx 跑 `apply`，然后对一个**临时的假镜像**跑检索与状态工具。
 * 同步工具需要真凭证与网络，这里只验它在缺环境变量时能给出可操作的报错 ——
 * 这恰恰是最容易出问题、也最需要人看懂的那条路径。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = join(import.meta.dirname, '..', '..', '..')
const BUNDLE = join(REPO, 'packages', 'dsh-rcs-kb', 'lib', 'index.js')
const hasBundle = existsSync(BUNDLE)

interface CapturedTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: unknown
    render(args: unknown, value: unknown): { type: string; text?: string }[]
    presentationMeta?(args: unknown, value: unknown): unknown
  }
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
let cacheDir: string

const exec = { signal: new AbortController().signal }
const tool = (n: string): CapturedTool | undefined => tools.find((t) => t.name === n)

/** 造一个最小可用的假镜像。 */
function seedCache(dir: string): void {
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(
    join(dir, 'docs', 'd1.txt'),
    '中断服务函数内禁止调用 printf 与 malloc，改用 FromISR 变体。',
    'utf8',
  )
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      syncedAt: '2026-08-29T00:00:00.000Z',
      sources: [{ label: 'A02 电控组(通用)', token: 'fA' }],
      policy: { allowlistOnly: true, includeTypes: ['docx'], excludeTypes: ['file'], maxDepth: 6 },
      docs: {
        d1: {
          token: 'd1',
          name: 'RCSLIB代码规范',
          type: 'docx',
          path: 'A02 电控组(通用)/规范/RCSLIB代码规范',
          url: 'https://xmurcsrobot.feishu.cn/docx/d1',
          modifiedTime: '1000',
          bytes: 60,
        },
      },
      skippedByType: { file: 803 },
    }),
    'utf8',
  )
}

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'rcs-kbp-'))
  seedCache(cacheDir)
  if (!hasBundle) return
  tools = []
  const ctx = {
    tools: {
      register(def: CapturedTool) {
        tools.push(def)
        return () => {}
      },
    },
    effect(fn: () => () => void) {
      fn()
      return () => {}
    },
  }
  mod.apply(ctx, {
    teamConfig: join(REPO, 'config', 'team.json'),
    cacheDir,
    appSecretEnv: 'FEISHU_APP_SECRET_TEST_ABSENT',
  })
})

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true })
})

beforeAll(async () => {
  if (!hasBundle) return
  mod = (await import(pathToFileURL(BUNDLE).href)) as unknown as PluginModule
})

describe.skipIf(!hasBundle)('知识库插件可加载', () => {
  it('导出符合 cordis 插件契约', () => {
    expect(mod.name).toBe('rcs-kb')
    expect(mod.inject).toEqual(['tools'])
    expect(typeof mod.apply).toBe('function')
  })

  it('注册了三个工具', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(['rcs_kb_search', 'rcs_kb_status', 'rcs_kb_sync'])
  })

  it('Config 里只有环境变量的名字，没有密钥本身', () => {
    const c = mod.Config({}) as Record<string, unknown>
    expect(c['appSecretEnv']).toBe('FEISHU_APP_SECRET')
    expect(JSON.stringify(c)).not.toMatch(/secret["']?\s*:\s*["'][A-Za-z0-9]{20,}/)
  })

  it('检索工具的描述里写明它是离线的 —— 赛场能不能用是关键信息', () => {
    expect(tool('rcs_kb_search')!.description).toMatch(/离线|不联网/)
  })

  it('同步工具的描述里标明它联网且写盘', () => {
    expect(tool('rcs_kb_sync')!.description).toMatch(/联网/)
    expect(tool('rcs_kb_sync')!.description).toMatch(/赛场/)
  })
})

describe.skipIf(!hasBundle)('rcs_kb_search 端到端', () => {
  it('命中本地镜像并返回原文链接', async () => {
    const t = tool('rcs_kb_search')!
    const v = (await t.execute({ query: 'printf' }, exec)) as { hits: unknown[] }
    expect(v.hits.length).toBe(1)
    const text = t.output.render({}, v)[0]?.text ?? ''
    expect(text).toContain('RCSLIB代码规范')
    expect(text).toContain('https://xmurcsrobot.feishu.cn/docx/d1')
  })

  it('查不到时提示可能是没同步，而不是断言队里没有', async () => {
    const t = tool('rcs_kb_search')!
    const v = await t.execute({ query: '量子纠缠推进器' }, exec)
    const text = t.output.render({}, v)[0]?.text ?? ''
    expect(text).toContain('还没同步')
    expect(text).toContain('rcs_kb_status')
  })

  it('结果卡片按文档折叠，字段齐全', async () => {
    const t = tool('rcs_kb_search')!
    const v = await t.execute({ query: 'printf' }, exec)
    const args = { query: 'printf' }
    const meta = t.output.presentationMeta!(args, v)
    // 注意传 args 而不是 {}：defineTool 对呈现钩子的参数做**软校验**，
    // 必填参数缺失时直接返回 undefined（退回通用卡片），而不是抛错。
    // 这是契约行为，不是 bug —— 早先在规则插件上已经踩过一次。
    const view = t.presentResult!(args, { meta }) as {
      card: string
      files: { path: string; matches: unknown[] }[]
      total: number
    }
    expect(view.card).toBe('search')
    expect(view.total).toBe(1)
    expect(view.files[0]?.path).toContain('RCSLIB代码规范')
  })

  it('无命中时退回通用卡片，不硬套搜索卡片', async () => {
    const t = tool('rcs_kb_search')!
    const args = { query: '不存在的词' }
    const v = await t.execute(args, exec)
    const view = t.presentResult!(args, { meta: t.output.presentationMeta!(args, v) }) as { card: string }
    expect(view.card).toBe('generic')
  })
})

describe.skipIf(!hasBundle)('rcs_kb_status 端到端', () => {
  it('报出文档数、同步时间与授权范围', async () => {
    const t = tool('rcs_kb_status')!
    const v = await t.execute({}, exec)
    const text = t.output.render({}, v)[0]?.text ?? ''
    expect(text).toContain('A02 电控组(通用)')
    expect(text).toContain('2026-08-29')
    expect(text).toMatch(/不联网|断网/)
  })

  it('镜像缺失时说明原因并指出下一步', async () => {
    rmSync(join(cacheDir, 'manifest.json'))
    const t = tool('rcs_kb_status')!
    const v = await t.execute({}, exec)
    const text = t.output.render({}, v)[0]?.text ?? ''
    expect(text).toContain('rcs_kb_sync')
  })
})

describe.skipIf(!hasBundle)('rcs_kb_sync 的失败路径', () => {
  /**
   * **必须显式清掉环境变量**，不能指望它"恰好不存在"。
   *
   * 早先这条测试只靠 config 里传一个不存在的变量名来制造失败，但插件解析
   * secret 时是 `team.json 的 appSecretEnv` 优先，config 那个覆盖不生效。
   * 于是本机配好 FEISHU_APP_SECRET 之后，这条测试**真的发起了联网同步**，
   * 20 秒超时才暴露 —— 在此之前它一直"通过"，但通过的原因是错的。
   *
   * 单测绝不能依赖机器上恰好有没有某个环境变量。
   */
  const KEYS = ['FEISHU_APP_SECRET', 'FEISHU_APP_ID']
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved = {}
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('缺少 app_secret 环境变量时，报错要说清密钥该放哪、为什么', async () => {
    const t = tool('rcs_kb_sync')!
    await expect(t.execute({}, exec)).rejects.toThrow(/环境变量/)
    await expect(t.execute({}, exec)).rejects.toThrow(/shell 历史|进 git/)
  })

  it('报错里不得出现密钥本身', async () => {
    const t = tool('rcs_kb_sync')!
    const err = await t.execute({}, exec).catch((e: Error) => e)
    expect((err as Error).message).not.toMatch(/[A-Za-z0-9]{32}/)
  })
})

describe.skipIf(!hasBundle)('呈现钩子不得抛异常', () => {
  it('presentCall 在配置缺失时也要能返回', () => {
    for (const t of tools) {
      expect(() => t.presentCall?.({ query: 'x' })).not.toThrow()
    }
  })

  it('presentResult 遇到不认识的 meta 返回 undefined 而不是抛', () => {
    const t = tool('rcs_kb_search')!
    const args = { query: 'x' }
    expect(t.presentResult!(args, { meta: { kind: '别的插件的' } })).toBeUndefined()
    expect(t.presentResult!(args, {})).toBeUndefined()
  })

  it('呈现参数缺必填项时退回 undefined（defineTool 的软校验），不抛错', () => {
    const t = tool('rcs_kb_search')!
    expect(() => t.presentResult!({}, { meta: { kind: 'rcs-kb-search', query: 'x', hits: [] } })).not.toThrow()
    expect(t.presentResult!({}, { meta: { kind: 'rcs-kb-search', query: 'x', hits: [] } })).toBeUndefined()
  })
})
