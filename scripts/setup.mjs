#!/usr/bin/env node
/**
 * 首次安装自检 —— 队友 clone 下来跑这一条就知道还缺什么。
 *
 *   npm run setup
 *
 * 它**只读不写**（除非你传 --write）：先把每一项的实际状态查清楚并给出
 * 可操作的下一步，而不是默默改你的配置。写操作只有一处，就是在你显式要求时
 * 把探测到的固件仓库路径写进 config/team.json。
 *
 * 设计原则和这套工具的其它部分一致：**能查的就查，查不到就明确说找过哪里**，
 * 绝不猜一个路径然后让人对着莫名其妙的结果调试。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveFirmwareRoot, firmwareNotFoundMessage, repoPaths } from '../packages/rcs-core/src/paths.ts'
import { probeToolchain } from '../packages/rcs-core/src/toolchain.ts'
import { nodeDeps } from '../packages/rcs-core/src/runner.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const write = process.argv.includes('--write')

const ok = (s) => `  ✅ ${s}`
const bad = (s) => `  ❌ ${s}`
const warn = (s) => `  ⚠️  ${s}`
// 只记数字的话，结尾那句"见上面标 ❌ 的条目"就可能指向一条**没被计数**的 ❌
// （固件仓库那条就是），人会去修一个不阻塞的问题，真正卡住的反而找不到。
// 存原因，结尾直接把它们念出来。
const blockers = []
const block = (reason) => blockers.push(reason)

console.log('dsh4rcs 安装自检\n')

// ---------- 1. Node ----------
console.log('[1/7] Node 运行时')
// 门槛是 22.18 而不是 22：原生 TypeScript 剥离从 22.18 起才默认开启。
// 早先只查主版本号，于是 22.5 的机器在这里拿到 ✅，接着在任何 import .ts 的
// 脚本上崩一句 ERR_UNKNOWN_FILE_EXTENSION —— 一个自检打了勾之后才出现的失败，
// 比不检查更难排。
const [major, minor] = process.versions.node.split('.').map(Number)
if (major > 22 || (major === 22 && minor >= 18)) console.log(ok(`Node ${process.versions.node}`))
else {
  console.log(bad(`Node ${process.versions.node} —— 需要 22.18 或更高（用到了原生 TS 剥离与新 fs API）`))
  block(`Node 版本太低（${process.versions.node} < 22.18）`)
}

// ---------- 2. 依赖 ----------
console.log('\n[2/7] 依赖')
if (existsSync(join(REPO, 'node_modules'))) console.log(ok('node_modules 已安装'))
else {
  console.log(bad('还没装依赖 —— 先跑 `npm install`'))
  block('没装依赖（npm install）')
}

// ---------- 3. 构建产物 ----------
console.log('\n[3/7] 构建产物')
// 与 build.mjs 的 PLUGINS 保持一致。漏一个就会在 7 插件的仓库上报「5/5 已构建」——
// 那是一个没验过的勾，正是本仓库「假绿比红更危险」那条要防的。
const plugins = [
  'dsh-rcs-core',
  'dsh-rcs-guard',
  'dsh-rcs-control',
  'dsh-rcs-rules',
  'dsh-rcs-kb',
  'dsh-rcs-ui-client',
  'dsh-rcs-train',
]
const built = plugins.filter((p) => existsSync(join(REPO, 'packages', p, 'lib', 'index.js')))
if (built.length === plugins.length) console.log(ok(`${built.length}/${plugins.length} 个插件已构建`))
else {
  console.log(warn(`${built.length}/${plugins.length} 个插件已构建 —— 跑 \`npm run build\``))
}

// ---------- 4. 固件仓库 ----------
console.log('\n[4/7] RCS 固件仓库')
let configured = ''
const teamFile = repoPaths.teamConfig()
if (existsSync(teamFile)) {
  try {
    configured = JSON.parse(readFileSync(teamFile, 'utf8'))?.firmware?.repo ?? ''
  } catch { /* 配置坏了下一步会报 */ }
}
const fw = resolveFirmwareRoot(configured ? { explicit: configured } : {})
if (fw.ok) {
  console.log(ok(`${fw.root}`))
  console.log(`     （来源：${fw.from}）`)
  if (write && !configured) {
    const raw = JSON.parse(readFileSync(teamFile, 'utf8'))
    raw.firmware.repo = fw.root.replace(/\\/g, '/')
    writeFileSync(teamFile, `${JSON.stringify(raw, null, 2)}\n`)
    console.log(`     已写入 config/team.json 的 firmware.repo`)
  } else if (!configured) {
    console.log('     自动发现的，没有写进配置。想固定下来：`npm run setup -- --write`')
  }
} else {
  // 用 ⚠️ 而不是 ❌：这一项**不计入阻塞**，规则查询与知识检索照常能用。
  // 标 ❌ 却不计数，会让结尾的"还有 N 项必须先解决"指错地方。
  console.log(warn('找不到固件仓库（不阻塞：只影响工程检查与构建烧录类工具）'))
  console.log(firmwareNotFoundMessage(fw.tried).split('\n').map((l) => `     ${l}`).join('\n'))
  console.log('     （只影响工程检查与构建烧录类工具；规则查询与知识检索不受影响）')
}

// ---------- 5. 队内配置与数据 ----------
console.log('\n[5/7] 队内配置与数据')
if (existsSync(teamFile)) {
  try {
    const t = JSON.parse(readFileSync(teamFile, 'utf8'))
    console.log(ok(`config/team.json —— ${t.team} ${t.season} 赛季「${t.theme ?? '主题待定'}」`))
  } catch (e) {
    console.log(bad(`config/team.json 解析失败：${e.message}`))
    block(`config/team.json 解析失败：${e.message}`)
  }
} else {
  console.log(bad('缺 config/team.json'))
  block('缺 config/team.json')
}
const rules = repoPaths.rulesRoot()
if (existsSync(rules)) {
  console.log(ok(`规则数据目录存在：${rules}`))
} else {
  console.log(warn(`没有规则数据（${rules}）—— 用 rcs_rule_import 导入规则书`))
}

// ---------- 5.5 生成 L3 调试 overlay ----------
// dev.cordis.yml 必须写绝对的 file:/// URL —— Windows 上 Node 的 ESM 加载器
// 拒收裸盘符路径（ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'）。
// 所以它天然是机器相关的、不进版本控制，这里按本机路径生成。
const overlay = join(REPO, 'dev.cordis.yml')
if (!existsSync(overlay)) {
  const url = (p) => `file:///${join(REPO, 'packages', p, 'lib', 'index.js').replace(/\\/g, '/')}`
  const lines = [
    '# 本地调试用的 patch overlay（由 npm run setup 生成，已 gitignore）。',
    '#',
    '#   npm run dsh:patch          # 带此 overlay 启动',
    '#   npm run dsh:patch:config   # 只打印配置树，排错首选',
    '#',
    '# name 必须是 file:/// URL，不能是裸盘符路径 —— Windows 上 Node 的 ESM',
    '# 加载器会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。注意是三个斜杠。',
    '# 指向 lib 而非 src：dsh 没有 TypeScript 源码加载器。',
    '- insert:',
    '    - id: rcs-control',
    `      name: '${url('dsh-rcs-control')}'`,
    '    - id: rcs-kb',
    `      name: '${url('dsh-rcs-kb')}'`,
    '',
  ]
  writeFileSync(overlay, lines.join('\n'))
  console.log('\n[5.5] 已生成 dev.cordis.yml（L3 调试用，按本机路径）')
}

// ---------- 5.6 宿主包实例统一 ----------
// 插件以 link: 装进 profile，而 Node 按**真实路径**解析模块 —— 会先撞到本仓库
// 自己的 node_modules，拿到与宿主不同的那一份 dsh-tools。
// dsh 的 code mode 用普通 Symbol()（不是 Symbol.for）做键，实例私有，
// 于是宿主读不到 → "Cannot read properties of undefined (reading 'prepare')"，
// 而且那一轮会在工具调用中途崩溃，把整个会话的历史弄坏（之后每轮都被 API 拒绝）。
// 详见 scripts/link-host-packages.mjs 的文件头。
console.log('\n[5.6] 宿主包实例')
try {
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, [join(REPO, 'scripts', 'link-host-packages.mjs'), '--check'], { stdio: 'pipe' })
  console.log(ok('插件与宿主使用同一份宿主包'))
} catch (e) {
  // 三种失败要分开说，因为对应的动作完全不同：
  //   2 = 本机根本没有 dsh 运行时 —— 还没到双实例这一步，不是风险
  //   3 = 有运行时但版本对不上 —— 让脚本自己把找到了什么讲清楚，别在这里复述
  //   其它 = 版本对得上、只是还没联接 —— 跑一下脚本就好
  // 早先 3 和"没联接"是同一条分支，于是给出的建议是"跑脚本修复"，
  // 而那条命令在版本不一致时必然再失败一次；人照做、失败、无从下手。
  if (e.status === 2) {
    console.log(warn('本机还没有 dsh 运行时，无法检查'))
    console.log('       只想跑 npm run check / npm run test 的话，这项可以不管。')
    console.log('       要用 dsh：`npm install` 会把锁定版运行时装进本仓库。')
  } else if (e.status === 3) {
    console.log(bad('宿主运行时版本与本仓库锁定的不一致'))
    const detail = (e.stderr ?? Buffer.alloc(0)).toString('utf8').trimEnd()
    if (detail) console.log(detail.split('\n').map((l) => `     ${l}`).join('\n'))
    block('宿主运行时版本不一致（详见 [5.6]）')
  } else {
    console.log(warn('存在双实例风险 —— 跑 `node scripts/link-host-packages.mjs` 修复'))
    console.log('       npm install 之后要重跑一次：装依赖会把联接变回普通目录。')
    block('宿主包双实例风险（node scripts/link-host-packages.mjs）')
  }
}

// ---------- 6. 工具链 ----------
console.log('\n[6/7] 本机工具链（可选，缺了只影响对应工具）')
for (const t of probeToolchain(nodeDeps)) {
  if (t.available) console.log(ok(`${t.label}  ${t.path ?? ''}`))
  else {
    console.log(warn(`${t.label} 未找到`))
    if (t.hint) console.log(t.hint.split('\n').map((l) => `       ${l}`).join('\n'))
  }
}

// ---------- 7. 版本新鲜度 ----------
// 这一节要联网（git ls-remote + npm registry），但**刻意不写缓存** ——
// 本脚本对外承诺「只读不写」。它跑得不频繁，多打一次网无所谓；
// 常用路径是 rcs_version_status 工具，那边走 24 小时缓存。
//
// 三项都不是阻塞项：离线是正常状态，规则书没确认过也不妨碍任何本地功能。
console.log('\n[7/7] 版本新鲜度（联网，失败不影响任何本地功能）')
try {
  const { checkFreshness, summarizeFreshness, nodeFetchJson } = await import(
    '../packages/rcs-core/src/freshness.ts'
  )
  const { nodeRunner } = await import('../packages/rcs-core/src/runner.ts')
  const teamRules = existsSync(teamFile)
    ? (JSON.parse(readFileSync(teamFile, 'utf8')).rules ?? { currentVersion: '（未知）' })
    : { currentVersion: '（未知）' }

  const report = await checkFreshness({
    deps: { run: nodeRunner, fetchJson: nodeFetchJson },
    repoRoot: REPO,
    rules: teamRules,
    now: new Date(),
    // store 省略 —— 不落盘
  })
  console.log(summarizeFreshness(report).split('\n').map((l) => `  ${l}`).join('\n'))
} catch (e) {
  console.log(warn(`新鲜度检查没跑起来：${e.message}`))
  console.log('       这一项失败不影响任何本地功能，可以忽略。')
}

// ---------- 结论 ----------
console.log(`
${'─'.repeat(60)}`)
if (blockers.length === 0) {
  console.log('可以用了。接下来：')
  console.log('  npm run verify        # 跑一遍类型检查 / 构建 / 测试')
  console.log('  npm run dsh:install   # 装进 dsh 的 rcs-dev profile')
  console.log('  npm run dsh:start     # 启动，等打印出 dsh web 地址再开浏览器')
} else {
  console.log(`还有 ${blockers.length} 项必须先解决：`)
  for (const reason of blockers) console.log(`  · ${reason}`)
}

// 不要用 process.exit()。第 7 节发过网络请求，undici 的套接字还在关闭中，
// 这时强制退出会在 Windows 上触发 libuv 断言：
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
// 进程随即以 127 崩掉 —— 自检明明跑完了，最后一行却是一句看不懂的 C 断言，
// 而且退出码也是错的（127 而不是 1）。设 exitCode 让事件循环自然收尾，
// 实测多等不到一秒。
process.exitCode = blockers.length === 0 ? 0 : 1
