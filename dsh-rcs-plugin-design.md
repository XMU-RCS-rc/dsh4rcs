# dsh4rcs — 厦门大学机器人队（RCS）DeepSeek Harness 插件功能设计

> 文档版本：v0.5（2026-08-27）
> **范围：仅 ROBOCON 竞技赛，面向 2027 赛季（第二十六届）。RoboCup 暂缓，保留在附录 A。**
>
> **v0.5 关键变更：主题已公布 —— 「女娲补天」。** v0.4 整篇建立在"主题尚未公布、现在是基建窗口"之上，这个前提已经作废，第一节整节重写。同时 M0/M2/M3 第一梯队/guard 已实现并装入 profile，实现状态见第五节各模块标注。
>
> 配套文档：
> - [`deepseek-harness-plugin-guide.md`](./deepseek-harness-plugin-guide.md) —— 怎么写 dsh 插件
> - [`rcs-embedded-roadmap.md`](./rcs-embedded-roadmap.md) —— 电控方向技术路线（基于 `D:\code\RCS_code` 与 `D:\code\RCS_code\R2` 实测）
>
> **v0.4 变更**：赛事范围收敛为 ROBOCON 竞技赛单线；待确认项全部落实；M1 按飞书重新设计；RoboCup 相关模块移入附录 A。

---

## 〇、已确认前提

| 项 | 结论 | 来源 |
|---|---|---|
| **赛事范围** | **仅 ROBOCON 竞技赛**（不含仿生足式、机器人排球）；RoboCup 暂缓 | 队内确认 |
| **目标赛季** | **2027 年 · 第二十六届** | 队内确认 |
| **2027 主题** | **女娲补天**（规则 V0 已发布并入库；V0 为 ABU 原版翻译稿，国内赛 V1 即将发布） | 规则书 |
| **ABU 2027 主办国** | **印度尼西亚 · 梭罗** | 规则书 |
| **机器人编制** | **TR 搬运机器人**（可手动/自动）+ **BR 建筑机器人**（必须全自动） | 规则 11.1~11.3 |
| **人力** | ROBOCON 与 RoboCup **共用同一批队员** | 队内确认 |
| **代码库** | 两条线**各自独立仓库** | 队内确认 |
| **队内文档** | **飞书** | 队内确认 |
| **电控栈** | STM32F407；新模板 CubeMX + HAL + FreeRTOS + C/C++ 混编；R2 为标准库 + uCOS-II（迁移中） | 实测代码 |
| **执行器** | CAN 挂 RM3508 / RM2006 / GM6020 / VESC；R2 另有达妙电机；**使用气动** | 实测代码 |
| **底盘** | `kin_chassis` 支持 4 舵轮 + 4 全向轮/麦轮；定位为正交码盘 + 陀螺仪 | 实测代码 |
| **上下位机** | 自研 RDLC 协议（CRC16/MODBUS），UART2 115200；UART1=视觉，UART6=SBUS | 实测代码 |
| **开发环境** | Windows（Keil MDK + VSCode/EIDE）+ WSL Ubuntu 22.04（上位机 Python CLI） | 实测代码 |

**待确认项已全部清空。M0 / M2 / M3 第一梯队 / guard 已实现并装入 `rcs-dev` profile。**

---

## 一、决定性约束：主题已公布，V1 即将到来

**2027 主题：女娲补天**（第二十六届，规则 V0 于 2026 年 9 月发布）。基建窗口已经关闭，全队进入设计冲刺。

```
2026-09  主题与规则 V0 发布 ← 已发生
   │
   │   ←── 冲刺期（当前位置）：全员扑在机器人上 ──→
   │
2026 末~2027 初   国内赛规则 V1 发布（官方前言已预告）
   │
2027-06  分区赛 / 复赛
2027-07-15 前  国内决赛
2027-08  ABU Robocon 2027（印度尼西亚 · 梭罗）
```

**四条推论：**

1. **插件优先级低于主线。** 冲刺期里任何工具都不能占用电控组修 bug、上车联调的时间。这条排在最前面。
2. **`rcs_rule_diff` 的价值兑现了。** V0 是 ABU 原版翻译稿，官方前言明说「很快，将会有国内赛规则V1版发布」。V1 一到就能直接跑出改动清单——**漏看一条改动可能让整套机构返工**。
3. **规则数据已入库。** `data/rules/2027/V0/` 下有 167 条结构化条款与一份机器可校验的约束表（每条带条款号溯源）。V1 发布后用 `scripts/docx-to-rules.mjs` 转换、加个目录即可，代码不动。
4. **本届的电控硬约束已经明确**，可以直接进 `rcs_rule_check`：

| 约束 | 值 | 条款 |
|---|---|---|
| 电池标称电压 | ≤24V（串联后总电压同样受限） | 11.12 |
| 电路任意两点电压 | ≤42V | 11.13 |
| 气压 | ≤600 kPa | 11.14 |
| 整机重量 | ≤50kg（含电池、控制器、电缆） | 11.7 |
| 启动尺寸 | 700³ mm 立方体内 | 11.4 |
| 运行尺寸 | 1000×1400×1200 mm | 11.5/11.6 |
| **红色急停按钮** | 必须，清晰可见且易于触及 | 12.2 |
| TR↔BR 无线互通 | **严禁** | 11.10 |
| BR | **必须全自动** | 11.3 |

> 规则第 14 节还给出了**全部场地元素的 RGB 色值**（建塔处 `40-100-50`、传递区红 `245-170-60`、五色石 `218-165-32` 等），已存入 `constraints.json`。视觉组做颜色阈值应以此为准，不要凭肉眼调。

---

## 二、ROBOCON 的赛事特性（设计基础）

| 特性 | 对插件设计的影响 |
|---|---|
| **每年主题全换**，机械方案基本推倒重来 | 知识传承的对象是**方法论与可复用模块**，不是具体方案。M1 必须强制区分二者 |
| **规则频繁改版**（2026 年 V1.0 → V4，另有 FAQ） | M2 的核心能力是 **版本 diff**，不是检索 |
| **国内规则 + ABU 英文规则双轨** | 打进 ABU 才发现规则不一样就晚了，需要对照工具 |
| **MR（手动）+ AR（自动）并存** | 上下位机分工、遥控失控保护是电控重点 |
| **机械 + 电控可靠性 + 速度** 是胜负手 | 工具应服务于"少犯错、快定位"，而非"自动写算法" |
| **现场 retry 机制** | 赛场需要快速判断"重试还是继续" |
| **高压气动 + 大功率电机** | 物理危险操作必须有审批门 |

---

## 三、设计原则

1. **安全第一** —— 气动充压、电磁阀动作、电机使能、烧录是真实的人身与设备风险，必须挡在人工确认之后（第六节）。
2. **跨赛季资产优先** —— 主题每年重置，工具要押在「明年还能用」的东西上（规则版本追踪、分层检查、知识传承），而不是绑定当年机构。
3. **规则只检索、不生成** —— 解读错误的代价是整套方案返工，输出必须带条款号与版本号。
4. **离线可用** —— 赛场网络不可靠，飞书 API 也不可靠，关键数据必须本地镜像。
5. **约定变成检查** —— 新模板的分层与执行器总线约定，靠工具守，不靠自觉。
6. **插件本身要防断代** —— 必须有文档、有 CI、有交接人。
7. **不与主线抢人** —— 插件是辅助工程，优先级低于修 CAN bug 和模板上车。

---

## 四、总体架构

```
                  ┌──────────────────────────────┐
                  │   dsh-rcs-core (Service)      │
                  │  ctx.rcs：赛季 / 机器人角色 /  │
                  │  工程层次识别                  │
                  └──────────────┬───────────────┘
                                 │ inject: ['rcs']
   ┌────────────┬────────────────┼────────────────┬────────────┐
   │            │                │                │            │
┌──▼─────┐ ┌────▼─────┐ ┌────────▼──────┐ ┌───────▼───┐ ┌──────▼────┐
│ M1 知识 │ │ M2 规则   │ │ M3 电控与     │ │ M4 日志   │ │ M5 赛场   │
│ 传承    │ │ 版本追踪  │ │ 运动控制      │ │ 与复盘    │ │ 模式      │
│ (飞书)  │ │ (2027)   │ │ (三梯队)      │ │           │ │ (只读)    │
└─────────┘ └──────────┘ └───────────────┘ └───────────┘ └───────────┘
   ┌──────────────┬──────────────────────────────┐
   │  M6 新人培养  │  M7 项目协作                  │
   └──────────────┴──────────────────────────────┘
                  ┌──────────────────────────────┐
                  │  dsh-rcs-guard（横切安全层）   │
                  │  tools/pre-execute 三级审批    │
                  └──────────────────────────────┘
```

对应 dsh 原语：

| RCS 概念 | dsh 实现 |
|---|---|
| 队内上下文（赛季 / 角色 / 工程层次） | **Service**（类式插件，`super(ctx, 'rcs')`） |
| 各类查询、构建、解析能力 | **Tool**（`defineTool` + `ctx.tools.register`） |
| 危险操作拦截（气动 / 上电 / 烧录） | **`tools/pre-execute`（**waterfall**，非 bail）+ `ctx.tools.guard()`** |
| 排障过程自动入库 | 监听 **`session/event` / `tools/result`** |
| 开发态 / 赛场态 / 新人态 | 不同 **profile** |
| 串口 / 调试器 / 飞书连接 | **`ctx.effect()`** 管理，卸载即释放 |

---

## 五、功能模块清单

### M0 · `dsh-rcs-core` —— 队内上下文服务【P0 · ✅ 已实现】

不直接面向用户，为其它模块提供共享上下文。**类式插件**，对外暴露 `ctx.rcs`。

- 识别机器人角色：**TR（搬运，可手动/自动）/ BR（建筑，必须全自动）**，含区域限制与携带上限
- **识别工程层次**（按真实模板结构）：`rcs_hal` / `rcs_module` / `rcs_support` / `rcs_template` / `user`
  —— 这是 M3 分层检查的基础：知道文件在哪一层，才能判断它能 include 什么
- 赛季与关键节点（主题发布 → 设计定版 → 联调 → 分区赛 → 决赛 → ABU）

```yaml
config:
  team: RCS
  season: '2027'
  event: '第二十六届 ROBOCON 竞技赛'
  theme: '女娲补天'                    # 已公布
  rules:
    root: 'D:/code/dsh4rcs/data/rules'
    currentVersion: 'V0'               # V1 发布后改这里
    abuHost: 'Indonesia (Solo)'
  firmware:
    repo: 'D:/code/RCS_code'
    template: 'template/RCS_Template_F407'
    mcu: stm32f407
    framework: hal                     # hal | stdperiph(R2 遗留)
    rtos: freertos                     # freertos | ucosii(R2 遗留)
    lang: cxx
    layers: [RCS_HAL, RCS_Module, RCS_Support, RCS_Template, user]
  legacy:
    repo: 'D:/code/RCS_code/R2'                 # 第25届实战代码，移植参考
    season: '2026'
    theme: '武林探秘'
  uart:                                # 外设预算已定，勿随意改动
    usart1: vision
    usart2: { use: host-rdlc, baud: 115200, pins: 'PD5/PD6' }
    usart6: sbus
  actuators: [rm3508, rm2006, gm6020, vesc, cylinder]
  chassis: agv4                        # kin_chassis：4舵轮 / 4全向轮·麦轮
  feishu:
    appId: '${FEISHU_APP_ID}'          # 走环境变量，禁止硬编码
    wikiSpaceIds: ['<知识空间ID>']
    cacheDir: 'D:/rcs/kb-cache'        # 本地镜像，赛场离线依赖它
  paths:
    rules: 'D:/rcs/data/rules'
```

---

### M1 · `dsh-rcs-kb` —— 知识传承（飞书）【P0 · ✅ 已实现并跑通】

**解决**：换届断层。学生战队第一痛点，也最容易被低估。

#### 数据源：飞书

| 工具 | 参数 | 作用 |
|---|---|---|
| `rcs_kb_sync` | `force?` | **增量同步**飞书知识库到本地镜像：按节点 `obj_edit_time` 只拉变更 |
| `rcs_kb_search` | `query`, `kind?`, `season?`, `outcome?` | 检索本地镜像（**不实时打飞书 API**） |
| `rcs_kb_add` | `title`, `content`, `tags[]`, `reusable`, `outcome` | 沉淀结论，写回飞书多维表格 |
| `rcs_kb_why` | `codePath`, `lineRange?` | “这段为什么这么写”——结合 git blame + 知识库 + 提交信息 |
| `rcs_kb_module` | `query` | 检索**可复用模块**（气动回路、轨迹规划模板、驱动器封装），跨主题复用 |

#### 飞书接入要点

- **应用类型**：企业自建应用，`app_id` + `app_secret` → `tenant_access_token`
- **用到的 API**：知识库 Wiki（空间/节点树/节点内容）、云文档 docx（块结构与纯文本）、多维表格 bitable（结构化条目读写）、消息（机器人推送，供 M2 用）
- **权限**：scope 需管理员在开发者后台审批；文档还需**把应用加为协作者**或开启知识库应用权限——**这一步经常卡住，建议第一天就去申请**
- **凭据**：`app_secret` 走环境变量，**绝不入库**
- **频控**：API 有 QPS 限制，必须增量同步 + 本地缓存，不要每次检索都打 API

> **本地镜像是硬要求，不是优化。** 赛场网络差、飞书可能不可达，检索必须能离线跑。同步与检索必须解耦。

#### 三条关键设计

1. **区分"方法论"与"当年方案"。** ROBOCON 每年主题重置，`reusable: true/false` 是必填字段。检索时对 `reusable: false` 的历史方案降权——它们是背景，不是答案。

2. **负面结论必须入库，且与正面结论等价。** `RCS/` 仓库提交历史里有极高价值的负面记录——“发现 siso 缓冲区的 uart 是完全不现实的想法”“大疆电机一旦缓冲区发送超过一条报文就会死”。这类“此路不通”最容易随人离队蒸发，后来者原样再踩一遍。故 `rcs_kb_add` 设 `outcome: worked | failed | partial`，`rcs_kb_search` 默认把 `failed` 一并召回。

3. **承接 R2 → 新模板的移植知识。** 老工程 `RCSLIB/` 有 60+ 模块，新模板“并未完全移植”。移植清单见[路线图第九节](./rcs-embedded-roadmap.md)，应作为首批入库内容——**这批知识保质期只有一届**，老队员还在时不录，明年就查不到了。

**自动沉淀**：监听 `tools/result` 与 `session/event`，排障会话成功收敛时提示入库。

---

### M2 · `dsh-rcs-rules` —— 规则版本追踪【P0 · ✅ 已实现】

**核心能力是 diff，不是检索。**

| 工具 | 参数 | 作用 |
|---|---|---|
| **`rcs_rule_diff`** | `versionA`, `versionB` | **核心工具**：对比规则版本改动，输出新增/删除/修改条款 |
| `rcs_rule_lookup` | `query`, `version?` | 检索条文，**返回条款号 + 版本号 + 原文**，不允许模型自由发挥 |
| `rcs_rule_check` | `designDescription` | 拿设计描述比对规则，列出可能违规点（尺寸/重量/**气压**/电压/自主性/机器人数量） |
| `rcs_rule_faq` | `query` | 检索官方 FAQ 与答疑 |
| `rcs_rule_intl` | `query` | **对照国内规则与 ABU 英文 Rulebook 差异**（2027 由印尼出题） |
| `rcs_rule_watch` | — | 监测官网规则页更新，**发现新版自动跑 diff 并经飞书机器人推群** |

#### 主题公布前 vs 公布后

| 时期 | `rcs_rule_diff` 的用法 |
|---|---|
| **现在（主题未公布）** | 用 2026 年 V1.0→V4 做**开发与验证素材**，把工具打磨到可用 |
| **主题公布当天** | 立即对 2026 与 2027 做**赛制层面**对比：场地、机器人数量、retry 机制、得分逻辑有何结构性变化 |
| **赛季中** | 追踪 2027 自身的版本迭代（大概率同样会出到 V3、V4） |
| **进 ABU 后** | `rcs_rule_intl` 对照印尼方英文 Rulebook |

**数据目录**（主题公布后只加目录，不改代码）：

```
data/rules/
├── 2026/{V1.0,V2,V3,V4}/      # 历史，开发素材
├── 2026/abu-hk/
└── 2027/                       # 主题公布后填入
```

---

### M3 · `dsh-rcs-control` —— 电控与运动控制【一、二、三梯队 ✅ 均已实现】

> 已按 `D:\code\RCS_code` 真实结构设计。技术栈无待确认项。

#### 第一梯队：守护架构【P0，零硬件依赖】

新模板的四层分层与执行器软总线是**跨赛季资产**，但目前只靠 `请读我.txt` 的口头约定维持。R2 的教训是约定挡不住 deadline——`RCS-PROVINCE-COMPETITION.c`、`R2_arm.c` 这类主题代码最终混进了公共库。**把约定变成工具检查，是插件能给电控组的最大价值。**

| 工具 | 危险度 | 作用 |
|---|---|---|
| **`rcs_lint_layer`** | L0 | **分层红线检查**：① `RCS_Support` 是否误 include HAL/FreeRTOS（破了就无法 PC 单测）② 执行器是否继承 `rcs_actor` 并挂入 `rcs_actor_bus`（绕过总线＝控制不连续）③ 主题代码是否混进 `RCS/`（应只在 `user/`）④ 是否存在反向依赖 |
| **`rcs_template_gap`** | L0 | 比对 `请读我.txt` 的 18 个计划例程与 `RCS_Template/` 实际文件，输出缺口与 step 断点（**当前实到 9 个**） |
| `rcs_repo_hygiene` | L0 | 检查 `.gitignore` 缺失、`*.uvguix.<个人名>` / `OBJ/` / `.tags` / `*.orig` / `.codex-backup/` 入库（R2 现有 21 个 uvguix + 270 个 OBJ） |

#### 第二梯队：协议与解算【P1】

| 工具 | 危险度 | 作用 |
|---|---|---|
| `rcs_rdlc_decode` | L0 | 解析 RDLC 帧：帧头 / 长度 / **CRC16-MODBUS** / 帧尾，命令载荷（`0x10`+sequence+module+operation）与反馈载荷（`0x90`+status+echo+report）。定义复用 `RCS_Support/src/rdlc.c`，**勿另起一套** |
| `rcs_bus_decode` | L0 | 解析 CAN 报文：RM3508 / RM2006 / GM6020 反馈帧、VESC 报文，按队内 ID 映射还原成“几号电机、什么状态” |
| `rcs_kinematics_check` | L0 | 按 `kin_chassis` **真实约定**校验：4 舵轮编号 0/1/2/3、X 轴为 0°、逆时针为正、含重心修正 `bias_x/bias_y`；另覆盖 4 全向轮/麦轮 |
| `rcs_angle_loop_check` | L0 | 舵轮过 ±180° 最短路检查——`angle_loop` 的典型错误是规范化与实现方向搞反，机器人会在边界卡住 |
| `rcs_traj_check` | L0 | `path_planning` 检查：梯形加减速与二维贝塞尔的速度/加速度连续性、是否超出电机能力 |
| `rcs_actuator_spec` | L0 | 执行器速查：RM3508/RM2006/GM6020 减速比与额定扭矩、VESC 参数、**气缸缸径与推力**、电磁阀型号 |
| `rcs_pid_advise` | L0 | 读 VOFA 波形/日志给 PID 整定方向建议（**只建议，不自动写参数**）。可引用 `sync_pid.h` 已调好的默认参数宏作起点 |

#### 第三梯队：构建与烧录【P1】

| 工具 | 危险度 | 作用 |
|---|---|---|
| `rcs_fw_build` | L1 | 调 MDK-ARM 或 VSCode/EIDE 构建，**编译错误结构化返回**（文件:行:原因） |
| `rcs_support_test` | L1 | 跑 `RCS_Support/test` 的 PC 单元测试（CMake），**不需要硬件**——CI 的核心 |
| `rcs_fw_flash` | **L2** | **复用现成的 `upper_host_cli/swd_flash.py`**（pyocd，target `stm32f407vgtx`），勿重造 —— 强制人工确认 |
| `rcs_lint_embedded` | L0 | 嵌入式规范检查：中断内禁 `printf`/`malloc`、`volatile` 漏加、临界区、DMA 对齐、看门狗、**急停回路是否可被软件旁路** |
| `rcs_pneumatic_check` | L0 | **气动回路检查**：气压是否超规则上限、气缸推力是否够、**电磁阀失电状态是否安全** |

**关键设计**

- **`rcs_lint_layer` 与 `rcs_template_gap` 是本模块的支点**，且完全不需要硬件，与 M0/M1/M2 一同放进 P0。路线图第三、五节就是这两个工具的手工版输出。
- **一切协议定义以下位机源码为单一真相**：`rdlc.c`、`kin_chassis.h`、`sync_pid.h` 是权威，插件只读取、不复制。协议在两处维护必然发散。
- 模板 README 原话应写进工具描述：**“软件停止不能替代硬件急停、驱动使能线和限位保护”**。
- 硬件连接类工具一律 `ctx.effect()` 注册，避免 HMR 后串口/调试器被占用。

---

### M4 · `dsh-rcs-log` —— 日志与赛后复盘【P1 · ⏸ 待日志样本】

| 工具 | 作用 |
|---|---|
| `rcs_log_parse` | 解析机器人日志（二进制 / CSV / VOFA 波形）成结构化时间线 |
| `rcs_log_anomaly` | 自动标记异常：CAN 掉线、控制周期抖动、定位跳变、**每一次 retry** |
| `rcs_postmortem_draft` | 生成复盘草稿（现象 → 定位 → 根因 → 改进项 → 责任人） |

**关键设计**：复盘草稿**直接写进 M1 知识库（飞书）**形成闭环——这场比赛的教训，明年的新人搜得到。这是把比赛数据转成队史资产的关键一环。

---

### M5 · `dsh-rcs-field` —— 赛场模式【P2，赛前必须就绪 · guard 的 field 模式已就绪】

| 工具 | 作用 |
|---|---|
| `rcs_checklist` | 分阶段清单：检录 / 启动区就位 / 上场前自检 / 下场检查 |
| `rcs_quickref` | 极简速查（规则条款、接线、参数），**短输出、低延迟、不展开长推理** |
| `rcs_retry_advise` | 根据当前局面与规则中的 retry 代价，给“重试还是继续”的判断依据 |
| `rcs_incident` | 现场问题快速记录，赛后自动汇总进复盘 |

**关键设计（红线）**

- **`rcs-field` profile 下 `ctx.tools.guard()` 全局禁掉所有 L1/L2 工具**——赛场上 Agent 只能查，不能改、不能烧录、不能动气路。
- **完全离线**：规则、清单、知识库镜像全部本地文件，**不依赖飞书 API**。
- 可配合社区插件 `dsh-tier-router`，赛场用小模型/本地模型降低延迟。

---

### M6 · `dsh-rcs-onboard` —— 新人培养【P2】

| 工具 | 作用 |
|---|---|
| `rcs_learning_path` | 按岗位（机械 / 电控 / 软件）生成路径，**直接对接模板作者已写好的 step1~step8** |
| `rcs_task_next` | 分配下一个训练任务：点灯 → PWM → 编码器 → 单电机闭环 → actor_bus → 底盘运动学 → 轨迹跟踪 |
| `rcs_quiz` | 出题检验，错题回链知识库 |
| `rcs_explain_code` | 用**队内术语与历史背景**讲解祖传代码（依赖 M1） |

> 训练任务要**有验收标准**（如“底盘按给定轨迹跑完，横向误差 < 5cm”）。这个模块直接减轻老队员重复答疑负担，是他们愿意维护这套插件的动力来源。
>
> **时机**：招新与培训通常在赛季初，M6 现在做已经晚了半拍；但 step1~step8 的路径已写在 `请读我.txt` 里，工具化成本很低，随时可补。

---

### M7 · `dsh-rcs-ops` —— 项目协作【P2】

| 工具 | 作用 |
|---|---|
| `rcs_branch_check` | 分支模型规范（如 `season/2027`、`feat/*`、`fix/*`） |
| `rcs_review` | 按队内规范做代码评审（结合 M3 的分层与嵌入式检查） |
| `rcs_countdown` | 里程碑倒计时：主题发布 → 机械定版 → 电控联调 → 校内测试 → 分区赛 → 决赛 → ABU |
| `rcs_feishu_push` | 关键事件推送到飞书群（规则改版 diff、CI 失败、里程碑临近） |

> 可先直接用社区插件 `dsh-github-connector`、`dsh-agent-teams`，不必自己造。

---

## 六、安全与权限设计（红线）

机器人战队与普通软件项目最大的区别：**Agent 的一个错误动作可能伤人、损机。** ROBOCON 的危险源集中在**高压气动**（气罐、电磁阀、气缸突然动作）与大功率电机、机构夹持。

### 三级危险度

| 级别 | 定义 | 例子 | 策略 |
|---|---|---|---|
| **L0 只读** | 不改变任何状态 | 查规则、查知识库、解析日志、运动学校验、分层检查 | 自动放行 |
| **L1 本地写** | 只影响本机文件 | 改代码、生成配置、构建固件、跑 PC 单测 | 常规审批 |
| **L2 物理动作** | 影响真实硬件 | 烧录、电机使能、**气路充压/电磁阀动作**、总线下发控制指令 | **强制二次人工确认；`rcs-field` 下直接拒绝** |

### 实现

权限逻辑**不写进工具内部**，走钩子：

```typescript
// packages/dsh-rcs-guard/src/index.ts —— 与真实实现一致
//
// 注意三处与早期文档示例不同的 API（已对照 dsh-tools@0.1.0-rc.6 的 .d.ts 核实）：
//   1. tools/pre-execute 是 **waterfall**，签名 (exec, next) => Promise<PreToolDecision>
//   2. PreToolDecision 是**对象**：{kind:'allow'} | {kind:'deny',reason} | {kind:'ask',reason?}
//   3. ToolGuard 返回**拒绝原因字符串**（undefined 表示不干预），不是布尔
ctx.on('tools/pre-execute', async (exec, next) => {
  const d = decide(exec.name, guardConfig)
  // 不干预时必须 await next() 把决定权交下去 ——
  // 直接 return {kind:'allow'} 会短路掉其它插件的审批，那是错的
  if (d.kind === 'allow') return next()
  return d
})

// 赛场模式的单调拒绝：在 pre-execute 之后，任何插件都绕不过
if (config.mode === 'field') {
  ctx.tools.guard((exec) => fieldGuard(exec.name, guardConfig))
}
```

### 其它安全要求

- **气动是首要风险**：涉及充压与阀动作的工具默认 L2，工具描述必须写明“执行前确认周围无人、机构行程内无手”。
- **凭据不外泄**：飞书 `app_secret`、标定参数走环境变量与本地配置，**绝不入库、不随上下文外发**。
- **第三方插件先扫描**：装社区插件前先过 `dsh-poison-guard`。
- **审计留痕**：dsh 的 append-only 会话日志天然满足，赛后可追溯 Agent 做过什么。

---

## 七、Profile 设计

| Profile | 使用者 | 组成 bundle | 特点 |
|---|---|---|---|
| `rcs-dev` | 电控/软件组日常 | core + guard + kb + rules + control + log + ops | 全功能，L2 需确认 |
| `rcs-field` | 赛场 | core + guard(field) + rules + field + log | **只读 + 完全离线** |
| `rcs-newbie` | 新队员 | core + guard + kb + rules + onboard | 无危险工具，重引导 |

```bash
dsh plugin --profile rcs-field add dsh-rcs-core dsh-rcs-guard dsh-rcs-rules dsh-rcs-field
dsh --profile rcs-field --dump-config     # 上场前务必验证生效配置
```

---

## 八、仓库结构

```
dsh4rcs/
├── README.md
├── deepseek-harness-plugin-guide.md
├── dsh-rcs-plugin-design.md              # 本文
├── rcs-embedded-roadmap.md
├── pnpm-workspace.yaml
├── packages/
│   ├── dsh-rcs-core/
│   │   ├── src/index.ts
│   │   ├── cordis.patch.yml
│   │   └── package.json                  # 含 dsh.bundle 声明
│   ├── dsh-rcs-guard/
│   ├── dsh-rcs-kb/                       # 含飞书同步
│   ├── dsh-rcs-rules/
│   ├── dsh-rcs-control/
│   ├── dsh-rcs-log/
│   ├── dsh-rcs-field/
│   ├── dsh-rcs-onboard/
│   └── dsh-rcs-ops/
├── data/
│   ├── rules/2026/{V1.0,V2,V3,V4}/       # 开发素材
│   ├── rules/2027/                       # 主题公布后填入
│   ├── specs/                            # 执行器、气动元件参数
│   └── checklists/
└── docs/
    ├── CONTRIBUTING.md                   # 防断代：怎么加一个新工具
    └── HANDOVER.md                       # 交接文档
```

**分发**：队内私有，优先 **tarball 或私有 npm registry**（零授权安装）。

---

## 九、路线图（对齐赛季节奏）

| 阶段 | 模块 | 状态 |
|---|---|---|
| **已完成** | M0 core、M2 rules（diff/lookup/check）、M3 第一梯队 + `rcs_lint_embedded`、guard 安全层 | ✅ 全部装入 `rcs-dev` profile，146 个测试通过 |
| **待外部输入** | M1 kb（飞书授权）、M3 第二三梯队（工具链/实车信息）、M4 log（日志样本）、UI 面板（品牌色） | ⏸ 见第十二节 |
| **赛前必做** | M5 field 的清单与速查内容 | 赛场只读模式的 guard 已就绪，缺的是清单数据 |
| **可随时做** | M6 onboard（step1~step8 已在 `请读我.txt`）、M7 ops | 不阻塞 |

**V1 规则一发布就该做的第一件事**：

```bash
node scripts/docx-to-rules.mjs <V1规则书.docx> 2027 V1
npm run dsh:start          # 然后让 Agent 跑 rcs_rule_diff V0 V1
```

改动清单出来后，人工核对涉及机械/电控的条款，再决定要不要改方案。

---

## 十、验收指标

| 指标 | 基线 | 目标 |
|---|---|---|
| 规则改版后全队知晓改动的时间 | 口口相传，常有人漏 | **< 1 天，且有书面 diff 推到飞书群** |
| 规则相关的设计返工次数 | 现状 Y 次/赛季 | 减少 50% |
| 知识库检索命中率 | — | > 60% |
| 飞书知识同步覆盖率 | — | 历年文档 + 复盘 100% 入镜像 |
| 分层红线违规数（`rcs_lint_layer`） | 未知 | 赛季结束时 **归零** |
| 例程完成度 | **9 / 18** | 主题公布前达到 **15 / 18** |
| 新人独立完成首个里程碑任务耗时 | 现状 X 周 | 缩短 30% |
| **L2 工具误触发次数** | — | **必须为 0** |

---

## 十一、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **冲刺期抢占主线人力** | 插件挤掉修 bug 与上车联调的时间 | 已实现部分不需再投入；未实现部分全部卡在外部输入，天然不占人力 |
| **V1 规则大改** | 已定方案返工 | `rcs_rule_diff` 已就绪，V1 一到立刻出改动清单，把发现时间从「口口相传」压到一天内 |
| **CAN 缓冲区多报文崩溃**（git log `fa9056c`） | 电控线硬阻塞，全线卡死 | 见路线图 P0-2，先复现再动其它。插件侧解决不了，但 M1 须记录排查过程 |
| **飞书权限申请卡住** | M1 无数据源，最高优先模块停摆 | **第一天就去申请 scope 与文档协作者权限**；同时准备导出 → 本地镜像的降级路径 |
| **下赛季模板未经实战检验**（作者自陈） | 上车后集中暴露问题 | `rcs_template_gap` 持续暴露缺口；`rcs_support_test` 进 CI |
| **分层约定只靠口头维持** | 主题代码混进公共库，重蹈 R2 覆辙 | `rcs_lint_layer` 放进 P0，把约定变成检查 |
| **R2 赛季实战代码无版本控制** | 唯一实战资产可能丢失 | 立即建仓归档；`rcs_repo_hygiene` 查 `.gitignore` |
| **2027 主题可能大改赛制** | 部分工具假设失效 | P0 只做主题无关模块；M2 数据目录与代码解耦 |
| **气动物理事故** | 伤人、损机 | 三级权限 + `guard()` + 赛场只读 + 失电安全态检查；软件保护不替代硬件急停 |
| **插件本身断代** | 明年又成祖传代码 | `CONTRIBUTING.md` + `HANDOVER.md`；每模块 2 名维护人（一大三一大二） |
| **API 成本** | 队费有限 | `dsh-cost-meter` 监控；`dsh-tier-router` 分层 |
| **dsh 处于 preview，API 变动** | 插件被破坏 | 锁定 dsh 版本；写集成测试 |

---

## 十二、下一步（2026-08-29 实测校正）

### 已经能用的 —— 20 个工具

`npm run dsh:start` 启动 `rcs-dev` profile：

| 模块 | 工具 |
|---|---|
| M0 上下文 | `rcs_team_context` |
| M1 知识库 | `rcs_kb_search`（离线）· `rcs_kb_status` · `rcs_kb_sync` |
| M2 规则 | `rcs_rule_lookup` · `rcs_rule_diff` · `rcs_rule_check` · `rcs_rule_import` · `rcs_rule_versions` |
| M3 一梯队 | `rcs_lint_layer` · `rcs_lint_embedded` · `rcs_template_gap` · `rcs_repo_hygiene` |
| M3 二梯队 | `rcs_rdlc_decode` · `rcs_angle_loop_check` · `rcs_kinematics_check` |
| M3 三梯队 | `rcs_toolchain_status` · `rcs_support_test`(L1) · `rcs_fw_build`(L1) · `rcs_fw_flash`(L2) |

危险操作由 `rcs-guard` 统一管控。值得记一笔：这三个 L1/L2 工具**在实现之前
就已登记在危险清单里**，落地当天就自动受管控 —— 实测 dev 模式烧录需人工确认、
赛场模式三者全部硬拒，**分级代码一行没改**。

### 二梯队查出的真问题

工具不是摆设。首次对 `demo/RCS/RCS_Support` 与 `template/RCS_Template_F407`
（明年要用的模板）运行，查出三处：

1. **`kin_chassis.cpp:153` 弧度/角度单位错配。** `inv_kin` 的 `atan2f` 输出弧度，
   却直接进了角度制的 `angle_loop`。`fmod(x,360)` 对 |x|≤π 是恒等变换、
   `round(diff/360)` 恒为 0 —— **`find_nearest` 整体退化为空操作**。
   实测：目标 3.0 rad、当前 -3.0 rad，应走 0.28 rad（16°），实际走 6.0 rad（344°）。
   这正是该函数注释里承诺要防止的「轮子擦地卡死」。
2. **`kin_chassis.cpp:168` 返回未初始化的栈内存。** `rcs_omni4::inv_kin`
   算了中间量却没写进返回值，用全向轮/麦轮底盘会拿到随机数。
3. **`kin_chassis.cpp:148` 优先级混用。** `a || b || c && d`，2 号轮单独越界不报警。

前两条都是**沉默失败**：编译通过、运行不报错，只在赛场上表现为「今天车有点怪」。

### 还缺的

#### 一、两个环境阻塞（工具已就绪，卡在机器上）

| 阻塞 | 影响 | 怎么解 |
|---|---|---|
| ~~本机没有 cmake~~ | ✅ 已装好，测试已跑通（WSL 14/14） | 队内 gtest 静态库是 Linux ELF，须在 WSL 内构建：`sudo apt update && sudo apt install -y cmake build-essential`。**`apt update` 不能省** —— 全新实例包列表为空，直接 install 会报「Unable to locate package cmake」，看着像没网，其实只是没拉过索引 |
| **Keil license 未激活** | `rcs_fw_build` 实测失败于 `armclang: No license checking back-end` | uVision → File → License Management。**这不是代码问题**，工具已能自动如此定性 |

#### 二、等实物/实测数据（接口已留）

| 项 | 接口位置 | 等什么 |
|---|---|---|
| 总线 ID 映射 | `config/bus-map.json` + `loadBusMap()` 带校验加载器 | 实车定版。**空表时明确拒绝解读**，不拿编造的映射去解报文 |
| 日志三件套 | `vehicle-contract.ts` 的 `LogRecord` / `parseRobotLog` | 一份真实日志样本 + 格式说明 |
| PID 建议 | `vehicle-contract.ts` 的 `advisePid` | 一份带调参过程的 VOFA 波形 |

> 这三个都**故意抛错而不返回空结果** —— 未配置时假装能用，比功能缺失危险得多。

#### 三、等队里决定

赛场清单内容、RCS 品牌色（UI Tier 2 面板）、飞书共享范围收紧。

#### 四、结构性前提不成立

- **`D:/code/RCS_code` 不是 git 仓库。** `rcs_branch_check` / `rcs_review` 前提不成立，
  `rcs_repo_hygiene` 也只剩一半价值。要么先 `git init`，要么这两个工具不做。
- **`rcs_feishu_push` 需要 `im:message` 写权限。** 本套工具至今全程只读，
  加第一个写权限该是队里明确决定的事。

### 一个提醒

**冲刺期里插件的优先级低于主线。** 路线图里那个 CAN 缓冲区崩溃（git log `fa9056c`：
「一旦缓冲区发送超过一条报文就会死」）如果还没修，那件事比这里任何一条都重要。

顺带一提：队内文档 `03 RCSLIB参考手册` 里已经写了成因与土办法
（「STM32F4 只有 3 个发送邮箱……超过 3 条报文，delay_ms(1) 之后再发」），
现在 `rcs_kb_search` 查「缓冲区」就能直接调出来。

---

## 附录 A · RoboCup（暂缓）

队内已确认 **先不考虑 RoboCup**，相关模块从主线移出。此处保留结论，供恢复时直接接续。

### 恢复时的两条既定约束

1. **共用队员** —— 与 ROBOCON 是同一批人。这意味着**人力是同一个池子，两线不能同时高强度推进**；也意味着**知识库应当共用一套**（M1 不拆），只在条目上打赛事线标签。
2. **代码库独立** —— 两条线各自仓库。故 M3（ROBOCON 电控）与未来的 RoboCup 自主模块**互不依赖**，分层检查、构建、CI 各走各的。

### 恢复时需先回答的阻塞项

**打哪个 league？** 不同 league 技术栈几乎不重叠，不确认就无法设计：

- **HSL（人形足球）** —— 2026 年由 Humanoid League 与 SPL 合并而成，首次举办于仁川；规则处于 v0.1 持续修订
- **@Home（家庭服务）** —— 2026 年首次引入足式人形，允许安全吊架；Rulebook 已出 2027 版
- **SSL（小型组）** —— **2027 年仍办，2028 年起不再作为主要赛事**，若选此线需同步规划转型
- MSL / Rescue / Simulation

### 恢复时可复用的部分

| 模块 | 可复用度 |
|---|---|
| M0 core / M1 kb / guard / M7 ops | **直接复用**，加赛事线标签即可 |
| M2 rules | **框架复用**，换数据源（各 league 英文 rulebook） |
| M4 log / M5 field / M6 onboard | 框架复用，内容重写 |
| M3 control | **不复用**——RoboCup 侧需要另建 ROS2 / SLAM / 仿真方向的模块 |

> RoboCup 侧的完整模块设计（ROS2 体检、TF 检查、步态/场地定位、语音与抓取、仿真回归等）见本文档 v0.3 版本历史。
