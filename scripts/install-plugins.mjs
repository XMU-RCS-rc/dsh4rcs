#!/usr/bin/env node
/**
 * 把这套插件装进 dsh profile —— `npm run dsh:install` 走的就是本脚本。
 *
 * 比一条 `dsh plugin add` 多做三件事，每一件都对应一个「照着 README 走完却打不开」的坑。
 *
 * ## 一、新 profile 用 dsh 自带的 web 模板建
 *
 * 按名字新建的 profile 只有 `dsh-base`：起来没有网页界面，`dsh-rcs-ui-client` 注入的
 * 客户端模块也无处附着。0.1.0-rc.6 时的做法是把 `dsh-web-app` 当依赖装进 profile，
 * 好让 dsh 的对账把它写进 bundles —— 可 dsh 解析 bundle **永远先找安装目录**，
 * profile 里那份从来不会被当 bundle 用到，只是白白拖进整套客户端依赖（外加几个要跑
 * 原生构建的包），还在 profile 里留下一份与宿主不同的 dsh-tools，那是双实例的来源。
 * 0.1.5 起 `--from-default-profile web` 按官方模板初始化，profile 里不装任何宿主包。
 *
 * ## 二、旧 profile 就地迁移
 *
 * rc.6 时代装进去的 `dsh-web-app` / `dsh-client-ui-primitives` 从 dependencies 摘掉
 * （bundles 里的 web-app 保留），接下来那一轮 pnpm 会把它们连同上一代宿主包一起清掉。
 * 必须赶在 pnpm 之前改，理由见 rcs-core/src/profile-manifest.ts。
 *
 * ## 三、把版本 overrides 写进 profile 的 pnpm-workspace.yaml
 *
 * profile 里已经没有宿主包，这一段是保险：谁往 profile 里加了宿主包，也只能解析到与
 * 服务端同一代。rc.6 那次前端漂到 rc.8、服务端还是 rc.6，网页端永远停在
 * "Loading plugins…" —— cordis 的 inject 是无限等待且不报错，界面上、控制台里都没有线索。
 * 三十多个新生装机，这种"不报错、只是打不开"的坑代价最高，所以放进脚本。
 *
 * 顺序是刻意的：**先落配置，再让 pnpm 跑第一次**。pnpm 默认忽略依赖的构建脚本并以
 * `ERR_PNPM_IGNORED_BUILDS` 失败退出，配置落晚了那一步就已经失败。按模板初始化本身
 * 不跑 pnpm，所以「建 profile → 写配置 → 装插件」满足这个顺序。
 *
 * profile 目录按 dsh 的同一条规则定位：`$DSH_HOME/profiles/<名>`，没设 DSH_HOME 时是
 * `~/.dsh/profiles/<名>`。早先写死 `~/.dsh`，设了 DSH_HOME 的机器上配置写进一个 dsh
 * 根本不读的目录，安装却照样报成功。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkPnpm, resolveDshHome } from '../packages/rcs-core/src/dsh-runtime.ts'
import { migrateProfileManifest } from '../packages/rcs-core/src/profile-manifest.ts'
import { withOverridesBlock, hasForeignOverrides } from '../packages/rcs-core/src/profile-overrides.ts'
import { pnpmVersionOutput, whichSync } from '../packages/rcs-core/src/runner.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = process.env['DSH4RCS_PROFILE'] ?? 'rcs-dev'
const PROFILE_DIR = join(resolveDshHome(), 'profiles', PROFILE)
const MANIFEST = join(PROFILE_DIR, 'package.json')
const WORKSPACE_YAML = join(PROFILE_DIR, 'pnpm-workspace.yaml')

/**
 * 允许跑安装脚本的依赖。pnpm 默认忽略构建脚本并以 ERR_PNPM_IGNORED_BUILDS
 * **失败退出**。新布局下 profile 不从 npm 装任何包，这一行通常用不上；
 * 留着是因为 koffi（原生 FFI 库）就在宿主依赖闭包里 —— 谁往 profile 里加了宿主包，
 * 撞上的是硬失败而不是警告。
 */
const ALLOW_BUILDS = ['koffi']

/**
 * pnpm-workspace.yaml 缺失时的兜底模板头，与 dsh 0.1.5-rc.2 初始化 profile 时写的
 * 逐字一致（rc.6 起没变过）。正常情况下这个文件由 dsh 建 profile 时写好，这里只是兜底；
 * 升级 dsh 时核对一次 —— dsh 改了模板而这里没跟，症状是 pnpm workspace 配置不对。
 */
const TEMPLATE_HEAD = ['packages:', '  - .', '', 'nodeLinker: hoisted', 'autoInstallPeers: false', ''].join('\n')

const PLUGINS = [
  'dsh-rcs-core',
  'dsh-rcs-guard',
  'dsh-rcs-rules',
  'dsh-rcs-control',
  'dsh-rcs-kb',
  'dsh-rcs-ui-client',
  'dsh-rcs-train',
]

/** 跑一条 dsh 子命令，失败就地停住 —— 半装的 profile 比没装更难排查。 */
function dsh(args, label, { quietStdout = false, header = true } = {}) {
  if (header) console.log(`\n[dsh:install] ${label}`)
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'dsh.mjs'), ...args], {
    stdio: ['inherit', quietStdout ? 'ignore' : 'inherit', 'inherit'],
    cwd: REPO,
  })
  if (r.error) {
    console.error(`[dsh:install] 启动失败：${r.error.message}`)
    process.exitCode = 1
    return false
  }
  if (r.status !== 0) {
    console.error(`[dsh:install] ${label} 失败（退出码 ${r.status}）`)
    process.exitCode = r.status ?? 1
    return false
  }
  return true
}

// ---------- 0. 先查 pnpm ----------
// 第 4 步由 dsh 转给 profile 目录里的 pnpm。缺了它，Windows 上 dsh 经 cmd 调用、拿不到 ENOENT，
// 报出来的只有 cmd 的「'pnpm' 不是内部或外部命令」加一句笼统的 `pnpm failed` —— 而那时构建做完了、
// profile 也建好了，留下一个半装的 profile。所以开工之前先查，缺了就什么都不做。
{
  const pnpmPath = whichSync('pnpm')
  const pnpm = checkPnpm({ path: pnpmPath, versionOutput: pnpmPath ? pnpmVersionOutput() : undefined })
  if (!pnpm.ok) {
    const [first, ...rest] = pnpm.reason.split('\n')
    console.error(`[dsh:install] ${first}`)
    for (const line of rest) console.error(`             ${line}`)
    process.exit(1)
  }
  console.log(`[dsh:install] pnpm ${pnpm.version}`)
  if (pnpm.warning) console.warn(`[dsh:install] ${pnpm.warning}`)
}

// ---------- 1. 构建 ----------
console.log(`\n[dsh:install 1/4] 构建 ${PLUGINS.length} 个插件`)
{
  const r = spawnSync(process.execPath, [join(REPO, 'build.mjs')], {
    stdio: 'inherit',
    cwd: REPO,
  })
  if (r.status !== 0) {
    console.error('[dsh:install] 构建失败，没有继续安装 —— 装一份旧产物只会让人对着过期代码调试。')
    process.exit(r.status ?? 1)
  }
}

// ---------- 2. 准备 profile ----------
console.log(`\n[dsh:install 2/4] 准备 profile ${PROFILE}：${PROFILE_DIR}`)
if (!existsSync(MANIFEST)) {
  if (existsSync(PROFILE_DIR)) {
    // dsh 只肯在目录不存在时按模板初始化 —— 它要独占这个目录，免得把残留状态当成新 profile。
    console.error(`[dsh:install] ${PROFILE_DIR} 已存在但没有 package.json，多半是上次安装中途失败留下的。`)
    console.error('             确认里面没有要留的东西（尤其是 cordis.patch.yml）后删掉这个目录再重跑。')
    process.exit(1)
  }
  // --dump-config 让 dsh 初始化完就退出而不起服务；它打印的配置树这里用不上，丢掉。
  if (
    !dsh(
      ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'],
      '按 dsh 自带的 web 模板新建 profile',
      { quietStdout: true },
    )
  ) {
    process.exit()
  }
} else {
  const { manifest, changes } = migrateProfileManifest(JSON.parse(readFileSync(MANIFEST, 'utf8')))
  if (changes.length === 0) {
    console.log('  已是当前布局，无需迁移')
  } else {
    // 缩进与换行照 dsh 自己写这个文件的格式，免得它下次改写时整份文件都显示成改动。
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
    for (const change of changes) console.log(`  ${change}`)
  }
}

// ---------- 3. 写 profile 配置（必须在 pnpm 第一次跑之前） ----------
console.log(`\n[dsh:install 3/4] 同步版本 overrides 到 ${WORKSPACE_YAML}`)
{
  const overrides = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).overrides ?? {}
  const count = Object.keys(overrides).length
  if (count === 0) {
    console.error('[dsh:install] 本仓库 package.json 里没有 overrides —— 拒绝写一份空的进去。')
    process.exit(1)
  }
  const existing = existsSync(WORKSPACE_YAML) ? readFileSync(WORKSPACE_YAML, 'utf8') : TEMPLATE_HEAD
  if (hasForeignOverrides(existing)) {
    // 重复的顶层键在 YAML 里只有一个生效，而哪个生效取决于解析器 ——
    // 那是"写进去了却没生效"的经典形态，比直接停下来难查得多。
    console.error(`[dsh:install] ${WORKSPACE_YAML} 里已有手写的 overrides 段。`)
    console.error('             自动合并会产生重复的顶层键（pnpm 只认其中一个，且不报错）。')
    console.error(`             生成段写的就是本仓库那 ${count} 条钉死；若那段是早先照文档手工加的，`)
    console.error('             直接删掉它再重跑即可，不会丢东西。')
    process.exit(1)
  }
  writeFileSync(WORKSPACE_YAML, withOverridesBlock(existing, { overrides, allowBuilds: ALLOW_BUILDS }))
  console.log(`  已写入 ${count} 条版本钉死（与本仓库 package.json 的 overrides 同源）`)
  console.log(`  允许构建：${ALLOW_BUILDS.join('、')}`)
}

// ---------- 4. 装插件 ----------
// 这一步的阶段标题（[dsh:install 4/4]）由 scripts/dsh.mjs 在转发 `plugin add` 前打印，这里不重复。
console.log('')
if (
  !dsh(
    ['plugin', '--profile', PROFILE, 'add', ...PLUGINS.map((p) => `./packages/${p}`)],
    `安装 ${PLUGINS.length} 个插件`,
    { header: false },
  )
) {
  process.exit()
}

// ---------- 收尾 ----------
// 升级前留下的 profile 里可能还有指向上一代运行时的联接；npm/pnpm 装完也会把联接变回普通目录。
console.log('\n[dsh:install] 检查宿主包联接')
spawnSync(process.execPath, [join(REPO, 'scripts', 'link-host-packages.mjs')], {
  stdio: 'inherit',
  cwd: REPO,
})

console.log('\n完成。启动：npm run dsh:start')
