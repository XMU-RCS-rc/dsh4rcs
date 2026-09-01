/**
 * 离线检索测试。
 *
 * 检索是赛场上唯一还能用的那条路径（同步要联网，检索不用），
 * 所以它的失败模式要比同步更保守：坏文档、缺文件、空镜像都不能抛，
 * 只能少给结果。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { searchKb, kbStatus, snippetsAround, readDocText } from '../src/kb-index.ts'
import type { KbManifest } from '../src/kb-sync.ts'
import { DEFAULT_SYNC_POLICY } from '../src/kb-sync.ts'

let dir: string

function seed(docs: { token: string; name: string; path: string; text?: string; error?: string }[]): void {
  mkdirSync(join(dir, 'docs'), { recursive: true })
  const manifest: KbManifest = {
    version: 1,
    syncedAt: '2026-08-29T00:00:00.000Z',
    sources: [{ label: '电控组(通用)', token: 'fA' }],
    policy: DEFAULT_SYNC_POLICY,
    docs: {},
    skippedByType: { file: 803 },
  }
  for (const d of docs) {
    manifest.docs[d.token] = {
      token: d.token,
      name: d.name,
      type: 'docx',
      path: d.path,
      url: `https://x.feishu.cn/docx/${d.token}`,
      modifiedTime: '1000',
      bytes: d.text ? Buffer.byteLength(d.text, 'utf8') : undefined,
      error: d.error,
    }
    if (d.text !== undefined) writeFileSync(join(dir, 'docs', `${d.token}.txt`), d.text, 'utf8')
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rcs-kbi-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('searchKb', () => {
  it('正文命中', () => {
    seed([
      { token: 'd1', name: 'RCSLIB代码规范', path: '电控组/规范', text: '中断服务函数内禁止调用 printf 与 malloc。' },
      { token: 'd2', name: '培训大纲', path: '电控组/培训', text: '第一周：焊接与万用表使用。' },
    ])
    const hits = searchKb(dir, 'printf')
    expect(hits.map((h) => h.doc.token)).toEqual(['d1'])
  })

  it('标题命中权重更高 —— 队内文档命名很规范，名字是最强信号', () => {
    seed([
      { token: 'd1', name: '无关文档', path: 'a', text: '这里提到了代码规范这四个字' },
      { token: 'd2', name: '代码规范', path: 'b', text: '与检索词无关的内容' },
    ])
    const hits = searchKb(dir, '代码规范')
    expect(hits[0]?.doc.token).toBe('d2')
  })

  it('中文靠字符二元组，不需要分词', () => {
    seed([{ token: 'd1', name: 'x', path: 'p', text: '气动系统压力上限为 600kPa' }])
    // 「气动压力」在原文里不连续出现，靠二元组重合仍能命中
    expect(searchKb(dir, '气动压力').length).toBe(1)
  })

  it('拉丁文查询不启用二元组兜底 —— 它只会制造垃圾命中', () => {
    // 实测踩到：查 FromISR 时，其二元组 Fr/ro/om/mI/IS/SR 在一篇
    // ESP32 开发指南里凑齐了，那篇全文根本没有 FromISR，却被当成命中返回。
    seed([
      { token: 'd1', name: 'ESP32开发指南', path: 'p', text: 'From the ISR of ROM, ISR SRAM om mI' },
      { token: 'd2', name: '代码规范', path: 'p', text: '中断里要用 xQueueSendFromISR 变体' },
    ])
    const hits = searchKb(dir, 'FromISR')
    expect(hits.map((h) => h.doc.token)).toEqual(['d2'])
  })

  it('拉丁文查询大小写无关，但片段保留原文大小写', () => {
    seed([{ token: 'd1', name: 'x', path: 'p', text: `${'补'.repeat(80)}xQueueSendFromISR 变体` }])
    const hits = searchKb(dir, 'fromisr')
    expect(hits.length).toBe(1)
    expect(hits[0]?.snippets[0]).toContain('FromISR')
  })

  it('如实记录命中来源，模糊匹配不得冒充标题命中', () => {
    seed([
      { token: 'd1', name: '代码规范', path: 'p', text: '无关' },
      { token: 'd2', name: '无关标题', path: 'p', text: '这里提到代码与规范两件事' },
    ])
    const hits = searchKb(dir, '代码规范')
    expect(hits.find((h) => h.doc.token === 'd1')?.matchedIn).toContain('name')
    const fuzzy = hits.find((h) => h.doc.token === 'd2')
    if (fuzzy) expect(fuzzy.matchedIn).not.toContain('name')
  })

  it('返回带上下文的片段', () => {
    seed([{ token: 'd1', name: 'x', path: 'p', text: `${'前'.repeat(100)}急停按钮${'后'.repeat(100)}` }])
    const hits = searchKb(dir, '急停按钮')
    expect(hits[0]?.snippets[0]).toContain('急停按钮')
    expect(hits[0]?.snippets[0]?.startsWith('…')).toBe(true)
  })

  it('抓取失败的文档不参与检索 —— 它没有正文', () => {
    seed([{ token: 'd1', name: '权限不足的文档', path: 'p', error: '权限不足' }])
    expect(searchKb(dir, '权限')).toEqual([])
  })

  it('正文文件缺失不抛异常，只是少给结果', () => {
    seed([{ token: 'd1', name: '标题里有急停', path: 'p' }])
    const hits = searchKb(dir, '急停')
    expect(hits.length).toBe(1)
    expect(hits[0]?.snippets).toEqual([])
  })

  it('镜像不存在时返回空数组而不是抛', () => {
    expect(searchKb(dir, '任意')).toEqual([])
  })

  it('空查询返回空', () => {
    seed([{ token: 'd1', name: 'x', path: 'p', text: 'y' }])
    expect(searchKb(dir, '   ')).toEqual([])
  })

  it('limit 生效', () => {
    seed(
      Array.from({ length: 12 }, (_, i) => ({
        token: `d${i}`, name: `文档${i}`, path: 'p', text: '共同关键词 急停',
      })),
    )
    expect(searchKb(dir, '急停', 5).length).toBe(5)
  })
})

describe('kbStatus', () => {
  it('没同步过时明确说明，并指出下一步', () => {
    const s = kbStatus(dir)
    expect(s.ok).toBe(false)
    expect(s.reason).toContain('rcs_kb_sync')
  })

  it('汇报总数、失败数与授权范围', () => {
    seed([
      { token: 'd1', name: 'a', path: 'p', text: '内容' },
      { token: 'd2', name: 'b', path: 'p', error: '权限不足' },
    ])
    const s = kbStatus(dir)
    expect(s.ok).toBe(true)
    expect(s.total).toBe(2)
    expect(s.failed).toBe(1)
    expect(s.sources[0]?.label).toBe('电控组(通用)')
  })

  it('保留按类型跳过的统计，让人知道没同步的去哪了', () => {
    seed([{ token: 'd1', name: 'a', path: 'p', text: 'x' }])
    expect(kbStatus(dir).skippedByType['file']).toBe(803)
  })
})

describe('snippetsAround', () => {
  it('多处命中各取一段，受上限约束', () => {
    const text = Array.from({ length: 6 }, (_, i) => `${'x'.repeat(30)}目标${i}`).join('')
    expect(snippetsAround(text, '目标', 3).length).toBe(3)
  })

  it('没命中返回空', () => {
    expect(snippetsAround('abc', '目标')).toEqual([])
  })

  it('密集命中要合并，不能给出互相包含的片段', () => {
    // 实测踩到：「CAN总线入门」开头连续出现 3 次关键词，
    // 逐个截窗得到的三段几乎一样，后一段只比前一段长一点。
    const text = 'CAN总线入门 学习目标 掌握STM32如何接入CAN总线 了解CAN总线如何实现多机通信'
    const out = snippetsAround(text, 'CAN总线', 3, 60)
    expect(out.length).toBe(1)
  })

  it('相隔够远的命中仍然各给一段', () => {
    const text = `目标${'填'.repeat(400)}目标${'充'.repeat(400)}目标`
    expect(snippetsAround(text, '目标', 3, 60).length).toBe(3)
  })

  it('片段之间不得互相包含', () => {
    const text = `目标 甲${'x'.repeat(300)}目标 乙${'y'.repeat(300)}目标 丙`
    const out = snippetsAround(text, '目标', 3, 40)
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]?.replaceAll('…', '') ?? ''
      const cur = out[i]?.replaceAll('…', '') ?? ''
      expect(cur.includes(prev)).toBe(false)
      expect(prev.includes(cur)).toBe(false)
    }
  })

  it('空 needle 返回空而不是死循环', () => {
    expect(snippetsAround('abc', '')).toEqual([])
  })
})

describe('readDocText', () => {
  it('文件不存在返回空串', () => {
    expect(readDocText(dir, 'nope')).toBe('')
  })
})
