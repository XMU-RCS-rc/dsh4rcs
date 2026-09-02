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
