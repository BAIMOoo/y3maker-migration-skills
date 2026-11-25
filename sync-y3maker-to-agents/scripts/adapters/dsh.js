/**
 * DSH（DeepSeek Harness）宿主适配层：
 * - 直接原生复用 Canonical Store（.agents/skills/），不复制 skills 或非 skill 目录。
 * - 按显式 MCP Scope 将遗留 MCP 服务转换为 @deepseek-ai/dsh-mcp-client 插件条目，
 *   以零依赖方式安全合并至 .dsh/cordis.patch.yml 或 ~/.dsh/cordis.patch.yml。
 */
const fs = require("fs");
const path = require("path");

const {
  computeCordisManagedHash,
  mergeCordisPatchYaml,
  parseCordisPatchDocument,
} = require("../lib/cordis-yaml-merge");
const { readText } = require("../lib/fs-utils");
const {
  EXPLICIT_STREAMABLE_HTTP_TYPES,
  isLegacySseServer,
  isPlainObject,
  normalizeStringMap,
} = require("../lib/mcp-source");

const DSH_MCP_PLUGIN_NAME = "@deepseek-ai/dsh-mcp-client";
const MANAGED_ID_PREFIX = "y3maker-mcp-";
const PROJECT_PATCH_RELATIVE = ".dsh/cordis.patch.yml";
const USER_PATCH_RELATIVE = "~/.dsh/cordis.patch.yml";
const PROJECT_PATCH_HINT =
  "已生成 DSH 项目级 MCP 补丁 .dsh/cordis.patch.yml；启动 DSH 时请传入：dsh --patch .dsh/cordis.patch.yml";

const VALID_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function sanitizeServerNameBase(rawName) {
  const cleaned = String(rawName || "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = cleaned || "server";
  return base.slice(0, 32);
}

function allocateServerNames(rawNames) {
  const assigned = new Map();
  const used = new Set();

  for (const rawName of rawNames) {
    if (VALID_SERVER_NAME_PATTERN.test(rawName) && !used.has(rawName)) {
      assigned.set(rawName, rawName);
      used.add(rawName);
    }
  }

  for (const rawName of rawNames) {
    if (assigned.has(rawName)) {
      continue;
    }
    const base = sanitizeServerNameBase(rawName);
    let candidate = base;
    let counter = 2;
    while (used.has(candidate)) {
      const suffix = `-${counter}`;
      candidate = `${base.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`;
      counter += 1;
    }
    assigned.set(rawName, candidate);
    used.add(candidate);
  }

  return assigned;
}

function classifyServerConfig(rawName, config) {
  const safeConfig = isPlainObject(config) ? config : {};
  const rawType = typeof safeConfig.type === "string" ? safeConfig.type.trim().toLowerCase() : "";

  if (isLegacySseServer(safeConfig)) {
    return {
      ok: false,
      warning: `DSH 的 ${DSH_MCP_PLUGIN_NAME} 不支持旧版 SSE 传输，已跳过服务 "${rawName}"；请改用 Streamable HTTP（/mcp）端点或通过 mcp-remote 等 stdio 桥接包装。`,
    };
  }

  if (rawType === "stdio" || (!rawType && safeConfig.command && !safeConfig.url)) {
    if (!safeConfig.command || typeof safeConfig.command !== "string" || !safeConfig.command.trim()) {
      return {
        ok: false,
        warning: `DSH 适配层跳过无效服务 "${rawName}"：stdio 传输缺少必填字段 command。`,
      };
    }
    const dshConfig = {
      transport: "stdio",
      command: safeConfig.command,
    };
    if (Array.isArray(safeConfig.args) && safeConfig.args.length > 0) {
      dshConfig.args = safeConfig.args.map((item) => String(item));
    }
    const env = normalizeStringMap(safeConfig.env);
    if (env) {
      dshConfig.env = env;
    }
    if (typeof safeConfig.cwd === "string" && safeConfig.cwd.length > 0) {
      dshConfig.cwd = safeConfig.cwd;
    }
    return { ok: true, config: dshConfig };
  }

  if (EXPLICIT_STREAMABLE_HTTP_TYPES.has(rawType) || (!rawType && safeConfig.url)) {
    if (!safeConfig.url || typeof safeConfig.url !== "string" || !safeConfig.url.trim()) {
      return {
        ok: false,
        warning: `DSH 适配层跳过无效服务 "${rawName}"：streamable-http 传输缺少必填字段 url。`,
      };
    }
    const dshConfig = {
      transport: "streamable-http",
      url: safeConfig.url,
    };
    const headers = normalizeStringMap(safeConfig.headers);
    if (headers) {
      dshConfig.headers = headers;
    }
    return { ok: true, config: dshConfig };
  }

  const typeHint = rawType ? `（传输类型 "${safeConfig.type}" 不受支持）` : "（缺少 command 或 url）";
  return {
    ok: false,
    warning: `DSH 适配层无法识别服务 "${rawName}" 的有效传输配置${typeHint}，已跳过。`,
  };
}

function convertLegacyMcpForDsh(legacyMcp) {
  const skipped = [...(legacyMcp.disabled || [])];
  const warnings = [...(legacyMcp.warnings || [])];
  const validItems = [];

  for (const rawName of legacyMcp.enabled || []) {
    const classified = classifyServerConfig(rawName, legacyMcp.servers[rawName]);
    if (!classified.ok) {
      skipped.push(rawName);
      if (classified.warning) {
        warnings.push(classified.warning);
      }
      continue;
    }
    validItems.push({ rawName, config: classified.config });
  }

  const nameMap = allocateServerNames(validItems.map((item) => item.rawName));
  const entries = validItems.map((item) => {
    const serverName = nameMap.get(item.rawName);
    return {
      rawName: item.rawName,
      id: `${MANAGED_ID_PREFIX}${serverName}`,
      name: DSH_MCP_PLUGIN_NAME,
      serverName,
      config: {
        serverName,
        ...item.config,
      },
    };
  });

  skipped.sort();
  return { entries, skipped, warnings };
}

function resolveDshPatchTarget(ctx) {
  if (ctx.mcpScope === "user") {
    return {
      targetRelative: USER_PATCH_RELATIVE,
      targetFile: path.join(ctx.homeDir, ".dsh", "cordis.patch.yml"),
      targetScope: "user",
      hints: [],
    };
  }
  return {
    targetRelative: PROJECT_PATCH_RELATIVE,
    targetFile: path.join(ctx.workspace, ".dsh", "cordis.patch.yml"),
    targetScope: "project",
    hints: [PROJECT_PATCH_HINT],
  };
}

module.exports = {
  id: "dsh",
  aliases: [],
  displayName: "DSH",

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
          warnings: [...(ctx.legacyMcp.warnings || [])],
          hints: [],
        },
        extraCreatedDirs: [],
      };
    }

    const converted = convertLegacyMcpForDsh(ctx.legacyMcp);
    if (converted.entries.length === 0) {
      return {
        filePlans: [],
        mcpReport: {
          scope: ctx.mcpScope,
          target: null,
          converted: false,
          servers: [],
          skipped: converted.skipped,
          empty: ctx.legacyMcp.empty,
          warnings: converted.warnings,
          hints: [],
        },
        extraCreatedDirs: [],
      };
    }

    const targetInfo = resolveDshPatchTarget(ctx);
    const serverNames = converted.entries.map((entry) => entry.rawName);
    const managedIds = converted.entries.map((entry) => entry.id);

    const mcpReport = {
      scope: ctx.mcpScope,
      target: targetInfo.targetRelative,
      converted: false,
      servers: serverNames,
      managedIds,
      skipped: converted.skipped,
      empty: ctx.legacyMcp.empty,
      warnings: converted.warnings,
      hints: targetInfo.hints,
    };

    const plan = {
      kind: "mcp-config",
      mergeExisting: true,
      managedKeys: [...managedIds].sort(),
      computeManagedHash: computeCordisManagedHash,
      sourceFile: ctx.legacyMcp.filePath,
      sourceRelative: ctx.legacyMcp.relativePath,
      targetFile: targetInfo.targetFile,
      targetRelative: targetInfo.targetRelative,
      targetScope: targetInfo.targetScope,
      render(currentPlan) {
        const existingText =
          fs.existsSync(currentPlan.targetFile) && fs.statSync(currentPlan.targetFile).isFile()
            ? readText(currentPlan.targetFile)
            : "";
        return {
          text: mergeCordisPatchYaml(existingText, converted.entries),
          flags: {
            rewrittenLegacyPaths: false,
            normalizedSkillFrontmatter: false,
            appliedSpecialFixes: [],
          },
          metadata: {
            mcp: {
              ...mcpReport,
              converted: true,
            },
          },
        };
      },
    };

    return {
      filePlans: [plan],
      mcpReport,
      extraCreatedDirs: [],
    };
  },

  verifyTarget(ctx) {
    if (!ctx.hasLegacyMcp || !ctx.mcpScope || ctx.mcpScope === "skip") {
      return [];
    }
    const converted = convertLegacyMcpForDsh(ctx.legacyMcp);
    if (converted.entries.length === 0) {
      return [];
    }
    const targetInfo = resolveDshPatchTarget(ctx);
    if (!fs.existsSync(targetInfo.targetFile) || !fs.statSync(targetInfo.targetFile).isFile()) {
      return [
        {
          type: "missing-mcp-config",
          path: targetInfo.targetRelative,
          detail: `缺少 DSH MCP 补丁文件 ${targetInfo.targetRelative}（--mcp-scope ${ctx.mcpScope}）`,
        },
      ];
    }

    let doc;
    try {
      doc = parseCordisPatchDocument(readText(targetInfo.targetFile));
    } catch (error) {
      return [
        {
          type: "invalid-mcp-config",
          path: targetInfo.targetRelative,
          detail: `DSH MCP 补丁文件解析失败：${error.message}`,
        },
      ];
    }

    const byId = new Map();
    for (const item of doc.items) {
      if (item.type !== "insert") {
        continue;
      }
      for (const child of item.children) {
        const childId = child.meta && child.meta.id;
        if (!childId) {
          continue;
        }
        if (!byId.has(childId)) {
          byId.set(childId, []);
        }
        byId.get(childId).push(child.meta);
      }
    }

    const issues = [];
    for (const entry of converted.entries) {
      const matches = byId.get(entry.id) || [];
      if (matches.length === 0) {
        issues.push({
          type: "missing-mcp-server",
          path: targetInfo.targetRelative,
          detail: `DSH 补丁缺少受管 MCP 条目 ${entry.id}（serverName: ${entry.serverName}）`,
        });
        continue;
      }
      if (matches.length > 1) {
        issues.push({
          type: "invalid-mcp-config",
          path: targetInfo.targetRelative,
          detail: `DSH 补丁中存在重复的受管条目 id：${entry.id}（出现 ${matches.length} 次）`,
        });
      }
      for (const actual of matches) {
        if (actual.name !== DSH_MCP_PLUGIN_NAME) {
          issues.push({
            type: "invalid-mcp-config",
            path: targetInfo.targetRelative,
            detail: `受管条目 ${entry.id} 的插件名必须为 ${DSH_MCP_PLUGIN_NAME}（当前：${actual.name || "缺失"}）`,
          });
        }
        if (
          !actual.serverName ||
          actual.serverName !== entry.serverName ||
          !VALID_SERVER_NAME_PATTERN.test(actual.serverName)
        ) {
          issues.push({
            type: "invalid-mcp-config",
            path: targetInfo.targetRelative,
            detail: `受管条目 ${entry.id} 缺少或不匹配的 serverName（期望：${entry.serverName}，当前：${actual.serverName || "缺失"}）`,
          });
        }
        if (actual.transport !== entry.config.transport) {
          issues.push({
            type: "invalid-mcp-config",
            path: targetInfo.targetRelative,
            detail: `受管条目 ${entry.id} 的 transport 无效或不匹配（期望：${entry.config.transport}，当前：${actual.transport || "缺失"}）`,
          });
        }
        if (entry.config.transport === "stdio" && !actual.command) {
          issues.push({
            type: "invalid-mcp-config",
            path: targetInfo.targetRelative,
            detail: `受管条目 ${entry.id}（stdio）缺少必填字段 command`,
          });
        }
        if (entry.config.transport === "streamable-http" && !actual.url) {
          issues.push({
            type: "invalid-mcp-config",
            path: targetInfo.targetRelative,
            detail: `受管条目 ${entry.id}（streamable-http）缺少必填字段 url`,
          });
        }
      }
    }

    return issues;
  },
};
