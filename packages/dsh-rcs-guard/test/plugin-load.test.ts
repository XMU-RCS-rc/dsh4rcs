/**
 * guard 插件的集成测试 —— 用**真实 cordis** 跑 waterfall 分发。
 *
 * 为什么不用纯桩：guard 的全部行为都发生在 cordis 的事件系统里
 * （`tools/pre-execute` 是 waterfall，`next()` 代表委托下游）。
 * 桩对象测不出「我对 waterfall 签名的理解是否与实现一致」——
 * 而这正是最容易写错、又最不能出错的地方（它管的是物理危险操作）。
 *
 * `tools` 服务用一个最小 Service 桩：真实的 `ToolRuntime` 还依赖
 * systemPrompt 等一串服务，为验证本插件而拉起整条链不划算。
 *
 * 桩仍然保留 `guard()`，不是因为插件要用它 —— 赛场模式删除后它已经不注册
 * 单调拒绝了 —— 而是为了能断言「一个都没注册」。那是删除后的实质承诺，
 * 只有桩接得住这个调用，才能区分「没注册」和「注册了但桩没接住」。
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

async function bootGuard(mode: 'dev' | 'training', extraL2: string[] = []): Promise<Context> {
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

  it('不注册单调拒绝 —— 现存模式没有任何硬性拒绝', () => {
    expect(registeredGuards).toHaveLength(0)
  })

  it('extraL2 能把队内自定义工具提升为需确认', async () => {
    const c = await bootGuard('dev', ['team_custom_actuator'])
    expect((await preExecute(c, 'team_custom_actuator')).kind).toBe('ask')
  })
})

describe.skipIf(!ready)('guard 在培训模式', () => {
  let ctx: Context
  beforeEach(async () => {
    ctx = await bootGuard('training')
  })

  it('L0 放行：新生要能查规则、查队内资料', async () => {
    expect((await preExecute(ctx, 'rcs_rule_lookup')).kind).toBe('allow')
  })

  it('L1 放行 —— 构建与跑测试是学习循环的核心', async () => {
    expect((await preExecute(ctx, 'rcs_fw_build')).kind).toBe('allow')
  })

  it('L2 物理动作需人工确认，文案要求第一次有人在旁', async () => {
    const d = await preExecute(ctx, 'rcs_fw_flash')
    expect(d.kind).toBe('ask')
    expect(d.reason).toContain('老队员在旁边')
  })

  it('LG 代码生成需过闸门', async () => {
    const d = await preExecute(ctx, 'rcs_train_generate')
    expect(d.kind).toBe('ask')
    expect(d.reason).toContain('骨架跑起来了吗')
  })

  // 赛场模式删除后，两种模式都不再注册单调拒绝。这条与 dev 那条成对，
  // 少任何一条都留得下「只在某个模式漏注册」的缺口。
  it('同样不注册单调拒绝', () => {
    expect(registeredGuards).toHaveLength(0)
  })

  it('没有任何工具会被拒绝', async () => {
    for (const t of ['rcs_rule_lookup', 'rcs_fw_build', 'rcs_fw_flash', 'rcs_train_generate']) {
      expect((await preExecute(ctx, t)).kind, `${t} 不该是 deny`).not.toBe('deny')
    }
  })
})
