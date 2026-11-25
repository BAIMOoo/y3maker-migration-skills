/**
 * Claude Code 宿主适配层（Harness Adapter）：
 * - 单向 Skill Projection：将 Canonical Store 的 .agents/skills/ 投影至 .claude/skills/，
 *   改写跨目录相对引用回指 .agents/...，并仅在投影副本中保留规范化后的 allowed-tools。
 * - Claude MCP 安全合并：按 MCP Scope 合并至 .mcp.json（project）、~/.claude.json（user）或显式跳过（skip）。
 * - 端到端校验：校验 .claude/skills/ 结构、frontmatter、引用路径以及 Claude MCP 配置。
 */
const fs = require("fs");
const path = require("path");

const { CANONICAL_DIR, SELF_SKILL_NAME, TEXT_SUFFIXES } = require("../lib/constants");
const { extractFrontmatter, normalizeSkillFrontmatterText } = require("../lib/frontmatter");
const { hashBuffer, normalizeSlashes, readText, sortedEntries } = require("../lib/fs-utils");
const { parseLegacyMcpServers } = require("../lib/mcp-source");
const { materializeTextPlan, rewriteClaudeSkillRelativePaths } = require("../lib/text-transforms");

const UNREWRITTEN_CLAUDE_RELATIVE_PATTERN =
  /(?:\.\.[\\/]){2,}(?:rules[\\/]|memory[\\/]|knowledge[\\/]|templates[\\/]|spec-config\.json)/;

function rewriteClaudeRelativeReferences(content) {
  return rewriteClaudeSkillRelativePaths(content).replace(
    /(?:\.\.\\){2,}(rules\\|memory\\|knowledge\\|templates\\|spec-config\.json)/g,
    `${CANONICAL_DIR}\\$1`
  );
}

function materializeCanonicalFallback(canonicalPlan, workspace) {
  const rawBuffer = fs.readFileSync(canonicalPlan.sourceFile);
  const sourceHash = hashBuffer(rawBuffer);
  if (!TEXT_SUFFIXES.has(path.extname(canonicalPlan.sourceFile).toLowerCase())) {
    return {
      sourceHash,
      renderedHash: sourceHash,
      buffer: rawBuffer,
      flags: {
        rewrittenLegacyPaths: false,
        normalizedSkillFrontmatter: false,
        appliedSpecialFixes: [],
      },
      metadata: {},
    };
  }
  try {
    const materialized = materializeTextPlan(canonicalPlan, workspace);
    return {
      sourceHash,
      renderedHash: hashBuffer(materialized.buffer),
      buffer: materialized.buffer,
      flags: materialized.flags,
      metadata: {},
    };
  } catch (error) {
    if (String((error && error.message) || error).startsWith("Unable to decode ")) {
      return {
        sourceHash,
        renderedHash: sourceHash,
        buffer: rawBuffer,
        flags: {
          rewrittenLegacyPaths: false,
          normalizedSkillFrontmatter: false,
          appliedSpecialFixes: [],
        },
        metadata: {
          binaryTextSuffixFallback: true,
        },
      };
    }
    throw error;
  }
}

function buildSkillProjectionPlan(ctx, canonicalPlan) {
  const claudeSkillsRoot = path.join(ctx.paths.claude, "skills");
  const targetFile = path.join(
    claudeSkillsRoot,
    canonicalPlan.skillName,
    canonicalPlan.relativeSkillFile.replaceAll("/", path.sep)
  );
  const targetRelative = normalizeSlashes(path.relative(ctx.workspace, targetFile));

  return {
    kind: "skill-projection",
    skillName: canonicalPlan.skillName,
    relativeSkillFile: canonicalPlan.relativeSkillFile,
    sourceFile: canonicalPlan.targetFile,
    sourceRelative: canonicalPlan.targetRelative,
    legacySourceFile: canonicalPlan.sourceFile,
    targetFile,
    targetRelative,
    targetScope: "project",
    render(_plan, renderCtx) {
      const canonicalMaterialized =
        (renderCtx &&
          renderCtx.materializedByTarget &&
          renderCtx.materializedByTarget.get(canonicalPlan.targetRelative)) ||
        materializeCanonicalFallback(canonicalPlan, (renderCtx && renderCtx.workspace) || ctx.workspace);

      const isBinary =
        !TEXT_SUFFIXES.has(path.extname(canonicalPlan.sourceFile).toLowerCase()) ||
        Boolean(canonicalMaterialized.metadata && canonicalMaterialized.metadata.binaryTextSuffixFallback);

      if (isBinary) {
        return {
          buffer: canonicalMaterialized.buffer,
          sourceHash: canonicalMaterialized.renderedHash,
          flags: {
            rewrittenLegacyPaths: false,
            normalizedSkillFrontmatter: false,
            appliedSpecialFixes: [],
          },
          metadata: canonicalMaterialized.metadata ? { ...canonicalMaterialized.metadata } : {},
        };
      }

      let content = canonicalMaterialized.buffer.toString("utf8");
      const flags = {
        rewrittenLegacyPaths: Boolean(
          canonicalMaterialized.flags && canonicalMaterialized.flags.rewrittenLegacyPaths
        ),
        normalizedSkillFrontmatter: Boolean(
          canonicalMaterialized.flags && canonicalMaterialized.flags.normalizedSkillFrontmatter
        ),
        appliedSpecialFixes:
          canonicalMaterialized.flags && Array.isArray(canonicalMaterialized.flags.appliedSpecialFixes)
            ? [...canonicalMaterialized.flags.appliedSpecialFixes]
            : [],
      };

      const relativeRewritten = rewriteClaudeRelativeReferences(content);
      if (relativeRewritten !== content) {
        content = relativeRewritten;
        flags.rewrittenLegacyPaths = true;
      }

      if (canonicalPlan.relativeSkillFile === "SKILL.md") {
        const legacyOriginal = readText(canonicalPlan.sourceFile);
        const { frontmatter: sourceFrontmatter } = extractFrontmatter(legacyOriginal);
        const normalized = normalizeSkillFrontmatterText(canonicalPlan.skillName, content, {
          preserveAllowedTools: true,
          sourceFrontmatter,
        });
        if (normalized !== content) {
          content = normalized;
          flags.normalizedSkillFrontmatter = true;
        }
      }

      const normalizedLf = content.replace(/\r\n/g, "\n");
      return {
        buffer: Buffer.from(normalizedLf, "utf8"),
        sourceHash: canonicalMaterialized.renderedHash,
        flags,
        metadata: {},
      };
    },
  };
}

function normalizeClaudeMcpTransport(config) {
  const rawType = typeof config.type === "string" ? config.type.trim().toLowerCase() : "";
  if (rawType === "streamablehttp" || rawType === "streamable-http" || rawType === "http") {
    return "http";
  }
  if (rawType === "sse") {
    return "sse";
  }
  if (rawType === "stdio") {
    return "stdio";
  }
  return config.url ? "http" : "stdio";
}

function normalizeClaudeMcpServer(config = {}) {
  const normalized = {};
  if (config.url) {
    normalized.type = normalizeClaudeMcpTransport(config);
    normalized.url = config.url;
  }
  if (config.command) {
    normalized.type = normalizeClaudeMcpTransport(config);
    normalized.command = config.command;
  }
  if (Array.isArray(config.args) && config.args.length > 0) {
    normalized.args = [...config.args];
  }
  if (
    config.env &&
    typeof config.env === "object" &&
    !Array.isArray(config.env) &&
    Object.keys(config.env).length > 0
  ) {
    normalized.env = { ...config.env };
  }
  if (
    config.headers &&
    typeof config.headers === "object" &&
    !Array.isArray(config.headers) &&
    Object.keys(config.headers).length > 0
  ) {
    normalized.headers = { ...config.headers };
  }
  return normalized;
}

function loadExistingClaudeJson(existingFile, targetRelative) {
  if (!existingFile || !fs.existsSync(existingFile)) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(readText(existingFile));
  } catch (error) {
    throw new Error(`无法解析已有 Claude MCP 配置文件 ${targetRelative}：${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`已有 Claude MCP 配置文件 ${targetRelative} 根节点必须是 JSON 对象`);
  }
  if (
    parsed.mcpServers !== undefined &&
    (!parsed.mcpServers ||
      typeof parsed.mcpServers !== "object" ||
      Array.isArray(parsed.mcpServers))
  ) {
    throw new Error(`已有 Claude MCP 配置文件 ${targetRelative} 中的 mcpServers 必须是对象`);
  }
  return parsed;
}

function buildClaudeMcpFromLegacy(legacyFile, existingFile, targetRelative) {
  const parsedLegacy = parseLegacyMcpServers(legacyFile);
  const existing = loadExistingClaudeJson(existingFile, targetRelative);
  const next = { ...existing };
  const nextServers = existing.mcpServers ? { ...existing.mcpServers } : {};
  const servers = [];
  for (const { name, config } of parsedLegacy.enabledEntries) {
    nextServers[name] = normalizeClaudeMcpServer(config);
    servers.push(name);
  }
  next.mcpServers = nextServers;
  return {
    content: `${JSON.stringify(next, null, 2)}\n`,
    servers,
    skipped: [...parsedLegacy.disabled],
    empty: parsedLegacy.empty,
    warnings: [...parsedLegacy.warnings],
  };
}

function buildClaudeMcpPlan(ctx) {
  if (!ctx.legacyMcp || !ctx.legacyMcp.exists) {
    return { filePlan: null, mcpReport: null };
  }
  if (ctx.mcpScope === "skip") {
    return {
      filePlan: null,
      mcpReport: {
        scope: "skip",
        target: null,
        converted: false,
        servers: [],
        skipped: ["mcp_settings.json"],
        empty: ctx.legacyMcp.empty,
        warnings: [...ctx.legacyMcp.warnings],
        hints: [],
      },
    };
  }

  const targetFile =
    ctx.mcpScope === "project" ? ctx.paths.projectMcp : path.join(ctx.homeDir, ".claude.json");
  const targetRelative = ctx.mcpScope === "project" ? ".mcp.json" : "~/.claude.json";

  const filePlan = {
    kind: "mcp-config",
    isMcpConfig: true,
    sourceFile: ctx.legacyMcp.filePath,
    sourceRelative: ctx.legacyMcp.relativePath,
    targetFile,
    targetRelative,
    targetScope: ctx.mcpScope,
    mergeExisting: true,
    render(plan) {
      const claudeMcp = buildClaudeMcpFromLegacy(
        plan.sourceFile,
        plan.targetFile,
        plan.targetRelative
      );
      return {
        text: claudeMcp.content,
        sourceHash: hashBuffer(fs.readFileSync(plan.sourceFile)),
        metadata: {
          mcp: {
            converted: true,
            scope: plan.targetScope,
            target: plan.targetRelative,
            servers: claudeMcp.servers,
            skipped: claudeMcp.skipped,
            empty: claudeMcp.empty,
            warnings: claudeMcp.warnings,
            hints: [],
          },
        },
      };
    },
  };

  const mcpReport = {
    scope: ctx.mcpScope,
    target: targetRelative,
    converted: false,
    servers: [...ctx.legacyMcp.enabled],
    skipped: [...ctx.legacyMcp.disabled],
    empty: ctx.legacyMcp.empty,
    warnings: [...ctx.legacyMcp.warnings],
    hints: [],
  };

  return { filePlan, mcpReport };
}

function verifyClaudeMcpConfig(ctx) {
  const issues = [];
  if (!ctx.hasLegacyMcp || !ctx.mcpScope || ctx.mcpScope === "skip") {
    return issues;
  }
  if (ctx.mcpScope !== "project" && ctx.mcpScope !== "user") {
    return issues;
  }

  const targetFile =
    ctx.mcpScope === "project" ? ctx.paths.projectMcp : path.join(ctx.homeDir, ".claude.json");
  const displayPath = ctx.mcpScope === "project" ? ".mcp.json" : "~/.claude.json";

  if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
    issues.push({
      type: "missing-path",
      path: displayPath,
      detail:
        ctx.mcpScope === "project"
          ? "存在遗留 MCP 配置且已选择项目级迁移，但缺少 Claude MCP 配置文件 .mcp.json"
          : "存在遗留 MCP 配置且已选择用户级迁移，但缺少 Claude MCP 配置文件 ~/.claude.json",
    });
    return issues;
  }

  let parsed;
  try {
    parsed = JSON.parse(ctx.verifyHelpers.readText(targetFile));
  } catch (error) {
    issues.push({
      type: "invalid-mcp-config",
      path: displayPath,
      detail: `Claude MCP 配置文件不是合法 JSON：${error.message}`,
    });
    return issues;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    issues.push({
      type: "invalid-mcp-config",
      path: displayPath,
      detail: "Claude MCP 配置文件根节点必须是 JSON 对象",
    });
    return issues;
  }

  if (
    !parsed.mcpServers ||
    typeof parsed.mcpServers !== "object" ||
    Array.isArray(parsed.mcpServers)
  ) {
    issues.push({
      type: "invalid-mcp-config",
      path: displayPath,
      detail: "Claude MCP 配置文件缺少有效的 mcpServers 对象",
    });
    return issues;
  }

  const enabledServers =
    ctx.legacyMcp && Array.isArray(ctx.legacyMcp.enabled) ? ctx.legacyMcp.enabled : [];
  for (const serverName of enabledServers) {
    if (!Object.prototype.hasOwnProperty.call(parsed.mcpServers, serverName)) {
      issues.push({
        type: "missing-mcp-server",
        path: displayPath,
        detail: `Claude MCP 配置中缺少已启用的遗留 MCP 服务：${serverName}`,
      });
      continue;
    }
    const serverConfig = parsed.mcpServers[serverName];
    if (!serverConfig || typeof serverConfig !== "object" || Array.isArray(serverConfig)) {
      issues.push({
        type: "invalid-mcp-config",
        path: displayPath,
        detail: `Claude MCP 服务 ${serverName} 配置必须是 JSON 对象`,
      });
    }
  }

  return issues;
}

module.exports = {
  id: "claude",
  aliases: [],
  displayName: "Claude Code",

  planTarget(ctx) {
    const filePlans = [];
    const canonicalSkillPlans = Array.isArray(ctx.canonicalSkillPlans) ? ctx.canonicalSkillPlans : [];
    for (const canonicalPlan of canonicalSkillPlans) {
      filePlans.push(buildSkillProjectionPlan(ctx, canonicalPlan));
    }

    const { filePlan: mcpPlan, mcpReport } = buildClaudeMcpPlan(ctx);
    if (mcpPlan) {
      filePlans.push(mcpPlan);
    }

    return {
      filePlans,
      mcpReport,
      extraCreatedDirs: [path.join(ctx.paths.claude, "skills")],
    };
  },

  verifyTarget(ctx) {
    const issues = [];
    const claudeSkillsRoot = path.join(ctx.paths.claude, "skills");
    const canonicalSkillsRoot = path.join(ctx.paths.agents, "skills");

    if (!fs.existsSync(claudeSkillsRoot) || !fs.statSync(claudeSkillsRoot).isDirectory()) {
      issues.push({
        type: "missing-path",
        path: ".claude/skills",
        detail: "启用 claude 目标时缺少技能投影目录 .claude/skills",
      });
    } else {
      for (const skillName of sortedEntries(canonicalSkillsRoot)) {
        if (skillName === SELF_SKILL_NAME) {
          continue;
        }
        const canonicalSkillDir = path.join(canonicalSkillsRoot, skillName);
        if (!fs.statSync(canonicalSkillDir).isDirectory()) {
          continue;
        }
        const projectedSkillDir = path.join(claudeSkillsRoot, skillName);
        if (!fs.existsSync(projectedSkillDir) || !fs.statSync(projectedSkillDir).isDirectory()) {
          issues.push({
            type: "missing-skill",
            path: `.claude/skills/${skillName}/SKILL.md`,
            detail: "缺少对应 Canonical Store 技能的 Claude 投影目录",
          });
        }
      }

      issues.push(
        ...ctx.verifyHelpers.verifySkillsDir(ctx.workspace, claudeSkillsRoot, {
          allowedKeys: ["name", "description", "allowed-tools"],
        })
      );

      issues.push(
        ...ctx.verifyHelpers.scanActiveTextSurfaces(ctx.workspace, [claudeSkillsRoot], {
          excludeDirs: [path.join(claudeSkillsRoot, SELF_SKILL_NAME)],
          skillsRoots: [claudeSkillsRoot],
          extraStaleChecks: [
            {
              type: "stale-path",
              test: (text) => UNREWRITTEN_CLAUDE_RELATIVE_PATTERN.test(text),
              detail: "Claude 技能投影中仍包含未改写为 .agents/... 的跨目录相对引用",
            },
          ],
        })
      );
    }

    issues.push(...verifyClaudeMcpConfig(ctx));
    return issues;
  },
};
