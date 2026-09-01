/**
 * 构建 / 测试 / 烧录的工具链层。
 *
 * ## 为什么把「跑外部进程」也做成可注入
 *
 * 和 `FeishuClient` 同一个理由：真正容易写错的是**参数拼装、输出解析、
 * 失败分类**，而不是 spawn 本身。把执行器注入进来，这些逻辑就能在没有
 * Keil、没有烧录器、没有 cmake 的机器上完整单测。
 *
 * ## 探测优先于假设
 *
 * 队里每个人的机器都不一样：有人装了 Keil、有人只有 GCC、有人在 WSL 里跑。
 * 工具**先探测再执行**，缺什么就明确说缺什么、去哪装 —— 而不是抛一个
 * `ENOENT` 让人自己猜。这类"环境不齐"的报错如果说不清楚，
 * 会比功能缺失更劝退。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 一次外部命令的结果。 */
export type CommandResult = {
  code: number
  stdout: string
  stderr: string
  /** 命令没跑起来（找不到可执行文件等）时的原因。 */
  spawnError?: string
}

/** 可注入的执行器。测试里换成假的即可。 */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>

// ---------- 工具链探测 ----------

export type ToolStatus = {
  id: string
  label: string
  available: boolean
  path?: string
  /** 不可用时说明怎么办；可用时可留空。 */
  hint?: string
}

/** Keil 的默认安装位置。队内机器实测在 D 盘。 */
export const KEIL_CANDIDATES = [
  'D:/keil/UV4/UV4.exe',
  'C:/Keil_v5/UV4/UV4.exe',
  'C:/Keil/UV4/UV4.exe',
]

export type ProbeDeps = {
  exists: (p: string) => boolean
  /** 在 PATH 里找可执行文件；找不到返回 undefined。 */
  which: (cmd: string) => string | undefined
}

/** 探测本机工具链。纯函数（依赖注入），便于测试各种组合。 */
export function probeToolchain(deps: ProbeDeps): ToolStatus[] {
  const keil = KEIL_CANDIDATES.find((p) => deps.exists(p))
  const cmake = deps.which('cmake')
  const python = deps.which('python') ?? deps.which('python3')
  const wsl = deps.which('wsl')

  return [
    {
      id: 'keil',
      label: 'Keil MDK (UV4.exe)',
      available: keil !== undefined,
      path: keil,
      hint: keil ? undefined : `未找到。已查过：${KEIL_CANDIDATES.join('、')}。装了但不在这些路径，请在工具参数里显式指定。`,
    },
    {
      id: 'cmake',
      label: 'CMake',
      available: cmake !== undefined,
      path: cmake,
      hint: cmake
        ? undefined
        : 'PC 单元测试需要它。Windows 可 `winget install Kitware.CMake`；' +
          'WSL 里 `sudo apt update && sudo apt install -y cmake build-essential`。\n' +
          '若 apt update 满屏 `Ign:`：多半是机器走代理上网，而 sudo 会清掉 http_proxy 环境变量。' +
          '给 apt 单独配一份即可（把端口换成你的）：\n' +
          '  printf \'Acquire::http::Proxy "http://127.0.0.1:7897";\\nAcquire::https::Proxy "http://127.0.0.1:7897";\\n\' | sudo tee /etc/apt/apt.conf.d/99proxy',
    },
    {
      id: 'python',
      label: 'Python',
      available: python !== undefined,
      path: python,
      hint: python ? undefined : '烧录脚本 swd_flash.py 需要它。',
    },
    {
      id: 'wsl',
      label: 'WSL',
      available: wsl !== undefined,
      path: wsl,
      hint: wsl ? undefined : '队内 PC 测试的 gtest 静态库是 Linux 产物，没有 WSL 就只能在 Windows 侧重新编译 gtest。',
    },
  ]
}

/**
 * 探测 **WSL 内** 的工具链。
 *
 * 单独一个函数、而且是异步的，因为它必须真的起一个 wsl 进程 ——
 * Windows 侧的 PATH 里查不到 WSL 里装了什么。
 *
 * 这一步不是锦上添花：队内 PC 测试的 gtest 静态库是 Linux 产物，
 * **只能在 WSL 里构建**。只报 Windows 侧的 cmake 会得出完全相反的结论 ——
 * 明明 WSL 里装好了，却告诉人「CMake 缺失」。
 */
export async function probeWslToolchain(run: CommandRunner): Promise<ToolStatus[]> {
  const tools = ['cmake', 'make', 'g++']
  const r = await run('wsl', ['-e', 'bash', '-lc', tools.map((t) => `command -v ${t} || echo -`).join('; ')], {
    timeoutMs: 30_000,
  })
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return tools.map((t, i) => {
    const path = lines[i] && lines[i] !== '-' ? lines[i] : undefined
    return {
      id: `wsl-${t}`,
      label: `WSL: ${t}`,
      available: path !== undefined,
      ...(path ? { path } : {}),
      ...(path
        ? {}
        : {
            hint:
              '在 WSL 里执行 `sudo apt update && sudo apt install -y cmake build-essential`。' +
              '若 apt update 满屏 `Ign:`，是 sudo 清掉了 http_proxy，见 cmake 一项的说明。',
          }),
    }
  })
}

// ---------- Keil 构建 ----------

export type BuildDiagnostic = {
  severity: 'error' | 'warning'
  file?: string
  line?: number
  /** Keil 的诊断编号，如 `#20`、`L6218E`。 */
  code?: string
  message: string
}

/**
 * UV4 的退出码。
 *
 * 注意 **1 表示「有警告」而不是失败** —— 按常规把非 0 一律当失败，
 * 会把一次成功的构建报成失败。
 */
export const UV4_EXIT: Record<number, string> = {
  0: '构建成功，无错误无警告',
  1: '构建成功，但有警告',
  2: '构建失败：有错误',
  3: '构建失败：致命错误',
  11: '打不开工程文件',
  12: '设备错误',
  13: '找不到文件',
  15: 'License 错误',
  20: '无法启动 uVision',
}

/**
 * 解析 Keil 构建日志。
 *
 * 覆盖三种形态：
 *   1. 带行号的编译诊断  `..\RCS\user\main.c(42): error:  #20: identifier "foo" is undefined`
 *   2. 链接器诊断        `.\out\x.axf: Error: L6218E: Undefined symbol foo`
 *   3. **工具级错误**    `armclang: error: No license checking back-end registered ...`
 *
 * 第 3 种是实测补上的：本机构建返回退出码 2（有错误），日志里满屏
 * `armclang: error: ... license ...`，但前两条规则一条都没匹配上，
 * 于是工具报了「失败，但日志里没有解析出诊断」—— 明明原因就摆在那儿。
 * **"失败且说不出原因"是最糟的输出**，它逼人去手工翻日志，那这个工具就白做了。
 */
/**
 * 一行里可能藏着**多个**诊断位置。
 *
 * Keil 会把 `In file included from` 的包含链折叠进同一行：
 *
 *   `a.cpp(30): warning: In file included from...../b.cpp(89): error: 真正的问题`
 *
 * 只看行首会得出「a.cpp 的一条 warning」—— 而真实情况是 **b.cpp 第 89 行的一条
 * error**。实测就踩到了：构建确实失败，工具却报「错误 0 警告 11」。
 * 所以取**最后一个**位置标记，那才是问题所在。
 */
function innermostDiagnostic(
  line: string,
): { file: string; line: number; severity: 'error' | 'warning'; message: string } | undefined {
  const re = /([^\s(][^(]*?)\((\d+)\):\s*(error|warning|note)\s*:\s*/gi
  let last: RegExpExecArray | undefined
  for (let m = re.exec(line); m; m = re.exec(line)) last = m
  if (!last) return undefined
  const sev = last[3]!.toLowerCase()
  if (sev === 'note') return undefined // note 是补充说明，不单独成条
  return {
    // 折叠行里，捕获到的"路径"前面还粘着 `In file included from.....` 这段说明。
    // 3 个以上连续点是这种折叠的标志，把它连同前面的文字一起切掉，只留真实路径。
    file: last[1]!.replace(/^.*?\.{3,}[/\\]*/, '').replace(/^[/\\]+/, '').trim(),
    line: Number(last[2]),
    severity: sev === 'error' ? 'error' : 'warning',
    message: line.slice(last.index + last[0].length).trim(),
  }
}

export function parseKeilLog(log: string): BuildDiagnostic[] {
  const out: BuildDiagnostic[] = []
  const linker = /^(?:(.*?):\s*)?(Error|Warning)\s*:\s*(L\d+[A-Z]?)\s*:\s*(.*)$/i
  // armclang / armlink / armasm 这类工具名开头，无文件无行号
  const toolLevel = /^(arm\w+|\w+\.exe)\s*:\s*(error|warning)\s*:\s*(.*)$/i

  const seen = new Set<string>()
  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const d = innermostDiagnostic(line)
    if (d) {
      // 诊断编号（#20 / #177-D）若在消息开头则单独拆出来
      const codeM = /^(#[\w-]+)\s*:\s*/.exec(d.message)
      out.push({
        severity: d.severity,
        file: d.file,
        line: d.line,
        ...(codeM ? { code: codeM[1] } : {}),
        message: codeM ? d.message.slice(codeM[0].length) : d.message,
      })
      continue
    }

    const l = linker.exec(line)
    if (l) {
      out.push({
        severity: l[2]!.toLowerCase() === 'error' ? 'error' : 'warning',
        file: l[1]?.trim(),
        code: l[3],
        message: l[4]!.trim(),
      })
      continue
    }

    const t = toolLevel.exec(line)
    if (t) {
      // 工具级错误常常每个源文件重复一遍（本机实测重复了几十次），去重
      const key = `${t[1]}|${t[3]}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        severity: t[2]!.toLowerCase() === 'error' ? 'error' : 'warning',
        code: t[1],
        message: t[3]!.trim(),
      })
    }
  }
  return out
}

/** 从 `.uvprojx` 里读出工程选用的 Arm Compiler 版本，如 `V6.24`。 */
export function projectCompilerVersion(uvprojxXml: string): string | undefined {
  // <pCCUsed>6240000::V6.24::ARMCLANG</pCCUsed>
  return /<pCCUsed>[^<]*?::(V[\d.]+)::/.exec(uvprojxXml)?.[1]
}

/**
 * Keil **自带**的 Arm Compiler 版本 —— 从 `TOOLS.INI` 的 release notes 条目里读。
 *
 * 为什么不去枚举 `D:/keil/ArmCompiler_V*` 目录：那些是**单独安装**的版本，
 * 恰恰是常常没授权的那一批。判断「哪个版本能用」要看 Keil 自己注册了什么，
 * 而不是磁盘上有什么。
 */
export function keilBundledCompilers(uv4Path: string, read: (p: string) => string): string[] {
  // D:/keil/UV4/UV4.exe → D:/keil/TOOLS.INI
  const root = uv4Path.replace(/\\/g, '/').replace(/\/UV4\/UV4\.exe$/i, '')
  const ini = read(`${root}/TOOLS.INI`)
  const found = new Set<string>()
  for (const m of ini.matchAll(/Arm Compiler[^"]*?\b(\d+\.\d+)\b/g)) {
    if (m[1]) found.add(`V${m[1]}`)
  }
  return [...found]
}

/**
 * 认出「这不是你代码的问题」的环境类错误。
 *
 * License 没激活、编译器版本选错这类问题，让人对着自己的代码找半天是纯粹的浪费。
 *
 * `wanted` / `installed` 给上时，能把 license 报错进一步定性到**版本不匹配** ——
 * 实测就是这种情况：Keil 自带并授权的是 6.22，工程却选了单独安装、未授权的 6.24。
 * 只说「license 没激活」会让人跑去查授权，其实授权是好的，选错了编译器而已。
 */
export function classifyBuildFailure(
  diagnostics: BuildDiagnostic[],
  context?: { wanted?: string; installed?: string[] },
): string | undefined {
  const text = diagnostics.map((d) => d.message).join('\n')

  if (/license/i.test(text)) {
    const wanted = context?.wanted
    const installed = context?.installed ?? []
    if (wanted && installed.length > 0 && !installed.includes(wanted)) {
      return (
        `工程选用的是 Arm Compiler **${wanted}**，但本机 Keil 实际带的是 ` +
        `**${installed.join('、')}** —— 单独安装的版本通常不在 MDK 授权范围内，` +
        '于是报 license 错误。**授权本身多半没问题，是版本选错了。**\n' +
        `改法：uVision → Project → Manage → Project Items → Folders/Extensions，` +
        `把 ARM Compiler 切到 ${installed[0]}；或直接改 .uvprojx 里的 <pCCUsed>。`
      )
    }
    return (
      'Keil license 未激活或不可用 —— **这不是代码问题**。\n' +
      '先确认工程选的编译器版本是否是 Keil 自带那个（单独装的版本常常没授权）；' +
      '再看 uVision → File → License Management。'
    )
  }
  if (/cannot open source input file|No such file or directory/i.test(text)) {
    return '有源文件找不到 —— 多半是工程里引用的路径失效，或仓库没拉全。'
  }
  return undefined
}

export type BuildResult = {
  ok: boolean
  exitCode: number
  /** 退出码的人话解释。 */
  verdict: string
  project: string
  diagnostics: BuildDiagnostic[]
  errors: number
  warnings: number
  /** 工具链缺失等无法开始构建的原因。 */
  blocked?: string
  /** 环境类失败的定性说明，如「license 未激活，不是代码问题」。 */
  hint?: string
  /** 一条诊断都没解析出来时附上日志末尾，绝不让人对着「失败但无原因」发呆。 */
  logTail?: string
  /** 日志文件位置，便于人工细看。 */
  logFile?: string
}

export type BuildOptions = {
  /** `.uvprojx` 路径。 */
  project: string
  /** UV4.exe 路径；不给则探测。 */
  uv4?: string
  /** 目标（uvprojx 里的 Target 名）；不给用工程默认。 */
  target?: string
  /** 重新完整构建（-r）而不是增量（-b）。 */
  rebuild?: boolean
  run: CommandRunner
  deps: ProbeDeps
  /** 日志文件路径；不给则默认放临时目录。 */
  logFile?: string
  readLog?: (p: string) => string
  /** 读取 `.uvprojx` 与 `TOOLS.INI` 的方式；不给则与 readLog 相同。 */
  readText?: (p: string) => string
}

/**
 * 调 Keil 构建。
 *
 * UV4 不把诊断打到 stdout，必须用 `-o <logfile>` 落盘再读 —— 直接读 stdout
 * 会拿到空字符串，然后误以为"构建干净"。
 */
export async function buildFirmware(options: BuildOptions): Promise<BuildResult> {
  const { project, run, deps } = options
  const readLog = options.readLog ?? ((p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : ''))
  // 读工程文件与 TOOLS.INI 用同一个读取器，测试里可整体替换
  const readProject = options.readText ?? readLog

  const blocked = (reason: string): BuildResult => ({
    ok: false, exitCode: -1, verdict: '未开始', project, diagnostics: [], errors: 0, warnings: 0, blocked: reason,
  })

  if (!deps.exists(project)) {
    return blocked(`找不到工程文件：${project}`)
  }
  const uv4 = options.uv4 ?? KEIL_CANDIDATES.find((p) => deps.exists(p))
  if (!uv4) {
    return blocked(
      `没找到 UV4.exe。已查过：${KEIL_CANDIDATES.join('、')}。\n` +
        '装在别处的话，在工具参数里用 uv4 显式指定路径。',
    )
  }

  // 日志默认放临时目录，**不往队里的仓库里丢文件** —— 工具不该污染被检查的工程
  const logFile = options.logFile ?? join(tmpdir(), `rcs-build-${process.pid}.log`)
  const args = [options.rebuild ? '-r' : '-b', project, '-j0', '-o', logFile]
  if (options.target) args.push('-t', options.target)

  const r = await run(uv4, args, { timeoutMs: 10 * 60 * 1000 })
  if (r.spawnError) return blocked(`UV4 启动失败：${r.spawnError}`)

  const log = readLog(logFile)
  const diagnostics = parseKeilLog(log)

  /*
   * 交叉校验：armclang 末尾会打「N error(s) generated.」。
   * 如果它说有错、我们却一条都没解析出来，那就是解析器漏了格式 ——
   * 与其报一个「错误 0」误导人，不如把这件事本身当成一条诊断摆出来。
   * （实测踩过：Keil 把 `In file included from` 链折叠成一行，
   *   行首是 warning、行尾才是真正的 error。）
   */
  const claimed = Number(/(\d+)\s+errors?\s+generated/i.exec(log)?.[1] ?? 0)
  let errors = diagnostics.filter((d) => d.severity === 'error').length
  if (claimed > 0 && errors === 0) {
    diagnostics.unshift({
      severity: 'error',
      message:
        `编译器报告 ${claimed} 个错误，但本工具一条都没解析出来 —— 说明日志里出现了未覆盖的格式。` +
        `请直接看完整日志：${logFile}`,
    })
    errors = diagnostics.filter((d) => d.severity === 'error').length
  }
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length
  // 退出码 0 与 1 都算构建成功 —— 1 只是「有警告」
  const ok = r.code === 0 || r.code === 1

  // 失败时把「工程选了哪个编译器 / Keil 自带哪个」一并交给分类器，
  // 好把 license 错误进一步定性到版本不匹配
  let hint: string | undefined
  if (!ok) {
    const wanted = projectCompilerVersion(readProject(project))
    const installed = keilBundledCompilers(uv4, readProject)
    hint = classifyBuildFailure(diagnostics, {
      ...(wanted ? { wanted } : {}),
      ...(installed.length > 0 ? { installed } : {}),
    })
  }
  // 失败却一条诊断都没解析出来 —— 把日志末尾原样带上，绝不留一句「无原因」
  const logTail = !ok && diagnostics.length === 0 && log ? log.split(/\r?\n/).slice(-40).join('\n') : undefined

  return {
    ok,
    exitCode: r.code,
    verdict: UV4_EXIT[r.code] ?? `未知退出码 ${r.code}`,
    project,
    diagnostics,
    errors,
    warnings,
    logFile,
    ...(hint ? { hint } : {}),
    ...(logTail ? { logTail } : {}),
  }
}

// ---------- PC 单元测试 ----------

/** ar 归档里第一个成员的目标文件格式。用来判断静态库能不能在本平台链接。 */
export function archiveObjectFormat(buf: Uint8Array): 'elf' | 'coff' | 'unknown' {
  // '!<arch>\n' (8) + 成员头 (60)，但首个成员常是符号表 '/'，需要跳过
  let off = 8
  for (let i = 0; i < 4 && off + 60 <= buf.length; i++) {
    const name = new TextDecoder().decode(buf.subarray(off, off + 16)).trim()
    const sizeText = new TextDecoder().decode(buf.subarray(off + 48, off + 58)).trim()
    const size = Number.parseInt(sizeText, 10)
    const body = off + 60
    if (!Number.isFinite(size)) break
    if (name !== '/' && name !== '//') {
      const b = buf.subarray(body, body + 4)
      if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'elf'
      if (b[0] === 0x64 && b[1] === 0x86) return 'coff' // x86-64
      if (b[0] === 0x4c && b[1] === 0x01) return 'coff' // i386
      return 'unknown'
    }
    off = body + size + (size % 2)
  }
  return 'unknown'
}

export type TestOutcome = {
  ok: boolean
  passed: number
  failed: number
  failures: { name: string; detail?: string }[]
  /** 无法开始时的原因（工具链缺失、静态库平台不符等）。 */
  blocked?: string
  /** 实际使用的执行方式。 */
  mode?: 'native' | 'wsl'
}

/**
 * 解析 gtest 输出。
 *
 * 只认 `[  PASSED  ]` / `[  FAILED  ]` 这类稳定标记，不去解析自由文本 ——
 * 后者随 gtest 版本变化，解析错了会把失败报成成功，那比解析不出来危险得多。
 */
export function parseGtestOutput(text: string): { passed: number; failed: number; failures: { name: string }[] } {
  const failures: { name: string }[] = []
  let passed = 0
  let failed = 0

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const okm = /^\[\s*OK\s*\]\s+(\S+)/.exec(line)
    if (okm) { passed++; continue }
    const fm = /^\[\s*FAILED\s*\]\s+(\S+)/.exec(line)
    // gtest 末尾的汇总也用 [ FAILED ]，带空格的用例名才是真条目
    if (fm && !/^\[\s*FAILED\s*\]\s+\d+\s+test/.test(line)) {
      const name = fm[1]!
      if (!failures.some((x) => x.name === name)) { failures.push({ name }); failed++ }
    }
  }
  return { passed, failed, failures }
}

/**
 * 认出测试工程本身的配置不一致 —— 与 `classifyBuildFailure` 同一思路。
 *
 * 这类问题不是"环境没装好"，而是**仓库里就是坏的**，只是平时没人跑所以没暴露。
 * 报错要指到具体哪一行、改成什么，否则人会先怀疑自己的环境，绕一大圈。
 */
export function classifyTestFailure(output: string): string | undefined {
  const std = /C\+\+ versions less than C\+\+(\d+) are not supported/.exec(output)
  if (std) {
    return (
      `测试工程的 C++ 标准配置与 gtest 头文件不匹配：gtest 要求 **C++${std[1]}**，` +
      '但 `test/CMakeLists.txt` 里设的是更低的版本。\n' +
      `改法是一行：把 \`set(CMAKE_CXX_STANDARD 14)\` 改成 \`set(CMAKE_CXX_STANDARD ${std[1]})\`。\n` +
      '（多半是某次更新了 gtest 头文件却没同步改 CMakeLists —— 这份 PC 测试' +
      '因此一直编译不过，而它本该是 CI 的核心。）'
    )
  }
  if (/CMakeCache\.txt directory .* is different than the directory/.test(output)) {
    return '构建缓存来自另一台机器的路径。本工具已改用仓库外的构建目录，若仍报此错请清掉旧的 `build/`。'
  }
  if (/undefined reference to|cannot find -l/.test(output)) {
    return '链接失败：静态库与当前编译器不匹配（队内 gtest 是 Linux/GCC 产物）。确认是在 WSL 内构建。'
  }
  return undefined
}

export type SupportTestOptions = {
  /** `RCS_Support/test` 目录。 */
  testDir: string
  run: CommandRunner
  deps: ProbeDeps
  readFileBytes?: (p: string) => Uint8Array | undefined
}

/**
 * 跑 `RCS_Support/test` 的 PC 单元测试。
 *
 * **这是 CI 的核心** —— 它不需要任何硬件，能在每次提交时验证运动学、
 * 角度回环、FIFO 这些纯逻辑。
 *
 * 但它对环境有个不显眼的硬要求：队内仓库里那几个 `libgtest.a` 是
 * **在 WSL/Ubuntu 下编译的 ELF 归档**，Windows 原生工具链链不了。
 * 所以要先看静态库的目标格式，再决定走哪条路，并在走不通时说清原因。
 */
export async function runSupportTests(options: SupportTestOptions): Promise<TestOutcome> {
  const { testDir, run, deps } = options
  const readBytes = options.readFileBytes ?? ((p: string) => (existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined))

  const blocked = (reason: string): TestOutcome => ({ ok: false, passed: 0, failed: 0, failures: [], blocked: reason })

  if (!deps.exists(join(testDir, 'CMakeLists.txt'))) {
    return blocked(`${testDir} 下没有 CMakeLists.txt —— 确认路径是否为 RCS_Support/test`)
  }

  const gtest = readBytes(join(testDir, 'lib', 'libgtest.a'))
  const format = gtest ? archiveObjectFormat(gtest) : 'unknown'

  const hasCmake = deps.which('cmake') !== undefined
  const hasWsl = deps.which('wsl') !== undefined

  // 库是 Linux 产物时，只能走 WSL
  if (format === 'elf') {
    if (!hasWsl) {
      return blocked(
        '仓库里的 libgtest.a 是 Linux ELF 归档（在 WSL/Ubuntu 下编译的），Windows 原生工具链链不了，而本机没有 WSL。\n' +
          '两条出路：装 WSL 并在其中 `sudo apt update && sudo apt install -y cmake build-essential`；或在 Windows 侧重新编译一份 gtest。',
      )
    }
    const probe = await run('wsl', ['-e', 'bash', '-lc', 'command -v cmake && command -v make && command -v g++'])
    if (probe.code !== 0) {
      return blocked(
        'libgtest.a 是 Linux 产物，须在 WSL 内构建，但 WSL 里缺 cmake / make / g++。\n' +
          '在 WSL 里执行：sudo apt update && sudo apt install -y cmake build-essential\n' +
          '**`apt update` 不能省**：全新 WSL 实例的包列表是空的，直接 install 会报\n' +
          '「Unable to locate package cmake」，看着像没网，其实只是没拉过索引。\n' +
          '这一步需要 sudo 密码，得你手动执行。',
      )
    }
    return runCmakeAnd(run, testDir, 'wsl')
  }

  if (!hasCmake) {
    return blocked(
      '没有 cmake。Windows: `winget install Kitware.CMake`；WSL: `sudo apt update && sudo apt install -y cmake build-essential`。',
    )
  }
  return runCmakeAnd(run, testDir, 'native')
}

/**
 * Windows 路径 → WSL 路径：`D:/code/x` / `D:\code\x` → `/mnt/d/code/x`。
 *
 * 实测踩到：把 Windows 路径原样传给 `wsl -e cmake -S ...`，cmake 报
 * 「source directory does not exist」。WSL 里根本没有 `D:` 这个东西。
 * 已经是 POSIX 路径的原样返回，便于在真 Linux 上直接复用。
 */
export function toWslPath(p: string): string {
  const s = p.replace(/\\/g, '/')
  const m = /^([A-Za-z]):\/(.*)$/.exec(s)
  return m ? `/mnt/${m[1]!.toLowerCase()}/${m[2]}` : s
}

/**
 * 构建目录**放在仓库之外**。
 *
 * 两个实测理由：
 *   1. 队内仓库里提交了一份 `test/build/`，其 `CMakeCache.txt` 记的是
 *      **别人机器上的源码路径**（`/mnt/d/back/...`）。复用它会直接报
 *      「source does not match the source used to generate cache」。
 *   2. 工具不该往被检查的工程里写东西 —— 与构建日志放临时目录同一条原则。
 *
 * 目录名带上源路径的哈希，避免多个工程互相覆盖。
 */
function outOfTreeBuildDir(testDir: string, mode: 'native' | 'wsl'): string {
  let h = 0
  for (let i = 0; i < testDir.length; i++) h = (Math.imul(31, h) + testDir.charCodeAt(i)) | 0
  const name = `rcs-support-test-${(h >>> 0).toString(16)}`
  return mode === 'wsl' ? `/tmp/${name}` : join(tmpdir(), name)
}

async function runCmakeAnd(run: CommandRunner, testDir: string, mode: 'native' | 'wsl'): Promise<TestOutcome> {
  // WSL 模式下所有路径都要翻译，否则 cmake 找不到源目录
  const p = (x: string): string => (mode === 'wsl' ? toWslPath(x) : x)
  const wrap = (cmd: string, args: string[]): [string, string[]] =>
    mode === 'wsl' ? ['wsl', ['-e', cmd, ...args]] : [cmd, args]

  const src = p(testDir)
  const buildDir = outOfTreeBuildDir(testDir, mode)

  const [c1, a1] = wrap('cmake', ['-S', src, '-B', buildDir])
  const conf = await run(c1, a1, { timeoutMs: 5 * 60 * 1000 })
  if (conf.code !== 0) {
    return { ok: false, passed: 0, failed: 0, failures: [], mode, blocked: `cmake 配置失败：\n${conf.stderr || conf.stdout}`.slice(0, 2000) }
  }

  const [c2, a2] = wrap('cmake', ['--build', buildDir])
  const built = await run(c2, a2, { timeoutMs: 10 * 60 * 1000 })
  if (built.code !== 0) {
    const raw = built.stderr || built.stdout
    const why = classifyTestFailure(raw)
    // 先给定性结论再给原始输出 —— 让人一眼知道该改哪里，而不是从几十行
    // 编译日志里自己捞
    return {
      ok: false, passed: 0, failed: 0, failures: [], mode,
      blocked: (why ? `${why}\n\n原始输出（截断）：\n` : '编译失败：\n') + raw.slice(0, 1500),
    }
  }

  const [c3, a3] = wrap(`${buildDir}/test`, [])
  const ran = await run(c3, a3, { timeoutMs: 5 * 60 * 1000 })
  const parsed = parseGtestOutput(`${ran.stdout}\n${ran.stderr}`)
  return { ok: ran.code === 0 && parsed.failed === 0, ...parsed, mode }
}

// ---------- 烧录 ----------

export type FlashResult = {
  ok: boolean
  /** 是否真的写了片子。verify-only 时为 false。 */
  wrote: boolean
  binary: string
  output: string
  blocked?: string
}

export type FlashOptions = {
  /** `upper_host_cli/swd_flash.py` 路径。 */
  script: string
  /** 待烧录的 .bin；不给用脚本默认值。 */
  binary?: string
  /** true 才真正写入；默认只校验。 */
  write?: boolean
  target?: string
  run: CommandRunner
  deps: ProbeDeps
}

/**
 * 烧录固件。
 *
 * **整个工具按 L2 管控，即使只做 verify。** 理由：接调试器会 halt 住 MCU，
 * 若此时机器人上电且电机使能，急停逻辑随之停止运行 —— 那是实打实的人身风险。
 * 给 verify 开一条低权限通道等于给硬件留了个后门，不值得。
 *
 * 复用队内既有的 `swd_flash.py`（pyOCD + Keil 的 CMSIS pack），不另造轮子：
 * 烧录参数写错的代价是砖掉板子。
 */
export async function flashFirmware(options: FlashOptions): Promise<FlashResult> {
  const { script, run, deps } = options
  const blocked = (reason: string): FlashResult => ({
    ok: false, wrote: false, binary: options.binary ?? '(脚本默认)', output: '', blocked: reason,
  })

  if (!deps.exists(script)) return blocked(`找不到烧录脚本：${script}`)
  const python = deps.which('python') ?? deps.which('python3')
  if (!python) return blocked('没有 Python，无法运行 swd_flash.py。')
  if (options.binary && !deps.exists(options.binary)) {
    return blocked(`找不到固件文件：${options.binary}。先跑 rcs_fw_build 生成 .bin。`)
  }

  const args = [script]
  if (options.binary) args.push('--bin', options.binary)
  if (options.target) args.push('--target', options.target)
  if (options.write) args.push('--write')

  const r = await run(python, args, { timeoutMs: 5 * 60 * 1000 })
  if (r.spawnError) return blocked(`启动失败：${r.spawnError}`)

  return {
    ok: r.code === 0,
    wrote: options.write === true && r.code === 0,
    binary: options.binary ?? '(脚本默认)',
    output: `${r.stdout}\n${r.stderr}`.trim(),
  }
}
