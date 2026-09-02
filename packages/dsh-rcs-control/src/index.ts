/**
 * dsh-rcs-control —— RCS 电控工程检查的 dsh 适配层。
 *
 * 这一层**刻意做薄**：只负责把 `@rcs/core` 的纯函数包成 dsh Tool、把
 * `@rcs/ui` 的投影接到呈现钩子上，不含任何业务逻辑。
 * dsh 目前是 developer preview（本机 launcher 是不带版本锁的
 * `npx @deepseek-ai/dsh web`，会自己漂到新版），API 变动只会打到这个文件。
 *
 * 本文件用到的 API 均已对照本机 `@deepseek-ai/dsh-tools@0.1.0-rc.6` 的
 * `lib/types/*.d.ts` 核实，并通过 `tsc --noEmit` 全量类型检查：
 *   - defineTool<S, O>(options): ToolDefinition
 *   - ctx.tools.register(def): () => void        // 返回 disposer，插件卸载自动反注册
 *   - parameters: { [key]: ValueSchemaSpec & { required?: true } }
 *     注册后会被**归一成 JSON Schema**：必填项落到顶层 `required: string[]`，
 *     写入时的 `required: true` 标志不再保留。按后者去反查会一个都查不到。
 *     另：presentCall/presentResult 对参数做**软校验** —— 必填项缺失时返回
 *     undefined 并退回通用卡片，而不是抛错。
 *   - output.schema 为 object 时 additionalProperties 是**必填**
 *   - execute(args, exec) 必须返回 Promise
 *   - ContentBlock.type ∈ 'text'|'reasoning'|'image'|'tool-call'|'tool-result'
 *   - presentCall/presentResult 必须是**纯函数**：实时与回放都会调用
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView, ToolResult, JsonValue } from '@deepseek-ai/dsh-tools'

import type { CheckResult } from '../../rcs-core/src/types.ts'
import { loadJsonConfig } from '../../rcs-core/src/index.ts'
import { lintLayers } from '../../rcs-core/src/layer-lint.ts'
import type { LayerRulesConfig } from '../../rcs-core/src/layer-lint.ts'
import { checkTemplateGap, checkSupportPairing } from '../../rcs-core/src/template-gap.ts'
import type { TemplateManifest } from '../../rcs-core/src/template-gap.ts'
import { checkRepoHygiene } from '../../rcs-core/src/repo-hygiene.ts'
import { lintEmbedded } from '../../rcs-core/src/lint-embedded.ts'
import { decodeRdlc, parseHexBytes, toHex } from '../../rcs-core/src/rdlc.ts'
import { checkAngleLoop, checkKinematics } from '../../rcs-core/src/kin-check.ts'
import {
  probeToolchain, probeWslToolchain, buildFirmware, runSupportTests, flashFirmware,
} from '../../rcs-core/src/toolchain.ts'
import type { BuildResult, TestOutcome, FlashResult, ToolStatus } from '../../rcs-core/src/toolchain.ts'
import { nodeRunner, nodeDeps } from '../../rcs-core/src/runner.ts'
import {
  repoPaths, resolveFirmwareRoot, firmwareNotFoundMessage,
} from '../../rcs-core/src/paths.ts'

import {
  toPresentationMeta, isRcsMeta, TONE_MARK, severityTone, statsLine,
} from '../../rcs-ui/src/index.ts'
import type { CheckResultLike } from '../../rcs-ui/src/index.ts'

export const name = 'rcs-control'
export const inject = ['tools']

export interface Config {
  /** 被检查工程的默认根目录，工具参数可覆盖。 */
  projectRoot: string
  /** 规则与清单 JSON 所在目录。 */
  configDir: string
  /** Keil 工程文件（.uvprojx）。留空则由工具参数给。 */
  keilProject: string
  /** UV4.exe 路径。留空则按常见安装位置探测。 */
  uv4: string
  /** `RCS_Support/test` 目录，PC 单元测试用。 */
  supportTestDir: string
  /** `upper_host_cli/swd_flash.py` 路径。 */
  flashScript: string
}

export const Config: Schema<Config> = Schema.object({
  // 以下路径默认全部留空 —— 写死绝对路径在别人机器上一个都不存在。
  // 留空时按 rcs-core/paths.ts 的解析链去找，找不到会明确报错并列出找过哪里。
  projectRoot: Schema.string().default(''),
  configDir: Schema.string().default(''),
  keilProject: Schema.string().default(''),
  uv4: Schema.string().default(''),
  supportTestDir: Schema.string().default(''),
  flashScript: Schema.string().default(''),
})

/** findings 的输出 schema。object 节点必须显式声明 additionalProperties。 */
const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rule: { type: 'string', description: '规则 ID' },
    severity: { type: 'string', enum: ['error', 'warn', 'info'], description: '严重级别' },
    message: { type: 'string', description: '一句话说明' },
    file: { type: 'string', description: '相对路径' },
    line: { type: 'integer', description: '行号' },
    detail: { type: 'string', description: '补充细节，如传递依赖链' },
  },
} as const

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    check: { type: 'string', description: '检查器名' },
    target: { type: 'string', description: '被检查目录' },
    ok: { type: 'boolean', description: '无 error 级发现即为 true' },
    stats: { type: 'json', description: '计数统计' },
    findings: { type: 'array', items: FINDING_SCHEMA, description: '全部发现' },
  },
} as const

/**
 * 把结构化结果渲染成给模型看的紧凑文本。太长会挤占上下文，故限量。
 *
 * 参数收**宽松类型**：`render` 拿到的 value 由 schema 反推，字段全是可选的
 * （`InferValue` 不会因为业务上"一定有值"就标成必填）。这里全程给默认值，
 * 而不是断言成严格类型 —— 渲染钩子按契约不得抛异常。
 */
function renderResult(r: CheckResultLike, limit = 40): string {
  const findings = r.findings ?? []
  const head = `[${r.ok ? 'PASS' : 'FAIL'}] ${r.check ?? ''}  ${r.target ?? ''}`
  const stats = statsLine(r.stats)

  if (findings.length === 0) return `${head}\n${stats}\n无发现。`

  const shown = findings.slice(0, limit).map((f) => {
    const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''
    const mark = TONE_MARK[severityTone(f.severity)]
    return `${mark} [${f.rule ?? '?'}] ${f.message ?? ''}${loc}${f.detail ? `\n    ${f.detail}` : ''}`
  })
  const more = findings.length > limit ? `\n… 另有 ${findings.length - limit} 条未列出` : ''
  return `${head}\n${stats}\n${shown.join('\n')}${more}`
}

/**
 * 待执行的调用卡片。
 * kind 用 'search' —— 这些检查在语义上就是「在工程里找问题」，
 * 让 UI 复用搜索类的图标与卡片处理。
 */
function checkCallView(title: string, target: string): ToolCallView {
  return { card: 'generic', title, kind: 'search', rawInput: target }
}

/**
 * 完成后的结果卡片。
 *
 * findings 天然是「文件 + 行号 + 说明」的分组结构，正好对上 dsh 的搜索卡片，
 * 于是能白拿到按文件折叠、点击跳转的原生交互 —— 比塞一堆纯文本强得多。
 * 数据走 result.meta（由 output.presentationMeta 持久化到会话日志），
 * 这样**回放历史会话时卡片依然完整**，而不是退化成一段纯文本。
 */
function checkResultView(result: ToolResult): ToolResultView | undefined {
  const meta = result.meta
  if (!isRcsMeta(meta)) return undefined // 元数据不可用时回退到通用渲染

  if (meta.groups.length === 0) {
    return { card: 'generic', title: `${meta.check} — 通过，无发现` }
  }

  return {
    card: 'search',
    shape: 'matches',
    title: `${meta.check} — ${meta.ok ? '通过' : '未通过'}`,
    files: meta.groups.map((g) => ({ path: g.path, matches: g.matches })),
    truncated: meta.truncated,
    total: meta.total,
  }
}

// ---------- 协议与工具链的渲染 ----------

type RdlcOut = {
  decoded?: {
    frame?: { src?: number; dst?: number; payload?: number[]; offset?: number }
    payload?: Record<string, unknown>
    direction?: string
  }[]
  errors?: { offset?: number; reason?: string; bytes?: number[] }[]
  pending?: number
  badTokens?: string[]
}

/** 十六进制两位。渲染钩子里用，故不抛异常。 */
const hx = (n: unknown): string =>
  typeof n === 'number' ? n.toString(16).padStart(2, '0').toUpperCase() : '??'

function renderRdlc(v: RdlcOut): string {
  const decoded = v.decoded ?? []
  const errors = v.errors ?? []
  const lines: string[] = [`解析出 ${decoded.length} 帧，${errors.length} 处错误`]

  if (v.badTokens?.length) {
    lines.push(`忽略了无法识别的 token：${v.badTokens.slice(0, 8).join(' ')}`)
  }

  for (const d of decoded.slice(0, 20)) {
    const p = d.payload ?? {}
    const kind = String(p['kind'] ?? '?')
    const head = `@${d.frame?.offset ?? '?'}  ${d.direction ?? ''}`
    if (kind === 'command') {
      lines.push(
        `${head}  命令 seq=${p['sequence']} 模块=${p['moduleName']} 操作=0x${hx(p['operation'])}` +
          `  数据 ${(p['data'] as number[] | undefined)?.length ?? 0} 字节`,
      )
    } else if (kind === 'feedback') {
      lines.push(
        `${head}  反馈 seq=${p['sequence']} 模块=${p['moduleName']} 状态=${p['statusName']}` +
          `  echo ${(p['echo'] as number[] | undefined)?.length ?? 0} / report ${(p['report'] as number[] | undefined)?.length ?? 0} 字节`,
      )
    } else if (kind === 'error') {
      lines.push(`${head}  载荷解析失败：${p['reason']}`)
    } else {
      lines.push(`${head}  未知载荷，首字节 0x${hx(p['first'])}`)
    }
  }
  if (decoded.length > 20) lines.push(`… 另有 ${decoded.length - 20} 帧未列出`)

  for (const e of errors.slice(0, 10)) {
    lines.push(`✗ 偏移 ${e.offset}：${e.reason}`)
    if (e.bytes?.length) lines.push(`    ${toHex(e.bytes)}`)
  }
  if (v.pending) lines.push(`尾部还有 ${v.pending} 字节不完整 —— 可能是抓包截断，或帧还没收全`)

  return lines.join('\n')
}

/**
 * 按**能力**给结论，而不是数「缺几项」。
 *
 * 光数个数会误导：Windows 侧没有 cmake 完全不影响 PC 测试 ——
 * 队内 gtest 是 Linux 产物，那条链路本来就只能在 WSL 里跑。
 * 人关心的是「我现在能做什么」，不是「清单上有几个叉」。
 */
function renderToolchain(tools: ToolStatus[]): string {
  const has = (id: string): boolean => tools.find((t) => t.id === id)?.available === true
  const lines = tools.map((t) => {
    const mark = t.available ? '✅' : '❌'
    const where = t.path ? `  ${t.path}` : ''
    const hint = !t.available && t.hint ? `\n    ${t.hint}` : ''
    return `${mark} ${t.label}${where}${hint}`
  })

  // PC 测试只要 WSL 那套齐了就行；Windows 侧的 cmake 是另一条可选路径
  const canTest = (has('wsl') && has('wsl-cmake') && has('wsl-g++') && has('wsl-make')) || has('cmake')
  const caps = [
    { ok: has('keil'), name: 'rcs_fw_build（Keil 构建）' },
    { ok: canTest, name: 'rcs_support_test（PC 单元测试）' },
    { ok: has('python'), name: 'rcs_fw_flash（SWD 烧录）' },
  ]
  const verdict = caps.map((c) => `  ${c.ok ? '✅' : '❌'} ${c.name}`).join('\n')
  const blocked = caps.filter((c) => !c.ok).length

  return (
    `${lines.join('\n')}\n\n当前可用的工具：\n${verdict}\n\n` +
    (blocked === 0 ? '三条链路都通。' : `${blocked} 条链路不可用，按上面的提示补齐即可。`)
  )
}

function renderBuild(r: BuildResult): string {
  if (r.blocked) return `构建未开始：${r.blocked}`
  const head =
    `[${r.ok ? 'PASS' : 'FAIL'}] Keil 构建  ${r.project}\n` +
    `退出码 ${r.exitCode} —— ${r.verdict}\n错误 ${r.errors}  警告 ${r.warnings}`
  const hint = r.hint ? `\n\n⚠️ ${r.hint}` : ''
  const where = r.logFile ? `\n完整日志：${r.logFile}` : ''
  const diags = r.diagnostics ?? []

  if (diags.length === 0) {
    // 失败却没有诊断时，把日志末尾原样附上 ——
    // 「失败但说不出原因」是最糟的输出，会逼人去手工翻日志，那这工具就白做了
    const tail = r.logTail ? `\n\n日志末尾：\n${r.logTail}` : '\n（日志里没有解析出诊断）'
    return `${head}${hint}${tail}${where}`
  }

  // 错误优先，警告其次 —— 一屏之内先看到该修的
  const sorted = [...diags].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  const shown = sorted.slice(0, 40).map((d) => {
    const loc = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : '(无位置)'
    return `${d.severity === 'error' ? '✗' : '⚠'} ${loc}  ${d.code ?? ''} ${d.message}`
  })
  const more = sorted.length > 40 ? `\n… 另有 ${sorted.length - 40} 条` : ''
  return `${head}${hint}\n${shown.join('\n')}${more}${where}`
}

function renderTests(r: TestOutcome): string {
  if (r.blocked) return `测试未开始：\n${r.blocked}`
  const head = `[${r.ok ? 'PASS' : 'FAIL'}] PC 单元测试（${r.mode ?? '?'} 模式）\n通过 ${r.passed}  失败 ${r.failed}`
  if (!r.failures?.length) return head
  return `${head}\n${r.failures.slice(0, 30).map((f) => `✗ ${f.name}`).join('\n')}`
}

function renderFlash(r: FlashResult): string {
  if (r.blocked) return `烧录未开始：${r.blocked}`
  const action = r.wrote ? '已写入并校验' : '仅校验（未写入）'
  const head = `[${r.ok ? 'OK' : 'FAIL'}] ${action}  ${r.binary}`
  const tail = r.wrote
    ? '\n⚠️ 片子已被改写。软件停止不能替代硬件急停、驱动使能线和限位保护。'
    : ''
  return `${head}\n${(r.output ?? '').slice(0, 2000)}${tail}`
}

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
  /**
   * 固件工程根目录：工具参数 > core 共享配置 > 插件配置 > 环境变量 > 同级发现。
   *
   * 全都解析不到时**明确报错并列出找过哪里** —— 猜一个路径比报错危险，
   * 拿错工程做检查，结论看着正常但完全不对。
   */
  const root = (override?: string): string => {
    const explicit = override || shared(ctx)?.projectRoot || config.projectRoot
    const r = resolveFirmwareRoot(explicit ? { explicit } : {})
    if (!r.ok) throw new Error(firmwareNotFoundMessage(r.tried))
    return r.root
  }

  /** 规则与清单 JSON：插件配置 > 本仓库的 config/ 目录。 */
  const configDir = (): string => config.configDir || repoPaths.config()

  const layerRules = (): LayerRulesConfig =>
    loadJsonConfig<LayerRulesConfig>(join(configDir(), 'layer-rules.json'))
  const manifest = (): TemplateManifest =>
    loadJsonConfig<TemplateManifest>(join(configDir(), 'template-manifest.json'))

  /**
   * 工具链相关路径：配置给了就用，否则从固件仓库根派生。
   *
   * 派生而不是写死，是因为这些文件都在固件仓库内部、相对位置是稳定的，
   * 而固件仓库本身在哪台机器上都不一样。
   */
  const keilProject = (o?: string): string =>
    o || config.keilProject || join(root(), 'demo', 'MDK-ARM', 'RCS_Template_F407.uvprojx')
  const supportTestDir = (o?: string): string =>
    o || config.supportTestDir || join(root(), 'demo', 'RCS', 'RCS_Support', 'test')
  const flashScript = (): string =>
    config.flashScript || join(root(), 'upper_host_cli', 'swd_flash.py')

  /**
   * 给呈现钩子用的安全版本。
   *
   * `presentCall` 按契约**不得抛异常**（实时与回放都会调用），而路径解析在
   * 固件仓库找不到时是会抛的 —— 直接调会把整条消息的渲染搞崩。
   */
  /** 同理：presentCall 里解析工程根目录也不能抛。 */
  const rootSafe = (o?: string): string => {
    try {
      return root(o)
    } catch {
      return '(未找到固件工程)'
    }
  }

  const keilProjectSafe = (o?: string): string => {
    try {
      return keilProject(o)
    } catch {
      return '(未找到固件工程)'
    }
  }
  const supportTestDirSafe = (o?: string): string => {
    try {
      return supportTestDir(o)
    } catch {
      return '(未找到固件工程)'
    }
  }

  ctx.tools.register(
    defineTool({
      name: 'rcs_lint_layer',
      description:
        '检查 RCS 固件工程的分层红线：RCS_Support 是否依赖 HAL/RTOS（含传递依赖）、' +
        '执行器是否继承 rcs_actor 挂入执行器总线、主题代码是否混进跨赛季库 RCS/。' +
        '这些约定原本只写在 请读我.txt 里，本工具把它变成可验证的检查。',
      parameters: {
        projectRoot: {
          type: 'string',
          description: '固件工程根目录，省略则用插件配置里的默认值',
        },
      },
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
        presentationMeta: (_args, value) => toPresentationMeta(value) as unknown as JsonValue,
      },
      presentCall: (args) => checkCallView('分层红线检查', rootSafe(args.projectRoot)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        return lintLayers(root(args.projectRoot), layerRules())
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rcs_template_gap',
      description:
        '比对 请读我.txt 规划的 18 个例程与 RCS_Template/ 下的实际文件，列出缺口。' +
        '例程缺一个，新人培养链就断一节；标记为 critical 的缺失会升级为 error。',
      parameters: {
        projectRoot: { type: 'string', description: '固件工程根目录，省略则用默认值' },
        includePairing: {
          type: 'boolean',
          description: '同时检查 RCS_Support 的头源配对（默认 false）',
        },
      },
      output: {
        schema: { type: 'array', items: RESULT_SCHEMA, description: '一个或两个检查结果' },
        render: (_args, value) => [
          { type: 'text', text: value.map((r) => renderResult(r)).join('\n\n') },
        ],
        // 数组结果只投影第一项（例程缺口）；配对检查作为附加信息留在文本里
        presentationMeta: (_args, value) =>
          (value[0] ? toPresentationMeta(value[0]) : null) as unknown as JsonValue,
      },
      presentCall: (args) => checkCallView('例程缺口比对', rootSafe(args.projectRoot)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        const r = root(args.projectRoot)
        const m = manifest()
        const out: CheckResult[] = [checkTemplateGap(r, m)]
        if (args.includePairing) out.push(checkSupportPairing(r, m))
        return out
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rcs_repo_hygiene',
      description:
        '检查仓库卫生：是否缺 .gitignore、是否有 Keil 个人配置（*.uvguix）、' +
        '编译产物（OBJ/、Listings/）、编辑残留（*.orig）等本不该入库的文件。',
      parameters: {
        repoRoot: { type: 'string', description: '仓库根目录，省略则用默认值' },
      },
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
        presentationMeta: (_args, value) => toPresentationMeta(value) as unknown as JsonValue,
      },
      presentCall: (args) => checkCallView('仓库卫生检查', rootSafe(args.repoRoot)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        return checkRepoHygiene(root(args.repoRoot))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rcs_lint_embedded',
      description:
        '嵌入式代码规范检查：中断里禁 printf/malloc/阻塞延时、必须用 FromISR 变体、' +
        '跨中断共享标志位要加 volatile、临界区配对、看门狗喂狗位置，' +
        '以及**急停回路是否可能被软件旁路**（规则 12.2 要求红色急停按钮为硬件回路）。' +
        '默认排除 HAL/CMSIS 等厂商代码，只查队内代码。' +
        '可用行内注释 `// rcs-lint-ignore: <规则id> <理由>` 就地豁免。',
      parameters: {
        projectRoot: { type: 'string', description: '固件工程根目录，省略则用默认值' },
        includeDirs: {
          type: 'array',
          items: { type: 'string' },
          description: '只检查这些子目录（相对工程根），如 ["RCS/user"]；省略则查全部队内代码',
        },
      },
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
        presentationMeta: (_args, value) => toPresentationMeta(value) as unknown as JsonValue,
      },
      presentCall: (args) => checkCallView('嵌入式规范检查', rootSafe(args.projectRoot)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        return lintEmbedded(root(args.projectRoot), {
          ...(args.includeDirs?.length ? { includeDirs: args.includeDirs } : {}),
        })
      },
    }),
  )

  // ---------- 协议与解算（L0，纯读） ----------

  ctx.tools.register(
    defineTool({
      name: 'rcs_rdlc_decode',
      description:
        '解析 RDLC 协议字节流（队内上下位机通信）：帧头 0xC0 / 地址 / 长度 / ' +
        'CRC16-MODBUS / 帧尾 0x0C，并解释命令(0x10)与反馈(0x90)载荷。' +
        '接受各种抓包格式的十六进制文本。坏帧会单独报出偏移与原始字节，并能重新同步。',
      parameters: {
        hex: { type: 'string', required: true, description: '十六进制字节，如 "C0 A0 01 05 00 ..."' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            decoded: { type: 'json', description: '解析出的帧' },
            errors: { type: 'json', description: '坏帧及原因' },
            pending: { type: 'integer', description: '尾部不完整的字节数' },
            badTokens: { type: 'json', description: '无法解析的十六进制 token' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderRdlc(value as never) }],
      },
      // 呈现钩子不得抛异常：回放历史会话时也会调用它，届时 args 可能不完整。
      // 直接写 args.hex.slice() 会在 hex 缺失时炸掉整条消息的渲染。
      presentCall: (args) => {
        const hex = String(args?.hex ?? '')
        return checkCallView('解析 RDLC 报文', hex.length > 40 ? `${hex.slice(0, 40)}…` : hex)
      },
      async execute(args) {
        const { bytes, bad } = parseHexBytes(args.hex)
        const r = decodeRdlc(bytes)
        return { ...r, badTokens: bad } as unknown as never
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rcs_angle_loop_check',
      description:
        '检查舵轮角度回环。典型错误是 inv_kin 的 atan2 输出（弧度）直接进了 ' +
        'angle_loop（角度制），使回环退化为空操作 —— 代码照跑、不报错，' +
        '但舵轮过 ±180° 时会走远路擦地卡死。',
      parameters: { projectRoot: { type: 'string', description: '工程根目录，省略用默认' } },
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderResult(value as CheckResultLike) }],
        presentationMeta: (_args, value) => toPresentationMeta(value as CheckResultLike) as never,
      },
      presentCall: (args) => checkCallView('检查角度回环', rootSafe(args.projectRoot)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        return checkAngleLoop(root(args.projectRoot)) as unknown as never
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rcs_kinematics_check',
      description:
        '检查底盘运动学：inv_kin 的结果是否漏了 find_nearest（最短路）、' +
        '解算函数是否返回了未初始化的栈内存、条件里 ||/&& 优先级混用、' +
        '重心修正 bias_x/bias_y 是否未设。',
      parameters: { projectRoot: { type: 'string', description: '工程根目录，省略用默认' } },
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderResult(value as CheckResultLike) }],
        presentationMeta: (_args, value) => toPresentationMeta(value as CheckResultLike) as never,
      },
      presentCall: (args) => checkCallView('检查底盘运动学', rootSafe(args.projectRoot)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        return checkKinematics(root(args.projectRoot)) as unknown as never
      },
    }),
  )

  // ---------- 工具链（L0 探测 / L1 构建与测试 / L2 烧录） ----------

  ctx.tools.register(
    defineTool({
      name: 'rcs_toolchain_status',
      description:
        '探测本机工具链：Keil UV4、CMake、Python、WSL。构建/测试/烧录跑不起来时先查这个 —— ' +
        '缺什么会直接给出安装命令。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { tools: { type: 'json', description: '各工具的可用性与路径' } },
        },
        render: (_args, value) => [
          { type: 'text', text: renderToolchain((value as { tools?: ToolStatus[] }).tools ?? []) },
        ],
      },
      presentCall: () => checkCallView('探测工具链', '本机'),
      async execute() {
        const windows = probeToolchain(nodeDeps)
        // WSL 里装了什么，Windows 侧的 PATH 看不到。PC 测试只能在 WSL 跑，
        // 不查这一层就会得出「CMake 缺失」的相反结论。
        const hasWsl = windows.find((t) => t.id === 'wsl')?.available === true
        const wsl = hasWsl ? await probeWslToolchain(nodeRunner) : []
        return { tools: [...windows, ...wsl] } as unknown as never
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rcs_support_test',
      description:
        '跑 RCS_Support 的 PC 单元测试（CMake + gtest），**不需要任何硬件** —— 这是 CI 的核心。' +
        '注意队内仓库里的 gtest 静态库是 Linux 产物，Windows 上须经 WSL 构建；' +
        '环境不齐时会说清缺什么、怎么装，而不是抛一个看不懂的错。',
      parameters: { testDir: { type: 'string', description: 'RCS_Support/test 目录，省略用默认' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', description: '全部通过' },
            passed: { type: 'integer', description: '通过数' },
            failed: { type: 'integer', description: '失败数' },
            failures: { type: 'json', description: '失败用例' },
            blocked: { type: 'string', description: '无法开始的原因' },
            mode: { type: 'string', description: 'native 或 wsl' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderTests(value as TestOutcome) }],
      },
      presentCall: (args) => checkCallView('跑 PC 单元测试', supportTestDirSafe(args.testDir)),
      async execute(args) {
        return (await runSupportTests({
          testDir: supportTestDir(args.testDir),
          run: nodeRunner,
          deps: nodeDeps,
        })) as unknown as never
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rcs_fw_build',
      description:
        '用 Keil UV4 构建固件，编译错误结构化返回（文件:行:原因）。' +
        '注意 UV4 退出码 1 表示「有警告但成功」，本工具据此判定，不会把有警告的成功报成失败。',
      parameters: {
        project: { type: 'string', description: '.uvprojx 路径，省略用默认' },
        target: { type: 'string', description: '工程内的 Target 名，省略用工程默认' },
        rebuild: { type: 'boolean', description: '完整重建而非增量' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', description: '构建是否成功' },
            exitCode: { type: 'integer', description: 'UV4 退出码' },
            verdict: { type: 'string', description: '退出码的人话解释' },
            project: { type: 'string', description: '工程文件' },
            errors: { type: 'integer', description: '错误数' },
            warnings: { type: 'integer', description: '警告数' },
            diagnostics: { type: 'json', description: '结构化诊断' },
            blocked: { type: 'string', description: '无法开始的原因' },
            hint: { type: 'string', description: '环境类失败的定性说明，如 license 未激活' },
            logTail: { type: 'string', description: '一条诊断都没解析出来时的日志末尾' },
            logFile: { type: 'string', description: '完整日志路径' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderBuild(value as BuildResult) }],
      },
      presentCall: (args) => checkCallView('构建固件', keilProjectSafe(args.project)),
      async execute(args) {
        return (await buildFirmware({
          project: keilProject(args.project),
          ...(config.uv4 ? { uv4: config.uv4 } : {}),
          ...(args.target ? { target: args.target } : {}),
          rebuild: args.rebuild === true,
          run: nodeRunner,
          deps: nodeDeps,
        })) as unknown as never
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rcs_fw_flash',
      description:
        '烧录固件到 STM32F407（复用队内 upper_host_cli/swd_flash.py，pyOCD + SWD）。' +
        '**默认只校验不写入**，write=true 才真正改写片子。' +
        '整个工具按 L2 物理动作管控：接调试器会 halt 住 MCU，若此时机器人上电且电机使能，' +
        '急停逻辑随之停止运行。执行前请确认周围无人、机构行程内无手、气路已泄压。',
      parameters: {
        binary: { type: 'string', description: '.bin 路径，省略用脚本默认' },
        write: { type: 'boolean', description: 'true 才真正写入；默认只校验' },
        target: { type: 'string', description: '芯片型号，默认 stm32f407vgtx' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', description: '是否成功' },
            wrote: { type: 'boolean', description: '是否真的写了片子' },
            binary: { type: 'string', description: '固件文件' },
            output: { type: 'string', description: '脚本输出' },
            blocked: { type: 'string', description: '无法开始的原因' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderFlash(value as FlashResult) }],
      },
      presentCall: (args) =>
        checkCallView(args.write ? '烧录固件（写入）' : '校验固件（只读）', args.binary ?? '(脚本默认)'),
      async execute(args) {
        return (await flashFirmware({
          script: flashScript(),
          ...(args.binary ? { binary: args.binary } : {}),
          ...(args.target ? { target: args.target } : {}),
          write: args.write === true,
          run: nodeRunner,
          deps: nodeDeps,
        })) as unknown as never
      },
    }),
  )

  ctx.effect(() => {
    // 检查器都是无状态纯函数，没有需要释放的资源。
    // 构建/烧录用的子进程由 nodeRunner 自己管超时与回收。
    // 将来加**常驻**串口/调试器连接时，务必在此注册释放逻辑，
    // 否则 HMR 之后句柄会泄漏、串口被占。
    return () => {}
  })
}
