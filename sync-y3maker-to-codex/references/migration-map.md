# 迁移映射（已废弃 / Deprecated）

> **⚠️ 已废弃（Deprecated — 冻结维护）**：`sync-y3maker-to-codex` 已停止新增功能，仅保留以兼容既有安装链接。请改用统一多 Harness 技能 [`sync-y3maker-to-agents`](../../sync-y3maker-to-agents/SKILL.md) 及新版参考文档 [`sync-y3maker-to-agents/references/migration-map.md`](../../sync-y3maker-to-agents/references/migration-map.md)。

## 脚本入口

- `scripts/run-migration.js inventory`
- `scripts/run-migration.js apply`
- `scripts/verify-migration.js`

## 自动处理内容

| 遗留面 | 目标面 | 脚本处理 |
| --- | --- | --- |
| `.y3maker/knowledge/` | `.codex/knowledge/` | 复制副本 |
| `.y3maker/memory/` | `.codex/memory/` | 复制副本，作为归档 |
| `.y3maker/rules/*.mdc` | `.codex/rules/*.mdc` | 复制副本，作为参考 |
| `.y3maker/skills/` | `.codex/skills/` | 复制后规范化 `SKILL.md` |
| `.y3maker/templates/` 或旧 `.codemaker/templates/` | `.codex/templates/` | 复制副本，并参与 manifest 重复同步/冲突保护 |
| `.y3maker/mcp_settings.json` | 显式选择的项目级 `.codex/config.toml`、用户级 `~/.codex/config.toml`，或跳过 | 转换为 `[mcp_servers.*]`；没有交互选择或 `--mcp-scope project\|user\|skip` 时拒绝修改 MCP 配置 |
| `openspec/docs` / `openspec/reports` 缺失 | 工作区目录 | 自动创建 |
| `.codex/cmtmp` 等临时目录 | 不保留 | 迁移完成后自动清理 |

## 自动过滤内容

默认不保留这些旧体系副产物：

- `.y3maker/skills/README.md`
- `.y3maker/skills/install_skills.bat`
- `.y3maker/skills/y3-auto-test/.queue`
- `.y3maker/skills/y3-obj-gen/.claude-plugin`

## 自动规范化内容

`run-migration.js apply` 会自动做这些修正：

- 去掉 `SKILL.md` 的 UTF-8 BOM
- 只保留 `name` 和 `description` 两个 frontmatter 字段
- 用目录名覆盖 skill `name`
- 把 `.codemaker` 路径批量改成 `.codex`
- 修正 `y3-auto-test` 中残留的旧自引用路径
- 发现 `.y3maker/mcp_settings.json` 时，要求用户选择 MCP 配置迁移目标；推荐项目级配置以规避 Codex App 对用户级 MCP 配置识别不稳定的问题

## 重复同步规则

`apply` 也是首次迁移后的重复同步入口。

- 基线状态写入 `.codex/migration/y3maker-manifest.json`
- 源变了、目标没变：自动更新
- 源和目标都变了：保留目标，报告 `blocked`
- 源文件消失：保留目标，报告 `orphaned`

## 保留人工判断的内容

以下内容继续由 Codex 结合项目上下文判断，不写死进固定脚本：

- 哪些规则应该浓缩进根目录 `AGENTS.md`
- 哪些 memory 只是归档，哪些事实值得转存至宿主的长期记忆系统
- 哪些遗留 skill / 资源虽然能复制，但不值得继续保留
- 验收发现的缺失依赖中，哪些应该补，哪些应该直接报告
- `blocked` / `orphaned` 项的后续处理方式

## 验收清单

`verify-migration.js` 至少确认：

- `.codex/knowledge`、`.codex/memory`、`.codex/rules`、`.codex/skills`、`.codex/templates` 存在
- 每个迁移后的 skill 都有 `SKILL.md`
- `SKILL.md` frontmatter 合法且没有 BOM
- 迁移副本里没有残留 `.codemaker` / `.y3maker` 活跃引用；旧模板文档中的 `.codemaker/templates/...` 被改写为 `.codex/templates/...`
- 按迁移时选择确认项目级 `.codex/config.toml`、用户级 `~/.codex/config.toml`，或显式跳过记录；用户级配置不得被隐式修改
- manifest 中没有待人工处理的 `blocked` / `orphaned` 项被静默忽略
- 常见路径引用失效会被列出，而不是静默跳过
