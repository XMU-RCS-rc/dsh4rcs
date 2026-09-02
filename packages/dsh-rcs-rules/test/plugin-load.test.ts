/**
 * 规则插件的加载与端到端测试 —— 不启动 dsh。
 *
 * 桩 ctx 跑 `apply`，然后对**真实的 2027 V0 规则数据**跑一遍三个工具，
 * 验证注册形状、执行结果与呈现链路。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = join(import.meta.dirname, '..', '..', '..')
const BUNDLE = join(REPO, 'packages', 'dsh-rcs-rules', 'lib', 'index.js')
const RULES = join(REPO, 'data', 'rules')

const hasBundle = existsSync(BUNDLE)
const hasRules = existsSync(join(RULES, '2027', 'V0', 'clauses.json'))

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

beforeAll(async () => {
  if (!hasBundle) return
  mod = (await import(pathToFileURL(BUNDLE).href)) as unknown as PluginModule
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
  mod.apply(ctx, { rulesRoot: RULES, season: '2027', constraintsVersion: 'V0' })
})

const tool = (n: string): CapturedTool | undefined => tools.find((t) => t.name === n)
const exec = { signal: new AbortController().signal }

describe.skipIf(!hasBundle)('规则插件可加载', () => {
  it('导出符合 cordis 插件契约', () => {
    expect(mod.name).toBe('rcs-rules')
    expect(mod.inject).toEqual(['tools'])
    expect(typeof mod.apply).toBe('function')
  })

  it('注册了五个规则工具（含跨赛季的导入入口）', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'rcs_rule_check',
      'rcs_rule_diff',
      'rcs_rule_import',
      'rcs_rule_lookup',
      'rcs_rule_versions',
    ])
  })

  it('Config 不给赛季默认值 —— 插件要跨赛季复用', () => {
    const c = mod.Config({}) as Record<string, unknown>
    expect(typeof c['rulesRoot']).toBe('string')
    // 刻意留空：写死某一年，第二年就会有人忘了改而拿旧规则做判断
    expect(c['season']).toBe('')
    expect(c['constraintsVersion']).toBe('')
  })
})

describe.skipIf(!hasBundle || !hasRules)('rcs_rule_lookup 端到端', () => {
  it('查「气压上限」返回 11.14 原文，且带免责提示', async () => {
    const t = tool('rcs_rule_lookup')!
    const v = (await t.execute({ query: '气压上限' }, exec)) as {
      version: string
      hits: { id: string; text: string }[]
    }
    expect(v.hits.some((h) => h.id === '11.14')).toBe(true)

    const text = t.output.render({}, v)[0]?.text ?? ''
    expect(text).toContain('11.14')
    expect(text).toContain('600kPa')
    expect(text).toContain('以官方规则手册为准')
  })

  it('省略 version 时自动取该赛季最新版本', async () => {
    const t = tool('rcs_rule_lookup')!
    const v = (await t.execute({ query: '急停' }, exec)) as { version: string }
    expect(v.version).toBe('V0')
  })

  it('查不到时给出明确说明而不是空白', async () => {
    const t = tool('rcs_rule_lookup')!
    const v = await t.execute({ query: '量子纠缠推进器' }, exec)
    const text = t.output.render({}, v)[0]?.text ?? ''
    expect(text).toContain('没有检索到')
  })
})

describe.skipIf(!hasBundle || !hasRules)('rcs_rule_diff 端到端', () => {
  it('V0 自比得零差异', async () => {
    const t = tool('rcs_rule_diff')!
    const v = (await t.execute({ fromVersion: 'V0', toVersion: 'V0' }, exec)) as {
      stats: { added: number; removed: number; modified: number }
    }
    expect(v.stats.added + v.stats.removed + v.stats.modified).toBe(0)

    const text = t.output.render({}, v)[0]?.text ?? ''
    expect(text).toContain('两个版本完全一致')
  })

  it('版本不存在时报出可操作的错误', async () => {
    const t = tool('rcs_rule_diff')!
    await expect(t.execute({ fromVersion: 'V0', toVersion: 'V99' }, exec)).rejects.toThrow(
      /规则文件不存在/,
    )
  })
})

describe.skipIf(!hasBundle || !hasRules)('rcs_rule_check 端到端', () => {
  it('超压设计被查出，结论带条款号', async () => {
    const t = tool('rcs_rule_check')!
    const v = (await t.execute(
      { design: '气动系统 0.8MPa，整机 55kg，配红色急停按钮' },
      exec,
    )) as { ok: boolean; findings: { rule: string; detail?: string }[] }

    expect(v.ok).toBe(false)
    expect(v.findings.some((f) => f.rule === 'pressure-over')).toBe(true)
    expect(v.findings.find((f) => f.rule === 'pressure-over')?.detail).toContain('11.14')
  })

  it('呈现链路完整：render + presentationMeta + presentResult（含 JSON 往返）', async () => {
    const t = tool('rcs_rule_check')!
    const args = { design: '用无人机投放塔顶，气压 0.9MPa' }
    const v = await t.execute(args, exec)

    const text = t.output.render(args, v)[0]?.text ?? ''
    expect(text).toContain('以官方规则手册为准')

    // 模拟回放：meta 经过一次 JSON 往返
    const meta = JSON.parse(JSON.stringify(t.output.presentationMeta?.(args, v)))
    const view = t.presentResult?.(args, { content: [], isError: false, meta }) as {
      card: string
      total: number
    }
    expect(view.card).toBe('search')
    expect(view.total).toBeGreaterThan(0)
  })

  it('defineTool 对呈现钩子的 args 做软校验：必填缺失时回退到通用渲染', async () => {
    // 这是 defineTool 的既定行为（"Replay-only presenters validate softly and
    // fall back to generic rendering for obsolete logged arguments"）：
    // 回放旧会话时日志里的 args 可能已经过时，presenter 不能因此抛异常。
    // 实测表现是**返回 undefined**，由 UI 退回通用卡片 —— 不是 bug。
    const t = tool('rcs_rule_check')!
    const args = { design: '气压 0.9MPa' }
    const v = await t.execute(args, exec)
    const meta = t.output.presentationMeta?.(args, v)

    // design 是 required，传空对象通不过校验
    expect(t.presentResult?.({}, { content: [], isError: false, meta })).toBeUndefined()
    expect(t.presentCall?.({})).toBeUndefined()

    // 传合法 args 就正常出卡片
    expect(t.presentCall?.(args)).toBeDefined()
  })

  it('合规设计不报 error', async () => {
    const t = tool('rcs_rule_check')!
    const v = (await t.execute(
      { design: '24V 锂电池，气压 500kPa，整机 45kg，红色急停按钮，BR 全自动' },
      exec,
    )) as { ok: boolean }
    expect(v.ok).toBe(true)
  })
})

describe.skipIf(!hasBundle || !hasRules)('规则结果卡片', () => {
  it('检索结果用搜索卡片，每条**条款**是一个可折叠分组，分组名带版本号', async () => {
    const t = tool('rcs_rule_lookup')!
    const args = { query: '气压上限' }
    const v = await t.execute(args, exec)
    const meta = JSON.parse(JSON.stringify(t.output.presentationMeta?.(args, v)))
    const view = t.presentResult?.(args, { content: [], isError: false, meta }) as {
      card: string
      title: string
      files: { path: string; matches: unknown[] }[]
      total: number
    }

    expect(view.card).toBe('search')
    expect(view.total).toBeGreaterThan(0)
    // 版本号必须出现在分组名里：规则会改版，脱离版本的条款号是危险的
    expect(view.files[0]?.path).toContain('V0')
    expect(view.files.some((f) => f.path.includes('11.14'))).toBe(true)
  })

  it('无命中时退回通用卡片而不是空的搜索卡片', async () => {
    const t = tool('rcs_rule_lookup')!
    const args = { query: '量子纠缠推进器' }
    const v = await t.execute(args, exec)
    const meta = JSON.parse(JSON.stringify(t.output.presentationMeta?.(args, v)))
    const view = t.presentResult?.(args, { content: [], isError: false, meta }) as {
      card: string
      title: string
    }
    expect(view.card).toBe('generic')
    expect(view.title).toContain('无命中')
  })

  it('diff 用通用卡片 —— 改动不是「文件里的若干行」，套搜索卡片会误导', async () => {
    const t = tool('rcs_rule_diff')!
    const args = { fromVersion: 'V0', toVersion: 'V0' }
    const v = await t.execute(args, exec)
    const meta = JSON.parse(JSON.stringify(t.output.presentationMeta?.(args, v)))
    const view = t.presentResult?.(args, { content: [], isError: false, meta }) as {
      card: string
      title: string
    }
    expect(view.card).toBe('generic')
    expect(view.title).toContain('无改动')
  })

  it('meta 缺失时全部卡片回退到通用渲染，不抛异常', () => {
    for (const n of ['rcs_rule_lookup', 'rcs_rule_diff', 'rcs_rule_check']) {
      const t = tool(n)!
      expect(() => t.presentResult?.({ query: 'x', design: 'x', fromVersion: 'V0', toVersion: 'V0' },
        { content: [], isError: false })).not.toThrow()
    }
  })
})

describe.skipIf(!hasBundle)('跨赛季入口', () => {
  it('rcs_rule_versions 列出规则库现有内容', async () => {
    const t = tool('rcs_rule_versions')!
    const v = (await t.execute({}, exec)) as { seasons: { season: string; versions: string[] }[] }
    expect(Array.isArray(v.seasons)).toBe(true)
    const text = t.output.render({}, v)[0]?.text ?? ''
    expect(text).toContain('规则库')
  })

  it('rcs_rule_import 参数齐全，且默认不覆盖已有版本', () => {
    const t = tool('rcs_rule_import')!
    // 注意：defineTool 会把 parameters **编译成 JSON Schema**，
    // 所以读的是 .properties，不是原样的声明对象
    const props = (t.parameters as { properties: Record<string, unknown> }).properties
    expect(props['docxPath']).toBeDefined()
    expect(props['season']).toBeDefined()
    expect(props['version']).toBeDefined()
    expect(props['overwrite']).toBeDefined()
    // 描述里要讲清楚约束表需人工填 —— 这是模型最容易想当然的地方
    expect(t.description).toContain('人工填写')
  })

  it('导入不存在的文件报出可操作的错误', async () => {
    const t = tool('rcs_rule_import')!
    await expect(
      t.execute({ docxPath: 'D:/nowhere/rules.docx', season: '2099', version: 'V0' }, exec),
    ).rejects.toThrow(/规则书不存在/)
  })

  it('赛季必须是四位年份', async () => {
    const t = tool('rcs_rule_import')!
    await expect(
      t.execute({ docxPath: 'D:/nowhere/x.docx', season: '27', version: 'V0' }, exec),
    ).rejects.toThrow()
  })
})
