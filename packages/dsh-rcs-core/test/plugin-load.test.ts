/**
 * core 插件的加载测试 —— 用**真实的 cordis Context**，不是桩。
 *
 * 其它插件的测试用桩 ctx 就够（它们只调 `ctx.tools.register`），
 * 但 core 是**类式 Service 插件**：`super(ctx, 'rcs')` 会走 cordis 的真实注册流程，
 * 桩对象测不出服务是否真的挂上去了。好在 `@deepseek-ai/cordis` 已是 devDependency，
 * 直接 new 一个 Context 就能验证。
 *
 * 顺带验证一个设计意图：没有 `tools` 服务时，Service 本身依然可用
 * （工具注册包在 `ctx.inject(['tools'], ...)` 里，是可选依赖）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const REPO = join(import.meta.dirname, '..', '..', '..')
const BUNDLE = join(REPO, 'packages', 'dsh-rcs-core', 'lib', 'index.js')
const TEAM = join(REPO, 'config', 'team.json')

const ready = existsSync(BUNDLE) && existsSync(TEAM)

/** ctx.rcs 的最小结构，只声明本测试用到的。 */
interface RcsFace {
  season: string
  theme: string | null
  rulesVersion: string
  projectRoot: string
  templateRoot: string
  robot(id: string): { id: string; autonomy: string; carryLimit: number } | undefined
  mayEnter(robot: string, zone: string): boolean | undefined
  layerOf(file: string): string | undefined
  countdown(today: Date): { days: number }[]
  summary(today: Date): string
}

let ctx: Context & { rcs?: RcsFace }

beforeAll(async () => {
  if (!ready) return
  const mod = await import(pathToFileURL(BUNDLE).href)
  ctx = new Context() as Context & { rcs?: RcsFace }
  ctx.plugin(mod, { teamConfig: TEAM })
  // Fiber 的加载是异步的，等它进 ACTIVE
  await new Promise((r) => setTimeout(r, 300))
})

describe.skipIf(!ready)('dsh-rcs-core 服务注册', () => {
  it('ctx.rcs 被挂上', () => {
    expect(ctx.rcs).toBeDefined()
  })

  it('没有 tools 服务时插件依然加载成功（工具注册是可选依赖）', () => {
    // ctx 里从没提供过 tools，若工具注册写成顶层 inject，插件会停在 PENDING、
    // ctx.rcs 也就不会存在。这条断言守住那个设计选择。
    expect((ctx as unknown as { tools?: unknown }).tools).toBeUndefined()
    expect(ctx.rcs).toBeDefined()
  })

  it('赛季上下文来自 config/team.json', () => {
    expect(ctx.rcs?.season).toBe('2027')
    expect(ctx.rcs?.theme).toBe('女娲补天')
    expect(ctx.rcs?.rulesVersion).toBe('V0')
  })

  it('机器人角色与规则第 11 节一致', () => {
    expect(ctx.rcs?.robot('BR')?.autonomy).toBe('full-auto-required')
    expect(ctx.rcs?.robot('TR')?.carryLimit).toBe(3)
  })

  it('区域限制与规则 4.3 一致', () => {
    expect(ctx.rcs?.mayEnter('TR', 'L1')).toBe(false)
    expect(ctx.rcs?.mayEnter('BR', 'L2')).toBe(true)
  })

  it('工程路径与层次识别可用', () => {
    expect(ctx.rcs?.projectRoot).toContain('RCS_code')
    expect(ctx.rcs?.templateRoot).toContain('RCS_Template_F407')
    expect(ctx.rcs?.layerOf('RCS_Support/inc/gps.h')).toBe('RCS_Support')
  })

  it('倒计时与摘要不抛', () => {
    const today = new Date('2027-01-01T00:00:00Z')
    expect(() => ctx.rcs?.countdown(today)).not.toThrow()
    expect(ctx.rcs?.summary(today)).toContain('2027')
  })
})

describe.skipIf(!ready)('配置缺失时的行为', () => {
  it('配置文件不存在会让插件加载失败，而不是静默提供空上下文', async () => {
    const mod = await import(pathToFileURL(BUNDLE).href)
    const bad = new Context() as Context & { rcs?: RcsFace }
    // cordis 会把 apply 抛出的异常记进 fiber 状态（FAILED），不冒泡到这里
    bad.plugin(mod, { teamConfig: 'D:/definitely/not/here/team.json' })
    await new Promise((r) => setTimeout(r, 200))
    expect(bad.rcs).toBeUndefined()
  })
})
