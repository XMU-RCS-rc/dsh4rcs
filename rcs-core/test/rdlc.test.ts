/**
 * RDLC 解析测试。
 *
 * **基准不是我手写的。** `fixtures/rdlc-vectors.json` 由队内上位机
 * `upper_host_cli/rdlc_cli.py` 生成，它与下位机 `RCS_Support/src/rdlc.c`
 * 是同一协议的两份独立实现。拿它当基准，等于让本模块与队内既有实现对齐，
 * 而不是与我对协议的理解对齐 —— 后者出错时没人会发现。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  crc16Modbus, decodeRdlcStream, decodeRdlcPayload, decodeRdlc, parseHexBytes,
  RDLC_HEAD, RDLC_TAIL, UPPER_ADDRESS, LOWER_ADDRESS, MSG_COMMAND, MSG_FEEDBACK,
} from '../src/rdlc.ts'

type Vector = {
  kind: string
  seq?: number
  module?: number
  operation?: number
  data?: number[]
  frame: number[]
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'rdlc-vectors.json'), 'utf8'),
) as { crc_probe: number; vectors: Vector[] }

describe('crc16Modbus', () => {
  it('标准校验值：crc16("123456789") === 0x4B37', () => {
    expect(crc16Modbus(new TextEncoder().encode('123456789'))).toBe(0x4b37)
  })

  it('与队内 Python 实现算出的值一致', () => {
    expect(fixture.crc_probe).toBe(0x4b37)
  })

  it('空输入返回初值 0xFFFF', () => {
    expect(crc16Modbus(new Uint8Array())).toBe(0xffff)
  })
})

describe('对队内 Python 实现生成的真实帧', () => {
  it('夹具里有命令帧和反馈帧', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(4)
    expect(fixture.vectors.some((v) => v.kind === 'command')).toBe(true)
    expect(fixture.vectors.some((v) => v.kind === 'feedback')).toBe(true)
  })

  it('每一条向量都能解出且只解出一帧', () => {
    for (const v of fixture.vectors) {
      const r = decodeRdlcStream(v.frame)
      expect(r.errors, `向量 ${v.kind} 不该报错`).toEqual([])
      expect(r.frames.length, `向量 ${v.kind} 应解出 1 帧`).toBe(1)
    }
  })

  it('命令帧的 sequence/module/operation/data 与生成时一致', () => {
    for (const v of fixture.vectors.filter((x) => x.kind === 'command')) {
      const { decoded } = decodeRdlc(v.frame)
      const p = decoded[0]?.payload
      expect(p?.kind).toBe('command')
      if (p?.kind !== 'command') continue
      expect(p.sequence).toBe(v.seq)
      expect(p.module).toBe(v.module)
      expect(p.operation).toBe(v.operation)
      expect(p.data).toEqual(v.data)
    }
  })

  it('命令帧方向是「上位机 → 下位机」', () => {
    const v = fixture.vectors.find((x) => x.kind === 'command')!
    const { decoded } = decodeRdlc(v.frame)
    expect(decoded[0]?.direction).toBe('上位机 → 下位机')
    expect(decoded[0]?.frame.src).toBe(UPPER_ADDRESS)
    expect(decoded[0]?.frame.dst).toBe(LOWER_ADDRESS)
  })

  it('反馈帧能解出 status / echo / report', () => {
    const v = fixture.vectors.find((x) => x.kind === 'feedback')!
    const { decoded } = decodeRdlc(v.frame)
    const p = decoded[0]?.payload
    expect(p?.kind).toBe('feedback')
    if (p?.kind !== 'feedback') return
    expect(p.echo).toEqual([9, 8, 7])
    expect(p.report).toEqual([0xaa, 0xbb])
    expect(p.statusName).toBe('BAD_MODULE')
    expect(decoded[0]?.direction).toBe('下位机 → 上位机')
  })

  it('满载荷（40 字节数据）也能正确解出', () => {
    const v = fixture.vectors.find((x) => (x.data?.length ?? 0) === 40)!
    const { decoded } = decodeRdlc(v.frame)
    const p = decoded[0]?.payload
    expect(p?.kind).toBe('command')
    if (p?.kind === 'command') expect(p.data.length).toBe(40)
  })
})

describe('帧结构常量与下位机源码一致', () => {
  it('帧头 0xC0、帧尾 0x0C', () => {
    expect(RDLC_HEAD).toBe(0xc0)
    expect(RDLC_TAIL).toBe(0x0c)
    const v = fixture.vectors[0]!
    expect(v.frame[0]).toBe(RDLC_HEAD)
    expect(v.frame[v.frame.length - 1]).toBe(RDLC_TAIL)
  })

  it('CRC 只覆盖 payload，不含 src/dst/len —— 这与常见惯例相反', () => {
    const v = fixture.vectors[0]!
    const len = (v.frame[3] as number) | ((v.frame[4] as number) << 8)
    const payload = Uint8Array.from(v.frame.slice(5, 5 + len))
    const onWire = (v.frame[5 + len] as number) | ((v.frame[5 + len + 1] as number) << 8)
    expect(crc16Modbus(payload)).toBe(onWire)

    // 反证：把头部一起算进去就对不上（若这条断言失败，说明协议改了）
    const withHeader = Uint8Array.from(v.frame.slice(1, 5 + len))
    expect(crc16Modbus(withHeader)).not.toBe(onWire)
  })

  it('CRC 小端在线', () => {
    const v = fixture.vectors[0]!
    const len = (v.frame[3] as number) | ((v.frame[4] as number) << 8)
    const crc = crc16Modbus(Uint8Array.from(v.frame.slice(5, 5 + len)))
    expect(v.frame[5 + len]).toBe(crc & 0xff)
    expect(v.frame[5 + len + 1]).toBe((crc >> 8) & 0xff)
  })
})

describe('坏数据处理', () => {
  const good = fixture.vectors[0]!.frame

  it('前导垃圾字节被跳过，帧仍能解出', () => {
    const r = decodeRdlcStream([0x11, 0x22, 0x33, ...good])
    expect(r.frames.length).toBe(1)
    expect(r.frames[0]?.offset).toBe(3)
  })

  it('CRC 错误被记为错误，且带偏移与原始字节', () => {
    const bad = [...good]
    bad[6] = (bad[6]! + 1) & 0xff // 改一个载荷字节
    const r = decodeRdlcStream(bad)
    expect(r.frames).toEqual([])
    expect(r.errors[0]?.reason).toContain('CRC')
    expect(r.errors[0]?.offset).toBe(0)
    expect(r.errors[0]?.bytes.length).toBeGreaterThan(0)
  })

  it('坏帧之后能重新同步，后面的好帧照样解出', () => {
    const bad = [...good]
    bad[6] = (bad[6]! + 1) & 0xff
    const r = decodeRdlcStream([...bad, ...good])
    expect(r.frames.length).toBe(1)
    expect(r.errors.length).toBeGreaterThanOrEqual(1)
  })

  it('帧尾不对报帧尾错误，不误报成 CRC 错误', () => {
    const bad = [...good]
    bad[bad.length - 1] = 0x99
    const r = decodeRdlcStream(bad)
    expect(r.errors[0]?.reason).toContain('帧尾')
  })

  it('长度字段离谱时明说可能是误把数据当帧头', () => {
    const r = decodeRdlcStream([RDLC_HEAD, 0xa0, 0x01, 0xff, 0x00, ...good])
    expect(r.errors[0]?.reason).toContain('超出上限')
    // 后面真正的帧仍要解出来
    expect(r.frames.length).toBe(1)
  })

  it('半截帧不算错误，只报 pending 等待续传', () => {
    const r = decodeRdlcStream(good.slice(0, good.length - 3))
    expect(r.errors).toEqual([])
    expect(r.frames).toEqual([])
    expect(r.pending).toBeGreaterThan(0)
  })

  it('连续两帧都能解出', () => {
    const r = decodeRdlcStream([...good, ...good])
    expect(r.frames.length).toBe(2)
  })
})

describe('载荷长度字段与实际不符时报错而不是截断', () => {
  it('命令：dataLen 与载荷长度对不上', () => {
    const p = decodeRdlcPayload([MSG_COMMAND, 1, 1, 2, 10, 0, 0])
    expect(p.kind).toBe('error')
    if (p.kind === 'error') expect(p.reason).toContain('10')
  })

  it('反馈：echo 长度越界', () => {
    const p = decodeRdlcPayload([MSG_FEEDBACK, 1, 1, 2, 0, 200, 0])
    expect(p.kind).toBe('error')
    if (p.kind === 'error') expect(p.reason).toContain('越界')
  })

  it('反馈：report 长度对不上', () => {
    const p = decodeRdlcPayload([MSG_FEEDBACK, 1, 1, 2, 0, 1, 9, 5, 0])
    expect(p.kind).toBe('error')
  })

  it('空载荷', () => {
    expect(decodeRdlcPayload([]).kind).toBe('error')
  })

  it('未知首字节如实标为 unknown，不猜', () => {
    const p = decodeRdlcPayload([0x55, 1, 2, 3])
    expect(p.kind).toBe('unknown')
  })

  it('未知模块号不编造名字', () => {
    const p = decodeRdlcPayload([MSG_COMMAND, 1, 0xab, 2, 0])
    expect(p.kind).toBe('command')
    if (p.kind === 'command') expect(p.moduleName).toContain('UNKNOWN')
  })
})

describe('parseHexBytes 容忍各种抓包格式', () => {
  it('空格分隔', () => {
    expect(parseHexBytes('C0 A0 01').bytes).toEqual([0xc0, 0xa0, 0x01])
  })

  it('带 0x 前缀与逗号', () => {
    expect(parseHexBytes('0xC0, 0xA0, 0x01').bytes).toEqual([0xc0, 0xa0, 0x01])
  })

  it('连续无分隔', () => {
    expect(parseHexBytes('C0A001').bytes).toEqual([0xc0, 0xa0, 0x01])
  })

  it('跨行', () => {
    expect(parseHexBytes('C0 A0\n01 05').bytes).toEqual([0xc0, 0xa0, 0x01, 0x05])
  })

  it('非法 token 单独报出来，不静默丢弃', () => {
    const r = parseHexBytes('C0 ZZ 01')
    expect(r.bytes).toEqual([0xc0, 0x01])
    expect(r.bad).toEqual(['ZZ'])
  })

  it('空串返回空', () => {
    expect(parseHexBytes('   ').bytes).toEqual([])
  })

  it('解析出的字节能直接喂给解码器', () => {
    const hexText = fixture.vectors[0]!.frame
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
    const { bytes } = parseHexBytes(hexText)
    expect(decodeRdlcStream(bytes).frames.length).toBe(1)
  })
})
