/**
 * 每个工具的返回值都要符合它声明的输出 schema —— **真实 cordis** 装上全部插件后逐个执行。
 *
 * dsh 0.1.5-rc.2 会校验工具返回值：多一个没声明的字段（schema 写了
 * additionalProperties: false），整次调用直接判失败。2026-09-14 在真 dsh 里踩到：
 * rcs_kb_status 返回了 failed / bytes / sources / skippedByType，schema 只声明了三个字段，
 * 一调就报 invalid output；rcs_kb_sync 更糟，把整份镜像 manifest 原样返回。
 * 以前的测试只看 execute 的返回值对不对，没人拿 schema 去比。
 *
 * 校验器是**照一条观测到的报错写的复刻，不是宿主的校验器** —— 锁定版运行时里的实现
 * 没找到可读的源码。语义取自真 dsh 的报错（`"value.failed" is not a declared property
 * (additionalProperties: false)`）：additionalProperties: false 的对象不许有未声明的字段，
 * 顺着 properties / items 逐层往下查，`json` 类型放行。它不管 required、也不查 null ——
 * 宿主可能比它严，所以最终还要在真 dsh 里跑一遍（docs/acceptance-prompts.md 的 C6 / C7）。
 *
 * 联网、要硬件或要 .docx 的工具不真跑：
 *   - rcs_fw_build / rcs_fw_flash / rcs_support_test：用 rcs-core 里同一个函数配假执行器造返回值
 *   - rcs_kb_sync：校验插件导出的 syncOutput 投影
 *   - 见 NOT_EXECUTED：返回值由插件按 schema 字段逐个写出，源码里一眼可查
 * 新加的工具必须在这里有着落，否则「全部工具都覆盖到」那条会红。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'

import { buildFirmware, flashFirmware, runSupportTests } from '../../rcs-core/src/toolchain.ts'
import type { CommandResult, CommandRunner, ProbeDeps } from '../../rcs-core/src/toolchain.ts'
import { DEFAULT_SYNC_POLICY } from '../../rcs-core/src/kb-sync.ts'
import type { SyncResult } from '../../rcs-core/src/kb-sync.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')
const PLUGINS = ['dsh-rcs-core', 'dsh-rcs-rules', 'dsh-rcs-kb', 'dsh-rcs-control', 'dsh-rcs-train'] as const
const lib = (name: string): string => join(REPO, 'packages', name, 'lib', 'index.js')
const TEAM = join(REPO, 'config', 'team.json')
const FW = join(REPO, '..', 'RCS_code')
const ready = PLUGINS.every((n) => existsSync(lib(n))) && existsSync(TEAM)
const hasFirmware = existsSync(join(FW, 'template')) && existsSync(join(FW, 'R2'))

type Schema = {
  type?: string
  enum?: readonly unknown[]
  additionalProperties?: boolean
  properties?: Record<string, Schema>
  items?: Schema
}

/** 照 dsh 输出校验的语义挑错：未声明的字段报「value.x is not a declared property」。 */
function violations(schema: Schema | undefined, value: unknown, path = 'value'): string[] {
  if (schema === undefined || schema.type === 'json' || value === undefined || value === null) return []
  switch (schema.type) {
    case 'array':
      if (!Array.isArray(value)) return [`${path} 应为数组`]
      return value.flatMap((v, i) => violations(schema.items, v, `${path}[${i}]`))
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return [`${path} 应为对象`]
      const props = schema.properties ?? {}
      return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
        if (k in props) return violations(props[k], v, `${path}.${k}`)
        return schema.additionalProperties === false ? [`${path}.${k} is not a declared property`] : []
      })
    }
    case 'string':
      if (typeof value !== 'string') return [`${path} 应为 string`]
      return schema.enum !== undefined && !schema.enum.includes(value) ? [`${path} 不在 enum 里`] : []
    case 'integer':
      return Number.isInteger(value) ? [] : [`${path} 应为 integer`]
    case 'number':
      return typeof value === 'number' ? [] : [`${path} 应为 number`]
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path} 应为 boolean`]
    default:
      return []
  }
}

interface RegisteredTool {
  name: string
  output?: { schema?: Schema }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

const registered = new Map<string, RegisteredTool>()

/** 最小 tools 服务：只收下注册的工具。 */
class FakeTools extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
  register(tool: RegisteredTool): () => void {
    registered.set(tool.name, tool)
    return () => {}
  }
  guard(): () => void {
    return () => {}
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300))
const load = (name: string): Promise<Record<string, unknown>> => import(pathToFileURL(lib(name)).href)
const exec = { signal: new AbortController().signal }

function schemaOf(name: string): Schema | undefined {
  const tool = registered.get(name)
  if (tool === undefined) throw new Error(`${name} 没有注册`)
  return tool.output?.schema
}

async function run(name: string, args: unknown): Promise<string[]> {
  const value = await registered.get(name)!.execute(args, exec)
  return violations(schemaOf(name), value)
}

/** 真跑过的工具。 */
const covered = new Set<string>()

/** 不在这里执行的工具，以及为什么。 */
const NOT_EXECUTED: Record<string, string> = {
  rcs_version_status: '要联网（git ls-remote + npm registry）；返回值是插件里按 summary / stale / items / fromCache 逐个写出的',
  rcs_rule_import: '要一份 .docx；返回值 ImportResult 的字段与 schema 一一对应',
  rcs_train_quiz: '只在培训模式、有真实改动时才走到返回；返回值只有 recorded / text 两个字段',
  rcs_train_hint: '只在学员于问答框里追问之后才走到返回；返回值同样只有 recorded / text 两个字段',
}

let workspace = ''

beforeAll(async () => {
  if (!ready) return
  workspace = mkdtempSync(join(tmpdir(), 'rcs-tool-outputs-'))
  const configs: Record<(typeof PLUGINS)[number], unknown> = {
    'dsh-rcs-core': { teamConfig: TEAM },
    'dsh-rcs-rules': { rulesRoot: '', season: '', constraintsVersion: '' },
    'dsh-rcs-kb': { teamConfig: '', cacheDir: '', appSecretEnv: 'RCS_TOOL_OUTPUTS_NO_SECRET' },
    'dsh-rcs-control': {},
    'dsh-rcs-train': { curriculum: '', workspaceRoot: workspace, student: '' },
  }
  const ctx = new Context()
  ctx.plugin(FakeTools)
  await settle()
  for (const name of PLUGINS) {
    ctx.plugin((await load(name)) as never, configs[name] as never)
    await settle()
  }
}, 60_000)

afterAll(() => {
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

describe.skipIf(!ready)('工具返回值符合输出 schema', () => {
  const offline: [string, unknown][] = [
    ['rcs_team_context', {}],
    ['rcs_team_context', { robot: 'BR' }],
    ['rcs_rule_versions', {}],
    ['rcs_rule_lookup', { query: '11.14' }],
    ['rcs_rule_diff', { fromVersion: 'V0', toVersion: 'V0' }],
    ['rcs_rule_check', { design: 'TR 的气动系统工作气压 0.8MPa，整机重量 55kg，电池 48V' }],
    ['rcs_kb_status', {}],
    ['rcs_kb_search', { query: 'Keil 下载 安装' }],
    ['rcs_rdlc_decode', { hex: 'FF 00 C0 A0 01 05 00 10 01 01 02 00 B4 9F 0C zz C0 A0' }],
    ['rcs_toolchain_status', {}],
    ['rcs_train_task', { taskId: 'ring-buffer' }],
    ['rcs_train_review', { taskId: 'ring-buffer', testsPassed: 3, testsFailed: 6, testFailures: ['RB.PutThenGet'] }],
  ]
  for (const [name, args] of offline) {
    it(`${name} ${JSON.stringify(args)}`, async () => {
      covered.add(name)
      expect(await run(name, args)).toEqual([])
    }, 60_000)
  }

  describe.skipIf(!hasFirmware)('对真实固件仓库', () => {
    const firmware: [string, unknown][] = [
      ['rcs_lint_layer', { projectRoot: FW }],
      ['rcs_template_gap', { projectRoot: FW, includePairing: true }],
      ['rcs_repo_hygiene', { repoRoot: join(FW, 'R2') }],
      ['rcs_lint_embedded', { projectRoot: join(FW, 'template', 'RCS_Template_F407') }],
      ['rcs_angle_loop_check', { projectRoot: join(FW, 'demo', 'RCS', 'RCS_Support') }],
      ['rcs_kinematics_check', { projectRoot: join(FW, 'demo', 'RCS', 'RCS_Support') }],
      ['rcs_train_scaffold', { taskId: 'ring-buffer' }],
    ]
    for (const [name, args] of firmware) {
      it(`${name} ${JSON.stringify(args)}`, async () => {
        covered.add(name)
        expect(await run(name, args)).toEqual([])
      }, 60_000)
    }
  })

  describe('要硬件、联网的工具：同一个函数配假执行器', () => {
    const runner = (code: number, stdout = ''): CommandRunner =>
      (async () => ({ code, stdout, stderr: '' }) as CommandResult) as CommandRunner
    const deps = (present: string[], onPath: string[]): ProbeDeps => ({
      exists: (p) => present.some((x) => p.replace(/\\/g, '/').includes(x)),
      which: (c) => (onPath.includes(c) ? `/usr/bin/${c}` : undefined),
    })

    it('rcs_fw_build：成功带警告、失败只剩日志尾巴', async () => {
      covered.add('rcs_fw_build')
      const project = 'D:/proj/MDK-ARM/RCS_Template_F407.uvprojx'
      const okWithWarnings = await buildFirmware({
        project, run: runner(1), deps: deps(['uvprojx', 'UV4.exe'], []),
        readLog: () => 'a.c(1): warning:  #1: something',
      })
      const failedBare = await buildFirmware({
        project, run: runner(2), deps: deps(['uvprojx', 'UV4.exe'], []), readLog: () => '',
      })
      const blocked = await buildFirmware({ project, run: runner(0), deps: deps([], []), readLog: () => '' })
      for (const r of [okWithWarnings, failedBare, blocked]) expect(violations(schemaOf('rcs_fw_build'), r)).toEqual([])
    })

    it('rcs_fw_flash：只校验、脚本缺失', async () => {
      covered.add('rcs_fw_flash')
      const script = 'D:/code/RCS_code/demo_function_dispatch/tools/swd_flash.py'
      const binary = 'D:/code/RCS_code/demo/MDK-ARM/RCS_Template_F407/RCS_Template_F407.bin'
      const verified = await flashFirmware({
        script, binary, run: runner(0, 'verify ok'), deps: deps(['swd_flash.py', '.bin'], ['python']), write: false,
      })
      const blocked = await flashFirmware({ script, binary, run: runner(0), deps: deps([], []), write: false })
      for (const r of [verified, blocked]) expect(violations(schemaOf('rcs_fw_flash'), r)).toEqual([])
    })

    it('rcs_support_test：WSL 跑通、工具链缺失', async () => {
      covered.add('rcs_support_test')
      const cmake = new TextEncoder().encode('set(GTEST_DIR "/mnt/d/code/RCS_code/x/test/lib")\n')
      const ran = await runSupportTests({
        testDir: 'D:/code/rcs-training/ring-buffer',
        run: runner(0, '[       OK ] RB.PutThenGet (0 ms)\n[  FAILED  ] RB.PeekDoesNotConsume (0 ms)\n'),
        deps: deps(['CMakeLists.txt'], ['wsl']),
        readFileBytes: (p) => (p.replace(/\\/g, '/').endsWith('CMakeLists.txt') ? cmake : undefined),
      })
      const blocked = await runSupportTests({
        testDir: 'D:/x', run: runner(0), deps: deps(['CMakeLists.txt'], []), readFileBytes: () => undefined,
      })
      for (const r of [ran, blocked]) expect(violations(schemaOf('rcs_support_test'), r)).toEqual([])
    })

    it('rcs_kb_sync：交给宿主的是投影，不带整份 manifest', async () => {
      covered.add('rcs_kb_sync')
      const { syncOutput } = (await load('dsh-rcs-kb')) as { syncOutput: (r: SyncResult) => unknown }
      const result: SyncResult = {
        manifest: {
          version: 1,
          syncedAt: '2026-09-14T00:00:00.000Z',
          sources: [{ label: 'A02 电控组(通用)', token: 'fA' }],
          policy: DEFAULT_SYNC_POLICY,
          docs: {},
          skippedByType: { file: 3 },
        },
        stats: { added: 1, updated: 0, unchanged: 2, failed: 1, removed: 0, folders: 5 },
        failures: [{ name: 'x', path: 'A02/x', reason: '权限不足' }],
        permissionHint: { scopes: ['docx:document:readonly'], authLink: 'https://open.feishu.cn/x' },
      }
      const out = syncOutput(result)
      expect(out).not.toHaveProperty('manifest')
      expect(violations(schemaOf('rcs_kb_sync'), out)).toEqual([])
    })
  })

  it('全部工具都有着落：真跑过，或写明了为什么不跑', () => {
    const expected = hasFirmware ? [...registered.keys()] : [...registered.keys()].filter((n) => !isFirmwareTool(n))
    const missing = expected.filter((n) => !covered.has(n) && NOT_EXECUTED[n] === undefined)
    expect(registered.size).toBe(26)
    expect(missing).toEqual([])
  })
})

describe('校验器本身会报错 —— 不然上面全绿也说明不了什么', () => {
  it('照原来只声明三个字段的 rcs_kb_status schema 校验，报出的正是真 dsh 里那四条', () => {
    const before: Schema = {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' }, total: { type: 'number' }, syncedAt: { type: 'string' } },
    }
    const status = {
      ok: true,
      syncedAt: '2026-09-02T13:40:39.961Z',
      total: 44,
      failed: 0,
      bytes: 378180,
      sources: [{ label: 'A02 电控组(通用)', token: 'fA' }],
      skippedByType: { file: 803 },
    }
    expect(violations(before, status)).toEqual([
      'value.failed is not a declared property',
      'value.bytes is not a declared property',
      'value.sources is not a declared property',
      'value.skippedByType is not a declared property',
    ])
  })

  it('逐层往下查：数组元素里多一个字段也报，路径写到那个元素', () => {
    const schema: Schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        findings: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, properties: { rule: { type: 'string' } } },
        },
      },
    }
    expect(violations(schema, { findings: [{ rule: 'a' }, { rule: 'b', extra: 1 }] })).toEqual([
      'value.findings[1].extra is not a declared property',
    ])
  })

  it('类型不对也报', () => {
    const schema: Schema = { type: 'object', additionalProperties: false, properties: { line: { type: 'integer' } } }
    expect(violations(schema, { line: 1.5 })).toEqual(['value.line 应为 integer'])
  })
})

function isFirmwareTool(name: string): boolean {
  return [
    'rcs_lint_layer', 'rcs_template_gap', 'rcs_repo_hygiene', 'rcs_lint_embedded',
    'rcs_angle_loop_check', 'rcs_kinematics_check', 'rcs_train_scaffold',
  ].includes(name)
}
