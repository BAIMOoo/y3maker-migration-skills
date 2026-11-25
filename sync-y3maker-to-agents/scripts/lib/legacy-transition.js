/**
 * 旧版迁移过渡检测占位模块（由 Ticket #7 替换为完整的只读扫描逻辑）。
 * 保持只读约定：绝不修改或删除任何历史 .codex/ 或 .claude/ 目录。
 */
function detectLegacyTransitions(_workspace, _options = {}) {
  return {
    detected: false,
    legacyMigrations: [],
  };
}

module.exports = {
  detectLegacyTransitions,
};
