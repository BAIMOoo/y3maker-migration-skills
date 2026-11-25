const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  SKILL_ROOT,
  createFixture,
  seedMinimalY3Maker,
  snapshotDirectory,
} = require("./helpers/fixture");

function seedRichMultiHarnessWorkspace(fixture, options = {}) {
  seedMinimalY3Maker(fixture, {
    withTemplates: options.withTemplates !== undefined ? options.withTemplates : "codemaker",
    mcpSettings:
      options.mcpSettings !== undefined
        ? options.mcpSettings
        : {
            mcpServers: {
              "y3-stdio": {
                type: "stdio",
                command: "node",
                args: ["scripts/mcp-server.js", "--port", "3000"],
                cwd: "./tools",
                env: {
                  NODE_ENV: "production",
                  Y3_MAP: "demo",
                },
              },
              "y3-http": {
                type: "streamableHttp",
                url: "https://mcp.example.com/mcp",
                headers: {
                  Authorization: "Bearer demo-token",
                  "X-Team": "y3",
                },
              },
              "legacy-sse": {
                type: "sse",
                url: "https://legacy.example.com/sse",
              },
              "disabled-srv": {
                command: "python",
                args: ["disabled.py"],
                disabled: true,
              },
            },
          },
  });

  // 带 UTF-8 BOM、CRLF、多余字段、多行 description、跨目录相对引用的顶层 SKILL.md
  const sampleSkill = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(
      [
        "---",
        "name: wrong-sample-name",
        "description: >-",
        "  全四端联调示例技能，遵循 ../../rules/api-safety.mdc",
        "  与 .codemaker/knowledge/overview.md。",
        "tools: Read, Bash",
        "custom-unused: drop-me",
        "---",
        "",
        "# 示例技能",
        "",
        "- 规则：`../../rules/api-safety.mdc`",
        "- 记忆：`../../memory/facts.md`",
        "- 知识：`../../knowledge/overview.md`",
        "- 模板：`../../templates/legacy-tpl.md`",
        "- 脚本：`scripts/run.py`",
        "- 旧占位符：`<agent>/knowledge/overview.md`、`<codemaker>/rules/api-safety.mdc`",
        "",
      ].join("\r\n"),
      "utf8"
    ),
  ]);
  fixture.writeWorkspaceFile(".y3maker/skills/y3-sample/SKILL.md", sampleSkill);
  fixture.writeWorkspaceFile(
    ".y3maker/skills/y3-sample/references/guide.md",
    "详见 `../../../rules/api-safety.mdc §1.1` 与 `../../../knowledge/overview.md#intro`。\n"
  );

  // 特殊修复 1：y3-auto-test 自引用 + .queue 过滤
  fixture.writeWorkspaceFile(
    ".y3maker/skills/y3-auto-test/SKILL.md",
    "---\nname: y3-auto-test\ndescription: 自动测试技能\n---\n\n正文。\n"
  );
  fixture.writeWorkspaceFile(
    ".y3maker/skills/y3-auto-test/admin_daemon.ps1",
    "$dir = '.\\.codemaker\\skills\\desktop-automation'\r\n"
  );
  fixture.writeWorkspaceFile(".y3maker/skills/y3-auto-test/.queue/pending.json", "{}\n");

  // 特殊修复 2：y3-obj-gen cmtmp 提示替换 + .claude-plugin 过滤
  fixture.writeWorkspaceFile(
    ".y3maker/skills/y3-obj-gen/SKILL.md",
    [
      "---",
      "name: y3-obj-gen",
      "description: 对象生成技能",
      "allowed-tools: Read, Grep",
      "---",
      "",
      "MCP 返回的数据会保存到临时文件 `.codemaker/cmtmp/` 目录下。由于数据量很大（56000+），需要使用脚本搜索：",
      "",
    ].join("\n")
  );
  fixture.writeWorkspaceFile(".y3maker/skills/y3-obj-gen/.claude-plugin/plugin.json", "{}\n");

  // 应自动过滤的旧技能根目录文件
  fixture.writeWorkspaceFile(".y3maker/skills/README.md", "# 应过滤的顶层说明\n");
  fixture.writeWorkspaceFile(".y3maker/skills/install_skills.bat", "@echo off\n");
}

describe("多 Harness 四端组合（--targets all）全链路端到端回归（Ticket #8）", () => {
  it("Slice 1: inventory -> apply --targets all --mcp-scope project (--dry-run 与正式执行) -> verify 全四端通过且严格保持只读边界", () => {
    const fixture = createFixture();
    try {
      seedRichMultiHarnessWorkspace(fixture);

      // 预置 .agents/cmtmp 临时目录（应仅在正式 apply 时清理）
      fixture.writeWorkspaceFile(".agents/cmtmp/temp-dump.json", "{}\n");

      // 预置根目录 AGENTS.md 与 CLAUDE.md（任何流程都绝不可改写）
      const originalAgentsMd = "# 项目自定义 AGENTS.md\n请保持原样。\n";
      const originalClaudeMd = "# 项目自定义 CLAUDE.md\n@AGENTS.md\n";
      fixture.writeWorkspaceFile("AGENTS.md", originalAgentsMd);
      fixture.writeWorkspaceFile("CLAUDE.md", originalClaudeMd);

      // 预置各宿主已有项目级非受管 MCP 配置，验证四端同时安全合并
      const existingCodexToml = [
        "# 已有项目 Codex 配置",
        'model = "gpt-5.4"',
        "",
        "[mcp_servers.custom-codex]",
        'command = "uvx"',
        'args = ["custom-codex-mcp"]',
        "",
      ].join("\n");
      fixture.writeWorkspaceFile(".codex/config.toml", existingCodexToml);

      const existingClaudeMcp = `${JSON.stringify(
        {
          customFlag: true,
          mcpServers: {
            "custom-claude": {
              type: "stdio",
              command: "node",
              args: ["custom-claude.js"],
            },
          },
        },
        null,
        2
      )}\n`;
      fixture.writeWorkspaceFile(".mcp.json", existingClaudeMcp);

      const existingDshPatch = [
        "# 已有项目 DSH 补丁",
        "- insert:",
        '    - id: "custom-project-plugin"',
        '      name: "@acme/dsh-custom"',
        "      config:",
        '        enabled: "true"',
        "",
      ].join("\n");
      fixture.writeWorkspaceFile(".dsh/cordis.patch.yml", existingDshPatch);

      // 1) inventory 盘点
      const invRes = fixture.runInventory(["--pretty"]);
      assert.equal(invRes.status, 0, `inventory stderr: ${invRes.stderr}`);
      assert.equal(invRes.json.exists[".y3maker"], true);
      assert.equal(invRes.json.exists[".codemaker"], true);
      assert.equal(invRes.json.exists["AGENTS.md"], true);
      assert.equal(invRes.json.exists["CLAUDE.md"], true);
      assert.equal(invRes.json.legacy.hasMcpSettings, true);
      assert.deepEqual(invRes.json.legacy.mcp.enabled, ["legacy-sse", "y3-http", "y3-stdio"]);
      assert.deepEqual(invRes.json.legacy.mcp.disabled, ["disabled-srv"]);
      assert.equal(invRes.json.codemaker.hasTemplates, true);
      assert.deepEqual(invRes.json.legacyTransition, { detected: false, legacyMigrations: [] });

      const workspaceBeforeDry = snapshotDirectory(fixture.workspace);
      const homeBeforeDry = snapshotDirectory(fixture.homeDir);
      const legacyBefore = fixture.snapshotTree(".y3maker");

      // 2) apply --targets all --mcp-scope project --dry-run：完整预览且零磁盘改动
      const dryRes = fixture.runApply([
        "--targets",
        "all",
        "--mcp-scope",
        "project",
        "--dry-run",
        "--pretty",
      ]);
      assert.equal(dryRes.status, 0, `dry-run stderr: ${dryRes.stderr}`);
      assert.equal(dryRes.json.dryRun, true);
      assert.deepEqual(dryRes.json.targets, ["antigravity", "claude", "codex", "dsh"]);
      assert.equal(dryRes.json.mcp.scope, "project");
      assert.deepEqual(Object.keys(dryRes.json.mcp.targets).sort(), [
        "antigravity",
        "claude",
        "codex",
        "dsh",
      ]);
      assert.ok(dryRes.json.sync.created.includes(".agents/rules/api-safety.mdc"));
      assert.ok(dryRes.json.sync.created.includes(".claude/skills/y3-sample/SKILL.md"));
      assert.ok(dryRes.json.sync.created.includes(".agents/plugins/y3maker-mcp/plugin.json"));
      assert.ok(dryRes.json.sync.created.includes(".agents/plugins/y3maker-mcp/mcp_config.json"));
      assert.ok(dryRes.json.sync.updated.includes(".codex/config.toml"));
      assert.ok(dryRes.json.sync.updated.includes(".mcp.json"));
      assert.ok(dryRes.json.sync.updated.includes(".dsh/cordis.patch.yml"));
      assert.ok(
        dryRes.json.mcp.hints.some((h) => h.includes("--patch .dsh/cordis.patch.yml")),
        "dry-run 应预告 DSH --patch 启动提示"
      );
      assert.ok(
        dryRes.json.mcp.targets.antigravity.warnings.some(
          (w) => w.includes("legacy-sse") && w.includes("mcp-remote")
        ),
        "dry-run 应包含 Antigravity SSE 跳过与 mcp-remote 提示"
      );

      // dry-run 绝不修改工作区与 Fake Home 的任何文件
      assert.deepEqual(snapshotDirectory(fixture.workspace), workspaceBeforeDry);
      assert.deepEqual(snapshotDirectory(fixture.homeDir), homeBeforeDry);

      // 3) 正式执行 apply --targets all --mcp-scope project
      const applyRes = fixture.runApply([
        "--targets",
        "all",
        "--mcp-scope",
        "project",
        "--pretty",
      ]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);
      assert.equal(applyRes.json.dryRun, false);
      assert.deepEqual(applyRes.json.targets, ["antigravity", "claude", "codex", "dsh"]);
      assert.deepEqual(applyRes.json.sync.blocked, []);
      assert.deepEqual(applyRes.json.sync.orphaned, []);

      // 3a) Canonical Store (.agents/) 校验
      assert.equal(fixture.existsInWorkspace(".agents/rules/api-safety.mdc"), true);
      assert.equal(fixture.existsInWorkspace(".agents/rules/api-safety.md"), false);
      assert.equal(fixture.existsInWorkspace(".agents/templates/legacy-tpl.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/cmtmp"), false);
      assert.equal(fixture.existsInWorkspace("openspec/docs"), true);
      assert.equal(fixture.existsInWorkspace("openspec/reports"), true);
      assert.equal(fixture.existsInWorkspace(".agents/skills/README.md"), false);
      assert.equal(fixture.existsInWorkspace(".agents/skills/install_skills.bat"), false);
      assert.equal(fixture.existsInWorkspace(".agents/skills/y3-auto-test/.queue"), false);
      assert.equal(fixture.existsInWorkspace(".agents/skills/y3-obj-gen/.claude-plugin"), false);

      const canonicalSkill = fixture.readWorkspaceFile(".agents/skills/y3-sample/SKILL.md");
      assert.match(canonicalSkill, /^---\nname: y3-sample\ndescription: >-\n/);
      assert.equal(canonicalSkill.includes("tools:"), false);
      assert.equal(canonicalSkill.includes("allowed-tools:"), false);
      assert.equal(canonicalSkill.includes("custom-unused:"), false);
      assert.ok(canonicalSkill.includes("`../../rules/api-safety.mdc`"));
      assert.ok(canonicalSkill.includes("`.agents/knowledge/overview.md`"));
      assert.equal(
        fixture.readWorkspaceFile(".agents/skills/y3-auto-test/admin_daemon.ps1"),
        "$dir = '.\\.agents\\skills\\y3-auto-test'\n"
      );
      assert.ok(
        fixture
          .readWorkspaceFile(".agents/skills/y3-obj-gen/SKILL.md")
          .includes("不要在 `.agents/` 下保留临时目录")
      );

      // 3b) Claude Skill Projection & .mcp.json 安全合并
      assert.equal(fixture.existsInWorkspace(".claude/skills/y3-sample/SKILL.md"), true);
      assert.equal(fixture.existsInWorkspace(".claude/rules"), false);
      assert.equal(fixture.existsInWorkspace(".claude/memory"), false);
      assert.equal(fixture.existsInWorkspace(".claude/knowledge"), false);
      assert.equal(fixture.existsInWorkspace(".claude/templates"), false);
      assert.equal(fixture.existsInWorkspace(".claude/migration"), false);

      const claudeSkill = fixture.readWorkspaceFile(".claude/skills/y3-sample/SKILL.md");
      assert.ok(claudeSkill.includes("allowed-tools: Read, Bash"));
      assert.ok(claudeSkill.includes("`.agents/rules/api-safety.mdc`"));
      assert.ok(claudeSkill.includes("`.agents/templates/legacy-tpl.md`"));
      assert.equal(claudeSkill.includes("../../rules/"), false);
      assert.ok(
        fixture
          .readWorkspaceFile(".claude/skills/y3-obj-gen/SKILL.md")
          .includes("allowed-tools: Read, Grep")
      );

      const claudeMcp = fixture.readWorkspaceJson(".mcp.json");
      assert.equal(claudeMcp.customFlag, true);
      assert.ok(claudeMcp.mcpServers["custom-claude"]);
      assert.equal(claudeMcp.mcpServers["y3-stdio"].type, "stdio");
      assert.equal(claudeMcp.mcpServers["y3-http"].type, "http");
      assert.deepEqual(claudeMcp.mcpServers["y3-http"].headers, {
        Authorization: "Bearer demo-token",
        "X-Team": "y3",
      });
      assert.equal(claudeMcp.mcpServers["legacy-sse"].type, "sse");
      assert.equal(claudeMcp.mcpServers["disabled-srv"], undefined);

      // 3c) Codex .codex/config.toml 安全合并且不复制资产树
      assert.equal(fixture.existsInWorkspace(".codex/skills"), false);
      assert.equal(fixture.existsInWorkspace(".codex/rules"), false);
      const codexToml = fixture.readWorkspaceFile(".codex/config.toml");
      assert.ok(codexToml.includes('# 已有项目 Codex 配置\nmodel = "gpt-5.4"'));
      assert.ok(codexToml.includes("[mcp_servers.custom-codex]"));
      assert.ok(codexToml.includes("[mcp_servers.y3-stdio]"));
      assert.ok(codexToml.includes("[mcp_servers.y3-http.http_headers]"));
      assert.ok(codexToml.includes("[mcp_servers.legacy-sse]"));
      assert.equal(codexToml.includes("disabled-srv"), false);

      // 3d) Antigravity 插件目录 + SSE 跳过告警
      const agyPlugin = fixture.readWorkspaceJson(".agents/plugins/y3maker-mcp/plugin.json");
      assert.equal(agyPlugin.name, "y3maker-mcp");
      assert.ok(typeof agyPlugin.version === "string" && agyPlugin.version.length > 0);
      const agyMcp = fixture.readWorkspaceJson(".agents/plugins/y3maker-mcp/mcp_config.json");
      assert.deepEqual(Object.keys(agyMcp.mcpServers).sort(), ["y3-http", "y3-stdio"]);
      assert.equal("type" in agyMcp.mcpServers["y3-stdio"], false);
      assert.equal("type" in agyMcp.mcpServers["y3-http"], false);
      assert.equal(agyMcp.mcpServers["legacy-sse"], undefined);
      assert.equal(agyMcp.mcpServers["disabled-srv"], undefined);
      assert.ok(
        applyRes.json.mcp.targets.antigravity.warnings.some(
          (w) => w.includes("legacy-sse") && w.includes("mcp-remote")
        )
      );

      // 3e) DSH .dsh/cordis.patch.yml 安全合并 + --patch 提示 + SSE 跳过告警
      assert.equal(fixture.existsInWorkspace(".dsh/skills"), false);
      const dshPatch = fixture.readWorkspaceFile(".dsh/cordis.patch.yml");
      assert.ok(dshPatch.includes('id: "custom-project-plugin"'));
      assert.ok(dshPatch.includes('id: "y3maker-mcp-y3-stdio"'));
      assert.ok(dshPatch.includes('id: "y3maker-mcp-y3-http"'));
      assert.equal(dshPatch.includes("legacy-sse"), false);
      assert.equal(dshPatch.includes("disabled-srv"), false);
      assert.ok(
        applyRes.json.mcp.targets.dsh.hints.some((h) => h.includes("--patch .dsh/cordis.patch.yml"))
      );
      assert.ok(
        applyRes.json.mcp.hints.some((h) => h.includes("--patch .dsh/cordis.patch.yml"))
      );
      assert.ok(
        applyRes.json.mcp.targets.dsh.warnings.some(
          (w) => w.includes("legacy-sse") && w.includes("mcp-remote")
        )
      );

      // 3f) 硬边界检查：project scope 不触碰 Fake Home；.y3maker、AGENTS.md、CLAUDE.md 字节级未改动
      assert.deepEqual(snapshotDirectory(fixture.homeDir), homeBeforeDry);
      assert.deepEqual(fixture.snapshotTree(".y3maker"), legacyBefore);
      assert.equal(fixture.readWorkspaceFile("AGENTS.md"), originalAgentsMd);
      assert.equal(fixture.readWorkspaceFile("CLAUDE.md"), originalClaudeMd);

      // 4) 全量 verify（省略参数，自动从 manifest 读取 4 宿主与 project scope）
      const verifyRes = fixture.runVerify(["--pretty"]);
      assert.equal(
        verifyRes.status,
        0,
        `verify 应通过，stdout: ${verifyRes.stdout}\nstderr: ${verifyRes.stderr}`
      );
      assert.equal(verifyRes.json.ok, true);
      assert.deepEqual(verifyRes.json.targets, ["antigravity", "claude", "codex", "dsh"]);
      assert.equal(verifyRes.json.mcpScope, "project");
      assert.deepEqual(verifyRes.json.issues, []);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 2: 同一工作区下 --targets all 切换 project -> user -> skip -> project 三种 MCP Scope，四端安全合并、旧范围配置保留提示且每步 verify 均通过", () => {
    const fixture = createFixture();
    try {
      seedRichMultiHarnessWorkspace(fixture);
      const legacyBefore = fixture.snapshotTree(".y3maker");

      // 在隔离 Fake Home 预置四个宿主各自已有的全局用户配置
      const initialHomeCodex = [
        "# 用户全局 Codex 配置",
        'model = "gpt-5.4"',
        "",
        '[projects."C:\\\\demo"]',
        'trust_level = "trusted"',
        "",
        "[mcp_servers.personal-codex]",
        'command = "uvx"',
        'args = ["git-mcp"]',
        "",
      ].join("\n");
      fixture.writeHomeFile(".codex/config.toml", initialHomeCodex);

      const initialHomeClaude = `${JSON.stringify(
        {
          numStartups: 42,
          theme: "dark",
          mcpServers: {
            "personal-claude": {
              type: "stdio",
              command: "npx",
              args: ["-y", "personal-claude-mcp"],
            },
          },
        },
        null,
        2
      )}\n`;
      fixture.writeHomeFile(".claude.json", initialHomeClaude);

      const initialHomeAgy = `${JSON.stringify(
        {
          extraSetting: { keep: true },
          mcpServers: {
            "personal-agy": {
              command: "node",
              args: ["personal-agy.js"],
            },
          },
        },
        null,
        2
      )}\n`;
      fixture.writeHomeFile(".gemini/config/mcp_config.json", initialHomeAgy);

      const initialHomeDsh = [
        "# 用户全局 DSH 补丁",
        "- insert:",
        '    - id: "cmhub-hooks-claude-code"',
        '      name: "@deepseek-ai/dsh-hooks-claude-code"',
        "      config:",
        '        configPath: "C:\\\\demo\\\\settings.json"',
        "",
        '- id: "tool-bash"',
        "  disabled: true",
        "",
      ].join("\n");
      fixture.writeHomeFile(".dsh/cordis.patch.yml", initialHomeDsh);

      const homeBeforeProject = snapshotDirectory(fixture.homeDir);

      // Step 1: project scope
      const stepProject = fixture.runApply(["--targets", "all", "--mcp-scope", "project"]);
      assert.equal(stepProject.status, 0, `project apply stderr: ${stepProject.stderr}`);
      assert.equal(stepProject.json.mcp.scope, "project");
      assert.deepEqual(snapshotDirectory(fixture.homeDir), homeBeforeProject, "project 范围不应触碰 Fake Home");
      assert.equal(fixture.runVerify().status, 0, "project 范围 verify 应通过");

      const projectCodexBeforeSwitch = fixture.readWorkspaceFile(".codex/config.toml");
      const projectClaudeBeforeSwitch = fixture.readWorkspaceFile(".mcp.json");
      const projectAgyMcpBeforeSwitch = fixture.readWorkspaceFile(
        ".agents/plugins/y3maker-mcp/mcp_config.json"
      );
      const projectDshBeforeSwitch = fixture.readWorkspaceFile(".dsh/cordis.patch.yml");

      // Step 2: 切换至 user scope 先跑 dry-run（零落盘 + 预告旧范围保留提示）
      const workspaceBeforeUserDry = snapshotDirectory(fixture.workspace);
      const dryUser = fixture.runApply([
        "--targets",
        "all",
        "--mcp-scope",
        "user",
        "--dry-run",
        "--pretty",
      ]);
      assert.equal(dryUser.status, 0, `user dry-run stderr: ${dryUser.stderr}`);
      assert.deepEqual(dryUser.json.sync.orphaned, [], "切换 MCP Scope 不应误报为源文件被删除的 orphaned");
      assert.ok(
        dryUser.json.mcp.hints.some((h) => h.includes(".mcp.json") && h.includes("project") && h.includes("user")),
        `dry-run 应在 mcp.hints 中提示保留旧范围配置，实际：${JSON.stringify(dryUser.json.mcp.hints)}`
      );
      assert.deepEqual(snapshotDirectory(fixture.workspace), workspaceBeforeUserDry);
      assert.deepEqual(snapshotDirectory(fixture.homeDir), homeBeforeProject);

      // Step 3: 正式切换至 user scope
      const stepUser = fixture.runApply(["--targets", "all", "--mcp-scope", "user", "--pretty"]);
      assert.equal(stepUser.status, 0, `user apply stderr: ${stepUser.stderr}`);
      assert.equal(stepUser.json.mcp.scope, "user");
      assert.deepEqual(stepUser.json.sync.blocked, []);
      assert.deepEqual(stepUser.json.sync.orphaned, [], "切换 MCP Scope 不应产生误导性 orphaned 条目");

      // 校验四个宿主的 Fake Home 全局配置均已安全合并且保留既有内容
      const homeCodex = fixture.readHomeFile(".codex/config.toml");
      assert.ok(homeCodex.includes('model = "gpt-5.4"'));
      assert.ok(homeCodex.includes('[projects."C:\\\\demo"]'));
      assert.ok(homeCodex.includes("[mcp_servers.personal-codex]"));
      assert.ok(homeCodex.includes("[mcp_servers.y3-stdio]"));
      assert.ok(homeCodex.includes("[mcp_servers.y3-http]"));
      assert.ok(homeCodex.includes("[mcp_servers.legacy-sse]"));
      assert.equal(homeCodex.includes("disabled-srv"), false);

      const homeClaude = fixture.readHomeJson(".claude.json");
      assert.equal(homeClaude.numStartups, 42);
      assert.equal(homeClaude.theme, "dark");
      assert.ok(homeClaude.mcpServers["personal-claude"]);
      assert.equal(homeClaude.mcpServers["y3-stdio"].type, "stdio");
      assert.equal(homeClaude.mcpServers["y3-http"].type, "http");
      assert.equal(homeClaude.mcpServers["legacy-sse"].type, "sse");
      assert.equal(homeClaude.mcpServers["disabled-srv"], undefined);

      const homeAgy = fixture.readHomeJson(".gemini/config/mcp_config.json");
      assert.deepEqual(homeAgy.extraSetting, { keep: true });
      assert.ok(homeAgy.mcpServers["personal-agy"]);
      assert.ok(homeAgy.mcpServers["y3-stdio"]);
      assert.ok(homeAgy.mcpServers["y3-http"]);
      assert.equal("type" in homeAgy.mcpServers["y3-stdio"], false);
      assert.equal("type" in homeAgy.mcpServers["y3-http"], false);
      assert.equal(homeAgy.mcpServers["legacy-sse"], undefined);
      assert.ok(
        stepUser.json.mcp.targets.antigravity.warnings.some(
          (w) => w.includes("legacy-sse") && w.includes("mcp-remote")
        )
      );

      const homeDsh = fixture.readHomeFile(".dsh/cordis.patch.yml");
      assert.ok(homeDsh.includes('id: "cmhub-hooks-claude-code"'));
      assert.ok(homeDsh.includes('- id: "tool-bash"\n  disabled: true'));
      assert.ok(homeDsh.includes('id: "y3maker-mcp-y3-stdio"'));
      assert.ok(homeDsh.includes('id: "y3maker-mcp-y3-http"'));
      assert.equal(homeDsh.includes("legacy-sse"), false);
      assert.equal(
        stepUser.json.mcp.targets.dsh.hints.some((h) => h.includes("--patch .dsh/cordis.patch.yml")),
        false,
        "user 范围下 DSH 全局自动加载，不应再提示项目级 --patch 参数"
      );

      // 原 project 范围的 5 个配置文件未被静默删除或篡改，且在 mcp.hints 中提示保留
      assert.equal(fixture.readWorkspaceFile(".codex/config.toml"), projectCodexBeforeSwitch);
      assert.equal(fixture.readWorkspaceFile(".mcp.json"), projectClaudeBeforeSwitch);
      assert.equal(
        fixture.readWorkspaceFile(".agents/plugins/y3maker-mcp/mcp_config.json"),
        projectAgyMcpBeforeSwitch
      );
      assert.equal(fixture.readWorkspaceFile(".dsh/cordis.patch.yml"), projectDshBeforeSwitch);
      for (const retainedPath of [
        ".codex/config.toml",
        ".mcp.json",
        ".agents/plugins/y3maker-mcp/plugin.json",
        ".agents/plugins/y3maker-mcp/mcp_config.json",
        ".dsh/cordis.patch.yml",
      ]) {
        assert.ok(
          stepUser.json.mcp.hints.some((h) => h.includes(retainedPath)),
          `切换至 user 范围后应在 mcp.hints 中提示保留了原配置文件 ${retainedPath}`
        );
      }

      const verifyUser = fixture.runVerify(["--pretty"]);
      assert.equal(
        verifyUser.status,
        0,
        `切换至 user 范围后 verify 应通过，实际：${verifyUser.stdout}`
      );
      assert.equal(verifyUser.json.ok, true);
      assert.equal(verifyUser.json.mcpScope, "user");
      assert.deepEqual(verifyUser.json.issues, []);

      // Step 4: 切换至 skip scope（不修改任何 MCP 文件，保留用户级配置并提示，verify 通过）
      const homeBeforeSkip = snapshotDirectory(fixture.homeDir);
      const stepSkip = fixture.runApply(["--targets", "all", "--mcp-scope", "skip", "--pretty"]);
      assert.equal(stepSkip.status, 0, `skip apply stderr: ${stepSkip.stderr}`);
      assert.equal(stepSkip.json.mcp.scope, "skip");
      assert.deepEqual(stepSkip.json.sync.orphaned, []);
      assert.deepEqual(snapshotDirectory(fixture.homeDir), homeBeforeSkip, "skip 范围不应修改 Fake Home");
      for (const targetId of ["antigravity", "claude", "codex", "dsh"]) {
        assert.equal(stepSkip.json.mcp.targets[targetId].scope, "skip");
        assert.equal(stepSkip.json.mcp.targets[targetId].converted, false);
      }
      for (const retainedUserPath of [
        "~/.codex/config.toml",
        "~/.claude.json",
        "~/.gemini/config/mcp_config.json",
        "~/.dsh/cordis.patch.yml",
      ]) {
        assert.ok(
          stepSkip.json.mcp.hints.some((h) => h.includes(retainedUserPath)),
          `切换至 skip 后应在 mcp.hints 中提示保留了用户级配置 ${retainedUserPath}`
        );
      }

      const verifySkip = fixture.runVerify(["--pretty"]);
      assert.equal(verifySkip.status, 0, `切换至 skip 后 verify 应通过，实际：${verifySkip.stdout}`);
      assert.equal(verifySkip.json.ok, true);
      assert.equal(verifySkip.json.mcpScope, "skip");
      assert.deepEqual(verifySkip.json.issues, []);

      // Step 5: 从 skip 切回 project scope -> 无痛重新接管（adopt），verify 通过
      const backToProject = fixture.runApply(["--targets", "all", "--mcp-scope", "project"]);
      assert.equal(backToProject.status, 0, `back-to-project stderr: ${backToProject.stderr}`);
      assert.deepEqual(backToProject.json.sync.blocked, []);
      assert.deepEqual(backToProject.json.sync.orphaned, []);
      const verifyBack = fixture.runVerify();
      assert.equal(verifyBack.status, 0, `切回 project 后 verify 应通过，实际：${verifyBack.stdout}`);
      assert.equal(verifyBack.json.ok, true);

      // 硬边界：全程不创建根目录 AGENTS.md / CLAUDE.md，.y3maker 只读
      assert.equal(fixture.existsInWorkspace("AGENTS.md"), false);
      assert.equal(fixture.existsInWorkspace("CLAUDE.md"), false);
      assert.deepEqual(fixture.snapshotTree(".y3maker"), legacyBefore);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 3: --targets all 跨轮重复同步（幂等复跑、上游更新联动四端、三面 blocked 保护、上游删除 orphaned 保留、解决后 verify 通过）", () => {
    const fixture = createFixture();
    try {
      seedRichMultiHarnessWorkspace(fixture);
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-extra/SKILL.md",
        "---\nname: y3-extra\ndescription: 将被上游删除的临时技能\n---\n\n正文。\n"
      );
      fixture.writeWorkspaceFile(".y3maker/memory/old-note.md", "# 旧记忆\n");

      // Round 1: 首次全四端迁移（project MCP）
      const round1 = fixture.runApply(["--targets", "all", "--mcp-scope", "project"]);
      assert.equal(round1.status, 0, `round1 stderr: ${round1.stderr}`);
      assert.equal(fixture.runVerify().status, 0, "round1 verify 应通过");

      // Round 2: 省略 --targets 复用 manifest.targets，幂等复跑应全量 unchanged
      const round2 = fixture.runApply(["--mcp-scope", "project"]);
      assert.equal(round2.status, 0, `round2 stderr: ${round2.stderr}`);
      assert.deepEqual(round2.json.targets, ["antigravity", "claude", "codex", "dsh"]);
      assert.deepEqual(round2.json.sync.created, []);
      assert.deepEqual(round2.json.sync.updated, []);
      assert.deepEqual(round2.json.sync.blocked, []);
      assert.deepEqual(round2.json.sync.orphaned, []);
      assert.ok(round2.json.sync.unchangedCount > 0);

      // Round 3: 制造跨轮混合变更
      // 3a) 上游纯变更（knowledge + y3-sample 技能正文与 tools + MCP stdio 参数）
      fixture.writeWorkspaceFile(
        ".y3maker/knowledge/overview.md",
        "# 项目知识 v2\n\n参考 `.codemaker/rules/api-safety.mdc`。\n"
      );
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-sample/SKILL.md",
        [
          "---",
          "name: y3-sample",
          "description: 示例技能 v2",
          "tools: Read, Bash, Grep",
          "---",
          "",
          "# 示例技能 v2",
          "",
          "阅读 `../../rules/api-safety.mdc` 并执行 `scripts/run.py`。",
          "",
        ].join("\n")
      );
      fixture.writeWorkspaceFile(
        ".y3maker/mcp_settings.json",
        `${JSON.stringify(
          {
            mcpServers: {
              "y3-stdio": {
                type: "stdio",
                command: "node",
                args: ["scripts/mcp-server-v2.js", "--port", "3000"],
                cwd: "./tools",
                env: {
                  NODE_ENV: "production",
                  Y3_MAP: "demo",
                },
              },
              "y3-http": {
                type: "streamableHttp",
                url: "https://mcp.example.com/mcp",
                headers: {
                  Authorization: "Bearer demo-token",
                  "X-Team": "y3",
                },
              },
            },
          },
          null,
          2
        )}\n`
      );

      // 3b) 三处本地冲突（Canonical Store 规则、Claude 技能投影脚本、DSH MCP 补丁）
      const originalDshBeforeConflict = fixture.readWorkspaceFile(".dsh/cordis.patch.yml");
      const localRuleEdit = "---\ndescription: 本地手工定制规则\n---\n\n请勿覆盖。\n";
      fixture.writeWorkspaceFile(".agents/rules/api-safety.mdc", localRuleEdit);
      const localClaudeScriptEdit = "print('local-claude-override')\n";
      fixture.writeWorkspaceFile(".claude/skills/y3-sample/scripts/run.py", localClaudeScriptEdit);
      const localDshOverride = originalDshBeforeConflict.replace(
        "scripts/mcp-server.js",
        "scripts/local-dsh-override.js"
      );
      fixture.writeWorkspaceFile(".dsh/cordis.patch.yml", localDshOverride);

      // 3c) 上游删除技能与记忆文件
      fixture.removeWorkspacePath(".y3maker/skills/y3-extra");
      fixture.removeWorkspacePath(".y3maker/memory/old-note.md");

      const round3 = fixture.runApply(["--mcp-scope", "project", "--pretty"]);
      assert.equal(round3.status, 0, `round3 stderr: ${round3.stderr}`);

      // 上游纯变更自动同步到 Canonical Store、Claude 投影与另外 3 个未冲突宿主的 MCP 配置
      assert.ok(round3.json.sync.updated.includes(".agents/knowledge/overview.md"));
      assert.ok(round3.json.sync.updated.includes(".agents/skills/y3-sample/SKILL.md"));
      assert.ok(round3.json.sync.updated.includes(".claude/skills/y3-sample/SKILL.md"));
      assert.ok(round3.json.sync.updated.includes(".codex/config.toml"));
      assert.ok(round3.json.sync.updated.includes(".mcp.json"));
      assert.ok(round3.json.sync.updated.includes(".agents/plugins/y3maker-mcp/mcp_config.json"));

      assert.ok(fixture.readWorkspaceFile(".agents/knowledge/overview.md").includes("# 项目知识 v2"));
      assert.equal(
        fixture.readWorkspaceFile(".agents/skills/y3-sample/SKILL.md").includes("allowed-tools:"),
        false,
        "Canonical Store 的 SKILL.md 绝不写入 allowed-tools"
      );
      assert.ok(
        fixture
          .readWorkspaceFile(".claude/skills/y3-sample/SKILL.md")
          .includes("allowed-tools: Read, Bash, Grep")
      );
      assert.ok(fixture.readWorkspaceFile(".codex/config.toml").includes("mcp-server-v2.js"));
      assert.deepEqual(fixture.readWorkspaceJson(".mcp.json").mcpServers["y3-stdio"].args, [
        "scripts/mcp-server-v2.js",
        "--port",
        "3000",
      ]);
      assert.deepEqual(
        fixture.readWorkspaceJson(".agents/plugins/y3maker-mcp/mcp_config.json").mcpServers[
          "y3-stdio"
        ].args,
        ["scripts/mcp-server-v2.js", "--port", "3000"]
      );

      // 三处本地冲突全部标记 blocked 且磁盘内容毫发无损
      const blockedPaths = round3.json.sync.blocked.map((item) => item.path).sort();
      assert.deepEqual(blockedPaths, [
        ".agents/rules/api-safety.mdc",
        ".claude/skills/y3-sample/scripts/run.py",
        ".dsh/cordis.patch.yml",
      ]);
      assert.equal(fixture.readWorkspaceFile(".agents/rules/api-safety.mdc"), localRuleEdit);
      assert.equal(
        fixture.readWorkspaceFile(".claude/skills/y3-sample/scripts/run.py"),
        localClaudeScriptEdit
      );
      assert.equal(fixture.readWorkspaceFile(".dsh/cordis.patch.yml"), localDshOverride);
      assert.equal(round3.json.mcp.targets.dsh.blocked, true);
      assert.equal(round3.json.mcp.targets.dsh.converted, false);

      // 上游删除的文件保留在磁盘并标记 orphaned（含 .agents 与 .claude/skills 同步孤立）
      const orphanedPaths = round3.json.sync.orphaned.map((item) => item.path).sort();
      assert.deepEqual(orphanedPaths, [
        ".agents/memory/old-note.md",
        ".agents/skills/y3-extra/SKILL.md",
        ".claude/skills/y3-extra/SKILL.md",
      ]);
      assert.equal(fixture.existsInWorkspace(".agents/memory/old-note.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/skills/y3-extra/SKILL.md"), true);
      assert.equal(fixture.existsInWorkspace(".claude/skills/y3-extra/SKILL.md"), true);

      // 此时 verify 必须失败并检出全部 3 个 merge-blocked 与 3 个 orphaned-target
      const verifyDirty = fixture.runVerify(["--pretty"]);
      assert.equal(verifyDirty.status, 1);
      assert.equal(verifyDirty.json.ok, false);
      for (const p of blockedPaths) {
        assert.ok(
          verifyDirty.json.issues.some((i) => i.type === "merge-blocked" && i.path === p),
          `verify 应检出 merge-blocked: ${p}`
        );
      }
      for (const p of orphanedPaths) {
        assert.ok(
          verifyDirty.json.issues.some((i) => i.type === "orphaned-target" && i.path === p),
          `verify 应检出 orphaned-target: ${p}`
        );
      }

      // Round 4: 人工解决三处冲突并清理孤立文件 -> 再次 apply 全部转为 resolved，verify 通过
      fixture.writeWorkspaceFile(
        ".agents/rules/api-safety.mdc",
        "---\ndescription: API 安全规则\n---\n\n禁止调用危险接口，详见 `.agents/knowledge/overview.md`。\n"
      );
      fixture.writeWorkspaceFile(".claude/skills/y3-sample/scripts/run.py", "print('ok')\n");
      fixture.writeWorkspaceFile(
        ".dsh/cordis.patch.yml",
        originalDshBeforeConflict.replace("scripts/mcp-server.js", "scripts/mcp-server-v2.js")
      );
      fixture.removeWorkspacePath(".agents/memory/old-note.md");
      fixture.removeWorkspacePath(".agents/skills/y3-extra");
      fixture.removeWorkspacePath(".claude/skills/y3-extra");

      const round4 = fixture.runApply(["--mcp-scope", "project", "--pretty"]);
      assert.equal(round4.status, 0, `round4 stderr: ${round4.stderr}`);
      assert.deepEqual(round4.json.sync.resolved.sort(), [
        ".agents/rules/api-safety.mdc",
        ".claude/skills/y3-sample/scripts/run.py",
        ".dsh/cordis.patch.yml",
      ]);
      assert.equal(round4.json.mcp.targets.dsh.blocked, false);
      assert.equal(round4.json.mcp.targets.dsh.converted, true);
      assert.deepEqual(round4.json.sync.blocked, []);
      assert.deepEqual(round4.json.sync.orphaned, []);

      const verifyClean = fixture.runVerify(["--pretty"]);
      assert.equal(verifyClean.status, 0, `解决后 verify 应通过，实际：${verifyClean.stdout}`);
      assert.equal(verifyClean.json.ok, true);
      assert.deepEqual(verifyClean.json.issues, []);

      // Round 5: 确认真正删除上游 .y3maker/mcp_settings.json 仍会保守标记四端 MCP 文件为 orphaned（绝不静默删除）
      fixture.removeWorkspacePath(".y3maker/mcp_settings.json");
      const round5 = fixture.runApply([]);
      assert.equal(round5.status, 0, `round5 stderr: ${round5.stderr}`);
      assert.deepEqual(
        round5.json.sync.orphaned.map((item) => item.path).sort(),
        [
          ".agents/plugins/y3maker-mcp/mcp_config.json",
          ".agents/plugins/y3maker-mcp/plugin.json",
          ".codex/config.toml",
          ".dsh/cordis.patch.yml",
          ".mcp.json",
        ]
      );
      assert.equal(fixture.existsInWorkspace(".codex/config.toml"), true);
      assert.equal(fixture.existsInWorkspace(".mcp.json"), true);
      assert.equal(fixture.existsInWorkspace(".dsh/cordis.patch.yml"), true);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 4: 含旧版 .codex/ 与 .claude/ 历史迁移的工作区升级至 --targets all，过渡盘点准确识别手工改动并全程零破坏历史目录", () => {
    const crypto = require("crypto");
    const fixture = createFixture();
    try {
      seedRichMultiHarnessWorkspace(fixture);

      const sha256Text = (text) =>
        crypto.createHash("sha256").update(Buffer.from(text.replace(/\r\n/g, "\n"), "utf8")).digest("hex");

      // 构造旧版 .codex/ 迁移副本（一个未改文件 + 一个被手工改过的文件）
      const codexRuleOriginal = "---\ndescription: 旧规则\n---\n\n未改动。\n";
      const codexKnowledgeBaseline = "# 旧知识基线\n";
      const codexKnowledgeEdited = "# 旧知识（用户手工修改过）\n";
      fixture.writeWorkspaceFile(".codex/rules/api-safety.mdc", codexRuleOriginal);
      fixture.writeWorkspaceFile(".codex/knowledge/overview.md", codexKnowledgeEdited);
      fixture.writeWorkspaceFile(
        ".codex/skills/y3-sample/SKILL.md",
        "---\nname: y3-sample\ndescription: 旧 Codex 技能\n---\n\n旧技能。\n"
      );
      fixture.writeWorkspaceFile(
        ".codex/migration/y3maker-manifest.json",
        `${JSON.stringify(
          {
            version: 1,
            tool: "sync-y3maker-to-codex",
            updatedAt: "2026-01-01T00:00:00.000Z",
            files: {
              ".codex/rules/api-safety.mdc": {
                status: "managed",
                kind: "rules",
                source: ".y3maker/rules/api-safety.mdc",
                target: ".codex/rules/api-safety.mdc",
                targetScope: "project",
                renderedHash: sha256Text(codexRuleOriginal),
                targetHash: sha256Text(codexRuleOriginal),
              },
              ".codex/knowledge/overview.md": {
                status: "managed",
                kind: "knowledge",
                source: ".y3maker/knowledge/overview.md",
                target: ".codex/knowledge/overview.md",
                targetScope: "project",
                renderedHash: sha256Text(codexKnowledgeBaseline),
                targetHash: sha256Text(codexKnowledgeBaseline),
              },
              ".codex/skills/y3-sample/SKILL.md": {
                status: "managed",
                kind: "skill",
                source: ".y3maker/skills/y3-sample/SKILL.md",
                target: ".codex/skills/y3-sample/SKILL.md",
                targetScope: "project",
                renderedHash: sha256Text("---\nname: y3-sample\ndescription: 旧 Codex 技能\n---\n\n旧技能。\n"),
                targetHash: sha256Text("---\nname: y3-sample\ndescription: 旧 Codex 技能\n---\n\n旧技能。\n"),
              },
            },
          },
          null,
          2
        )}\n`
      );

      // 构造旧版 .claude/ 迁移副本（含旧 .claude/skills/ 与旧 .claude/rules/）
      const claudeRuleOriginal = "---\ndescription: 旧 Claude 规则\n---\n\n未改动。\n";
      const legacyClaudeSkill =
        "---\nname: y3-sample\ndescription: 旧版 Claude 技能\n---\n\n引用 `.claude/rules/api-safety.mdc`。\n";
      fixture.writeWorkspaceFile(".claude/rules/api-safety.mdc", claudeRuleOriginal);
      fixture.writeWorkspaceFile(".claude/skills/y3-sample/SKILL.md", legacyClaudeSkill);
      fixture.writeWorkspaceFile(
        ".claude/migration/y3maker-manifest.json",
        `${JSON.stringify(
          {
            version: 1,
            tool: "sync-y3maker-to-claude",
            updatedAt: "2026-01-01T00:00:00.000Z",
            files: {
              ".claude/rules/api-safety.mdc": {
                status: "managed",
                kind: "rules",
                source: ".y3maker/rules/api-safety.mdc",
                target: ".claude/rules/api-safety.mdc",
                targetScope: "project",
                renderedHash: sha256Text(claudeRuleOriginal),
                targetHash: sha256Text(claudeRuleOriginal),
              },
              ".claude/skills/y3-sample/SKILL.md": {
                status: "managed",
                kind: "skill",
                source: ".y3maker/skills/y3-sample/SKILL.md",
                target: ".claude/skills/y3-sample/SKILL.md",
                targetScope: "project",
                renderedHash: sha256Text(legacyClaudeSkill),
                targetHash: sha256Text(legacyClaudeSkill),
              },
            },
          },
          null,
          2
        )}\n`
      );

      const legacyBefore = fixture.snapshotTree(".y3maker");
      const codexRulesBefore = fixture.snapshotTree(".codex/rules");
      const codexKnowledgeBefore = fixture.snapshotTree(".codex/knowledge");
      const codexSkillsBefore = fixture.snapshotTree(".codex/skills");
      const codexMigrationBefore = fixture.snapshotTree(".codex/migration");
      const claudeRulesBefore = fixture.snapshotTree(".claude/rules");
      const claudeMigrationBefore = fixture.snapshotTree(".claude/migration");

      // 1) inventory 盘点应发现两套旧版迁移并标出本地手工改动文件
      const invRes = fixture.runInventory(["--pretty"]);
      assert.equal(invRes.status, 0, `inventory stderr: ${invRes.stderr}`);
      assert.equal(invRes.json.legacyTransition.detected, true);
      assert.deepEqual(invRes.json.legacyTransition.summary.detectedHarnesses, ["claude", "codex"]);
      assert.equal(invRes.json.legacyTransition.summary.modifiedCount, 1);

      const codexLegacyInv = invRes.json.legacyTransition.legacyMigrations.find(
        (item) => item.harness === "codex"
      );
      assert.ok(
        codexLegacyInv.manualReviewRequired.some((f) => f.path === ".codex/knowledge/overview.md")
      );
      assert.ok(codexLegacyInv.safeToCleanDirectories.includes(".codex/rules"));

      // 2) apply --targets all --mcp-scope project：不破坏任何旧历史目录，保护冲突的 .claude/skills/y3-sample/SKILL.md
      const applyRes = fixture.runApply([
        "--targets",
        "all",
        "--mcp-scope",
        "project",
        "--pretty",
      ]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);

      // 旧版历史目录 100% 字节级未改动
      assert.deepEqual(fixture.snapshotTree(".y3maker"), legacyBefore);
      assert.deepEqual(fixture.snapshotTree(".codex/rules"), codexRulesBefore);
      assert.deepEqual(fixture.snapshotTree(".codex/knowledge"), codexKnowledgeBefore);
      assert.deepEqual(fixture.snapshotTree(".codex/skills"), codexSkillsBefore);
      assert.deepEqual(fixture.snapshotTree(".codex/migration"), codexMigrationBefore);
      assert.deepEqual(fixture.snapshotTree(".claude/rules"), claudeRulesBefore);
      assert.deepEqual(fixture.snapshotTree(".claude/migration"), claudeMigrationBefore);

      // 与旧版内容不同的 .claude/skills/y3-sample/SKILL.md 必须被 blocked 保护，绝不静默覆盖
      assert.ok(
        applyRes.json.sync.blocked.some((b) => b.path === ".claude/skills/y3-sample/SKILL.md"),
        "遇旧版不同的 .claude/skills/y3-sample/SKILL.md 应保护为 blocked"
      );
      assert.equal(
        fixture.readWorkspaceFile(".claude/skills/y3-sample/SKILL.md"),
        legacyClaudeSkill
      );

      // 过渡报告在 --targets all 下必须保护活跃的 .claude/skills、.mcp.json 与 .codex/config.toml
      assert.ok(
        applyRes.json.legacyTransition.summary.activeProtectedDirectories.includes(".claude/skills")
      );
      const claudeLegacyApply = applyRes.json.legacyTransition.legacyMigrations.find(
        (item) => item.harness === "claude"
      );
      const codexLegacyApply = applyRes.json.legacyTransition.legacyMigrations.find(
        (item) => item.harness === "codex"
      );
      assert.ok(claudeLegacyApply.activeProtectedPaths.includes(".claude/skills"));
      assert.ok(claudeLegacyApply.activeProtectedPaths.includes(".mcp.json"));
      assert.ok(codexLegacyApply.activeProtectedPaths.includes(".codex/config.toml"));
      assert.equal(claudeLegacyApply.safeToCleanDirectories.includes(".claude/skills"), false);

      // 根目录 AGENTS.md / CLAUDE.md 未被创建
      assert.equal(fixture.existsInWorkspace("AGENTS.md"), false);
      assert.equal(fixture.existsInWorkspace("CLAUDE.md"), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 5a: 单次 verify 在 --targets all 下同时拦截四端 MCP 异常与 Claude 技能投影路径异常", () => {
    const fixture = createFixture();
    try {
      seedRichMultiHarnessWorkspace(fixture);
      const applyRes = fixture.runApply(["--targets", "all", "--mcp-scope", "project"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);

      // 同时破坏四端产物
      // 1) Codex: 损坏 TOML 语法
      fixture.writeWorkspaceFile(".codex/config.toml", "[mcp_servers.y3-stdio\ncommand = 'node'\n");
      // 2) Claude: 删除受管 MCP 服务 + 在 .claude/skills/ 注入未改写相对路径
      fixture.writeWorkspaceFile(".mcp.json", `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
      fixture.writeWorkspaceFile(
        ".claude/skills/y3-sample/references/guide.md",
        "未改写：`../../../rules/api-safety.mdc`\n"
      );
      // 3) Antigravity: 注入不被 agy strict 接受的 "type" 字段
      fixture.writeWorkspaceFile(
        ".agents/plugins/y3maker-mcp/mcp_config.json",
        `${JSON.stringify(
          {
            mcpServers: {
              "y3-stdio": { type: "stdio", command: "node", args: ["a.js"] },
              "y3-http": { url: "https://mcp.example.com/mcp" },
            },
          },
          null,
          2
        )}\n`
      );
      // 4) DSH: 破坏受管条目 serverName
      fixture.writeWorkspaceFile(
        ".dsh/cordis.patch.yml",
        [
          "- insert:",
          '    - id: "y3maker-mcp-y3-stdio"',
          '      name: "@deepseek-ai/dsh-mcp-client"',
          "      config:",
          '        transport: "stdio"',
          '        command: "node"',
          "",
        ].join("\n")
      );

      const verifyRes = fixture.runVerify(["--pretty"]);
      assert.equal(verifyRes.status, 1);
      assert.equal(verifyRes.json.ok, false);

      const issues = verifyRes.json.issues;
      assert.ok(
        issues.some((i) => i.type === "invalid-mcp-config" && i.path === ".codex/config.toml"),
        `应检出 Codex TOML 异常，实际：${JSON.stringify(issues)}`
      );
      assert.ok(
        issues.some((i) => i.type === "missing-mcp-server" && i.path === ".mcp.json"),
        `应检出 Claude .mcp.json 缺服务，实际：${JSON.stringify(issues)}`
      );
      assert.ok(
        issues.some(
          (i) => i.type === "stale-path" && i.path === ".claude/skills/y3-sample/references/guide.md"
        ),
        `应检出 Claude 技能投影未改写相对路径，实际：${JSON.stringify(issues)}`
      );
      assert.ok(
        issues.some(
          (i) =>
            i.type === "invalid-mcp-config" &&
            i.path === ".agents/plugins/y3maker-mcp/mcp_config.json"
        ),
        `应检出 Antigravity mcp_config.json 非法 type 字段，实际：${JSON.stringify(issues)}`
      );
      assert.ok(
        issues.some((i) => i.path === ".dsh/cordis.patch.yml"),
        `应检出 DSH cordis.patch.yml 异常，实际：${JSON.stringify(issues)}`
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 5b: 发布态 sync-y3maker-to-agents 技能包文档完整且符合四端 SKILL.md 规范，自安装到项目后 verify 仍通过", () => {
    const skillMdPath = path.join(SKILL_ROOT, "SKILL.md");
    const mapMdPath = path.join(SKILL_ROOT, "references", "migration-map.md");
    const openaiYamlPath = path.join(SKILL_ROOT, "agents", "openai.yaml");

    // 1) 三份文档文件必须存在、非空且无 UTF-8 BOM
    for (const docPath of [skillMdPath, mapMdPath, openaiYamlPath]) {
      assert.equal(fs.existsSync(docPath), true, `缺少技能包发布文档：${docPath}`);
      const raw = fs.readFileSync(docPath);
      assert.ok(raw.length > 0, `技能包文档不能为空：${docPath}`);
      assert.notDeepEqual([raw[0], raw[1], raw[2]], [0xef, 0xbb, 0xbf], `文档不应含 UTF-8 BOM：${docPath}`);
    }

    const skillText = fs.readFileSync(skillMdPath, "utf8");
    const mapText = fs.readFileSync(mapMdPath, "utf8");
    const openaiYamlText = fs.readFileSync(openaiYamlPath, "utf8");

    // 2) SKILL.md frontmatter 仅含标准 name 与 description（零非标准键）且非占位文档
    const fmMatch = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    assert.ok(fmMatch, "SKILL.md 必须包含合法 YAML frontmatter");
    const fmKeys = fmMatch[1]
      .split(/\r?\n/)
      .filter((line) => line && !/^\s/.test(line) && line.includes(":"))
      .map((line) => line.split(":", 1)[0].trim());
    assert.deepEqual(fmKeys, ["name", "description"], "SKILL.md frontmatter 应仅保留 name 与 description");
    assert.match(fmMatch[1], /^name:\s*sync-y3maker-to-agents\s*$/m);
    assert.equal(skillText.includes("占位文档"), false, "SKILL.md 不应残留占位文案");
    assert.ok(skillText.includes("references/migration-map.md"), "SKILL.md 应指向 references/migration-map.md");

    // 3) agents/openai.yaml 包含 Codex 元数据字段
    assert.match(openaiYamlText, /display_name:/);
    assert.match(openaiYamlText, /short_description:/);
    assert.match(openaiYamlText, /default_prompt:.*\$sync-y3maker-to-agents/);
    assert.match(openaiYamlText, /allow_implicit_invocation:\s*true/);

    // 4) references/migration-map.md 覆盖 Canonical Store 与四端适配映射
    assert.ok(mapText.includes(".agents/"));
    assert.ok(mapText.includes(".claude/skills/"));
    assert.ok(mapText.includes(".codex/config.toml"));
    assert.ok(mapText.includes(".agents/plugins/y3maker-mcp/"));
    assert.ok(mapText.includes(".dsh/cordis.patch.yml"));

    // 5) 将真实发布版 SKILL.md 安装进已迁移工作区的 .agents/skills/ 与 .claude/skills/ 后，verify 必须通过
    const fixture = createFixture();
    try {
      seedRichMultiHarnessWorkspace(fixture);
      const applyRes = fixture.runApply(["--targets", "all", "--mcp-scope", "project"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);

      fixture.writeWorkspaceFile(".agents/skills/sync-y3maker-to-agents/SKILL.md", skillText);
      fixture.writeWorkspaceFile(".agents/skills/sync-y3maker-to-agents/references/migration-map.md", mapText);
      fixture.writeWorkspaceFile(".claude/skills/sync-y3maker-to-agents/SKILL.md", skillText);
      fixture.writeWorkspaceFile(".claude/skills/sync-y3maker-to-agents/references/migration-map.md", mapText);

      const verifyRes = fixture.runVerify(["--pretty"]);
      assert.equal(
        verifyRes.status,
        0,
        `安装真实 sync-y3maker-to-agents 技能后 verify 应通过，实际：${verifyRes.stdout}`
      );
      assert.equal(verifyRes.json.ok, true);
      assert.deepEqual(verifyRes.json.issues, []);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 6: 收缩 --targets all -> --targets codex 保留取消启用宿主的磁盘文件且不误报 orphaned，输出中文人工核对提示并使 verify 通过", () => {
    const fixture = createFixture();
    try {
      seedRichMultiHarnessWorkspace(fixture);
      fixture.writeWorkspaceFile(
        ".y3maker/skills/y3-removed/SKILL.md",
        "---\nname: y3-removed\ndescription: 即将真正删除的上游技能\n---\n\n正文。\n"
      );

      // Step 1: 先全四端迁移（project MCP）
      const allRes = fixture.runApply(["--targets", "all", "--mcp-scope", "project", "--pretty"]);
      assert.equal(allRes.status, 0, `all apply stderr: ${allRes.stderr}`);
      assert.equal(fixture.runVerify().status, 0);

      // 记录取消启用宿主的磁盘快照，确保收缩 targets 时绝不删改它们
      const claudeSkillsBefore = fixture.snapshotTree(".claude/skills");
      const claudeMcpBefore = fixture.readWorkspaceFile(".mcp.json");
      const agyPluginBefore = fixture.snapshotTree(".agents/plugins/y3maker-mcp");
      const dshPatchBefore = fixture.readWorkspaceFile(".dsh/cordis.patch.yml");

      // Step 2: 仅收缩 --targets 为 codex（.y3maker 完整未删）
      const narrowRes = fixture.runApply(["--targets", "codex", "--mcp-scope", "project", "--pretty"]);
      assert.equal(narrowRes.status, 0, `narrow apply stderr: ${narrowRes.stderr}`);
      assert.deepEqual(narrowRes.json.targets, ["codex"]);
      assert.deepEqual(
        narrowRes.json.sync.orphaned,
        [],
        `仅取消启用宿主时不应误报 orphaned，实际：${JSON.stringify(narrowRes.json.sync.orphaned)}`
      );
      assert.deepEqual(narrowRes.json.sync.blocked, []);

      // 取消启用宿主留下的磁盘文件必须原样保留未删除
      assert.deepEqual(fixture.snapshotTree(".claude/skills"), claudeSkillsBefore);
      assert.equal(fixture.readWorkspaceFile(".mcp.json"), claudeMcpBefore);
      assert.deepEqual(fixture.snapshotTree(".agents/plugins/y3maker-mcp"), agyPluginBefore);
      assert.equal(fixture.readWorkspaceFile(".dsh/cordis.patch.yml"), dshPatchBefore);

      // 应输出清晰中文提示，列出取消启用宿主留下的文件路径供人工核对或清理
      assert.ok(
        Array.isArray(narrowRes.json.hints) && narrowRes.json.hints.length > 0,
        `收缩 --targets 时应在顶层 hints 输出中文保留提示，实际：${JSON.stringify(narrowRes.json.hints)}`
      );
      const joinedHints = narrowRes.json.hints.join("\n");
      for (const expectedPath of [
        ".claude/skills/y3-sample/SKILL.md",
        ".mcp.json",
        ".agents/plugins/y3maker-mcp/plugin.json",
        ".agents/plugins/y3maker-mcp/mcp_config.json",
        ".dsh/cordis.patch.yml",
      ]) {
        assert.ok(
          joinedHints.includes(expectedPath),
          `hints 应列出取消启用宿主保留的文件 ${expectedPath}，实际：${joinedHints}`
        );
      }

      // manifest 不得保留会阻断 verify 的 orphaned 记录，verify 必须通过
      const manifestAfterNarrow = fixture.readWorkspaceJson(".agents/migration/y3maker-manifest.json");
      assert.deepEqual(manifestAfterNarrow.targets, ["codex"]);
      assert.equal(
        Object.values(manifestAfterNarrow.files).some((entry) => entry.status === "orphaned"),
        false,
        "manifest 不应包含因取消启用宿主产生的 orphaned 条目"
      );

      const verifyNarrow = fixture.runVerify(["--pretty"]);
      assert.equal(
        verifyNarrow.status,
        0,
        `收缩 --targets 为 codex 后 verify 应通过，实际：${verifyNarrow.stdout}`
      );
      assert.equal(verifyNarrow.json.ok, true);
      assert.deepEqual(verifyNarrow.json.issues, []);

      // Step 3: 恢复 all 后，在同一轮既收缩为 codex 又真正删除 .y3maker/skills/y3-removed -> 仅真正删除的源对应文件标记 orphaned
      const restoreAll = fixture.runApply(["--targets", "all", "--mcp-scope", "project"]);
      assert.equal(restoreAll.status, 0, `restoreAll stderr: ${restoreAll.stderr}`);
      fixture.removeWorkspacePath(".y3maker/skills/y3-removed");

      const mixedRes = fixture.runApply(["--targets", "codex", "--mcp-scope", "project", "--pretty"]);
      assert.equal(mixedRes.status, 0, `mixed apply stderr: ${mixedRes.stderr}`);
      assert.deepEqual(
        mixedRes.json.sync.orphaned.map((item) => item.path).sort(),
        [".agents/skills/y3-removed/SKILL.md", ".claude/skills/y3-removed/SKILL.md"],
        "仅 .y3maker 中真正被删除的源文件对应目标才应标记为 orphaned"
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 7: 四端合并 MCP 配置按受管切片哈希判定冲突——用户/宿主修改无关字段叠加源更新时安全合并，手工修改受管条目仍触发 blocked", () => {
    const fixture = createFixture();
    try {
      seedRichMultiHarnessWorkspace(fixture, {
        mcpSettings: {
          mcpServers: {
            "y3-stdio": {
              type: "stdio",
              command: "node",
              args: ["scripts/mcp-v1.js"],
            },
            "y3-http": {
              type: "streamableHttp",
              url: "https://mcp.example.com/v1",
            },
          },
        },
      });

      // 预置隔离 Fake Home 四端已有配置
      fixture.writeHomeFile(
        ".claude.json",
        `${JSON.stringify(
          {
            numStartups: 10,
            mcpServers: {
              "personal-claude": { type: "stdio", command: "npx", args: ["-y", "personal"] },
            },
          },
          null,
          2
        )}\n`
      );
      fixture.writeHomeFile(
        ".codex/config.toml",
        [
          'model = "gpt-5.4"',
          "",
          '[projects."C:\\\\demo"]',
          'trust_level = "trusted"',
          "",
        ].join("\n")
      );
      fixture.writeHomeFile(
        ".gemini/config/mcp_config.json",
        `${JSON.stringify(
          {
            extraSetting: { keep: 1 },
            mcpServers: {
              "personal-agy": { command: "node", args: ["personal.js"] },
            },
          },
          null,
          2
        )}\n`
      );
      fixture.writeHomeFile(
        ".dsh/cordis.patch.yml",
        [
          "- insert:",
          '    - id: "existing-user-plugin"',
          '      name: "@acme/existing"',
          "",
        ].join("\n")
      );

      // Round 1: 初次全四端 user scope 合并
      const r1 = fixture.runApply(["--targets", "all", "--mcp-scope", "user"]);
      assert.equal(r1.status, 0, `r1 stderr: ${r1.stderr}`);
      assert.deepEqual(r1.json.sync.blocked, []);
      assert.equal(fixture.runVerify().status, 0);

      // Round 2: 同时在四端修改“无关用户/宿主字段” + 更新上游 .y3maker/mcp_settings.json
      const claudeDisk = fixture.readHomeJson(".claude.json");
      claudeDisk.numStartups = 11;
      claudeDisk.mcpServers["personal-extra"] = { type: "stdio", command: "uvx", args: ["extra"] };
      fixture.writeHomeFile(".claude.json", `${JSON.stringify(claudeDisk, null, 2)}\n`);

      const codexDisk = fixture.readHomeFile(".codex/config.toml");
      fixture.writeHomeFile(
        ".codex/config.toml",
        `${codexDisk.replace('model = "gpt-5.4"', 'model = "gpt-5.5"')}\n# 运行时新增工程信任\n[projects."D:\\\\new-proj"]\ntrust_level = "trusted"\n\n[mcp_servers.user-extra]\ncommand = "uvx"\nargs = ["extra"]\n`
      );

      const agyDisk = fixture.readHomeJson(".gemini/config/mcp_config.json");
      agyDisk.extraSetting = { keep: 2, theme: "dark" };
      agyDisk.mcpServers["agy-extra"] = { command: "python", args: ["extra.py"] };
      fixture.writeHomeFile(
        ".gemini/config/mcp_config.json",
        `${JSON.stringify(agyDisk, null, 2)}\n`
      );

      const dshDisk = fixture.readHomeFile(".dsh/cordis.patch.yml");
      fixture.writeHomeFile(
        ".dsh/cordis.patch.yml",
        `${dshDisk}    # 用户追加的新插件\n    - id: "my-new-dsh-plugin"\n      name: "@acme/new-plugin"\n`
      );

      fixture.writeWorkspaceFile(
        ".y3maker/mcp_settings.json",
        `${JSON.stringify(
          {
            mcpServers: {
              "y3-stdio": {
                type: "stdio",
                command: "node",
                args: ["scripts/mcp-v2.js"],
              },
              "y3-http": {
                type: "streamableHttp",
                url: "https://mcp.example.com/v2",
              },
              "y3-added": {
                command: "uvx",
                args: ["y3-added-mcp"],
              },
            },
          },
          null,
          2
        )}\n`
      );

      const r2 = fixture.runApply(["--targets", "all", "--mcp-scope", "user", "--pretty"]);
      assert.equal(r2.status, 0, `r2 stderr: ${r2.stderr}`);
      assert.deepEqual(
        r2.json.sync.blocked,
        [],
        `仅修改无关用户字段叠加源更新时不得误报 blocked，实际：${JSON.stringify(r2.json.sync.blocked)}`
      );
      for (const expectedUpdated of [
        "~/.claude.json",
        "~/.codex/config.toml",
        "~/.gemini/config/mcp_config.json",
        "~/.dsh/cordis.patch.yml",
      ]) {
        assert.ok(
          r2.json.sync.updated.includes(expectedUpdated),
          `应安全合并更新 ${expectedUpdated}，实际 updated：${JSON.stringify(r2.json.sync.updated)}`
        );
      }

      // 校验四端均同时保留了用户无关改动并合入了上游 v2 与新增服务
      const claudeAfterR2 = fixture.readHomeJson(".claude.json");
      assert.equal(claudeAfterR2.numStartups, 11);
      assert.ok(claudeAfterR2.mcpServers["personal-extra"]);
      assert.deepEqual(claudeAfterR2.mcpServers["y3-stdio"].args, ["scripts/mcp-v2.js"]);
      assert.equal(claudeAfterR2.mcpServers["y3-http"].url, "https://mcp.example.com/v2");
      assert.ok(claudeAfterR2.mcpServers["y3-added"]);

      const codexAfterR2 = fixture.readHomeFile(".codex/config.toml");
      assert.ok(codexAfterR2.includes('model = "gpt-5.5"'));
      assert.ok(codexAfterR2.includes('[projects."D:\\\\new-proj"]'));
      assert.ok(codexAfterR2.includes("[mcp_servers.user-extra]"));
      assert.ok(codexAfterR2.includes('args = ["scripts/mcp-v2.js"]'));
      assert.ok(codexAfterR2.includes('url = "https://mcp.example.com/v2"'));
      assert.ok(codexAfterR2.includes("[mcp_servers.y3-added]"));

      const agyAfterR2 = fixture.readHomeJson(".gemini/config/mcp_config.json");
      assert.deepEqual(agyAfterR2.extraSetting, { keep: 2, theme: "dark" });
      assert.ok(agyAfterR2.mcpServers["agy-extra"]);
      assert.deepEqual(agyAfterR2.mcpServers["y3-stdio"].args, ["scripts/mcp-v2.js"]);
      assert.ok(agyAfterR2.mcpServers["y3-added"]);

      const dshAfterR2 = fixture.readHomeFile(".dsh/cordis.patch.yml");
      assert.ok(dshAfterR2.includes('id: "my-new-dsh-plugin"'));
      assert.ok(dshAfterR2.includes('- "scripts/mcp-v2.js"'));
      assert.ok(dshAfterR2.includes('url: "https://mcp.example.com/v2"'));
      assert.ok(dshAfterR2.includes('id: "y3maker-mcp-y3-added"'));

      const verifyR2 = fixture.runVerify(["--pretty"]);
      assert.equal(verifyR2.status, 0, `r2 verify 应通过，实际：${verifyR2.stdout}`);
      assert.equal(verifyR2.json.ok, true);

      // Round 3: 手工修改四端中的“受管 MCP 条目” + 上游再次更新 -> 四端均必须触发 blocked 且保护手工改动
      claudeAfterR2.mcpServers["y3-stdio"].args = ["scripts/manual-claude.js"];
      const claudeManualText = `${JSON.stringify(claudeAfterR2, null, 2)}\n`;
      fixture.writeHomeFile(".claude.json", claudeManualText);

      const codexManualText = codexAfterR2.replace(
        'args = ["scripts/mcp-v2.js"]',
        'args = ["scripts/manual-codex.js"]'
      );
      fixture.writeHomeFile(".codex/config.toml", codexManualText);

      agyAfterR2.mcpServers["y3-stdio"].args = ["scripts/manual-agy.js"];
      const agyManualText = `${JSON.stringify(agyAfterR2, null, 2)}\n`;
      fixture.writeHomeFile(".gemini/config/mcp_config.json", agyManualText);

      const dshManualText = dshAfterR2.replace(
        '- "scripts/mcp-v2.js"',
        '- "scripts/manual-dsh.js"'
      );
      fixture.writeHomeFile(".dsh/cordis.patch.yml", dshManualText);

      fixture.writeWorkspaceFile(
        ".y3maker/mcp_settings.json",
        `${JSON.stringify(
          {
            mcpServers: {
              "y3-stdio": {
                type: "stdio",
                command: "node",
                args: ["scripts/mcp-v3.js"],
              },
              "y3-http": {
                type: "streamableHttp",
                url: "https://mcp.example.com/v3",
              },
            },
          },
          null,
          2
        )}\n`
      );

      const r3 = fixture.runApply(["--targets", "all", "--mcp-scope", "user", "--pretty"]);
      assert.equal(r3.status, 0, `r3 stderr: ${r3.stderr}`);
      assert.deepEqual(
        r3.json.sync.blocked.map((item) => item.path).sort(),
        [
          "~/.claude.json",
          "~/.codex/config.toml",
          "~/.dsh/cordis.patch.yml",
          "~/.gemini/config/mcp_config.json",
        ],
        "手工修改受管 MCP 条目时四端均必须标记为 blocked"
      );
      assert.equal(fixture.readHomeFile(".claude.json"), claudeManualText);
      assert.equal(fixture.readHomeFile(".codex/config.toml"), codexManualText);
      assert.equal(fixture.readHomeFile(".gemini/config/mcp_config.json"), agyManualText);
      assert.equal(fixture.readHomeFile(".dsh/cordis.patch.yml"), dshManualText);

      // 同时验证 project 范围：在 .mcp.json 与 Antigravity 项目插件上修改无关字段 + 上游更新也安全合并
      const p1 = fixture.runApply(["--targets", "claude,antigravity", "--mcp-scope", "project"]);
      assert.equal(p1.status, 0, `p1 stderr: ${p1.stderr}`);
      const projMcp = fixture.readWorkspaceJson(".mcp.json");
      projMcp.customProjectKey = "keep-me";
      fixture.writeWorkspaceFile(".mcp.json", `${JSON.stringify(projMcp, null, 2)}\n`);
      const projAgyPlugin = fixture.readWorkspaceJson(".agents/plugins/y3maker-mcp/plugin.json");
      projAgyPlugin.author = "y3-team";
      fixture.writeWorkspaceFile(
        ".agents/plugins/y3maker-mcp/plugin.json",
        `${JSON.stringify(projAgyPlugin, null, 2)}\n`
      );
      const projAgyMcp = fixture.readWorkspaceJson(".agents/plugins/y3maker-mcp/mcp_config.json");
      projAgyMcp.mcpServers["custom-proj"] = { command: "node", args: ["custom.js"] };
      fixture.writeWorkspaceFile(
        ".agents/plugins/y3maker-mcp/mcp_config.json",
        `${JSON.stringify(projAgyMcp, null, 2)}\n`
      );

      fixture.writeWorkspaceFile(
        ".y3maker/mcp_settings.json",
        `${JSON.stringify(
          {
            mcpServers: {
              "y3-stdio": {
                type: "stdio",
                command: "node",
                args: ["scripts/mcp-v4.js"],
              },
            },
          },
          null,
          2
        )}\n`
      );

      const p2 = fixture.runApply(["--targets", "claude,antigravity", "--mcp-scope", "project"]);
      assert.equal(p2.status, 0, `p2 stderr: ${p2.stderr}`);
      assert.deepEqual(p2.json.sync.blocked, []);
      assert.equal(fixture.readWorkspaceJson(".mcp.json").customProjectKey, "keep-me");
      assert.deepEqual(fixture.readWorkspaceJson(".mcp.json").mcpServers["y3-stdio"].args, [
        "scripts/mcp-v4.js",
      ]);
      assert.equal(
        fixture.readWorkspaceJson(".agents/plugins/y3maker-mcp/plugin.json").author,
        "y3-team"
      );
      assert.deepEqual(
        fixture.readWorkspaceJson(".agents/plugins/y3maker-mcp/mcp_config.json").mcpServers[
          "y3-stdio"
        ].args,
        ["scripts/mcp-v4.js"]
      );
      assert.ok(
        fixture.readWorkspaceJson(".agents/plugins/y3maker-mcp/mcp_config.json").mcpServers[
          "custom-proj"
        ]
      );
      assert.equal(fixture.runVerify().status, 0);
    } finally {
      fixture.cleanup();
    }
  });
});
