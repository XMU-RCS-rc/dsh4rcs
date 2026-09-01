# RCS 电控方向技术路线

> 版本：v1.0（2026-08-24）
> 依据：实测 `D:\code\RCS_code\R2`（第二十五届实战工程）与 `D:\code\RCS_code`（下赛季模板工程）
> 关联：[`dsh-rcs-plugin-design.md`](./dsh-rcs-plugin-design.md) · [`deepseek-harness-plugin-guide.md`](./deepseek-harness-plugin-guide.md)

---

## 一、现状实测：两代工程对比

| 维度 | **R2（第25届实战）** | **RCS_code（下赛季模板）** |
|---|---|---|
| 芯片 | STM32F407 | STM32F407 |
| 固件库 | **标准库（FWLIB）** | **HAL + CubeMX（.ioc）** |
| RTOS | **uCOS-II** | **FreeRTOS** |
| 语言 | 纯 C | **C / C++ 混编**（`rcs_cxx.h`，大量 `.cpp`） |
| 工程结构 | BSP / CORE / FWLIB / RCSLIB / SYSTEM / USER / uCOS-II（正点原子风格） | Core / Drivers / Middlewares / **RCS**（四层自研库）/ MDK-ARM |
| 队内库 | `RCSLIB/` **60+ 文件扁平堆放** | `RCS/` **四层分层，且是独立 git 仓库** |
| IDE | Keil 单一 | Keil + **VSCode/EIDE**（`.eide`、`.vscode` 均在） |
| 单元测试 | 无 | **有**（`RCS_Support/test` + CMake，PC 上跑） |
| 上位机 | 无 | **有**（Python CLI + RDLC 协议 + ISP 烧录脚本） |
| 版本控制 | **无 `.git`** | 模板本身无 git，但 `RCS/` 子库有完整提交历史 |
| 工程卫生 | **21 个 `.uvguix.<个人名>`、270 个 OBJ 产物入库；无 `.gitignore`** | 同样**无 `.gitignore`**；有 `.codex-backup/`、`.acl-old` 残留 |

**结论：新模板是一次彻底的架构重构，方向正确，但尚未经过实战检验。** 模板作者在 `请读我.txt` 里已明确自陈：

> “受限于时间，并未完全移植老代码中的功能……代码并未通过彻底的实战检验，仅能确保 RCS_Template 中的样例程序可以正常运行。”

技术路线的首要任务因此不是"继续加功能"，而是**把模板验证到可上车状态**。

---

## 二、新模板架构评估

### 2.1 实际分层（来自真实文件树）

```
RCS_Template_F407/
├── Core/            CubeMX 生成：main.c freertos.c stm32f4xx_it.c ...
├── Drivers/         CMSIS + STM32F4xx_HAL_Driver
├── Middlewares/     FreeRTOS
└── RCS/             ← 队内自研库（独立 git 仓库，跨赛季复用）
    ├── RCS_HAL/         外设抽象层
    │   └── rcs_adc / rcs_can / rcs_exti / rcs_gpio / rcs_os / rcs_tim / rcs_uart / rcs_cxx
    ├── RCS_Module/      执行器与传感器层
    │   ├── rcs_actor/   rcs_cylinder · rcs_motor_rm3508 · rcs_motor_gm6020 · rcs_motor_vesc
    │   ├── rcs_actor_bus        ← 执行器软总线（核心抽象）
    │   ├── rcs_gyro             ← 维特智能 HWT101CT / JY901
    │   ├── rm_motor_raw / vesc_motor_raw / rcs_soft_encoder
    ├── RCS_Support/     算法层（可在 PC 单元测试）
    │   ├── kin_chassis  4 舵轮 / 4 全向轮·麦轮 正逆运动学
    │   ├── kin_diff     差动机构解算（模板类，header-only）
    │   ├── angle_loop   角度回环（舵轮过 ±180° 最短路）
    │   ├── sync_pid     面向对象 PID（带积分分离等保护）
    │   ├── path_planning 梯形加减速 + 二维贝塞尔
    │   ├── easy_filters 低通 / 窗口均值 / 卡尔曼
    │   ├── gps          正交码盘 + 陀螺仪全场定位
    │   ├── rdlc         上下位机通信协议（CRC16/MODBUS）
    │   └── lockfree_fifo / siso_fifo
    ├── RCS_Template/    例程（学习用）
    └── user/            app_main · lower_scheduler · upctrl_fsm
```

### 2.2 三个做对了的设计（应当保留并强化）

**① 执行器软总线 `rcs_actor_bus`** —— 这是模板里最有价值的设计。

抽象基类 `rcs_actor` 强制子类实现 `excute` / `reset` / `monitor` 三个接口，单例总线用独立任务统一驱动（执行任务 5ms、监视任务 50ms），监视数据直接串口输出到 VOFA 画波形。头文件里写明了设计意图：

> “如果哪一年新加入了一个执行器，请参考其他执行器的代码编写方式，继承该类……**这是为了从制度上避免控制不连续**”

**用制度约束替代口头约定**，正是学生战队跨届传承最需要的东西。**这条必须写进强制规范。**

**② `RCS_Support` 算法层可在 PC 上单元测试** —— `test/CMakeLists.txt` + `angle_loop_test.cpp`，不依赖硬件。运动学、PID、路径规划、滤波这些最容易出错又最难在车上调试的东西，能在 PC 上验证，这是质变。

**③ RDLC 上下位机链路 + Python CLI** —— 自定义帧（帧头/长度/CRC16-MODBUS/帧尾），上位机地址 `0xA0`、下位机 `0x01`，Python 侧带 `self-test`（CRC 标准向量、分片解码、错误 CRC 拒绝、PTY 伪串口端到端），还支持 WSL + usbipd 挂载 USB 串口。**协议层先于硬件被验证**，思路专业。

### 2.3 外设预算（已定，勿随意改动）

| 外设 | 用途 |
|---|---|
| UART1 | 视觉数据 |
| UART2（PD5/PD6，115200 8N1） | 上位机 RDLC 链路 |
| UART6 | SBUS 遥控 |
| CAN | 大疆电机（RM3508/RM2006/GM6020）、VESC |

---

## 三、缺口清单（实测，非推测）

### 3.1 例程完成度：计划 18 个，实到 9 个

`请读我.txt` 规划的学习路线共 18 个例程，`RCS_Template/` 实际只有 9 个：

| step | 计划例程 | 状态 |
|---|---|---|
| 3 | `freertos_kprintf_test` | ✅ 有 |
| 3 | `uart_test` | ✅ 有 |
| 3 | `oled_test` | ❌ **缺** |
| 3 | `cylinder_bus_test` | ⚠️ 有 `cylinder_test`，名称/内容需对齐 |
| 3 | `motor_bus_test` | ⚠️ 有 `rmmotor_test` |
| 3 | **`actor_bus_test`** | ❌ **缺（核心抽象无例程，优先级最高）** |
| 3 | `pid_test` | ❌ **缺** |
| 4 | `gpio_test` | ❌ **缺** |
| 4 | `wit_gyro_test` | ✅ 有 |
| 4 | `dt35_filter_test` | ❌ **缺** |
| 4 | `orth_encoder_test` | ❌ **缺** |
| 4 | `stp23_laser_test` | ❌ **缺**（R2 里有 `stp23.c` 可移植） |
| 5 | **`chassis_test`** | ❌ **缺（`kin_chassis` 已实现却无例程）** |
| 5 | `gps_test` | ⚠️ 有 `gps_local` / `gps_proxy` |
| 6 | `diff_test` | ❌ 缺（`kin_diff.h` 已是模板类，可直接写例程） |
| 6 | `scara_test` | ❌ 缺（R2 有 `RCS_Scara` 可移植） |
| 7 | `upctrl_test` | ✅ 有 |
| 7 | `chctrl_test` | ❌ **缺** |
| — | `can_test` | ✅ 有（计划外） |

> 已核实：`kin_diff.h` 是 `template<typename TFLOAT> class diff`、`angle_loop.h` 是内联实现，**两者 header-only 属正常设计，不是缺失**。

### 3.2 HAL 层未完成项（作者自标 todo）

- `rcs_adc`：待加均值滤波获取 ADC 值
- `rcs_tim`：待拆分为**计时 / PWM 输出 / 正交编码器读取**三套面向对象接口 —— 这是 `orth_encoder_test` 的前置依赖
- `rcs_gpio`：仅为兼容老代码，作者建议直接用 HAL

### 3.3 已知硬件问题（git log 留痕，必须复现验证）

- `fa9056c` “大疆电机已经能够在有 CAN 总线缓冲区下闭环控制，但**一旦缓冲区发送超过一条报文就会死**” —— **CAN 发送缓冲区的严重缺陷，是否已修复必须先确认**
- `5ac3557` “发现 siso 缓冲区的 uart 是完全不现实的想法”

### 3.4 工程卫生

| 问题 | 位置 | 处置 |
|---|---|---|
| 无 `.gitignore` | 三个仓库全部 | **立即补** |
| 21 个 `.uvguix.<个人名>` 入库 | R2/USER | 从索引移除并忽略 |
| 270 个 OBJ 编译产物入库 | R2/OBJ | 同上 |
| `.tags`、`.tags_sorted_by_file` 入库 | R2 | 同上 |
| `.codex-backup/`、`*.acl-old`、`*.orig` 残留 | RCS_code | 清理 |
| **R2 整个赛季实战代码无版本控制** | R2 | 补建仓库并归档 |
| 工程名仍叫 `F407Practice` | R2 | 新工程勿沿用 |

---

## 四、技术路线：四个阶段

### 阶段 P0 · 模板验证与补完（起步 4~6 周，最高优先级）

**目标：把"能编译的框架"变成"敢上车的底座"。**

| # | 任务 | 交付标准 |
|---|---|---|
| P0-1 | 补 `.gitignore`，清理 R2/RCS_code 冗余文件，**给 R2 建仓归档** | 三个仓库干净，`git status` 无噪声 |
| P0-2 | **复现并定位 CAN 缓冲区多报文崩溃问题** | 写出最小复现例程 + 根因说明 + 修复；`can_test` 连发 8 帧不死 |
| P0-3 | 补 `actor_bus_test` | 电机 + 气缸同挂总线，5ms 执行 / 50ms 监视，VOFA 出波形 |
| P0-4 | 补 `pid_test`、`chassis_test` | PC 单元测试 + 实车阶跃响应对照 |
| P0-5 | 完成 `rcs_tim` 三接口拆分（计时 / PWM / 正交编码器） | 补 `orth_encoder_test`，码盘读数与实测位移误差 < 2% |
| P0-6 | `rcs_adc` 均值滤波 | 补 `gpio_test`、`dt35_filter_test` |
| P0-7 | **模板整体上车联调** | 单电机闭环 → 底盘四轮联动，跑通 |

> P0-2 是阻塞项。**CAN 是所有执行器的命脉，这个 bug 不解决，后面全是沙上建塔。**

### 阶段 P1 · 上位机链路定型（与 P0 并行，3~4 周）

见第六节的方案选型。核心交付：

- 调度方案拍板并冻结协议
- **补通信看门狗**：链路超时自动进入安全态（当前两个方案都没有）
- **补到位状态回报**：方案二 README 自己指出"函数返回值不等于机构真实到位状态"，必须用 `actor_bus` 的 monitor 通道补齐
- Python CLI 从 `self-test` 推进到**真实串口回环测试**

### 阶段 P2 · 底盘与上层机构（赛季主体）

| 方向 | 任务 |
|---|---|
| 底盘 | 舵轮/全向轮方案定型 → `kin_chassis` 参数标定 → `angle_loop` 过 ±180° 验证 → `path_planning` 轨迹跟踪 |
| 定位 | `gps`（正交码盘 + 陀螺仪）全场定位精度标定，补 `gps_test`；激光（`stp23`）辅助校正 |
| 上层 | 按当年主题写执行器类，**一律继承 `rcs_actor` 挂总线**；`upctrl_fsm` 状态机 |
| 遥控 | SBUS（UART6）通道映射与失控保护 |

### 阶段 P3 · 赛季应用与沉淀

- 赛场调参流程固化（哪些参数允许现场改、怎么改、谁批准）
- 每次调试结论入知识库（对接 dsh 插件的 M1）
- **赛季末把当年新增的通用能力回流进 `RCS/` 库**，主题相关代码留在 `user/`

---

## 五、分层依赖规范（红线，写进 CONTRIBUTING）

```
user/          ← 当年主题相关，赛季结束可丢弃
   ↓ 只能调用
RCS_Template/  ← 例程，不参与实车编译
RCS_Module/    ← 执行器、传感器（必须继承 rcs_actor）
   ↓ 只能调用
RCS_Support/   ← 纯算法，禁止依赖任何硬件与 RTOS，必须可 PC 单测
   ↓ 只能调用
RCS_HAL/       ← 外设抽象
   ↓
HAL / FreeRTOS
```

**四条强制规则：**

1. **`RCS_Support` 不得 include 任何 HAL 或 FreeRTOS 头文件** —— 这是它能被 PC 单元测试的前提，破了就全废。
2. **所有执行器必须继承 `rcs_actor` 并挂入 `rcs_actor_bus`** —— 不允许绕过总线直接控制。原文写得很清楚：这是从制度上避免控制不连续。
3. **禁止反向依赖**：`RCS_HAL` 不得引用 `RCS_Module`，`RCS_Module` 不得引用 `user/`。
4. **主题相关代码只能进 `user/`** —— `RCS/` 是跨赛季资产。R2 的教训是 `RCS-PROVINCE-COMPETITION.c`、`R2_arm.c` 这类比赛专用文件混进了公共区。

---

## 六、上位机调度方案选型（明确建议）

模板给了两套并行 demo，必须尽早拍板，否则两边都半成品。

| | **方案一：直接外设调度** | **方案二：复杂函数调度** |
|---|---|---|
| 上位机下发 | 电机转速、PWM 角度（`int16`/`uint16`） | 高层意图（`speed_x/y/angular_z` + 三角度，`float32`） |
| 下位机角色 | 哑执行器 | 保留完整控制权 |
| 反馈 | `direct_report_task` 每 50ms 周期反馈 | 函数返回后立即反馈 |
| 控制环位置 | **跨 UART 链路** | **在下位机内** |
| 改动作 | 不用重烧固件 | 要改下位机代码并重烧 |

### 建议：**方案二为主线，方案一保留为调试后门**

理由：

1. **控制环不能跨链路。** 115200 的 UART 在赛场电磁环境下不可靠，把控制环放在链路对面，一次丢包就是失控。ROBOCON 是高强度对抗，这个风险不可接受。
2. **方案一天然适合当标定/调参通道** —— 直接指定单个电机转速、单路 PWM 角度，正是标定和单元测试要的粒度。保留它，但**赛场 profile 必须禁用**。
3. 方案二的缺点（改动作要重烧）可以靠**参数化指令**缓解：把可变的做成参数，而不是每个动作一条新命令。

### 无论选哪个，这三项必须补

- **链路看门狗**：N 个周期收不到有效帧 → 自动进入安全态（速度归零、气路回安全位）。两个 demo 目前都没有。
- **到位状态回报**：用 `actor_bus` 的 monitor 通道回报真实位置，而不是拿函数返回值当到位信号。
- **序号与重传语义**：RDLC 已有 `sequence` 字段，需明确定义乱序、重复、丢失时的行为。

> 模板 README 已经写明：“**软件停止不能替代硬件急停、驱动使能线和限位保护**”。这句话应当原样写进队内规范。

---

## 七、人员能力矩阵与培养路径

模板作者已在 `请读我.txt` 给出 step1~step8 路线，建议直接采用并补上验收标准：

| 阶段 | 内容 | 验收标准（补充） |
|---|---|---|
| step1 | C 基础（指针/函数指针/变量生命周期/头文件）、面向对象概念、C++ 基础（类/命名空间/静态成员/STL）、单片机基础（三大组成、中断、GPIO/EXTI/ADC/TIM/UART/CAN/SPI/IIC） | 能独立说清"中断 vs 轮询何时用哪个"、"CAN 与 UART 的本质区别" |
| step2 | HAL 库、FreeRTOS、CubeMX | 能独立用 CubeMX 配出一个带 FreeRTOS 的新工程并点亮 LED |
| step3 | 日志调试（kprintf / uart / oled）、执行器（气缸/电机/actor_bus）、PID | **能把一个新执行器继承 `rcs_actor` 挂上总线并在 VOFA 出波形** |
| step4 | 传感器（GPIO/陀螺仪/DT35/正交编码器/STP23 激光）、滤波 | 码盘读数误差 < 2%，滤波前后波形对比可解释 |
| step5 | 底盘正逆运动学、全场定位 | **底盘按给定轨迹跑完，横向误差 < 5cm** |
| step6 | 差动机构、SCARA 机械臂运动学 | 末端定位误差满足当年机构要求 |
| step7 | ROBOCON 特色（upctrl / chctrl） | 能独立完成一个小比赛的完整控制代码 |
| step8 | 按当年需求扩展 | — |

**分工建议**：step1~step4 为电控组全员必过；step5~step6 按底盘组/机构组分流；step7 由主控负责人掌握。

---

## 八、工程规范

**立即执行**

```gitignore
# .gitignore（三个仓库通用）
*.uvguix*
*.uvoptx
OBJ/
build/
Listings/
Objects/
DebugConfig/
.tags*
*.orig
*.acl-old
.codex-backup/
__pycache__/
```

**持续执行**

| 项 | 规范 |
|---|---|
| 分支 | `main` 保护；`season/2027`、`feat/<模块>`、`fix/<问题>` |
| 提交 | 沿用 `RCS/` 已有的中文短句风格（如"完成 can 自回环验证"），**问题与结论都要写**（如"发现 siso 缓冲区的 uart 是完全不现实的想法" —— 这种负面结论极有价值） |
| 命名 | 库内统一 `rcs_` 前缀 + 小写下划线；杜绝 R2 里 `Gyro` / `RCS_CAN` / `codetab` 混用 |
| 测试 | **新增 `RCS_Support` 算法必须附 PC 单元测试**，无测试不合入 |
| 例程 | 新增 `RCS_Module` 能力必须附对应 `*_test` 例程 |
| 文档 | 保持现有 Doxygen 风格头注释（`@brief`/`@note`/`@warning`/`@changelog`），这套注释质量已经很好，要守住 |

---

## 九、R2 老代码移植清单

新模板"并未完全移植老代码功能"，以下 R2 资产值得挑出来移植：

| R2 文件 | 去向 | 备注 |
|---|---|---|
| `stp23.c` | `RCS_Module` | STP23 激光，补 `stp23_laser_test` |
| `RCS_Scara.c` | `RCS_Support` | SCARA 运动学，补 `scara_test` |
| `dm_motor_drv/ctrl.c` | `RCS_Module/rcs_actor` | **达妙电机，需重写为继承 `rcs_actor`** |
| `RCS_OLED.c` + `codetab.c` | `RCS_Module` | 补 `oled_test` |
| `RCS_DT35.c` | `RCS_Module` | 补 `dt35_filter_test` |
| `Laser_Position.c` / `Laser_Ranging.c` | `RCS_Support` | 定位算法，评估是否已被新 `gps` 覆盖 |
| `NEC_IR_RX.c`、`RCS_TB6612.c`、`Valve_2006.c` | 按需 | 当年用得上再移 |
| `RCS_LogServer.c` | 评估 | 新模板用 `rcs_kprintf`，可能已替代 |

**不要移植**：`RCS-PROVINCE-COMPETITION.c`、`R2_Upctrl.c`、`R2_arm.c`、`R2_CombCtrl.c`、`R1_UpCtrl_Motion.c` —— 主题相关，明年主题变了就作废。**可提取其中的方法论写进知识库**。

---

## 十、与 dsh 插件的衔接

现在有了真实工程结构，`dsh-rcs-plugin-design.md` 的 **M3 `dsh-rcs-control`** 可以落到具体：

| 工具 | 基于本工程的具体实现 |
|---|---|
| `rcs_lint_layer` | **新增**：检查分层依赖红线——`RCS_Support` 是否误 include HAL/FreeRTOS、执行器是否继承 `rcs_actor`、主题代码是否混进 `RCS/` |
| `rcs_bus_decode` | 解析 RM CAN（RM3508/RM2006/GM6020）与 VESC 报文，按队内 ID 映射还原 |
| `rcs_rdlc_decode` | **新增**：解析 RDLC 帧（帧头/长度/CRC16-MODBUS/帧尾）、命令与反馈载荷，复用 `rdlc.c` 的定义 |
| `rcs_kinematics_check` | 按 `kin_chassis` 的 4 舵轮编号约定（0/1/2/3、逆时针为正、X 轴为 0°）校验解算 |
| `rcs_template_gap` | **新增**：比对 `请读我.txt` 的 18 个计划例程与 `RCS_Template/` 实际文件，输出缺口清单（本文第三节就是手工版） |
| `rcs_fw_build` | 调 MDK-ARM 或 EIDE 构建，结构化返回编译错误 |
| `rcs_fw_flash` | 复用现成的 `isp_flash.py` —— **L2 危险操作，强制人工确认** |
| `rcs_actuator_spec` | 执行器参数库：RM3508/RM2006/GM6020/VESC/气缸 |

---

## 十一、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **CAN 缓冲区多报文崩溃未修复** | 所有执行器不可用，赛季直接卡死 | **列为 P0 第一阻塞项**，先复现再动其它 |
| 模板未经实战检验 | 上车后暴露大量问题，赛季中期返工 | P0 阶段强制走完"例程 → 单模块上车 → 整车联调"，不跳步 |
| 两套调度方案久拖不决 | 两边都半成品 | **P1 内必须拍板并冻结协议**（建议方案二为主） |
| 标准库/uCOS-II → HAL/FreeRTOS 迁移断层 | 老队员经验失效，新队员没人带 | 老队员优先过 step2；把 R2 的调参经验写进知识库而非代码 |
| R2 代码无版本控制 | 唯一实战资产可能丢失 | **立即建仓归档**（含 `.gitignore`） |
| `RCS/` 库无人维护 | 明年又推倒重来 | 指定 2 名维护人（一大三一大二）；新能力必须回流进库 |
| 链路失联无保护 | **机器人失控，安全事故** | P1 必须补通信看门狗 + 安全态；且软件保护不替代硬件急停 |
| 例程缺 9 个 | 新人无路可学，培养链断 | P0 优先补 `actor_bus_test`、`pid_test`、`chassis_test` 三个关键节点 |

---

## 十二、下一步（三件事）

1. **确认 CAN 缓冲区问题是否已修复**（git log `fa9056c`）。这是唯一的硬阻塞项，先做这个。
2. **拍板上位机调度方案**，冻结 RDLC 命令表，补链路看门狗。
3. **补三个关键例程**（`actor_bus_test` / `pid_test` / `chassis_test`）并建立 `.gitignore`，让新人 step3~step5 的路能走通。
