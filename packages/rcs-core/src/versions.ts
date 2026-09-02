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
export const PINNED_DSH = '0.1.0-rc.6'

/** 宿主包在 npm 上的包名，用于查询上游最新版本。 */
export const DSH_PACKAGE = '@deepseek-ai/dsh'
