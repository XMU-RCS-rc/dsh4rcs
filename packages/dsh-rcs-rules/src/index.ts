/**
 * dsh-rcs-rules —— ROBOCON 规则版本追踪与查询。
 *
 * ## 为什么核心能力是 diff 而不是检索
 *
 * ROBOCON 规则每年重发且赛季内频繁改版。2027 赛季的 V0 是 ABU 原版的翻译稿，
 * 官方在前言里明说「很快，将会有国内赛规则V1版发布」。对战队来说，
 * **「改了哪里」比「写了什么」重要得多** —— 漏看一条改动可能让整套机构返工。
 *
 * ## 三条硬约束
 *
 *   1. **只检索、不生成**。规则解读错误的代价是整套方案返工，
 *      所以工具永远返回原文 + 条款号 + 版本号，由人自己判断。
 *   2. **一切结论可溯源**。`rcs_rule_check` 的每条提示都带条款号。
 *   3. **措辞是「疑似/请核对」**。最终解释权在裁判组（13.1）。
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView, ToolResult, JsonValue } from '@deepseek-ai/dsh-tools'

import { JsonRuleSource, searchClauses } from '../../rcs-core/src/rule-source.ts'
import { diffRuleDocuments } from '../../rcs-core/src/rule-diff.ts'
import type { RuleDiffResult } from '../../rcs-core/src/rule-diff.ts'
import { loadConstraints, checkDesign } from '../../rcs-core/src/rule-check.ts'
import { importRulebook } from '../../rcs-core/src/rule-import.ts'
import type { ImportResult } from '../../rcs-core/src/rule-import.ts'
import { repoPaths } from '../../rcs-core/src/paths.ts'
import type { CheckResultLike } from '../../rcs-ui/src/index.ts'
import { toPresentationMeta, isRcsMeta, TONE_MARK, severityTone, statsLine } from '../../rcs-ui/src/index.ts'

export const name = 'rcs-rules'
export const inject = ['tools']

export interface Config {
  /** 规则数据根目录，结构为 <root>/<赛季>/<版本>/clauses.json */
  rulesRoot: string
  /** 默认赛季，工具参数可覆盖。 */
  season: string
  /** `rcs_rule_check` 用哪个版本的约束表。 */
  constraintsVersion: string
}

/**
 * 赛季与版本**刻意不给默认值**。
 *
 * 插件要跨赛季复用。把某一年硬编码进来，第二年就会有人忘了改，
 * 于是拿旧规则做判断而毫无察觉 —— 那比直接报错糟得多。
 *
 * 解析优先级：工具参数 > core 的 `ctx.rcs`（来自 `config/team.json`）> 本插件配置。
 * 三处都没有就明确报错。
 */
export const Config: Schema<Config> = Schema.object({
  // 默认留空 —— 回落到本仓库的 data/rules，见 rcs-core/paths.ts
  rulesRoot: Schema.string().default(''),
  season: Schema.string().default(''),
  constraintsVersion: Schema.string().default(''),
})

const CLAUSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '条款号，如 11.14' },
    title: { type: 'string', description: '条款标题' },
    text: { type: 'string', description: '条款原文' },
  },
} as const

/** 免责尾注 —— 每个面向模型的输出都要带上。 */
const DISCLAIMER = '以官方规则手册为准；本工具只做检索与机械比对，不替代人工核对。'

// ---------- 渲染 ----------

function renderDiff(d: RuleDiffResult): string {
  const head =
    `规则 diff  ${d.from.season}/${d.from.version} → ${d.to.season}/${d.to.version}\n` +
    `新增 ${d.stats.added}  删除 ${d.stats.removed}  修改 ${d.stats.modified}  未变 ${d.stats.unchanged}`

  if (d.changes.length === 0) return `${head}\n\n两个版本完全一致。\n${DISCLAIMER}`

  const mark: Record<string, string> = { added: '+', removed: '-', modified: '~' }
  const body = d.changes.slice(0, 60).map((c) => {
    const head2 = `${mark[c.kind]} [${c.clauseId}]`
    if (c.kind === 'added') return `${head2} 新增：${(c.after ?? '').slice(0, 160)}`
    if (c.kind === 'removed') return `${head2} 删除：${(c.before ?? '').slice(0, 160)}`
    const sim = c.similarity !== undefined ? `（相似度 ${(c.similarity * 100).toFixed(0)}%）` : ''
    return `${head2} 修改${sim}\n    旧：${(c.before ?? '').slice(0, 140)}\n    新：${(c.after ?? '').slice(0, 140)}`
  })
  const more = d.changes.length > 60 ? `\n… 另有 ${d.changes.length - 60} 条未列出` : ''
  return `${head}\n\n${body.join('\n')}${more}\n\n${DISCLAIMER}`
}

interface LookupHit {
  id: string
  text: string
  score: number
}

function renderLookup(season: string, version: string, query: string, hits: LookupHit[]): string {
  if (hits.length === 0) {
    return `在 ${season}/${version} 中没有检索到与「${query}」相关的条款。\n${DISCLAIMER}`
  }
  const body = hits
    .map((h) => `[${version} · 条款 ${h.id}]\n${h.text}`)
    .join('\n\n')
  return `${season}/${version} 检索「${query}」，命中 ${hits.length} 条：\n\n${body}\n\n${DISCLAIMER}`
}

function renderCheck(r: CheckResultLike): string {
  const findings = r.findings ?? []
  const head = `设计合规比对（${r.target ?? ''}）  ${statsLine(r.stats)}`
  if (findings.length === 0) {
    return `${head}\n未发现疑似违规点。注意：本工具只做数值与关键词比对，覆盖不了全部规则。\n${DISCLAIMER}`
  }
  const body = findings
    .map((f) => {
      const mark = TONE_MARK[severityTone(f.severity)]
      return `${mark} [${f.rule ?? '?'}] ${f.message ?? ''}\n    ${f.detail ?? ''}`
    })
    .join('\n')
  return `${head}\n${body}\n\n${DISCLAIMER}`
}

function renderImport(r: ImportResult): string {
  const lines = [
    `已导入 ${r.season}/${r.version}`,
    `段落 ${r.paragraphs}  条款 ${r.clauses}  字符 ${r.chars}`,
    `目录 ${r.dir}`,
  ]
  if (r.overwrote) lines.push('（覆盖了已存在的版本）')
  if (r.constraintsScaffolded) {
    lines.push(
      '',
      `已生成 constraints.json 骨架，其中 ${r.constraintsPending} 个字段待填。`,
      '数值约束表**不做自动提取** —— 规则解读错了代价是整套方案返工。',
      '请对照 clauses.json 逐条填写，并核对每个 clause 是否指向本版真实条款号。',
      '填完前 rcs_rule_check 对该版本不可用。',
    )
  } else if (r.constraintsPending > 0) {
    lines.push('', `注意：已有的 constraints.json 还有 ${r.constraintsPending} 个字段是 null。`)
  }
  lines.push('', '下一步：用 rcs_rule_diff 对比上一版，人工核对涉及机械/电控的改动。')
  return lines.join('\n')
}

function renderVersions(v: { seasons: { season: string; versions: string[] }[] }): string {
  if (v.seasons.length === 0) {
    return '规则库是空的。用 rcs_rule_import 导入一份规则书 .docx 后再来。'
  }
  return [
    '规则库现有内容：',
    ...v.seasons.map((s) => `  ${s.season}: ${s.versions.join(', ')}`),
    '',
    '用 rcs_rule_import 可以导入新赛季或新版本的规则书。',
  ].join('\n')
}

function callView(title: string, input: unknown): ToolCallView {
  return { card: 'generic', title, kind: 'search', rawInput: input }
}

/**
 * 检索结果卡片：把每条命中的**条款**当作一个可折叠分组。
 *
 * 条款天然是「编号 + 正文」，和搜索卡片的「文件 + 匹配行」同构，
 * 于是能白拿到按条款折叠的原生交互。分组名带上版本号 ——
 * 规则会改版，脱离版本的条款号是危险的。
 */
type LookupMeta = {
  kind: 'rcs-rule-lookup'
  season: string
  version: string
  query: string
  hits: { id: string; text: string }[]
}

/** 按行切分并去掉空行。单独成函数，免得在对象字面量里塞正则影响可读性。 */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

function isLookupMeta(v: unknown): v is LookupMeta {
  return (
    typeof v === 'object' && v !== null &&
    (v as { kind?: unknown }).kind === 'rcs-rule-lookup' &&
    Array.isArray((v as { hits?: unknown }).hits)
  )
}

function lookupResultView(result: ToolResult): ToolResultView | undefined {
  const meta = result.meta
  if (!isLookupMeta(meta)) return undefined
  if (meta.hits.length === 0) {
    return { card: 'generic', title: `规则检索「${meta.query}」— 无命中` }
  }
  return {
    card: 'search',
    shape: 'matches',
    title: `${meta.season}/${meta.version} 检索「${meta.query}」— ${meta.hits.length} 条`,
    files: meta.hits.map((h) => ({
      path: `${meta.version} · 条款 ${h.id}`,
      matches: splitLines(h.text).map((line, i) => ({ lineNumber: i + 1, line })),
    })),
    truncated: false,
    total: meta.hits.length,
  }
}

/**
 * diff 结果卡片。
 *
 * 这里**不用搜索卡片**：改动不是「文件里的若干行」，硬套会误导人以为能跳转到某处。
 * 用通用卡片给一个信息密度高的标题，正文仍走 render 的文本。
 */
type DiffMeta = {
  kind: 'rcs-rule-diff'
  from: string
  to: string
  added: number
  removed: number
  modified: number
}

function isDiffMeta(v: unknown): v is DiffMeta {
  return (
    typeof v === 'object' && v !== null &&
    (v as { kind?: unknown }).kind === 'rcs-rule-diff'
  )
}

function diffResultView(result: ToolResult): ToolResultView | undefined {
  const meta = result.meta
  if (!isDiffMeta(meta)) return undefined
  const total = meta.added + meta.removed + meta.modified
  const title =
    total === 0
      ? `规则 ${meta.from} → ${meta.to} — 无改动`
      : `规则 ${meta.from} → ${meta.to} — 新增 ${meta.added} / 删除 ${meta.removed} / 修改 ${meta.modified}`
  return { card: 'generic', title }
}

/** 复用 rcs-ui 的呈现元数据，让规则结果也拿到搜索卡片。 */
function checkResultView(result: ToolResult): ToolResultView | undefined {
  const meta = result.meta
  if (!isRcsMeta(meta)) return undefined
  if (meta.groups.length === 0) return { card: 'generic', title: '合规比对 — 未发现疑似违规点' }
  return {
    card: 'search',
    shape: 'matches',
    title: `合规比对 — ${meta.total} 条待核对`,
    files: meta.groups.map((g) => ({ path: g.path, matches: g.matches })),
    truncated: meta.truncated,
    total: meta.total,
  }
}

// ---------- 插件 ----------

/**
 * core 插件（`dsh-rcs-core`）提供的共享上下文的最小结构。
 *
 * 这里**刻意不 import 它的类型**：一 import 就在构建期把两个插件绑在一起，
 * 而设计上它们要能各自独立安装。用结构类型 + 运行时探测即可。
 */
interface RcsShared {
  season?: string
  projectRoot?: string
  rulesRoot?: string
  rulesVersion?: string
}

/**
 * 可选依赖：core 在场就用它的共享配置，不在场就退回本插件自己的配置。
 *
 * **每次调用都重新探测**，不在 apply 时缓存 —— core 可能比本插件晚加载，
 * 也可能中途被卸载重载，缓存住就会拿到过期的值。
 */
function shared(ctx: Context): RcsShared | undefined {
  // 防御式：ctx.get 在某些精简组合下可能不存在，且本函数被呈现钩子间接调用 ——
  // 呈现钩子按契约不得抛异常，一抛就把整条消息的渲染搞崩。
  try {
    const get = (ctx as unknown as { get?: (name: string) => RcsShared | undefined }).get
    return typeof get === 'function' ? get.call(ctx, 'rcs') : undefined
  } catch {
    return undefined
  }
}

export function apply(ctx: Context, config: Config): void {
  /** 规则根目录与赛季：core 共享配置优先，其次本插件配置。 */
  // 解析链：core 共享配置 > 插件配置 > 本仓库内的 data/rules
  const rulesRoot = (): string => shared(ctx)?.rulesRoot || config.rulesRoot || repoPaths.rulesRoot()
  // 用 `||` 而不是 `??`：空串也要视为「没配」，继续往下一级找
  const season = (override?: string): string => {
    const s = override || shared(ctx)?.season || config.season
    if (!s) {
      throw new Error(
        '没有指定赛季。请在工具参数里传 season，或在 config/team.json 里设 season' +
          '（由 dsh-rcs-core 经 ctx.rcs 提供），或在本插件配置里设 season。' +
          '本插件刻意不给默认年份 —— 拿错年份的规则做判断，比直接报错危险得多。',
      )
    }
    return s
  }
  const source = (): JsonRuleSource => new JsonRuleSource(rulesRoot())

  ctx.tools.register(
    defineTool({
      name: 'rcs_rule_diff',
      description:
        '对比两个版本的 ROBOCON 规则，列出新增/删除/修改的条款。' +
        '规则赛季内会反复改版（2027 的 V0 是 ABU 翻译稿，国内赛 V1 即将发布），' +
        '漏看一条改动可能让整套机构返工，所以改动清单比全文更重要。',
      parameters: {
        fromVersion: { type: 'string', required: true, description: '旧版本，如 V0' },
        toVersion: { type: 'string', required: true, description: '新版本，如 V1' },
        season: { type: 'string', description: '赛季，省略用插件配置的默认值' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'json', description: '旧版本标识' },
            to: { type: 'json', description: '新版本标识' },
            stats: { type: 'json', description: '新增/删除/修改/未变 计数' },
            changes: { type: 'json', description: '逐条改动' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: renderDiff(value as unknown as RuleDiffResult) },
        ],
        presentationMeta: (_args, value) => {
          const d = value as unknown as RuleDiffResult
          return {
            kind: 'rcs-rule-diff',
            from: `${d.from.season}/${d.from.version}`,
            to: `${d.to.season}/${d.to.version}`,
            added: d.stats.added,
            removed: d.stats.removed,
            modified: d.stats.modified,
          } as unknown as JsonValue
        },
      },
      presentCall: (args) =>
        callView('规则版本对比', `${args.fromVersion} → ${args.toVersion}`),
      presentResult: (_args, result) => diffResultView(result),
      async execute(args) {
        const s = season(args.season)
        const src = source()
        const [from, to] = await Promise.all([
          src.load(s, args.fromVersion),
          src.load(s, args.toVersion),
        ])
        return diffRuleDocuments(from, to) as unknown as never
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rcs_rule_lookup',
      description:
        '检索 ROBOCON 规则条款，返回条款号 + 版本号 + 原文。' +
        '可直接给条款号（如 11.14）精确定位，也可给关键词（如「气压上限」「急停」）。' +
        '本工具只做检索不做解读 —— 规则解读错了代价是整套方案返工。',
      parameters: {
        query: { type: 'string', required: true, description: '关键词或条款号' },
        season: { type: 'string', description: '赛季，省略用默认值' },
        version: { type: 'string', description: '版本，省略用该赛季最新版本' },
        limit: { type: 'integer', description: '最多返回几条，默认 8' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            season: { type: 'string', description: '赛季' },
            version: { type: 'string', description: '版本' },
            query: { type: 'string', description: '查询串' },
            hits: { type: 'array', items: CLAUSE_SCHEMA, description: '命中条款' },
          },
        },
        render: (_args, value) =>
          [
            {
              type: 'text' as const,
              text: renderLookup(
                value.season ?? '',
                value.version ?? '',
                value.query ?? '',
                (value.hits ?? []).map((h) => ({
                  id: h.id ?? '',
                  text: h.text ?? '',
                  score: 0,
                })),
              ),
            },
          ],
        presentationMeta: (_args, value) =>
          ({
            kind: 'rcs-rule-lookup',
            season: value.season ?? '',
            version: value.version ?? '',
            query: value.query ?? '',
            hits: (value.hits ?? []).map((h) => ({ id: h.id ?? '', text: h.text ?? '' })),
          }) as unknown as JsonValue,
      },
      presentCall: (args) => callView('规则条款检索', args.query),
      presentResult: (_args, result) => lookupResultView(result),
      async execute(args) {
        const s = season(args.season)
        const src = source()
        const version = args.version ?? (await src.listVersions(s)).at(-1)
        if (!version) throw new Error(`赛季 ${s} 下没有任何规则版本`)
        const doc = await src.load(s, version)
        const hits = searchClauses(doc, args.query, args.limit ?? 8)
        return {
          season: s,
          version,
          query: args.query,
          hits: hits.map((h) => ({ id: h.clause.id, text: h.clause.text })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rcs_rule_check',
      description:
        '拿一段设计描述比对规则约束，列出疑似违规点（电压、气压、重量、尺寸、' +
        '禁用能源、飞行机构、BR 必须全自动、急停按钮等），每条都带条款号。' +
        '只做数值与关键词的机械比对，覆盖不了全部规则，不替代人工核对。',
      parameters: {
        design: { type: 'string', required: true, description: '设计描述，自然语言即可' },
        season: { type: 'string', description: '赛季，省略用默认值' },
        version: { type: 'string', description: '约束表版本，省略用插件配置的默认值' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            check: { type: 'string', description: '检查器名' },
            target: { type: 'string', description: '赛季/版本' },
            ok: { type: 'boolean', description: '无 error 级发现即为 true' },
            stats: { type: 'json', description: '计数' },
            findings: {
              type: 'array',
              description: '疑似违规点',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  rule: { type: 'string', description: '规则 ID' },
                  severity: { type: 'string', enum: ['error', 'warn', 'info'], description: '严重级别' },
                  message: { type: 'string', description: '说明' },
                  file: { type: 'string', description: '不适用' },
                  line: { type: 'integer', description: '不适用' },
                  detail: { type: 'string', description: '条款号与上下文' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderCheck(value) }],
        presentationMeta: (_args, value) => toPresentationMeta(value) as unknown as JsonValue,
      },
      presentCall: (args) => callView('设计合规比对', args.design.slice(0, 60)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        const s = season(args.season)
        // 同样用 `||`：空串继续往下找；都没有就退到该赛季的最新版本
        const version =
          args.version ||
          shared(ctx)?.rulesVersion ||
          config.constraintsVersion ||
          (await source().listVersions(s)).at(-1)
        if (!version) {
          throw new Error(`赛季 ${s} 下没有任何规则版本，请先用 rcs_rule_import 导入规则书。`)
        }
        const c = loadConstraints(join(rulesRoot(), s, version, 'constraints.json'))
        return checkDesign(args.design, c)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rcs_rule_import',
      description:
        '导入一份新的 ROBOCON 规则书（.docx），落库到 data/rules/<赛季>/<版本>/。' +
        '每年换主题、赛季内还反复改版，所以这是常规操作而非一次性脚本。' +
        '导入后会自动生成 constraints.json 骨架（数值约束表**需人工填写**，不做自动提取）。' +
        '导入完成后通常紧接着用 rcs_rule_diff 对比上一版。',
      parameters: {
        docxPath: { type: 'string', required: true, description: '规则书 .docx 的路径' },
        season: { type: 'string', required: true, description: '赛季，四位年份，如 2028' },
        version: { type: 'string', required: true, description: '版本名，如 V0 / V1 / abu' },
        overwrite: {
          type: 'boolean',
          description: '该版本已存在时是否覆盖。默认 false —— 已核对过的规则数据被悄悄改掉很难发现',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            season: { type: 'string', description: '赛季' },
            version: { type: 'string', description: '版本' },
            dir: { type: 'string', description: '落库目录' },
            paragraphs: { type: 'integer', description: '提取到的段落数' },
            clauses: { type: 'integer', description: '切分出的条款数' },
            chars: { type: 'integer', description: '全文字符数' },
            constraintsScaffolded: { type: 'boolean', description: '是否新生成了约束表骨架' },
            constraintsPending: { type: 'integer', description: '约束表中仍待填的字段数' },
            overwrote: { type: 'boolean', description: '是否覆盖了已存在的版本' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: renderImport(value as unknown as ImportResult) },
        ],
      },
      presentCall: (args) => callView('导入规则书', `${args.season}/${args.version}`),
      async execute(args) {
        return importRulebook(args.docxPath, rulesRoot(), args.season, args.version, {
          overwrite: args.overwrite === true,
        }) as unknown as never
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rcs_rule_versions',
      description:
        '列出规则库里已有的赛季与版本。不确定该用哪个版本、或想知道能不能做 diff 时先调它。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            seasons: { type: 'json', description: '赛季与其下的版本列表' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: renderVersions(
              value as unknown as { seasons: { season: string; versions: string[] }[] },
            ),
          },
        ],
      },
      presentCall: () => callView('列出规则版本', rulesRoot()),
      async execute() {
        const src = source()
        const seasons = []
        for (const season of src.listSeasons()) {
          try {
            seasons.push({ season, versions: await src.listVersions(season) })
          } catch {
            // 目录存在但没有可用版本，跳过而不是让整个列举失败
          }
        }
        return { seasons }
      },
    }),
  )

  ctx.effect(() => {
    // 规则数据是按需读盘的，没有常驻句柄。
    // 将来若加内存缓存或文件监听，务必在这里注册释放。
    return () => {}
  })
}
