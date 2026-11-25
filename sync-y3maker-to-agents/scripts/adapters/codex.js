/**
 * Codex 宿主适配层占位实现（由 Ticket #4 替换为完整安全 TOML 区块合并与验收逻辑）。
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
  id: "codex",
  aliases: [],
  displayName: "Codex",

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
