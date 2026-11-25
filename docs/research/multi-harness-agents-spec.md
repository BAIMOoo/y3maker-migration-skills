# Multi-Harness `.agents/` Canonical Architecture Research

**Target Repository:** `y3maker-migration-skills` ([medaka](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka))  
**Scope:** Feasibility, discovery rules, compatibility boundaries, Windows/Git mechanics, and codebase audit for migrating legacy `.y3maker/` project assets into a shared `.agents/` canonical structure serving **OpenAI Codex**, **Anthropic Claude Code**, and **Google Antigravity (`agy`)** simultaneously.  
**Local Environment Observed (Primary CLI/Host Evidence):**
- `node`: `v22.23.4` (`C:\Program Files\nodejs\node.exe`)
- `git`: `git version 2.56.1.windows.1` (`core.symlinks = false` in both `C:/Program Files/Git/etc/gitconfig` and repo `.git/config`)
- `codex`: `codex-cli 0.172.0`
- `claude`: `2.1.302 (Claude Code)`
- `agy`: `1.5.17`

---

## Executive Summary & Compatibility Matrix

### Core Feasibility Verdict

A single canonical `.agents/` source-of-truth for **Codex + Claude Code + Antigravity** is **architecturally feasible, but NOT zero-adapter**:

1. **Skills (`.agents/skills/`):** Natively discovered by **Codex** and **Antigravity**, but **NOT natively discovered by Claude Code** (which requires `.claude/skills/`). Bridging `.agents/skills/` -> `.claude/skills/` on Windows without admin/Developer Mode has significant NTFS/Git hazards for symlinks and directory junctions; a **manifest-tracked one-way mirror (managed copy)** is the only completely portable, privilege-free, Git-safe bridge across Windows/macOS/Linux.
2. **Project Rules Entry (`AGENTS.md`):** Natively discovered by **Codex** and **Antigravity**, and bridgeable to **Claude Code** via a minimal `CLAUDE.md` containing `@AGENTS.md` (and/or native `AGENTS.md` fallback on newer Claude Code v2.1.x). However, **subdirectory `rules/` semantics conflict across all three harnesses** (`.codex/rules/` is Codex execpolicy `.rules`; `.claude/rules/*.md` is Claude path-scoped Markdown; `.agents/rules/*.md` is Antigravity trigger-based Markdown). Legacy `.y3maker/rules/*.mdc` must **NOT** be dumped into `.agents/rules/` if active rule collision is undesired.
3. **MCP Servers:** **Zero format convergence across the three harnesses.** Codex uses TOML (`.codex/config.toml`), Claude Code uses `.mcp.json` / `~/.claude.json`, and Antigravity uses `mcp_config.json` (global `~/.gemini/config/mcp_config.json`, plugin `.agents/plugins/<name>/mcp_config.json` + `plugin.json`; standalone `.agents/mcp_config.json` has conflicting primary docs and needs local test on `agy 1.5.17`). Transport support also diverges: Antigravity strictly rejects legacy HTTP+SSE.
4. **Shared Codebase Potential:** In the current repo, ~80–85% of `migration-lib.js` and ~95% of `run-migration.js` are duplicated between `sync-y3maker-to-codex` and `sync-y3maker-to-claude`, and drift bugs have already emerged (e.g., `templates/` handling and `verify-migration.js` active surfaces).

### Cross-Harness Compatibility Matrix

| Dimension | Agent Skills Standard (`agentskills.io`) | OpenAI Codex (`codex-cli 0.172.0`) | Anthropic Claude Code (`2.1.302`) | Google Antigravity (`agy 1.5.17`) |
| :--- | :--- | :--- | :--- | :--- |
| **Project Skills Path** | `<skill-name>/SKILL.md` (`agentskills.io/specification`) | `.agents/skills/` & `.codex/skills/` (CWD -> repo root) | **`.claude/skills/` ONLY** (+ nested `<subdir>/.claude/skills/`); `.agents/skills/` NOT native | **`.agents/skills/`** (+ `.agent/`, `_agents/`, `_agent/`, `.agents/skills.json`; CWD -> repo root) |
| **User Skills Path** | Implementation-defined | `~/.agents/skills/` & `~/.codex/skills/` *(see verification note in §1.2)* | `~/.claude/skills/` (+ `~/.claude/skills/synced/`) | `~/.gemini/config/skills/` (+ `~/.gemini/config/skills.json`) |
| **`SKILL.md` Required Frontmatter** | `name`, `description` | `name`, `description` | `name`, `description` | `description` required; `name` required in local docs (defaults to folder in live docs) |
| **`SKILL.md` `allowed-tools`** | Optional (**experimental**), space-separated string | **Unverified / Needs local test** on `codex-cli 0.172.0` (strict validators may reject unknown keys) | Supported (pre-approves tools without prompt; NOT a deny sandbox) | **Accepted (ignored, not rejected)** — empirically confirmed on `agy 1.5.17` |
| **Skill Symlink Support** | Implementation-defined | **Unverified / Needs local test** on Windows | Documented for `<skill-name>` symlinks; Windows junction UI menu bug reported (`#68318`) | **Unverified / Needs local test** on Windows |
| **Project Root Rules File** | N/A | `AGENTS.md`, `AGENTS.override.md` (32 KiB default cap) | `CLAUDE.md`, `CLAUDE.local.md`; `@AGENTS.md` import (max 4 hops); `AGENTS.md` fallback in v2.1.x *(needs local test)* | `AGENTS.md`, `GEMINI.md` (24 KB/file cap, 20k-token aggregate budget) |
| **Modular `rules/` Folder** | N/A | `.codex/rules/*.rules` = **command execpolicy** (NOT markdown instructions) | `.claude/rules/*.md` (optional `paths:` frontmatter) | `.agents/rules/*.md` (frontmatter triggers: `always_on`, `model_decision`, `glob`, `manual`) |
| **Project MCP Config** | N/A | `.codex/config.toml` (`[mcp_servers.*]`, requires trusted project) | `.mcp.json` (`mcpServers`, requires per-server/project approval) | `.agents/plugins/<name>/mcp_config.json` + `plugin.json` confirmed; standalone `.agents/mcp_config.json` **Conflicting docs / Needs local test** |
| **User MCP Config** | N/A | `~/.codex/config.toml` | `~/.claude.json` (`user` global + `local` per-project scopes) | `~/.gemini/config/mcp_config.json` |
| **MCP Transports** | N/A | `stdio`, Streamable HTTP (`url`) | `stdio`, `http`, `sse` (+ WebSocket via `add-json`) | `stdio`, Streamable HTTP (`url` / `serverUrl`); **legacy HTTP+SSE NOT supported** |

---

## Area 1: Skills Discovery & `SKILL.md` Compatibility

### 1.1 Agent Skills Open Standard (`agentskills.io`)

- **Canonical directory structure:** A skill is a self-contained directory named `<skill-name>/` containing a mandatory `SKILL.md` file and optional `scripts/`, `references/`, and `assets/` subdirectories ([agentskills.io/specification](https://agentskills.io/specification)).
- **Core frontmatter schema (6 official fields):** ([agentskills.io/specification](https://agentskills.io/specification))
  1. `name` (**required**): string, max 64 chars, lowercase alphanumeric (`a-z`, `0-9`) and hyphens (`-`) only, cannot start or end with a hyphen, must match the parent directory name.
  2. `description` (**required**): non-empty string, max 1024 chars; drives progressive-disclosure matching at startup.
  3. `license` (optional): string (SPDX name or bundled license file reference).
  4. `compatibility` (optional): string, max 500 chars (target software, system packages, network constraints).
  5. `metadata` (optional): arbitrary string-to-string key-value map.
  6. `allowed-tools` (optional, **experimental**): space-separated string of pre-approved tools (e.g., `Read Glob Bash(python:*)`). Because the spec marks it experimental, runtime enforcement and parser acceptance vary across harnesses ([agentskills.io/specification](https://agentskills.io/specification)).

### 1.2 OpenAI Codex

- **Discovery paths & traversal:**
  - Project/repo scope: Codex discovers skills in `.agents/skills/<skill-name>/SKILL.md` and `.codex/skills/<skill-name>/SKILL.md`, walking from the current working directory up to the repository root ([developers.openai.com/codex/skills](https://developers.openai.com/codex/skills); [github.com/openai/codex](https://github.com/openai/codex)).
  - User scope: `~/.codex/skills/` and `~/.agents/skills/` are referenced across Codex docs/ecosystem; **Unverified / Needs local test** whether `codex-cli 0.172.0` prioritizes `~/.agents/skills/` vs `~/.codex/skills/` identically on Windows.
- **`SKILL.md` frontmatter & `allowed-tools` handling:**
  - Codex's Rust core (`codex-rs/core-skills/src/loader.rs`) parses `SKILL.md` frontmatter into `SkillFrontmatter` with required `name` and `description` ([github.com/openai/codex](https://github.com/openai/codex)).
  - Codex does **not** use `allowed-tools` in `SKILL.md`; instead, Codex models tool/MCP dependencies and invocation policy in `agents/openai.yaml` ([developers.openai.com/codex/skills](https://developers.openai.com/codex/skills)).
  - **CRITICAL — Unverified / Needs local test:** Whether `codex-cli 0.172.0`'s Rust `SkillFrontmatter` struct silently ignores unknown YAML keys like `allowed-tools` (default Serde behavior) or rejects the skill via `#[serde(deny_unknown_fields)]` could not be verified directly from raw Rust source lines in this offline-curl environment. Strict schema validators in the Codex ecosystem (e.g., `quick_validate.py`) flag unknown keys ([github.com/openai/codex](https://github.com/openai/codex)). **Must run a 30-second local test with `codex-cli 0.172.0` before deciding whether canonical `.agents/skills/*/SKILL.md` may contain `allowed-tools`.**
- **`agents/openai.yaml` role:** Optional Codex-specific sidecar inside `<skill-name>/agents/openai.yaml` defining UI metadata (`interface.display_name`, `short_description`, `default_prompt`), invocation policy (`policy.allow_implicit_invocation`), and external/MCP tool dependencies (`dependencies.tools`) ([developers.openai.com/codex/skills](https://developers.openai.com/codex/skills); see also existing example in [sync-y3maker-to-codex/agents/openai.yaml](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/agents/openai.yaml#L1-L7)). Other harnesses ignore this subdirectory because `agentskills.io` allows arbitrary additional subdirectories.

### 1.3 Anthropic Claude Code

- **Exact discovery paths — `.agents/skills` is NOT natively scanned:**
  - Official Claude Code docs list the following skill locations ([code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)):
    - Project: `.claude/skills/<skill-name>/SKILL.md`
    - Nested/monorepo: `<subdir>/.claude/skills/<skill-name>/SKILL.md`
    - Personal/user: `~/.claude/skills/<skill-name>/SKILL.md` (plus `~/.claude/skills/synced/` for `claude.ai` accounts)
    - Enterprise/managed: `.claude/skills/<skill-name>/SKILL.md` under managed settings
    - Plugins: plugin-bundled skills
  - Official GitHub feature request `anthropics/claude-code#107421` (*"[Feature Request] Load skills from `~/.agents/skills/` and `<project>/.agents/skills/`"*) confirms that Claude Code does **not** natively scan `.agents/skills/` ([github.com/anthropics/claude-code/issues/107421](https://github.com/anthropics/claude-code/issues/107421)).
  - **Consequence:** A canonical `.agents/skills/` directory alone is invisible to Claude Code; a bridge into `.claude/skills/` is mandatory.
- **`SKILL.md` frontmatter & `allowed-tools`:**
  - Supports standard `name`, `description`, `allowed-tools`, plus Claude-specific extensions (`disable-model-invocation`, `user-invocable`, `context: fork`, `model`, `argument-hint`, etc.) ([code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)).
  - `allowed-tools` **pre-approves** listed tools to run without confirmation prompts while the skill is active; it is **not** a deny-list sandbox ([code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)).
  - Note syntax nuance: `agentskills.io` specifies space-separated `allowed-tools` (`Read Glob Bash`), while existing [sync-y3maker-to-claude/SKILL.md](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/SKILL.md#L4) uses comma-separated (`Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion`). Both forms work in Claude Code, though space-separated matches `agentskills.io`.
- **Symlink / Junction traversal:**
  - Official docs confirm Claude Code follows directory symlinks placed as `<skill-name>` entries under enterprise, personal, or project skill roots, reads `SKILL.md` from the target, and deduplicates multiple links pointing to the same target ([code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)).
  - **Windows caveat:** `anthropics/claude-code#68318` reports that on Windows, skills linked via NTFS directory junctions/symlinks are resolved by the agent loader, but may be omitted from interactive `/` slash-command menus in Desktop UI integrations ([github.com/anthropics/claude-code](https://github.com/anthropics/claude-code)).
  - **Unverified / Needs local test:** Whether symlinking/junctioning the parent `.claude/skills` directory itself (vs per-skill subdirectories `.claude/skills/<name>`) works reliably in `claude 2.1.302` CLI and slash-command completion on Windows.

### 1.4 Google Antigravity (`agy`)

All local facts below are verified directly from the installed `agy 1.5.17` built-in customization documentation and live `antigravity.google/docs/*`:

- **Workspace & global discovery paths:**
  - Workspace customization roots: `.agents/` (canonical), plus `.agent/`, `_agents/`, and `_agent/` ([agy-customizations/SKILL.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/SKILL.md#L41-L47); [antigravity_guide/references/ide.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/antigravity_guide/references/ide.md#L72-L76)).
  - Hierarchical walk: walks up from CWD to the repository root (folder containing `.git`), discovering `GEMINI.md`, `AGENTS.md`, `.agents/rules/*.md`, `.agents/rules.json`, `.agents/skills/*/SKILL.md`, and `.agents/skills.json` ([agy-customizations/SKILL.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/SKILL.md#L48-L54)).
  - Global root: `~/.gemini/config/` ([agy-customizations/SKILL.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/SKILL.md#L55-L57)).
  - Precedence (highest to lowest): Workspace hierarchical -> Declared workspace `skills.json`/`plugins.json` -> Global `~/.gemini/config/` -> Built-in -> Global declared JSON configs ([agy-customizations/SKILL.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/SKILL.md#L67-L77)).
- **`SKILL.md` frontmatter & `allowed-tools` compatibility:**
  - Local built-in docs require `name` (lowercase, hyphenated) and `description` ([agy-customizations/docs/skills.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/skills.md#L21-L55)); live `antigravity.google/docs/skills` also documents optional `disable-slash-command` and folder-name fallback for `name` ([antigravity.google/docs/skills](https://antigravity.google/docs/skills)).
  - **Empirical local proof on `allowed-tools`:** On this machine, [~/.gemini/config/skills/sync-y3maker-to-claude/SKILL.md](file:///C:/Users/wb.lixinyan03/.gemini/config/skills/sync-y3maker-to-claude/SKILL.md#L1-L5) contains `allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion` on line 4 and is actively discovered and injected into the live `agy 1.5.17` session's `<skills>` catalog without error. Therefore, **Antigravity tolerates (does not reject) `allowed-tools` in `SKILL.md`**, though Antigravity itself manages tool permissions via settings/capabilities rather than `allowed-tools` ([antigravity.google/docs/skills](https://antigravity.google/docs/skills); [antigravity_guide/references/app.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/antigravity_guide/references/app.md#L35-L79)).
- **`skills.json` and `plugins.json`:**
  - Placed in `.agents/` (honored in every `.agents/` between CWD and repo root) or `~/.gemini/config/` ([agy-customizations/docs/json_configs.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/json_configs.md#L7-L18)).
  - Supports `entries` (`path`, `include_only`, `exclude`, scanned **one level deep**) and `inherits` (`path`, `include_only`, `exclude`) ([agy-customizations/docs/json_configs.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/json_configs.md#L25-L74)).
  - Path resolution: `/` absolute, `~/` home-relative, relative paths resolve against the directory containing the `.agents/` dir (falling back to repo root) ([agy-customizations/docs/json_configs.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/json_configs.md#L17-L18), [L86-L96](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/json_configs.md#L86-L96)).
  - *Strategic note:* Because Antigravity supports `.agents/skills.json` pointing to any workspace-relative directory (e.g., `.claude/skills`), Antigravity is actually the most flexible harness—whereas `.agents/skills/` already works natively for **both** Codex and Antigravity with zero extra manifest.

---

## Area 2: Project Rules / Memory Entry Files

### 2.1 Root Entry Files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`)

- **OpenAI Codex:**
  - Loads global `~/.codex/AGENTS.md` (or `AGENTS.override.md`), then walks from repo root down to CWD concatenating `AGENTS.md` files; at any directory level, `AGENTS.override.md` takes precedence over `AGENTS.md` ([developers.openai.com/codex](https://developers.openai.com/codex)).
  - Default total cap: `project_doc_max_bytes = 32768` (32 KiB); configurable in `config.toml` ([developers.openai.com/codex](https://developers.openai.com/codex)).
  - Fallback filenames can be configured via `project_doc_fallback_filenames` (e.g., `["CLAUDE.md"]`) in `config.toml`, though relying on `AGENTS.md` requires zero user config ([developers.openai.com/codex](https://developers.openai.com/codex)).
- **Google Antigravity (`agy`):**
  - Automatically discovers `GEMINI.md` and `AGENTS.md` walking up from CWD to repo root; standalone files do **not** support frontmatter and are always active for their directory and subdirectories ([agy-customizations/docs/rules.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/rules.md#L12-L20)).
  - **Include syntax (`@[label](path)`):** Supported inside rules; expanded before applying the per-file size cap ([agy-customizations/docs/rules.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/rules.md#L31-L33)).
  - **Size & budget limits:**
    - **Per-file cap:** `24,000` bytes (`24 KB`) after expanding `@[label](path)` includes, truncated on line boundaries ([agy-customizations/docs/rules.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/rules.md#L31-L33)).
    - **Aggregate rules budget (`defaultRulesBudget`):** `20,000` tokens shared by always-on and global rules; over-budget rules are demoted to file path pointers for on-demand reads (builtin plugins exempt) ([agy-customizations/docs/rules.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/rules.md#L34-L40)).
  - **Deduplication:** Deduplicated by resolved file path per conversation turn ([agy-customizations/SKILL.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/SKILL.md#L94-L98); [agy-customizations/docs/rules.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/rules.md#L22-L26)).
- **Anthropic Claude Code:**
  - Natively loads `CLAUDE.md` (and `CLAUDE.local.md`) ([code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory)).
  - **`@path` import syntax:** `CLAUDE.md` supports `@path/to/file` (relative to the importing file, absolute, or `@~/...`) with recursive expansion up to **4 hops**; spaces are backslash-escaped, and backticked `` `@foo` `` is ignored ([code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory)).
  - **Can `CLAUDE.md` simply contain `@AGENTS.md`?** **YES.** A minimal `CLAUDE.md` with `@AGENTS.md` (plus any optional Claude-only instructions below it) works across Claude Code versions and keeps `AGENTS.md` as the single canonical rules document for all 3 harnesses ([code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory)).
  - **Native `AGENTS.md` fallback:** Newer Claude Code releases (reported for v2.1.277+; local CLI is `2.1.302`) also document reading `AGENTS.md` when `CLAUDE.md` is absent via the `claude-md-or-agents-md` project instructions setting ([code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory)). **Needs local test** on `claude 2.1.302` if omitting `CLAUDE.md` entirely is considered; however, shipping a 1-line `CLAUDE.md` (`@AGENTS.md`) avoids version/config fragility and allows Claude-specific addenda without breaking `AGENTS.md` loading.
  - **Budget alignment:** Keep canonical `AGENTS.md` under **24 KB** so it satisfies both Antigravity's 24,000-byte per-file cap and Codex's 32 KiB default cap simultaneously.

### 2.2 Modular `rules/` Directory Semantic Conflict (Critical Footgun)

The three harnesses assign **incompatible meanings** to `<harness-dir>/rules/`:

| Directory | Harness Behavior | Compatibility with Legacy `.y3maker/rules/*.mdc` |
| :--- | :--- | :--- |
| **`.codex/rules/`** | Codex **execution policy** files (`*.rules`, `prefix_rule(pattern=..., decision="allow"\|"prompt"\|"forbidden")`) controlling sandbox escapes; loaded when project is trusted ([developers.openai.com/codex](https://developers.openai.com/codex)). | Legacy `.mdc` markdown files are ignored (pure archive), NOT executed as instructions. |
| **`.claude/rules/`** | Claude Code modular Markdown rules (`*.md`), optionally scoped via `paths:` YAML frontmatter ([code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory)). | Legacy `.mdc` extension is not `.md`; **Unverified / Needs local test** whether `claude 2.1.302` ignores `.mdc` or loads it. |
| **`.agents/rules/`** | Antigravity modular Markdown rules (`*.md`, plus `.agents/rules.json`), using frontmatter triggers (`always_on`, `model_decision`, `glob`, `manual`) ([agy-customizations/SKILL.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/SKILL.md#L49-L51), [L91-L92](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/SKILL.md#L91-L92); [antigravity.google/docs/rules](https://antigravity.google/docs/rules)). | Legacy `.y3maker/rules/*.mdc` use Cursor-style `.mdc` format. Storing archived `.y3maker/rules/` inside `.agents/rules/` risks confusing Antigravity's active modular-rules folder if any `.md` files exist or are later renamed! |

**Implication:** Archived legacy Y3Maker assets (`knowledge/`, `memory/`, legacy `rules/*.mdc`, `templates/`) should either live under a dedicated non-active namespace (e.g., `.agents/y3maker-archive/` or `.agents/reference/`) OR keep strict awareness that `.agents/rules/*.md` is an **active Antigravity discovery surface**!

---

## Area 3: MCP Server Configuration (Project vs User Scope)

### 3.1 OpenAI Codex

- **Files & schema:** TOML table `[mcp_servers.<name>]` in:
  - Project scope: `.codex/config.toml`
  - User scope: `~/.codex/config.toml` ([developers.openai.com/codex](https://developers.openai.com/codex); `codex mcp --help`).
- **Project trust requirement:** Project-scoped `.codex/config.toml` (including `[mcp_servers.*]` and `.codex/rules/`) is only loaded when the project is explicitly trusted in `~/.codex/config.toml` via `[projects."<path>"]` with `trust_level = "trusted"`; untrusted projects restrict `.codex/` layers ([developers.openai.com/codex](https://developers.openai.com/codex)).
- **Transports (`codex mcp add --help`):**
  - Stdio: `command`, `args`, `env` (`-- <COMMAND>...`, `--env KEY=VALUE`).
  - Streamable HTTP: `url` (`--url <URL>`), `--bearer-token-env-var`, OAuth options.
- **Known operational caveat:** Existing [sync-y3maker-to-codex/SKILL.md](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/SKILL.md#L37-L38) documents that Codex App recognition of user-level `~/.codex/config.toml` MCP servers can be unreliable, hence recommending project scope.

### 3.2 Anthropic Claude Code

- **Files & 3 scopes (`claude mcp add --help`, [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp)):**
  - `local` (CLI default): per-project private entry inside `~/.claude.json`.
  - `project` (VCS-shared): workspace root `.mcp.json` (`{ "mcpServers": { ... } }`).
  - `user` (global private): global `mcpServers` inside `~/.claude.json`.
  - Precedence: `local` > `project` > `user` ([code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp)).
- **Project trust / approval behavior:**
  - Verified directly from `claude mcp --help`: *"Unapproved `.mcp.json` servers are shown as `⏸ Pending approval` and not connected to; approved servers are health-checked unless disabled for this project."* Users can reset decisions via `claude mcp reset-project-choices`.
  - Batch auto-approval via `enableAllProjectMcpServers: true` in settings is ignored for untrusted folders ([code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp)).
- **Transports (`claude mcp add --help` / `claude mcp --help`):** `stdio`, `http`, `sse` (and WebSocket via `add-json`), plus `-e/--env` and `-H/--header`.

### 3.3 Google Antigravity (`agy`)

- **Files & project-scope discrepancy (CRITICAL):**
  - **Local built-in docs (`agy 1.5.17`)** list **ONLY two locations** for `mcp_config.json` ([agy-customizations/docs/mcp_servers.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/mcp_servers.md#L17-L23)):
    1. Global: `~/.gemini/config/mcp_config.json`
    2. Plugin: `plugins/<plugin_name>/mcp_config.json` — e.g., `.agents/plugins/<plugin_name>/mcp_config.json`, paired with a required `plugin.json` marker in `.agents/plugins/<plugin_name>/plugin.json` ([agy-customizations/docs/plugins.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/plugins.md#L12-L37), [L71-L72](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/plugins.md#L71-L72)). Discovered plugins are **enabled by default** unless `plugin.json` declares `"disabled": true` or `config.json` disables them ([agy-customizations/docs/plugins.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/plugins.md#L86-L112)).
  - **CLI check (`agy mcp add --help`):** Provides `-t/--type` (`stdio` | `http`), `-e/--env`, `-H/--header`, with **no `--scope` flag**. Meanwhile `agy plugin validate [target] [--strict] [--json]` validates plugin bundles the exact way the plugin loader reads them (`agy plugin validate --help`).
  - **Live public docs (`antigravity.google/docs/mcp`):** Additionally mention workspace-local `.agents/mcp_config.json` alongside global and plugin configs ([antigravity.google/docs/mcp](https://antigravity.google/docs/mcp)).
  - **Status:** Standalone `.agents/mcp_config.json` in `agy 1.5.17` is **Conflicting primary docs / Needs local test**. By contrast, wrapping project MCP inside `.agents/plugins/<name>/mcp_config.json` + `plugin.json` is **confirmed in BOTH local built-in docs and live docs**, and can be checked directly with `agy plugin validate`.
- **Transport restrictions (STRICT):**
  - Supported: **Stdio** (`command`, `args`, `env`) and **Streamable HTTP** (`url`; legacy key `serverUrl` also accepted) ([agy-customizations/docs/mcp_servers.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/mcp_servers.md#L28-L67)).
  - **Unsupported:** **Legacy HTTP+SSE transport (MCP spec 2024-11-05) is NOT supported.** Legacy SSE servers must either switch to a Streamable HTTP endpoint (`/mcp`) or be wrapped in a stdio bridge such as `mcp-remote` ([agy-customizations/docs/mcp_servers.md](file:///C:/Users/wb.lixinyan03/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/mcp_servers.md#L68-L71)). This directly affects legacy `.y3maker/mcp_settings.json` entries that declare `"type": "sse"`.

---

## Area 4: Windows & Git Mechanics for Cross-Harness Bridging

Because **Codex** and **Antigravity** natively scan `.agents/skills/` while **Claude Code** requires `.claude/skills/`, bridging `.agents/skills/` -> `.claude/skills/` on Windows (the primary Y3 Editor developer OS) must be evaluated across three mechanisms:

| Mechanism | Creation Command / Node API | Windows Privilege Required | Path Type | Git Behavior (`core.symlinks = false`, Windows default) | Known Harness / Tooling Risks |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. NTFS Directory Junction** | `fs.symlinkSync(target, link, 'junction')` / `mklink /J` | **None** (standard user, no Admin / Developer Mode) | **Absolute path only** (Node auto-normalizes `target` to absolute) ([nodejs.org/api/fs.html](https://nodejs.org/api/fs.html)) | **Hazardous if tracked:** Junctions are NTFS reparse points, NOT POSIX symlinks (`120000`). Git for Windows can report nested files as deleted/type-changed or fail with `lstat` errors unless `.gitignore`d ([github.com/git-for-windows/git](https://github.com/git-for-windows/git)). | Breaks if repo folder is moved/renamed (absolute target); `anthropics/claude-code#68318` reports Windows junction skills may vanish from `/` UI menus; `Dirent.isDirectory()` is `false` on links in naive scanners. |
| **2. NTFS Directory Symlink** | `fs.symlinkSync(target, link, 'dir')` / `mklink /D` | **Admin (`SeCreateSymbolicLinkPrivilege`) OR Windows Developer Mode** ([learn.microsoft.com](https://learn.microsoft.com/en-us/windows/security/threat-protection/security-policy-settings/create-symbolic-links)) | Relative or absolute | Stored as mode `120000` blob. When `core.symlinks = false` (observed default on this Windows host!), `git checkout` materializes a **plain-text file** containing the target path instead of a link ([git-scm.com/docs/git-config](https://git-scm.com/docs/git-config)) — **breaks Claude Code completely** on teammates' Windows machines. | Fails with `EPERM` on locked-down corporate Windows machines without Developer Mode; broken checkout unless every teammate configures both Developer Mode + `core.symlinks = true`. |
| **3. Managed Copy (Manifest-Tracked One-Way Mirror)** | Copy + optional transform into `.claude/skills/`, tracked in manifest | **None** (standard filesystem writes) | N/A (physical files) | **100% clean:** standard `100644` blobs; works identically with `core.symlinks = false` or `true`, across Windows/macOS/Linux, whether committed or `.gitignore`d. | Requires running `apply` to refresh `.claude/skills/` after editing `.agents/skills/` (or `.y3maker/`); duplicate disk files; must protect local edits via existing 3-way hash manifest (`blocked` guard). |

### Key Primary-Source Citations for Area 4

- **Node.js `fs.symlink` / `fs.symlinkSync`:** `'junction'` is Windows-only, directory-only, and automatically converts `target` to an **absolute path** ([nodejs.org/api/fs.html](https://nodejs.org/api/fs.html)).
- **Microsoft Windows NTFS:** Creating true symbolic links requires `SeCreateSymbolicLinkPrivilege` (Administrators by default) unless Windows Developer Mode is enabled (`SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE`); directory junctions work without elevation but are local-volume directory-only reparse points ([learn.microsoft.com](https://learn.microsoft.com/en-us/windows/security/threat-protection/security-policy-settings/create-symbolic-links); [learn.microsoft.com/windows/win32/fileio/hard-links-and-junctions](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions)).
- **Git for Windows:** `core.symlinks` controls whether mode `120000` entries are checked out as symlinks or plain-text files containing the link target ([git-scm.com/docs/git-config](https://git-scm.com/docs/git-config)). Local verification on this Windows machine (`git version 2.56.1.windows.1`) confirmed `core.symlinks = false` in both `C:/Program Files/Git/etc/gitconfig` and repo `.git/config`.

**Bottom Line on Bridging:**
- If `.claude/skills/` is **gitignored** (local-only generated artifact per developer), either **Managed Copy** (safest) or **optional NTFS Junction** (space-saving, but watch `#68318` and repo relocation) can work without Admin.
- If migrated skills are **committed to Git** for a Windows team, **Managed Copy is the ONLY reliable option**; NTFS symlinks break under `core.symlinks = false`, and NTFS junctions cannot be committed portably (absolute paths + Git `lstat`/deletion hazards).

---

## Area 5: Audit of Current Repository Implementation

All files in [sync-y3maker-to-codex/](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex) and [sync-y3maker-to-claude/](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude) were audited line by line.

### 5.1 Shared Core (~80–85% Identical Today)

The following logic is functionally identical across both skills' `scripts/migration-lib.js` and `scripts/run-migration.js`:

1. **Workspace Safety Guard:** Rejects filesystem root, `os.homedir()`, and user-level harness home (`~/.codex` vs `~/.claude`) unless `--allow-unsafe-workspace` is set ([codex/migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L45-L76), [claude/migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L43-L74)).
2. **Text I/O & Binary Fallback:** `TEXT_SUFFIXES` (`.json`, `.md`, `.mdc`, `.ps1`, `.py`, `.toml`, `.txt`, `.yaml`, `.yml`), UTF-8 fatal -> GB18030 fatal decode with UTF-8 BOM strip, LF normalization, and raw-buffer fallback when a text-suffix file is actually binary ([codex/migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L9-L19), [L101-L162](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L101-L162), [L617-L637](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L617-L637); [claude/migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L9-L19), [L100-L161](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L100-L161), [L626-L643](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L626-L643)).
3. **3-Way Hash Manifest State Machine:** `decidePlanAction()` (`create`, `update`, `adopt`, `resolved`, `blocked`, `unchanged`) + `orphaned` retention when source disappears ([codex/migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L647-L745), [L836-L898](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L836-L898); [claude/migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L653-L751), [L847-L892](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L847-L892)).
4. **Legacy Filtering & Defaults:** Identical `SKILL_ITEM_EXCLUDES` (`y3-auto-test/.queue`, `y3-obj-gen/.claude-plugin`), `DEFAULT_OPENSPEC_DIRS` (`openspec/docs`, `openspec/reports`), `cmtmp` cleanup, and non-directory skill root skips (`README.md`, `install_skills.bat`) ([codex/migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L24-L29); [claude/migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L22-L27)).
5. **CLI & Interactive MCP Gate:** `run-migration.js` is ~95% line-for-line identical (only lines 80–81 prompt strings differ) ([codex/run-migration.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/run-migration.js#L77-L85); [claude/run-migration.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/run-migration.js#L77-L85)).

### 5.2 Precise Diff Matrix: Real Platform Divergences vs Code Drift Bugs

| Area | `sync-y3maker-to-codex` | `sync-y3maker-to-claude` | Classification |
| :--- | :--- | :--- | :--- |
| **Target Root & Manifest** | `.codex/` + `.codex/migration/y3maker-manifest.json`; tracks `.omx`, `AGENTS.md` ([migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L33), [L85-L95](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L85-L95)) | `.claude/` + `.claude/migration/y3maker-manifest.json`; tracks `.omc`, `CLAUDE.md`, `.mcp.json` ([migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L31), [L83-L94](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L83-L94)) | Genuine platform difference (candidate for unification under `.agents/`) |
| **`templates/` Discovery & Verification** | Resolves `.y3maker/templates` **or** `.codemaker/templates` (`resolveLegacyTreeRoot`); reports `.codemaker` in `inventory`; conditionally requires `.codex/templates` and scans it in `activeSurfaces` ([migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L21-L22), [L238-L248](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L238-L248), [L390-L398](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L390-L398); [verify-migration.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/verify-migration.js#L35-L40), [L171](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/verify-migration.js#L171)) | Only checks `.y3maker/templates` (misses `.codemaker/templates`); omits `templates` from `copied` initializer, `SKILL.md`, `migration-map.md`, and `verify-migration.js` `activeSurfaces` ([migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L20), [L430](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L430); [verify-migration.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/verify-migration.js#L52), [L139](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/verify-migration.js#L139)) | **Drift bug** between duplicated scripts |
| **`SKILL.md` Frontmatter Normalization** | Strips everything except `name` + `description`; verifier rejects any other key ([migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L342-L349); [verify-migration.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/verify-migration.js#L147-L156)) | Keeps `name`, `description`, and `allowed-tools` (rewriting legacy `tools:` -> `allowed-tools:`); verifier allows all 3 ([migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L330-L343); [verify-migration.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/verify-migration.js#L119-L128)) | Genuine platform policy difference (depends on local `codex-cli` test!) |
| **Text Path Rewriting** | `.codemaker` -> `.codex` only; special fixes in `y3-auto-test/{admin_daemon,send_command}.ps1` and `y3-obj-gen/SKILL.md` ([migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L518-L551)) | `.codemaker` -> `.claude` **and** `.codex` -> `.claude`; same 2 special fixes targeting `.claude` ([migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L529-L558)) | Genuine target-path difference (under `.agents/`, both would rewrite to `.agents`) |
| **MCP Format, Merging & Empty Guard** | Generates standalone TOML `[mcp_servers.<name>]` (`url`, `command`, `args`, `env`) to `.codex/config.toml` or `~/.codex/config.toml`; **does NOT merge existing TOML**, drops `headers`, no empty-`mcpServers` warning ([migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/migration-lib.js#L351-L387)) | Merges into existing JSON (`.mcp.json` or `~/.claude.json`), normalizes `type` (`streamableHttp`->`http`, `sse`, `stdio`), preserves `headers`, inspects empty `mcpServers` + emits `warnings` ([migration-lib.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/migration-lib.js#L345-L425)) | Genuine format difference + **feature drift** (Claude has merge, `headers`, and empty-MCP detection that Codex lacks) |
| **Verifier Reference Checks** | Strips ` §...` and `#...` before checking base file; `scripts/` resolves directly to skill root ([verify-migration.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/scripts/verify-migration.js#L276-L311)) | Skips any candidate containing `§` or ending in `/`; doesn't strip `#...`; `scripts/` checks skill root then falls back to `dirname(filePath)` ([verify-migration.js](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/scripts/verify-migration.js#L234-L266)) | **Drift bug** between duplicated verifiers |
| **Skill Packaging Metadata** | Own `SKILL.md` has `name`+`description` only; includes [agents/openai.yaml](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-codex/agents/openai.yaml); no `evals/` | Own `SKILL.md` adds `allowed-tools` ([SKILL.md](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/SKILL.md#L4)); includes [evals/evals.json](file:///C:/Users/wb.lixinyan03/orca/workspaces/y3maker-migration-skills-BAIMOoo/medaka/sync-y3maker-to-claude/evals/evals.json); no `agents/openai.yaml` | Genuine harness metadata difference |

---

## Summary of Items Marked "Unverified / Needs Local Test"

Before finalizing the architecture in `/grill-with-docs`, the following **5 concrete items** can be tested locally in under 5 minutes using the already-installed `codex-cli 0.172.0`, `claude 2.1.302`, and `agy 1.5.17`:

1. **`codex-cli 0.172.0` + `allowed-tools` in `SKILL.md`:** Does Codex silently ignore `allowed-tools:` in `.agents/skills/<name>/SKILL.md`, or does it reject the skill?
2. **`agy 1.5.17` standalone `.agents/mcp_config.json` vs `.agents/plugins/<name>/mcp_config.json`:** Local built-in docs omit `.agents/mcp_config.json`, while live `antigravity.google/docs/mcp` mentions it. Test whether `agy 1.5.17` actually loads standalone `.agents/mcp_config.json` or requires the plugin wrapper (and run `agy plugin validate` on the plugin wrapper).
3. **`claude 2.1.302` native `AGENTS.md` fallback & `.claude/rules/*.mdc`:** Confirm whether `claude 2.1.302` loads `AGENTS.md` when `CLAUDE.md` is absent (vs requiring `@AGENTS.md` in `CLAUDE.md`), and confirm whether `.claude/rules/*.mdc` is ignored by Claude Code.
4. **`claude 2.1.302` Windows directory junction behavior:** If considering an optional local-only junction bridge (`.claude/skills` -> `.agents/skills` or per-skill junctions), test both parent-dir junction and per-skill junction in `claude 2.1.302` CLI and slash-command discovery.
5. **`codex-cli 0.172.0` user-scope `~/.agents/skills/`:** Confirm whether `codex-cli 0.172.0` scans `~/.agents/skills/` in addition to `~/.codex/skills/` on Windows (relevant for self-installation of the migration skill itself).

---

## Key Decisions to Settle in `/grill-with-docs`

### Settled Facts (Hard Constraints from Primary Sources)
- **`.agents/skills/` is natively supported by Codex and Antigravity, NOT Claude Code** — a `.claude/skills/` projection/bridge is mandatory for Claude Code support.
- **NTFS Symlinks (`mklink /D`) are NOT viable for Windows teams** — they require Admin/Developer Mode and break under Git for Windows' default `core.symlinks = false`.
- **NTFS Junctions (`mklink /J`) cannot be safely committed to Git** — they require absolute paths and cause Git for Windows tracking/`lstat` hazards.
- **MCP configs cannot be unified into a single file** — Codex requires `.codex/config.toml` (TOML), Claude Code requires `.mcp.json` (JSON), and Antigravity requires `mcp_config.json` (JSON, plugin-wrapped or workspace-level pending test) with **no legacy SSE support**.
- **`.agents/rules/` (Antigravity active rules), `.claude/rules/` (Claude active rules), and `.codex/rules/` (Codex execpolicy) have conflicting semantics** — archived legacy `.y3maker/rules/*.mdc` must not collide with active rule directories.
- **`AGENTS.md` works natively in Codex (32 KiB cap) and Antigravity (24 KB/file cap), and bridges cleanly into Claude Code via `CLAUDE.md` (`@AGENTS.md`)** — keeping `AGENTS.md` <= 24 KB satisfies all three.

### Open Design Choices to Resolve
1. **Skill packaging topology:** Replace `sync-y3maker-to-codex` + `sync-y3maker-to-claude` with a single unified `sync-y3maker-to-agents` skill, OR keep thin harness-specific wrapper skills backed by one shared engine, OR add `sync-y3maker-to-agents` alongside existing skills for backward compatibility?
2. **Claude `.claude/skills/` bridge strategy:**
   - Default to **manifest-tracked one-way managed copy** (`.agents/skills/` -> `.claude/skills/`) so Windows + Git work out of the box?
   - Offer an opt-in `--claude-bridge junction` mode ONLY when `.claude/skills/` is `.gitignore`d?
3. **Canonical `SKILL.md` frontmatter policy (`allowed-tools`):**
   - If local test proves `codex-cli 0.172.0` ignores `allowed-tools`, keep `name` + `description` + `allowed-tools` in canonical `.agents/skills/*/SKILL.md` (identical across all 3 harnesses)?
   - If Codex rejects `allowed-tools`, strip it in `.agents/skills/` and inject/preserve it ONLY when projecting to `.claude/skills/`?
4. **Canonical location for legacy non-skill Y3Maker archives (`knowledge/`, `memory/`, `rules/*.mdc`, `templates/`):**
   - Place under `.agents/knowledge/`, `.agents/memory/`, `.agents/templates/`, and **relocate legacy `.y3maker/rules/*.mdc`** to `.agents/legacy-rules/` (or `.agents/archive/rules/`) so Antigravity never mistakes them for active `.agents/rules/*.md`?
   - Or keep all 4 trees under `.agents/<tree>` with a guardrail ensuring `.mdc` files are never auto-converted to `.md`?
5. **Multi-harness MCP generation & `--targets` CLI UX:**
   - Support `--targets codex,claude,agy` (or auto-detect installed/configured harnesses) with explicit `--mcp-scope project|user|skip`?
   - For Antigravity project MCP, generate `.agents/plugins/y3maker-mcp/{plugin.json,mcp_config.json}` (guaranteed by both local and live docs) or standalone `.agents/mcp_config.json` (if local test confirms `agy 1.5.17` loads it)?
   - How should legacy `"type": "sse"` MCP servers be handled for Antigravity (skip with explicit warning + `mcp-remote` hint, or auto-wrap)?
   - Upgrade Codex MCP writer from full-file overwrite to safe TOML section merge (matching Claude's existing JSON merge + empty-`mcpServers` warning)?
6. **`AGENTS.md` / `CLAUDE.md` scaffolding policy:**
   - Continue keeping `AGENTS.md` / `CLAUDE.md` condensation strictly manual (as today), OR allow the script to optionally scaffold a 1-line `CLAUDE.md` containing `@AGENTS.md` when `AGENTS.md` exists and `CLAUDE.md` does not?
7. **Target repo `.gitignore` & drift cleanup:**
   - Should the migration report recommend `.gitignore` rules if `.claude/skills/` is generated as a local mirror, vs committing both `.agents/` and `.claude/`?
   - Fix the existing `templates/` (`.codemaker/templates` fallback + `activeSurfaces`) and `verify-migration.js` (`§`/`#` normalization) drift bugs in the shared engine.
