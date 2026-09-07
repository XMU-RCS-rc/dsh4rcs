/**
 * dsh 启动器的纯逻辑：缓存定位、终端模式和可观察性文案。
 *
 * 独立在这里是为了能注入文件系统做单测；真正 spawn 子进程仍留在 scripts/dsh.mjs。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type CachedDsh = { bin: string; source: string }

type CacheDeps = {
  exists: (path: string) => boolean
  readFile: (path: string) => string
  readDir: (path: string) => string[]
}

const realCacheDeps: CacheDeps = {
  exists: existsSync,
  readFile: (path) => readFileSync(path, 'utf8'),
  readDir: readdirSync,
}

/** npm/npx 在 Windows 和 POSIX 上的两类真实缓存根。 */
export function npxCacheRoots(env: Record<string, string | undefined> = process.env): string[] {
  const home = env['USERPROFILE'] ?? env['HOME'] ?? ''
  const local = env['LOCALAPPDATA'] ?? ''
  const configured = env['npm_config_cache'] ?? env['NPM_CONFIG_CACHE'] ?? ''
  const candidates = [
    configured ? join(configured, '_npx') : '',
    local ? join(local, 'npm-cache', '_npx') : '',
    home ? join(home, '.npm', '_npx') : '',
  ].filter(Boolean).map((path) => resolve(path))
  return [...new Set(candidates)]
}

/**
 * 在所有 npx 缓存根中寻找精确版本。坏目录、坏 JSON 和无权限目录都跳过，
 * 继续找下一个候选，不能因为一项缓存损坏阻断启动。
 */
export function findCachedDsh(
  pinned: string,
  options: {
    roots?: string[]
    deps?: CacheDeps
  } = {},
): CachedDsh | undefined {
  const deps = options.deps ?? realCacheDeps
  for (const base of options.roots ?? npxCacheRoots()) {
    if (!deps.exists(base)) continue
    let entries: string[]
    try {
      entries = deps.readDir(base)
    } catch {
      continue
    }
    for (const entry of entries) {
      const dir = join(base, entry, 'node_modules', '@deepseek-ai', 'dsh')
      const bin = join(dir, 'lib', 'bin.js')
      if (!deps.exists(bin)) continue
      try {
        const pkg = JSON.parse(deps.readFile(join(dir, 'package.json'))) as { version?: string }
        if (pkg.version === pinned) return { bin, source: `npx 缓存（${pinned}）` }
      } catch {
        // 缓存项不完整或正在被另一个 npm 进程更新，跳过即可。
      }
    }
  }
  return undefined
}

export function isInteractive(
  stderrIsTTY: boolean | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return stderrIsTTY === true && !env['CI']
}

/** CI/重定向下固定为逐行日志；尊重用户已显式设置的 reporter。 */
export function ensureAppendOnlyReporter(
  env: Record<string, string | undefined>,
  interactive: boolean,
): void {
  if (!interactive && !env['npm_config_reporter']) env['npm_config_reporter'] = 'append-only'
}

export function heartbeatLine(label: string, elapsedMs: number): string {
  return `[dsh] ${label}仍在进行… 已用 ${Math.max(0, Math.floor(elapsedMs / 1000))}s`
}

/** 只输出 profile 与数量，不回显可能含 registry token 的完整 argv。 */
export function pluginInstallStage(args: string[]): string | undefined {
  if (args[0] !== 'plugin') return undefined
  const valueFlags = new Set(['--profile', '--reporter', '--filter', '--registry', '--store-dir', '--config-dir'])
  const addAt = args.findIndex(
    (arg, index) => index > 0 && arg === 'add' && !valueFlags.has(args[index - 1] ?? ''),
  )
  if (addAt < 0) return undefined
  const profileAt = args.indexOf('--profile')
  const profile = profileAt >= 0 ? (args[profileAt + 1] ?? '（未指定）') : '（未指定）'
  let count = 0
  for (let index = addAt + 1; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (valueFlags.has(arg)) {
      index++
      continue
    }
    if (!arg.startsWith('-')) count++
  }
  return `[dsh:install 2/2] 安装 ${count} 个插件到 profile ${profile}`
}

export function normalizeChildExit(
  code: number | null,
  signal: string | null,
  platform: NodeJS.Platform,
): { code: number; missingCommand: boolean } {
  if (signal) return { code: 1, missingCommand: false }
  if (platform === 'win32' && code === 9009) return { code: 127, missingCommand: true }
  return { code: code ?? 1, missingCommand: false }
}

/* ---------------------------------------------------------------- 宿主包作用域 */

/**
 * 一个候选宿主作用域（`.../node_modules/@deepseek-ai`）及其关键包版本。
 * 版本一栏是**诊断材料**：选不中时要能告诉人"在哪儿找到了什么"，
 * 而不是只说一句"版本不一致"。
 */
export type HostScopeCandidate = {
  scope: string
  /** 包名 → 版本；读不出来就是 undefined（目录缺失或 package.json 坏了）。 */
  versions: Record<string, string | undefined>
}

export type HostScopeResult =
  | { ok: true; scope: string; source: string }
  | { ok: false; candidates: HostScopeCandidate[] }

type ScopeDeps = {
  exists: (path: string) => boolean
  readFile: (path: string) => string
  readDir: (path: string) => string[]
}

const realScopeDeps: ScopeDeps = {
  exists: existsSync,
  readFile: (path) => readFileSync(path, 'utf8'),
  readDir: readdirSync,
}

function versionIn(scope: string, name: string, deps: ScopeDeps): string | undefined {
  try {
    const raw = deps.readFile(join(scope, name, 'package.json'))
    return (JSON.parse(raw) as { version?: string }).version
  } catch {
    return undefined
  }
}

/**
 * 选出可以用来做联接目标的宿主 `@deepseek-ai` 作用域。
 *
 * ## 为什么必须按版本选，而不是"找到第一个就用"
 *
 * npx 缓存目录名是**调用规格的哈希**，目录一旦建好就再也不重新解析依赖。
 * 而 `@deepseek-ai/dsh` 把兄弟包声明成 `^0.1.0-rc.6` —— 同一条
 * `npx -y @deepseek-ai/dsh@0.1.0-rc.6` 命令，在 rc.8 发布前后建出来的树并不一样：
 * dsh 本体确实是 rc.6，`dsh-tools` 却会解析到 rc.8。
 * 于是不同机器上的"宿主"根本不是同一棵树，先到先得只会随机挑一棵。
 *
 * 挑错的后果不是报个错就完了：联接过去就是双实例，code mode 崩在工具调用中途，
 * 把整个会话历史弄坏。所以宁可选不出来、明确报错，也不能挑一个"看起来像"的。
 *
 * `wanted` 是包名到版本的映射，由调用方从本仓库的依赖声明里取 —— 仓库锁的版本
 * 才是判据，反过来拿宿主去改仓库是本末倒置。
 */
export function selectHostScope(
  wanted: Record<string, string>,
  options: {
    /** 本仓库自己的 `node_modules/@deepseek-ai`。装了 dsh 时它本身就是宿主。 */
    repoScope?: string
    roots?: string[]
    deps?: ScopeDeps
  } = {},
): HostScopeResult {
  const deps = options.deps ?? realScopeDeps
  const names = Object.keys(wanted)
  const candidates: HostScopeCandidate[] = []

  const inspect = (scope: string): HostScopeCandidate => ({
    scope,
    versions: Object.fromEntries(names.map((n) => [n, versionIn(scope, n, deps)])),
  })
  const matches = (c: HostScopeCandidate): boolean =>
    names.every((n) => c.versions[n] !== undefined && c.versions[n] === wanted[n])

  // 1. 本仓库 —— 与 scripts/dsh.mjs 的解析链同序。仓库装了 dsh 就最可复现：
  //    版本由 package-lock.json 钉死，每台机器一模一样。
  if (options.repoScope && deps.exists(join(options.repoScope, 'dsh'))) {
    const local = inspect(options.repoScope)
    if (matches(local)) return { ok: true, scope: options.repoScope, source: '本仓库 node_modules' }
    candidates.push(local)
  }

  // 2. npx 缓存里的每一个候选，全都看一遍再决定。
  for (const base of options.roots ?? npxCacheRoots()) {
    if (!deps.exists(base)) continue
    let entries: string[]
    try {
      entries = deps.readDir(base)
    } catch {
      continue
    }
    for (const entry of entries) {
      const scope = join(base, entry, 'node_modules', '@deepseek-ai')
      if (!deps.exists(join(scope, 'dsh-tools'))) continue
      const candidate = inspect(scope)
      if (matches(candidate)) return { ok: true, scope, source: 'npx 缓存' }
      candidates.push(candidate)
    }
  }

  return { ok: false, candidates }
}

/**
 * 选不出宿主时给人看的说明。
 *
 * **刻意不说"把 package.json 的版本对齐"** —— 早先就是这么写的，而它指的方向是反的：
 * 仓库锁 rc.6 是对的（插件按 rc.6 的类型定义写并验证过），漂掉的是运行时。
 * 照着改会把仓库升到一个没验证过的版本，还会撞上服务端与前端版本错配导致的
 * "Loading plugins…" 静默卡死 —— 一条把人引向更糟状态的提示，比不给提示更坏。
 */
export function hostScopeNotFoundMessage(
  wanted: Record<string, string>,
  candidates: HostScopeCandidate[],
): string {
  const L: string[] = []
  L.push('找不到版本一致的 dsh 宿主运行时。')
  L.push('')
  L.push('本仓库要求（package.json 的 overrides，改动前请重跑 npm run verify）：')
  for (const [name, version] of Object.entries(wanted)) L.push(`  ${name} ${version}`)
  L.push('')
  if (candidates.length === 0) {
    L.push('本机没有找到任何 dsh 运行时。')
  } else {
    L.push('本机找到的运行时：')
    for (const c of candidates) {
      L.push(`  ${c.scope}`)
      for (const [name, version] of Object.entries(c.versions)) {
        const flag = version === wanted[name] ? ' ' : '≠'
        L.push(`    ${flag} ${name} ${version ?? '（缺）'}`)
      }
    }
  }
  L.push('')
  L.push('**不要改 package.json 里的版本。** 仓库锁的版本是验证过的那一版；')
  L.push('漂掉的是本机的运行时：npx 缓存目录一旦建好就不再重新解析依赖，而 dsh')
  L.push('把兄弟包声明成 ^ 范围，所以不同时间装出来的树并不一样。')
  L.push('')
  L.push('修复：让本仓库自己装一份锁定版运行时（版本由 package-lock.json 钉死）')
  L.push('  npm install')
  L.push('  node scripts/link-host-packages.mjs')

  return L.join('\n')
}
