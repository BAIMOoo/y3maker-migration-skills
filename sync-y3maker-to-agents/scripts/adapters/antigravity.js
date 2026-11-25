/**
 * Antigravity（agy）宿主适配层占位实现（由 Ticket #5 替换为完整插件生成、全局合并与 SSE 跳过逻辑）。
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
  id: "antigravity",
  aliases: ["agy"],
  displayName: "Antigravity",

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
