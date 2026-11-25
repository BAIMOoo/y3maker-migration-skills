/**
 * 零依赖 Cordis 补丁 YAML（cordis.patch.yml）解析、非破坏性合并与受管切片哈希计算器。
 */
const { hashBuffer } = require("./fs-utils");

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

function computeCordisManagedHash(diskText, managedIds) {
  if (!Array.isArray(managedIds)) {
    return null;
  }
  let doc;
  try {
    doc = parseCordisPatchDocument(diskText);
  } catch (_error) {
    return null;
  }

  const managedSet = new Set(managedIds);
  const snapshot = {};
  for (const id of [...managedIds].sort()) {
    snapshot[id] = [];
  }

  for (const item of doc.items) {
    if (item.type !== "insert") {
      continue;
    }
    for (const child of item.children) {
      const childId = child.meta && child.meta.id;
      if (!childId || !managedSet.has(childId)) {
        continue;
      }
      const dedentedLines = child.contentLines.map((line) =>
        line.startsWith(item.childIndent) ? line.slice(item.childIndent.length) : line
      );
      snapshot[childId].push(dedentedLines);
    }
  }

  return hashBuffer(Buffer.from(JSON.stringify(snapshot), "utf8"));
}

module.exports = {
  computeCordisManagedHash,
  mergeCordisPatchYaml,
  parseCordisPatchDocument,
  renderManagedEntryLines,
};
