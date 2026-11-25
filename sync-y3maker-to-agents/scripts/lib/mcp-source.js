const fs = require("fs");

const { readText } = require("./fs-utils");

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
  inspectLegacyMcp,
  parseLegacyMcpServers,
};
