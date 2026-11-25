# 多 Harness 统一迁移映射参考

本文档是 `sync-y3maker-to-agents` 的权威参考映射，涵盖 **Canonical Store**（`.agents/`）、四端 **Harness Adapter**、**Migration Manifest** 状态机、旧版过渡检测与验收规则。

## 1. CLI 入口与参数

| 脚本 | 子命令 / 参数 | 说明 |
| --- | --- | --- |
| `scripts/run-migration.js` | `inventory [--workspace .] [--pretty]` | 只读盘点 `.y3maker/`、`.codemaker/templates`、MCP 配置、当前 manifest 与旧版 `.codex/`/`.claude/` 过渡状态 |
| `scripts/run-migration.js` | `apply [--workspace .] [--targets ...] [--mcp-scope project\|user\|skip] [--dry-run] [--pretty] [--allow-unsafe-workspace]` | 首次迁移或重复同步；`--dry-run` 完整预览且不写入磁盘 |
| `scripts/verify-migration.js` | `[--workspace .] [--targets ...] [--mcp-scope project\|user\|skip] [--pretty] [--allow-unsafe-workspace]` | 端到端验收；省略 `--targets` / `--mcp-scope` 时自动复用 manifest 记录 |

`--targets` 可选值：`codex`、`claude`、`antigravity`（别名 `agy`）、`dsh`、`all`（展开为 `["antigravity", "claude", "codex", "dsh"]`）。

## 2. Canonical Store（`.agents/`）资产映射

| Legacy Source（遗留真源） | Canonical Store（共享正本） | 自动处理方式 |
| --- | --- | --- |
| `.y3maker/knowledge/` | `.agents/knowledge/` | 复制副本并规范化文本路径 |
| `.y3maker/memory/` | `.agents/memory/` | 复制副本并规范化文本路径 |
| `.y3maker/rules/*.mdc` | `.agents/rules/*.mdc` | 原位保留 `.mdc` 后缀与目录，维持技能内 `../../rules/*.mdc` 相对引用，避免与 Antigravity 活跃规则 `.agents/rules/*.md` 冲突 |
| `.y3maker/skills/<name>/` | `.agents/skills/<name>/` | 复制技能目录、过滤旧副产物、规范化 `SKILL.md` frontmatter（仅保留 `name` 与 `description`） |
| `.y3maker/templates/`（若无则回退 `.codemaker/templates/`） | `.agents/templates/` | 复制模板副本、规范化路径并纳入 manifest 跟踪 |
| `openspec/docs`、`openspec/reports` | 工作区 `openspec/` | 缺失时自动补建 |
| `.agents/cmtmp` | 不保留 | 正式 `apply` 阶段自动清理 |
| 项目根目录 `AGENTS.md` / `CLAUDE.md` | **绝不触碰** | 不创建、不覆盖、不自动拼接 |

### 2.1 自动过滤的旧体系副产物

- `.y3maker/skills/README.md` 与技能根目录下其他顶层文件（如 `install_skills.bat`）
- `.y3maker/skills/y3-auto-test/.queue`
- `.y3maker/skills/y3-obj-gen/.claude-plugin`

### 2.2 编码、路径与 Frontmatter 规范化

- **编码与换行**：文本后缀（`.json` `.md` `.mdc` `.ps1` `.py` `.toml` `.txt` `.yaml` `.yml`）优先 UTF-8（严格）解码，失败后回退 GB18030，剥离 UTF-8 BOM 并统一输出 LF；若 `.json` 等文本后缀文件实际为二进制字节流（解码抛出 `ERR_UNABLE_TO_DECODE`），则自动回退原样二进制复制。`SKILL.md` frontmatter 语法错误不会被二进制回退吞掉，会直接报错。
- **路径改写**：将 `.codemaker`、`.codex`、`.y3maker/`、`.y3maker\`、`<agent>/`、`<agent>\`、`<codemaker>/`、`<codemaker>\` 统一改写为 `.agents` 对应路径。
- **历史特殊修复**：
  - `y3-auto-test/{admin_daemon,send_command}.ps1`：将 `.\.agents\skills\desktop-automation` 修复为 `.\.agents\skills\y3-auto-test`。
  - `y3-obj-gen/SKILL.md`：将保存临时文件至 `.agents/cmtmp/` 的提示更新为一次性临时文件说明。
- **Frontmatter 差异**：
  - `.agents/skills/<name>/SKILL.md`：强制 `name: <目录名>`，仅保留 `name` 与 `description`（保留多行折叠/字面量格式）。
  - `.claude/skills/<name>/SKILL.md`（仅启用 `claude` 时）：在规范化基础上，如源 `.y3maker/skills/<name>/SKILL.md` 声明了 `allowed-tools:` 或 `tools:`，仅在投影副本中保留规范化后的 `allowed-tools:`（`tools:` 自动转为 `allowed-tools:`）。

## 3. 四端 Harness Adapter 映射表

| Harness | Skills 发现方式 | `project` 范围 MCP 落点 | `user` 范围 MCP 落点 | MCP 格式、合并与兼容说明 |
| --- | --- | --- | --- | --- |
| **Codex**（`codex`） | 原生读取 `.agents/skills/`（不复制） | `.codex/config.toml` | `~/.codex/config.toml` | 安全 TOML 区块合并（按 `[mcp_servers.<name>]` 及子表 `.env`/`.http_headers` 原位更新或追加，完整保留 preamble、注释、非受管段落与其他 MCP 服务）；特殊服务名自动加引号；空 `mcpServers` 或无有效服务时告警且不覆写 |
| **Claude Code**（`claude`） | **Skill Projection** 单向投影至 `.claude/skills/`（不复制非 skill 目录） | `.mcp.json` | `~/.claude.json` | 安全 JSON 合并（仅写入顶层 `mcpServers` 受管键，保留所有其他用户键与非受管服务）；支持 `stdio`/`http`/`sse`（`streamableHttp` 规范为 `http`）与 `headers`；空 `mcpServers` 输出明确警告 |
| **Antigravity**（`antigravity` / `agy`） | 原生读取 `.agents/skills/`（不复制） | `.agents/plugins/y3maker-mcp/plugin.json` + `mcp_config.json` | `~/.gemini/config/mcp_config.json` | 安全 JSON 合并，保留非受管服务；`plugin.json` 必填 `name` 与 `version`（通过 `agy plugin validate --strict`）；`mcp_config.json` **不输出 `type` 字段**；**不支持旧版 HTTP+SSE**（`type: "sse"` 或 `/sse` 路径），自动跳过并在 `warnings` 中提示切换 `/mcp` 或使用 `mcp-remote` 桥接；若无兼容服务则不生成空插件 |
| **DSH**（`dsh`） | 原生读取 `.agents/skills/`（不复制） | `.dsh/cordis.patch.yml`（需 `--patch` 加载） | `~/.dsh/cordis.patch.yml`（自动加载） | 零依赖安全 YAML 合并（顶层为 Cordis 补丁序列 `- insert:`，按受管 `id: "y3maker-mcp-<serverName>"` 原位更新/追加 `@deepseek-ai/dsh-mcp-client`，保留 `cmhub-hooks-claude-code` 等既有插件、注释与顶层覆写）；`serverName` 自动清洗为 `[A-Za-z0-9_-]{1,32}`；跳过旧版 SSE 并告警；`project` 范围在 `mcp.hints` 中附带 `dsh --patch .dsh/cordis.patch.yml` 启动提示 |

### 3.1 Claude Skill Projection 跨目录相对路径回指规则

启用 `claude` 目标将 `.agents/skills/<name>/...` 投影到 `.claude/skills/<name>/...` 时，自动改写指向 `.agents/` 兄弟共享目录的相对路径（含 `../../` 及更深层级 `../../../`、正斜杠与反斜杠）：

- `../../rules/...` → `.agents/rules/...`
- `../../memory/...` → `.agents/memory/...`
- `../../knowledge/...` → `.agents/knowledge/...`
- `../../templates/...` → `.agents/templates/...`
- `../../spec-config.json` → `.agents/spec-config.json`

同级技能间的相对引用（如 `../other-skill/SKILL.md`）保持不变；`.agents/skills/` 正本内容不受影响。

## 4. Migration Manifest 状态机

清单位置：`.agents/migration/y3maker-manifest.json`（记录 `targets`、`files` 与 `mcp` 汇总）。

| 场景 | 同步动作 | 目标状态 | 是否写盘 |
| --- | --- | --- | --- |
| 目标首次不存在 | `create` | `managed` | 是 |
| 目标已存在、无历史基线、且非 `mergeExisting` 安全合并项 | `blocked` | `blocked` | 否（保护已有文件） |
| 目标已存在、无历史基线、但为 MCP 安全合并项（`mergeExisting: true`） | `update` | `managed` | 是（保留既有非受管内容） |
| 目标磁盘哈希已等于渲染哈希（无基线 / 此前 `blocked` / 已一致） | `adopt` / `resolved` / `unchanged` | `managed` | 否 |
| 仅上游变更，目标未改 | `update` | `managed` | 是 |
| 目标在本地被手工修改（合并类 MCP 仅比对受管切片 `managedHash`，修改无关字段叠加源更新仍可安全合并） | `blocked` | `blocked` | 否（保护本地改动） |
| 上游源文件被删除（且非 MCP Scope 切换或取消启用宿主） | `orphaned` | `orphaned` | 否（保留目标文件） |
| 存在 `.y3maker/mcp_settings.json` 且用户显式切换 `--mcp-scope`（如 `project` ↔ `user` ↔ `skip`） | 释放旧范围追踪并写入 `mcp.hints` | 旧文件保留在磁盘 | 否（绝不静默删除原配置） |
| 收缩 `--targets` 取消启用某个宿主（且对应 `.y3maker` 源文件仍存在） | 释放旧宿主追踪并写入顶层 `hints` | 旧文件保留在磁盘 | 否（不误报 `orphaned`，绝不静默删除） |

## 5. 旧版 `.codex/` / `.claude/` 过渡盘点（`legacyTransition`）

`inventory` 与 `apply` 均会只读检查 `.codex/migration/y3maker-manifest.json` 与 `.claude/migration/y3maker-manifest.json`：

- `files.unmodified`：与旧版 manifest 基线一致的文件。
- `files.modified`：磁盘哈希与旧基线不一致或历史处于 `blocked` 的文件（存在本地手工改动）。
- `files.orphaned`：旧版清单中已处于 `orphaned` 的历史文件。
- `files.missing`：已被用户删除的旧受管文件。
- `files.untracked`：旧子目录中未被旧版 manifest 记录的本地额外文件。
- `userScopedFiles`：旧清单中的用户级文件（位于工作区外，不归入项目目录清理候选）。
- `activeProtectedDirectories` / `activeProtectedPaths`：当前已启用宿主正在活跃使用的路径（如启用 `claude` 时的 `.claude/skills` 与 `.mcp.json`，启用 `codex` 时的 `.codex/config.toml`），绝不可误删。
- `manualReviewRequired`：清理前必须逐一人工核对合并的文件清单。
- `safeToCleanDirectories`：未检测到手工改动、未跟踪文件且非活跃保护路径的旧子目录候选清单。

## 6. `verify-migration.js` 验收清单

| 校验面 | 校验内容 | 典型 `issue.type` |
| --- | --- | --- |
| Canonical Store 目录 | `.agents/{knowledge,memory,rules,skills}`（有模板源或模板记录时含 `templates`）；禁止残留 `.agents/cmtmp` | `missing-path`、`extra-temp-dir` |
| Manifest 状态 | 禁止未处理的 `blocked` 或 `orphaned` 条目 | `merge-blocked`、`orphaned-target` |
| `.agents/skills/` | 每个技能存在 `SKILL.md`、无 UTF-8 BOM、frontmatter 合法、`name` 与目录名一致、仅允许 `name` 与 `description` | `missing-skill`、`bom`、`frontmatter` |
| 活跃文本面扫描 | `.agents/{knowledge,rules,skills,templates}` 无残留 `.codemaker`、`.codex`、`.y3maker/`、`<agent>/`、`<codemaker>/`；反引号引用路径存在（自动规范化 `§`/`#`，优先从技能根解析 `scripts/`，豁免自身技能 `sync-y3maker-to-agents`） | `stale-path`、`missing-reference` |
| Claude 适配层 | `.claude/skills/` 存在且覆盖全部来自 `.y3maker/skills/` 或清单跟踪的正本技能；无 BOM；仅允许 `name`/`description`/`allowed-tools`；无未改写的 `../../rules/` 等跨目录相对引用；按 `mcpScope` 校验 `.mcp.json` / `~/.claude.json` 合法 JSON 及启用服务 | `missing-path`、`missing-skill`、`stale-path`、`invalid-mcp-config`、`missing-mcp-server` |
| Codex 适配层 | 按 `mcpScope` 校验 `.codex/config.toml` / `~/.codex/config.toml` 存在、TOML 语法合法且包含全部受管 `[mcp_servers.*]` 区块及 `command`/`url` | `missing-path`、`invalid-mcp-config` |
| Antigravity 适配层 | 按 `mcpScope` 校验插件 `plugin.json`（含 `name`、`version`）与 `mcp_config.json` 或 `~/.gemini/config/mcp_config.json`（合法 JSON、包含兼容服务、禁止出现 `type` 字段） | `missing-path`、`invalid-mcp-config` |
| DSH 适配层 | 按 `mcpScope` 校验 `.dsh/cordis.patch.yml` / `~/.dsh/cordis.patch.yml` 存在、YAML 序列结构合法、受管 `@deepseek-ai/dsh-mcp-client` 条目完整且无重复 `id` | `missing-mcp-config`、`missing-mcp-server`、`invalid-mcp-config` |
| MCP Scope 门禁 | 存在 `.y3maker/mcp_settings.json` 但未记录或传入任何 `mcpScope` 时直接阻断 | `mcp-target-unselected` |

## 7. 保留给人工判断的事项

- 是否及如何将高价值项目规范人工浓缩到项目根目录 `AGENTS.md` 或 `CLAUDE.md`。
- `.agents/memory/` 中的归档事实哪些值得转存至各自宿主的长期记忆系统。
- `blocked` / `orphaned` 文件的合并或清理决策。
- `legacyTransition` 报告中旧版 `.codex/` / `.claude/` 子目录的核对与手动清理时机。
- 验收发现的 `.y3maker/` 原始缺失外部依赖应如何补齐或向项目维护者反馈。
