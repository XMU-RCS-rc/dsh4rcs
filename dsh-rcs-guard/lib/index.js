// packages/dsh-rcs-guard/src/index.ts
import Schema from "@deepseek-ai/schemastery";

// packages/rcs-core/src/danger.ts
var DEFAULT_DANGER_RULES = [
  // ---- L2 物理动作 ----
  { tool: "rcs_fw_flash", level: "L2", reason: "\u70E7\u5F55\u4F1A\u6539\u5199\u8FD0\u884C\u4E2D\u7684\u56FA\u4EF6" },
  { tool: "rcs_motor_enable", level: "L2", reason: "\u7535\u673A\u4F7F\u80FD\u4F1A\u8BA9\u673A\u6784\u7ACB\u5373\u8FD0\u52A8" },
  { tool: "rcs_pneumatic_fire", level: "L2", reason: "\u6C14\u8DEF\u52A8\u4F5C \u2014\u2014 600kPa \u4E0B\u6C14\u7F38\u77AC\u95F4\u4F38\u51FA\uFF0C\u884C\u7A0B\u5185\u6709\u624B\u4F1A\u5939\u4F24" },
  { tool: "rcs_bus_write", level: "L2", reason: "\u603B\u7EBF\u4E0B\u53D1\u63A7\u5236\u6307\u4EE4\u4F1A\u76F4\u63A5\u9A71\u52A8\u6267\u884C\u5668" },
  { tool: "rcs_serial_write", level: "L2", reason: "\u4E32\u53E3\u4E0B\u53D1\u53EF\u80FD\u89E6\u53D1\u4E0B\u4F4D\u673A\u52A8\u4F5C" },
  // ---- L1 本机写 ----
  { tool: "rcs_fw_build", level: "L1", reason: "\u6784\u5EFA\u4F1A\u6539\u5199\u4EA7\u7269\u76EE\u5F55" },
  {
    tool: "rcs_kb_sync",
    level: "L1",
    reason: "\u540C\u6B65\u4F1A\u8054\u7F51\u62C9\u53D6\u961F\u5185\u98DE\u4E66\u6587\u6863\u5E76\u5199\u5165\u672C\u5730\u955C\u50CF \u2014\u2014 \u65E2\u51FA\u7F51\u53C8\u843D\u76D8\u3002\u8D5B\u573A\u4E0A\u7981\u6B62\uFF1A\u7F51\u7EDC\u4E0D\u53EF\u9760\uFF0C\u4E14\u8D5B\u573A\u53EA\u8BE5\u67E5\u5DF2\u6709\u955C\u50CF\uFF0C\u4E0D\u8BE5\u6539\u5B83"
  },
  { tool: "rcs_support_test", level: "L1", reason: "\u4F1A\u5728\u672C\u673A\u8FD0\u884C\u6D4B\u8BD5\u8FDB\u7A0B" },
  { tool: "rcs_serial_monitor", level: "L1", reason: "\u4F1A\u5360\u7528\u4E32\u53E3\u8BBE\u5907" },
  { tool: "rcs_sim_launch", level: "L1", reason: "\u4F1A\u62C9\u8D77\u4EFF\u771F\u8FDB\u7A0B" }
];
function levelOf(tool, config) {
  if (config.extraL2?.includes(tool)) return "L2";
  return config.rules.find((r) => r.tool === tool)?.level ?? "L0";
}
function reasonOf(tool, config) {
  if (config.extraL2?.includes(tool)) return "\u961F\u5185\u81EA\u5B9A\u4E49\u7684\u9AD8\u5371\u5DE5\u5177";
  return config.rules.find((r) => r.tool === tool)?.reason ?? "\u672A\u767B\u8BB0\u7684\u9AD8\u5371\u64CD\u4F5C";
}
function decide(tool, config) {
  const level = levelOf(tool, config);
  if (level === "L0") return { kind: "allow" };
  const why = reasonOf(tool, config);
  if (config.mode === "field") {
    return {
      kind: "deny",
      reason: `\u8D5B\u573A\u6A21\u5F0F\u7981\u6B62 ${level} \u64CD\u4F5C\uFF1A${tool} \u2014\u2014 ${why}\u3002\u8D5B\u573A\u4E0A Agent \u53EA\u80FD\u67E5\uFF0C\u4E0D\u80FD\u6539\u3001\u4E0D\u80FD\u70E7\u5F55\u3001\u4E0D\u80FD\u52A8\u6C14\u8DEF\u3002`
    };
  }
  if (level === "L2") {
    return {
      kind: "ask",
      reason: `${tool} \u662F\u7269\u7406\u52A8\u4F5C\uFF1A${why}\u3002\u6267\u884C\u524D\u8BF7\u786E\u8BA4\u5468\u56F4\u65E0\u4EBA\u3001\u673A\u6784\u884C\u7A0B\u5185\u65E0\u624B\u3001\u6C14\u8DEF\u5DF2\u6CC4\u538B\u3002\u6CE8\u610F\uFF1A\u8F6F\u4EF6\u505C\u6B62\u4E0D\u80FD\u66FF\u4EE3\u786C\u4EF6\u6025\u505C\u3001\u9A71\u52A8\u4F7F\u80FD\u7EBF\u548C\u9650\u4F4D\u4FDD\u62A4\u3002`
    };
  }
  return { kind: "allow" };
}
function fieldGuard(tool, config) {
  if (config.mode !== "field") return void 0;
  const level = levelOf(tool, config);
  if (level === "L0") return void 0;
  return `\u8D5B\u573A\u6A21\u5F0F\uFF1A${tool}\uFF08${level}\uFF09\u5DF2\u88AB\u786C\u6027\u963B\u6B62 \u2014\u2014 ${reasonOf(tool, config)}`;
}

// packages/dsh-rcs-guard/src/index.ts
var name = "rcs-guard";
var inject = ["tools"];
var Config = Schema.object({
  mode: Schema.union(["dev", "field"]).default("dev"),
  extraL2: Schema.array(Schema.string()).default([])
});
function apply(ctx, config) {
  const guardConfig = {
    mode: config.mode,
    rules: DEFAULT_DANGER_RULES,
    extraL2: config.extraL2
  };
  ctx.on(
    "tools/pre-execute",
    async (exec, next) => {
      const d = decide(exec.name, guardConfig);
      if (d.kind === "allow") return next();
      return d;
    }
  );
  if (config.mode === "field") {
    ctx.tools.guard((exec) => fieldGuard(exec.name, guardConfig));
  }
  const l2 = DEFAULT_DANGER_RULES.filter((r) => levelOf(r.tool, guardConfig) === "L2").map(
    (r) => r.tool
  );
  const banner = config.mode === "field" ? `[rcs-guard] \u8D5B\u573A\u6A21\u5F0F\uFF1A\u6240\u6709 L1/L2 \u5DE5\u5177\u4E00\u5F8B\u62D2\u7EDD\uFF08\u542B ${l2.length} \u4E2A\u7269\u7406\u52A8\u4F5C\u5DE5\u5177\uFF09` : `[rcs-guard] \u5F00\u53D1\u6A21\u5F0F\uFF1A${l2.length} \u4E2A\u7269\u7406\u52A8\u4F5C\u5DE5\u5177\u9700\u4EBA\u5DE5\u786E\u8BA4 \u2014\u2014 ${l2.join(", ")}`;
  console.info(banner);
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
