const TOOL_NAME = "sync-y3maker-to-agents";
const SELF_SKILL_NAME = "sync-y3maker-to-agents";

const CANONICAL_DIR = ".agents";
const CANONICAL_DIR_NAMES = ["knowledge", "memory", "rules", "skills", "templates", "migration"];
const COPY_TREE_NAMES = ["knowledge", "memory", "rules"];
const LEGACY_ROOT_CANDIDATES = [".y3maker", ".codemaker"];
const TEMPLATE_TREE_NAME = "templates";
const DEFAULT_OPENSPEC_DIRS = ["openspec/docs", "openspec/reports"];
const EXTRA_AGENTS_TEMP_DIRS = ["cmtmp"];

const SKILL_ITEM_EXCLUDES = {
  "y3-auto-test": new Set([".queue"]),
  "y3-obj-gen": new Set([".claude-plugin"]),
};

const TEXT_SUFFIXES = new Set([
  ".json",
  ".md",
  ".mdc",
  ".ps1",
  ".py",
  ".toml",
  ".txt",
  ".yaml",
  ".yml",
]);

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const ACTIVE_PATH_PATTERN =
  /`((?:(?:\.agents|\.claude|openspec|scripts)\/[^`\n]+)|(?:\.\.\/){2,}(?:(?:rules|memory|knowledge|templates)\/[^`\n]+|spec-config\.json))`/g;

const MANIFEST_VERSION = 1;
const MANIFEST_RELATIVE_PATH = ".agents/migration/y3maker-manifest.json";

const MCP_SCOPES = new Set(["project", "user", "skip"]);
const CANONICAL_TARGETS = ["antigravity", "claude", "codex", "dsh"];
const USER_HARNESS_HOME_DIRS = [".codex", ".claude", ".agents", ".gemini", ".dsh"];

module.exports = {
  ACTIVE_PATH_PATTERN,
  CANONICAL_DIR,
  CANONICAL_DIR_NAMES,
  CANONICAL_TARGETS,
  COPY_TREE_NAMES,
  DEFAULT_OPENSPEC_DIRS,
  EXTRA_AGENTS_TEMP_DIRS,
  FRONTMATTER_PATTERN,
  LEGACY_ROOT_CANDIDATES,
  MANIFEST_RELATIVE_PATH,
  MANIFEST_VERSION,
  MCP_SCOPES,
  SELF_SKILL_NAME,
  SKILL_ITEM_EXCLUDES,
  TEMPLATE_TREE_NAME,
  TEXT_SUFFIXES,
  TOOL_NAME,
  USER_HARNESS_HOME_DIRS,
};
