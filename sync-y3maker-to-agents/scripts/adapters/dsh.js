/**
 * DSH（DeepSeek Harness）宿主适配层：
 * - 直接原生复用 Canonical Store（.agents/skills/），不复制 skills 或非 skill 目录。
 * - 按显式 MCP Scope 将遗留 MCP 服务转换为 @deepseek-ai/dsh-mcp-client 插件条目，
 *   以零依赖方式安全合并至 .dsh/cordis.patch.yml 或 ~/.dsh/cordis.patch.yml。
 */
const fs = require("fs");
const path = require("path");

const { readText } = require("../lib/fs-utils");

const DSH_MCP_PLUGIN_NAME = "@deepseek-ai/dsh-mcp-client";
const MANAGED_ID_PREFIX = "y3maker-mcp-";
const PROJECT_PATCH_RELATIVE = ".dsh/cordis.patch.yml";
const USER_PATCH_RELATIVE = "~/.dsh/cordis.patch.yml";
const PROJECT_PATCH_HINT =
  "已生成 DSH 项目级 MCP 补丁 .dsh/cordis.patch.yml；启动 DSH 时请传入：dsh --patch .dsh/cordis.patch.yml";

const VALID_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BARE_YAML_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED_YAML_KEY_PATTERN = /^(?:true|false|yes|no|on|off|null|~|y|n)$/i;

function yamlString(value) {
  return JSON.stringify(String(value));
}

function yamlMapKey(key) {
  const str = String(key);
  if (BARE_YAML_KEY_PATTERN.test(str) && !RESERVED_YAML_KEY_PATTERN.test(str)) {
    return str;
  }
  return JSON.stringify(str);
}

function isBlankOrComment(line) {
  return /^\s*(?:#.*)?$/.test(line);
}

function indentLength(line) {
  const match = /^ */.exec(line);
  return match ? match[0].length : 0;
}

function splitTrailingTrivia(lines) {
  let end = lines.length;
  while (end > 0 && isBlankOrComment(lines[end - 1])) {
    end -= 1;
  }
  return {
    contentLines: lines.slice(0, end),
    trailingTrivia: lines.slice(end),
  };
}

function parseYamlScalar(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('"')) {
    let escaped = false;
    for (let i = 1; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        try {
          return JSON.parse(trimmed.slice(0, i + 1));
        } catch (_err) {
          return trimmed.slice(1, i);
        }
      }
    }
    return trimmed.slice(1);
  }
  if (trimmed.startsWith("'")) {
    let result = "";
    for (let i = 1; i < trimmed.length; i += 1) {
      if (trimmed[i] === "'") {
        if (trimmed[i + 1] === "'") {
          result += "'";
          i += 1;
          continue;
        }
        return result;
      }
      result += trimmed[i];
    }
    return result;
  }
  const withoutComment = trimmed.replace(/(?:^|\s+)#.*$/, "").trim();
  return withoutComment || null;
}

function extractInsertChildMetadata(contentLines, childIndentLen) {
  const meta = {
    id: null,
    name: null,
    serverName: null,
    transport: null,
    command: null,
    url: null,
  };
  if (contentLines.length === 0) {
    return meta;
  }

  let keyCol = null;
  let inConfig = false;
  let configKeyCol = null;

  function applyTopKey(key, rawVal) {
    inConfig = false;
    configKeyCol = null;
    if (key === "id") {
      meta.id = parseYamlScalar(rawVal);
    } else if (key === "name") {
      meta.name = parseYamlScalar(rawVal);
    } else if (key === "config") {
      inConfig = true;
    }
  }

  const firstMatch = /^(\s*)-(\s+)(.+)$/.exec(contentLines[0]);
  if (firstMatch && firstMatch[1].length === childIndentLen) {
    keyCol = firstMatch[1].length + 1 + firstMatch[2].length;
    const inlineKeyMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(firstMatch[3]);
    if (inlineKeyMatch) {
      applyTopKey(inlineKeyMatch[1], inlineKeyMatch[2]);
    }
  }

  for (let i = 1; i < contentLines.length; i += 1) {
    const line = contentLines[i];
    if (isBlankOrComment(line)) {
      continue;
    }
    const ind = indentLength(line);
    if (ind <= childIndentLen) {
      break;
    }
    if (keyCol === null) {
      keyCol = ind;
    }
    if (ind === keyCol) {
      const keyMatch = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (keyMatch) {
        applyTopKey(keyMatch[1], keyMatch[2]);
      } else {
        inConfig = false;
        configKeyCol = null;
      }
      continue;
    }
    if (inConfig && ind > keyCol) {
      if (configKeyCol === null) {
        configKeyCol = ind;
      }
      if (ind === configKeyCol) {
        const cfgMatch = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (cfgMatch) {
          const [, cfgKey, cfgVal] = cfgMatch;
          if (cfgKey === "serverName") {
            meta.serverName = parseYamlScalar(cfgVal);
          } else if (cfgKey === "transport") {
            meta.transport = parseYamlScalar(cfgVal);
          } else if (cfgKey === "command") {
            meta.command = parseYamlScalar(cfgVal);
          } else if (cfgKey === "url") {
            meta.url = parseYamlScalar(cfgVal);
          }
        }
      }
    }
  }

  return meta;
}

function parseInsertItemBlock(contentLines, trailingTrivia, topIndent) {
  let insertLineIdx = -1;
  let insertKeyCol = -1;
  let restAfterColon = "";

  const firstLineMatch = /^(\s*)-(\s+)insert\s*:\s*(.*)$/.exec(contentLines[0]);
  if (firstLineMatch && firstLineMatch[1] === topIndent) {
    insertLineIdx = 0;
    insertKeyCol = topIndent.length + 1 + firstLineMatch[2].length;
    restAfterColon = firstLineMatch[3];
  } else if (/^\s*-\s*(?:#.*)?$/.test(contentLines[0])) {
    for (let i = 1; i < contentLines.length; i += 1) {
      if (isBlankOrComment(contentLines[i])) {
        continue;
      }
      const nextMatch = /^(\s*)insert\s*:\s*(.*)$/.exec(contentLines[i]);
      if (nextMatch && nextMatch[1].length > topIndent.length) {
        insertLineIdx = i;
        insertKeyCol = nextMatch[1].length;
        restAfterColon = nextMatch[2];
      }
      break;
    }
  }

  if (insertLineIdx === -1) {
    return {
      type: "raw",
      lines: contentLines,
      trailingTrivia,
    };
  }

  const valueNoComment = restAfterColon.replace(/(?:^|\s+)#.*$/, "").trim();
  const isFlowEmpty = valueNoComment === "[]";
  if (valueNoComment && !isFlowEmpty) {
    return {
      type: "raw",
      lines: contentLines,
      trailingTrivia,
    };
  }

  let insertEnd = contentLines.length;
  for (let i = insertLineIdx + 1; i < contentLines.length; i += 1) {
    const line = contentLines[i];
    if (isBlankOrComment(line)) {
      continue;
    }
    const ind = indentLength(line);
    if (ind < insertKeyCol || (ind === insertKeyCol && !/^\s*-(?:\s|$)/.test(line))) {
      insertEnd = i;
      break;
    }
  }

  const beforeInsertLines = contentLines.slice(0, insertLineIdx);
  const insertLine = contentLines[insertLineIdx];
  const insertSpanLines = contentLines.slice(insertLineIdx + 1, insertEnd);
  const afterInsertLines = contentLines.slice(insertEnd);

  let firstChildIdx = -1;
  let childIndent = `${topIndent}    `;
  for (let i = 0; i < insertSpanLines.length; i += 1) {
    const line = insertSpanLines[i];
    if (isBlankOrComment(line)) {
      continue;
    }
    const childMatch = /^(\s*)-(?:\s|$)/.exec(line);
    if (!childMatch) {
      throw new Error("cordis.patch.yml 中的 `- insert:` 区块必须包含 YAML 序列项");
    }
    firstChildIdx = i;
    childIndent = childMatch[1];
    break;
  }

  if (firstChildIdx === -1) {
    return {
      type: "insert",
      topIndent,
      beforeInsertLines,
      insertLine,
      isFlowEmpty,
      childIndent,
      insertHeaderLines: insertSpanLines,
      children: [],
      afterInsertLines,
      trailingTrivia,
    };
  }

  const childIndentLen = childIndent.length;
  const insertHeaderLines = insertSpanLines.slice(0, firstChildIdx);
  const childStarts = [];
  for (let i = firstChildIdx; i < insertSpanLines.length; i += 1) {
    const line = insertSpanLines[i];
    if (isBlankOrComment(line)) {
      continue;
    }
    const ind = indentLength(line);
    if (ind === childIndentLen && /^\s*-(?:\s|$)/.test(line)) {
      childStarts.push(i);
    } else if (ind < childIndentLen) {
      throw new Error("cordis.patch.yml 中的 `- insert:` 区块缩进异常");
    }
  }

  const children = [];
  for (let idx = 0; idx < childStarts.length; idx += 1) {
    const start = childStarts[idx];
    const end = idx + 1 < childStarts.length ? childStarts[idx + 1] : insertSpanLines.length;
    const { contentLines: childContent, trailingTrivia: childTrivia } = splitTrailingTrivia(
      insertSpanLines.slice(start, end)
    );
    const meta = extractInsertChildMetadata(childContent, childIndentLen);
    children.push({
      meta,
      contentLines: childContent,
      trailingTrivia: childTrivia,
    });
  }

  return {
    type: "insert",
    topIndent,
    beforeInsertLines,
    insertLine,
    isFlowEmpty,
    childIndent,
    insertHeaderLines,
    children,
    afterInsertLines,
    trailingTrivia,
  };
}

function parseCordisPatchDocument(text) {
  let normalized = String(text || "").replace(/\r\n/g, "\n");
  if (normalized.charCodeAt(0) === 0xfeff) {
    normalized = normalized.slice(1);
  }
  if (!normalized.trim()) {
    return {
      leadingLines: [],
      topIndent: "",
      items: [],
      trailingLines: [],
    };
  }

  const rawLines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");

  let bodyEnd = rawLines.length;
  for (let i = 0; i < rawLines.length; i += 1) {
    if (/^\.\.\.(?:\s+#.*|\s*)$/.test(rawLines[i])) {
      bodyEnd = i;
      break;
    }
  }
  const bodyLines = rawLines.slice(0, bodyEnd);
  const trailingLines = rawLines.slice(bodyEnd);

  let firstContentIdx = -1;
  for (let i = 0; i < bodyLines.length; i += 1) {
    const line = bodyLines[i];
    if (isBlankOrComment(line) || /^---(?:\s+#.*|\s*)$/.test(line)) {
      continue;
    }
    firstContentIdx = i;
    break;
  }

  if (firstContentIdx === -1) {
    return {
      leadingLines: bodyLines,
      topIndent: "",
      items: [],
      trailingLines,
    };
  }

  const leadingLines = bodyLines.slice(0, firstContentIdx);
  const firstLine = bodyLines[firstContentIdx];
  if (/^\s*\[\s*\](?:\s+#.*|\s*)$/.test(firstLine)) {
    const afterEmpty = bodyLines.slice(firstContentIdx + 1);
    if (afterEmpty.every(isBlankOrComment)) {
      return {
        leadingLines,
        topIndent: "",
        items: [],
        trailingLines: [...afterEmpty, ...trailingLines],
      };
    }
  }

  const topMatch = /^(\s*)-(?:\s|$)/.exec(firstLine);
  if (!topMatch) {
    throw new Error("cordis.patch.yml 顶层必须是 YAML 序列（例如以 `- insert:` 开头的补丁列表）");
  }
  const topIndent = topMatch[1];
  const topIndentLen = topIndent.length;

  const itemStarts = [];
  for (let i = firstContentIdx; i < bodyLines.length; i += 1) {
    const line = bodyLines[i];
    if (isBlankOrComment(line)) {
      continue;
    }
    const ind = indentLength(line);
    if (ind < topIndentLen) {
      throw new Error("cordis.patch.yml 顶层缩进异常，已拒绝覆盖以保护既有内容");
    }
    if (ind === topIndentLen) {
      if (/^\s*-(?:\s|$)/.test(line)) {
        itemStarts.push(i);
      } else {
        throw new Error("cordis.patch.yml 顶层存在非序列条目，已拒绝覆盖以保护既有内容");
      }
    }
  }

  const items = [];
  for (let idx = 0; idx < itemStarts.length; idx += 1) {
    const start = itemStarts[idx];
    const end = idx + 1 < itemStarts.length ? itemStarts[idx + 1] : bodyLines.length;
    const { contentLines, trailingTrivia } = splitTrailingTrivia(bodyLines.slice(start, end));
    items.push(parseInsertItemBlock(contentLines, trailingTrivia, topIndent));
  }

  return {
    leadingLines,
    topIndent,
    items,
    trailingLines,
  };
}

function serializeCordisPatchDocument(doc) {
  const out = [...doc.leadingLines];
  for (const item of doc.items) {
    if (item.type === "raw") {
      out.push(...item.lines, ...item.trailingTrivia);
      continue;
    }
    out.push(...item.beforeInsertLines);
    const headerLine =
      item.isFlowEmpty && item.children.length > 0
        ? item.insertLine.replace(/insert\s*:\s*\[\s*\]/, "insert:")
        : item.insertLine;
    out.push(headerLine);
    out.push(...item.insertHeaderLines);
    for (const child of item.children) {
      out.push(...child.contentLines, ...child.trailingTrivia);
    }
    out.push(...item.afterInsertLines, ...item.trailingTrivia);
  }
  out.push(...doc.trailingLines);
  return `${out.join("\n")}\n`;
}

function buildManagedChild(entry, childIndent) {
  return {
    meta: {
      id: entry.id,
      name: entry.name,
      serverName: entry.config.serverName,
      transport: entry.config.transport,
      command: entry.config.command || null,
      url: entry.config.url || null,
    },
    contentLines: renderManagedEntryLines(entry, childIndent),
    trailingTrivia: [],
  };
}

function mergeCordisPatchYaml(existingText, entries) {
  const doc = parseCordisPatchDocument(existingText || "");
  const remainingById = new Map(entries.map((entry) => [entry.id, entry]));

  let preferredInsertBlock = null;
  let firstInsertBlock = null;

  for (const item of doc.items) {
    if (item.type !== "insert") {
      continue;
    }
    if (!firstInsertBlock) {
      firstInsertBlock = item;
    }
    for (const child of item.children) {
      const childId = child.meta && child.meta.id;
      if (childId && remainingById.has(childId)) {
        const updated = buildManagedChild(remainingById.get(childId), item.childIndent);
        child.contentLines = updated.contentLines;
        child.meta = updated.meta;
        remainingById.delete(childId);
        preferredInsertBlock = item;
      }
    }
  }

  if (remainingById.size > 0) {
    const targetBlock = preferredInsertBlock || firstInsertBlock;
    if (targetBlock) {
      for (const entry of remainingById.values()) {
        targetBlock.children.push(buildManagedChild(entry, targetBlock.childIndent));
      }
    } else {
      const topIndent = doc.topIndent || "";
      const childIndent = `${topIndent}    `;
      const newChildren = [...remainingById.values()].map((entry) =>
        buildManagedChild(entry, childIndent)
      );
      doc.items.push({
        type: "insert",
        topIndent,
        beforeInsertLines: [],
        insertLine: `${topIndent}- insert:`,
        isFlowEmpty: false,
        childIndent,
        insertHeaderLines: [],
        children: newChildren,
        afterInsertLines: [],
        trailingTrivia: [],
      });
    }
  }

  return serializeCordisPatchDocument(doc);
}

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

function normalizeStringRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return null;
  }
  const normalized = {};
  for (const key of keys) {
    normalized[key] = String(record[key]);
  }
  return normalized;
}

function isLegacySseServer(safeConfig, rawType) {
  if (rawType === "sse") {
    return true;
  }
  if (!rawType && !safeConfig.command && typeof safeConfig.url === "string" && safeConfig.url.trim()) {
    try {
      const parsed = new URL(safeConfig.url);
      if (/\/sse(?:\/|$)/i.test(parsed.pathname)) {
        return true;
      }
    } catch (_err) {
      if (/\/sse(?:[/?#]|$)/i.test(safeConfig.url)) {
        return true;
      }
    }
  }
  return false;
}

function classifyServerConfig(rawName, config) {
  const safeConfig = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const rawType = typeof safeConfig.type === "string" ? safeConfig.type.trim().toLowerCase() : "";

  if (isLegacySseServer(safeConfig, rawType)) {
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
    const env = normalizeStringRecord(safeConfig.env);
    if (env) {
      dshConfig.env = env;
    }
    if (typeof safeConfig.cwd === "string" && safeConfig.cwd.length > 0) {
      dshConfig.cwd = safeConfig.cwd;
    }
    return { ok: true, config: dshConfig };
  }

  if (
    rawType === "http" ||
    rawType === "streamablehttp" ||
    rawType === "streamable-http" ||
    (!rawType && safeConfig.url)
  ) {
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
    const headers = normalizeStringRecord(safeConfig.headers);
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

function renderManagedEntryLines(entry, itemIndent = "    ") {
  const keyIndent = `${itemIndent}  `;
  const configIndent = `${itemIndent}    `;
  const nestedIndent = `${itemIndent}      `;
  const lines = [
    `${itemIndent}- id: ${yamlString(entry.id)}`,
    `${keyIndent}name: ${yamlString(entry.name)}`,
    `${keyIndent}config:`,
    `${configIndent}serverName: ${yamlString(entry.config.serverName)}`,
    `${configIndent}transport: ${yamlString(entry.config.transport)}`,
  ];

  if (entry.config.transport === "stdio") {
    lines.push(`${configIndent}command: ${yamlString(entry.config.command)}`);
    if (Array.isArray(entry.config.args) && entry.config.args.length > 0) {
      lines.push(`${configIndent}args:`);
      for (const arg of entry.config.args) {
        lines.push(`${nestedIndent}- ${yamlString(arg)}`);
      }
    }
    if (entry.config.env) {
      lines.push(`${configIndent}env:`);
      for (const [key, value] of Object.entries(entry.config.env)) {
        lines.push(`${nestedIndent}${yamlMapKey(key)}: ${yamlString(value)}`);
      }
    }
    if (entry.config.cwd) {
      lines.push(`${configIndent}cwd: ${yamlString(entry.config.cwd)}`);
    }
  } else {
    lines.push(`${configIndent}url: ${yamlString(entry.config.url)}`);
    if (entry.config.headers) {
      lines.push(`${configIndent}headers:`);
      for (const [key, value] of Object.entries(entry.config.headers)) {
        lines.push(`${nestedIndent}${yamlMapKey(key)}: ${yamlString(value)}`);
      }
    }
  }

  return lines;
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
      isMcpConfig: true,
      mergeExisting: true,
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
