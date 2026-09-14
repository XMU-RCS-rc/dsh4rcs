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
 *   node scripts/dsh.mjs --profile web --dump-config --patch ./config/overlays/dev.cordis.yml
 *   node scripts/dsh.mjs plugin --profile rcs-dev add ./packages/dsh-rcs-control
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

// 版本常量放在 rcs-core 里，因为 freshness.ts 也要用它和上游 latest 比对，
// 而本文件在顶层就启动 dsh（没有 main 守卫），不能被 import。
import { PINNED_DSH } from '../packages/rcs-core/src/versions.ts'
import {
  bootedProfile,
  ensureAppendOnlyReporter,
  findCachedDsh,
  heartbeatLine,
  isInteractive,
  normalizeChildExit,
  patchFiles,
  patchSetsConfig,
  pluginInstallStage,
  resolveDshHome,
} from '../packages/rcs-core/src/dsh-runtime.ts'
import { profileBootProblem } from '../packages/rcs-core/src/profile-manifest.ts'

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

/**
 * 启动前看一眼 dsh4rcs 管的那个 profile（`npm run dsh:start` 起的就是它）。
 * 缺网页界面的 profile 起来不打印任何东西、也不退出，人只会以为还在加载 ——
 * 这种直接拦下并给出修法。别的 profile 不归本仓库管，不看。见 docs/troubleshooting.md。
 * 返回 true 表示拦下了。
 */
function refuseBrokenProfile() {
  const profile = bootedProfile(args)
  if (profile === undefined || profile !== (process.env['DSH4RCS_PROFILE'] ?? 'rcs-dev')) return false
  const manifestPath = join(resolveDshHome(), 'profiles', profile, 'package.json')
  let manifest
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      return false // 清单本身坏了，交给 dsh 自己报
    }
  }
  const problem = profileBootProblem(manifest, { profile, manifestPath })
  if (!problem) return false
  const [first, ...rest] = problem.message.split('\n')
  note(`[dsh] ${problem.level === 'block' ? '没有启动：' : '注意：'}${first}`)
  for (const line of rest) note(`      ${line}`)
  return problem.level === 'block'
}

/**
 * 启动 overlay 会整段替换 profile 里 rcs-guard 的 config（dsh 的 patch 不合并 config）。
 * profile 里若也给 rcs-guard 配了 config（比如加了 extraL2），这次启动它不生效 ——
 * 自定义的 L2 工具退回 L0、不再弹确认。这种事不能悄悄发生，所以说一声。
 */
function warnGuardConfigShadowed() {
  const profile = bootedProfile(args)
  if (profile === undefined) return
  const read = (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  const shadowing = patchFiles(args).filter((file) => patchSetsConfig(read(resolve(file)), 'rcs-guard'))
  if (shadowing.length === 0) return
  // dsh 叠加的顺序是 bundle → profile 的 cordis.patch.yml → dsh home 的 cordis.patch.yml → --patch，
  // 前两层用户层里的 guard 配置都会被 overlay 盖掉。
  const home = resolveDshHome()
  const userLayers = [join(home, 'profiles', profile, 'cordis.patch.yml'), join(home, 'cordis.patch.yml')]
  const shadowed = userLayers.filter((path) => patchSetsConfig(read(path), 'rcs-guard'))
  if (shadowed.length === 0) return
  note(`[dsh] 注意：${shadowed.join('、')} 里给 rcs-guard 配的 config 这次不生效 ——`)
  note(`      ${shadowing.join('、')} 会整段替换它（dsh 的 patch 不合并 config），extraL2 等以后者为准。`)
  note('      队里的自定义 L2 工具请加在 config/overlays/ 下 dsh4rcs-training / dsh4rcs-competition 两份 overlay 的 extraL2 里。')
}

const blocked = refuseBrokenProfile()
if (!blocked) warnGuardConfigShadowed()

let status
if (blocked) {
  status = 1
} else if (found) {
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
