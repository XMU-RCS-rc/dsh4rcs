/**
 * RDLC 协议解析 —— 队内上下位机通信协议。
 *
 * ## 唯一真相是下位机源码
 *
 * 本模块严格照 固件仓库的 `demo/RCS/RCS_Support/src/rdlc.c` 实现，
 * 并用队内上位机 `upper_host_cli/rdlc_cli.py` 生成的真实帧做跨实现基准
 * （测试夹具 `test/fixtures/rdlc-vectors.json`，非手写）。
 *
 * **协议在两处维护必然发散**，所以这里只做「解析与解释」，不定义任何新字段。
 * 下位机改了协议，先改 `rdlc.c`，再让这里的基准测试失败提醒我们跟进。
 *
 * ## 一个反直觉的地方，务必注意
 *
 * **CRC 只覆盖 payload，不含地址和长度字段。** 这与绝大多数帧协议的惯例相反
 * （通常会把头部一起校验）。若按惯例实现，会把每一帧合法数据都判成 CRC 错误。
 * 已在 C 与 Python 两份实现里分别确认：
 *   - C:      `prvGetCrc16(payload, payloadSize)`
 *   - Python: `crc16_modbus(payload)`
 */

/** 帧头。 */
export const RDLC_HEAD = 0xc0
/** 帧尾。 */
export const RDLC_TAIL = 0x0c
/** 转义字符。注意 `rdlc.h` 里 `RDLC_ESCAPE_ENABLE` 默认为 0，即**默认不转义**。 */
export const RDLC_ESCAPE = 0xff
/** `rdlc_cli.py` 的上限；`rdlc.h` 侧由 `RdlcConfig_t.msgMaxSize` 决定。 */
export const RDLC_MAX_PAYLOAD = 64

/** 上位机地址。 */
export const UPPER_ADDRESS = 0xa0
/** 下位机地址。 */
export const LOWER_ADDRESS = 0x01

/** 载荷首字节：命令。 */
export const MSG_COMMAND = 0x10
/** 载荷首字节：反馈。 */
export const MSG_FEEDBACK = 0x90

/** 模块号 —— 取自 `rdlc_cli.py`，与下位机 dispatch 表对应。 */
export const MODULE_NAMES: Record<number, string> = {
  0x00: 'SYSTEM',
  0x01: 'MOTORS',
  0x02: 'PWM',
  0x10: 'COMPLEX',
  0x7e: 'LINK_TEST',
}

/** 反馈状态码。 */
export const STATUS_NAMES: Record<number, string> = {
  0: 'OK',
  1: 'BAD_MESSAGE',
  2: 'BAD_MODULE',
  3: 'BAD_OPERATION',
  4: 'BAD_LENGTH',
  5: 'REJECTED',
  6: 'INTERNAL_ERROR',
}

/**
 * CRC16/MODBUS：初值 0xFFFF，反射多项式 0xA001，无最终异或。
 * 标准校验值 `crc16("123456789") === 0x4B37`，测试里有断言。
 */
export function crc16Modbus(data: Uint8Array): number {
  let crc = 0xffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1
    }
  }
  return crc & 0xffff
}

export type RdlcFrame = {
  src: number
  dst: number
  payload: number[]
  /** 该帧在输入流中的起始偏移，便于定位问题字节。 */
  offset: number
}

export type RdlcParseError = {
  offset: number
  reason: string
  /** 出错处的原始字节，最多 16 个，用于人工核对。 */
  bytes: number[]
}

export type RdlcStreamResult = {
  frames: RdlcFrame[]
  errors: RdlcParseError[]
  /** 尾部不完整、留待下次拼接的字节数。 */
  pending: number
}

const hex = (b: number): string => b.toString(16).padStart(2, '0').toUpperCase()
export const toHex = (bytes: number[] | Uint8Array): string =>
  Array.from(bytes, hex).join(' ')

/**
 * 从字节流里解出所有帧。
 *
 * **遇到坏帧要能重新同步。** 真实串口上丢字节、串扰是常态，一个坏帧不该让
 * 后面所有帧都解不出来 —— 所以出错后从下一个 `0xC0` 继续找，并把错误单独记下来。
 * 报错要带偏移和原始字节，否则排查时还得自己数。
 */
export function decodeRdlcStream(input: Uint8Array | number[]): RdlcStreamResult {
  const data = input instanceof Uint8Array ? input : Uint8Array.from(input)
  const frames: RdlcFrame[] = []
  const errors: RdlcParseError[] = []
  let i = 0
  let pending = 0

  const fail = (offset: number, reason: string): void => {
    errors.push({ offset, reason, bytes: Array.from(data.subarray(offset, offset + 16)) })
  }

  while (i < data.length) {
    if (data[i] !== RDLC_HEAD) {
      i++
      continue
    }
    const start = i
    // 帧头(1) + src(1) + dst(1) + lenL(1) + lenH(1) = 5 字节头部
    if (start + 5 > data.length) {
      pending = data.length - start
      break
    }
    const src = data[start + 1] as number
    const dst = data[start + 2] as number
    const len = (data[start + 3] as number) | ((data[start + 4] as number) << 8)
    const payloadStart = start + 5
    // payload + crc(2) + tail(1)
    const frameEnd = payloadStart + len + 3

    if (len > RDLC_MAX_PAYLOAD) {
      fail(start, `载荷长度 ${len} 超出上限 ${RDLC_MAX_PAYLOAD}，多半是把数据字节当成了帧头`)
      i = start + 1
      continue
    }
    if (frameEnd > data.length) {
      // 可能只是还没收全，交给调用方拼接下一段
      pending = data.length - start
      break
    }
    if (data[frameEnd - 1] !== RDLC_TAIL) {
      fail(start, `帧尾应为 0x0C，实际 0x${hex(data[frameEnd - 1] as number)}`)
      i = start + 1
      continue
    }

    const payload = data.subarray(payloadStart, payloadStart + len)
    // ⚠️ CRC 只算 payload —— 不含 src/dst/len。见文件头说明。
    const expect = crc16Modbus(payload)
    const actual = (data[payloadStart + len] as number) | ((data[payloadStart + len + 1] as number) << 8)
    if (expect !== actual) {
      fail(start, `CRC 校验失败：期望 0x${expect.toString(16).toUpperCase()}，实际 0x${actual.toString(16).toUpperCase()}`)
      i = start + 1
      continue
    }

    frames.push({ src, dst, payload: Array.from(payload), offset: start })
    i = frameEnd
  }

  return { frames, errors, pending }
}

export type RdlcCommand = {
  kind: 'command'
  sequence: number
  module: number
  moduleName: string
  operation: number
  data: number[]
}

export type RdlcFeedback = {
  kind: 'feedback'
  sequence: number
  module: number
  moduleName: string
  operation: number
  status: number
  statusName: string
  echo: number[]
  report: number[]
}

export type RdlcPayload = RdlcCommand | RdlcFeedback | { kind: 'unknown'; first: number; raw: number[] }

const moduleName = (m: number): string => MODULE_NAMES[m] ?? `UNKNOWN(0x${hex(m)})`

/**
 * 解释载荷。
 *
 * 命令：`0x10 | sequence | module | operation | dataLen | data[dataLen]`
 * 反馈：`0x90 | sequence | module | operation | status | echoLen | echo[] | reportLen | report[]`
 *
 * 长度字段与实际长度对不上时**报错而不是截断** —— 悄悄少解一段数据，
 * 排查时会以为下位机没发，那比直接报错难查得多。
 */
export function decodeRdlcPayload(payload: number[]): RdlcPayload | { kind: 'error'; reason: string } {
  if (payload.length === 0) return { kind: 'error', reason: '空载荷' }
  const first = payload[0] as number

  if (first === MSG_COMMAND) {
    if (payload.length < 5) return { kind: 'error', reason: `命令载荷至少 5 字节，实际 ${payload.length}` }
    const dataLen = payload[4] as number
    if (payload.length !== 5 + dataLen) {
      return {
        kind: 'error',
        reason: `命令长度字段说有 ${dataLen} 字节数据，但载荷共 ${payload.length} 字节（应为 ${5 + dataLen}）`,
      }
    }
    return {
      kind: 'command',
      sequence: payload[1] as number,
      module: payload[2] as number,
      moduleName: moduleName(payload[2] as number),
      operation: payload[3] as number,
      data: payload.slice(5),
    }
  }

  if (first === MSG_FEEDBACK) {
    if (payload.length < 7) return { kind: 'error', reason: `反馈载荷至少 7 字节，实际 ${payload.length}` }
    const echoLen = payload[5] as number
    const reportLenIndex = 6 + echoLen
    if (reportLenIndex >= payload.length) {
      return { kind: 'error', reason: `echo 长度 ${echoLen} 越界，载荷只有 ${payload.length} 字节` }
    }
    const reportLen = payload[reportLenIndex] as number
    if (payload.length !== reportLenIndex + 1 + reportLen) {
      return {
        kind: 'error',
        reason: `反馈长度字段与载荷不符：echo=${echoLen} report=${reportLen}，载荷共 ${payload.length} 字节`,
      }
    }
    const status = payload[4] as number
    return {
      kind: 'feedback',
      sequence: payload[1] as number,
      module: payload[2] as number,
      moduleName: moduleName(payload[2] as number),
      operation: payload[3] as number,
      status,
      statusName: STATUS_NAMES[status] ?? `UNKNOWN(${status})`,
      echo: payload.slice(6, reportLenIndex),
      report: payload.slice(reportLenIndex + 1),
    }
  }

  return { kind: 'unknown', first, raw: payload }
}

export type DecodedFrame = {
  frame: RdlcFrame
  payload: RdlcPayload | { kind: 'error'; reason: string }
  /** 方向说明，如「上位机 → 下位机」。地址不认识时如实标注。 */
  direction: string
}

const addrName = (a: number): string =>
  a === UPPER_ADDRESS ? '上位机' : a === LOWER_ADDRESS ? '下位机' : `0x${hex(a)}`

/** 一步到位：字节流 → 结构化帧列表。工具层直接用这个。 */
export function decodeRdlc(input: Uint8Array | number[]): {
  decoded: DecodedFrame[]
  errors: RdlcParseError[]
  pending: number
} {
  const { frames, errors, pending } = decodeRdlcStream(input)
  return {
    decoded: frames.map((frame) => ({
      frame,
      payload: decodeRdlcPayload(frame.payload),
      direction: `${addrName(frame.src)} → ${addrName(frame.dst)}`,
    })),
    errors,
    pending,
  }
}

/**
 * 解析十六进制文本。
 *
 * 抓包工具的输出格式五花八门（空格分隔、逗号分隔、带 `0x` 前缀、连续无分隔），
 * 全都接受 —— 让人为了喂给工具而先手工整理格式，这工具就没人用。
 */
export function parseHexBytes(text: string): { bytes: number[]; bad: string[] } {
  const bad: string[] = []
  const cleaned = text.replace(/0[xX]/g, ' ').replace(/[,;:\n\r\t]+/g, ' ').trim()
  if (cleaned.length === 0) return { bytes: [], bad }

  // 有空白就按空白切；完全没有空白则按每两个字符切
  const tokens = /\s/.test(cleaned)
    ? cleaned.split(/\s+/)
    : (cleaned.match(/../g) ?? [])

  const bytes: number[] = []
  for (const t of tokens) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(t)) {
      bad.push(t)
      continue
    }
    bytes.push(parseInt(t, 16))
  }
  return { bytes, bad }
}
