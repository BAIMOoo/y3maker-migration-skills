#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const { getAdapters, normalizeTargets } = require("./adapters");
const { emitJson, parseCommonCliOptions } = require("./lib/cli-args");
const { assertSafeWorkspace, getUserHome } = require("./lib/fs-utils");
const { loadManifest } = require("./lib/manifest");
const { applyMigration, inventoryWorkspace } = require("./lib/migration-engine");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = parseCommonCliOptions(rest, { allowDryRun: true });

  if (!command || !["inventory", "apply"].includes(command)) {
    throw new Error(
      "用法：node run-migration.js <inventory|apply> [--workspace .] [--targets codex,claude,antigravity,dsh|all] [--mcp-scope project|user|skip] [--dry-run] [--pretty] [--allow-unsafe-workspace]"
    );
  }
  return { command, options };
}

function question(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resolveTargets(workspace, options) {
  if (options.targets && options.targets.length > 0) {
    return normalizeTargets(options.targets);
  }

  const manifest = loadManifest(workspace);
  if (Array.isArray(manifest.targets) && manifest.targets.length > 0) {
    return normalizeTargets(manifest.targets);
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "未指定目标宿主（--targets）。非交互模式下禁止静默猜测，请通过 --targets 传入逗号分隔的宿主（codex、claude、antigravity/agy、dsh）或 all。"
    );
  }

  process.stderr.write(
    [
      "请选择本次迁移启用的目标宿主（可多选，用逗号分隔，或输入 all）：",
      "  - codex",
      "  - claude",
      "  - antigravity（别名 agy）",
      "  - dsh",
      "  - all（同时启用以上全部 4 个宿主）",
      "",
    ].join("\n")
  );
  const answer = await question("目标宿主 [例如 codex,claude 或 all]: ");
  return normalizeTargets(answer);
}

async function resolveMcpScope(workspace, options) {
  if (options.mcpScope || !fs.existsSync(path.join(workspace, ".y3maker", "mcp_settings.json"))) {
    return options.mcpScope;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "检测到遗留 MCP 配置（.y3maker/mcp_settings.json），非交互模式下禁止静默修改 MCP 配置。请显式传入 --mcp-scope project、--mcp-scope user 或 --mcp-scope skip。"
    );
  }

  const homeDir = getUserHome(options.homeDir);
  const adapters = getAdapters(options.targets);
  const targetNames = adapters.map((adapter) => adapter.displayName).join("、");
  process.stderr.write(
    [
      `检测到 .y3maker/mcp_settings.json（当前启用宿主：${targetNames}）。请选择统一 MCP 迁移范围：`,
      `  1) project - 写入各宿主的项目级 MCP 配置（位于工作区 ${workspace}）`,
      `  2) user    - 写入各宿主的用户级 MCP 配置（位于主目录 ${homeDir}）`,
      "  3) skip    - 本次跳过所有宿主的 MCP 迁移",
      "",
    ].join("\n")
  );

  const answer = (await question("MCP 迁移范围 [project/user/skip 或 1/2/3]: ")).toLowerCase();
  const aliases = {
    "1": "project",
    p: "project",
    project: "project",
    "2": "user",
    u: "user",
    user: "user",
    "3": "skip",
    s: "skip",
    skip: "skip",
  };
  if (!aliases[answer]) {
    throw new Error("未选择有效的 MCP 迁移范围。可选值：project、user 或 skip。");
  }
  return aliases[answer];
}

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    const workspace = path.resolve(options.workspace);
    if (command === "inventory") {
      const payload = inventoryWorkspace(workspace);
      emitJson(payload, options.pretty);
      return;
    }

    assertSafeWorkspace(workspace, options);
    options.targets = await resolveTargets(workspace, options);
    options.mcpScope = await resolveMcpScope(workspace, options);

    const payload = applyMigration(workspace, {
      dryRun: options.dryRun,
      targets: options.targets,
      mcpScope: options.mcpScope,
      allowUnsafeWorkspace: options.allowUnsafeWorkspace,
    });
    emitJson(payload, options.pretty);
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
