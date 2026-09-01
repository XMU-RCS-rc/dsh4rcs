// packages/dsh-rcs-core/src/index.ts
import { Service } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

// packages/rcs-core/src/team-context.ts
import { readFileSync, existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";

// packages/rcs-core/src/paths.ts
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
function repoRootFrom(moduleUrl) {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..", "..");
}
var REPO_ROOT = repoRootFrom(import.meta.url);
var repoPaths = {
  config: () => join(REPO_ROOT, "config"),
  teamConfig: () => join(REPO_ROOT, "config", "team.json"),
  rulesRoot: () => join(REPO_ROOT, "data", "rules"),
  kbCache: () => join(REPO_ROOT, "data", "kb-cache")
};
function looksLikeFirmwareRepo(dir) {
  if (!existsSync(dir)) return false;
  const marks = ["template", "demo", "upper_host_cli", "R2"];
  return marks.filter((m) => existsSync(join(dir, m))).length >= 2;
}
function resolveFirmwareRoot(options = {}) {
  const env = options.env ?? process.env;
  const root = options.repoRoot ?? REPO_ROOT;
  const tried = [];
  const candidates = [
    ["\u5DE5\u5177\u53C2\u6570/ \u63D2\u4EF6\u914D\u7F6E", options.explicit],
    ["config/team.json \u7684 firmware.repo", options.fromTeamConfig],
    ["\u73AF\u5883\u53D8\u91CF RCS_CODE_ROOT", env["RCS_CODE_ROOT"]],
    ["\u73AF\u5883\u53D8\u91CF RCS_HOME", env["RCS_HOME"] ? join(env["RCS_HOME"], "RCS_code") : void 0],
    ["\u4E0E\u672C\u4ED3\u5E93\u540C\u7EA7\u7684 ../RCS_code", join(root, "..", "RCS_code")]
  ];
  for (const [from, value] of candidates) {
    if (!value) continue;
    const abs = resolve(value);
    tried.push(`${from}: ${abs}`);
    const explicitish = from.startsWith("\u5DE5\u5177\u53C2\u6570") || from.startsWith("config/team.json") || from.startsWith("\u73AF\u5883\u53D8\u91CF");
    if (explicitish ? existsSync(abs) : looksLikeFirmwareRepo(abs)) {
      return { ok: true, root: abs, from };
    }
  }
  return { ok: false, tried };
}

// packages/rcs-core/src/team-context.ts
function loadTeamConfig(file) {
  if (!existsSync2(file)) {
    throw new Error(`\u961F\u5185\u914D\u7F6E\u4E0D\u5B58\u5728\uFF1A${file}
\u8BF7\u786E\u8BA4 config/team.json \u5B58\u5728\uFF0C\u6216\u4FEE\u6B63\u63D2\u4EF6\u7684 teamConfig \u8DEF\u5F84\u3002`);
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!raw.season || !Array.isArray(raw.robots)) {
    throw new Error(`\u961F\u5185\u914D\u7F6E\u683C\u5F0F\u4E0D\u5BF9\uFF08\u7F3A season \u6216 robots\uFF09\uFF1A${file}`);
  }
  return raw;
}
function layerOfPath(file, layers) {
  const normalized = file.replace(/\\/g, "/");
  for (const l of [...layers].sort((a, b) => b.length - a.length)) {
    if (normalized.includes(`/${l}/`) || normalized.startsWith(`${l}/`) || normalized.endsWith(`/${l}`)) {
      return l;
    }
  }
  return void 0;
}
function daysUntil(m, today) {
  if (!m.date) return null;
  const target = /* @__PURE__ */ new Date(`${m.date}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return null;
  const day = 24 * 60 * 60 * 1e3;
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target.getTime() - t0) / day);
}
function nextMilestone(ms, today) {
  return ms.filter((m) => !m.done && m.date !== null).filter((m) => (daysUntil(m, today) ?? -1) >= 0).sort((a, b) => (daysUntil(a, today) ?? 0) - (daysUntil(b, today) ?? 0))[0];
}
var TeamContext = class _TeamContext {
  config;
  configFile;
  constructor(config, configFile) {
    this.config = config;
    this.configFile = configFile;
  }
  static fromFile(file) {
    return new _TeamContext(loadTeamConfig(file), file);
  }
  get season() {
    return this.config.season;
  }
  get theme() {
    return this.config.theme;
  }
  /**
   * 固件仓库根目录。
   *
   * `config/team.json` 里的 `firmware.repo` **默认留空** —— 写死绝对路径
   * 在别人机器上不存在。留空时走 `paths.ts` 的解析链（环境变量 → 同级发现）。
   *
   * 解析不到返回空串而**不抛异常**：这个 getter 会被呈现钩子间接调用，
   * 按契约不得抛。需要硬失败的调用方（如 rcs_lint_layer）自己调
   * `resolveFirmwareRoot` 并在失败时给出「找过哪些路径」的完整报错。
   */
  get projectRoot() {
    const configured = this.config.firmware.repo;
    const r = resolveFirmwareRoot(configured ? { explicit: configured } : {});
    return r.ok ? r.root : "";
  }
  get templateRoot() {
    const root = this.projectRoot;
    return root ? join2(root, this.config.firmware.template) : "";
  }
  /** 规则数据根目录。留空时回落到本仓库的 `data/rules`。 */
  get rulesRoot() {
    return this.config.rules.root || repoPaths.rulesRoot();
  }
  get rulesVersion() {
    return this.config.rules.currentVersion;
  }
  get feishu() {
    return this.config.feishu;
  }
  /** 知识库镜像目录。留空时回落到本仓库的 `data/kb-cache`。 */
  get kbCacheDir() {
    return this.config.feishu?.cacheDir || repoPaths.kbCache();
  }
  /** 按 id 找机器人。大小写不敏感。 */
  robot(id) {
    const key = id.trim().toUpperCase();
    return this.config.robots.find((r) => r.id.toUpperCase() === key);
  }
  /** 某台机器人是否允许进入某区域。 */
  mayEnter(robotId, zone) {
    const r = this.robot(robotId);
    return r ? r.zones.includes(zone) : void 0;
  }
  /** 文件属于哪一工程层次。 */
  layerOf(file) {
    return layerOfPath(file, this.config.firmware.layers);
  }
  /** 赛季倒计时。today 显式传入，便于测试。 */
  countdown(today) {
    return this.config.milestones.filter((m) => !m.done && m.date !== null).map((m) => ({ milestone: m, days: daysUntil(m, today) ?? 0 })).sort((a, b) => a.days - b.days);
  }
  /** 一句话摘要，给模型当上下文用。 */
  summary(today) {
    const next = nextMilestone(this.config.milestones, today);
    const theme = this.theme ?? "\uFF08\u4E3B\u9898\u5F85\u516C\u5E03\uFF09";
    const nextText = next ? `\u4E0B\u4E00\u4E2A\u8282\u70B9\uFF1A${next.label}\uFF08${daysUntil(next, today)} \u5929\u540E\uFF09` : "\u6682\u65E0\u5DF2\u6392\u671F\u7684\u4E0B\u4E00\u4E2A\u8282\u70B9";
    return [
      `${this.config.team} \xB7 ${this.config.season} \u8D5B\u5B63 \xB7 ${this.config.event}`,
      `\u4E3B\u9898\uFF1A${theme}`,
      `\u89C4\u5219\u7248\u672C\uFF1A${this.rulesVersion}`,
      `\u673A\u5668\u4EBA\uFF1A${this.config.robots.map((r) => `${r.id}(${r.name}, ${r.autonomy})`).join("\u3001")}`,
      `\u56FA\u4EF6\uFF1A${this.config.firmware.mcu} / ${this.config.firmware.framework} / ${this.config.firmware.rtos}`,
      nextText
    ].join("\n");
  }
};

// packages/dsh-rcs-core/src/index.ts
var name = "rcs-core";
var Config = Schema.object({
  // 默认留空：写死绝对路径在别人机器上一个都不存在。留空时回落到
  // 本仓库内的 config/team.json（由 repoPaths 从模块位置推出）。
  teamConfig: Schema.string().default("")
});
var RcsService = class extends Service {
  team;
  constructor(ctx, config) {
    super(ctx, "rcs");
    this.team = TeamContext.fromFile(config.teamConfig || repoPaths.teamConfig());
  }
  get season() {
    return this.team.season;
  }
  get theme() {
    return this.team.theme;
  }
  get projectRoot() {
    return this.team.projectRoot;
  }
  get templateRoot() {
    return this.team.templateRoot;
  }
  get rulesRoot() {
    return this.team.rulesRoot;
  }
  get rulesVersion() {
    return this.team.rulesVersion;
  }
  get config() {
    return this.team.config;
  }
  robot(id) {
    return this.team.robot(id);
  }
  mayEnter(robotId, zone) {
    return this.team.mayEnter(robotId, zone);
  }
  layerOf(file) {
    return this.team.layerOf(file);
  }
  countdown(today) {
    return this.team.countdown(today);
  }
  summary(today) {
    return this.team.summary(today);
  }
};
function callView(title) {
  return { card: "generic", title, kind: "read" };
}
function apply(ctx, config) {
  ctx.plugin(RcsService, config);
  ctx.inject(["tools"], (scoped) => {
    scoped.tools.register(
      defineTool({
        name: "rcs_team_context",
        description: '\u67E5\u8BE2 RCS \u961F\u5185\u4E0A\u4E0B\u6587\uFF1A\u5F53\u524D\u8D5B\u5B63\u3001\u4E3B\u9898\u3001\u89C4\u5219\u7248\u672C\u3001\u673A\u5668\u4EBA\u89D2\u8272\u4E0E\u533A\u57DF\u9650\u5236\u3001\u56FA\u4EF6\u6280\u672F\u6808\u3001\u8D5B\u5B63\u5012\u8BA1\u65F6\u3002\u56DE\u7B54"\u6211\u4EEC\u73B0\u5728\u6253\u4EC0\u4E48\u6BD4\u8D5B/\u4EC0\u4E48\u4E3B\u9898/\u8FD8\u6709\u591A\u4E45"\u8FD9\u7C7B\u95EE\u9898\u65F6\u5148\u8C03\u5B83\u3002',
        parameters: {
          robot: {
            type: "string",
            description: "\u53EA\u770B\u67D0\u53F0\u673A\u5668\u4EBA\uFF08TR \u6216 BR\uFF09\u7684\u89D2\u8272\u4E0E\u9650\u5236\uFF0C\u7701\u7565\u5219\u8FD4\u56DE\u5168\u90E8\u4E0A\u4E0B\u6587"
          }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string", description: "\u4EBA\u7C7B\u53EF\u8BFB\u6458\u8981" },
              season: { type: "string", description: "\u8D5B\u5B63" },
              theme: { type: "string", description: "\u4E3B\u9898\uFF1B\u672A\u516C\u5E03\u65F6\u4E3A\u7A7A\u4E32" },
              rulesVersion: { type: "string", description: "\u5F53\u524D\u89C4\u5219\u7248\u672C" },
              robots: { type: "json", description: "\u673A\u5668\u4EBA\u89D2\u8272\u4E0E\u533A\u57DF\u9650\u5236" },
              countdown: { type: "json", description: "\u8D5B\u5B63\u5012\u8BA1\u65F6" },
              firmware: { type: "json", description: "\u56FA\u4EF6\u6280\u672F\u6808" }
            }
          },
          render: (_args, value) => [{ type: "text", text: value.summary ?? "" }]
        },
        presentCall: () => callView("\u67E5\u8BE2\u961F\u5185\u4E0A\u4E0B\u6587"),
        async execute(args, exec) {
          const today = /* @__PURE__ */ new Date();
          const rcs = scoped.rcs;
          const robots = args.robot ? [rcs.robot(args.robot)].filter((r) => r !== void 0) : rcs.config.robots;
          const countdown = rcs.countdown(today).map((c) => ({
            id: c.milestone.id,
            label: c.milestone.label,
            date: c.milestone.date,
            days: c.days
          }));
          const lines = [rcs.summary(today)];
          if (args.robot) {
            const r = robots[0];
            lines.push(
              r ? `
${r.id}\uFF08${r.name}\uFF09\uFF1A${r.autonomy}\uFF0C\u53EF\u8FDB\u5165 ${r.zones.join("/")}\uFF0C\u540C\u65F6\u6700\u591A\u643A\u5E26 ${r.carryLimit} \u4E2A\uFF08\u6761\u6B3E ${r.clause}\uFF09` : `
\u6CA1\u6709\u627E\u5230\u673A\u5668\u4EBA\u300C${args.robot}\u300D\uFF0C\u672C\u5C4A\u53EA\u6709 TR \u4E0E BR\u3002`
            );
          }
          const next = countdown[0];
          if (next) lines.push(`
\u6700\u8FD1\u8282\u70B9\uFF1A${next.label} \u2014\u2014 ${next.days} \u5929\u540E\uFF08${next.date}\uFF09`);
          void exec;
          return {
            summary: lines.join("\n"),
            season: rcs.season,
            theme: rcs.theme ?? "",
            rulesVersion: rcs.rulesVersion,
            robots,
            countdown,
            firmware: rcs.config.firmware
          };
        }
      })
    );
  });
  ctx.effect(() => {
    void daysUntil;
    return () => {
    };
  });
}
export {
  Config,
  RcsService,
  apply,
  name
};
//# sourceMappingURL=index.js.map
