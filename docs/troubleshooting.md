# 排错

从 README 拆出来的一节。这里每一条都是**实际踩过并定位过**的，不是设想的故障。

### 升级到 0.1.5-rc.2（从 0.1.0-rc.6 或 0.1.5-rc.1）

> 日常更新（同一个 dsh 版本内拉新代码）见 [install.md 的「更新」一节](./install.md#更新)。这一节只讲跨这几个 dsh 版本时多出来的事。

仓库现在锁的是 `0.1.5-rc.2`。按旧版装过的机器，在仓库根目录跑：

```bash
git pull
npm install            # 装回锁定版运行时（dsh 本体 + 240 条版本钉死）
npm run verify
npm run dsh:install    # 旧 profile 就地迁移，见下
npm run dsh:start
```

从 rc.1 升上来的：`dsh:install` 只会打印「已是当前布局，无需迁移」，并把 `pnpm-workspace.yaml` 生成段里的
钉死换成 rc.2；没有会话格式迁移（rc.1 → rc.2 的 `dsh-session-format-*` 一字未改）。

从 rc.6 升上来的，`dsh:install` 遇到旧 profile 会自动迁移，每一处改动都会打印出来：

- 从 profile 的 `dependencies` 摘掉旧版装进去的 `@deepseek-ai/dsh-web-app` 与
  `@deepseek-ai/dsh-client-ui-primitives`。bundles 里的 web-app **保留** —— 0.1.5 起它随 dsh 内置、
  从安装目录解析；profile 里另装一份只会多出一个与宿主不同的 dsh-tools。
- 接下来那一轮 pnpm 会把上一代的宿主包从 profile 里清掉；还指着旧运行时的联接，
  由收尾的 `link-host-packages.mjs` 重新指到当前宿主。
- `cordis.patch.yml`（你自己写的 persona、插件配置）不动。

两点要知道：

- **第一次启动会把旧会话迁到新格式，而且是单向的。** 0.1.5 带了 v0→v3 的会话格式迁移。
  想留回退的余地，先把 `~/.dsh/sessions` 复制一份。
- pnpm 会对 profile `package.json` 里早先手写的 `pnpm.overrides` 打一行 WARN
  （pnpm 11 已经不读这个字段）。无害；嫌吵就删掉那一段 —— 真正生效的钉死在
  `pnpm-workspace.yaml` 的生成段里。

### dsh 版本必须锁死

dsh 的 profile 用 pnpm 安装，而 `dsh-web-app@0.1.0-rc.6` 用 `^0.1.0-rc.6` 声明客户端依赖 —— pnpm 会解析到更新的 rc.8，造成**服务端 rc.6、前端 rc.8**。rc.8 的前端在 `mountApp` 里 `await ctx.inject(['uiRenderer'])`，而 rc.6 这一代没有模块提供该服务；cordis 的 inject 是**无限等待且不报错**，结果是网页端永远停在 "Loading plugins…"，控制台里连报错都没有。

这是 rc.6 时代的事故。现在由两道闸兜着：

- **运行时版本由本仓库钉死。** `@deepseek-ai/dsh` 是 devDependency，`package.json` 的
  `overrides` 把整棵 0.1.5-rc.2 树（240 条）逐个钉死，由 `package-lock.json` 固定；
  `scripts/dsh.mjs` 优先用这一份。
- **profile 里不再装宿主包。** `npm run dsh:install` 用 dsh 自带的 web 模板建 profile，
  web-app 与各宿主包都从安装目录解析，profile 里只有 7 个插件的联接。同一份 overrides
  仍会写进 `$DSH_HOME/profiles/rcs-dev/pnpm-workspace.yaml`（没设 `DSH_HOME` 就是 `~/.dsh`）
  作为保险：谁往 profile 里加了宿主包，也只能解析到同一代。

撞上了就重跑一次 `npm run dsh:install`。

> **pnpm 11 起 overrides 只认 `pnpm-workspace.yaml`**，写在 `package.json` 的 `pnpm.overrides` 会被静默忽略（只有一行 WARN）。
> 生成段带 `# >>> dsh4rcs overrides (generated) >>>` 标记，重跑是整段替换，手写内容不会被吃掉；
> 若文件里已有另一段手写的 `overrides:`，脚本会停下来让你自己合并 —— YAML 重复顶层键只有一个生效，
> 而且不报错。

### `link-host-packages.mjs` 报「版本不一致」

**不要改 `package.json` 里的版本。** 仓库锁的是按其类型定义写并验证过的那一版；
漂掉的是本机的运行时，或 profile 里旧版留下的副本。脚本会按位置给出修法：

- `仓库 X vs 宿主 Y` —— 本仓库 `node_modules` 偏离了 lockfile，跑 `npm install`。
- `profile:<名> X vs 宿主 Y` —— 旧版 `dsh:install` 装进 profile 的副本，重跑 `npm run dsh:install` 会清掉它。

npx 缓存为什么会漂：缓存目录名是**调用规格的哈希**，目录一旦建好就再也不重新解析依赖。
而 `@deepseek-ai/dsh` 把兄弟包声明成 `^` 范围 —— 同一条 `npx -y @deepseek-ai/dsh@0.1.0-rc.6`，
在 rc.8 发布之前建出来的树里 `dsh-tools` 是 rc.6，之后建出来的就是 rc.8。**同一条命令在不同机器上
装出不同的树**，清缓存重装也没用。所以本仓库自己装一份锁定版运行时，`scripts/dsh.mjs` 的解析顺序是
「本仓库 node_modules → npx 缓存 → npx 拉取」，装好之后就不再碰 npx 缓存。

> 旧版脚本在这里一律印「先把 package.json 里的版本对齐再跑本脚本」——
> 那句话指的方向是反的，照做会把仓库升到一个没验证过的版本。已经改掉。

### `link-host-packages.mjs --check` 报「联接指向的不是当前宿主」

联接还在，指向的却是上一代运行时 —— 换过 dsh 版本、或删过旧的 npx 缓存之后必然出现。直接跑：

```bash
node scripts/link-host-packages.mjs
```

它把联接重新指到当前宿主，只删联接本身，不碰它原先指向的目录。`npm run dsh:install` 收尾时也会跑这一步。

> 旧版脚本只看「是不是联接」就打勾：升到 0.1.5 后 profile 里的联接仍指着 rc.6 的 npx 缓存，
> `--check` 却照样报「已联接到宿主」—— 一个没验过的勾，而它挡的是双实例。已经改掉。

### `npm run setup` 最后一行是一句 C 断言

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

自检本身跑完了，崩在退出那一步：第 7 节发过网络请求，undici 的套接字还在关闭中，
而脚本调了 `process.exit()`。Windows 上 libuv 会为此断言，进程以 127 退出 ——
连退出码都是错的。已改成设 `process.exitCode` 让事件循环自然收尾。`git pull` 即可。

### 工具调用报 `Cannot read properties of undefined (reading 'prepare')`

宿主包出现了多个实例。rc.6 时 dsh 的 loader 从 profile 根解析插件名，`ctx.tools` 因此来自 profile 的 `dsh-tools`；而 `dsh-agent-loop` 来自 npx 缓存，用**自己那份**的 `Symbol()` 去读 `ctx.tools[TOOL_RUNTIME_SCHEDULER]`。该符号是普通 `Symbol()` 而非 `Symbol.for()`，实例私有，于是取回 `undefined`。

0.1.5 起 profile 里不再装宿主包，这条路堵上了。剩下的触发方式是**用别处的 dsh 运行时启动这套插件**（见最后一节）。检查与修复：

```bash
node scripts/link-host-packages.mjs --check   # 检查
node scripts/link-host-packages.mjs           # 修复
```

`postinstall` 会自动维护（`npm install` 会把目录联接变回普通目录）。

> 后果值得一提：该轮在工具调用中途崩溃，会话历史里留下没有对应结果的 `tool_calls`，之后**每一轮**都会被模型 API 拒绝（`An assistant message with 'tool_calls' must be followed by tool messages`）—— 整个会话报废，只能新建。

### `npm run dsh:start` 起不来

**先等够 20 秒。** 正常启动时，终端先是 `[dsh] 使用 本地 node_modules (…)` 和一句「正在启动 … 约 20 秒后才打印 dsh web: 网址」，
约 4 秒后出现几行 `[rcs-guard]` / `[rcs-train]`，再过十几秒才打印 `dsh web: http://127.0.0.1:3080/?token=…`，
紧跟一行 `dsh web: opening the default browser` 并自动打开浏览器。实测 0.1.5-rc.2 从启动到打印网址 16–24 秒，
把 rcs 插件全部关掉也是 16.7 秒 —— 这是 dsh 自己的启动耗时，不是卡住。网址里的 token 每次启动都换，
旧标签页连不上新实例，要用新打印的那个地址。

先看端口是不是已经被另一个实例占了：报错会明确写 `EADDRINUSE: address already in use 127.0.0.1:3080`。
换端口：`npm run dsh:start -- --port 3090`。自己拼命令时，`--profile`、`--patch` 这些启动器参数要写在
`--port`、`--no-open` 这些网页参数前面 —— 写反了 dsh 报一行 `error: unknown option '--patch'`，然后挂住、不打印网址。

**等了一分钟仍不打印网址、也不退出**，先看 3080 有没有人在监听：

```powershell
Get-NetTCPConnection -LocalPort 3080 -State Listen
```

有输出：网页服务已经起来了。往上翻找 `dsh web:` 那一行，多半早就打印过、被后面的输出顶上去了；
真没有，是有插件一直没加载完（cordis 的 inject 无限等待、不报错），用 `npm run dsh:start:no-rcs` 对比是不是 rcs 插件引起的。

没有输出、终端里除了 `[dsh]` 开头的两行什么都没有：profile 里没有网页界面，只剩 `dsh-base` —— 那是没有 web 服务的
agent 内核，起来就这么待着。用 `dsh:config` 确认：

```powershell
npm run dsh:config | Select-String '^# == '
```

正常的 profile 里有 `# == @deepseek-ai/dsh-web-app` 和 7 段 `# == dsh-rcs-*`；出问题的只有
`# == @deepseek-ai/dsh-base`。配置里那条 `id: web` 是联网搜索工具，不是网页界面，别被它骗了。

这种 profile 是旧版 `dsh:install` 半路失败留下的：旧脚本让 `dsh plugin add` 按名字建 profile，
bundles 只写了 `dsh-base`，接着 pnpm 调不起来（多半是没装，见下一节），web-app 和插件都没装上。
手工跑 `dsh plugin --profile rcs-dev add …` 建出来的 profile 也是这样。

修法：Ctrl+C 停掉挂着的那个，然后

```bash
pnpm --version         # 没有就 npm i -g pnpm@11
npm run dsh:install    # 会打印「把 @deepseek-ai/dsh-web-app 加进 dsh.profile.bundles」，结尾是「完成。」
npm run dsh:start      # 这回会打印 dsh web: http://127.0.0.1:3080/…
```

`dsh:start` 现在启动前会先看一眼 rcs-dev 的 bundles：缺 `dsh-web-app` 就直接停下并报这条修法，
不再静默挂住。所以在现在的代码上，起来之后安静十几秒几乎都是网址还没打印 —— 先等，见本节开头。

**网页能打开，但没有队徽、没有蓝白主题、对话里调不到 `rcs_*` 工具**：插件没装进 profile，
`dsh:config` 里有 `dsh-web-app` 段、没有 `dsh-rcs-*` 段。现在的 `dsh:install` 先按 web 模板建 profile
再装插件，所以装插件那步失败时留下的是这种 profile。修法同上；`dsh:start` 遇到它会先打一条警告。

### `'pnpm' 不是内部或外部命令` / `dsh: pnpm failed in profile directory …`

`npm run dsh:install` 在装插件那一步报：

```
'pnpm' 不是内部或外部命令，也不是可运行的程序
或批处理文件。
dsh: pnpm failed in profile directory C:\Users\<你>\.dsh\profiles\rcs-dev
[dsh:install] 安装 7 个插件 失败（退出码 1）
```

本机没装 pnpm。`dsh plugin` 把参数原样转给 profile 目录里的 pnpm，而 Node 默认没有 pnpm 命令。
`npm run dsh:uninstall` 和手工 `dsh plugin …` 走的是同一条路，也会这样报。

报错之所以绕：Windows 上 dsh 经 cmd 调 pnpm（`shell: true`），命令不存在时 Node 拿不到 `ENOENT`，
只拿到 cmd 的退出码 1 —— dsh 自己那句明确的 `pnpm not found on PATH` 因此不会出现，
剩下的是 cmd 的中文报错加一句笼统的 `pnpm failed`。

修法：

```bash
npm i -g pnpm@11       # 带上 @11：不带版本会装到 12
pnpm --version         # 应输出 11.x
npm run dsh:install    # 重跑即可，已建好的 profile 会被补齐
```

**失败之后别接着跑 `dsh:start`。** profile 这时已经建好，插件却一个没装 —— 起来要么没有 `rcs_*` 工具，
要么（旧版脚本建的 profile）不打印网址、一直挂着，见上一节。

现在 `dsh:install` 在构建之前先查 pnpm，缺了直接停下并给出上面的命令，走不到装插件这一步；
`npm run setup` 也会查。

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

官方 launcher 硬编码了 `web` 子命令且不锁版本，`dsh plugin add` 会失效。本仓库一律走 `scripts/dsh.mjs`（使用本仓库锁定的运行时并绕开 launcher），所有 `npm run dsh:*` 脚本已经处理好。

**别用指向别处运行时的 launcher 启动这套插件。** 插件按真实路径从本仓库 `node_modules`
解析 `@deepseek-ai/dsh-tools`；宿主若是另一个目录里的 dsh，两边就是两份实例 ——
版本号一样也不行，照样撞上上面那条 `reading 'prepare'`。

---

### 升级 dsh 版本（维护者）

从 rc.6 升到 0.1.5-rc.1、再从 rc.1 升到 rc.2，都是这么走的，下次照做：

1. **在仓库外装一棵目标版本的树**，用 npm `overrides` 把所有 `@deepseek-ai/*` 钉到同一版本，
   确认整棵树没有漂移（`^` 范围 + 预发布语义会把兄弟包带到更新的 rc）。
   想先估工作量，就把这棵树与本仓库 `node_modules/@deepseek-ai` 逐包比内容（排除 `package.json`）：
   rc.1 → rc.2 只变了 7 个前端包（chat、sidebar、web-frontend 等），插件 import 的
   `dsh-tools` / `dsh-util-values` 一字未改，于是这一轮只剩换版本号和第 4 步。
2. 把那棵树的 `overrides` **原样**抄进本仓库 `package.json`；`devDependencies` 里的
   `@deepseek-ai/*` 必须与 overrides 完全一致，否则 npm 报冲突。改
   `packages/rcs-core/src/versions.ts` 的 `PINNED_DSH`。
3. `npm install` → `npm run verify`。typecheck 报错就是宿主 API 变了
   （0.1.5 的例子：dsh-tools 不再转出 `JsonValue`，改从 `dsh-util-values` 取）。
   `npm install` 的 postinstall 会把 `$DSH_HOME/profiles` 下各 profile 里的宿主包联接重新指到本仓库，
   试验阶段先设一个临时 `DSH_HOME` 再跑，日常 profile 就不会被指到一个还没验过的运行时上。
4. **L4 在临时 home 里验**：设一个临时 `DSH_HOME`，从零跑 `npm run dsh:install`，
   再 `npm run dsh:start -- --port 3099 --no-open`，打开它打印的带 token 的地址：
   要越过 Loading plugins、侧栏有队徽、整页蓝白主题、控制台无报错。
   旧 profile 的迁移也要验一遍：把一份旧 profile 的 `package.json`、`pnpm-workspace.yaml`、
   `cordis.patch.yml` 复制进临时 home 再装。
5. 核对 `scripts/install-plugins.mjs` 的 `TEMPLATE_HEAD` 与 dsh 的 profile 模板是否一致，
   以及文档里写着版本号的地方（`grep -rn "0\.1\.5-rc\.2"`，下次换成当时锁的那一版）。

---

还有问题看 [`usage.md`](./usage.md) 的使用手册，或 [`features.md`](./features.md) 的功能清单。
