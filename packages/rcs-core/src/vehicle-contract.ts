/**
 * 依赖实车的那部分能力 —— **只定契约，不做实现**。
 *
 * ## 为什么现在只留接口
 *
 * ROBOCON 每年底盘全新：CAN ID 怎么分、几个电机、什么机构，要等机械定版、
 * 实车装好才知道。现在写死任何一套映射，明年都是错的；而"错的映射"比
 * "没有映射"危险得多 —— 它会让人相信一个编造出来的解读。
 *
 * 所以这里的做法与规则约束表（`constraints.json`）一致：
 *   1. 把**该填哪些字段、每个字段什么含义**固化下来；
 *   2. 提供带校验的加载器，**没填完就明确拒绝运行**，而不是拿默认值硬算；
 *   3. 等实车定了，填 `config/` 里的表即可启用，代码一行不用改。
 *
 * ## 覆盖三块
 *
 *   - `rcs_bus_decode`：CAN 报文 → 「几号电机、什么状态」，需要 ID 映射表
 *   - M4 日志系列：需要一份真实日志样本与格式说明
 *   - `rcs_pid_advise`：需要一份带调参过程的 VOFA 波形
 */

// ---------- CAN 总线映射 ----------

/** 队内在用的执行器型号。取自 `config/team.json` 的 firmware.actuators。 */
export type ActuatorKind = 'rm3508' | 'rm2006' | 'gm6020' | 'vesc' | 'cylinder'

/** 一条 CAN ID 到机构的映射。 */
export type BusEntry = {
  /** 十六进制字符串，如 `0x201`。用字符串是为了让配置文件里保持可读的十六进制。 */
  canId: string
  /** 机构名，如 `底盘左前轮`、`抬升机构`。中文即可 —— 这是给人看的。 */
  mechanism: string
  actuator: ActuatorKind
  /** 报文方向：`feedback` 是电调回传，`command` 是下发。 */
  direction: 'feedback' | 'command'
  /** 减速比。做转速换算要用；不确定就先留空，别猜。 */
  gearRatio?: number
  /** 备注，如「负数减速比，用于把速度扭回正数」。 */
  note?: string
}

export type BusMap = {
  /** 赛季，如 `2027`。防止拿去年的表解今年的报文。 */
  season: string
  /** 底盘形态，如 `4舵轮`、`4麦轮`。 */
  chassis: string
  entries: BusEntry[]
}

/** 加载结果。未填完时**不返回半成品**，只返回缺什么。 */
export type BusMapLoad =
  | { ok: true; map: BusMap }
  | { ok: false; reason: string; missing: string[] }

/**
 * 校验并加载 CAN ID 映射表。
 *
 * 空表、赛季不符、条目字段缺失一律拒绝 —— 宁可让工具报「还没配」，
 * 也不能让它拿一张残缺的表去解报文然后给出看似合理的错误结论。
 */
export function loadBusMap(raw: unknown, expectSeason?: string): BusMapLoad {
  const missing: string[] = []
  const fail = (reason: string): BusMapLoad => ({ ok: false, reason, missing })

  if (typeof raw !== 'object' || raw === null) {
    return fail('映射表不是一个对象 —— 检查 config 里的 JSON 是否写坏了。')
  }
  const m = raw as Partial<BusMap>

  if (!m.season) missing.push('season')
  if (!m.chassis) missing.push('chassis')
  if (!Array.isArray(m.entries) || m.entries.length === 0) missing.push('entries（至少一条）')

  if (missing.length > 0) {
    return fail(
      `CAN ID 映射表还没填：缺 ${missing.join('、')}。\n` +
        '每年底盘全新，这张表要等机械定版、实车装好后由人填写。' +
        '在此之前 rcs_bus_decode 不会给出解读 —— 拿一张编造的映射去解报文，' +
        '比不解读危险得多。',
    )
  }

  for (const [i, e] of (m.entries ?? []).entries()) {
    for (const k of ['canId', 'mechanism', 'actuator', 'direction'] as const) {
      if (!e[k]) missing.push(`entries[${i}].${k}`)
    }
    if (e.canId && !/^0x[0-9a-fA-F]+$/.test(e.canId)) {
      return fail(`entries[${i}].canId 应写成十六进制字符串（如 "0x201"），当前是 ${JSON.stringify(e.canId)}。`)
    }
  }
  if (missing.length > 0) return fail(`映射表有条目字段缺失：${missing.join('、')}`)

  if (expectSeason && m.season !== expectSeason) {
    return fail(
      `映射表是 ${m.season} 赛季的，当前赛季是 ${expectSeason}。\n` +
        '底盘每年重做，跨赛季套用会把报文解成完全不相干的机构。确认后请更新 season 字段。',
    )
  }

  return { ok: true, map: m as BusMap }
}

/** 生成一份带注释的空表骨架，交给人填。 */
export function scaffoldBusMap(season: string, chassis = 'tbd'): Record<string, unknown> {
  return {
    $comment: [
      'CAN ID → 机构映射表。每年底盘全新，本表须在实车定版后由人填写并核对。',
      'canId 写十六进制字符串（如 "0x201"）；mechanism 用中文机构名，这是给人看的。',
      'gearRatio 不确定就留空 —— 猜一个错的减速比，会让所有转速换算悄悄错掉。',
      '填完后 rcs_bus_decode 自动启用，代码不用改。',
    ],
    season,
    chassis,
    entries: [],
    $example: {
      canId: '0x201',
      mechanism: '底盘左前轮',
      actuator: 'rm3508',
      direction: 'feedback',
      gearRatio: 19,
      note: '示例条目，填表时删掉本节',
    },
  }
}

// ---------- 日志（M4） ----------

/** 一条日志记录的最小契约。真实格式待样本确定后细化。 */
export type LogRecord = {
  /** 相对开机的毫秒数，或绝对时间戳 —— 待样本确定。 */
  t: number
  /** 记录类别，如 `can`、`ctrl`、`vision`。 */
  channel: string
  /** 结构化字段。样本到手前不预设 schema。 */
  fields: Record<string, number | string | boolean>
}

export type LogParseResult = {
  records: LogRecord[]
  /** 解析不了的行数。大于 0 说明格式假设有误，必须报出来。 */
  unparsed: number
}

/**
 * 日志解析的占位实现。
 *
 * **刻意不去猜格式。** 二进制、CSV、VOFA 波形三种可能性差别巨大，
 * 靠猜写出来的解析器会在某种格式下静默产生垃圾数据 ——
 * 而日志分析的结论会直接影响赛后复盘的判断。
 */
export function parseRobotLog(_text: string): LogParseResult {
  throw new Error(
    'M4 日志解析尚未实现：需要一份**真实日志样本**与格式说明才能动手。\n' +
      '需要知道的是：二进制还是文本？字段分隔方式？时间戳是相对开机还是绝对？' +
      '有哪些 channel？\n' +
      '拿到样本后，本函数与 rcs_log_parse / rcs_log_anomaly / rcs_postmortem_draft 一并实现。',
  )
}

// ---------- PID 整定建议 ----------

export type PidSample = {
  t: number
  target: number
  actual: number
}

/**
 * PID 建议的占位实现。
 *
 * 需要一份**带调参过程**的 VOFA 波形：只有一条最终曲线看不出超调、
 * 振荡、稳态误差各自的来源，给出的建议会流于套话。
 * 而且按设计约定，本工具**只给方向建议，绝不自动写参数** ——
 * 参数错了是电机堵转烧驱动，那必须是人按下的。
 */
export function advisePid(_samples: PidSample[]): never {
  throw new Error(
    'rcs_pid_advise 尚未实现：需要一份真实的 VOFA 波形样本（最好带调参过程）。\n' +
      '注意本工具的既定约束：只给整定方向建议，不自动写参数。',
  )
}

/** 三块待实现能力的统一清单，供 `rcs_team_context` 之类的工具如实汇报进度。 */
export const PENDING_VEHICLE_CAPABILITIES = [
  {
    id: 'bus-decode',
    tool: 'rcs_bus_decode',
    needs: 'CAN ID → 机构映射表（config/bus-map.json）',
    blockedBy: '每年底盘全新，须等机械定版、实车装好',
  },
  {
    id: 'log',
    tool: 'rcs_log_parse / rcs_log_anomaly / rcs_postmortem_draft',
    needs: '一份真实日志样本 + 格式说明',
    blockedBy: '日志模块尚未产出样本',
  },
  {
    id: 'pid',
    tool: 'rcs_pid_advise',
    needs: '一份带调参过程的 VOFA 波形',
    blockedBy: '需实车调参时录制',
  },
] as const
