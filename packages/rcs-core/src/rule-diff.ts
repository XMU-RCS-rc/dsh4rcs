/**
 * 规则版本 diff —— **比赛相关内容的接口层，实现待补**。
 *
 * 分工说明（这是本文件存在的意义）：
 *   - `diffRuleDocuments` 是 **纯逻辑**，现在就能实现并测试；
 *   - `RuleSource`（把官方规则文件解析成结构化条款）才是比赛相关的部分，
 *     依赖 2026 年 V1.0~V4 的规则原文与 2027 年尚未公布的新规则，故先留接口。
 *
 * 补充实现时只需新增一个 `RuleSource` 的实现类（如 PdfRuleSource），
 * 不需要改动 diff 逻辑与上层工具。
 */

/** 一条规则条款。 */
export interface RuleClause {
  /** 条款号，如 `3.2.1`。这是溯源的关键，不允许缺失。 */
  id: string
  title?: string
  text: string
}

/** 一份特定版本的规则文档。 */
export interface RuleDocument {
  /** 赛事标识，如 `robocon-cn` / `robocon-abu`。 */
  competition: string
  /** 赛季，如 `2026`。 */
  season: string
  /** 版本，如 `V4`。 */
  version: string
  clauses: RuleClause[]
}

export type RuleChangeKind = 'added' | 'removed' | 'modified'

export interface RuleChange {
  kind: RuleChangeKind
  clauseId: string
  title?: string
  before?: string
  after?: string
  /** 0~1，1 表示完全相同。仅 modified 有值。 */
  similarity?: number
}

export interface RuleDiffResult {
  from: { season: string; version: string }
  to: { season: string; version: string }
  changes: RuleChange[]
  stats: { added: number; removed: number; modified: number; unchanged: number }
}

/** 归一化：去空白差异，避免排版调整被误报成实质修改。 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 取字符二元组集合。 */
function bigrams(text: string): Set<string> {
  const s = text.replace(/\s+/g, '')
  const out = new Set<string>()
  if (s.length === 1) out.add(s)
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
  return out
}

/**
 * 字符二元组 Jaccard 相似度。
 *
 * 这里**刻意不用词级切分**：规则条文以中文为主，中文没有空格词边界，
 * 词级 Jaccard 会把「气压上限为 0.6MPa → 0.5MPa」这种只改一个数字的修订
 * 算成 0.33 的低相似度，从而把「措辞微调」和「实质改写」混为一谈。
 * 字符二元组对中英混排都稳定，且无需分词依赖。
 */
function similarity(a: string, b: string): number {
  const sa = bigrams(a)
  const sb = bigrams(b)
  if (sa.size === 0 && sb.size === 0) return 1
  let inter = 0
  for (const g of sa) if (sb.has(g)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 1 : inter / union
}

/**
 * 对比两份规则文档，按条款号配对。
 * 纯函数，无 IO —— 可用合成数据完整单测。
 */
export function diffRuleDocuments(from: RuleDocument, to: RuleDocument): RuleDiffResult {
  const fromMap = new Map(from.clauses.map((c) => [c.id, c]))
  const toMap = new Map(to.clauses.map((c) => [c.id, c]))
  const changes: RuleChange[] = []
  let unchanged = 0

  for (const [id, oldClause] of fromMap) {
    const newClause = toMap.get(id)
    if (!newClause) {
      changes.push({
        kind: 'removed',
        clauseId: id,
        ...(oldClause.title ? { title: oldClause.title } : {}),
        before: oldClause.text,
      })
    } else if (normalize(oldClause.text) !== normalize(newClause.text)) {
      changes.push({
        kind: 'modified',
        clauseId: id,
        ...(newClause.title ? { title: newClause.title } : {}),
        before: oldClause.text,
        after: newClause.text,
        similarity: similarity(oldClause.text, newClause.text),
      })
    } else {
      unchanged++
    }
  }

  for (const [id, newClause] of toMap) {
    if (!fromMap.has(id)) {
      changes.push({
        kind: 'added',
        clauseId: id,
        ...(newClause.title ? { title: newClause.title } : {}),
        after: newClause.text,
      })
    }
  }

  // 按条款号自然序排，便于人阅读
  changes.sort((a, b) => a.clauseId.localeCompare(b.clauseId, 'zh', { numeric: true }))

  return {
    from: { season: from.season, version: from.version },
    to: { season: to.season, version: to.version },
    changes,
    stats: {
      added: changes.filter((c) => c.kind === 'added').length,
      removed: changes.filter((c) => c.kind === 'removed').length,
      modified: changes.filter((c) => c.kind === 'modified').length,
      unchanged,
    },
  }
}

/**
 * 规则数据源 —— **待实现的接口**。
 *
 * 需要队内补充的内容：
 *   1. 2026 年竞技赛 V1.0 / V2 / V3 / V4 规则原文（robocon.org.cn 下载）
 *   2. 从 PDF/Word 抽取条款号与正文的解析器
 *   3. 2027 年主题公布后的新规则
 */
export interface RuleSource {
  /** 列出某赛季已有的版本，按发布顺序。 */
  listVersions(season: string): Promise<string[]>
  /** 载入指定赛季与版本的规则文档。 */
  load(season: string, version: string): Promise<RuleDocument>
}

/** 数据源尚未接入时的占位实现，明确报错而不是静默返回空结果。 */
export class UnimplementedRuleSource implements RuleSource {
  readonly reason: string

  constructor(reason = '规则数据源尚未接入：需要先准备规则原文与条款解析器') {
    this.reason = reason
  }

  listVersions(_season: string): Promise<string[]> {
    return Promise.reject(new Error(this.reason))
  }

  load(_season: string, _version: string): Promise<RuleDocument> {
    return Promise.reject(new Error(this.reason))
  }
}

/** 用数据源跑一次 diff。数据源就绪后，上层工具无需改动。 */
export async function diffRuleVersions(
  source: RuleSource,
  season: string,
  fromVersion: string,
  toVersion: string,
): Promise<RuleDiffResult> {
  const [from, to] = await Promise.all([
    source.load(season, fromVersion),
    source.load(season, toVersion),
  ])
  return diffRuleDocuments(from, to)
}
