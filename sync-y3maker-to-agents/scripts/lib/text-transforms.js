const fs = require("fs");
const path = require("path");

const { ACTIVE_PATH_PATTERN, CANONICAL_DIR, TEXT_SUFFIXES } = require("./constants");
const { normalizeSkillFrontmatterText } = require("./frontmatter");
const { hashBuffer, isDecodeError, normalizeSlashes, readText } = require("./fs-utils");

function rewriteCanonicalPaths(content) {
  return content
    .replace(/\.codemaker/g, CANONICAL_DIR)
    .replace(/\.codex/g, CANONICAL_DIR)
    .replace(/\.y3maker(?=[\\/])/g, CANONICAL_DIR)
    .replace(/<agent>(?=[\\/])/g, CANONICAL_DIR)
    .replace(/<codemaker>(?=[\\/])/g, CANONICAL_DIR);
}

/**
 * 供 Claude Skill Projection 复用的跨目录相对路径改写辅助函数：
 * 将 ../../rules/、../../memory/、../../knowledge/、../../templates/、../../spec-config.json
 * （含更深层级 ../../../ 及正斜杠、反斜杠、混合斜杠变体）统一改写回 .agents/...。
 */
function rewriteClaudeSkillRelativePaths(content) {
  return content.replace(
    /((?:\.\.[\\/]){2,})(rules[\\/]|memory[\\/]|knowledge[\\/]|templates[\\/]|spec-config\.json)/g,
    (_match, prefix, target) => {
      const isPureBackslash = !prefix.includes("/") && !target.includes("/");
      if (isPureBackslash) {
        return `${CANONICAL_DIR}\\${target}`;
      }
      return `${CANONICAL_DIR}/${target.replace(/\\/g, "/")}`;
    }
  );
}

function applyCanonicalTextTransforms(originalContent, options = {}) {
  const { targetFile, workspace } = options;
  let content = originalContent;
  const flags = {
    rewrittenLegacyPaths: false,
    normalizedSkillFrontmatter: false,
    appliedSpecialFixes: [],
  };

  const legacyRewritten = rewriteCanonicalPaths(content);
  if (legacyRewritten !== content) {
    content = legacyRewritten;
    flags.rewrittenLegacyPaths = true;
  }

  if (
    targetFile &&
    targetFile.includes(`${path.sep}y3-auto-test${path.sep}`) &&
    (path.basename(targetFile) === "admin_daemon.ps1" ||
      path.basename(targetFile) === "send_command.ps1")
  ) {
    const updated = content.replace(
      /\.\\\.agents\\skills\\desktop-automation/g,
      ".\\.agents\\skills\\y3-auto-test"
    );
    if (updated !== content) {
      content = updated;
      flags.appliedSpecialFixes.push("y3-auto-test-self-reference");
    }
  }

  if (
    targetFile &&
    targetFile.includes(`${path.sep}y3-obj-gen${path.sep}`) &&
    path.basename(targetFile) === "SKILL.md"
  ) {
    const updated = content.replace(
      "MCP 返回的数据会保存到临时文件 `.agents/cmtmp/` 目录下。由于数据量很大（56000+），需要使用脚本搜索：",
      "MCP 返回的数据应保存到一次性临时文件中，不要在 `.agents/` 下保留临时目录。由于数据量很大（56000+），需要使用脚本搜索："
    );
    if (updated !== content) {
      content = updated;
      flags.appliedSpecialFixes.push("y3-obj-gen-cmtmp-note");
    }
  }

  if (workspace && targetFile) {
    const skillRoot = path.join(workspace, CANONICAL_DIR, "skills");
    const relativeToSkillRoot = path.relative(skillRoot, targetFile);
    if (
      !relativeToSkillRoot.startsWith("..") &&
      !path.isAbsolute(relativeToSkillRoot) &&
      path.basename(targetFile) === "SKILL.md"
    ) {
      const [skillName, fileName, ...rest] = normalizeSlashes(relativeToSkillRoot).split("/");
      if (skillName && fileName === "SKILL.md" && rest.length === 0) {
        const normalized = normalizeSkillFrontmatterText(skillName, content, {
          preserveAllowedTools: false,
        });
        if (normalized !== content) {
          content = normalized;
          flags.normalizedSkillFrontmatter = true;
        }
      }
    }
  }

  const normalizedLf = content.replace(/\r\n/g, "\n");
  return {
    content: normalizedLf,
    buffer: Buffer.from(normalizedLf, "utf8"),
    flags,
  };
}

function materializeTextPlan(plan, workspace) {
  const original = readText(plan.sourceFile);
  return applyCanonicalTextTransforms(original, {
    targetFile: plan.targetFile,
    workspace,
  });
}

function materializeFilePlan(plan, workspace) {
  const rawBuffer = fs.readFileSync(plan.sourceFile);
  const sourceHash = hashBuffer(rawBuffer);
  if (!TEXT_SUFFIXES.has(path.extname(plan.sourceFile).toLowerCase())) {
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

  let materialized;
  try {
    materialized = materializeTextPlan(plan, workspace);
  } catch (error) {
    if (isDecodeError(error)) {
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

  return {
    sourceHash,
    renderedHash: hashBuffer(materialized.buffer),
    buffer: materialized.buffer,
    flags: materialized.flags,
    metadata: {},
  };
}

function extractCandidatePaths(text) {
  const results = [];
  for (const match of text.matchAll(ACTIVE_PATH_PATTERN)) {
    const candidate = match[1].trim();
    if (/[{}*<>]/.test(candidate)) {
      continue;
    }
    results.push(candidate);
  }
  return results;
}

module.exports = {
  applyCanonicalTextTransforms,
  extractCandidatePaths,
  materializeFilePlan,
  materializeTextPlan,
  rewriteCanonicalPaths,
  rewriteClaudeSkillRelativePaths,
};
