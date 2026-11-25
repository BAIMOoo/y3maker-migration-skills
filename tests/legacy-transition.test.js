const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");

const { REPO_ROOT, createFixture, seedMinimalY3Maker } = require("./helpers/fixture");

const LEGACY_CODEX_SCRIPT = path.join(REPO_ROOT, "sync-y3maker-to-codex", "scripts", "run-migration.js");
const LEGACY_CLAUDE_SCRIPT = path.join(REPO_ROOT, "sync-y3maker-to-claude", "scripts", "run-migration.js");

function sha256TextLf(text) {
  return crypto.createHash("sha256").update(Buffer.from(text.replace(/\r\n/g, "\n"), "utf8")).digest("hex");
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

describe("旧版 .codex/ 与 .claude/ 迁移副本过渡盘点检测（Ticket #7）", () => {
  it("Slice 1: 无旧版 manifest 的新工作区（即使存在非旧迁移的 .codex 或 .claude 文件）输出干净空结果且无误报噪声", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);
      // 模拟非旧版迁移产生的普通配置目录/文件（不存在 migration/y3maker-manifest.json）
      fixture.writeWorkspaceFile(".codex/config.toml", "model = \"gpt-5\"\n");
      fixture.writeWorkspaceFile(".claude/settings.local.json", "{}\n");

      const inv = fixture.runInventory(["--pretty"]);
      assert.equal(inv.status, 0, `inventory stderr: ${inv.stderr}`);
      assert.deepEqual(inv.json.legacyTransition, {
        detected: false,
        legacyMigrations: [],
      });

      const applyRes = fixture.runApply(["--targets", "dsh", "--pretty"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);
      assert.deepEqual(applyRes.json.legacyTransition, {
        detected: false,
        legacyMigrations: [],
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 2: 自动发现旧版 .codex manifest，准确区分未改动文件（含 CRLF 与二进制 .json）与本地手工改动/历史 blocked 文件，且零破坏", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);

      // 准备旧版 .codex 迁移副本：
      // 1) 未改动文本文件（磁盘使用 CRLF，检验 LF 规范化哈希一致）
      const knowledgeLf = "# 项目知识\n\n参考 `.codex/rules/api-safety.mdc`。\n";
      fixture.writeWorkspaceFile(".codex/knowledge/overview.md", knowledgeLf.replace(/\n/g, "\r\n"));

      // 2) 未改动二进制 .json 文件
      const binaryJson = Buffer.from([0x80, 0xff, 0x00, 0xfe, 0x42]);
      fixture.writeWorkspaceFile(".codex/knowledge/game-data.json", binaryJson);

      // 3) 未改动技能文件
      const skillText = "---\nname: y3-sample\ndescription: 示例技能\n---\n\n正文\n";
      fixture.writeWorkspaceFile(".codex/skills/y3-sample/SKILL.md", skillText);

      // 4) 空的旧 templates 目录（旧版工具会默认创建）
      fixture.mkdirWorkspace(".codex/templates");

      // 5) 磁盘内容已偏离旧版 manifest 基线的手工改动文件
      const originalRule = "---\ndescription: API 安全规则\n---\n\n原始规则。\n";
      const editedRule = "---\ndescription: API 安全规则\n---\n\n开发者在 .codex 中追加的本地规则。\n";
      fixture.writeWorkspaceFile(".codex/rules/api-safety.mdc", editedRule);

      // 6) 旧版 manifest 中本身就标记为 blocked 的文件（targetHash 等于当前磁盘但与 renderedHash 冲突）
      const renderedMemory = "# 历史记忆\n\n原始版本。\n";
      const blockedLocalMemory = "# 历史记忆\n\n旧版同步冲突时保留的本地修改。\n";
      fixture.writeWorkspaceFile(".codex/memory/facts.md", blockedLocalMemory);

      const legacyCodexManifest = {
        version: 1,
        tool: "sync-y3maker-to-codex",
        updatedAt: "2026-01-15T10:00:00.000Z",
        files: {
          ".codex/knowledge/overview.md": {
            status: "managed",
            kind: "knowledge",
            source: ".y3maker/knowledge/overview.md",
            target: ".codex/knowledge/overview.md",
            targetScope: "project",
            sourceHash: sha256TextLf(knowledgeLf),
            renderedHash: sha256TextLf(knowledgeLf),
            targetHash: sha256TextLf(knowledgeLf),
          },
          ".codex/knowledge/game-data.json": {
            status: "managed",
            kind: "knowledge",
            source: ".y3maker/knowledge/game-data.json",
            target: ".codex/knowledge/game-data.json",
            targetScope: "project",
            sourceHash: sha256Buffer(binaryJson),
            renderedHash: sha256Buffer(binaryJson),
            targetHash: sha256Buffer(binaryJson),
          },
          ".codex/skills/y3-sample/SKILL.md": {
            status: "managed",
            kind: "skill",
            source: ".y3maker/skills/y3-sample/SKILL.md",
            target: ".codex/skills/y3-sample/SKILL.md",
            targetScope: "project",
            sourceHash: sha256TextLf(skillText),
            renderedHash: sha256TextLf(skillText),
            targetHash: sha256TextLf(skillText),
          },
          ".codex/rules/api-safety.mdc": {
            status: "managed",
            kind: "rules",
            source: ".y3maker/rules/api-safety.mdc",
            target: ".codex/rules/api-safety.mdc",
            targetScope: "project",
            sourceHash: sha256TextLf(originalRule),
            renderedHash: sha256TextLf(originalRule),
            targetHash: sha256TextLf(originalRule),
          },
          ".codex/memory/facts.md": {
            status: "blocked",
            kind: "memory",
            source: ".y3maker/memory/facts.md",
            target: ".codex/memory/facts.md",
            targetScope: "project",
            sourceHash: sha256TextLf(renderedMemory),
            renderedHash: sha256TextLf(renderedMemory),
            targetHash: sha256TextLf(blockedLocalMemory),
            blockedReason: "target changed locally after the last migration",
          },
        },
      };
      fixture.writeWorkspaceFile(
        ".codex/migration/y3maker-manifest.json",
        `${JSON.stringify(legacyCodexManifest, null, 2)}\n`
      );

      const codexBefore = fixture.snapshotTree(".codex");
      const y3makerBefore = fixture.snapshotTree(".y3maker");

      // 在 inventory、apply --dry-run、apply 三个入口均应输出一致的过渡盘点结果
      const inv = fixture.runInventory(["--pretty"]);
      assert.equal(inv.status, 0, `inventory stderr: ${inv.stderr}`);

      const dryApply = fixture.runApply(["--targets", "dsh", "--dry-run", "--pretty"]);
      assert.equal(dryApply.status, 0, `dry-run stderr: ${dryApply.stderr}`);

      const applyRes = fixture.runApply(["--targets", "dsh", "--pretty"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);

      for (const [label, report] of [
        ["inventory", inv.json.legacyTransition],
        ["apply --dry-run", dryApply.json.legacyTransition],
        ["apply", applyRes.json.legacyTransition],
      ]) {
        assert.equal(report.detected, true, `${label}: 应检测到旧版迁移`);
        assert.equal(report.legacyMigrations.length, 1, `${label}: 应有 1 条旧迁移记录`);

        const codex = report.legacyMigrations[0];
        assert.equal(codex.harness, "codex");
        assert.equal(codex.rootDir, ".codex");
        assert.equal(codex.manifestPath, ".codex/migration/y3maker-manifest.json");
        assert.equal(codex.manifestValid, true);
        assert.equal(codex.tool, "sync-y3maker-to-codex");
        assert.equal(codex.trackedFiles, 5);

        assert.deepEqual(codex.files.unmodified, [
          ".codex/knowledge/game-data.json",
          ".codex/knowledge/overview.md",
          ".codex/skills/y3-sample/SKILL.md",
        ]);
        assert.deepEqual(
          codex.files.modified.map((item) => item.path),
          [".codex/memory/facts.md", ".codex/rules/api-safety.mdc"]
        );
        assert.deepEqual(
          codex.manualReviewRequired.map((item) => item.path),
          [".codex/memory/facts.md", ".codex/rules/api-safety.mdc"]
        );

        // 仅含未改动文件或空目录的子目录进入 safeToCleanDirectories；含手工改动文件及 migration 目录不得进入
        assert.deepEqual(codex.safeToCleanDirectories, [
          ".codex/knowledge",
          ".codex/skills",
          ".codex/templates",
        ]);
        assert.deepEqual(codex.reviewRequiredDirectories, [".codex/memory", ".codex/rules"]);
        assert.equal(codex.safeToCleanDirectories.includes(".codex/migration"), false);
        assert.ok(codex.warnings.length > 0, `${label}: 存在手工改动时应输出告警`);
        assert.ok(codex.cleanupGuidance.length > 0, `${label}: 应输出中文清理指引`);

        assert.deepEqual(report.summary.detectedHarnesses, ["codex"]);
        assert.equal(report.summary.unmodifiedCount, 3);
        assert.equal(report.summary.modifiedCount, 2);
        assert.equal(report.summary.manualReviewCount, 2);
      }

      // 硬边界：旧 .codex/ 与 .y3maker/ 逐字节保持原样，未创建根目录 AGENTS.md / CLAUDE.md
      assert.deepEqual(fixture.snapshotTree(".codex"), codexBefore);
      assert.deepEqual(fixture.snapshotTree(".y3maker"), y3makerBefore);
      assert.equal(fixture.existsInWorkspace("AGENTS.md"), false);
      assert.equal(fixture.existsInWorkspace("CLAUDE.md"), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 3a: 妥善分类 orphaned（未改/已改）、missing 与旧目录内未受管 untracked 本地文件", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);

      // 1) 未改动的 orphaned 文件（上游已删、磁盘未改）
      const orphanedCleanText = "# 已从 .y3maker 删除的旧文档\n";
      fixture.writeWorkspaceFile(".codex/knowledge/old-removed.md", orphanedCleanText);

      // 2) 被本地改过的 orphaned 文件（上游已删、磁盘又手工改过）
      const orphanedBaseText = "# 已删旧记忆\n";
      const orphanedEditedText = "# 已删旧记忆（本地补充了重要信息）\n";
      fixture.writeWorkspaceFile(".codex/memory/old-edited.md", orphanedEditedText);

      // 3) missing 文件（manifest 有记录但用户已手动删掉，.codex/rules 仅剩未改动的 api-safety.mdc）
      const cleanRuleText = "---\ndescription: API 安全规则\n---\n\n规则正文。\n";
      fixture.writeWorkspaceFile(".codex/rules/api-safety.mdc", cleanRuleText);

      // 4) untracked 本地新增文件（位于旧版托管子目录 .codex/templates 内，但旧 manifest 未记录）
      fixture.writeWorkspaceFile(".codex/templates/my-custom-tpl.md", "# 用户手写模板\n");

      // 5) 未改动的技能目录
      const cleanSkillText = "---\nname: y3-sample\ndescription: 示例技能\n---\n\n正文\n";
      fixture.writeWorkspaceFile(".codex/skills/y3-sample/SKILL.md", cleanSkillText);

      // 6) .codex/migration 目录内的额外本地备忘文件
      fixture.writeWorkspaceFile(".codex/migration/handwritten-notes.txt", "个人备注\n");

      const legacyManifest = {
        version: 1,
        tool: "sync-y3maker-to-codex",
        updatedAt: "2026-01-20T08:00:00.000Z",
        files: {
          ".codex/knowledge/old-removed.md": {
            status: "orphaned",
            kind: "knowledge",
            source: ".y3maker/knowledge/old-removed.md",
            target: ".codex/knowledge/old-removed.md",
            targetScope: "project",
            sourceHash: sha256TextLf(orphanedCleanText),
            renderedHash: sha256TextLf(orphanedCleanText),
            targetHash: sha256TextLf(orphanedCleanText),
            blockedReason: "source file was removed from .y3maker; target was left in place",
          },
          ".codex/memory/old-edited.md": {
            status: "orphaned",
            kind: "memory",
            source: ".y3maker/memory/old-edited.md",
            target: ".codex/memory/old-edited.md",
            targetScope: "project",
            sourceHash: sha256TextLf(orphanedBaseText),
            renderedHash: sha256TextLf(orphanedBaseText),
            targetHash: sha256TextLf(orphanedBaseText),
            blockedReason: "source file was removed from .y3maker; target was left in place",
          },
          ".codex/rules/already-deleted.mdc": {
            status: "managed",
            kind: "rules",
            source: ".y3maker/rules/already-deleted.mdc",
            target: ".codex/rules/already-deleted.mdc",
            targetScope: "project",
            sourceHash: sha256TextLf("gone\n"),
            renderedHash: sha256TextLf("gone\n"),
            targetHash: sha256TextLf("gone\n"),
          },
          ".codex/rules/api-safety.mdc": {
            status: "managed",
            kind: "rules",
            source: ".y3maker/rules/api-safety.mdc",
            target: ".codex/rules/api-safety.mdc",
            targetScope: "project",
            sourceHash: sha256TextLf(cleanRuleText),
            renderedHash: sha256TextLf(cleanRuleText),
            targetHash: sha256TextLf(cleanRuleText),
          },
          ".codex/skills/y3-sample/SKILL.md": {
            status: "managed",
            kind: "skill",
            source: ".y3maker/skills/y3-sample/SKILL.md",
            target: ".codex/skills/y3-sample/SKILL.md",
            targetScope: "project",
            sourceHash: sha256TextLf(cleanSkillText),
            renderedHash: sha256TextLf(cleanSkillText),
            targetHash: sha256TextLf(cleanSkillText),
          },
        },
      };
      fixture.writeWorkspaceFile(
        ".codex/migration/y3maker-manifest.json",
        `${JSON.stringify(legacyManifest, null, 2)}\n`
      );

      const inv = fixture.runInventory(["--pretty"]);
      assert.equal(inv.status, 0, `inventory stderr: ${inv.stderr}`);

      const report = inv.json.legacyTransition;
      assert.equal(report.detected, true);
      const codex = report.legacyMigrations[0];

      assert.deepEqual(codex.files.unmodified, [
        ".codex/rules/api-safety.mdc",
        ".codex/skills/y3-sample/SKILL.md",
      ]);
      assert.deepEqual(codex.files.missing, [".codex/rules/already-deleted.mdc"]);
      assert.deepEqual(
        codex.files.orphaned.map((item) => ({
          path: item.path,
          locallyModified: item.locallyModified,
        })),
        [
          { path: ".codex/knowledge/old-removed.md", locallyModified: false },
          { path: ".codex/memory/old-edited.md", locallyModified: true },
        ]
      );
      assert.deepEqual(
        codex.files.modified.map((item) => item.path),
        [".codex/memory/old-edited.md"]
      );
      assert.deepEqual(codex.files.untracked, [
        ".codex/migration/handwritten-notes.txt",
        ".codex/templates/my-custom-tpl.md",
      ]);

      // manualReviewRequired 汇总所有需核对项（orphaned + modified + untracked，不重复同一路径）
      assert.deepEqual(
        codex.manualReviewRequired.map((item) => item.path),
        [
          ".codex/knowledge/old-removed.md",
          ".codex/memory/old-edited.md",
          ".codex/migration/handwritten-notes.txt",
          ".codex/templates/my-custom-tpl.md",
        ]
      );

      // 只有完全干净的 .codex/rules（仅含未改动文件 + 已删 missing）和 .codex/skills 进入 safeToCleanDirectories
      assert.deepEqual(codex.safeToCleanDirectories, [".codex/rules", ".codex/skills"]);
      assert.deepEqual(codex.reviewRequiredDirectories, [
        ".codex/knowledge",
        ".codex/memory",
        ".codex/migration",
        ".codex/templates",
      ]);

      assert.equal(report.summary.orphanedCount, 2);
      assert.equal(report.summary.missingCount, 1);
      assert.equal(report.summary.untrackedCount, 2);
      assert.equal(report.summary.modifiedCount, 1);
      assert.equal(report.summary.manualReviewCount, 4);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 3b: 当旧版 .codex 所有受管文件均未改动且无 untracked 文件时，全部旧子目录（含 .codex/migration）均可评估清理", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);

      const knowledgeText = "# 项目知识\n";
      fixture.writeWorkspaceFile(".codex/knowledge/overview.md", knowledgeText);
      fixture.mkdirWorkspace(".codex/templates");

      const legacyManifest = {
        version: 1,
        tool: "sync-y3maker-to-codex",
        updatedAt: "2026-01-20T08:00:00.000Z",
        files: {
          ".codex/knowledge/overview.md": {
            status: "managed",
            kind: "knowledge",
            source: ".y3maker/knowledge/overview.md",
            target: ".codex/knowledge/overview.md",
            targetScope: "project",
            renderedHash: sha256TextLf(knowledgeText),
            targetHash: sha256TextLf(knowledgeText),
          },
          ".codex/memory/removed-by-user.md": {
            status: "managed",
            kind: "memory",
            source: ".y3maker/memory/removed-by-user.md",
            target: ".codex/memory/removed-by-user.md",
            targetScope: "project",
            renderedHash: sha256TextLf("deleted\n"),
            targetHash: sha256TextLf("deleted\n"),
          },
        },
      };
      fixture.writeWorkspaceFile(
        ".codex/migration/y3maker-manifest.json",
        `${JSON.stringify(legacyManifest, null, 2)}\n`
      );

      const inv = fixture.runInventory(["--pretty"]);
      assert.equal(inv.status, 0, `inventory stderr: ${inv.stderr}`);

      const codex = inv.json.legacyTransition.legacyMigrations[0];
      assert.deepEqual(codex.files.unmodified, [".codex/knowledge/overview.md"]);
      assert.deepEqual(codex.files.missing, [".codex/memory/removed-by-user.md"]);
      assert.deepEqual(codex.files.modified, []);
      assert.deepEqual(codex.files.orphaned, []);
      assert.deepEqual(codex.files.untracked, []);
      assert.deepEqual(codex.manualReviewRequired, []);
      assert.deepEqual(codex.reviewRequiredDirectories, []);
      assert.deepEqual(codex.safeToCleanDirectories, [
        ".codex/knowledge",
        ".codex/migration",
        ".codex/templates",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 4: 同时检测旧 .codex/ 与 .claude/，启用 claude 目标时保护活跃 .claude/skills 不被建议清理，且 --targets all 与子集均零破坏旧副本", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);
      const originalAgentsMd = "# 项目既有 AGENTS.md\n";
      const originalClaudeMd = "# 项目既有 CLAUDE.md\n";
      fixture.writeWorkspaceFile("AGENTS.md", originalAgentsMd);
      fixture.writeWorkspaceFile("CLAUDE.md", originalClaudeMd);

      // 构造旧 .codex/ 副本（含未改动文件 + 手工改动文件 + 项目级 config.toml）
      const codexKnowledge = "# Codex 知识副本\n";
      const codexRuleBase = "---\ndescription: API 安全规则\n---\n\n原始条款。\n";
      const codexRuleEdited = "---\ndescription: API 安全规则\n---\n\n本地追加条款。\n";
      const codexConfig = "[mcp_servers.demo]\ncommand = \"node\"\nargs = [\"server.js\"]\n";
      fixture.writeWorkspaceFile(".codex/knowledge/overview.md", codexKnowledge);
      fixture.writeWorkspaceFile(".codex/rules/api-safety.mdc", codexRuleEdited);
      fixture.writeWorkspaceFile(".codex/config.toml", codexConfig);
      fixture.writeWorkspaceFile(
        ".codex/migration/y3maker-manifest.json",
        `${JSON.stringify(
          {
            version: 1,
            tool: "sync-y3maker-to-codex",
            updatedAt: "2026-01-10T00:00:00.000Z",
            files: {
              ".codex/knowledge/overview.md": {
                status: "managed",
                kind: "knowledge",
                source: ".y3maker/knowledge/overview.md",
                target: ".codex/knowledge/overview.md",
                targetScope: "project",
                renderedHash: sha256TextLf(codexKnowledge),
                targetHash: sha256TextLf(codexKnowledge),
              },
              ".codex/rules/api-safety.mdc": {
                status: "managed",
                kind: "rules",
                source: ".y3maker/rules/api-safety.mdc",
                target: ".codex/rules/api-safety.mdc",
                targetScope: "project",
                renderedHash: sha256TextLf(codexRuleBase),
                targetHash: sha256TextLf(codexRuleBase),
              },
              ".codex/config.toml": {
                status: "managed",
                kind: "mcp-config",
                source: ".y3maker/mcp_settings.json",
                target: ".codex/config.toml",
                targetScope: "project",
                renderedHash: sha256TextLf(codexConfig),
                targetHash: sha256TextLf(codexConfig),
              },
            },
          },
          null,
          2
        )}\n`
      );

      // 构造旧 .claude/ 副本（全量未改动，覆盖所有技能文件与项目 .mcp.json）
      const claudeKnowledge = "# Claude 知识副本\n";
      const claudeMemory = "# Claude 记忆副本\n";
      const claudeRule = "---\ndescription: API 安全规则\n---\n\nClaude 规则副本。\n";
      const claudeSkillMd =
        "---\nname: y3-sample\ndescription: 示例技能\nallowed-tools: Read, Bash\n---\n\n正文。\n";
      const claudeRunPy = "print('ok')\n";
      const projectMcpJson = `${JSON.stringify({ mcpServers: { demo: { type: "stdio", command: "node" } } }, null, 2)}\n`;
      fixture.writeWorkspaceFile(".claude/knowledge/overview.md", claudeKnowledge);
      fixture.writeWorkspaceFile(".claude/memory/facts.md", claudeMemory);
      fixture.writeWorkspaceFile(".claude/rules/api-safety.mdc", claudeRule);
      fixture.writeWorkspaceFile(".claude/skills/y3-sample/SKILL.md", claudeSkillMd);
      fixture.writeWorkspaceFile(".claude/skills/y3-sample/scripts/run.py", claudeRunPy);
      fixture.writeWorkspaceFile(".mcp.json", projectMcpJson);
      fixture.writeWorkspaceFile(
        ".claude/migration/y3maker-manifest.json",
        `${JSON.stringify(
          {
            version: 1,
            tool: "sync-y3maker-to-claude",
            updatedAt: "2026-01-12T00:00:00.000Z",
            files: {
              ".claude/knowledge/overview.md": {
                status: "managed",
                kind: "knowledge",
                source: ".y3maker/knowledge/overview.md",
                target: ".claude/knowledge/overview.md",
                targetScope: "project",
                renderedHash: sha256TextLf(claudeKnowledge),
                targetHash: sha256TextLf(claudeKnowledge),
              },
              ".claude/memory/facts.md": {
                status: "managed",
                kind: "memory",
                source: ".y3maker/memory/facts.md",
                target: ".claude/memory/facts.md",
                targetScope: "project",
                renderedHash: sha256TextLf(claudeMemory),
                targetHash: sha256TextLf(claudeMemory),
              },
              ".claude/rules/api-safety.mdc": {
                status: "managed",
                kind: "rules",
                source: ".y3maker/rules/api-safety.mdc",
                target: ".claude/rules/api-safety.mdc",
                targetScope: "project",
                renderedHash: sha256TextLf(claudeRule),
                targetHash: sha256TextLf(claudeRule),
              },
              ".claude/skills/y3-sample/SKILL.md": {
                status: "managed",
                kind: "skill",
                source: ".y3maker/skills/y3-sample/SKILL.md",
                target: ".claude/skills/y3-sample/SKILL.md",
                targetScope: "project",
                renderedHash: sha256TextLf(claudeSkillMd),
                targetHash: sha256TextLf(claudeSkillMd),
              },
              ".claude/skills/y3-sample/scripts/run.py": {
                status: "managed",
                kind: "skill",
                source: ".y3maker/skills/y3-sample/scripts/run.py",
                target: ".claude/skills/y3-sample/scripts/run.py",
                targetScope: "project",
                renderedHash: sha256TextLf(claudeRunPy),
                targetHash: sha256TextLf(claudeRunPy),
              },
              ".mcp.json": {
                status: "managed",
                kind: "mcp-config",
                source: ".y3maker/mcp_settings.json",
                target: ".mcp.json",
                targetScope: "project",
                renderedHash: sha256TextLf(projectMcpJson),
                targetHash: sha256TextLf(projectMcpJson),
              },
            },
          },
          null,
          2
        )}\n`
      );

      const codexBefore = fixture.snapshotTree(".codex");
      const claudeBefore = fixture.snapshotTree(".claude");
      const y3makerBefore = fixture.snapshotTree(".y3maker");

      // 1) 首次迁移前 inventory：同时发现 claude 与 codex
      const preInv = fixture.runInventory(["--pretty"]);
      assert.equal(preInv.status, 0, `preInv stderr: ${preInv.stderr}`);
      assert.deepEqual(preInv.json.legacyTransition.summary.detectedHarnesses, ["claude", "codex"]);

      // 2) apply --dry-run --targets claude：即便尚未落盘 .agents manifest，也必须保护活跃的 .claude/skills
      const dryClaude = fixture.runApply(["--targets", "claude", "--dry-run", "--pretty"]);
      assert.equal(dryClaude.status, 0, `dryClaude stderr: ${dryClaude.stderr}`);
      const dryClaudeEntry = dryClaude.json.legacyTransition.legacyMigrations.find(
        (item) => item.harness === "claude"
      );
      assert.ok(dryClaudeEntry);
      assert.deepEqual(dryClaudeEntry.activeProtectedDirectories, [".claude/skills"]);
      assert.ok(dryClaudeEntry.activeProtectedPaths.includes(".claude/skills"));
      assert.ok(dryClaudeEntry.activeProtectedPaths.includes(".mcp.json"));
      assert.equal(
        dryClaudeEntry.safeToCleanDirectories.includes(".claude/skills"),
        false,
        "启用 claude 目标时，绝不能建议清理活跃的 .claude/skills"
      );
      assert.deepEqual(dryClaudeEntry.safeToCleanDirectories, [
        ".claude/knowledge",
        ".claude/memory",
        ".claude/migration",
        ".claude/rules",
      ]);
      assert.ok(
        dryClaudeEntry.cleanupGuidance.some((line) => line.includes(".claude/skills")),
        "清理指引应明确说明 .claude/skills 正被活跃使用"
      );
      assert.deepEqual(dryClaude.json.legacyTransition.summary.activeProtectedDirectories, [
        ".claude/skills",
      ]);

      // 3) 正式 apply --targets claude，再跑 inventory，两者均应持续保护 .claude/skills
      const applyClaude = fixture.runApply(["--targets", "claude", "--pretty"]);
      assert.equal(applyClaude.status, 0, `applyClaude stderr: ${applyClaude.stderr}`);
      const postInv = fixture.runInventory(["--pretty"]);
      assert.equal(postInv.status, 0, `postInv stderr: ${postInv.stderr}`);

      for (const report of [applyClaude.json.legacyTransition, postInv.json.legacyTransition]) {
        const claudeEntry = report.legacyMigrations.find((item) => item.harness === "claude");
        assert.deepEqual(claudeEntry.activeProtectedDirectories, [".claude/skills"]);
        assert.equal(claudeEntry.safeToCleanDirectories.includes(".claude/skills"), false);
      }

      // 4) 仅启用 codex（不含 claude）时，.claude/skills 不再处于活跃保护列表，而 .codex/config.toml 被标注为活跃保护路径
      const applyCodexOnly = fixture.runApply(["--targets", "codex", "--pretty"]);
      assert.equal(applyCodexOnly.status, 0, `applyCodexOnly stderr: ${applyCodexOnly.stderr}`);
      const claudeWhenCodexOnly = applyCodexOnly.json.legacyTransition.legacyMigrations.find(
        (item) => item.harness === "claude"
      );
      const codexWhenCodexOnly = applyCodexOnly.json.legacyTransition.legacyMigrations.find(
        (item) => item.harness === "codex"
      );
      assert.deepEqual(claudeWhenCodexOnly.activeProtectedDirectories, []);
      assert.ok(claudeWhenCodexOnly.safeToCleanDirectories.includes(".claude/skills"));
      assert.ok(codexWhenCodexOnly.activeProtectedPaths.includes(".codex/config.toml"));

      // 5) 启用全部目标 --targets all：.claude/skills 再次受保护，且旧 .codex/ 与 .claude/ 逐字节零破坏
      const applyAll = fixture.runApply(["--targets", "all", "--pretty"]);
      assert.equal(applyAll.status, 0, `applyAll stderr: ${applyAll.stderr}`);
      const claudeWhenAll = applyAll.json.legacyTransition.legacyMigrations.find(
        (item) => item.harness === "claude"
      );
      assert.deepEqual(claudeWhenAll.activeProtectedDirectories, [".claude/skills"]);
      assert.equal(claudeWhenAll.safeToCleanDirectories.includes(".claude/skills"), false);

      // 硬边界：所有旧 .codex/、.claude/、.y3maker/、根目录文档与 .mcp.json 逐字节未改动
      assert.deepEqual(fixture.snapshotTree(".codex"), codexBefore);
      assert.deepEqual(fixture.snapshotTree(".claude"), claudeBefore);
      assert.deepEqual(fixture.snapshotTree(".y3maker"), y3makerBefore);
      assert.equal(fixture.readWorkspaceFile(".mcp.json"), projectMcpJson);
      assert.equal(fixture.readWorkspaceFile("AGENTS.md"), originalAgentsMd);
      assert.equal(fixture.readWorkspaceFile("CLAUDE.md"), originalClaudeMd);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 5: 用户级条目（targetScope: user 或 ~/ 前缀）独立归类到 userScopedFiles，不与项目目录清理候选混淆且假主目录只读", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);

      // 假用户主目录中的用户级 MCP 配置
      const userCodexConfig = "[mcp_servers.demo]\ncommand = \"node\"\nargs = [\"srv.js\"]\n";
      const userClaudeBase = `${JSON.stringify({ mcpServers: { demo: { type: "stdio", command: "node" } } }, null, 2)}\n`;
      const userClaudeEdited = `${JSON.stringify({ theme: "dark", mcpServers: { demo: { type: "stdio", command: "node" } } }, null, 2)}\n`;
      fixture.writeHomeFile(".codex/config.toml", userCodexConfig);
      fixture.writeHomeFile(".claude.json", userClaudeEdited);

      // 项目级旧副本（均未改动）
      const codexKnowledge = "# Codex 知识\n";
      const claudeKnowledge = "# Claude 知识\n";
      fixture.writeWorkspaceFile(".codex/knowledge/overview.md", codexKnowledge);
      fixture.writeWorkspaceFile(".claude/knowledge/overview.md", claudeKnowledge);

      fixture.writeWorkspaceFile(
        ".codex/migration/y3maker-manifest.json",
        `${JSON.stringify(
          {
            version: 1,
            tool: "sync-y3maker-to-codex",
            updatedAt: "2026-01-10T00:00:00.000Z",
            files: {
              ".codex/knowledge/overview.md": {
                status: "managed",
                kind: "knowledge",
                source: ".y3maker/knowledge/overview.md",
                target: ".codex/knowledge/overview.md",
                targetScope: "project",
                renderedHash: sha256TextLf(codexKnowledge),
                targetHash: sha256TextLf(codexKnowledge),
              },
              "~/.codex/config.toml": {
                status: "managed",
                kind: "mcp-config",
                source: ".y3maker/mcp_settings.json",
                target: "~/.codex/config.toml",
                targetScope: "user",
                renderedHash: sha256TextLf(userCodexConfig),
                targetHash: sha256TextLf(userCodexConfig),
              },
            },
          },
          null,
          2
        )}\n`
      );

      fixture.writeWorkspaceFile(
        ".claude/migration/y3maker-manifest.json",
        `${JSON.stringify(
          {
            version: 1,
            tool: "sync-y3maker-to-claude",
            updatedAt: "2026-01-12T00:00:00.000Z",
            files: {
              ".claude/knowledge/overview.md": {
                status: "managed",
                kind: "knowledge",
                source: ".y3maker/knowledge/overview.md",
                target: ".claude/knowledge/overview.md",
                targetScope: "project",
                renderedHash: sha256TextLf(claudeKnowledge),
                targetHash: sha256TextLf(claudeKnowledge),
              },
              // 故意省略 targetScope，验证通过 ~/ 前缀自动识别为 user
              "~/.claude.json": {
                status: "managed",
                kind: "mcp-config",
                source: ".y3maker/mcp_settings.json",
                target: "~/.claude.json",
                renderedHash: sha256TextLf(userClaudeBase),
                targetHash: sha256TextLf(userClaudeBase),
              },
              "~/.claude/deleted-user.json": {
                status: "managed",
                kind: "mcp-config",
                source: ".y3maker/mcp_settings.json",
                target: "~/.claude/deleted-user.json",
                targetScope: "user",
                renderedHash: sha256TextLf("{}\n"),
                targetHash: sha256TextLf("{}\n"),
              },
            },
          },
          null,
          2
        )}\n`
      );

      const inv = fixture.runInventory(["--pretty"]);
      assert.equal(inv.status, 0, `inventory stderr: ${inv.stderr}`);

      const report = inv.json.legacyTransition;
      assert.equal(report.detected, true);
      assert.equal(report.summary.userScopedCount, 3);

      const codex = report.legacyMigrations.find((item) => item.harness === "codex");
      const claude = report.legacyMigrations.find((item) => item.harness === "claude");

      assert.deepEqual(codex.files.unmodified, [".codex/knowledge/overview.md"]);
      assert.deepEqual(codex.files.modified, []);
      assert.deepEqual(codex.files.missing, []);
      assert.deepEqual(codex.manualReviewRequired, []);
      assert.deepEqual(codex.safeToCleanDirectories, [".codex/knowledge", ".codex/migration"]);
      assert.equal(codex.userScopedFiles.length, 1);
      assert.equal(codex.userScopedFiles[0].path, "~/.codex/config.toml");
      assert.equal(codex.userScopedFiles[0].targetScope, "user");
      assert.equal(codex.userScopedFiles[0].status, "unmodified");

      assert.deepEqual(claude.files.unmodified, [".claude/knowledge/overview.md"]);
      assert.deepEqual(claude.files.modified, []);
      assert.deepEqual(claude.files.missing, []);
      assert.deepEqual(claude.manualReviewRequired, []);
      assert.deepEqual(claude.safeToCleanDirectories, [".claude/knowledge", ".claude/migration"]);
      assert.deepEqual(
        claude.userScopedFiles.map((item) => ({
          path: item.path,
          targetScope: item.targetScope,
          status: item.status,
        })),
        [
          { path: "~/.claude.json", targetScope: "user", status: "modified" },
          { path: "~/.claude/deleted-user.json", targetScope: "user", status: "missing" },
        ]
      );
      assert.ok(
        claude.cleanupGuidance.some((line) => line.includes("用户级")),
        "指引应提示存在独立的用户级配置文件"
      );

      // 假主目录文件未被改动
      assert.equal(fixture.readHomeFile(".codex/config.toml"), userCodexConfig);
      assert.equal(fixture.readHomeFile(".claude.json"), userClaudeEdited);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 6a: 损坏或结构非法的旧版 manifest 优雅降级输出告警，不中断 inventory 与 apply，且不误报任何可安全清理目录", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);

      fixture.writeWorkspaceFile(".codex/knowledge/overview.md", "# 旧文件\n");
      fixture.writeWorkspaceFile(".codex/migration/y3maker-manifest.json", "{ invalid json !!!\n");

      fixture.writeWorkspaceFile(".claude/rules/api-safety.mdc", "# 旧规则\n");
      fixture.writeWorkspaceFile(
        ".claude/skills/y3-sample/SKILL.md",
        "---\nname: y3-sample\ndescription: 示例\n---\n\n正文\n"
      );
      fixture.writeWorkspaceFile(".claude/skills/y3-sample/scripts/run.py", "print('ok')\n");
      fixture.writeWorkspaceFile(
        ".claude/migration/y3maker-manifest.json",
        JSON.stringify({ version: 1, tool: "sync-y3maker-to-claude", files: ["not-an-object"] })
      );

      const codexBefore = fixture.snapshotTree(".codex");
      const claudeBefore = fixture.snapshotTree(".claude");

      const inv = fixture.runInventory(["--pretty"]);
      assert.equal(inv.status, 0, `损坏 manifest 不应令 inventory 崩溃，stderr: ${inv.stderr}`);

      const applyRes = fixture.runApply(["--targets", "claude", "--pretty"]);
      assert.equal(applyRes.status, 0, `损坏 manifest 不应令 apply 崩溃，stderr: ${applyRes.stderr}`);
      assert.equal(fixture.existsInWorkspace(".agents/knowledge/overview.md"), true);

      for (const [label, report, expectProtectedClaudeSkills] of [
        ["inventory", inv.json.legacyTransition, false],
        ["apply", applyRes.json.legacyTransition, true],
      ]) {
        assert.equal(report.detected, true, `${label}: 应检测到旧 manifest`);
        assert.equal(report.summary.hasMalformedManifest, true, `${label}: 应标记存在损坏 manifest`);
        assert.deepEqual(report.summary.safeToCleanDirectories, []);
        assert.ok(report.warnings.length >= 2, `${label}: 应包含两个损坏 manifest 的告警`);

        const codex = report.legacyMigrations.find((item) => item.harness === "codex");
        const claude = report.legacyMigrations.find((item) => item.harness === "claude");

        assert.equal(codex.manifestValid, false);
        assert.deepEqual(codex.safeToCleanDirectories, []);
        assert.ok(codex.warnings.some((w) => w.includes(".codex/migration/y3maker-manifest.json")));
        assert.ok(codex.cleanupGuidance.length > 0);

        assert.equal(claude.manifestValid, false);
        assert.deepEqual(claude.safeToCleanDirectories, []);
        assert.ok(claude.warnings.some((w) => w.includes(".claude/migration/y3maker-manifest.json")));
        if (expectProtectedClaudeSkills) {
          assert.deepEqual(claude.activeProtectedDirectories, [".claude/skills"]);
        }
      }

      assert.deepEqual(fixture.snapshotTree(".codex"), codexBefore);
      assert.deepEqual(fixture.snapshotTree(".claude"), claudeBefore);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 6b: 旧版 manifest 中含异常条目或越界路径时安全跳过越界读取并保护对应目录", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture);

      const cleanKnowledge = "# 正常未改动知识\n";
      fixture.writeWorkspaceFile(".codex/knowledge/overview.md", cleanKnowledge);
      fixture.writeWorkspaceFile(".codex/rules/api-safety.mdc", "# 规则内容\n");

      fixture.writeWorkspaceFile(
        ".codex/migration/y3maker-manifest.json",
        `${JSON.stringify(
          {
            version: 1,
            tool: "sync-y3maker-to-codex",
            files: {
              ".codex/knowledge/overview.md": {
                status: "managed",
                kind: "knowledge",
                source: ".y3maker/knowledge/overview.md",
                target: ".codex/knowledge/overview.md",
                targetScope: "project",
                renderedHash: sha256TextLf(cleanKnowledge),
                targetHash: sha256TextLf(cleanKnowledge),
              },
              ".codex/rules/api-safety.mdc": null,
              "../outside-secret.txt": {
                status: "managed",
                kind: "knowledge",
                source: ".y3maker/knowledge/x.md",
                target: "../outside-secret.txt",
                targetScope: "project",
                targetHash: "deadbeef",
              },
            },
          },
          null,
          2
        )}\n`
      );

      const inv = fixture.runInventory(["--pretty"]);
      assert.equal(inv.status, 0, `inventory stderr: ${inv.stderr}`);

      const codex = inv.json.legacyTransition.legacyMigrations[0];
      assert.equal(codex.manifestValid, true);
      assert.deepEqual(codex.files.unmodified, [".codex/knowledge/overview.md"]);
      assert.deepEqual(codex.safeToCleanDirectories, [".codex/knowledge"]);
      assert.deepEqual(codex.reviewRequiredDirectories, [".codex/rules"]);
      assert.ok(
        codex.manualReviewRequired.some(
          (item) => item.path === ".codex/rules/api-safety.mdc" && item.category === "invalid-entry"
        )
      );
      assert.ok(
        codex.warnings.some((w) => w.includes("../outside-secret.txt")),
        "应对越界路径输出安全告警"
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 7: 与真实旧版 sync-y3maker-to-codex / sync-y3maker-to-claude 生成的 manifest 端到端互通并零破坏", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, { withTemplates: "y3maker" });

      // 使用仓库内真实的旧版单宿主迁移脚本生成 .codex/ 与 .claude/ 副本与 manifest
      const legacyCodexRun = fixture.runCli(LEGACY_CODEX_SCRIPT, [
        "apply",
        "--workspace",
        fixture.workspace,
      ]);
      assert.equal(legacyCodexRun.status, 0, `旧版 codex 迁移失败: ${legacyCodexRun.stderr}`);

      const legacyClaudeRun = fixture.runCli(LEGACY_CLAUDE_SCRIPT, [
        "apply",
        "--workspace",
        fixture.workspace,
      ]);
      assert.equal(legacyClaudeRun.status, 0, `旧版 claude 迁移失败: ${legacyClaudeRun.stderr}`);

      // 在真实旧副本中各手工修改 1 个文件
      fixture.writeWorkspaceFile(
        ".codex/rules/api-safety.mdc",
        `${fixture.readWorkspaceFile(".codex/rules/api-safety.mdc")}\n# 本地手工追加规则\n`
      );
      fixture.writeWorkspaceFile(
        ".claude/memory/facts.md",
        `${fixture.readWorkspaceFile(".claude/memory/facts.md")}\n- 本地补充事实\n`
      );

      const codexBefore = fixture.snapshotTree(".codex");
      const claudeBefore = fixture.snapshotTree(".claude");
      const y3makerBefore = fixture.snapshotTree(".y3maker");

      const inv = fixture.runInventory(["--pretty"]);
      assert.equal(inv.status, 0, `inventory stderr: ${inv.stderr}`);
      assert.deepEqual(inv.json.legacyTransition.summary.detectedHarnesses, ["claude", "codex"]);

      const applyAll = fixture.runApply(["--targets", "all", "--pretty"]);
      assert.equal(applyAll.status, 0, `apply --targets all stderr: ${applyAll.stderr}`);

      const report = applyAll.json.legacyTransition;
      const codex = report.legacyMigrations.find((item) => item.harness === "codex");
      const claude = report.legacyMigrations.find((item) => item.harness === "claude");

      assert.equal(codex.manifestValid, true);
      assert.deepEqual(
        codex.files.modified.map((item) => item.path),
        [".codex/rules/api-safety.mdc"]
      );
      assert.deepEqual(codex.reviewRequiredDirectories, [".codex/rules"]);
      assert.deepEqual(codex.safeToCleanDirectories, [
        ".codex/knowledge",
        ".codex/memory",
        ".codex/skills",
        ".codex/templates",
      ]);

      assert.equal(claude.manifestValid, true);
      assert.deepEqual(
        claude.files.modified.map((item) => item.path),
        [".claude/memory/facts.md"]
      );
      assert.deepEqual(claude.reviewRequiredDirectories, [".claude/memory"]);
      assert.deepEqual(claude.activeProtectedDirectories, [".claude/skills"]);
      assert.deepEqual(claude.safeToCleanDirectories, [
        ".claude/knowledge",
        ".claude/rules",
        ".claude/templates",
      ]);

      // 真实旧副本与 Legacy Source 均逐字节未受破坏
      assert.deepEqual(fixture.snapshotTree(".codex"), codexBefore);
      assert.deepEqual(fixture.snapshotTree(".claude"), claudeBefore);
      assert.deepEqual(fixture.snapshotTree(".y3maker"), y3makerBefore);
    } finally {
      fixture.cleanup();
    }
  });
});
