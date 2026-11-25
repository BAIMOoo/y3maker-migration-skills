const fs = require("fs");
const path = require("path");

const { getAdapter, normalizeTargets } = require("../adapters");
const {
  COPY_TREE_NAMES,
  EXTRA_AGENTS_TEMP_DIRS,
  LEGACY_ROOT_CANDIDATES,
  MCP_SCOPES,
  SELF_SKILL_NAME,
  TEMPLATE_TREE_NAME,
  TEXT_SUFFIXES,
} = require("./constants");
const {
  extractFrontmatter,
  extractFrontmatterField,
  getFrontmatterScalar,
  loadFrontmatterKeys,
} = require("./frontmatter");
const {
  assertSafeWorkspace,
  getUserHome,
  hashExistingFile,
  isDecodeError,
  isSameOrInsidePath,
  normalizeSlashes,
  readText,
  workspacePaths,
} = require("./fs-utils");
const { loadManifest, resolveManifestTargetFile } = require("./manifest");
const { inspectLegacyMcp } = require("./mcp-source");
const { extractCandidatePaths } = require("./text-transforms");

function hasTemplateSource(workspace) {
  return LEGACY_ROOT_CANDIDATES.some((rootName) => {
    const target = path.join(workspace, rootName, TEMPLATE_TREE_NAME);
    return fs.existsSync(target) && fs.statSync(target).isDirectory();
  });
}

function findFirstMcpManifestEntry(manifest) {
  const files = manifest && manifest.files && typeof manifest.files === "object" ? manifest.files : {};
  return Object.entries(files).find(([, entry]) => entry && entry.kind === "mcp-config") || null;
}

function normalizeReferenceCandidate(candidate) {
  return candidate
    .replace(/\s+§.*$/, "")
    .replace(/#.*$/, "")
    .trim();
}

function shouldSkipReference(candidate) {
  return (
    !candidate ||
    candidate.includes("$") ||
    candidate.includes("{") ||
    candidate.includes("}") ||
    candidate.includes("*") ||
    candidate.includes("<") ||
    candidate.includes(">") ||
    candidate.includes("...") ||
    candidate.includes("xxx") ||
    candidate.endsWith("/") ||
    candidate.endsWith("AutoTestPlan.md") ||
    candidate.endsWith("env_setup_done") ||
    candidate.includes("/report/") ||
    candidate.endsWith("/report")
  );
}

function resolveReferenceTarget(workspace, filePath, candidate, skillsRoots = []) {
  if (candidate.startsWith("scripts/")) {
    for (const skillsRoot of skillsRoots) {
      const relToSkills = path.relative(skillsRoot, filePath);
      if (!relToSkills.startsWith("..") && !path.isAbsolute(relToSkills)) {
        const skillName = relToSkills.split(path.sep, 1)[0];
        if (skillName) {
          const candidateTarget = path.join(
            skillsRoot,
            skillName,
            candidate.replaceAll("/", path.sep)
          );
          if (fs.existsSync(candidateTarget)) {
            return candidateTarget;
          }
        }
      }
    }
    return path.join(path.dirname(filePath), candidate.replaceAll("/", path.sep));
  }
  if (candidate.startsWith("../") || candidate.startsWith("./")) {
    return path.resolve(path.dirname(filePath), candidate);
  }
  return path.join(workspace, candidate.replaceAll("/", path.sep));
}

function walkFiles(target, onFile) {
  for (const name of fs.readdirSync(target).sort()) {
    const current = path.join(target, name);
    const stats = fs.statSync(current);
    if (stats.isDirectory()) {
      walkFiles(current, onFile);
    } else if (stats.isFile()) {
      onFile(current);
    }
  }
}

function verifySkillsDir(workspace, skillsRoot, options = {}) {
  const issues = [];
  const allowedKeys = options.allowedKeys || ["name", "description"];
  if (!fs.existsSync(skillsRoot)) {
    return issues;
  }

  for (const skillName of fs.readdirSync(skillsRoot).sort()) {
    const skillDir = path.join(skillsRoot, skillName);
    if (!fs.statSync(skillDir).isDirectory()) {
      continue;
    }
    const skillFile = path.join(skillDir, "SKILL.md");
    const relSkill = normalizeSlashes(path.relative(workspace, skillFile));
    if (!fs.existsSync(skillFile)) {
      issues.push({
        type: "missing-skill",
        path: relSkill,
        detail: "技能目录缺少 SKILL.md",
      });
      continue;
    }

    const raw = fs.readFileSync(skillFile);
    if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
      issues.push({
        type: "bom",
        path: relSkill,
        detail: "SKILL.md 仍包含 UTF-8 BOM",
      });
    }

    let frontmatter;
    try {
      ({ frontmatter } = extractFrontmatter(readText(skillFile)));
    } catch (error) {
      issues.push({
        type: "frontmatter",
        path: relSkill,
        detail: error.message,
      });
      continue;
    }

    const extraKeys = loadFrontmatterKeys(frontmatter).filter(
      (key) => !allowedKeys.includes(key)
    );
    if (extraKeys.length > 0) {
      issues.push({
        type: "frontmatter",
        path: relSkill,
        detail: `包含不允许的 frontmatter 字段：${extraKeys.join(", ")}`,
      });
    }

    if (getFrontmatterScalar(frontmatter, "name") !== skillName) {
      issues.push({
        type: "frontmatter",
        path: relSkill,
        detail: "frontmatter 中的 name 字段与技能目录名不一致",
      });
    }

    if (!extractFrontmatterField(frontmatter, "description")) {
      issues.push({
        type: "frontmatter",
        path: relSkill,
        detail: "frontmatter 缺少必填字段 description",
      });
    }
  }

  return issues;
}

function scanActiveTextSurfaces(workspace, surfaceRoots, options = {}) {
  const issues = [];
  const excludeDirs = options.excludeDirs || [];
  const skillsRoots = options.skillsRoots || [path.join(workspace, ".agents", "skills")];
  const extraStaleChecks = options.extraStaleChecks || [];

  for (const root of surfaceRoots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    walkFiles(root, (filePath) => {
      for (const excluded of excludeDirs) {
        if (isSameOrInsidePath(excluded, filePath)) {
          return;
        }
      }
      if (!TEXT_SUFFIXES.has(path.extname(filePath).toLowerCase())) {
        return;
      }

      const relPath = normalizeSlashes(path.relative(workspace, filePath));
      let text;
      try {
        text = readText(filePath);
      } catch (error) {
        if (isDecodeError(error)) {
          return;
        }
        throw error;
      }

      if (text.includes(".codemaker")) {
        issues.push({
          type: "stale-path",
          path: relPath,
          detail: "包含遗留路径 .codemaker",
        });
      }
      if (text.includes(".codex")) {
        issues.push({
          type: "stale-path",
          path: relPath,
          detail: "包含遗留路径 .codex",
        });
      }
      if (text.includes(".y3maker/") || text.includes(".y3maker\\")) {
        issues.push({
          type: "stale-path",
          path: relPath,
          detail: "包含遗留路径 .y3maker/",
        });
      }
      if (text.includes("<agent>/") || text.includes("<agent>\\")) {
        issues.push({
          type: "stale-path",
          path: relPath,
          detail: "包含未替换的占位符路径 <agent>/",
        });
      }
      if (text.includes("<codemaker>/") || text.includes("<codemaker>\\")) {
        issues.push({
          type: "stale-path",
          path: relPath,
          detail: "包含未替换的占位符路径 <codemaker>/",
        });
      }
      for (const check of extraStaleChecks) {
        if (check && typeof check.test === "function" && check.test(text, filePath)) {
          issues.push({
            type: check.type || "stale-path",
            path: relPath,
            detail: check.detail,
          });
        }
      }

      for (const rawCandidate of extractCandidatePaths(text)) {
        const candidate = normalizeReferenceCandidate(rawCandidate);
        if (shouldSkipReference(candidate)) {
          continue;
        }
        const target = resolveReferenceTarget(workspace, filePath, candidate, skillsRoots);
        if (!fs.existsSync(target)) {
          issues.push({
            type: "missing-reference",
            path: relPath,
            detail: `引用路径不存在：${candidate}`,
          });
        }
      }
    });
  }

  return issues;
}

function verifyWorkspace(workspace, options = {}) {
  const paths = workspacePaths(workspace);
  const homeDir = getUserHome(options.homeDir);

  assertSafeWorkspace(paths.workspace, {
    allowUnsafeWorkspace: Boolean(options.allowUnsafeWorkspace),
    homeDir,
  });

  if (options.mcpScope && !MCP_SCOPES.has(options.mcpScope)) {
    throw new Error(`无效的 --mcp-scope：${options.mcpScope}。可选值：project、user 或 skip。`);
  }

  const manifestExists = fs.existsSync(paths.manifest);
  const manifest = manifestExists ? loadManifest(paths.workspace) : { targets: [], files: {}, mcp: null };

  const effectiveTargets =
    normalizeTargets(options.targets) ||
    (Array.isArray(manifest.targets) && manifest.targets.length > 0
      ? normalizeTargets(manifest.targets)
      : []);

  const firstMcpEntry = findFirstMcpManifestEntry(manifest);
  const effectiveMcpScope =
    options.mcpScope ||
    (manifest.mcp && manifest.mcp.scope) ||
    (firstMcpEntry ? firstMcpEntry[1].targetScope : null) ||
    null;

  if (!fs.existsSync(paths.agents)) {
    return {
      ok: false,
      workspace: paths.workspace,
      targets: effectiveTargets,
      mcpScope: effectiveMcpScope,
      issues: [
        {
          type: "missing-path",
          path: ".agents",
          detail: "缺少 Canonical Store 目录 .agents",
        },
      ],
    };
  }

  const issues = [];
  const files = manifest.files && typeof manifest.files === "object" ? manifest.files : {};

  const requiredRoots = [...COPY_TREE_NAMES, "skills"];
  if (
    hasTemplateSource(paths.workspace) ||
    Object.values(files).some((entry) => entry && entry.kind === TEMPLATE_TREE_NAME)
  ) {
    requiredRoots.push(TEMPLATE_TREE_NAME);
  }

  for (const name of requiredRoots) {
    const target = path.join(paths.agents, name);
    if (!fs.existsSync(target)) {
      issues.push({
        type: "missing-path",
        path: normalizeSlashes(path.relative(paths.workspace, target)),
        detail: "缺少必需的迁移输出目录",
      });
    }
  }

  if (manifestExists) {
    for (const [target, entry] of Object.entries(files)) {
      if (entry.status === "blocked") {
        issues.push({
          type: "merge-blocked",
          path: target,
          detail: entry.blockedReason || "迁移同步处于 blocked 状态，等待人工合并",
        });
      }
      if (entry.status === "orphaned") {
        issues.push({
          type: "orphaned-target",
          path: target,
          detail: entry.blockedReason || "源文件已从 .y3maker 移除，但目标文件仍保留",
        });
      }
    }
  }

  for (const name of EXTRA_AGENTS_TEMP_DIRS) {
    const target = path.join(paths.agents, name);
    if (fs.existsSync(target)) {
      issues.push({
        type: "extra-temp-dir",
        path: normalizeSlashes(path.relative(paths.workspace, target)),
        detail: "不应在 .agents 下保留临时迁移目录",
      });
    }
  }

  const canonicalSkillsRoot = path.join(paths.agents, "skills");
  issues.push(
    ...verifySkillsDir(paths.workspace, canonicalSkillsRoot, {
      allowedKeys: ["name", "description"],
    })
  );

  const activeSurfaces = [
    path.join(paths.agents, "knowledge"),
    path.join(paths.agents, "rules"),
    canonicalSkillsRoot,
    path.join(paths.agents, "templates"),
  ];
  const selfSkillDir = path.join(canonicalSkillsRoot, SELF_SKILL_NAME);
  issues.push(
    ...scanActiveTextSurfaces(paths.workspace, activeSurfaces, {
      excludeDirs: [selfSkillDir],
      skillsRoots: [canonicalSkillsRoot],
    })
  );

  const legacyMcpPath = path.join(paths.legacy, "mcp_settings.json");
  const legacyMcp = inspectLegacyMcp(legacyMcpPath);
  const hasLegacyMcp = legacyMcp.exists;

  if (hasLegacyMcp && !effectiveMcpScope) {
    issues.push({
      type: "mcp-target-unselected",
      path: ".y3maker/mcp_settings.json",
      detail:
        "检测到遗留 MCP 配置但未记录显式 MCP 迁移范围；请使用 --mcp-scope project、user 或 skip 重新运行 apply",
    });
  }

  const verifyHelpers = {
    hashExistingFile,
    normalizeReferenceCandidate,
    normalizeSlashes,
    readText,
    resolveManifestTargetFile: (targetRelative, entry) =>
      resolveManifestTargetFile(paths.workspace, targetRelative, entry, { homeDir }),
    resolveReferenceTarget,
    scanActiveTextSurfaces,
    shouldSkipReference,
    verifySkillsDir,
  };

  for (const targetId of effectiveTargets) {
    const adapter = getAdapter(targetId);
    if (typeof adapter.verifyTarget === "function") {
      const adapterIssues = adapter.verifyTarget({
        workspace: paths.workspace,
        homeDir,
        paths,
        manifest,
        targets: effectiveTargets,
        mcpScope: effectiveMcpScope,
        hasLegacyMcp,
        legacyMcp,
        verifyHelpers,
      });
      if (Array.isArray(adapterIssues)) {
        issues.push(...adapterIssues);
      }
    }
  }

  return {
    ok: issues.length === 0,
    workspace: paths.workspace,
    targets: effectiveTargets,
    mcpScope: effectiveMcpScope,
    issues,
  };
}

module.exports = {
  normalizeReferenceCandidate,
  resolveReferenceTarget,
  scanActiveTextSurfaces,
  shouldSkipReference,
  verifySkillsDir,
  verifyWorkspace,
};
