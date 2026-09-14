/**
 * 本地镜像的离线检索。
 *
 * **完全不碰网络。** 飞书随时可能不可达或限频，而查资料不该受它牵连 ——
 * 所以检索只读 `data/kb-cache/`，同步失败或没网都不影响查。
 *
 * ## 为什么用字符二元组而不是分词
 *
 * 和 `rule-source.ts` 的检索同源：队内文档是中文，按空格分词几乎切不开
 * （「气动系统压力上限」是一个词还是四个？），词级重合度算出来的分数没有意义。
 * 字符二元组对中文稳定得多，也不需要词典。这条在规则 diff 上验证过：
 * 词级 Jaccard 给「0.6MPa→0.5MPa」只打 0.33 分，二元组能正确识别为小改动。
 *
 * ## 但查询里的空格要认
 *
 * 文档不分词，**查询**要按空白切开：模型检索时习惯写「Keil 下载 安装」这种
 * 空格分隔的关键词。早先整串当一个词去找，原文里当然没有「Keil 下载 安装」
 * 这一串，于是只剩二元组兜底、结果全都没有片段 —— 模型据此断定「这几篇
 * 安装说明只有标题、正文没进镜像」，转头去闯飞书登录页。其实正文就在镜像里，
 * 单查 `Keil` 每篇都有三段片段。所以现在每个关键词各自匹配，命中的词多的排前面。
 *
 * ## 模糊匹配要大部分二元组都对上
 *
 * 二元组兜底只对中文关键词启用，而且这个词的二元组要对上三分之二以上才算。
 * 早先只要分数过门槛：「量子计算」和一篇文档只共有「计算」一个二元组就被
 * 当成命中返回，「急停回路」靠一个「回路」命中了 CAN 总线入门 —— 都没有片段，
 * 看着像「相关但没展开」，其实毫不相干。**误报比漏报更伤。**
 */
import { readFileSync, existsSync } from 'node:fs'

import type { KbDoc, KbManifest } from './kb-sync.ts'
import { loadManifest, docPath } from './kb-sync.ts'

export type KbHit = {
  doc: KbDoc
  score: number
  /** 命中上下文片段，已按出现顺序截取。 */
  snippets: string[]
  /**
   * 命中来源，用于如实说明「为什么这篇被选中」。
   * 没有片段时尤其重要 —— 不能一律说成「标题命中」。
   */
  matchedIn: ('name' | 'path' | 'text' | 'fuzzy')[]
  /** 这篇命中了查询里的哪些关键词（原样，按查询里的顺序）。 */
  terms?: string[]
}

export type KbStatus = {
  ok: boolean
  reason?: string
  syncedAt?: string
  total: number
  /** 抓取失败、正文缺失的条目数。 */
  failed: number
  bytes: number
  sources: { label: string; token: string }[]
  skippedByType: Record<string, number>
}

/** 单篇正文的读取上限。防止某个异常大的文件把检索拖垮。 */
const MAX_DOC_BYTES = 2 * 1024 * 1024

/** 中文关键词靠二元组兜底时，至少要对上这么大比例的二元组才算命中。 */
const FUZZY_MIN_COVERAGE = 2 / 3

function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
  return out
}

/**
 * 取命中位置前后的上下文。中文没有词边界，按字符窗口截最稳。
 *
 * **相邻命中要合并，否则片段会互相包含。** 「CAN总线入门」这种文档开头
 * 密集出现关键词，逐个命中各截一窗，结果是三段内容几乎一样、后一段只比
 * 前一段长一点 —— 既占地方又显得敷衍。所以落在上一窗内的命中直接跳过，
 * 保证每段片段来自文档的不同位置。
 */
export function snippetsAround(
  text: string,
  needle: string,
  max = 3,
  radius = 60,
  ignoreCase = false,
): string[] {
  if (!needle) return []
  // 大小写无关时在折叠副本上找位置，但**截取用原文** —— 展示要保留原始大小写
  const haystack = ignoreCase ? text.toLowerCase() : text
  const target = ignoreCase ? needle.toLowerCase() : needle
  const out: string[] = []
  let from = 0
  let lastEnd = -1
  while (out.length < max) {
    const i = haystack.indexOf(target, from)
    if (i < 0) break
    from = i + needle.length
    // 命中落在上一段窗口里 —— 内容已经展示过，跳过
    if (i < lastEnd) continue
    const start = Math.max(0, i - radius)
    const end = Math.min(text.length, i + needle.length + radius)
    lastEnd = end
    const prefix = start > 0 ? '…' : ''
    const suffix = end < text.length ? '…' : ''
    out.push(`${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`)
  }
  return out
}

/**
 * 多个关键词的片段：先让每个在正文里出现的词各占一段，再按原文顺序补足。
 *
 * 只按原文顺序截，片段会被最早出现、出现最密的那个词占满，别的词明明命中了
 * 却看不到它在哪 —— 读者分不清这篇是真相关还是只沾了一个词。
 * 窗口互不重叠，与 `snippetsAround` 同一条原则：片段不能互相包含。
 */
export function snippetsForTerms(
  text: string,
  needles: readonly { needle: string; ignoreCase: boolean }[],
  max = 3,
  radius = 60,
): string[] {
  const lowered = text.toLowerCase()
  const occurrences = needles.map(({ needle, ignoreCase }) => {
    const found: { at: number; len: number }[] = []
    if (!needle) return found
    const haystack = ignoreCase ? lowered : text
    const target = ignoreCase ? needle.toLowerCase() : needle
    for (let i = haystack.indexOf(target); i >= 0 && found.length < 20; i = haystack.indexOf(target, i + target.length)) {
      found.push({ at: i, len: target.length })
    }
    return found
  })

  const windows: { start: number; end: number }[] = []
  const take = ({ at, len }: { at: number; len: number }): void => {
    if (windows.length >= max) return
    const start = Math.max(0, at - radius)
    const end = Math.min(text.length, at + len + radius)
    if (windows.some((w) => start < w.end && end > w.start)) return
    windows.push({ start, end })
  }
  for (const found of occurrences) if (found[0] !== undefined) take(found[0])
  for (const o of occurrences.flatMap((found) => found.slice(1)).sort((a, b) => a.at - b.at)) take(o)

  return windows
    .sort((a, b) => a.start - b.start)
    .map(({ start, end }) => {
      const prefix = start > 0 ? '…' : ''
      const suffix = end < text.length ? '…' : ''
      return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
    })
}

/** 读一篇正文；缺失或超限返回空串（检索不该因为一篇坏文档整体失败）。 */
export function readDocText(cacheDir: string, token: string): string {
  const p = docPath(cacheDir, token)
  if (!existsSync(p)) return ''
  try {
    const buf = readFileSync(p)
    if (buf.byteLength > MAX_DOC_BYTES) return buf.subarray(0, MAX_DOC_BYTES).toString('utf8')
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

/** 查询里是否含中日韩文字。决定要不要用二元组兜底。 */
function hasCjk(s: string): boolean {
  return /[㐀-鿿豈-﫿]/.test(s)
}

/**
 * 把查询切成关键词：按空白与常见分隔符（，、；,;）切开，去重（拉丁文按大小写无关去重）。
 * 不做中文分词 —— 「气动压力」仍是一个词，交给二元组兜底。
 */
export function queryTerms(query: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of query.split(/[\s,，、;；]+/)) {
    const term = raw.trim()
    if (!term) continue
    const key = hasCjk(term) ? term : term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
  }
  return out
}

/**
 * 检索本地镜像。
 *
 * 查询先切成关键词（见 `queryTerms`），每个词各自打分：
 * 标题精确命中 > 正文精确命中 > 目录名命中 > 二元组重合度。
 * 标题权重高是因为队内文档命名相当规范（「RCSLIB代码规范(Ver 2025/1/17)」
 * 这种），名字往往就是最强的相关性信号。排序先看命中了几个词，再看分数。
 *
 * ## 二元组只对中文启用
 *
 * 中文没有词边界，「气动压力」在原文里可能不连续出现，必须靠字符二元组兜底。
 * 但对**拉丁文查询这套办法会制造垃圾命中**：实测查 `FromISR` 时，
 * 它的二元组 `Fr/ro/om/mI/IS/SR` 在一篇 ESP32 开发指南里凑齐了，
 * 于是那篇被当成命中返回 —— 而全文根本没有 FromISR 这个词。
 *
 * 拉丁文本来就有词边界，精确子串匹配就够用，模糊兜底纯属添乱。
 * 所以只在关键词含中日韩文字时才启用二元组，且要对上三分之二以上（见文件头）。
 * **误报比漏报更伤** —— 这是本仓库反复付过学费的一条。
 */
export function searchKb(cacheDir: string, query: string, limit = 8): KbHit[] {
  const terms = queryTerms(query).map((term) => {
    const cjk = hasCjk(term)
    // 拉丁文大小写无关：FromISR / fromISR 该是一回事
    return { term, cjk, needle: cjk ? term : term.toLowerCase(), grams: cjk ? bigrams(term) : new Set<string>() }
  })
  if (terms.length === 0) return []

  const manifest = loadManifest(cacheDir)
  if (!manifest) return []

  const hits: (KbHit & { matched: number; exact: number })[] = []

  for (const doc of Object.values(manifest.docs)) {
    if (doc.error) continue

    const text = readDocText(cacheDir, doc.token)
    const folded = { name: doc.name.toLowerCase(), path: doc.path.toLowerCase(), text: text.toLowerCase() }
    let nameGrams: Set<string> | undefined
    let textGrams: Set<string> | undefined
    let score = 0
    let exact = 0
    const matchedIn = new Set<KbHit['matchedIn'][number]>()
    const matchedTerms: string[] = []
    const inText: { needle: string; ignoreCase: boolean }[] = []

    for (const t of terms) {
      const name = t.cjk ? doc.name : folded.name
      const path = t.cjk ? doc.path : folded.path
      const body = t.cjk ? text : folded.text
      let hit = false
      if (name.includes(t.needle)) {
        score += 200
        matchedIn.add('name')
        hit = true
      }
      if (path.includes(t.needle)) {
        score += 40
        matchedIn.add('path')
        hit = true
      }
      if (body.includes(t.needle)) {
        score += 100
        matchedIn.add('text')
        inText.push({ needle: t.term, ignoreCase: !t.cjk })
        hit = true
      }
      if (hit) {
        exact++
        matchedTerms.push(t.term)
        continue
      }

      // 只有三个字以上的中文词才兜底：两个字的词只有一个二元组，对上就是原词
      if (t.grams.size < 2) continue
      nameGrams ??= bigrams(doc.name)
      textGrams ??= bigrams(text)
      let inName = 0
      let inAny = 0
      for (const g of t.grams) {
        const n = nameGrams.has(g)
        if (n) inName++
        if (n || textGrams.has(g)) inAny++
      }
      if (inAny / t.grams.size < FUZZY_MIN_COVERAGE) continue
      score += (inName / t.grams.size) * 60 + (inAny / t.grams.size) * 40
      matchedIn.add('fuzzy')
      matchedTerms.push(t.term)
    }

    if (matchedTerms.length === 0) continue
    hits.push({
      doc,
      score,
      snippets: snippetsForTerms(text, inText),
      matchedIn: [...matchedIn],
      terms: matchedTerms,
      matched: matchedTerms.length,
      exact,
    })
  }

  return hits
    .sort((a, b) => b.matched - a.matched || b.exact - a.exact || b.score - a.score)
    .slice(0, limit)
    .map(({ matched: _matched, exact: _exact, ...hit }) => hit)
}

/** 镜像状态。没同步过、同步不完整都要如实说，别让人以为查不到就是没有。 */
export function kbStatus(cacheDir: string): KbStatus {
  const manifest: KbManifest | undefined = loadManifest(cacheDir)
  if (!manifest) {
    return {
      ok: false,
      reason: `本地镜像不存在或已损坏（${cacheDir}）。先跑一次 rcs_kb_sync。`,
      total: 0,
      failed: 0,
      bytes: 0,
      sources: [],
      skippedByType: {},
    }
  }
  const docs = Object.values(manifest.docs)
  const failed = docs.filter((d) => d.error).length
  // manifest 来自磁盘，旧版或手改过的可能缺字段。缺了就不写这个键，不写成 undefined ——
  // dsh 只收无损 JSON，值为 undefined 的键会让整次 rcs_kb_status 判失败。
  return {
    ok: true,
    ...(typeof manifest.syncedAt === 'string' ? { syncedAt: manifest.syncedAt } : {}),
    total: docs.length,
    failed,
    bytes: docs.reduce((n, d) => n + (d.bytes ?? 0), 0),
    sources: manifest.sources ?? [],
    skippedByType: manifest.skippedByType ?? {},
  }
}
