# DeepSeek Harness (dsh) 插件开发指南

> 调研时间：2026-08-24
> 状态提示：dsh 目前处于 **developer preview**，官方明确说明会有 breaking changes。本文 API 以 2026-08 的官方文档 / 菜鸟教程为准，实际开发前请再核对仓库内 `docs/development.md`。

---

## 一、DeepSeek Harness 是什么

| 项目 | 说明 |
|---|---|
| 全称 | DeepSeek Harness，CLI 命令为 `dsh` |
| 开源方 | DeepSeek AI，2026 年 8 月开源 |
| 协议 / 语言 | MIT / TypeScript |
| 核心理念 | `Agent = Model + Harness`，**Everything is a Plugin（一切皆插件）** |
| 插件内核 | Cordis（依赖注入 + 插件生命周期 + 事件总线） |
| 仓库 | https://github.com/deepseek-ai/deepseek-harness |
| 文档 | https://deepseek-harness.github.io/deepseek-harness/ |

**和 Claude Code / Codex 这类 agent 最大的差别**：后者出厂即固定一套工作流，dsh 则把模型适配器、工具注册表、会话日志、沙箱、调度、甚至 **agent 主循环本身** 都做成了插件——每一个都可替换。它甚至可以把 Claude Code、Codex 当作 sub-agent 调用。

生态热度：开源两天内收到 2000+ 插件投稿，GitHub `dsh-plugin` topic 下已有 1100+ 可安装插件，覆盖 14 个分类。

---

## 二、当前网络上比较火热的插件盘点

按分类整理（install 命令来自官方社区插件页与各插件仓库）：

### 1. 插件发现 / 管理（新手先装这几个）

| 插件 | 作用 | 安装 |
|---|---|---|
| `dshmarket` | 图形化插件市场，集成进 Settings，不用再敲命令装插件 | `dsh plugin --profile web add dshmarket` |
| `dsh-find-plugin` | 让 Agent 自己去生态里搜索、发现插件 | `dsh plugin --profile web add dsh-find-plugin` |
| `dsh-plugin-doctor` | 校验 manifest 完整性、构建、打包，做健康检查 | `dsh plugin --profile web add github:zoahdev/dsh-plugin-doctor` |
| `dsh-poison-guard` | 安装前的供应链安全扫描，检测恶意代码模式 | `npm install -g dsh-poison-guard` |

### 2. UI / 工作台增强

| 插件 | 作用 | 安装 |
|---|---|---|
| `dsh-web-ui` | 带看板娘的 Web 界面、任务仪表盘、主题 | `dsh plugin --profile web add github:zhu1090093659/dsh-web-ui` |
| `dsh-better-sidebar` | 文件管理 / 代码编辑 / 终端 / Git 面板 / 后台任务合一 | `dsh plugin --profile web add dsh-better-sidebar` |
| `dsh-TUI` | Claude Code 风格终端 UI，实时状态 + token 进度 | `dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui` |
| `dsh-at-file` | 聊天里 `@文件名` 直接把文件内容带进 prompt | `dsh plugin --profile web add github:omdsh-dev/dsh-at-file` |

### 3. 上下文 / 成本 / 记忆

| 插件 | 作用 | 安装 |
|---|---|---|
| `dsh-context` / `context-vista` | 可视化上下文窗口构成，看清 token 预算被谁吃掉 | `dsh plugin --profile web add dsh-context` |
| `dsh-cost-meter` | 按会话 / 按天统计 API 成本，预算监控 + 历史看板 | `dsh plugin --profile web add github:Han-1413141/dsh-cost-meter` |
| `dsh-memory-evolve` | 跨会话长期记忆，感知 Git 分支，技能演化 | 见仓库 |
| `dsh-tier-router` | 两级模型路由：贵模型做规划，便宜模型做执行 | `dsh plugin --profile web add github:BruceLanLan/dsh-tier-router` |
| `obsidian-knowledge-mode` | 对接 Obsidian 做 AI 原生知识库，带反囤积与校验回路 | 见仓库 |

### 4. 多智能体 / 工作流

| 插件 | 作用 | 安装 |
|---|---|---|
| `dsh-agent-teams` | 多 agent 团队协作，任务分派 + 实时状态可见 | `dsh plugin --profile web add @nanmicoder/dsh-agent-teams` |
| `dsh_workflow` | 工作流编排 | `dsh plugin --profile web add github:dsh-external/dsh_workflow#main` |
| `virtual-product-team` | 模拟 PM / 工程师 / QA / 发布经理的完整产品团队 | 见仓库 |
| `dsh-omni-router` | 按任务复杂度智能路由，支持多推理模式 | 见仓库 |

### 5. 视觉 / 多模态 / 浏览器

| 插件 | 作用 | 安装 |
|---|---|---|
| `modlens` | 接外部视觉模型做图像分析 | `dsh plugin --profile web add @liustack/modlens` |
| `dsh-vision-toolkit` | 视觉工具集 | `dsh plugin --profile web add @anionex/dsh-vision-toolkit` |
| `dsh-browser` | 操作真实 Chrome，保留登录态 | 见仓库 |
| `BrowserSkill` | 腾讯出品的真实浏览器自动化方案 | 见仓库 |

### 6. 平台适配 / 其他

- `dsh-minimal-msys2`、`dsh-subprocess-win32`：**Windows 支持**（持久 bash、win32 运行时），Windows 用户重点关注
- `dsh-undo`：回滚 Agent 的改动
- `dsh-record-replay`：Agent 复现你演示过的操作
- `dsh-github-connector`：对话里直接管理 GitHub 仓库
- `dshp`：把整套 DSH 配置作为可移植文件列出 / 创建 / 分享
- 娱乐向：`dsh-minigames`（18 款小游戏）、`dsh-ads`（2005 年国内互联网风格广告）、`deepseek-manners`（每次回复后加“谢谢你，鲸鱼大人”）

### 插件发现渠道

- GitHub topic：https://github.com/topics/dsh-plugin
- `awesome-deepseek-harness` / `awesome-dsh-plugin` 精选列表
- 社区目录站：dshhub.dev、dsh.so

---

## 三、环境准备

**依赖要求**

- Node.js **v20+**（npm 安装与源码构建都需要）
- pnpm（仅源码安装需要）：`npm install -g pnpm`
- Git
- Python 3.10+（仅用 Python SDK 时）

**方式 A：npm 一键（推荐日常使用）**

```bash
npm install -g @deepseek-ai/dsh
dsh web
# 或免安装
npx @deepseek-ai/dsh web
```

Web UI 默认在 http://127.0.0.1:3080

**方式 B：源码（推荐插件开发）**

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

**常用命令**

| 命令 | 作用 |
|---|---|
| `dsh web` | 启动 Web UI |
| `dsh --profile headless "任务描述"` | 一次性跑单个任务 |
| `dsh --profile web --port 8080` | 指定端口 |
| `dsh --profile web --dump-config` | 打印完整配置树（**排错神器**） |
| `dsh plugin --profile <name> add/remove ...` | 插件增删 |

**首次配置**：Settings → Models 填 DeepSeek API Key → 点 “Choose workspace” 选项目目录。
Python SDK 走环境变量：`export DEEPSEEK_API_KEY=sk-xxx`

> `web` 和 `headless` 两个 profile 首次使用会从内置模板自动初始化。

---

## 四、插件的三种写法

一个 dsh 插件本质就是**一个导出 `apply` 函数的 TypeScript 模块**。框架加载时调用 `apply`，传入 `ctx`（Context），你在里面注册能力（工具、事件监听、LLM 适配器……）。

### 形态 1：函数式（最常用）

```typescript
// src/my-plugin.ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'

export function apply(ctx: Context) {
  console.log('[hello-plugin] plugin loaded!')
}
```

### 形态 2：对象式

```typescript
import type { Context } from '@deepseek-ai/cordis'

export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) {
    // 在这里注册能力
  },
}
```

### 形态 3：类式（**当你要对外提供 Service 时用**）

```typescript
import { Service, type Context } from '@deepseek-ai/cordis'

export default class MyService extends Service {
  static inject = ['tools']

  constructor(ctx: Context) {
    super(ctx, 'myService')   // 第二个参数就是服务名，别人 inject: ['myService']
  }
}
```

选型建议：**只消费能力 → 函数式；对外提供能力 → 类式。**

---

## 五、四个必须理解的核心概念

### 1. Context（ctx）

插件与框架的唯一接口。所有注册都通过 `ctx` 走，框架据此做**自动回收**。

### 2. Service 与依赖注入

```typescript
export const inject = ['tools', 'llm']

export function apply(ctx: Context) {
  // 保证：apply 执行时 ctx.tools / ctx.llm 一定已就绪
  ctx.tools.register(/* ... */)
}
```

内置服务（部分）：

| 服务 | 用途 |
|---|---|
| `ctx.tools` | 工具运行时（注册 / 调用工具） |
| `ctx.llm` | 语言模型服务（含 `registerAdapter`） |
| `ctx.agents` | Agent 管理 |

**可选依赖**不要写进 `inject`，用 `ctx.get()` 探测：

```typescript
export function apply(ctx: Context) {
  const metrics = ctx.get('metrics')
  metrics?.record('plugin_loaded', 1)
}
```

> 服务缺失时插件停在 PENDING 静默等待，**不报错**；服务运行中消失，依赖它的插件会自动 dispose，服务回来了又自动重载。这是 dsh 不会“调用空服务”的根本机制。

### 3. Fiber 生命周期（六态状态机）

Fiber 是一个插件实例的执行单元。

```
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
                 ↘ FAILED
```

| 状态 | 含义 | 触发 |
|---|---|---|
| PENDING | 已声明，但 inject 的依赖没就绪 | 插件加入、注入服务不可用 |
| LOADING | 依赖就绪，正在执行 apply | 所有必需服务已初始化 |
| ACTIVE | 插件运行中 | apply 正常返回 |
| FAILED | apply 抛异常 | apply 执行出错 |
| UNLOADING | 正在释放资源 | 依赖丢失 / 主动卸载 / HMR |
| DISPOSED | 完全卸载 | 所有 disposer 执行完毕 |

### 4. 自动清理

**通过 ctx 注册的任何东西——事件监听、工具、定时器——在插件卸载时都会被自动清理。**

| 注册动作 | 卸载时 |
|---|---|
| `ctx.on(event, handler)` | 监听器移除 |
| `ctx.tools.register(tool)` | 注册撤销 |
| `ctx.llm.registerAdapter()` | 适配器移除 |
| `ctx.effect(() => cleanup)` | 执行 disposer |

---

## 六、实战：从零写第一个插件

### 目录结构

```
scratch-plugin/
├── src/
│   └── my-plugin.ts     # 插件源码
├── cordis.yml           # patch overlay，本地开发用
└── package.json
```

### 第 1 步：写插件

```typescript
// scratch-plugin/src/my-plugin.ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'

export function apply(ctx: Context) {
  console.log('[hello-plugin] plugin loaded!')
}
```

### 第 2 步：写 patch overlay

```yaml
# scratch-plugin/cordis.yml
# 本地开发插入插件的 overlay
- insert:
    - id: hello
      # 注意：name 必须是绝对路径
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/my-plugin.ts'
```

### 第 3 步：带 patch 启动

```bash
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

看到控制台打印 `[hello-plugin] plugin loaded!` 即成功。

| 术语 | 含义 |
|---|---|
| **profile** | 可组装的配置，决定 Web UI 由哪些 bundle 包组成 |
| **patch overlay** | 启动时叠加的 YAML，用来插入本地插件或覆盖配置 |
| **insert** | patch 内的语法，按 name 路径加载插件 |

> `--patch` 适合**本地开发**；要分发给别人用，需要打成 bundle（见第十一节）。

---

## 七、定义工具（Tool）——插件最核心的能力

工具是 Agent 真正能“动手”的东西。schema 会自动注入模型 prompt，模型据此发现并按名调用。

```typescript
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-tool'
export const inject = ['tools']          // 必须，等 tools 注册表就绪

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file from disk.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path' },
      limit: { type: 'number' },
    },
    output: {
      // schema 声明 execute 返回的“规范值”类型
      schema: { type: 'string' },
      // render 把规范值转成给模型看的内容块
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
    },
  }))
}
```

**关键规则**

- `defineTool` 会根据 `parameters` **推导并校验** args，`execute` 里的 `args` 已是校验后的类型，不用自己再校验。
- `execute` 返回的是 `output.schema` 声明的**规范值（canonical value）**，`render` 负责转成模型可读内容。这层分离让同一个返回值可以有不同的渲染。
- **必须尊重 `exec.signal`**：信号触发时取消正在进行的工作。
- 抛异常或返回不合 schema 的值 → 标记为 `isError`。注册表会捕获抛出的异常，以及 schema / renderer / metadata-projector / lossless-JSON 的失败。
- 注册是 effect-based 的：插件 fiber 卸载会自动反注册。

**权限 / 审批不要写在工具里**，用钩子：

- `tools/pre-execute` 钩子：实现可扩展的 allow / deny / ask 策略
- `ctx.tools.guard()`：最终的单调拒绝（monotonic denial）

---

## 八、插件配置（Schema）

导出一个 `Config` 接口 + 同名 Schemastery schema：接口给 TS 类型安全，schema 给运行时校验。

```typescript
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export interface Config {
  greeting: string
  maxRetries: number
  verbose?: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  console.log(config.greeting)
}
```

**更强的校验**

```typescript
export const Config = Schema.object({
  apiKey: Schema.string().required(),
  timeout: Schema.number().default(30000),
  mode: Schema.union(['fast', 'accurate']).default('fast'),
})
```

**用户怎么传配置**（cordis.yml）

```yaml
- insert:
    - id: hello
      name: '/absolute/path/to/scratch-plugin/src/my-plugin.ts'
      config:
        greeting: 'Hi there!'
        maxRetries: 5
```

> 配置非法 → 插件加载失败并给出清晰错误；字段缺失 → 自动填 schema 默认值。

---

## 九、资源清理：`ctx.effect()`

用于管理框架不认识的资源（定时器、连接、子进程、文件句柄……）。

```typescript
ctx.effect(() => {
  const timer = setInterval(() => console.log('heartbeat'), 5000)
  // 返回 disposer，卸载时执行
  return () => clearInterval(timer)
})
```

**两条硬规则**

1. disposer **按注册的逆序**执行，异步并发执行。
2. **若清理步骤之间存在顺序依赖，必须把两步写在同一个 effect 的 disposer 里**串行等待——否则并发执行会乱序。

热重载（HMR）场景下不写 effect 会导致定时器 / 连接 / 监听器泄漏并重复注册，这是最常见的坑。

---

## 十、事件系统

五种分发模式：

| 模式 | 方法 | 是否 await | 有返回值 | 用途 |
|---|---|---|---|---|
| emit | `ctx.emit()` | 否 | 无 | 广播通知 |
| bail | `ctx.bail()` | 否 | 有 | 决策，第一个真值胜出 |
| serial | `ctx.serial()` | 是 | 有 | 顺序初始化 |
| waterfall | `ctx.waterfall()` | 否\* | 有 | 处理管线 |
| parallel | `ctx.parallel()` | 是 | 无 | 并发操作 |

\* waterfall 技术上不 await，但监听器常为 async，示例里普遍写 `await`。

**基础用法**

```javascript
ctx.on('event-name', (payload) => { /* 处理 */ })
ctx.emit('event-name', payload)
```

**bail（短路决策）**

```javascript
const result = ctx.bail('some-check', input)

ctx.on('some-check', (input) => {
  if (shouldBlock(input)) return 'blocked'
  // 返回 null/false/undefined 表示放行
})
```

**waterfall（管线改写）**

```javascript
const output = await ctx.waterfall('my-plugin/transform', input, async () => input)

ctx.on('my-plugin/transform', async (_input, next) => {
  const downstream = await next()
  return downstream.trim()
})
```

**监听工具结果**

```javascript
ctx.on('tools/result', (exec, result) => {
  console.log(`[tool] ${exec.name}`)
})
```

**类型安全的自定义事件**

```typescript
declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/ready': (payload: { id: string }) => void
    'my-plugin/check': (input: string) => boolean | undefined
  }
}
```

**主要事件类型**

- Cordis 实时事件：`agent/step`、`tools/result`、`session/event`
- 持久化会话事件：`turn/*`、`step/*`、`tool/call`、`compaction/*` —— 通过 `session/event` 监听，再判断 `event.type`

---

## 十一、打包：bundle 与 profile

| 概念 | manifest 字段 | 作用 | 谁来写 |
|---|---|---|---|
| **Bundle** | `dsh.bundle` | 声明“这个包贡献了什么” | 插件开发者 |
| **Profile** | `dsh.profile` | 声明“这套配置由哪些 bundle 组成” | `dsh plugin` 工具自动生成 |

> 一句话：**bundle 是你写和分发的东西；profile 是用户用 `dsh --profile <name>` 启动的东西。**

### Bundle 的 package.json

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

### Bundle 的三个文件

- `package.json` —— 带 `dsh.bundle` 声明的清单
- `cordis.patch.yml` —— 配置层（patch 条目的 YAML 数组）
- `index.js` —— 插件模块入口

### cordis.patch.yml

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin      # 用包名，不是相对路径
```

> 注意与本地 `--patch` overlay 的区别：本地开发用**绝对源码路径**，已安装的 bundle 用**包名**，好让 Node 的模块解析器能找到。

Profile 位于 `$DSH_HOME/profiles/<name>/`，包含 `package.json`（`dsh.profile`，有序 bundle 列表）和 `cordis.patch.yml`（每个 bundle 之后应用的用户层）。**profile manifest 永远不需要手写，`dsh plugin` 会自动创建和维护。**

---

## 十二、发布插件

三种分发方式：

| 方式 | 用户安装命令 | 产物 | 需要构建授权 |
|---|---|---|---|
| **npm** | `dsh plugin add your-package` | 预构建 `lib/` | 否 |
| **tarball** | `dsh plugin add ./hello-plugin-0.1.0.tgz` | 打包文件 | 否 |
| **Git** | `dsh plugin --profile demo add github:you/hello-plugin` | 源码 | **是**（pnpm ≥10） |

### npm 发布（推荐）

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "scripts": {
    "build": "tsdown",
    "prepublishOnly": "pnpm build"
  }
}
```

```bash
pnpm build
pnpm publish
```

### tarball

```bash
pnpm pack          # 产出 hello-plugin-0.1.0.tgz
```

### Git 安装（进阶）

需要自包含的 `prepare` 脚本：

```json
{
  "name": "dsh-hello-plugin",
  "scripts": { "prepare": "tsdown -c tsdown.publish.ts" }
}
```

用户还得手动授权构建：

```yaml
# $DSH_HOME/profiles/demo/pnpm-workspace.yaml
allowBuilds:
  dsh-hello-plugin: true
```

安全起见建议锁 commit：`github:you/hello-plugin#a1b2c3d`

> 官方建议：**优先发布 npm 或交付 tarball，让用户零授权直接安装。**

### 让插件被发现

在仓库打上 GitHub topic **`dsh-plugin`**，并考虑提 PR 到 `awesome-dsh-plugin`。

---

## 十三、安装与配置加载顺序

```bash
dsh plugin --profile demo add ./hello-plugin        # 添加
dsh plugin --profile demo remove dsh-hello-plugin   # 移除
dsh --profile demo --dump-config                    # 验证生效配置
```

自动生成的 profile package.json：

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": {
    "dsh-hello-plugin": "link:/path/to/hello-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-hello-plugin"]
    }
  }
}
```

**配置层优先级（低 → 高）**

1. **Bundle patches** —— `dsh.profile.bundles` 里列的包（数组顺序决定先后）
2. **Profile patch** —— profile 目录下的 `cordis.patch.yml`
3. **Home patch** —— `$DSH_HOME/cordis.patch.yml`（跨 profile 共享）
4. **CLI overlay** —— 每个 `--patch <path>` 参数（按 argv 顺序）

> 注意：**patch 是按 id 做整行替换，不是深合并**——覆盖时所有键都要重新写全。

---

## 十四、最佳实践与常见坑

**该做的**

1. 必需依赖写 `inject`，可选依赖用 `ctx.get()` 探测后可选链调用。
2. 一切资源走 `ctx` 或 `ctx.effect()` 注册，让框架自动回收。
3. 工具的 `execute` 里尊重 `exec.signal`，支持取消。
4. `output.schema` 与 `render` 分离：规范值给程序，渲染内容给模型。
5. 用 Schemastery 声明配置并给默认值，让错误在加载期暴露。
6. 权限 / 审批走 `tools/pre-execute` 与 `ctx.tools.guard()`，不要硬编码在工具里。
7. 排错第一招：`dsh --profile <name> --dump-config`。

**坑**

1. **本地 patch 的 `name` 必须绝对路径**，相对路径加载不到。
   **Windows 上还不够——必须写成 `file://` URL。** 实测（dsh 0.1.0-rc.6）：loader 直接对 `name` 做 `import()`，Node 的 ESM 加载器拒收盘符路径，报
   `ERR_UNSUPPORTED_ESM_URL_SCHEME: ... Received protocol 'd:'`。
   正确写法是三个斜杠：`file:///D:/path/to/plugin/index.js`。
   注意这只影响**本地 `--patch` overlay**；已安装 bundle 的 `cordis.patch.yml` 用包名，不受影响。
2. **patch 按 id 整行替换**，以为是深合并会丢配置。
3. 忘了 `inject: ['tools']` → 插件永远停在 PENDING，**静默不报错**，很难查。
4. 定时器 / 连接不写 `ctx.effect` → HMR 后泄漏 + 重复注册。
5. 清理有顺序依赖却拆成多个 effect → 逆序并发执行导致乱序。
6. Git 方式分发要求用户改 `pnpm-workspace.yaml` 授权，体验差，优先 npm/tarball。
7. Windows 用户注意装 `dsh-minimal-msys2` / `dsh-subprocess-win32`。
8. 装第三方插件前用 `dsh-poison-guard` 扫一遍，生态增长太快，供应链风险真实存在。

---

## 十五、参考链接

- 官方仓库：https://github.com/deepseek-ai/deepseek-harness
- 官方文档：https://deepseek-harness.github.io/deepseek-harness/
- 工具编写参考：https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool
- 官方介绍页：https://deepseek.com/harness/en/
- 插件生态 topic：https://github.com/topics/dsh-plugin
- Cordis 内核论文：https://github.com/cordiverse/paper
- 菜鸟教程（中文，章节最全）：https://www.runoob.com/deepseek-harness/deepseek-harness-tutorial.html
- 社区实战贴：https://github.com/deepseek-ai/deepseek-harness/discussions/961
