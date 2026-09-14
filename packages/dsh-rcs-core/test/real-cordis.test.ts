/**
 * core 的工具与服务在**真实 cordis** 里跑一遍 —— 桩 ctx 测不出服务有没有声明进 inject。
 *
 * 曾经的缺陷：rcs_team_context / rcs_version_status 注册在 `ctx.inject(['tools'], …)` 里，
 * 执行时却读 `scoped.rcs`。rcs 不在那一层的 inject 里，cordis 直接抛
 * `cannot get property "rcs" without inject` —— 桩测试全绿，真 dsh 里一调就错。
 *
 * 顺带验跨插件那一跳：rules 不传赛季时经 `ctx.get('rcs')` 取 core 的赛季。
 * `tools` 服务照 guard-mode 测试的做法用一个最小 Service 桩：只收下注册的工具。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'

const REPO = join(import.meta.dirname, '..', '..', '..')
const lib = (name: string): string => join(REPO, 'packages', name, 'lib', 'index.js')
const TEAM = join(REPO, 'config', 'team.json')
const ready = ['dsh-rcs-core', 'dsh-rcs-rules'].every((n) => existsSync(lib(n))) && existsSync(TEAM)

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

type Name = 'dsh-rcs-core' | 'dsh-rcs-rules'
const CONFIGS: Record<Name, unknown> = {
  'dsh-rcs-core': { teamConfig: TEAM },
  'dsh-rcs-rules': { rulesRoot: '', season: '', constraintsVersion: '' },
}

async function boot(names: readonly Name[]): Promise<void> {
  registered = []
  const ctx = new Context()
  ctx.plugin(FakeTools)
  await settle()
  for (const name of names) {
    ctx.plugin((await load(name)) as never, CONFIGS[name] as never)
    await settle()
  }
}

function tool(name: string): RegisteredTool {
  const t = registered.find((x) => x.name === name)
  if (t === undefined) throw new Error(`${name} 没有注册`)
  return t
}

const exec = { signal: new AbortController().signal }
const season = ready ? (JSON.parse(readFileSync(TEAM, 'utf8')) as { season: string }).season : ''

describe.skipIf(!ready)('core 的服务在真实 cordis 里用得到', () => {
  it('rcs_team_context 执行时拿得到 rcs，不抛 without inject', async () => {
    await boot(['dsh-rcs-core'])
    const r = (await tool('rcs_team_context').execute({}, exec)) as { season: string; summary: string }
    expect(r.season).toBe(season)
    expect(r.summary).toContain(season)
  })

  it('rcs_team_context 按机器人查也一样', async () => {
    await boot(['dsh-rcs-core'])
    const r = (await tool('rcs_team_context').execute({ robot: 'TR' }, exec)) as {
      robots: { id: string }[]
    }
    expect(r.robots.map((x) => x.id)).toEqual(['TR'])
  })

  it('rules 不传赛季时经 ctx.get(rcs) 取 core 的赛季', async () => {
    await boot(['dsh-rcs-core', 'dsh-rcs-rules'])
    const r = (await tool('rcs_rule_lookup').execute({ query: '11.14' }, exec)) as {
      season: string
      hits: { id: string }[]
    }
    expect(r.season).toBe(season)
    expect(r.hits.map((h) => h.id)).toContain('11.14')
  })

  it('没装 core 时 rules 明确报「没有指定赛季」，而不是 without inject', async () => {
    await boot(['dsh-rcs-rules'])
    await expect(tool('rcs_rule_lookup').execute({ query: '11.14' }, exec)).rejects.toThrow(
      /没有指定赛季/,
    )
  })
})
