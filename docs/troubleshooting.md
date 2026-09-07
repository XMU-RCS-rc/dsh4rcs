# 排错

从 README 拆出来的一节。这里每一条都是**实际踩过并定位过**的，不是设想的故障。

### dsh 版本必须锁死

dsh 的 profile 用 pnpm 安装，而 `dsh-web-app@0.1.0-rc.6` 用 `^0.1.0-rc.6` 声明客户端依赖 —— pnpm 会解析到更新的 rc.8，造成**服务端 rc.6、前端 rc.8**。rc.8 的前端在 `mountApp` 里 `await ctx.inject(['uiRenderer'])`，而 rc.6 这一代没有模块提供该服务；cordis 的 inject 是**无限等待且不报错**，结果是网页端永远停在 "Loading plugins…"，控制台里连报错都没有。

**`npm run dsh:install` 已经自动处理**：它在建好 profile 之后、装插件之前，
把本仓库 `package.json` 的 `overrides`（195 条，整棵 rc.6 树）写进
`~/.dsh/profiles/rcs-dev/pnpm-workspace.yaml`，再让 pnpm 在这份钉死之下解析。
这一步以前只存在于维护者本机手改的那份 profile 里，仓库里没有 ——
照着 README 走完的新人必然撞上这个卡死，而且界面上没有任何线索。

已经撞上了就重跑一次 `npm run dsh:install`。

> **pnpm 11 起 overrides 只认 `pnpm-workspace.yaml`**，写在 `package.json` 的 `pnpm.overrides` 会被静默忽略（只有一行 WARN）。
> 生成段带 `# >>> dsh4rcs overrides (generated) >>>` 标记，重跑是整段替换，手写内容不会被吃掉；
> 若文件里已有另一段手写的 `overrides:`，脚本会停下来让你自己合并 —— YAML 重复顶层键只有一个生效，
> 而且不报错。

### `link-host-packages.mjs` 报「版本不一致：仓库 0.1.0-rc.6 vs 宿主 0.1.0-rc.8」

**不要改 `package.json` 里的版本。** 仓库锁的 rc.6 是按其类型定义写并验证过的那一版；
升到 rc.8 会同时踩上一节那个 "Loading plugins…" 静默卡死。漂掉的是**本机的运行时**。

原因是 npx 缓存的工作方式：缓存目录名是**调用规格的哈希**，目录一旦建好就再也不重新
解析依赖。而 `@deepseek-ai/dsh` 把兄弟包声明成 `^0.1.0-rc.6` —— 同一条
`npx -y @deepseek-ai/dsh@0.1.0-rc.6`，在 rc.8 发布之前建出来的树里 `dsh-tools` 是 rc.6，
之后建出来的就是 rc.8。dsh 本体确实是 rc.6，兄弟包却漂了，于是**同一条命令在不同机器上
装出不同的树**。清缓存重装没有用，重装只会再得到一棵新的漂移树。

修法是让本仓库自己装一份锁定版运行时，版本由 `package-lock.json` 钉死：

```bash
git pull
npm install
npm run setup
```

`scripts/dsh.mjs` 的解析顺序是「本仓库 node_modules → npx 缓存 → npx 拉取」，
装好之后它就再也不碰 npx 缓存了。

> 旧版脚本在这里印的是「先把 package.json 里的版本对齐再跑本脚本」——
> 那句话指的方向是反的，照做会把仓库升到一个没验证过的版本。已经改掉。

### `npm run setup` 最后一行是一句 C 断言

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

自检本身跑完了，崩在退出那一步：第 7 节发过网络请求，undici 的套接字还在关闭中，
而脚本调了 `process.exit()`。Windows 上 libuv 会为此断言，进程以 127 退出 ——
连退出码都是错的。已改成设 `process.exitCode` 让事件循环自然收尾。`git pull` 即可。

### 工具调用报 `Cannot read properties of undefined (reading 'prepare')`

宿主包出现了多个实例。dsh 的 loader 从 profile 根解析插件名，`ctx.tools` 因此来自 profile 的 `dsh-tools`；而 `dsh-agent-loop` 来自 npx 缓存，用**自己那份**的 `Symbol()` 去读 `ctx.tools[TOOL_RUNTIME_SCHEDULER]`。该符号是普通 `Symbol()` 而非 `Symbol.for()`，实例私有，于是取回 `undefined`。

```bash
node scripts/link-host-packages.mjs --check   # 检查
node scripts/link-host-packages.mjs           # 修复
```

`postinstall` 会自动维护（`npm install` 会把目录联接变回普通目录）。

> 后果值得一提：该轮在工具调用中途崩溃，会话历史里留下没有对应结果的 `tool_calls`，之后**每一轮**都会被模型 API 拒绝（`An assistant message with 'tool_calls' must be followed by tool messages`）—— 整个会话报废，只能新建。

### `npm run dsh:start` 起不来

先看端口是不是已经被另一个实例占了：报错会明确写 `EADDRINUSE: address already in use 127.0.0.1:3080`。

### 怎么卸载这套插件

```bash
npm run dsh:uninstall          # 从 rcs-dev profile 卸载全部 7 个插件
```

只卸其中一个就直接点名（`dsh plugin` 把参数原样转发给 profile 目录里的 pnpm）：

```bash
node scripts/dsh.mjs plugin --profile rcs-dev remove dsh-rcs-train
```

dsh 会在 pnpm 跑完后**自动同步** `dsh.profile.bundles`，不用手改 profile 的
`package.json`。profile 本身和里面的会话记录都保留；想连 profile 一起丢掉，
删 `~/.dsh/profiles/rcs-dev` 目录即可，下次 `npm run dsh:install` 会重新建。

只是想临时停用而不卸载，用 `npm run dsh:start:no-rcs`（见
[`install.md`](./install.md)），比卸了再装快得多。

### `npm run setup` 报「找不到固件仓库」

**这一项不阻塞。** 规则查询、知识检索、培训工具都照常能用，只有工程检查与
构建烧录类工具需要它。把 `RCS_code` 克隆到与本仓库同级的位置即可自动发现，
或者设 `RCS_CODE_ROOT` 环境变量。

结尾那句「还有 N 项必须先解决」现在会把具体条目逐条念出来，照着那份清单修就行。

### `dsh` 命令本身不可用

本机 launcher 硬编码了 `web` 子命令且不锁版本，`dsh plugin add` 会失效。本仓库一律走 `scripts/dsh.mjs`（锁定 rc.6 并绕开 launcher），所有 `npm run dsh:*` 脚本已经处理好。

---

---

还有问题看 [`../USAGE.md`](../USAGE.md) 的使用手册，或 [`../FEATURES.md`](../FEATURES.md) 的功能清单。
