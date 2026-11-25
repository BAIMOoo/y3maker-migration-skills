---
name: sync-y3maker-to-agents
description: 将遗留的 Y3Maker / CodeMaker 项目资产（.y3maker/）统一迁移到共享正本 Canonical Store（.agents/），并按需生成 Codex、Claude Code、Antigravity 与 DSH 的极薄宿主适配层（Harness Adapter）。完整说明文档将在后续完善。
---

# `sync-y3maker-to-agents`（占位文档）

本技能以 `.agents/` 作为项目内唯一的 **Canonical Store**，通过 `scripts/run-migration.js` 执行 `inventory` / `apply` 迁移与重复同步，并通过 `scripts/verify-migration.js` 执行端到端验收。完整操作指引与多宿主迁移映射说明将在 Ticket #8 补充。
