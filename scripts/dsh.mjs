#!/usr/bin/env node
/**
 * 锁定版本的 dsh 调用器 —— 绕开 dsh-launcher。
 *
 * 为什么不能直接用 `dsh` 命令：
 *   系统里的 `dsh` 是 `AppData\Local\Programs\dsh-launcher\bin\dsh.cmd`，内容是
 *   `npx @deepseek-ai/dsh web %*`。它有两个问题：
 *     1. **不锁版本** —— 每次可能拉到新版（实测会漂到 0.1.1-rc.2），
 *        而本插件是按 0.1.0-rc.6 的类型定义写并验证的。
 *     2. **硬编码 `web` 子命令** —— 所有参数都被追加到 `web` 后面，于是
 *        `dsh --version` 变成 `dsh web --version`（web 子命令 allowUnknownOption，
 *        参数被透传给 web 应用 → 直接启服务，看起来就是"卡住"）；
 *        `dsh plugin add` 更是彻底失效，因为 `plugin` 成了 web 应用的位置参数。
 *
 * 解析顺序（先命中先用）：
 *   1. 本仓库 node_modules（devDependency，版本锁在 package-lock 里，最可复现）
 *   2. npx 缓存里已有的同版本（零下载）
 *   3. 兜底：npx -y 拉取锁定版本
 *
 * 用法：node scripts/dsh.mjs <dsh 的原始参数>
 *   node scripts/dsh.mjs --profile web --dump-config --patch ./dev.cordis.yml
 *   node scripts/dsh.mjs plugin --profile rcs-dev add ./packages/dsh-rcs-control
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/** 本插件验证过的 dsh 版本。改动前请重跑 `npm run verify`。 */
export const PINNED = '0.1.0-rc.6'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

function versionOf(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

/** 1. 本仓库 node_modules。 */
function fromLocal() {
  const dir = join(REPO, 'node_modules', '@deepseek-ai', 'dsh')
  const bin = join(dir, 'lib', 'bin.js')
  if (!existsSync(bin)) return undefined
  const v = versionOf(dir)
  if (v !== PINNED) return undefined
  return { bin, source: `本地 node_modules (${v})` }
}

/** 2. npx 缓存 —— 缓存目录名是内容哈希，逐个探。 */
function fromNpxCache() {
  const base = join(
    process.env['LOCALAPPDATA'] ?? join(process.env['HOME'] ?? '', 'AppData', 'Local'),
    'npm-cache',
    '_npx',
  )
  if (!existsSync(base)) return undefined
  let entries
  try {
    entries = readdirSync(base)
  } catch {
    return undefined
  }
  for (const e of entries) {
    const dir = join(base, e, 'node_modules', '@deepseek-ai', 'dsh')
    const bin = join(dir, 'lib', 'bin.js')
    if (existsSync(bin) && versionOf(dir) === PINNED) {
      return { bin, source: `npx 缓存 (${PINNED})` }
    }
  }
  return undefined
}

const args = process.argv.slice(2)
const found = fromLocal() ?? fromNpxCache()

let result
if (found) {
  if (!process.env['DSH_QUIET']) console.error(`[dsh] 使用 ${found.source}`)
  result = spawnSync(process.execPath, [found.bin, ...args], { stdio: 'inherit' })
} else {
  console.error(`[dsh] 本地与缓存均无 ${PINNED}，回退到 npx 拉取（首次会比较慢）`)
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  result = spawnSync(npx, ['-y', `@deepseek-ai/dsh@${PINNED}`, ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

process.exit(result.status ?? 1)
