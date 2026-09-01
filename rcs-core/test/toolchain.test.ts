/**
 * 工具链层测试 —— 全部用假执行器，不碰 Keil、不碰烧录器、不碰 cmake。
 *
 * 这正是把执行器做成可注入的理由：真正容易写错的是参数拼装、输出解析、
 * 失败分类，这些不需要真硬件就能逐条验证。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

import {
  probeToolchain, parseKeilLog, buildFirmware, UV4_EXIT, KEIL_CANDIDATES,
  archiveObjectFormat, parseGtestOutput, runSupportTests, flashFirmware, classifyBuildFailure,
  classifyTestFailure, toWslPath, projectCompilerVersion, keilBundledCompilers, probeWslToolchain,
} from '../src/toolchain.ts'
import type { CommandResult, CommandRunner, ProbeDeps } from '../src/toolchain.ts'

/** 造一个假执行器：按命令名返回预设结果，并记录调用。 */
function fakeRunner(
  responses: Record<string, Partial<CommandResult>> = {},
): CommandRunner & { calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = []
  const fn = (async (command: string, args: string[]) => {
    calls.push({ command, args })
    const key = Object.keys(responses).find((k) => command.includes(k) || args.some((a) => a.includes(k)))
    return { code: 0, stdout: '', stderr: '', ...(key ? responses[key] : {}) } as CommandResult
  }) as CommandRunner & { calls: { command: string; args: string[] }[] }
  fn.calls = calls
  return fn
}

const depsWith = (present: string[], onPath: string[] = []): ProbeDeps => ({
  exists: (p) => present.some((x) => p.replace(/\\/g, '/').includes(x)),
  which: (c) => (onPath.includes(c) ? `/usr/bin/${c}` : undefined),
})

describe('probeToolchain', () => {
  it('全都有时逐项标记可用', () => {
    const r = probeToolchain(depsWith(['UV4.exe'], ['cmake', 'python', 'wsl']))
    expect(r.every((t) => t.available)).toBe(true)
  })

  it('缺失项必须给出可操作的下一步，不能只说「没有」', () => {
    const r = probeToolchain(depsWith([], []))
    for (const t of r.filter((x) => !x.available)) {
      expect(t.hint, `${t.id} 缺失时应有 hint`).toBeTruthy()
    }
    expect(r.find((t) => t.id === 'cmake')?.hint).toMatch(/winget|apt/)
    // 提示必须包含 apt update：全新 WSL 实例包列表为空，
    // 直接 apt install 会报「Unable to locate package」—— 用户实测踩到过
    expect(r.find((t) => t.id === 'cmake')?.hint).toContain('apt update')
    // 走代理的机器上 sudo 会清掉 http_proxy，apt update 会满屏 Ign —— 提示要覆盖这个失败模式
    expect(r.find((t) => t.id === 'cmake')?.hint).toContain('Ign')
  })

  it('Keil 未找到时列出查过哪些路径 —— 便于判断是否装在别处', () => {
    const hint = probeToolchain(depsWith([])).find((t) => t.id === 'keil')?.hint ?? ''
    for (const c of KEIL_CANDIDATES) expect(hint).toContain(c)
  })

  it('python3 也算数', () => {
    const r = probeToolchain(depsWith([], ['python3']))
    expect(r.find((t) => t.id === 'python')?.available).toBe(true)
  })
})

describe('parseKeilLog', () => {
  it('解析带行号的编译错误', () => {
    const d = parseKeilLog('..\\RCS\\user\\main.c(42): error:  #20: identifier "foo" is undefined')
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ severity: 'error', line: 42, code: '#20' })
    expect(d[0]?.file).toContain('main.c')
    expect(d[0]?.message).toContain('undefined')
  })

  it('解析警告', () => {
    const d = parseKeilLog('.\\src\\a.c(10): warning:  #177-D: variable "x" was declared but never referenced')
    expect(d[0]?.severity).toBe('warning')
    expect(d[0]?.code).toBe('#177-D')
  })

  it('解析链接器错误（无行号）', () => {
    const d = parseKeilLog('.\\out\\x.axf: Error: L6218E: Undefined symbol foo')
    expect(d[0]).toMatchObject({ severity: 'error', code: 'L6218E' })
    expect(d[0]?.line).toBeUndefined()
  })

  it('忽略普通日志行，不硬凑', () => {
    expect(parseKeilLog('Build target \'RCS\'\nlinking...\nProgram Size: Code=1234')).toEqual([])
  })

  it('解析工具级错误（无文件无行号）—— 实测踩到的漏网之鱼', () => {
    const d = parseKeilLog('armclang: error: No license checking back-end registered with id Keil.mdkstd')
    expect(d).toHaveLength(1)
    expect(d[0]?.severity).toBe('error')
    expect(d[0]?.code).toBe('armclang')
    expect(d[0]?.file).toBeUndefined()
  })

  it('工具级错误按每个源文件重复时要去重', () => {
    const log = Array.from({ length: 30 }, () => 'armclang: error: No license checking back-end').join('\n')
    expect(parseKeilLog(log)).toHaveLength(1)
  })

  it('折叠的 In-file-included-from 行：取行尾那个真正的诊断，不是行首', () => {
    // 实测踩到：Keil 把包含链折叠成一行，行首是 app_main.cpp 的 warning，
    // 行尾才是 host_link.cpp 的 error。只看行首会报「错误 0」而构建其实失败。
    const line =
      '../RCS/user/app_main.cpp(30): warning: In file included from...../RCS/user\\host_link.cpp(89): ' +
      "error: non-constant-expression cannot be narrowed from type 'unsigned int' to 'uint8_t' in initializer list"
    const d = parseKeilLog(line)
    expect(d).toHaveLength(1)
    expect(d[0]?.severity).toBe('error')
    expect(d[0]?.line).toBe(89)
    expect(d[0]?.file).toContain('host_link.cpp')
    // 折叠说明文字（`In file included from.....`）要整段切掉，只留真实路径
    expect(d[0]?.file).not.toContain('In file included')
    expect(d[0]?.file?.startsWith('.')).toBe(false)
    expect(d[0]?.file).toBe('RCS/user\\host_link.cpp')
  })

  it('note 行不单独成条 —— 它只是补充说明', () => {
    expect(parseKeilLog('../RCS/user/host_link.cpp(89): note: insert an explicit cast to silence this issue')).toEqual([])
  })

  it('普通单层诊断不受影响', () => {
    const d = parseKeilLog('../RCS/RCS_Support/src/easy_filters.c(31): warning: use of NaN [-Wnan-infinity-disabled]')
    expect(d[0]).toMatchObject({ severity: 'warning', line: 31 })
    expect(d[0]?.file).toContain('easy_filters.c')
  })

  it('混合日志里错误与警告各归各位', () => {
    const d = parseKeilLog(
      ['a.c(1): warning:  #1: w1', 'b.c(2): error:  #2: e1', 'noise', 'c.c(3): error:  #3: e2'].join('\n'),
    )
    expect(d.filter((x) => x.severity === 'error')).toHaveLength(2)
    expect(d.filter((x) => x.severity === 'warning')).toHaveLength(1)
  })
})

describe('buildFirmware', () => {
  const project = 'D:/proj/MDK-ARM/RCS_Template_F407.uvprojx'
  const deps = depsWith(['uvprojx', 'UV4.exe'])

  it('退出码 1 是「有警告」，仍算构建成功 —— 不能一律把非 0 当失败', async () => {
    const r = await buildFirmware({
      project, run: fakeRunner({ UV4: { code: 1 } }), deps,
      readLog: () => 'a.c(1): warning:  #1: something',
    })
    expect(r.ok).toBe(true)
    expect(r.warnings).toBe(1)
    expect(r.verdict).toBe(UV4_EXIT[1])
  })

  it('退出码 2 是有错误', async () => {
    const r = await buildFirmware({
      project, run: fakeRunner({ UV4: { code: 2 } }), deps,
      readLog: () => 'a.c(9): error:  #20: bad',
    })
    expect(r.ok).toBe(false)
    expect(r.errors).toBe(1)
  })

  it('必须用 -o 把日志落盘 —— UV4 不往 stdout 打诊断', async () => {
    const run = fakeRunner()
    await buildFirmware({ project, run, deps, readLog: () => '' })
    const args = run.calls[0]?.args ?? []
    expect(args).toContain('-o')
    expect(args).toContain('-j0')
  })

  it('默认增量构建，rebuild 时用 -r', async () => {
    const inc = fakeRunner()
    await buildFirmware({ project, run: inc, deps, readLog: () => '' })
    expect(inc.calls[0]?.args[0]).toBe('-b')

    const full = fakeRunner()
    await buildFirmware({ project, run: full, deps, rebuild: true, readLog: () => '' })
    expect(full.calls[0]?.args[0]).toBe('-r')
  })

  it('工程文件不存在时明确报出来，不去 spawn', async () => {
    const run = fakeRunner()
    const r = await buildFirmware({ project, run, deps: depsWith([]), readLog: () => '' })
    expect(r.blocked).toContain('找不到工程文件')
    expect(run.calls).toEqual([])
  })

  it('找不到 UV4 时提示可显式指定路径', async () => {
    const r = await buildFirmware({
      project, run: fakeRunner(), deps: depsWith(['uvprojx']), readLog: () => '',
    })
    expect(r.blocked).toContain('uv4')
  })

  it('失败却没解析出诊断时，附上日志末尾 —— 不留「失败但无原因」', async () => {
    const r = await buildFirmware({
      project, run: fakeRunner({ UV4: { code: 2 } }), deps,
      readLog: () => '一些无法解析的输出\n最后一行',
    })
    expect(r.diagnostics).toEqual([])
    expect(r.logTail).toContain('最后一行')
  })

  it('license 错误被定性为环境问题，明说不是代码问题', async () => {
    const r = await buildFirmware({
      project, run: fakeRunner({ UV4: { code: 2 } }), deps,
      readLog: () => 'armclang: error: No license checking back-end registered with id Keil.mdkstd',
    })
    expect(r.hint).toContain('不是代码问题')
    expect(r.hint).toContain('License Management')
  })

  it('构建成功时不给环境提示', async () => {
    const r = await buildFirmware({
      project, run: fakeRunner({ UV4: { code: 0 } }), deps, readLog: () => '',
    })
    expect(r.hint).toBeUndefined()
    expect(r.logTail).toBeUndefined()
  })

  it('日志默认写临时目录，不污染被检查的工程', async () => {
    const run = fakeRunner()
    const r = await buildFirmware({ project, run, deps, readLog: () => '' })
    const logArg = run.calls[0]?.args[run.calls[0].args.indexOf('-o') + 1] ?? ''
    expect(logArg).not.toContain('D:/proj')
    expect(r.logFile).toBe(logArg)
  })

  it('编译器说有错、解析器却没解出来时，把这件事本身报成错误', async () => {
    // 防的是「报错误 0，但构建其实失败」这种最误导人的输出
    const r = await buildFirmware({
      project, run: fakeRunner({ UV4: { code: 2 } }), deps,
      readLog: () => '某种没覆盖的格式\n1 error generated.',
    })
    expect(r.errors).toBe(1)
    expect(r.diagnostics[0]?.message).toContain('未覆盖的格式')
    expect(r.diagnostics[0]?.message).toContain('完整日志')
  })

  it('解析出的错误数与编译器一致时不加这条', async () => {
    const r = await buildFirmware({
      project, run: fakeRunner({ UV4: { code: 2 } }), deps,
      readLog: () => 'a.c(9): error:  #20: bad\n1 error generated.',
    })
    expect(r.errors).toBe(1)
    expect(r.diagnostics[0]?.message).not.toContain('未覆盖的格式')
  })

  it('未知退出码不冒充成功', async () => {
    const r = await buildFirmware({
      project, run: fakeRunner({ UV4: { code: 99 } }), deps, readLog: () => '',
    })
    expect(r.ok).toBe(false)
    expect(r.verdict).toContain('99')
  })
})

describe('toWslPath', () => {
  it('盘符路径翻译成 /mnt/<盘符小写>/', () => {
    expect(toWslPath('D:/code/x')).toBe('/mnt/d/code/x')
    expect(toWslPath('C:\\Users\\a\\b')).toBe('/mnt/c/Users/a/b')
  })

  it('已经是 POSIX 路径的原样返回', () => {
    expect(toWslPath('/tmp/x')).toBe('/tmp/x')
  })

  it('实测踩到：不翻译会让 cmake 报 source directory does not exist', () => {
    // WSL 里根本没有 D: 这个东西
    expect(toWslPath('D:/code/RCS_code/demo/RCS/RCS_Support/test')).not.toContain('D:')
  })
})

describe('classifyTestFailure', () => {
  it('认出 gtest 要求的 C++ 标准高于 CMakeLists 设置', () => {
    const s = classifyTestFailure('gtest-port.h:273:2: error: #error C++ versions less than C++17 are not supported.')
    expect(s).toContain('C++17')
    expect(s).toContain('CMAKE_CXX_STANDARD')
  })

  it('认出跨机器的陈旧构建缓存', () => {
    const s = classifyTestFailure('CMake Error: The current CMakeCache.txt directory /a/build is different than the directory /b/build where')
    expect(s).toContain('构建缓存')
  })

  it('认出静态库与编译器不匹配', () => {
    expect(classifyTestFailure('undefined reference to `testing::Test::Test()`')).toContain('WSL')
  })

  it('认不出来时返回 undefined，不编造原因', () => {
    expect(classifyTestFailure('some unrelated output')).toBeUndefined()
  })
})

describe('Keil 编译器版本', () => {
  const UVPROJX = '<Target><ArmAdsMisc><pCCUsed>6240000::V6.24::ARMCLANG</pCCUsed><uAC6>1</uAC6></ArmAdsMisc></Target>'
  const TOOLS_INI = [
    'RTEPATH="D:\\keil"',
    'BOOK4="ARMCLANG\\sw\\info\\releasenotes.html" ("Release Notes for Arm Compiler 6.22",GEN)',
    'BOOK5="ARMCLANG\\sw\\hlp\\compiler_user_guide.pdf" ("Arm Compiler User Guide Version 6.22 (PDF)",GEN)',
  ].join('\n')

  it('从 .uvprojx 读出工程选用的版本', () => {
    expect(projectCompilerVersion(UVPROJX)).toBe('V6.24')
  })

  it('读不到时返回 undefined', () => {
    expect(projectCompilerVersion('<Target/>')).toBeUndefined()
  })

  it('从 TOOLS.INI 读出 Keil 自带的版本', () => {
    expect(keilBundledCompilers('D:/keil/UV4/UV4.exe', () => TOOLS_INI)).toEqual(['V6.22'])
  })

  it('看的是 Keil 注册了什么，不是磁盘上有什么 —— 单独装的版本常常没授权', () => {
    // 磁盘上有 ArmCompiler_V6.24 目录，但 TOOLS.INI 里只有 6.22
    const got = keilBundledCompilers('D:/keil/UV4/UV4.exe', () => TOOLS_INI)
    expect(got).not.toContain('V6.24')
  })

  it('license 错误 + 版本不匹配 → 定性为选错版本，而不是授权失效', () => {
    const s = classifyBuildFailure(
      [{ severity: 'error', code: 'armclang', message: 'No license checking back-end registered with id Keil.mdkstd' }],
      { wanted: 'V6.24', installed: ['V6.22'] },
    )
    expect(s).toContain('V6.24')
    expect(s).toContain('V6.22')
    expect(s).toContain('版本选错')
  })

  it('版本一致时仍报 license，就走通用授权提示', () => {
    const s = classifyBuildFailure(
      [{ severity: 'error', code: 'armclang', message: 'No license checking back-end' }],
      { wanted: 'V6.22', installed: ['V6.22'] },
    )
    expect(s).toContain('License Management')
  })
})

describe('probeWslToolchain', () => {
  it('逐行对应 cmake / make / g++', async () => {
    const run = fakeRunner({ wsl: { code: 0, stdout: '/usr/bin/cmake\n/usr/bin/make\n/usr/bin/g++\n' } })
    const r = await probeWslToolchain(run)
    expect(r.map((t) => t.id)).toEqual(['wsl-cmake', 'wsl-make', 'wsl-g++'])
    expect(r.every((t) => t.available)).toBe(true)
  })

  it('缺失项用 - 占位，且给出安装提示', async () => {
    const run = fakeRunner({ wsl: { code: 0, stdout: '-\n/usr/bin/make\n/usr/bin/g++\n' } })
    const r = await probeWslToolchain(run)
    expect(r[0]?.available).toBe(false)
    expect(r[0]?.hint).toContain('apt update')
  })

  it('WSL 起不来时全部报缺失，不抛异常', async () => {
    const run = fakeRunner({ wsl: { code: 1, stdout: '' } })
    const r = await probeWslToolchain(run)
    expect(r.every((t) => !t.available)).toBe(true)
  })
})

describe('archiveObjectFormat', () => {
  const arHeader = (name: string, size: number): number[] => {
    const h = name.padEnd(16) + ' '.repeat(32) + String(size).padEnd(10) + '`\n'
    return Array.from(h, (c) => c.charCodeAt(0))
  }

  it('识别 ELF（Linux 产物）', () => {
    const buf = Uint8Array.from([
      ...Array.from('!<arch>\n', (c) => c.charCodeAt(0)),
      ...arHeader('/', 4), 0, 0, 0, 0,
      ...arHeader('x.o', 4), 0x7f, 0x45, 0x4c, 0x46,
    ])
    expect(archiveObjectFormat(buf)).toBe('elf')
  })

  it('识别 COFF（Windows 产物）', () => {
    const buf = Uint8Array.from([
      ...Array.from('!<arch>\n', (c) => c.charCodeAt(0)),
      ...arHeader('x.o', 4), 0x64, 0x86, 0, 0,
    ])
    expect(archiveObjectFormat(buf)).toBe('coff')
  })

  it('残缺输入不抛异常', () => {
    expect(archiveObjectFormat(new Uint8Array([1, 2, 3]))).toBe('unknown')
  })

  it('队内真实 libgtest.a 是 ELF —— 这决定了必须走 WSL', () => {
    const p = 'D:/code/RCS_code/demo/RCS/RCS_Support/test/lib/libgtest.a'
    if (!existsSync(p)) return
    expect(archiveObjectFormat(new Uint8Array(readFileSync(p)))).toBe('elf')
  })
})

describe('parseGtestOutput', () => {
  it('统计通过与失败', () => {
    const out = [
      '[       OK ] regularTest.a (0 ms)',
      '[       OK ] regularTest.b (0 ms)',
      '[  FAILED  ] normalizeTest.c (1 ms)',
      '[  FAILED  ] 1 test, listed below:',
    ].join('\n')
    const r = parseGtestOutput(out)
    expect(r.passed).toBe(2)
    expect(r.failed).toBe(1)
    expect(r.failures[0]?.name).toBe('normalizeTest.c')
  })

  it('末尾汇总行不重复计入', () => {
    const out = ['[  FAILED  ] X.y', '[  FAILED  ] X.y', '[  FAILED  ] 1 test, listed below:'].join('\n')
    expect(parseGtestOutput(out).failed).toBe(1)
  })

  it('空输出不报成功也不崩', () => {
    expect(parseGtestOutput('')).toEqual({ passed: 0, failed: 0, failures: [] })
  })
})

describe('runSupportTests', () => {
  const testDir = 'D:/proj/RCS_Support/test'
  const elfLib = Uint8Array.from([
    ...Array.from('!<arch>\n', (c) => c.charCodeAt(0)),
    ...Array.from(('x.o'.padEnd(16) + ' '.repeat(32) + '4'.padEnd(10) + '`\n'), (c) => c.charCodeAt(0)),
    0x7f, 0x45, 0x4c, 0x46,
  ])

  it('没有 CMakeLists.txt 时明确说路径可能不对', async () => {
    const r = await runSupportTests({ testDir, run: fakeRunner(), deps: depsWith([]) })
    expect(r.blocked).toContain('CMakeLists.txt')
  })

  it('库是 ELF 但没有 WSL —— 说清为什么 Windows 原生走不通', async () => {
    const r = await runSupportTests({
      testDir, run: fakeRunner(), deps: depsWith(['CMakeLists.txt'], ['cmake']),
      readFileBytes: () => elfLib,
    })
    expect(r.blocked).toContain('ELF')
    expect(r.blocked).toContain('WSL')
  })

  it('有 WSL 但 WSL 里缺 cmake —— 给出确切的 apt 命令', async () => {
    const r = await runSupportTests({
      testDir,
      run: fakeRunner({ wsl: { code: 1 } }),
      deps: depsWith(['CMakeLists.txt'], ['wsl']),
      readFileBytes: () => elfLib,
    })
    expect(r.blocked).toContain('apt update')
    expect(r.blocked).toContain('Unable to locate package')
  })

  it('WSL 齐备时走 wsl 模式并解析 gtest 输出', async () => {
    const run = fakeRunner({ test: { code: 0, stdout: '[       OK ] a.b (0 ms)\n' } })
    const r = await runSupportTests({
      testDir, run, deps: depsWith(['CMakeLists.txt'], ['wsl', 'cmake']),
      readFileBytes: () => elfLib,
    })
    expect(r.mode).toBe('wsl')
    expect(run.calls.every((c) => c.command === 'wsl')).toBe(true)
  })

  it('没有 cmake 且库不是 ELF 时，提示怎么装', async () => {
    const r = await runSupportTests({
      testDir, run: fakeRunner(), deps: depsWith(['CMakeLists.txt'], []),
      readFileBytes: () => undefined,
    })
    expect(r.blocked).toContain('cmake')
  })
})

describe('flashFirmware', () => {
  const script = 'D:/code/RCS_code/upper_host_cli/swd_flash.py'
  const deps = depsWith(['swd_flash.py', '.bin'], ['python'])

  it('默认只校验，不传 --write', async () => {
    const run = fakeRunner()
    const r = await flashFirmware({ script, run, deps })
    expect(run.calls[0]?.args).not.toContain('--write')
    expect(r.wrote).toBe(false)
  })

  it('write 为 true 时才真正写入', async () => {
    const run = fakeRunner()
    const r = await flashFirmware({ script, run, deps, write: true })
    expect(run.calls[0]?.args).toContain('--write')
    expect(r.wrote).toBe(true)
  })

  it('写入失败时 wrote 为 false —— 不能因为传了 write 就报告写成功', async () => {
    const r = await flashFirmware({ script, run: fakeRunner({ swd_flash: { code: 1 } }), deps, write: true })
    expect(r.ok).toBe(false)
    expect(r.wrote).toBe(false)
  })

  it('固件不存在时提示先构建，且不去 spawn', async () => {
    const run = fakeRunner()
    const r = await flashFirmware({
      script, run, binary: 'D:/nope.bin', write: true,
      deps: { exists: (p) => p.includes('swd_flash.py'), which: () => '/usr/bin/python' },
    })
    expect(r.blocked).toContain('rcs_fw_build')
    expect(run.calls).toEqual([])
  })

  it('没有 Python 时说清楚', async () => {
    const r = await flashFirmware({ script, run: fakeRunner(), deps: depsWith(['swd_flash.py'], []) })
    expect(r.blocked).toContain('Python')
  })
})
