/**
 * CLI 参数解析与 JSON 输出辅助模块（供 run-migration.js 与 verify-migration.js 共享）。
 */
const { normalizeTargets } = require("../adapters");
const { MCP_SCOPES } = require("./constants");

function emitJson(payload, pretty) {
  const text = JSON.stringify(payload, null, pretty ? 2 : 0);
  process.stdout.write(`${text}\n`);
}

function requireNextValue(tokens, index, flagName) {
  const value = tokens[index + 1];
  if (value === undefined) {
    throw new Error(`参数 ${flagName} 缺少取值`);
  }
  return value;
}

function parseCommonCliOptions(tokens, config = {}) {
  const allowDryRun = Boolean(config.allowDryRun);
  const options = {
    workspace: ".",
    pretty: false,
    allowUnsafeWorkspace: false,
    targets: null,
    mcpScope: null,
  };
  if (allowDryRun) {
    options.dryRun = false;
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--workspace") {
      options.workspace = requireNextValue(tokens, index, "--workspace");
      index += 1;
    } else if (allowDryRun && token === "--dry-run") {
      options.dryRun = true;
    } else if (token === "--pretty") {
      options.pretty = true;
    } else if (token === "--allow-unsafe-workspace") {
      options.allowUnsafeWorkspace = true;
    } else if (token === "--targets") {
      options.targets = requireNextValue(tokens, index, "--targets");
      index += 1;
    } else if (token === "--mcp-scope") {
      options.mcpScope = requireNextValue(tokens, index, "--mcp-scope");
      index += 1;
    } else {
      throw new Error(`未知参数：${token}`);
    }
  }

  if (options.mcpScope !== null && !MCP_SCOPES.has(options.mcpScope)) {
    throw new Error(`无效的 --mcp-scope：${options.mcpScope}。可选值：project、user 或 skip。`);
  }
  if (options.targets !== null) {
    options.targets = normalizeTargets(options.targets);
  }
  return options;
}

module.exports = {
  emitJson,
  parseCommonCliOptions,
  requireNextValue,
};
