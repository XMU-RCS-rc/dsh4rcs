# 安装与配置细节

README 里是最短路径，够日常使用。这里放三类内容：**怎么更新**、**装到非默认位置**，以及**配置怎么解析**。

---

## 更新

队里推了新版本，先在跑 dsh 的那个终端里 Ctrl+C 停掉它，再在仓库根目录按顺序跑：

```powershell
git pull
npm install            # 依赖或锁定的 dsh 版本可能跟着变
npm run dsh:install    # 重新构建并装进 profile，最后一行是「完成。」才算装好
npm run dsh:start      # 或 dsh:start:training / dsh:start:competition
```

这和 `rcs_version_status` 工具、`npm run setup` 最后一节给的建议是同一串命令。
不确定自己是不是最新，就跑 `npm run setup` 看「版本新鲜度」，或在 dsh 里问一句「插件是不是最新的」。

| 步骤 | 做什么 | 什么时候可以跳过 |
|---|---|---|
| `git pull` | 拿到新代码 | — |
| `npm install` | 装回 `package-lock.json` 锁定的依赖，包括锁定版的 dsh 运行时；postinstall 顺带把宿主包联接重新指好 | 拉下来的提交没碰 `package.json` / `package-lock.json` |
| `npm run dsh:install` | 重新构建插件，并把插件装进 profile（新加的插件也靠这一步装上）。插件以 link 方式装在 profile 里，dsh 跑的是 `packages/*/lib` 的构建产物 —— 不重新构建就还是旧代码 | 只改了文档 |
| 重启 dsh | 插件只在 dsh 启动时加载一次，正在跑的进程不会换成新代码 | — |

**最常见的坑是没重启。** 仓库里明明修过的问题在 dsh 里照样出现 —— 比如工具报
`returned invalid output`、`"value.reason" is not a declared property` —— 先确认 dsh 是在上面几步之后重新启动的。

`git pull` 报本地有改动：多半是 `npm run setup -- --write` 改过 `config/team.json`。先 `git stash`，拉完再 `git stash pop`。

更新不会动这些：学员工作目录 `rcs-training/`（改动小测的记录在里面）、飞书镜像 `data/kb-cache/`、
profile 里你自己写的 `cordis.patch.yml`。dsh 的会话记录也不动 —— 除非锁定的 dsh 版本变了，见下一段。

**锁定的 dsh 版本变了**（`package.json` 里 `@deepseek-ai/dsh` 的版本号变了）：步骤照上面跑，另外先读
[排错](./troubleshooting.md)里「升级到 0.1.5-rc.2」那一节 —— 第一次启动会把旧会话迁到新格式，而且是单向的，
想留退路先把 `~/.dsh/sessions` 复制一份。维护者要换锁定的版本，见同一份文档的「升级 dsh 版本（维护者）」。

---

## 前置条件：pnpm 11.x

`npm run dsh:install` 装插件那一步是 `dsh plugin add`，dsh 把它原样转给 profile 目录里的 pnpm。
Node 默认没有 pnpm 命令，要单独装：

```powershell
npm i -g pnpm@11
pnpm --version   # 应输出 11.x
```

**带上 `@11`。** npm 上 pnpm 的 latest 已经是 12，不带版本的 `npm i -g pnpm` 会装到 12。
本仓库写进 profile 的配置（`pnpm-workspace.yaml` 里的 `overrides` 与 `allowBuilds`）是按 pnpm 11
的规则写、按 11 验证的。11 同时是下限：11 起 overrides 只认 `pnpm-workspace.yaml`，
见[排错](./troubleshooting.md)。

已经装了 12 的不必马上降：实测 12.4.1 能把当前布局装通、网页照常起来，`dsh:install` 只打一行警告。
但当前布局只有 `link:` 依赖，`allowBuilds` 那一段在 12 下其实没被用到，也就没验证过；
遇到 pnpm 报错，先换回 11 再说。

`npm run setup` 会查这一项；`dsh:install` 也会在构建之前先查，缺了就停下并给出上面的命令。

---

## 目录布局

固件仓库放在**同级目录**即可自动发现，无需任何配置：

```
code/
├── dsh4rcs/       ← 本仓库
├── RCS_code/      ← 固件仓库
└── rcs-training/  ← 学员工作目录（首次发放基线时自动建）
```

`rcs-training/` 由 `rcs_train_scaffold` 按需创建，不用手工建，也不进任何 git 仓库。
它默认跟着本仓库走而**不放主目录** —— Windows 上主目录必然在 C 盘，
而队里的工作盘是 D，三十多个新生的工作目录不该堆到系统盘。
要放别处就设环境变量：

```powershell
[Environment]::SetEnvironmentVariable('RCS_TRAINING_HOME','E:/rcs-training','User')
```

启动时横幅会打印实际用的目录和它的来源，对不上先看那一行。

固件仓库放在别处就设环境变量：

```powershell
[Environment]::SetEnvironmentVariable('RCS_CODE_ROOT','E:/path/to/RCS_code','User')
```

---

## 启用与关闭整套插件

dsh4rcs 默认全部启用。按场景选启动命令：

| 命令 | 安全层模式 | 培训工具 `rcs_train_*` | 用在 |
|---|---|---|---|
| `npm run dsh:start` | 按 profile 配置（默认 `dev`） | 开 | 日常开发、备课 |
| `npm run dsh:start:training` | **固定 `training`** | 开 | 新生培训（另开改动小测） |
| `npm run dsh:start:competition` | **固定 `dev`** | 关 | 比赛 |
| `npm run dsh:start:no-rcs` | —（整套停用） | 关 | 临时停用全部 7 个入口，不卸载插件 |

切换需要重启 dsh。启动横幅会报出生效的模式（`[rcs-guard] 培训模式…` 或 `[rcs-guard] 开发模式…`），
对不上先看那一行；要看完整配置，跑 `npm run dsh:config -- --patch ./config/overlays/dsh4rcs-training.cordis.yml`。

**培训与比赛为什么要分两条命令**：guard 的模式本来是 profile 级配置，而以前没有任何启动命令会设它 ——
培训机器照 README 跑 `dsh:start`，拿到的是 `dev`；谁为了上课把 profile 改成 `training` 却忘了改回来，
比赛时又一直带着。现在两条命令把模式写死在各自的 overlay 里（`config/overlays/` 下的 `dsh4rcs-training.cordis.yml` /
`dsh4rcs-competition.cordis.yml`），不继承 profile。`rcs-train` 默认装着（不被调用时不做任何事），
比赛那条命令顺手关掉它；老队员同一台笔记本既能备课又能打比赛，一条命令切换、不用重装 profile。

两种模式都**不拒绝**任何调用 —— 培训一样要烧代码、也用 F407。差别只有两处：`training` 下 L2 物理动作
的确认文案更重（多一句「第一次做请让老队员在旁边」），LG 代码生成要过闸门。LG 目前只登记了
`rcs_train_generate`，这个工具还没实现，所以眼下真正起作用的只有前一处。
见 [README 的安全层一节](../README.md#安全层)。

培训插件的**改动小测**也跟着这个模式走：只在 `training` 下开启，见 [USAGE](./usage.md#改动小测)。
所以 `dsh4rcs-training.cordis.yml` 里不给 `rcs-train` 单独配 —— 配了会整段替换 profile 里
`rcs-train` 的配置（比如学员名字 `student`）。

**overlay 会整段替换 profile 里 `rcs-guard` 的 config**（dsh 的 patch 不合并 config）。队里要加自定义的
L2 工具，加在上面两份 overlay 的 `extraL2` 里；只加在 profile（或 dsh home）的 `cordis.patch.yml` 里，
用这两条命令启动时不生效，`scripts/dsh.mjs` 发现这种情况会在启动时提醒。

**这两条命令分不开的**：宿主自己的权限预设。每个会话可以在 `read-only` / `workspace-write` /
`danger-full-access` 之间选，新会话的默认值记在 dsh home（没设 `DSH_HOME` 就是 `~/.dsh`）的
`settings.yaml` 里；会话记录和凭据也在这一层 —— 所有 profile、所有启动方式共用。
其中 `danger-full-access` 不弹任何确认：rcs 的 L2 工具因此被自动拒绝，但宿主自带的 shell 工具
不受沙箱限制、也不经过 guard，照样能直接跑烧录脚本。新生各自装机时本来就是各自的 home；
同一台电脑要彻底分开，就给培训单独设一个 `DSH_HOME`（本仓库的脚本都认它），再在那边跑一遍
`npm run dsh:install`。

---

## 构建与安装的两个提示

`dsh:install` 会打印构建/安装两个阶段。pnpm 保留原生进度；如果首次需要通过 npx
下载锁定版 dsh，非交互终端与 CI 每 15 秒打印一次已用时间，避免长时间无输出被误判为
卡死。这里不显示百分比，因为 npx 不提供总包数或总字节数。PowerShell 中需要留存完整
日志时可用 `npm run dsh:install 2>&1 | Tee-Object dsh-install.log`。

`dsh-rcs-ui-client` 声明了浏览器端 bundle，**必须先构建才可启动**。它通过 dsh 的主题
token 接口为整个页面提供 RCS 蓝白主题，覆盖背景、侧栏、卡片、按钮、输入框、对话气泡、
边框和交互态，并分别适配浅色与深色模式；队徽点击后在新标签页打开团队 GitHub 主页。
`npm run verify` 和 `npm run dsh:install` 都会先构建 —— 刚 clone 后不要跳过这两步直接
`dsh:start`，否则宿主会明确报告缺少 `lib/client.js`。

---

### `npm run dsh:install` 都做了什么

它走 `scripts/install-plugins.mjs`。开工前先查 pnpm（没有就停，什么都不做），然后四步：

1. **构建**插件产物（失败就停住 —— 装一份旧产物只会让人对着过期代码调试）
2. **准备 profile**：不存在就用 dsh 自带的 web 模板新建（`--from-default-profile web`），
   bundles 里是 `dsh-base` 与 `dsh-web-app`，两者都从 dsh 安装目录解析；已存在就就地迁移
   旧版留下的布局（见[排错](./troubleshooting.md)第一节）
3. **写 profile 配置**：把本仓库 `package.json` 的 240 条 `overrides` 和 `allowBuilds: koffi`
   写进 `$DSH_HOME/profiles/rcs-dev/pnpm-workspace.yaml`（没设 `DSH_HOME` 就是 `~/.dsh`）
4. **装 7 个插件**（`link:` 到本仓库 `packages/`）—— 由 dsh 转给 profile 目录里的 pnpm，
   整条流程只有这一步用到 pnpm；收尾检查宿主包联接

**结尾打印 `完成。启动：npm run dsh:start` 才算装好。** 任何一步失败，脚本都会停下并以非 0 退出，
这时别接着跑 `dsh:start` —— 半装的 profile 起来要么没有 `rcs_*` 工具，要么不打印网址、一直挂着
（见[排错](./troubleshooting.md)）。照报错修好再重跑 `npm run dsh:install`：它可以重复跑，
已建好的 profile 会被补齐。

profile 里**不装任何宿主包**。0.1.0-rc.6 时脚本会把 `dsh-web-app`、`dsh-client-ui-primitives`
装进 profile —— 可 dsh 解析 bundle 永远先找安装目录，那两份从来不会被用到，
只是拖进整套客户端依赖，还多出一份与宿主不同的 dsh-tools。

第 3 步必须在 pnpm 第一次跑之前：pnpm 默认忽略依赖的构建脚本并以
`ERR_PNPM_IGNORED_BUILDS` **失败退出**。按模板建 profile 本身不跑 pnpm，所以这个顺序成立。
现在 profile 不从 npm 装包，这一段是保险：谁往 profile 里加了宿主包，也只能解析到同一代。

这几步以前都不在仓库里，只存在于维护者本机手改过的那份 profile ——
新人照着文档走完，得到的是一个装不完、或者装完了没有网页界面的 profile，
而且两种失败都不会说自己缺什么。现在都在脚本里，可重复。

profile 的 `pnpm-workspace.yaml` 里生成段带 `# >>> dsh4rcs overrides (generated) >>>`
标记，重跑是整段替换；标记之外的手写内容不动。若文件里另有一段手写的
`overrides:` 或 `allowBuilds:`，脚本会停下来让你自己合并 ——
YAML 重复顶层键只有一个生效，且不报错。

装到别的 profile：`DSH4RCS_PROFILE=名字 node scripts/install-plugins.mjs`。
装到别的 dsh home：设 `DSH_HOME`，脚本与 dsh 按同一条规则定位 profile。

### tgz 安装到其它 profile

`npm run dsh:install` 使用 link 布局，插件能从真实模块位置识别本仓库。若把
`dsh-rcs-*.tgz` 安装到 `web` 等其它 profile，插件位于
`<profile>/node_modules`，**无法反推出 clone 在哪里**；必须显式供给路径。

在该 profile 的 `cordis.patch.yml` 中加入（把路径换成实际 clone 位置）：

```yaml
- id: rcs-core
  config:
    teamConfig: 'D:/code/dsh4rcs/config/team.json'
```

完整套件会通过 `ctx.rcs` 共享该配置，并从 `teamConfig` 的位置派生
`data/rules`、`data/kb-cache` 和 `config/`。若单独安装某个插件，则给该插件
设置其已有的 `teamConfig`、`rulesRoot`、`cacheDir` 或 `configDir` 字段。

也可设置 `DSH4RCS_HOME` 指向 clone 根目录。两种方式都会校验
`package.json` 与 `config/team.json`；指错时明确报错，不会把 profile 根当作
仓库并产生假绿。

---

## 配置

`config/team.json` 是**唯一真相** —— 赛季一换只改这里，代码不用动。

路径字段默认留空，运行时按这条链解析：

```
工具参数 → ctx.rcs 共享配置 → 插件配置 → 环境变量 → 自动发现 → 明确报错
```

解析不到时会**列出找过哪些路径**，而不是猜一个然后给出莫名其妙的结果。

### 飞书凭证

`config/team.json` 里只有 `appId` 和授权目录清单，**没有 app_secret**。每个人自己设环境变量：

```powershell
[Environment]::SetEnvironmentVariable('FEISHU_APP_SECRET','你的secret','User')
```

设完**重开终端**。诊断用 `npm run feishu:check`，它分三层报告（scope / 协作者 / 实际范围），并且**只推荐只读权限**。

详细步骤见 [`feishu-setup.md`](./feishu-setup.md)。

---

配置字段的完整含义见 [`../config/team.json`](../config/team.json) 里的 `$comment` 键 ——
那些注释就写在它们描述的字段旁边，不会走失。
