# dsh4rcs 功能清单

> 更新：2026-08-29 · 5 个插件 · 20 个工具 · 377 个测试全通过
> 使用方法见 [`USAGE.md`](./USAGE.md) · 设计背景见 [`dsh-rcs-plugin-design.md`](./dsh-rcs-plugin-design.md)

---

## 一、跨赛季设计（本轮重点）

ROBOCON 每年换主题、赛季内还反复改版。整套插件按**多赛季复用**设计，换赛季只做两件事：

```
1. 导入新规则书          → rcs_rule_import 或 scripts/docx-to-rules.mjs
2. 填 constraints.json   → 人工，导入时已生成带条款线索的骨架
```

代码一行不用改。

### 三条支撑这一点的设计

**赛季不写死在代码里。** `config/team.json` 是唯一真相，经 `dsh-rcs-core` 的 `ctx.rcs` 分发给其它插件。规则插件的 `season` / `constraintsVersion` 默认值**刻意留空**——写死某一年，第二年就会有人忘了改而拿旧规则做判断，那比直接报错危险得多。三处（工具参数 / core / 插件配置）都没有时明确报错。

**规则数据按 `<赛季>/<版本>` 分目录。** 加一个版本就是加一个目录，`rcs_rule_diff` 能对比任意两个版本，跨赛季也行。

**约束表不做自动提取。** 数值约束（电压/气压/重量上限）由人填写并核对。让正则去猜"哪个数字是上限"太危险——规则解读错了代价是整套方案返工。导入时生成骨架，把"该填哪些字段、每个字段去哪条条款找"固化下来，但**判断留给人**。未填完时 `rcs_rule_check` 直接拒绝运行，而不是拿 `null` 去比较。

---

## 二、20 个工具

### 规则（`dsh-rcs-rules`，5 个）

| 工具 | 参数 | 作用 |
|---|---|---|
| **`rcs_rule_import`** | `docxPath`✱ `season`✱ `version`✱ `overwrite` | **导入新规则书** —— 跨赛季入口。落库 + 归档原件 + 生成约束表骨架。默认不覆盖已有版本 |
| **`rcs_rule_versions`** | — | 列出规则库现有的赛季与版本 |
| `rcs_rule_diff` | `fromVersion`✱ `toVersion`✱ `season` | 版本对比，列出新增/删除/修改条款 |
| `rcs_rule_lookup` | `query`✱ `season` `version` `limit` | 查条款，返回**条款号 + 版本号 + 原文** |
| `rcs_rule_check` | `design`✱ `season` `version` | 设计描述比对约束，指出疑似违规，每条带条款号 |

### 工程检查（`dsh-rcs-control`，4 个）

| 工具 | 参数 | 作用 |
|---|---|---|
| `rcs_lint_layer` | `projectRoot` | 分层红线：`RCS_Support` 是否依赖 HAL/RTOS（**含传递依赖**）、执行器是否继承 `rcs_actor`、主题代码是否混进 `RCS/` |
| `rcs_lint_embedded` | `projectRoot` `includeDirs` | 嵌入式规范：中断内禁 printf/malloc/阻塞延时、FromISR 变体、volatile、临界区、**急停回路是否可被软件旁路** |
| `rcs_template_gap` | `projectRoot` `includePairing` | 例程缺口比对 |
| `rcs_repo_hygiene` | `repoRoot` | `.gitignore` 缺失、`*.uvguix`、编译产物、编辑残留 |

### 协议与解算（`dsh-rcs-control`，3 个）

| 工具 | 参数 | 作用 |
|---|---|---|
| `rcs_rdlc_decode` | `hex`✱ | 解析 RDLC 字节流（CRC16-MODBUS）与命令/反馈载荷。坏帧报偏移+原始字节并重新同步 |
| `rcs_angle_loop_check` | `projectRoot` | 舵轮角度回环。**已在队内代码里查出弧度/角度单位错配** |
| `rcs_kinematics_check` | `projectRoot` | 底盘运动学。**已查出返回未初始化栈内存、`||`/`&&` 优先级混用** |

### 工具链（`dsh-rcs-control`，4 个）

| 工具 | 危险度 | 作用 |
|---|---|---|
| `rcs_toolchain_status` | L0 | 探测 Keil / CMake / Python / WSL，缺什么直接给安装命令 |
| `rcs_support_test` | **L1** | 跑 `RCS_Support/test` 的 PC 单元测试，**不需要硬件** —— CI 的核心 |
| `rcs_fw_build` | **L1** | Keil UV4 构建，编译错误结构化返回；能区分 license 之类的环境问题 |
| `rcs_fw_flash` | **L2** | 烧录（复用队内 `swd_flash.py`，pyOCD+SWD）。**默认只校验**，赛场一律拒绝 |

### 队内飞书资料（`dsh-rcs-kb`，3 个）

| 工具 | 参数 | 作用 |
|---|---|---|
| `rcs_kb_search` | `query`✱ `limit` | **离线**检索队内资料镜像，返回片段 + 飞书原文链接 |
| `rcs_kb_status` | — | 镜像状态：上次同步、文档数、授权范围、按类型跳过数 |
| `rcs_kb_sync` | `force` | 同步飞书资料到本地镜像。**联网 + 写盘 → L1，赛场禁止** |

也可以不启动 dsh 直接跑：`npm run kb:sync` / `npm run kb:dry`（只遍历不抓正文）。

### 队内上下文（`dsh-rcs-core`，1 个）

| 工具 | 参数 | 作用 |
|---|---|---|
| `rcs_team_context` | `robot` | 赛季、主题、规则版本、机器人角色与区域限制、固件技术栈、赛季倒计时 |

### 安全层（`dsh-rcs-guard`，无工具，横切生效）

三级危险度：**L0 只读**放行 · **L1 本机写**开发放行/赛场拒绝 · **L2 物理动作**（烧录、电机使能、气路动作、总线下发）开发需人工确认、**赛场一律拒绝**。

赛场模式另注册不可绕过的 `ctx.tools.guard()`。启动时打印生效策略——安全配置最怕"以为开了其实没开"。

✱ = 必填参数

---

## 三、四层架构

```
packages/
├── rcs-core/            纯逻辑，零 dsh 依赖 —— 所有判断都在这
├── rcs-ui/              视图模型，纯投影，零依赖
├── dsh-rcs-core/        Service 插件，提供 ctx.rcs
├── dsh-rcs-guard/       安全层
├── dsh-rcs-control/     工程检查工具
├── dsh-rcs-rules/       规则工具
└── dsh-rcs-kb/          飞书资料同步与离线检索
```

**适配层刻意做薄。** dsh 是 developer preview（本机 launcher 不锁版本，会自己漂），API 变动只打到适配层，几百行判断逻辑与 UI 投影不受影响。而且绝大部分开发与测试**根本不用启动 dsh**。

---

## 四、验证阶梯

| 级别 | 做什么 | 需要 dsh | 状态 |
|---|---|---|---|
| L0 typecheck | 对着 `dsh-tools@0.1.0-rc.6` 的 `.d.ts` 检查 | ❌ | ✅ 零错误 |
| L1 单元测试 | `vitest run` | ❌ | ✅ 377/377 |
| L2 CLI 冒烟 | `npm run check -- all <工程>` | ❌ | ✅ |
| L2.5 插件加载 | 桩 ctx / 真实 cordis 跑 `apply` | ❌ | ✅ |
| L3 dsh 加载 | `npm run dsh:patch` | ✅ | ✅ |
| L4 profile 安装 | `npm run dsh:install` → `dsh:start` | ✅ | ✅ |

**每一层都抓到了下一层抓不到的东西**（详见 `README.md`）。测试用的是真实工程与真实规则数据，不是 mock。

### 测试分布（377 个）

| 文件 | 数量 | 重点 |
|---|---|---|
| `rcs-core/test/kb-sync` | 34 | 同步、**白名单越界**、只读 scope 推荐，全用假 client |
| `rcs-core/test/lint-embedded` | 21 | 嵌入式规范，**重点防误报** |
| `rcs-core/test/rule-source` | 26 | 规则检索 + BR 全自动防误报专项 |
| `rcs-core/test/danger` | 19 | 危险度分级（涉及人身安全，覆盖最密） |
| `rcs-core/test/team-context` | 16 | 队内上下文 |
| `rcs-ui/test/view-model` | 14 | 投影函数不得抛异常 |
| `rcs-core/test/real-project` | 11 | 对真实工程，基准是手工核查结论 |
| `dsh-rcs-rules/test` | 20 | 规则插件端到端 + 结果卡片 + 跨赛季入口 |
| `dsh-rcs-guard/test` | 10 | **真实 cordis** 跑 waterfall |
| `rcs-core/test/rules-data` | 9 | **规则提取质量**回归 |
| `dsh-rcs-core/test` | 8 | **真实 cordis** 跑 Service 注册 |
| `dsh-rcs-control/test` | 7 | 桩 ctx 跑 apply |
| `rcs-core/test/kb-index` | 22 | 离线检索：坏数据不得抛、片段不得互相包含、**拉丁文查询不得误报** |
| `dsh-rcs-kb/test` | 15 | 知识库插件端到端 + 结果卡片 |
| `rcs-core/test/rule-diff` | 4 | diff 纯逻辑 |

---

## 五、RCS 专属 UI

**Tier 1 工具呈现（部分接入）** —— rc.6 的服务端会保存 `presentCall` / `presentResult`，但通用工具卡片只消费其中的搜索结果视图；自定义调用标题、图标与 generic 结果会被宿主忽略：

- findings 天然是「文件 + 行号 + 说明」，映射到 dsh 的**搜索结果卡片**，可按文件折叠与点击跳转
- 规则检索按**条款**折叠，分组名带版本号（脱离版本的条款号是危险的）
- 数据经 `presentationMeta` 落到会话日志；搜索结果卡片回放有效，其余元数据等待宿主消费
- **污染源排名**：把传递依赖链的「第一跳」聚合，回答"先修哪个文件能一次解锁最多下游文件"

**Tier 2 客户端 UI（部分接入）** —— `dsh-rcs-ui-client` 已把队徽作为可折叠的侧栏底部入口接入 `sidebar.footer.action`，点击打开团队仓库；图片以内嵌 data URL 随 bundle 分发，不依赖开发机路径。`rcs-ui/src/panel-contract.ts` 的完整工程看板仍只有数据契约与刷新策略，数据源和 React 看板待实现。

---

## 六、踩过并已修的坑（都有回归测试）

| 坑 | 后果 | 现在 |
|---|---|---|
| **规则提取漏条款** | 11.16 整条消失（文本框嵌套 `<w:p>` 导致段落截断） | 按起始标签切分，9 条回归测试 |
| 说明文字重复两遍 | `mc:Fallback` 与 `mc:Choice` 内容相同 | 剥离 Fallback |
| 正文混入图片坐标 | `020000` 把「。」和条款号隔开，分条失败 | 剥离 drawing/pict |
| 条款未独立成段 | 被并进上一条 | 行内切分，条件卡紧防误伤 |
| **BR 全自动误报** | 「BR 全自动，TR 手动遥控」这种合规描述被判违规 | 收敛到小句级，6 条专项测试 |
| **分层检查太吵** | 一个污染源炸出 11 条重复，87 条没人看 | 按第一跳聚合 → 14 条 |
| **嵌入式检查太吵** | 扫了 HAL/CMSIS，253 条 | 排除厂商目录 + 收紧规则 → 7 条 |
| **诊断用假 token 探权限** | docx 权限被报了两轮**假绿** —— 飞书先校验 token 格式再校验权限 | 改用真实文档 token 探测，没样本就报「未验证」 |
| **飞书侧无法按目录隔离** | 应用不经授权就能读到全队资料（含账号密码文档） | 范围收敛落到本地白名单 + 出网前硬断言 |
| **权限提示把读写版并列展示** | 飞书的「任选其一」候选集被原样打印，看着像两个都要开 | 只渲染只读那一个，读写版标注为不要开 |
| **片段互相包含** | 关键词密集出现时，三段摘要几乎一样 | 落在上一窗内的命中直接跳过 |
| **二元组对拉丁文查询误报** | 查 `FromISR` 命中一篇全文没有该词的 ESP32 指南（`Fr/ro/om/mI/IS/SR` 在其中凑齐了） | 二元组只对中文启用；拉丁文走精确子串 + 大小写无关 |
| **把模糊匹配说成「标题命中」** | 无片段时一律标注标题命中，等于骗读者 | 记录 `matchedIn`，如实区分标题/目录/正文/仅相关度 |
| **规则本身是错的** | 「求最短路该用 `_to_0` 而非 `_to_180`」一次喷出 15 条误报 | 验算发现两者接 normalize 后**数学等价**，队内 gtest 正是在断言这点 —— 规则删除，留注释防重犯 |
| 注释里的代码被当成代码 | R2 的 `//&& sign_back == 0)` 触发优先级告警 | 剥注释后再判断，保留行数不错位 |
| Windows 应用执行别名 | Store 版 Python 是零字节重解析点，`existsSync` 返回 false，误报「没装 Python」 | `lstatSync` 兜底 |
| Keil 工具级错误没解析到 | 退出码说有错，诊断却是 0 条 —— 输出成「失败但说不出原因」 | 补 `armclang: error:` 形态 + 无诊断时附日志末尾 |
| 构建日志写进了队内仓库 | 工具污染被检查的工程 | 日志默认落临时目录 |
| **折叠诊断行漏判严重级** | Keil 把 `In file included from` 链折叠成一行：行首是 warning、行尾才是真正的 error。只看行首 → 报「错误 0」而构建其实失败 | 取行内**最后一个**位置标记；并用「N error generated」交叉校验，对不上就把这件事本身报成错误 |
| WSL 路径没转换 | `wsl -e cmake -S D:/code/...` 报 source directory does not exist | `toWslPath` 转成 `/mnt/d/...` |
| 复用仓库里的 `build/` | 其 `CMakeCache.txt` 记的是别人机器的路径，cmake 直接拒绝 | 构建目录改到仓库外，按源路径哈希命名 |
| 只探测 Windows 侧工具链 | WSL 里装好了 cmake 却报「CMake 缺失」—— 而 PC 测试**只能**在 WSL 跑 | 增加 `probeWslToolchain`，结论改成按**能力**说而非数缺几项 |
| license 报错定性太粗 | 说「授权失效」，实际是工程选了没授权的 V6.24 | 比对 `.uvprojx` 的 `pCCUsed` 与 TOOLS.INI 注册的版本 |
| 测试依赖环境变量恰好不存在 | 配好飞书凭证后，一条"失败路径"测试真的发起联网同步，20s 超时 | 显式清空并恢复环境变量，与机器状态解耦 |
| 目录名里带斜杠 | 「硬件/软件培训知识体系」会打死按路径落盘的方案 | 正文按 token 扁平落盘，可读路径存清单 |
| Windows patch 路径 | `ERR_UNSUPPORTED_ESM_URL_SCHEME` | 必须写 `file:///D:/...` |
| `dsh` 命令不可用 | launcher 硬编码 `web`，`dsh plugin add` 失效 | `scripts/dsh.mjs` 锁版本绕开 |

> 有几个共同点值得记：**误报比漏报更伤**（天天喊狼来了的检查没人看）；**太吵等于没有**；**静默丢数据最危险**（167 条跑通了，但少了一条谁也看不出来——是逐条核对 46 个引用条款号才发现的）；**假绿比红更危险**（用假 token 探权限，两轮都报"已开通"，直到拿真文档一试才发现根本没批——检查项宁可报"未验证"，也不要报一个没验过的勾）。

---

## 七、还缺什么

| 项 | 状态 |
|---|---|
| **M1 飞书资料库** | ✅ 44 篇文档 / 369 KB 已入本地镜像，离线检索可用 |
| **M3 协议与解算** | ✅ RDLC / 角度回环 / 运动学，已查出两个真 bug |
| **M3 构建与烧录** | ✅ 已接入并实测调通 |
| **PC 单元测试** | ✅ **已跑通** —— `demo` 与 `template` 各 14/14（WSL 模式） |
| 总线 ID 映射 | ⏸ 接口已留（`config/bus-map.json` + 带校验加载器），实车定版后填表即启用 |
| 日志模块 / PID 建议 | ⏸ 契约已定，等真实日志样本与 VOFA 波形 |
| UI 面板 / 品牌色 | ⏸ 等 RCS 品牌色（深浅两套） |
| 赛场清单 | ⏸ 等队里给实际内容 |
| 飞书共享范围 | ⏸ 队里处理：收紧根目录可见性、把凭证类文档移出 |

### 已改动的队内代码（2026-08-30，改前已备份）

备份：`D:/code/RCS_code_backup_<时间戳>/`，内含 `restore.sh` 可一键还原。

| 位置 | 改动 | 效果 |
|---|---|---|
| 三处 `RCS_Support/test/CMakeLists.txt` | `CMAKE_CXX_STANDARD` 14 → **17** | PC 单元测试从**编译不过**变成 14/14 通过。三处含 `template`（明年的基线） |
| `demo/MDK-ARM/RCS_Template_F407.uvprojx` | `pArmCC` / `pCCUsed` V6.24 → **V6.22** | license 错误消失，编译器正常工作 |

### 构建暴露出的一个既有代码错误（尚未改，等确认）

```
RCS/user/host_link.cpp:89  error: non-constant-expression cannot be narrowed
                           from 'unsigned int' to 'uint8_t' in initializer list
```

**修法在队内仓库里已经存在**：一直使用 V6.22 的 `demo_function_dispatch`，同一文件同一位置已经带着 cast：

```cpp
// demo_function_dispatch（可编译）
(uint8_t)(command->source_address == 0U ? HOST_LINK_UPPER_ADDRESS
                                        : command->source_address),
// demo（报错）
command->source_address == 0U ? HOST_LINK_UPPER_ADDRESS : command->source_address,
```

这个错误**原本就在**，只是此前被 license 失败挡住从未显形 —— 属于「工具让既有问题现形」，不是改动引入的。

危险工具**在实现之前就已登记在 guard 的 L2/L1 清单里**，所以 `rcs_fw_flash` / `rcs_fw_build` / `rcs_support_test` 一落地就自动受管控 —— 实测 dev 模式下烧录需人工确认、赛场模式三者全部硬拒，**分级代码一行没改**。这正是「先定安全策略、再做功能」的收益。

> **提醒**：冲刺期里插件优先级低于主线。路线图里那个 CAN 缓冲区崩溃（git log `fa9056c`：「一旦缓冲区发送超过一条报文就会死」）如果还没修，比这里任何一条都重要。

---

## 附：工具在队内代码里查出的问题

这三条不是插件的功能演示，是**跑出来的真实结果**，都在 `demo/RCS/RCS_Support`
与 `template/RCS_Template_F407`（明年要用的模板）里同时存在。

| 位置 | 问题 | 后果 |
|---|---|---|
| `kin_chassis.cpp:153` | `inv_kin` 的 `atan2f` 输出是**弧度**，却直接进了角度制的 `angle_loop` | `fmod(x,360)` 对 \|x\|≤π 是恒等变换、`round(diff/360)` 恒为 0 —— **`find_nearest` 整体退化为空操作**。实测：目标 3.0 rad、当前 -3.0 rad，应走 0.28 rad（16°），实际走 6.0 rad（344°），正是该函数注释里承诺要防止的「轮子擦地卡死」 |
| `kin_chassis.cpp:168` | `rcs_omni4::inv_kin` 算了中间量却返回**从未赋值**的 `retval` | 用全向轮/麦轮底盘时拿到未初始化的栈内存，表现为「电机乱转」或「完全不动」，每次上电还不一样 |
| `kin_chassis.cpp:148` | `a<0 \|\| b<0 \|\| c<0 && d<0` 优先级混用 | 实际语义是 `a \|\| b \|\| (c && d)`，2 号轮单独速度越界不会报警 |

> 前两条都属于**沉默失败**：编译通过、运行不报错，只在赛场上表现为「今天车有点怪」。
> 这正是做静态检查的理由。修不修由电控组判断，工具只负责把它们摆出来。
