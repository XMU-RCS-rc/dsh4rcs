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
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

// 版本常量放在 rcs-core 里，因为 freshness.ts 也要用它和上游 latest 比对，
// 而本文件在顶层就启动 dsh（没有 main 守卫），不能被 import。
import { PINNED_DSH } from '../packages/rcs-core/src/versions.ts'
import {
  ensureAppendOnlyReporter,
  findCachedDsh,
  heartbeatLine,
  isInteractive,
  normalizeChildExit,
  pluginInstallStage,
} from '../packages/rcs-core/src/dsh-runtime.ts'

/** 本插件验证过的 dsh 版本。改动前请重跑 `npm run verify`。 */
export const PINNED = PINNED_DSH

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
  return findCachedDsh(PINNED)
}

const args = process.argv.slice(2)
const found = fromLocal() ?? fromNpxCache()
const interactive = isInteractive(process.stderr.isTTY, process.env)
const installStage = pluginInstallStage(args)

function note(message) {
  process.stderr.write(`${message}\n`)
}

if (args[0] === 'plugin') {
  ensureAppendOnlyReporter(process.env, interactive)
}
if (installStage) note(installStage)

let status
if (found) {
  if (!process.env['DSH_QUIET']) console.error(`[dsh] 使用 ${found.source}`)
  const result = spawnSync(process.execPath, [found.bin, ...args], { stdio: 'inherit' })
  if (result.error) {
    note(`[dsh] 启动失败：${result.error.message}`)
    status = result.error.code === 'ENOENT' ? 127 : 1
  } else if (result.signal) {
    note(`[dsh] 子进程被信号 ${result.signal} 终止`)
    status = 1
  } else {
    status = result.status ?? 1
  }
} else {
  note(`[dsh] 本地与缓存均无 ${PINNED}，改用 npx 拉取；首次可能需要数分钟`)
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const startedAt = Date.now()
  const timer = interactive
    ? undefined
    : setInterval(() => note(heartbeatLine('拉取 dsh 运行时', Date.now() - startedAt)), 15_000)
  timer?.unref()

  status = await new Promise((resolveStatus) => {
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      if (timer) clearInterval(timer)
      const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      note(`[dsh] 拉取 dsh 运行时${code === 0 ? '完成' : '结束'}，用时 ${elapsed}s`)
      resolveStatus(code)
    }

    // Windows 的 cmd 在不同版本上会把“命令不存在”压成 1 或 9009，
    // 不能靠 close code 猜。先用系统 where.exe 做无 shell 的确定性预检。
    if (process.platform === 'win32') {
      const lookup = spawnSync('where.exe', [npx], { stdio: 'ignore', shell: false })
      if (lookup.status !== 0) {
        note('[dsh] npx 不在 PATH 上，无法下载锁定版 dsh')
        finish(127)
        return
      }
    }

    let child
    try {
      child = spawn(npx, ['-y', `@deepseek-ai/dsh@${PINNED}`, ...args], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
    } catch (error) {
      note(`[dsh] 启动 npx 失败：${error instanceof Error ? error.message : String(error)}`)
      finish(1)
      return
    }
    child.once('error', (error) => {
      note(
        error.code === 'ENOENT'
          ? '[dsh] npx 不在 PATH 上，无法下载锁定版 dsh'
          : `[dsh] 启动 npx 失败：${error.message}`,
      )
      finish(error.code === 'ENOENT' ? 127 : 1)
    })
    child.once('close', (code, signal) => {
      if (signal) note(`[dsh] npx 被信号 ${signal} 终止`)
      const normalized = normalizeChildExit(code, signal, process.platform)
      if (normalized.missingCommand) note('[dsh] npx 不在 PATH 上，无法下载锁定版 dsh')
      finish(normalized.code)
    })
  })
}

// 不用 process.exit()：stderr 指向管道时写入是异步的，强退可能截掉最后一行。
process.exitCode = status
