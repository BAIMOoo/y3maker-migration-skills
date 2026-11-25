const { FRONTMATTER_PATTERN } = require("./constants");

function extractFrontmatter(text) {
  const match = text.match(FRONTMATTER_PATTERN);
  if (!match) {
    throw new Error("缺少或无效的 YAML frontmatter");
  }
  return { frontmatter: match[1], body: match[2] };
}

function extractFrontmatterField(frontmatter, fieldName) {
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`${fieldName}:`));
  if (start < 0) {
    return null;
  }
  const fieldLines = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !/^\s/.test(line)) {
      break;
    }
    fieldLines.push(line);
  }
  while (fieldLines.length > 1 && fieldLines[fieldLines.length - 1].trim() === "") {
    fieldLines.pop();
  }
  return fieldLines;
}

function getFrontmatterScalar(frontmatter, fieldName) {
  const lines = extractFrontmatterField(frontmatter, fieldName);
  if (!lines || lines.length === 0) {
    return null;
  }
  const rawValue = lines[0].slice(fieldName.length + 1).trim();
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  return rawValue;
}

function loadFrontmatterKeys(frontmatter) {
  return frontmatter
    .split(/\r?\n/)
    .filter((line) => line && !/^\s/.test(line) && line.includes(":"))
    .map((line) => line.split(":", 1)[0].trim());
}

function normalizeSkillFrontmatterText(skillName, original, options = {}) {
  const { frontmatter, body } = extractFrontmatter(original);
  const descriptionLines = extractFrontmatterField(frontmatter, "description");
  if (!descriptionLines) {
    throw new Error("frontmatter 缺少必填字段 description");
  }

  const lines = ["---", `name: ${skillName}`, ...descriptionLines];

  if (options.preserveAllowedTools) {
    const sourceFrontmatter =
      options.sourceFrontmatter !== undefined ? options.sourceFrontmatter : frontmatter;
    const allowedToolsLines =
      extractFrontmatterField(sourceFrontmatter, "allowed-tools") ||
      extractFrontmatterField(sourceFrontmatter, "tools");
    if (allowedToolsLines) {
      lines.push(allowedToolsLines.join("\n").replace(/^tools:/, "allowed-tools:"));
    }
  }

  lines.push("---");
  const trimmedBody = body.replace(/^\r?\n+/, "").replace(/\s+$/, "");
  if (!trimmedBody) {
    return `${lines.join("\n")}\n`;
  }
  return `${lines.join("\n")}\n\n${trimmedBody}\n`;
}

module.exports = {
  extractFrontmatter,
  extractFrontmatterField,
  getFrontmatterScalar,
  loadFrontmatterKeys,
  normalizeSkillFrontmatterText,
};
