const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createFixture, seedMinimalY3Maker } = require("./helpers/fixture");

describe("sync-y3maker-to-agents Codex 适配层（TOML 安全合并与验收）", () => {
  it("Slice 1: 启用 codex 不向 .codex/ 复制资产树，project 范围生成含 stdio/HTTP/引号表名的 .codex/config.toml 并通过 verify", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        withTemplates: "codemaker",
        mcpSettings: {
          mcpServers: {
            "y3-tools": {
              command: "node",
              args: ["scripts/mcp.js", "--port", 8080],
              cwd: "./tools",
              env: {
                NODE_ENV: "production",
                "custom.key": "val",
                EMPTY_NULL: null,
              },
            },
            "remote.api": {
              type: "streamableHttp",
              url: "https://example.com/mcp",
              headers: {
                Authorization: "Bearer secret-token",
                "X-Api-Key": "k-123",
              },
            },
            "off-server": {
              command: "node",
              args: ["disabled.js"],
              disabled: true,
            },
          },
        },
      });

      const applyRes = fixture.runApply(["--targets", "codex", "--mcp-scope", "project", "--pretty"]);
      assert.equal(applyRes.status, 0, `apply 应退出 0，stderr: ${applyRes.stderr}`);
      assert.ok(applyRes.json, "apply stdout 应为合法 JSON");

      // 共享正本位于 .agents/，绝不向 .codex/ 重复复制资产树
      assert.equal(fixture.existsInWorkspace(".agents/skills/y3-sample/SKILL.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/rules/api-safety.mdc"), true);
      assert.equal(fixture.existsInWorkspace(".agents/knowledge/overview.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/memory/facts.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/templates/legacy-tpl.md"), true);

      assert.equal(fixture.existsInWorkspace(".codex/skills"), false);
      assert.equal(fixture.existsInWorkspace(".codex/rules"), false);
      assert.equal(fixture.existsInWorkspace(".codex/knowledge"), false);
      assert.equal(fixture.existsInWorkspace(".codex/memory"), false);
      assert.equal(fixture.existsInWorkspace(".codex/templates"), false);

      // project 范围只写 .codex/config.toml，不触碰 fake home
      assert.equal(fixture.existsInWorkspace(".codex/config.toml"), true);
      assert.equal(fixture.existsInHome(".codex/config.toml"), false);

      const toml = fixture.readWorkspaceFile(".codex/config.toml");
      assert.equal(toml.includes("\r\n"), false, "生成的 config.toml 应使用 LF 换行");
      assert.ok(toml.includes("[mcp_servers.y3-tools]\n"), "应包含 bare key 表头 [mcp_servers.y3-tools]");
      assert.ok(toml.includes('command = "node"\n'));
      assert.ok(toml.includes('args = ["scripts/mcp.js", "--port", "8080"]\n'));
      assert.ok(toml.includes('cwd = "./tools"\n'));
      assert.ok(toml.includes("[mcp_servers.y3-tools.env]\n"));
      assert.ok(toml.includes('NODE_ENV = "production"\n'));
      assert.ok(toml.includes('"custom.key" = "val"\n'));
      assert.equal(toml.includes("EMPTY_NULL"), false, "null 环境变量不应序列化为无效或字符串 null");

      assert.ok(
        toml.includes('[mcp_servers."remote.api"]\n'),
        "含点号的服务器名必须使用 TOML 引号表名"
      );
      assert.ok(toml.includes('url = "https://example.com/mcp"\n'));
      assert.ok(toml.includes('[mcp_servers."remote.api".http_headers]\n'));
      assert.ok(toml.includes('"Authorization" = "Bearer secret-token"\n'));
      assert.ok(toml.includes('"X-Api-Key" = "k-123"\n'));

      assert.equal(toml.includes("off-server"), false, "disabled: true 的服务器必须跳过");

      // 检查 JSON 报告与 manifest 跟踪
      const codexMcp = applyRes.json.mcp.targets.codex;
      assert.equal(codexMcp.scope, "project");
      assert.equal(codexMcp.target, ".codex/config.toml");
      assert.equal(codexMcp.converted, true);
      assert.equal(codexMcp.action, "create");
      assert.equal(codexMcp.blocked, false);
      assert.deepEqual(codexMcp.servers, ["remote.api", "y3-tools"]);
      assert.deepEqual(codexMcp.skipped, ["off-server"]);
      assert.equal(codexMcp.empty, false);

      assert.ok(applyRes.json.sync.created.includes(".codex/config.toml"));

      const manifest = fixture.readWorkspaceJson(".agents/migration/y3maker-manifest.json");
      const entry = manifest.files[".codex/config.toml"];
      assert.ok(entry, "manifest 应跟踪 .codex/config.toml");
      assert.equal(entry.status, "managed");
      assert.equal(entry.kind, "mcp-config");
      assert.equal(entry.targetScope, "project");
      assert.equal(entry.adapterId, "codex");

      // verify 通过
      const verifyRes = fixture.runVerify(["--pretty"]);
      assert.equal(verifyRes.status, 0, `verify 应通过，output: ${verifyRes.stdout} ${verifyRes.stderr}`);
      assert.equal(verifyRes.json.ok, true);
      assert.deepEqual(verifyRes.json.issues, []);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 2: user 范围安全 TOML 区块合并保留既有 preamble/注释/非受管配置/多行值，原地更新受管服务器且重复执行幂等", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: {
          mcpServers: {
            "y3-tools": {
              command: "node",
              args: ["scripts/new-server.js"],
            },
            "remote.api": {
              type: "http",
              url: "https://api.example.com/mcp",
              headers: {
                "X-Token": "tok-new",
              },
            },
          },
        },
      });

      const existingUserToml = [
        "# 用户全局 Codex 配置",
        'model = "gpt-5.4"',
        'approval_policy = "on-request"',
        'custom_note = """',
        "[not_a_section]",
        '"""',
        "extra_flags = [",
        '  "[also_not_a_section]",',
        '  "--safe"',
        "]",
        "",
        "# 已信任的工程列表",
        '[projects."C:\\\\work\\\\y3"]',
        'trust_level = "trusted"',
        "",
        "# 用户个人 MCP 服务器（非受管，必须原样保留）",
        "[mcp_servers.personal-git]",
        'command = "uvx"',
        'args = ["mcp-server-git"]',
        "",
        "[mcp_servers.personal-git.env]",
        'GIT_TRACE = "1"',
        "",
        "# 旧版受管服务器（应原地更新并清理过时 env 子表）",
        "[mcp_servers.y3-tools]",
        'command = "node"',
        'args = ["scripts/old-server.js"]',
        "",
        "[mcp_servers.y3-tools.env]",
        'OBSOLETE_VAR = "remove-me"',
        "",
        "# 用户插件区块（紧接在旧受管子表之后，必须完整保留注释与表）",
        '[plugins."review@local"]',
        "enabled = true",
        "",
        "[[hooks.pre_tool]]",
        'matcher = "Bash"',
        'command = "echo ok"',
        "",
      ].join("\n");

      fixture.writeHomeFile(".codex/config.toml", existingUserToml);

      // 1) dry-run 预览不修改磁盘
      const dryRes = fixture.runApply(["--targets", "codex", "--mcp-scope", "user", "--dry-run"]);
      assert.equal(dryRes.status, 0, `dry-run stderr: ${dryRes.stderr}`);
      assert.equal(dryRes.json.dryRun, true);
      assert.ok(dryRes.json.sync.updated.includes("~/.codex/config.toml"));
      assert.equal(fixture.readHomeFile(".codex/config.toml"), existingUserToml);

      // 2) 正式 apply：安全合并至 fake home 的 ~/.codex/config.toml
      const applyRes = fixture.runApply(["--targets", "codex", "--mcp-scope", "user", "--pretty"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);
      assert.equal(fixture.existsInWorkspace(".codex/config.toml"), false, "user 范围不应创建项目级 .codex/config.toml");
      assert.ok(applyRes.json.sync.updated.includes("~/.codex/config.toml"));
      assert.equal(applyRes.json.mcp.targets.codex.scope, "user");
      assert.equal(applyRes.json.mcp.targets.codex.target, "~/.codex/config.toml");
      assert.equal(applyRes.json.mcp.targets.codex.converted, true);
      assert.equal(applyRes.json.mcp.targets.codex.action, "update");

      const merged = fixture.readHomeFile(".codex/config.toml");

      // 校验所有非受管配置与注释完整保留
      assert.ok(merged.includes('# 用户全局 Codex 配置\nmodel = "gpt-5.4"\napproval_policy = "on-request"'));
      assert.ok(merged.includes('custom_note = """\n[not_a_section]\n"""'));
      assert.ok(merged.includes('extra_flags = [\n  "[also_not_a_section]",\n  "--safe"\n]'));
      assert.ok(merged.includes('# 已信任的工程列表\n[projects."C:\\\\work\\\\y3"]\ntrust_level = "trusted"'));
      assert.ok(
        merged.includes(
          '# 用户个人 MCP 服务器（非受管，必须原样保留）\n[mcp_servers.personal-git]\ncommand = "uvx"\nargs = ["mcp-server-git"]\n\n[mcp_servers.personal-git.env]\nGIT_TRACE = "1"'
        )
      );
      assert.ok(
        merged.includes(
          '# 用户插件区块（紧接在旧受管子表之后，必须完整保留注释与表）\n[plugins."review@local"]\nenabled = true'
        )
      );
      assert.ok(merged.includes('[[hooks.pre_tool]]\nmatcher = "Bash"\ncommand = "echo ok"'));

      // 校验受管服务器原地更新 + 过时子表清理 + 新受管服务器追加
      assert.ok(merged.includes('# 旧版受管服务器（应原地更新并清理过时 env 子表）\n[mcp_servers.y3-tools]\ncommand = "node"\nargs = ["scripts/new-server.js"]'));
      assert.equal(merged.includes("old-server.js"), false);
      assert.equal(merged.includes("OBSOLETE_VAR"), false);
      assert.equal(merged.includes("[mcp_servers.y3-tools.env]"), false);

      assert.ok(
        merged.includes(
          '[mcp_servers."remote.api"]\nurl = "https://api.example.com/mcp"\n\n[mcp_servers."remote.api".http_headers]\n"X-Token" = "tok-new"'
        )
      );

      // 校验受管更新保持原有相对位置（y3-tools 仍在 personal-git 之后、plugins 之前）
      assert.ok(
        merged.indexOf("[mcp_servers.personal-git]") < merged.indexOf("[mcp_servers.y3-tools]")
      );
      assert.ok(
        merged.indexOf("[mcp_servers.y3-tools]") < merged.indexOf('[plugins."review@local"]')
      );

      // 3) verify 通过
      const verifyRes = fixture.runVerify(["--pretty"]);
      assert.equal(verifyRes.status, 0, `verify 应通过，output: ${verifyRes.stdout}`);
      assert.equal(verifyRes.json.ok, true);

      // 4) 重复执行完全幂等（unchanged，字节级一致）
      const secondRes = fixture.runApply(["--targets", "codex", "--mcp-scope", "user"]);
      assert.equal(secondRes.status, 0, `second apply stderr: ${secondRes.stderr}`);
      assert.deepEqual(secondRes.json.sync.created, []);
      assert.deepEqual(secondRes.json.sync.updated, []);
      assert.deepEqual(secondRes.json.sync.blocked, []);
      assert.equal(secondRes.json.mcp.targets.codex.action, "unchanged");
      assert.equal(secondRes.json.mcp.targets.codex.converted, true);
      assert.equal(fixture.readHomeFile(".codex/config.toml"), merged);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 3: --mcp-scope skip 不触碰全局/项目配置；空 mcpServers 或全禁用服务器输出明确警告且不静默写空或覆盖已有 config.toml", () => {
    // 3a) --mcp-scope skip
    {
      const fixture = createFixture();
      try {
        seedMinimalY3Maker(fixture, {
          mcpSettings: {
            mcpServers: {
              "y3-tools": { command: "node", args: ["server.js"] },
            },
          },
        });
        const userToml = 'model = "gpt-5.4"\n';
        fixture.writeHomeFile(".codex/config.toml", userToml);

        const res = fixture.runApply(["--targets", "codex", "--mcp-scope", "skip"]);
        assert.equal(res.status, 0, `skip apply stderr: ${res.stderr}`);
        assert.equal(fixture.existsInWorkspace(".codex/config.toml"), false);
        assert.equal(fixture.readHomeFile(".codex/config.toml"), userToml);
        assert.equal(res.json.mcp.targets.codex.scope, "skip");
        assert.equal(res.json.mcp.targets.codex.converted, false);
        assert.deepEqual(res.json.mcp.targets.codex.skipped, ["mcp_settings.json"]);

        const verifyRes = fixture.runVerify();
        assert.equal(verifyRes.status, 0, `skip verify 应通过: ${verifyRes.stdout}`);
        assert.equal(verifyRes.json.ok, true);
      } finally {
        fixture.cleanup();
      }
    }

    // 3b) 空 mcpServers：无既有文件时不写空文件；有既有文件时不覆盖
    {
      const fixture = createFixture();
      try {
        seedMinimalY3Maker(fixture, {
          mcpSettings: { mcpServers: {} },
        });

        const freshRes = fixture.runApply(["--targets", "codex", "--mcp-scope", "project"]);
        assert.equal(freshRes.status, 0, `empty mcp apply stderr: ${freshRes.stderr}`);
        assert.equal(
          fixture.existsInWorkspace(".codex/config.toml"),
          false,
          "mcpServers 为空时不应静默写入空 .codex/config.toml"
        );
        assert.equal(freshRes.json.mcp.targets.codex.converted, false);
        assert.equal(freshRes.json.mcp.targets.codex.empty, true);
        assert.ok(
          freshRes.json.mcp.targets.codex.warnings.some((w) => w.includes("mcpServers")),
          `codex mcpReport 应包含明确空对象警告，实际: ${JSON.stringify(freshRes.json.mcp.targets.codex.warnings)}`
        );
        assert.ok(
          freshRes.json.mcp.warnings.some((w) => w.includes("mcpServers")),
          "顶层 mcp.warnings 应包含明确空对象警告"
        );

        const verifyFresh = fixture.runVerify();
        assert.equal(verifyFresh.status, 0, `空 mcpServers 时 verify 应通过: ${verifyFresh.stdout}`);

        // 预先存在既有 .codex/config.toml 时也绝不覆盖清空
        const existingProjectToml = '# 项目既有配置\nmodel = "gpt-5.4"\n';
        fixture.writeWorkspaceFile(".codex/config.toml", existingProjectToml);
        const existingRes = fixture.runApply(["--targets", "codex", "--mcp-scope", "project"]);
        assert.equal(existingRes.status, 0);
        assert.equal(fixture.readWorkspaceFile(".codex/config.toml"), existingProjectToml);
      } finally {
        fixture.cleanup();
      }
    }

    // 3c) 所有服务器均 disabled 或缺少 command/url：输出明确警告且不写空文件
    {
      const fixture = createFixture();
      try {
        seedMinimalY3Maker(fixture, {
          mcpSettings: {
            mcpServers: {
              "off-only": { command: "node", args: ["off.js"], disabled: true },
              "broken-entry": { type: "stdio" },
            },
          },
        });

        const res = fixture.runApply(["--targets", "codex", "--mcp-scope", "project"]);
        assert.equal(res.status, 0, `all-disabled apply stderr: ${res.stderr}`);
        assert.equal(
          fixture.existsInWorkspace(".codex/config.toml"),
          false,
          "无有效可迁移服务器时不应静默写入空 .codex/config.toml"
        );
        assert.equal(res.json.mcp.targets.codex.converted, false);
        assert.equal(res.json.mcp.targets.codex.empty, false);
        assert.deepEqual(res.json.mcp.targets.codex.skipped, ["broken-entry", "off-only"]);
        assert.ok(res.json.mcp.targets.codex.warnings.length > 0, "应输出明确跳过告警");

        const verifyRes = fixture.runVerify();
        assert.equal(verifyRes.status, 0, `无有效服务器时 verify 应通过: ${verifyRes.stdout}`);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it("Slice 4: Manifest 跟踪与冲突保护（上游更新自动同步、非受管编辑 adopt 保留、受管区本地改动 blocked 不覆盖、冲突解决 resolved）", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: {
          mcpServers: {
            "y3-tools": {
              command: "node",
              args: ["scripts/v1.js"],
            },
          },
        },
      });

      // 1) 首次创建
      const first = fixture.runApply(["--targets", "codex", "--mcp-scope", "project"]);
      assert.equal(first.status, 0, `first stderr: ${first.stderr}`);
      assert.ok(first.json.sync.created.includes(".codex/config.toml"));

      // 2) 上游变更 -> 自动更新
      fixture.writeWorkspaceFile(
        ".y3maker/mcp_settings.json",
        JSON.stringify(
          {
            mcpServers: {
              "y3-tools": {
                command: "node",
                args: ["scripts/v2.js"],
              },
            },
          },
          null,
          2
        )
      );
      const second = fixture.runApply(["--targets", "codex", "--mcp-scope", "project"]);
      assert.equal(second.status, 0, `second stderr: ${second.stderr}`);
      assert.ok(second.json.sync.updated.includes(".codex/config.toml"));
      assert.ok(fixture.readWorkspaceFile(".codex/config.toml").includes('args = ["scripts/v2.js"]'));

      // 3) 用户仅新增非受管顶层配置与非受管 MCP 服务器 -> adopt 保留而不误报冲突
      const withUserCustom = [
        'model = "o3"',
        "",
        fixture.readWorkspaceFile(".codex/config.toml").trimEnd(),
        "",
        "[mcp_servers.user-custom]",
        'command = "python"',
        'args = ["my_mcp.py"]',
        "",
      ].join("\n");
      fixture.writeWorkspaceFile(".codex/config.toml", withUserCustom);

      const third = fixture.runApply(["--targets", "codex", "--mcp-scope", "project"]);
      assert.equal(third.status, 0, `third stderr: ${third.stderr}`);
      assert.ok(third.json.sync.adopted.includes(".codex/config.toml"));
      assert.equal(third.json.sync.blocked.length, 0);
      assert.equal(fixture.readWorkspaceFile(".codex/config.toml"), withUserCustom);

      // 4) 用户手动修改受管区块 [mcp_servers.y3-tools] -> 触发 blocked 保护且绝不覆盖
      const locallyEditedManaged = withUserCustom.replace(
        'args = ["scripts/v2.js"]',
        'args = ["scripts/local-override.js"]'
      );
      fixture.writeWorkspaceFile(".codex/config.toml", locallyEditedManaged);

      const fourth = fixture.runApply(["--targets", "codex", "--mcp-scope", "project"]);
      assert.equal(fourth.status, 0, `fourth stderr: ${fourth.stderr}`);
      assert.ok(
        fourth.json.sync.blocked.some((item) => item.path === ".codex/config.toml"),
        "手工改动受管区块必须标记为 blocked"
      );
      assert.equal(fixture.readWorkspaceFile(".codex/config.toml"), locallyEditedManaged);
      assert.equal(fourth.json.mcp.targets.codex.blocked, true);
      assert.equal(fourth.json.mcp.targets.codex.converted, false);

      const manifestBlocked = fixture.readWorkspaceJson(".agents/migration/y3maker-manifest.json");
      assert.equal(manifestBlocked.files[".codex/config.toml"].status, "blocked");

      const verifyBlocked = fixture.runVerify();
      assert.equal(verifyBlocked.status, 1);
      assert.equal(verifyBlocked.json.ok, false);
      assert.ok(
        verifyBlocked.json.issues.some(
          (issue) => issue.type === "merge-blocked" && issue.path === ".codex/config.toml"
        )
      );

      // 5) 手工合并恢复与上游一致 -> 再次 apply 转为 resolved 并恢复 managed
      fixture.writeWorkspaceFile(".codex/config.toml", withUserCustom);
      const fifth = fixture.runApply(["--targets", "codex", "--mcp-scope", "project"]);
      assert.equal(fifth.status, 0, `fifth stderr: ${fifth.stderr}`);
      assert.ok(fifth.json.sync.resolved.includes(".codex/config.toml"));
      assert.equal(fifth.json.mcp.targets.codex.blocked, false);
      assert.equal(fifth.json.mcp.targets.codex.converted, true);
      assert.equal(
        fixture.readWorkspaceJson(".agents/migration/y3maker-manifest.json").files[
          ".codex/config.toml"
        ].status,
        "managed"
      );

      const verifyResolved = fixture.runVerify();
      assert.equal(verifyResolved.status, 0, `resolved verify 应通过: ${verifyResolved.stdout}`);
      assert.equal(verifyResolved.json.ok, true);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 5: verify 按 mcpScope 校验 .codex/config.toml 与 ~/.codex/config.toml 的存在性、TOML 语法合法性与受管 [mcp_servers.*] 区块完整性", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: {
          mcpServers: {
            "y3-tools": {
              command: "node",
              args: ["scripts/mcp.js"],
            },
            "remote.api": {
              type: "http",
              url: "https://example.com/mcp",
              headers: {
                Authorization: "Bearer tok",
              },
            },
          },
        },
      });

      const applyRes = fixture.runApply(["--targets", "codex", "--mcp-scope", "project"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);

      // 1) 删除项目级 .codex/config.toml -> verify 必须报 missing-path
      fixture.removeWorkspacePath(".codex/config.toml");
      const missingProject = fixture.runVerify(["--pretty"]);
      assert.equal(missingProject.status, 1);
      assert.equal(missingProject.json.ok, false);
      assert.ok(
        missingProject.json.issues.some(
          (i) => i.type === "missing-path" && i.path === ".codex/config.toml"
        ),
        `应检出 .codex/config.toml 缺失，实际 issues: ${JSON.stringify(missingProject.json.issues)}`
      );

      // 2) 指定 --mcp-scope user 且 fake home 缺失 ~/.codex/config.toml -> 必须报 missing-path
      const missingUser = fixture.runVerify(["--mcp-scope", "user"]);
      assert.equal(missingUser.status, 1);
      assert.equal(missingUser.json.ok, false);
      assert.ok(
        missingUser.json.issues.some(
          (i) => i.type === "missing-path" && i.path === "~/.codex/config.toml"
        ),
        `应检出 ~/.codex/config.toml 缺失，实际 issues: ${JSON.stringify(missingUser.json.issues)}`
      );

      // 3) 非法 TOML 语法（未闭合表头 / 无等号裸行 / 重复表头 / 空值 / 非法裸词值）-> 必须报 invalid-mcp-config
      const badTomlCases = [
        "[mcp_servers.y3-tools\ncommand = \"node\"\n",
        "[mcp_servers.y3-tools]\nbroken_line_without_equals\n",
        '[mcp_servers.y3-tools]\ncommand = "node"\n\n[mcp_servers.y3-tools]\ncommand = "python"\n',
        "[mcp_servers.y3-tools]\ncommand =   # empty value\n",
        'model = unquoted_bad\n[mcp_servers.y3-tools]\ncommand = "node"\n\n[mcp_servers."remote.api"]\nurl = "https://example.com/mcp"\n',
      ];
      for (const badToml of badTomlCases) {
        fixture.writeWorkspaceFile(".codex/config.toml", badToml);
        const badVerify = fixture.runVerify();
        assert.equal(badVerify.status, 1, `非法 TOML 必须失败: ${badToml}`);
        assert.equal(badVerify.json.ok, false);
        assert.ok(
          badVerify.json.issues.some(
            (i) => i.type === "invalid-mcp-config" && i.path === ".codex/config.toml"
          ),
          `非法 TOML 应报 invalid-mcp-config，实际: ${JSON.stringify(badVerify.json.issues)}`
        );
      }

      // 4) 合法 TOML 但缺少必需受管区块与 command 字段 -> 必须报 invalid-mcp-config
      fixture.writeWorkspaceFile(
        ".codex/config.toml",
        ['model = "gpt-5.4"', "", "[mcp_servers.y3-tools]", 'args = ["scripts/mcp.js"]', ""].join(
          "\n"
        )
      );
      const incompleteVerify = fixture.runVerify();
      assert.equal(incompleteVerify.status, 1);
      assert.equal(incompleteVerify.json.ok, false);
      assert.ok(
        incompleteVerify.json.issues.some(
          (i) =>
            i.type === "invalid-mcp-config" &&
            i.path === ".codex/config.toml" &&
            i.detail.includes("y3-tools") &&
            i.detail.includes("command")
        ),
        `应检出 y3-tools 缺少 command，实际: ${JSON.stringify(incompleteVerify.json.issues)}`
      );
      assert.ok(
        incompleteVerify.json.issues.some(
          (i) =>
            i.type === "invalid-mcp-config" &&
            i.path === ".codex/config.toml" &&
            i.detail.includes("remote.api")
        ),
        `应检出缺少 remote.api 区块，实际: ${JSON.stringify(incompleteVerify.json.issues)}`
      );

      // 5) 合法等价引号写法（单引号/双引号表头）应通过 verify
      fixture.writeWorkspaceFile(
        ".codex/config.toml",
        [
          '[mcp_servers."y3-tools"]',
          'command = "node"',
          'args = ["scripts/mcp.js"]',
          "",
          "[mcp_servers.'remote.api']",
          'url = "https://example.com/mcp"',
          "",
          "[mcp_servers.'remote.api'.http_headers]",
          '"Authorization" = "Bearer tok"',
          "",
        ].join("\n")
      );
      const equivalentVerify = fixture.runVerify();
      assert.equal(
        equivalentVerify.status,
        0,
        `等价 TOML 引号写法应通过 verify，实际: ${equivalentVerify.stdout}`
      );
      assert.equal(equivalentVerify.json.ok, true);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 5b: 不破坏遗留 .codex/skills 与 .codex/rules 历史目录，且遇损坏 TOML 时 apply 拒绝覆盖并清晰报错", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: {
          mcpServers: {
            "y3-tools": { command: "node", args: ["server.js"] },
          },
        },
      });

      // 预置旧版迁移遗留的 .codex/skills 与 .codex/rules 以及合法 .codex/config.toml
      const legacyCodexSkill = "---\nname: old-skill\ndescription: 旧技能\n---\n\n保留历史。\n";
      const legacyCodexRule = "# 旧规则文件\n";
      fixture.writeWorkspaceFile(".codex/skills/old-skill/SKILL.md", legacyCodexSkill);
      fixture.writeWorkspaceFile(".codex/rules/legacy.mdc", legacyCodexRule);

      const applyRes = fixture.runApply(["--targets", "codex", "--mcp-scope", "project"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);

      // 旧版 .codex/skills 与 .codex/rules 未被删除或修改，且未向 .codex/ 复制新技能 y3-sample
      assert.equal(fixture.readWorkspaceFile(".codex/skills/old-skill/SKILL.md"), legacyCodexSkill);
      assert.equal(fixture.readWorkspaceFile(".codex/rules/legacy.mdc"), legacyCodexRule);
      assert.equal(fixture.existsInWorkspace(".codex/skills/y3-sample"), false);
      assert.equal(fixture.existsInWorkspace(".codex/knowledge"), false);
      assert.equal(fixture.existsInWorkspace(".codex/memory"), false);

      // 预置历史 .codex/ 目录不影响新版 .agents/ verify 通过
      const verifyRes = fixture.runVerify();
      assert.equal(verifyRes.status, 0, `含历史 .codex/ 时 verify 应通过: ${verifyRes.stdout}`);
      assert.equal(verifyRes.json.ok, true);

      // 当已有 .codex/config.toml 语法损坏时，apply 拒绝破坏性覆盖并返回非 0
      const brokenToml = "[mcp_servers.y3-tools\ncommand = 'node'\n";
      fixture.writeWorkspaceFile(".codex/config.toml", brokenToml);
      const brokenApply = fixture.runApply(["--targets", "codex", "--mcp-scope", "project"]);
      assert.notEqual(brokenApply.status, 0, "损坏 TOML 时 apply 应报错退出");
      assert.match(brokenApply.stderr, /TOML/);
      assert.equal(fixture.readWorkspaceFile(".codex/config.toml"), brokenToml);
    } finally {
      fixture.cleanup();
    }
  });
});
