// packages/dsh-rcs-control/src/index.ts
import { join as join13 } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

// packages/rcs-core/src/index.ts
import { readFileSync as readFileSync9 } from "node:fs";

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

// packages/rcs-core/src/fsutil.ts
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, basename, extname } from "node:path";
var DEFAULT_SKIP = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".vscode",
  ".eide",
  "build",
  "OBJ",
  "Objects",
  "Listings",
  "DebugConfig",
  "RTE",
  "__pycache__",
  ".codex-backup"
]);
function walkFiles(root, options = {}) {
  if (!existsSync(root)) return [];
  const skip = /* @__PURE__ */ new Set([
    ...options.noDefaultSkip ? [] : DEFAULT_SKIP,
    ...options.skipDirs ?? []
  ]);
  const exts = options.extensions ? new Set(options.extensions) : void 0;
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name2 of entries) {
      const full = join(dir, name2);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!skip.has(name2)) visit(full);
      } else if (st.isFile()) {
        if (!exts || exts.has(extname(name2))) out.push(full);
      }
    }
  };
  visit(root);
  return out.sort();
}
function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
function relPath(root, file) {
  return relative(root, file).split(sep).join("/");
}
function fileExists(p) {
  return existsSync(p);
}
var INCLUDE_RE = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/;
function parseIncludes(source) {
  const out = [];
  const lines = source.split(/\r?\n/);
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    for (; ; ) {
      const start = line.indexOf("/*");
      if (start === -1) break;
      const end = line.indexOf("*/", start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        inBlockComment = true;
        break;
      }
      line = line.slice(0, start) + " " + line.slice(end + 2);
    }
    const lineComment = line.indexOf("//");
    if (lineComment !== -1) line = line.slice(0, lineComment);
    const m = INCLUDE_RE.exec(line);
    if (m) {
      out.push({
        header: (m[2] ?? "").trim(),
        kind: m[1] === "<" ? "system" : "local",
        line: i + 1
      });
    }
  }
  return out;
}
function isCppFile(file) {
  return [".c", ".cpp", ".cc", ".h", ".hpp"].includes(extname(file));
}
function fileName(p) {
  return basename(p);
}

// packages/rcs-core/src/layer-lint.ts
import { join as join2 } from "node:path";
function buildHeaderIndex(libRoot) {
  const index = /* @__PURE__ */ new Map();
  for (const f of walkFiles(libRoot, { extensions: [".h", ".hpp"] })) {
    const name2 = fileName(f);
    if (!index.has(name2)) index.set(name2, f);
  }
  return index;
}
function findForbidden(entry, rule, headerIndex) {
  const forbid = rule.forbidHeaders.map((p) => new RegExp(p, "i"));
  const allow = new Set(rule.allowHeaders ?? []);
  const violations = [];
  const seenHeader = /* @__PURE__ */ new Set();
  const visitedFile = /* @__PURE__ */ new Set([entry]);
  const queue = [{ file: entry, chain: [] }];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur) break;
    const includes = parseIncludes(readText(cur.file));
    for (const inc of includes) {
      const base = fileName(inc.header);
      if (allow.has(base)) continue;
      if (forbid.some((re) => re.test(base))) {
        if (!seenHeader.has(base)) {
          seenHeader.add(base);
          violations.push({
            header: base,
            chain: [...cur.chain, base],
            line: cur.chain.length === 0 ? inc.line : void 0
          });
        }
        continue;
      }
      if (!rule.transitive) continue;
      const resolved = headerIndex.get(base);
      if (resolved && !visitedFile.has(resolved)) {
        visitedFile.add(resolved);
        queue.push({ file: resolved, chain: [...cur.chain, base] });
      }
    }
  }
  return violations;
}
function checkPurity(libRoot, rule, config) {
  const layer = config.layers.find((l) => l.layer === rule.layer);
  if (!layer) return [];
  const layerDir = join2(libRoot, layer.dir);
  const headerIndex = buildHeaderIndex(libRoot);
  const findings = [];
  for (const file of walkFiles(layerDir, { extensions: [".c", ".cpp", ".h", ".hpp"] })) {
    const violations = findForbidden(file, rule, headerIndex);
    if (violations.length === 0) continue;
    const groups = /* @__PURE__ */ new Map();
    for (const v of violations) {
      const key = v.chain[0] ?? v.header;
      const g = groups.get(key);
      if (g) g.push(v);
      else groups.set(key, [v]);
    }
    for (const [firstHop, vs] of groups) {
      const head = vs[0];
      if (!head) continue;
      const isDirect = head.chain.length === 1;
      if (isDirect) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          message: `${rule.message}\uFF1A\u76F4\u63A5 include ${head.header}`,
          file: relPath(libRoot, file),
          ...head.line !== void 0 ? { line: head.line } : {},
          detail: "\u76F4\u63A5\u4F9D\u8D56 \u2014\u2014 \u5220\u9664\u8BE5 include\uFF0C\u6216\u628A\u9700\u8981 RTOS \u7684\u90E8\u5206\u4E0B\u6C89\u5230 RCS_HAL\u3002"
        });
      } else {
        const leaves = vs.map((v) => v.header);
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          message: `${rule.message}\uFF1A\u7ECF ${firstHop} \u4F20\u9012\u5F15\u5165 ${leaves.length} \u4E2A\u5382\u5546/RTOS \u5934`,
          file: relPath(libRoot, file),
          detail: `${fileName(file)} -> ${firstHop} -> {${leaves.slice(0, 4).join(", ")}${leaves.length > 4 ? ` \u2026\u5171 ${leaves.length} \u4E2A` : ""}}\u3002${firstHop} \u672C\u8EAB\u662F\u6C61\u67D3\u6E90\u3002`
        });
      }
    }
  }
  return findings;
}
function checkActorBase(libRoot, rule) {
  const dir = join2(libRoot, rule.dir);
  const exempt = new Set(rule.exempt ?? []);
  const findings = [];
  const headerIndex = buildHeaderIndex(libRoot);
  const baseRe = new RegExp(`:\\s*(public|protected|private)?\\s*${rule.baseClass}\\b`);
  for (const file of walkFiles(dir, { extensions: [".cpp", ".c"] })) {
    const base = fileName(file);
    if (exempt.has(base)) continue;
    const header = headerIndex.get(base.replace(/\.(cpp|c)$/, ".h"));
    const text = readText(file) + (header ? "\n" + readText(header) : "");
    if (!baseRe.test(text)) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        message: rule.message,
        file: relPath(libRoot, file),
        detail: `\u672A\u627E\u5230\u7EE7\u627F ${rule.baseClass} \u7684\u58F0\u660E\u3002\u7ED5\u8FC7\u6267\u884C\u5668\u603B\u7EBF\u4F1A\u5BFC\u81F4\u63A7\u5236\u4E0D\u8FDE\u7EED\u3002`
      });
    }
  }
  return findings;
}
function checkThemeCode(libRoot, rule) {
  const patterns = rule.patterns.map((p) => new RegExp(p, "i"));
  const findings = [];
  for (const file of walkFiles(libRoot, { extensions: [".c", ".cpp", ".h", ".hpp"] })) {
    const rel = relPath(libRoot, file);
    if (rel.startsWith(rule.confineTo + "/")) continue;
    const base = fileName(file);
    if (patterns.some((re) => re.test(base))) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        message: rule.message,
        file: rel,
        detail: `\u6587\u4EF6\u540D\u547D\u4E2D\u4E3B\u9898\u4EE3\u7801\u7279\u5F81\u3002RCS/ \u662F\u8DE8\u8D5B\u5B63\u8D44\u4EA7\uFF0C\u4E3B\u9898\u76F8\u5173\u4EE3\u7801\u5E94\u79FB\u5165 ${rule.confineTo}/\u3002`
      });
    }
  }
  return findings;
}
function lintLayers(projectRoot, config) {
  const libRoot = join2(projectRoot, config.libRoot);
  const findings = [];
  for (const rule of config.purityRules) {
    findings.push(...checkPurity(libRoot, rule, config));
  }
  if (config.actorRule) findings.push(...checkActorBase(libRoot, config.actorRule));
  if (config.themeRule) findings.push(...checkThemeCode(libRoot, config.themeRule));
  const byRule = {};
  for (const f of findings) byRule[`rule:${f.rule}`] = (byRule[`rule:${f.rule}`] ?? 0) + 1;
  return toResult("layer-lint", libRoot, findings, byRule);
}

// packages/rcs-core/src/template-gap.ts
import { join as join3 } from "node:path";
function stemsOf(dir) {
  const map = /* @__PURE__ */ new Map();
  for (const f of walkFiles(dir, { extensions: [".c", ".cpp", ".h", ".hpp"] })) {
    const stem = fileName(f).replace(/\.(c|cpp|h|hpp)$/, "");
    if (!map.has(stem)) map.set(stem, f);
  }
  return map;
}
function analyzeTemplateGap(projectRoot, manifest) {
  const dir = join3(projectRoot, manifest.templateDir);
  const stems = stemsOf(dir);
  const statuses = [];
  for (const ex of manifest.examples) {
    let state = "missing";
    let matched;
    if (stems.has(ex.name)) {
      state = "present";
      matched = ex.name;
    } else {
      const alias = (ex.aliases ?? []).find((a) => stems.has(a));
      if (alias) {
        state = "alias";
        matched = alias;
      }
    }
    statuses.push({
      name: ex.name,
      step: ex.step,
      topic: ex.topic,
      state,
      ...matched ? { matchedFile: matched } : {},
      critical: ex.critical === true,
      ...ex.note ? { note: ex.note } : {}
    });
  }
  return {
    planned: statuses.length,
    present: statuses.filter((s) => s.state !== "missing").length,
    missing: statuses.filter((s) => s.state === "missing").length,
    statuses
  };
}
function checkTemplateGap(projectRoot, manifest) {
  const report = analyzeTemplateGap(projectRoot, manifest);
  const findings = [];
  for (const s of report.statuses) {
    if (s.state === "missing") {
      findings.push({
        rule: s.critical ? "template-missing-critical" : "template-missing",
        severity: s.critical ? "error" : "warn",
        message: `\u4F8B\u7A0B\u7F3A\u5931\uFF1A${s.name}\uFF08step${s.step} \xB7 ${s.topic}\uFF09`,
        file: `${manifest.templateDir}/${s.name}`,
        ...s.note ? { detail: s.note } : {}
      });
    } else if (s.state === "alias") {
      findings.push({
        rule: "template-name-mismatch",
        severity: "info",
        message: `\u4F8B\u7A0B\u540D\u4E0E\u8BA1\u5212\u4E0D\u4E00\u81F4\uFF1A\u8BA1\u5212 ${s.name}\uFF0C\u5B9E\u9645 ${s.matchedFile}`,
        file: `${manifest.templateDir}/${s.matchedFile}`,
        detail: "\u5EFA\u8BAE\u5BF9\u9F50\u547D\u540D\uFF0C\u6216\u5728 template-manifest.json \u4E2D\u786E\u8BA4\u6B64\u522B\u540D\u3002"
      });
    }
  }
  return toResult("template-gap", join3(projectRoot, manifest.templateDir), findings, {
    planned: report.planned,
    present: report.present,
    missing: report.missing
  });
}
function checkSupportPairing(projectRoot, manifest) {
  const dir = join3(projectRoot, manifest.supportDir);
  const incDir = join3(dir, "inc");
  const srcDir = join3(dir, "src");
  const allow = new Set(manifest.headerOnly);
  const findings = [];
  const srcStems = new Set(
    walkFiles(srcDir, { extensions: [".c", ".cpp"] }).map(
      (f) => fileName(f).replace(/\.(c|cpp)$/, "")
    )
  );
  for (const h of walkFiles(incDir, { extensions: [".h", ".hpp"] })) {
    const base = fileName(h);
    if (allow.has(base)) continue;
    const stem = base.replace(/\.(h|hpp)$/, "");
    if (!srcStems.has(stem)) {
      findings.push({
        rule: "support-header-without-source",
        severity: "warn",
        message: `${base} \u6709\u5934\u65E0\u6E90`,
        file: relPath(projectRoot, h),
        detail: "\u82E5\u4E3A\u6A21\u677F\u7C7B\u6216\u7EAF\u5185\u8054\u5B9E\u73B0\uFF0C\u8BF7\u52A0\u5165 template-manifest.json \u7684 headerOnly \u767D\u540D\u5355\u3002"
      });
    }
  }
  return toResult("support-pairing", dir, findings, { headerOnlyAllowed: allow.size });
}

// packages/rcs-core/src/repo-hygiene.ts
import { join as join4 } from "node:path";
var DEFAULT_HYGIENE = {
  requireGitignore: true,
  junk: [
    { id: "keil-user-gui", pattern: "\\.uvguix", severity: "error", reason: "Keil \u4E2A\u4EBA GUI \u914D\u7F6E\uFF0C\u6BCF\u4EBA\u4E00\u4EFD\uFF0C\u5FC5\u7136\u51B2\u7A81" },
    { id: "keil-user-opt", pattern: "\\.uvoptx$", severity: "warn", reason: "Keil \u4E2A\u4EBA\u9009\u9879\u6587\u4EF6" },
    // matchPath 的模式用 (^|/) 而不是 ^：垃圾目录往往嵌在子工程下
    // （如 r2_proj/OBJ/），只锚定开头会全部漏掉。
    { id: "build-output", pattern: "(^|/)(OBJ|Objects|Listings|build|DebugConfig)/", matchPath: true, severity: "error", reason: "\u7F16\u8BD1\u4EA7\u7269\uFF0C\u5E94\u7531\u6784\u5EFA\u751F\u6210" },
    { id: "ctags-index", pattern: "^\\.tags", severity: "warn", reason: "\u672C\u5730\u7D22\u5F15\u6587\u4EF6" },
    { id: "editor-backup", pattern: "\\.(orig|acl-old|pre-final)$", severity: "warn", reason: "\u7F16\u8F91\u6B8B\u7559\u5907\u4EFD" },
    { id: "agent-backup", pattern: "(^|/)\\.codex-backup/", matchPath: true, severity: "warn", reason: "\u5DE5\u5177\u5907\u4EFD\u76EE\u5F55" },
    { id: "pycache", pattern: "(^|/)__pycache__/", matchPath: true, severity: "info", reason: "Python \u7F13\u5B58" }
  ]
};
function checkRepoHygiene(repoRoot, config = DEFAULT_HYGIENE) {
  const findings = [];
  if (config.requireGitignore && !fileExists(join4(repoRoot, ".gitignore"))) {
    findings.push({
      rule: "missing-gitignore",
      severity: "error",
      message: "\u4ED3\u5E93\u6839\u76EE\u5F55\u7F3A\u5C11 .gitignore",
      file: ".gitignore",
      detail: "\u6CA1\u6709 .gitignore\uFF0C\u4E2A\u4EBA\u914D\u7F6E\u4E0E\u7F16\u8BD1\u4EA7\u7269\u4F1A\u6301\u7EED\u5165\u5E93\u3002"
    });
  }
  const gitignore = readText(join4(repoRoot, ".gitignore"));
  const buckets = /* @__PURE__ */ new Map();
  const files = walkFiles(repoRoot, {
    noDefaultSkip: true,
    skipDirs: [".git", "node_modules"]
  });
  for (const f of files) {
    const rel = relPath(repoRoot, f);
    const base = fileName(f);
    for (const rule of config.junk) {
      const target = rule.matchPath ? rel : base;
      if (new RegExp(rule.pattern).test(target)) {
        let b = buckets.get(rule.id);
        if (!b) {
          b = { rule, files: [] };
          buckets.set(rule.id, b);
        }
        b.files.push(rel);
        break;
      }
    }
  }
  for (const { rule, files: hits } of buckets.values()) {
    const covered = gitignore.length > 0 && gitignore.split(/\r?\n/).some((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith("#") && new RegExp(rule.pattern).test(t);
    });
    findings.push({
      rule: rule.id,
      severity: covered ? "info" : rule.severity,
      message: `${rule.reason} \u2014\u2014 \u547D\u4E2D ${hits.length} \u4E2A\u6587\u4EF6${covered ? "\uFF08.gitignore \u5DF2\u8986\u76D6\uFF09" : ""}`,
      file: hits[0],
      detail: `\u6837\u4F8B\uFF1A${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ` \u2026 \u5171 ${hits.length} \u4E2A` : ""}`
    });
  }
  const stats = { scanned: files.length };
  for (const [id, b] of buckets) stats[`junk:${id}`] = b.files.length;
  return toResult("repo-hygiene", repoRoot, findings, stats);
}

// packages/rcs-core/src/rule-source.ts
import { readFileSync as readFileSync2, existsSync as existsSync2, readdirSync as readdirSync2 } from "node:fs";
import { join as join5 } from "node:path";

// packages/rcs-core/src/rule-check.ts
import { readFileSync as readFileSync3, existsSync as existsSync3 } from "node:fs";
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

// packages/rcs-core/src/team-context.ts
import { readFileSync as readFileSync4, existsSync as existsSync5 } from "node:fs";
import { join as join7 } from "node:path";

// packages/rcs-core/src/paths.ts
import { existsSync as existsSync4 } from "node:fs";
import { dirname, join as join6, resolve } from "node:path";
import { fileURLToPath } from "node:url";
function repoRootFrom(moduleUrl) {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..", "..");
}
var REPO_ROOT = repoRootFrom(import.meta.url);
var repoPaths = {
  config: () => join6(REPO_ROOT, "config"),
  teamConfig: () => join6(REPO_ROOT, "config", "team.json"),
  rulesRoot: () => join6(REPO_ROOT, "data", "rules"),
  kbCache: () => join6(REPO_ROOT, "data", "kb-cache")
};
function looksLikeFirmwareRepo(dir) {
  if (!existsSync4(dir)) return false;
  const marks = ["template", "demo", "upper_host_cli", "R2"];
  return marks.filter((m) => existsSync4(join6(dir, m))).length >= 2;
}
function resolveFirmwareRoot(options = {}) {
  const env = options.env ?? process.env;
  const root = options.repoRoot ?? REPO_ROOT;
  const tried = [];
  const candidates = [
    ["\u5DE5\u5177\u53C2\u6570/ \u63D2\u4EF6\u914D\u7F6E", options.explicit],
    ["config/team.json \u7684 firmware.repo", options.fromTeamConfig],
    ["\u73AF\u5883\u53D8\u91CF RCS_CODE_ROOT", env["RCS_CODE_ROOT"]],
    ["\u73AF\u5883\u53D8\u91CF RCS_HOME", env["RCS_HOME"] ? join6(env["RCS_HOME"], "RCS_code") : void 0],
    ["\u4E0E\u672C\u4ED3\u5E93\u540C\u7EA7\u7684 ../RCS_code", join6(root, "..", "RCS_code")]
  ];
  for (const [from, value] of candidates) {
    if (!value) continue;
    const abs = resolve(value);
    tried.push(`${from}: ${abs}`);
    const explicitish = from.startsWith("\u5DE5\u5177\u53C2\u6570") || from.startsWith("config/team.json") || from.startsWith("\u73AF\u5883\u53D8\u91CF");
    if (explicitish ? existsSync4(abs) : looksLikeFirmwareRepo(abs)) {
      return { ok: true, root: abs, from };
    }
  }
  return { ok: false, tried };
}
function firmwareNotFoundMessage(tried) {
  return "\u627E\u4E0D\u5230 RCS \u56FA\u4EF6\u4ED3\u5E93\uFF08RCS_code\uFF09\u3002\u5DF2\u6309\u987A\u5E8F\u627E\u8FC7\uFF1A\n" + (tried.length > 0 ? tried.map((t) => `  \xB7 ${t}`).join("\n") : "  \uFF08\u6CA1\u6709\u4EFB\u4F55\u5019\u9009\uFF09") + "\n\n\u4E09\u79CD\u6307\u5B9A\u65B9\u5F0F\uFF0C\u4EFB\u9009\u5176\u4E00\uFF1A\n  1. \u5728 config/team.json \u91CC\u8BBE firmware.repo\n  2. \u8BBE\u73AF\u5883\u53D8\u91CF RCS_CODE_ROOT\n  3. \u628A\u56FA\u4EF6\u4ED3\u5E93\u653E\u5230\u4E0E\u672C\u4ED3\u5E93\u540C\u7EA7\u7684 ../RCS_code\n\u4E5F\u53EF\u4EE5\u5728\u8C03\u7528\u5DE5\u5177\u65F6\u76F4\u63A5\u4F20 projectRoot \u53C2\u6570\u3002";
}

// packages/rcs-core/src/kb-sync.ts
import { mkdirSync, writeFileSync, readFileSync as readFileSync5, existsSync as existsSync6, rmSync } from "node:fs";
import { join as join8 } from "node:path";

// packages/rcs-core/src/kb-index.ts
import { readFileSync as readFileSync6, existsSync as existsSync7 } from "node:fs";
var MAX_DOC_BYTES = 2 * 1024 * 1024;

// packages/rcs-core/src/rdlc.ts
var RDLC_HEAD = 192;
var RDLC_TAIL = 12;
var RDLC_MAX_PAYLOAD = 64;
var UPPER_ADDRESS = 160;
var LOWER_ADDRESS = 1;
var MSG_COMMAND = 16;
var MSG_FEEDBACK = 144;
var MODULE_NAMES = {
  0: "SYSTEM",
  1: "MOTORS",
  2: "PWM",
  16: "COMPLEX",
  126: "LINK_TEST"
};
var STATUS_NAMES = {
  0: "OK",
  1: "BAD_MESSAGE",
  2: "BAD_MODULE",
  3: "BAD_OPERATION",
  4: "BAD_LENGTH",
  5: "REJECTED",
  6: "INTERNAL_ERROR"
};
function crc16Modbus(data) {
  let crc = 65535;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? crc >>> 1 ^ 40961 : crc >>> 1;
    }
  }
  return crc & 65535;
}
var hex = (b) => b.toString(16).padStart(2, "0").toUpperCase();
var toHex = (bytes) => Array.from(bytes, hex).join(" ");
function decodeRdlcStream(input) {
  const data = input instanceof Uint8Array ? input : Uint8Array.from(input);
  const frames = [];
  const errors = [];
  let i = 0;
  let pending = 0;
  const fail = (offset, reason) => {
    errors.push({ offset, reason, bytes: Array.from(data.subarray(offset, offset + 16)) });
  };
  while (i < data.length) {
    if (data[i] !== RDLC_HEAD) {
      i++;
      continue;
    }
    const start = i;
    if (start + 5 > data.length) {
      pending = data.length - start;
      break;
    }
    const src = data[start + 1];
    const dst = data[start + 2];
    const len = data[start + 3] | data[start + 4] << 8;
    const payloadStart = start + 5;
    const frameEnd = payloadStart + len + 3;
    if (len > RDLC_MAX_PAYLOAD) {
      fail(start, `\u8F7D\u8377\u957F\u5EA6 ${len} \u8D85\u51FA\u4E0A\u9650 ${RDLC_MAX_PAYLOAD}\uFF0C\u591A\u534A\u662F\u628A\u6570\u636E\u5B57\u8282\u5F53\u6210\u4E86\u5E27\u5934`);
      i = start + 1;
      continue;
    }
    if (frameEnd > data.length) {
      pending = data.length - start;
      break;
    }
    if (data[frameEnd - 1] !== RDLC_TAIL) {
      fail(start, `\u5E27\u5C3E\u5E94\u4E3A 0x0C\uFF0C\u5B9E\u9645 0x${hex(data[frameEnd - 1])}`);
      i = start + 1;
      continue;
    }
    const payload = data.subarray(payloadStart, payloadStart + len);
    const expect = crc16Modbus(payload);
    const actual = data[payloadStart + len] | data[payloadStart + len + 1] << 8;
    if (expect !== actual) {
      fail(start, `CRC \u6821\u9A8C\u5931\u8D25\uFF1A\u671F\u671B 0x${expect.toString(16).toUpperCase()}\uFF0C\u5B9E\u9645 0x${actual.toString(16).toUpperCase()}`);
      i = start + 1;
      continue;
    }
    frames.push({ src, dst, payload: Array.from(payload), offset: start });
    i = frameEnd;
  }
  return { frames, errors, pending };
}
var moduleName = (m) => MODULE_NAMES[m] ?? `UNKNOWN(0x${hex(m)})`;
function decodeRdlcPayload(payload) {
  if (payload.length === 0) return { kind: "error", reason: "\u7A7A\u8F7D\u8377" };
  const first = payload[0];
  if (first === MSG_COMMAND) {
    if (payload.length < 5) return { kind: "error", reason: `\u547D\u4EE4\u8F7D\u8377\u81F3\u5C11 5 \u5B57\u8282\uFF0C\u5B9E\u9645 ${payload.length}` };
    const dataLen = payload[4];
    if (payload.length !== 5 + dataLen) {
      return {
        kind: "error",
        reason: `\u547D\u4EE4\u957F\u5EA6\u5B57\u6BB5\u8BF4\u6709 ${dataLen} \u5B57\u8282\u6570\u636E\uFF0C\u4F46\u8F7D\u8377\u5171 ${payload.length} \u5B57\u8282\uFF08\u5E94\u4E3A ${5 + dataLen}\uFF09`
      };
    }
    return {
      kind: "command",
      sequence: payload[1],
      module: payload[2],
      moduleName: moduleName(payload[2]),
      operation: payload[3],
      data: payload.slice(5)
    };
  }
  if (first === MSG_FEEDBACK) {
    if (payload.length < 7) return { kind: "error", reason: `\u53CD\u9988\u8F7D\u8377\u81F3\u5C11 7 \u5B57\u8282\uFF0C\u5B9E\u9645 ${payload.length}` };
    const echoLen = payload[5];
    const reportLenIndex = 6 + echoLen;
    if (reportLenIndex >= payload.length) {
      return { kind: "error", reason: `echo \u957F\u5EA6 ${echoLen} \u8D8A\u754C\uFF0C\u8F7D\u8377\u53EA\u6709 ${payload.length} \u5B57\u8282` };
    }
    const reportLen = payload[reportLenIndex];
    if (payload.length !== reportLenIndex + 1 + reportLen) {
      return {
        kind: "error",
        reason: `\u53CD\u9988\u957F\u5EA6\u5B57\u6BB5\u4E0E\u8F7D\u8377\u4E0D\u7B26\uFF1Aecho=${echoLen} report=${reportLen}\uFF0C\u8F7D\u8377\u5171 ${payload.length} \u5B57\u8282`
      };
    }
    const status = payload[4];
    return {
      kind: "feedback",
      sequence: payload[1],
      module: payload[2],
      moduleName: moduleName(payload[2]),
      operation: payload[3],
      status,
      statusName: STATUS_NAMES[status] ?? `UNKNOWN(${status})`,
      echo: payload.slice(6, reportLenIndex),
      report: payload.slice(reportLenIndex + 1)
    };
  }
  return { kind: "unknown", first, raw: payload };
}
var addrName = (a) => a === UPPER_ADDRESS ? "\u4E0A\u4F4D\u673A" : a === LOWER_ADDRESS ? "\u4E0B\u4F4D\u673A" : `0x${hex(a)}`;
function decodeRdlc(input) {
  const { frames, errors, pending } = decodeRdlcStream(input);
  return {
    decoded: frames.map((frame) => ({
      frame,
      payload: decodeRdlcPayload(frame.payload),
      direction: `${addrName(frame.src)} \u2192 ${addrName(frame.dst)}`
    })),
    errors,
    pending
  };
}
function parseHexBytes(text) {
  const bad = [];
  const cleaned = text.replace(/0[xX]/g, " ").replace(/[,;:\n\r\t]+/g, " ").trim();
  if (cleaned.length === 0) return { bytes: [], bad };
  const tokens = /\s/.test(cleaned) ? cleaned.split(/\s+/) : cleaned.match(/../g) ?? [];
  const bytes = [];
  for (const t of tokens) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(t)) {
      bad.push(t);
      continue;
    }
    bytes.push(parseInt(t, 16));
  }
  return { bytes, bad };
}

// packages/rcs-core/src/kin-check.ts
import { join as join9 } from "node:path";
var VENDOR_DIRS = ["Drivers", "CMSIS", "Middlewares", "HAL_Driver", "Third_Party", "lib", "build"];
var UNIT_CONVERSION = /57\.29|57\.3|180\.0?f?\s*\/\s*(M_)?PI|(M_)?PI\s*\/\s*180|RAD2DEG|DEG2RAD|rad2deg|deg2rad|radiansToDegrees|degreesToRadians/;
function sourceFiles(root) {
  return walkFiles(root, { extensions: [".c", ".cpp", ".h", ".hpp"], skipDirs: VENDOR_DIRS }).filter(isCppFile);
}
function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}
function lineOf(lines, test) {
  const i = lines.findIndex(test);
  return i < 0 ? void 0 : i + 1;
}
function checkAngleLoop(root) {
  const findings = [];
  for (const file of sourceFiles(root)) {
    const raw = readText(file);
    if (!raw) continue;
    const rel = relPath(root, file);
    const text = stripComments(raw);
    const lines = text.split(/\r?\n/);
    const usesAngleLoop = /angle_loop\s*::/.test(text);
    const usesAtan = /\batan2f?\s*\(/.test(text);
    if (usesAngleLoop && usesAtan && !UNIT_CONVERSION.test(text)) {
      findings.push({
        rule: "angle-loop-unit-mismatch",
        severity: "error",
        file: rel,
        line: lineOf(lines, (l) => /angle_loop\s*::/.test(l)),
        message: "\u540C\u4E00\u6587\u4EF6\u91CC atan2 \u7684\u8F93\u51FA\uFF08\u5F27\u5EA6\uFF09\u76F4\u63A5\u8FDB\u4E86 angle_loop\uFF08\u89D2\u5EA6\u5236\uFF09\uFF0C\u4E14\u5168\u6587\u6CA1\u6709\u5F27\u5EA6\u2194\u89D2\u5EA6\u8F6C\u6362",
        detail: "angle_loop \u5185\u90E8\u662F fmod(x,360) \u4E0E round(diff/360)\u3002\u5BF9 |x|\u2264\u03C0 \u7684\u5F27\u5EA6\u8F93\u5165\uFF0Cfmod \u662F\u6052\u7B49\u53D8\u6362\u3001round \u6052\u4E3A 0 \u2014\u2014 \u56DE\u73AF\u6574\u4F53\u9000\u5316\u4E3A\u7A7A\u64CD\u4F5C\uFF0C\u4E14\u4E0D\u62A5\u4EFB\u4F55\u9519\u3002\n\u5B9E\u4F8B\uFF1A\u76EE\u6807\u89D2 3.0 rad\u3001\u5F53\u524D\u89D2 -3.0 rad\uFF0C\u671F\u671B\u8D70\u6700\u77ED\u8DEF 0.28 rad\uFF0816\xB0\uFF09\uFF0C\u5B9E\u9645\u4F1A\u8D70 6.0 rad\uFF08344\xB0\uFF09\uFF0C\u6B63\u662F kin_chassis.cpp \u6CE8\u91CA\u91CC\u8BF4\u7684\u300C\u8F6E\u5B50\u64E6\u5730\u5361\u6B7B\u300D\u3002\n\u4FEE\u6CD5\u4E8C\u9009\u4E00\uFF1A\u628A\u89D2\u5EA6\u5728\u8FDB angle_loop \u524D\u8F6C\u6210\u89D2\u5EA6\u5236\uFF0C\u6216\u6539\u7528\u5F27\u5EA6\u5236\u7684\u56DE\u73AF\u5B9E\u73B0\u3002"
      });
    }
    const regularAt = lineOf(lines, (l) => /angle_loop\s*::\s*regular_from_inf_to_(0|180)/.test(l));
    if (regularAt !== void 0 && !/normalize_from_0_to_inf/.test(text) && /\binv_kin\s*\(|\bangle\s*\[/.test(text)) {
      findings.push({
        rule: "angle-loop-no-normalize",
        severity: "warn",
        file: rel,
        line: regularAt,
        message: "\u53EA\u8C03\u7528\u4E86 regular_*\uFF08\u89C4\u8303\u5316\uFF09\uFF0C\u6CA1\u6709 normalize_from_0_to_inf\uFF08\u56DE\u73AF\uFF09\u2014\u2014 \u7F3A\u4E86\u6C42\u6700\u77ED\u8DEF\u8FD9\u4E00\u6B65",
        detail: "angle_loop \u7684\u4E24\u6B65\u662F\u5206\u5F00\u7684\uFF1A\u89C4\u8303\u5316\u628A\u89D2\u5EA6\u6536\u8FDB\u6709\u9650\u533A\u95F4\uFF0C\u56DE\u73AF\u624D\u628A\u5B83\u6620\u5C04\u5230\u79BB\u5F53\u524D\u89D2\u6700\u8FD1\u7684\u7B49\u4EF7\u89D2\u3002\u53EA\u505A\u524D\u4E00\u6B65\uFF0C\u8235\u8F6E\u8FC7\u8FB9\u754C\u65F6\u4ECD\u4F1A\u8D70\u8FDC\u8DEF\u3002"
      });
    }
  }
  return toResult("angle-loop", root, findings);
}
function checkKinematics(root) {
  const findings = [];
  for (const file of sourceFiles(root)) {
    const raw = readText(file);
    if (!raw) continue;
    const rel = relPath(root, file);
    const text = stripComments(raw);
    const lines = text.split(/\r?\n/);
    if (/\binv_kin\s*\(/.test(text) && !/\bfind_nearest\s*\(/.test(text)) {
      findings.push({
        rule: "kin-find-nearest-bypassed",
        severity: "error",
        file: rel,
        line: lineOf(lines, (l) => /\binv_kin\s*\(/.test(l)),
        message: "\u8C03\u7528\u4E86 inv_kin \u4F46\u5168\u6587\u6CA1\u6709 find_nearest \u2014\u2014 \u8235\u8F6E\u89D2\u5EA6\u672A\u505A\u6700\u77ED\u8DEF\u5904\u7406",
        detail: "kin_chassis.cpp \u539F\u6CE8\u91CA\uFF1A\u300C\u5982\u679C\u76F4\u63A5\u628A inv_kin \u5F97\u5230\u7684\u503C\u4E0B\u53D1\u7ED9\u7535\u673A\uFF0C\u662F\u4E0D\u80FD\u8BA9\u5E95\u76D8\u8FB9\u8D70\u8FB9\u8F6C\u7684\u3002\u56E0\u4E3A\u5F53\u5E95\u76D8\u5728 360 \u5EA6\u548C 180 \u5EA6\u9644\u8FD1\u65F6\uFF0C\u4F1A\u6311\u9009\u8DDD\u79BB\u66F4\u8FDC\u7684\u8DEF\u7EBF\uFF0C\u4F7F\u5F97\u8F6E\u5B50\u64E6\u5730\u5361\u6B7B\u3002\u300D\n\u6B63\u786E\u987A\u5E8F\uFF1Ainv_kin \u5F97\u7406\u8BBA\u76EE\u6807 \u2192 find_nearest \u6C42\u6700\u77ED\u8DEF \u2192 \u4E0B\u53D1\u7ED9\u7535\u673A\u3002"
      });
    }
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i] ?? "";
      const m = /^\s*\w[\w:<>,\s*&]*\b(\w+)::(inv_kin|kin)\s*\(/.exec(head);
      if (!m) continue;
      let end = i + 1;
      while (end < lines.length && !/^\}/.test(lines[end] ?? "")) end++;
      const body = lines.slice(i, end + 1).join("\n");
      const retVar = /^\s*[\w:]+\s+(\w+);\s*$/m.exec(body)?.[1];
      if (!retVar) continue;
      const assigned = new RegExp(`\\b${retVar}\\s*\\.\\s*\\w+`).test(body);
      if (!assigned && new RegExp(`return\\s+${retVar}\\s*;`).test(body)) {
        findings.push({
          rule: "kin-uninitialized-return",
          severity: "error",
          file: rel,
          line: i + 1,
          message: `${m[1]}::${m[2]} \u8FD4\u56DE\u4E86\u4ECE\u672A\u8D4B\u503C\u7684 ${retVar} \u2014\u2014 \u8C03\u7528\u65B9\u62FF\u5230\u7684\u662F\u672A\u521D\u59CB\u5316\u7684\u6808\u5185\u5B58`,
          detail: "\u51FD\u6570\u4F53\u91CC\u7B97\u4E86\u4E2D\u95F4\u91CF\u5374\u6CA1\u6709\u5199\u8FDB\u8FD4\u56DE\u503C\u3002\u7F16\u8BD1\u5668\u4E0D\u4F1A\u62A5\u9519\uFF0C\u8FD0\u884C\u65F6\u5F97\u5230\u968F\u673A\u6570\uFF0C\u8868\u73B0\u4E3A\u300C\u7535\u673A\u4E71\u8F6C\u300D\u6216\u300C\u5B8C\u5168\u4E0D\u52A8\u300D\uFF0C\u4E14\u6BCF\u6B21\u4E0A\u7535\u4E0D\u4E00\u6837\uFF0C\u6781\u96BE\u5B9A\u4F4D\u3002"
        });
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (!/\|\|/.test(l) || !/&&/.test(l)) continue;
      if (/\(/.test(l.split("&&")[0]?.split("||").pop() ?? "")) continue;
      findings.push({
        rule: "kin-precedence-mix",
        severity: "warn",
        file: rel,
        line: i + 1,
        message: "\u540C\u4E00\u6761\u4EF6\u91CC\u6DF7\u7528 || \u4E0E && \u4E14\u672A\u52A0\u62EC\u53F7 \u2014\u2014 && \u4F18\u5148\u7EA7\u66F4\u9AD8\uFF0C\u5B9E\u9645\u8BED\u4E49\u591A\u534A\u4E0D\u662F\u672C\u610F",
        detail: "\u4F8B\u5982 `a<0 || b<0 || c<0 && d<0` \u4F1A\u88AB\u89E3\u6790\u6210 `a<0 || b<0 || (c<0 && d<0)`\uFF0C\u4E8E\u662F\u53EA\u6709 c\u3001d \u540C\u65F6\u8D8A\u754C\u624D\u62A5\u8B66\uFF0C\u5355\u72EC c \u8D8A\u754C\u4F1A\u88AB\u6F0F\u6389\u3002\u52A0\u62EC\u53F7\u5373\u53EF\u6D88\u9664\u6B67\u4E49\u3002"
      });
    }
    const biasZero = /rcs_agv4\s*\w*\s*\(([^)]*)\)/.exec(text);
    if (biasZero) {
      const args = (biasZero[1] ?? "").split(",").map((s) => s.trim());
      if (args.length === 4 && /^0(\.0*f?)?$/.test(args[2] ?? "") && /^0(\.0*f?)?$/.test(args[3] ?? "")) {
        findings.push({
          rule: "kin-bias-zero",
          severity: "info",
          file: rel,
          line: lineOf(lines, (l) => /rcs_agv4\s*\w*\s*\(/.test(l)),
          message: "rcs_agv4 \u7684 bias_x / bias_y \u90FD\u4F20\u4E86 0 \u2014\u2014 \u91CD\u5FC3\u4FEE\u6B63\u672A\u542F\u7528",
          detail: "\u82E5\u91CD\u5FC3\u786E\u5B9E\u5728\u51E0\u4F55\u4E2D\u5FC3\uFF0C\u8FD9\u6CA1\u95EE\u9898\uFF1B\u82E5\u53EA\u662F\u8FD8\u6CA1\u91CF\uFF0C\u5E95\u76D8\u81EA\u8F6C\u65F6\u4F1A\u6709\u989D\u5916\u7684\u6A2A\u5411\u6F02\u79FB\u3002\u5355\u4F4D\u662F mm\uFF0C\u91CF\u4E00\u6B21\u5373\u53EF\u3002"
        });
      }
    }
  }
  return toResult("kinematics", root, findings);
}

// packages/rcs-core/src/toolchain.ts
import { existsSync as existsSync8, readFileSync as readFileSync7 } from "node:fs";
import { join as join10 } from "node:path";
import { tmpdir } from "node:os";
var KEIL_CANDIDATES = [
  "D:/keil/UV4/UV4.exe",
  "C:/Keil_v5/UV4/UV4.exe",
  "C:/Keil/UV4/UV4.exe"
];
function probeToolchain(deps) {
  const keil = KEIL_CANDIDATES.find((p) => deps.exists(p));
  const cmake = deps.which("cmake");
  const python = deps.which("python") ?? deps.which("python3");
  const wsl = deps.which("wsl");
  return [
    {
      id: "keil",
      label: "Keil MDK (UV4.exe)",
      available: keil !== void 0,
      path: keil,
      hint: keil ? void 0 : `\u672A\u627E\u5230\u3002\u5DF2\u67E5\u8FC7\uFF1A${KEIL_CANDIDATES.join("\u3001")}\u3002\u88C5\u4E86\u4F46\u4E0D\u5728\u8FD9\u4E9B\u8DEF\u5F84\uFF0C\u8BF7\u5728\u5DE5\u5177\u53C2\u6570\u91CC\u663E\u5F0F\u6307\u5B9A\u3002`
    },
    {
      id: "cmake",
      label: "CMake",
      available: cmake !== void 0,
      path: cmake,
      hint: cmake ? void 0 : 'PC \u5355\u5143\u6D4B\u8BD5\u9700\u8981\u5B83\u3002Windows \u53EF `winget install Kitware.CMake`\uFF1BWSL \u91CC `sudo apt update && sudo apt install -y cmake build-essential`\u3002\n\u82E5 apt update \u6EE1\u5C4F `Ign:`\uFF1A\u591A\u534A\u662F\u673A\u5668\u8D70\u4EE3\u7406\u4E0A\u7F51\uFF0C\u800C sudo \u4F1A\u6E05\u6389 http_proxy \u73AF\u5883\u53D8\u91CF\u3002\u7ED9 apt \u5355\u72EC\u914D\u4E00\u4EFD\u5373\u53EF\uFF08\u628A\u7AEF\u53E3\u6362\u6210\u4F60\u7684\uFF09\uFF1A\n  printf \'Acquire::http::Proxy "http://127.0.0.1:7897";\\nAcquire::https::Proxy "http://127.0.0.1:7897";\\n\' | sudo tee /etc/apt/apt.conf.d/99proxy'
    },
    {
      id: "python",
      label: "Python",
      available: python !== void 0,
      path: python,
      hint: python ? void 0 : "\u70E7\u5F55\u811A\u672C swd_flash.py \u9700\u8981\u5B83\u3002"
    },
    {
      id: "wsl",
      label: "WSL",
      available: wsl !== void 0,
      path: wsl,
      hint: wsl ? void 0 : "\u961F\u5185 PC \u6D4B\u8BD5\u7684 gtest \u9759\u6001\u5E93\u662F Linux \u4EA7\u7269\uFF0C\u6CA1\u6709 WSL \u5C31\u53EA\u80FD\u5728 Windows \u4FA7\u91CD\u65B0\u7F16\u8BD1 gtest\u3002"
    }
  ];
}
async function probeWslToolchain(run) {
  const tools = ["cmake", "make", "g++"];
  const r = await run("wsl", ["-e", "bash", "-lc", tools.map((t) => `command -v ${t} || echo -`).join("; ")], {
    timeoutMs: 3e4
  });
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return tools.map((t, i) => {
    const path = lines[i] && lines[i] !== "-" ? lines[i] : void 0;
    return {
      id: `wsl-${t}`,
      label: `WSL: ${t}`,
      available: path !== void 0,
      ...path ? { path } : {},
      ...path ? {} : {
        hint: "\u5728 WSL \u91CC\u6267\u884C `sudo apt update && sudo apt install -y cmake build-essential`\u3002\u82E5 apt update \u6EE1\u5C4F `Ign:`\uFF0C\u662F sudo \u6E05\u6389\u4E86 http_proxy\uFF0C\u89C1 cmake \u4E00\u9879\u7684\u8BF4\u660E\u3002"
      }
    };
  });
}
var UV4_EXIT = {
  0: "\u6784\u5EFA\u6210\u529F\uFF0C\u65E0\u9519\u8BEF\u65E0\u8B66\u544A",
  1: "\u6784\u5EFA\u6210\u529F\uFF0C\u4F46\u6709\u8B66\u544A",
  2: "\u6784\u5EFA\u5931\u8D25\uFF1A\u6709\u9519\u8BEF",
  3: "\u6784\u5EFA\u5931\u8D25\uFF1A\u81F4\u547D\u9519\u8BEF",
  11: "\u6253\u4E0D\u5F00\u5DE5\u7A0B\u6587\u4EF6",
  12: "\u8BBE\u5907\u9519\u8BEF",
  13: "\u627E\u4E0D\u5230\u6587\u4EF6",
  15: "License \u9519\u8BEF",
  20: "\u65E0\u6CD5\u542F\u52A8 uVision"
};
function innermostDiagnostic(line) {
  const re = /([^\s(][^(]*?)\((\d+)\):\s*(error|warning|note)\s*:\s*/gi;
  let last;
  for (let m = re.exec(line); m; m = re.exec(line)) last = m;
  if (!last) return void 0;
  const sev = last[3].toLowerCase();
  if (sev === "note") return void 0;
  return {
    // 折叠行里，捕获到的"路径"前面还粘着 `In file included from.....` 这段说明。
    // 3 个以上连续点是这种折叠的标志，把它连同前面的文字一起切掉，只留真实路径。
    file: last[1].replace(/^.*?\.{3,}[/\\]*/, "").replace(/^[/\\]+/, "").trim(),
    line: Number(last[2]),
    severity: sev === "error" ? "error" : "warning",
    message: line.slice(last.index + last[0].length).trim()
  };
}
function parseKeilLog(log) {
  const out = [];
  const linker = /^(?:(.*?):\s*)?(Error|Warning)\s*:\s*(L\d+[A-Z]?)\s*:\s*(.*)$/i;
  const toolLevel = /^(arm\w+|\w+\.exe)\s*:\s*(error|warning)\s*:\s*(.*)$/i;
  const seen = /* @__PURE__ */ new Set();
  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const d = innermostDiagnostic(line);
    if (d) {
      const codeM = /^(#[\w-]+)\s*:\s*/.exec(d.message);
      out.push({
        severity: d.severity,
        file: d.file,
        line: d.line,
        ...codeM ? { code: codeM[1] } : {},
        message: codeM ? d.message.slice(codeM[0].length) : d.message
      });
      continue;
    }
    const l = linker.exec(line);
    if (l) {
      out.push({
        severity: l[2].toLowerCase() === "error" ? "error" : "warning",
        file: l[1]?.trim(),
        code: l[3],
        message: l[4].trim()
      });
      continue;
    }
    const t = toolLevel.exec(line);
    if (t) {
      const key = `${t[1]}|${t[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        severity: t[2].toLowerCase() === "error" ? "error" : "warning",
        code: t[1],
        message: t[3].trim()
      });
    }
  }
  return out;
}
function projectCompilerVersion(uvprojxXml) {
  return /<pCCUsed>[^<]*?::(V[\d.]+)::/.exec(uvprojxXml)?.[1];
}
function keilBundledCompilers(uv4Path, read) {
  const root = uv4Path.replace(/\\/g, "/").replace(/\/UV4\/UV4\.exe$/i, "");
  const ini = read(`${root}/TOOLS.INI`);
  const found = /* @__PURE__ */ new Set();
  for (const m of ini.matchAll(/Arm Compiler[^"]*?\b(\d+\.\d+)\b/g)) {
    if (m[1]) found.add(`V${m[1]}`);
  }
  return [...found];
}
function classifyBuildFailure(diagnostics, context) {
  const text = diagnostics.map((d) => d.message).join("\n");
  if (/license/i.test(text)) {
    const wanted = context?.wanted;
    const installed = context?.installed ?? [];
    if (wanted && installed.length > 0 && !installed.includes(wanted)) {
      return `\u5DE5\u7A0B\u9009\u7528\u7684\u662F Arm Compiler **${wanted}**\uFF0C\u4F46\u672C\u673A Keil \u5B9E\u9645\u5E26\u7684\u662F **${installed.join("\u3001")}** \u2014\u2014 \u5355\u72EC\u5B89\u88C5\u7684\u7248\u672C\u901A\u5E38\u4E0D\u5728 MDK \u6388\u6743\u8303\u56F4\u5185\uFF0C\u4E8E\u662F\u62A5 license \u9519\u8BEF\u3002**\u6388\u6743\u672C\u8EAB\u591A\u534A\u6CA1\u95EE\u9898\uFF0C\u662F\u7248\u672C\u9009\u9519\u4E86\u3002**
\u6539\u6CD5\uFF1AuVision \u2192 Project \u2192 Manage \u2192 Project Items \u2192 Folders/Extensions\uFF0C\u628A ARM Compiler \u5207\u5230 ${installed[0]}\uFF1B\u6216\u76F4\u63A5\u6539 .uvprojx \u91CC\u7684 <pCCUsed>\u3002`;
    }
    return "Keil license \u672A\u6FC0\u6D3B\u6216\u4E0D\u53EF\u7528 \u2014\u2014 **\u8FD9\u4E0D\u662F\u4EE3\u7801\u95EE\u9898**\u3002\n\u5148\u786E\u8BA4\u5DE5\u7A0B\u9009\u7684\u7F16\u8BD1\u5668\u7248\u672C\u662F\u5426\u662F Keil \u81EA\u5E26\u90A3\u4E2A\uFF08\u5355\u72EC\u88C5\u7684\u7248\u672C\u5E38\u5E38\u6CA1\u6388\u6743\uFF09\uFF1B\u518D\u770B uVision \u2192 File \u2192 License Management\u3002";
  }
  if (/cannot open source input file|No such file or directory/i.test(text)) {
    return "\u6709\u6E90\u6587\u4EF6\u627E\u4E0D\u5230 \u2014\u2014 \u591A\u534A\u662F\u5DE5\u7A0B\u91CC\u5F15\u7528\u7684\u8DEF\u5F84\u5931\u6548\uFF0C\u6216\u4ED3\u5E93\u6CA1\u62C9\u5168\u3002";
  }
  return void 0;
}
async function buildFirmware(options) {
  const { project, run, deps } = options;
  const readLog = options.readLog ?? ((p) => existsSync8(p) ? readFileSync7(p, "utf8") : "");
  const readProject = options.readText ?? readLog;
  const blocked = (reason) => ({
    ok: false,
    exitCode: -1,
    verdict: "\u672A\u5F00\u59CB",
    project,
    diagnostics: [],
    errors: 0,
    warnings: 0,
    blocked: reason
  });
  if (!deps.exists(project)) {
    return blocked(`\u627E\u4E0D\u5230\u5DE5\u7A0B\u6587\u4EF6\uFF1A${project}`);
  }
  const uv4 = options.uv4 ?? KEIL_CANDIDATES.find((p) => deps.exists(p));
  if (!uv4) {
    return blocked(
      `\u6CA1\u627E\u5230 UV4.exe\u3002\u5DF2\u67E5\u8FC7\uFF1A${KEIL_CANDIDATES.join("\u3001")}\u3002
\u88C5\u5728\u522B\u5904\u7684\u8BDD\uFF0C\u5728\u5DE5\u5177\u53C2\u6570\u91CC\u7528 uv4 \u663E\u5F0F\u6307\u5B9A\u8DEF\u5F84\u3002`
    );
  }
  const logFile = options.logFile ?? join10(tmpdir(), `rcs-build-${process.pid}.log`);
  const args = [options.rebuild ? "-r" : "-b", project, "-j0", "-o", logFile];
  if (options.target) args.push("-t", options.target);
  const r = await run(uv4, args, { timeoutMs: 10 * 60 * 1e3 });
  if (r.spawnError) return blocked(`UV4 \u542F\u52A8\u5931\u8D25\uFF1A${r.spawnError}`);
  const log = readLog(logFile);
  const diagnostics = parseKeilLog(log);
  const claimed = Number(/(\d+)\s+errors?\s+generated/i.exec(log)?.[1] ?? 0);
  let errors = diagnostics.filter((d) => d.severity === "error").length;
  if (claimed > 0 && errors === 0) {
    diagnostics.unshift({
      severity: "error",
      message: `\u7F16\u8BD1\u5668\u62A5\u544A ${claimed} \u4E2A\u9519\u8BEF\uFF0C\u4F46\u672C\u5DE5\u5177\u4E00\u6761\u90FD\u6CA1\u89E3\u6790\u51FA\u6765 \u2014\u2014 \u8BF4\u660E\u65E5\u5FD7\u91CC\u51FA\u73B0\u4E86\u672A\u8986\u76D6\u7684\u683C\u5F0F\u3002\u8BF7\u76F4\u63A5\u770B\u5B8C\u6574\u65E5\u5FD7\uFF1A${logFile}`
    });
    errors = diagnostics.filter((d) => d.severity === "error").length;
  }
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;
  const ok = r.code === 0 || r.code === 1;
  let hint;
  if (!ok) {
    const wanted = projectCompilerVersion(readProject(project));
    const installed = keilBundledCompilers(uv4, readProject);
    hint = classifyBuildFailure(diagnostics, {
      ...wanted ? { wanted } : {},
      ...installed.length > 0 ? { installed } : {}
    });
  }
  const logTail = !ok && diagnostics.length === 0 && log ? log.split(/\r?\n/).slice(-40).join("\n") : void 0;
  return {
    ok,
    exitCode: r.code,
    verdict: UV4_EXIT[r.code] ?? `\u672A\u77E5\u9000\u51FA\u7801 ${r.code}`,
    project,
    diagnostics,
    errors,
    warnings,
    logFile,
    ...hint ? { hint } : {},
    ...logTail ? { logTail } : {}
  };
}
function archiveObjectFormat(buf) {
  let off = 8;
  for (let i = 0; i < 4 && off + 60 <= buf.length; i++) {
    const name2 = new TextDecoder().decode(buf.subarray(off, off + 16)).trim();
    const sizeText = new TextDecoder().decode(buf.subarray(off + 48, off + 58)).trim();
    const size = Number.parseInt(sizeText, 10);
    const body = off + 60;
    if (!Number.isFinite(size)) break;
    if (name2 !== "/" && name2 !== "//") {
      const b = buf.subarray(body, body + 4);
      if (b[0] === 127 && b[1] === 69 && b[2] === 76 && b[3] === 70) return "elf";
      if (b[0] === 100 && b[1] === 134) return "coff";
      if (b[0] === 76 && b[1] === 1) return "coff";
      return "unknown";
    }
    off = body + size + size % 2;
  }
  return "unknown";
}
function parseGtestOutput(text) {
  const failures = [];
  let passed = 0;
  let failed = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const okm = /^\[\s*OK\s*\]\s+(\S+)/.exec(line);
    if (okm) {
      passed++;
      continue;
    }
    const fm = /^\[\s*FAILED\s*\]\s+(\S+)/.exec(line);
    if (fm && !/^\[\s*FAILED\s*\]\s+\d+\s+test/.test(line)) {
      const name2 = fm[1];
      if (!failures.some((x) => x.name === name2)) {
        failures.push({ name: name2 });
        failed++;
      }
    }
  }
  return { passed, failed, failures };
}
function classifyTestFailure(output) {
  const std = /C\+\+ versions less than C\+\+(\d+) are not supported/.exec(output);
  if (std) {
    return `\u6D4B\u8BD5\u5DE5\u7A0B\u7684 C++ \u6807\u51C6\u914D\u7F6E\u4E0E gtest \u5934\u6587\u4EF6\u4E0D\u5339\u914D\uFF1Agtest \u8981\u6C42 **C++${std[1]}**\uFF0C\u4F46 \`test/CMakeLists.txt\` \u91CC\u8BBE\u7684\u662F\u66F4\u4F4E\u7684\u7248\u672C\u3002
\u6539\u6CD5\u662F\u4E00\u884C\uFF1A\u628A \`set(CMAKE_CXX_STANDARD 14)\` \u6539\u6210 \`set(CMAKE_CXX_STANDARD ${std[1]})\`\u3002
\uFF08\u591A\u534A\u662F\u67D0\u6B21\u66F4\u65B0\u4E86 gtest \u5934\u6587\u4EF6\u5374\u6CA1\u540C\u6B65\u6539 CMakeLists \u2014\u2014 \u8FD9\u4EFD PC \u6D4B\u8BD5\u56E0\u6B64\u4E00\u76F4\u7F16\u8BD1\u4E0D\u8FC7\uFF0C\u800C\u5B83\u672C\u8BE5\u662F CI \u7684\u6838\u5FC3\u3002\uFF09`;
  }
  if (/CMakeCache\.txt directory .* is different than the directory/.test(output)) {
    return "\u6784\u5EFA\u7F13\u5B58\u6765\u81EA\u53E6\u4E00\u53F0\u673A\u5668\u7684\u8DEF\u5F84\u3002\u672C\u5DE5\u5177\u5DF2\u6539\u7528\u4ED3\u5E93\u5916\u7684\u6784\u5EFA\u76EE\u5F55\uFF0C\u82E5\u4ECD\u62A5\u6B64\u9519\u8BF7\u6E05\u6389\u65E7\u7684 `build/`\u3002";
  }
  if (/undefined reference to|cannot find -l/.test(output)) {
    return "\u94FE\u63A5\u5931\u8D25\uFF1A\u9759\u6001\u5E93\u4E0E\u5F53\u524D\u7F16\u8BD1\u5668\u4E0D\u5339\u914D\uFF08\u961F\u5185 gtest \u662F Linux/GCC \u4EA7\u7269\uFF09\u3002\u786E\u8BA4\u662F\u5728 WSL \u5185\u6784\u5EFA\u3002";
  }
  return void 0;
}
async function runSupportTests(options) {
  const { testDir, run, deps } = options;
  const readBytes = options.readFileBytes ?? ((p) => existsSync8(p) ? new Uint8Array(readFileSync7(p)) : void 0);
  const blocked = (reason) => ({ ok: false, passed: 0, failed: 0, failures: [], blocked: reason });
  if (!deps.exists(join10(testDir, "CMakeLists.txt"))) {
    return blocked(`${testDir} \u4E0B\u6CA1\u6709 CMakeLists.txt \u2014\u2014 \u786E\u8BA4\u8DEF\u5F84\u662F\u5426\u4E3A RCS_Support/test`);
  }
  const gtest = readBytes(join10(testDir, "lib", "libgtest.a"));
  const format = gtest ? archiveObjectFormat(gtest) : "unknown";
  const hasCmake = deps.which("cmake") !== void 0;
  const hasWsl = deps.which("wsl") !== void 0;
  if (format === "elf") {
    if (!hasWsl) {
      return blocked(
        "\u4ED3\u5E93\u91CC\u7684 libgtest.a \u662F Linux ELF \u5F52\u6863\uFF08\u5728 WSL/Ubuntu \u4E0B\u7F16\u8BD1\u7684\uFF09\uFF0CWindows \u539F\u751F\u5DE5\u5177\u94FE\u94FE\u4E0D\u4E86\uFF0C\u800C\u672C\u673A\u6CA1\u6709 WSL\u3002\n\u4E24\u6761\u51FA\u8DEF\uFF1A\u88C5 WSL \u5E76\u5728\u5176\u4E2D `sudo apt update && sudo apt install -y cmake build-essential`\uFF1B\u6216\u5728 Windows \u4FA7\u91CD\u65B0\u7F16\u8BD1\u4E00\u4EFD gtest\u3002"
      );
    }
    const probe = await run("wsl", ["-e", "bash", "-lc", "command -v cmake && command -v make && command -v g++"]);
    if (probe.code !== 0) {
      return blocked(
        "libgtest.a \u662F Linux \u4EA7\u7269\uFF0C\u987B\u5728 WSL \u5185\u6784\u5EFA\uFF0C\u4F46 WSL \u91CC\u7F3A cmake / make / g++\u3002\n\u5728 WSL \u91CC\u6267\u884C\uFF1Asudo apt update && sudo apt install -y cmake build-essential\n**`apt update` \u4E0D\u80FD\u7701**\uFF1A\u5168\u65B0 WSL \u5B9E\u4F8B\u7684\u5305\u5217\u8868\u662F\u7A7A\u7684\uFF0C\u76F4\u63A5 install \u4F1A\u62A5\n\u300CUnable to locate package cmake\u300D\uFF0C\u770B\u7740\u50CF\u6CA1\u7F51\uFF0C\u5176\u5B9E\u53EA\u662F\u6CA1\u62C9\u8FC7\u7D22\u5F15\u3002\n\u8FD9\u4E00\u6B65\u9700\u8981 sudo \u5BC6\u7801\uFF0C\u5F97\u4F60\u624B\u52A8\u6267\u884C\u3002"
      );
    }
    return runCmakeAnd(run, testDir, "wsl");
  }
  if (!hasCmake) {
    return blocked(
      "\u6CA1\u6709 cmake\u3002Windows: `winget install Kitware.CMake`\uFF1BWSL: `sudo apt update && sudo apt install -y cmake build-essential`\u3002"
    );
  }
  return runCmakeAnd(run, testDir, "native");
}
function toWslPath(p) {
  const s = p.replace(/\\/g, "/");
  const m = /^([A-Za-z]):\/(.*)$/.exec(s);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : s;
}
function outOfTreeBuildDir(testDir, mode) {
  let h = 0;
  for (let i = 0; i < testDir.length; i++) h = Math.imul(31, h) + testDir.charCodeAt(i) | 0;
  const name2 = `rcs-support-test-${(h >>> 0).toString(16)}`;
  return mode === "wsl" ? `/tmp/${name2}` : join10(tmpdir(), name2);
}
async function runCmakeAnd(run, testDir, mode) {
  const p = (x) => mode === "wsl" ? toWslPath(x) : x;
  const wrap = (cmd, args) => mode === "wsl" ? ["wsl", ["-e", cmd, ...args]] : [cmd, args];
  const src = p(testDir);
  const buildDir = outOfTreeBuildDir(testDir, mode);
  const [c1, a1] = wrap("cmake", ["-S", src, "-B", buildDir]);
  const conf = await run(c1, a1, { timeoutMs: 5 * 60 * 1e3 });
  if (conf.code !== 0) {
    return { ok: false, passed: 0, failed: 0, failures: [], mode, blocked: `cmake \u914D\u7F6E\u5931\u8D25\uFF1A
${conf.stderr || conf.stdout}`.slice(0, 2e3) };
  }
  const [c2, a2] = wrap("cmake", ["--build", buildDir]);
  const built = await run(c2, a2, { timeoutMs: 10 * 60 * 1e3 });
  if (built.code !== 0) {
    const raw = built.stderr || built.stdout;
    const why = classifyTestFailure(raw);
    return {
      ok: false,
      passed: 0,
      failed: 0,
      failures: [],
      mode,
      blocked: (why ? `${why}

\u539F\u59CB\u8F93\u51FA\uFF08\u622A\u65AD\uFF09\uFF1A
` : "\u7F16\u8BD1\u5931\u8D25\uFF1A\n") + raw.slice(0, 1500)
    };
  }
  const [c3, a3] = wrap(`${buildDir}/test`, []);
  const ran = await run(c3, a3, { timeoutMs: 5 * 60 * 1e3 });
  const parsed = parseGtestOutput(`${ran.stdout}
${ran.stderr}`);
  return { ok: ran.code === 0 && parsed.failed === 0, ...parsed, mode };
}
async function flashFirmware(options) {
  const { script, run, deps } = options;
  const blocked = (reason) => ({
    ok: false,
    wrote: false,
    binary: options.binary ?? "(\u811A\u672C\u9ED8\u8BA4)",
    output: "",
    blocked: reason
  });
  if (!deps.exists(script)) return blocked(`\u627E\u4E0D\u5230\u70E7\u5F55\u811A\u672C\uFF1A${script}`);
  const python = deps.which("python") ?? deps.which("python3");
  if (!python) return blocked("\u6CA1\u6709 Python\uFF0C\u65E0\u6CD5\u8FD0\u884C swd_flash.py\u3002");
  if (options.binary && !deps.exists(options.binary)) {
    return blocked(`\u627E\u4E0D\u5230\u56FA\u4EF6\u6587\u4EF6\uFF1A${options.binary}\u3002\u5148\u8DD1 rcs_fw_build \u751F\u6210 .bin\u3002`);
  }
  const args = [script];
  if (options.binary) args.push("--bin", options.binary);
  if (options.target) args.push("--target", options.target);
  if (options.write) args.push("--write");
  const r = await run(python, args, { timeoutMs: 5 * 60 * 1e3 });
  if (r.spawnError) return blocked(`\u542F\u52A8\u5931\u8D25\uFF1A${r.spawnError}`);
  return {
    ok: r.code === 0,
    wrote: options.write === true && r.code === 0,
    binary: options.binary ?? "(\u811A\u672C\u9ED8\u8BA4)",
    output: `${r.stdout}
${r.stderr}`.trim()
  };
}

// packages/rcs-core/src/runner.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync9, lstatSync } from "node:fs";
import { delimiter, join as join11 } from "node:path";
var MAX_OUTPUT = 256 * 1024;
var nodeRunner = (command, args, options = {}) => new Promise((resolve2) => {
  const timeoutMs = options.timeoutMs ?? 2 * 60 * 1e3;
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (r) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve2(r);
  };
  let child;
  try {
    child = spawn(command, args, { cwd: options.cwd, shell: false, windowsHide: true });
  } catch (e) {
    resolve2({ code: -1, stdout: "", stderr: "", spawnError: e.message });
    return;
  }
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish({
      code: -1,
      stdout,
      stderr,
      spawnError: `\u8D85\u65F6\uFF08${Math.round(timeoutMs / 1e3)}s\uFF09\u5DF2\u5F3A\u5236\u7ED3\u675F\u3002\u5E38\u89C1\u539F\u56E0\uFF1A\u70E7\u5F55\u5668\u672A\u8FDE\u63A5\u3001Keil \u5F39\u51FA\u4E86\u6A21\u6001\u5BF9\u8BDD\u6846\u3002`
    });
  }, timeoutMs);
  child.stdout?.on("data", (d) => {
    if (stdout.length < MAX_OUTPUT) stdout += d.toString();
  });
  child.stderr?.on("data", (d) => {
    if (stderr.length < MAX_OUTPUT) stderr += d.toString();
  });
  child.on("error", (e) => finish({ code: -1, stdout, stderr, spawnError: e.message }));
  child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }));
});
var EXE_EXT = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
function executableExists(p) {
  if (existsSync9(p)) return true;
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
function whichSync(cmd) {
  if (cmd.includes("/") || cmd.includes("\\")) {
    return executableExists(cmd) ? cmd : void 0;
  }
  const paths = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
  for (const dir of paths) {
    for (const ext of EXE_EXT) {
      const full = join11(dir, cmd + ext);
      if (executableExists(full)) return full;
    }
  }
  return void 0;
}
var nodeDeps = {
  exists: (p) => existsSync9(p),
  which: whichSync
};

// packages/rcs-core/src/lint-embedded.ts
var DEFAULT_EMBEDDED_RULES = [
  {
    id: "isr-no-printf",
    severity: "error",
    pattern: String.raw`\b(printf|sprintf|snprintf|puts|fprintf)\s*\(`,
    isrOnly: true,
    message: "\u4E2D\u65AD\u91CC\u8C03\u7528\u4E86 printf \u7CFB\u5217",
    why: "printf \u4F1A\u8D70\u683C\u5F0F\u5316\u4E0E\u963B\u585E\u8F93\u51FA\uFF0C\u5728\u4E2D\u65AD\u91CC\u53EF\u80FD\u8017\u65F6\u6570\u6BEB\u79D2\uFF0C\u76F4\u63A5\u6253\u4E71\u63A7\u5236\u5468\u671F\uFF0C\u4E25\u91CD\u65F6\u4E22\u4E2D\u65AD\u3002\u8981\u8F93\u51FA\u8BF7\u7F6E\u6807\u5FD7\u4F4D\uFF0C\u4EA4\u7ED9\u4EFB\u52A1\u5904\u7406\u3002"
  },
  {
    id: "isr-no-malloc",
    severity: "error",
    pattern: String.raw`\b(malloc|calloc|realloc|free|pvPortMalloc|vPortFree)\s*\(`,
    isrOnly: true,
    message: "\u4E2D\u65AD\u91CC\u505A\u4E86\u52A8\u6001\u5185\u5B58\u5206\u914D/\u91CA\u653E",
    why: "\u5806\u64CD\u4F5C\u8981\u62FF\u9501\uFF0C\u5728\u4E2D\u65AD\u91CC\u53EF\u80FD\u6B7B\u9501\u6216\u7834\u574F\u5806\u7ED3\u6784\u3002\u4E2D\u65AD\u91CC\u53EA\u80FD\u7528\u9884\u5206\u914D\u7684\u9759\u6001\u7F13\u51B2\u3002"
  },
  {
    id: "isr-no-blocking-delay",
    severity: "error",
    pattern: String.raw`\b(HAL_Delay|vTaskDelay|osDelay|delay_ms|delay_us)\s*\(`,
    isrOnly: true,
    message: "\u4E2D\u65AD\u91CC\u8C03\u7528\u4E86\u963B\u585E\u5EF6\u65F6",
    why: "\u4E2D\u65AD\u91CC\u963B\u585E\u4F1A\u628A\u6574\u4E2A\u7CFB\u7EDF\u5361\u4F4F\u3002\u9700\u8981\u5EF6\u65F6\u5C31\u7528\u5B9A\u65F6\u5668\u6216\u72B6\u6001\u673A\u3002"
  },
  {
    id: "isr-use-fromisr",
    severity: "warn",
    pattern: String.raw`\b(xQueueSend|xQueueReceive|xSemaphoreGive|xSemaphoreTake|xTaskNotify)\s*\(`,
    isrOnly: true,
    message: "\u4E2D\u65AD\u91CC\u7528\u4E86\u975E FromISR \u7248\u672C\u7684 FreeRTOS API",
    why: "\u4E2D\u65AD\u4E0A\u4E0B\u6587\u5FC5\u987B\u7528 ...FromISR \u53D8\u4F53\u5E76\u5904\u7406 pxHigherPriorityTaskWoken\uFF0C\u5426\u5219\u884C\u4E3A\u672A\u5B9A\u4E49\u3002"
  },
  {
    id: "volatile-shared-flag",
    severity: "warn",
    pattern: String.raw`^(?!\s*volatile)(static\s+)?(uint8_t|uint16_t|uint32_t|int|bool|_Bool)\s+\w*(flag|Flag|ready|Ready|done|Done)\w*\s*(=|;)`,
    // 两道收敛：只看文件作用域的全局变量，且本文件里得真有中断服务函数。
    // 不收敛的话光新模板就报 175 条，绝大多数是局部变量与厂商代码，没人会看。
    fileScopeOnly: true,
    requiresIsrInFile: true,
    message: "\u7591\u4F3C\u4E2D\u65AD\u4E0E\u4EFB\u52A1\u5171\u4EAB\u7684\u5168\u5C40\u6807\u5FD7\u4F4D\u6CA1\u52A0 volatile",
    why: "\u7F16\u8BD1\u5668\u4F18\u5316\u540E\u53EF\u80FD\u628A\u53D8\u91CF\u7F13\u5B58\u8FDB\u5BC4\u5B58\u5668\uFF0C\u5BFC\u81F4\u4EFB\u52A1\u6C38\u8FDC\u770B\u4E0D\u5230\u4E2D\u65AD\u91CC\u7684\u4FEE\u6539\u3002\u8DE8\u4E2D\u65AD\u5171\u4EAB\u7684\u53D8\u91CF\u5FC5\u987B volatile\u3002\u672C\u6587\u4EF6\u542B\u4E2D\u65AD\u670D\u52A1\u51FD\u6570\uFF0C\u6545\u91CD\u70B9\u63D0\u793A\u3002"
  },
  {
    id: "critical-section-pair",
    severity: "warn",
    pattern: String.raw`\b(taskENTER_CRITICAL|__disable_irq|portENTER_CRITICAL)\s*\(`,
    message: "\u8FDB\u5165\u4E86\u4E34\u754C\u533A/\u5173\u4E2D\u65AD",
    why: "\u5FC5\u987B\u786E\u8BA4\u6240\u6709\u5206\u652F\uFF08\u542B\u63D0\u524D return \u4E0E\u5F02\u5E38\u8DEF\u5F84\uFF09\u90FD\u6210\u5BF9\u9000\u51FA\uFF0C\u5426\u5219\u4E2D\u65AD\u6C38\u4E45\u5173\u95ED\u3002\u672C\u68C0\u67E5\u53EA\u63D0\u793A\u4F4D\u7F6E\uFF0C\u9700\u4EBA\u5DE5\u6838\u5BF9\u914D\u5BF9\u3002"
  },
  {
    id: "estop-software-bypass",
    severity: "error",
    pattern: String.raw`(estop|e_stop|emergency|急停)`,
    message: "\u4EE3\u7801\u4E2D\u51FA\u73B0\u6025\u505C\u76F8\u5173\u903B\u8F91",
    why: "\u89C4\u5219 12.2 \u8981\u6C42\u7EA2\u8272\u6025\u505C\u6309\u94AE\u4E3A\u786C\u4EF6\u56DE\u8DEF\u3002\u82E5\u8FD9\u91CC\u662F\u300C\u8F6F\u4EF6\u8BFB\u6025\u505C\u5F15\u811A\u518D\u51B3\u5B9A\u662F\u5426\u505C\u673A\u300D\uFF0C\u5219\u6025\u505C\u53EF\u88AB\u8F6F\u4EF6\u65C1\u8DEF \u2014\u2014 \u5FC5\u987B\u7531\u786C\u4EF6\u76F4\u63A5\u5207\u65AD\u9A71\u52A8\u4F7F\u80FD/\u52A8\u529B\uFF0C\u8F6F\u4EF6\u53EA\u80FD\u505A\u8F85\u52A9\u4E0A\u62A5\u3002\u8BF7\u4EBA\u5DE5\u6838\u5BF9\u63A5\u7EBF\u3002"
  },
  {
    id: "watchdog-feed-in-loop",
    severity: "info",
    pattern: String.raw`\b(HAL_IWDG_Refresh|IWDG_ReloadCounter|WWDG_Refresh)\s*\(`,
    message: "\u770B\u95E8\u72D7\u5582\u72D7\u70B9",
    why: "\u5582\u72D7\u5E94\u653E\u5728\u80FD\u53CD\u6620\u7CFB\u7EDF\u5065\u5EB7\u7684\u4F4D\u7F6E\u3002\u5982\u679C\u653E\u5728\u4E00\u4E2A\u5373\u4F7F\u4EFB\u52A1\u5361\u6B7B\u4E5F\u7167\u8DD1\u7684\u5730\u65B9\uFF08\u6BD4\u5982\u7A7A\u95F2\u94A9\u5B50\u91CC\u65E0\u6761\u4EF6\u5582\uFF09\uFF0C\u770B\u95E8\u72D7\u5C31\u5931\u53BB\u610F\u4E49\u3002"
  }
];
function isIsrName(name2) {
  return /(_IRQHandler|_Handler|_ISR|Callback)$/.test(name2);
}
function findFunctions(source) {
  const lines = source.split(/\r?\n/);
  const out = [];
  const head = /^[A-Za-z_][\w\s*&:<>,]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*(\{)?\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(if|for|while|switch|return|else|do)\b/.test(line)) continue;
    const m = head.exec(line);
    if (!m || !m[1]) continue;
    let depth = 0;
    let started = false;
    let end = i;
    for (let j = i; j < lines.length && j < i + 4e3; j++) {
      const l = lines[j] ?? "";
      for (const ch of l) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") depth--;
      }
      if (started && depth <= 0) {
        end = j;
        break;
      }
    }
    if (!started) continue;
    out.push({ name: m[1], startLine: i + 1, endLine: end + 1, isIsr: isIsrName(m[1]) });
    i = end;
  }
  return out;
}
function isSuppressed(line, ruleId) {
  const m = /rcs-lint-ignore:\s*([\w-]+)/.exec(line);
  return m?.[1] === ruleId;
}
var VENDOR_DIRS2 = [
  "Drivers",
  "Middlewares",
  "CMSIS",
  "FWLIB",
  "CORE",
  "SYSTEM",
  "uCOS-II",
  "ThirdParty_Module",
  "OBJ",
  "build",
  // MDK 会把 CMSIS 头放进 .cmsis/RTE，实测会漏进来
  ".cmsis",
  "RTE",
  "DebugConfig",
  "Listings"
];
function lintEmbedded(root, options = {}) {
  const rules = options.rules ?? DEFAULT_EMBEDDED_RULES;
  const findings = [];
  const compiled = rules.map((r) => ({ rule: r, re: new RegExp(r.pattern) }));
  const skipDirs = [...VENDOR_DIRS2, ...options.excludeDirs ?? []];
  const files = walkFiles(root, {
    extensions: [".c", ".cpp", ".h", ".hpp"],
    skipDirs
  }).filter((f) => {
    if (!options.includeDirs?.length) return true;
    const rel = relPath(root, f);
    return options.includeDirs.some((d) => rel.startsWith(d));
  });
  let isrCount = 0;
  for (const file of files) {
    const text = readText(file);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    const fns = findFunctions(text);
    isrCount += fns.filter((f) => f.isIsr).length;
    const fnAt = (lineNo) => fns.find((f) => lineNo >= f.startLine && lineNo <= f.endLine);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      for (const { rule, re } of compiled) {
        if (!re.test(line)) continue;
        if (isSuppressed(line, rule.id)) continue;
        const fn = fnAt(i + 1);
        if (rule.isrOnly && !fn?.isIsr) continue;
        if (rule.fileScopeOnly && fn) continue;
        if (rule.requiresIsrInFile && !fns.some((x) => x.isIsr)) continue;
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          message: fn ? `${rule.message}\uFF08\u51FD\u6570 ${fn.name}\uFF09` : rule.message,
          file: relPath(root, file),
          line: i + 1,
          detail: rule.why
        });
      }
    }
  }
  const byRule = {};
  for (const f of findings) byRule[`rule:${f.rule}`] = (byRule[`rule:${f.rule}`] ?? 0) + 1;
  return toResult("lint-embedded", root, findings, {
    files: files.length,
    isrFunctions: isrCount,
    ...byRule
  });
}

// packages/rcs-core/src/rule-import.ts
import { readFileSync as readFileSync8, writeFileSync as writeFileSync2, mkdirSync as mkdirSync2, existsSync as existsSync10, copyFileSync, readdirSync as readdirSync3 } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { join as join12, basename as basename2 } from "node:path";

// packages/rcs-core/src/index.ts
function loadJsonConfig(path) {
  return JSON.parse(readFileSync9(path, "utf8"));
}

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

// packages/dsh-rcs-control/src/index.ts
var name = "rcs-control";
var inject = ["tools"];
var Config = Schema.object({
  // 以下路径默认全部留空 —— 写死绝对路径在别人机器上一个都不存在。
  // 留空时按 rcs-core/paths.ts 的解析链去找，找不到会明确报错并列出找过哪里。
  projectRoot: Schema.string().default(""),
  configDir: Schema.string().default(""),
  keilProject: Schema.string().default(""),
  uv4: Schema.string().default(""),
  supportTestDir: Schema.string().default(""),
  flashScript: Schema.string().default("")
});
var FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rule: { type: "string", description: "\u89C4\u5219 ID" },
    severity: { type: "string", enum: ["error", "warn", "info"], description: "\u4E25\u91CD\u7EA7\u522B" },
    message: { type: "string", description: "\u4E00\u53E5\u8BDD\u8BF4\u660E" },
    file: { type: "string", description: "\u76F8\u5BF9\u8DEF\u5F84" },
    line: { type: "integer", description: "\u884C\u53F7" },
    detail: { type: "string", description: "\u8865\u5145\u7EC6\u8282\uFF0C\u5982\u4F20\u9012\u4F9D\u8D56\u94FE" }
  }
};
var RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    check: { type: "string", description: "\u68C0\u67E5\u5668\u540D" },
    target: { type: "string", description: "\u88AB\u68C0\u67E5\u76EE\u5F55" },
    ok: { type: "boolean", description: "\u65E0 error \u7EA7\u53D1\u73B0\u5373\u4E3A true" },
    stats: { type: "json", description: "\u8BA1\u6570\u7EDF\u8BA1" },
    findings: { type: "array", items: FINDING_SCHEMA, description: "\u5168\u90E8\u53D1\u73B0" }
  }
};
function renderResult(r, limit = 40) {
  const findings = r.findings ?? [];
  const head = `[${r.ok ? "PASS" : "FAIL"}] ${r.check ?? ""}  ${r.target ?? ""}`;
  const stats = statsLine(r.stats);
  if (findings.length === 0) return `${head}
${stats}
\u65E0\u53D1\u73B0\u3002`;
  const shown = findings.slice(0, limit).map((f) => {
    const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
    const mark = TONE_MARK[severityTone(f.severity)];
    return `${mark} [${f.rule ?? "?"}] ${f.message ?? ""}${loc}${f.detail ? `
    ${f.detail}` : ""}`;
  });
  const more = findings.length > limit ? `
\u2026 \u53E6\u6709 ${findings.length - limit} \u6761\u672A\u5217\u51FA` : "";
  return `${head}
${stats}
${shown.join("\n")}${more}`;
}
function checkCallView(title, target) {
  return { card: "generic", title, kind: "search", rawInput: target };
}
function checkResultView(result) {
  const meta = result.meta;
  if (!isRcsMeta(meta)) return void 0;
  if (meta.groups.length === 0) {
    return { card: "generic", title: `${meta.check} \u2014 \u901A\u8FC7\uFF0C\u65E0\u53D1\u73B0` };
  }
  return {
    card: "search",
    shape: "matches",
    title: `${meta.check} \u2014 ${meta.ok ? "\u901A\u8FC7" : "\u672A\u901A\u8FC7"}`,
    files: meta.groups.map((g) => ({ path: g.path, matches: g.matches })),
    truncated: meta.truncated,
    total: meta.total
  };
}
var hx = (n) => typeof n === "number" ? n.toString(16).padStart(2, "0").toUpperCase() : "??";
function renderRdlc(v) {
  const decoded = v.decoded ?? [];
  const errors = v.errors ?? [];
  const lines = [`\u89E3\u6790\u51FA ${decoded.length} \u5E27\uFF0C${errors.length} \u5904\u9519\u8BEF`];
  if (v.badTokens?.length) {
    lines.push(`\u5FFD\u7565\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684 token\uFF1A${v.badTokens.slice(0, 8).join(" ")}`);
  }
  for (const d of decoded.slice(0, 20)) {
    const p = d.payload ?? {};
    const kind = String(p["kind"] ?? "?");
    const head = `@${d.frame?.offset ?? "?"}  ${d.direction ?? ""}`;
    if (kind === "command") {
      lines.push(
        `${head}  \u547D\u4EE4 seq=${p["sequence"]} \u6A21\u5757=${p["moduleName"]} \u64CD\u4F5C=0x${hx(p["operation"])}  \u6570\u636E ${p["data"]?.length ?? 0} \u5B57\u8282`
      );
    } else if (kind === "feedback") {
      lines.push(
        `${head}  \u53CD\u9988 seq=${p["sequence"]} \u6A21\u5757=${p["moduleName"]} \u72B6\u6001=${p["statusName"]}  echo ${p["echo"]?.length ?? 0} / report ${p["report"]?.length ?? 0} \u5B57\u8282`
      );
    } else if (kind === "error") {
      lines.push(`${head}  \u8F7D\u8377\u89E3\u6790\u5931\u8D25\uFF1A${p["reason"]}`);
    } else {
      lines.push(`${head}  \u672A\u77E5\u8F7D\u8377\uFF0C\u9996\u5B57\u8282 0x${hx(p["first"])}`);
    }
  }
  if (decoded.length > 20) lines.push(`\u2026 \u53E6\u6709 ${decoded.length - 20} \u5E27\u672A\u5217\u51FA`);
  for (const e of errors.slice(0, 10)) {
    lines.push(`\u2717 \u504F\u79FB ${e.offset}\uFF1A${e.reason}`);
    if (e.bytes?.length) lines.push(`    ${toHex(e.bytes)}`);
  }
  if (v.pending) lines.push(`\u5C3E\u90E8\u8FD8\u6709 ${v.pending} \u5B57\u8282\u4E0D\u5B8C\u6574 \u2014\u2014 \u53EF\u80FD\u662F\u6293\u5305\u622A\u65AD\uFF0C\u6216\u5E27\u8FD8\u6CA1\u6536\u5168`);
  return lines.join("\n");
}
function renderToolchain(tools) {
  const has = (id) => tools.find((t) => t.id === id)?.available === true;
  const lines = tools.map((t) => {
    const mark = t.available ? "\u2705" : "\u274C";
    const where = t.path ? `  ${t.path}` : "";
    const hint = !t.available && t.hint ? `
    ${t.hint}` : "";
    return `${mark} ${t.label}${where}${hint}`;
  });
  const canTest = has("wsl") && has("wsl-cmake") && has("wsl-g++") && has("wsl-make") || has("cmake");
  const caps = [
    { ok: has("keil"), name: "rcs_fw_build\uFF08Keil \u6784\u5EFA\uFF09" },
    { ok: canTest, name: "rcs_support_test\uFF08PC \u5355\u5143\u6D4B\u8BD5\uFF09" },
    { ok: has("python"), name: "rcs_fw_flash\uFF08SWD \u70E7\u5F55\uFF09" }
  ];
  const verdict = caps.map((c) => `  ${c.ok ? "\u2705" : "\u274C"} ${c.name}`).join("\n");
  const blocked = caps.filter((c) => !c.ok).length;
  return `${lines.join("\n")}

\u5F53\u524D\u53EF\u7528\u7684\u5DE5\u5177\uFF1A
${verdict}

` + (blocked === 0 ? "\u4E09\u6761\u94FE\u8DEF\u90FD\u901A\u3002" : `${blocked} \u6761\u94FE\u8DEF\u4E0D\u53EF\u7528\uFF0C\u6309\u4E0A\u9762\u7684\u63D0\u793A\u8865\u9F50\u5373\u53EF\u3002`);
}
function renderBuild(r) {
  if (r.blocked) return `\u6784\u5EFA\u672A\u5F00\u59CB\uFF1A${r.blocked}`;
  const head = `[${r.ok ? "PASS" : "FAIL"}] Keil \u6784\u5EFA  ${r.project}
\u9000\u51FA\u7801 ${r.exitCode} \u2014\u2014 ${r.verdict}
\u9519\u8BEF ${r.errors}  \u8B66\u544A ${r.warnings}`;
  const hint = r.hint ? `

\u26A0\uFE0F ${r.hint}` : "";
  const where = r.logFile ? `
\u5B8C\u6574\u65E5\u5FD7\uFF1A${r.logFile}` : "";
  const diags = r.diagnostics ?? [];
  if (diags.length === 0) {
    const tail = r.logTail ? `

\u65E5\u5FD7\u672B\u5C3E\uFF1A
${r.logTail}` : "\n\uFF08\u65E5\u5FD7\u91CC\u6CA1\u6709\u89E3\u6790\u51FA\u8BCA\u65AD\uFF09";
    return `${head}${hint}${tail}${where}`;
  }
  const sorted = [...diags].sort((a, b) => a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1);
  const shown = sorted.slice(0, 40).map((d) => {
    const loc = d.file ? `${d.file}${d.line ? `:${d.line}` : ""}` : "(\u65E0\u4F4D\u7F6E)";
    return `${d.severity === "error" ? "\u2717" : "\u26A0"} ${loc}  ${d.code ?? ""} ${d.message}`;
  });
  const more = sorted.length > 40 ? `
\u2026 \u53E6\u6709 ${sorted.length - 40} \u6761` : "";
  return `${head}${hint}
${shown.join("\n")}${more}${where}`;
}
function renderTests(r) {
  if (r.blocked) return `\u6D4B\u8BD5\u672A\u5F00\u59CB\uFF1A
${r.blocked}`;
  const head = `[${r.ok ? "PASS" : "FAIL"}] PC \u5355\u5143\u6D4B\u8BD5\uFF08${r.mode ?? "?"} \u6A21\u5F0F\uFF09
\u901A\u8FC7 ${r.passed}  \u5931\u8D25 ${r.failed}`;
  if (!r.failures?.length) return head;
  return `${head}
${r.failures.slice(0, 30).map((f) => `\u2717 ${f.name}`).join("\n")}`;
}
function renderFlash(r) {
  if (r.blocked) return `\u70E7\u5F55\u672A\u5F00\u59CB\uFF1A${r.blocked}`;
  const action = r.wrote ? "\u5DF2\u5199\u5165\u5E76\u6821\u9A8C" : "\u4EC5\u6821\u9A8C\uFF08\u672A\u5199\u5165\uFF09";
  const head = `[${r.ok ? "OK" : "FAIL"}] ${action}  ${r.binary}`;
  const tail = r.wrote ? "\n\u26A0\uFE0F \u7247\u5B50\u5DF2\u88AB\u6539\u5199\u3002\u8F6F\u4EF6\u505C\u6B62\u4E0D\u80FD\u66FF\u4EE3\u786C\u4EF6\u6025\u505C\u3001\u9A71\u52A8\u4F7F\u80FD\u7EBF\u548C\u9650\u4F4D\u4FDD\u62A4\u3002" : "";
  return `${head}
${(r.output ?? "").slice(0, 2e3)}${tail}`;
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
  const root = (override) => {
    const explicit = override || shared(ctx)?.projectRoot || config.projectRoot;
    const r = resolveFirmwareRoot(explicit ? { explicit } : {});
    if (!r.ok) throw new Error(firmwareNotFoundMessage(r.tried));
    return r.root;
  };
  const configDir = () => config.configDir || repoPaths.config();
  const layerRules = () => loadJsonConfig(join13(configDir(), "layer-rules.json"));
  const manifest = () => loadJsonConfig(join13(configDir(), "template-manifest.json"));
  const keilProject = (o) => o || config.keilProject || join13(root(), "demo", "MDK-ARM", "RCS_Template_F407.uvprojx");
  const supportTestDir = (o) => o || config.supportTestDir || join13(root(), "demo", "RCS", "RCS_Support", "test");
  const flashScript = () => config.flashScript || join13(root(), "upper_host_cli", "swd_flash.py");
  const rootSafe = (o) => {
    try {
      return root(o);
    } catch {
      return "(\u672A\u627E\u5230\u56FA\u4EF6\u5DE5\u7A0B)";
    }
  };
  const keilProjectSafe = (o) => {
    try {
      return keilProject(o);
    } catch {
      return "(\u672A\u627E\u5230\u56FA\u4EF6\u5DE5\u7A0B)";
    }
  };
  const supportTestDirSafe = (o) => {
    try {
      return supportTestDir(o);
    } catch {
      return "(\u672A\u627E\u5230\u56FA\u4EF6\u5DE5\u7A0B)";
    }
  };
  ctx.tools.register(
    defineTool({
      name: "rcs_lint_layer",
      description: "\u68C0\u67E5 RCS \u56FA\u4EF6\u5DE5\u7A0B\u7684\u5206\u5C42\u7EA2\u7EBF\uFF1ARCS_Support \u662F\u5426\u4F9D\u8D56 HAL/RTOS\uFF08\u542B\u4F20\u9012\u4F9D\u8D56\uFF09\u3001\u6267\u884C\u5668\u662F\u5426\u7EE7\u627F rcs_actor \u6302\u5165\u6267\u884C\u5668\u603B\u7EBF\u3001\u4E3B\u9898\u4EE3\u7801\u662F\u5426\u6DF7\u8FDB\u8DE8\u8D5B\u5B63\u5E93 RCS/\u3002\u8FD9\u4E9B\u7EA6\u5B9A\u539F\u672C\u53EA\u5199\u5728 \u8BF7\u8BFB\u6211.txt \u91CC\uFF0C\u672C\u5DE5\u5177\u628A\u5B83\u53D8\u6210\u53EF\u9A8C\u8BC1\u7684\u68C0\u67E5\u3002",
      parameters: {
        projectRoot: {
          type: "string",
          description: "\u56FA\u4EF6\u5DE5\u7A0B\u6839\u76EE\u5F55\uFF0C\u7701\u7565\u5219\u7528\u63D2\u4EF6\u914D\u7F6E\u91CC\u7684\u9ED8\u8BA4\u503C"
        }
      },
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: "text", text: renderResult(value) }],
        presentationMeta: (_args, value) => toPresentationMeta(value)
      },
      presentCall: (args) => checkCallView("\u5206\u5C42\u7EA2\u7EBF\u68C0\u67E5", rootSafe(args.projectRoot)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        return lintLayers(root(args.projectRoot), layerRules());
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_template_gap",
      description: "\u6BD4\u5BF9 \u8BF7\u8BFB\u6211.txt \u89C4\u5212\u7684 18 \u4E2A\u4F8B\u7A0B\u4E0E RCS_Template/ \u4E0B\u7684\u5B9E\u9645\u6587\u4EF6\uFF0C\u5217\u51FA\u7F3A\u53E3\u3002\u4F8B\u7A0B\u7F3A\u4E00\u4E2A\uFF0C\u65B0\u4EBA\u57F9\u517B\u94FE\u5C31\u65AD\u4E00\u8282\uFF1B\u6807\u8BB0\u4E3A critical \u7684\u7F3A\u5931\u4F1A\u5347\u7EA7\u4E3A error\u3002",
      parameters: {
        projectRoot: { type: "string", description: "\u56FA\u4EF6\u5DE5\u7A0B\u6839\u76EE\u5F55\uFF0C\u7701\u7565\u5219\u7528\u9ED8\u8BA4\u503C" },
        includePairing: {
          type: "boolean",
          description: "\u540C\u65F6\u68C0\u67E5 RCS_Support \u7684\u5934\u6E90\u914D\u5BF9\uFF08\u9ED8\u8BA4 false\uFF09"
        }
      },
      output: {
        schema: { type: "array", items: RESULT_SCHEMA, description: "\u4E00\u4E2A\u6216\u4E24\u4E2A\u68C0\u67E5\u7ED3\u679C" },
        render: (_args, value) => [
          { type: "text", text: value.map((r) => renderResult(r)).join("\n\n") }
        ],
        // 数组结果只投影第一项（例程缺口）；配对检查作为附加信息留在文本里
        presentationMeta: (_args, value) => value[0] ? toPresentationMeta(value[0]) : null
      },
      presentCall: (args) => checkCallView("\u4F8B\u7A0B\u7F3A\u53E3\u6BD4\u5BF9", rootSafe(args.projectRoot)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        const r = root(args.projectRoot);
        const m = manifest();
        const out = [checkTemplateGap(r, m)];
        if (args.includePairing) out.push(checkSupportPairing(r, m));
        return out;
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_repo_hygiene",
      description: "\u68C0\u67E5\u4ED3\u5E93\u536B\u751F\uFF1A\u662F\u5426\u7F3A .gitignore\u3001\u662F\u5426\u6709 Keil \u4E2A\u4EBA\u914D\u7F6E\uFF08*.uvguix\uFF09\u3001\u7F16\u8BD1\u4EA7\u7269\uFF08OBJ/\u3001Listings/\uFF09\u3001\u7F16\u8F91\u6B8B\u7559\uFF08*.orig\uFF09\u7B49\u672C\u4E0D\u8BE5\u5165\u5E93\u7684\u6587\u4EF6\u3002",
      parameters: {
        repoRoot: { type: "string", description: "\u4ED3\u5E93\u6839\u76EE\u5F55\uFF0C\u7701\u7565\u5219\u7528\u9ED8\u8BA4\u503C" }
      },
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: "text", text: renderResult(value) }],
        presentationMeta: (_args, value) => toPresentationMeta(value)
      },
      presentCall: (args) => checkCallView("\u4ED3\u5E93\u536B\u751F\u68C0\u67E5", rootSafe(args.repoRoot)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        return checkRepoHygiene(root(args.repoRoot));
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_lint_embedded",
      description: "\u5D4C\u5165\u5F0F\u4EE3\u7801\u89C4\u8303\u68C0\u67E5\uFF1A\u4E2D\u65AD\u91CC\u7981 printf/malloc/\u963B\u585E\u5EF6\u65F6\u3001\u5FC5\u987B\u7528 FromISR \u53D8\u4F53\u3001\u8DE8\u4E2D\u65AD\u5171\u4EAB\u6807\u5FD7\u4F4D\u8981\u52A0 volatile\u3001\u4E34\u754C\u533A\u914D\u5BF9\u3001\u770B\u95E8\u72D7\u5582\u72D7\u4F4D\u7F6E\uFF0C\u4EE5\u53CA**\u6025\u505C\u56DE\u8DEF\u662F\u5426\u53EF\u80FD\u88AB\u8F6F\u4EF6\u65C1\u8DEF**\uFF08\u89C4\u5219 12.2 \u8981\u6C42\u7EA2\u8272\u6025\u505C\u6309\u94AE\u4E3A\u786C\u4EF6\u56DE\u8DEF\uFF09\u3002\u9ED8\u8BA4\u6392\u9664 HAL/CMSIS \u7B49\u5382\u5546\u4EE3\u7801\uFF0C\u53EA\u67E5\u961F\u5185\u4EE3\u7801\u3002\u53EF\u7528\u884C\u5185\u6CE8\u91CA `// rcs-lint-ignore: <\u89C4\u5219id> <\u7406\u7531>` \u5C31\u5730\u8C41\u514D\u3002",
      parameters: {
        projectRoot: { type: "string", description: "\u56FA\u4EF6\u5DE5\u7A0B\u6839\u76EE\u5F55\uFF0C\u7701\u7565\u5219\u7528\u9ED8\u8BA4\u503C" },
        includeDirs: {
          type: "array",
          items: { type: "string" },
          description: '\u53EA\u68C0\u67E5\u8FD9\u4E9B\u5B50\u76EE\u5F55\uFF08\u76F8\u5BF9\u5DE5\u7A0B\u6839\uFF09\uFF0C\u5982 ["RCS/user"]\uFF1B\u7701\u7565\u5219\u67E5\u5168\u90E8\u961F\u5185\u4EE3\u7801'
        }
      },
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: "text", text: renderResult(value) }],
        presentationMeta: (_args, value) => toPresentationMeta(value)
      },
      presentCall: (args) => checkCallView("\u5D4C\u5165\u5F0F\u89C4\u8303\u68C0\u67E5", rootSafe(args.projectRoot)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        return lintEmbedded(root(args.projectRoot), {
          ...args.includeDirs?.length ? { includeDirs: args.includeDirs } : {}
        });
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_rdlc_decode",
      description: "\u89E3\u6790 RDLC \u534F\u8BAE\u5B57\u8282\u6D41\uFF08\u961F\u5185\u4E0A\u4E0B\u4F4D\u673A\u901A\u4FE1\uFF09\uFF1A\u5E27\u5934 0xC0 / \u5730\u5740 / \u957F\u5EA6 / CRC16-MODBUS / \u5E27\u5C3E 0x0C\uFF0C\u5E76\u89E3\u91CA\u547D\u4EE4(0x10)\u4E0E\u53CD\u9988(0x90)\u8F7D\u8377\u3002\u63A5\u53D7\u5404\u79CD\u6293\u5305\u683C\u5F0F\u7684\u5341\u516D\u8FDB\u5236\u6587\u672C\u3002\u574F\u5E27\u4F1A\u5355\u72EC\u62A5\u51FA\u504F\u79FB\u4E0E\u539F\u59CB\u5B57\u8282\uFF0C\u5E76\u80FD\u91CD\u65B0\u540C\u6B65\u3002",
      parameters: {
        hex: { type: "string", required: true, description: '\u5341\u516D\u8FDB\u5236\u5B57\u8282\uFF0C\u5982 "C0 A0 01 05 00 ..."' }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            decoded: { type: "json", description: "\u89E3\u6790\u51FA\u7684\u5E27" },
            errors: { type: "json", description: "\u574F\u5E27\u53CA\u539F\u56E0" },
            pending: { type: "integer", description: "\u5C3E\u90E8\u4E0D\u5B8C\u6574\u7684\u5B57\u8282\u6570" },
            badTokens: { type: "json", description: "\u65E0\u6CD5\u89E3\u6790\u7684\u5341\u516D\u8FDB\u5236 token" }
          }
        },
        render: (_args, value) => [{ type: "text", text: renderRdlc(value) }]
      },
      // 呈现钩子不得抛异常：回放历史会话时也会调用它，届时 args 可能不完整。
      // 直接写 args.hex.slice() 会在 hex 缺失时炸掉整条消息的渲染。
      presentCall: (args) => {
        const hex2 = String(args?.hex ?? "");
        return checkCallView("\u89E3\u6790 RDLC \u62A5\u6587", hex2.length > 40 ? `${hex2.slice(0, 40)}\u2026` : hex2);
      },
      async execute(args) {
        const { bytes, bad } = parseHexBytes(args.hex);
        const r = decodeRdlc(bytes);
        return { ...r, badTokens: bad };
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_angle_loop_check",
      description: "\u68C0\u67E5\u8235\u8F6E\u89D2\u5EA6\u56DE\u73AF\u3002\u5178\u578B\u9519\u8BEF\u662F inv_kin \u7684 atan2 \u8F93\u51FA\uFF08\u5F27\u5EA6\uFF09\u76F4\u63A5\u8FDB\u4E86 angle_loop\uFF08\u89D2\u5EA6\u5236\uFF09\uFF0C\u4F7F\u56DE\u73AF\u9000\u5316\u4E3A\u7A7A\u64CD\u4F5C \u2014\u2014 \u4EE3\u7801\u7167\u8DD1\u3001\u4E0D\u62A5\u9519\uFF0C\u4F46\u8235\u8F6E\u8FC7 \xB1180\xB0 \u65F6\u4F1A\u8D70\u8FDC\u8DEF\u64E6\u5730\u5361\u6B7B\u3002",
      parameters: { projectRoot: { type: "string", description: "\u5DE5\u7A0B\u6839\u76EE\u5F55\uFF0C\u7701\u7565\u7528\u9ED8\u8BA4" } },
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: "text", text: renderResult(value) }],
        presentationMeta: (_args, value) => toPresentationMeta(value)
      },
      presentCall: (args) => checkCallView("\u68C0\u67E5\u89D2\u5EA6\u56DE\u73AF", rootSafe(args.projectRoot)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        return checkAngleLoop(root(args.projectRoot));
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_kinematics_check",
      description: "\u68C0\u67E5\u5E95\u76D8\u8FD0\u52A8\u5B66\uFF1Ainv_kin \u7684\u7ED3\u679C\u662F\u5426\u6F0F\u4E86 find_nearest\uFF08\u6700\u77ED\u8DEF\uFF09\u3001\u89E3\u7B97\u51FD\u6570\u662F\u5426\u8FD4\u56DE\u4E86\u672A\u521D\u59CB\u5316\u7684\u6808\u5185\u5B58\u3001\u6761\u4EF6\u91CC ||/&& \u4F18\u5148\u7EA7\u6DF7\u7528\u3001\u91CD\u5FC3\u4FEE\u6B63 bias_x/bias_y \u662F\u5426\u672A\u8BBE\u3002",
      parameters: { projectRoot: { type: "string", description: "\u5DE5\u7A0B\u6839\u76EE\u5F55\uFF0C\u7701\u7565\u7528\u9ED8\u8BA4" } },
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: "text", text: renderResult(value) }],
        presentationMeta: (_args, value) => toPresentationMeta(value)
      },
      presentCall: (args) => checkCallView("\u68C0\u67E5\u5E95\u76D8\u8FD0\u52A8\u5B66", rootSafe(args.projectRoot)),
      presentResult: (_args, result) => checkResultView(result),
      async execute(args) {
        return checkKinematics(root(args.projectRoot));
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_toolchain_status",
      description: "\u63A2\u6D4B\u672C\u673A\u5DE5\u5177\u94FE\uFF1AKeil UV4\u3001CMake\u3001Python\u3001WSL\u3002\u6784\u5EFA/\u6D4B\u8BD5/\u70E7\u5F55\u8DD1\u4E0D\u8D77\u6765\u65F6\u5148\u67E5\u8FD9\u4E2A \u2014\u2014 \u7F3A\u4EC0\u4E48\u4F1A\u76F4\u63A5\u7ED9\u51FA\u5B89\u88C5\u547D\u4EE4\u3002",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { tools: { type: "json", description: "\u5404\u5DE5\u5177\u7684\u53EF\u7528\u6027\u4E0E\u8DEF\u5F84" } }
        },
        render: (_args, value) => [
          { type: "text", text: renderToolchain(value.tools ?? []) }
        ]
      },
      presentCall: () => checkCallView("\u63A2\u6D4B\u5DE5\u5177\u94FE", "\u672C\u673A"),
      async execute() {
        const windows = probeToolchain(nodeDeps);
        const hasWsl = windows.find((t) => t.id === "wsl")?.available === true;
        const wsl = hasWsl ? await probeWslToolchain(nodeRunner) : [];
        return { tools: [...windows, ...wsl] };
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_support_test",
      description: "\u8DD1 RCS_Support \u7684 PC \u5355\u5143\u6D4B\u8BD5\uFF08CMake + gtest\uFF09\uFF0C**\u4E0D\u9700\u8981\u4EFB\u4F55\u786C\u4EF6** \u2014\u2014 \u8FD9\u662F CI \u7684\u6838\u5FC3\u3002\u6CE8\u610F\u961F\u5185\u4ED3\u5E93\u91CC\u7684 gtest \u9759\u6001\u5E93\u662F Linux \u4EA7\u7269\uFF0CWindows \u4E0A\u987B\u7ECF WSL \u6784\u5EFA\uFF1B\u73AF\u5883\u4E0D\u9F50\u65F6\u4F1A\u8BF4\u6E05\u7F3A\u4EC0\u4E48\u3001\u600E\u4E48\u88C5\uFF0C\u800C\u4E0D\u662F\u629B\u4E00\u4E2A\u770B\u4E0D\u61C2\u7684\u9519\u3002",
      parameters: { testDir: { type: "string", description: "RCS_Support/test \u76EE\u5F55\uFF0C\u7701\u7565\u7528\u9ED8\u8BA4" } },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", description: "\u5168\u90E8\u901A\u8FC7" },
            passed: { type: "integer", description: "\u901A\u8FC7\u6570" },
            failed: { type: "integer", description: "\u5931\u8D25\u6570" },
            failures: { type: "json", description: "\u5931\u8D25\u7528\u4F8B" },
            blocked: { type: "string", description: "\u65E0\u6CD5\u5F00\u59CB\u7684\u539F\u56E0" },
            mode: { type: "string", description: "native \u6216 wsl" }
          }
        },
        render: (_args, value) => [{ type: "text", text: renderTests(value) }]
      },
      presentCall: (args) => checkCallView("\u8DD1 PC \u5355\u5143\u6D4B\u8BD5", supportTestDirSafe(args.testDir)),
      async execute(args) {
        return await runSupportTests({
          testDir: supportTestDir(args.testDir),
          run: nodeRunner,
          deps: nodeDeps
        });
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_fw_build",
      description: "\u7528 Keil UV4 \u6784\u5EFA\u56FA\u4EF6\uFF0C\u7F16\u8BD1\u9519\u8BEF\u7ED3\u6784\u5316\u8FD4\u56DE\uFF08\u6587\u4EF6:\u884C:\u539F\u56E0\uFF09\u3002\u6CE8\u610F UV4 \u9000\u51FA\u7801 1 \u8868\u793A\u300C\u6709\u8B66\u544A\u4F46\u6210\u529F\u300D\uFF0C\u672C\u5DE5\u5177\u636E\u6B64\u5224\u5B9A\uFF0C\u4E0D\u4F1A\u628A\u6709\u8B66\u544A\u7684\u6210\u529F\u62A5\u6210\u5931\u8D25\u3002",
      parameters: {
        project: { type: "string", description: ".uvprojx \u8DEF\u5F84\uFF0C\u7701\u7565\u7528\u9ED8\u8BA4" },
        target: { type: "string", description: "\u5DE5\u7A0B\u5185\u7684 Target \u540D\uFF0C\u7701\u7565\u7528\u5DE5\u7A0B\u9ED8\u8BA4" },
        rebuild: { type: "boolean", description: "\u5B8C\u6574\u91CD\u5EFA\u800C\u975E\u589E\u91CF" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", description: "\u6784\u5EFA\u662F\u5426\u6210\u529F" },
            exitCode: { type: "integer", description: "UV4 \u9000\u51FA\u7801" },
            verdict: { type: "string", description: "\u9000\u51FA\u7801\u7684\u4EBA\u8BDD\u89E3\u91CA" },
            project: { type: "string", description: "\u5DE5\u7A0B\u6587\u4EF6" },
            errors: { type: "integer", description: "\u9519\u8BEF\u6570" },
            warnings: { type: "integer", description: "\u8B66\u544A\u6570" },
            diagnostics: { type: "json", description: "\u7ED3\u6784\u5316\u8BCA\u65AD" },
            blocked: { type: "string", description: "\u65E0\u6CD5\u5F00\u59CB\u7684\u539F\u56E0" },
            hint: { type: "string", description: "\u73AF\u5883\u7C7B\u5931\u8D25\u7684\u5B9A\u6027\u8BF4\u660E\uFF0C\u5982 license \u672A\u6FC0\u6D3B" },
            logTail: { type: "string", description: "\u4E00\u6761\u8BCA\u65AD\u90FD\u6CA1\u89E3\u6790\u51FA\u6765\u65F6\u7684\u65E5\u5FD7\u672B\u5C3E" },
            logFile: { type: "string", description: "\u5B8C\u6574\u65E5\u5FD7\u8DEF\u5F84" }
          }
        },
        render: (_args, value) => [{ type: "text", text: renderBuild(value) }]
      },
      presentCall: (args) => checkCallView("\u6784\u5EFA\u56FA\u4EF6", keilProjectSafe(args.project)),
      async execute(args) {
        return await buildFirmware({
          project: keilProject(args.project),
          ...config.uv4 ? { uv4: config.uv4 } : {},
          ...args.target ? { target: args.target } : {},
          rebuild: args.rebuild === true,
          run: nodeRunner,
          deps: nodeDeps
        });
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_fw_flash",
      description: "\u70E7\u5F55\u56FA\u4EF6\u5230 STM32F407\uFF08\u590D\u7528\u961F\u5185 upper_host_cli/swd_flash.py\uFF0CpyOCD + SWD\uFF09\u3002**\u9ED8\u8BA4\u53EA\u6821\u9A8C\u4E0D\u5199\u5165**\uFF0Cwrite=true \u624D\u771F\u6B63\u6539\u5199\u7247\u5B50\u3002\u6574\u4E2A\u5DE5\u5177\u6309 L2 \u7269\u7406\u52A8\u4F5C\u7BA1\u63A7\uFF1A\u63A5\u8C03\u8BD5\u5668\u4F1A halt \u4F4F MCU\uFF0C\u82E5\u6B64\u65F6\u673A\u5668\u4EBA\u4E0A\u7535\u4E14\u7535\u673A\u4F7F\u80FD\uFF0C\u6025\u505C\u903B\u8F91\u968F\u4E4B\u505C\u6B62\u8FD0\u884C\u3002\u6267\u884C\u524D\u8BF7\u786E\u8BA4\u5468\u56F4\u65E0\u4EBA\u3001\u673A\u6784\u884C\u7A0B\u5185\u65E0\u624B\u3001\u6C14\u8DEF\u5DF2\u6CC4\u538B\u3002",
      parameters: {
        binary: { type: "string", description: ".bin \u8DEF\u5F84\uFF0C\u7701\u7565\u7528\u811A\u672C\u9ED8\u8BA4" },
        write: { type: "boolean", description: "true \u624D\u771F\u6B63\u5199\u5165\uFF1B\u9ED8\u8BA4\u53EA\u6821\u9A8C" },
        target: { type: "string", description: "\u82AF\u7247\u578B\u53F7\uFF0C\u9ED8\u8BA4 stm32f407vgtx" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", description: "\u662F\u5426\u6210\u529F" },
            wrote: { type: "boolean", description: "\u662F\u5426\u771F\u7684\u5199\u4E86\u7247\u5B50" },
            binary: { type: "string", description: "\u56FA\u4EF6\u6587\u4EF6" },
            output: { type: "string", description: "\u811A\u672C\u8F93\u51FA" },
            blocked: { type: "string", description: "\u65E0\u6CD5\u5F00\u59CB\u7684\u539F\u56E0" }
          }
        },
        render: (_args, value) => [{ type: "text", text: renderFlash(value) }]
      },
      presentCall: (args) => checkCallView(args.write ? "\u70E7\u5F55\u56FA\u4EF6\uFF08\u5199\u5165\uFF09" : "\u6821\u9A8C\u56FA\u4EF6\uFF08\u53EA\u8BFB\uFF09", args.binary ?? "(\u811A\u672C\u9ED8\u8BA4)"),
      async execute(args) {
        return await flashFirmware({
          script: flashScript(),
          ...args.binary ? { binary: args.binary } : {},
          ...args.target ? { target: args.target } : {},
          write: args.write === true,
          run: nodeRunner,
          deps: nodeDeps
        });
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
