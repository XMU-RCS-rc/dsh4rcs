/**
 * 跨模块共享的版本常量。
 *
 * 单独成文件而不是放在其中一个消费方里，是因为它有两个消费方，而两边都不能
 * import 对方：
 *
 *   - `scripts/dsh.mjs` 用它决定复用 npx 缓存还是重新拉取；
 *   - `freshness.ts` 用它和上游 latest 比对，判断宿主是不是有新版了。
 *
 * `dsh.mjs` 在**顶层**就把 dsh 拉起来（没有 main 守卫），
 * 所以任何人 import 它都会真的启动一个 dsh 进程。常量只能放在第三处。
 */

/**
 * 本插件套件验证过的 dsh 版本。
 *
 * 改这个数之前请重跑 `npm run verify`，并留意 README「dsh 版本必须锁死」一节：
 * 服务端与前端版本不一致时，网页端会**静默**停在 "Loading plugins…" ——
 * cordis 的 inject 是无限等待且不报错的，控制台里连线索都没有。
 */
export const PINNED_DSH = '0.1.5-rc.2'

/** 宿主包在 npm 上的包名，用于查询上游最新版本。 */
export const DSH_PACKAGE = '@deepseek-ai/dsh'

/**
 * `npm run dsh:install` 装插件用的 pnpm 主版本 —— `dsh plugin` 把参数原样转给 profile 目录里的 pnpm。
 *
 * 11 是下限：11 起 overrides 只认 `pnpm-workspace.yaml`，本仓库写进 profile 的版本钉死与
 * `allowBuilds` 都按这一代的规则写。它不是上限，但 npm 上的 latest 已经是 12，不带版本的
 * `npm i -g pnpm` 会装到 12 —— 所以文档与提示一律写 `pnpm@11`。12 只警告不拦：
 * 实测 12.4.1 能把当前布局装通（当前布局只有 link: 依赖，allowBuilds 在 12 下没被验证到）。
 */
export const PNPM_MAJOR = 11
