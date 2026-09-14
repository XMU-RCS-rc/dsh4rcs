# 参与开发

这套插件要**跨赛季活下去**，所以「怎么改」和「改完怎么验」写在这里，不靠口口相传。
设计文档第三节把「插件本身要防断代」列为一条设计原则，本文件是它的一半，
另一半是交接人名单（见文末）。

---

## 本地开发

```bash
npm run verify      # typecheck → build → test（顺序不能改，见下）
npm run typecheck   # 对着真实 dsh 类型定义检查适配层
npm run build       # esbuild 多插件构建，检查宿主包泄漏
npm run test        # 全量单元测试
```

> `verify` 的顺序是 typecheck → **build** → test：部分测试加载 `packages/*/lib` 的构建产物，先测后构建会拿到上一次的旧产物，报出令人困惑的失败。

### 持续集成

推到 `main` 或开 PR 时，[`.github/workflows/verify.yml`](./.github/workflows/verify.yml) 会在 **Ubuntu 与 Windows** 上各跑一遍 `npm ci → typecheck → build → test`。

依赖固件仓库、Keil、飞书凭证的测试都用 `skipIf` 守着，CI 上自动跳过 —— 这是设计好的，不是漏跑。队里清一色 Windows，多跑一个 Ubuntu 是为了逼出硬编码盘符、路径分隔符这类问题（都实际踩过）。

### 验证阶梯

验证分六级（L0 typecheck → L4 装进 profile），每一层都能抓到下一层抓不到的东西。
`npm run verify` 覆盖 L0~L1，CI 也只跑到这里；L3/L4 要启动 dsh 网页端，留给本地手动。

**完整的阶梯表与各级当前状态见 [`docs/features.md`](./docs/features.md) 第四节** ——
带状态的那份是唯一真相，这里不复述，免得两处数字对不上。

---

---

## 改动的三条约定

**1. 判断逻辑放 `packages/rcs-core/`，dsh 适配层只做包装。**

`rcs-core` 零 dsh 依赖，可以直接用 vitest 跑、用 node 调。dsh 处于 developer preview，
API 变动只该打到薄薄的适配层。新加一个检查器时，先在 core 里写成纯函数并测好，
再去 `dsh-rcs-*` 里包成 Tool。

**2. 新增插件要同步四处。** 这四处目前靠人对齐，漏一处就会出现「装了但没构建」
或「关不掉」：

| 位置 | 作用 |
|---|---|
| `scripts/build.mjs` 的 `PLUGINS` | 构建产物 |
| `package.json` 的 `dsh:install` | 装进 profile |
| `scripts/setup.mjs` 的 `plugins` | 自检报告的分母 |
| `config/overlays/dsh4rcs-disabled.cordis.yml` | `dsh:start:no-rcs` 要能关掉它 |

**3. 危险工具先登记再实现。** 会让硬件动起来的工具，在写代码之前就加进
`packages/rcs-core/src/danger.ts` 的清单。这样它落地当天就自动受管控，
而不是「先做出来再补安全」。

---

## 写检查器时反复付过学费的几条

- **误报比漏报更伤。** 天天喊狼来了的检查没人看。分层检查曾一次喷 87 条、
  嵌入式检查曾喷 253 条，收敛到 14 和 7 才有人用。收敛手段是限定作用域
  （只查队内代码、只查文件作用域），不是调低严重级别。
- **假绿比红更危险。** 检查项宁可报「未验证」，也不要给一个没验过的勾。
  曾用假 token 探飞书权限，两轮都报「已开通」，拿真文档一试才发现根本没批。
- **静默丢数据最危险。** 规则提取曾漏掉整条条款，167 条跑通了但少一条没人看得出来。
  所以规则导入那条链路有交叉校验：解析器说有几条错误，就必须解析出几条。
- **失败却说不出原因是最糟的输出。** 它逼人去手工翻日志，那工具就白做了。
  构建失败时若一条诊断都没解析出来，要把日志末尾原样附上。

---

## 提交与 CI

推到 `main` 或开 PR 都会触发 [`verify.yml`](./.github/workflows/verify.yml)。
本地跑通 `npm run verify` 再推 —— CI 上 Windows runner 按 2 倍分钟数计费，
不要拿它当调试环境。

提交信息用中文，说清**为什么改**而不只是改了什么。这个仓库的注释和提交信息
承担了大部分知识传递的工作。

---

## 交接

每个模块应当有两名维护人（一名大三、一名大二），避免明年又成祖传代码。
名单尚未落定 —— **这是当前最大的断代风险**，请在队内确认后补在这里。
