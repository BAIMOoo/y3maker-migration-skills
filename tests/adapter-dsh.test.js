const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createFixture, seedMinimalY3Maker } = require("./helpers/fixture");

describe("DSH 宿主适配层（cordis.patch.yml 安全合并与 --patch 提示）", () => {
  it("Slice 1: 启用 dsh 时直接复用 .agents/skills/ 不重复复制资产，且 --mcp-scope skip 不写入任何补丁", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, { withTemplates: "y3maker" });
      const legacyBefore = fixture.snapshotTree(".y3maker");

      // 无 mcp_settings.json 时：仅迁移 Canonical Store，不创建 .dsh 目录，不创建根目录 AGENTS.md/CLAUDE.md
      const applyNoMcp = fixture.runApply(["--targets", "dsh", "--pretty"]);
      assert.equal(applyNoMcp.status, 0, `stderr: ${applyNoMcp.stderr}`);
      assert.deepEqual(applyNoMcp.json.targets, ["dsh"]);
      assert.equal(fixture.existsInWorkspace(".agents/skills/y3-sample/SKILL.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/rules/api-safety.mdc"), true);
      assert.equal(fixture.existsInWorkspace(".dsh"), false, "无 MCP 配置时不应创建 .dsh 目录");
      assert.equal(fixture.existsInHome(".dsh/cordis.patch.yml"), false);
      assert.equal(fixture.existsInWorkspace("AGENTS.md"), false);
      assert.equal(fixture.existsInWorkspace("CLAUDE.md"), false);
      assert.deepEqual(fixture.snapshotTree(".y3maker"), legacyBefore);

      const verifyNoMcp = fixture.runVerify(["--pretty"]);
      assert.equal(verifyNoMcp.status, 0, `output: ${verifyNoMcp.stdout} ${verifyNoMcp.stderr}`);
      assert.equal(verifyNoMcp.json.ok, true);

      // 存在 mcp_settings.json 但显式 --mcp-scope skip 时：零写入，verify 通过
      fixture.writeWorkspaceFile(
        ".y3maker/mcp_settings.json",
        JSON.stringify(
          {
            mcpServers: {
              "y3-tools": { command: "node", args: ["server.js"] },
            },
          },
          null,
          2
        )
      );
      const applySkip = fixture.runApply(["--targets", "dsh", "--mcp-scope", "skip", "--pretty"]);
      assert.equal(applySkip.status, 0, `stderr: ${applySkip.stderr}`);
      assert.equal(applySkip.json.mcp.scope, "skip");
      assert.equal(applySkip.json.mcp.targets.dsh.scope, "skip");
      assert.equal(applySkip.json.mcp.targets.dsh.converted, false);
      assert.deepEqual(applySkip.json.mcp.targets.dsh.skipped, ["mcp_settings.json"]);
      assert.deepEqual(applySkip.json.mcp.targets.dsh.hints, []);
      assert.equal(fixture.existsInWorkspace(".dsh/cordis.patch.yml"), false);
      assert.equal(fixture.existsInHome(".dsh/cordis.patch.yml"), false);

      const verifySkip = fixture.runVerify(["--pretty"]);
      assert.equal(verifySkip.status, 0, `output: ${verifySkip.stdout} ${verifySkip.stderr}`);
      assert.equal(verifySkip.json.ok, true);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 2: --mcp-scope project 将 stdio 与 streamable-http 转换为 .dsh/cordis.patch.yml、清洗 serverName、输出 --patch 提示并通过 verify", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: {
          mcpServers: {
            "local-tool": {
              command: "node",
              args: ["scripts/server.js", "--mode", "dev"],
              env: {
                NODE_ENV: "production",
                "CUSTOM.KEY": "value:with:colon",
              },
              cwd: "C:\\workspace\\tools",
            },
            "remote-api": {
              type: "streamableHttp",
              url: "https://example.com/mcp",
              headers: {
                "X-Api-Key": "secret-token",
                Authorization: "Bearer demo",
              },
            },
            "my-server": {
              type: "http",
              url: "https://exact.example.com/mcp",
            },
            "my server": {
              type: "http",
              url: "https://collision.example.com/mcp",
            },
            "very-long-y3maker-mcp-server-name-over-32-chars": {
              command: "python",
              args: ["-m", "y3_mcp"],
            },
            "disabled-srv": {
              command: "node",
              args: ["off.js"],
              disabled: true,
            },
          },
        },
      });

      // 先执行 dry-run：不落盘，但报告中应包含预览目标与 --patch 提示
      const dryRes = fixture.runApply([
        "--targets",
        "dsh",
        "--mcp-scope",
        "project",
        "--dry-run",
        "--pretty",
      ]);
      assert.equal(dryRes.status, 0, `dry-run stderr: ${dryRes.stderr}`);
      assert.equal(dryRes.json.dryRun, true);
      assert.equal(fixture.existsInWorkspace(".dsh/cordis.patch.yml"), false);
      assert.equal(dryRes.json.mcp.targets.dsh.target, ".dsh/cordis.patch.yml");
      assert.ok(
        dryRes.json.mcp.targets.dsh.hints.some((h) => h.includes("--patch .dsh/cordis.patch.yml")),
        `dry-run mcpReport.hints 应包含 --patch 提示，实际：${JSON.stringify(dryRes.json.mcp.targets.dsh.hints)}`
      );
      assert.ok(
        dryRes.json.mcp.hints.some((h) => h.includes("--patch .dsh/cordis.patch.yml")),
        `dry-run report.mcp.hints 应包含 --patch 提示，实际：${JSON.stringify(dryRes.json.mcp.hints)}`
      );

      // 正式执行 apply
      const applyRes = fixture.runApply(["--targets", "dsh", "--mcp-scope", "project", "--pretty"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);
      assert.equal(applyRes.json.mcp.scope, "project");
      assert.equal(applyRes.json.mcp.targets.dsh.converted, true);
      assert.equal(applyRes.json.mcp.targets.dsh.target, ".dsh/cordis.patch.yml");
      assert.deepEqual(applyRes.json.mcp.targets.dsh.skipped, ["disabled-srv"]);
      assert.deepEqual(applyRes.json.mcp.targets.dsh.servers, [
        "local-tool",
        "my server",
        "my-server",
        "remote-api",
        "very-long-y3maker-mcp-server-name-over-32-chars",
      ]);
      assert.ok(
        applyRes.json.mcp.targets.dsh.hints.some((h) => h.includes("--patch .dsh/cordis.patch.yml")),
        "mcp.targets.dsh.hints 应包含 --patch .dsh/cordis.patch.yml 启动提示"
      );
      assert.ok(
        applyRes.json.mcp.hints.some((h) => h.includes("--patch .dsh/cordis.patch.yml")),
        "mcp.hints 应包含 --patch .dsh/cordis.patch.yml 启动提示"
      );

      // 不应复制 skills 或非 skill 目录到 .dsh/
      assert.equal(fixture.existsInWorkspace(".dsh/skills"), false);
      assert.equal(fixture.existsInWorkspace(".dsh/rules"), false);
      assert.equal(fixture.existsInWorkspace(".dsh/knowledge"), false);
      assert.equal(fixture.existsInWorkspace(".dsh/memory"), false);
      assert.equal(fixture.existsInWorkspace(".dsh/templates"), false);
      assert.equal(fixture.existsInHome(".dsh/cordis.patch.yml"), false);

      // 校验生成的 .dsh/cordis.patch.yml 内容符合 Cordis 补丁序列格式
      assert.equal(fixture.existsInWorkspace(".dsh/cordis.patch.yml"), true);
      const yaml = fixture.readWorkspaceFile(".dsh/cordis.patch.yml");
      assert.match(yaml, /^- insert:\n/);
      assert.equal(yaml.includes("disabled-srv"), false, "已禁用服务不应写入补丁");

      // stdio 服务字段完整
      assert.ok(yaml.includes('- id: "y3maker-mcp-local-tool"'));
      assert.ok(yaml.includes('name: "@deepseek-ai/dsh-mcp-client"'));
      assert.ok(yaml.includes('serverName: "local-tool"'));
      assert.ok(yaml.includes('transport: "stdio"'));
      assert.ok(yaml.includes('command: "node"'));
      assert.ok(yaml.includes('- "scripts/server.js"'));
      assert.ok(yaml.includes('NODE_ENV: "production"'));
      assert.ok(yaml.includes('"CUSTOM.KEY": "value:with:colon"'));
      assert.ok(yaml.includes('cwd: "C:\\\\workspace\\\\tools"'));

      // streamable-http 服务字段完整
      assert.ok(yaml.includes('- id: "y3maker-mcp-remote-api"'));
      assert.ok(yaml.includes('serverName: "remote-api"'));
      assert.ok(yaml.includes('transport: "streamable-http"'));
      assert.ok(yaml.includes('url: "https://example.com/mcp"'));
      assert.ok(yaml.includes('X-Api-Key: "secret-token"'));
      assert.ok(yaml.includes('Authorization: "Bearer demo"'));

      // 精确合法名称保留原名，冲突名称自动去重，超长名称截断至 <= 32 字符且全满足 [A-Za-z0-9_-]{1,32}
      assert.ok(yaml.includes('- id: "y3maker-mcp-my-server"'));
      assert.ok(yaml.includes('serverName: "my-server"'));
      assert.ok(yaml.includes('- id: "y3maker-mcp-my-server-2"'));
      assert.ok(yaml.includes('serverName: "my-server-2"'));
      const serverNameMatches = [...yaml.matchAll(/serverName: "([^"]+)"/g)].map((m) => m[1]);
      assert.equal(serverNameMatches.length, 5);
      assert.equal(new Set(serverNameMatches).size, 5, "所有 serverName 必须互不冲突");
      for (const sName of serverNameMatches) {
        assert.match(sName, /^[A-Za-z0-9_-]{1,32}$/, `非法 serverName: ${sName}`);
      }

      // verify 通过
      const verifyRes = fixture.runVerify(["--pretty"]);
      assert.equal(verifyRes.status, 0, `verify 应通过，output: ${verifyRes.stdout} ${verifyRes.stderr}`);
      assert.equal(verifyRes.json.ok, true);
      assert.deepEqual(verifyRes.json.issues, []);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 3: --mcp-scope user 安全合并已有 ~/.dsh/cordis.patch.yml，保留既有插件与顶层条目，支持幂等复跑与受管条目原位更新", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: {
          mcpServers: {
            "local-tool": {
              command: "node",
              args: ["scripts/v1.js"],
              env: { MODE: "v1" },
            },
            "remote-api": {
              type: "streamableHttp",
              url: "https://api.example.com/mcp",
            },
          },
        },
      });

      const existingUserPatch = [
        "# 用户全局 DSH 补丁",
        "- id: \"agent-default-model\"",
        "  config:",
        "    model: \"deepseek-chat\"",
        "",
        "- insert:",
        "    # 保留 hooks 插件与自定义标签",
        "    - id: \"cmhub-hooks-claude-code\"",
        "      name: \"@deepseek-ai/dsh-hooks-claude-code\"",
        "      config:",
        "        configPath: \"C:\\\\Users\\\\demo\\\\.claude\\\\settings.json\"",
        "        pattern: !!js/regexp /foo/",
        "    # 已有旧受管条目（无引号 id），应按 id 原位更新",
        "    - id: y3maker-mcp-local-tool",
        "      name: \"@deepseek-ai/dsh-mcp-client\"",
        "      config:",
        "        serverName: \"local-tool\"",
        "        transport: \"stdio\"",
        "        command: \"old-node\"",
        "    # 保留后续用户插件",
        "    - id: \"user-custom-plugin\"",
        "      name: \"@acme/dsh-custom\"",
        "",
        "- id: \"tool-bash\"",
        "  disabled: true",
        "",
      ].join("\n");
      fixture.writeHomeFile(".dsh/cordis.patch.yml", existingUserPatch);

      // Run 1: 首次合并应成功更新（不因无历史基线而误报 blocked）
      const first = fixture.runApply(["--targets", "dsh", "--mcp-scope", "user", "--pretty"]);
      assert.equal(first.status, 0, `first stderr: ${first.stderr}`);
      assert.equal(first.json.mcp.scope, "user");
      assert.equal(first.json.mcp.targets.dsh.target, "~/.dsh/cordis.patch.yml");
      assert.equal(first.json.mcp.targets.dsh.converted, true);
      assert.equal(first.json.mcp.targets.dsh.action, "update");
      assert.deepEqual(first.json.mcp.targets.dsh.hints, []);
      assert.deepEqual(first.json.mcp.hints, []);
      assert.equal(first.json.sync.blocked.length, 0);
      assert.equal(fixture.existsInWorkspace(".dsh/cordis.patch.yml"), false);

      const mergedAfterFirst = fixture.readHomeFile(".dsh/cordis.patch.yml");
      // 完整保留注释、顶层兄弟条目与用户插件
      assert.ok(mergedAfterFirst.includes("# 用户全局 DSH 补丁"));
      assert.ok(mergedAfterFirst.includes('- id: "agent-default-model"\n  config:\n    model: "deepseek-chat"'));
      assert.ok(mergedAfterFirst.includes('# 保留 hooks 插件与自定义标签'));
      assert.ok(
        mergedAfterFirst.includes(
          [
            '    - id: "cmhub-hooks-claude-code"',
            '      name: "@deepseek-ai/dsh-hooks-claude-code"',
            "      config:",
            '        configPath: "C:\\\\Users\\\\demo\\\\.claude\\\\settings.json"',
            "        pattern: !!js/regexp /foo/",
          ].join("\n")
        )
      );
      assert.ok(mergedAfterFirst.includes("# 已有旧受管条目（无引号 id），应按 id 原位更新"));
      assert.ok(mergedAfterFirst.includes("# 保留后续用户插件"));
      assert.ok(mergedAfterFirst.includes('    - id: "user-custom-plugin"\n      name: "@acme/dsh-custom"'));
      assert.ok(mergedAfterFirst.includes('- id: "tool-bash"\n  disabled: true'));

      // 只有一个 - insert: 区块，旧受管条目已原位更新且无重复 id，新条目已追加
      assert.equal((mergedAfterFirst.match(/^- insert:/gm) || []).length, 1);
      assert.equal((mergedAfterFirst.match(/y3maker-mcp-local-tool/g) || []).length, 1);
      assert.equal((mergedAfterFirst.match(/y3maker-mcp-remote-api/g) || []).length, 1);
      assert.equal(mergedAfterFirst.includes("old-node"), false);
      assert.ok(mergedAfterFirst.includes('command: "node"'));
      assert.ok(mergedAfterFirst.includes('- "scripts/v1.js"'));
      assert.ok(mergedAfterFirst.includes('url: "https://api.example.com/mcp"'));
      assert.ok(
        mergedAfterFirst.indexOf("y3maker-mcp-local-tool") <
          mergedAfterFirst.indexOf("user-custom-plugin"),
        "已有受管条目应保持原位更新，不打乱原有顺序"
      );

      const verifyFirst = fixture.runVerify(["--pretty"]);
      assert.equal(verifyFirst.status, 0, `verifyFirst output: ${verifyFirst.stdout}`);
      assert.equal(verifyFirst.json.ok, true);

      // Run 2: 无变更重复同步必须完全幂等
      const second = fixture.runApply(["--targets", "dsh", "--mcp-scope", "user", "--pretty"]);
      assert.equal(second.status, 0, `second stderr: ${second.stderr}`);
      assert.equal(second.json.sync.created.length, 0);
      assert.equal(second.json.sync.updated.length, 0);
      assert.equal(second.json.sync.blocked.length, 0);
      assert.equal(second.json.mcp.targets.dsh.action, "unchanged");
      assert.equal(second.json.mcp.targets.dsh.converted, true);
      assert.equal(fixture.readHomeFile(".dsh/cordis.patch.yml"), mergedAfterFirst);

      // Run 3: 更新上游 MCP（修改 local-tool 参数并新增 extra-srv）-> 原位更新 + 追加，仍保留用户条目
      fixture.writeWorkspaceFile(
        ".y3maker/mcp_settings.json",
        JSON.stringify(
          {
            mcpServers: {
              "local-tool": {
                command: "node",
                args: ["scripts/v2.js"],
                env: { MODE: "v2" },
              },
              "remote-api": {
                type: "streamableHttp",
                url: "https://api.example.com/mcp",
              },
              "extra-srv": {
                command: "uvx",
                args: ["y3-helper"],
              },
            },
          },
          null,
          2
        )
      );

      const third = fixture.runApply(["--targets", "dsh", "--mcp-scope", "user", "--pretty"]);
      assert.equal(third.status, 0, `third stderr: ${third.stderr}`);
      assert.deepEqual(third.json.sync.updated, ["~/.dsh/cordis.patch.yml"]);
      assert.equal(third.json.mcp.targets.dsh.action, "update");

      const mergedAfterThird = fixture.readHomeFile(".dsh/cordis.patch.yml");
      assert.equal((mergedAfterThird.match(/y3maker-mcp-local-tool/g) || []).length, 1);
      assert.equal((mergedAfterThird.match(/y3maker-mcp-remote-api/g) || []).length, 1);
      assert.equal((mergedAfterThird.match(/y3maker-mcp-extra-srv/g) || []).length, 1);
      assert.ok(mergedAfterThird.includes('- "scripts/v2.js"'));
      assert.equal(mergedAfterThird.includes("scripts/v1.js"), false);
      assert.ok(mergedAfterThird.includes('command: "uvx"'));
      assert.ok(mergedAfterThird.includes('id: "cmhub-hooks-claude-code"'));
      assert.ok(mergedAfterThird.includes('id: "user-custom-plugin"'));
      assert.ok(mergedAfterThird.includes('- id: "tool-bash"\n  disabled: true'));

      const verifyThird = fixture.runVerify(["--pretty"]);
      assert.equal(verifyThird.status, 0, `verifyThird output: ${verifyThird.stdout}`);
      assert.equal(verifyThird.json.ok, true);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 4: 合并边界场景（无 - insert: 块、- insert: []、2 空格缩进与嵌套 config.id 隔离、非受管新增 adopt 与受管修改 blocked 保护、非序列文件拒绝覆盖）", () => {
    // 4a: 仅有顶层覆写条目、无 - insert: 块、且带文档结束符 ...
    const fixtureA = createFixture();
    try {
      seedMinimalY3Maker(fixtureA, {
        mcpSettings: {
          mcpServers: {
            "local-tool": { command: "node", args: ["a.js"] },
          },
        },
      });
      fixtureA.writeHomeFile(
        ".dsh/cordis.patch.yml",
        ['---', '# 仅禁用某工具', '- id: "tool-bash"', '  disabled: true', '...', ''].join("\n")
      );
      const resA = fixtureA.runApply(["--targets", "dsh", "--mcp-scope", "user"]);
      assert.equal(resA.status, 0, `4a stderr: ${resA.stderr}`);
      const contentA = fixtureA.readHomeFile(".dsh/cordis.patch.yml");
      assert.ok(contentA.includes('- id: "tool-bash"\n  disabled: true'));
      assert.ok(contentA.includes('- insert:\n    - id: "y3maker-mcp-local-tool"'));
      assert.ok(
        contentA.indexOf("y3maker-mcp-local-tool") < contentA.lastIndexOf("..."),
        "新增 - insert: 区块应位于文档结束标记 ... 之前"
      );
      assert.equal(fixtureA.runVerify().status, 0);
    } finally {
      fixtureA.cleanup();
    }

    // 4b: 已有项目级 .dsh/cordis.patch.yml 为 - insert: []，安全填充并保留注释
    const fixtureB = createFixture();
    try {
      seedMinimalY3Maker(fixtureB, {
        mcpSettings: {
          mcpServers: {
            "local-tool": { command: "node", args: ["b.js"] },
          },
        },
      });
      fixtureB.writeWorkspaceFile(
        ".dsh/cordis.patch.yml",
        ["# 项目补丁", "- insert: [] # 初始为空", ""].join("\n")
      );
      const resB = fixtureB.runApply(["--targets", "dsh", "--mcp-scope", "project"]);
      assert.equal(resB.status, 0, `4b stderr: ${resB.stderr}`);
      const contentB = fixtureB.readWorkspaceFile(".dsh/cordis.patch.yml");
      assert.ok(contentB.includes("# 项目补丁"));
      assert.ok(contentB.includes("- insert: # 初始为空"));
      assert.ok(contentB.includes('    - id: "y3maker-mcp-local-tool"'));
      assert.equal(contentB.includes("[]"), false);
      assert.equal(fixtureB.runVerify().status, 0);
    } finally {
      fixtureB.cleanup();
    }

    // 4c: 2 空格缩进 + name 在 id 之前 + 另一插件嵌套 config.id 撞名隔离 + 用户追加插件 adopt + 手改受管条目 blocked 保护
    const fixtureC = createFixture();
    try {
      seedMinimalY3Maker(fixtureC, {
        mcpSettings: {
          mcpServers: {
            "local-tool": { command: "node", args: ["c.js"] },
          },
        },
      });
      fixtureC.writeHomeFile(
        ".dsh/cordis.patch.yml",
        [
          "- insert:",
          '  - id: "unrelated-plugin"',
          '    name: "@acme/unrelated"',
          "    config:",
          '      id: "y3maker-mcp-local-tool"',
          '  - name: "@deepseek-ai/dsh-mcp-client"',
          "    id: 'y3maker-mcp-local-tool'",
          "    config:",
          '      serverName: "local-tool"',
          '      transport: "stdio"',
          '      command: "legacy-node"',
          "",
        ].join("\n")
      );

      const run1 = fixtureC.runApply(["--targets", "dsh", "--mcp-scope", "user"]);
      assert.equal(run1.status, 0, `4c run1 stderr: ${run1.stderr}`);
      const yaml1 = fixtureC.readHomeFile(".dsh/cordis.patch.yml");
      assert.ok(yaml1.includes('  - id: "unrelated-plugin"'), "嵌套 config.id 不应误伤无关插件");
      assert.ok(yaml1.includes('      id: "y3maker-mcp-local-tool"'), "无关插件内的嵌套 config.id 应保留");
      assert.ok(yaml1.includes('  - id: "y3maker-mcp-local-tool"\n    name: "@deepseek-ai/dsh-mcp-client"'), "应沿用 2 空格缩进原位更新");
      assert.equal(yaml1.includes("legacy-node"), false);

      // 用户在不改动受管条目的情况下，自行新增另一个无关插件 -> 下次同步应无损 adopt
      const withExtraUserPlugin =
        yaml1 +
        [
          '  - id: "user-added-later"',
          '    name: "@acme/later"',
          "",
        ].join("\n");
      fixtureC.writeHomeFile(".dsh/cordis.patch.yml", withExtraUserPlugin);

      const run2 = fixtureC.runApply(["--targets", "dsh", "--mcp-scope", "user"]);
      assert.equal(run2.status, 0, `4c run2 stderr: ${run2.stderr}`);
      assert.equal(run2.json.sync.blocked.length, 0);
      assert.ok(run2.json.sync.adopted.includes("~/.dsh/cordis.patch.yml"));
      assert.equal(fixtureC.readHomeFile(".dsh/cordis.patch.yml"), withExtraUserPlugin);

      // 用户手工修改受管条目 command -> 下次同步必须 blocked 保护，禁止静默覆盖
      const tampered = withExtraUserPlugin.replace('command: "node"', 'command: "custom-local-node"');
      fixtureC.writeHomeFile(".dsh/cordis.patch.yml", tampered);

      const run3 = fixtureC.runApply(["--targets", "dsh", "--mcp-scope", "user"]);
      assert.equal(run3.status, 0, `4c run3 stderr: ${run3.stderr}`);
      assert.ok(
        run3.json.sync.blocked.some((item) => item.path === "~/.dsh/cordis.patch.yml"),
        "手工改动受管条目后应标记 blocked"
      );
      assert.equal(run3.json.mcp.targets.dsh.blocked, true);
      assert.equal(run3.json.mcp.targets.dsh.converted, false);
      assert.ok(
        fixtureC.readHomeFile(".dsh/cordis.patch.yml").includes('command: "custom-local-node"'),
        "blocked 时绝不能覆盖用户本地修改"
      );

      const verifyBlocked = fixtureC.runVerify();
      assert.equal(verifyBlocked.status, 1);
      assert.ok(
        verifyBlocked.json.issues.some(
          (i) => i.type === "merge-blocked" && i.path === "~/.dsh/cordis.patch.yml"
        )
      );
    } finally {
      fixtureC.cleanup();
    }

    // 4d: 顶层不是 YAML 序列的损坏/异构文件 -> 报错退出且不破坏原文件
    const fixtureD = createFixture();
    try {
      seedMinimalY3Maker(fixtureD, {
        mcpSettings: {
          mcpServers: {
            "local-tool": { command: "node", args: ["d.js"] },
          },
        },
      });
      const nonSequence = "plugins:\n  foo: bar\n";
      fixtureD.writeHomeFile(".dsh/cordis.patch.yml", nonSequence);
      const resD = fixtureD.runApply(["--targets", "dsh", "--mcp-scope", "user"]);
      assert.notEqual(resD.status, 0, "顶层非序列 YAML 必须报错拒绝覆盖");
      assert.match(resD.stderr, /cordis\.patch\.yml/);
      assert.equal(fixtureD.readHomeFile(".dsh/cordis.patch.yml"), nonSequence);
    } finally {
      fixtureD.cleanup();
    }
  });

  it("Slice 5: 遇到不支持的旧版 SSE（显式 type: sse 与隐式 /sse）时告警跳过不写无效传输；空 mcpServers 或全跳过时告警且不写入空补丁", () => {
    // 5a: 混合有效服务与旧版 SSE
    const fixtureA = createFixture();
    try {
      seedMinimalY3Maker(fixtureA, {
        mcpSettings: {
          mcpServers: {
            "valid-stdio": { command: "node", args: ["ok.js"] },
            "legacy-sse": { type: "sse", url: "https://old.example.com/events" },
            "implicit-sse": { url: "https://old.example.com/sse" },
            "explicit-http": { type: "streamableHttp", url: "https://modern.example.com/mcp" },
          },
        },
      });

      const resA = fixtureA.runApply(["--targets", "dsh", "--mcp-scope", "project", "--pretty"]);
      assert.equal(resA.status, 0, `5a stderr: ${resA.stderr}`);
      assert.equal(resA.json.mcp.targets.dsh.converted, true);
      assert.deepEqual(resA.json.mcp.targets.dsh.servers, ["explicit-http", "valid-stdio"]);
      assert.deepEqual(resA.json.mcp.targets.dsh.skipped, ["implicit-sse", "legacy-sse"]);
      assert.ok(
        resA.json.mcp.targets.dsh.warnings.some((w) => w.includes("legacy-sse") && /SSE/i.test(w)),
        `应对显式 type: sse 发出明确告警，实际：${JSON.stringify(resA.json.mcp.targets.dsh.warnings)}`
      );
      assert.ok(
        resA.json.mcp.targets.dsh.warnings.some((w) => w.includes("implicit-sse") && /SSE/i.test(w)),
        `应对隐式 /sse 端点发出明确告警，实际：${JSON.stringify(resA.json.mcp.targets.dsh.warnings)}`
      );
      assert.ok(resA.json.mcp.warnings.some((w) => w.includes("legacy-sse")));

      const yamlA = fixtureA.readWorkspaceFile(".dsh/cordis.patch.yml");
      assert.equal(yamlA.includes('transport: "sse"'), false, "绝不能写入无效的 transport: sse");
      assert.equal(yamlA.includes("legacy-sse"), false);
      assert.equal(yamlA.includes("implicit-sse"), false);
      assert.ok(yamlA.includes('id: "y3maker-mcp-valid-stdio"'));
      assert.ok(yamlA.includes('id: "y3maker-mcp-explicit-http"'));

      const verifyA = fixtureA.runVerify();
      assert.equal(verifyA.status, 0, `5a verify output: ${verifyA.stdout}`);
      assert.equal(verifyA.json.ok, true);
    } finally {
      fixtureA.cleanup();
    }

    // 5b: 空 mcpServers 对象 -> 告警且不写入空 .dsh/cordis.patch.yml，不输出误导性 --patch 提示
    const fixtureB = createFixture();
    try {
      seedMinimalY3Maker(fixtureB, {
        mcpSettings: { mcpServers: {} },
      });

      const resB = fixtureB.runApply(["--targets", "dsh", "--mcp-scope", "project", "--pretty"]);
      assert.equal(resB.status, 0, `5b stderr: ${resB.stderr}`);
      assert.equal(resB.json.mcp.targets.dsh.empty, true);
      assert.equal(resB.json.mcp.targets.dsh.converted, false);
      assert.deepEqual(resB.json.mcp.targets.dsh.servers, []);
      assert.deepEqual(resB.json.mcp.targets.dsh.hints, []);
      assert.ok(
        resB.json.mcp.targets.dsh.warnings.some((w) => w.includes("mcpServers")),
        `空 mcpServers 应有明确告警，实际：${JSON.stringify(resB.json.mcp.targets.dsh.warnings)}`
      );
      assert.equal(fixtureB.existsInWorkspace(".dsh/cordis.patch.yml"), false, "空 mcpServers 不应生成空补丁文件");

      const verifyB = fixtureB.runVerify();
      assert.equal(verifyB.status, 0, `5b verify output: ${verifyB.stdout}`);
      assert.equal(verifyB.json.ok, true);
    } finally {
      fixtureB.cleanup();
    }

    // 5c: 仅包含旧版 SSE 与 disabled 服务（零可转换服务）-> 告警且不创建/改写用户 ~/.dsh/cordis.patch.yml
    const fixtureC = createFixture();
    try {
      seedMinimalY3Maker(fixtureC, {
        mcpSettings: {
          mcpServers: {
            "only-sse": { type: "sse", url: "https://old.example.com/sse" },
            "off-srv": { command: "node", args: ["off.js"], disabled: true },
          },
        },
      });
      const existingUserPatch = '- id: "tool-bash"\n  disabled: true\n';
      fixtureC.writeHomeFile(".dsh/cordis.patch.yml", existingUserPatch);

      const resC = fixtureC.runApply(["--targets", "dsh", "--mcp-scope", "user", "--pretty"]);
      assert.equal(resC.status, 0, `5c stderr: ${resC.stderr}`);
      assert.equal(resC.json.mcp.targets.dsh.converted, false);
      assert.deepEqual(resC.json.mcp.targets.dsh.servers, []);
      assert.deepEqual(resC.json.mcp.targets.dsh.skipped, ["off-srv", "only-sse"]);
      assert.ok(resC.json.mcp.targets.dsh.warnings.some((w) => w.includes("only-sse") && /SSE/i.test(w)));
      assert.equal(
        fixtureC.readHomeFile(".dsh/cordis.patch.yml"),
        existingUserPatch,
        "无有效可转换服务时不应改写已有 ~/.dsh/cordis.patch.yml"
      );

      const verifyC = fixtureC.runVerify();
      assert.equal(verifyC.status, 0, `5c verify output: ${verifyC.stdout}`);
      assert.equal(verifyC.json.ok, true);
    } finally {
      fixtureC.cleanup();
    }
  });

  it("Slice 6: verify 按 MCP Scope 深入校验 cordis.patch.yml 存在性、YAML 结构、受管 @deepseek-ai/dsh-mcp-client 条目完整度与重复 id 拦截", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: {
          mcpServers: {
            "local-tool": { command: "node", args: ["server.js"] },
            "remote-api": { type: "streamableHttp", url: "https://example.com/mcp" },
          },
        },
      });

      const applyRes = fixture.runApply(["--targets", "dsh", "--mcp-scope", "project"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);
      assert.equal(fixture.runVerify().status, 0);

      // 1) 按 --mcp-scope user 覆盖校验时，因 ~/.dsh/cordis.patch.yml 缺失必须报错 missing-mcp-config
      const verifyUserMissing = fixture.runVerify(["--mcp-scope", "user"]);
      assert.equal(verifyUserMissing.status, 1);
      assert.equal(verifyUserMissing.json.ok, false);
      assert.ok(
        verifyUserMissing.json.issues.some(
          (i) => i.type === "missing-mcp-config" && i.path === "~/.dsh/cordis.patch.yml"
        )
      );

      // 2) 删除项目级 .dsh/cordis.patch.yml -> missing-mcp-config
      fixture.removeWorkspacePath(".dsh/cordis.patch.yml");
      const verifyProjMissing = fixture.runVerify();
      assert.equal(verifyProjMissing.status, 1);
      assert.ok(
        verifyProjMissing.json.issues.some(
          (i) => i.type === "missing-mcp-config" && i.path === ".dsh/cordis.patch.yml"
        )
      );

      // 3) 写入非序列损坏 YAML -> invalid-mcp-config
      fixture.writeWorkspaceFile(".dsh/cordis.patch.yml", "plugins:\n  bad: true\n");
      const verifyBadYaml = fixture.runVerify();
      assert.equal(verifyBadYaml.status, 1);
      assert.ok(
        verifyBadYaml.json.issues.some(
          (i) => i.type === "invalid-mcp-config" && i.path === ".dsh/cordis.patch.yml"
        )
      );

      // 4) 仅包含 local-tool（缺少 remote-api），且 local-tool 被篡改为错误插件名、错误 transport、缺失 command，还包含重复 id
      fixture.writeWorkspaceFile(
        ".dsh/cordis.patch.yml",
        [
          "- insert:",
          '    - id: "y3maker-mcp-local-tool"',
          '      name: "@wrong/plugin"',
          "      config:",
          '        serverName: "wrong-name"',
          '        transport: "sse"',
          '    - id: "y3maker-mcp-local-tool"',
          '      name: "@deepseek-ai/dsh-mcp-client"',
          "      config:",
          '        serverName: "local-tool"',
          '        transport: "stdio"',
          '        command: "node"',
          "",
        ].join("\n")
      );
      const verifyTampered = fixture.runVerify(["--pretty"]);
      assert.equal(verifyTampered.status, 1);
      assert.equal(verifyTampered.json.ok, false);
      const issues = verifyTampered.json.issues;
      assert.ok(
        issues.some(
          (i) => i.type === "missing-mcp-server" && i.detail.includes("y3maker-mcp-remote-api")
        ),
        `应检出缺失受管条目 y3maker-mcp-remote-api，实际：${JSON.stringify(issues)}`
      );
      assert.ok(
        issues.some(
          (i) => i.type === "invalid-mcp-config" && i.detail.includes("@deepseek-ai/dsh-mcp-client")
        ),
        `应检出错误插件名，实际：${JSON.stringify(issues)}`
      );
      assert.ok(
        issues.some((i) => i.type === "invalid-mcp-config" && /transport/i.test(i.detail)),
        `应检出错误 transport，实际：${JSON.stringify(issues)}`
      );
      assert.ok(
        issues.some((i) => i.type === "invalid-mcp-config" && /serverName/i.test(i.detail)),
        `应检出不匹配的 serverName，实际：${JSON.stringify(issues)}`
      );
      assert.ok(
        issues.some((i) => i.type === "invalid-mcp-config" && /command/i.test(i.detail)),
        `应检出缺失 command，实际：${JSON.stringify(issues)}`
      );
      assert.ok(
        issues.some((i) => i.type === "invalid-mcp-config" && /重复/.test(i.detail)),
        `应检出重复受管 id，实际：${JSON.stringify(issues)}`
      );
    } finally {
      fixture.cleanup();
    }
  });
});
