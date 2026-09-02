# dsh4rcs

[![verify](https://github.com/XMU-RCS-rc/dsh4rcs/actions/workflows/verify.yml/badge.svg)](https://github.com/XMU-RCS-rc/dsh4rcs/actions/workflows/verify.yml)

厦门大学 RCS 战队的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件套件 —— 面向 ROBOCON 2027「女娲补天」赛季的电控方向。

把队内散落在文档、口头约定和老队员脑子里的东西，变成 Agent 能直接调用、且**可验证**的工具：规则条款查得到出处，工程规范能自动检查，队内资料赛场断网也能检索。

**5 个插件 · 21 个工具 · 423 个测试全通过**

---

## 目录

- [能做什么](#能做什么)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [版本新鲜度](#版本新鲜度)
- [开发](#开发)
- [架构](#架构)
- [排错](#排错)
- [路线图](#路线图)

---

## 能做什么

### 队内上下文与版本（`dsh-rcs-core`）

| 工具 | 作用 |
|---|---|
| `rcs_team_context` | 赛季、主题、规则版本、机器人角色与区域限制、固件技术栈、赛季倒计时 |
| `rcs_version_status` | **只报告，不自动做任何事**：规则书、插件代码、dsh 宿主是不是过时了（L1，赛场禁止） |

新鲜度检查见[版本新鲜度](#版本新鲜度)一节 —— 三件事的可行性差别很大，措辞上也刻意做了区分。

### 规则（`dsh-rcs-rules`）

ROBOCON 每年换主题、赛季内还反复改版。**「改了哪里」往往比「写了什么」更要紧** —— 漏看一条改动可能让整套机构返工。

| 工具 | 作用 |
|---|---|
| `rcs_rule_lookup` | 查条款，返回**条款号 + 版本号 + 原文** |
| `rcs_rule_diff` | 版本对比，列出新增/删除/修改条款 |
| `rcs_rule_check` | 拿设计描述比对约束，指出疑似违规，每条带条款号 |
| `rcs_rule_import` | 导入新规则书（`.docx` → 结构化条款），跨赛季入口 |
| `rcs_rule_versions` | 列出规则库现有的赛季与版本 |

工具**只检索、不解读**。规则理解错的代价是整套方案返工，所以最终判断留给人，最终解释权在裁判组。

### 队内资料（`dsh-rcs-kb`）

| 工具 | 作用 |
|---|---|
| `rcs_kb_search` | **离线**检索飞书资料镜像，返回片段 + 原文链接 |
| `rcs_kb_status` | 镜像状态：上次同步、文档数、授权范围 |
| `rcs_kb_sync` | 同步飞书资料到本地镜像（L1，赛场禁止） |

**同步与检索解耦。** 赛场网络差、飞书随时可能不可达，而那时最需要查资料 —— 所以检索永远读本地镜像，绝不实时打 API。

### 工程检查（`dsh-rcs-control`）

跨赛季的分层架构与执行器软总线是队里的核心资产，但原本只靠 `请读我.txt` 的口头约定维持。**把约定变成工具检查**，是插件能给电控组的最大价值。

| 工具 | 作用 |
|---|---|
| `rcs_lint_layer` | 分层红线：`RCS_Support` 是否依赖 HAL/RTOS（**含传递依赖**）、执行器是否继承 `rcs_actor` |
| `rcs_lint_embedded` | 嵌入式规范：中断内禁 printf/malloc、FromISR 变体、volatile、**急停回路是否可被软件旁路** |
| `rcs_angle_loop_check` | 舵轮角度回环，重点查弧度/角度单位错配 |
| `rcs_kinematics_check` | 底盘运动学：未初始化返回、最短路缺失、运算符优先级 |
| `rcs_rdlc_decode` | 解析 RDLC 报文（CRC16-MODBUS）与命令/反馈载荷 |
| `rcs_template_gap` | 例程缺口比对 |
| `rcs_repo_hygiene` | `.gitignore` 缺失、`*.uvguix`、编译产物、编辑残留 |

> 这些检查**已经在队内代码里查出三个真实缺陷**，其中两个属于沉默失败（编译通过、运行不报错，只在赛场上表现为「今天车有点怪」）。详见 [`FEATURES.md`](./FEATURES.md) 附录。

### 工具链（`dsh-rcs-control`）

| 工具 | 危险度 | 作用 |
|---|---|---|
| `rcs_toolchain_status` | L0 | 探测 Keil / CMake / Python / WSL，缺什么给安装命令 |
| `rcs_support_test` | **L1** | PC 单元测试（CMake + gtest），**不需要硬件** —— CI 的核心 |
| `rcs_fw_build` | **L1** | Keil UV4 构建，编译错误结构化返回 |
| `rcs_fw_flash` | **L2** | SWD 烧录，**默认只校验不写入** |

### 安全层（`dsh-rcs-guard`）

三级危险度，横切生效，无工具：

- **L0 只读** —— 放行
- **L1 本机写** —— 开发放行，赛场拒绝
- **L2 物理动作**（烧录、电机使能、气路动作、总线下发）—— 开发需人工确认，**赛场一律拒绝**

赛场模式另注册不可绕过的 `ctx.tools.guard()`。启动时打印生效策略 —— 安全配置最怕「以为开了其实没开」。

> 规则强制要求红色急停按钮。**软件停止永远不能替代硬件急停、驱动使能线和限位保护。**

---

## 环境要求

| 必需 | 说明 |
|---|---|
| Node.js ≥ 22 | 用到原生 TypeScript 剥离 |
| DeepSeek Harness `0.1.0-rc.6` | 版本必须与 profile 一致，见[排错](#dsh-版本必须锁死) |

| 可选 | 缺了会怎样 |
|---|---|
| RCS 固件仓库 | 工程检查与构建烧录不可用；规则与资料检索不受影响 |
| Keil MDK | `rcs_fw_build` 不可用 |
| CMake（Windows 或 WSL） | `rcs_support_test` 不可用 |
| Python + pyOCD | `rcs_fw_flash` 不可用 |
| 飞书应用凭证 | `rcs_kb_*` 不可用 |

---

## 安装

```bash
git clone https://github.com/XMU-RCS-rc/dsh4rcs.git
cd dsh4rcs
npm install
npm run setup          # 自检：Node / 依赖 / 固件仓库 / 工具链，缺什么直接给命令
npm run verify         # typecheck → build → test
npm run dsh:install    # 装进 dsh 的 rcs-dev profile
npm run dsh:start      # 等打印出 dsh web 地址再开浏览器
```

`npm run setup` 只读不写（除非加 `--write`），逐项告诉你还缺什么以及怎么补。

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

## 使用

启动后在对话里直接问。**会话预设要选「标准模式」** —— PTC（Code）模式在 rc.6 下有已知问题，见[排错](#工具调用报-cannot-read-properties-of-undefined-reading-prepare)。

```
这个赛季的主题和两台机器人的限制是什么
查规则里关于气压上限的条款
CAN 总线怎么配？查一下队内资料
检查 RCS_code 的分层红线
跑一下 PC 单元测试
```

### 不启动 dsh 也能用

```bash
npm run check -- all ../RCS_code       # 工程检查，退出码可直接当 CI 门禁
npm run feishu:check                   # 飞书三层权限诊断
npm run kb:dry                         # 只遍历不抓正文，先确认授权范围
npm run kb:sync                        # 增量同步队内资料
```

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

## 版本新鲜度

「我手上这份是不是已经旧了」——`rcs_version_status` 工具，或 `npm run setup` 的最后一节。

三件事的可行性差别很大，所以措辞和做法都不一样：

| 检查什么 | 怎么查 | 为什么这么做 |
|---|---|---|
| **规则书** | 纯过期提醒，不联网 | 后果最严重，但**没法自动检测** —— robocon.org.cn 没有接口，爬页面会给出比查不到危险得多的「假确认」。所以只把「该去看了」变显眼 |
| **插件代码** | `git ls-remote` 比对本地 HEAD | 一次网络往返，复用已有凭据（私有库不用另外授权），**不改动本地仓库任何状态** |
| **dsh 宿主** | npm registry 的 latest | 只提示，**绝不建议自动升级** —— 见[排错](#dsh-版本必须锁死) |

三条硬约束：

- **不在插件加载时打网络。** 赛场断网必须可用，检查只在显式调用时发生
- **失败一律降级成「查不到」**，绝不抛异常 —— 离线是正常状态
- **只报告，不改任何东西。** 不自动 pull、不自动升级、不自动改配置

结果缓存 24 小时（`data/.version-cache.json`，已 gitignore），`refresh` 参数强制重查。赛场模式下整个工具被安全层拦在 L1（联网 + 落盘，与 `rcs_kb_sync` 同类）。

> 规则书那项要人配合：去官网确认过之后 —— **不管有没有新版** —— 把 `config/team.json` 的 `rules.lastCheckedAt` 改成当天。真有新版就 `npm run rules:import -- <docx> <赛季> <版本>` 导入（`--` 不能省，否则参数传不进脚本）。
>
> 顺带一提，`rcs_team_context` 也会捎带这条提醒：问「我们现在什么赛季」的人，正是最该知道「规则版本很久没确认过了」的人。

---

## 开发

```bash
npm run verify      # typecheck → build → test（顺序不能改，见下）
npm run typecheck   # 对着真实 dsh 类型定义检查适配层
npm run build       # esbuild 多插件构建，检查宿主包泄漏
npm run test        # 423 个测试
```

> `verify` 的顺序是 typecheck → **build** → test：部分测试加载 `packages/*/lib` 的构建产物，先测后构建会拿到上一次的旧产物，报出令人困惑的失败。

### 持续集成

推到 `main` 或开 PR 时，[`.github/workflows/verify.yml`](./.github/workflows/verify.yml) 会在 **Ubuntu 与 Windows** 上各跑一遍 `npm ci → typecheck → build → test`。

依赖固件仓库、Keil、飞书凭证的测试都用 `skipIf` 守着，CI 上自动跳过 —— 这是设计好的，不是漏跑。队里清一色 Windows，多跑一个 Ubuntu 是为了逼出硬编码盘符、路径分隔符这类问题（都实际踩过）。

### 验证阶梯

每一层都能抓到下一层抓不到的东西：

| 级别 | 做什么 | 需要 dsh |
|---|---|---|
| L0 | typecheck，对着 `dsh-tools` 的 `.d.ts` | ❌ |
| L1 | 单元测试（真实工程与真实规则数据，不是 mock） | ❌ |
| L2 | CLI 冒烟 | ❌ |
| L2.5 | 桩 ctx / **真实 cordis** 跑 `apply` | ❌ |
| L3 | `npm run dsh:patch` 挂 overlay 加载 | ✅ |
| L4 | `npm run dsh:install` 装进 profile | ✅ |

---

## 架构

```
packages/
├── rcs-core/            纯逻辑，零 dsh 依赖 —— 所有判断都在这
├── rcs-ui/              视图模型，纯投影，零依赖
├── dsh-rcs-core/        Service 插件，提供 ctx.rcs
├── dsh-rcs-guard/       安全层
├── dsh-rcs-control/     工程检查、协议解析、构建烧录
├── dsh-rcs-rules/       规则版本追踪与查询
└── dsh-rcs-kb/          飞书资料同步与离线检索
```

**适配层刻意做薄。** dsh 处于 developer preview，API 变动只打到适配层，几百行判断逻辑与 UI 投影不受影响；而且绝大部分开发与测试**根本不用启动 dsh**。

设计背景见 [`dsh-rcs-plugin-design.md`](./dsh-rcs-plugin-design.md)，完整功能清单见 [`FEATURES.md`](./FEATURES.md)，使用手册见 [`USAGE.md`](./USAGE.md)。

---

## 排错

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

## 路线图

**已完成** —— 队内上下文、规则查询与跨赛季导入、飞书资料同步与离线检索、分层与嵌入式检查、协议解析、构建与烧录、三级安全管控、版本新鲜度提醒。

**留了接口，等实物/数据** —— 这些能力**未配置时会明确拒绝运行**，不会拿默认值糊弄：

| 能力 | 等什么 |
|---|---|
| `rcs_bus_decode` | CAN ID → 机构映射（每年底盘全新，等实车定版后填 `config/bus-map.json`） |
| 日志解析与赛后复盘 | 一份真实日志样本 + 格式说明 |
| `rcs_pid_advise` | 一份带调参过程的 VOFA 波形 |
| 赛场清单 | 检录/就位/自检/下场各阶段的实际内容 |
| UI Tier 2 面板 | RCS 品牌色（现为中性占位，**未编造**） |

---

## 约定

这套工具反复付过学费的几条，写在这里供后来者参考：

- **误报比漏报更伤** —— 天天喊狼来了的检查没人看。分层检查曾一次喷 87 条、嵌入式检查曾喷 253 条，收敛到 14 和 7 才有人用。
- **假绿比红更危险** —— 检查项宁可报「未验证」，也不要给一个没验过的勾。
- **静默丢数据最危险** —— 规则提取曾漏掉整条条款，167 条跑通了但少一条没人看得出来。
- **失败却说不出原因是最糟的输出** —— 它逼人去手工翻日志，那工具就白做了。
