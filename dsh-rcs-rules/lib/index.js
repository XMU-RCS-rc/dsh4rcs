// packages/dsh-rcs-rules/src/index.ts
import { join as join4 } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

// packages/rcs-core/src/rule-source.ts
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
function compareVersions(a, b) {
  const isAbu = (v) => v.toLowerCase().startsWith("abu") ? 1 : 0;
  const abuDiff = isAbu(a) - isAbu(b);
  if (abuDiff !== 0) return abuDiff;
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}
var JsonRuleSource = class {
  root;
  constructor(root) {
    this.root = root;
  }
  dir(season, version) {
    return join(this.root, season, version);
  }
  listVersions(season) {
    const seasonDir = join(this.root, season);
    if (!existsSync(seasonDir)) {
      return Promise.reject(new Error(`\u8D5B\u5B63\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${seasonDir}`));
    }
    const versions = readdirSync(seasonDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(seasonDir, e.name, "clauses.json"))).map((e) => e.name).sort(compareVersions);
    return Promise.resolve(versions);
  }
  load(season, version) {
    const file = join(this.dir(season, version), "clauses.json");
    if (!existsSync(file)) {
      return Promise.reject(
        new Error(
          `\u89C4\u5219\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${file}
\u8BF7\u5148\u7528 scripts/docx-to-rules.mjs \u4ECE\u5B98\u65B9 .docx \u8F6C\u6362\uFF0C\u6216\u6838\u5BF9\u8D5B\u5B63/\u7248\u672C\u62FC\u5199\u3002`
        )
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      return Promise.reject(new Error(`\u89C4\u5219\u6587\u4EF6\u89E3\u6790\u5931\u8D25\uFF1A${file}\uFF08${String(e)}\uFF09`));
    }
    if (!Array.isArray(parsed.clauses) || parsed.clauses.length === 0) {
      return Promise.reject(new Error(`\u89C4\u5219\u6587\u4EF6\u6CA1\u6709\u6761\u6B3E\uFF1A${file}`));
    }
    return Promise.resolve({
      competition: parsed.competition ?? "robocon-cn",
      season: parsed.season ?? season,
      version: parsed.version ?? version,
      clauses: parsed.clauses
    });
  }
  /** 列出所有可用赛季。 */
  listSeasons() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  }
};
function searchClauses(doc, query, limit = 8) {
  const q = query.trim();
  if (!q) return [];
  const idInQuery = /\b\d+(?:\.\d+)+\b/.exec(q)?.[0];
  const bigrams2 = (s) => {
    const t = s.replace(/\s+/g, "");
    const out = /* @__PURE__ */ new Set();
    for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const qGrams = bigrams2(q);
  const hits = [];
  for (const clause of doc.clauses) {
    const matched = [];
    let score = 0;
    if (idInQuery && clause.id === idInQuery) {
      score += 1e3;
      matched.push(`\u6761\u6B3E\u53F7 ${idInQuery}`);
    }
    if (clause.text.includes(q)) {
      score += 100;
      matched.push(q);
    }
    if (qGrams.size > 0) {
      const cGrams = bigrams2(clause.text);
      let overlap = 0;
      for (const g of qGrams) if (cGrams.has(g)) overlap++;
      score += overlap / qGrams.size * 50;
    }
    if (score > 5) hits.push({ clause, score, matched });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// packages/rcs-core/src/rule-diff.ts
function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}
function bigrams(text) {
  const s = text.replace(/\s+/g, "");
  const out = /* @__PURE__ */ new Set();
  if (s.length === 1) out.add(s);
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}
function similarity(a, b) {
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}
function diffRuleDocuments(from, to) {
  const fromMap = new Map(from.clauses.map((c) => [c.id, c]));
  const toMap = new Map(to.clauses.map((c) => [c.id, c]));
  const changes = [];
  let unchanged = 0;
  for (const [id, oldClause] of fromMap) {
    const newClause = toMap.get(id);
    if (!newClause) {
      changes.push({
        kind: "removed",
        clauseId: id,
        ...oldClause.title ? { title: oldClause.title } : {},
        before: oldClause.text
      });
    } else if (normalize(oldClause.text) !== normalize(newClause.text)) {
      changes.push({
        kind: "modified",
        clauseId: id,
        ...newClause.title ? { title: newClause.title } : {},
        before: oldClause.text,
        after: newClause.text,
        similarity: similarity(oldClause.text, newClause.text)
      });
    } else {
      unchanged++;
    }
  }
  for (const [id, newClause] of toMap) {
    if (!fromMap.has(id)) {
      changes.push({
        kind: "added",
        clauseId: id,
        ...newClause.title ? { title: newClause.title } : {},
        after: newClause.text
      });
    }
  }
  changes.sort((a, b) => a.clauseId.localeCompare(b.clauseId, "zh", { numeric: true }));
  return {
    from: { season: from.season, version: from.version },
    to: { season: to.season, version: to.version },
    changes,
    stats: {
      added: changes.filter((c) => c.kind === "added").length,
      removed: changes.filter((c) => c.kind === "removed").length,
      modified: changes.filter((c) => c.kind === "modified").length,
      unchanged
    }
  };
}

// packages/rcs-core/src/rule-check.ts
import { readFileSync as readFileSync2, existsSync as existsSync2 } from "node:fs";

// packages/rcs-core/src/types.ts
function toResult(check, target, findings, extraStats = {}) {
  const stats = {
    total: findings.length,
    error: findings.filter((f) => f.severity === "error").length,
    warn: findings.filter((f) => f.severity === "warn").length,
    info: findings.filter((f) => f.severity === "info").length,
    ...extraStats
  };
  return {
    check,
    target,
    ok: (stats["error"] ?? 0) === 0,
    findings,
    stats
  };
}

// packages/rcs-core/src/rule-check.ts
function findUnfilled(v, path = "") {
  if (v === null) return [path || "(\u6839)"];
  if (Array.isArray(v)) return v.flatMap((x, i) => findUnfilled(x, `${path}[${i}]`));
  if (typeof v === "object") {
    return Object.entries(v).filter(([k]) => !k.startsWith("$")).flatMap(([k, x]) => findUnfilled(x, path ? `${path}.${k}` : k));
  }
  return [];
}
function loadConstraints(file) {
  if (!existsSync2(file)) {
    throw new Error(
      `\u7EA6\u675F\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${file}
\u8BF7\u5148\u7528 rcs_rule_import\uFF08\u6216 scripts/docx-to-rules.mjs\uFF09\u5BFC\u5165\u8BE5\u8D5B\u5B63\u7248\u672C\u7684\u89C4\u5219\u4E66\uFF0C\u5BFC\u5165\u65F6\u4F1A\u81EA\u52A8\u751F\u6210 constraints.json \u9AA8\u67B6\u3002`
    );
  }
  const parsed = JSON.parse(readFileSync2(file, "utf8"));
  const unfilled = findUnfilled(parsed);
  if (unfilled.length > 0) {
    throw new Error(
      `\u7EA6\u675F\u8868\u5C1A\u672A\u586B\u5199\u5B8C\u6210\uFF1A${file}
\u8FD8\u6709 ${unfilled.length} \u4E2A\u5B57\u6BB5\u662F null\uFF0C\u4F8B\u5982\uFF1A${unfilled.slice(0, 5).join("\u3001")}
\u6570\u503C\u7EA6\u675F\u8868\u4E0D\u505A\u81EA\u52A8\u63D0\u53D6\uFF08\u89C4\u5219\u89E3\u8BFB\u9519\u4E86\u4EE3\u4EF7\u662F\u6574\u5957\u65B9\u6848\u8FD4\u5DE5\uFF09\uFF0C\u8BF7\u5BF9\u7167 clauses.json \u9010\u6761\u586B\u5199\u5E76\u6838\u5BF9\u6761\u6B3E\u53F7\u540E\u518D\u7528\u672C\u5DE5\u5177\u3002`
    );
  }
  return parsed;
}
var NUMBER = String.raw`(\d+(?:\.\d+)?)`;
var PATTERNS = [
  { re: new RegExp(`${NUMBER}\\s*(?:V|v|\u4F0F\u7279?)\\b`, "g"), unit: "V", scale: 1 },
  { re: new RegExp(`${NUMBER}\\s*MPa`, "gi"), unit: "kPa", scale: 1e3 },
  { re: new RegExp(`${NUMBER}\\s*kPa`, "gi"), unit: "kPa", scale: 1 },
  { re: new RegExp(`${NUMBER}\\s*bar`, "gi"), unit: "kPa", scale: 100 },
  { re: new RegExp(`${NUMBER}\\s*(?:kg|\u5343\u514B|\u516C\u65A4)`, "gi"), unit: "kg", scale: 1 },
  { re: new RegExp(`${NUMBER}\\s*(?:mm|\u6BEB\u7C73)`, "gi"), unit: "mm", scale: 1 },
  { re: new RegExp(`${NUMBER}\\s*(?:cm|\u5398\u7C73)`, "gi"), unit: "mm", scale: 10 }
];
function extractQuantities(text) {
  const out = [];
  for (const { re, unit, scale } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      if (!Number.isFinite(n)) continue;
      const start = Math.max(0, m.index - 18);
      out.push({
        value: n * scale,
        unit,
        raw: m[0].trim(),
        context: text.slice(start, m.index + m[0].length + 8).replace(/\s+/g, " ")
      });
    }
  }
  return out;
}
function splitClauses(text) {
  return text.split(/[\u3002\uff1b;\uff0c,\n]/).filter((s) => s.trim().length > 0);
}
function keywordRules(c) {
  return [
    {
      id: "forbidden-power",
      keywords: c.electrical.forbidden.items.filter((s) => /电池|能源/.test(s)),
      severity: "error",
      clause: c.electrical.forbidden.clause,
      message: "\u7591\u4F3C\u4F7F\u7528\u88AB\u660E\u4EE4\u7981\u6B62\u7684\u80FD\u6E90/\u7535\u6C60"
    },
    {
      id: "aerial-forbidden",
      keywords: ["\u98DE\u884C", "\u65E0\u4EBA\u673A", "\u65CB\u7FFC", "\u87BA\u65CB\u6868"],
      severity: "error",
      clause: c.safety.forbidAerial.clause,
      message: "\u7591\u4F3C\u4F7F\u7528\u98DE\u884C\u673A\u6784 \u2014\u2014 \u51FA\u4E8E\u5B89\u5168\u4E0E\u673A\u6784\u51B2\u7A81\uFF0C\u4E25\u683C\u7981\u6B62"
    },
    {
      id: "laser-class",
      keywords: ["\u6FC0\u5149", "laser", "LiDAR", "\u96F7\u8FBE"],
      severity: "warn",
      clause: c.electrical.laser.clause,
      message: `\u4F7F\u7528\u6FC0\u5149\u987B\u7B26\u5408 ${c.electrical.laser.standard} \u7684 ${c.electrical.laser.allowedClasses.join("/")} \u7C7B\uFF0C\u5E76\u5B9E\u65BD\u76F8\u5E94\u5B89\u5168\u63AA\u65BD`
    },
    {
      id: "inter-robot-wireless",
      keywords: ["TR\u4E0EBR", "TR\u548CBR", "BR\u4E0ETR", "\u4E24\u8F66\u901A\u4FE1", "\u673A\u5668\u4EBA\u95F4\u901A\u4FE1", "\u53CC\u673A\u901A\u4FE1"],
      severity: "error",
      clause: c.wireless.interRobotForbidden.clause,
      message: "\u7591\u4F3C TR \u4E0E BR \u4E4B\u95F4\u65E0\u7EBF\u4E92\u901A \u2014\u2014 \u6BD4\u8D5B\u671F\u95F4\u4E25\u7981"
    }
  ];
}
function checkDesign(text, c) {
  const findings = [];
  const quantities = extractQuantities(text);
  const push = (rule, severity, message, clause, detail) => {
    findings.push({
      rule,
      severity,
      message,
      detail: `\u6761\u6B3E ${clause}${detail ? " \xB7 " + detail : ""} \xB7 \u4EE5\u5B98\u65B9\u89C4\u5219\u624B\u518C\u4E3A\u51C6`
    });
  };
  const battMax = c.electrical.batteryNominalVoltageMaxV;
  const circMax = c.electrical.circuitMaxVoltageV;
  const presMax = c.pneumatic.maxPressureKPa;
  const massMax = c.robots.massMaxKg;
  for (const q of quantities) {
    if (q.unit === "V") {
      if (q.value > circMax.value) {
        push(
          "voltage-over-circuit",
          "error",
          `\u7535\u538B ${q.raw} \u8D85\u8FC7\u7535\u8DEF\u4E0A\u9650 ${circMax.value}V`,
          circMax.clause,
          `\u4E0A\u4E0B\u6587\u300C${q.context}\u300D`
        );
      } else if (q.value > battMax.value) {
        push(
          "voltage-over-battery",
          "warn",
          `\u7535\u538B ${q.raw} \u8D85\u8FC7\u7535\u6C60\u6807\u79F0\u4E0A\u9650 ${battMax.value}V \u2014\u2014 \u82E5\u6307\u7535\u6C60\u6807\u79F0\u7535\u538B\u5219\u8FDD\u89C4\uFF0C\u82E5\u6307\u7535\u8DEF\u77AC\u65F6\u7535\u538B\u9700 \u2264${circMax.value}V`,
          `${battMax.clause}/${circMax.clause}`,
          `\u4E0A\u4E0B\u6587\u300C${q.context}\u300D`
        );
      }
    } else if (q.unit === "kPa" && q.value > presMax.value) {
      push(
        "pressure-over",
        "error",
        `\u6C14\u538B ${q.raw}\uFF08=${q.value}kPa\uFF09\u8D85\u8FC7\u4E0A\u9650 ${presMax.value}kPa`,
        presMax.clause,
        `\u4E0A\u4E0B\u6587\u300C${q.context}\u300D`
      );
    } else if (q.unit === "kg" && q.value > massMax.value) {
      push(
        "mass-over",
        "error",
        `\u91CD\u91CF ${q.raw} \u8D85\u8FC7\u4E0A\u9650 ${massMax.value}kg`,
        massMax.clause,
        `\u542B\u7535\u6C60\u3001\u63A7\u5236\u5668\u4E0E\u7535\u7F06 \xB7 \u4E0A\u4E0B\u6587\u300C${q.context}\u300D`
      );
    } else if (q.unit === "mm") {
      const start = c.robots.startEnvelopeMm;
      const ext = c.robots.extendedEnvelopeMm["TR"] ?? c.robots.extendedEnvelopeMm["BR"];
      const maxExt = ext ? Math.max(ext.w, ext.l, ext.h) : Infinity;
      if (q.value > maxExt) {
        push(
          "size-over-extended",
          "error",
          `\u5C3A\u5BF8 ${q.raw} \u8D85\u8FC7\u8FD0\u884C\u65F6\u6700\u5927\u8FB9 ${maxExt}mm`,
          ext?.clause ?? "11.5",
          `\u4E0A\u4E0B\u6587\u300C${q.context}\u300D`
        );
      } else if (q.value > start.l && /启动|初始|收拢|收起|入场/.test(q.context)) {
        push(
          "size-over-start",
          "warn",
          `\u5C3A\u5BF8 ${q.raw} \u8D85\u8FC7\u542F\u52A8\u7ACB\u65B9\u4F53 ${start.l}mm \u2014\u2014 \u4E0A\u4E0B\u6587\u63D0\u5230\u542F\u52A8/\u6536\u62E2\u72B6\u6001`,
          start.clause,
          `\u4E0A\u4E0B\u6587\u300C${q.context}\u300D`
        );
      }
    }
  }
  for (const rule of keywordRules(c)) {
    const hit = rule.keywords.find((k) => text.includes(k));
    if (hit) push(rule.id, rule.severity, `${rule.message}\uFF08\u547D\u4E2D\u300C${hit}\u300D\uFF09`, rule.clause);
  }
  if (c.safety.emergencyStop.required && !/急停|急停按钮|E-?Stop|紧急停止/i.test(text)) {
    push(
      "estop-missing",
      "warn",
      `\u63CF\u8FF0\u4E2D\u672A\u63D0\u5230\u6025\u505C \u2014\u2014 \u89C4\u5219\u8981\u6C42\u914D\u5907${c.safety.emergencyStop.spec}`,
      c.safety.emergencyStop.clause,
      "\u82E5\u8BBE\u8BA1\u4E2D\u5DF2\u6709\uFF0C\u5FFD\u7565\u672C\u6761"
    );
  }
  const brAuto = c.robots.autonomy?.["BR"];
  if (brAuto) {
    const segments = splitClauses(text);
    const bad = segments.find(
      (seg) => /\bBR\b|建筑机器人/.test(seg) && /手动|遥控|手柄|操作手/.test(seg) && !/\bTR\b|搬运机器人/.test(seg)
    );
    if (bad) {
      push(
        "br-must-be-auto",
        "error",
        `BR\uFF08\u5EFA\u7B51\u673A\u5668\u4EBA\uFF09\u5FC5\u987B\u5168\u81EA\u52A8\uFF0C\u4F46\u63CF\u8FF0\u4E2D\u51FA\u73B0\u300C${bad.trim()}\u300D`,
        brAuto.clause
      );
    }
  }
  return toResult("rule-check", `${c.season}/${c.version}`, findings, {
    quantities: quantities.length
  });
}

// packages/rcs-core/src/rule-import.ts
import { readFileSync as readFileSync3, writeFileSync, mkdirSync, existsSync as existsSync3, copyFileSync, readdirSync as readdirSync2 } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { join as join2, basename } from "node:path";
function readZipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 101010256) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("\u4E0D\u662F\u5408\u6CD5\u7684 ZIP/docx\uFF1A\u627E\u4E0D\u5230\u4E2D\u592E\u76EE\u5F55");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 33639248) throw new Error("\u4E2D\u592E\u76EE\u5F55\u6761\u76EE\u7B7E\u540D\u9519\u8BEF");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name2 = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (name2 === wanted) {
      if (buf.readUInt32LE(localOff) !== 67324752) throw new Error("\u672C\u5730\u6587\u4EF6\u5934\u7B7E\u540D\u9519\u8BEF");
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataOff = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataOff, dataOff + compSize);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ZIP \u4E2D\u627E\u4E0D\u5230\u6761\u76EE\uFF1A${wanted}`);
}
function decodeXml(s) {
  return s.replace(/<w:tab\/>/g, "	").replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}
function paragraphs(xml) {
  let doc = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "");
  doc = doc.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, (m) => {
    const boxes = m.match(/<w:txbxContent>[\s\S]*?<\/w:txbxContent>/g);
    return boxes ? boxes.join("") : "";
  });
  doc = doc.replace(/<w:pict>[\s\S]*?<\/w:pict>/g, "");
  const tables = [];
  doc = doc.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (m) => {
    tables.push(m);
    return `<<<TBL${tables.length - 1}>>>`;
  });
  const emitTable = (tblXml, out2) => {
    out2.push("<<TABLE>>");
    for (const tr of tblXml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []) {
      const cells = (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map(
        (tc) => decodeXml(tc).replace(/\s+/g, " ")
      );
      const row = cells.join(" | ");
      if (row.replace(/[\s|]/g, "")) out2.push(`| ${row} |`);
    }
    out2.push("<<END TABLE>>");
  };
  const out = [];
  for (const seg of doc.split(/(<<<TBL\d+>>>)/)) {
    const tbl = /^<<<TBL(\d+)>>>$/.exec(seg);
    if (tbl) {
      emitTable(tables[Number(tbl[1])] ?? "", out);
      continue;
    }
    for (const chunk of seg.split(/<w:p[ />]/)) {
      const t = decodeXml(chunk.replace(/^[^>]*>/, ""));
      if (t) out.push(t);
    }
  }
  return out;
}
function splitInlineClauses(line) {
  return line.split(/(?<=。)\s*(?=\d{1,2}(?:\.\d{1,2})+\s+[一-龥])/);
}
function toClauses(lines) {
  const clauses = [];
  let current = null;
  const numbered = /^(\d+(?:\.\d+)*)[.\s、]?\s*(.*)$/;
  for (const line of lines.flatMap(splitInlineClauses)) {
    const m = numbered.exec(line);
    const looksLikeClause = m && m[1] && m[2] !== void 0 && (m[1].includes(".") || m[2].length > 0 && m[2].length < 40 && !/^\d/.test(m[2]));
    if (looksLikeClause && m) {
      if (current) clauses.push(current);
      current = { id: m[1] ?? "", text: m[2] ?? "" };
    } else if (current) {
      current.text += (current.text ? "\n" : "") + line;
    } else {
      current = { id: "0", text: line };
    }
  }
  if (current) clauses.push(current);
  const seen = /* @__PURE__ */ new Set();
  return clauses.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    c.text = c.text.trim();
    return c.text.length > 0;
  });
}
function scaffoldConstraints(season, version, previous) {
  const hint = (path, fallback) => {
    const parts = path.split(".");
    let node = previous;
    for (const k of parts) {
      if (typeof node !== "object" || node === null) return fallback;
      node = node[k];
    }
    return typeof node === "string" ? node : fallback;
  };
  return {
    $comment: [
      `${season} \u8D5B\u5B63 ${version} \u7248\u7684\u6570\u503C\u7EA6\u675F\u8868 \u2014\u2014 **\u9700\u8981\u4EBA\u5DE5\u586B\u5199\u5E76\u6838\u5BF9**\u3002`,
      "\u6BCF\u4E2A value \u90FD\u662F null\uFF0C\u8BF7\u5BF9\u7167 clauses.json \u7684\u539F\u6587\u9010\u6761\u586B\u5165\uFF0C\u5E76\u628A clause \u6539\u6210\u672C\u7248\u771F\u5B9E\u6761\u6B3E\u53F7\u3002",
      "clause \u5B57\u6BB5\u7684\u521D\u59CB\u503C\u662F\u4E0A\u4E00\u7248\u7684\u6761\u6B3E\u53F7\uFF08\u4EC5\u4F5C\u67E5\u627E\u7EBF\u7D22\uFF09\uFF1B\u65B0\u7248\u6761\u6B3E\u53F7\u5927\u6982\u7387\u53D8\u4E86\uFF0C\u52A1\u5FC5\u6838\u5BF9\u3002",
      "\u672C\u6587\u4EF6\u4E0D\u505A\u81EA\u52A8\u63D0\u53D6\uFF1A\u89C4\u5219\u89E3\u8BFB\u9519\u8BEF\u7684\u4EE3\u4EF7\u662F\u6574\u5957\u65B9\u6848\u8FD4\u5DE5\uFF0C\u4E0D\u80FD\u8BA9\u6B63\u5219\u53BB\u731C\u54EA\u4E2A\u6570\u5B57\u662F\u4E0A\u9650\u3002",
      "\u586B\u5B8C\u540E\u8DD1 `npm run check -- rules` \u6216\u8BA9 Agent \u8C03 rcs_rule_check \u9A8C\u8BC1\u3002"
    ],
    competition: "robocon-cn",
    season,
    version,
    theme: null,
    tolerance: { value: null, clause: hint("tolerance.clause", "13.2"), note: "\u5C3A\u5BF8\u91CD\u91CF\u7684\u5236\u9020\u516C\u5DEE" },
    robots: {
      massMaxKg: { value: null, clause: hint("robots.massMaxKg.clause", "11.7"), note: "\u542B\u7535\u6C60\u3001\u63A7\u5236\u5668\u3001\u7535\u7F06" },
      startEnvelopeMm: { l: null, w: null, h: null, clause: hint("robots.startEnvelopeMm.clause", "11.4") },
      extendedEnvelopeMm: {
        TR: { w: null, l: null, h: null, clause: hint("robots.extendedEnvelopeMm.TR.clause", "11.5") },
        BR: { w: null, l: null, h: null, clause: hint("robots.extendedEnvelopeMm.BR.clause", "11.6") }
      },
      autonomy: {
        TR: { mode: null, clause: hint("robots.autonomy.TR.clause", "11.2") },
        BR: { mode: null, clause: hint("robots.autonomy.BR.clause", "11.3") }
      }
    },
    electrical: {
      batteryNominalVoltageMaxV: { value: null, clause: hint("electrical.batteryNominalVoltageMaxV.clause", "11.12") },
      circuitMaxVoltageV: { value: null, clause: hint("electrical.circuitMaxVoltageV.clause", "11.13") },
      powerSources: { allowed: [], clause: hint("electrical.powerSources.clause", "11.11") },
      forbidden: { clause: hint("electrical.forbidden.clause", "11.15"), items: [] },
      laser: { standard: "IEC 60825-1", allowedClasses: [], clause: hint("electrical.laser.clause", "11.15") }
    },
    pneumatic: {
      maxPressureKPa: { value: null, clause: hint("pneumatic.maxPressureKPa.clause", "11.14") }
    },
    wireless: {
      allowed: [],
      clause: hint("wireless.clause", "11.8"),
      interRobotForbidden: { value: null, clause: hint("wireless.interRobotForbidden.clause", "11.10") }
    },
    safety: {
      emergencyStop: { required: null, spec: null, clause: hint("safety.emergencyStop.clause", "12.2") },
      forbidAerial: { value: null, clause: hint("safety.forbidAerial.clause", "12.6") }
    },
    $todo: [
      "\u628A\u4E0A\u9762\u6240\u6709 null \u6362\u6210\u672C\u7248\u89C4\u5219\u7684\u771F\u5B9E\u6570\u503C",
      "\u6838\u5BF9\u6BCF\u4E2A clause \u662F\u5426\u6307\u5411\u672C\u7248\u7684\u6B63\u786E\u6761\u6B3E",
      "\u6309\u672C\u8D5B\u5B63\u5B9E\u9645\u60C5\u51B5\u8865\u5145 zones / items / scoring / match \u7B49\u5206\u8282\uFF08\u53EF\u53C2\u8003\u4E0A\u4E00\u7248\uFF09",
      "\u7B2C 14 \u8282\u82E5\u6709\u573A\u5730 RGB \u8272\u503C\uFF0C\u8865\u8FDB $visionColors\uFF0C\u4F9B\u89C6\u89C9\u7EC4\u505A\u9608\u503C"
    ]
  };
}
function countNulls(v) {
  if (v === null) return 1;
  if (Array.isArray(v)) return v.reduce((n, x) => n + countNulls(x), 0);
  if (typeof v === "object" && v !== null) {
    return Object.entries(v).filter(([k]) => !k.startsWith("$")).reduce((n, [, x]) => n + countNulls(x), 0);
  }
  return 0;
}
function importRulebook(docxPath, rulesRoot, season, version, options = {}) {
  if (!existsSync3(docxPath)) {
    throw new Error(`\u89C4\u5219\u4E66\u4E0D\u5B58\u5728\uFF1A${docxPath}`);
  }
  if (!/^\d{4}$/.test(season)) {
    throw new Error(`\u8D5B\u5B63\u5E94\u4E3A\u56DB\u4F4D\u5E74\u4EFD\uFF0C\u6536\u5230\u300C${season}\u300D`);
  }
  if (!/^[\w.\-]+$/.test(version)) {
    throw new Error(`\u7248\u672C\u540D\u53EA\u80FD\u662F\u5B57\u6BCD\u6570\u5B57\u4E0E . - _\uFF0C\u6536\u5230\u300C${version}\u300D`);
  }
  const dir = join2(rulesRoot, season, version);
  const existed = existsSync3(join2(dir, "clauses.json"));
  if (existed && !options.overwrite) {
    throw new Error(
      `${season}/${version} \u5DF2\u5B58\u5728\u3002\u82E5\u786E\u5B9E\u8981\u91CD\u65B0\u5BFC\u5165\uFF0C\u8BF7\u663E\u5F0F\u6307\u5B9A\u8986\u76D6 \u2014\u2014 \u5DF2\u6838\u5BF9\u8FC7\u7684\u89C4\u5219\u6570\u636E\u88AB\u6084\u6084\u6539\u6389\u662F\u5F88\u96BE\u53D1\u73B0\u7684\u3002`
    );
  }
  const xml = readZipEntry(readFileSync3(docxPath), "word/document.xml").toString("utf8");
  const lines = paragraphs(xml);
  const clauses = toClauses(lines);
  if (clauses.length < 10) {
    throw new Error(
      `\u53EA\u89E3\u6790\u51FA ${clauses.length} \u6761\u6761\u6B3E\uFF0C\u660E\u663E\u4E0D\u5BF9\u3002\u8BF7\u786E\u8BA4\u8FD9\u662F ROBOCON \u89C4\u5219\u4E66\u7684 .docx\uFF08\u4E0D\u662F .doc \u6216 PDF \u8F6C\u5B58\uFF09\u3002`
    );
  }
  mkdirSync(join2(dir, "source"), { recursive: true });
  copyFileSync(docxPath, join2(dir, "source", basename(docxPath)));
  const fullText = lines.join("\n");
  writeFileSync(join2(dir, "rules.txt"), fullText, "utf8");
  writeFileSync(
    join2(dir, "clauses.json"),
    JSON.stringify({ competition: "robocon-cn", season, version, clauses }, null, 2),
    "utf8"
  );
  writeFileSync(
    join2(dir, "meta.json"),
    JSON.stringify(
      {
        competition: "robocon-cn",
        season,
        version,
        sourceFile: basename(docxPath),
        paragraphs: lines.length,
        clauses: clauses.length,
        chars: fullText.length
      },
      null,
      2
    ),
    "utf8"
  );
  const constraintsPath = join2(dir, "constraints.json");
  let scaffolded = false;
  let constraints;
  if (existsSync3(constraintsPath)) {
    constraints = JSON.parse(readFileSync3(constraintsPath, "utf8"));
  } else {
    constraints = scaffoldConstraints(season, version, findPreviousConstraints(rulesRoot, season, version));
    writeFileSync(constraintsPath, JSON.stringify(constraints, null, 2), "utf8");
    scaffolded = true;
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
    overwrote: existed
  };
}
function findPreviousConstraints(rulesRoot, season, version) {
  const tryLoad = (s, v) => {
    const f = join2(rulesRoot, s, v, "constraints.json");
    if (!existsSync3(f)) return void 0;
    try {
      return JSON.parse(readFileSync3(f, "utf8"));
    } catch {
      return void 0;
    }
  };
  if (!existsSync3(rulesRoot)) return void 0;
  const seasons = readdirSync2(rulesRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  for (const s of [season, ...seasons.filter((x) => x !== season)]) {
    const dir = join2(rulesRoot, s);
    if (!existsSync3(dir)) continue;
    const versions = readdirSync2(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== version).map((e) => e.name).sort().reverse();
    for (const v of versions) {
      const c = tryLoad(s, v);
      if (c) return c;
    }
  }
  return void 0;
}

// packages/rcs-core/src/paths.ts
import { existsSync as existsSync4 } from "node:fs";
import { dirname, join as join3, resolve } from "node:path";
import { fileURLToPath } from "node:url";
function repoRootFrom(moduleUrl) {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..", "..");
}
var REPO_ROOT = repoRootFrom(import.meta.url);
var repoPaths = {
  config: () => join3(REPO_ROOT, "config"),
  teamConfig: () => join3(REPO_ROOT, "config", "team.json"),
  rulesRoot: () => join3(REPO_ROOT, "data", "rules"),
  kbCache: () => join3(REPO_ROOT, "data", "kb-cache")
};

// packages/rcs-ui/src/view-model.ts
function statsLine(stats) {
  if (typeof stats !== "object" || stats === null) return "";
  return Object.entries(stats).filter((e) => typeof e[1] === "number" && e[1] > 0).map(([k, v]) => `${k}=${v}`).join("  ");
}
function severityTone(s) {
  if (s === "error") return "critical";
  if (s === "warn") return "warning";
  return "neutral";
}
var LAYER_ORDER = ["RCS_HAL", "RCS_Module", "RCS_Support", "RCS_Template", "user"];
function layerOf(file) {
  if (!file) return "unknown";
  const normalized = file.replace(/\\/g, "/");
  for (const l of LAYER_ORDER) {
    if (normalized.includes(`${l}/`) || normalized.startsWith(l)) return l;
  }
  return "unknown";
}
function groupByFile(findings) {
  const groups = /* @__PURE__ */ new Map();
  for (const f of findings) {
    const path = f.file ?? "(\u65E0\u6587\u4EF6)";
    let g = groups.get(path);
    if (!g) {
      g = { path, layer: layerOf(f.file), matches: [] };
      groups.set(path, g);
    }
    const msg = f.message ?? "(\u65E0\u8BF4\u660E)";
    g.matches.push({
      lineNumber: f.line ?? 1,
      line: f.detail ? `${msg} \u2014 ${f.detail}` : msg
    });
  }
  return [...groups.values()];
}
function rankRootCauses(findings) {
  const map = /* @__PURE__ */ new Map();
  for (const f of findings) {
    const m = /->\s*([\w.\-]+\.h(?:pp)?)\s*->/.exec(f.detail ?? "");
    if (!m || !m[1]) continue;
    const header = m[1];
    let set = map.get(header);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      map.set(header, set);
    }
    if (f.file) set.add(f.file);
  }
  return [...map.entries()].map(([header, files]) => ({
    header,
    affectedFiles: files.size,
    samples: [...files].slice(0, 5)
  })).sort((a, b) => b.affectedFiles - a.affectedFiles);
}
function toneOf(score) {
  return score >= 80 ? "success" : score >= 50 ? "warning" : "critical";
}
function scoreOf(errors, warns) {
  return Math.max(0, 100 - errors * 5 - warns * 1);
}
function healthFromFindings(label, findings) {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  const score = scoreOf(errors, warns);
  return { score, tone: toneOf(score), breakdown: [{ label, errors, warns }] };
}
function toPresentationMeta(r, limit = 50) {
  const findings = r.findings ?? [];
  const shown = findings.slice(0, limit);
  const check = r.check ?? "check";
  return {
    kind: "rcs-check",
    check,
    target: r.target ?? "",
    ok: r.ok ?? false,
    groups: groupByFile(shown),
    rootCauses: rankRootCauses(findings),
    health: healthFromFindings(check, findings),
    total: findings.length,
    truncated: findings.length > limit
  };
}
function isRcsMeta(v) {
  if (typeof v !== "object" || v === null) return false;
  const o = v;
  return o["kind"] === "rcs-check" && Array.isArray(o["groups"]) && typeof o["total"] === "number";
}

// packages/rcs-ui/src/theme.ts
var TONE_MARK = {
  critical: "\u2717",
  warning: "!",
  neutral: "\xB7",
  success: "\u2713"
};

// packages/dsh-rcs-rules/src/index.ts
var name = "rcs-rules";
var inject = ["tools"];
var Config = Schema.object({
  // 默认留空 —— 回落到本仓库的 data/rules，见 rcs-core/paths.ts
  rulesRoot: Schema.string().default(""),
  season: Schema.string().default(""),
  constraintsVersion: Schema.string().default("")
});
var CLAUSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", description: "\u6761\u6B3E\u53F7\uFF0C\u5982 11.14" },
    title: { type: "string", description: "\u6761\u6B3E\u6807\u9898" },
    text: { type: "string", description: "\u6761\u6B3E\u539F\u6587" }
  }
};
var DISCLAIMER = "\u4EE5\u5B98\u65B9\u89C4\u5219\u624B\u518C\u4E3A\u51C6\uFF1B\u672C\u5DE5\u5177\u53EA\u505A\u68C0\u7D22\u4E0E\u673A\u68B0\u6BD4\u5BF9\uFF0C\u4E0D\u66FF\u4EE3\u4EBA\u5DE5\u6838\u5BF9\u3002";
function renderDiff(d) {
  const head = `\u89C4\u5219 diff  ${d.from.season}/${d.from.version} \u2192 ${d.to.season}/${d.to.version}
\u65B0\u589E ${d.stats.added}  \u5220\u9664 ${d.stats.removed}  \u4FEE\u6539 ${d.stats.modified}  \u672A\u53D8 ${d.stats.unchanged}`;
  if (d.changes.length === 0) return `${head}

\u4E24\u4E2A\u7248\u672C\u5B8C\u5168\u4E00\u81F4\u3002
${DISCLAIMER}`;
  const mark = { added: "+", removed: "-", modified: "~" };
  const body = d.changes.slice(0, 60).map((c) => {
    const head2 = `${mark[c.kind]} [${c.clauseId}]`;
    if (c.kind === "added") return `${head2} \u65B0\u589E\uFF1A${(c.after ?? "").slice(0, 160)}`;
    if (c.kind === "removed") return `${head2} \u5220\u9664\uFF1A${(c.before ?? "").slice(0, 160)}`;
    const sim = c.similarity !== void 0 ? `\uFF08\u76F8\u4F3C\u5EA6 ${(c.similarity * 100).toFixed(0)}%\uFF09` : "";
    return `${head2} \u4FEE\u6539${sim}
    \u65E7\uFF1A${(c.before ?? "").slice(0, 140)}
    \u65B0\uFF1A${(c.after ?? "").slice(0, 140)}`;
  });
  const more = d.changes.length > 60 ? `
\u2026 \u53E6\u6709 ${d.changes.length - 60} \u6761\u672A\u5217\u51FA` : "";
  return `${head}

${body.join("\n")}${more}

${DISCLAIMER}`;
}
function renderLookup(season, version, query, hits) {
  if (hits.length === 0) {
    return `\u5728 ${season}/${version} \u4E2D\u6CA1\u6709\u68C0\u7D22\u5230\u4E0E\u300C${query}\u300D\u76F8\u5173\u7684\u6761\u6B3E\u3002
${DISCLAIMER}`;
  }
  const body = hits.map((h) => `[${version} \xB7 \u6761\u6B3E ${h.id}]
${h.text}`).join("\n\n");
  return `${season}/${version} \u68C0\u7D22\u300C${query}\u300D\uFF0C\u547D\u4E2D ${hits.length} \u6761\uFF1A

${body}

${DISCLAIMER}`;
}
function renderCheck(r) {
  const findings = r.findings ?? [];
  const head = `\u8BBE\u8BA1\u5408\u89C4\u6BD4\u5BF9\uFF08${r.target ?? ""}\uFF09  ${statsLine(r.stats)}`;
  if (findings.length === 0) {
    return `${head}
\u672A\u53D1\u73B0\u7591\u4F3C\u8FDD\u89C4\u70B9\u3002\u6CE8\u610F\uFF1A\u672C\u5DE5\u5177\u53EA\u505A\u6570\u503C\u4E0E\u5173\u952E\u8BCD\u6BD4\u5BF9\uFF0C\u8986\u76D6\u4E0D\u4E86\u5168\u90E8\u89C4\u5219\u3002
${DISCLAIMER}`;
  }
  const body = findings.map((f) => {
    const mark = TONE_MARK[severityTone(f.severity)];
    return `${mark} [${f.rule ?? "?"}] ${f.message ?? ""}
    ${f.detail ?? ""}`;
  }).join("\n");
  return `${head}
${body}

${DISCLAIMER}`;
}
function renderImport(r) {
  const lines = [
    `\u5DF2\u5BFC\u5165 ${r.season}/${r.version}`,
    `\u6BB5\u843D ${r.paragraphs}  \u6761\u6B3E ${r.clauses}  \u5B57\u7B26 ${r.chars}`,
    `\u76EE\u5F55 ${r.dir}`
  ];
  if (r.overwrote) lines.push("\uFF08\u8986\u76D6\u4E86\u5DF2\u5B58\u5728\u7684\u7248\u672C\uFF09");
  if (r.constraintsScaffolded) {
    lines.push(
      "",
      `\u5DF2\u751F\u6210 constraints.json \u9AA8\u67B6\uFF0C\u5176\u4E2D ${r.constraintsPending} \u4E2A\u5B57\u6BB5\u5F85\u586B\u3002`,
      "\u6570\u503C\u7EA6\u675F\u8868**\u4E0D\u505A\u81EA\u52A8\u63D0\u53D6** \u2014\u2014 \u89C4\u5219\u89E3\u8BFB\u9519\u4E86\u4EE3\u4EF7\u662F\u6574\u5957\u65B9\u6848\u8FD4\u5DE5\u3002",
      "\u8BF7\u5BF9\u7167 clauses.json \u9010\u6761\u586B\u5199\uFF0C\u5E76\u6838\u5BF9\u6BCF\u4E2A clause \u662F\u5426\u6307\u5411\u672C\u7248\u771F\u5B9E\u6761\u6B3E\u53F7\u3002",
      "\u586B\u5B8C\u524D rcs_rule_check \u5BF9\u8BE5\u7248\u672C\u4E0D\u53EF\u7528\u3002"
    );
  } else if (r.constraintsPending > 0) {
    lines.push("", `\u6CE8\u610F\uFF1A\u5DF2\u6709\u7684 constraints.json \u8FD8\u6709 ${r.constraintsPending} \u4E2A\u5B57\u6BB5\u662F null\u3002`);
  }
  lines.push("", "\u4E0B\u4E00\u6B65\uFF1A\u7528 rcs_rule_diff \u5BF9\u6BD4\u4E0A\u4E00\u7248\uFF0C\u4EBA\u5DE5\u6838\u5BF9\u6D89\u53CA\u673A\u68B0/\u7535\u63A7\u7684\u6539\u52A8\u3002");
  return lines.join("\n");
}
function renderVersions(v) {
  if (v.seasons.length === 0) {
    return "\u89C4\u5219\u5E93\u662F\u7A7A\u7684\u3002\u7528 rcs_rule_import \u5BFC\u5165\u4E00\u4EFD\u89C4\u5219\u4E66 .docx \u540E\u518D\u6765\u3002";
  }
  return [
    "\u89C4\u5219\u5E93\u73B0\u6709\u5185\u5BB9\uFF1A",
    ...v.seasons.map((s) => `  ${s.season}: ${s.versions.join(", ")}`),
    "",
    "\u7528 rcs_rule_import \u53EF\u4EE5\u5BFC\u5165\u65B0\u8D5B\u5B63\u6216\u65B0\u7248\u672C\u7684\u89C4\u5219\u4E66\u3002"
  ].join("\n");
}
function callView(title, input) {
  return { card: "generic", title, kind: "search", rawInput: input };
}
function splitLines(text) {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0);
}
function isLookupMeta(v) {
  return typeof v === "object" && v !== null && v.kind === "rcs-rule-lookup" && Array.isArray(v.hits);
}
function lookupResultView(result) {
  const meta = result.meta;
  if (!isLookupMeta(meta)) return void 0;
  if (meta.hits.length === 0) {
    return { card: "generic", title: `\u89C4\u5219\u68C0\u7D22\u300C${meta.query}\u300D\u2014 \u65E0\u547D\u4E2D` };
  }
  return {
    card: "search",
    shape: "matches",
    title: `${meta.season}/${meta.version} \u68C0\u7D22\u300C${meta.query}\u300D\u2014 ${meta.hits.length} \u6761`,
    files: meta.hits.map((h) => ({
      path: `${meta.version} \xB7 \u6761\u6B3E ${h.id}`,
      matches: splitLines(h.text).map((line, i) => ({ lineNumber: i + 1, line }))
    })),
    truncated: false,
    total: meta.hits.length
  };
}
function isDiffMeta(v) {
  return typeof v === "object" && v !== null && v.kind === "rcs-rule-diff";
}
function diffResultView(result) {
  const meta = result.meta;
  if (!isDiffMeta(meta)) return void 0;
  const total = meta.added + meta.removed + meta.modified;
  const title = total === 0 ? `\u89C4\u5219 ${meta.from} \u2192 ${meta.to} \u2014 \u65E0\u6539\u52A8` : `\u89C4\u5219 ${meta.from} \u2192 ${meta.to} \u2014 \u65B0\u589E ${meta.added} / \u5220\u9664 ${meta.removed} / \u4FEE\u6539 ${meta.modified}`;
  return { card: "generic", title };
}
function checkResultView(result) {
  const meta = result.meta;
  if (!isRcsMeta(meta)) return void 0;
  if (meta.groups.length === 0) return { card: "generic", title: "\u5408\u89C4\u6BD4\u5BF9 \u2014 \u672A\u53D1\u73B0\u7591\u4F3C\u8FDD\u89C4\u70B9" };
  return {
    card: "search",
    shape: "matches",
    title: `\u5408\u89C4\u6BD4\u5BF9 \u2014 ${meta.total} \u6761\u5F85\u6838\u5BF9`,
    files: meta.groups.map((g) => ({ path: g.path, matches: g.matches })),
    truncated: meta.truncated,
    total: meta.total
  };
}
function shared(ctx) {
  try {
    const get = ctx.get;
    return typeof get === "function" ? get.call(ctx, "rcs") : void 0;
  } catch {
    return void 0;
  }
}
function apply(ctx, config) {
  const rulesRoot = () => shared(ctx)?.rulesRoot || config.rulesRoot || repoPaths.rulesRoot();
  const season = (override) => {
    const s = override || shared(ctx)?.season || config.season;
    if (!s) {
      throw new Error(
        "\u6CA1\u6709\u6307\u5B9A\u8D5B\u5B63\u3002\u8BF7\u5728\u5DE5\u5177\u53C2\u6570\u91CC\u4F20 season\uFF0C\u6216\u5728 config/team.json \u91CC\u8BBE season\uFF08\u7531 dsh-rcs-core \u7ECF ctx.rcs \u63D0\u4F9B\uFF09\uFF0C\u6216\u5728\u672C\u63D2\u4EF6\u914D\u7F6E\u91CC\u8BBE season\u3002\u672C\u63D2\u4EF6\u523B\u610F\u4E0D\u7ED9\u9ED8\u8BA4\u5E74\u4EFD \u2014\u2014 \u62FF\u9519\u5E74\u4EFD\u7684\u89C4\u5219\u505A\u5224\u65AD\uFF0C\u6BD4\u76F4\u63A5\u62A5\u9519\u5371\u9669\u5F97\u591A\u3002"
      );
    }
    return s;
  };
  const source = () => new JsonRuleSource(rulesRoot());
  ctx.tools.register(
    defineTool({
      name: "rcs_rule_diff",
      description: "\u5BF9\u6BD4\u4E24\u4E2A\u7248\u672C\u7684 ROBOCON \u89C4\u5219\uFF0C\u5217\u51FA\u65B0\u589E/\u5220\u9664/\u4FEE\u6539\u7684\u6761\u6B3E\u3002\u89C4\u5219\u8D5B\u5B63\u5185\u4F1A\u53CD\u590D\u6539\u7248\uFF082027 \u7684 V0 \u662F ABU \u7FFB\u8BD1\u7A3F\uFF0C\u56FD\u5185\u8D5B V1 \u5373\u5C06\u53D1\u5E03\uFF09\uFF0C\u6F0F\u770B\u4E00\u6761\u6539\u52A8\u53EF\u80FD\u8BA9\u6574\u5957\u673A\u6784\u8FD4\u5DE5\uFF0C\u6240\u4EE5\u6539\u52A8\u6E05\u5355\u6BD4\u5168\u6587\u66F4\u91CD\u8981\u3002",
      parameters: {
        fromVersion: { type: "string", required: true, description: "\u65E7\u7248\u672C\uFF0C\u5982 V0" },
        toVersion: { type: "string", required: true, description: "\u65B0\u7248\u672C\uFF0C\u5982 V1" },
        season: { type: "string", description: "\u8D5B\u5B63\uFF0C\u7701\u7565\u7528\u63D2\u4EF6\u914D\u7F6E\u7684\u9ED8\u8BA4\u503C" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            from: { type: "json", description: "\u65E7\u7248\u672C\u6807\u8BC6" },
            to: { type: "json", description: "\u65B0\u7248\u672C\u6807\u8BC6" },
            stats: { type: "json", description: "\u65B0\u589E/\u5220\u9664/\u4FEE\u6539/\u672A\u53D8 \u8BA1\u6570" },
            changes: { type: "json", description: "\u9010\u6761\u6539\u52A8" }
          }
        },
        render: (_args, value) => [
          { type: "text", text: renderDiff(value) }
        ],
        presentationMeta: (_args, value) => {
          const d = value;
          return {
            kind: "rcs-rule-diff",
            from: `${d.from.season}/${d.from.version}`,
            to: `${d.to.season}/${d.to.version}`,
            added: d.stats.added,
            removed: d.stats.removed,
            modified: d.stats.modified
          };
        }
      },
      presentCall: (args) => callView("\u89C4\u5219\u7248\u672C\u5BF9\u6BD4", `${args.fromVersion} \u2192 ${args.toVersion}`),
      presentResult: (_args, result) => diffResultView(result),
      async execute(args) {
        const s = season(args.season);
        const src = source();
        const [from, to] = await Promise.all([
          src.load(s, args.fromVersion),
          src.load(s, args.toVersion)
        ]);
        return diffRuleDocuments(from, to);
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_rule_lookup",
      description: "\u68C0\u7D22 ROBOCON \u89C4\u5219\u6761\u6B3E\uFF0C\u8FD4\u56DE\u6761\u6B3E\u53F7 + \u7248\u672C\u53F7 + \u539F\u6587\u3002\u53EF\u76F4\u63A5\u7ED9\u6761\u6B3E\u53F7\uFF08\u5982 11.14\uFF09\u7CBE\u786E\u5B9A\u4F4D\uFF0C\u4E5F\u53EF\u7ED9\u5173\u952E\u8BCD\uFF08\u5982\u300C\u6C14\u538B\u4E0A\u9650\u300D\u300C\u6025\u505C\u300D\uFF09\u3002\u672C\u5DE5\u5177\u53EA\u505A\u68C0\u7D22\u4E0D\u505A\u89E3\u8BFB \u2014\u2014 \u89C4\u5219\u89E3\u8BFB\u9519\u4E86\u4EE3\u4EF7\u662F\u6574\u5957\u65B9\u6848\u8FD4\u5DE5\u3002",
      parameters: {
        query: { type: "string", required: true, description: "\u5173\u952E\u8BCD\u6216\u6761\u6B3E\u53F7" },
        season: { type: "string", description: "\u8D5B\u5B63\uFF0C\u7701\u7565\u7528\u9ED8\u8BA4\u503C" },
        version: { type: "string", description: "\u7248\u672C\uFF0C\u7701\u7565\u7528\u8BE5\u8D5B\u5B63\u6700\u65B0\u7248\u672C" },
        limit: { type: "integer", description: "\u6700\u591A\u8FD4\u56DE\u51E0\u6761\uFF0C\u9ED8\u8BA4 8" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            season: { type: "string", description: "\u8D5B\u5B63" },
            version: { type: "string", description: "\u7248\u672C" },
            query: { type: "string", description: "\u67E5\u8BE2\u4E32" },
            hits: { type: "array", items: CLAUSE_SCHEMA, description: "\u547D\u4E2D\u6761\u6B3E" }
          }
        },
        render: (_args, value) => [
          {
            type: "text",
            text: renderLookup(
              value.season ?? "",
              value.version ?? "",
              value.query ?? "",
              (value.hits ?? []).map((h) => ({
                id: h.id ?? "",
                text: h.text ?? "",
                score: 0
              }))
            )
          }
        ],
        presentationMeta: (_args, value) => ({
          kind: "rcs-rule-lookup",
          season: value.season ?? "",
          version: value.version ?? "",
          query: value.query ?? "",
          hits: (value.hits ?? []).map((h) => ({ id: h.id ?? "", text: h.text ?? "" }))
        })
      },
      presentCall: (args) => callView("\u89C4\u5219\u6761\u6B3E\u68C0\u7D22", args.query),
      presentResult: (_args, result) => lookupResultView(result),
      async execute(args) {
        const s = season(args.season);
        const src = source();
        const version = args.version ?? (await src.listVersions(s)).at(-1);
        if (!version) throw new Error(`\u8D5B\u5B63 ${s} \u4E0B\u6CA1\u6709\u4EFB\u4F55\u89C4\u5219\u7248\u672C`);
        const doc = await src.load(s, version);
        const hits = searchClauses(doc, args.query, args.limit ?? 8);
        return {
          season: s,
          version,
          query: args.query,
          hits: hits.map((h) => ({ id: h.clause.id, text: h.clause.text }))
        };
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_rule_check",
      description: "\u62FF\u4E00\u6BB5\u8BBE\u8BA1\u63CF\u8FF0\u6BD4\u5BF9\u89C4\u5219\u7EA6\u675F\uFF0C\u5217\u51FA\u7591\u4F3C\u8FDD\u89C4\u70B9\uFF08\u7535\u538B\u3001\u6C14\u538B\u3001\u91CD\u91CF\u3001\u5C3A\u5BF8\u3001\u7981\u7528\u80FD\u6E90\u3001\u98DE\u884C\u673A\u6784\u3001BR \u5FC5\u987B\u5168\u81EA\u52A8\u3001\u6025\u505C\u6309\u94AE\u7B49\uFF09\uFF0C\u6BCF\u6761\u90FD\u5E26\u6761\u6B3E\u53F7\u3002\u53EA\u505A\u6570\u503C\u4E0E\u5173\u952E\u8BCD\u7684\u673A\u68B0\u6BD4\u5BF9\uFF0C\u8986\u76D6\u4E0D\u4E86\u5168\u90E8\u89C4\u5219\uFF0C\u4E0D\u66FF\u4EE3\u4EBA\u5DE5\u6838\u5BF9\u3002",
      parameters: {
        design: { type: "string", required: true, description: "\u8BBE\u8BA1\u63CF\u8FF0\uFF0C\u81EA\u7136\u8BED\u8A00\u5373\u53EF" },
        season: { type: "string", description: "\u8D5B\u5B63\uFF0C\u7701\u7565\u7528\u9ED8\u8BA4\u503C" },
        version: { type: "string", description: "\u7EA6\u675F\u8868\u7248\u672C\uFF0C\u7701\u7565\u7528\u63D2\u4EF6\u914D\u7F6E\u7684\u9ED8\u8BA4\u503C" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            check: { type: "string", description: "\u68C0\u67E5\u5668\u540D" },
            target: { type: "string", description: "\u8D5B\u5B63/\u7248\u672C" },
            ok: { type: "boolean", description: "\u65E0 error \u7EA7\u53D1\u73B0\u5373\u4E3A true" },
            stats: { type: "json", description: "\u8BA1\u6570" },
            findings: {
              type: "array",
              description: "\u7591\u4F3C\u8FDD\u89C4\u70B9",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  rule: { type: "string", description: "\u89C4\u5219 ID" },
                  severity: { type: "string", enum: ["error", "warn", "info"], description: "\u4E25\u91CD\u7EA7\u522B" },
                  message: { type: "string", description: "\u8BF4\u660E" },
                  file: { type: "string", description: "\u4E0D\u9002\u7528" },
                  line: { type: "integer", description: "\u4E0D\u9002\u7528" },
                  detail: { type: "string", description: "\u6761\u6B3E\u53F7\u4E0E\u4E0A\u4E0B\u6587" }
                }
              }
            }
          }
        },
        render: (_args, value) => [{ type: "text", text: renderCheck(value) }],
        presentationMeta: (_args, value) => toPresentationMeta(value)
      },
      presentCall: (args) => callView("\u8BBE\u8BA1\u5408\u89C4\u6BD4\u5BF9", args.design.slice(0, 60)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        const s = season(args.season);
        const version = args.version || shared(ctx)?.rulesVersion || config.constraintsVersion || (await source().listVersions(s)).at(-1);
        if (!version) {
          throw new Error(`\u8D5B\u5B63 ${s} \u4E0B\u6CA1\u6709\u4EFB\u4F55\u89C4\u5219\u7248\u672C\uFF0C\u8BF7\u5148\u7528 rcs_rule_import \u5BFC\u5165\u89C4\u5219\u4E66\u3002`);
        }
        const c = loadConstraints(join4(rulesRoot(), s, version, "constraints.json"));
        return checkDesign(args.design, c);
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_rule_import",
      description: "\u5BFC\u5165\u4E00\u4EFD\u65B0\u7684 ROBOCON \u89C4\u5219\u4E66\uFF08.docx\uFF09\uFF0C\u843D\u5E93\u5230 data/rules/<\u8D5B\u5B63>/<\u7248\u672C>/\u3002\u6BCF\u5E74\u6362\u4E3B\u9898\u3001\u8D5B\u5B63\u5185\u8FD8\u53CD\u590D\u6539\u7248\uFF0C\u6240\u4EE5\u8FD9\u662F\u5E38\u89C4\u64CD\u4F5C\u800C\u975E\u4E00\u6B21\u6027\u811A\u672C\u3002\u5BFC\u5165\u540E\u4F1A\u81EA\u52A8\u751F\u6210 constraints.json \u9AA8\u67B6\uFF08\u6570\u503C\u7EA6\u675F\u8868**\u9700\u4EBA\u5DE5\u586B\u5199**\uFF0C\u4E0D\u505A\u81EA\u52A8\u63D0\u53D6\uFF09\u3002\u5BFC\u5165\u5B8C\u6210\u540E\u901A\u5E38\u7D27\u63A5\u7740\u7528 rcs_rule_diff \u5BF9\u6BD4\u4E0A\u4E00\u7248\u3002",
      parameters: {
        docxPath: { type: "string", required: true, description: "\u89C4\u5219\u4E66 .docx \u7684\u8DEF\u5F84" },
        season: { type: "string", required: true, description: "\u8D5B\u5B63\uFF0C\u56DB\u4F4D\u5E74\u4EFD\uFF0C\u5982 2028" },
        version: { type: "string", required: true, description: "\u7248\u672C\u540D\uFF0C\u5982 V0 / V1 / abu" },
        overwrite: {
          type: "boolean",
          description: "\u8BE5\u7248\u672C\u5DF2\u5B58\u5728\u65F6\u662F\u5426\u8986\u76D6\u3002\u9ED8\u8BA4 false \u2014\u2014 \u5DF2\u6838\u5BF9\u8FC7\u7684\u89C4\u5219\u6570\u636E\u88AB\u6084\u6084\u6539\u6389\u5F88\u96BE\u53D1\u73B0"
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            season: { type: "string", description: "\u8D5B\u5B63" },
            version: { type: "string", description: "\u7248\u672C" },
            dir: { type: "string", description: "\u843D\u5E93\u76EE\u5F55" },
            paragraphs: { type: "integer", description: "\u63D0\u53D6\u5230\u7684\u6BB5\u843D\u6570" },
            clauses: { type: "integer", description: "\u5207\u5206\u51FA\u7684\u6761\u6B3E\u6570" },
            chars: { type: "integer", description: "\u5168\u6587\u5B57\u7B26\u6570" },
            constraintsScaffolded: { type: "boolean", description: "\u662F\u5426\u65B0\u751F\u6210\u4E86\u7EA6\u675F\u8868\u9AA8\u67B6" },
            constraintsPending: { type: "integer", description: "\u7EA6\u675F\u8868\u4E2D\u4ECD\u5F85\u586B\u7684\u5B57\u6BB5\u6570" },
            overwrote: { type: "boolean", description: "\u662F\u5426\u8986\u76D6\u4E86\u5DF2\u5B58\u5728\u7684\u7248\u672C" }
          }
        },
        render: (_args, value) => [
          { type: "text", text: renderImport(value) }
        ]
      },
      presentCall: (args) => callView("\u5BFC\u5165\u89C4\u5219\u4E66", `${args.season}/${args.version}`),
      async execute(args) {
        return importRulebook(args.docxPath, rulesRoot(), args.season, args.version, {
          overwrite: args.overwrite === true
        });
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_rule_versions",
      description: "\u5217\u51FA\u89C4\u5219\u5E93\u91CC\u5DF2\u6709\u7684\u8D5B\u5B63\u4E0E\u7248\u672C\u3002\u4E0D\u786E\u5B9A\u8BE5\u7528\u54EA\u4E2A\u7248\u672C\u3001\u6216\u60F3\u77E5\u9053\u80FD\u4E0D\u80FD\u505A diff \u65F6\u5148\u8C03\u5B83\u3002",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            seasons: { type: "json", description: "\u8D5B\u5B63\u4E0E\u5176\u4E0B\u7684\u7248\u672C\u5217\u8868" }
          }
        },
        render: (_args, value) => [
          {
            type: "text",
            text: renderVersions(
              value
            )
          }
        ]
      },
      presentCall: () => callView("\u5217\u51FA\u89C4\u5219\u7248\u672C", rulesRoot()),
      async execute() {
        const src = source();
        const seasons = [];
        for (const season2 of src.listSeasons()) {
          try {
            seasons.push({ season: season2, versions: await src.listVersions(season2) });
          } catch {
          }
        }
        return { seasons };
      }
    })
  );
  ctx.effect(() => {
    return () => {
    };
  });
}
export {
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
