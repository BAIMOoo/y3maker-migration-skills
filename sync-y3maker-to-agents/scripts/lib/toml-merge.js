/**
 * 零依赖 TOML 文档解析与 Codex [mcp_servers.*] 区块非破坏性合并器。
 */
const { hashBuffer } = require("./fs-utils");

const BARE_TOML_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const BARE_KEY_CHAR_PATTERN = /[A-Za-z0-9_-]/;
const TOML_BARE_SCALAR_PATTERNS = [
  /^(?:true|false)$/,
  /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/,
  /^0x[0-9a-fA-F](?:_?[0-9a-fA-F])*$/,
  /^0o[0-7](?:_?[0-7])*$/,
  /^0b[01](?:_?[01])*$/,
  /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?|[eE][+-]?[0-9](?:_?[0-9])*)$/,
  /^[+-]?(?:inf|nan)$/,
  /^\d{4}-\d{2}-\d{2}(?:[T t]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/,
  /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/,
];

function isValidTomlBareScalar(token) {
  return TOML_BARE_SCALAR_PATTERNS.some((pattern) => pattern.test(token));
}

function formatTomlKey(key) {
  const str = String(key);
  return BARE_TOML_KEY_PATTERN.test(str) ? str : JSON.stringify(str);
}

function decodeTomlBasicString(raw, startIndex, lineNumber) {
  let index = startIndex + 1;
  let value = "";
  while (index < raw.length) {
    const ch = raw[index];
    if (ch === '"') {
      return { value, nextIndex: index + 1 };
    }
    if (ch === "\\") {
      index += 1;
      if (index >= raw.length) {
        throw new Error(`第 ${lineNumber} 行存在未完成的转义序列`);
      }
      const esc = raw[index];
      if (esc === "b") {
        value += "\b";
        index += 1;
      } else if (esc === "t") {
        value += "\t";
        index += 1;
      } else if (esc === "n") {
        value += "\n";
        index += 1;
      } else if (esc === "f") {
        value += "\f";
        index += 1;
      } else if (esc === "r") {
        value += "\r";
        index += 1;
      } else if (esc === '"') {
        value += '"';
        index += 1;
      } else if (esc === "\\") {
        value += "\\";
        index += 1;
      } else if (esc === "u" || esc === "U") {
        const hexLen = esc === "u" ? 4 : 8;
        const hex = raw.slice(index + 1, index + 1 + hexLen);
        if (hex.length !== hexLen || !/^[0-9a-fA-F]+$/.test(hex)) {
          throw new Error(`第 ${lineNumber} 行存在非法的 Unicode 转义 \\${esc}${hex}`);
        }
        value += String.fromCodePoint(parseInt(hex, 16));
        index += 1 + hexLen;
      } else {
        throw new Error(`第 ${lineNumber} 行存在非法的字符串转义 \\${esc}`);
      }
      continue;
    }
    value += ch;
    index += 1;
  }
  throw new Error(`第 ${lineNumber} 行双引号字符串未闭合`);
}

function decodeTomlLiteralString(raw, startIndex, lineNumber) {
  const endIndex = raw.indexOf("'", startIndex + 1);
  if (endIndex < 0) {
    throw new Error(`第 ${lineNumber} 行单引号字面量字符串未闭合`);
  }
  return {
    value: raw.slice(startIndex + 1, endIndex),
    nextIndex: endIndex + 1,
  };
}

function skipHorizontalWhitespace(raw, index) {
  let cursor = index;
  while (cursor < raw.length && (raw[cursor] === " " || raw[cursor] === "\t")) {
    cursor += 1;
  }
  return cursor;
}

function parseTomlDottedKey(raw, startIndex, stopChar, lineNumber) {
  const segments = [];
  let index = skipHorizontalWhitespace(raw, startIndex);

  while (index < raw.length) {
    const ch = raw[index];
    if (ch === '"') {
      const parsed = decodeTomlBasicString(raw, index, lineNumber);
      segments.push(parsed.value);
      index = parsed.nextIndex;
    } else if (ch === "'") {
      const parsed = decodeTomlLiteralString(raw, index, lineNumber);
      segments.push(parsed.value);
      index = parsed.nextIndex;
    } else if (BARE_KEY_CHAR_PATTERN.test(ch)) {
      let end = index;
      while (end < raw.length && BARE_KEY_CHAR_PATTERN.test(raw[end])) {
        end += 1;
      }
      segments.push(raw.slice(index, end));
      index = end;
    } else {
      throw new Error(`第 ${lineNumber} 行键名语法不合法`);
    }

    index = skipHorizontalWhitespace(raw, index);
    if (raw[index] === ".") {
      index = skipHorizontalWhitespace(raw, index + 1);
      if (index >= raw.length || raw[index] === stopChar) {
        throw new Error(`第 ${lineNumber} 行存在空的点分键名段`);
      }
      continue;
    }
    if (raw[index] === stopChar) {
      break;
    }
    throw new Error(`第 ${lineNumber} 行键名后出现意外字符 "${raw[index] || ""}"`);
  }

  if (segments.length === 0) {
    throw new Error(`第 ${lineNumber} 行键名不能为空`);
  }
  return { segments, nextIndex: index };
}

function parseTomlTableHeader(line, lineNumber) {
  let index = skipHorizontalWhitespace(line, 0);
  if (line[index] !== "[") {
    throw new Error(`第 ${lineNumber} 行不是合法的 TOML 表头`);
  }
  const isArrayTable = line[index + 1] === "[";
  index += isArrayTable ? 2 : 1;

  const { segments, nextIndex } = parseTomlDottedKey(line, index, "]", lineNumber);
  index = nextIndex;

  if (isArrayTable) {
    if (line.slice(index, index + 2) !== "]]") {
      throw new Error(`第 ${lineNumber} 行数组表头缺少闭合的 ]]`);
    }
    index += 2;
  } else {
    if (line[index] !== "]") {
      throw new Error(`第 ${lineNumber} 行表头缺少闭合的 ]`);
    }
    index += 1;
  }

  index = skipHorizontalWhitespace(line, index);
  if (index < line.length && line[index] !== "#") {
    throw new Error(`第 ${lineNumber} 行表头后存在非法尾随内容`);
  }

  return { isArrayTable, segments };
}

function advanceTomlMultilineState(line, state, lineNumber) {
  let index = 0;
  while (index < line.length) {
    if (state.multilineDelimiter === '"""') {
      if (line[index] === "\\") {
        index += 2;
        continue;
      }
      if (line.slice(index, index + 3) === '"""') {
        let runEnd = index;
        while (runEnd < line.length && line[runEnd] === '"') {
          runEnd += 1;
        }
        const runLength = runEnd - index;
        if (runLength > 5) {
          throw new Error(`第 ${lineNumber} 行多行基本字符串存在连续超过 5 个双引号`);
        }
        state.multilineDelimiter = null;
        index = runEnd;
        continue;
      }
      index += 1;
      continue;
    }

    if (state.multilineDelimiter === "'''") {
      if (line.slice(index, index + 3) === "'''") {
        let runEnd = index;
        while (runEnd < line.length && line[runEnd] === "'") {
          runEnd += 1;
        }
        const runLength = runEnd - index;
        if (runLength > 5) {
          throw new Error(`第 ${lineNumber} 行多行字面量字符串存在连续超过 5 个单引号`);
        }
        state.multilineDelimiter = null;
        index = runEnd;
        continue;
      }
      index += 1;
      continue;
    }

    const ch = line[index];
    if (ch === "#") {
      break;
    }
    if (line.slice(index, index + 3) === '"""') {
      state.multilineDelimiter = '"""';
      index += 3;
      continue;
    }
    if (line.slice(index, index + 3) === "'''") {
      state.multilineDelimiter = "'''";
      index += 3;
      continue;
    }
    if (ch === '"') {
      const parsed = decodeTomlBasicString(line, index, lineNumber);
      index = parsed.nextIndex;
      continue;
    }
    if (ch === "'") {
      const parsed = decodeTomlLiteralString(line, index, lineNumber);
      index = parsed.nextIndex;
      continue;
    }
    if (ch === "[") {
      state.bracketDepth += 1;
    } else if (ch === "]") {
      state.bracketDepth -= 1;
      if (state.bracketDepth < 0) {
        throw new Error(`第 ${lineNumber} 行存在多余的 ]`);
      }
    } else if (ch === "{") {
      state.braceDepth += 1;
    } else if (ch === "}") {
      state.braceDepth -= 1;
      if (state.braceDepth < 0) {
        throw new Error(`第 ${lineNumber} 行存在多余的 }`);
      }
    }
    index += 1;
  }
}

function isBlankOrCommentLine(line) {
  return /^\s*(#.*)?$/.test(line);
}

function isBlankLine(line) {
  return /^\s*$/.test(line);
}

function parseKeyValueLine(line, state, lineNumber) {
  const { segments, nextIndex } = parseTomlDottedKey(line, 0, "=", lineNumber);
  if (line[nextIndex] !== "=") {
    throw new Error(`第 ${lineNumber} 行缺少赋值号 =`);
  }

  const valueStart = skipHorizontalWhitespace(line, nextIndex + 1);
  if (valueStart >= line.length || line[valueStart] === "#") {
    throw new Error(`第 ${lineNumber} 行缺少赋值内容`);
  }

  let stringValue = null;
  const startsWithTripleDouble = line.slice(valueStart, valueStart + 3) === '"""';
  const startsWithTripleSingle = line.slice(valueStart, valueStart + 3) === "'''";

  if (line[valueStart] === '"' && !startsWithTripleDouble) {
    const parsed = decodeTomlBasicString(line, valueStart, lineNumber);
    const after = skipHorizontalWhitespace(line, parsed.nextIndex);
    if (after < line.length && line[after] !== "#") {
      throw new Error(`第 ${lineNumber} 行字符串值后存在非法尾随内容`);
    }
    stringValue = parsed.value;
  } else if (line[valueStart] === "'" && !startsWithTripleSingle) {
    const parsed = decodeTomlLiteralString(line, valueStart, lineNumber);
    const after = skipHorizontalWhitespace(line, parsed.nextIndex);
    if (after < line.length && line[after] !== "#") {
      throw new Error(`第 ${lineNumber} 行字面量字符串值后存在非法尾随内容`);
    }
    stringValue = parsed.value;
  } else if (
    startsWithTripleDouble ||
    startsWithTripleSingle ||
    line[valueStart] === "[" ||
    line[valueStart] === "{"
  ) {
    advanceTomlMultilineState(line.slice(valueStart), state, lineNumber);
  } else {
    const rest = line.slice(valueStart);
    const commentIndex = rest.indexOf("#");
    const scalarToken = (commentIndex >= 0 ? rest.slice(0, commentIndex) : rest).trim();
    if (!isValidTomlBareScalar(scalarToken)) {
      throw new Error(`第 ${lineNumber} 行存在非法的 TOML 标量值 "${scalarToken}"`);
    }
  }

  return { segments, stringValue };
}

function isStrictSegmentPrefix(prefix, candidate) {
  if (candidate.length <= prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (candidate[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

function parseTomlDocument(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  if (normalized.length === 0) {
    return {
      preambleLines: [],
      sections: [],
      mcpServerTables: new Map(),
    };
  }

  const rawLines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");

  const preambleLines = [];
  const sections = [];
  const seenStandardTables = new Map();
  const mcpServerTables = new Map();
  let currentSection = null;
  let currentMcpTable = null;
  const state = {
    multilineDelimiter: null,
    bracketDepth: 0,
    braceDepth: 0,
  };

  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const line = rawLines[idx];
    const lineNumber = idx + 1;
    const isTopLevelState =
      state.multilineDelimiter === null && state.bracketDepth === 0 && state.braceDepth === 0;

    if (isTopLevelState && /^\s*\[/.test(line)) {
      const header = parseTomlTableHeader(line, lineNumber);
      if (header.isArrayTable) {
        for (const [seenKey, seenSegments] of seenStandardTables.entries()) {
          if (isStrictSegmentPrefix(header.segments, seenSegments)) {
            seenStandardTables.delete(seenKey);
          }
        }
      } else {
        const tableKey = JSON.stringify(header.segments);
        if (seenStandardTables.has(tableKey)) {
          const displayPath = header.segments.map(formatTomlKey).join(".");
          throw new Error(`第 ${lineNumber} 行重复定义表头 [${displayPath}]`);
        }
        seenStandardTables.set(tableKey, header.segments);
      }

      currentSection = {
        header,
        lineNumber,
        lines: [line],
      };
      sections.push(currentSection);

      if (
        !header.isArrayTable &&
        header.segments.length === 2 &&
        header.segments[0] === "mcp_servers"
      ) {
        currentMcpTable = { keys: new Map() };
        mcpServerTables.set(header.segments[1], currentMcpTable);
      } else {
        currentMcpTable = null;
      }
      continue;
    }

    if (isTopLevelState) {
      if (!isBlankOrCommentLine(line)) {
        const entry = parseKeyValueLine(line, state, lineNumber);
        if (currentMcpTable && entry.segments.length === 1) {
          currentMcpTable.keys.set(entry.segments[0], {
            stringValue: entry.stringValue,
          });
        }
      }
    } else {
      advanceTomlMultilineState(line, state, lineNumber);
    }

    if (currentSection) {
      currentSection.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }

  if (state.multilineDelimiter !== null) {
    throw new Error("存在未闭合的多行字符串");
  }
  if (state.bracketDepth !== 0) {
    throw new Error("存在未闭合的数组方括号");
  }
  if (state.braceDepth !== 0) {
    throw new Error("存在未闭合的内联表花括号");
  }

  return { preambleLines, sections, mcpServerTables };
}

function extractDetachedTrailingComments(sectionLines, hasNextSection) {
  const bodyLines = sectionLines.slice(1);
  let lastContentIdx = -1;
  for (let i = bodyLines.length - 1; i >= 0; i -= 1) {
    if (!isBlankOrCommentLine(bodyLines[i])) {
      lastContentIdx = i;
      break;
    }
  }

  const tail = bodyLines.slice(lastContentIdx + 1);
  let trimmedEnd = tail.length;
  while (trimmedEnd > 0 && isBlankLine(tail[trimmedEnd - 1])) {
    trimmedEnd -= 1;
  }
  const tailWithoutEndBlanks = tail.slice(0, trimmedEnd);
  if (tailWithoutEndBlanks.length === 0) {
    return [];
  }

  let lastBlankIdx = -1;
  for (let i = tailWithoutEndBlanks.length - 1; i >= 0; i -= 1) {
    if (isBlankLine(tailWithoutEndBlanks[i])) {
      lastBlankIdx = i;
      break;
    }
  }

  if (lastBlankIdx >= 0) {
    return tailWithoutEndBlanks.slice(lastBlankIdx + 1);
  }
  if (hasNextSection && tail.length === tailWithoutEndBlanks.length) {
    return tailWithoutEndBlanks;
  }
  return [];
}

function ensureSingleTrailingBlank(lines) {
  if (lines.length === 0) {
    return;
  }
  while (lines.length > 0 && isBlankLine(lines[lines.length - 1])) {
    lines.pop();
  }
  if (lines.length > 0) {
    lines.push("");
  }
}

function renderCodexServerLines(server) {
  const formattedName = formatTomlKey(server.name);
  const lines = [`[mcp_servers.${formattedName}]`];

  if (server.transport === "http") {
    lines.push(`url = ${JSON.stringify(server.url)}`);
    if (server.httpHeaders) {
      const headerKeys = Object.keys(server.httpHeaders).sort();
      if (headerKeys.length > 0) {
        lines.push("");
        lines.push(`[mcp_servers.${formattedName}.http_headers]`);
        for (const key of headerKeys) {
          lines.push(`${JSON.stringify(key)} = ${JSON.stringify(server.httpHeaders[key])}`);
        }
      }
    }
    return lines;
  }

  lines.push(`command = ${JSON.stringify(server.command)}`);
  if (server.args.length > 0) {
    lines.push(`args = [${server.args.map((value) => JSON.stringify(value)).join(", ")}]`);
  }
  if (server.cwd) {
    lines.push(`cwd = ${JSON.stringify(server.cwd)}`);
  }
  if (server.env) {
    const envKeys = Object.keys(server.env).sort();
    if (envKeys.length > 0) {
      lines.push("");
      lines.push(`[mcp_servers.${formattedName}.env]`);
      for (const key of envKeys) {
        lines.push(`${formatTomlKey(key)} = ${JSON.stringify(server.env[key])}`);
      }
    }
  }
  return lines;
}

function getManagedServerName(header, managedNameSet) {
  if (
    header.isArrayTable ||
    header.segments.length < 2 ||
    header.segments[0] !== "mcp_servers"
  ) {
    return null;
  }
  return managedNameSet.has(header.segments[1]) ? header.segments[1] : null;
}

function extractManagedSectionBodyLines(sectionLines) {
  let end = sectionLines.length;
  while (end > 1 && isBlankOrCommentLine(sectionLines[end - 1])) {
    end -= 1;
  }
  return sectionLines.slice(1, end);
}

function computeCodexMcpManagedHash(diskText, managedKeys) {
  if (!Array.isArray(managedKeys)) {
    return null;
  }
  let doc;
  try {
    doc = parseTomlDocument(diskText);
  } catch (_error) {
    return null;
  }

  const managedSet = new Set(managedKeys);
  const snapshot = {};
  for (const name of [...managedKeys].sort()) {
    snapshot[name] = [];
  }

  for (const section of doc.sections) {
    const serverName = getManagedServerName(section.header, managedSet);
    if (!serverName) {
      continue;
    }
    snapshot[serverName].push({
      header: section.header.segments,
      body: extractManagedSectionBodyLines(section.lines),
    });
  }

  return hashBuffer(Buffer.from(JSON.stringify(snapshot), "utf8"));
}

function mergeCodexMcpToml(existingText, servers, options = {}) {
  let doc;
  try {
    doc = parseTomlDocument(existingText);
  } catch (error) {
    const label = options.targetRelative || "config.toml";
    throw new Error(`无法安全合并 ${label}：TOML 语法不合法（${error.message}）`);
  }

  const managedServerMap = new Map(servers.map((server) => [server.name, server]));
  const emittedServers = new Set();
  const outputLines = [];

  const hasMeaningfulPreamble = doc.preambleLines.some((line) => !isBlankLine(line));
  if (hasMeaningfulPreamble || doc.sections.length > 0) {
    outputLines.push(...doc.preambleLines);
  }

  let prevWasManaged = false;

  for (let i = 0; i < doc.sections.length; i += 1) {
    const section = doc.sections[i];
    const hasNextSection = i + 1 < doc.sections.length;
    const managedName = getManagedServerName(section.header, managedServerMap);

    if (!managedName) {
      if (outputLines.length > 0 && prevWasManaged) {
        ensureSingleTrailingBlank(outputLines);
      }
      outputLines.push(...section.lines);
      prevWasManaged = false;
      continue;
    }

    const detachedComments = extractDetachedTrailingComments(section.lines, hasNextSection);

    if (!emittedServers.has(managedName)) {
      if (outputLines.length > 0 && prevWasManaged) {
        ensureSingleTrailingBlank(outputLines);
      }
      outputLines.push(...renderCodexServerLines(managedServerMap.get(managedName)));
      emittedServers.add(managedName);
      prevWasManaged = true;
    }

    if (detachedComments.length > 0) {
      ensureSingleTrailingBlank(outputLines);
      outputLines.push(...detachedComments);
      prevWasManaged = false;
    }
  }

  for (const server of servers) {
    if (emittedServers.has(server.name)) {
      continue;
    }
    if (outputLines.length > 0) {
      ensureSingleTrailingBlank(outputLines);
    }
    outputLines.push(...renderCodexServerLines(server));
    emittedServers.add(server.name);
  }

  return `${outputLines.join("\n")}\n`;
}

module.exports = {
  computeCodexMcpManagedHash,
  formatTomlKey,
  mergeCodexMcpToml,
  parseTomlDocument,
  renderCodexServerLines,
};
