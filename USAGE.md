# dsh4rcs — 项目总览与使用手册

> 更新：2026-08-27
> 面向：RCS 队内使用者与后续维护者
> 相关：[`README.md`](./README.md)（设计要点与验证阶梯） · [`dsh-rcs-plugin-design.md`](./dsh-rcs-plugin-design.md)（完整功能设计）

---

## 一、这是什么

给 RCS 战队做的 DeepSeek Harness（dsh）插件套件。**4 个插件、8 个工具**，让 Agent 能直接回答「规则怎么说」和「我们的工程哪里不对」。

**当前赛季：2027 · 第二十六届 ROBOCON 竞技赛 · 主题「女娲补天」**（规则 V0 已入库）。

---

## 二、20 个工具

### 规则相关（`dsh-rcs-rules`）

| 工具 | 参数 | 作用 |
|---|---|---|
| `rcs_rule_lookup` | `query`(必填)、`season`、`version`、`limit` | 查条款。可给关键词（「气压上限」）或直接给条款号（`11.14`）。**返回条款号 + 版本号 + 原文** |
| `rcs_rule_diff` | `fromVersion`(必填)、`toVersion`(必填)、`season` | 版本对比，列出新增/删除/修改条款 |
| `rcs_rule_check` | `design`(必填)、`season`、`version` | 拿设计描述比对约束，指出疑似违规，每条带条款号 |
| `rcs_rule_import` | `docxPath`(必填)、`season`(必填)、`version`(必填)、`overwrite` | **导入新规则书** —— 跨赛季入口 |
| `rcs_rule_versions` | — | 列出规则库现有的赛季与版本 |

### 工程检查（`dsh-rcs-control`）

| 工具 | 参数 | 作用 |
|---|---|---|
| `rcs_lint_layer` | `projectRoot` | 分层红线：`RCS_Support` 是否依赖 HAL/RTOS（**含传递依赖**）、执行器是否继承 `rcs_actor`、主题代码是否混进 `RCS/` |
| `rcs_lint_embedded` | `projectRoot`、`includeDirs` | 嵌入式规范：中断内禁 printf/malloc/阻塞延时、FromISR 变体、volatile、临界区、**急停回路是否可被软件旁路** |
| `rcs_template_gap` | `projectRoot`、`includePairing` | 18 个计划例程的缺口 |
| `rcs_repo_hygiene` | `repoRoot` | `.gitignore` 缺失、`*.uvguix`、编译产物、编辑残留 |

### 队内上下文（`dsh-rcs-core`）

| 工具 | 参数 | 作用 |
|---|---|---|
| `rcs_team_context` | `robot` | 赛季、主题、规则版本、TR/BR 角色与区域限制、固件技术栈、赛季倒计时 |

### 协议与解算（`dsh-rcs-control`）

| 工具 | 参数 | 作用 |
|---|---|---|
| `rcs_rdlc_decode` | `hex`(必填) | 解析 RDLC 字节流与命令/反馈载荷。坏帧报偏移+原始字节并能重新同步 |
| `rcs_angle_loop_check` | `projectRoot` | 舵轮角度回环，重点查弧度/角度单位错配 |
| `rcs_kinematics_check` | `projectRoot` | 底盘运动学，查未初始化返回、最短路缺失、优先级混用 |

### 工具链（`dsh-rcs-control`）

| 工具 | 危险度 | 作用 |
|---|---|---|
| `rcs_toolchain_status` | L0 | 探测 Keil / CMake / Python / WSL，缺什么给安装命令 |
| `rcs_support_test` | **L1** | PC 单元测试，不需要硬件 |
| `rcs_fw_build` | **L1** | Keil UV4 构建，错误结构化返回 |
| `rcs_fw_flash` | **L2** | SWD 烧录，**默认只校验**，赛场拒绝 |

> L1/L2 由 `rcs-guard` 统一管控：赛场模式下三者全部硬拒，开发模式下烧录需人工确认。

### 队内飞书资料（`dsh-rcs-kb`）

| 工具 | 参数 | 作用 |
|---|---|---|
| `rcs_kb_search` | `query`(必填)、`limit` | **离线**检索队内资料镜像，返回片段 + 飞书原文链接 |
| `rcs_kb_status` | — | 镜像状态：上次同步、文档数、授权范围、按类型跳过数 |
| `rcs_kb_sync` | `force` | 同步飞书资料到本地镜像。**联网 + 写盘 → L1，赛场禁止** |

> 检索**不联网**，赛场断网照样能用。这是刻意的：同步与检索解耦，
> 检索永远读 `data/kb-cache/`，绝不实时打飞书 API。
>
> 查不到东西时先跑 `rcs_kb_status` —— 要区分「镜像里没有」和「队里没有」。

### 安全层（`dsh-rcs-guard`，无工具，横切生效）

三级危险度管控。**L2 物理动作**（烧录、电机使能、气路动作、总线下发）在开发模式需人工确认，**赛场模式一律拒绝**。

---

## 三、怎么用

```bash
npm run dsh:start      # 启动 rcs-dev profile（插件已装好）
```

浏览器打开提示的地址，然后直接问：

> 气压上限是多少？

> 我们打算用 0.8MPa 的气动、整机 55kg，有没有违规？

> 检查一下固件工程的分层有没有问题

结果以**卡片**呈现——规则检索按条款折叠，工程检查按文件折叠、可点击跳转。

### 改了代码之后

```bash
npm run verify        # typecheck + 146 个测试 + 构建
npm run dsh:install   # 重新构建并装进 profile（当前只装 control；其余插件同理）
npm run dsh:start
```

### 不启动 dsh 也能用（适合进 CI）

```bash
npm run check -- all            D:/code/RCS_code
npm run check -- layer-lint     D:/code/RCS_code
npm run check -- lint-embedded  D:/code/RCS_code
npm run check -- hygiene        D:/code/RCS_code/R2
npm run check -- layer-lint     D:/code/RCS_code --json
```

**退出码**：无 error 返回 0，否则 1 —— 可直接当门禁。

工具链相关的检查也能在 dsh 之外跑（详见各工具说明）：构建走 Keil `UV4.exe`、
PC 测试走 CMake+gtest、烧录走队内既有的 `upper_host_cli/swd_flash.py`。
**这三样都不是新造的轮子**，插件只负责调用与解析输出。

飞书同步同样有命令行入口：

```bash
npm run feishu:check       # 三层权限诊断：scope / 协作者 / 实际范围
npm run kb:dry             # 只遍历不抓正文 —— 先确认授权范围对不对
npm run kb:sync            # 增量同步
npm run kb:sync -- --force # 全量重抓
```

密钥只从环境变量 `FEISHU_APP_SECRET` 读，**不接受命令行传入**（会进 shell 历史）。

---

## 四、V1 规则发布时怎么做

官方前言明说「很快，将会有国内赛规则V1版发布」。到时候：

```bash
node scripts/docx-to-rules.mjs <V1规则书.docx> 2027 V1
```

产出 `data/rules/2027/V1/{rules.txt, clauses.json, meta.json}`，然后让 Agent 跑：

> 对比 V0 和 V1 的规则改动

改动清单出来后，**人工核对涉及机械/电控的条款**。另需手工更新 `data/rules/2027/V1/constraints.json`（数值约束表，带条款号溯源），并把 `config/team.json` 的 `rules.currentVersion` 改成 `V1`。

---

## 五、当前实测结论

| 检查 | 结果 |
|---|---|
| `layer-lint`（新模板） | 14 条（13 分层污染 + 1 执行器未继承基类） |
| `lint-embedded`（新模板） | 7 条（含 `uart_test.c:52` **中断回调里 printf**） |
| `lint-embedded`（R2） | 7 条（含 `stm32f4xx_it.c:69` 中断里 printf） |
| `template-gap` | 18 个计划例程覆盖 **7** 个 |
| `repo-hygiene`（R2） | 21 个 uvguix、278 个编译产物、缺 `.gitignore` |

**最值得先处理的一条**：`RCS_Support` 已被 HAL/RTOS 污染，`rcs_private_config.h` 是首要污染源（它自己 include 了 11 个厂商/RTOS 头）。这解释了为什么 `RCS_Support/test` 下**只有 `angle_loop_test.cpp` 一个测试**——别的文件在 PC 上根本编不过。

---

## 六、排错

**第一招永远是看配置树**：

```bash
npm run dsh:config
```

找 `# == dsh-rcs-*` 开头的段落，核对 `name` 与 `config`。

| 症状 | 原因 | 处理 |
|---|---|---|
| 配置树里没有某个插件 | 没装进 profile | `node scripts/dsh.mjs plugin --profile rcs-dev add ./packages/<插件>` |
| `ERR_UNSUPPORTED_ESM_URL_SCHEME` | Windows 上 patch 路径写成了盘符路径 | 改成 `file:///D:/...`（三个斜杠） |
| 插件停在 PENDING 又不报错 | `inject` 的服务没就绪 | 看配置树确认依赖服务在场 |
| `ERR_PNPM_IGNORED_BUILDS` | 原生包需构建授权 | profile 的 `pnpm-workspace.yaml` 里 `allowBuilds: { <包名>: true }` |
| 规则工具报「规则文件不存在」 | 赛季/版本目录没建 | 用 `scripts/docx-to-rules.mjs` 转换 |
| 启动要一分钟 | 插件多，属正常 | 耐心等，或看 `dsh:config` 先确认配置无误 |

### 不要直接敲 `dsh`

系统的 `dsh` 是 `dsh-launcher`，内容是 `npx @deepseek-ai/dsh web %*`：**不锁版本**（会漂到新版），且**硬编码 `web` 子命令**（所以 `dsh --version` 会直接启服务看起来像卡住，`dsh plugin add` 更是彻底失效）。一律走 `npm run dsh:*`，它们经 `scripts/dsh.mjs` 锁定 `0.1.0-rc.6`。

---

## 七、仓库内容

### 文档

| 文件 | 内容 |
|---|---|
| `USAGE.md` | 本文 —— 总览与使用 |
| `README.md` | 设计要点、验证阶梯、已知事项 |
| `dsh-rcs-plugin-design.md` | 完整功能设计 v0.5（M0~M7 全景与实现状态） |
| `rcs-embedded-roadmap.md` | 电控方向技术路线（不涉及插件） |
| `deepseek-harness-plugin-guide.md` | dsh 插件开发通用指南 |

### 代码

```
packages/
├── rcs-core/            纯逻辑，零 dsh 依赖
│   ├── layer-lint       分层红线（传递依赖 BFS）
│   ├── lint-embedded    嵌入式规范
│   ├── template-gap     例程缺口 + 头源配对
│   ├── repo-hygiene     仓库卫生
│   ├── rule-diff        规则版本 diff（字符二元组相似度）
│   ├── rule-source      规则数据源 + 条款检索
│   ├── rule-check       设计约束比对
│   ├── team-context     队内上下文
│   ├── danger           危险度分级
│   └── cli              命令行入口
├── rcs-ui/              视图模型，纯投影
│   ├── view-model       分组、污染源排名、健康分、呈现元数据
│   ├── theme            色彩 token（品牌色待填）
│   └── panel-contract   客户端面板契约（待实现）
├── dsh-rcs-core/        Service 插件，提供 ctx.rcs
├── dsh-rcs-guard/       安全层
├── dsh-rcs-control/     工程检查工具
└── dsh-rcs-rules/       规则工具
```

### 数据与脚本

| 路径 | 作用 |
|---|---|
| `config/team.json` | **队内共享上下文的单一真相**，赛季一换只改这里 |
| `config/layer-rules.json` | 分层规则、执行器基类、主题代码特征 |
| `config/template-manifest.json` | 18 个例程清单、`headerOnly` 白名单 |
| `data/rules/2027/V0/` | 规则原件、167 条结构化条款、约束表 |
| `scripts/dsh.mjs` | 锁版本的 dsh 调用器，绕开 launcher |
| `scripts/docx-to-rules.mjs` | 规则书 .docx → 结构化条款（零依赖） |
| `scripts/feishu-check.mjs` | 飞书三层权限诊断，**用真实 token 探测** |
| `scripts/kb-sync.mjs` | 命令行同步入口，不必启动 dsh |
| `data/kb-cache/` | 飞书资料本地镜像（**已 gitignore**，队内资料不进仓库） |
| `build.mjs` | esbuild 多插件构建，**检查宿主包泄漏** |

### 测试：372 个，全通过

| 文件 | 数量 | 测什么 |
|---|---|---|
| `rcs-core/test/rule-source` | 20 | 规则数据源与检索，对真实 V0 |
| `rcs-core/test/lint-embedded` | 21 | 嵌入式规范，重点防误报 |
| `rcs-core/test/danger` | 19 | 危险度分级（涉及人身安全，覆盖最密） |
| `rcs-core/test/team-context` | 16 | 队内上下文，时间函数显式传 today |
| `rcs-ui/test/view-model` | 14 | 投影函数不得抛；污染源排名 |
| `rcs-core/test/real-project` | 11 | 对真实工程，基准是手工核查结论 |
| `dsh-rcs-rules/test` | 16 | 规则插件端到端 + 结果卡片 |
| `dsh-rcs-guard/test` | 10 | **真实 cordis** 跑 waterfall |
| `dsh-rcs-core/test` | 8 | **真实 cordis** 跑 Service 注册 |
| `dsh-rcs-control/test` | 7 | 桩 ctx 跑 apply |
| `rcs-core/test/kb-sync` | 34 | 同步、**白名单越界**、只读 scope 推荐，全用假 client |
| `rcs-core/test/kb-index` | 22 | 离线检索：坏数据不得抛、片段不得互相包含、**拉丁文查询不得误报** |
| `dsh-rcs-kb/test` | 15 | 知识库插件端到端 + 结果卡片 |
| `rcs-core/test/rule-diff` | 4 | diff 纯逻辑 |

---

## 八、还缺什么

| 项 | 需要你提供 |
|---|---|
| **M1 飞书资料库** | ✅ 已完成 |
| **M3 全部** | ✅ 已完成（协议解算 + 构建烧录） |
| PC 单元测试 | ✅ 已跑通（WSL 模式 14/14）。需队里把 `test/CMakeLists.txt` 的 `CMAKE_CXX_STANDARD` 改成 17 |
| Keil 编译器版本 | ⚠️ 工程选了没授权的 V6.24，Keil 自带的是 V6.22。切过去即可，**不是授权问题** |
| **构建/烧录工具** | Keil `UV4.exe` 路径或 EIDE 命令行；烧录器型号与 `isp_flash.py` 参数 |
| **总线 ID 映射** | 每年底盘全新，做成 `config/` 里的映射表，等实车定了再填 |
| **日志模块** | 一份真实日志样本 + 格式说明 |
| **UI 面板 / 品牌色** | RCS 品牌色（深浅两套）；`rcs-ui/src/theme.ts` 现为中性占位，**未编造** |
| **赛场清单** | `rcs_checklist` 的实际内容（检录/上场前自检/下场） |

> **提醒**：冲刺期里插件优先级低于主线。路线图里那个 CAN 缓冲区崩溃（git log `fa9056c`）如果还没修，比这里任何一条都重要。
