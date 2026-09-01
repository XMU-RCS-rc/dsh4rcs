#!/usr/bin/env node
/**
 * 把仓库内的宿主包换成指向 dsh 运行时那一份的目录联接（junction）。
 *
 *   node scripts/link-host-packages.mjs          # 应用
 *   node scripts/link-host-packages.mjs --check  # 只检查，不改
 *   node scripts/link-host-packages.mjs --undo   # 还原成 npm 装的普通目录
 *
 * ## 为什么必须这么做
 *
 * 插件以 `link:` 装进 dsh profile，而 **Node 按真实路径解析模块**：
 * 从 `packages/dsh-rcs-x/lib/index.js` 往上找 `@deepseek-ai/dsh-tools`，
 * 会先撞到本仓库自己的 `node_modules`，拿到**与宿主不同的那一份**。
 *
 * 平时看不出问题，因为工具注册走的是普通对象。但 dsh 的 code mode 用
 * **普通 `Symbol()`**（不是 `Symbol.for()`）做键：
 *
 *     const TOOL_RUNTIME_SCHEDULER = Symbol('@deepseek-ai/dsh-tools.scheduler')
 *     const scheduler = registry[TOOL_RUNTIME_SCHEDULER]
 *
 * 普通 Symbol 是**实例私有**的：两份 dsh-tools = 两个不同的符号，
 * 宿主拿自己的符号去读，取回 `undefined`，然后
 * `Cannot read properties of undefined (reading 'prepare')`。
 *
 * 更糟的是后果：那一轮在工具调用中途崩溃，会话历史里留下一个没有对应
 * 结果的 `tool_calls`，之后**每一轮**都会被模型 API 拒绝
 * （"An assistant message with 'tool_calls' must be followed by tool messages"）
 * —— 整个会话永久报废，只能新建。而走不走 code mode 是模型自己决定的，
 * 没法靠"别用"规避。
 *
 * ## 注意
 *
 * `npm install` 会把联接重新变回普通目录，所以装完依赖要再跑一次本脚本。
 * `npm run setup` 会自动处理。
 *
 * 只在**版本完全一致**时才联接 —— 版本不同就说明该升级仓库依赖，
 * 而不是偷偷指到另一个版本上。
 */
import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, renameSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCOPE = join(REPO, 'node_modules', '@deepseek-ai')

/**
 * 需要与宿主统一的**全部**位置。
 *
 * profile 那份最要紧：dsh 的 loader 从 profile 根解析插件名，所以
 * `ctx.tools`（ToolRuntime 实例）来自 profile 的 dsh-tools；而 dsh-agent-loop
 * 来自 npx 缓存，它用自己那份的符号去读 `ctx.tools[TOOL_RUNTIME_SCHEDULER]`。
 * 两份不统一 → 取回 undefined → 无论标准模式还是 code 模式都崩。
 */
const SCOPES = [
  ['仓库', SCOPE],
  ['profile', join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.dsh', 'profiles', 'rcs-dev', 'node_modules', '@deepseek-ai')],
]

/** 只统一**宿主必须唯一**的这几个。其余包各自一份没有影响。 */
const HOST_PACKAGES = ['dsh-tools', 'cordis', 'schemastery']

const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--undo') ? 'undo' : 'apply'

/** 找到 dsh 运行时实际使用的 node_modules。 */
function findHostScope() {
  const cache = join(process.env['LOCALAPPDATA'] ?? '', 'npm-cache', '_npx')
  if (!existsSync(cache)) return undefined
  for (const dir of readdirSync(cache)) {
    const p = join(cache, dir, 'node_modules', '@deepseek-ai')
    if (existsSync(join(p, 'dsh-tools', 'package.json'))) return p
  }
  return undefined
}

const version = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}
const isLink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

const host = findHostScope()
if (!host) {
  console.error('找不到 dsh 运行时的 node_modules（npx 缓存）。先跑一次 `npm run dsh:config` 让 npx 把它下下来。')
  process.exit(2)
}
console.log(`宿主包位置：${host}\n`)

let changed = 0
let mismatch = 0

for (const [where, scope] of SCOPES) {
  if (!existsSync(scope)) {
    console.log(`[${where}] 目录不存在，跳过：${scope}\n`)
    continue
  }
  console.log(`[${where}] ${scope}`)
  processScope(where, scope)
  console.log()
}

function processScope(where, scope) {
for (const name of HOST_PACKAGES) {
  const mine = join(scope, name)
  const theirs = join(host, name)
  const label = name.padEnd(14)

  // 宿主自己那份不用动
  if (resolve(mine) === resolve(theirs)) {
    console.log(`  ·   ${label}就是宿主本体`)
    continue
  }
  if (!existsSync(theirs)) {
    console.log(`  ⚠️  ${label}宿主侧没有这个包，跳过`)
    continue
  }
  if (!existsSync(mine)) {
    console.log(`  ·   ${label}此处未安装，无需处理`)
    continue
  }

  if (mode === 'undo') {
    if (isLink(mine)) {
      rmSync(mine, { recursive: true, force: true })
      console.log(`  ↩️  ${label}已移除联接 —— 跑 npm install 恢复普通目录`)
      changed++
    } else {
      console.log(`  ·   ${label}本来就是普通目录`)
    }
    continue
  }

  if (isLink(mine)) {
    console.log(`  ✅ ${label}已联接到宿主`)
    continue
  }

  const vMine = version(mine)
  const vTheirs = version(theirs)
  if (vMine !== vTheirs) {
    // 版本不一致时**不联接** —— 那是依赖该升级了，偷偷指过去只会掩盖问题
    console.log(`  ❌ ${label}版本不一致：仓库 ${vMine} vs 宿主 ${vTheirs}`)
    console.log(`     先把 package.json 里的版本对齐再跑本脚本。`)
    mismatch++
    continue
  }

  if (mode === 'check') {
    console.log(`  ⚠️  ${label}是独立副本（${vMine}）—— 会造成双实例，跑本脚本修复`)
    changed++
    continue
  }
  void where

  // 原目录先改名保留，联接成功后再删，避免中途失败把依赖弄没
  const backup = `${mine}.npm-copy`
  rmSync(backup, { recursive: true, force: true })
  renameSync(mine, backup)
  try {
    symlinkSync(theirs, mine, 'junction')
    rmSync(backup, { recursive: true, force: true })
    console.log(`  ✅ ${label}已联接到宿主（${vTheirs}）`)
    changed++
  } catch (e) {
    renameSync(backup, mine)
    console.log(`  ❌ ${label}联接失败，已还原：${e.message}`)
    mismatch++
  }
}
}


if (mismatch > 0) {
  console.log(`${mismatch} 项未处理，见上。`)
  process.exit(1)
}
if (mode === 'check') {
  console.log(changed === 0 ? '宿主包已统一，无双实例风险。' : `${changed} 项需要处理：node scripts/link-host-packages.mjs`)
  process.exit(changed === 0 ? 0 : 1)
}
console.log(mode === 'undo' ? '已还原。跑 `npm install` 装回普通副本。' : '完成。插件与宿主现在用同一份宿主包。')
