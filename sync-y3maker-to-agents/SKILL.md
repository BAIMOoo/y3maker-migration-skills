---
name: sync-y3maker-to-agents
description: 将遗留的 Y3Maker / CodeMaker 项目资产（`.y3maker/`）统一迁移到共享正本 Canonical Store（`.agents/`），并按需生成 Codex、Claude Code、Antigravity（`agy`）与 DSH 的极薄宿主适配层（Harness Adapter）。适用于工作区存在 `.y3maker/`、旧 `.codemaker` 路径、遗留 rules/memory/skills/templates 或 `mcp_settings.json`，且需要：(1) 首次迁移到 `.agents/` 并启用一个或多个目标宿主，(2) `.y3maker/` 更新后执行安全重复同步与冲突保护，(3) 按显式 MCP Scope（`project`/`user`/`skip`）转换各宿主 MCP 配置，或 (4) 从旧版 `.codex/` / `.claude/` 迁移副本盘点手工改动并平稳过渡时使用。
---

# 将 Y3Maker 统一迁移至 `.agents/`（多 Harness）

以项目内唯一的 **Canonical Store**（`.agents/`）承载全部共享资产，仅在用户选定的 **Harness** 需要时生成极薄 **Harness Adapter**。严格保持 **Legacy Source**（`.y3maker/`）只读，默认先运行脚本完成机械迁移与校验，再处理需要人工判断的事项。

> 详细路径映射、四端 MCP 格式与验收细则见 [references/migration-map.md](references/migration-map.md)。

## 执行流程（`inventory -> dry-run -> apply -> verify`）

以下示例假设当前技能位于本技能目录，执行时请用实际安装路径替换 `<skill-dir>`（例如 `.agents/skills/sync-y3maker-to-agents` 或用户级 skills 目录）。

### 1. 盘点工作区（`inventory`）

在写入任何文件前先盘点工作区现状：

```powershell
node "<skill-dir>/scripts/run-migration.js" inventory --workspace "." --pretty
```

完成标准：确认输出中的 `.y3maker/` 资产清单、是否存在 `.codemaker/templates` 回退、是否存在 `.y3maker/mcp_settings.json`、现有 **Migration Manifest** 状态，以及 `legacyTransition` 是否检测到旧版 `.codex/` 或 `.claude/` 迁移副本。

### 2. 确定目标宿主与 MCP Scope，并执行 `dry-run` 预览

`apply` 需要两项显式输入：

- `--targets`：逗号分隔的目标宿主，可选 `codex`、`claude`、`antigravity`（别名 `agy`）、`dsh` 或 `all`（同时启用全部 4 个宿主）。首次执行且处于非交互环境时省略 `--targets` 会直接报错；后续重复同步可省略并自动复用 **Migration Manifest** 中已记录的 `targets`。
- `--mcp-scope`：当存在 `.y3maker/mcp_settings.json` 时必须显式指定统一 **MCP Scope**：
  - `project`：写入各宿主的项目级 MCP 配置
  - `user`：安全合并至各宿主的用户级全局 MCP 配置
  - `skip`：本次跳过全部宿主的 MCP 迁移

交互式终端未传参时会提示选择；非交互模式禁止静默猜测或修改 MCP 配置。先执行 `--dry-run` 预览全部计划：

```powershell
node "<skill-dir>/scripts/run-migration.js" apply --workspace "." --targets all --mcp-scope project --dry-run --pretty
```

完成标准：确认 `dry-run` 输出的 `targets`、`createdDirs`、`sync`（`created`/`updated`/`blocked`/`orphaned`）、各宿主 `mcp.targets` 变更计划、`mcp.warnings`（如 Antigravity / DSH 的旧版 SSE 跳过告警）与 `mcp.hints`（如 DSH 项目级 `--patch` 启动提示）均符合预期。`--dry-run` 不会写入磁盘。

### 3. 执行迁移或重复同步（`apply`）

确认预览无误后，去掉 `--dry-run` 正式执行：

```powershell
node "<skill-dir>/scripts/run-migration.js" apply --workspace "." --targets all --mcp-scope project --pretty
```

脚本会自动完成以下工作：

- **统一写入 Canonical Store（`.agents/`）**：同步 `knowledge`、`memory`、`rules`（`.y3maker/rules/*.mdc` 原位保留在 `.agents/rules/`，不改后缀不挪目录，以维持技能内的 `../../rules/*.mdc` 相对引用且不与 Antigravity 活跃规则 `.agents/rules/*.md` 冲突）、`skills` 与 `templates`（优先 `.y3maker/templates`，回退 `.codemaker/templates`）。
- **清洗与规范化**：自动剥离 UTF-8 BOM、支持 UTF-8 / GB18030 解码与二进制 `.json` 原样回退、过滤旧副产物（技能根 `README.md`、`install_skills.bat`、`y3-auto-test/.queue`、`y3-obj-gen/.claude-plugin`）、将 `.codemaker`/`.codex`/`.y3maker/`/`<agent>/`/`<codemaker>/` 规范化为 `.agents/`、修复 `y3-auto-test` 自引用与 `y3-obj-gen` `cmtmp` 提示、确保 `openspec/docs` 与 `openspec/reports` 存在并清理 `.agents/cmtmp`。
- **规范化 `.agents/skills/*/SKILL.md`**：仅保留标准 `name`（覆盖为目录名）与 `description`，确保四端解析零兼容风险。
- **按 `--targets` 执行各 Harness Adapter**：
  - **Codex**：直接原生读取 `.agents/skills/`，不复制资产树；MCP 以安全 TOML 区块合并写入 `.codex/config.toml`（`project`）或 `~/.codex/config.toml`（`user`），保留既有配置与注释。
  - **Claude Code**：执行受 **Migration Manifest** 跟踪的单向 **Skill Projection**，将 `.agents/skills/` 投影至 `.claude/skills/`（不复制 `rules`/`memory`/`knowledge`/`templates`），自动将跨目录相对路径（`../../rules/`、`../../memory/`、`../../knowledge/`、`../../templates/`、`../../spec-config.json` 及更深层级）回指 `.agents/...`，并仅在 `.claude/skills/*/SKILL.md` 保留规范化后的 `allowed-tools`（兼容源 `tools:` 转换）；MCP 安全合并至 `.mcp.json`（`project`）或 `~/.claude.json`（`user`）。
  - **Antigravity（`agy`）**：直接原生读取 `.agents/skills/`；项目级 MCP 生成符合 `agy plugin validate --strict` 的插件目录 `.agents/plugins/y3maker-mcp/`（含 `name` 与 `version` 的 `plugin.json` 及不含 `type` 字段的 `mcp_config.json`），用户级安全合并至 `~/.gemini/config/mcp_config.json`；遇到 Antigravity 不支持的旧版 HTTP+SSE 服务（`type: "sse"` 或 `/sse` 端点）时自动跳过，并在 `warnings` 中提示切换至 Streamable HTTP（`/mcp`）或使用 `mcp-remote` 桥接。
  - **DSH**：直接原生读取 `.agents/skills/`；将兼容服务转为 `@deepseek-ai/dsh-mcp-client` 条目（按受管 `id` 幂等合并，保留既有用户插件与顶层补丁），`user` 合并至 `~/.dsh/cordis.patch.yml`（全局自动加载），`project` 生成/合并 `.dsh/cordis.patch.yml` 并在 `mcp.hints` 中提示以 `dsh --patch .dsh/cordis.patch.yml` 启动加载；遇到不支持的旧版 SSE 服务同样跳过并告警。
- **维护单一 Migration Manifest**：将全量跟踪基线写入 `.agents/migration/y3maker-manifest.json`。

完成标准：命令退出码为 `0`，输出 JSON 中已明确列出各文件同步结果及告警/提示。

### 4. 端到端验收（`verify`）

每次 `apply` 后都必须执行验收脚本：

```powershell
node "<skill-dir>/scripts/verify-migration.js" --workspace "." --pretty
```

验收器默认复用 **Migration Manifest** 中记录的 `targets` 与 `mcpScope`，也支持通过 `--targets` / `--mcp-scope` 显式覆盖校验。

完成标准：`verify` 返回退出码 `0`、`ok: true` 且 `issues` 为空列表；若 `ok: false`，逐条定位并修复问题后重新验收，切勿把未通过验收的结果汇报为迁移完成。对于原始 `.y3maker/` 中本就缺失的外部引用或脚本，如实向用户报告，不要伪造占位文件。

## 重复同步与 MCP Scope 切换

`apply` 同时也是 `.y3maker/` 后续更新时的安全同步入口，依赖 `.agents/migration/y3maker-manifest.json` 维护三态哈希基线：

- `created` / `updated`：目标首次创建，或仅上游变更而目标未改时自动更新。
- `adopted` / `resolved`：目标内容已与期望结果一致，自动建立基线或解除此前的冲突状态。
- `blocked`：目标被本地手工修改，或首次迁移遇到未跟踪的差异文件——保留原文件不覆盖，等待人工合并。
- `orphaned`：源文件已从 `.y3maker/` 移除——保留目标文件不静默删除，等待人工确认后清理。
- **切换 `--mcp-scope`**：在 `project` / `user` / `skip` 之间切换时，原范围的 MCP 配置文件会原样保留在磁盘上不自动删除，并在 `mcp.hints` 中逐一列出提示用户按需人工核对或清理。

## 旧版 `.codex/` 与 `.claude/` 过渡核对指引

当工作区曾运行旧版 `sync-y3maker-to-codex` 或 `sync-y3maker-to-claude` 时，`inventory` 与 `apply` 的 `legacyTransition` 会以只读方式扫描旧版清单并比对磁盘哈希：

1. **先核对人工改动**：优先处理 `manualReviewRequired` 中列出的 `modified`（本地手工改过或历史 `blocked`）、`orphaned` 与 `untracked` 文件，将仍需保留的改动合并到 `.y3maker/` 或 `.agents/`。
2. **保护当前活跃路径**：若启用了 `claude` 或 `codex` 目标，务必保留 `activeProtectedPaths` 标注的活跃路径（如 `.claude/skills`、`.mcp.json`、`.codex/config.toml`），切勿整目录删除 `.claude/` 或 `.codex/`。
3. **再手动评估清理**：确认改动已妥善保留后，可按 `safeToCleanDirectories` 列表由人工手动清理不再需要的旧子目录（如 `.codex/rules`、`.claude/rules` 等）。本技能绝不自动删除历史副本。

## 硬边界与安全护栏

- **只读上游**：保持 **Legacy Source**（`.y3maker/`）全程只读，只迁移与改写目标副本。
- **根目录零侵入**：绝不创建、覆盖或修改项目根目录的 `AGENTS.md` 或 `CLAUDE.md`；是否将某些规则浓缩进根目录说明由人工另行决定。
- **历史副本只读**：绝不自动删除、移动或改写旧版 `.codex/` 或 `.claude/` 迁移副本（仅在启用对应宿主且显式选择 `project` MCP 范围时安全合并 `.codex/config.toml` / `.mcp.json`，或受 `blocked` 保护执行 `.claude/skills/` 投影）。
- **显式 MCP 边界**：存在 `.y3maker/mcp_settings.json` 时必须显式选择 `--mcp-scope`，绝不隐式修改用户主目录配置。
- **危险工作区护栏**：默认拒绝文件系统根目录、用户主目录及 `~/.codex`、`~/.claude`、`~/.agents`、`~/.gemini`、`~/.dsh` 作为工作区；仅在明确确认场景下使用 `--allow-unsafe-workspace`。

## 最终汇报要求

向用户汇报结果时至少说明：

1. 本次是首次迁移还是重复同步，启用的 `--targets` 与 `--mcp-scope`。
2. `created` / `updated` / `adopted` / `resolved` / `blocked` / `orphaned` 摘要。
3. 各启用宿主的 MCP 迁移落点、跳过项、`warnings`（尤其空 `mcpServers`、Antigravity / DSH 旧版 SSE 跳过及 `mcp-remote` 建议）与 `hints`（尤其 DSH 项目级 `dsh --patch .dsh/cordis.patch.yml` 启动命令及 MCP Scope 切换保留提示）。
4. 若检测到 `legacyTransition`，给出 `manualReviewRequired`、`activeProtectedPaths` 与 `safeToCleanDirectories` 核对建议。
5. `verify` 验收结果及所有未修复的原始缺失引用或 `blocked`/`orphaned` 待人工项。

## 参考文件

- 完整迁移映射、四端配置格式与验收规则：[references/migration-map.md](references/migration-map.md)
- 迁移与盘点脚本：[scripts/run-migration.js](scripts/run-migration.js)
- 端到端验收脚本：[scripts/verify-migration.js](scripts/verify-migration.js)
