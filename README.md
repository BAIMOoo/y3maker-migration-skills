# Y3Maker 迁移 Skills

本仓库提供将遗留 Y3Maker / CodeMaker 项目资产（**Legacy Source**，即 `.y3maker/`）安全迁移至现代多 **Harness**（运行宿主）原生目录结构的自包含技能包。

## 推荐入口

| Skill | 状态 | 覆盖 Harness（运行宿主） | 适用场景 |
| --- | --- | --- | --- |
| [`sync-y3maker-to-agents`](./sync-y3maker-to-agents/) | **唯一推荐** | Codex、Claude Code、Antigravity（`agy`）、DSH | 一次迁移到项目内共享正本 **Canonical Store**（`.agents/`），并按 `--targets` 生成各宿主极薄 **Harness Adapter**（含 Claude **Skill Projection**、四端安全 MCP 合并与旧版 `.codex/`/`.claude/` 过渡盘点）。 |
| [`sync-y3maker-to-codex`](./sync-y3maker-to-codex/) | Deprecated（冻结维护） | Codex（单宿主） | 历史单宿主入口，保留目录以兼容既有安装 URL；请迁移至 `sync-y3maker-to-agents`。 |
| [`sync-y3maker-to-claude`](./sync-y3maker-to-claude/) | Deprecated（冻结维护） | Claude Code（单宿主） | 历史单宿主入口，保留目录以兼容既有安装 URL；请迁移至 `sync-y3maker-to-agents`。 |

### 核心架构与安全边界

`sync-y3maker-to-agents` 采用 **`.agents/` 共享正本 + 极薄宿主适配层** 架构（详见 [ADR-0001](./docs/adr/0001-canonical-agents-store-with-thin-adapters.md)、[ADR-0002](./docs/adr/0002-keep-y3-mdc-rules-in-agents-rules.md) 与 [GLOSSARY.md](./GLOSSARY.md)）：

- **唯一共享正本**：将 `.y3maker/` 的 `knowledge`、`memory`、`rules`（`.mdc` 原位保留在 `.agents/rules/`）、`skills` 与 `templates`（含 `.codemaker/templates` 回退）统一迁移至 `.agents/`，由单一 **Migration Manifest**（`.agents/migration/y3maker-manifest.json`）维护三态同步与冲突保护。Codex、Antigravity 与 DSH 直接原生读取 `.agents/skills/`。
- **按需生成宿主适配层**：
  - **Codex**：直接复用 `.agents/skills/`；安全 TOML 区块合并写入 `.codex/config.toml` 或 `~/.codex/config.toml`。
  - **Claude Code**：通过受清单跟踪的单向 **Skill Projection** 将 `.agents/skills/` 投影至 `.claude/skills/`（跨目录相对引用回指 `.agents/`，仅在投影副本保留规范化后的 `allowed-tools`）；安全合并 `.mcp.json` 或 `~/.claude.json`。
  - **Antigravity（`agy`）**：直接复用 `.agents/skills/`；项目级生成符合 `agy plugin validate --strict` 的 `.agents/plugins/y3maker-mcp/`，用户级安全合并 `~/.gemini/config/mcp_config.json`；遇到旧版 HTTP+SSE 服务自动跳过并输出 `mcp-remote` 桥接告警。
  - **DSH**：直接复用 `.agents/skills/`；安全合并 `@deepseek-ai/dsh-mcp-client` 至 `~/.dsh/cordis.patch.yml`（用户级自动加载）或 `.dsh/cordis.patch.yml`（项目级，附 `dsh --patch .dsh/cordis.patch.yml` 启动提示）。
- **统一安全边界**：
  - 严格保持 **Legacy Source**（`.y3maker/`）只读。
  - 绝不创建、覆盖或修改项目根目录的 `AGENTS.md` 或 `CLAUDE.md`。
  - 绝不自动删除或改写旧版 `.codex/` / `.claude/` 迁移历史副本，只在盘点与迁移报告中提供 `legacyTransition` 核对与手动清理建议。
  - 存在 `.y3maker/mcp_settings.json` 时必须显式选择统一 **MCP Scope**（`project` / `user` / `skip`），禁止隐式修改全局配置。
  - 零外部 npm 依赖，纯 Node.js 标准库实现，单目录自包含。

## 仓库结构

```text
sync-y3maker-to-agents/    # 唯一推荐的多 Harness 统一迁移技能包（自包含）
sync-y3maker-to-codex/     # Deprecated（冻结维护，兼容旧安装 URL）
sync-y3maker-to-claude/    # Deprecated（冻结维护，兼容旧安装 URL）
tests/                     # 零依赖 Node.js 端到端回归测试套件
docs/adr/                  # 架构决策记录（ADR-0001 / ADR-0002）
GLOSSARY.md                # 项目领域术语表
```

## 安装（推荐安装 `sync-y3maker-to-agents`）

建议直接在对应 **Harness** 中发送安装指令，由宿主按当前环境完成安装与识别校验；也可直接复制整个 `sync-y3maker-to-agents/` 目录到对应宿主的 skills 目录。

### Codex

在 Codex 中发送：

```text
请从 GitHub 仓库 https://github.com/BAIMOoo/y3maker-migration-skills 安装 sync-y3maker-to-agents skill，并确认安装后可以被当前 Codex 环境识别。
```

> 自包含复制位置：用户级 `~/.agents/skills/sync-y3maker-to-agents/`（或 `~/.codex/skills/sync-y3maker-to-agents/`），项目级 `.agents/skills/sync-y3maker-to-agents/`。

### Claude Code

在 Claude Code 中发送：

```text
请从 GitHub 仓库 https://github.com/BAIMOoo/y3maker-migration-skills 安装 sync-y3maker-to-agents skill，并确认安装后可以被当前 Claude Code 环境识别。
```

> 自包含复制位置：用户级 `~/.claude/skills/sync-y3maker-to-agents/`，项目级 `.claude/skills/sync-y3maker-to-agents/`。

### Antigravity（`agy`）

在 Antigravity 中发送：

```text
请从 GitHub 仓库 https://github.com/BAIMOoo/y3maker-migration-skills 安装 sync-y3maker-to-agents skill，并确认安装后可以被当前 Antigravity 环境识别。
```

> 自包含复制位置：用户级 `~/.gemini/config/skills/sync-y3maker-to-agents/`，项目级 `.agents/skills/sync-y3maker-to-agents/`。

### DSH（DeepSeek Harness）

在 DSH 中发送：

```text
请从 GitHub 仓库 https://github.com/BAIMOoo/y3maker-migration-skills 安装 sync-y3maker-to-agents skill，并确认安装后可以被当前 DSH 环境识别。
```

> 自包含复制位置：项目级 `.agents/skills/sync-y3maker-to-agents/`（或对应环境配置的用户级 skills 目录）。

如果你的 **Harness** 支持项目级 skill，也可在安装提示中补充“安装到当前项目级目录”；否则默认安装到用户级 skills 目录即可。

## 使用方式

阅读 [`sync-y3maker-to-agents/SKILL.md`](./sync-y3maker-to-agents/SKILL.md)，按固定四步执行：

```text
inventory -> dry-run -> apply -> verify
```

示例（假设技能已安装到 `<skill-dir>`）：

```powershell
# 1. 盘点工作区与旧版 .codex/ / .claude/ 迁移状态
node "<skill-dir>/scripts/run-migration.js" inventory --workspace "." --pretty

# 2. 预览四端迁移计划（零落盘）；也可按需传子集如 --targets codex,agy
node "<skill-dir>/scripts/run-migration.js" apply --workspace "." --targets all --mcp-scope project --dry-run --pretty

# 3. 确认后正式迁移或重复同步
node "<skill-dir>/scripts/run-migration.js" apply --workspace "." --targets all --mcp-scope project --pretty

# 4. 执行全量端到端验收（自动复用 manifest 记录的 targets 与 mcpScope）
node "<skill-dir>/scripts/verify-migration.js" --workspace "." --pretty
```

如果迁移时选择了 `--mcp-scope user` 或 `--mcp-scope skip`，`verify` 会自动从 `.agents/migration/y3maker-manifest.json` 读取对应范围，也可通过 `--mcp-scope` 显式覆写校验。

## 从旧版单宿主技能迁移

如果你之前安装或使用过已废弃的 `sync-y3maker-to-codex` 或 `sync-y3maker-to-claude`：

1. 在你的 **Harness** 中安装 `sync-y3maker-to-agents`。
2. 在目标 Y3 工作区运行 `inventory`：`legacyTransition` 会自动读取旧版 `.codex/migration/y3maker-manifest.json` 与 `.claude/migration/y3maker-manifest.json`，只读比对哈希并区分可安全评估清理的旧子目录与被本地手工改动过的 `manualReviewRequired` 文件。
3. 运行 `apply --targets ... --mcp-scope ...` 建立 `.agents/` **Canonical Store** 与新版适配层（脚本绝不删除或破坏历史 `.codex/` / `.claude/` 文件，遇到已有差异的 `.claude/skills/` 文件会保守标记 `blocked`）。
4. 核对并合并 `manualReviewRequired` 中的手工改动，通过 `verify` 后，再按 `safeToCleanDirectories` 与 `activeProtectedPaths` 提示手动清理不再需要的旧版子目录。

## 开发与测试

本仓库保持零外部 npm 依赖，使用 Node.js 内置测试运行器执行全部端到端回归测试（在隔离临时工作区与隔离假用户主目录中运行，绝不触碰真实用户主目录）：

```powershell
node --test tests/*.test.js
```

开发约定：

- 所有文档、注释与用户提示保持中文，并遵循 [GLOSSARY.md](./GLOSSARY.md) 术语。
- `sync-y3maker-to-agents/` 目录必须保持自包含（不依赖仓库根目录或外部包），方便直接复制安装。
- 旧版 `sync-y3maker-to-codex/` 与 `sync-y3maker-to-claude/` 已进入冻结维护状态，不再回填新特性，也不要删除或重命名其目录以免破坏既有安装链接。

## 不应提交的内容

请不要提交：

- 个人配置文件
- 真实项目的 `.y3maker/`、`.agents/`、`.codex/`、`.claude/`、`.dsh/`、`.omx/`、`.omc/`
- 迁移生成的 manifest
- 日志、临时文件、密钥或 token
