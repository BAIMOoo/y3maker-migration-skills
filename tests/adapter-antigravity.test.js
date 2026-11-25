const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");

const { createFixture, seedMinimalY3Maker } = require("./helpers/fixture");

function findAgyBinary() {
  const probe = spawnSync("agy", ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
  });
  return probe.status === 0;
}

describe("Antigravity（agy）宿主适配层", () => {
  it("Slice 1: 识别 antigravity/agy、不重复复制资产，--mcp-scope project 生成符合 agy strict 规范的插件目录并保留既有非受管服务", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        withTemplates: "y3maker",
        mcpSettings: {
          mcpServers: {
            "y3-stdio": {
              type: "stdio",
              command: "node",
              args: ["scripts/mcp-server.js", "--port", "3000"],
              env: { NODE_ENV: "production", Y3_DEBUG: "1" },
            },
            "y3-http": {
              type: "streamableHttp",
              url: "https://mcp.example.com/mcp",
              headers: {
                Authorization: "Bearer token-123",
                "X-Tenant": "y3",
              },
            },
            "y3-disabled": {
              command: "python",
              args: ["off.py"],
              disabled: true,
            },
          },
        },
      });

      // 预先存在一个非受管服务器，验证 project 插件首次合并不会覆盖用户既有条目
      fixture.writeWorkspaceFile(
        ".agents/plugins/y3maker-mcp/mcp_config.json",
        `${JSON.stringify(
          {
            mcpServers: {
              "custom-local": {
                command: "node",
                args: ["custom-mcp.js"],
              },
            },
          },
          null,
          2
        )}\n`
      );

      // 1) dry-run 使用别名 agy，不落盘写入
      const dryRes = fixture.runApply([
        "--targets",
        "agy",
        "--mcp-scope",
        "project",
        "--dry-run",
        "--pretty",
      ]);
      assert.equal(dryRes.status, 0, `dry-run stderr: ${dryRes.stderr}`);
      assert.deepEqual(dryRes.json.targets, ["antigravity"]);
      assert.equal(dryRes.json.mcp.targets.antigravity.scope, "project");
      assert.equal(dryRes.json.mcp.targets.antigravity.converted, true);
      assert.deepEqual(dryRes.json.mcp.targets.antigravity.servers, ["y3-http", "y3-stdio"]);
      assert.deepEqual(dryRes.json.mcp.targets.antigravity.skipped, ["y3-disabled"]);
      assert.equal(
        fixture.existsInWorkspace(".agents/plugins/y3maker-mcp/plugin.json"),
        false,
        "dry-run 不应写入 plugin.json"
      );
      assert.equal(
        fixture.readWorkspaceJson(".agents/plugins/y3maker-mcp/mcp_config.json").mcpServers["y3-stdio"],
        undefined,
        "dry-run 不应修改已有 mcp_config.json"
      );

      // 2) 正式执行 apply（使用别名 agy）
      const applyRes = fixture.runApply(["--targets", "agy", "--mcp-scope", "project", "--pretty"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);
      assert.deepEqual(applyRes.json.targets, ["antigravity"]);

      const agyReport = applyRes.json.mcp.targets.antigravity;
      assert.equal(agyReport.scope, "project");
      assert.equal(agyReport.converted, true);
      assert.equal(agyReport.target, ".agents/plugins/y3maker-mcp/mcp_config.json");
      assert.deepEqual(agyReport.servers, ["y3-http", "y3-stdio"]);
      assert.deepEqual(agyReport.skipped, ["y3-disabled"]);

      // 不重复复制 skills 或非 skill 目录，也不触碰根目录 AGENTS.md / CLAUDE.md
      assert.equal(fixture.existsInWorkspace(".agents/skills/y3-sample/SKILL.md"), true);
      assert.equal(fixture.existsInWorkspace(".agents/plugins/y3maker-mcp/skills"), false);
      assert.equal(fixture.existsInWorkspace(".agents/plugins/y3maker-mcp/rules"), false);
      assert.equal(fixture.existsInWorkspace(".claude"), false);
      assert.equal(fixture.existsInWorkspace(".codex"), false);
      assert.equal(fixture.existsInWorkspace("AGENTS.md"), false);
      assert.equal(fixture.existsInWorkspace("CLAUDE.md"), false);

      // 校验 plugin.json 含 name 与 version
      const pluginJson = fixture.readWorkspaceJson(".agents/plugins/y3maker-mcp/plugin.json");
      assert.equal(pluginJson.name, "y3maker-mcp");
      assert.equal(typeof pluginJson.version, "string");
      assert.ok(pluginJson.version.length > 0, "plugin.json 必须包含非空 version 字段");

      // 校验 mcp_config.json：保留已有非受管条目，转换 stdio + Streamable HTTP，绝不含 type 字段
      const mcpConfig = fixture.readWorkspaceJson(".agents/plugins/y3maker-mcp/mcp_config.json");
      assert.deepEqual(mcpConfig.mcpServers["custom-local"], {
        command: "node",
        args: ["custom-mcp.js"],
      });
      assert.deepEqual(mcpConfig.mcpServers["y3-stdio"], {
        command: "node",
        args: ["scripts/mcp-server.js", "--port", "3000"],
        env: { NODE_ENV: "production", Y3_DEBUG: "1" },
      });
      assert.deepEqual(mcpConfig.mcpServers["y3-http"], {
        url: "https://mcp.example.com/mcp",
        headers: {
          Authorization: "Bearer token-123",
          "X-Tenant": "y3",
        },
      });
      assert.equal(mcpConfig.mcpServers["y3-disabled"], undefined);
      for (const [name, cfg] of Object.entries(mcpConfig.mcpServers)) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(cfg, "type"),
          false,
          `Antigravity MCP 服务器 "${name}" 不得包含 type 字段`
        );
      }

      // 校验 manifest 统一记录规范化后的 antigravity 目标与插件文件基线
      const manifest = fixture.readWorkspaceJson(".agents/migration/y3maker-manifest.json");
      assert.deepEqual(manifest.targets, ["antigravity"]);
      assert.equal(manifest.files[".agents/plugins/y3maker-mcp/plugin.json"].status, "managed");
      assert.equal(manifest.files[".agents/plugins/y3maker-mcp/mcp_config.json"].status, "managed");

      // 3) 幂等重跑：无任何新增或更新
      const rerun = fixture.runApply(["--targets", "antigravity", "--mcp-scope", "project"]);
      assert.equal(rerun.status, 0, `rerun stderr: ${rerun.stderr}`);
      assert.equal(rerun.json.sync.created.length, 0);
      assert.equal(rerun.json.sync.updated.length, 0);
      assert.equal(rerun.json.sync.blocked.length, 0);

      // 4) 若本机安装了 agy CLI，实测 agy plugin validate --strict --json 必须通过
      if (findAgyBinary()) {
        const validateRes = spawnSync(
          "agy",
          [
            "plugin",
            "validate",
            fixture.workspacePath(".agents/plugins/y3maker-mcp"),
            "--strict",
            "--json",
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            shell: process.platform === "win32",
          }
        );
        assert.equal(
          validateRes.status,
          0,
          `agy plugin validate --strict 必须退出 0，stdout: ${validateRes.stdout}, stderr: ${validateRes.stderr}`
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 2: --mcp-scope user 安全合并至 ~/.gemini/config/mcp_config.json（保留既有配置并支持冲突保护），--mcp-scope skip 零写入", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: {
          mcpServers: {
            "y3-tools": {
              type: "stdio",
              command: "node",
              args: ["tools-v1.js"],
              env: { MODE: "dev" },
            },
            "y3-remote": {
              type: "http",
              url: "https://remote.example.com/mcp",
            },
          },
        },
      });

      // 在隔离 Fake Home 预置既有全局配置（含其他顶层字段与用户既有 MCP 服务）
      const initialUserConfig = {
        extraSetting: { keep: true },
        mcpServers: {
          "user-personal-mcp": {
            command: "node",
            args: ["personal.js"],
          },
        },
      };
      fixture.writeHomeFile(
        ".gemini/config/mcp_config.json",
        `${JSON.stringify(initialUserConfig, null, 2)}\n`
      );

      // 1) --mcp-scope skip 不应写入项目插件或修改用户全局配置
      const skipRes = fixture.runApply(["--targets", "antigravity", "--mcp-scope", "skip"]);
      assert.equal(skipRes.status, 0, `skip stderr: ${skipRes.stderr}`);
      assert.equal(skipRes.json.mcp.targets.antigravity.scope, "skip");
      assert.equal(skipRes.json.mcp.targets.antigravity.converted, false);
      assert.equal(skipRes.json.mcp.targets.antigravity.target, null);
      assert.deepEqual(skipRes.json.mcp.targets.antigravity.skipped, ["mcp_settings.json"]);
      assert.equal(fixture.existsInWorkspace(".agents/plugins/y3maker-mcp"), false);
      assert.deepEqual(fixture.readHomeJson(".gemini/config/mcp_config.json"), initialUserConfig);

      // 2) --mcp-scope user --dry-run 预览合并但不落盘
      const dryUser = fixture.runApply([
        "--targets",
        "antigravity",
        "--mcp-scope",
        "user",
        "--dry-run",
      ]);
      assert.equal(dryUser.status, 0, `dry-run user stderr: ${dryUser.stderr}`);
      assert.equal(dryUser.json.mcp.targets.antigravity.scope, "user");
      assert.equal(dryUser.json.mcp.targets.antigravity.converted, true);
      assert.equal(dryUser.json.mcp.targets.antigravity.target, "~/.gemini/config/mcp_config.json");
      assert.deepEqual(fixture.readHomeJson(".gemini/config/mcp_config.json"), initialUserConfig);

      // 3) 正式 --mcp-scope user 安全合并
      const userRes = fixture.runApply(["--targets", "antigravity", "--mcp-scope", "user"]);
      assert.equal(userRes.status, 0, `user apply stderr: ${userRes.stderr}`);
      assert.equal(userRes.json.mcp.targets.antigravity.converted, true);
      assert.equal(userRes.json.mcp.targets.antigravity.target, "~/.gemini/config/mcp_config.json");
      assert.deepEqual(userRes.json.mcp.targets.antigravity.servers, ["y3-remote", "y3-tools"]);
      assert.equal(fixture.existsInWorkspace(".agents/plugins/y3maker-mcp"), false);

      const mergedUser = fixture.readHomeJson(".gemini/config/mcp_config.json");
      assert.deepEqual(mergedUser.extraSetting, { keep: true });
      assert.deepEqual(mergedUser.mcpServers["user-personal-mcp"], {
        command: "node",
        args: ["personal.js"],
      });
      assert.deepEqual(mergedUser.mcpServers["y3-tools"], {
        command: "node",
        args: ["tools-v1.js"],
        env: { MODE: "dev" },
      });
      assert.deepEqual(mergedUser.mcpServers["y3-remote"], {
        url: "https://remote.example.com/mcp",
      });
      assert.equal(
        Object.prototype.hasOwnProperty.call(mergedUser.mcpServers["y3-tools"], "type"),
        false
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(mergedUser.mcpServers["y3-remote"], "type"),
        false
      );

      // 4) 幂等重跑 -> unchanged
      const idempotent = fixture.runApply(["--targets", "antigravity", "--mcp-scope", "user"]);
      assert.equal(idempotent.status, 0);
      assert.equal(idempotent.json.sync.updated.length, 0);
      assert.equal(idempotent.json.sync.blocked.length, 0);

      // 5) 仅源更新 -> 自动更新，继续保留用户既有配置
      fixture.writeWorkspaceFile(
        ".y3maker/mcp_settings.json",
        `${JSON.stringify(
          {
            mcpServers: {
              "y3-tools": {
                type: "stdio",
                command: "node",
                args: ["tools-v2.js"],
              },
              "y3-remote": {
                type: "http",
                url: "https://remote.example.com/mcp",
              },
            },
          },
          null,
          2
        )}\n`
      );
      const updatedRes = fixture.runApply(["--targets", "antigravity", "--mcp-scope", "user"]);
      assert.equal(updatedRes.status, 0);
      assert.ok(updatedRes.json.sync.updated.includes("~/.gemini/config/mcp_config.json"));
      const afterUpdate = fixture.readHomeJson(".gemini/config/mcp_config.json");
      assert.deepEqual(afterUpdate.mcpServers["user-personal-mcp"], {
        command: "node",
        args: ["personal.js"],
      });
      assert.deepEqual(afterUpdate.mcpServers["y3-tools"], {
        command: "node",
        args: ["tools-v2.js"],
      });

      // 6) 用户手工修改受管条目 -> 触发 blocked 保护不覆盖
      const tampered = {
        ...afterUpdate,
        mcpServers: {
          ...afterUpdate.mcpServers,
          "y3-tools": {
            command: "node",
            args: ["local-manual-override.js"],
          },
        },
      };
      fixture.writeHomeFile(
        ".gemini/config/mcp_config.json",
        `${JSON.stringify(tampered, null, 2)}\n`
      );
      const blockedRes = fixture.runApply(["--targets", "antigravity", "--mcp-scope", "user"]);
      assert.equal(blockedRes.status, 0);
      assert.ok(
        blockedRes.json.sync.blocked.some((b) => b.path === "~/.gemini/config/mcp_config.json")
      );
      assert.equal(blockedRes.json.mcp.targets.antigravity.blocked, true);
      assert.equal(blockedRes.json.mcp.targets.antigravity.converted, false);
      assert.deepEqual(
        fixture.readHomeJson(".gemini/config/mcp_config.json").mcpServers["y3-tools"].args,
        ["local-manual-override.js"]
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 3: 混合 stdio + Streamable HTTP + 旧版 HTTP+SSE 时跳过 SSE（含大小写与 /sse 路径启发式）并输出含 mcp-remote 提示的告警", () => {
    const fixture = createFixture();
    try {
      seedMinimalY3Maker(fixture, {
        mcpSettings: {
          mcpServers: {
            "y3-stdio": {
              command: "node",
              args: ["server.js"],
            },
            "mcp-remote-bridge": {
              type: "stdio",
              command: "npx",
              args: ["-y", "mcp-remote", "https://old.example.com/sse"],
              url: "https://old.example.com/sse",
            },
            "assets-http": {
              url: "https://modern.example.com/assets/mcp",
            },
            "explicit-http-with-sse-path": {
              type: "streamableHttp",
              url: "https://modern.example.com/sse",
            },
            "legacy-sse-explicit": {
              type: "sse",
              url: "https://old.example.com/events",
            },
            "legacy-sse-upper": {
              type: "SSE",
              url: "https://old2.example.com/stream",
            },
            "legacy-sse-path": {
              url: "https://old3.example.com/api/sse?token=abc",
            },
          },
        },
      });

      const res = fixture.runApply(["--targets", "antigravity", "--mcp-scope", "project"]);
      assert.equal(res.status, 0, `apply stderr: ${res.stderr}`);

      const agy = res.json.mcp.targets.antigravity;
      assert.equal(agy.converted, true);
      assert.deepEqual(agy.servers, [
        "assets-http",
        "explicit-http-with-sse-path",
        "mcp-remote-bridge",
        "y3-stdio",
      ]);
      assert.deepEqual(agy.skipped, [
        "legacy-sse-explicit",
        "legacy-sse-path",
        "legacy-sse-upper",
      ]);

      // 每个被跳过的 SSE 服务均应有明确告警，且提示 Streamable HTTP /mcp 或 mcp-remote 桥接
      for (const skippedName of ["legacy-sse-explicit", "legacy-sse-upper", "legacy-sse-path"]) {
        const matched = agy.warnings.find((w) => w.includes(skippedName));
        assert.ok(matched, `应为旧版 SSE 服务器 ${skippedName} 输出明确告警，实际: ${JSON.stringify(agy.warnings)}`);
        assert.match(matched, /SSE/i);
        assert.match(matched, /\/mcp|Streamable HTTP/i);
        assert.match(matched, /mcp-remote/);
        assert.ok(res.json.mcp.warnings.includes(matched), "顶层 mcp.warnings 应同步汇总告警");
      }

      const mcpConfig = fixture.readWorkspaceJson(".agents/plugins/y3maker-mcp/mcp_config.json");
      assert.deepEqual(Object.keys(mcpConfig.mcpServers).sort(), [
        "assets-http",
        "explicit-http-with-sse-path",
        "mcp-remote-bridge",
        "y3-stdio",
      ]);
      assert.deepEqual(mcpConfig.mcpServers["mcp-remote-bridge"], {
        command: "npx",
        args: ["-y", "mcp-remote", "https://old.example.com/sse"],
      });
      assert.equal(mcpConfig.mcpServers["legacy-sse-explicit"], undefined);
      assert.equal(mcpConfig.mcpServers["legacy-sse-upper"], undefined);
      assert.equal(mcpConfig.mcpServers["legacy-sse-path"], undefined);
    } finally {
      fixture.cleanup();
    }
  });

  it("Slice 4: 跳过不兼容/已禁用项后无有效服务或 mcpServers 为空时，不生成空插件或写入全局文件，并清晰报告跳过原因与告警", () => {
    // 子场景 A：仅含旧版 SSE 与 disabled 服务（project 范围）
    const fixtureSseOnly = createFixture();
    try {
      seedMinimalY3Maker(fixtureSseOnly, {
        mcpSettings: {
          mcpServers: {
            "only-sse": {
              type: "sse",
              url: "https://legacy.example.com/sse",
            },
            "off-srv": {
              command: "node",
              args: ["off.js"],
              disabled: true,
            },
          },
        },
      });

      const res = fixtureSseOnly.runApply(["--targets", "antigravity", "--mcp-scope", "project"]);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);

      const agy = res.json.mcp.targets.antigravity;
      assert.equal(agy.converted, false);
      assert.equal(agy.target, null);
      assert.deepEqual(agy.servers, []);
      assert.deepEqual(agy.skipped, ["off-srv", "only-sse"]);
      assert.equal(typeof agy.skippedReason, "string");
      assert.ok(agy.skippedReason.length > 0, "必须明确报告 skippedReason");
      assert.ok(
        agy.warnings.some((w) => w.includes("only-sse") && w.includes("mcp-remote")),
        `应包含 SSE 跳过与 mcp-remote 告警，实际: ${JSON.stringify(agy.warnings)}`
      );
      assert.ok(
        agy.warnings.some((w) => /无可写入|没有可写入|未生成/.test(w)),
        `应明确提示无有效服务可写，实际: ${JSON.stringify(agy.warnings)}`
      );
      assert.equal(
        fixtureSseOnly.existsInWorkspace(".agents/plugins/y3maker-mcp"),
        false,
        "无有效服务时不应创建空插件目录"
      );
    } finally {
      fixtureSseOnly.cleanup();
    }

    // 子场景 B：空 mcpServers 对象（user 范围）
    const fixtureEmpty = createFixture();
    try {
      seedMinimalY3Maker(fixtureEmpty, {
        mcpSettings: { mcpServers: {} },
      });

      const res = fixtureEmpty.runApply(["--targets", "antigravity", "--mcp-scope", "user"]);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);

      const agy = res.json.mcp.targets.antigravity;
      assert.equal(agy.converted, false);
      assert.equal(agy.empty, true);
      assert.equal(agy.target, null);
      assert.deepEqual(agy.servers, []);
      assert.equal(typeof agy.skippedReason, "string");
      assert.ok(agy.skippedReason.length > 0, "空 mcpServers 应提供明确的 skippedReason");
      assert.ok(agy.warnings.length > 0, "空 mcpServers 应输出告警");
      assert.equal(
        fixtureEmpty.existsInHome(".gemini/config/mcp_config.json"),
        false,
        "空 mcpServers 时不应写入 ~/.gemini/config/mcp_config.json"
      );
    } finally {
      fixtureEmpty.cleanup();
    }

    // 子场景 C：仅包含 disabled 服务器（project 范围）
    const fixtureDisabledOnly = createFixture();
    try {
      seedMinimalY3Maker(fixtureDisabledOnly, {
        mcpSettings: {
          mcpServers: {
            "disabled-only": {
              command: "node",
              args: ["off.js"],
              disabled: true,
            },
          },
        },
      });

      const res = fixtureDisabledOnly.runApply([
        "--targets",
        "antigravity",
        "--mcp-scope",
        "project",
      ]);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);

      const agy = res.json.mcp.targets.antigravity;
      assert.equal(agy.converted, false);
      assert.equal(agy.target, null);
      assert.deepEqual(agy.skipped, ["disabled-only"]);
      assert.equal(typeof agy.skippedReason, "string");
      assert.ok(agy.skippedReason.length > 0);
      assert.ok(agy.warnings.some((w) => /没有可写入|未生成/.test(w)));
      assert.equal(fixtureDisabledOnly.existsInWorkspace(".agents/plugins/y3maker-mcp"), false);
    } finally {
      fixtureDisabledOnly.cleanup();
    }
  });

  it("Slice 5: verify 按 MCP Scope 端到端校验项目插件与全局配置（含通过路径、全跳过豁免及各类损坏阻断）", () => {
    // 1) project 范围：正常通过 + 各类损坏阻断
    const projectFixture = createFixture();
    try {
      seedMinimalY3Maker(projectFixture, {
        mcpSettings: {
          mcpServers: {
            "y3-stdio": { command: "node", args: ["server.js"] },
            "y3-http": { type: "streamableHttp", url: "https://mcp.example.com/mcp" },
            "y3-sse": { type: "sse", url: "https://mcp.example.com/sse" },
          },
        },
      });

      const applyRes = projectFixture.runApply(["--targets", "agy", "--mcp-scope", "project"]);
      assert.equal(applyRes.status, 0, `apply stderr: ${applyRes.stderr}`);

      // 1a) 正常验收通过
      const okVerify = projectFixture.runVerify(["--pretty"]);
      assert.equal(okVerify.status, 0, `verify 应通过，output: ${okVerify.stdout}`);
      assert.equal(okVerify.json.ok, true);
      assert.deepEqual(okVerify.json.targets, ["antigravity"]);
      assert.deepEqual(okVerify.json.issues, []);

      // 1b) plugin.json 缺少 version 与 name
      projectFixture.writeWorkspaceFile(
        ".agents/plugins/y3maker-mcp/plugin.json",
        `${JSON.stringify({ name: "" }, null, 2)}\n`
      );
      const badPluginMeta = projectFixture.runVerify();
      assert.equal(badPluginMeta.status, 1);
      assert.equal(badPluginMeta.json.ok, false);
      assert.ok(
        badPluginMeta.json.issues.some(
          (i) =>
            i.type === "invalid-mcp-config" &&
            i.path === ".agents/plugins/y3maker-mcp/plugin.json" &&
            /name/.test(i.detail)
        ),
        `应检出缺少 name，issues: ${JSON.stringify(badPluginMeta.json.issues)}`
      );
      assert.ok(
        badPluginMeta.json.issues.some(
          (i) =>
            i.type === "invalid-mcp-config" &&
            i.path === ".agents/plugins/y3maker-mcp/plugin.json" &&
            /version/.test(i.detail)
        ),
        `应检出缺少 version，issues: ${JSON.stringify(badPluginMeta.json.issues)}`
      );

      // 1c) plugin.json 语法损坏
      projectFixture.writeWorkspaceFile(".agents/plugins/y3maker-mcp/plugin.json", "{ broken");
      const brokenPluginJson = projectFixture.runVerify();
      assert.equal(brokenPluginJson.status, 1);
      assert.ok(
        brokenPluginJson.json.issues.some(
          (i) =>
            i.type === "invalid-mcp-config" &&
            i.path === ".agents/plugins/y3maker-mcp/plugin.json"
        )
      );

      // 1d) 删除 plugin.json -> missing-path
      projectFixture.removeWorkspacePath(".agents/plugins/y3maker-mcp/plugin.json");
      const missingPlugin = projectFixture.runVerify();
      assert.equal(missingPlugin.status, 1);
      assert.ok(
        missingPlugin.json.issues.some(
          (i) =>
            i.type === "missing-path" && i.path === ".agents/plugins/y3maker-mcp/plugin.json"
        )
      );

      // 恢复合法 plugin.json，测试 mcp_config.json 各类损坏
      projectFixture.writeWorkspaceFile(
        ".agents/plugins/y3maker-mcp/plugin.json",
        `${JSON.stringify({ name: "y3maker-mcp", version: "1.0.0" }, null, 2)}\n`
      );

      // 1e) mcp_config.json 包含禁止的 type 字段 + 缺失已迁移服务
      projectFixture.writeWorkspaceFile(
        ".agents/plugins/y3maker-mcp/mcp_config.json",
        `${JSON.stringify(
          {
            mcpServers: {
              "y3-stdio": {
                type: "stdio",
                command: "node",
                args: ["server.js"],
              },
            },
          },
          null,
          2
        )}\n`
      );
      const badMcpType = projectFixture.runVerify();
      assert.equal(badMcpType.status, 1);
      assert.ok(
        badMcpType.json.issues.some(
          (i) =>
            i.type === "invalid-mcp-config" &&
            i.path === ".agents/plugins/y3maker-mcp/mcp_config.json" &&
            /type/.test(i.detail)
        ),
        `应检出禁用 type 字段，issues: ${JSON.stringify(badMcpType.json.issues)}`
      );
      assert.ok(
        badMcpType.json.issues.some(
          (i) =>
            i.type === "invalid-mcp-config" &&
            i.path === ".agents/plugins/y3maker-mcp/mcp_config.json" &&
            i.detail.includes("y3-http")
        ),
        `应检出缺失已迁移兼容服务 y3-http，issues: ${JSON.stringify(badMcpType.json.issues)}`
      );

      // 1f) 删除 mcp_config.json -> missing-path
      projectFixture.removeWorkspacePath(".agents/plugins/y3maker-mcp/mcp_config.json");
      const missingMcp = projectFixture.runVerify();
      assert.equal(missingMcp.status, 1);
      assert.ok(
        missingMcp.json.issues.some(
          (i) =>
            i.type === "missing-path" &&
            i.path === ".agents/plugins/y3maker-mcp/mcp_config.json"
        )
      );
    } finally {
      projectFixture.cleanup();
    }

    // 2) user 范围：正常通过 + 篡改与缺失阻断
    const userFixture = createFixture();
    try {
      seedMinimalY3Maker(userFixture, {
        mcpSettings: {
          mcpServers: {
            "y3-tools": { command: "node", args: ["tools.js"] },
          },
        },
      });
      userFixture.writeHomeFile(
        ".gemini/config/mcp_config.json",
        `${JSON.stringify(
          {
            mcpServers: {
              "existing-user": { command: "node", args: ["existing.js"] },
            },
          },
          null,
          2
        )}\n`
      );

      const applyUser = userFixture.runApply(["--targets", "antigravity", "--mcp-scope", "user"]);
      assert.equal(applyUser.status, 0);

      const verifyUserOk = userFixture.runVerify();
      assert.equal(verifyUserOk.status, 0, `user verify 应通过，output: ${verifyUserOk.stdout}`);
      assert.equal(verifyUserOk.json.ok, true);

      // 篡改 user 配置：为受管服务添加禁止的 type 字段
      userFixture.writeHomeFile(
        ".gemini/config/mcp_config.json",
        `${JSON.stringify(
          {
            mcpServers: {
              "existing-user": { command: "node", args: ["existing.js"] },
              "y3-tools": { type: "stdio", command: "node", args: ["tools.js"] },
            },
          },
          null,
          2
        )}\n`
      );
      const verifyUserBadType = userFixture.runVerify();
      assert.equal(verifyUserBadType.status, 1);
      assert.ok(
        verifyUserBadType.json.issues.some(
          (i) =>
            i.type === "invalid-mcp-config" &&
            i.path === "~/.gemini/config/mcp_config.json" &&
            /type/.test(i.detail)
        )
      );

      // 缺失 ~/.gemini/config/mcp_config.json -> missing-path
      fs.rmSync(userFixture.homePath(".gemini/config/mcp_config.json"), { force: true });
      const verifyUserMissing = userFixture.runVerify();
      assert.equal(verifyUserMissing.status, 1);
      assert.ok(
        verifyUserMissing.json.issues.some(
          (i) => i.type === "missing-path" && i.path === "~/.gemini/config/mcp_config.json"
        )
      );
    } finally {
      userFixture.cleanup();
    }

    // 3) skip 与全跳过（仅旧版 SSE）场景：verify 应干净通过不误报缺失
    const skippedFixture = createFixture();
    try {
      seedMinimalY3Maker(skippedFixture, {
        mcpSettings: {
          mcpServers: {
            "only-sse": { type: "sse", url: "https://legacy.example.com/sse" },
          },
        },
      });
      const applySse = skippedFixture.runApply([
        "--targets",
        "antigravity",
        "--mcp-scope",
        "project",
      ]);
      assert.equal(applySse.status, 0);
      assert.equal(applySse.json.mcp.targets.antigravity.converted, false);

      const verifySse = skippedFixture.runVerify();
      assert.equal(
        verifySse.status,
        0,
        `全部跳过不兼容 SSE 时 verify 不应误报缺失，output: ${verifySse.stdout}`
      );
      assert.equal(verifySse.json.ok, true);

      const applySkip = skippedFixture.runApply([
        "--targets",
        "antigravity",
        "--mcp-scope",
        "skip",
      ]);
      assert.equal(applySkip.status, 0);
      const verifySkip = skippedFixture.runVerify();
      assert.equal(verifySkip.status, 0);
      assert.equal(verifySkip.json.ok, true);
    } finally {
      skippedFixture.cleanup();
    }
  });
});
