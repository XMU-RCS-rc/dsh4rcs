/**
 * 路径解析 —— 让这套插件能装到别人的机器上。
 *
 * ## 为什么不能写死绝对路径
 *
 * 初版把 `D:/code/RCS_code`、`D:/code/dsh4rcs/config` 之类直接写进 Schema
 * 默认值。在作者机器上一切正常，别人 clone 下来**一个路径都不存在**，
 * 而且失败方式很难懂：工具报「找不到文件」，但没人知道它本该找哪。
 *
 * ## 解析链
 *
 * 与本仓库处理 `season` 的方式一致 —— **默认留空、逐级解析、解析不到就明确报错**：
 *
 *   1. 工具参数（调用者显式指定）
 *   2. `ctx.rcs` 共享配置（来自 config/team.json）
 *   3. 插件自身配置
 *   4. 环境变量（`RCS_HOME` / `RCS_CODE_ROOT`）
 *   5. 自动发现（相对本仓库的位置）
 *   6. 抛出一条**说清楚找过哪里**的错误
 *
 * 写死一个猜测值比报错危险：拿错路径做检查，结论看起来正常但完全不对。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 从模块自身位置推出本仓库根目录。
 *
 * 两种布局都是**从所在目录往上三级**，所以一套逻辑通吃：
 *   源码运行：`packages/rcs-core/src/paths.ts`  → src → rcs-core → packages → 根
 *   构建产物：`packages/dsh-rcs-xxx/lib/index.js` → lib → dsh-rcs-xxx → packages → 根
 *
 * 用 `import.meta.url` 而不是 `process.cwd()`：后者取决于从哪儿启动 dsh，
 * 而插件被加载时的工作目录根本不受我们控制。
 */
export function repoRootFrom(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..', '..')
}

/** 本仓库根目录。 */
export const REPO_ROOT = repoRootFrom(import.meta.url)

/** 仓库内的固定位置 —— 这些**可以**写死，因为它们跟着仓库走。 */
export const repoPaths = {
  config: (): string => join(REPO_ROOT, 'config'),
  teamConfig: (): string => join(REPO_ROOT, 'config', 'team.json'),
  rulesRoot: (): string => join(REPO_ROOT, 'data', 'rules'),
  kbCache: (): string => join(REPO_ROOT, 'data', 'kb-cache'),
}

/** 判断一个目录像不像 RCS 固件仓库。用于自动发现时避免认错。 */
export function looksLikeFirmwareRepo(dir: string): boolean {
  if (!existsSync(dir)) return false
  // 这三样是队内固件仓库的标志物，任意命中两个即认为是
  const marks = ['template', 'demo', 'upper_host_cli', 'R2']
  return marks.filter((m) => existsSync(join(dir, m))).length >= 2
}

export type FirmwareResolution =
  | { ok: true; root: string; from: string }
  | { ok: false; tried: string[] }

/**
 * 解析固件仓库（`RCS_code`）根目录。
 *
 * 它在**本仓库之外**，所以必须真的去找，而不能假定位置。
 * 自动发现只认「看起来确实像固件仓库」的目录 —— 宁可报错，
 * 也不要指向一个碰巧同名的空目录然后给出一堆莫名其妙的检查结果。
 */
export function resolveFirmwareRoot(options: {
  explicit?: string
  fromTeamConfig?: string
  env?: Record<string, string | undefined>
  repoRoot?: string
} = {}): FirmwareResolution {
  const env = options.env ?? process.env
  const root = options.repoRoot ?? REPO_ROOT
  const tried: string[] = []

  const candidates: [string, string | undefined][] = [
    ['工具参数/ 插件配置', options.explicit],
    ['config/team.json 的 firmware.repo', options.fromTeamConfig],
    ['环境变量 RCS_CODE_ROOT', env['RCS_CODE_ROOT']],
    ['环境变量 RCS_HOME', env['RCS_HOME'] ? join(env['RCS_HOME'], 'RCS_code') : undefined],
    ['与本仓库同级的 ../RCS_code', join(root, '..', 'RCS_code')],
  ]

  for (const [from, value] of candidates) {
    if (!value) continue
    const abs = resolve(value)
    tried.push(`${from}: ${abs}`)
    // 显式指定的只要存在就用（用户说了算）；自动发现的要过标志物检查
    const explicitish = from.startsWith('工具参数') || from.startsWith('config/team.json') || from.startsWith('环境变量')
    if (explicitish ? existsSync(abs) : looksLikeFirmwareRepo(abs)) {
      return { ok: true, root: abs, from }
    }
  }
  return { ok: false, tried }
}

/** 解析失败时的报错文案 —— 必须说清找过哪里，否则没人知道该怎么修。 */
export function firmwareNotFoundMessage(tried: string[]): string {
  return (
    '找不到 RCS 固件仓库（RCS_code）。已按顺序找过：\n' +
    (tried.length > 0 ? tried.map((t) => `  · ${t}`).join('\n') : '  （没有任何候选）') +
    '\n\n三种指定方式，任选其一：\n' +
    '  1. 在 config/team.json 里设 firmware.repo\n' +
    '  2. 设环境变量 RCS_CODE_ROOT\n' +
    '  3. 把固件仓库放到与本仓库同级的 ../RCS_code\n' +
    '也可以在调用工具时直接传 projectRoot 参数。'
  )
}
