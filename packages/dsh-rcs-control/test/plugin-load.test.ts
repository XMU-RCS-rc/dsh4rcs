/**
 * 插件加载测试 —— **不启动 dsh** 就验证适配层契约。
 *
 * 用一个桩 Context 跑 `apply`，检查：
 *   1. 构建产物能被 Node 正常 import（外置依赖解析得到）
 *   2. 导出形状符合 cordis 插件契约（name / inject / apply / Config）
 *   3. 三个工具都注册了，且带齐 execute / render / presentCall / presentResult
 *   4. 工具真能跑出结果，呈现钩子在真实数据上不抛
 *
 * 这一层挡住的是「启动 dsh 才发现插件加载失败」的返工。
 * 它替代不了 L3（真实 dsh 加载），但能把 L3 的失败面缩小到「只剩 dsh 集成本身」。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = join(import.meta.dirname, '..', '..', '..')
const BUNDLE = join(REPO, 'packages', 'dsh-rcs-control', 'lib', 'index.js')
const PROJECT = process.env['RCS_PROJECT'] ?? 'D:/code/RCS_code'

const hasBundle = existsSync(BUNDLE)
const hasProject = existsSync(join(PROJECT, 'template', 'RCS_Template_F407'))

/** 被注册的工具定义（只取本测试关心的字段）。 */
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
  Config: { (config?: unknown): unknown }
  apply(ctx: unknown, config: unknown): void
}

let mod: PluginModule
let tools: CapturedTool[] = []
let disposers = 0

beforeAll(async () => {
  if (!hasBundle) return
  mod = (await import(pathToFileURL(BUNDLE).href)) as unknown as PluginModule

  tools = []
  disposers = 0
  // 桩 Context：只实现 apply 用到的两个面
  const ctx = {
    tools: {
      register(def: CapturedTool) {
        tools.push(def)
        return () => { disposers++ }
      },
    },
    effect(fn: () => () => void) {
      fn()
      return () => { disposers++ }
    },
  }
  mod.apply(ctx, { projectRoot: PROJECT, configDir: join(REPO, 'config') })
})

describe.skipIf(!hasBundle)('构建产物可加载', () => {
  it('导出符合 cordis 插件契约', () => {
    expect(mod.name).toBe('rcs-control')
    expect(mod.inject).toEqual(['tools'])
    expect(typeof mod.apply).toBe('function')
    expect(mod.Config).toBeDefined()
  })

  it('Config schema 提供默认值', () => {
    const resolved = mod.Config({}) as Record<string, unknown>
    expect(typeof resolved['projectRoot']).toBe('string')
    expect(typeof resolved['configDir']).toBe('string')
  })

  it('注册了 11 个工具：4 个分层/规范检查 + 3 个协议与解算 + 4 个工具链', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'rcs_angle_loop_check',
      'rcs_fw_build',
      'rcs_fw_flash',
      'rcs_kinematics_check',
      'rcs_lint_embedded',
      'rcs_lint_layer',
      'rcs_rdlc_decode',
      'rcs_repo_hygiene',
      'rcs_support_test',
      'rcs_template_gap',
      'rcs_toolchain_status',
    ])
  })

  /**
   * 产出 Finding 的检查类工具。只有这些才该接搜索卡片那条呈现链路 ——
   * 构建/烧录/协议解析的结果不是「文件+行号」，硬套搜索卡片会误导人
   * 以为能点击跳转。
   */
  const FINDING_TOOLS = [
    'rcs_lint_layer', 'rcs_lint_embedded', 'rcs_repo_hygiene', 'rcs_template_gap',
    'rcs_angle_loop_check', 'rcs_kinematics_check',
  ]

  it('每个工具都带齐基本字段', () => {
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(10)
      expect(typeof t.execute, t.name).toBe('function')
      expect(typeof t.output.render, t.name).toBe('function')
      expect(typeof t.presentCall, t.name).toBe('function')
    }
  })

  it('检查类工具接了 findings 的呈现链路', () => {
    for (const name of FINDING_TOOLS) {
      const t = tools.find((x) => x.name === name)
      expect(t, name).toBeDefined()
      expect(typeof t?.output.presentationMeta, name).toBe('function')
      expect(typeof t?.presentResult, name).toBe('function')
    }
  })

  it('非检查类工具不硬套搜索卡片', () => {
    for (const name of ['rcs_fw_build', 'rcs_fw_flash', 'rcs_toolchain_status', 'rcs_support_test']) {
      const t = tools.find((x) => x.name === name)
      expect(t?.presentResult, name).toBeUndefined()
    }
  })

  it('presentCall 遇到空参数一律不得抛 —— 回放历史会话时 args 可能不完整', () => {
    for (const t of tools) {
      expect(() => t.presentCall?.({}), t.name).not.toThrow()
    }
  })

  it('无必填参数的工具，空参数下就该给出合法卡片', () => {
    // 有必填参数的工具（如 rcs_rdlc_decode 的 hex）在参数缺失时，
    // defineTool 的**软校验**会让 presentCall 返回 undefined 并退回通用卡片。
    // 这是契约行为不是 bug —— 早先在规则插件上已经踩过一次。
    // defineTool 会把 parameters 归一成 JSON Schema：必填项落在**顶层 required 数组**里，
    // 而不是保留写入时的 `required: true` 标志。按后者去筛会一个都筛不出来。
    const optional = tools.filter(
      (t) => ((t.parameters as { required?: string[] }).required ?? []).length === 0,
    )
    expect(optional.length).toBeGreaterThan(0)
    for (const t of optional) {
      const view = t.presentCall?.({}) as { card: string; title: string; kind: string }
      expect(view, t.name).toBeDefined()
      expect(view.card, t.name).toBe('generic')
      expect(view.kind, t.name).toBe('search')
      expect(view.title.length, t.name).toBeGreaterThan(0)
    }
  })

  it('有必填参数的工具，给齐参数后卡片正常', () => {
    const rdlc = tools.find((t) => t.name === 'rcs_rdlc_decode')!
    const view = rdlc.presentCall?.({ hex: 'C0 A0 01' }) as { card: string; title: string }
    expect(view.card).toBe('generic')
    expect(view.title).toContain('RDLC')
  })
})

describe.skipIf(!hasBundle || !hasProject)('工具在真实工程上端到端可用', () => {
  it('rcs_lint_layer 跑出结果，且呈现链路完整', async () => {
    const tool = tools.find((t) => t.name === 'rcs_lint_layer')
    expect(tool).toBeDefined()
    if (!tool) return

    const value = await tool.execute({}, { signal: new AbortController().signal })

    // 模型可见文本
    const blocks = tool.output.render({}, value)
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toContain('layer-lint')

    // 持久化元数据 → 结果卡片（模拟回放：meta 经过一次 JSON 往返）
    const meta = tool.output.presentationMeta?.({}, value)
    const roundTripped = JSON.parse(JSON.stringify(meta))
    const view = tool.presentResult?.({}, {
      content: blocks,
      isError: false,
      meta: roundTripped,
    }) as { card: string; total: number; files: unknown[] }

    expect(view.card).toBe('search')
    expect(view.total).toBeGreaterThan(0)
    expect(view.files.length).toBeGreaterThan(0)
  })

  it('meta 缺失时 presentResult 回退到通用渲染而不是抛异常', () => {
    const tool = tools.find((t) => t.name === 'rcs_repo_hygiene')
    expect(tool).toBeDefined()
    // 回放旧会话时 meta 可能根本不存在
    expect(() => tool?.presentResult?.({}, { content: [], isError: false })).not.toThrow()
    expect(tool?.presentResult?.({}, { content: [], isError: false })).toBeUndefined()
  })
})
