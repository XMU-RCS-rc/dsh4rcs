/**
 * 规则数据源与检索测试 —— 断言对着**真实的 2027 V0 规则数据**。
 *
 * 这些断言同时起到回归作用：V1 发布后若有人误改了 V0 数据，这里会红。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { JsonRuleSource, compareVersions, searchClauses } from '../src/rule-source.ts'
import { diffRuleDocuments } from '../src/rule-diff.ts'
import { loadConstraints, checkDesign, extractQuantities } from '../src/rule-check.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')
const RULES = join(REPO, 'data', 'rules')
const V0 = join(RULES, '2027', 'V0', 'clauses.json')
const hasRules = existsSync(V0)

describe('compareVersions', () => {
  it('按自然序排，abu 版排在最后', () => {
    const sorted = ['V4', 'abu-2027', 'V0', 'V10', 'V2'].sort(compareVersions)
    expect(sorted).toEqual(['V0', 'V2', 'V4', 'V10', 'abu-2027'])
  })
})

describe('extractQuantities', () => {
  it('抽取并归一化电压/气压/重量/尺寸', () => {
    const q = extractQuantities('用 24V 电池，气压 0.8MPa，整机 55kg，展开 1500mm')
    const find = (u: string) => q.filter((x) => x.unit === u)

    expect(find('V')[0]?.value).toBe(24)
    expect(find('kPa')[0]?.value).toBe(800) // MPa → kPa
    expect(find('kg')[0]?.value).toBe(55)
    expect(find('mm')[0]?.value).toBe(1500)
  })

  it('bar 与 cm 也能归一化', () => {
    const q = extractQuantities('6bar 气源，行程 80cm')
    expect(q.find((x) => x.unit === 'kPa')?.value).toBe(600)
    expect(q.find((x) => x.unit === 'mm')?.value).toBe(800)
  })

  it('保留上下文，便于人判断这个数说的是什么', () => {
    const q = extractQuantities('电池标称电压 24V')
    expect(q[0]?.context).toContain('电池')
  })
})

describe.skipIf(!hasRules)('JsonRuleSource 对真实 2027 V0', () => {
  const source = new JsonRuleSource(RULES)

  it('列出赛季与版本', async () => {
    expect(source.listSeasons()).toContain('2027')
    expect(await source.listVersions('2027')).toContain('V0')
  })

  it('载入 V0 并带齐元信息', async () => {
    const doc = await source.load('2027', 'V0')
    expect(doc.season).toBe('2027')
    expect(doc.version).toBe('V0')
    expect(doc.clauses.length).toBeGreaterThan(100)
  })

  it('缺失版本报出可操作的错误，而不是静默返回空', async () => {
    await expect(source.load('2027', 'V99')).rejects.toThrow(/规则文件不存在/)
    await expect(source.listVersions('1999')).rejects.toThrow(/赛季目录不存在/)
  })

  it('同版本自比得 0 差异', async () => {
    const doc = await source.load('2027', 'V0')
    const d = diffRuleDocuments(doc, doc)
    expect(d.stats.added).toBe(0)
    expect(d.stats.removed).toBe(0)
    expect(d.stats.modified).toBe(0)
    expect(d.stats.unchanged).toBe(doc.clauses.length)
  })
})

describe.skipIf(!hasRules)('searchClauses 对真实 2027 V0', () => {
  const source = new JsonRuleSource(RULES)

  it('查"气压"命中 11.14，且返回原文', async () => {
    const doc = await source.load('2027', 'V0')
    const hits = searchClauses(doc, '气压上限')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.clause.id === '11.14')).toBe(true)
    const c = hits.find((h) => h.clause.id === '11.14')
    expect(c?.clause.text).toContain('600kPa')
  })

  it('查"急停"命中 12.2', async () => {
    const doc = await source.load('2027', 'V0')
    const hits = searchClauses(doc, '急停按钮')
    expect(hits.some((h) => h.clause.id === '12.2')).toBe(true)
  })

  it('直接给条款号能精确置顶', async () => {
    const doc = await source.load('2027', 'V0')
    const hits = searchClauses(doc, '11.12')
    expect(hits[0]?.clause.id).toBe('11.12')
    expect(hits[0]?.clause.text).toContain('24V')
  })

  it('空查询返回空，不抛', () => {
    expect(searchClauses({ competition: 'x', season: '2027', version: 'V0', clauses: [] }, '')).toEqual([])
  })
})

describe.skipIf(!hasRules)('checkDesign 对真实约束', () => {
  const c = loadConstraints(join(RULES, '2027', 'V0', 'constraints.json'))

  it('约束表加载正确', () => {
    expect(c.theme).toBe('女娲补天')
    expect(c.electrical.batteryNominalVoltageMaxV.value).toBe(24)
    expect(c.pneumatic.maxPressureKPa.value).toBe(600)
  })

  it('超压与超重都能查出，并带条款号', () => {
    const r = checkDesign('气动系统工作在 0.8MPa，整机重量约 55kg，配红色急停按钮', c)
    const rules = r.findings.map((f) => f.rule)
    expect(rules).toContain('pressure-over')
    expect(rules).toContain('mass-over')
    expect(r.findings.find((f) => f.rule === 'pressure-over')?.detail).toContain('11.14')
    expect(r.ok).toBe(false)
  })

  it('合规描述不报 error', () => {
    const r = checkDesign(
      '采用 24V 锂电池，气压 500kPa，整机 45kg，配备清晰可见的红色急停按钮，BR 全自动运行',
      c,
    )
    expect(r.findings.filter((f) => f.severity === 'error')).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('48V 触发电路电压上限（42V）而非仅电池上限', () => {
    const r = checkDesign('驱动器母线 48V，含急停', c)
    expect(r.findings.some((f) => f.rule === 'voltage-over-circuit')).toBe(true)
  })

  it('30V 落在 24~42V 之间，给警告而不是直接判违规', () => {
    const r = checkDesign('中间电路 30V，含急停', c)
    const f = r.findings.find((x) => x.rule === 'voltage-over-battery')
    expect(f?.severity).toBe('warn')
  })

  it('飞行机构与 BR 手动都判 error', () => {
    const a = checkDesign('用无人机把塔顶投放到 L2，含急停', c)
    expect(a.findings.some((f) => f.rule === 'aerial-forbidden')).toBe(true)

    const b = checkDesign('BR 由操作手遥控完成建塔，含急停', c)
    expect(b.findings.some((f) => f.rule === 'br-must-be-auto')).toBe(true)
  })

  it('没提急停时给出提醒', () => {
    const r = checkDesign('24V 电池，气压 500kPa', c)
    expect(r.findings.some((f) => f.rule === 'estop-missing')).toBe(true)
  })

  it('所有结论都带条款号与免责提示', () => {
    const r = checkDesign('气压 0.9MPa', c)
    for (const f of r.findings) {
      expect(f.detail).toMatch(/条款 [\d.\/]+/)
      expect(f.detail).toContain('以官方规则手册为准')
    }
  })
})

describe.skipIf(!hasRules)('BR 全自动检查 —— 防误报专项', () => {
  const c = loadConstraints(join(RULES, '2027', 'V0', 'constraints.json'))
  const hit = (t: string) => checkDesign(t, c).findings.some((f) => f.rule === 'br-must-be-auto')

  it('TR 手动是规则允许的（11.2），不得误报', () => {
    // 这是实跑时抓到的真实误报：早期版本只看「全文同时出现 BR 与手动」，
    // 于是「BR 全自动，TR 手动遥控」这种完全合规的描述会被判违规。
    expect(hit('24V 供电，气压 0.6MPa，整机 45kg，红色急停按钮，BR 全自动，TR 手动遥控')).toBe(false)
  })

  it('BR 明确写了全自动，不报', () => {
    expect(hit('BR 全自动建塔，含急停')).toBe(false)
  })

  it('同一小句里既有 BR 又有 TR 时不报 —— 无法判断手动说的是谁', () => {
    expect(hit('TR和BR都由同一套遥控器管理，含急停')).toBe(false)
  })

  it('BR 被遥控要报', () => {
    expect(hit('BR 由操作手遥控完成建塔，含急停')).toBe(true)
  })

  it('用中文名「建筑机器人」同样能识别', () => {
    expect(hit('建筑机器人用手柄控制，含急停')).toBe(true)
  })

  it('报错时回显命中的那一小句，便于人工核对', () => {
    const f = checkDesign('BR 由操作手遥控完成建塔，含急停', c).findings.find(
      (x) => x.rule === 'br-must-be-auto',
    )
    expect(f?.message).toContain('操作手遥控')
    expect(f?.detail).toContain('11.3')
  })
})
