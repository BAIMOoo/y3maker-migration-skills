const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { TextDecoder } = require("util");

const {
  CANONICAL_DIR,
  MANIFEST_RELATIVE_PATH,
  TEXT_SUFFIXES,
  USER_HARNESS_HOME_DIRS,
} = require("./constants");

function normalizeSlashes(value) {
  return value.split(path.sep).join("/");
}

function normalizePathForCompare(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrInsidePath(parent, candidate) {
  const normParent = normalizePathForCompare(parent);
  const normCandidate = normalizePathForCompare(candidate);
  const relative = path.relative(normParent, normCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getUserHome(overrideHomeDir) {
  if (overrideHomeDir) {
    return path.resolve(overrideHomeDir);
  }
  const envHome = process.env.Y3MAKER_HOME || process.env.USERPROFILE || process.env.HOME;
  return path.resolve(envHome || os.homedir());
}

function getUnsafeWorkspaceReason(workspace, options = {}) {
  const resolved = path.resolve(workspace);
  const parsed = path.parse(resolved);
  if (normalizePathForCompare(resolved) === normalizePathForCompare(parsed.root)) {
    return `工作区解析到了文件系统根目录：${resolved}`;
  }

  const home = getUserHome(options.homeDir);
  if (normalizePathForCompare(resolved) === normalizePathForCompare(home)) {
    return `工作区解析到了用户主目录：${resolved}`;
  }

  for (const harnessDir of USER_HARNESS_HOME_DIRS) {
    const harnessHome = path.join(home, harnessDir);
    if (isSameOrInsidePath(harnessHome, resolved)) {
      return `工作区位于用户级宿主配置目录（~/${harnessDir}）内部：${resolved}`;
    }
  }

  return null;
}

function assertSafeWorkspace(workspace, options = {}) {
  if (options.allowUnsafeWorkspace) {
    return;
  }
  const reason = getUnsafeWorkspaceReason(workspace, options);
  if (!reason) {
    return;
  }
  throw new Error(
    `${reason}。已拒绝执行迁移安全护栏检查；如确认目标路径无误，请显式传入 --allow-unsafe-workspace。`
  );
}

function sortedEntries(target) {
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return [];
  }
  return fs.readdirSync(target).sort();
}

function workspacePaths(workspace) {
  const root = path.resolve(workspace);
  return {
    workspace: root,
    legacy: path.join(root, ".y3maker"),
    codemaker: path.join(root, ".codemaker"),
    agents: path.join(root, CANONICAL_DIR),
    codex: path.join(root, ".codex"),
    claude: path.join(root, ".claude"),
    dsh: path.join(root, ".dsh"),
    projectMcp: path.join(root, ".mcp.json"),
    agentsMd: path.join(root, "AGENTS.md"),
    claudeMd: path.join(root, "CLAUDE.md"),
    manifest: path.join(root, MANIFEST_RELATIVE_PATH.replaceAll("/", path.sep)),
  };
}

const UNABLE_TO_DECODE_CODE = "ERR_UNABLE_TO_DECODE";

function isDecodeError(error) {
  return Boolean(error && error.code === UNABLE_TO_DECODE_CODE);
}

function readText(filePath) {
  const raw = fs.readFileSync(filePath);
  const decoders = [
    new TextDecoder("utf-8", { fatal: true }),
    new TextDecoder("gb18030", { fatal: true }),
  ];
  for (const decoder of decoders) {
    try {
      let text = decoder.decode(raw);
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }
      return text;
    } catch (_error) {
      continue;
    }
  }
  const error = new Error(`无法解码文件（非 UTF-8/GB18030 文本）：${filePath}`);
  error.code = UNABLE_TO_DECODE_CODE;
  throw error;
}

function writeText(filePath, content, dryRun) {
  if (dryRun) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = content.replace(/\r\n/g, "\n");
  fs.writeFileSync(filePath, Buffer.from(normalized, "utf8"));
}

function writeBuffer(filePath, content, dryRun) {
  if (dryRun) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function ensureDir(target, dryRun) {
  if (dryRun) {
    return;
  }
  fs.mkdirSync(target, { recursive: true });
}

function hashBuffer(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function hashExistingFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  const raw = fs.readFileSync(filePath);
  if (TEXT_SUFFIXES.has(path.extname(filePath).toLowerCase())) {
    try {
      return hashBuffer(Buffer.from(readText(filePath).replace(/\r\n/g, "\n"), "utf8"));
    } catch (_error) {
      return hashBuffer(raw);
    }
  }
  return hashBuffer(raw);
}

function collectFiles(root, options = {}) {
  const files = [];

  function walk(currentDir, relativeDir) {
    for (const name of sortedEntries(currentDir)) {
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      if (options.skipRelativePath && options.skipRelativePath(relativePath)) {
        continue;
      }
      const currentPath = path.join(currentDir, name);
      const stats = fs.statSync(currentPath);
      if (stats.isDirectory()) {
        walk(currentPath, relativePath);
      } else if (stats.isFile()) {
        files.push(relativePath);
      }
    }
  }

  if (fs.existsSync(root)) {
    walk(root, "");
  }
  return files;
}

module.exports = {
  UNABLE_TO_DECODE_CODE,
  assertSafeWorkspace,
  collectFiles,
  ensureDir,
  getUnsafeWorkspaceReason,
  getUserHome,
  hashBuffer,
  hashExistingFile,
  isDecodeError,
  isSameOrInsidePath,
  normalizePathForCompare,
  normalizeSlashes,
  readText,
  sortedEntries,
  workspacePaths,
  writeBuffer,
  writeText,
};
