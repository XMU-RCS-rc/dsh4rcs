# 安装与配置细节

README 里是最短路径，够日常使用。这里放两类内容：**装到非默认位置**，以及**配置怎么解析**。

---

## 目录布局

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
