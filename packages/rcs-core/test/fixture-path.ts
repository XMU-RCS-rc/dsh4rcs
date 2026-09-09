/**
 * 造测试用的假路径 —— 保证它在 Windows 与 POSIX 上**都是绝对路径**。
 *
 * ## 为什么需要这个
 *
 * 直接写 `'D:/fake-profile'` 只在 Windows 上是绝对路径。POSIX 上它是**相对**的，
 * 于是两件事同时发生：
 *
 *   1. `join()` 拼出来的仍是相对路径，而断言里往往用 `resolve()` 或写死的
 *      反斜杠字面量去比 —— `resolve()` 会按 cwd 补全，两边必然对不上。
 *   2. 更隐蔽的一种：`pathToFileURL('D:/x/y/z.js')` 在 POSIX 上得到的是
 *      `file://<cwd>/D:/x/y/z.js`，往上三级正好落回**真实仓库根**。
 *      于是一条本该失败的用例（「显式值指向非仓库时不能假绿」）反而通过了 ——
 *      测试还绿着，测的却不是它声称的那件事。
 *
 * 两种都在 CI 的 ubuntu-latest 那一路上真实发生过，而 windows-latest 全绿，
 * 所以本机看不出来。这正是 CI 跑两个平台的意义。
 *
 * 用法：`fixturePath('fake-profile')` → Windows 得 `D:\fake-profile`，
 * POSIX 得 `/fake-profile`；两者都是绝对路径，`join` 与 `resolve` 结果一致。
 *
 * **只用于测试固件。** 真实代码里的路径应当来自解析链，不该凭空造。
 */
import { join } from 'node:path'

/** POSIX 的根是 `/`；Windows 上用 `D:\`，与队里的工作盘一致，读起来也眼熟。 */
const ROOT = process.platform === 'win32' ? `D:${String.fromCharCode(92)}` : '/'

export function fixturePath(...parts: string[]): string {
  return join(ROOT, ...parts)
}
