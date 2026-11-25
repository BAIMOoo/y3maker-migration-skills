---
status: accepted
---

# 采用 `.agents/` 共享正本加极薄宿主适配层架构

为了在一次迁移中同时支持 Codex、Claude Code、Antigravity 与 DSH，同时避免把整套 Y3Maker 资产按宿主复制四份导致清单分裂与内容漂移，`sync-y3maker-to-agents` 将所有跨宿主共享资产写入唯一的 **Canonical Store**（`.agents/`），仅为各宿主无法从 `.agents/` 原生读取的约定生成极薄的 **Harness Adapter**。针对目前不原生扫描 `.agents/skills/` 的 Claude Code，其适配层采用受 **Migration Manifest** 跟踪的单向 **Skill Projection**（复制到 `.claude/skills/`），而不使用 Windows 符号链接或 NTFS 目录联接。

## 备选方案

- **NTFS 符号链接（`mklink /D`）**：放弃。Windows 下需要管理员权限或开发者模式，且 Git for Windows 默认 `core.symlinks = false`，跨机器检出后链接会损坏为纯文本文件。
- **NTFS 目录联接（`mklink /J`）**：放弃。目录联接强制绑定绝对路径（移动工作区即失效），放进 Git 跟踪树存在 `lstat` 异常风险，且 Claude Desktop Windows 存在 `/` 菜单漏显链接技能的问题。
- **按宿主各自完整迁移**：放弃。会导致多份 `.y3maker` 副本与多份 manifest 并存，每次更新需重复迁移多次且极易漂移。

## 影响

- Codex、Antigravity、DSH 直接原生消费 `.agents/skills/`，零重复复制。
- Claude Code 在 `.claude/skills/` 获得确定、跨平台、Git 安全且带 `blocked`/`orphaned` 保护的技能投影，并在投影副本中按需保留源 skill 的 `allowed-tools`，同时保持 `.agents/skills/` 仅含纯净的 `name` 与 `description`。
- 各宿主的 MCP 配置隔离在各自原生路径（`.codex/config.toml`、`.mcp.json`、`.agents/plugins/y3maker-mcp/`、`.dsh/cordis.patch.yml` 或用户级配置），由统一的显式 `--mcp-scope` 控制。
