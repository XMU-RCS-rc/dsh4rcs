# 排错

从 README 拆出来的一节。这里每一条都是**实际踩过并定位过**的，不是设想的故障。

### dsh 版本必须锁死

dsh 的 profile 用 pnpm 安装，而 `dsh-web-app@0.1.0-rc.6` 用 `^0.1.0-rc.6` 声明客户端依赖 —— pnpm 会解析到更新的 rc.8，造成**服务端 rc.6、前端 rc.8**。rc.8 的前端在 `mountApp` 里 `await ctx.inject(['uiRenderer'])`，而 rc.6 这一代没有模块提供该服务；cordis 的 inject 是**无限等待且不报错**，结果是网页端永远停在 "Loading plugins…"，控制台里连报错都没有。

修法：在 `~/.dsh/profiles/rcs-dev/pnpm-workspace.yaml` 里把全部 `@deepseek-ai/*` 钉到 `0.1.0-rc.6`，然后 `pnpm install`。

> **pnpm 11 起 overrides 只认 `pnpm-workspace.yaml`**，写在 `package.json` 的 `pnpm.overrides` 会被静默忽略（只有一行 WARN）。

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

### `dsh` 命令本身不可用

本机 launcher 硬编码了 `web` 子命令且不锁版本，`dsh plugin add` 会失效。本仓库一律走 `scripts/dsh.mjs`（锁定 rc.6 并绕开 launcher），所有 `npm run dsh:*` 脚本已经处理好。

---

---

还有问题看 [`../USAGE.md`](../USAGE.md) 的使用手册，或 [`../FEATURES.md`](../FEATURES.md) 的功能清单。
