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
 * 只在**版本完全一致**时才联接。版本不一致时**不要改仓库的 package.json**：
 * 仓库锁的是验证过的那一版，漂掉的是本机运行时。npx 缓存目录名是调用规格的哈希，
 * 建好之后就不再重新解析依赖，而 dsh 把兄弟包声明成 `^` 范围 —— 同一条拉取命令
 * 在不同时间建出来的树并不一样。正确的修法是让本仓库自己装一份锁定版运行时。
 */
import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, renameSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 版本选择逻辑放在 rcs-core 里是为了能注入依赖做单测：挑错宿主的后果是会话历史
// 被弄坏，这段判断必须有测试兜着，不能只活在一个脚本里。
//
// 用动态 import 而不是静态，是因为本脚本由 postinstall 调用，而加载 .ts 依赖
// Node 的原生类型剥离（22.18 起默认开启）。版本不够时静态 import 会让
// `npm install` 直接死在一句 ERR_UNKNOWN_FILE_EXTENSION 上 —— 那是队友第一次
// clone 时最难自己看懂的一种失败。
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 18)) {
  console.log(`需要 Node 22.18 或更高（当前 ${process.versions.node}）—— 本仓库用到了原生 TypeScript 剥离。`)
  process.exit(process.argv.includes('--postinstall') ? 0 : 2)
}
const { selectHostScope, hostScopeNotFoundMessage } = await import(
  '../packages/rcs-core/src/dsh-runtime.ts'
)

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCOPE = join(REPO, 'node_modules', '@deepseek-ai')

/** `~/.dsh/profiles` 的位置。 */
const PROFILES_DIR = join(
  process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
  '.dsh',
  'profiles',
)

/**
 * 列出**所有**已存在的 profile。
 *
 * 早先这里写死了 `rcs-dev`，于是新建一个 profile 做验证时它拿不到联接，
 * 静默带着双实例风险跑起来 —— 而那个风险的后果是 code mode 崩溃并
 * **永久毁掉会话历史**。写死一个名字省不了几行，代价却是这种级别的故障，
 * 所以改成扫描：有几个 profile 就检查几个，谁也不会被漏掉。
 */
function discoverProfileScopes() {
  if (!existsSync(PROFILES_DIR)) return []
  return readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => [`profile:${e.name}`, join(PROFILES_DIR, e.name, 'node_modules', '@deepseek-ai')])
    .filter(([, scope]) => existsSync(scope))
}

/**
 * 需要与宿主统一的**全部**位置。
 *
 * profile 那几份最要紧：dsh 的 loader 从 profile 根解析插件名，所以
 * `ctx.tools`（ToolRuntime 实例）来自 profile 的 dsh-tools；而 dsh-agent-loop
 * 来自 npx 缓存，它用自己那份的符号去读 `ctx.tools[TOOL_RUNTIME_SCHEDULER]`。
 * 两份不统一 → 取回 undefined → 无论标准模式还是 code 模式都崩。
 */
const SCOPES = [['仓库', SCOPE], ...discoverProfileScopes()]

/** 只统一**宿主必须唯一**的这几个。其余包各自一份没有影响。 */
const HOST_PACKAGES = ['dsh-tools', 'cordis', 'schemastery']

const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--undo') ? 'undo' : 'apply'
/**
 * 由 postinstall 调用时传入。差别只有一处：**找不到宿主就安静退出 0**。
 *
 * 没有它，`npm install` 会在任何没装过 dsh 的机器上直接失败（postinstall
 * 非零退出会让 npm 整个装不上）—— 包括队友的第一次 clone，以及 CI。
 * 而双实例风险本来就由 `npm run setup` 作为阻塞项报告，postinstall 只是顺手
 * 维护，不该是安装的门槛。
 */
const fromPostinstall = process.argv.includes('--postinstall')

/**
 * 本仓库要求的宿主包版本 —— 判据来自 package.json 的 overrides，
 * 而不是"宿主装了什么"。反过来拿宿主去改仓库是本末倒置：
 * 插件是按锁定版的类型定义写并验证的。
 */
function wantedVersions() {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
  const overrides = pkg.overrides ?? {}
  const wanted = {}
  for (const name of HOST_PACKAGES) {
    const v = overrides[`@deepseek-ai/${name}`]
    if (typeof v === 'string') wanted[name] = v
  }
  return wanted
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

const WANTED = wantedVersions()
const picked = selectHostScope(WANTED, { repoScope: SCOPE })

if (!picked.ok) {
  if (fromPostinstall) {
    // 还没装过 dsh、或者装的版本不对，都不该让 `npm install` 整个失败：
    // 第一次 clone、CI、只想跑 npm run check 的人都会卡在这里。
    // 双实例风险由 `npm run setup` 作为阻塞项报告，postinstall 只是顺手维护。
    console.log('（跳过宿主包联接：本机还没有版本一致的 dsh 运行时。跑 `npm run setup` 看详情。）')
    process.exit(0)
  }
  console.error(hostScopeNotFoundMessage(WANTED, picked.candidates))
  // 退出码分开：2 = 本机压根没有运行时，3 = 有但版本不对。
  // 合成一个的话，setup.mjs 只能笼统说"还没装 dsh"，而那句话对后者是错的，
  // 会让人去装一个已经装了的东西。
  process.exit(picked.candidates.length === 0 ? 2 : 3)
}

const host = picked.scope
console.log(`宿主包位置：${host}`)
console.log(`（来源：${picked.source}）`)
console.log()

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
