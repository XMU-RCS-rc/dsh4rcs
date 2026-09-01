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
let blocking = 0

console.log('dsh4rcs 安装自检\n')

// ---------- 1. Node ----------
console.log('[1/6] Node 运行时')
const major = Number(process.versions.node.split('.')[0])
if (major >= 22) console.log(ok(`Node ${process.versions.node}`))
else {
  console.log(bad(`Node ${process.versions.node} —— 需要 22 或更高（用到了原生 TS 剥离与新 fs API）`))
  blocking++
}

// ---------- 2. 依赖 ----------
console.log('\n[2/6] 依赖')
if (existsSync(join(REPO, 'node_modules'))) console.log(ok('node_modules 已安装'))
else {
  console.log(bad('还没装依赖 —— 先跑 `npm install`'))
  blocking++
}

// ---------- 3. 构建产物 ----------
console.log('\n[3/6] 构建产物')
const plugins = ['dsh-rcs-core', 'dsh-rcs-guard', 'dsh-rcs-control', 'dsh-rcs-rules', 'dsh-rcs-kb']
const built = plugins.filter((p) => existsSync(join(REPO, 'packages', p, 'lib', 'index.js')))
if (built.length === plugins.length) console.log(ok(`${built.length}/${plugins.length} 个插件已构建`))
else {
  console.log(warn(`${built.length}/${plugins.length} 个插件已构建 —— 跑 \`npm run build\``))
}

// ---------- 4. 固件仓库 ----------
console.log('\n[4/6] RCS 固件仓库')
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
  console.log(bad('找不到固件仓库'))
  console.log(firmwareNotFoundMessage(fw.tried).split('\n').map((l) => `     ${l}`).join('\n'))
  console.log('     （只影响工程检查与构建烧录类工具；规则查询与知识检索不受影响）')
}

// ---------- 5. 队内配置与数据 ----------
console.log('\n[5/6] 队内配置与数据')
if (existsSync(teamFile)) {
  try {
    const t = JSON.parse(readFileSync(teamFile, 'utf8'))
    console.log(ok(`config/team.json —— ${t.team} ${t.season} 赛季「${t.theme ?? '主题待定'}」`))
  } catch (e) {
    console.log(bad(`config/team.json 解析失败：${e.message}`))
    blocking++
  }
} else {
  console.log(bad('缺 config/team.json'))
  blocking++
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

// ---------- 6. 工具链 ----------
console.log('\n[6/6] 本机工具链（可选，缺了只影响对应工具）')
for (const t of probeToolchain(nodeDeps)) {
  if (t.available) console.log(ok(`${t.label}  ${t.path ?? ''}`))
  else {
    console.log(warn(`${t.label} 未找到`))
    if (t.hint) console.log(t.hint.split('\n').map((l) => `       ${l}`).join('\n'))
  }
}

// ---------- 结论 ----------
console.log(`\n${'─'.repeat(60)}`)
if (blocking === 0) {
  console.log('可以用了。接下来：')
  console.log('  npm run verify        # 跑一遍类型检查 / 构建 / 测试')
  console.log('  npm run dsh:install   # 装进 dsh 的 rcs-dev profile')
  console.log('  npm run dsh:start     # 启动，等打印出 dsh web 地址再开浏览器')
} else {
  console.log(`还有 ${blocking} 项必须先解决，见上面标 ❌ 的条目。`)
}
process.exit(blocking === 0 ? 0 : 1)
