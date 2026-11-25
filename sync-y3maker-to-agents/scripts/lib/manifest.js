const fs = require("fs");
const path = require("path");

const { MANIFEST_VERSION, TOOL_NAME } = require("./constants");
const { getUserHome, readText, workspacePaths, writeText } = require("./fs-utils");

function emptyManifest() {
  return {
    version: MANIFEST_VERSION,
    tool: TOOL_NAME,
    updatedAt: null,
    targets: [],
    files: {},
    mcp: null,
  };
}

function loadManifest(workspace) {
  const { manifest } = workspacePaths(workspace);
  if (!fs.existsSync(manifest)) {
    return emptyManifest();
  }
  const parsed = JSON.parse(readText(manifest));
  return {
    version: parsed.version || MANIFEST_VERSION,
    tool: parsed.tool || TOOL_NAME,
    updatedAt: parsed.updatedAt || null,
    targets: Array.isArray(parsed.targets) ? parsed.targets : [],
    files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
    mcp: parsed.mcp && typeof parsed.mcp === "object" ? parsed.mcp : null,
  };
}

function writeManifest(workspace, manifest, dryRun) {
  const { manifest: manifestFile } = workspacePaths(workspace);
  const payload = {
    version: MANIFEST_VERSION,
    tool: TOOL_NAME,
    updatedAt: new Date().toISOString(),
    targets: Array.isArray(manifest.targets) ? manifest.targets : [],
    files: manifest.files || {},
  };
  if (manifest.mcp) {
    payload.mcp = manifest.mcp;
  }
  writeText(manifestFile, `${JSON.stringify(payload, null, 2)}\n`, dryRun);
}

function resolveManifestTargetFile(workspace, targetRelative, previous = {}, options = {}) {
  const targetScope =
    previous.targetScope || (targetRelative.startsWith("~/") ? "user" : "project");
  if (targetScope === "user") {
    const withoutHomePrefix = targetRelative.replace(/^~[\\/]/, "");
    return path.join(getUserHome(options.homeDir), withoutHomePrefix.replaceAll("/", path.sep));
  }
  return path.join(workspace, targetRelative.replaceAll("/", path.sep));
}

function decidePlanAction(previous, renderedHash, currentTargetHash, options = {}) {
  const mergeExisting = Boolean(options.mergeExisting);

  if (currentTargetHash === renderedHash) {
    if (!previous) {
      return { action: "adopt" };
    }
    if (previous.status === "blocked") {
      return { action: "resolved" };
    }
    if (previous.status === "managed" && previous.renderedHash === renderedHash) {
      return { action: "unchanged" };
    }
    return { action: "adopt" };
  }

  if (!previous) {
    if (currentTargetHash === null) {
      return { action: "create" };
    }
    if (mergeExisting) {
      return { action: "update" };
    }
    return {
      action: "blocked",
      reason: "目标文件已存在，但尚无历史迁移基线记录",
    };
  }

  if (previous.status === "blocked") {
    return {
      action: "blocked",
      reason: previous.blockedReason || "此前的合并冲突尚未解决",
    };
  }

  const sourceChanged = previous.renderedHash !== renderedHash;
  const targetChanged = previous.targetHash !== currentTargetHash;

  if (sourceChanged && !targetChanged) {
    return { action: "update" };
  }
  if (!sourceChanged && targetChanged) {
    return {
      action: "blocked",
      reason: "上次迁移后目标文件已被本地修改",
    };
  }
  if (sourceChanged && targetChanged) {
    return {
      action: "blocked",
      reason: "上次迁移后源文件与目标文件均发生了修改",
    };
  }
  return { action: "unchanged" };
}

function managedManifestRecord(plan, materialized, targetHash) {
  const record = {
    status: "managed",
    kind: plan.kind,
    source: plan.sourceRelative,
    target: plan.targetRelative,
    targetScope: plan.targetScope || "project",
    sourceHash: materialized.sourceHash,
    renderedHash: materialized.renderedHash,
    targetHash,
    updatedAt: new Date().toISOString(),
  };
  if (plan.adapterId) {
    record.adapterId = plan.adapterId;
  }
  return record;
}

function blockedManifestRecord(plan, materialized, targetHash, reason) {
  const record = {
    status: "blocked",
    kind: plan.kind,
    source: plan.sourceRelative,
    target: plan.targetRelative,
    targetScope: plan.targetScope || "project",
    sourceHash: materialized.sourceHash,
    renderedHash: materialized.renderedHash,
    targetHash,
    blockedReason: reason,
    updatedAt: new Date().toISOString(),
  };
  if (plan.adapterId) {
    record.adapterId = plan.adapterId;
  }
  return record;
}

function orphanedManifestRecord(previous, targetHash) {
  return {
    ...previous,
    status: "orphaned",
    targetHash,
    blockedReason: "源文件已从 .y3maker 移除，已保留目标文件未做删除",
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  blockedManifestRecord,
  decidePlanAction,
  emptyManifest,
  loadManifest,
  managedManifestRecord,
  orphanedManifestRecord,
  resolveManifestTargetFile,
  writeManifest,
};
