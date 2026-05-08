# Y3Maker 迁移 Skills

这个仓库收集了一组迁移 skill，用于把遗留的 Y3Maker / CodeMaker 项目助手资产迁移到新的 Agent 原生目录结构中。

## 包含的 skill

| Skill | 目标平台 | 适用场景 |
| --- | --- | --- |
| [`sync-y3maker-to-codex`](./sync-y3maker-to-codex/) | Codex | 将 `.y3maker/` 资产迁移到 `.codex/`，并可按需迁移 Codex MCP 配置。 |
| [`sync-y3maker-to-claude`](./sync-y3maker-to-claude/) | Claude Code | 将 `.y3maker/` 资产迁移到 `.claude/`、`.mcp.json`，并可按需迁移 Claude Code MCP 配置。 |

两个 skill 遵循相同的安全模型：

- 不修改原始 `.y3maker/` 目录。
- 先执行 inventory 盘点，再执行 dry-run 预览。
- 如果存在 MCP 配置，必须显式选择迁移范围。
- 使用迁移 manifest 跟踪后续重复同步。
- 对 blocked / orphaned 文件保守处理，不静默覆盖或删除。

## 仓库结构

```text
sync-y3maker-to-codex/     # Codex skill 包
sync-y3maker-to-claude/    # Claude Code skill 包
```

每个 skill 都保持自包含，方便直接复制到对应工具的用户级或项目级 skills 目录。

## 安装

### Codex

把 Codex skill 复制到 Codex skills 目录：

```powershell
Copy-Item -Recurse .\sync-y3maker-to-codex "$HOME\.codex\skills\sync-y3maker-to-codex"
```

### Claude Code

把 Claude Code skill 复制到 Claude skills 目录：

```powershell
Copy-Item -Recurse .\sync-y3maker-to-claude "$HOME\.claude\skills\sync-y3maker-to-claude"
```

## 使用方式

进入对应 skill 目录，阅读其中的 `SKILL.md`，按以下流程执行：

```text
inventory -> dry-run -> apply -> verify
```

示例：

```powershell
node ".\scripts\run-migration.js" inventory --workspace "."
node ".\scripts\run-migration.js" apply --workspace "." --dry-run --mcp-scope project
node ".\scripts\verify-migration.js" --workspace "." --mcp-scope project
```

如果迁移时选择了 `--mcp-scope user` 或 `--mcp-scope skip`，验收时也应保持一致。

## 开发说明

这两个 skill 相关但不完全相同。请保留平台差异，不要为了合并而破坏各自约定：

- Codex 使用 `.codex/` 以及 Codex 配置约定。
- Claude Code 使用 `.claude/`、`.mcp.json`、`~/.claude.json`，并使用 Claude skill 元数据，例如 `allowed-tools`。

如果未来要抽公共逻辑，建议先保证两个 skill 仍可独立复制和安装。

## 不应提交的内容

请不要提交：

- 个人配置文件
- 真实项目的 `.y3maker/`、`.codex/`、`.claude/`、`.omx/`
- 迁移生成的 manifest
- 日志、临时文件、密钥或 token
