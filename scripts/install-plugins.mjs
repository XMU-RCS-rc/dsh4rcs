#!/usr/bin/env node
/**
 * 把这套插件装进 dsh profile —— `npm run dsh:install` 走的就是本脚本。
 *
 * 比一条 `dsh plugin add` 多做的那一步是**把版本 overrides 写进 profile**。
 * 缺了它，pnpm 会把客户端依赖解析到比服务端更新的一代（`dsh-web-app` 用
 * `^0.1.0-rc.6` 声明依赖，而预发布语义允许 rc.8 落进这个范围），
 * 于是网页端永远停在 "Loading plugins…" —— cordis 的 inject 是无限等待且不报错，
 * 界面上、控制台里都没有任何线索。
 *
 * 这份 overrides 过去只存在于维护者本机手改的 profile 里，仓库里没有；
 * 也就是说照着 README 一步步走完的新人**必然**撞上一个查不出原因的卡死。
 * 三十多个新生装机，这种"不报错、只是打不开"的坑代价最高，所以放进脚本。
 *
 * 顺序是刻意的：**先落配置，再让 pnpm 跑第一次**。
 * 反过来（先建 profile 再写配置）行不通：pnpm 默认忽略依赖的构建脚本并以
 * `ERR_PNPM_IGNORED_BUILDS` 失败退出，而 koffi 从第一次解析就在依赖里 ——
 * 那一步就已经失败了，根本轮不到后面写配置。
 *
 * profile 目录不存在时这里会补一份 dsh 的模板头（packages / nodeLinker /
 * autoInstallPeers）。dsh 只在文件缺失时才写模板，已存在就逐字保留，
 * 所以先来后到决定了以谁为准。模板头照抄 0.1.0-rc.6 首次初始化生成的内容；
 * 升级 dsh 时要核对一次 —— dsh 改了模板而这里没跟，症状是 pnpm workspace 配置不对。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { withOverridesBlock, hasForeignOverrides } from '../packages/rcs-core/src/profile-overrides.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = process.env['DSH4RCS_PROFILE'] ?? 'rcs-dev'
const PROFILE_DIR = join(
  process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
  '.dsh',
  'profiles',
  PROFILE,
)
const WORKSPACE_YAML = join(PROFILE_DIR, 'pnpm-workspace.yaml')

/**
 * 宿主侧必须**装进 profile** 的 bundle。
 *
 * `@deepseek-ai/dsh-base` 是 in-box 的，profile 模板自带；但网页端不是 ——
 * 不把 `dsh-web-app` 加进来，profile 起来就没有 web 界面，
 * 而 `dsh-rcs-ui-client` 注入的那几个 `@deepseek-ai/dsh-client-ui-*` 也无处附着。
 * 早先只在维护者本机的 profile 里手工加过它，仓库里没有 ——
 * 于是照文档走完全部步骤的新人 `npm run dsh:start` 起来是个没有网页的 profile。
 *
 * 版本从本仓库 overrides 取，与运行时同源。
 */
const HOST_BUNDLES = ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-client-ui-primitives']

/**
 * 允许跑安装脚本的依赖。pnpm 默认忽略构建脚本并以 ERR_PNPM_IGNORED_BUILDS
 * **失败退出**，所以这不是可选项 —— koffi 是原生 FFI 库，不放行整个 profile 装不完。
 * 同样是过去只在维护者手改的 profile 里存在的一行。
 */
const ALLOW_BUILDS = ['koffi']

/**
 * dsh 0.1.0-rc.6 首次初始化 profile 时写的 pnpm-workspace.yaml 模板头。
 * profile 还不存在时由本脚本先写 —— dsh 只在文件缺失时才写模板，
 * 已存在就逐字保留，所以先来后到决定了以谁为准。
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
function dsh(args, label) {
  console.log(`\n[dsh:install] ${label}`)
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'dsh.mjs'), ...args], {
    stdio: 'inherit',
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

// ---------- 1. 构建 ----------
console.log('[dsh:install 1/3] 构建插件产物')
{
  const r = spawnSync(process.execPath, [join(REPO, 'build.mjs'), '--install-stage'], {
    stdio: 'inherit',
    cwd: REPO,
  })
  if (r.status !== 0) {
    console.error('[dsh:install] 构建失败，没有继续安装 —— 装一份旧产物只会让人对着过期代码调试。')
    process.exit(r.status ?? 1)
  }
}

// ---------- 2. 写 profile 配置（必须在 pnpm 第一次跑之前） ----------
console.log(`\n[dsh:install 2/3] 同步版本 overrides 到 ${WORKSPACE_YAML}`)
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
  mkdirSync(dirname(WORKSPACE_YAML), { recursive: true })
  writeFileSync(WORKSPACE_YAML, withOverridesBlock(existing, { overrides, allowBuilds: ALLOW_BUILDS }))
  console.log(`  已写入 ${count} 条版本钉死（与本仓库 package.json 的 overrides 同源）`)
  console.log(`  允许构建：${ALLOW_BUILDS.join('、')}`)
}

// ---------- 3. 装插件与宿主 bundle ----------
const pinned = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).overrides ?? {}
const hostSpecs = HOST_BUNDLES.map((name) => {
  const version = pinned[name]
  if (!version) {
    console.error(`[dsh:install] ${name} 不在本仓库 overrides 里，拒绝装一个不锁版本的宿主包。`)
    process.exit(1)
  }
  return `${name}@${version}`
})
const specs = [...PLUGINS.map((p) => `./packages/${p}`), ...hostSpecs]
if (
  !dsh(
    ['plugin', '--profile', PROFILE, 'add', ...specs],
    `3/3 安装 ${PLUGINS.length} 个插件 + ${HOST_BUNDLES.length} 个宿主 bundle`,
  )
) {
  process.exit()
}

// ---------- 收尾 ----------
// npm/pnpm 装完会把目录联接变回普通目录，双实例风险随之回来。
console.log('\n[dsh:install] 重建宿主包联接')
spawnSync(process.execPath, [join(REPO, 'scripts', 'link-host-packages.mjs')], {
  stdio: 'inherit',
  cwd: REPO,
})

console.log('\n完成。启动：npm run dsh:start')
