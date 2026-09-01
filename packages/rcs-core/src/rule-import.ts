/**
 * 规则书导入 —— **跨赛季复用的入口**。
 *
 * ROBOCON 每年换主题、赛季内还反复改版，所以「上传一份新规则书」必须是常规操作，
 * 不能是每年重写一次的脚本。这里把整条链路做成纯函数：
 *
 *   .docx → 段落 → 结构化条款 → 落盘到 data/rules/<赛季>/<版本>/
 *
 * 命令行（`scripts/docx-to-rules.mjs`）与 dsh 工具（`rcs_rule_import`）
 * 共用本模块，不存在两套实现走偏的问题。
 *
 * ## 关于 constraints.json
 *
 * 数值约束表（电压/气压/重量/尺寸上限）**刻意不做自动提取**。
 * 规则解读错了代价是整套方案返工，让正则去猜"哪个数字是上限"太危险。
 * 导入时会生成一份**带条款线索的骨架**，由人填写并核对 —— 见 `scaffoldConstraints`。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { join, basename } from 'node:path'

// ---------- 最小 ZIP 读取 ----------

/**
 * 从 ZIP 里取出一个条目。只支持 stored(0) 与 deflate(8)，docx 用的就这两种。
 *
 * 自己解 ZIP 而不装依赖：.docx 就是个 ZIP，取一个 `word/document.xml` 只需要
 * 读中央目录 + inflate，Node 内置 zlib 就够，不值得为此引入运行时依赖。
 */
export function readZipEntry(buf: Buffer, wanted: string): Buffer {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP/docx：找不到中央目录')

  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录条目签名错误')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')

    if (name === wanted) {
      // 本地文件头里名称与 extra 的长度可能与中央目录不同，必须重新读
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('本地文件头签名错误')
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataOff = localOff + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(dataOff, dataOff + compSize)
      return method === 0 ? raw : inflateRawSync(raw)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`ZIP 中找不到条目：${wanted}`)
}

// ---------- OOXML 取文本 ----------

function decodeXml(s: string): string {
  return s
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim()
}

/**
 * 从 document.xml 抽段落文本。
 *
 * 这个函数踩过三个坑，每一个都会**静默丢内容**，改动前请先看
 * `packages/rcs-core/test/rules-data.test.ts` 的回归断言：
 *
 *   1. `mc:Fallback` 与 `mc:Choice` 装同一段内容的两种渲染，都取会重复；
 *   2. 图片锚点里的坐标数字剥标签后会当成正文留下（`020000` 之类），
 *      还会把「。」和紧随的条款号隔开导致分条失败；
 *   3. 文本框里嵌套 `<w:p>`，配对匹配会在内层收尾，把外层段落后半截整段丢掉 ——
 *      2027 V0 的 11.16 就是这样整条消失的。
 */
export function paragraphs(xml: string): string[] {
  let doc = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '')

  // 图片/形状锚点丢掉，但里面的文本框是真文字，要留
  doc = doc.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, (m) => {
    const boxes = m.match(/<w:txbxContent>[\s\S]*?<\/w:txbxContent>/g)
    return boxes ? boxes.join('') : ''
  })
  doc = doc.replace(/<w:pict>[\s\S]*?<\/w:pict>/g, '')

  // 表格整体先替换成占位，避免表格内的段落被当成正文段落打散
  const tables: string[] = []
  doc = doc.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (m) => {
    tables.push(m)
    return `<<<TBL${tables.length - 1}>>>`
  })

  const emitTable = (tblXml: string, out: string[]): void => {
    out.push('<<TABLE>>')
    for (const tr of tblXml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []) {
      const cells = (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((tc) =>
        decodeXml(tc).replace(/\s+/g, ' '),
      )
      const row = cells.join(' | ')
      if (row.replace(/[\s|]/g, '')) out.push(`| ${row} |`)
    }
    out.push('<<END TABLE>>')
  }

  const out: string[] = []
  for (const seg of doc.split(/(<<<TBL\d+>>>)/)) {
    const tbl = /^<<<TBL(\d+)>>>$/.exec(seg)
    if (tbl) {
      emitTable(tables[Number(tbl[1])] ?? '', out)
      continue
    }
    // 按段落**起始标签**切，不用配对匹配 —— 见上方坑 3
    for (const chunk of seg.split(/<w:p[ />]/)) {
      // split 只吃掉 `<w:p` 和一个字符，开标签剩下的属性还在块首，先丢掉
      const t = decodeXml(chunk.replace(/^[^>]*>/, ''))
      if (t) out.push(t)
    }
  }
  return out
}

// ---------- 条款切分 ----------

export type ImportedClause = { id: string; text: string }

/**
 * 有些条款在 docx 里**没有独立成段** —— 排版时被接在上一段末尾同一个 run 里。
 * 不做行内切分就会被整条并进上一条，检索与 diff 都看不见它。
 *
 * 条件卡得紧以免误伤：必须是「。」之后 + 条款号形如 N.N + 空格 + 中文。
 * 这样「气压不得超过 0.6 MPa」里的 0.6 不会被当成条款号（后面跟的是拉丁字母）。
 */
export function splitInlineClauses(line: string): string[] {
  return line.split(/(?<=。)\s*(?=\d{1,2}(?:\.\d{1,2})+\s+[一-龥])/)
}

/**
 * 把段落切成带条款号的条款。
 *
 * 编号形如 `11.14`、`4.6.1`；章标题形如 `12 安全`。
 * 没有编号的段落（背景故事、说明文字）归到上一条，保证正文不丢。
 */
export function toClauses(lines: string[]): ImportedClause[] {
  const clauses: ImportedClause[] = []
  let current: ImportedClause | null = null
  const numbered = /^(\d+(?:\.\d+)*)[.\s、]?\s*(.*)$/

  for (const line of lines.flatMap(splitInlineClauses)) {
    const m = numbered.exec(line)
    // 只认「数字.数字」或「数字 + 空格 + 短标题」，避免把 "600kPa" 之类误判
    const looksLikeClause =
      m && m[1] && m[2] !== undefined &&
      (m[1].includes('.') || (m[2].length > 0 && m[2].length < 40 && !/^\d/.test(m[2])))

    if (looksLikeClause && m) {
      if (current) clauses.push(current)
      current = { id: m[1] ?? '', text: m[2] ?? '' }
    } else if (current) {
      current.text += (current.text ? '\n' : '') + line
    } else {
      current = { id: '0', text: line }
    }
  }
  if (current) clauses.push(current)

  const seen = new Set<string>()
  return clauses.filter((c) => {
    if (seen.has(c.id)) return false
    seen.add(c.id)
    c.text = c.text.trim()
    return c.text.length > 0
  })
}

// ---------- 约束表骨架 ----------

/**
 * 生成 constraints.json 的骨架。
 *
 * **数值一律留 null，由人填。** 让正则去猜"哪个数字是上限"太危险 ——
 * 规则解读错了代价是整套方案返工。骨架的作用是把"该填哪些字段、
 * 每个字段该去哪条条款找"固化下来，而不是替人做判断。
 *
 * `clauseHint` 是**上一版的条款号**（若有），仅作查找线索；
 * 新赛季条款号大概率会变，填的时候必须回原文核对。
 */
export function scaffoldConstraints(
  season: string,
  version: string,
  previous?: Record<string, unknown>,
): Record<string, unknown> {
  const hint = (path: string, fallback: string): string => {
    const parts = path.split('.')
    let node: unknown = previous
    for (const k of parts) {
      if (typeof node !== 'object' || node === null) return fallback
      node = (node as Record<string, unknown>)[k]
    }
    return typeof node === 'string' ? node : fallback
  }

  return {
    $comment: [
      `${season} 赛季 ${version} 版的数值约束表 —— **需要人工填写并核对**。`,
      '每个 value 都是 null，请对照 clauses.json 的原文逐条填入，并把 clause 改成本版真实条款号。',
      'clause 字段的初始值是上一版的条款号（仅作查找线索）；新版条款号大概率变了，务必核对。',
      '本文件不做自动提取：规则解读错误的代价是整套方案返工，不能让正则去猜哪个数字是上限。',
      '填完后跑 `npm run check -- rules` 或让 Agent 调 rcs_rule_check 验证。',
    ],
    competition: 'robocon-cn',
    season,
    version,
    theme: null,
    tolerance: { value: null, clause: hint('tolerance.clause', '13.2'), note: '尺寸重量的制造公差' },

    robots: {
      massMaxKg: { value: null, clause: hint('robots.massMaxKg.clause', '11.7'), note: '含电池、控制器、电缆' },
      startEnvelopeMm: { l: null, w: null, h: null, clause: hint('robots.startEnvelopeMm.clause', '11.4') },
      extendedEnvelopeMm: {
        TR: { w: null, l: null, h: null, clause: hint('robots.extendedEnvelopeMm.TR.clause', '11.5') },
        BR: { w: null, l: null, h: null, clause: hint('robots.extendedEnvelopeMm.BR.clause', '11.6') },
      },
      autonomy: {
        TR: { mode: null, clause: hint('robots.autonomy.TR.clause', '11.2') },
        BR: { mode: null, clause: hint('robots.autonomy.BR.clause', '11.3') },
      },
    },

    electrical: {
      batteryNominalVoltageMaxV: { value: null, clause: hint('electrical.batteryNominalVoltageMaxV.clause', '11.12') },
      circuitMaxVoltageV: { value: null, clause: hint('electrical.circuitMaxVoltageV.clause', '11.13') },
      powerSources: { allowed: [], clause: hint('electrical.powerSources.clause', '11.11') },
      forbidden: { clause: hint('electrical.forbidden.clause', '11.15'), items: [] },
      laser: { standard: 'IEC 60825-1', allowedClasses: [], clause: hint('electrical.laser.clause', '11.15') },
    },

    pneumatic: {
      maxPressureKPa: { value: null, clause: hint('pneumatic.maxPressureKPa.clause', '11.14') },
    },

    wireless: {
      allowed: [],
      clause: hint('wireless.clause', '11.8'),
      interRobotForbidden: { value: null, clause: hint('wireless.interRobotForbidden.clause', '11.10') },
    },

    safety: {
      emergencyStop: { required: null, spec: null, clause: hint('safety.emergencyStop.clause', '12.2') },
      forbidAerial: { value: null, clause: hint('safety.forbidAerial.clause', '12.6') },
    },

    $todo: [
      '把上面所有 null 换成本版规则的真实数值',
      '核对每个 clause 是否指向本版的正确条款',
      '按本赛季实际情况补充 zones / items / scoring / match 等分节（可参考上一版）',
      '第 14 节若有场地 RGB 色值，补进 $visionColors，供视觉组做阈值',
    ],
  }
}

// ---------- 导入 ----------

export type ImportResult = {
  season: string
  version: string
  dir: string
  paragraphs: number
  clauses: number
  chars: number
  /** 是否新生成了约束表骨架（true 表示需要人工填写）。 */
  constraintsScaffolded: boolean
  /** 约束表中仍为 null 的字段数；>0 表示尚未填完。 */
  constraintsPending: number
  /** 是否覆盖了已存在的版本。 */
  overwrote: boolean
}

/** 统计对象里还有多少个 null（用来判断约束表填完没有）。 */
function countNulls(v: unknown): number {
  if (v === null) return 1
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + countNulls(x), 0)
  if (typeof v === 'object' && v !== null) {
    return Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !k.startsWith('$'))
      .reduce<number>((n, [, x]) => n + countNulls(x), 0)
  }
  return 0
}

/**
 * 导入一份规则书。
 *
 * @param docxPath 规则书 .docx 路径
 * @param rulesRoot 规则数据根目录（`data/rules`）
 * @param season 赛季，如 `2028`
 * @param version 版本，如 `V1`
 * @param options.overwrite 版本已存在时是否覆盖；默认 false（防止误覆盖已核对过的数据）
 */
export function importRulebook(
  docxPath: string,
  rulesRoot: string,
  season: string,
  version: string,
  options: { overwrite?: boolean } = {},
): ImportResult {
  if (!existsSync(docxPath)) {
    throw new Error(`规则书不存在：${docxPath}`)
  }
  if (!/^\d{4}$/.test(season)) {
    throw new Error(`赛季应为四位年份，收到「${season}」`)
  }
  if (!/^[\w.\-]+$/.test(version)) {
    throw new Error(`版本名只能是字母数字与 . - _，收到「${version}」`)
  }

  const dir = join(rulesRoot, season, version)
  const existed = existsSync(join(dir, 'clauses.json'))
  if (existed && !options.overwrite) {
    throw new Error(
      `${season}/${version} 已存在。若确实要重新导入，请显式指定覆盖 —— ` +
        `已核对过的规则数据被悄悄改掉是很难发现的。`,
    )
  }

  const xml = readZipEntry(readFileSync(docxPath), 'word/document.xml').toString('utf8')
  const lines = paragraphs(xml)
  const clauses = toClauses(lines)

  if (clauses.length < 10) {
    throw new Error(
      `只解析出 ${clauses.length} 条条款，明显不对。` +
        `请确认这是 ROBOCON 规则书的 .docx（不是 .doc 或 PDF 转存）。`,
    )
  }

  mkdirSync(join(dir, 'source'), { recursive: true })
  copyFileSync(docxPath, join(dir, 'source', basename(docxPath)))

  const fullText = lines.join('\n')
  writeFileSync(join(dir, 'rules.txt'), fullText, 'utf8')
  writeFileSync(
    join(dir, 'clauses.json'),
    JSON.stringify({ competition: 'robocon-cn', season, version, clauses }, null, 2),
    'utf8',
  )
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify(
      {
        competition: 'robocon-cn',
        season,
        version,
        sourceFile: basename(docxPath),
        paragraphs: lines.length,
        clauses: clauses.length,
        chars: fullText.length,
      },
      null,
      2,
    ),
    'utf8',
  )

  // 约束表：已存在就不动（里面是人工核对过的成果），不存在才生成骨架
  const constraintsPath = join(dir, 'constraints.json')
  let scaffolded = false
  let constraints: Record<string, unknown>
  if (existsSync(constraintsPath)) {
    constraints = JSON.parse(readFileSync(constraintsPath, 'utf8')) as Record<string, unknown>
  } else {
    constraints = scaffoldConstraints(season, version, findPreviousConstraints(rulesRoot, season, version))
    writeFileSync(constraintsPath, JSON.stringify(constraints, null, 2), 'utf8')
    scaffolded = true
  }

  return {
    season,
    version,
    dir,
    paragraphs: lines.length,
    clauses: clauses.length,
    chars: fullText.length,
    constraintsScaffolded: scaffolded,
    constraintsPending: countNulls(constraints),
    overwrote: existed,
  }
}

/** 找同赛季（或最近赛季）已填好的约束表，用来给新版本提供条款号线索。 */
function findPreviousConstraints(
  rulesRoot: string,
  season: string,
  version: string,
): Record<string, unknown> | undefined {
  const tryLoad = (s: string, v: string): Record<string, unknown> | undefined => {
    const f = join(rulesRoot, s, v, 'constraints.json')
    if (!existsSync(f)) return undefined
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  if (!existsSync(rulesRoot)) return undefined

  // 优先同赛季的其它版本，其次最近的赛季
  const seasons = readdirSync(rulesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse()

  for (const s of [season, ...seasons.filter((x) => x !== season)]) {
    const dir = join(rulesRoot, s)
    if (!existsSync(dir)) continue
    const versions = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== version)
      .map((e) => e.name)
      .sort()
      .reverse()
    for (const v of versions) {
      const c = tryLoad(s, v)
      if (c) return c
    }
  }
  return undefined
}
