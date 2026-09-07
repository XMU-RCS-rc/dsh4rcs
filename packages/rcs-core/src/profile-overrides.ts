/**
 * 往 dsh profile 的 `pnpm-workspace.yaml` 里写版本 overrides。
 *
 * ## 为什么这件事必须自动做
 *
 * profile 用 pnpm 装依赖，而 `dsh-web-app@0.1.0-rc.6` 把客户端依赖声明成
 * `^0.1.0-rc.6` —— npm/pnpm 的预发布语义允许 `0.1.0-rc.8` 落进这个范围，
 * 于是服务端是 rc.6、前端资源是 rc.8。rc.8 的前端在 `mountApp` 里
 * `await ctx.inject(['uiRenderer'])`，而 rc.6 这一代没有任何模块提供该服务；
 * cordis 的 inject 语义是**无限等待且不报错**，结果是网页端永远停在
 * "Loading plugins…"，控制台里连一行报错都没有。
 *
 * 这份 overrides 早先只存在于维护者本机手改的那一份 profile 里，仓库里没有。
 * 也就是说照着 README 走完全部步骤的新人**必然**撞上这个卡死，而且撞上之后
 * 界面上什么线索也没有。三十多个新生装机，这是最贵的一种坑：
 * 不报错、不留日志、只是打不开。
 *
 * ## 为什么是文本拼接而不是 YAML 库
 *
 * 只需要「保留原文件、替换其中的 overrides 段」这一件事，为它引一个 YAML 依赖
 * 不划算；而且原文件是 dsh 的 profile 模板写的，**逐字保留**比解析后重新序列化
 * 更安全 —— 后者会顺手改掉注释和格式，出问题时看不出是谁动的。
 */

/** 生成段的起止标记。认标记而不认缩进，重复写入才能幂等。 */
export const OVERRIDES_BEGIN = '# >>> dsh4rcs overrides (generated) >>>'
export const OVERRIDES_END = '# <<< dsh4rcs overrides (generated) <<<'

/**
 * 把 overrides 段写进（或更新到）profile 的 pnpm-workspace.yaml。
 *
 * - 已有生成段：整段替换，其余逐字不动。
 * - 没有生成段但有手写的 `overrides:`：**保留手写的，把生成段追加在后面**
 *   会产生重复键，所以这种情况下拒绝改写并由调用方报错 —— 见 `hasForeignOverrides`。
 * - 都没有：追加到末尾。
 */
export type ProfileSettings = {
  /** 包名 → 版本，逐个钉死。 */
  overrides: Record<string, string>
  /**
   * 允许跑安装脚本的包。pnpm 默认忽略依赖的构建脚本并以
   * `ERR_PNPM_IGNORED_BUILDS` **失败退出** —— koffi 是原生 FFI 库，
   * 不放行整个 profile 就装不完。这一行早先同样只存在于维护者手改的那份 profile 里。
   */
  allowBuilds: string[]
}

export function withOverridesBlock(existing: string, settings: ProfileSettings): string {
  const block = renderOverridesBlock(settings)
  const begin = existing.indexOf(OVERRIDES_BEGIN)
  if (begin >= 0) {
    const endAt = existing.indexOf(OVERRIDES_END, begin)
    const after = endAt >= 0 ? existing.slice(endAt + OVERRIDES_END.length) : ''
    return `${existing.slice(0, begin)}${block}${after.startsWith('\n') ? after : `\n${after}`}`
  }
  const base = existing.trimEnd()
  return base ? `${base}\n\n${block}\n` : `${block}\n`
}

/**
 * 文件里是否有**不是本工具写的** `overrides:` 顶层键。
 *
 * 有的话不能直接追加：YAML 里重复的顶层键，pnpm 只认其中一个，
 * 而具体认哪个取决于解析器 —— 那是「看起来写进去了、实际没生效」的经典形态，
 * 比直接报错难查得多。宁可停下来让人自己决定怎么合并。
 */
export function hasForeignOverrides(existing: string): boolean {
  const generatedFrom = existing.indexOf(OVERRIDES_BEGIN)
  const generatedTo = existing.indexOf(OVERRIDES_END)
  return existing.split('\n').some((line, index, lines) => {
    if (!/^(overrides|allowBuilds):\s*$/.test(line)) return false
    const offset = lines.slice(0, index).reduce((n, l) => n + l.length + 1, 0)
    const inGenerated = generatedFrom >= 0 && offset > generatedFrom && (generatedTo < 0 || offset < generatedTo)
    return !inGenerated
  })
}

function renderOverridesBlock({ overrides, allowBuilds }: ProfileSettings): string {
  const L: string[] = [OVERRIDES_BEGIN]
  L.push('#')
  L.push('# 由 `npm run dsh:install` 从本仓库 package.json 的 overrides 同步过来，手改会被覆盖。')
  L.push('# 作用：防止 pnpm 把客户端依赖解析到比服务端更新的一代 —— 那会让网页端')
  L.push('# 静默停在 "Loading plugins…"（cordis 的 inject 是无限等待且不报错）。')
  L.push('#')
  L.push('# pnpm 11 起 overrides 只认本文件，写在 package.json 的 pnpm.overrides 会被忽略。')
  L.push('overrides:')
  for (const name of Object.keys(overrides).sort()) {
    L.push(`  '${name}': ${overrides[name]}`)
  }
  if (allowBuilds.length > 0) {
    L.push('')
    L.push('# pnpm 默认忽略依赖的构建脚本，并以 ERR_PNPM_IGNORED_BUILDS 失败退出。')
    L.push('# koffi 是原生 FFI 库，不放行 profile 就装不完。')
    L.push('allowBuilds:')
    for (const name of [...allowBuilds].sort()) L.push(`  ${name}: true`)
  }
  L.push(OVERRIDES_END)
  return L.join('\n')
}
