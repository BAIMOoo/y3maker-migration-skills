const fs = require("fs");
const path = require("path");

const { MANIFEST_RELATIVE_PATH } = require("./constants");
const {
  collectFiles,
  getUserHome,
  hashExistingFile,
  isSameOrInsidePath,
  readText,
} = require("./fs-utils");
const { resolveManifestTargetFile } = require("./manifest");

const LEGACY_MANIFEST_SPECS = [
  {
    harness: "claude",
    rootDir: ".claude",
    manifestPath: ".claude/migration/y3maker-manifest.json",
    expectedTool: "sync-y3maker-to-claude",
  },
  {
    harness: "codex",
    rootDir: ".codex",
    manifestPath: ".codex/migration/y3maker-manifest.json",
    expectedTool: "sync-y3maker-to-codex",
  },
];

const LEGACY_ASSET_SUBDIRS = ["knowledge", "memory", "rules", "skills", "templates"];
const LEGACY_ALL_SUBDIRS = [...LEGACY_ASSET_SUBDIRS, "migration"];

function normalizeRelativePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function resolveSafeProjectPath(workspace, targetPath) {
  if (!targetPath || path.isAbsolute(targetPath) || /^[A-Za-z]:[\\/]/.test(targetPath)) {
    return null;
  }
  const diskPath = path.resolve(workspace, targetPath);
  return isSameOrInsidePath(workspace, diskPath) ? diskPath : null;
}

function resolveLegacySubdir(rootDir, targetPath) {
  const prefix = `${rootDir}/`;
  if (!targetPath.startsWith(prefix)) {
    return null;
  }
  const firstSegment = targetPath.slice(prefix.length).split("/", 1)[0];
  if (!LEGACY_ALL_SUBDIRS.includes(firstSegment)) {
    return null;
  }
  return `${rootDir}/${firstSegment}`;
}

function isLocallyModified(entry, currentHash) {
  if (!entry.targetHash && !entry.renderedHash) {
    return true;
  }
  if (entry.targetHash && currentHash !== entry.targetHash) {
    return true;
  }
  if (entry.renderedHash && currentHash !== entry.renderedHash) {
    return true;
  }
  return false;
}

function loadCanonicalManifestSafe(workspace, options = {}) {
  if (options.canonicalManifest && typeof options.canonicalManifest === "object") {
    return options.canonicalManifest;
  }
  const canonicalManifest = path.join(workspace, MANIFEST_RELATIVE_PATH.replaceAll("/", path.sep));
  if (!fs.existsSync(canonicalManifest) || !fs.statSync(canonicalManifest).isFile()) {
    return { targets: [], files: {} };
  }
  try {
    const parsed = JSON.parse(readText(canonicalManifest));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        targets: Array.isArray(parsed.targets) ? parsed.targets : [],
        files: parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files)
          ? parsed.files
          : {},
      };
    }
  } catch (_error) {
    return { targets: [], files: {} };
  }
  return { targets: [], files: {} };
}

function resolveActiveTargets(canonicalManifest, options = {}) {
  if (Array.isArray(options.targets)) {
    return new Set(options.targets.map((target) => String(target).toLowerCase()));
  }
  if (canonicalManifest && Array.isArray(canonicalManifest.targets)) {
    return new Set(canonicalManifest.targets.map((target) => String(target).toLowerCase()));
  }
  return new Set();
}

function isActivelyManagedSurface(
  targetPath,
  subdir,
  canonicalFiles,
  activeProtectedDirectoriesSet,
  activeProtectedPathsSet
) {
  const isProtectedSurface =
    activeProtectedPathsSet.has(targetPath) ||
    (Boolean(subdir) && activeProtectedDirectoriesSet.has(subdir));
  if (!isProtectedSurface) {
    return false;
  }
  const canonicalEntry = canonicalFiles && canonicalFiles[targetPath];
  return Boolean(canonicalEntry && canonicalEntry.status === "managed");
}

function isUserScopedEntry(targetPath, entry) {
  return Boolean(
    (entry && entry.targetScope === "user") || /^~[\\/]/.test(String(targetPath || ""))
  );
}

function classifyUserScopedStatus(entry, currentHash) {
  if (currentHash === null) {
    return "missing";
  }
  if (entry.status === "blocked") {
    return "modified";
  }
  if (entry.status === "orphaned") {
    return isLocallyModified(entry, currentHash) ? "modified" : "orphaned";
  }
  return isLocallyModified(entry, currentHash) ? "modified" : "unmodified";
}

function parseLegacyManifest(manifestFile) {
  let rawText;
  try {
    rawText = readText(manifestFile);
  } catch (error) {
    return {
      ok: false,
      error: `无法解码旧版迁移清单文件：${error.message}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return {
      ok: false,
      error: `旧版迁移清单不是合法 JSON：${error.message}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "旧版迁移清单顶层结构必须为 JSON 对象",
    };
  }
  if (!parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
    return {
      ok: false,
      error: "旧版迁移清单缺少合法的 files 对象映射",
    };
  }
  return { ok: true, parsed };
}

function collectPresentDirectories(workspace, rootDir) {
  const presentDirectories = [];
  for (const subdirName of LEGACY_ALL_SUBDIRS) {
    const dirRel = `${rootDir}/${subdirName}`;
    const dirFull = path.join(workspace, dirRel.replaceAll("/", path.sep));
    if (fs.existsSync(dirFull) && fs.statSync(dirFull).isDirectory()) {
      presentDirectories.push(dirRel);
    }
  }
  presentDirectories.sort();
  return presentDirectories;
}

function collectActiveProtections(workspace, spec, presentDirectories, activeTargets, filesMap) {
  const activeProtectedDirectoriesSet = new Set();
  const activeProtectedPathsSet = new Set();

  if (spec.harness === "claude" && activeTargets.has("claude")) {
    if (presentDirectories.includes(".claude/skills")) {
      activeProtectedDirectoriesSet.add(".claude/skills");
      activeProtectedPathsSet.add(".claude/skills");
    }
    const projectMcpFile = path.join(workspace, ".mcp.json");
    if (
      (fs.existsSync(projectMcpFile) && fs.statSync(projectMcpFile).isFile()) ||
      (filesMap && Object.prototype.hasOwnProperty.call(filesMap, ".mcp.json"))
    ) {
      activeProtectedPathsSet.add(".mcp.json");
    }
  }

  if (spec.harness === "codex" && activeTargets.has("codex")) {
    const codexConfigFile = path.join(workspace, ".codex", "config.toml");
    if (
      (fs.existsSync(codexConfigFile) && fs.statSync(codexConfigFile).isFile()) ||
      (filesMap && Object.prototype.hasOwnProperty.call(filesMap, ".codex/config.toml"))
    ) {
      activeProtectedPathsSet.add(".codex/config.toml");
    }
  }

  return { activeProtectedDirectoriesSet, activeProtectedPathsSet };
}

function appendActiveProtectionGuidance(
  spec,
  presentDirectories,
  activeProtectedDirectoriesSet,
  activeProtectedPathsSet,
  warnings,
  cleanupGuidance
) {
  if (activeProtectedDirectoriesSet.has(".claude/skills")) {
    warnings.push(
      "当前已启用 claude 宿主，.claude/skills 正由 Skill Projection（技能投影）活跃使用，切勿整目录删除 .claude/ 或 .claude/skills。"
    );
    cleanupGuidance.push(
      "请务必保留活跃目录 .claude/skills（由 claude 宿主的 Skill Projection 使用），仅在核对后按需手动清理其余旧子目录。"
    );
  } else if (spec.harness === "claude" && presentDirectories.includes(".claude/skills")) {
    cleanupGuidance.push(
      "提示：若后续计划启用 claude 宿主，.claude/skills 将用于承载 Skill Projection（技能投影），清理 .claude/skills 前请确认宿主选择。"
    );
  }
  if (activeProtectedPathsSet.has(".mcp.json")) {
    cleanupGuidance.push(
      "当前已启用 claude 宿主，项目根目录 .mcp.json 为 Claude Code 项目级 MCP 配置路径，切勿误删。"
    );
  }
  if (activeProtectedPathsSet.has(".codex/config.toml")) {
    cleanupGuidance.push(
      "当前已启用 codex 宿主，.codex/config.toml 为 Codex 项目级 MCP 配置路径，清理旧子目录时切勿整目录删除 .codex/。"
    );
  }
}

function inspectSingleLegacyMigration(workspace, spec, context) {
  const manifestFile = path.join(workspace, spec.manifestPath.replaceAll("/", path.sep));
  const activeTargets = context.activeTargets;
  const canonicalFiles = context.canonicalFiles || {};
  const homeDir = context.homeDir;
  const presentDirectories = collectPresentDirectories(workspace, spec.rootDir);
  const manifestResult = parseLegacyManifest(manifestFile);

  if (!manifestResult.ok) {
    const { activeProtectedDirectoriesSet, activeProtectedPathsSet } = collectActiveProtections(
      workspace,
      spec,
      presentDirectories,
      activeTargets,
      null
    );
    const activeProtectedDirectories = [...activeProtectedDirectoriesSet].sort();
    const activeProtectedPaths = [...activeProtectedPathsSet].sort();
    const reviewRequiredDirectories = presentDirectories
      .filter((dirRel) => !activeProtectedDirectoriesSet.has(dirRel))
      .sort();
    const warnings = [
      `旧版迁移清单 ${spec.manifestPath} 解析失败（${manifestResult.error}），无法校验旧副本哈希，请勿自动或盲目删除 ${spec.rootDir}/。`,
    ];
    const cleanupGuidance = [
      `过渡盘点仅执行只读检查，绝不会自动删除、移动或改写 ${spec.rootDir}/ 中的历史副本。`,
      `由于 ${spec.manifestPath} 损坏或结构非法，无法自动区分未改动文件与本地手工改动；请在清理前逐一人工核对 ${spec.rootDir}/ 中的全部历史文件。`,
    ];
    appendActiveProtectionGuidance(
      spec,
      presentDirectories,
      activeProtectedDirectoriesSet,
      activeProtectedPathsSet,
      warnings,
      cleanupGuidance
    );

    return {
      harness: spec.harness,
      rootDir: spec.rootDir,
      manifestPath: spec.manifestPath,
      manifestValid: false,
      manifestError: manifestResult.error,
      tool: spec.expectedTool,
      updatedAt: null,
      trackedFiles: 0,
      presentDirectories,
      activeProtectedDirectories,
      activeProtectedPaths,
      safeToCleanDirectories: [],
      reviewRequiredDirectories,
      files: {
        unmodified: [],
        modified: [],
        orphaned: [],
        missing: [],
        untracked: [],
      },
      manualReviewRequired: [],
      userScopedFiles: [],
      warnings,
      cleanupGuidance,
    };
  }

  const parsed = manifestResult.parsed;
  const filesMap = parsed.files;
  const { activeProtectedDirectoriesSet, activeProtectedPathsSet } = collectActiveProtections(
    workspace,
    spec,
    presentDirectories,
    activeTargets,
    filesMap
  );

  const unmodified = [];
  const modified = [];
  const orphaned = [];
  const missing = [];
  const untracked = [];
  const manualReviewRequired = [];
  const userScopedFiles = [];
  const reviewDirs = new Set();
  const warnings = [];
  const trackedProjectPaths = new Set([spec.manifestPath]);

  for (const key of Object.keys(filesMap).sort()) {
    const entry = filesMap[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      const targetPath = normalizeRelativePath(key);
      const diskPath = resolveSafeProjectPath(workspace, targetPath);
      if (!diskPath) {
        warnings.push(
          `旧版迁移清单 ${spec.manifestPath} 包含越界或非法条目「${targetPath}」，已跳过磁盘读取。`
        );
        continue;
      }
      trackedProjectPaths.add(targetPath);
      const reason = "旧版迁移清单中该条目结构损坏，无法校验文件哈希，清理前请先人工核对";
      warnings.push(`旧版迁移清单 ${spec.manifestPath} 中条目「${targetPath}」结构损坏，已列入人工核对清单。`);
      manualReviewRequired.push({
        path: targetPath,
        category: "invalid-entry",
        kind: null,
        source: null,
        reason,
      });
      const subdir = resolveLegacySubdir(spec.rootDir, targetPath);
      if (subdir) {
        reviewDirs.add(subdir);
      }
      continue;
    }

    const targetPath = normalizeRelativePath(entry.target || key);

    if (isUserScopedEntry(targetPath, entry)) {
      const diskPath = resolveManifestTargetFile(
        workspace,
        targetPath,
        { targetScope: "user" },
        { homeDir }
      );
      const safeDiskPath = isSameOrInsidePath(homeDir, diskPath) ? diskPath : null;
      if (!safeDiskPath) {
        warnings.push(
          `旧版迁移清单 ${spec.manifestPath} 包含越界用户级路径「${targetPath}」，已跳过磁盘读取。`
        );
      }
      const currentHash = safeDiskPath ? hashExistingFile(safeDiskPath) : null;
      userScopedFiles.push({
        path: targetPath,
        kind: entry.kind || null,
        source: entry.source || null,
        targetScope: "user",
        manifestStatus: entry.status || "managed",
        status: safeDiskPath ? classifyUserScopedStatus(entry, currentHash) : "invalid-path",
        note: "用户级配置文件位于工作区之外，不属于项目旧版迁移副本清理候选，请按宿主配置单独管理",
      });
      continue;
    }

    const diskPath = resolveSafeProjectPath(workspace, targetPath);
    if (!diskPath) {
      warnings.push(
        `旧版迁移清单 ${spec.manifestPath} 包含超出工作区边界的路径「${targetPath}」，已跳过磁盘读取。`
      );
      continue;
    }

    trackedProjectPaths.add(targetPath);
    const currentHash = hashExistingFile(diskPath);
    if (currentHash === null) {
      missing.push(targetPath);
      continue;
    }

    const subdir = resolveLegacySubdir(spec.rootDir, targetPath);
    if (
      isActivelyManagedSurface(
        targetPath,
        subdir,
        canonicalFiles,
        activeProtectedDirectoriesSet,
        activeProtectedPathsSet
      )
    ) {
      continue;
    }
    if (entry.status === "orphaned") {
      const locallyModified = isLocallyModified(entry, currentHash);
      const reason = locallyModified
        ? "源文件已从 .y3maker 移除且旧副本存在本地手工改动，未迁移到 .agents/，清理前请先核对并备份或合并"
        : "源文件已从 .y3maker 移除，该旧副本未迁移到 .agents/，清理前请先确认是否仍需保留";
      orphaned.push({
        path: targetPath,
        kind: entry.kind || null,
        source: entry.source || null,
        locallyModified,
        reason,
      });
      if (locallyModified) {
        modified.push({
          path: targetPath,
          kind: entry.kind || null,
          source: entry.source || null,
          manifestStatus: "orphaned",
          reason,
        });
      }
      manualReviewRequired.push({
        path: targetPath,
        category: locallyModified ? "modified" : "orphaned",
        kind: entry.kind || null,
        source: entry.source || null,
        reason,
      });
      if (subdir) {
        reviewDirs.add(subdir);
      }
      continue;
    }

    if (entry.status === "blocked") {
      const reason = entry.blockedReason
        ? `旧版迁移清单已标记为冲突阻塞（${entry.blockedReason}），清理前请先核对并合并本地改动`
        : "旧版迁移清单已标记为冲突阻塞（blocked），清理前请先核对并合并本地改动";
      modified.push({
        path: targetPath,
        kind: entry.kind || null,
        source: entry.source || null,
        manifestStatus: "blocked",
        reason,
      });
      manualReviewRequired.push({
        path: targetPath,
        category: "modified",
        kind: entry.kind || null,
        source: entry.source || null,
        reason,
      });
      if (subdir) {
        reviewDirs.add(subdir);
      }
      continue;
    }

    if (isLocallyModified(entry, currentHash)) {
      const reason =
        !entry.targetHash && !entry.renderedHash
          ? "旧版迁移清单缺少哈希基线，无法确认是否被手工改动，清理前请先人工核对"
          : "磁盘文件哈希与旧版迁移清单基线不一致，存在本地手工改动，清理前请先核对合并";
      modified.push({
        path: targetPath,
        kind: entry.kind || null,
        source: entry.source || null,
        manifestStatus: entry.status || "managed",
        reason,
      });
      manualReviewRequired.push({
        path: targetPath,
        category: "modified",
        kind: entry.kind || null,
        source: entry.source || null,
        reason,
      });
      if (subdir) {
        reviewDirs.add(subdir);
      }
      continue;
    }

    unmodified.push(targetPath);
  }

  for (const dirRel of presentDirectories) {
    if (activeProtectedDirectoriesSet.has(dirRel)) {
      continue;
    }
    const dirFull = path.join(workspace, dirRel.replaceAll("/", path.sep));
    for (const relFile of collectFiles(dirFull)) {
      const fullRel = `${dirRel}/${relFile}`;
      if (trackedProjectPaths.has(fullRel)) {
        continue;
      }
      untracked.push(fullRel);
      manualReviewRequired.push({
        path: fullRel,
        category: "untracked",
        kind: null,
        source: null,
        reason: "旧版迁移副本目录中存在未被旧版迁移清单记录的本地文件，清理前请先确认是否需要保留",
      });
      reviewDirs.add(dirRel);
    }
  }

  unmodified.sort();
  modified.sort((a, b) => a.path.localeCompare(b.path));
  orphaned.sort((a, b) => a.path.localeCompare(b.path));
  missing.sort();
  untracked.sort();
  manualReviewRequired.sort((a, b) => a.path.localeCompare(b.path));
  userScopedFiles.sort((a, b) => a.path.localeCompare(b.path));

  const activeProtectedDirectories = [...activeProtectedDirectoriesSet].sort();
  const activeProtectedPaths = [...activeProtectedPathsSet].sort();
  const reviewRequiredDirectories = [...reviewDirs]
    .filter((dirRel) => !activeProtectedDirectoriesSet.has(dirRel))
    .sort();
  const safeToCleanDirectories = [];
  for (const dirRel of presentDirectories) {
    if (activeProtectedDirectoriesSet.has(dirRel)) {
      continue;
    }
    if (dirRel === `${spec.rootDir}/migration`) {
      if (manualReviewRequired.length === 0 && !reviewDirs.has(dirRel)) {
        safeToCleanDirectories.push(dirRel);
      }
      continue;
    }
    if (!reviewDirs.has(dirRel)) {
      safeToCleanDirectories.push(dirRel);
    }
  }
  safeToCleanDirectories.sort();

  const cleanupGuidance = [
    `过渡盘点仅执行只读检查，绝不会自动删除、移动或改写 ${spec.rootDir}/ 中的历史副本。`,
  ];

  appendActiveProtectionGuidance(
    spec,
    presentDirectories,
    activeProtectedDirectoriesSet,
    activeProtectedPathsSet,
    warnings,
    cleanupGuidance
  );

  if (modified.length > 0) {
    warnings.push(
      `检测到旧版 ${spec.rootDir}/ 中有 ${modified.length} 个文件存在本地手工改动或历史冲突，清理前请先核对并合并到 Legacy Source（.y3maker/）或 Canonical Store（.agents/）。`
    );
  }
  if (orphaned.length > 0) {
    warnings.push(
      `检测到旧版 ${spec.rootDir}/ 中有 ${orphaned.length} 个孤立文件（orphaned，源文件已从 .y3maker/ 移除），清理前请先确认是否仍需保留。`
    );
  }
  if (untracked.length > 0) {
    warnings.push(
      `检测到旧版 ${spec.rootDir}/ 子目录中存在 ${untracked.length} 个未被旧版迁移清单记录的本地文件，清理前请先人工确认。`
    );
  }
  if (manualReviewRequired.length > 0) {
    cleanupGuidance.push(
      `请先逐一核对 manualReviewRequired 清单中的 ${manualReviewRequired.length} 个文件（涉及目录：${reviewRequiredDirectories.join("、") || spec.rootDir}），确认改动已合并后再手动清理。`
    );
  }
  if (safeToCleanDirectories.length > 0) {
    cleanupGuidance.push(
      `以下旧版迁移子目录未检测到本地改动，确认不再需要旧版副本后可评估手动清理：${safeToCleanDirectories.join("、")}。`
    );
  }
  if (manualReviewRequired.length > 0 && presentDirectories.includes(`${spec.rootDir}/migration`)) {
    cleanupGuidance.push(
      `请保留 ${spec.rootDir}/migration 直至上述需人工核对的文件处理完毕，以便保留哈希比对基线。`
    );
  }
  if (userScopedFiles.length > 0) {
    cleanupGuidance.push(
      `旧版迁移清单还包含 ${userScopedFiles.length} 个用户级配置文件（已单独列在 userScopedFiles），它们位于工作区之外，不属于项目旧版迁移副本清理范围。`
    );
  }

  return {
    harness: spec.harness,
    rootDir: spec.rootDir,
    manifestPath: spec.manifestPath,
    manifestValid: true,
    tool: parsed.tool || spec.expectedTool,
    updatedAt: parsed.updatedAt || null,
    trackedFiles: Object.keys(filesMap).length,
    presentDirectories,
    activeProtectedDirectories,
    activeProtectedPaths,
    safeToCleanDirectories,
    reviewRequiredDirectories,
    files: {
      unmodified,
      modified,
      orphaned,
      missing,
      untracked,
    },
    manualReviewRequired,
    userScopedFiles,
    warnings,
    cleanupGuidance,
  };
}

/**
 * 只读扫描工作区中是否存在旧版 .codex/ 与 .claude/ 迁移清单，
 * 并通过与旧版一致的 LF 规范化哈希比对，区分可安全评估清理与需人工核对的文件。
 * 严格保持只读约定：绝不删除、移动或改写任何历史目录与文件。
 */
function detectLegacyTransitions(workspace, options = {}) {
  const root = path.resolve(workspace);
  const homeDir = getUserHome(options.homeDir);
  const canonicalManifest = loadCanonicalManifestSafe(root, options);
  const activeTargets = resolveActiveTargets(canonicalManifest, options);
  const canonicalFiles =
    canonicalManifest && canonicalManifest.files && typeof canonicalManifest.files === "object"
      ? canonicalManifest.files
      : {};
  const legacyMigrations = [];

  for (const spec of LEGACY_MANIFEST_SPECS) {
    const manifestFile = path.join(root, spec.manifestPath.replaceAll("/", path.sep));
    if (!fs.existsSync(manifestFile) || !fs.statSync(manifestFile).isFile()) {
      continue;
    }
    legacyMigrations.push(
      inspectSingleLegacyMigration(root, spec, { activeTargets, canonicalFiles, homeDir })
    );
  }

  if (legacyMigrations.length === 0) {
    return {
      detected: false,
      legacyMigrations: [],
    };
  }

  const aggregatedWarnings = [];
  const allSafeDirs = new Set();
  const allProtectedDirs = new Set();
  for (const item of legacyMigrations) {
    for (const warning of item.warnings) {
      if (!aggregatedWarnings.includes(warning)) {
        aggregatedWarnings.push(warning);
      }
    }
    for (const dir of item.safeToCleanDirectories) {
      allSafeDirs.add(dir);
    }
    for (const dir of item.activeProtectedDirectories) {
      allProtectedDirs.add(dir);
    }
  }

  return {
    detected: true,
    legacyMigrations,
    summary: {
      detectedHarnesses: legacyMigrations.map((item) => item.harness),
      totalTrackedFiles: legacyMigrations.reduce((sum, item) => sum + item.trackedFiles, 0),
      unmodifiedCount: legacyMigrations.reduce((sum, item) => sum + item.files.unmodified.length, 0),
      modifiedCount: legacyMigrations.reduce((sum, item) => sum + item.files.modified.length, 0),
      orphanedCount: legacyMigrations.reduce((sum, item) => sum + item.files.orphaned.length, 0),
      missingCount: legacyMigrations.reduce((sum, item) => sum + item.files.missing.length, 0),
      untrackedCount: legacyMigrations.reduce((sum, item) => sum + item.files.untracked.length, 0),
      manualReviewCount: legacyMigrations.reduce(
        (sum, item) => sum + item.manualReviewRequired.length,
        0
      ),
      userScopedCount: legacyMigrations.reduce(
        (sum, item) => sum + item.userScopedFiles.length,
        0
      ),
      safeToCleanDirectories: [...allSafeDirs].sort(),
      activeProtectedDirectories: [...allProtectedDirs].sort(),
      hasMalformedManifest: legacyMigrations.some((item) => !item.manifestValid),
    },
    warnings: aggregatedWarnings,
  };
}

module.exports = {
  detectLegacyTransitions,
};
