/**
 * 规则数据源的文件实现 —— 补上 `rule-diff.ts` 里留的 `RuleSource` 接口。
 *
 * 数据来自 `data/rules/<赛季>/<版本>/clauses.json`，由 `scripts/docx-to-rules.mjs`
 * 从官方 .docx 转换而来。V1 发布后对新文件跑一遍转换即可，本文件不用改。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RuleClause, RuleDocument, RuleSource } from './rule-diff.ts'

/** clauses.json 的磁盘格式。 */
interface ClausesFile {
  competition: string
  season: string
  version: string
  clauses: RuleClause[]
}

/** 版本号排序：V0 < V1 < V1.1 < V2 < V4，且把 abu-* 排在最后。 */
export function compareVersions(a: string, b: string): number {
  const isAbu = (v: string) => (v.toLowerCase().startsWith('abu') ? 1 : 0)
  const abuDiff = isAbu(a) - isAbu(b)
  if (abuDiff !== 0) return abuDiff
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })
}

/**
 * 从目录树读取规则。
 *
 * 目录约定：`<root>/<season>/<version>/clauses.json`
 */
export class JsonRuleSource implements RuleSource {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  private dir(season: string, version: string): string {
    return join(this.root, season, version)
  }

  listVersions(season: string): Promise<string[]> {
    const seasonDir = join(this.root, season)
    if (!existsSync(seasonDir)) {
      return Promise.reject(new Error(`赛季目录不存在：${seasonDir}`))
    }
    const versions = readdirSync(seasonDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(seasonDir, e.name, 'clauses.json')))
      .map((e) => e.name)
      .sort(compareVersions)
    return Promise.resolve(versions)
  }

  load(season: string, version: string): Promise<RuleDocument> {
    const file = join(this.dir(season, version), 'clauses.json')
    if (!existsSync(file)) {
      return Promise.reject(
        new Error(
          `规则文件不存在：${file}\n` +
            `请先用 scripts/docx-to-rules.mjs 从官方 .docx 转换，或核对赛季/版本拼写。`,
        ),
      )
    }
    let parsed: ClausesFile
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as ClausesFile
    } catch (e) {
      return Promise.reject(new Error(`规则文件解析失败：${file}（${String(e)}）`))
    }
    if (!Array.isArray(parsed.clauses) || parsed.clauses.length === 0) {
      return Promise.reject(new Error(`规则文件没有条款：${file}`))
    }
    return Promise.resolve({
      competition: parsed.competition ?? 'robocon-cn',
      season: parsed.season ?? season,
      version: parsed.version ?? version,
      clauses: parsed.clauses,
    })
  }

  /** 列出所有可用赛季。 */
  listSeasons(): string[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  }
}

/** 一条检索命中。 */
export interface ClauseHit {
  clause: RuleClause
  /** 匹配得分，越高越相关。 */
  score: number
  /** 命中的关键词。 */
  matched: string[]
}

/**
 * 在规则文档里检索条款。
 *
 * **刻意只做检索，不做生成。** 规则解读错误的代价是整套方案返工，
 * 所以返回的永远是原文 + 条款号，由人或模型自己判断，工具不替它下结论。
 *
 * 打分规则（简单但够用，且行为可预测）：
 *   - 条款号精确命中 → 极高分，直接置顶
 *   - 正文包含完整查询串 → 高分
 *   - 按字符二元组重合度累加 → 兜底，能容忍中文没有词边界
 */
export function searchClauses(doc: RuleDocument, query: string, limit = 8): ClauseHit[] {
  const q = query.trim()
  if (!q) return []

  // 查询串里出现的条款号，如 "11.14" / "4.6.1"
  const idInQuery = /\b\d+(?:\.\d+)+\b/.exec(q)?.[0]

  const bigrams = (s: string): Set<string> => {
    const t = s.replace(/\s+/g, '')
    const out = new Set<string>()
    for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
    return out
  }
  const qGrams = bigrams(q)

  const hits: ClauseHit[] = []
  for (const clause of doc.clauses) {
    const matched: string[] = []
    let score = 0

    if (idInQuery && clause.id === idInQuery) {
      score += 1000
      matched.push(`条款号 ${idInQuery}`)
    }
    if (clause.text.includes(q)) {
      score += 100
      matched.push(q)
    }
    if (qGrams.size > 0) {
      const cGrams = bigrams(clause.text)
      let overlap = 0
      for (const g of qGrams) if (cGrams.has(g)) overlap++
      score += (overlap / qGrams.size) * 50
    }

    if (score > 5) hits.push({ clause, score, matched })
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}
