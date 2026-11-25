/**
 * Antigravity（agy）宿主适配层：
 * - 直接原生复用 Canonical Store（.agents/skills/），不重复复制资产。
 * - 按显式 MCP Scope 生成项目级插件（.agents/plugins/y3maker-mcp/）或合并至 ~/.gemini/config/mcp_config.json。
 */
const fs = require("fs");
const path = require("path");

const { readText } = require("../lib/fs-utils");
const {
  EXPLICIT_STREAMABLE_HTTP_TYPES,
  computeJsonFieldsManagedHash,
  computeJsonMcpManagedHash,
  isLegacySseServer,
  isPlainObject,
  normalizeStringMap,
  resolveServerUrl,
} = require("../lib/mcp-source");

const PLUGIN_NAME = "y3maker-mcp";
const PLUGIN_DEFAULT_VERSION = "1.0.0";
const PLUGIN_DEFAULT_DESCRIPTION = "由 Y3Maker 迁移生成的 MCP 服务配置";
const PLUGIN_MANAGED_FIELDS = ["description", "name", "version"];
const PLUGIN_DIR_RELATIVE = `.agents/plugins/${PLUGIN_NAME}`;
const PLUGIN_MANIFEST_RELATIVE = `${PLUGIN_DIR_RELATIVE}/plugin.json`;
const PLUGIN_MCP_RELATIVE = `${PLUGIN_DIR_RELATIVE}/mcp_config.json`;
const USER_MCP_RELATIVE = "~/.gemini/config/mcp_config.json";

const SUPPORTED_EXPLICIT_TYPES = new Set(["stdio", ...EXPLICIT_STREAMABLE_HTTP_TYPES]);

function readExistingJsonObject(filePath, displayPath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(readText(filePath));
  } catch (error) {
    throw new Error(`无法解析既有 Antigravity 配置文件 ${displayPath}：${error.message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`既有 Antigravity 配置文件 ${displayPath} 顶层必须是 JSON 对象`);
  }
  return parsed;
}

function convertAntigravityServers(legacyMcp) {
  const rawServers = isPlainObject(legacyMcp.servers) ? legacyMcp.servers : {};
  const convertedServers = {};
  const servers = [];
  const skipped = [];
  const warnings = [...(legacyMcp.warnings || [])];

  for (const name of Object.keys(rawServers).sort()) {
    const entry = rawServers[name];
    if (!isPlainObject(entry)) {
      skipped.push(name);
      warnings.push(`跳过无效的 Antigravity MCP 服务器 "${name}"：配置项不是合法对象。`);
      continue;
    }
    if (entry.disabled) {
      skipped.push(name);
      continue;
    }

    const rawType = typeof entry.type === "string" ? entry.type.trim().toLowerCase() : "";
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    const url = resolveServerUrl(entry);

    if (isLegacySseServer(entry)) {
      skipped.push(name);
      warnings.push(
        `Antigravity 不支持旧版 HTTP+SSE 传输，已跳过 MCP 服务器 "${name}"；请改用 Streamable HTTP（如 /mcp 端点）或通过 stdio 桥接工具（如 mcp-remote）接入。`
      );
      continue;
    }

    if (rawType && !SUPPORTED_EXPLICIT_TYPES.has(rawType)) {
      skipped.push(name);
      warnings.push(
        `Antigravity 仅支持 stdio 与 Streamable HTTP 传输，已跳过 MCP 服务器 "${name}"（不支持的类型：${entry.type}）。`
      );
      continue;
    }

    if (rawType === "stdio" || (!EXPLICIT_STREAMABLE_HTTP_TYPES.has(rawType) && !url && command)) {
      if (!command) {
        skipped.push(name);
        warnings.push(`Antigravity 无法转换 stdio MCP 服务器 "${name}"：缺少有效的 command 字段，已跳过。`);
        continue;
      }
      const normalized = { command };
      if (Array.isArray(entry.args) && entry.args.length > 0) {
        normalized.args = entry.args.map((item) => String(item));
      }
      const env = normalizeStringMap(entry.env);
      if (env) {
        normalized.env = env;
      }
      convertedServers[name] = normalized;
      servers.push(name);
      continue;
    }

    if (url) {
      const normalized = { url };
      const headers = normalizeStringMap(entry.headers);
      if (headers) {
        normalized.headers = headers;
      }
      convertedServers[name] = normalized;
      servers.push(name);
      continue;
    }

    skipped.push(name);
    warnings.push(
      `Antigravity 无法转换 MCP 服务器 "${name}"：缺少有效的 command（stdio）或 url（Streamable HTTP）配置，已跳过。`
    );
  }

  return { convertedServers, servers, skipped, warnings };
}

function renderPluginManifest(targetFile, displayPath) {
  const existing = readExistingJsonObject(targetFile, displayPath);
  const next = {
    ...existing,
    name:
      typeof existing.name === "string" && existing.name.trim()
        ? existing.name.trim()
        : PLUGIN_NAME,
    version:
      typeof existing.version === "string" && existing.version.trim()
        ? existing.version.trim()
        : PLUGIN_DEFAULT_VERSION,
  };
  if (typeof existing.description !== "string" || !existing.description.trim()) {
    next.description = PLUGIN_DEFAULT_DESCRIPTION;
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

function renderMergedMcpConfig(targetFile, displayPath, convertedServers) {
  const existing = readExistingJsonObject(targetFile, displayPath);
  if (existing.mcpServers !== undefined && !isPlainObject(existing.mcpServers)) {
    throw new Error(`既有 Antigravity MCP 配置文件 ${displayPath} 中的 mcpServers 必须是 JSON 对象`);
  }
  const mergedServers = {
    ...(existing.mcpServers || {}),
    ...convertedServers,
  };
  const next = {
    ...existing,
    mcpServers: mergedServers,
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

function verifyPluginManifest(pluginManifestFile) {
  const issues = [];
  if (!fs.existsSync(pluginManifestFile) || !fs.statSync(pluginManifestFile).isFile()) {
    issues.push({
      type: "missing-path",
      path: PLUGIN_MANIFEST_RELATIVE,
      detail: "已选择项目级 MCP 迁移范围，但缺少 Antigravity 插件清单 plugin.json",
    });
    return issues;
  }

  let parsed;
  try {
    parsed = JSON.parse(readText(pluginManifestFile));
  } catch (error) {
    issues.push({
      type: "invalid-mcp-config",
      path: PLUGIN_MANIFEST_RELATIVE,
      detail: `Antigravity 插件清单 plugin.json 无法解析为合法 JSON：${error.message}`,
    });
    return issues;
  }

  if (!isPlainObject(parsed)) {
    issues.push({
      type: "invalid-mcp-config",
      path: PLUGIN_MANIFEST_RELATIVE,
      detail: "Antigravity 插件清单 plugin.json 顶层必须是 JSON 对象",
    });
    return issues;
  }

  if (typeof parsed.name !== "string" || !parsed.name.trim()) {
    issues.push({
      type: "invalid-mcp-config",
      path: PLUGIN_MANIFEST_RELATIVE,
      detail: "Antigravity 插件清单 plugin.json 缺少非空字符串字段 name",
    });
  }
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    issues.push({
      type: "invalid-mcp-config",
      path: PLUGIN_MANIFEST_RELATIVE,
      detail:
        "Antigravity 插件清单 plugin.json 缺少非空字符串字段 version（agy plugin validate --strict 要求提供 version）",
    });
  }
  return issues;
}

function verifyMcpConfigFile(configFile, displayPath, expectedServers, options = {}) {
  const issues = [];
  if (!fs.existsSync(configFile) || !fs.statSync(configFile).isFile()) {
    issues.push({
      type: "missing-path",
      path: displayPath,
      detail: `缺少 Antigravity MCP 配置文件 ${displayPath}`,
    });
    return issues;
  }

  let parsed;
  try {
    parsed = JSON.parse(readText(configFile));
  } catch (error) {
    issues.push({
      type: "invalid-mcp-config",
      path: displayPath,
      detail: `Antigravity MCP 配置文件无法解析为合法 JSON：${error.message}`,
    });
    return issues;
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
    issues.push({
      type: "invalid-mcp-config",
      path: displayPath,
      detail: "Antigravity MCP 配置文件缺少合法的 mcpServers 对象",
    });
    return issues;
  }

  const serversMap = parsed.mcpServers;
  for (const expectedName of expectedServers) {
    if (!Object.prototype.hasOwnProperty.call(serversMap, expectedName)) {
      issues.push({
        type: "invalid-mcp-config",
        path: displayPath,
        detail: `Antigravity MCP 配置缺少已迁移的兼容服务器 "${expectedName}"`,
      });
    }
  }

  const namesToInspect = options.validateAllServers
    ? Object.keys(serversMap).sort()
    : expectedServers.filter((name) => Object.prototype.hasOwnProperty.call(serversMap, name));

  for (const name of namesToInspect) {
    const cfg = serversMap[name];
    if (!isPlainObject(cfg)) {
      issues.push({
        type: "invalid-mcp-config",
        path: displayPath,
        detail: `Antigravity MCP 服务器 "${name}" 配置项必须是 JSON 对象`,
      });
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(cfg, "type")) {
      issues.push({
        type: "invalid-mcp-config",
        path: displayPath,
        detail: `Antigravity MCP 服务器 "${name}" 包含不被 agy plugin validate --strict 接受的 "type" 字段`,
      });
    }

    const hasCommand = typeof cfg.command === "string" && cfg.command.trim().length > 0;
    const hasUrl =
      (typeof cfg.url === "string" && cfg.url.trim().length > 0) ||
      (typeof cfg.serverUrl === "string" && cfg.serverUrl.trim().length > 0);
    if (!hasCommand && !hasUrl) {
      issues.push({
        type: "invalid-mcp-config",
        path: displayPath,
        detail: `Antigravity MCP 服务器 "${name}" 缺少有效的 command（stdio）或 url（Streamable HTTP）字段`,
      });
    }

    if (
      cfg.args !== undefined &&
      (!Array.isArray(cfg.args) || cfg.args.some((item) => typeof item !== "string"))
    ) {
      issues.push({
        type: "invalid-mcp-config",
        path: displayPath,
        detail: `Antigravity MCP 服务器 "${name}" 的 args 必须是字符串数组`,
      });
    }
    if (cfg.env !== undefined && !isPlainObject(cfg.env)) {
      issues.push({
        type: "invalid-mcp-config",
        path: displayPath,
        detail: `Antigravity MCP 服务器 "${name}" 的 env 必须是键值对象`,
      });
    }
    if (cfg.headers !== undefined && !isPlainObject(cfg.headers)) {
      issues.push({
        type: "invalid-mcp-config",
        path: displayPath,
        detail: `Antigravity MCP 服务器 "${name}" 的 headers 必须是键值对象`,
      });
    }
  }

  return issues;
}

module.exports = {
  id: "antigravity",
  aliases: ["agy"],
  displayName: "Antigravity",

  planTarget(ctx) {
    const { paths, homeDir, legacyMcp, mcpScope } = ctx;
    if (!legacyMcp || !legacyMcp.exists) {
      return {
        filePlans: [],
        mcpReport: null,
        extraCreatedDirs: [],
      };
    }

    if (mcpScope === "skip") {
      return {
        filePlans: [],
        mcpReport: {
          scope: "skip",
          target: null,
          converted: false,
          servers: [],
          skipped: ["mcp_settings.json"],
          empty: legacyMcp.empty,
          warnings: [],
          hints: [],
        },
        extraCreatedDirs: [],
      };
    }

    const { convertedServers, servers, skipped, warnings } = convertAntigravityServers(legacyMcp);

    if (mcpScope === "project" && servers.length > 0) {
      const pluginDir = path.join(paths.agents, "plugins", PLUGIN_NAME);
      const pluginManifestFile = path.join(pluginDir, "plugin.json");
      const pluginMcpFile = path.join(pluginDir, "mcp_config.json");

      return {
        filePlans: [
          {
            kind: "mcp-config",
            mergeExisting: true,
            managedKeys: [...PLUGIN_MANAGED_FIELDS],
            computeManagedHash: computeJsonFieldsManagedHash,
            sourceFile: legacyMcp.filePath,
            sourceRelative: legacyMcp.relativePath,
            targetFile: pluginManifestFile,
            targetRelative: PLUGIN_MANIFEST_RELATIVE,
            targetScope: "project",
            render() {
              return {
                text: renderPluginManifest(pluginManifestFile, PLUGIN_MANIFEST_RELATIVE),
              };
            },
          },
          {
            kind: "mcp-config",
            mergeExisting: true,
            managedKeys: [...servers].sort(),
            computeManagedHash: computeJsonMcpManagedHash,
            sourceFile: legacyMcp.filePath,
            sourceRelative: legacyMcp.relativePath,
            targetFile: pluginMcpFile,
            targetRelative: PLUGIN_MCP_RELATIVE,
            targetScope: "project",
            render() {
              return {
                text: renderMergedMcpConfig(pluginMcpFile, PLUGIN_MCP_RELATIVE, convertedServers),
              };
            },
          },
        ],
        mcpReport: {
          scope: "project",
          target: PLUGIN_MCP_RELATIVE,
          pluginDir: PLUGIN_DIR_RELATIVE,
          pluginManifest: PLUGIN_MANIFEST_RELATIVE,
          converted: true,
          servers,
          skipped,
          empty: legacyMcp.empty,
          warnings,
          hints: [],
        },
        extraCreatedDirs: [pluginDir],
      };
    }

    if (mcpScope === "user" && servers.length > 0) {
      const userMcpFile = path.join(homeDir, ".gemini", "config", "mcp_config.json");
      return {
        filePlans: [
          {
            kind: "mcp-config",
            mergeExisting: true,
            managedKeys: [...servers].sort(),
            computeManagedHash: computeJsonMcpManagedHash,
            sourceFile: legacyMcp.filePath,
            sourceRelative: legacyMcp.relativePath,
            targetFile: userMcpFile,
            targetRelative: USER_MCP_RELATIVE,
            targetScope: "user",
            render() {
              return {
                text: renderMergedMcpConfig(userMcpFile, USER_MCP_RELATIVE, convertedServers),
              };
            },
          },
        ],
        mcpReport: {
          scope: "user",
          target: USER_MCP_RELATIVE,
          converted: true,
          servers,
          skipped,
          empty: legacyMcp.empty,
          warnings,
          hints: [],
        },
        extraCreatedDirs: [],
      };
    }

    const skippedReason = legacyMcp.empty
      ? ".y3maker/mcp_settings.json 中的 mcpServers 为空对象，未生成 Antigravity MCP 配置"
      : "跳过不兼容或已禁用的条目后，没有可写入 Antigravity 的有效 MCP 服务器，已跳过配置写入";
    if (!warnings.includes(skippedReason)) {
      warnings.push(skippedReason);
    }

    return {
      filePlans: [],
      mcpReport: {
        scope: mcpScope,
        target: null,
        converted: false,
        servers: [],
        skipped,
        skippedReason,
        empty: legacyMcp.empty,
        warnings,
        hints: [],
      },
      extraCreatedDirs: [],
    };
  },

  verifyTarget(ctx) {
    const { paths, homeDir, hasLegacyMcp, legacyMcp, mcpScope } = ctx;
    if (!hasLegacyMcp || !mcpScope || mcpScope === "skip") {
      return [];
    }

    const { servers: expectedServers } = convertAntigravityServers(legacyMcp);
    if (expectedServers.length === 0) {
      return [];
    }

    if (mcpScope === "project") {
      const pluginDir = path.join(paths.agents, "plugins", PLUGIN_NAME);
      const pluginManifestFile = path.join(pluginDir, "plugin.json");
      const pluginMcpFile = path.join(pluginDir, "mcp_config.json");
      return [
        ...verifyPluginManifest(pluginManifestFile),
        ...verifyMcpConfigFile(pluginMcpFile, PLUGIN_MCP_RELATIVE, expectedServers, {
          validateAllServers: true,
        }),
      ];
    }

    if (mcpScope === "user") {
      const userMcpFile = path.join(homeDir, ".gemini", "config", "mcp_config.json");
      return verifyMcpConfigFile(userMcpFile, USER_MCP_RELATIVE, expectedServers, {
        validateAllServers: false,
      });
    }

    return [];
  },
};
