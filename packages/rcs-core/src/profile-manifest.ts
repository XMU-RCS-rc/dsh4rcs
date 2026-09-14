/**
 * 把旧版 `dsh:install` 建出来的 profile 清单（`package.json`）迁到 0.1.5 的布局。
 *
 * ## 旧布局为什么要装那两个宿主包
 *
 * 0.1.0-rc.6 时代，脚本把 `dsh-web-app` 与 `dsh-client-ui-primitives` 当依赖装进 profile：
 *   - 前者是为了让 `dsh plugin` 的对账把它写进 `dsh.profile.bundles` —— 按名字新建的
 *     profile 只有 `dsh-base`，起来没有网页界面；
 *   - 后者是因为 rc.6 的客户端包把它声明成 **peer**，而 profile 模板是 `autoInstallPeers: false`。
 *
 * ## 0.1.5 起两条理由都不成立，而旧副本本身有害
 *
 *   - dsh 解析 bundle **永远先找安装目录**，profile 里那份 web-app 从来不会被当 bundle 用到，
 *     却要拖进整套客户端依赖和 5 个要跑原生构建的包。网页界面改由 dsh 自带的 web 模板
 *     写进 bundles（`--from-default-profile web`），直接从安装目录解析。
 *   - primitives 降成了客户端包的 devDependency（构建时已打进各包），运行时树里根本没有它。
 *   - 升级后 profile 的 node_modules 里还留着上一代的 dsh-tools 等宿主包 —— 那正是双实例的来源。
 *
 * 所以：从 `dependencies` 删掉这两个（下一次 pnpm 安装会连同依赖一起清掉），
 * `dsh.profile.bundles` 里的 web-app **保留**。必须在 pnpm 跑之前删：dsh 的对账把
 * 「装之前就不在 dependencies 里」的 bundle 当成内置层不去碰；反过来若先让 pnpm 跑、
 * 再从依赖里删，对账会把它当成「被移除的依赖」连 bundles 里那一项一起摘掉，网页端就没了。
 *
 * 纯函数、不碰文件系统，调用方负责读写。启动前检查 `profileBootProblem` 也在这里，同样只看清单。
 */
import { PNPM_MAJOR } from './versions.ts'

/** 网页界面 bundle。0.1.5 起随 dsh 内置，从安装目录解析。 */
export const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'

/** dsh4rcs 七个插件的包名前缀。 */
export const PLUGIN_PREFIX = 'dsh-rcs-'

/**
 * 旧版安装脚本装进 profile 的宿主包。只认这两个名字 ——
 * 别的 `@deepseek-ai/*` 依赖是人自己加的（比如 `dsh-headless`），不动。
 */
export const LEGACY_HOST_DEPENDENCIES: readonly string[] = [
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** 只声明本模块读写的字段；其余字段原样透传。 */
export type ProfileManifest = {
  dependencies?: Record<string, string>
  dsh?: {
    profile?: { bundles?: string[]; [key: string]: unknown }
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type ManifestMigration = {
  manifest: ProfileManifest
  /** 人类可读的改动清单；为空表示无需改写（此时 manifest 就是传入的那个对象）。 */
  changes: string[]
}

export function migrateProfileManifest(manifest: ProfileManifest): ManifestMigration {
  const changes: string[] = []

  const dependencies = { ...manifest.dependencies }
  for (const name of LEGACY_HOST_DEPENDENCIES) {
    if (Object.hasOwn(dependencies, name)) {
      changes.push(`从 dependencies 移除旧版安装留下的 ${name}@${dependencies[name]}`)
      delete dependencies[name]
    }
  }

  // 按名字初始化、没走 web 模板的 profile，bundles 里只有 dsh-base —— 起来没有网页界面。
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  if (!bundles.includes(WEB_APP_BUNDLE)) {
    // 紧跟 dsh-base，与 dsh 自带 web 模板的顺序一致；没有 base 时 indexOf 为 -1，落在最前。
    bundles.splice(bundles.indexOf('@deepseek-ai/dsh-base') + 1, 0, WEB_APP_BUNDLE)
    changes.push(`把 ${WEB_APP_BUNDLE} 加进 dsh.profile.bundles（从 dsh 安装目录解析）`)
  }

  if (changes.length === 0) return { manifest, changes }
  return {
    manifest: {
      ...manifest,
      dependencies,
      dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
    },
    changes,
  }
}

export type BootProblem = {
  /** block：别启动，起来也是白等；warn：能起来，但缺东西。 */
  level: 'block' | 'warn'
  message: string
}

/**
 * 启动前看一眼 dsh4rcs 管的那个 profile（`npm run dsh:start` 起的就是它）。
 *
 * 缺网页界面的 profile 起来**不打印任何东西、也不退出**：bundles 里只剩 `dsh-base`，那是没有
 * web 服务的 agent 内核，等多久都一样。旧版 `dsh:install` 在 pnpm 那步失败、或手工
 * `dsh plugin add` 按名字建出来的 profile 都是这样 —— 这种直接拦下，给出修法。
 *
 * 一个 dsh4rcs 插件都没有的只警告：网页照样起得来，只是没有 `rcs_*` 工具。现在的 `dsh:install`
 * 先按 web 模板建 profile 再装插件，装插件那步失败留下的就是这种。只卸了其中几个是人有意为之
 * （排错文档里教过怎么只卸一个），不管。
 *
 * `manifest` 为 undefined 表示清单不存在。dsh 自己也会报错，但它建议的 `dsh plugin add`
 * 恰好会建出上面那种只有 `dsh-base` 的 profile，所以这里抢先指向 `dsh:install`。
 */
export function profileBootProblem(
  manifest: ProfileManifest | undefined,
  context: { profile: string; manifestPath: string },
): BootProblem | undefined {
  const fix = [
    `  pnpm --version         # 没有就 npm i -g pnpm@${PNPM_MAJOR}`,
    '  npm run dsh:install    # 结尾是「完成。启动：npm run dsh:start」才算装好',
  ]
  if (manifest === undefined) {
    return {
      level: 'block',
      message: [`profile ${context.profile} 还没建（没有 ${context.manifestPath}）。先装：`, ...fix].join('\n'),
    }
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(WEB_APP_BUNDLE)) {
    return {
      level: 'block',
      message: [
        `profile ${context.profile} 里没有网页界面：dsh.profile.bundles 缺 ${WEB_APP_BUNDLE}。`,
        '照这样启动不会打印网址，也不会退出 —— 只剩 dsh-base，那是没有 web 服务的内核。',
        '多半是上次 dsh:install 半路失败（常见原因：没装 pnpm）。重跑一遍会把 web-app 补进 bundles：',
        ...fix,
        `清单：${context.manifestPath}`,
      ].join('\n'),
    }
  }
  if (!bundles.some((bundle) => bundle.startsWith(PLUGIN_PREFIX))) {
    return {
      level: 'warn',
      message: [
        `profile ${context.profile} 里一个 dsh4rcs 插件都没有：网页能打开，但没有 rcs_* 工具、队徽和蓝白主题。`,
        '多半是上次 dsh:install 在装插件那步失败（常见原因：没装 pnpm）。修法：',
        ...fix,
      ].join('\n'),
    }
  }
  return undefined
}
