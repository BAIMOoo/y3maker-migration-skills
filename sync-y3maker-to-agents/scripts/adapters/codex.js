/**
 * Codex 宿主适配层（Harness Adapter）：
 * - Codex 直接原生消费 Canonical Store（.agents/skills/），绝不向 .codex/ 重复复制资产树。
 * - 按显式 MCP Scope（project / user / skip）以非破坏性 TOML 区块合并方式更新 .codex/config.toml 或 ~/.codex/config.toml。
 * - 提供面向 verify 的 TOML 语法与受管 [mcp_servers.*] 区块完整性验收。
 */
const fs = require("fs");
const path = require("path");

const { readText } = require("../lib/fs-utils");
const { isPlainObject, normalizeStringMap } = require("../lib/mcp-source");
const {
  computeCodexMcpManagedHash,
  formatTomlKey,
  mergeCodexMcpToml,
  parseTomlDocument,
} = require("../lib/toml-merge");

function buildStdioServer(name, config) {
  return {
    name,
    transport: "stdio",
    command: config.command,
    args: Array.isArray(config.args) ? config.args.map((item) => String(item)) : [],
    cwd: typeof config.cwd === "string" && config.cwd.length > 0 ? config.cwd : null,
    env: normalizeStringMap(config.env),
  };
}

function collectCodexMcpServers(legacyMcp) {
  const servers = [];
  const skipped = Array.isArray(legacyMcp.disabled) ? [...legacyMcp.disabled] : [];
  const warnings = [];
  const rawServers = isPlainObject(legacyMcp.servers) ? legacyMcp.servers : {};
  const enabledNames = Array.isArray(legacyMcp.enabled) ? legacyMcp.enabled : [];

  for (const name of enabledNames) {
    const config = isPlainObject(rawServers[name]) ? rawServers[name] : {};
    const declaredType = typeof config.type === "string" ? config.type.toLowerCase() : "";
    const hasCommand = typeof config.command === "string" && config.command.length > 0;
    const hasUrl = typeof config.url === "string" && config.url.length > 0;

    if (declaredType === "stdio" && hasCommand) {
      servers.push(buildStdioServer(name, config));
      continue;
    }

    if (hasUrl) {
      const rawHeaders = isPlainObject(config.headers)
        ? config.headers
        : isPlainObject(config.http_headers)
          ? config.http_headers
          : null;
      servers.push({
        name,
        transport: "http",
        url: config.url,
        httpHeaders: normalizeStringMap(rawHeaders),
      });
      continue;
    }

    if (hasCommand) {
      servers.push(buildStdioServer(name, config));
      continue;
    }

    skipped.push(name);
    warnings.push(`Codex MCP 配置已跳过缺少 command 或 url 的服务器：${name}`);
  }

  return {
    servers,
    skipped: skipped.sort(),
    warnings,
  };
}

function resolveCodexConfigTarget(ctx) {
  if (ctx.mcpScope === "project") {
    return {
      targetFile: path.join(ctx.paths.codex, "config.toml"),
      targetRelative: ".codex/config.toml",
    };
  }
  return {
    targetFile: path.join(ctx.homeDir, ".codex", "config.toml"),
    targetRelative: "~/.codex/config.toml",
  };
}

module.exports = {
  id: "codex",
  aliases: [],
  displayName: "Codex",

  planTarget(ctx) {
    if (!ctx.legacyMcp || !ctx.legacyMcp.exists) {
      return {
        filePlans: [],
        mcpReport: null,
        extraCreatedDirs: [],
      };
    }

    if (ctx.mcpScope === "skip") {
      return {
        filePlans: [],
        mcpReport: {
          scope: "skip",
          target: null,
          converted: false,
          servers: [],
          skipped: ["mcp_settings.json"],
          empty: ctx.legacyMcp.empty,
          warnings: [],
          hints: [],
        },
        extraCreatedDirs: [],
      };
    }

    const { targetFile, targetRelative } = resolveCodexConfigTarget(ctx);
    if (ctx.legacyMcp.empty) {
      return {
        filePlans: [],
        mcpReport: {
          scope: ctx.mcpScope,
          target: targetRelative,
          converted: false,
          servers: [],
          skipped: [],
          empty: true,
          warnings: [
            `.y3maker/mcp_settings.json 中的 mcpServers 为空对象，已跳过写入 ${targetRelative}`,
          ],
          hints: [],
        },
        extraCreatedDirs: [],
      };
    }

    const { servers, skipped, warnings } = collectCodexMcpServers(ctx.legacyMcp);
    if (servers.length === 0) {
      return {
        filePlans: [],
        mcpReport: {
          scope: ctx.mcpScope,
          target: targetRelative,
          converted: false,
          servers: [],
          skipped,
          empty: false,
          warnings: [
            ...warnings,
            `.y3maker/mcp_settings.json 中没有可迁移到 Codex 的启用 MCP 服务器，已跳过写入 ${targetRelative}`,
          ],
          hints: [],
        },
        extraCreatedDirs: [],
      };
    }

    const serverNames = servers.map((item) => item.name);
    const filePlan = {
      kind: "mcp-config",
      mergeExisting: true,
      managedKeys: [...serverNames].sort(),
      computeManagedHash: computeCodexMcpManagedHash,
      sourceFile: ctx.legacyMcp.filePath,
      sourceRelative: ctx.legacyMcp.relativePath,
      targetFile,
      targetRelative,
      targetScope: ctx.mcpScope,
      render(plan) {
        const existingText = fs.existsSync(plan.targetFile) ? readText(plan.targetFile) : "";
        const mergedText = mergeCodexMcpToml(existingText, servers, {
          targetRelative: plan.targetRelative,
        });
        return {
          text: mergedText,
          metadata: {
            mcp: {
              scope: plan.targetScope,
              target: plan.targetRelative,
              converted: true,
              servers: serverNames,
              skipped,
              empty: false,
              warnings,
              hints: [],
            },
          },
        };
      },
    };

    return {
      filePlans: [filePlan],
      mcpReport: {
        scope: ctx.mcpScope,
        target: targetRelative,
        converted: false,
        servers: serverNames,
        skipped,
        empty: false,
        warnings,
        hints: [],
      },
      extraCreatedDirs: [],
    };
  },

  verifyTarget(ctx) {
    if (!ctx.hasLegacyMcp || !ctx.mcpScope || ctx.mcpScope === "skip") {
      return [];
    }
    if (!ctx.legacyMcp || ctx.legacyMcp.empty) {
      return [];
    }

    const { servers } = collectCodexMcpServers(ctx.legacyMcp);
    if (servers.length === 0) {
      return [];
    }

    const { targetFile, targetRelative } = resolveCodexConfigTarget(ctx);
    if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
      const scopeLabel = ctx.mcpScope === "project" ? "项目级" : "用户级";
      return [
        {
          type: "missing-path",
          path: targetRelative,
          detail: `存在遗留 MCP 配置且已选择 Codex 的${scopeLabel} MCP 迁移，但目标配置缺失`,
        },
      ];
    }

    let text;
    try {
      text = readText(targetFile);
    } catch (error) {
      return [
        {
          type: "invalid-mcp-config",
          path: targetRelative,
          detail: `无法读取 Codex MCP 配置文件：${error.message}`,
        },
      ];
    }

    let parsed;
    try {
      parsed = parseTomlDocument(text);
    } catch (error) {
      return [
        {
          type: "invalid-mcp-config",
          path: targetRelative,
          detail: `Codex MCP 配置文件 TOML 语法不合法：${error.message}`,
        },
      ];
    }

    const issues = [];
    for (const server of servers) {
      const table = parsed.mcpServerTables.get(server.name);
      if (!table) {
        issues.push({
          type: "invalid-mcp-config",
          path: targetRelative,
          detail: `Codex MCP 配置缺少受管服务器区块 [mcp_servers.${formatTomlKey(server.name)}]`,
        });
        continue;
      }

      if (server.transport === "stdio") {
        const commandField = table.keys.get("command");
        if (
          !commandField ||
          typeof commandField.stringValue !== "string" ||
          commandField.stringValue.trim().length === 0
        ) {
          issues.push({
            type: "invalid-mcp-config",
            path: targetRelative,
            detail: `Codex MCP 服务器 ${server.name} 缺少有效的 command 字符串配置`,
          });
        }
      } else if (server.transport === "http") {
        const urlField = table.keys.get("url");
        if (
          !urlField ||
          typeof urlField.stringValue !== "string" ||
          urlField.stringValue.trim().length === 0
        ) {
          issues.push({
            type: "invalid-mcp-config",
            path: targetRelative,
            detail: `Codex MCP 服务器 ${server.name} 缺少有效的 url 字符串配置`,
          });
        }
      }
    }

    return issues;
  },
};
