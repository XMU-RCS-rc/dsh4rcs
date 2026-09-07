# 安装与配置细节

README 里是最短路径，够日常使用。这里放两类内容：**装到非默认位置**，以及**配置怎么解析**。

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

放在别处就设环境变量：

```powershell
[Environment]::SetEnvironmentVariable('RCS_CODE_ROOT','E:/path/to/RCS_code','User')
```

---

## 启用与关闭整套插件

dsh4rcs 默认全部启用。需要明确切换时：

| 命令 | 效果 |
|---|---|
| `npm run dsh:start` | 日常启动（等同 `dsh:start:rcs`） |
| `npm run dsh:start:no-rcs` | 临时 patch 禁用全部 7 个入口，但不卸载插件 |
| `npm run dsh:start:competition` | 只关掉培训工具 `rcs_train_*`，其余照常 |

切换状态需要重启 dsh。

**培训与比赛的区分只在工具集** —— 培训机器多一套 `rcs_train_*`。默认全装
（`rcs-train` 不被调用时不做任何事），需要干净环境时才关。这样 30 多个新生装机时
少一条要记的命令，而老队员同一台笔记本既能备课又能打比赛，一条命令切换、
不用重装 profile。

危险度判定**不随培训/比赛改变**，那是 guard 的 `mode` 单独管的另一条线，
见 [README 的安全层一节](../README.md#安全层)。

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

它走 `scripts/install-plugins.mjs`，三步：

1. **构建**插件产物（失败就停住 —— 装一份旧产物只会让人对着过期代码调试）
2. **写 profile 配置**：把本仓库 `package.json` 的 195 条 `overrides` 和
   `allowBuilds: koffi` 写进 `~/.dsh/profiles/rcs-dev/pnpm-workspace.yaml`
3. **装 7 个插件 + 2 个宿主 bundle**（`dsh-web-app`、`dsh-client-ui-primitives`）

第 2 步必须在 pnpm 第一次跑之前：pnpm 默认忽略依赖的构建脚本并以
`ERR_PNPM_IGNORED_BUILDS` **失败退出**，而 koffi 从第一次解析就在依赖里。

第 2、3 步以前都不在仓库里，只存在于维护者本机手改过的那份 profile ——
新人照着文档走完，得到的是一个装不完、或者装完了没有网页界面的 profile，
而且两种失败都不会说自己缺什么。现在这三步都在脚本里，可重复。

profile 的 `pnpm-workspace.yaml` 里生成段带 `# >>> dsh4rcs overrides (generated) >>>`
标记，重跑是整段替换；标记之外的手写内容不动。若文件里另有一段手写的
`overrides:` 或 `allowBuilds:`，脚本会停下来让你自己合并 ——
YAML 重复顶层键只有一个生效，且不报错。

装到别的 profile：`DSH4RCS_PROFILE=名字 node scripts/install-plugins.mjs`。

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

### 推荐目录布局

固件仓库放在**同级目录**即可自动发现，无需任何配置：

```
code/
├── dsh4rcs/       ← 本仓库
└── RCS_code/      ← 固件仓库
```

放在别处就设环境变量：

```powershell
[Environment]::SetEnvironmentVariable('RCS_CODE_ROOT','E:/path/to/RCS_code','User')
```

---

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
---

配置字段的完整含义见 [`../config/team.json`](../config/team.json) 里的 `$comment` 键 ——
那些注释就写在它们描述的字段旁边，不会走失。
