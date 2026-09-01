#!/usr/bin/env node
/**
 * 命令行同步入口 —— 不启动 dsh 也能跑。
 *
 *   npm run kb:sync           # 增量
 *   npm run kb:sync -- --force # 全量重抓
 *   npm run kb:sync -- --dry   # 只遍历不抓正文，看看范围对不对
 *
 * 和 `npm run check` 同样的思路：核心逻辑在 rcs-core 里，命令行和 dsh 工具
 * 只是两个薄壳。CI 或排错时不必为了同步一次去开一个 dsh 会话。
 *
 * 凭证只从环境变量读（`FEISHU_APP_SECRET`），不接受命令行传入。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  HttpFeishuClient, FeishuPermissionError, describeScopes,
} from '../packages/rcs-core/src/feishu.ts'
import {
  syncKnowledgeBase, walkAllowlist, AllowlistGuard, DEFAULT_SYNC_POLICY,
} from '../packages/rcs-core/src/kb-sync.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const force = args.includes('--force')
const dry = args.includes('--dry')

const team = JSON.parse(readFileSync(join(REPO, 'config', 'team.json'), 'utf8'))
const fc = team.feishu
if (!fc) {
  console.error('config/team.json 里没有 feishu 配置段。见 feishu-setup.md。')
  process.exit(2)
}

const secretEnv = fc.appSecretEnv ?? 'FEISHU_APP_SECRET'
const secret = process.env[secretEnv]
if (!secret) {
  console.error(
    `环境变量 ${secretEnv} 没有值。\n` +
      '密钥只从环境变量读 —— 不放配置文件（会进 git）、不走命令行参数（会进 shell 历史）。\n' +
      '刚设过的话要重开终端。',
  )
  process.exit(2)
}

const policy = { ...DEFAULT_SYNC_POLICY, ...(fc.sync ?? {}) }
const sources = fc.sources ?? []
const client = new HttpFeishuClient(
  { appId: fc.appId, appSecret: secret },
  { minIntervalMs: fc.minIntervalMs },
)

console.log(`授权范围（${sources.length} 个目录）：`)
for (const s of sources) console.log(`  · ${s.label}  ${s.token}`)
console.log(`只抓类型：${policy.includeTypes.join(', ')}   跳过：${policy.excludeTypes.join(', ')}`)
console.log(`深度上限 ${policy.maxDepth}\n`)

try {
  if (dry) {
    const guard = new AllowlistGuard(sources.map((s) => s.token))
    let lastFolders = 0
    const walked = await walkAllowlist(client, sources, policy, guard, (folders) => {
      if (folders - lastFolders >= 10) {
        lastFolders = folders
        process.stdout.write(`\r  遍历中… ${folders} 个目录`)
      }
    })
    process.stdout.write('\r'.padEnd(40) + '\r')
    console.log(`试运行：遍历 ${walked.folders} 个目录，命中 ${walked.docs.length} 篇文档，未抓正文。`)
    const skipped = Object.entries(walked.skippedByType)
    if (skipped.length > 0) {
      console.log(`按类型跳过：${skipped.map(([k, n]) => `${k}×${n}`).join('  ')}`)
    }
    if (walked.depthCapped > 0) console.log(`因深度上限未展开：${walked.depthCapped} 个目录`)
    console.log('\n前 20 篇：')
    for (const d of walked.docs.slice(0, 20)) console.log(`  ${d.type.padEnd(5)} ${d.path}`)
    process.exit(0)
  }

  const r = await syncKnowledgeBase({
    client,
    sources,
    policy,
    cacheDir: fc.cacheDir,
    force,
    onProgress: (phase, done, total) => {
      if (phase === 'fetch' && (done % 5 === 0 || done === total)) {
        process.stdout.write(`\r  抓取 ${done}/${total}`)
      }
    },
  })
  process.stdout.write('\r'.padEnd(40) + '\r')

  const s = r.stats
  console.log(`同步完成 —— 遍历 ${s.folders} 个目录`)
  console.log(`新增 ${s.added}  更新 ${s.updated}  未变 ${s.unchanged}  失败 ${s.failed}  已删除 ${s.removed}`)
  const skipped = Object.entries(r.manifest.skippedByType)
  if (skipped.length > 0) console.log(`按类型跳过：${skipped.map(([k, n]) => `${k}×${n}`).join('  ')}`)
  console.log(`镜像：${fc.cacheDir}`)

  if (r.failures.length > 0) {
    console.log(`\n抓取失败 ${r.failures.length} 条（前 5 条）：`)
    for (const f of r.failures.slice(0, 5)) console.log(`  · ${f.path}\n    ${f.reason.slice(0, 160)}`)
  }
  if (r.permissionHint) {
    // 只呈现该开的那一个（只读）—— 飞书返回的是「任选其一」的候选集
    console.log('\n⚠️  失败原因是权限不足。')
    console.log(`   要开通的权限：${describeScopes(r.permissionHint.scopes)}`)
    if (r.permissionHint.authLink) console.log(`   申请链接（已指向只读版）：${r.permissionHint.authLink}`)
    console.log('   勾完需发版并等管理员审批，然后重跑本命令。')
    console.log('   失败条目已连同原因记在清单里，下次会自动重试 —— 不必加 --force。')
  }
  process.exit(r.stats.failed > 0 ? 1 : 0)
} catch (e) {
  if (e instanceof FeishuPermissionError) {
    console.error(`\n飞书权限不足。要开通的权限：${e.scopeAdvice}`)
    if (e.authLink) console.error(`申请链接（已指向只读版）：${e.authLink}`)
    process.exit(1)
  }
  console.error(`\n同步失败：${e.message}`)
  process.exit(1)
}
