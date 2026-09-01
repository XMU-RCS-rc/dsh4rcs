/**
 * guard 插件的集成测试 —— 用**真实 cordis** 跑 waterfall 分发。
 *
 * 为什么不用纯桩：guard 的全部行为都发生在 cordis 的事件系统里
 * （`tools/pre-execute` 是 waterfall，`next()` 代表委托下游）。
 * 桩对象测不出「我对 waterfall 签名的理解是否与实现一致」——
 * 而这正是最容易写错、又最不能出错的地方（它管的是物理危险操作）。
 *
 * `tools` 服务用一个最小 Service 桩：真实的 `ToolRuntime` 还依赖
 * systemPrompt 等一串服务，为验证 guard 而拉起整条链不划算，
 * 且 guard 只用到 `tools.guard()` 这一个面。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'

const REPO = join(import.meta.dirname, '..', '..', '..')
const BUNDLE = join(REPO, 'packages', 'dsh-rcs-guard', 'lib', 'index.js')
const ready = existsSync(BUNDLE)

type GuardFn = (exec: { name: string }) => string | undefined
type Decision = { kind: string; reason?: string }

let registeredGuards: GuardFn[] = []

/** 最小 tools 服务：只提供 guard 与 register 两个面。 */
class FakeTools extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
  guard(fn: GuardFn): () => void {
    registeredGuards.push(fn)
    return () => {}
  }
  register(): () => void {
    return () => {}
  }
}

async function bootGuard(mode: 'dev' | 'field', extraL2: string[] = []): Promise<Context> {
  registeredGuards = []
  const mod = await import(pathToFileURL(BUNDLE).href)
  const ctx = new Context()
  ctx.plugin(FakeTools)
  await new Promise((r) => setTimeout(r, 150))
  ctx.plugin(mod, { mode, extraL2 })
  await new Promise((r) => setTimeout(r, 250))
  return ctx
}

/** 走真实的 waterfall 分发，默认下游是放行。 */
async function preExecute(ctx: Context, tool: string): Promise<Decision> {
  return (await (ctx as unknown as {
    waterfall(
      name: string,
      exec: { name: string },
      next: () => Promise<Decision>,
    ): Promise<Decision>
  }).waterfall('tools/pre-execute', { name: tool }, async () => ({ kind: 'allow' }))) as Decision
}

describe.skipIf(!ready)('guard 在开发模式', () => {
  let ctx: Context
  beforeEach(async () => {
    ctx = await bootGuard('dev')
  })

  it('插件加载后 tools 服务在场（inject 已满足）', () => {
    expect((ctx as unknown as { tools?: unknown }).tools).toBeDefined()
  })

  it('L0 工具经 next() 委托下游放行', async () => {
    expect((await preExecute(ctx, 'rcs_lint_layer')).kind).toBe('allow')
  })

  it('L2 物理动作要求人工确认', async () => {
    const d = await preExecute(ctx, 'rcs_pneumatic_fire')
    expect(d.kind).toBe('ask')
    expect(d.reason).toContain('600kPa')
  })

  it('L1 放行，交给 dsh 自身的审批体系', async () => {
    expect((await preExecute(ctx, 'rcs_fw_build')).kind).toBe('allow')
  })

  it('开发模式不注册 guard —— 单调拒绝只属于赛场', () => {
    expect(registeredGuards).toHaveLength(0)
  })

  it('extraL2 能把队内自定义工具提升为需确认', async () => {
    const c = await bootGuard('dev', ['team_custom_actuator'])
    expect((await preExecute(c, 'team_custom_actuator')).kind).toBe('ask')
  })
})

describe.skipIf(!ready)('guard 在赛场模式（红线）', () => {
  let ctx: Context
  beforeEach(async () => {
    ctx = await bootGuard('field')
  })

  it('L0 仍放行：赛场上必须能查规则', async () => {
    expect((await preExecute(ctx, 'rcs_rule_lookup')).kind).toBe('allow')
  })

  it('L2 一律拒绝', async () => {
    const d = await preExecute(ctx, 'rcs_fw_flash')
    expect(d.kind).toBe('deny')
    expect(d.reason).toContain('赛场模式')
  })

  it('L1 同样拒绝', async () => {
    expect((await preExecute(ctx, 'rcs_fw_build')).kind).toBe('deny')
  })

  it('注册了不可绕过的 guard，且返回拒绝原因字符串而非布尔', () => {
    expect(registeredGuards).toHaveLength(1)
    const g = registeredGuards[0]!
    const r = g({ name: 'rcs_pneumatic_fire' })
    expect(typeof r).toBe('string')
    expect(r).toContain('赛场模式')
    expect(g({ name: 'rcs_lint_layer' })).toBeUndefined()
  })
})
