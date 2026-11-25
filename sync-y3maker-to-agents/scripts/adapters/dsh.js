/**
 * DSH（DeepSeek Harness）宿主适配层占位实现（由 Ticket #6 替换为完整 cordis.patch.yml YAML 合并与 --patch 提示逻辑）。
 */
function buildInitialMcpReport(ctx) {
  if (!ctx.legacyMcp || !ctx.legacyMcp.exists) {
    return null;
  }
  if (ctx.mcpScope === "skip") {
    return {
      scope: "skip",
      target: null,
      converted: false,
      servers: [],
      skipped: ["mcp_settings.json"],
      empty: ctx.legacyMcp.empty,
      warnings: [],
      hints: [],
    };
  }
  return {
    scope: ctx.mcpScope,
    target: null,
    converted: false,
    servers: [],
    skipped: [],
    empty: ctx.legacyMcp.empty,
    warnings: [],
    hints: [],
  };
}

module.exports = {
  id: "dsh",
  aliases: [],
  displayName: "DSH",

  planTarget(ctx) {
    return {
      filePlans: [],
      mcpReport: buildInitialMcpReport(ctx),
      extraCreatedDirs: [],
    };
  },

  verifyTarget(_ctx) {
    return [];
  },
};
