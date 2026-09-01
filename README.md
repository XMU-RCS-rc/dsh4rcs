# dsh4rcs

RCS 战队的 DeepSeek Harness 插件套件。当前阶段：**框架已搭好、构建就绪、36 个测试全通过；比赛相关内容与客户端面板留了接口**。

## 设计要点

**核心 / UI / 适配层三分。**

```
packages/rcs-core/          纯 TypeScript 检查逻辑，零 dsh 依赖
packages/rcs-ui/            RCS 专属 UI 的视图模型，纯投影，零依赖
packages/dsh-rcs-control/   dsh 适配层，只做 defineTool + register —— 刻意做薄
```

本机 dsh launcher 是 `npx @deepseek-ai/dsh web %*`，**不锁版本**（实测会自己漂到新版）。preview 期 API 变动只会打到薄薄的适配层，几百行检查逻辑与 UI 投影不受影响；而且绝大部分开发与测试**根本不需要启动 dsh**。

## 当前状态

### 已实现并验证

| 能力 | 说明 | 实测 |
|---|---|---|
| `layer-lint` | 分层红线：RCS_Support 是否依赖 HAL/RTOS（**含传递依赖**）、执行器是否继承 `rcs_actor`、主题代码是否混进 `RCS/` | 14 条发现 |
| `template-gap` | 18 个计划例程 vs 实际文件 | 7/18 |
| `support-pairing` | `.h` 是否有对应 `.c/.cpp` | 无误报 |
| `repo-hygiene` | `.gitignore` 缺失、`*.uvguix`、编译产物、编辑残留 | R2 有 21 个 uvguix |
| `rule-diff` | 规则版本对比的**纯逻辑** | 已实现并测试 |
| **工具呈现 UI** | `presentCall` / `presentResult` / `presentationMeta` | 已接入 |

### RCS 专属 UI

**Tier 1 · 工具呈现（已接入）** —— 任何 UI 都吃得到，无需前端代码：

- findings 天然是「文件 + 行号 + 说明」，直接映射到 dsh 的**搜索卡片**，白拿按文件折叠与点击跳转
- 数据经 `output.presentationMeta` 落到会话日志，**回放历史会话时卡片依然完整**
- **污染源排名**：把传递依赖链的「第一跳」聚合，回答"先修哪个文件能一次解锁最多下游文件"。实测把 `rcs_private_config.h` 排为首位
- 五个工程层次各有语义色；纯文本 UI 用 `TONE_MARK` 记号，黑白终端也能区分严重级别

**Tier 2 · 客户端面板（留接口）** —— `packages/rcs-ui/src/panel-contract.ts`：

工程健康分、例程完成度（按 step1~step8）、污染源排名、赛季倒计时。数据契约与刷新策略已定，React 组件待实现。契约先定的原因：Tier 1 与 Tier 2 共用同一套投影函数，不会两处各算一遍还结论不一致。

### 留了接口，待补内容

| 接口 | 位置 | 需要补什么 |
|---|---|---|
| `RuleSource` | `rcs-core/src/rule-diff.ts` | 2026 年 V1.0~V4 规则原文 + 条款解析器 |
| `RcsDashboardSource` | `rcs-ui/src/panel-contract.ts` | Node 侧快照与订阅；React 面板组件 |
| `RCS_BRAND` | `rcs-ui/src/theme.ts` | **真实品牌色**（现为中性占位，我不知道 RCS 品牌规范，没有编造） |
| `config/template-manifest.json` | 例程清单 | 随赛季调整 |
| `config/layer-rules.json` → `themeRule.patterns` | 主题代码特征 | 每赛季追加 |

两个占位实现（`UnimplementedRuleSource` / `UnimplementedDashboardSource`）都会**明确抛错**，不会静默返回空结果假装通过。

## 别人怎么装（三步）

```bash
git clone <仓库地址> dsh4rcs
cd dsh4rcs
npm install
npm run setup          # 自检：Node 版本 / 依赖 / 固件仓库 / 工具链，缺什么直接给命令
npm run verify         # typecheck → build → test
npm run dsh:install    # 装进 dsh 的 rcs-dev profile
npm run dsh:start      # 等打印出 dsh web 地址再开浏览器
```

### 路径不用改

仓库里**没有任何绝对路径**。插件配置默认全部留空，运行时按这条链解析：

```
工具参数 → ctx.rcs 共享配置 → 插件配置 → 环境变量 → 自动发现 → 明确报错
```

- **仓库内的东西**（`config/`、`data/rules/`）从模块自身位置推出，永远对。
- **固件仓库 `RCS_code`** 在仓库之外，按顺序找：`config/team.json` 的
  `firmware.repo` → 环境变量 `RCS_CODE_ROOT` → 与本仓库**同级**的 `../RCS_code`。
  自动发现会检查目录里有没有 `template`/`demo`/`upper_host_cli`/`R2` 这些标志物，
  **认不出就报错并列出找过哪些路径**，绝不指向一个碰巧同名的空目录。

所以最省事的布局是：

```
D:/code/
├── dsh4rcs/       ← 本仓库
└── RCS_code/      ← 固件仓库（同级即可，无需配置）
```

放在别处就设一个环境变量：

```bash
# Windows PowerShell
[Environment]::SetEnvironmentVariable('RCS_CODE_ROOT','E:/somewhere/RCS_code','User')
```

### 飞书凭证要各自配

`config/team.json` 里只有 `appId` 和授权目录清单，**没有 app_secret**。
每个人自己设环境变量：

```powershell
[Environment]::SetEnvironmentVariable('FEISHU_APP_SECRET','你的secret','User')
```

设完**重开终端**。用 `npm run feishu:check` 三层诊断（scope / 协作者 / 实际范围）。
不配飞书也能用，只是 `rcs_kb_*` 三个工具不可用，其余 17 个照常。

### 一个必须知道的坑：dsh 版本要锁死

dsh 的 profile 用 pnpm 安装，而 `dsh-web-app@0.1.0-rc.6` 用 `^0.1.0-rc.6`
声明客户端依赖 —— pnpm 会解析到更新的 rc.8，于是**服务端 rc.6、前端 rc.8**。
rc.8 的前端在 `mountApp` 里 `await ctx.inject(['uiRenderer'])`，而 rc.6 这一代
没有模块提供该服务；cordis 的 inject 是**无限等待且不报错**，
结果就是网页端永远停在 "Loading plugins…"，控制台里连报错都没有。

`npm run dsh:install` 之后如果遇到这个现象，在
`~/.dsh/profiles/rcs-dev/pnpm-workspace.yaml` 里把全部 `@deepseek-ai/*`
钉到 `0.1.0-rc.6` 再 `pnpm install`。

> **pnpm 11 起 overrides 只认 `pnpm-workspace.yaml`**，写在 `package.json`
> 的 `pnpm.overrides` 会被静默忽略（只有一行 WARN）。


## 快速开始

```bash
npm install
npm run verify        # typecheck + test + build，一条命令走完
```

分开跑：

```bash
npm run typecheck     # 对着真实 dsh 类型定义检查适配层
npm run test          # 377 个测试
npm run build         # 产出 packages/dsh-rcs-control/lib/index.js

# 不启动 dsh 的命令行冒烟
npm run check -- all ../RCS_code
npm run check -- hygiene ../RCS_code/R2
```

## 验证阶梯

| 级别 | 做什么 | 需要 dsh | 状态 |
|---|---|---|---|
| **L0** typecheck | 对着 `dsh-tools@0.1.0-rc.6` 的 `.d.ts` 检查 | ❌ | ✅ 零错误 |
| **L1** 单元测试 | `vitest run`，断言对着真实工程 | ❌ | ✅ 36/36 |
| **L2** CLI 冒烟 | `npm run check -- all <工程>` | ❌ | ✅ 通过 |
| **L2.5** 插件加载 | 桩 ctx 跑 `apply`，验证注册与呈现链路 | ❌ | ✅ 7/7 |
| **L3** dsh 本地加载 | `npm run dsh:patch` | ✅ | ✅ 启动成功，零错误 |
| **L4** profile 安装 | `npm run dsh:install` → `npm run dsh:start` | ✅ + pnpm | ✅ rcs-dev profile 已就绪 |

**每一层都抓到了下一层抓不到的东西。**

- **L0** 抓出两个真错误：`SearchMatchesResultView` 漏了必填的 `total`；schema 反推的类型字段全是可选的（赋值是单向的，"execute 返回值能过检查"不等于"能当严格类型用"），而渲染钩子按契约不得抛异常，必须防御式取值。
- **L2.5** 用桩 ctx 把「execute → render → presentationMeta → JSON 往返 → presentResult」在真实数据上跑通。
- **L3 抓到一个前面全测不出的 Windows 问题**：loader 直接对 `name` 做 `import()`，Node 的 ESM 加载器拒收盘符路径，报 `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'`。教程只说"必须是绝对路径"，**Windows 上必须写成 `file:///D:/...`**。
- **L4** 暴露 pnpm 的构建授权门：`koffi`（`dsh-host-directory-picker-native` 的硬依赖）需要在 profile 的 `pnpm-workspace.yaml` 里显式 `allowBuilds: { koffi: true }`。npm 装 dsh 时是静默跑的，pnpm 把这一步显式化了。

**测试用的是真实工程，不是 mock。** 断言直接来自 2026-08 的手工核查结论（见 [`rcs-embedded-roadmap.md`](./rcs-embedded-roadmap.md) 第三节）：工具必须复现人工找到的结论，既不漏报也不误报。

其中最有价值的是**防误报断言**：`kin_diff.h`（模板类）与 `angle_loop.h`（内联）有头无源属正常设计，工具若把它们报成缺失即为误报。人工核查时我差点也踩了这个坑。

## 运行

环境已配好，日常这样用：

```bash
npm run dsh:config    # 打印 rcs-dev 的生效配置树，不进交互界面 —— 排错首选
npm run dsh:start     # 启动 rcs-dev profile（已装好插件）
npm run dsh:install   # 改了代码后：重新构建并装进 profile
```

临时调试（不改 profile，用 overlay 挂到 web profile）：

```bash
npm run dsh:patch:config
npm run dsh:patch
```

### 为什么不能直接用 `dsh` 命令

系统里的 `dsh` 是 `AppData\Local\Programs\dsh-launcher\bin\dsh.cmd`，内容是 `npx @deepseek-ai/dsh web %*`，有两个问题：

1. **不锁版本** —— 实测会漂到 `0.1.1-rc.2`，而本插件是按 `0.1.0-rc.6` 的类型定义写并验证的。
2. **硬编码 `web` 子命令** —— 所有参数都被追加到 `web` 后面。所以 `dsh --version` 会变成 `dsh web --version`（`web` 子命令 `allowUnknownOption`，参数透传给 web 应用 → 直接启服务，看起来就是"卡住"）；**`dsh plugin add` 更是彻底失效**，因为 `plugin` 成了 web 应用的位置参数。

`scripts/dsh.mjs` 解决这两点：锁定版本，三级回退解析（本仓库 node_modules → npx 缓存 → npx 拉取）。换 dsh 版本前请重跑 `npm run verify`。

## 目录结构

```
dsh4rcs/
├── config/                             ★ 数据与代码解耦，赛季更新只改这里
│   ├── layer-rules.json
│   └── template-manifest.json
├── packages/
│   ├── rcs-core/     src/{types,fsutil,layer-lint,template-gap,repo-hygiene,rule-diff,cli,index}.ts
│   ├── rcs-ui/       src/{view-model,theme,panel-contract,index}.ts
│   └── dsh-rcs-control/
│       ├── src/index.ts                dsh 适配层
│       ├── lib/index.js                构建产物（L3/L4 加载它）
│       ├── cordis.patch.yml            bundle 层 patch（用包名）
│       └── package.json                含 dsh.bundle 声明
├── build.mjs                           esbuild：核心打入、宿主外置
├── dev.cordis.yml                      L3 overlay（用绝对路径）
└── 文档：deepseek-harness-plugin-guide.md / dsh-rcs-plugin-design.md / rcs-embedded-roadmap.md
```

## 已知事项

- **宿主包必须外置**。`@deepseek-ai/*` 打进产物会造成双实例，服务标识与 `instanceof` 全乱。`build.mjs` 检出这种情况会直接报错退出。
- **本地 devDeps 与 dsh 运行时是两份拷贝**。三个 `@deepseek-ai` 包精确锁版本（无 `^`）以降低偏差；根治办法是走 L4 用 `dsh plugin add` 装进 profile，让插件解析到 dsh 自己的副本。
- **依赖真实工程路径**：默认 `D:/code/RCS_code`，可用 `RCS_PROJECT` 环境变量或工具参数覆盖。目录不存在时相关测试自动跳过而非失败。
- 文档里的 `deepseek-harness-plugin-guide.md` 有两处示例与 rc.6 实现不符（`tools/pre-execute` 是 waterfall 不是 bail；`ToolGuard` 返回拒绝原因字符串不是布尔），实现 guard 模块时以本仓库适配层为准。
