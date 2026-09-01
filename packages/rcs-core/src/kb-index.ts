/**
 * 本地镜像的离线检索。
 *
 * **完全不碰网络。** 赛场上飞书大概率不可达，而这时最需要查资料 ——
 * 所以检索只读 `data/kb-cache/`，同步失败或没网都不影响查。
 *
 * ## 为什么用字符二元组而不是分词
 *
 * 和 `rule-source.ts` 的检索同源：队内文档是中文，按空格分词几乎切不开
 * （「气动系统压力上限」是一个词还是四个？），词级重合度算出来的分数没有意义。
 * 字符二元组对中文稳定得多，也不需要词典。这条在规则 diff 上验证过：
 * 词级 Jaccard 给「0.6MPa→0.5MPa」只打 0.33 分，二元组能正确识别为小改动。
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
  return /[㐀-鿿豈-﫿]/.test(s)
}

/**
 * 检索本地镜像。
 *
 * 打分：标题精确命中 > 正文精确命中 > 二元组重合度。
 * 标题权重高是因为队内文档命名相当规范（「RCSLIB代码规范(Ver 2025/1/17)」
 * 这种），名字往往就是最强的相关性信号。
 *
 * ## 二元组只对中文启用
 *
 * 中文没有词边界，「气动压力」在原文里可能不连续出现，必须靠字符二元组兜底。
 * 但对**拉丁文查询这套办法会制造垃圾命中**：实测查 `FromISR` 时，
 * 它的二元组 `Fr/ro/om/mI/IS/SR` 在一篇 ESP32 开发指南里凑齐了，
 * 于是那篇被当成命中返回 —— 而全文根本没有 FromISR 这个词。
 *
 * 拉丁文本来就有词边界，精确子串匹配就够用，模糊兜底纯属添乱。
 * 所以只在查询含中日韩文字时才启用二元组。
 * **误报比漏报更伤** —— 这是本仓库反复付过学费的一条。
 */
export function searchKb(cacheDir: string, query: string, limit = 8): KbHit[] {
  const q = query.trim()
  if (!q) return []

  const manifest = loadManifest(cacheDir)
  if (!manifest) return []

  // 拉丁文查询做大小写无关匹配：FromISR / fromISR 该是一回事
  const cjk = hasCjk(q)
  const needle = cjk ? q : q.toLowerCase()
  const fold = (s: string): string => (cjk ? s : s.toLowerCase())
  const qGrams = cjk ? bigrams(q) : new Set<string>()

  const hits: KbHit[] = []

  for (const doc of Object.values(manifest.docs)) {
    if (doc.error) continue

    const text = readDocText(cacheDir, doc.token)
    let score = 0
    const matchedIn: KbHit['matchedIn'] = []

    if (fold(doc.name).includes(needle)) {
      score += 200
      matchedIn.push('name')
    }
    if (fold(doc.path).includes(needle)) {
      score += 40
      matchedIn.push('path')
    }
    if (fold(text).includes(needle)) {
      score += 100
      matchedIn.push('text')
    }

    if (qGrams.size > 0) {
      const nameGrams = bigrams(doc.name)
      let nameOverlap = 0
      for (const g of qGrams) if (nameGrams.has(g)) nameOverlap++
      let fuzzy = (nameOverlap / qGrams.size) * 60

      if (text) {
        const textGrams = bigrams(text)
        let overlap = 0
        for (const g of qGrams) if (textGrams.has(g)) overlap++
        fuzzy += (overlap / qGrams.size) * 40
      }
      if (fuzzy > 0) {
        score += fuzzy
        if (matchedIn.length === 0) matchedIn.push('fuzzy')
      }
    }

    if (score > 8) {
      hits.push({ doc, score, snippets: snippetsAround(text, needle, 3, 60, !cjk), matchedIn })
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
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
  return {
    ok: true,
    syncedAt: manifest.syncedAt,
    total: docs.length,
    failed,
    bytes: docs.reduce((n, d) => n + (d.bytes ?? 0), 0),
    sources: manifest.sources,
    skippedByType: manifest.skippedByType ?? {},
  }
}
