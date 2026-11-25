const antigravity = require("./antigravity");
const claude = require("./claude");
const codex = require("./codex");
const dsh = require("./dsh");

const ADAPTERS = [antigravity, claude, codex, dsh];
const ADAPTER_BY_ID = new Map();
const ALIAS_TO_ID = new Map();

for (const adapter of ADAPTERS) {
  ADAPTER_BY_ID.set(adapter.id, adapter);
  ALIAS_TO_ID.set(adapter.id, adapter.id);
  for (const alias of adapter.aliases || []) {
    ALIAS_TO_ID.set(alias.toLowerCase(), adapter.id);
  }
}

const ALL_TARGET_IDS = [...ADAPTER_BY_ID.keys()].sort();

function listAdapters() {
  return ALL_TARGET_IDS.map((id) => ADAPTER_BY_ID.get(id));
}

function getAdapter(id) {
  const canonicalId = ALIAS_TO_ID.get(String(id || "").toLowerCase());
  if (!canonicalId) {
    throw new Error(
      `未知的目标宿主：${id}。可选值：codex、claude、antigravity（别名 agy）、dsh 或 all。`
    );
  }
  return ADAPTER_BY_ID.get(canonicalId);
}

function normalizeTargets(rawTargets) {
  if (rawTargets === null || rawTargets === undefined) {
    return null;
  }

  const tokens = Array.isArray(rawTargets)
    ? rawTargets.flatMap((item) => String(item).split(","))
    : String(rawTargets).split(",");

  const trimmed = tokens.map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (trimmed.length === 0) {
    throw new Error(
      "目标宿主（--targets）不能为空。可选值：codex、claude、antigravity（别名 agy）、dsh 或 all。"
    );
  }

  const resolved = new Set();
  for (const token of trimmed) {
    if (token === "all") {
      for (const id of ALL_TARGET_IDS) {
        resolved.add(id);
      }
      continue;
    }
    const canonicalId = ALIAS_TO_ID.get(token);
    if (!canonicalId) {
      throw new Error(
        `未知的目标宿主：${token}。可选值：codex、claude、antigravity（别名 agy）、dsh 或 all。`
      );
    }
    resolved.add(canonicalId);
  }

  return [...resolved].sort();
}

function getAdapters(targetIds) {
  const normalized = normalizeTargets(targetIds) || [];
  return normalized.map((id) => ADAPTER_BY_ID.get(id));
}

module.exports = {
  ALL_TARGET_IDS,
  getAdapter,
  getAdapters,
  listAdapters,
  normalizeTargets,
};
