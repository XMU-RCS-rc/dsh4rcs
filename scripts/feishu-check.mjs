#!/usr/bin/env node
/**
 * 飞书接入诊断 —— 每次改完权限都可以重跑。
 *
 *   npm run feishu:check
 *
 * 只从环境变量读凭证（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`），
 * **不接受命令行传入 secret** —— 命令行参数会进 shell 历史。
 *
 * ## 为什么必须用真实 token 探测
 *
 * 早先版本拿 `doxcnProbeOnly` 这种假 token 去试各个接口，靠「是不是 99991672」
 * 判断权限是否开通。**这是错的**：飞书先校验 token 格式、再校验权限，
 * 假 token 在权限检查之前就被格式校验挡回来，返回一个非 99991672 的错误码，
 * 于是被误判成「权限已通」。docx 权限因此被报了整整两轮假绿。
 *
 * 现在的做法：先从白名单目录里**发现真实文档 token**，再拿它去探。
 * 库里没有某个类型（比如一篇旧版文档都没有）时，如实报「未验证」而不是打勾 ——
 * 假绿比红更危险，它让人以为已经做完了。
 *
 * ## 三层结构
 *
 *   一层 scope    —— 应用级，能不能调这类接口，无法按目录细分
 *   二层 协作者   —— 资源级，能看到哪些目录
 *   三层 范围核查 —— 前两层通过 ≠ 范围收住了，必须单独查
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'https://open.feishu.cn/open-apis'
const DENIED = '99991672'

const teamFile = join(REPO, 'config', 'team.json')
const team = existsSync(teamFile) ? JSON.parse(readFileSync(teamFile, 'utf8')) : {}
const cfg = team.feishu ?? {}

const APP_ID = process.env['FEISHU_APP_ID'] ?? cfg.appId
const APP_SECRET = process.env[cfg.appSecretEnv ?? 'FEISHU_APP_SECRET']

if (!APP_ID) {
  console.error('缺少 app_id：请设 FEISHU_APP_ID 环境变量，或在 config/team.json 的 feishu.appId 里填。')
  process.exit(2)
}
if (!APP_SECRET) {
  console.error(
    `缺少 app_secret：请设环境变量 ${cfg.appSecretEnv ?? 'FEISHU_APP_SECRET'}。\n` +
      '密钥不放配置文件 —— 配置文件会进 git。\n' +
      '刚设过环境变量的话，要**重开终端**才生效。',
  )
  process.exit(2)
}

const auth = await (
  await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  })
).json()

if (auth.code !== 0) {
  console.error(`凭证无效：code=${auth.code} msg=${auth.msg}`)
  console.error('检查 app_id 与 app_secret 是否匹配、应用是否还存在、secret 是否刚重置过。')
  process.exit(1)
}
const token = auth.tenant_access_token
console.log(`凭证有效（token 有效期 ${auth.expire}s）  app_id=${APP_ID}\n`)

/** 单次 GET。网络抖动重试一次 —— 实测飞书偶发 ECONNRESET。 */
async function get(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } })
      return await r.json()
    } catch (e) {
      if (attempt >= 1) return { code: -1, msg: `网络错误：${e.message}` }
      await new Promise((r) => setTimeout(r, 400))
    }
  }
}

const authLink = (scope) =>
  `https://open.feishu.cn/app/${APP_ID}/auth?q=${scope}&op_from=openapi&token_type=tenant`

const missingScopes = (msg) => {
  const m = /\[([^\]]+)\]/.exec(msg ?? '')
  return m ? m[1].split(',').map((s) => s.trim()) : []
}

/**
 * 从缺失清单里挑出该申请的那一个 —— 只读优先。
 *
 * 飞书返回的是**「任选其一即可」**的候选集（msg 里明写「开通任一权限即可」），
 * 通常同时含读写版 `docx:document` 与只读版 `docx:document:readonly`。
 * 把整个列表原样打给人看会让人以为两个都要开 —— 而读写版给的是本工具
 * 根本不需要的写权限。所以**只推荐只读那一个**。
 */
const preferReadonly = (miss, fallback) =>
  miss.find((s) => s.endsWith(':readonly')) ?? fallback ?? miss[0]

/** 把候选集渲染成一句「申请这个，别申请那些」。 */
const describeScopes = (miss, fallback) => {
  const scope = preferReadonly(miss, fallback)
  if (!scope) return '（飞书没有返回具体的权限名）'
  if (!scope.endsWith(':readonly')) {
    return `${scope} ⚠️ 候选里没有只读版本，开通前请确认它给出的写权限是否可接受`
  }
  const others = miss.filter((s) => s !== scope).length
  return others > 0 ? `${scope}（另外 ${others} 个是读写权限，任选其一即可 —— 只开这个只读的）` : scope
}

const listFolder = (tok, pageToken) =>
  get(`/drive/v1/files?folder_token=${tok}&page_size=50${pageToken ? `&page_token=${pageToken}` : ''}`)

const sources = Array.isArray(cfg.sources) ? cfg.sources.filter((s) => s.token) : []

// ── 第一层 a：目录列表权限（用真实目录 token 探） ───────────────
console.log('第一层 · 应用权限（scope）—— 应用级，无法按目录细分')
const lacking = []
let driveOk = false

if (sources.length === 0) {
  console.log('  ⚠️  feishu.sources 为空，无法用真实 token 探测目录权限。')
} else {
  const j = await listFolder(sources[0].token)
  if (String(j.code) === DENIED) {
    const miss = missingScopes(j.msg)
    console.log(`  ❌ [必需] 云盘 目录列表  需开通：${describeScopes(miss, 'drive:drive:readonly')}`)
    lacking.push({
      label: '云盘 目录列表',
      why: '遍历电控目录、拿到文件清单',
      need: true,
      miss,
      scope: 'drive:drive:readonly',
    })
  } else if (j.code === 0) {
    driveOk = true
    console.log('  ✅ [必需] 云盘 目录列表')
  } else {
    console.log(`  ⚠️  [必需] 云盘 目录列表  接口返回 code=${j.code}：${(j.msg ?? '').slice(0, 60)}`)
  }
}

// ── 发现真实样本 token ─────────────────────────────────────────
// 只为拿到「每种类型各一个真 token」，不做完整遍历。
// 请求数设上限：软件组递归有 148 个目录，全走一遍纯属浪费。
const WANT = ['docx', 'doc', 'sheet', 'bitable']
const sample = {}
const counts = {}
let requests = 0
const REQUEST_CAP = 40

if (driveOk) {
  const queue = sources.map((s) => ({ token: s.token, depth: 0 }))
  const seen = new Set(queue.map((q) => q.token))
  while (queue.length > 0 && requests < REQUEST_CAP && WANT.some((t) => !sample[t])) {
    const { token: tok, depth } = queue.shift()
    requests++
    const j = await listFolder(tok)
    if (j.code !== 0) continue
    for (const f of j.data?.files ?? []) {
      counts[f.type] = (counts[f.type] ?? 0) + 1
      if (WANT.includes(f.type) && !sample[f.type]) sample[f.type] = { token: f.token, name: f.name }
      if (f.type === 'folder' && depth < 3 && !seen.has(f.token)) {
        seen.add(f.token)
        queue.push({ token: f.token, depth: depth + 1 })
      }
    }
  }
}

// ── 第一层 b：内容权限（必须用真实 token） ─────────────────────
const CONTENT_CHECKS = [
  {
    label: '新版文档 正文',
    type: 'docx',
    need: true,
    scope: 'docx:document:readonly',
    why: '读 docx 正文 —— 队内文档绝大多数是这种',
    path: (t) => `/docx/v1/documents/${t}/raw_content`,
  },
  {
    label: '旧版文档 正文',
    type: 'doc',
    need: false,
    scope: 'docs:doc:readonly',
    why: '读 2023 年前建的旧版文档',
    path: (t) => `/doc/v2/${t}/content`,
  },
  {
    label: '电子表格',
    type: 'sheet',
    need: false,
    scope: 'sheets:spreadsheet:readonly',
    why: '读器件清单 / 测试记录这类表格',
    path: (t) => `/sheets/v3/spreadsheets/${t}`,
  },
  {
    label: '多维表格',
    type: 'bitable',
    need: false,
    scope: 'bitable:app:readonly',
    why: '把检查结论写回飞书（暂未实现）',
    path: (t) => `/bitable/v1/apps/${t}/tables?page_size=1`,
  },
]

for (const c of CONTENT_CHECKS) {
  const tag = c.need ? '必需' : '可选'
  const s = sample[c.type]
  if (!s) {
    // 白名单范围内没有这种类型 —— 如实说未验证，不打勾。
    console.log(`  ⚪ [${tag}] ${c.label}  未验证（授权范围内没有 ${c.type} 类型文件可供探测）`)
    continue
  }
  const j = await get(c.path(s.token))
  if (String(j.code) === DENIED) {
    const miss = missingScopes(j.msg)
    console.log(`  ❌ [${tag}] ${c.label}  需开通：${describeScopes(miss, c.scope)}`)
    lacking.push({ ...c, miss })
  } else if (j.code === 0) {
    console.log(`  ✅ [${tag}] ${c.label}  已用真实文档验证：${s.name}`)
  } else {
    console.log(`  ⚠️  [${tag}] ${c.label}  code=${j.code}：${(j.msg ?? '').slice(0, 60)}`)
  }
}

// ── 第二层：资源可读性 ─────────────────────────────────────────
console.log('\n第二层 · 资源授权（协作者）—— 决定能看到哪些目录')
const unreachable = []
if (sources.length === 0) {
  console.log('  ⚠️  config/team.json 的 feishu.sources 是空的 —— 还没圈定授权范围。')
} else if (!driveOk) {
  console.log('  ⏸️  目录列表权限未通，本层无法判定。')
  unreachable.push(...sources)
} else {
  for (const s of sources) {
    const j = await listFolder(s.token)
    if (j.code === 0) {
      const files = j.data?.files ?? []
      const kinds = {}
      for (const f of files) kinds[f.type] = (kinds[f.type] ?? 0) + 1
      const breakdown = Object.entries(kinds)
        .map(([k, n]) => `${k}×${n}`)
        .join(' ')
      console.log(`  ✅ ${s.label}  顶层 ${files.length} 项${breakdown ? `（${breakdown}）` : ''}`)
    } else {
      console.log(`  ❌ ${s.label}  code=${j.code}  ${(j.msg ?? '').split('。')[0].slice(0, 80)}`)
      unreachable.push(s)
    }
  }
}

// ── 第三层：范围核查 ───────────────────────────────────────────
let overBroad = false
if (driveOk && cfg.rootFolderToken) {
  console.log('\n第三层 · 范围核查 —— 前两层通过不代表范围收住了')
  const j = await listFolder(cfg.rootFolderToken)
  if (j.code === 0) {
    overBroad = true
    const files = j.data?.files ?? []
    const dirs = files.filter((f) => f.type === 'folder').map((f) => f.name)
    console.log(`  🔴 应用能读到**根目录**「RCS16 RC资料库」共 ${files.length} 项，且无人为它授权。`)
    console.log(`     可见子目录：${dirs.join('、')}`)
    console.log('     → 飞书侧没有做到电控隔离，共享文件夹对应用身份默认可读。')
    console.log('     → 范围收敛目前只靠本地白名单：feishu.sources + feishu.sync.allowlistOnly。')
    console.log('        它防的是「同步器写错」，防不住「有人直接拿凭证调 API」。')
  } else {
    console.log('  ✅ 应用读不到根目录 —— 范围由飞书侧收住了。')
  }
}

// ── 待办 ───────────────────────────────────────────────────────
if (Object.keys(counts).length > 0) {
  const brief = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join('  ')
  console.log(`\n探测期间在白名单范围内见到：${brief}（仅抽样，非完整统计）`)
}

if (lacking.length > 0) {
  console.log('\n待办 · 开通权限（点链接直达，勾选后需**发版并等管理员审批**）')
  for (const c of lacking) {
    console.log(`  ${c.need ? '【必需】' : '【可选】'} ${c.label} —— ${c.why}`)
    console.log(`    权限：${preferReadonly(c.miss, c.scope)}`)
    console.log(`    ${authLink(preferReadonly(c.miss, c.scope))}`)
  }
  console.log('  链接已指向只读版本。飞书页面上可能同时列出同名的读写权限 ——')
  console.log('  **不要勾它**：本套工具全程只读，写权限没有任何用处，只会放大出事的面。')
}

const ready =
  driveOk && lacking.filter((c) => c.need).length === 0 && sources.length > 0 && unreachable.length === 0
const verdict = !ready
  ? '还有必需项未完成，见上。'
  : overBroad
    ? '可以同步，但**范围未在飞书侧收住** —— 本地白名单是唯一屏障，见第三层。'
    : '飞书接入已就绪，范围也收住了。'
console.log(`\n结论：${verdict}`)
process.exit(ready ? 0 : 1)
