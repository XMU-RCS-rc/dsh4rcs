/**
 * 规则数据的完整性回归测试。
 *
 * 这些断言守的是 `scripts/docx-to-rules.mjs` 的**提取质量**，
 * 而不是检索逻辑。V1 发布后跑同一个脚本，这里能挡住同类回归。
 *
 * 每一条都对应一个实际踩过的坑：
 *   - 11.16 曾被整条丢失（文本框嵌套 <w:p> 导致段落被截断）
 *   - 说明文字曾重复两遍（mc:Fallback 与 mc:Choice 内容相同）
 *   - 正文里曾混入 `020000` / `right765810` 这类图片锚点坐标
 *   - 11.16 在 docx 里没独立成段，需要行内切分才能拆出来
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..', '..')
const DIR = join(REPO, 'data', 'rules', '2027', 'V0')
const ready = existsSync(join(DIR, 'clauses.json'))

type Clause = { id: string; text: string }
const load = () =>
  JSON.parse(readFileSync(join(DIR, 'clauses.json'), 'utf8')) as { clauses: Clause[] }
const text = () => readFileSync(join(DIR, 'rules.txt'), 'utf8')

describe.skipIf(!ready)('2027 V0 规则数据完整性', () => {
  const byId = (id: string) => load().clauses.find((c) => c.id === id)

  it('条款数量在合理区间', () => {
    expect(load().clauses.length).toBeGreaterThan(150)
  })

  it('11.16 必须独立成条 —— 它在 docx 里没独立成段，最容易丢', () => {
    const c = byId('11.16')
    expect(c, '11.16 缺失：检查 docx-to-rules 的行内切分与文本框处理').toBeDefined()
    expect(c?.text).toContain('吸盘')
  })

  it('11.15 不应把 11.16 的内容吞进去', () => {
    expect(byId('11.15')?.text).not.toContain('吸盘')
  })

  it('第 11 节（机器人）条款连续，无断号', () => {
    const ids = load()
      .clauses.map((c) => c.id)
      .filter((id) => /^11\.\d+$/.test(id))
      .map((id) => Number(id.split('.')[1]))
      .sort((a, b) => a - b)
    expect(ids[0]).toBe(1)
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i], `11.${ids[i - 1]!} 之后断号`).toBe(ids[i - 1]! + 1)
    }
  })

  it('正文不含图片锚点坐标噪声', () => {
    const t = text()
    expect(t).not.toContain('right765810')
    expect(t).not.toContain('1455420345440')
    expect(t).not.toMatch(/。0{4,}\d/)
  })

  it('说明文字不重复（mc:Fallback 已剥离）', () => {
    const t = text()
    const marker = '对包装箱尺寸的规定仍然是不合理的'
    const count = t.split(marker).length - 1
    expect(count, '出现多次说明同一段被重复提取').toBe(1)
  })

  it('关键电控约束条款存在且数值正确', () => {
    expect(byId('11.12')?.text).toContain('24V')
    expect(byId('11.13')?.text).toContain('42V')
    expect(byId('11.14')?.text).toContain('600kPa')
    expect(byId('11.7')?.text).toContain('50kg')
    expect(byId('12.2')?.text).toContain('急停')
  })

  it('得分条款存在', () => {
    expect(byId('8.5.1')?.text).toContain('250')
    expect(byId('3.6.1')?.text).toContain('两座全塔')
  })

  it('约束表与条款原文一致', () => {
    const c = JSON.parse(readFileSync(join(DIR, 'constraints.json'), 'utf8'))
    // 约束表是人工提炼的，这里交叉验证它没抄错数
    expect(c.electrical.batteryNominalVoltageMaxV.value).toBe(24)
    expect(c.electrical.circuitMaxVoltageV.value).toBe(42)
    expect(c.pneumatic.maxPressureKPa.value).toBe(600)
    expect(c.robots.massMaxKg.value).toBe(50)
    expect(c.scoring.sacredStone.points).toBe(250)
    expect(c.theme).toBe('女娲补天')

    // 每条约束都要能在原文里找到对应条款
    const ids = new Set(load().clauses.map((x) => x.id))
    for (const clause of [
      c.electrical.batteryNominalVoltageMaxV.clause,
      c.electrical.circuitMaxVoltageV.clause,
      c.pneumatic.maxPressureKPa.clause,
      c.robots.massMaxKg.clause,
      c.safety.emergencyStop.clause,
    ]) {
      expect(ids.has(clause), `约束表引用了不存在的条款 ${clause}`).toBe(true)
    }
  })
})
