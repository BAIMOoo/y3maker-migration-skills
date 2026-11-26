const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { createFixture, seedMinimalY3Maker } = require("./helpers/fixture");

describe("sync-y3maker-to-agents 核心迁移（Canonical Store 与 CLI 契约）", () => {
  it("Slice 1: inventory 盘点 .y3maker、.codemaker/templates、MCP 配置与初始 manifest 状态", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        withTemplates: "codemaker",
        mcpSettings: {
          mcpServers: {
            "y3-tools": { command: "node", args: ["server.js"] },
            "disabled-srv": { command: "node", args: ["off.js"], disabled: true },
          },
        },
      });

      const res = fixture.runInventory(["--pretty"]);
      assert.equal(res.status, 0, `inventory 应退出 0，stderr: ${res.stderr}`);
      assert.ok(res.json, "inventory stdout 应为合法 JSON");
      assert.equal(res.json.exists[".y3maker"], true);
      assert.equal(res.json.exists[".codemaker"], true);
      assert.equal(res.json.exists[".agents"], false);
      assert.equal(res.json.exists["AGENTS.md"], false);
      assert.equal(res.json.exists["CLAUDE.md"], false);
      assert.equal(Object.prototype.hasOwnProperty.call(res.json.exists, ".omx"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(res.json.exists, ".omc"), false);

      assert.deepEqual(res.json.legacy.skills, ["y3-sample"]);
      assert.deepEqual(res.json.legacy.rules, ["api-safety.mdc"]);
      assert.deepEqual(res.json.legacy.knowledge, ["overview.md"]);
      assert.deepEqual(res.json.legacy.memory, ["facts.md"]);
      assert.equal(res.json.legacy.hasMcpSettings, true);
      assert.deepEqual(res.json.legacy.mcp.enabled, ["y3-tools"]);
      assert.deepEqual(res.json.legacy.mcp.disabled, ["disabled-srv"]);

      assert.equal(res.json.codemaker.hasTemplates, true);
      assert.deepEqual(res.json.codemaker.templates, ["legacy-tpl.md"]);

      assert.equal(res.json.manifest.path, ".agents/migration/y3maker-manifest.json");
      assert.equal(res.json.manifest.exists, false);
      assert.equal(res.json.manifest.trackedFiles, 0);
      assert.deepEqual(res.json.legacyTransition, { detected: false, legacyMigrations: [] });
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 2: 安全工作区护栏默认拒绝根目录、假用户主目录及五个宿主用户配置目录，仅 --allow-unsafe-workspace 放行", () => {
    const fixture = createFixture();
    try {
      const fsRoot = path.parse(fixture.workspace).root;
      const unsafeTargets = [
        fsRoot,
        fixture.homeDir,
        fixture.homePath(".codex"),
        fixture.homePath(".claude"),
        fixture.homePath(".agents"),
        fixture.homePath(".gemini"),
        fixture.homePath(".dsh"),
        fixture.homePath(".agents/nested-proj"),
      ];

      for (const unsafeDir of unsafeTargets) {
        if (unsafeDir !== fsRoot) {
          fixture.mkdirHome(path.relative(fixture.homeDir, unsafeDir));
        }

        const applyRes = fixture.runApply(["--targets", "codex", "--dry-run"], {
          workspace: unsafeDir,
        });
        assert.notEqual(applyRes.status, 0, `apply 应拒绝危险工作区: ${unsafeDir}`);
        assert.match(applyRes.stderr, /--allow-unsafe-workspace/);

        const verifyRes = fixture.runVerify([], { workspace: unsafeDir });
        assert.notEqual(verifyRes.status, 0, `verify 应拒绝危险工作区: ${unsafeDir}`);
        assert.match(verifyRes.stderr, /--allow-unsafe-workspace/);
      }

      // 在 fake home/.agents/nested-proj 中放入合法 .y3maker，验证显式 --allow-unsafe-workspace 可放行 verify 护栏检查
      const nestedDir = fixture.homePath(".agents/nested-proj");
      const verifyAllowed = fixture.runVerify(["--allow-unsafe-workspace"], {
        workspace: nestedDir,
      });
      // 允许通过安全护栏后，verify 应返回结构化 JSON（因缺少 .agents 目录而 ok: false，而不是护栏错误）
      assert.ok(verifyAllowed.json, `verify --allow-unsafe-workspace 应返回 JSON，stderr: ${verifyAllowed.stderr}`);
      assert.equal(verifyAllowed.json.ok, false);
      assert.equal(verifyAllowed.json.issues[0].type, "missing-path");
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 3: --targets 规范化与非交互模式下缺失 --targets / --mcp-scope 的拒绝保护", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: {
          mcpServers: {
            "y3-tools": { command: "node", args: ["server.js"] },
          },
        },
      });

      // 非交互模式下缺失 --targets 拒绝执行
      const noTargets = fixture.runApply(["--mcp-scope", "skip", "--dry-run"]);
      assert.notEqual(noTargets.status, 0);
      assert.match(noTargets.stderr, /--targets/);
      assert.equal(fixture.existsInWorkspace(".agents"), false);

      // 非法 --targets 拒绝执行
      const badTargets = fixture.runApply(["--targets", "codex,unknown", "--mcp-scope", "skip"]);
      assert.notEqual(badTargets.status, 0);
      assert.match(badTargets.stderr, /unknown/);

      // 非法 --mcp-scope 拒绝执行
      const badScope = fixture.runApply(["--targets", "codex", "--mcp-scope", "global"]);
      assert.notEqual(badScope.status, 0);
      assert.match(badScope.stderr, /--mcp-scope/);

      // 存在 .y3maker/mcp_settings.json 但未传 --mcp-scope，非交互模式拒绝写入
      const noScope = fixture.runApply(["--targets", "codex"]);
      assert.notEqual(noScope.status, 0);
      assert.match(noScope.stderr, /--mcp-scope/);
      assert.equal(fixture.existsInWorkspace(".agents"), false);

      // --targets agy,codex,codex 规范化为 ["antigravity", "codex"]
      const normalized = fixture.runApply([
        "--targets",
        "codex,agy,codex",
        "--mcp-scope",
        "skip",
        "--dry-run",
      ]);
      assert.equal(normalized.status, 0, `stderr: ${normalized.stderr}`);
      assert.deepEqual(normalized.json.targets, ["antigravity", "codex"]);
      assert.equal(normalized.json.mcp.scope, "skip");
      assert.equal(normalized.json.mcp.targets.antigravity.scope, "skip");
      assert.equal(normalized.json.mcp.targets.codex.scope, "skip");
      assert.equal(fixture.existsInWorkspace(".agents"), false, "dry-run 不应写入 .agents");

      // --targets all 展开为完整有序 4 宿主列表
      const allRes = fixture.runApply(["--targets", "all", "--mcp-scope", "skip", "--dry-run"]);
      assert.equal(allRes.status, 0, `stderr: ${allRes.stderr}`);
      assert.deepEqual(allRes.json.targets, ["antigravity", "claude", "codex", "dsh"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 4: apply 迁移核心树（含 .codemaker/templates 回退与 .mdc 原位保留）、过滤旧副产物、创建 openspec、清理 cmtmp 且保持只读边界", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, { withTemplates: "codemaker" });

      // 添加需要过滤的旧体系副产物
      fixture.writeWorkspaceFile(".y3maker/skills/README.md", "# 应跳过\n");
      fixture.writeWorkspaceFile(".y3maker/skills/install_skills.bat", "@echo off\n");
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-auto-test/SKILL.md",
        "---\nname: y3-auto-test\ndescription: 自动测试\n---\n\n正文。\n"
      );
      fixture.writeWorkspaceFile(".y3maker/skills/y3-auto-test/.queue/job.json", "{}\n");
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-obj-gen/SKILL.md",
        "---\nname: y3-obj-gen\ndescription: 对象生成\n---\n\n正文。\n"
      );
      fixture.writeWorkspaceFile(".y3maker/skills/y3-obj-gen/.claude-plugin/plugin.json", "{}\n");

      // 预先放入根目录 AGENTS.md 与 CLAUDE.md 以及 .agents/cmtmp 临时目录
      const originalAgentsMd = "# 自定义 AGENTS.md\n保留原样。\n";
      const originalClaudeMd = "# 自定义 CLAUDE.md\n保留原样。\n";
      fixture.writeWorkspaceFile("AGENTS.md", originalAgentsMd);
      fixture.writeWorkspaceFile("CLAUDE.md", originalClaudeMd);
      fixture.writeWorkspaceFile(".agents/cmtmp/dump.json", "{}\n");

      const legacyBefore = fixture.snapshotTree(".y3maker");

      // 先跑 dry-run：预览一切变更但不改磁盘
      const dryRes = fixture.runApply(["--targets", "codex", "--dry-run", "--pretty"]);
      assert.equal(dryRes.status, 0, `dry-run stderr: ${dryRes.stderr}`);
      assert.equal(dryRes.json.dryRun, true);
      assert.ok(dryRes.json.sync.created.includes(".agents/rules/api-safety.mdc"));
      assert.ok(dryRes.json.sync.created.includes(".agents/templates/legacy-tpl.md"));
      assert.deepEqual(dryRes.json.projectDefaults, ["openspec/docs", "openspec/reports"]);
      assert.deepEqual(dryRes.json.removedTempDirs, [".agents/cmtmp"]);
      assert.equal(fixture.existsInWorkspace(".agents/rules/api-safety.mdc"), false);
      assert.equal(fixture.existsInWorkspace("openspec/docs"), false);
      assert.equal(fixture.existsInWorkspace(".agents/cmtmp/dump.json"), true);

      // 正式执行 apply
      const applyRes = fixture.runApply(["--targets", "codex", "--pretty"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);
      assert.equal(applyRes.json.dryRun, false);

      // 核心资产与 .mdc 原位保留 + .codemaker/templates 回退
      assert.equal(fixture.existsInWorkspace(".agents/knowledge/overview.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/memory/facts.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/rules/api-safety.mdc"), true);
      assert.equal(fixture.existsInWorkspace(".agents/rules/api-safety.md"), false);
      assert.equal(fixture.existsInWorkspace(".agents/templates/legacy-tpl.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/skills/y3-sample/SKILL.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/skills/y3-sample/scripts/run.py"), true);

      // 已知旧副产物被过滤
      assert.equal(fixture.existsInWorkspace(".agents/skills/README.md"), false);
      assert.equal(fixture.existsInWorkspace(".agents/skills/install_skills.bat"), false);
      assert.equal(fixture.existsInWorkspace(".agents/skills/y3-auto-test/.queue/job.json"), false);
      assert.equal(
        fixture.existsInWorkspace(".agents/skills/y3-obj-gen/.claude-plugin/plugin.json"),
        false
      );

      // openspec 目录创建与 cmtmp 清理
      assert.equal(fixture.existsInWorkspace("openspec/docs"), true);
      assert.equal(fixture.existsInWorkspace("openspec/reports"), true);
      assert.equal(fixture.existsInWorkspace(".agents/cmtmp"), false);

      // 硬边界：.y3maker 只读；根目录 AGENTS.md / CLAUDE.md 未修改
      assert.deepEqual(fixture.snapshotTree(".y3maker"), legacyBefore);
      assert.equal(fixture.readWorkspaceFile("AGENTS.md"), originalAgentsMd);
      assert.equal(fixture.readWorkspaceFile("CLAUDE.md"), originalClaudeMd);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 4b: 当根目录无 AGENTS.md / CLAUDE.md 且同时存在 .y3maker/templates 与 .codemaker/templates 时，优先 .y3maker/templates 且不创建根目录文档", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, { withTemplates: "y3maker" });
      fixture.writeWorkspaceFile(".codemaker/templates/old-only.md", "旧版 .codemaker 模板\n");

      const res = fixture.runApply(["--targets", "dsh"]);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      assert.equal(fixture.existsInWorkspace(".agents/templates/doc.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/templates/old-only.md"), false);
      assert.equal(fixture.existsInWorkspace("AGENTS.md"), false);
      assert.equal(fixture.existsInWorkspace("CLAUDE.md"), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 5: 规范化文本路径、剥离 BOM、裁剪 SKILL.md frontmatter（保留多行 description）、特殊修复与二进制 .json 回退", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, { withTemplates: "codemaker" });

      // 带 UTF-8 BOM、CRLF、多余 frontmatter 字段、错误 name、多行 description 的 SKILL.md
      const bomSkill = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          [
            "---",
            "name: outdated-name",
            "description: >-",
            "  支持多行描述，且引用 .codemaker/rules/api-safety.mdc",
            "  以及 <agent>/knowledge/overview.md。",
            "tools: Read, Bash",
            "allowed-tools: Write",
            "custom-field: should-drop",
            "---",
            "",
            "# 正文",
            "",
            "旧路径：`.codemaker/knowledge/overview.md`、`.codex/memory/facts.md`、`.y3maker/rules/api-safety.mdc`、`.y3maker\\rules\\api-safety.mdc`、`<agent>/templates/legacy-tpl.md`、`<codemaker>/knowledge/overview.md`。",
            "",
          ].join("\r\n"),
          "utf8"
        ),
      ]);
      fixture.writeWorkspaceFile(".y3maker/skills/y3-sample/SKILL.md", bomSkill);

      // 特殊修复 1: y3-auto-test 脚本自引用
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-auto-test/SKILL.md",
        "---\nname: y3-auto-test\ndescription: 自动测试\n---\n\n正文。\n"
      );
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-auto-test/admin_daemon.ps1",
        "$dir = '.\\.codemaker\\skills\\desktop-automation'\r\n"
      );
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-auto-test/send_command.ps1",
        "$dir = '.\\.y3maker\\skills\\desktop-automation'\r\n"
      );

      // 特殊修复 2: y3-obj-gen cmtmp 提示替换
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-obj-gen/SKILL.md",
        [
          "---",
          "name: y3-obj-gen",
          "description: 对象生成",
          "---",
          "",
          "MCP 返回的数据会保存到临时文件 `.codemaker/cmtmp/` 目录下。由于数据量很大（56000+），需要使用脚本搜索：",
          "",
        ].join("\n")
      );

      // 含非 UTF-8/GB18030 字节的二进制 .json 数据文件（应回退原样复制）
      const binaryJson = Buffer.from([0x80, 0xff, 0x00, 0xfe, 0x99, 0x01, 0x02]);
      fixture.writeWorkspaceFile(".y3maker/knowledge/game-data.json", binaryJson);

      const res = fixture.runApply(["--targets", "codex"]);
      assert.equal(res.status, 0, `apply stderr: ${res.stderr}`);

      // 检查 SKILL.md 无 BOM、无 CRLF、仅保留 name 与 description、name 为目录名、路径全重写
      const rawSkillBuf = fixture.readWorkspaceBuffer(".agents/skills/y3-sample/SKILL.md");
      assert.notDeepEqual(
        [rawSkillBuf[0], rawSkillBuf[1], rawSkillBuf[2]],
        [0xef, 0xbb, 0xbf],
        "SKILL.md 不应残留 UTF-8 BOM"
      );
      const skillText = rawSkillBuf.toString("utf8");
      assert.equal(skillText.includes("\r\n"), false, "文本文件应规范化为 LF");
      assert.match(skillText, /^---\nname: y3-sample\ndescription: >-\n/);
      assert.equal(skillText.includes("tools:"), false);
      assert.equal(skillText.includes("allowed-tools:"), false);
      assert.equal(skillText.includes("custom-field:"), false);
      assert.equal(skillText.includes(".codemaker"), false);
      assert.equal(skillText.includes(".codex"), false);
      assert.equal(skillText.includes(".y3maker/"), false);
      assert.equal(skillText.includes(".y3maker\\"), false);
      assert.equal(skillText.includes("<agent>/"), false);
      assert.equal(skillText.includes("<codemaker>/"), false);
      assert.ok(skillText.includes(".agents/rules/api-safety.mdc"));
      assert.ok(skillText.includes(".agents\\rules\\api-safety.mdc"));
      assert.ok(skillText.includes(".agents/knowledge/overview.md"));
      assert.ok(skillText.includes(".agents/memory/facts.md"));
      assert.ok(skillText.includes(".agents/templates/legacy-tpl.md"));

      // 检查 .mdc 与模板也完成了路径重写
      const ruleText = fixture.readWorkspaceFile(".agents/rules/api-safety.mdc");
      assert.ok(ruleText.includes(".agents/knowledge/overview.md"));
      const tplText = fixture.readWorkspaceFile(".agents/templates/legacy-tpl.md");
      assert.ok(tplText.includes(".agents/rules/api-safety.mdc"));

      // 检查特殊修复 1 & 2
      assert.equal(
        fixture.readWorkspaceFile(".agents/skills/y3-auto-test/admin_daemon.ps1"),
        "$dir = '.\\.agents\\skills\\y3-auto-test'\n"
      );
      assert.equal(
        fixture.readWorkspaceFile(".agents/skills/y3-auto-test/send_command.ps1"),
        "$dir = '.\\.agents\\skills\\y3-auto-test'\n"
      );
      const objGenText = fixture.readWorkspaceFile(".agents/skills/y3-obj-gen/SKILL.md");
      assert.ok(
        objGenText.includes(
          "MCP 返回的数据应保存到一次性临时文件中，不要在 `.agents/` 下保留临时目录。由于数据量很大（56000+），需要使用脚本搜索："
        )
      );

      // 检查二进制 .json 原样回退复制
      assert.deepEqual(fixture.readWorkspaceBuffer(".agents/knowledge/game-data.json"), binaryJson);

      assert.ok(res.json.normalizedSkills.includes(".agents/skills/y3-sample/SKILL.md"));
      assert.ok(res.json.rewrittenFiles.includes(".agents/skills/y3-auto-test/admin_daemon.ps1"));
      assert.ok(res.json.rewrittenFiles.includes(".agents/skills/y3-obj-gen/SKILL.md"));
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 5b: 非法 SKILL.md frontmatter 不应被二进制回退静默吞掉，必须报错失败", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);
      fixture.writeWorkspaceFile(
        ".y3maker/skills/broken-skill/SKILL.md",
        "# 没有 frontmatter 的技能文件\n"
      );

      const res = fixture.runApply(["--targets", "codex"]);
      assert.notEqual(res.status, 0, "缺少 frontmatter 的 SKILL.md 必须报错");
      assert.match(res.stderr, /frontmatter/i);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 6: Migration Manifest 持久化 targets 与哈希，重复同步严格执行 update / blocked / resolved / orphaned 与 targets 复用", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);

      // 首次迁移：启用 codex + agy
      const first = fixture.runApply(["--targets", "codex,agy"]);
      assert.equal(first.status, 0, `first stderr: ${first.stderr}`);

      const manifest = fixture.readWorkspaceJson(".agents/migration/y3maker-manifest.json");
      assert.equal(manifest.tool, "sync-y3maker-to-agents");
      assert.deepEqual(manifest.targets, ["antigravity", "codex"]);
      assert.equal(manifest.files[".agents/knowledge/overview.md"].status, "managed");
      assert.ok(manifest.files[".agents/knowledge/overview.md"].sourceHash);
      assert.ok(manifest.files[".agents/knowledge/overview.md"].renderedHash);
      assert.ok(manifest.files[".agents/knowledge/overview.md"].targetHash);

      // 盘点可读取 manifest 已记录的 targets
      const inv = fixture.runInventory();
      assert.equal(inv.status, 0);
      assert.equal(inv.json.manifest.exists, true);
      assert.deepEqual(inv.json.manifest.targets, ["antigravity", "codex"]);

      // 无变更重复运行（省略 --targets 应自动复用 manifest.targets）
      const second = fixture.runApply([]);
      assert.equal(second.status, 0, `second stderr: ${second.stderr}`);
      assert.deepEqual(second.json.targets, ["antigravity", "codex"]);
      assert.equal(second.json.sync.created.length, 0);
      assert.equal(second.json.sync.updated.length, 0);
      assert.equal(second.json.sync.blocked.length, 0);
      assert.equal(second.json.sync.orphaned.length, 0);
      assert.equal(second.json.sync.unchangedCount, Object.keys(manifest.files).length);

      // 1) 仅源文件变化 -> 自动更新
      fixture.writeWorkspaceFile(
        ".y3maker/knowledge/overview.md",
        "# 项目知识 v2\n\n参考 `.codemaker/rules/api-safety.mdc`。\n"
      );

      // 2) 源与目标同时变化 -> 保护目标并标记 blocked
      fixture.writeWorkspaceFile(
        ".y3maker/rules/api-safety.mdc",
        "---\ndescription: API 安全规则 v2\n---\n\n上游新增条款。\n"
      );
      const localRuleContent = "---\ndescription: API 安全规则\n---\n\n本地手工定制条款。\n";
      fixture.writeWorkspaceFile(".agents/rules/api-safety.mdc", localRuleContent);

      // 3) 仅目标被本地修改 -> 保护目标并标记 blocked
      const localMemoryContent = "# 本地补充的记忆\n";
      fixture.writeWorkspaceFile(".agents/memory/facts.md", localMemoryContent);

      // 4) 源文件删除 -> 保留目标并标记 orphaned
      fixture.removeWorkspacePath(".y3maker/skills/y3-sample/scripts/run.py");

      const third = fixture.runApply([]);
      assert.equal(third.status, 0, `third stderr: ${third.stderr}`);
      assert.deepEqual(third.json.sync.updated, [".agents/knowledge/overview.md"]);
      assert.ok(
        fixture.readWorkspaceFile(".agents/knowledge/overview.md").includes("# 项目知识 v2")
      );

      const blockedPaths = third.json.sync.blocked.map((item) => item.path).sort();
      assert.deepEqual(blockedPaths, [".agents/memory/facts.md", ".agents/rules/api-safety.mdc"]);
      assert.equal(fixture.readWorkspaceFile(".agents/rules/api-safety.mdc"), localRuleContent);
      assert.equal(fixture.readWorkspaceFile(".agents/memory/facts.md"), localMemoryContent);

      const orphanedPaths = third.json.sync.orphaned.map((item) => item.path);
      assert.deepEqual(orphanedPaths, [".agents/skills/y3-sample/scripts/run.py"]);
      assert.equal(
        fixture.existsInWorkspace(".agents/skills/y3-sample/scripts/run.py"),
        true,
        "orphaned 文件不应被静默删除"
      );

      const manifestAfterThird = fixture.readWorkspaceJson(
        ".agents/migration/y3maker-manifest.json"
      );
      assert.equal(manifestAfterThird.files[".agents/rules/api-safety.mdc"].status, "blocked");
      assert.equal(manifestAfterThird.files[".agents/memory/facts.md"].status, "blocked");
      assert.equal(
        manifestAfterThird.files[".agents/skills/y3-sample/scripts/run.py"].status,
        "orphaned"
      );

      // 5) 解决冲突：将目标调整为与渲染结果一致，再次运行应变为 resolved -> managed
      fixture.writeWorkspaceFile(
        ".agents/rules/api-safety.mdc",
        "---\ndescription: API 安全规则 v2\n---\n\n上游新增条款。\n"
      );
      const fourth = fixture.runApply([]);
      assert.equal(fourth.status, 0);
      assert.deepEqual(fourth.json.sync.resolved, [".agents/rules/api-safety.mdc"]);
      const manifestAfterFourth = fixture.readWorkspaceJson(
        ".agents/migration/y3maker-manifest.json"
      );
      assert.equal(manifestAfterFourth.files[".agents/rules/api-safety.mdc"].status, "managed");
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 6b: 首次迁移遇已有未跟踪目标时，内容一致则 adopt，内容不同则 blocked 不覆盖", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);
      // 预先放入一个与渲染结果完全一致的文件（应 adopt）和一个不同的文件（应 blocked）
      fixture.writeWorkspaceFile(".agents/memory/facts.md", "# 历史记忆\n\n旧项目事实记录。\n");
      fixture.writeWorkspaceFile(".agents/knowledge/overview.md", "# 用户已有本地知识\n");

      const res = fixture.runApply(["--targets", "codex"]);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      assert.deepEqual(res.json.sync.adopted, [".agents/memory/facts.md"]);
      assert.deepEqual(
        res.json.sync.blocked.map((b) => b.path),
        [".agents/knowledge/overview.md"]
      );
      assert.equal(fixture.readWorkspaceFile(".agents/knowledge/overview.md"), "# 用户已有本地知识\n");
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 7: verify 端到端通过用例（§/# 规范化、scripts/ 技能根解析、二进制 .json 跳过、自身技能豁免、无 templates 条件放行）", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, { withTemplates: "codemaker" });

      // 在技能嵌套子文档中添加带 §、# 锚点、scripts/（位于技能根而非 references/ 下）与占位符路径的引用
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-sample/references/guide.md",
        [
          "# 指南",
          "",
          "- 章节引用：`.codemaker/rules/api-safety.mdc §2.1`",
          "- 锚点引用：`<agent>/knowledge/overview.md#section-1`",
          "- 技能根脚本：`scripts/run.py`",
          "- 不再维护的目录忽略：`.omx/project-memory.json`、`.omc/project-memory.json`",
          "- 占位符跳过：`.agents/rules/{name}.mdc`、`.agents/skills/...`、`openspec/reports/report/`",
          "",
        ].join("\n")
      );
      // 含非 UTF-8/GB18030 二进制数据的 .json
      fixture.writeWorkspaceFile(
        ".y3maker/knowledge/binary.json",
        Buffer.from([0x80, 0xff, 0x00, 0xfe])
      );

      const applyRes = fixture.runApply(["--targets", "codex,agy"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);

      // 模拟自身技能 sync-y3maker-to-agents 安装在 .agents/skills/ 下（正文提及 .y3maker/ 不应误报）
      fixture.writeWorkspaceFile(
        ".agents/skills/sync-y3maker-to-agents/SKILL.md",
        "---\nname: sync-y3maker-to-agents\ndescription: 迁移工具自身\n---\n\n读取 `.y3maker/` 与 `.codemaker`。\n"
      );

      const verifyRes = fixture.runVerify(["--pretty"]);
      assert.equal(verifyRes.status, 0, `verify 应通过，output: ${verifyRes.stdout} ${verifyRes.stderr}`);
      assert.equal(verifyRes.json.ok, true);
      assert.deepEqual(verifyRes.json.targets, ["antigravity", "codex"]);
      assert.deepEqual(verifyRes.json.issues, []);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 7b: verify 条件校验 templates/（无模板源时不强制要求 .agents/templates；有模板源缺失时报错）", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture); // 无 templates
      const applyRes = fixture.runApply(["--targets", "codex"]);
      assert.equal(applyRes.status, 0);

      // 删除空的 .agents/templates：因为无模板源且 manifest 无 templates 条目，verify 应依然通过
      fixture.removeWorkspacePath(".agents/templates");
      const verifyWithoutSource = fixture.runVerify();
      assert.equal(verifyWithoutSource.status, 0, `output: ${verifyWithoutSource.stdout}`);
      assert.equal(verifyWithoutSource.json.ok, true);

      // 新增 .codemaker/templates 源目录后仍缺少 .agents/templates，verify 必须报错 missing-path
      fixture.writeWorkspaceFile(".codemaker/templates/t.md", "模板\n");
      const verifyWithSource = fixture.runVerify();
      assert.equal(verifyWithSource.status, 1);
      assert.equal(verifyWithSource.json.ok, false);
      assert.ok(
        verifyWithSource.json.issues.some(
          (i) => i.type === "missing-path" && i.path === ".agents/templates"
        )
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 7c: verify 阻断所有关键异常（缺失目录、cmtmp、BOM、frontmatter、残留旧路径、悬空引用、blocked/orphaned、未选 MCP Scope）", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, { withTemplates: "y3maker" });
      const applyRes = fixture.runApply(["--targets", "codex"]);
      assert.equal(applyRes.status, 0);

      // 制造 blocked + orphaned
      fixture.writeWorkspaceFile(".y3maker/knowledge/overview.md", "# 源变更\n");
      fixture.writeWorkspaceFile(".agents/knowledge/overview.md", "# 本地变更\n");
      fixture.removeWorkspacePath(".y3maker/skills/y3-sample/scripts/run.py");
      const syncRes = fixture.runApply([]);
      assert.equal(syncRes.status, 0);

      // 制造残留旧路径（含 templates 活跃面 + <agent>/ + <codemaker>/ + .codex）
      fixture.writeWorkspaceFile(
        ".agents/templates/doc.md",
        "残留：.codemaker/x .codex/y .y3maker/z <agent>/a <codemaker>/b\n"
      );

      // 制造悬空引用（含 scripts/ 与 .agents/）
      fixture.writeWorkspaceFile(
        ".agents/skills/y3-sample/references/broken.md",
        "缺少 `.agents/knowledge/does-not-exist.md` 与 `scripts/nope.py`。\n"
      );

      // 制造 BOM + 非法额外 frontmatter 字段 + name 不一致
      fixture.writeWorkspaceFile(
        ".agents/skills/y3-sample/SKILL.md",
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(
            "---\nname: wrong-name\ndescription: 示例\nallowed-tools: Read\n---\n\n正文\n",
            "utf8"
          ),
        ])
      );

      // 制造缺少 SKILL.md 的技能目录与残留 cmtmp 目录
      fixture.mkdirWorkspace(".agents/skills/empty-skill");
      fixture.mkdirWorkspace(".agents/cmtmp");

      // 制造未记录 MCP scope 的 .y3maker/mcp_settings.json
      fixture.writeWorkspaceFile(
        ".y3maker/mcp_settings.json",
        JSON.stringify({ mcpServers: { demo: { command: "node", args: ["a.js"] } } })
      );

      const verifyRes = fixture.runVerify(["--pretty"]);
      assert.equal(verifyRes.status, 1, "存在问题时 verify 必须退出 1");
      assert.equal(verifyRes.json.ok, false);

      const issues = verifyRes.json.issues;
      const hasIssue = (type, pathPart, detailPattern) =>
        issues.some(
          (item) =>
            item.type === type &&
            (!pathPart || item.path === pathPart) &&
            (!detailPattern || detailPattern.test(item.detail))
        );

      assert.ok(hasIssue("merge-blocked", ".agents/knowledge/overview.md"), "应检出 merge-blocked");
      assert.ok(
        hasIssue("orphaned-target", ".agents/skills/y3-sample/scripts/run.py"),
        "应检出 orphaned-target"
      );
      assert.ok(hasIssue("extra-temp-dir", ".agents/cmtmp"), "应检出 extra-temp-dir");
      assert.ok(hasIssue("missing-skill", ".agents/skills/empty-skill/SKILL.md"), "应检出 missing-skill");
      assert.ok(hasIssue("bom", ".agents/skills/y3-sample/SKILL.md"), "应检出 bom");
      assert.ok(
        hasIssue("frontmatter", ".agents/skills/y3-sample/SKILL.md", /allowed-tools/),
        "应检出非法额外 frontmatter 字段"
      );
      assert.ok(
        hasIssue("frontmatter", ".agents/skills/y3-sample/SKILL.md", /name/),
        "应检出 name 与目录名不一致"
      );
      assert.ok(hasIssue("stale-path", ".agents/templates/doc.md", /\.codemaker/), "应检出 .codemaker");
      assert.ok(hasIssue("stale-path", ".agents/templates/doc.md", /\.codex/), "应检出 .codex");
      assert.ok(hasIssue("stale-path", ".agents/templates/doc.md", /\.y3maker/), "应检出 .y3maker/");
      assert.ok(hasIssue("stale-path", ".agents/templates/doc.md", /<agent>/), "应检出 <agent>/");
      assert.ok(
        hasIssue("stale-path", ".agents/templates/doc.md", /<codemaker>/),
        "应检出 <codemaker>/"
      );
      assert.ok(
        hasIssue("missing-reference", ".agents/skills/y3-sample/references/broken.md", /does-not-exist\.md/),
        "应检出缺失 .agents 引用"
      );
      assert.ok(
        hasIssue("missing-reference", ".agents/skills/y3-sample/references/broken.md", /scripts\/nope\.py/),
        "应检出缺失 scripts/ 引用"
      );
      assert.ok(
        hasIssue("mcp-target-unselected", ".y3maker/mcp_settings.json"),
        "应检出 mcp-target-unselected"
      );

      // 显式传入 --mcp-scope skip 时不应再报告 mcp-target-unselected
      const verifySkip = fixture.runVerify(["--mcp-scope", "skip"]);
      assert.equal(
        verifySkip.json.issues.some((i) => i.type === "mcp-target-unselected"),
        false
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 8: GB18030 编码文本正确解码转 UTF-8，文档中裸目录词如 `.claude`、`scripts` 不误报缺失引用", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);

      // GB18030 编码的中文 "规则" (0xB9 0xE6 0xD4 0xF2) + 旧路径 + 裸目录词 + CRLF
      const gb18030Content = Buffer.concat([
        Buffer.from([0xb9, 0xe6, 0xd4, 0xf2]),
        Buffer.from(
          ": see `.codemaker/knowledge/overview.md` and bare `.claude` / `scripts`.\r\n",
          "ascii"
        ),
      ]);
      fixture.writeWorkspaceFile(".y3maker/rules/gb-rule.mdc", gb18030Content);

      const applyRes = fixture.runApply(["--targets", "codex"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);

      const decoded = fixture.readWorkspaceFile(".agents/rules/gb-rule.mdc");
      assert.equal(
        decoded,
        "规则: see `.agents/knowledge/overview.md` and bare `.claude` / `scripts`.\n"
      );

      const verifyRes = fixture.runVerify(["--pretty"]);
      assert.equal(verifyRes.status, 0, `裸词不应误报 missing-reference: ${verifyRes.stdout}`);
      assert.equal(verifyRes.json.ok, true);
    } finally {
      fixture.cleanup();
    }
  });
});
