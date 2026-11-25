#!/usr/bin/env node

const path = require("path");

const { normalizeTargets } = require("./adapters");
const { MCP_SCOPES } = require("./lib/constants");
const { assertSafeWorkspace } = require("./lib/fs-utils");
const { verifyWorkspace } = require("./lib/verifier");

function requireNextValue(tokens, index, flagName) {
  const value = tokens[index + 1];
  if (value === undefined) {
    throw new Error(`参数 ${flagName} 缺少取值`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    workspace: ".",
    pretty: false,
    allowUnsafeWorkspace: false,
    targets: null,
    mcpScope: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--workspace") {
      options.workspace = requireNextValue(argv, index, "--workspace");
      index += 1;
    } else if (token === "--pretty") {
      options.pretty = true;
    } else if (token === "--allow-unsafe-workspace") {
      options.allowUnsafeWorkspace = true;
    } else if (token === "--targets") {
      options.targets = requireNextValue(argv, index, "--targets");
      index += 1;
    } else if (token === "--mcp-scope") {
      options.mcpScope = requireNextValue(argv, index, "--mcp-scope");
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

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const workspace = path.resolve(options.workspace);
    assertSafeWorkspace(workspace, options);
    const payload = verifyWorkspace(workspace, options);
    process.stdout.write(`${JSON.stringify(payload, null, options.pretty ? 2 : 0)}\n`);
    process.exitCode = payload.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
