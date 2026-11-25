/**
 * Codex 宿主适配层（Harness Adapter）：
 * - Codex 直接原生消费 Canonical Store（.agents/skills/），绝不向 .codex/ 重复复制资产树。
 * - 按显式 MCP Scope（project / user / skip）以非破坏性 TOML 区块合并方式更新 .codex/config.toml 或 ~/.codex/config.toml。
 * - 提供面向 verify 的 TOML 语法与受管 [mcp_servers.*] 区块完整性验收。
 */
const fs = require("fs");
const path = require("path");

const { readText } = require("../lib/fs-utils");

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  const seenStandardTables = new Set();
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
      if (!header.isArrayTable) {
        const tableKey = JSON.stringify(header.segments);
        if (seenStandardTables.has(tableKey)) {
          const displayPath = header.segments.map(formatTomlKey).join(".");
          throw new Error(`第 ${lineNumber} 行重复定义表头 [${displayPath}]`);
        }
        seenStandardTables.add(tableKey);
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

function buildStdioServer(name, config) {
  return {
    name,
    transport: "stdio",
    command: config.command,
    args: Array.isArray(config.args) ? config.args.map((item) => String(item)) : [],
    cwd: typeof config.cwd === "string" && config.cwd.length > 0 ? config.cwd : null,
    env: isPlainObject(config.env) ? config.env : null,
  };
}

function collectCodexMcpServers(legacyMcp) {
  const servers = [];
  const skipped = Array.isArray(legacyMcp.disabled) ? [...legacyMcp.disabled] : [];
  const warnings = [];
  const rawServers = isPlainObject(legacyMcp.servers) ? legacyMcp.servers : {};
  const enabledNames = Array.isArray(legacyMcp.enabled) ? legacyMcp.enabled : [];

  for (const name of enabledNames) {
    const config = isPlainObject(rawServers[name]) ? rawServers[name] : {};
    const declaredType = typeof config.type === "string" ? config.type.toLowerCase() : "";
    const hasCommand = typeof config.command === "string" && config.command.length > 0;
    const hasUrl = typeof config.url === "string" && config.url.length > 0;

    if (declaredType === "stdio" && hasCommand) {
      servers.push(buildStdioServer(name, config));
      continue;
    }

    if (hasUrl) {
      const rawHeaders = isPlainObject(config.headers)
        ? config.headers
        : isPlainObject(config.http_headers)
          ? config.http_headers
          : null;
      servers.push({
        name,
        transport: "http",
        url: config.url,
        httpHeaders: rawHeaders,
      });
      continue;
    }

    if (hasCommand) {
      servers.push(buildStdioServer(name, config));
      continue;
    }

    skipped.push(name);
    warnings.push(`Codex MCP 配置已跳过缺少 command 或 url 的服务器：${name}`);
  }

  return {
    servers,
    skipped: skipped.sort(),
    warnings,
  };
}

function renderCodexServerLines(server) {
  const formattedName = formatTomlKey(server.name);
  const lines = [`[mcp_servers.${formattedName}]`];

  if (server.transport === "http") {
    lines.push(`url = ${JSON.stringify(server.url)}`);
    if (server.httpHeaders) {
      const headerKeys = Object.keys(server.httpHeaders)
        .filter((key) => server.httpHeaders[key] !== null && server.httpHeaders[key] !== undefined)
        .sort();
      if (headerKeys.length > 0) {
        lines.push("");
        lines.push(`[mcp_servers.${formattedName}.http_headers]`);
        for (const key of headerKeys) {
          lines.push(`${JSON.stringify(key)} = ${JSON.stringify(String(server.httpHeaders[key]))}`);
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
    const envKeys = Object.keys(server.env)
      .filter((key) => server.env[key] !== null && server.env[key] !== undefined)
      .sort();
    if (envKeys.length > 0) {
      lines.push("");
      lines.push(`[mcp_servers.${formattedName}.env]`);
      for (const key of envKeys) {
        lines.push(`${formatTomlKey(key)} = ${JSON.stringify(String(server.env[key]))}`);
      }
    }
  }
  return lines;
}

function getManagedServerName(header, managedServerMap) {
  if (
    header.isArrayTable ||
    header.segments.length < 2 ||
    header.segments[0] !== "mcp_servers"
  ) {
    return null;
  }
  return managedServerMap.has(header.segments[1]) ? header.segments[1] : null;
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

function resolveCodexConfigTarget(ctx) {
  if (ctx.mcpScope === "project") {
    return {
      targetFile: path.join(ctx.paths.codex, "config.toml"),
      targetRelative: ".codex/config.toml",
    };
  }
  return {
    targetFile: path.join(ctx.homeDir, ".codex", "config.toml"),
    targetRelative: "~/.codex/config.toml",
  };
}

module.exports = {
  id: "codex",
  aliases: [],
  displayName: "Codex",

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
          warnings: [],
          hints: [],
        },
        extraCreatedDirs: [],
      };
    }

    const { targetFile, targetRelative } = resolveCodexConfigTarget(ctx);
    if (ctx.legacyMcp.empty) {
      return {
        filePlans: [],
        mcpReport: {
          scope: ctx.mcpScope,
          target: targetRelative,
          converted: false,
          servers: [],
          skipped: [],
          empty: true,
          warnings: [
            `.y3maker/mcp_settings.json 中的 mcpServers 为空对象，已跳过写入 ${targetRelative}`,
          ],
          hints: [],
        },
        extraCreatedDirs: [],
      };
    }

    const { servers, skipped, warnings } = collectCodexMcpServers(ctx.legacyMcp);
    if (servers.length === 0) {
      return {
        filePlans: [],
        mcpReport: {
          scope: ctx.mcpScope,
          target: targetRelative,
          converted: false,
          servers: [],
          skipped,
          empty: false,
          warnings: [
            ...warnings,
            `.y3maker/mcp_settings.json 中没有可迁移到 Codex 的启用 MCP 服务器，已跳过写入 ${targetRelative}`,
          ],
          hints: [],
        },
        extraCreatedDirs: [],
      };
    }

    const filePlan = {
      kind: "mcp-config",
      isMcpConfig: true,
      mergeExisting: true,
      sourceFile: ctx.legacyMcp.filePath,
      sourceRelative: ctx.legacyMcp.relativePath,
      targetFile,
      targetRelative,
      targetScope: ctx.mcpScope,
      render(plan) {
        const existingText = fs.existsSync(plan.targetFile) ? readText(plan.targetFile) : "";
        const mergedText = mergeCodexMcpToml(existingText, servers, {
          targetRelative: plan.targetRelative,
        });
        return {
          text: mergedText,
          metadata: {
            mcp: {
              scope: plan.targetScope,
              target: plan.targetRelative,
              converted: true,
              servers: servers.map((item) => item.name),
              skipped,
              empty: false,
              warnings,
              hints: [],
            },
          },
        };
      },
    };

    return {
      filePlans: [filePlan],
      mcpReport: {
        scope: ctx.mcpScope,
        target: targetRelative,
        converted: false,
        servers: servers.map((item) => item.name),
        skipped,
        empty: false,
        warnings,
        hints: [],
      },
      extraCreatedDirs: [],
    };
  },

  verifyTarget(ctx) {
    if (!ctx.hasLegacyMcp || !ctx.mcpScope || ctx.mcpScope === "skip") {
      return [];
    }
    if (!ctx.legacyMcp || ctx.legacyMcp.empty) {
      return [];
    }

    const { servers } = collectCodexMcpServers(ctx.legacyMcp);
    if (servers.length === 0) {
      return [];
    }

    const { targetFile, targetRelative } = resolveCodexConfigTarget(ctx);
    if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
      const scopeLabel = ctx.mcpScope === "project" ? "项目级" : "用户级";
      return [
        {
          type: "missing-path",
          path: targetRelative,
          detail: `存在遗留 MCP 配置且已选择 Codex 的${scopeLabel} MCP 迁移，但目标配置缺失`,
        },
      ];
    }

    let text;
    try {
      text = readText(targetFile);
    } catch (error) {
      return [
        {
          type: "invalid-mcp-config",
          path: targetRelative,
          detail: `无法读取 Codex MCP 配置文件：${error.message}`,
        },
      ];
    }

    let parsed;
    try {
      parsed = parseTomlDocument(text);
    } catch (error) {
      return [
        {
          type: "invalid-mcp-config",
          path: targetRelative,
          detail: `Codex MCP 配置文件 TOML 语法不合法：${error.message}`,
        },
      ];
    }

    const issues = [];
    for (const server of servers) {
      const table = parsed.mcpServerTables.get(server.name);
      if (!table) {
        issues.push({
          type: "invalid-mcp-config",
          path: targetRelative,
          detail: `Codex MCP 配置缺少受管服务器区块 [mcp_servers.${formatTomlKey(server.name)}]`,
        });
        continue;
      }

      if (server.transport === "stdio") {
        const commandField = table.keys.get("command");
        if (
          !commandField ||
          typeof commandField.stringValue !== "string" ||
          commandField.stringValue.trim().length === 0
        ) {
          issues.push({
            type: "invalid-mcp-config",
            path: targetRelative,
            detail: `Codex MCP 服务器 ${server.name} 缺少有效的 command 字符串配置`,
          });
        }
      } else if (server.transport === "http") {
        const urlField = table.keys.get("url");
        if (
          !urlField ||
          typeof urlField.stringValue !== "string" ||
          urlField.stringValue.trim().length === 0
        ) {
          issues.push({
            type: "invalid-mcp-config",
            path: targetRelative,
            detail: `Codex MCP 服务器 ${server.name} 缺少有效的 url 字符串配置`,
          });
        }
      }
    }

    return issues;
  },
};
