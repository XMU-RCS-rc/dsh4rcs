// packages/dsh-rcs-kb/src/index.ts
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

// packages/rcs-core/src/feishu.ts
var FeishuPermissionError = class extends Error {
  scopes;
  appId;
  constructor(message, scopes, appId) {
    super(message);
    this.name = "FeishuPermissionError";
    this.scopes = scopes;
    this.appId = appId;
  }
  /** 该申请的那一个 scope —— 只读优先。 */
  get suggestedScope() {
    return recommendScope(this.scopes).scope;
  }
  /** 面向人的一句话说明：申请哪个、别申请哪个。 */
  get scopeAdvice() {
    return describeScopes(this.scopes);
  }
  get authLink() {
    if (!this.appId || !this.suggestedScope) return void 0;
    return `https://open.feishu.cn/app/${this.appId}/auth?q=${this.suggestedScope}&op_from=openapi&token_type=tenant`;
  }
};
function recommendScope(scopes) {
  const ro = scopes.find((s) => s.endsWith(":readonly"));
  const scope = ro ?? scopes[0] ?? "";
  return { scope, readonly: ro !== void 0, others: scopes.filter((s) => s !== scope) };
}
function describeScopes(scopes) {
  const { scope, readonly, others } = recommendScope(scopes);
  if (!scope) return "\uFF08\u98DE\u4E66\u6CA1\u6709\u8FD4\u56DE\u5177\u4F53\u7684\u6743\u9650\u540D\uFF09";
  if (readonly) {
    const tail = others.length > 0 ? `\uFF08\u98DE\u4E66\u5217\u51FA\u7684\u53E6\u5916 ${others.length} \u4E2A\u662F\u8BFB\u5199\u6743\u9650\uFF0C\u4EFB\u9009\u5176\u4E00\u5373\u53EF \u2014\u2014 **\u53EA\u5F00\u8FD9\u4E2A\u53EA\u8BFB\u7684**\uFF09` : "";
    return `${scope}${tail}`;
  }
  return `${scope} \u26A0\uFE0F \u5019\u9009\u91CC\u6CA1\u6709\u53EA\u8BFB\u7248\u672C\uFF0C\u5F00\u901A\u524D\u8BF7\u786E\u8BA4\u5B83\u7ED9\u51FA\u7684\u5199\u6743\u9650\u662F\u5426\u53EF\u63A5\u53D7`;
}
var FeishuApiError = class extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.name = "FeishuApiError";
    this.code = code;
  }
};
var DENIED = 99991672;
var RATE_LIMITED = 99991400;
function parseScopes(msg) {
  const inner = /\[([^\]]+)\]/.exec(msg ?? "")?.[1];
  return inner ? inner.split(",").map((s) => s.trim()).filter(Boolean) : [];
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var HttpFeishuClient = class {
  appId;
  #secret;
  #base;
  #fetch;
  #minInterval;
  #retries;
  #token;
  /** token 到期时刻（ms）。提前 60s 视为过期，避免边界上刚好失效。 */
  #tokenExpiry = 0;
  /** 上一次请求发出的时刻，用于限速。请求是串行的。 */
  #lastCall = 0;
  constructor(creds, options = {}) {
    if (!creds.appId) throw new Error("\u7F3A\u5C11 app_id");
    if (!creds.appSecret) {
      throw new Error(
        "\u7F3A\u5C11 app_secret\u3002\u5B83\u5FC5\u987B\u4ECE\u73AF\u5883\u53D8\u91CF\u8BFB\u53D6\uFF08\u9ED8\u8BA4 FEISHU_APP_SECRET\uFF09\uFF0C\u4E0D\u653E\u914D\u7F6E\u6587\u4EF6\u3001\u4E0D\u8D70\u547D\u4EE4\u884C\u53C2\u6570 \u2014\u2014 \u524D\u8005\u4F1A\u8FDB git\uFF0C\u540E\u8005\u4F1A\u8FDB shell \u5386\u53F2\u3002"
      );
    }
    this.appId = creds.appId;
    this.#secret = creds.appSecret;
    this.#base = options.baseUrl ?? "https://open.feishu.cn/open-apis";
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#minInterval = options.minIntervalMs ?? 120;
    this.#retries = options.retries ?? 2;
  }
  async #accessToken() {
    if (this.#token && Date.now() < this.#tokenExpiry) return this.#token;
    const r = await this.#fetch(`${this.#base}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.#secret })
    });
    const j = await r.json();
    if (j.code !== 0 || !j.tenant_access_token) {
      throw new FeishuApiError(
        `\u83B7\u53D6 tenant_access_token \u5931\u8D25\uFF1Acode=${j.code} ${j.msg ?? ""}\u3002\u68C0\u67E5 app_id \u4E0E app_secret \u662F\u5426\u5339\u914D\u3001secret \u662F\u5426\u521A\u91CD\u7F6E\u8FC7\u3002`,
        j.code ?? -1
      );
    }
    this.#token = j.tenant_access_token;
    this.#tokenExpiry = Date.now() + Math.max(0, (j.expire ?? 7200) - 60) * 1e3;
    return this.#token;
  }
  /** 串行 + 限速 + 重试的 GET。所有读接口都走这里。 */
  async #get(path) {
    const token = await this.#accessToken();
    for (let attempt = 0; ; attempt++) {
      const wait = this.#lastCall + this.#minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      this.#lastCall = Date.now();
      let j;
      try {
        const r = await this.#fetch(`${this.#base}${path}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        j = await r.json();
      } catch (e) {
        if (attempt >= this.#retries) {
          throw new FeishuApiError(`\u7F51\u7EDC\u9519\u8BEF\uFF08\u5DF2\u91CD\u8BD5 ${attempt} \u6B21\uFF09\uFF1A${e.message}`, -1);
        }
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (j.code === 0) return j.data ?? {};
      if (j.code === DENIED) {
        throw new FeishuPermissionError(
          `\u6743\u9650\u4E0D\u8DB3\uFF1A${path}`,
          parseScopes(j.msg),
          this.appId
        );
      }
      if (j.code === RATE_LIMITED && attempt < this.#retries) {
        await sleep(1e3 * (attempt + 1));
        continue;
      }
      throw new FeishuApiError(`\u98DE\u4E66\u63A5\u53E3\u9519\u8BEF code=${j.code}\uFF1A${j.msg ?? ""}`, j.code ?? -1);
    }
  }
  async listFolder(token, pageToken) {
    const qs = `folder_token=${encodeURIComponent(token)}&page_size=50` + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");
    const data = await this.#get(`/drive/v1/files?${qs}`);
    const raw = data["files"] ?? [];
    return {
      // 缺字段就退化成空串而不是 undefined —— 下游用 token 当键，
      // 一个 undefined 键会静默污染整份清单。
      files: raw.map((f) => ({
        token: f["token"] ?? "",
        name: f["name"] ?? "(\u672A\u547D\u540D)",
        type: f["type"] ?? "unknown",
        parentToken: f["parent_token"] ?? token,
        url: f["url"],
        modifiedTime: f["modified_time"]
      })).filter((f) => f.token !== ""),
      hasMore: Boolean(data["has_more"]),
      nextPageToken: data["next_page_token"]
    };
  }
  async docxRawContent(token) {
    const data = await this.#get(`/docx/v1/documents/${encodeURIComponent(token)}/raw_content`);
    return data["content"] ?? "";
  }
  async legacyDocContent(token) {
    const data = await this.#get(`/doc/v2/${encodeURIComponent(token)}/content`);
    const content = data["content"];
    if (typeof content !== "string") return "";
    return extractLegacyText(content);
  }
};
function extractLegacyText(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return "";
  }
  const out = [];
  const visit = (v) => {
    if (typeof v === "string") return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "text" && typeof x === "string") out.push(x);
        else visit(x);
      }
    }
  };
  visit(parsed);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

// packages/rcs-core/src/kb-sync.ts
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
var DEFAULT_SYNC_POLICY = {
  allowlistOnly: true,
  includeTypes: ["docx", "doc"],
  excludeTypes: ["file", "shortcut", "bitable", "mindnote", "slides"],
  maxDepth: 6
};
var AllowlistGuard = class {
  #allowed = /* @__PURE__ */ new Set();
  #roots;
  constructor(roots) {
    this.#roots = [...roots];
    for (const r of roots) this.#allowed.add(r);
  }
  /** 遍历中发现的、位于白名单子树内的节点。 */
  admit(token) {
    this.#allowed.add(token);
  }
  has(token) {
    return this.#allowed.has(token);
  }
  get size() {
    return this.#allowed.size;
  }
  assert(token, what) {
    if (this.#allowed.has(token)) return;
    throw new Error(
      `\u767D\u540D\u5355\u8D8A\u754C\uFF1A\u62D2\u7EDD\u8BBF\u95EE ${what}\uFF08token=${token}\uFF09\u3002
\u6388\u6743\u8303\u56F4\u53EA\u6709\u8FD9\u4E9B\u6839\u76EE\u5F55\uFF1A${this.#roots.join(", ")}\u3002
\u8FD9\u4E0D\u662F\u914D\u7F6E\u95EE\u9898\u800C\u662F\u4EE3\u7801\u95EE\u9898 \u2014\u2014 \u53D6\u6B63\u6587\u524D\u5FC5\u987B\u5148\u7ECF\u8FC7\u904D\u5386\u53D1\u73B0\u8BE5\u8282\u70B9\u3002`
    );
  }
};
async function walkAllowlist(client, sources, policy, guard, onProgress) {
  const docs = [];
  const skippedByType = {};
  let folders = 0;
  let depthCapped = 0;
  const seen = new Set(sources.map((s) => s.token));
  const queue = sources.map((s) => ({
    token: s.token,
    path: s.label,
    depth: 0
  }));
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur) break;
    folders++;
    let pageToken;
    do {
      const page = await client.listFolder(cur.token, pageToken);
      pageToken = page.hasMore ? page.nextPageToken : void 0;
      for (const f of page.files) {
        guard.admit(f.token);
        const path = `${cur.path}/${f.name}`;
        if (f.type === "folder") {
          if (cur.depth + 1 > policy.maxDepth) {
            depthCapped++;
            continue;
          }
          if (seen.has(f.token)) continue;
          seen.add(f.token);
          queue.push({ token: f.token, path, depth: cur.depth + 1 });
          continue;
        }
        if (f.type === "shortcut" || policy.excludeTypes.includes(f.type)) {
          skippedByType[f.type] = (skippedByType[f.type] ?? 0) + 1;
          continue;
        }
        if (!policy.includeTypes.includes(f.type)) {
          skippedByType[f.type] = (skippedByType[f.type] ?? 0) + 1;
          continue;
        }
        docs.push({ ...f, path, depth: cur.depth + 1 });
      }
    } while (pageToken);
    onProgress?.(folders, docs.length);
  }
  return { docs, skippedByType, folders, depthCapped };
}
var MANIFEST = "manifest.json";
var DOCS_DIR = "docs";
function manifestPath(cacheDir) {
  return join(cacheDir, MANIFEST);
}
function docPath(cacheDir, token) {
  return join(cacheDir, DOCS_DIR, `${token}.txt`);
}
function loadManifest(cacheDir) {
  const p = manifestPath(cacheDir);
  if (!existsSync(p)) return void 0;
  try {
    const m = JSON.parse(readFileSync(p, "utf8"));
    return m.version === 1 && m.docs ? m : void 0;
  } catch {
    return void 0;
  }
}
async function syncKnowledgeBase(options) {
  const { client, sources, policy, cacheDir, force = false } = options;
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  if (sources.length === 0) {
    throw new Error(
      "\u6CA1\u6709\u914D\u7F6E\u4EFB\u4F55\u540C\u6B65\u6765\u6E90\u3002\u8BF7\u5728 config/team.json \u7684 feishu.sources \u91CC\u5217\u51FA\u6388\u6743\u76EE\u5F55 \u2014\u2014 \u8FD9\u4EFD\u6E05\u5355\u5C31\u662F\u6388\u6743\u8303\u56F4\u672C\u8EAB\uFF0C\u7A7A\u7684\u610F\u5473\u7740\u4EC0\u4E48\u90FD\u4E0D\u8BE5\u540C\u6B65\u3002"
    );
  }
  if (!policy.allowlistOnly) {
    throw new Error(
      "feishu.sync.allowlistOnly \u5FC5\u987B\u4E3A true\u3002\u98DE\u4E66\u4FA7\u5BF9\u8BE5\u5171\u4EAB\u6587\u4EF6\u5939\u6CA1\u6709\u505A\u5230\u76EE\u5F55\u7EA7\u9694\u79BB\uFF0C\u672C\u5730\u767D\u540D\u5355\u662F\u552F\u4E00\u7684\u8303\u56F4\u5C4F\u969C\uFF0C\u5173\u6389\u5B83\u7B49\u4E8E\u628A\u5168\u961F\u8D44\u6599\u7EB3\u5165\u540C\u6B65\u8303\u56F4\u3002"
    );
  }
  const guard = new AllowlistGuard(sources.map((s) => s.token));
  const walked = await walkAllowlist(
    client,
    sources,
    policy,
    guard,
    (folders, docs2) => options.onProgress?.("walk", folders, docs2)
  );
  const previous = loadManifest(cacheDir);
  const prevDocs = previous?.docs ?? {};
  mkdirSync(join(cacheDir, DOCS_DIR), { recursive: true });
  const docs = {};
  const failures = [];
  let permissionHint;
  const stats = {
    added: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    removed: 0,
    folders: walked.folders
  };
  let done = 0;
  for (const node of walked.docs) {
    done++;
    options.onProgress?.("fetch", done, walked.docs.length);
    const prev = prevDocs[node.token];
    const unchanged = !force && prev !== void 0 && prev.error === void 0 && prev.modifiedTime === node.modifiedTime && existsSync(docPath(cacheDir, node.token));
    if (unchanged) {
      docs[node.token] = { ...prev, name: node.name, path: node.path, url: node.url };
      stats.unchanged++;
      continue;
    }
    guard.assert(node.token, `${node.type} \u300C${node.name}\u300D`);
    try {
      const text = node.type === "docx" ? await client.docxRawContent(node.token) : await client.legacyDocContent(node.token);
      writeFileSync(docPath(cacheDir, node.token), text, "utf8");
      docs[node.token] = {
        token: node.token,
        name: node.name,
        type: node.type,
        path: node.path,
        url: node.url,
        modifiedTime: node.modifiedTime,
        bytes: Buffer.byteLength(text, "utf8"),
        syncedAt: now().toISOString()
      };
      if (prev === void 0) stats.added++;
      else stats.updated++;
    } catch (e) {
      const err = e;
      stats.failed++;
      failures.push({ name: node.name, path: node.path, reason: err.message });
      docs[node.token] = {
        token: node.token,
        name: node.name,
        type: node.type,
        path: node.path,
        url: node.url,
        modifiedTime: node.modifiedTime,
        error: err.message
      };
      if (e instanceof FeishuPermissionError && !permissionHint) {
        permissionHint = { scopes: e.scopes, authLink: e.authLink };
      }
    }
  }
  for (const token of Object.keys(prevDocs)) {
    if (docs[token]) continue;
    stats.removed++;
    rmSync(docPath(cacheDir, token), { force: true });
  }
  const manifest = {
    version: 1,
    syncedAt: now().toISOString(),
    sources: sources.map((s) => ({ label: s.label, token: s.token })),
    policy,
    docs,
    skippedByType: walked.skippedByType
  };
  writeFileSync(manifestPath(cacheDir), `${JSON.stringify(manifest, null, 2)}
`, "utf8");
  return { manifest, stats, failures, permissionHint };
}

// packages/rcs-core/src/kb-index.ts
import { readFileSync as readFileSync2, existsSync as existsSync2 } from "node:fs";
var MAX_DOC_BYTES = 2 * 1024 * 1024;
function bigrams(s) {
  const t = s.replace(/\s+/g, "");
  const out = /* @__PURE__ */ new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}
function snippetsAround(text, needle, max = 3, radius = 60, ignoreCase = false) {
  if (!needle) return [];
  const haystack = ignoreCase ? text.toLowerCase() : text;
  const target = ignoreCase ? needle.toLowerCase() : needle;
  const out = [];
  let from = 0;
  let lastEnd = -1;
  while (out.length < max) {
    const i = haystack.indexOf(target, from);
    if (i < 0) break;
    from = i + needle.length;
    if (i < lastEnd) continue;
    const start = Math.max(0, i - radius);
    const end = Math.min(text.length, i + needle.length + radius);
    lastEnd = end;
    const prefix = start > 0 ? "\u2026" : "";
    const suffix = end < text.length ? "\u2026" : "";
    out.push(`${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`);
  }
  return out;
}
function readDocText(cacheDir, token) {
  const p = docPath(cacheDir, token);
  if (!existsSync2(p)) return "";
  try {
    const buf = readFileSync2(p);
    if (buf.byteLength > MAX_DOC_BYTES) return buf.subarray(0, MAX_DOC_BYTES).toString("utf8");
    return buf.toString("utf8");
  } catch {
    return "";
  }
}
function hasCjk(s) {
  return /[㐀-鿿豈-﫿]/.test(s);
}
function searchKb(cacheDir, query, limit = 8) {
  const q = query.trim();
  if (!q) return [];
  const manifest = loadManifest(cacheDir);
  if (!manifest) return [];
  const cjk = hasCjk(q);
  const needle = cjk ? q : q.toLowerCase();
  const fold = (s) => cjk ? s : s.toLowerCase();
  const qGrams = cjk ? bigrams(q) : /* @__PURE__ */ new Set();
  const hits = [];
  for (const doc of Object.values(manifest.docs)) {
    if (doc.error) continue;
    const text = readDocText(cacheDir, doc.token);
    let score = 0;
    const matchedIn = [];
    if (fold(doc.name).includes(needle)) {
      score += 200;
      matchedIn.push("name");
    }
    if (fold(doc.path).includes(needle)) {
      score += 40;
      matchedIn.push("path");
    }
    if (fold(text).includes(needle)) {
      score += 100;
      matchedIn.push("text");
    }
    if (qGrams.size > 0) {
      const nameGrams = bigrams(doc.name);
      let nameOverlap = 0;
      for (const g of qGrams) if (nameGrams.has(g)) nameOverlap++;
      let fuzzy = nameOverlap / qGrams.size * 60;
      if (text) {
        const textGrams = bigrams(text);
        let overlap = 0;
        for (const g of qGrams) if (textGrams.has(g)) overlap++;
        fuzzy += overlap / qGrams.size * 40;
      }
      if (fuzzy > 0) {
        score += fuzzy;
        if (matchedIn.length === 0) matchedIn.push("fuzzy");
      }
    }
    if (score > 8) {
      hits.push({ doc, score, snippets: snippetsAround(text, needle, 3, 60, !cjk), matchedIn });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
function kbStatus(cacheDir) {
  const manifest = loadManifest(cacheDir);
  if (!manifest) {
    return {
      ok: false,
      reason: `\u672C\u5730\u955C\u50CF\u4E0D\u5B58\u5728\u6216\u5DF2\u635F\u574F\uFF08${cacheDir}\uFF09\u3002\u5148\u8DD1\u4E00\u6B21 rcs_kb_sync\u3002`,
      total: 0,
      failed: 0,
      bytes: 0,
      sources: [],
      skippedByType: {}
    };
  }
  const docs = Object.values(manifest.docs);
  const failed = docs.filter((d) => d.error).length;
  return {
    ok: true,
    syncedAt: manifest.syncedAt,
    total: docs.length,
    failed,
    bytes: docs.reduce((n, d) => n + (d.bytes ?? 0), 0),
    sources: manifest.sources,
    skippedByType: manifest.skippedByType ?? {}
  };
}

// packages/rcs-core/src/team-context.ts
import { readFileSync as readFileSync3, existsSync as existsSync4 } from "node:fs";
import { join as join3 } from "node:path";

// packages/rcs-core/src/paths.ts
import { existsSync as existsSync3 } from "node:fs";
import { dirname, join as join2, resolve } from "node:path";
import { fileURLToPath } from "node:url";
function repoRootFrom(moduleUrl) {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..", "..");
}
var REPO_ROOT = repoRootFrom(import.meta.url);
var repoPaths = {
  config: () => join2(REPO_ROOT, "config"),
  teamConfig: () => join2(REPO_ROOT, "config", "team.json"),
  rulesRoot: () => join2(REPO_ROOT, "data", "rules"),
  kbCache: () => join2(REPO_ROOT, "data", "kb-cache")
};

// packages/rcs-core/src/team-context.ts
function loadTeamConfig(file) {
  if (!existsSync4(file)) {
    throw new Error(`\u961F\u5185\u914D\u7F6E\u4E0D\u5B58\u5728\uFF1A${file}
\u8BF7\u786E\u8BA4 config/team.json \u5B58\u5728\uFF0C\u6216\u4FEE\u6B63\u63D2\u4EF6\u7684 teamConfig \u8DEF\u5F84\u3002`);
  }
  const raw = JSON.parse(readFileSync3(file, "utf8"));
  if (!raw.season || !Array.isArray(raw.robots)) {
    throw new Error(`\u961F\u5185\u914D\u7F6E\u683C\u5F0F\u4E0D\u5BF9\uFF08\u7F3A season \u6216 robots\uFF09\uFF1A${file}`);
  }
  return raw;
}

// packages/dsh-rcs-kb/src/index.ts
var name = "rcs-kb";
var inject = ["tools"];
var Config = Schema.object({
  // 默认留空 —— 回落到本仓库的 config/team.json（见 rcs-core/paths.ts）。
  // 写死绝对路径在别人机器上一个都不存在，而且失败方式很难懂。
  teamConfig: Schema.string().default(""),
  cacheDir: Schema.string().default(""),
  appSecretEnv: Schema.string().default("FEISHU_APP_SECRET")
});
var DISCLAIMER = "\u5185\u5BB9\u6765\u81EA\u961F\u5185\u98DE\u4E66\u955C\u50CF\uFF0C\u53EF\u80FD\u843D\u540E\u4E8E\u7EBF\u4E0A\u7248\u672C\uFF1B\u5173\u952E\u7ED3\u8BBA\u8BF7\u56DE\u539F\u6587\u6838\u5BF9\u3002";
function callView(title, input) {
  return { card: "generic", title, kind: "search", rawInput: input };
}
function renderSync(r) {
  const s = r.stats;
  const head = `\u98DE\u4E66\u540C\u6B65\u5B8C\u6210 \u2014\u2014 \u904D\u5386 ${s.folders} \u4E2A\u76EE\u5F55
\u65B0\u589E ${s.added}  \u66F4\u65B0 ${s.updated}  \u672A\u53D8 ${s.unchanged}  \u5931\u8D25 ${s.failed}  \u5DF2\u5220\u9664 ${s.removed}`;
  const skipped = Object.entries(r.manifest.skippedByType);
  const skipLine = skipped.length > 0 ? `
\u6309\u7C7B\u578B\u8DF3\u8FC7\uFF1A${skipped.map(([k, n]) => `${k}\xD7${n}`).join("  ")}\uFF08\u89C1 sync.excludeTypes\uFF09` : "";
  const scope = `
\u6388\u6743\u8303\u56F4\uFF1A${r.manifest.sources.map((x) => x.label).join("\u3001")}`;
  let fail = "";
  if (r.failures.length > 0) {
    const lines = r.failures.slice(0, 10).map((f) => `  \xB7 ${f.path} \u2014\u2014 ${f.reason.slice(0, 120)}`);
    const more = r.failures.length > 10 ? `
  \u2026 \u53E6\u6709 ${r.failures.length - 10} \u6761` : "";
    fail = `

\u6293\u53D6\u5931\u8D25 ${r.failures.length} \u6761\uFF1A
${lines.join("\n")}${more}`;
  }
  let hint = "";
  if (r.permissionHint) {
    hint = `

\u26A0\uFE0F \u5931\u8D25\u539F\u56E0\u662F\u6743\u9650\u4E0D\u8DB3\u3002
   \u8981\u5F00\u901A\u7684\u6743\u9650\uFF1A${describeScopes(r.permissionHint.scopes)}
` + (r.permissionHint.authLink ? `   \u7533\u8BF7\u94FE\u63A5\uFF08\u5DF2\u6307\u5411\u53EA\u8BFB\u7248\uFF09\uFF1A${r.permissionHint.authLink}
` : "") + "   \u52FE\u5B8C\u9700\u53D1\u7248\u5E76\u7B49\u7BA1\u7406\u5458\u5BA1\u6279\u3002";
  }
  return `${head}${skipLine}${scope}${fail}${hint}

${DISCLAIMER}`;
}
function whyMatched(h) {
  const m = h.matchedIn ?? [];
  if (m.includes("name")) return "\u6807\u9898\u547D\u4E2D";
  if (m.includes("path")) return "\u76EE\u5F55\u540D\u547D\u4E2D";
  if (m.includes("text")) return "\u6B63\u6587\u547D\u4E2D";
  return "\u4EC5\u76F8\u5173\u5EA6\u5339\u914D\uFF0C\u672A\u51FA\u73B0\u539F\u8BCD";
}
function renderSearch(query, hits) {
  if (hits.length === 0) {
    return `\u672C\u5730\u955C\u50CF\u91CC\u6CA1\u6709\u68C0\u7D22\u5230\u4E0E\u300C${query}\u300D\u76F8\u5173\u7684\u5185\u5BB9\u3002
\u6CE8\u610F\uFF1A\u67E5\u4E0D\u5230\u53EF\u80FD\u662F**\u8FD8\u6CA1\u540C\u6B65**\u6216**\u4E0D\u5728\u6388\u6743\u8303\u56F4\u5185**\uFF0C\u4E0D\u4EE3\u8868\u961F\u91CC\u6CA1\u6709\u8FD9\u4EFD\u8D44\u6599\u3002
\u53EF\u4EE5\u5148\u7528 rcs_kb_status \u770B\u955C\u50CF\u72B6\u6001\u3002`;
  }
  const body = hits.map((h) => {
    const head = `[${h.doc.path}]`;
    const snips = h.snippets.length > 0 ? h.snippets.map((s) => `    ${s}`).join("\n") : `    \uFF08${whyMatched(h)}\uFF0C\u6B63\u6587\u65E0\u76F4\u63A5\u547D\u4E2D\uFF09`;
    const link = h.doc.url ? `
    \u539F\u6587\uFF1A${h.doc.url}` : "";
    return `${head}
${snips}${link}`;
  }).join("\n\n");
  return `\u68C0\u7D22\u300C${query}\u300D\uFF0C\u547D\u4E2D ${hits.length} \u7BC7\uFF1A

${body}

${DISCLAIMER}`;
}
function renderStatus(s) {
  if (!s.ok) return `\u955C\u50CF\u4E0D\u53EF\u7528\uFF1A${s.reason}`;
  const kb = (s.bytes / 1024).toFixed(1);
  const skipped = Object.entries(s.skippedByType);
  return `\u672C\u5730\u955C\u50CF\u72B6\u6001
\u6700\u540E\u540C\u6B65\uFF1A${s.syncedAt}
\u6587\u6863 ${s.total} \u7BC7\uFF08\u5176\u4E2D ${s.failed} \u7BC7\u6293\u53D6\u5931\u8D25\uFF09  \u6B63\u6587\u5408\u8BA1 ${kb} KB
\u6388\u6743\u8303\u56F4\uFF1A${s.sources.map((x) => x.label).join("\u3001")}
` + (skipped.length > 0 ? `\u6309\u7C7B\u578B\u8DF3\u8FC7\uFF1A${skipped.map(([k, n]) => `${k}\xD7${n}`).join("  ")}
` : "") + `
\u68C0\u7D22\u8D70\u672C\u5730\u955C\u50CF\uFF0C\u4E0D\u8054\u7F51 \u2014\u2014 \u8D5B\u573A\u65AD\u7F51\u65F6\u4F9D\u7136\u53EF\u7528\u3002`;
}
function isSearchMeta(v) {
  return typeof v === "object" && v !== null && v.kind === "rcs-kb-search" && Array.isArray(v.hits);
}
function searchResultView(result) {
  const meta = result.meta;
  if (!isSearchMeta(meta)) return void 0;
  if (meta.hits.length === 0) {
    return { card: "generic", title: `\u77E5\u8BC6\u5E93\u68C0\u7D22\u300C${meta.query}\u300D\u2014 \u65E0\u547D\u4E2D` };
  }
  return {
    card: "search",
    shape: "matches",
    title: `\u77E5\u8BC6\u5E93\u68C0\u7D22\u300C${meta.query}\u300D\u2014 ${meta.hits.length} \u7BC7`,
    files: meta.hits.map((h) => ({
      path: h.path,
      matches: h.snippets.map((line, i) => ({ lineNumber: i + 1, line }))
    })),
    truncated: false,
    total: meta.hits.length
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
  const feishuConfig = () => {
    const fromCore = shared(ctx)?.feishu;
    if (fromCore) return fromCore;
    const teamFile = config.teamConfig || repoPaths.teamConfig();
    const team = loadTeamConfig(teamFile);
    if (!team.feishu) {
      throw new Error(
        `${teamFile} \u91CC\u6CA1\u6709 feishu \u914D\u7F6E\u6BB5\u3002
\u9700\u8981 appId\u3001appSecretEnv\u3001sources\u3001cacheDir \u2014\u2014 \u89C1 feishu-setup.md\u3002`
      );
    }
    return team.feishu;
  };
  const cacheDir = () => config.cacheDir || shared(ctx)?.kbCacheDir || feishuConfig().cacheDir || repoPaths.kbCache();
  const policyOf = (fc) => ({ ...DEFAULT_SYNC_POLICY, ...fc.sync ?? {} });
  ctx.tools.register(
    defineTool({
      name: "rcs_kb_search",
      description: "\u68C0\u7D22\u961F\u5185\u98DE\u4E66\u8D44\u6599\u7684**\u672C\u5730\u955C\u50CF**\uFF08\u7535\u63A7\u7EC4\u6587\u6863\u3001\u5386\u5E74\u6280\u672F\u79EF\u7D2F\u3001\u57F9\u8BAD\u8D44\u6599\u7B49\uFF09\u3002\u5B8C\u5168\u79BB\u7EBF\uFF0C\u4E0D\u8054\u7F51 \u2014\u2014 \u8D5B\u573A\u65AD\u7F51\u65F6\u7167\u6837\u80FD\u7528\u3002\u67E5\u4E0D\u5230\u65F6\u8981\u6CE8\u610F\u533A\u5206\u300C\u955C\u50CF\u91CC\u6CA1\u6709\u300D\u548C\u300C\u961F\u91CC\u6CA1\u6709\u300D\uFF1A\u524D\u8005\u53EF\u80FD\u53EA\u662F\u8FD8\u6CA1\u540C\u6B65\u3002",
      parameters: {
        query: { type: "string", required: true, description: "\u68C0\u7D22\u5173\u952E\u8BCD\uFF0C\u652F\u6301\u4E2D\u6587" },
        limit: { type: "number", description: "\u8FD4\u56DE\u6761\u6570\u4E0A\u9650\uFF0C\u9ED8\u8BA4 8" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "\u68C0\u7D22\u8BCD" },
            hits: { type: "json", description: "\u547D\u4E2D\u7684\u6587\u6863\u4E0E\u7247\u6BB5" }
          }
        },
        render: (_args, value) => {
          const v = value;
          return [{ type: "text", text: renderSearch(v.query ?? "", v.hits ?? []) }];
        },
        presentationMeta: (_args, value) => {
          const v = value;
          const meta = {
            kind: "rcs-kb-search",
            query: v.query ?? "",
            hits: (v.hits ?? []).map((h) => ({
              path: h.doc.path,
              snippets: h.snippets.length > 0 ? h.snippets : [h.doc.name]
            }))
          };
          return meta;
        }
      },
      presentCall: (args) => callView("\u68C0\u7D22\u961F\u5185\u8D44\u6599", args.query),
      presentResult: (_args, result) => searchResultView(result),
      async execute(args) {
        const hits = searchKb(cacheDir(), args.query, args.limit ?? 8);
        return { query: args.query, hits };
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "rcs_kb_status",
      description: "\u67E5\u770B\u672C\u5730\u98DE\u4E66\u955C\u50CF\u7684\u72B6\u6001\uFF1A\u4E0A\u6B21\u540C\u6B65\u65F6\u95F4\u3001\u6587\u6863\u6570\u3001\u6388\u6743\u8303\u56F4\u3001\u6309\u7C7B\u578B\u8DF3\u8FC7\u7684\u6570\u91CF\u3002\u68C0\u7D22\u67E5\u4E0D\u5230\u4E1C\u897F\u65F6\u5148\u770B\u8FD9\u4E2A \u2014\u2014 \u533A\u5206\u300C\u6CA1\u540C\u6B65\u300D\u548C\u300C\u771F\u6CA1\u6709\u300D\u3002",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", description: "\u955C\u50CF\u662F\u5426\u53EF\u7528" },
            total: { type: "number", description: "\u6587\u6863\u6570" },
            syncedAt: { type: "string", description: "\u4E0A\u6B21\u540C\u6B65\u65F6\u95F4" }
          }
        },
        render: (_args, value) => [{ type: "text", text: renderStatus(value) }]
      },
      presentCall: () => callView("\u67E5\u770B\u955C\u50CF\u72B6\u6001", cacheDirSafe()),
      async execute() {
        return kbStatus(cacheDir());
      }
    })
  );
  function cacheDirSafe() {
    try {
      return cacheDir();
    } catch {
      return "(\u672A\u914D\u7F6E)";
    }
  }
  ctx.tools.register(
    defineTool({
      name: "rcs_kb_sync",
      description: "\u628A\u961F\u5185\u98DE\u4E66\u8D44\u6599\u540C\u6B65\u5230\u672C\u5730\u955C\u50CF\u3002**\u8054\u7F51 + \u5199\u76D8**\uFF0C\u5C5E L1 \u64CD\u4F5C\uFF0C\u8D5B\u573A\u6A21\u5F0F\u7981\u6B62\u3002\u53EA\u904D\u5386 config/team.json \u91CC feishu.sources \u5217\u51FA\u7684\u76EE\u5F55\u5B50\u6811 \u2014\u2014 \u90A3\u4EFD\u6E05\u5355\u5C31\u662F\u6388\u6743\u8303\u56F4\u3002\u589E\u91CF\u540C\u6B65\uFF1A\u6587\u6863\u6CA1\u6539\u8FC7\u5C31\u4E0D\u91CD\u6293\u3002",
      parameters: {
        force: { type: "boolean", description: "\u5FFD\u7565\u589E\u91CF\u5224\u65AD\uFF0C\u5168\u91CF\u91CD\u6293" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            stats: { type: "json", description: "\u65B0\u589E/\u66F4\u65B0/\u672A\u53D8/\u5931\u8D25\u8BA1\u6570" },
            failures: { type: "json", description: "\u6293\u53D6\u5931\u8D25\u7684\u6761\u76EE" }
          }
        },
        render: (_args, value) => [{ type: "text", text: renderSync(value) }]
      },
      presentCall: (args) => callView("\u540C\u6B65\u98DE\u4E66\u8D44\u6599", args.force ? "\u5168\u91CF" : "\u589E\u91CF"),
      async execute(args) {
        const fc = feishuConfig();
        const secretEnv = fc.appSecretEnv || config.appSecretEnv;
        const secret = process.env[secretEnv];
        if (!secret) {
          throw new Error(
            `\u73AF\u5883\u53D8\u91CF ${secretEnv} \u6CA1\u6709\u503C\uFF0C\u62FF\u4E0D\u5230 app_secret\u3002
\u5BC6\u94A5\u53EA\u4ECE\u73AF\u5883\u53D8\u91CF\u8BFB \u2014\u2014 \u4E0D\u653E\u914D\u7F6E\u6587\u4EF6\uFF08\u4F1A\u8FDB git\uFF09\u3001\u4E0D\u8D70\u547D\u4EE4\u884C\u53C2\u6570\uFF08\u4F1A\u8FDB shell \u5386\u53F2\uFF09\u3002
\u521A\u8BBE\u8FC7\u73AF\u5883\u53D8\u91CF\u7684\u8BDD\uFF0C\u8981\u91CD\u5F00\u7EC8\u7AEF\u624D\u751F\u6548\u3002`
          );
        }
        const sources = fc.sources ?? [];
        const client = new HttpFeishuClient(
          { appId: fc.appId, appSecret: secret },
          { minIntervalMs: fc.minIntervalMs }
        );
        try {
          return await syncKnowledgeBase({
            client,
            sources,
            policy: policyOf(fc),
            cacheDir: cacheDir(),
            force: args.force === true
          });
        } catch (e) {
          if (e instanceof FeishuPermissionError) {
            throw new Error(
              `\u98DE\u4E66\u6743\u9650\u4E0D\u8DB3\u3002\u8981\u5F00\u901A\u7684\u6743\u9650\uFF1A${e.scopeAdvice}
` + (e.authLink ? `\u7533\u8BF7\u94FE\u63A5\uFF08\u5DF2\u6307\u5411\u53EA\u8BFB\u7248\uFF09\uFF1A${e.authLink}
` : "") + "\u52FE\u5B8C\u9700\u53D1\u7248\u5E76\u7B49\u7BA1\u7406\u5458\u5BA1\u6279\u3002\u8DD1 npm run feishu:check \u53EF\u590D\u67E5\u3002"
            );
          }
          throw e;
        }
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
