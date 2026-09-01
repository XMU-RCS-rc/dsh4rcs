/**
 * 飞书知识库同步 —— 把授权范围内的文档拉成本地镜像。
 *
 * ## 为什么要本地镜像
 *
 * 赛场网络差、飞书随时可能不可达，而规则与知识检索恰恰在赛场最需要。
 * 所以**同步与检索必须解耦**：同步是偶尔跑一次的联网操作，检索永远走本地
 * 镜像。这是硬要求，不是性能优化。
 *
 * ## 为什么白名单是这一层的核心
 *
 * 实测（2026-08-29）：应用凭 tenant_access_token 已经能读到整个共享文件夹
 * 「RCS16 RC资料库」的根目录，**没有任何人给它授权** —— 共享文件夹对组织内
 * 身份默认可读。也就是说飞书侧的资源隔离在这里不成立，范围收敛只能落在
 * 我们自己这一层。
 *
 * `AllowlistGuard` 把这条约束做成**出网前的断言**而不只是遍历的结构性质：
 * 任何取正文的调用都要先过 `assert()`，越界直接抛。这样即便将来有人加了
 * 一条"顺手再取一篇"的代码路径，也会当场炸掉而不是安静地多拉一篇。
 *
 * 要诚实地说清楚这道屏障的强度：它防的是**我们自己写错代码**，
 * 防不住**有人拿着 app_secret 直接调 API**。真正的修复在飞书那边。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { FeishuClient, DriveNode } from './feishu.ts'
import { FeishuPermissionError } from './feishu.ts'

export type KbSource = {
  kind: string
  label: string
  token: string
  owner?: string
}

export type SyncPolicy = {
  /** 只允许遍历 sources 子树。恒为 true —— 留字段是为了让配置显式表态。 */
  allowlistOnly: boolean
  /** 会被抓正文的类型。 */
  includeTypes: string[]
  /** 明确跳过的类型（安装包、快捷方式等）。 */
  excludeTypes: string[]
  /** 目录递归深度上限，防环也防意外的超大树。 */
  maxDepth: number
}

export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  allowlistOnly: true,
  includeTypes: ['docx', 'doc'],
  excludeTypes: ['file', 'shortcut', 'bitable', 'mindnote', 'slides'],
  maxDepth: 6,
}

/** 镜像里的一篇文档。 */
export type KbDoc = {
  token: string
  name: string
  type: string
  /** 人类可读的目录路径，如 `A02 电控组(通用)/模板代码/xxx`。仅供展示。 */
  path: string
  url?: string
  modifiedTime?: string
  /** 正文字节数。抓取失败时缺省。 */
  bytes?: number
  syncedAt?: string
  /** 抓取失败的原因。失败的条目**保留在清单里**，否则下次同步会当作新文档反复重试且无人知晓。 */
  error?: string
}

export type KbManifest = {
  version: 1
  syncedAt: string
  sources: { label: string; token: string }[]
  policy: SyncPolicy
  /** token → 文档。用 token 作键是因为它稳定，而名字会改。 */
  docs: Record<string, KbDoc>
  /** 遍历时按类型跳过的计数，让人知道"没同步的那些去哪了"。 */
  skippedByType: Record<string, number>
}

export type SyncStats = {
  added: number
  updated: number
  unchanged: number
  failed: number
  removed: number
  /** 遍历过的目录数。 */
  folders: number
}

export type SyncResult = {
  manifest: KbManifest
  stats: SyncStats
  /** 抓取失败的条目，供上层提示。 */
  failures: { name: string; path: string; reason: string }[]
  /** 权限类失败单独拎出来 —— 处理方式是去开权限，不是重试。 */
  permissionHint?: { scopes: string[]; authLink?: string }
}

/**
 * 白名单守卫。
 *
 * 只有从 sources 根出发、经过遍历发现的 token 才会被 `admit`；
 * 取正文前必须 `assert`。越界就是编程错误，直接抛。
 */
export class AllowlistGuard {
  readonly #allowed = new Set<string>()
  readonly #roots: string[]

  constructor(roots: string[]) {
    this.#roots = [...roots]
    for (const r of roots) this.#allowed.add(r)
  }

  /** 遍历中发现的、位于白名单子树内的节点。 */
  admit(token: string): void {
    this.#allowed.add(token)
  }

  has(token: string): boolean {
    return this.#allowed.has(token)
  }

  get size(): number {
    return this.#allowed.size
  }

  assert(token: string, what: string): void {
    if (this.#allowed.has(token)) return
    throw new Error(
      `白名单越界：拒绝访问 ${what}（token=${token}）。\n` +
        `授权范围只有这些根目录：${this.#roots.join(', ')}。\n` +
        '这不是配置问题而是代码问题 —— 取正文前必须先经过遍历发现该节点。',
    )
  }
}

/** 遍历结果里的一个节点，带人类可读路径。 */
export type WalkedNode = DriveNode & { path: string; depth: number }

export type WalkResult = {
  /** 命中 includeTypes 的文档节点。 */
  docs: WalkedNode[]
  /** 按类型统计被跳过的数量。 */
  skippedByType: Record<string, number>
  folders: number
  /** 因深度上限而未展开的目录数。 */
  depthCapped: number
}

/**
 * 从 sources 出发广度遍历，只收集白名单子树内、且类型在 includeTypes 里的节点。
 *
 * 刻意**不跟随 shortcut**：快捷方式指向别处，跟过去就出了白名单子树。
 * 它们默认也在 excludeTypes 里，这里再挡一次 —— 越界是安全边界，值得双保险。
 */
export async function walkAllowlist(
  client: FeishuClient,
  sources: KbSource[],
  policy: SyncPolicy,
  guard: AllowlistGuard,
  onProgress?: (folders: number, docs: number) => void,
): Promise<WalkResult> {
  const docs: WalkedNode[] = []
  const skippedByType: Record<string, number> = {}
  let folders = 0
  let depthCapped = 0

  const seen = new Set<string>(sources.map((s) => s.token))
  const queue: { token: string; path: string; depth: number }[] = sources.map((s) => ({
    token: s.token,
    path: s.label,
    depth: 0,
  }))

  while (queue.length > 0) {
    const cur = queue.shift()
    if (!cur) break
    folders++

    let pageToken: string | undefined
    do {
      const page = await client.listFolder(cur.token, pageToken)
      pageToken = page.hasMore ? page.nextPageToken : undefined

      for (const f of page.files) {
        // 先入白名单：它确实是从授权根走下来的
        guard.admit(f.token)
        const path = `${cur.path}/${f.name}`

        if (f.type === 'folder') {
          if (cur.depth + 1 > policy.maxDepth) {
            depthCapped++
            continue
          }
          if (seen.has(f.token)) continue
          seen.add(f.token)
          queue.push({ token: f.token, path, depth: cur.depth + 1 })
          continue
        }

        // shortcut 指向白名单之外，永不跟随
        if (f.type === 'shortcut' || policy.excludeTypes.includes(f.type)) {
          skippedByType[f.type] = (skippedByType[f.type] ?? 0) + 1
          continue
        }
        if (!policy.includeTypes.includes(f.type)) {
          skippedByType[f.type] = (skippedByType[f.type] ?? 0) + 1
          continue
        }

        docs.push({ ...f, path, depth: cur.depth + 1 })
      }
    } while (pageToken)

    onProgress?.(folders, docs.length)
  }

  return { docs, skippedByType, folders, depthCapped }
}

const MANIFEST = 'manifest.json'
const DOCS_DIR = 'docs'

export function manifestPath(cacheDir: string): string {
  return join(cacheDir, MANIFEST)
}

/**
 * 正文落盘用 `docs/<token>.txt` 这种**扁平**结构，不镜像目录树。
 *
 * 不是图省事：队内真的有个目录叫「硬件/软件培训知识体系」，名字里带斜杠。
 * 按路径建目录会当场炸掉，或更糟 —— 在某些平台上悄悄写到别处去。
 * token 是稳定且文件系统安全的，人类可读的路径存在 manifest 里。
 */
export function docPath(cacheDir: string, token: string): string {
  return join(cacheDir, DOCS_DIR, `${token}.txt`)
}

export function loadManifest(cacheDir: string): KbManifest | undefined {
  const p = manifestPath(cacheDir)
  if (!existsSync(p)) return undefined
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as KbManifest
    return m.version === 1 && m.docs ? m : undefined
  } catch {
    // 清单损坏就当没有 —— 下次同步会重建，比抛错卡住整个检索好。
    return undefined
  }
}

export type SyncOptions = {
  client: FeishuClient
  sources: KbSource[]
  policy: SyncPolicy
  cacheDir: string
  /** 忽略增量判断，全量重抓。 */
  force?: boolean
  now?: () => Date
  onProgress?: (phase: string, done: number, total: number) => void
}

/**
 * 执行一次同步。
 *
 * 增量策略：`modified_time` 与上次一致、且正文文件还在，就跳过抓取。
 * 这是飞书返回的唯一可靠变更信号；内容哈希要抓下来才能算，起不到省流量的作用。
 */
export async function syncKnowledgeBase(options: SyncOptions): Promise<SyncResult> {
  const { client, sources, policy, cacheDir, force = false } = options
  const now = options.now ?? (() => new Date())

  if (sources.length === 0) {
    throw new Error(
      '没有配置任何同步来源。请在 config/team.json 的 feishu.sources 里列出授权目录 —— ' +
        '这份清单就是授权范围本身，空的意味着什么都不该同步。',
    )
  }
  if (!policy.allowlistOnly) {
    throw new Error(
      'feishu.sync.allowlistOnly 必须为 true。飞书侧对该共享文件夹没有做到目录级隔离，' +
        '本地白名单是唯一的范围屏障，关掉它等于把全队资料纳入同步范围。',
    )
  }

  const guard = new AllowlistGuard(sources.map((s) => s.token))
  const walked = await walkAllowlist(client, sources, policy, guard, (folders, docs) =>
    options.onProgress?.('walk', folders, docs),
  )

  const previous = loadManifest(cacheDir)
  const prevDocs = previous?.docs ?? {}

  mkdirSync(join(cacheDir, DOCS_DIR), { recursive: true })

  const docs: Record<string, KbDoc> = {}
  const failures: SyncResult['failures'] = []
  let permissionHint: SyncResult['permissionHint']
  const stats: SyncStats = {
    added: 0, updated: 0, unchanged: 0, failed: 0, removed: 0, folders: walked.folders,
  }

  let done = 0
  for (const node of walked.docs) {
    done++
    options.onProgress?.('fetch', done, walked.docs.length)

    const prev = prevDocs[node.token]
    const unchanged =
      !force &&
      prev !== undefined &&
      prev.error === undefined &&
      prev.modifiedTime === node.modifiedTime &&
      existsSync(docPath(cacheDir, node.token))

    if (unchanged) {
      // 名字/路径可能变了，元信息照样更新，只是不重抓正文
      docs[node.token] = { ...prev, name: node.name, path: node.path, url: node.url }
      stats.unchanged++
      continue
    }

    // 出网前的硬断言 —— 白名单越界在这里当场炸掉
    guard.assert(node.token, `${node.type} 「${node.name}」`)

    try {
      const text =
        node.type === 'docx'
          ? await client.docxRawContent(node.token)
          : await client.legacyDocContent(node.token)

      writeFileSync(docPath(cacheDir, node.token), text, 'utf8')
      docs[node.token] = {
        token: node.token,
        name: node.name,
        type: node.type,
        path: node.path,
        url: node.url,
        modifiedTime: node.modifiedTime,
        bytes: Buffer.byteLength(text, 'utf8'),
        syncedAt: now().toISOString(),
      }
      if (prev === undefined) stats.added++
      else stats.updated++
    } catch (e) {
      const err = e as Error
      stats.failed++
      failures.push({ name: node.name, path: node.path, reason: err.message })
      // 失败条目保留在清单里，附上原因 —— 悄悄消失比报错更危险
      docs[node.token] = {
        token: node.token,
        name: node.name,
        type: node.type,
        path: node.path,
        url: node.url,
        modifiedTime: node.modifiedTime,
        error: err.message,
      }
      if (e instanceof FeishuPermissionError && !permissionHint) {
        permissionHint = { scopes: e.scopes, authLink: e.authLink }
      }
    }
  }

  // 飞书那边删掉的文档，本地镜像也要删 —— 否则检索会返回已不存在的内容
  for (const token of Object.keys(prevDocs)) {
    if (docs[token]) continue
    stats.removed++
    rmSync(docPath(cacheDir, token), { force: true })
  }

  const manifest: KbManifest = {
    version: 1,
    syncedAt: now().toISOString(),
    sources: sources.map((s) => ({ label: s.label, token: s.token })),
    policy,
    docs,
    skippedByType: walked.skippedByType,
  }
  writeFileSync(manifestPath(cacheDir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return { manifest, stats, failures, permissionHint }
}
