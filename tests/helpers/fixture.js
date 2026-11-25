const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SKILL_ROOT = path.join(REPO_ROOT, "sync-y3maker-to-agents");
const RUN_MIGRATION_SCRIPT = path.join(SKILL_ROOT, "scripts", "run-migration.js");
const VERIFY_MIGRATION_SCRIPT = path.join(SKILL_ROOT, "scripts", "verify-migration.js");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function writeFileEnsureDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (Buffer.isBuffer(content)) {
    fs.writeFileSync(filePath, content);
  } else {
    fs.writeFileSync(filePath, content, "utf8");
  }
}

function buildIsolatedEnv(homeDir, extraEnv = {}) {
  const resolvedHome = path.resolve(homeDir);
  const parsed = path.parse(resolvedHome);
  const env = {
    ...process.env,
    Y3MAKER_HOME: resolvedHome,
    HOME: resolvedHome,
    USERPROFILE: resolvedHome,
    ...extraEnv,
  };
  if (process.platform === "win32" && parsed.root) {
    env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, "");
    env.HOMEPATH = resolvedHome.slice(env.HOMEDRIVE.length) || "\\";
  }
  return env;
}

function snapshotDirectory(rootDir) {
  const result = {};
  if (!fs.existsSync(rootDir)) {
    return result;
  }
  function walk(currentDir, relDir) {
    for (const entry of fs.readdirSync(currentDir).sort()) {
      const fullPath = path.join(currentDir, entry);
      const relPath = relDir ? `${relDir}/${entry}` : entry;
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory()) {
        walk(fullPath, relPath);
      } else if (stats.isFile()) {
        result[relPath] = sha256(fs.readFileSync(fullPath));
      }
    }
  }
  walk(rootDir, "");
  return result;
}

function createFixture(options = {}) {
  const prefix = options.prefix || "y3maker-agents-test-";
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(tempRoot, "workspace");
  const homeDir = path.join(tempRoot, "home");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  function workspacePath(relPath) {
    return path.join(workspace, relPath.replaceAll("/", path.sep));
  }

  function homePath(relPath) {
    return path.join(homeDir, relPath.replaceAll("/", path.sep));
  }

  function runCli(scriptPath, args = [], opts = {}) {
    const res = spawnSync(process.execPath, [scriptPath, ...args], {
      cwd: opts.cwd || workspace,
      env: buildIsolatedEnv(opts.homeDir || homeDir, opts.env),
      encoding: "utf8",
      input: opts.input || "",
      windowsHide: true,
    });
    let json = null;
    const trimmed = (res.stdout || "").trim();
    if (trimmed) {
      try {
        json = JSON.parse(trimmed);
      } catch (_err) {
        json = null;
      }
    }
    return {
      status: res.status,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
      json,
    };
  }

  function withDefaultWorkspace(args, opts = {}) {
    if (opts.omitWorkspace || args.includes("--workspace")) {
      return args;
    }
    return [...args, "--workspace", opts.workspace || workspace];
  }

  return {
    tempRoot,
    workspace,
    homeDir,
    workspacePath,
    homePath,
    writeWorkspaceFile(relPath, content) {
      writeFileEnsureDir(workspacePath(relPath), content);
    },
    writeHomeFile(relPath, content) {
      writeFileEnsureDir(homePath(relPath), content);
    },
    readWorkspaceFile(relPath) {
      return fs.readFileSync(workspacePath(relPath), "utf8");
    },
    readWorkspaceBuffer(relPath) {
      return fs.readFileSync(workspacePath(relPath));
    },
    readWorkspaceJson(relPath) {
      return JSON.parse(fs.readFileSync(workspacePath(relPath), "utf8"));
    },
    readHomeFile(relPath) {
      return fs.readFileSync(homePath(relPath), "utf8");
    },
    readHomeJson(relPath) {
      return JSON.parse(fs.readFileSync(homePath(relPath), "utf8"));
    },
    existsInWorkspace(relPath) {
      return fs.existsSync(workspacePath(relPath));
    },
    existsInHome(relPath) {
      return fs.existsSync(homePath(relPath));
    },
    mkdirWorkspace(relPath) {
      fs.mkdirSync(workspacePath(relPath), { recursive: true });
    },
    mkdirHome(relPath) {
      fs.mkdirSync(homePath(relPath), { recursive: true });
    },
    removeWorkspacePath(relPath) {
      fs.rmSync(workspacePath(relPath), { recursive: true, force: true });
    },
    snapshotTree(relDir) {
      return snapshotDirectory(workspacePath(relDir));
    },
    runCli,
    runMigration(args = [], opts = {}) {
      return runCli(RUN_MIGRATION_SCRIPT, withDefaultWorkspace(args, opts), opts);
    },
    runInventory(extraArgs = [], opts = {}) {
      return runCli(RUN_MIGRATION_SCRIPT, withDefaultWorkspace(["inventory", ...extraArgs], opts), opts);
    },
    runApply(extraArgs = [], opts = {}) {
      return runCli(RUN_MIGRATION_SCRIPT, withDefaultWorkspace(["apply", ...extraArgs], opts), opts);
    },
    runVerify(extraArgs = [], opts = {}) {
      return runCli(VERIFY_MIGRATION_SCRIPT, withDefaultWorkspace(extraArgs, opts), opts);
    },
    cleanup() {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function seedMinimalY3Maker(fixture, options = {}) {
  fixture.writeWorkspaceFile(
    ".y3maker/knowledge/overview.md",
    "# 项目知识\n\n参考 `.codemaker/rules/api-safety.mdc`。\n"
  );
  fixture.writeWorkspaceFile(".y3maker/memory/facts.md", "# 历史记忆\n\n旧项目事实记录。\n");
  fixture.writeWorkspaceFile(
    ".y3maker/rules/api-safety.mdc",
    "---\ndescription: API 安全规则\n---\n\n禁止调用危险接口，详见 `.y3maker/knowledge/overview.md`。\n"
  );
  fixture.writeWorkspaceFile(
    ".y3maker/skills/y3-sample/SKILL.md",
    [
      "---",
      "name: wrong-name",
      "description: 示例技能",
      "tools: Read, Bash",
      "---",
      "",
      "# 示例技能",
      "",
      "阅读 `../../rules/api-safety.mdc` 并执行 `scripts/run.py`。",
      "",
    ].join("\n")
  );
  fixture.writeWorkspaceFile(".y3maker/skills/y3-sample/scripts/run.py", "print('ok')\n");

  if (options.withTemplates === "y3maker") {
    fixture.writeWorkspaceFile(".y3maker/templates/doc.md", "模板：`<agent>/knowledge/overview.md`\n");
  } else if (options.withTemplates === "codemaker") {
    fixture.writeWorkspaceFile(".codemaker/templates/legacy-tpl.md", "旧模板：`<codemaker>/rules/api-safety.mdc`\n");
  }

  if (options.mcpSettings !== undefined) {
    fixture.writeWorkspaceFile(
      ".y3maker/mcp_settings.json",
      typeof options.mcpSettings === "string"
        ? options.mcpSettings
        : `${JSON.stringify(options.mcpSettings, null, 2)}\n`
    );
  }
}

module.exports = {
  REPO_ROOT,
  RUN_MIGRATION_SCRIPT,
  SKILL_ROOT,
  VERIFY_MIGRATION_SCRIPT,
  buildIsolatedEnv,
  createFixture,
  seedMinimalY3Maker,
  snapshotDirectory,
};
