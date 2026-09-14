/**
 * 对真实飞书镜像的检索回归 —— 基准是 2026-09-14 在 dsh 里踩到的两件事：
 *
 *   1. 模型写「Keil 下载 安装」这种空格分隔的关键词，整串当一个词找，
 *      结果全都没有片段，模型断定「安装说明只有标题」—— 其实正文就在镜像里。
 *   2. 「量子计算」「急停回路」靠一个二元组命中毫不相干的文档。
 *
 * 镜像在 .gitignore 里（队内资料不进仓库），没有镜像的机器上整组跳过。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { searchKb } from '../src/kb-index.ts'

const KB = join(import.meta.dirname, '..', '..', '..', 'data', 'kb-cache')
const hasMirror = existsSync(join(KB, 'manifest.json'))

describe.skipIf(!hasMirror)('真实镜像检索', () => {
  it('「Keil 下载 安装」：MDK-ARM 下的安装说明排在最前，而且带片段', () => {
    const [first, second] = searchKb(KB, 'Keil 下载 安装')
    for (const h of [first, second]) {
      expect(h?.doc.path).toContain('MDK-ARM')
      expect(h?.snippets.length).toBeGreaterThan(0)
    }
  })

  it('「CAN 总线」带空格也命中 CAN总线入门，并给出片段', () => {
    const [first] = searchKb(KB, 'CAN 总线')
    expect(first?.doc.name).toBe('CAN总线入门')
    expect(first?.snippets.length).toBeGreaterThan(0)
  })

  it('「量子计算」没有命中', () => {
    expect(searchKb(KB, '量子计算')).toEqual([])
  })

  it('「急停回路」不会命中 CAN总线入门', () => {
    expect(searchKb(KB, '急停回路').map((h) => h.doc.name)).not.toContain('CAN总线入门')
  })
})
