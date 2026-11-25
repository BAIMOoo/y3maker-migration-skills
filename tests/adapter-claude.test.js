const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createFixture, seedMinimalY3Maker } = require("./helpers/fixture");

describe("Claude Code 适配层（Skill Projection 与 Claude MCP 安全合并）", () => {
  it("Slice 1: apply --targets claude 单向投影 .agents/skills/ 至 .claude/skills/，不复制非 skill 目录，支持 dry-run 并纳入 manifest 跟踪", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, { withTemplates: "codemaker" });

      // 添加需要过滤的旧副产物与二进制资产（含二进制 .json）
      fixture.writeWorkspaceFile(".y3maker/skills/README.md", "# 顶层说明应忽略\n");
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

      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
      fixture.writeWorkspaceFile(".y3maker/skills/y3-sample/assets/icon.png", pngBytes);
      const binaryJson = Buffer.from([0x80, 0xff, 0x00, 0xfe, 0x99, 0x01]);
      fixture.writeWorkspaceFile(".y3maker/skills/y3-sample/data/raw.json", binaryJson);

      const legacyBefore = fixture.snapshotTree(".y3maker");

      // 先执行 dry-run：预览投影但不落盘
      const dryRes = fixture.runApply(["--targets", "claude", "--dry-run", "--pretty"]);
      assert.equal(dryRes.status, 0, `dry-run stderr: ${dryRes.stderr}`);
      assert.equal(dryRes.json.dryRun, true);
      assert.ok(dryRes.json.createdDirs.includes(".claude/skills"), "dry-run 应预告创建 .claude/skills");
      assert.ok(
        dryRes.json.sync.created.includes(".claude/skills/y3-sample/SKILL.md"),
        "dry-run 应预告投影 .claude/skills/y3-sample/SKILL.md"
      );
      assert.ok(
        dryRes.json.sync.created.includes(".claude/skills/y3-sample/scripts/run.py"),
        "dry-run 应预告投影技能内脚本"
      );
      assert.equal(fixture.existsInWorkspace(".claude"), false, "dry-run 不得创建 .claude 目录");
      assert.equal(fixture.existsInWorkspace(".agents"), false, "dry-run 不得创建 .agents 目录");

      // 正式执行 apply
      const applyRes = fixture.runApply(["--targets", "claude", "--pretty"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);
      assert.deepEqual(applyRes.json.targets, ["claude"]);

      // Canonical Store 存在完整资产
      assert.equal(fixture.existsInWorkspace(".agents/rules/api-safety.mdc"), true);
      assert.equal(fixture.existsInWorkspace(".agents/memory/facts.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/knowledge/overview.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/templates/legacy-tpl.md"), true);

      // .claude/skills/ 仅投影 skills 且过滤已知副产物
      assert.equal(fixture.existsInWorkspace(".claude/skills/y3-sample/SKILL.md"), true);
      assert.equal(fixture.existsInWorkspace(".claude/skills/y3-sample/scripts/run.py"), true);
      assert.equal(fixture.existsInWorkspace(".claude/skills/y3-auto-test/SKILL.md"), true);
      assert.equal(fixture.existsInWorkspace(".claude/skills/y3-obj-gen/SKILL.md"), true);
      assert.deepEqual(
        fixture.readWorkspaceBuffer(".claude/skills/y3-sample/assets/icon.png"),
        pngBytes
      );
      assert.deepEqual(
        fixture.readWorkspaceBuffer(".claude/skills/y3-sample/data/raw.json"),
        binaryJson
      );
      assert.equal(fixture.existsInWorkspace(".claude/skills/README.md"), false);
      assert.equal(fixture.existsInWorkspace(".claude/skills/y3-auto-test/.queue/job.json"), false);
      assert.equal(
        fixture.existsInWorkspace(".claude/skills/y3-obj-gen/.claude-plugin/plugin.json"),
        false
      );

      // 不在 .claude/ 下重复复制非 skill 目录
      assert.equal(fixture.existsInWorkspace(".claude/rules"), false);
      assert.equal(fixture.existsInWorkspace(".claude/memory"), false);
      assert.equal(fixture.existsInWorkspace(".claude/knowledge"), false);
      assert.equal(fixture.existsInWorkspace(".claude/templates"), false);
      assert.equal(fixture.existsInWorkspace(".claude/migration"), false);

      // 硬边界：.y3maker 只读；不创建 AGENTS.md / CLAUDE.md
      assert.deepEqual(fixture.snapshotTree(".y3maker"), legacyBefore);
      assert.equal(fixture.existsInWorkspace("AGENTS.md"), false);
      assert.equal(fixture.existsInWorkspace("CLAUDE.md"), false);

      // 投影文件全部纳入 .agents/migration/y3maker-manifest.json 跟踪
      const manifest = fixture.readWorkspaceJson(".agents/migration/y3maker-manifest.json");
      const projectedEntry = manifest.files[".claude/skills/y3-sample/SKILL.md"];
      assert.ok(projectedEntry, "manifest 应记录投影的 SKILL.md");
      assert.equal(projectedEntry.status, "managed");
      assert.equal(projectedEntry.adapterId, "claude");
      assert.equal(projectedEntry.source, ".agents/skills/y3-sample/SKILL.md");
      assert.ok(projectedEntry.sourceHash);
      assert.ok(projectedEntry.renderedHash);
      assert.ok(projectedEntry.targetHash);

      const projectedScript = manifest.files[".claude/skills/y3-sample/scripts/run.py"];
      assert.ok(projectedScript, "manifest 应记录投影的技能附属文件");
      assert.equal(projectedScript.status, "managed");
      assert.equal(projectedScript.adapterId, "claude");
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 2: 投影至 .claude/skills/ 时将跨目录相对引用（含更深层级与反斜杠）改写为 .agents/...，保留同级技能引用且不破坏 Canonical Store", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, { withTemplates: "y3maker" });
      fixture.writeWorkspaceFile(
        ".y3maker/skills/other-skill/SKILL.md",
        "---\nname: other-skill\ndescription: 另一个技能\n---\n\n正文。\n"
      );
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-sample/SKILL.md",
        [
          "---",
          "name: y3-sample",
          "description: >-",
          "  遵循 ../../rules/api-safety.mdc 的示例技能",
          "---",
          "",
          "- 规则：`../../rules/api-safety.mdc`",
          "- 记忆：`../../memory/facts.md`",
          "- 知识：`../../knowledge/overview.md`",
          "- 模板：`../../templates/doc.md`",
          "- 配置：`../../spec-config.json`",
          "- 同级技能：`../other-skill/SKILL.md`",
          "",
        ].join("\n")
      );
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-sample/references/deep/guide.md",
        [
          "# 深层引用",
          "",
          "- 规则：`../../../../rules/api-safety.mdc`",
          "- 三级模板：`../../../templates/doc.md`",
          "- 三级配置：`../../../spec-config.json`",
          "",
        ].join("\n")
      );
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-sample/scripts/helper.ps1",
        "$rule = '..\\..\\rules\\api-safety.mdc'\n$cfg = '..\\..\\..\\spec-config.json'\n"
      );

      const res = fixture.runApply(["--targets", "claude"]);
      assert.equal(res.status, 0, `apply stderr: ${res.stderr}`);

      // .claude/skills/ 下的跨目录相对引用全部改写为 .agents/...
      const claudeSkill = fixture.readWorkspaceFile(".claude/skills/y3-sample/SKILL.md");
      assert.ok(claudeSkill.includes("遵循 .agents/rules/api-safety.mdc 的示例技能"));
      assert.ok(claudeSkill.includes("`.agents/rules/api-safety.mdc`"));
      assert.ok(claudeSkill.includes("`.agents/memory/facts.md`"));
      assert.ok(claudeSkill.includes("`.agents/knowledge/overview.md`"));
      assert.ok(claudeSkill.includes("`.agents/templates/doc.md`"));
      assert.ok(claudeSkill.includes("`.agents/spec-config.json`"));
      assert.equal(claudeSkill.includes("../../rules/"), false);
      assert.equal(claudeSkill.includes("../../memory/"), false);
      assert.equal(claudeSkill.includes("../../knowledge/"), false);
      assert.equal(claudeSkill.includes("../../templates/"), false);
      assert.equal(claudeSkill.includes("../../spec-config.json"), false);
      assert.ok(claudeSkill.includes("`../other-skill/SKILL.md`"), "同级技能相对引用应保留");

      const claudeDeep = fixture.readWorkspaceFile(
        ".claude/skills/y3-sample/references/deep/guide.md"
      );
      assert.ok(claudeDeep.includes("`.agents/rules/api-safety.mdc`"));
      assert.ok(claudeDeep.includes("`.agents/templates/doc.md`"));
      assert.ok(claudeDeep.includes("`.agents/spec-config.json`"));
      assert.equal(claudeDeep.includes("../"), false);

      const claudePs1 = fixture.readWorkspaceFile(".claude/skills/y3-sample/scripts/helper.ps1");
      assert.equal(
        claudePs1,
        "$rule = '.agents\\rules\\api-safety.mdc'\n$cfg = '.agents\\spec-config.json'\n"
      );

      // Canonical Store (.agents/skills/) 保持原样（不被改为 .agents/... 破坏相对路径习惯）
      const canonicalSkill = fixture.readWorkspaceFile(".agents/skills/y3-sample/SKILL.md");
      assert.ok(canonicalSkill.includes("`../../rules/api-safety.mdc`"));
      assert.ok(res.json.rewrittenFiles.includes(".claude/skills/y3-sample/SKILL.md"));
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 3: 仅在 .claude/skills/*/SKILL.md 保留规范化后的 allowed-tools（含 tools 转换与多行列表），同时保持 .agents/skills/*/SKILL.md 仅含 name 与 description", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);

      // Skill A (y3-sample): seedMinimalY3Maker 已内置 `tools: Read, Bash` 与错误 name
      // 再放入嵌套子目录 references/SKILL.md（不应按顶层 SKILL.md 裁剪 frontmatter）
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-sample/references/SKILL.md",
        "# 嵌套参考文档\n\n不是顶层技能入口，参考 `../../../rules/api-safety.mdc`。\n"
      );

      // Skill B: 带 UTF-8 BOM、CRLF、多行 tools 列表与多余自定义字段
      const skillB = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          [
            "---",
            "name: old-b-name",
            "description: 技能 B",
            "tools:",
            "  - Read",
            "  - Edit",
            "custom-meta: drop-me",
            "---",
            "",
            "正文 B。",
            "",
          ].join("\r\n"),
          "utf8"
        ),
      ]);
      fixture.writeWorkspaceFile(".y3maker/skills/skill-b/SKILL.md", skillB);

      // Skill C: 同时含 tools 与 allowed-tools -> 优先保留 allowed-tools
      fixture.writeWorkspaceFile(
        ".y3maker/skills/skill-c/SKILL.md",
        [
          "---",
          "name: skill-c",
          "description: 技能 C",
          "tools: Read",
          "allowed-tools: Read, Grep, Bash",
          "---",
          "",
          "正文 C。",
          "",
        ].join("\n")
      );

      // Skill D: 无 tools / allowed-tools -> 仅保留 name 与 description
      fixture.writeWorkspaceFile(
        ".y3maker/skills/skill-d/SKILL.md",
        "---\nname: skill-d\ndescription: 技能 D\n---\n\n正文 D。\n"
      );

      const res = fixture.runApply(["--targets", "claude"]);
      assert.equal(res.status, 0, `apply stderr: ${res.stderr}`);

      // Skill A
      const canonicalA = fixture.readWorkspaceFile(".agents/skills/y3-sample/SKILL.md");
      const claudeA = fixture.readWorkspaceFile(".claude/skills/y3-sample/SKILL.md");
      assert.equal(canonicalA.includes("tools:"), false);
      assert.equal(canonicalA.includes("allowed-tools:"), false);
      assert.match(claudeA, /^---\nname: y3-sample\ndescription: 示例技能\nallowed-tools: Read, Bash\n---\n/);
      assert.equal(claudeA.includes("\ntools:"), false);

      // 嵌套 references/SKILL.md 不应做顶层 frontmatter 解析报错，且相对路径被改写
      assert.equal(
        fixture.readWorkspaceFile(".claude/skills/y3-sample/references/SKILL.md"),
        "# 嵌套参考文档\n\n不是顶层技能入口，参考 `.agents/rules/api-safety.mdc`。\n"
      );

      // Skill B: 无 BOM、无 CRLF、保留多行 allowed-tools、丢弃 custom-meta；.agents 下仅 name + description
      const rawClaudeB = fixture.readWorkspaceBuffer(".claude/skills/skill-b/SKILL.md");
      assert.notDeepEqual([rawClaudeB[0], rawClaudeB[1], rawClaudeB[2]], [0xef, 0xbb, 0xbf]);
      const claudeB = rawClaudeB.toString("utf8");
      const canonicalB = fixture.readWorkspaceFile(".agents/skills/skill-b/SKILL.md");
      assert.equal(claudeB.includes("\r\n"), false);
      assert.equal(claudeB.includes("custom-meta"), false);
      assert.match(
        claudeB,
        /^---\nname: skill-b\ndescription: 技能 B\nallowed-tools:\n  - Read\n  - Edit\n---\n\n正文 B。\n$/
      );
      assert.equal(canonicalB, "---\nname: skill-b\ndescription: 技能 B\n---\n\n正文 B。\n");

      // Skill C: 优先保留 allowed-tools，.agents 下仅 name + description
      const claudeC = fixture.readWorkspaceFile(".claude/skills/skill-c/SKILL.md");
      const canonicalC = fixture.readWorkspaceFile(".agents/skills/skill-c/SKILL.md");
      assert.equal(
        claudeC,
        "---\nname: skill-c\ndescription: 技能 C\nallowed-tools: Read, Grep, Bash\n---\n\n正文 C。\n"
      );
      assert.equal(canonicalC, "---\nname: skill-c\ndescription: 技能 C\n---\n\n正文 C。\n");

      // Skill D: 两者一致
      assert.equal(
        fixture.readWorkspaceFile(".claude/skills/skill-d/SKILL.md"),
        "---\nname: skill-d\ndescription: 技能 D\n---\n\n正文 D。\n"
      );
      assert.ok(res.json.normalizedSkills.includes(".claude/skills/y3-sample/SKILL.md"));
      assert.ok(res.json.normalizedSkills.includes(".claude/skills/skill-b/SKILL.md"));
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 4: 重复同步对 .claude/skills/ 完整执行 unchanged / update / blocked / resolved / orphaned 保护（含仅改 tools 触发投影更新）", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-extra/SKILL.md",
        "---\nname: y3-extra\ndescription: 额外技能\ntools: Read\n---\n\n正文 v1。\n"
      );

      // 首次迁移
      const first = fixture.runApply(["--targets", "claude"]);
      assert.equal(first.status, 0, `first stderr: ${first.stderr}`);

      // 无变更重复同步（自动复用 manifest.targets）
      const manifestFirst = fixture.readWorkspaceJson(".agents/migration/y3maker-manifest.json");
      const second = fixture.runApply([]);
      assert.equal(second.status, 0, `second stderr: ${second.stderr}`);
      assert.deepEqual(second.json.targets, ["claude"]);
      assert.equal(second.json.sync.created.length, 0);
      assert.equal(second.json.sync.updated.length, 0);
      assert.equal(second.json.sync.blocked.length, 0);
      assert.equal(second.json.sync.orphaned.length, 0);
      assert.equal(second.json.sync.unchangedCount, Object.keys(manifestFirst.files).length);

      // 1) 仅修改 .y3maker/skills/y3-extra/SKILL.md 的 tools（Canonical 不变，Claude 投影需自动更新）
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-extra/SKILL.md",
        "---\nname: y3-extra\ndescription: 额外技能\ntools: Read, Bash\n---\n\n正文 v1。\n"
      );

      // 2) y3-sample/SKILL.md 双端同时修改（上游更新 + .claude 副本本地改动）
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-sample/SKILL.md",
        [
          "---",
          "name: y3-sample",
          "description: 示例技能 v2",
          "tools: Read, Bash",
          "---",
          "",
          "# 示例技能 v2",
          "",
          "阅读 `../../rules/api-safety.mdc`。",
          "",
        ].join("\n")
      );
      const localClaudeSkill = "---\nname: y3-sample\ndescription: 本地手工定制\n---\n\n手工内容。\n";
      fixture.writeWorkspaceFile(".claude/skills/y3-sample/SKILL.md", localClaudeSkill);

      // 3) 删除上游脚本 -> .agents 与 .claude 副本均应保留并标记 orphaned
      fixture.removeWorkspacePath(".y3maker/skills/y3-sample/scripts/run.py");

      const third = fixture.runApply([]);
      assert.equal(third.status, 0, `third stderr: ${third.stderr}`);

      // y3-extra 仅 .claude 投影更新；y3-sample 仅 .agents 自动更新，.claude 被 blocked 保护
      assert.deepEqual(third.json.sync.updated.sort(), [
        ".agents/skills/y3-sample/SKILL.md",
        ".claude/skills/y3-extra/SKILL.md",
      ]);
      assert.ok(
        fixture
          .readWorkspaceFile(".claude/skills/y3-extra/SKILL.md")
          .includes("allowed-tools: Read, Bash")
      );
      assert.deepEqual(
        third.json.sync.blocked.map((item) => item.path),
        [".claude/skills/y3-sample/SKILL.md"]
      );
      assert.equal(
        fixture.readWorkspaceFile(".claude/skills/y3-sample/SKILL.md"),
        localClaudeSkill,
        "blocked 的 .claude/skills/ 文件不得被覆盖"
      );

      assert.deepEqual(
        third.json.sync.orphaned.map((item) => item.path).sort(),
        [".agents/skills/y3-sample/scripts/run.py", ".claude/skills/y3-sample/scripts/run.py"]
      );
      assert.equal(
        fixture.existsInWorkspace(".claude/skills/y3-sample/scripts/run.py"),
        true,
        "orphaned 的投影文件不得被静默删除"
      );

      // 此时运行 verify 必须检出 .claude/skills/ 的 merge-blocked 与 orphaned-target
      const verifyConflict = fixture.runVerify();
      assert.equal(verifyConflict.status, 1);
      assert.ok(
        verifyConflict.json.issues.some(
          (i) => i.type === "merge-blocked" && i.path === ".claude/skills/y3-sample/SKILL.md"
        ),
        "verify 应检出 .claude/skills/ 的 merge-blocked"
      );
      assert.ok(
        verifyConflict.json.issues.some(
          (i) => i.type === "orphaned-target" && i.path === ".claude/skills/y3-sample/scripts/run.py"
        ),
        "verify 应检出 .claude/skills/ 的 orphaned-target"
      );

      // 4) 人工合入解决 .claude/skills/y3-sample/SKILL.md 冲突后再次运行 -> resolved
      const resolvedContent = [
        "---",
        "name: y3-sample",
        "description: 示例技能 v2",
        "allowed-tools: Read, Bash",
        "---",
        "",
        "# 示例技能 v2",
        "",
        "阅读 `.agents/rules/api-safety.mdc`。",
        "",
      ].join("\n");
      fixture.writeWorkspaceFile(".claude/skills/y3-sample/SKILL.md", resolvedContent);

      const fourth = fixture.runApply([]);
      assert.equal(fourth.status, 0, `fourth stderr: ${fourth.stderr}`);
      assert.deepEqual(fourth.json.sync.resolved, [".claude/skills/y3-sample/SKILL.md"]);
      const manifestAfter = fixture.readWorkspaceJson(".agents/migration/y3maker-manifest.json");
      assert.equal(manifestAfter.files[".claude/skills/y3-sample/SKILL.md"].status, "managed");
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 4b: 首次启用 claude 遇旧版 .claude/ 历史目录时，不触碰旧 rules/migration，.claude/skills/ 内容一致 adopt、不一致 blocked 不覆盖", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);

      // 模拟旧版 sync-y3maker-to-claude 遗留目录与文件
      const oldRule = "# 旧版 .claude 规则，绝不可删除或修改\n";
      const oldManifest = JSON.stringify({ version: 1, tool: "sync-y3maker-to-claude", files: {} });
      const oldClaudeSkill = "---\nname: y3-sample\ndescription: 旧版技能\n---\n\n旧版 `.claude/rules/api-safety.mdc`。\n";
      fixture.writeWorkspaceFile(".claude/rules/old-rule.mdc", oldRule);
      fixture.writeWorkspaceFile(".claude/migration/y3maker-manifest.json", oldManifest);
      fixture.writeWorkspaceFile(".claude/skills/y3-sample/SKILL.md", oldClaudeSkill);
      fixture.writeWorkspaceFile(".claude/skills/y3-sample/scripts/run.py", "print('ok')\n");

      const res = fixture.runApply(["--targets", "claude"]);
      assert.equal(res.status, 0, `apply stderr: ${res.stderr}`);

      // 一致的脚本被 adopt；存在差异的旧 SKILL.md 被 blocked 保护不被覆盖
      assert.deepEqual(res.json.sync.adopted, [".claude/skills/y3-sample/scripts/run.py"]);
      assert.deepEqual(
        res.json.sync.blocked.map((item) => item.path),
        [".claude/skills/y3-sample/SKILL.md"]
      );
      assert.equal(fixture.readWorkspaceFile(".claude/skills/y3-sample/SKILL.md"), oldClaudeSkill);

      // 旧版 .claude/rules 与 .claude/migration 完整保留未动
      assert.equal(fixture.readWorkspaceFile(".claude/rules/old-rule.mdc"), oldRule);
      assert.equal(
        fixture.readWorkspaceFile(".claude/migration/y3maker-manifest.json"),
        oldManifest
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 5a: --mcp-scope project 安全合并至 .mcp.json（保留非受管配置、支持 headers、streamableHttp->http、跳过 disabled、dry-run 与冲突保护）", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: {
          mcpServers: {
            "y3-local": {
              command: "node",
              args: ["scripts/server.js"],
              env: { NODE_ENV: "production" },
            },
            "y3-http": {
              type: "streamableHttp",
              url: "https://example.com/mcp",
              headers: {
                Authorization: "Bearer demo-token",
                "X-Api-Key": "secret-123",
              },
            },
            "y3-sse": {
              type: "sse",
              url: "https://example.com/sse",
            },
            "y3-disabled": {
              command: "python",
              args: ["off.py"],
              disabled: true,
            },
          },
        },
      });

      // 预先存在 .mcp.json，包含非受管顶层字段与其他非受管服务
      const preExistingMcp = `${JSON.stringify(
        {
          customTopLevel: true,
          mcpServers: {
            "existing-project-srv": {
              type: "stdio",
              command: "uvx",
              args: ["keep-me"],
            },
          },
        },
        null,
        2
      )}\n`;
      fixture.writeWorkspaceFile(".mcp.json", preExistingMcp);

      // dry-run 预览合并但不落盘
      const dryRes = fixture.runApply([
        "--targets",
        "claude",
        "--mcp-scope",
        "project",
        "--dry-run",
      ]);
      assert.equal(dryRes.status, 0, `dry-run stderr: ${dryRes.stderr}`);
      assert.ok(dryRes.json.sync.updated.includes(".mcp.json"));
      assert.equal(fixture.readWorkspaceFile(".mcp.json"), preExistingMcp, "dry-run 不得修改 .mcp.json");
      assert.equal(dryRes.json.mcp.targets.claude.converted, true);
      assert.equal(dryRes.json.mcp.targets.claude.target, ".mcp.json");

      // 正式执行首次合并（mergeExisting: true 应安全合并而非误报 blocked）
      const applyRes = fixture.runApply(["--targets", "claude", "--mcp-scope", "project"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);
      assert.equal(applyRes.json.sync.blocked.length, 0);
      assert.ok(applyRes.json.sync.updated.includes(".mcp.json"));
      assert.equal(fixture.existsInHome(".claude.json"), false, "project scope 不得触碰 ~/.claude.json");

      const merged = fixture.readWorkspaceJson(".mcp.json");
      assert.equal(merged.customTopLevel, true, "应保留已有非受管顶层字段");
      assert.deepEqual(merged.mcpServers["existing-project-srv"], {
        type: "stdio",
        command: "uvx",
        args: ["keep-me"],
      });
      assert.deepEqual(merged.mcpServers["y3-local"], {
        type: "stdio",
        command: "node",
        args: ["scripts/server.js"],
        env: { NODE_ENV: "production" },
      });
      assert.deepEqual(merged.mcpServers["y3-http"], {
        type: "http",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer demo-token",
          "X-Api-Key": "secret-123",
        },
      });
      assert.deepEqual(merged.mcpServers["y3-sse"], {
        type: "sse",
        url: "https://example.com/sse",
      });
      assert.equal("y3-disabled" in merged.mcpServers, false, "disabled: true 服务必须跳过");

      assert.equal(applyRes.json.mcp.targets.claude.converted, true);
      assert.equal(applyRes.json.mcp.targets.claude.scope, "project");
      assert.equal(applyRes.json.mcp.targets.claude.target, ".mcp.json");
      assert.deepEqual(applyRes.json.mcp.targets.claude.servers, ["y3-http", "y3-local", "y3-sse"]);
      assert.deepEqual(applyRes.json.mcp.targets.claude.skipped, ["y3-disabled"]);

      // 幂等重跑 -> unchanged
      const second = fixture.runApply(["--mcp-scope", "project"]);
      assert.equal(second.status, 0, `second stderr: ${second.stderr}`);
      assert.equal(second.json.sync.updated.length, 0);
      assert.equal(second.json.sync.blocked.length, 0);
      assert.equal(second.json.mcp.targets.claude.action, "unchanged");

      // 上游 MCP 更新 -> 自动更新 .mcp.json 且继续保留非受管配置
      fixture.writeWorkspaceFile(
        ".y3maker/mcp_settings.json",
        JSON.stringify(
          {
            mcpServers: {
              "y3-local": { command: "node", args: ["scripts/server-v2.js"] },
            },
          },
          null,
          2
        )
      );
      const third = fixture.runApply(["--mcp-scope", "project"]);
      assert.equal(third.status, 0, `third stderr: ${third.stderr}`);
      assert.ok(third.json.sync.updated.includes(".mcp.json"));
      const afterUpstream = fixture.readWorkspaceJson(".mcp.json");
      assert.deepEqual(afterUpstream.mcpServers["y3-local"].args, ["scripts/server-v2.js"]);
      assert.ok(afterUpstream.mcpServers["existing-project-srv"]);

      // 手工修改 .mcp.json 中的受管服务 -> 下次同步标记 blocked 且保护手工改动
      afterUpstream.mcpServers["y3-local"].args = ["scripts/my-manual-override.js"];
      const manualContent = `${JSON.stringify(afterUpstream, null, 2)}\n`;
      fixture.writeWorkspaceFile(".mcp.json", manualContent);

      const fourth = fixture.runApply(["--mcp-scope", "project"]);
      assert.equal(fourth.status, 0, `fourth stderr: ${fourth.stderr}`);
      assert.deepEqual(
        fourth.json.sync.blocked.map((item) => item.path),
        [".mcp.json"]
      );
      assert.equal(fixture.readWorkspaceFile(".mcp.json"), manualContent);
      assert.equal(fourth.json.mcp.targets.claude.blocked, true);
      assert.equal(fourth.json.mcp.targets.claude.converted, false);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 5b: --mcp-scope user 仅安全合并至隔离 Fake Home ~/.claude.json 顶层 mcpServers，保留所有其他用户字段", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: {
          mcpServers: {
            "y3-remote": {
              type: "streamableHttp",
              url: "https://mcp.y3.example/v1",
              headers: { "X-Team": "y3" },
            },
          },
        },
      });

      fixture.writeHomeFile(
        ".claude.json",
        `${JSON.stringify(
          {
            numStartups: 12,
            theme: "dark",
            projects: {
              "D:\\other-proj": { allowedTools: ["Read"] },
            },
            mcpServers: {
              "personal-tool": {
                type: "stdio",
                command: "npx",
                args: ["-y", "personal-mcp"],
              },
            },
          },
          null,
          2
        )}\n`
      );

      const res = fixture.runApply(["--targets", "claude", "--mcp-scope", "user"]);
      assert.equal(res.status, 0, `apply stderr: ${res.stderr}`);
      assert.equal(fixture.existsInWorkspace(".mcp.json"), false, "user scope 不得生成工作区 .mcp.json");
      assert.equal(res.json.mcp.targets.claude.scope, "user");
      assert.equal(res.json.mcp.targets.claude.target, "~/.claude.json");
      assert.equal(res.json.mcp.targets.claude.converted, true);
      assert.deepEqual(res.json.mcp.targets.claude.servers, ["y3-remote"]);

      const userJson = fixture.readHomeJson(".claude.json");
      assert.equal(userJson.numStartups, 12);
      assert.equal(userJson.theme, "dark");
      assert.deepEqual(userJson.projects, { "D:\\other-proj": { allowedTools: ["Read"] } });
      assert.deepEqual(userJson.mcpServers["personal-tool"], {
        type: "stdio",
        command: "npx",
        args: ["-y", "personal-mcp"],
      });
      assert.deepEqual(userJson.mcpServers["y3-remote"], {
        type: "http",
        url: "https://mcp.y3.example/v1",
        headers: { "X-Team": "y3" },
      });

      const manifest = fixture.readWorkspaceJson(".agents/migration/y3maker-manifest.json");
      assert.equal(manifest.files["~/.claude.json"].targetScope, "user");
      assert.equal(manifest.files["~/.claude.json"].status, "managed");

      // 模拟 Claude Code 自身更新无关顶层字段 numStartups（未改动受管服务且上游未变）-> adopt，不误报冲突
      userJson.numStartups = 13;
      fixture.writeHomeFile(".claude.json", `${JSON.stringify(userJson, null, 2)}\n`);
      const second = fixture.runApply(["--mcp-scope", "user"]);
      assert.equal(second.status, 0, `second stderr: ${second.stderr}`);
      assert.equal(second.json.sync.blocked.length, 0);
      assert.ok(second.json.sync.adopted.includes("~/.claude.json"));
      assert.equal(fixture.readHomeJson(".claude.json").numStartups, 13);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 5c: --mcp-scope skip 显式跳过且不写入 MCP；空 mcpServers 发出明确警告并安全保留既有服务", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: { mcpServers: {} },
      });

      // 1) skip 模式：不生成 .mcp.json 与 ~/.claude.json，但报告空警告
      const skipRes = fixture.runApply(["--targets", "claude", "--mcp-scope", "skip"]);
      assert.equal(skipRes.status, 0, `skip stderr: ${skipRes.stderr}`);
      assert.equal(fixture.existsInWorkspace(".mcp.json"), false);
      assert.equal(fixture.existsInHome(".claude.json"), false);
      assert.equal(skipRes.json.mcp.targets.claude.scope, "skip");
      assert.equal(skipRes.json.mcp.targets.claude.converted, false);
      assert.deepEqual(skipRes.json.mcp.targets.claude.skipped, ["mcp_settings.json"]);
      assert.equal(skipRes.json.mcp.targets.claude.empty, true);
      assert.ok(
        skipRes.json.mcp.warnings.some((w) => w.includes("mcpServers")),
        "空 mcpServers 应发出明确警告"
      );

      // 2) project 模式遇到空 mcpServers 与既有 .mcp.json -> 发出警告并保留既有非受管服务
      fixture.writeWorkspaceFile(
        ".mcp.json",
        `${JSON.stringify({ mcpServers: { keep: { type: "stdio", command: "node" } } }, null, 2)}\n`
      );
      const emptyProjectRes = fixture.runApply(["--targets", "claude", "--mcp-scope", "project"]);
      assert.equal(emptyProjectRes.status, 0, `empty project stderr: ${emptyProjectRes.stderr}`);
      assert.equal(emptyProjectRes.json.mcp.targets.claude.empty, true);
      assert.equal(emptyProjectRes.json.mcp.targets.claude.converted, true);
      assert.equal(emptyProjectRes.json.mcp.targets.claude.target, ".mcp.json");
      assert.ok(
        emptyProjectRes.json.mcp.targets.claude.warnings.some((w) => w.includes("mcpServers")),
        "claude MCP 报告中应含空 mcpServers 警告"
      );
      assert.deepEqual(fixture.readWorkspaceJson(".mcp.json"), {
        mcpServers: { keep: { type: "stdio", command: "node" } },
      });

      // 3) 已有 .mcp.json 语法损坏时应明确报错且不覆盖原文件
      fixture.writeWorkspaceFile(".mcp.json", "{ broken json");
      const brokenRes = fixture.runApply(["--targets", "claude", "--mcp-scope", "project"]);
      assert.notEqual(brokenRes.status, 0, "损坏的 .mcp.json 应报错");
      assert.match(brokenRes.stderr, /\.mcp\.json/);
      assert.equal(fixture.readWorkspaceFile(".mcp.json"), "{ broken json");
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 6a: verify 在 claude 目标下端到端通过（project/user/skip MCP、allowed-tools、.agents 引用、scripts 技能根解析、自身技能豁免）", () => {
    // 1) project MCP + 完整技能引用
    const projectFixture = createFixture();
    try {
      seedMinimalY3Maker(projectFixture, {
        withTemplates: "y3maker",
        mcpSettings: {
          mcpServers: {
            "y3-http": {
              type: "streamableHttp",
              url: "https://example.com/mcp",
              headers: { Authorization: "Bearer demo" },
            },
          },
        },
      });
      projectFixture.writeWorkspaceFile(
        ".y3maker/skills/y3-sample/references/guide.md",
        [
          "# 指南",
          "",
          "- 章节引用：`../../../rules/api-safety.mdc §1.2`",
          "- 锚点引用：`../../../knowledge/overview.md#intro`",
          "- 技能根脚本：`scripts/run.py`",
          "- 占位符跳过：`.agents/rules/{name}.mdc`、`scripts/`",
          "",
        ].join("\n")
      );
      projectFixture.writeWorkspaceFile(
        ".y3maker/skills/y3-sample/data/raw.json",
        Buffer.from([0x80, 0xff, 0x00, 0xfe])
      );

      const applyRes = projectFixture.runApply(["--targets", "claude", "--mcp-scope", "project"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);

      // 在 .claude/skills/ 下模拟安装自身技能（含 .y3maker/ 与 ../../rules/ 示例说明，应豁免不误报）
      projectFixture.writeWorkspaceFile(
        ".claude/skills/sync-y3maker-to-agents/SKILL.md",
        "---\nname: sync-y3maker-to-agents\ndescription: 统一迁移工具\nallowed-tools: Read, Bash\n---\n\n读取 `.y3maker/` 与 `../../rules/foo.mdc`。\n"
      );

      const verifyRes = projectFixture.runVerify(["--pretty"]);
      assert.equal(
        verifyRes.status,
        0,
        `project verify 应通过，output: ${verifyRes.stdout} ${verifyRes.stderr}`
      );
      assert.equal(verifyRes.json.ok, true);
      assert.deepEqual(verifyRes.json.targets, ["claude"]);
      assert.equal(verifyRes.json.mcpScope, "project");
      assert.deepEqual(verifyRes.json.issues, []);
    } finally {
      projectFixture.cleanup();
    }

    // 2) user MCP
    const userFixture = createFixture();
    try {
      seedMinimalY3Maker(userFixture, {
        mcpSettings: {
          mcpServers: {
            "y3-local": { command: "node", args: ["server.js"] },
          },
        },
      });
      const applyUser = userFixture.runApply(["--targets", "claude", "--mcp-scope", "user"]);
      assert.equal(applyUser.status, 0, `apply user stderr: ${applyUser.stderr}`);

      const verifyUser = userFixture.runVerify();
      assert.equal(verifyUser.status, 0, `user verify 应通过，output: ${verifyUser.stdout}`);
      assert.equal(verifyUser.json.ok, true);
      assert.equal(verifyUser.json.mcpScope, "user");
      assert.deepEqual(verifyUser.json.issues, []);
    } finally {
      userFixture.cleanup();
    }

    // 3) skip MCP
    const skipFixture = createFixture();
    try {
      seedMinimalY3Maker(skipFixture, {
        mcpSettings: {
          mcpServers: {
            "y3-local": { command: "node", args: ["server.js"] },
          },
        },
      });
      const applySkip = skipFixture.runApply(["--targets", "claude", "--mcp-scope", "skip"]);
      assert.equal(applySkip.status, 0, `apply skip stderr: ${applySkip.stderr}`);

      const verifySkip = skipFixture.runVerify();
      assert.equal(verifySkip.status, 0, `skip verify 应通过，output: ${verifySkip.stdout}`);
      assert.equal(verifySkip.json.ok, true);
      assert.equal(verifySkip.json.mcpScope, "skip");
      assert.deepEqual(verifySkip.json.issues, []);
    } finally {
      skipFixture.cleanup();
    }
  });

  it("Slice 6b: verify 阻断 claude 适配层全部关键异常（缺少投影目录/技能、BOM、非法 frontmatter、未改写相对路径、悬空引用、MCP 缺失/损坏/缺服务）", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: {
          mcpServers: {
            "y3-tools": { command: "node", args: ["server.js"] },
          },
        },
      });
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-second/SKILL.md",
        "---\nname: y3-second\ndescription: 第二个技能\n---\n\n正文。\n"
      );

      const applyRes = fixture.runApply(["--targets", "claude", "--mcp-scope", "project"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);

      // 1) 整个 .claude/skills 缺失 -> missing-path
      fixture.removeWorkspacePath(".claude/skills");
      const missingRootVerify = fixture.runVerify();
      assert.equal(missingRootVerify.status, 1);
      assert.ok(
        missingRootVerify.json.issues.some(
          (i) => i.type === "missing-path" && i.path === ".claude/skills"
        ),
        "缺少 .claude/skills 时应报 missing-path"
      );

      // 恢复投影后制造细粒度异常
      const reapply = fixture.runApply(["--targets", "claude", "--mcp-scope", "project"]);
      assert.equal(reapply.status, 0);

      // 2) 删除其中一个对应 Canonical Store 的投影技能目录 -> missing-skill
      fixture.removeWorkspacePath(".claude/skills/y3-second");

      // 3) 空技能目录缺少 SKILL.md -> missing-skill
      fixture.mkdirWorkspace(".claude/skills/empty-claude-skill");

      // 4) BOM + 非法 frontmatter 字段（遗留 tools: 与未知键）+ name 不一致
      fixture.writeWorkspaceFile(
        ".claude/skills/y3-sample/SKILL.md",
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(
            [
              "---",
              "name: wrong-claude-name",
              "description: 损坏技能",
              "tools: Read",
              "extra-key: forbidden",
              "---",
              "",
              "旧路径 `.codemaker/a`、未改写相对路径 `../../rules/api-safety.mdc`、悬空 `.agents/knowledge/missing.md` 与 `scripts/missing.py`。",
              "",
            ].join("\n"),
            "utf8"
          ),
        ])
      );
      // 即使遗留 .claude/rules/api-safety.mdc 存在，未改写的 ../../rules/api-safety.mdc 也必须被 stale-path 检出
      fixture.writeWorkspaceFile(".claude/rules/api-safety.mdc", "# 旧遗留规则\n");

      // 5) .mcp.json 缺少已启用的遗留服务
      fixture.writeWorkspaceFile(".mcp.json", `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);

      const verifyRes = fixture.runVerify(["--pretty"]);
      assert.equal(verifyRes.status, 1, "存在异常时 verify 必须退出 1");
      assert.equal(verifyRes.json.ok, false);

      const issues = verifyRes.json.issues;
      const hasIssue = (type, pathPart, detailPattern) =>
        issues.some(
          (item) =>
            item.type === type &&
            (!pathPart || item.path === pathPart) &&
            (!detailPattern || detailPattern.test(item.detail))
        );

      assert.ok(
        hasIssue("missing-skill", ".claude/skills/y3-second/SKILL.md"),
        "应检出缺失对应 Canonical Store 技能的投影"
      );
      assert.ok(
        hasIssue("missing-skill", ".claude/skills/empty-claude-skill/SKILL.md"),
        "应检出缺少 SKILL.md 的空技能目录"
      );
      assert.ok(hasIssue("bom", ".claude/skills/y3-sample/SKILL.md"), "应检出 BOM");
      assert.ok(
        hasIssue("frontmatter", ".claude/skills/y3-sample/SKILL.md", /tools/),
        "应检出未规范化的 tools 字段"
      );
      assert.ok(
        hasIssue("frontmatter", ".claude/skills/y3-sample/SKILL.md", /extra-key/),
        "应检出不允许的额外 frontmatter 字段"
      );
      assert.ok(
        hasIssue("frontmatter", ".claude/skills/y3-sample/SKILL.md", /name/),
        "应检出 name 不一致"
      );
      assert.ok(
        hasIssue("stale-path", ".claude/skills/y3-sample/SKILL.md", /\.codemaker/),
        "应检出残留 .codemaker 路径"
      );
      assert.ok(
        hasIssue("stale-path", ".claude/skills/y3-sample/SKILL.md", /相对引用|\.agents/),
        "即使旧 .claude/rules 存在，也应检出未改写的跨目录相对引用"
      );
      assert.ok(
        hasIssue("missing-reference", ".claude/skills/y3-sample/SKILL.md", /missing\.md/),
        "应检出悬空的 .agents 引用"
      );
      assert.ok(
        hasIssue("missing-reference", ".claude/skills/y3-sample/SKILL.md", /scripts\/missing\.py/),
        "应检出悬空的 scripts/ 引用"
      );
      assert.ok(
        hasIssue("missing-mcp-server", ".mcp.json", /y3-tools/),
        "应检出 .mcp.json 缺少已启用的遗留服务"
      );

      // 6) .mcp.json 损坏 JSON -> invalid-mcp-config
      fixture.writeWorkspaceFile(".mcp.json", "{ not json");
      const corruptMcp = fixture.runVerify();
      assert.equal(corruptMcp.status, 1);
      assert.ok(
        corruptMcp.json.issues.some(
          (i) => i.type === "invalid-mcp-config" && i.path === ".mcp.json"
        ),
        "损坏的 .mcp.json 应报 invalid-mcp-config"
      );

      // 7) 删除 .mcp.json -> missing-path；切换到 --mcp-scope user 且缺失 ~/.claude.json -> missing-path
      fixture.removeWorkspacePath(".mcp.json");
      const missingProjectMcp = fixture.runVerify(["--mcp-scope", "project"]);
      assert.ok(
        missingProjectMcp.json.issues.some(
          (i) => i.type === "missing-path" && i.path === ".mcp.json"
        ),
        "缺失 .mcp.json 应报 missing-path"
      );

      const missingUserMcp = fixture.runVerify(["--mcp-scope", "user"]);
      assert.ok(
        missingUserMcp.json.issues.some(
          (i) => i.type === "missing-path" && i.path === "~/.claude.json"
        ),
        "缺失 ~/.claude.json 应报 missing-path"
      );

      // 8) ~/.claude.json 缺少 mcpServers 对象 -> invalid-mcp-config
      fixture.writeHomeFile(".claude.json", JSON.stringify({ theme: "dark" }));
      const invalidUserMcp = fixture.runVerify(["--mcp-scope", "user"]);
      assert.ok(
        invalidUserMcp.json.issues.some(
          (i) => i.type === "invalid-mcp-config" && i.path === "~/.claude.json"
        ),
        "缺少 mcpServers 的 ~/.claude.json 应报 invalid-mcp-config"
      );
    } finally {
      fixture.cleanup();
    }
  });
});
