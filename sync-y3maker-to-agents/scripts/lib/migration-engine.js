const fs = require("fs");
const path = require("path");

const { getAdapters, normalizeTargets } = require("../adapters");
const {
  CANONICAL_DIR,
  CANONICAL_DIR_NAMES,
  COPY_TREE_NAMES,
  DEFAULT_OPENSPEC_DIRS,
  EXTRA_AGENTS_TEMP_DIRS,
  LEGACY_ROOT_CANDIDATES,
  MANIFEST_RELATIVE_PATH,
  MANIFEST_VERSION,
  MCP_SCOPES,
  SKILL_ITEM_EXCLUDES,
  TEMPLATE_TREE_NAME,
  TOOL_NAME,
} = require("./constants");
const {
  assertSafeWorkspace,
  collectFiles,
  ensureDir,
  getUserHome,
  hashBuffer,
  hashExistingFile,
  normalizeSlashes,
  readText,
  sortedEntries,
  workspacePaths,
  writeBuffer,
} = require("./fs-utils");
const { detectLegacyTransitions } = require("./legacy-transition");
const {
  blockedManifestRecord,
  decidePlanAction,
  loadManifest,
  managedManifestRecord,
  orphanedManifestRecord,
  resolveManifestTargetFile,
  writeManifest,
} = require("./manifest");
const { inspectLegacyMcp } = require("./mcp-source");
const { materializeFilePlan } = require("./text-transforms");

function normalizeMcpScope(mcpScope) {
  if (!mcpScope) {
    return null;
  }
  if (!MCP_SCOPES.has(mcpScope)) {
    throw new Error(`无效的 MCP 迁移范围：${mcpScope}。可选值：project、user 或 skip。`);
  }
  return mcpScope;
}

function resolveLegacyTreeRoot(workspace, treeName) {
  for (const rootName of LEGACY_ROOT_CANDIDATES) {
    const candidate = path.join(workspace, rootName, treeName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return { rootName, root: candidate };
    }
  }
  return null;
}

function appendUnique(list, items) {
  if (!Array.isArray(items)) {
    return;
  }
  for (const item of items) {
    if (item && !list.includes(item)) {
      list.push(item);
    }
  }
}

function hasUpstreamSource(workspace, previous, seenTargets) {
  if (!previous || typeof previous.source !== "string" || !previous.source) {
    return false;
  }
  if (previous.source.startsWith(`${CANONICAL_DIR}/`)) {
    return seenTargets.has(previous.source);
  }
  const sourceFile = path.join(workspace, previous.source.replaceAll("/", path.sep));
  return fs.existsSync(sourceFile) && fs.statSync(sourceFile).isFile();
}

function inventoryWorkspace(workspace, options = {}) {
  const paths = workspacePaths(workspace);
  const homeDir = getUserHome(options.homeDir);
  const manifest = loadManifest(paths.workspace);
  const manifestEntries = Object.values(manifest.files || {});
  const legacyMcpPath = path.join(paths.legacy, "mcp_settings.json");
  const legacyMcp = inspectLegacyMcp(legacyMcpPath);
  const legacyTransition = detectLegacyTransitions(paths.workspace, {
    homeDir,
    targets: manifest.targets || [],
    canonicalManifest: manifest,
  });

  const result = {
    workspace: paths.workspace,
    exists: {
      ".y3maker": fs.existsSync(paths.legacy),
      ".codemaker": fs.existsSync(paths.codemaker),
      ".agents": fs.existsSync(paths.agents),
      ".codex": fs.existsSync(paths.codex),
      ".claude": fs.existsSync(paths.claude),
      ".dsh": fs.existsSync(paths.dsh),
      ".mcp.json": fs.existsSync(paths.projectMcp),
      "AGENTS.md": fs.existsSync(paths.agentsMd),
      "CLAUDE.md": fs.existsSync(paths.claudeMd),
    },
    manifest: {
      path: MANIFEST_RELATIVE_PATH,
      exists: fs.existsSync(paths.manifest),
      targets: manifest.targets || [],
      mcpScope: manifest.mcp ? manifest.mcp.scope || null : null,
      trackedFiles: manifestEntries.length,
      blockedFiles: manifestEntries.filter((entry) => entry.status === "blocked").length,
      orphanedTargets: manifestEntries.filter((entry) => entry.status === "orphaned").length,
    },
    legacy: {},
    codemaker: {},
    legacyTransition,
  };

  if (fs.existsSync(paths.legacy)) {
    result.legacy = {
      entries: sortedEntries(paths.legacy),
      skills: sortedEntries(path.join(paths.legacy, "skills")).filter((name) =>
        fs.statSync(path.join(paths.legacy, "skills", name)).isDirectory()
      ),
      rules: sortedEntries(path.join(paths.legacy, "rules")).filter((name) =>
        fs.statSync(path.join(paths.legacy, "rules", name)).isFile()
      ),
      knowledge: sortedEntries(path.join(paths.legacy, "knowledge")),
      memory: sortedEntries(path.join(paths.legacy, "memory")),
      templates: sortedEntries(path.join(paths.legacy, "templates")),
      hasMcpSettings: legacyMcp.exists,
      mcp: legacyMcp.exists
        ? {
            empty: legacyMcp.empty,
            enabled: legacyMcp.enabled,
            disabled: legacyMcp.disabled,
            warnings: legacyMcp.warnings,
          }
        : null,
    };
  }

  if (fs.existsSync(paths.codemaker)) {
    const codemakerTemplates = path.join(paths.codemaker, "templates");
    result.codemaker = {
      entries: sortedEntries(paths.codemaker),
      templates: sortedEntries(codemakerTemplates),
      hasTemplates: fs.existsSync(codemakerTemplates) && fs.statSync(codemakerTemplates).isDirectory(),
    };
  }

  return result;
}

function buildMigrationPlan(workspace, options = {}) {
  const paths = workspacePaths(workspace);
  const homeDir = getUserHome(options.homeDir);
  const manifest = options.manifest || loadManifest(paths.workspace);

  const targets =
    normalizeTargets(options.targets) ||
    (Array.isArray(manifest.targets) && manifest.targets.length > 0
      ? normalizeTargets(manifest.targets)
      : null);

  if (!targets || targets.length === 0) {
    throw new Error(
      "未指定目标宿主（--targets）。请传入逗号分隔的目标宿主（codex、claude、antigravity/agy、dsh）或 all。"
    );
  }

  const mcpScope = normalizeMcpScope(options.mcpScope);
  const legacyMcp = inspectLegacyMcp(path.join(paths.legacy, "mcp_settings.json"));
  if (legacyMcp.exists && !mcpScope) {
    throw new Error(
      "检测到遗留 MCP 配置（.y3maker/mcp_settings.json），禁止静默修改 MCP 配置。请显式传入 --mcp-scope project、--mcp-scope user 或 --mcp-scope skip。"
    );
  }

  const filePlans = [];
  const canonicalSkillPlans = [];
  const copied = { knowledge: [], memory: [], rules: [], skills: [], templates: [] };

  for (const name of COPY_TREE_NAMES) {
    const sourceRoot = path.join(paths.legacy, name);
    const targetRoot = path.join(paths.agents, name);
    if (!fs.existsSync(sourceRoot)) {
      continue;
    }
    copied[name] = sortedEntries(sourceRoot);
    for (const relativeFile of collectFiles(sourceRoot)) {
      const sourceFile = path.join(sourceRoot, relativeFile.replaceAll("/", path.sep));
      const targetFile = path.join(targetRoot, relativeFile.replaceAll("/", path.sep));
      filePlans.push({
        kind: name,
        sourceFile,
        sourceRelative: normalizeSlashes(path.relative(paths.workspace, sourceFile)),
        targetFile,
        targetRelative: normalizeSlashes(path.relative(paths.workspace, targetFile)),
        targetScope: "project",
      });
    }
  }

  const skillsRoot = path.join(paths.legacy, "skills");
  const targetSkillsRoot = path.join(paths.agents, "skills");
  if (fs.existsSync(skillsRoot)) {
    for (const skillName of sortedEntries(skillsRoot)) {
      const sourceSkillDir = path.join(skillsRoot, skillName);
      if (!fs.statSync(sourceSkillDir).isDirectory()) {
        continue;
      }
      copied.skills.push(skillName);
      const excluded = SKILL_ITEM_EXCLUDES[skillName] || new Set();
      for (const relativeFile of collectFiles(sourceSkillDir, {
        skipRelativePath(relativePath) {
          const topLevelName = relativePath.split("/", 1)[0];
          return excluded.has(topLevelName);
        },
      })) {
        const sourceFile = path.join(sourceSkillDir, relativeFile.replaceAll("/", path.sep));
        const targetFile = path.join(
          targetSkillsRoot,
          skillName,
          relativeFile.replaceAll("/", path.sep)
        );
        const plan = {
          kind: "skill",
          skillName,
          relativeSkillFile: relativeFile,
          sourceFile,
          sourceRelative: normalizeSlashes(path.relative(paths.workspace, sourceFile)),
          targetFile,
          targetRelative: normalizeSlashes(path.relative(paths.workspace, targetFile)),
          targetScope: "project",
        };
        filePlans.push(plan);
        canonicalSkillPlans.push(plan);
      }
    }
  }

  const templateSource = resolveLegacyTreeRoot(paths.workspace, TEMPLATE_TREE_NAME);
  if (templateSource) {
    const sourceRoot = templateSource.root;
    const targetRoot = path.join(paths.agents, TEMPLATE_TREE_NAME);
    copied.templates = sortedEntries(sourceRoot);
    for (const relativeFile of collectFiles(sourceRoot)) {
      const sourceFile = path.join(sourceRoot, relativeFile.replaceAll("/", path.sep));
      const targetFile = path.join(targetRoot, relativeFile.replaceAll("/", path.sep));
      filePlans.push({
        kind: TEMPLATE_TREE_NAME,
        sourceFile,
        sourceRelative: normalizeSlashes(path.relative(paths.workspace, sourceFile)),
        targetFile,
        targetRelative: normalizeSlashes(path.relative(paths.workspace, targetFile)),
        targetScope: "project",
      });
    }
  }

  const adapters = getAdapters(targets);
  const adapterMcpReports = {};
  const extraCreatedDirs = [];
  for (const adapter of adapters) {
    const planned = adapter.planTarget({
      workspace: paths.workspace,
      homeDir,
      paths,
      canonicalSkillPlans,
      legacyMcp,
      mcpScope,
      manifest,
    });
    if (!planned) {
      continue;
    }
    if (Array.isArray(planned.filePlans)) {
      for (const adapterPlan of planned.filePlans) {
        filePlans.push({
          adapterId: adapter.id,
          ...adapterPlan,
        });
      }
    }
    if (planned.mcpReport) {
      adapterMcpReports[adapter.id] = { ...planned.mcpReport };
    }
    if (Array.isArray(planned.extraCreatedDirs)) {
      for (const dirPath of planned.extraCreatedDirs) {
        extraCreatedDirs.push(dirPath);
      }
    }
  }

  return {
    paths,
    homeDir,
    targets,
    filePlans,
    copied,
    legacyMcp,
    mcpScope,
    adapterMcpReports,
    extraCreatedDirs,
  };
}

function materializePlan(plan, ctx) {
  if (typeof plan.render === "function") {
    const rendered = plan.render(plan, ctx);
    const buffer = Buffer.isBuffer(rendered.buffer)
      ? rendered.buffer
      : Buffer.from(String(rendered.text || "").replace(/\r\n/g, "\n"), "utf8");
    const sourceHash =
      rendered.sourceHash !== undefined
        ? rendered.sourceHash
        : plan.sourceFile && fs.existsSync(plan.sourceFile)
          ? hashBuffer(fs.readFileSync(plan.sourceFile))
          : hashBuffer(buffer);
    return {
      sourceHash,
      renderedHash: hashBuffer(buffer),
      buffer,
      flags: {
        rewrittenLegacyPaths: Boolean(rendered.flags && rendered.flags.rewrittenLegacyPaths),
        normalizedSkillFrontmatter: Boolean(
          rendered.flags && rendered.flags.normalizedSkillFrontmatter
        ),
        appliedSpecialFixes:
          (rendered.flags && Array.isArray(rendered.flags.appliedSpecialFixes)
            ? rendered.flags.appliedSpecialFixes
            : []),
      },
      metadata: rendered.metadata && typeof rendered.metadata === "object" ? rendered.metadata : {},
    };
  }

  return materializeFilePlan(plan, ctx.workspace);
}

function ensureProjectDefaults(workspace, dryRun) {
  const created = [];
  for (const relativeDir of DEFAULT_OPENSPEC_DIRS) {
    const target = path.join(workspace, relativeDir.replaceAll("/", path.sep));
    if (!fs.existsSync(target)) {
      ensureDir(target, dryRun);
      created.push(normalizeSlashes(relativeDir));
    }
  }
  return created;
}

function removeExtraneousAgentsTempDirs(workspace, dryRun) {
  const removed = [];
  const agentsRoot = path.join(workspace, ".agents");
  for (const name of EXTRA_AGENTS_TEMP_DIRS) {
    const target = path.join(agentsRoot, name);
    if (!fs.existsSync(target)) {
      continue;
    }
    removed.push(normalizeSlashes(path.relative(workspace, target)));
    if (!dryRun) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
  return removed;
}

function updateAdapterMcpState(mcp, adapterId, plan, materialized, decision) {
  const existing = mcp.targets[adapterId] || {
    scope: plan.targetScope || mcp.scope,
    target: plan.targetRelative,
    converted: false,
    servers: [],
    skipped: [],
    warnings: [],
    hints: [],
  };

  const wasBlocked = Boolean(existing.blocked);
  const metaMcp = materialized.metadata && materialized.metadata.mcp ? materialized.metadata.mcp : {};
  const merged = {
    ...existing,
    ...metaMcp,
    warnings: [...(existing.warnings || [])],
    hints: [...(existing.hints || [])],
  };
  appendUnique(merged.warnings, metaMcp.warnings);
  appendUnique(merged.hints, metaMcp.hints);

  if (!merged.target) {
    merged.target = plan.targetRelative;
  }

  if (decision.action === "blocked") {
    merged.action = "blocked";
    merged.blocked = true;
    merged.blockedReason = decision.reason;
    merged.converted = false;
    appendUnique(merged.warnings, [`${plan.targetRelative} 存在冲突，已保护未覆盖：${decision.reason}`]);
  } else if (wasBlocked) {
    merged.action = "blocked";
    merged.blocked = true;
    merged.converted = false;
  } else {
    merged.action = decision.action;
    merged.blocked = false;
    if (metaMcp.converted !== undefined) {
      merged.converted = metaMcp.converted;
    } else if (existing.converted !== undefined) {
      merged.converted = existing.converted;
    } else {
      merged.converted = true;
    }
  }

  mcp.targets[adapterId] = merged;
  appendUnique(mcp.warnings, merged.warnings);
  appendUnique(mcp.hints, merged.hints);
}

function applyMigration(workspace, options = {}) {
  const paths = workspacePaths(workspace);
  const homeDir = getUserHome(options.homeDir);
  const dryRun = Boolean(options.dryRun);

  assertSafeWorkspace(paths.workspace, {
    allowUnsafeWorkspace: Boolean(options.allowUnsafeWorkspace),
    homeDir,
  });

  if (!fs.existsSync(paths.legacy)) {
    throw new Error(`缺少 Legacy Source 目录：${paths.legacy}`);
  }

  const manifest = loadManifest(paths.workspace);
  const {
    targets,
    filePlans,
    copied,
    legacyMcp,
    mcpScope,
    adapterMcpReports,
    extraCreatedDirs,
  } = buildMigrationPlan(paths.workspace, { ...options, homeDir, manifest });

  const previousFiles = manifest.files || {};
  const nextFiles = {};
  const seenTargets = new Set();

  const createdDirs = [];
  for (const name of CANONICAL_DIR_NAMES) {
    const target = path.join(paths.agents, name);
    if (!fs.existsSync(target)) {
      createdDirs.push(normalizeSlashes(path.relative(paths.workspace, target)));
    }
    ensureDir(target, dryRun);
  }
  for (const extraDir of extraCreatedDirs) {
    if (!fs.existsSync(extraDir)) {
      createdDirs.push(normalizeSlashes(path.relative(paths.workspace, extraDir)));
    }
    ensureDir(extraDir, dryRun);
  }

  const sync = {
    created: [],
    updated: [],
    adopted: [],
    resolved: [],
    blocked: [],
    orphaned: [],
    unchangedCount: 0,
  };
  const rewrittenFiles = [];
  const normalizedSkills = [];

  const mcp = {
    hasLegacyMcp: legacyMcp.exists,
    scope: mcpScope,
    targets: {},
    warnings: [...legacyMcp.warnings],
    hints: [],
  };

  for (const [adapterId, report] of Object.entries(adapterMcpReports)) {
    mcp.targets[adapterId] = {
      ...report,
      warnings: Array.isArray(report.warnings) ? [...report.warnings] : [],
      hints: Array.isArray(report.hints) ? [...report.hints] : [],
    };
    appendUnique(mcp.warnings, report.warnings);
    appendUnique(mcp.hints, report.hints);
  }

  const materializeCtx = {
    workspace: paths.workspace,
    homeDir,
    paths,
    targets,
    mcpScope,
    legacyMcp,
    manifest,
    materializedByTarget: new Map(),
  };

  for (const plan of filePlans) {
    seenTargets.add(plan.targetRelative);
    const materialized = materializePlan(plan, materializeCtx);
    materializeCtx.materializedByTarget.set(plan.targetRelative, materialized);
    const currentTargetHash = hashExistingFile(plan.targetFile);
    const previous = previousFiles[plan.targetRelative] || null;

    let currentManagedHash = null;
    if (
      plan.mergeExisting &&
      typeof plan.computeManagedHash === "function" &&
      previous &&
      previous.managedHash &&
      Array.isArray(previous.managedKeys) &&
      currentTargetHash !== null
    ) {
      try {
        currentManagedHash = plan.computeManagedHash(readText(plan.targetFile), previous.managedKeys);
      } catch (_error) {
        currentManagedHash = null;
      }
    }

    const decision = decidePlanAction(previous, materialized.renderedHash, currentTargetHash, {
      mergeExisting: Boolean(plan.mergeExisting),
      sourceHash: materialized.sourceHash,
      currentManagedHash,
    });

    const renderedManagedMeta =
      plan.mergeExisting &&
      typeof plan.computeManagedHash === "function" &&
      Array.isArray(plan.managedKeys)
        ? {
            managedKeys: plan.managedKeys,
            managedHash: plan.computeManagedHash(
              materialized.buffer.toString("utf8"),
              plan.managedKeys
            ),
          }
        : {};

    if (
      materialized.flags.rewrittenLegacyPaths ||
      materialized.flags.appliedSpecialFixes.length > 0
    ) {
      rewrittenFiles.push(plan.targetRelative);
    }
    if (materialized.flags.normalizedSkillFrontmatter) {
      normalizedSkills.push(plan.targetRelative);
    }
    if (plan.adapterId && plan.kind === "mcp-config") {
      updateAdapterMcpState(mcp, plan.adapterId, plan, materialized, decision);
    }

    if (decision.action === "create" || decision.action === "update") {
      writeBuffer(plan.targetFile, materialized.buffer, dryRun);
      nextFiles[plan.targetRelative] = managedManifestRecord(
        plan,
        materialized,
        materialized.renderedHash,
        renderedManagedMeta
      );
      if (decision.action === "create") {
        sync.created.push(plan.targetRelative);
      } else {
        sync.updated.push(plan.targetRelative);
      }
      continue;
    }

    if (decision.action === "adopt" || decision.action === "resolved") {
      nextFiles[plan.targetRelative] = managedManifestRecord(
        plan,
        materialized,
        materialized.renderedHash,
        renderedManagedMeta
      );
      if (decision.action === "adopt") {
        sync.adopted.push(plan.targetRelative);
      } else {
        sync.resolved.push(plan.targetRelative);
      }
      continue;
    }

    if (decision.action === "blocked") {
      const blockedManagedMeta =
        previous && previous.managedHash && Array.isArray(previous.managedKeys)
          ? { managedKeys: previous.managedKeys, managedHash: previous.managedHash }
          : renderedManagedMeta;
      nextFiles[plan.targetRelative] = blockedManifestRecord(
        plan,
        materialized,
        currentTargetHash,
        decision.reason,
        blockedManagedMeta
      );
      sync.blocked.push({ path: plan.targetRelative, reason: decision.reason });
      continue;
    }

    nextFiles[plan.targetRelative] = managedManifestRecord(
      plan,
      materialized,
      currentTargetHash,
      renderedManagedMeta
    );
    sync.unchangedCount += 1;
  }

  const activeTargetSet = new Set(targets);
  const hints = [];
  const deselectedByAdapter = new Map();

  for (const [targetRelative, previous] of Object.entries(previousFiles)) {
    if (seenTargets.has(targetRelative)) {
      continue;
    }
    const targetFile = resolveManifestTargetFile(paths.workspace, targetRelative, previous, {
      homeDir,
    });
    const currentTargetHash = hashExistingFile(targetFile);
    if (currentTargetHash === null) {
      continue;
    }
    if (
      previous.adapterId &&
      !activeTargetSet.has(previous.adapterId) &&
      hasUpstreamSource(paths.workspace, previous, seenTargets)
    ) {
      if (!deselectedByAdapter.has(previous.adapterId)) {
        deselectedByAdapter.set(previous.adapterId, []);
      }
      deselectedByAdapter.get(previous.adapterId).push(targetRelative);
      continue;
    }
    const previousScope =
      previous.targetScope || (targetRelative.startsWith("~/") ? "user" : "project");
    if (
      previous.kind === "mcp-config" &&
      legacyMcp.exists &&
      mcpScope &&
      previousScope !== mcpScope
    ) {
      const scopeHint = `MCP 迁移范围已从 ${previousScope} 切换为 ${mcpScope}，原配置文件 ${targetRelative} 已保留未删除，请按需人工核对或清理`;
      appendUnique(mcp.hints, [scopeHint]);
      if (previous.adapterId && mcp.targets[previous.adapterId]) {
        appendUnique(mcp.targets[previous.adapterId].hints, [scopeHint]);
      }
      continue;
    }
    nextFiles[targetRelative] = orphanedManifestRecord(previous, currentTargetHash);
    sync.orphaned.push({
      path: targetRelative,
      reason: "源文件已从 .y3maker 移除，已保留目标文件未做删除",
    });
  }

  for (const adapterId of [...deselectedByAdapter.keys()].sort()) {
    const retainedPaths = deselectedByAdapter.get(adapterId).sort();
    const deselectedHint = `已取消启用宿主 ${adapterId}，以下由该宿主生成的历史文件已保留未删除，请按需人工核对或清理：${retainedPaths.join("、")}`;
    appendUnique(hints, [deselectedHint]);
  }

  const nextManifest = {
    version: MANIFEST_VERSION,
    tool: TOOL_NAME,
    updatedAt: new Date().toISOString(),
    targets,
    files: nextFiles,
    mcp,
  };
  writeManifest(paths.workspace, nextManifest, dryRun);

  return {
    dryRun,
    workspace: paths.workspace,
    targets,
    createdDirs,
    copied,
    sync,
    hints,
    rewrittenFiles: [...new Set(rewrittenFiles)].sort(),
    normalizedSkills: [...new Set(normalizedSkills)].sort(),
    mcp,
    manifest: {
      path: MANIFEST_RELATIVE_PATH,
      trackedFiles: Object.keys(nextFiles).length,
      blockedFiles: sync.blocked.length,
      orphanedTargets: sync.orphaned.length,
    },
    projectDefaults: ensureProjectDefaults(paths.workspace, dryRun),
    removedTempDirs: removeExtraneousAgentsTempDirs(paths.workspace, dryRun),
    legacyTransition: detectLegacyTransitions(paths.workspace, {
      homeDir,
      targets,
      ...(dryRun ? {} : { canonicalManifest: nextManifest }),
    }),
  };
}

module.exports = {
  applyMigration,
  buildMigrationPlan,
  inventoryWorkspace,
  materializePlan,
  normalizeMcpScope,
};
