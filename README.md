# dsh4rcs

[![verify](https://github.com/XMU-RCS-rc/dsh4rcs/actions/workflows/verify.yml/badge.svg)](https://github.com/XMU-RCS-rc/dsh4rcs/actions/workflows/verify.yml)

厦门大学 RCS 战队的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件套件 —— 面向 ROBOCON 2027「女娲补天」赛季的电控方向。

把队内散落在文档、口头约定和老队员脑子里的东西，变成 Agent 能直接调用、且**可验证**的工具：规则条款查得到出处，工程规范能自动检查，队内资料没网也能检索。

**7 个插件 · 26 个工具**

---

## 下载与安装

没有发布包，**clone 是唯一的获取方式** —— 插件以本地路径装进 dsh profile，本来就需要源码在本机。

**克隆到 D 盘的工作目录，不要放在主目录下。** 学员工作目录 `rcs-training/`
跟着本仓库走，clone 在 `C:/Users/<你>/` 下面就会把它一并拖到系统盘；
固件仓库 `RCS_code` 也约定放在同级目录，同理。

```bash
mkdir D:/code; cd D:/code
git clone https://github.com/XMU-RCS-rc/dsh4rcs.git
cd dsh4rcs
npm i -g pnpm@11       # dsh:install 装插件要用；带上 @11，不带会装到 12
npm install
npm run setup          # 自检：Node / 依赖 / pnpm / 固件仓库 / 工具链，缺什么直接给命令
npm run verify         # typecheck → build → test
npm run dsh:install    # 装进 dsh 的 rcs-dev profile，最后一行是「完成。」才算装好
npm run dsh:start      # 等打印出 dsh web 地址再开浏览器；新生培训改用 dsh:start:training
```

`npm run setup` 只读不写（除非加 `--write`），逐项告诉你还缺什么以及怎么补。**刚 clone 后不要跳过 `verify` 直接 `dsh:start`** —— 浏览器端 bundle 没构建，宿主会报缺 `lib/client.js`。**`dsh:install` 中途失败就先照报错修好再重跑，别接着 `dsh:start`** —— 半装的 profile 起来要么没有 `rcs_*` 工具，要么不打印网址、一直挂着。

固件仓库放在与本仓库**同级**的 `RCS_code/` 即可自动发现。装到别处、装进其它 profile、或要改配置，见 [`docs/install.md`](./docs/install.md)。

### 环境要求

| 必需 | 说明 |
|---|---|
| Node.js ≥ 22.18 | 用到原生 TypeScript 剥离，22.18 起才默认开启 |
| DeepSeek Harness `0.1.5-rc.2` | `npm install` 会把锁定版装进本仓库，**不能漂**，见[排错](./docs/troubleshooting.md) |
| pnpm 11.x | `npm i -g pnpm@11`（Node 默认没有 pnpm 命令）。`dsh:install` 装插件那一步靠它；缺了那一步失败，`dsh:start` 起来没有 `rcs_*` 工具，旧版脚本建的 profile 则干脆不打印网址、一直挂着，见[排错](./docs/troubleshooting.md) |

| 可选 | 缺了会怎样 |
|---|---|
| RCS 固件仓库 | 工程检查与构建烧录不可用；规则与资料检索不受影响 |
| Keil MDK | `rcs_fw_build` 不可用 |
| CMake（Windows 或 WSL） | `rcs_support_test` 不可用 |
| Python + pyOCD | `rcs_fw_flash` 不可用 |
| 飞书应用凭证 | `rcs_kb_*` 不可用 |

---

## 快速开始

启动后在对话里直接问。**会话预设建议选「标准模式」** —— PTC 模式（原 Code 模式）在 rc.6 下因宿主包双实例崩溃过；0.1.5-rc.2 的依赖树已核实每个宿主包只有一份，但 PTC 模式本身还没实测，见[排错](./docs/troubleshooting.md)。

```
这个赛季的主题和两台机器人的限制是什么
查规则里关于气压上限的条款
CAN 总线怎么配？查一下队内资料
检查 RCS_code 的分层红线
跑一下 PC 单元测试
```

不启动 dsh 也能用：

```bash
npm run check -- all ../RCS_code       # 工程检查，退出码可直接当 CI 门禁
npm run feishu:check                   # 飞书三层权限诊断
npm run kb:dry                         # 只遍历不抓正文，先确认授权范围
npm run kb:sync                        # 增量同步队内资料
npm run train:export                   # 新生：培训结束后导出改动小测的记录，交给老队员
npm run train:collect -- <收到的目录>   # 老队员：汇总成每人一份报告（不打分）
```

---

## 七个插件

| 插件 | 工具数 | 做什么 |
|---|---|---|
| `dsh-rcs-core` | 2 | 队内上下文（赛季/主题/机器人角色/倒计时）与版本新鲜度提醒 |
| `dsh-rcs-rules` | 5 | 规则条款检索、版本 diff、设计合规比对、跨赛季导入 |
| `dsh-rcs-kb` | 3 | 飞书资料同步与**离线**检索 |
| `dsh-rcs-control` | 11 | 分层与嵌入式规范检查、RDLC 解析、运动学检查、构建与烧录 |
| `dsh-rcs-train` | 5 | 新生培训：领任务、发基线、改动小测、回复追问、出验收单 |
| `dsh-rcs-guard` | 0 | 危险操作分级，横切生效 |
| `dsh-rcs-ui-client` | 0 | 队徽与整页 RCS 蓝白主题 |

每个工具的参数与用法见 [`docs/usage.md`](./docs/usage.md)，设计取舍与实测结论见 [`docs/features.md`](./docs/features.md)。

两条贯穿全套的原则：

- **规则只检索、不解读。** 返回条款号 + 版本号 + 原文，判断留给人 —— 理解错的代价是整套方案返工。
- **同步与检索解耦。** 飞书 API 随时可能不可达、限频或改版，所以检索永远读本地镜像，绝不实时打 API。

> 工程检查**已经在队内代码里查出三个真实缺陷**，其中两个属于沉默失败：编译通过、运行不报错，只在场上表现为「今天车有点怪」。详见 [`docs/features.md`](./docs/features.md) 附录。

---

## 安全层

`dsh-rcs-guard` 按危险度分四档，横切每一次 rcs 工具调用：

| 危险度 | `dev` | `training` |
|---|---|---|
| **L0 只读** | 放行 | 放行 |
| **L1 本机写** | 放行 | 放行 |
| **L2 物理动作**（烧录、电机使能、气路动作、总线下发） | 人工确认 | 人工确认（文案更重） |
| **LG 代码生成** | 放行 | **人工确认 + 闸门** |

模式跟着启动命令走：`npm run dsh:start:training` 固定 `training`，`npm run dsh:start:competition` 固定 `dev`
（并关掉培训工具），`npm run dsh:start` 按 profile 配置、默认 `dev`，见 [`docs/install.md`](./docs/install.md)。
LG 目前只登记了尚未实现的 `rcs_train_generate`。`training` 另外会开启培训插件的**改动小测**：
Agent 改了新生的代码，本轮结束前就这次改动出 1–3 道开放题，回答原样存在新生自己的培训目录里，
培训结束后 `npm run train:export` 导出、老队员 `npm run train:collect` 汇总。不评分，也不瞒新生 ——
问答框里写明了回答会给老队员看。看不懂题可以追问，Agent 只能回不给答案的提示，提示原文同样进记录 ——
这一条靠规矩和记录，机器判断不了。见 [`docs/usage.md`](./docs/usage.md#改动小测)。

启动时打印生效策略 —— 安全配置最怕「以为开了其实没开」。

**要如实说清这一层是什么：它是给 rcs 工具加的一道提醒，不是沙箱。** 判定按工具名精确匹配，只认 `rcs_*`，而 profile 里同时装着宿主自带的 `bash` / `pwsh` / `write`。`bash python swd_flash.py --write` 一路畅通。

曾经有第三种模式 `field`（赛场只读），把 L1/L2 全部硬拒。已删除：赛场不会有太多网络方面的顾虑，前提不成立；而且它挡不住上面那条路径 —— **一条挡不住的红线比没有红线更危险**，它让人以为自己被保护着。

> 规则强制要求红色急停按钮。**软件停止永远不能替代硬件急停、驱动使能线和限位保护。**

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
├── dsh-rcs-kb/          飞书资料同步与离线检索
├── dsh-rcs-train/       新生培训
└── dsh-rcs-ui-client/   队徽与浏览器端 UI 入口
```

**适配层刻意做薄。** dsh 处于 developer preview，API 变动只打到适配层，几百行判断逻辑与 UI 投影不受影响；而且绝大部分开发与测试**根本不用启动 dsh**。

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/usage.md`](./docs/usage.md) | 使用手册：每个工具的参数、返回与典型问法 |
| [`docs/features.md`](./docs/features.md) | 功能清单、验证阶梯、版本新鲜度、还缺什么 |
| [`docs/install.md`](./docs/install.md) | 目录布局、装进其它 profile、配置解析链、飞书凭证 |
| [`docs/troubleshooting.md`](./docs/troubleshooting.md) | 排错：版本锁死、双实例、启动失败 |
| [`docs/acceptance-prompts.md`](./docs/acceptance-prompts.md) | 验收提示词：在 dsh 里逐条输入，对着 RCS_code 真实内容核对每个工具 |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 参与开发：本地流程、改动约定、CI |
| [`AGENTS.md`](./AGENTS.md) | 给 Agent 看的工作区说明 |
| [`docs/dsh-rcs-plugin-design.md`](./docs/dsh-rcs-plugin-design.md) | 设计背景与模块规划 |
| [`docs/feishu-setup.md`](./docs/feishu-setup.md) | 飞书应用申请与授权的完整步骤 |
| [`docs/training-design.md`](./docs/training-design.md) | 新生培训的设计稿 |

---

## 约定

这套工具反复付过学费的几条，写在这里供后来者参考：

- **误报比漏报更伤** —— 天天喊狼来了的检查没人看。分层检查曾一次喷 87 条、嵌入式检查曾喷 253 条，收敛到 14 和 7 才有人用。
- **假绿比红更危险** —— 检查项宁可报「未验证」，也不要给一个没验过的勾。
- **静默丢数据最危险** —— 规则提取曾漏掉整条条款，167 条跑通了但少一条没人看得出来。
- **失败却说不出原因是最糟的输出** —— 它逼人去手工翻日志，那工具就白做了。
