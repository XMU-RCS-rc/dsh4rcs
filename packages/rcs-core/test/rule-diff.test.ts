/**
 * 规则 diff 的纯逻辑测试 —— 用合成数据，不依赖任何真实规则文件。
 * 这部分逻辑现在就能定型；待补的只有 RuleSource（把官方规则解析成条款）。
 */
import { describe, it, expect } from 'vitest'
import { diffRuleDocuments, UnimplementedRuleSource } from '../src/rule-diff.ts'
import type { RuleDocument } from '../src/rule-diff.ts'

function doc(version: string, clauses: [string, string][]): RuleDocument {
  return {
    competition: 'robocon-cn',
    season: '2026',
    version,
    clauses: clauses.map(([id, text]) => ({ id, text })),
  }
}

describe('diffRuleDocuments', () => {
  it('识别新增、删除、修改与未变', () => {
    const v3 = doc('V3', [
      ['3.1', '机器人启动区尺寸不得超过 1000mm x 1000mm'],
      ['3.2', '气压上限为 0.6MPa'],
      ['3.3', '每队最多两台机器人'],
    ])
    const v4 = doc('V4', [
      ['3.1', '机器人启动区尺寸不得超过 1000mm x 1000mm'],
      ['3.2', '气压上限为 0.5MPa'],
      ['3.4', '新增：重试需在指定区域进行'],
    ])

    const d = diffRuleDocuments(v3, v4)

    expect(d.stats).toEqual({ added: 1, removed: 1, modified: 1, unchanged: 1 })
    expect(d.from.version).toBe('V3')
    expect(d.to.version).toBe('V4')

    const modified = d.changes.find((c) => c.kind === 'modified')
    expect(modified?.clauseId).toBe('3.2')
    expect(modified?.before).toContain('0.6MPa')
    expect(modified?.after).toContain('0.5MPa')
    // 只改了一个数字，相似度应该很高 —— 用来把「实质改写」和「措辞微调」分开
    expect(modified?.similarity).toBeGreaterThan(0.5)

    expect(d.changes.find((c) => c.kind === 'removed')?.clauseId).toBe('3.3')
    expect(d.changes.find((c) => c.kind === 'added')?.clauseId).toBe('3.4')
  })

  it('忽略纯排版空白差异，避免把重新排版误报成实质修改', () => {
    const a = doc('V1', [['1.1', '机器人  质量   不得超过 50kg']])
    const b = doc('V2', [['1.1', '机器人 质量 不得超过 50kg']])
    expect(diffRuleDocuments(a, b).stats.modified).toBe(0)
    expect(diffRuleDocuments(a, b).stats.unchanged).toBe(1)
  })

  it('条款按自然序排列，便于人阅读', () => {
    const a = doc('V1', [])
    const b = doc('V2', [
      ['3.10', 'c'],
      ['3.2', 'a'],
      ['3.9', 'b'],
    ])
    const ids = diffRuleDocuments(a, b).changes.map((c) => c.clauseId)
    expect(ids).toEqual(['3.2', '3.9', '3.10'])
  })
})

describe('UnimplementedRuleSource', () => {
  it('明确报错而不是静默返回空结果', async () => {
    const src = new UnimplementedRuleSource()
    await expect(src.listVersions('2026')).rejects.toThrow(/尚未接入/)
    await expect(src.load('2026', 'V4')).rejects.toThrow(/尚未接入/)
  })
})
