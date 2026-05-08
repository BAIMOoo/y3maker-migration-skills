# Y3Maker Migration Skills

A small collection of migration skills for moving legacy Y3Maker / CodeMaker project assistant assets into modern agent-native layouts.

## Included skills

| Skill | Target | Use when |
| --- | --- | --- |
| [`sync-y3maker-to-codex`](./sync-y3maker-to-codex/) | Codex | You want to migrate `.y3maker/` assets into `.codex/` and optional Codex MCP configuration. |
| [`sync-y3maker-to-claude`](./sync-y3maker-to-claude/) | Claude Code | You want to migrate `.y3maker/` assets into `.claude/`, `.mcp.json`, and optional Claude Code MCP configuration. |

Both skills follow the same safety model:

- Do not mutate the original `.y3maker/` directory.
- Start with inventory and dry-run commands.
- Require an explicit MCP scope choice when MCP settings are present.
- Track repeated syncs with a migration manifest.
- Preserve blocked or orphaned files instead of overwriting or deleting silently.

## Repository layout

```text
sync-y3maker-to-codex/     # Codex skill package
sync-y3maker-to-claude/    # Claude Code skill package
```

Each skill is intentionally self-contained so it can be copied directly into the target tool's user-level or project-level skills directory.

## Installation

### Codex

Copy the Codex skill directory into your Codex skills directory:

```powershell
Copy-Item -Recurse .\sync-y3maker-to-codex "$HOME\.codex\skills\sync-y3maker-to-codex"
```

### Claude Code

Copy the Claude skill directory into your Claude skills directory:

```powershell
Copy-Item -Recurse .\sync-y3maker-to-claude "$HOME\.claude\skills\sync-y3maker-to-claude"
```

## Usage

Open the relevant `SKILL.md` and follow its inventory -> dry-run -> apply -> verify workflow.

For example, from inside a copied skill directory:

```powershell
node ".\scripts\run-migration.js" inventory --workspace "."
node ".\scripts\run-migration.js" apply --workspace "." --dry-run --mcp-scope project
node ".\scripts\verify-migration.js" --workspace "." --mcp-scope project
```

## Development notes

The two skills are related but not identical. Keep platform-specific metadata and MCP targets separate:

- Codex uses `.codex/` and Codex configuration conventions.
- Claude Code uses `.claude/`, `.mcp.json`, `~/.claude.json`, and Claude skill metadata such as `allowed-tools`.

Avoid committing personal configuration files, generated manifests, real project migrations, or secrets.
