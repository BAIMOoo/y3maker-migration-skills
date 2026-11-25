const fs = require("fs");

const { hashBuffer, readText } = require("./fs-utils");

const EXPLICIT_STREAMABLE_HTTP_TYPES = new Set(["http", "streamablehttp", "streamable-http"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringMap(record) {
  if (!isPlainObject(record)) {
    return null;
  }
  const normalized = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && value !== undefined) {
      normalized[key] = String(value);
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function hasLegacySseUrlPath(url) {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return /\/sse(?:\/|$)/i.test(parsed.pathname);
  } catch (_error) {
    return /\/sse(?:[/?#]|$)/i.test(url);
  }
}

function resolveServerUrl(serverConfig) {
  if (!isPlainObject(serverConfig)) {
    return "";
  }
  if (typeof serverConfig.url === "string" && serverConfig.url.trim()) {
    return serverConfig.url.trim();
  }
  if (typeof serverConfig.serverUrl === "string" && serverConfig.serverUrl.trim()) {
    return serverConfig.serverUrl.trim();
  }
  return "";
}

function isLegacySseServer(serverConfig) {
  if (!isPlainObject(serverConfig)) {
    return false;
  }
  const rawType = typeof serverConfig.type === "string" ? serverConfig.type.trim().toLowerCase() : "";
  if (rawType === "sse") {
    return true;
  }
  const url = resolveServerUrl(serverConfig);
  if (
    rawType !== "stdio" &&
    url &&
    !EXPLICIT_STREAMABLE_HTTP_TYPES.has(rawType) &&
    hasLegacySseUrlPath(url)
  ) {
    return true;
  }
  return false;
}

function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (isPlainObject(value)) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeJsonValue(value[key]);
    }
    return sorted;
  }
  return value;
}

function computeJsonMcpManagedHash(diskText, managedKeys) {
  if (!Array.isArray(managedKeys)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(diskText);
  } catch (_error) {
    return null;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
    return null;
  }
  const snapshot = {};
  for (const key of [...managedKeys].sort()) {
    snapshot[key] = Object.prototype.hasOwnProperty.call(parsed.mcpServers, key)
      ? canonicalizeJsonValue(parsed.mcpServers[key])
      : "__MISSING__";
  }
  return hashBuffer(Buffer.from(JSON.stringify(snapshot), "utf8"));
}

function computeJsonFieldsManagedHash(diskText, fieldNames) {
  if (!Array.isArray(fieldNames)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(diskText);
  } catch (_error) {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  const snapshot = {};
  for (const field of [...fieldNames].sort()) {
    snapshot[field] = Object.prototype.hasOwnProperty.call(parsed, field)
      ? canonicalizeJsonValue(parsed[field])
      : "__MISSING__";
  }
  return hashBuffer(Buffer.from(JSON.stringify(snapshot), "utf8"));
}

function inspectLegacyMcp(legacyFile) {
  if (!legacyFile || !fs.existsSync(legacyFile)) {
    return {
      exists: false,
      filePath: legacyFile || null,
      relativePath: ".y3maker/mcp_settings.json",
      empty: false,
      servers: {},
      enabled: [],
      disabled: [],
      warnings: [],
    };
  }

  const payload = JSON.parse(readText(legacyFile));
  const rawServers =
    payload && payload.mcpServers && typeof payload.mcpServers === "object" && !Array.isArray(payload.mcpServers)
      ? payload.mcpServers
      : {};
  const enabled = [];
  const disabled = [];
  for (const name of Object.keys(rawServers).sort()) {
    const entry = rawServers[name];
    if (entry && entry.disabled) {
      disabled.push(name);
    } else {
      enabled.push(name);
    }
  }
  const empty = Object.keys(rawServers).length === 0;
  return {
    exists: true,
    filePath: legacyFile,
    relativePath: ".y3maker/mcp_settings.json",
    empty,
    servers: rawServers,
    enabled,
    disabled,
    warnings: empty ? [".y3maker/mcp_settings.json 中的 mcpServers 为空对象"] : [],
  };
}

function parseLegacyMcpServers(legacyFile) {
  const info = inspectLegacyMcp(legacyFile);
  const enabledEntries = info.enabled.map((name) => ({
    name,
    config: info.servers[name] || {},
  }));
  return {
    ...info,
    enabledEntries,
  };
}

module.exports = {
  EXPLICIT_STREAMABLE_HTTP_TYPES,
  canonicalizeJsonValue,
  computeJsonFieldsManagedHash,
  computeJsonMcpManagedHash,
  inspectLegacyMcp,
  isLegacySseServer,
  isPlainObject,
  normalizeStringMap,
  parseLegacyMcpServers,
  resolveServerUrl,
};
