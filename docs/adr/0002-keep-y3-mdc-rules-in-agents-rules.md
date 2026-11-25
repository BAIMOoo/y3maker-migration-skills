---
status: accepted
---

# 将 Y3 的 `.mdc` 活跃规则保留在 `.agents/rules/` 原位

迁移后的 `.y3maker/rules/*.mdc` 保留在 `.agents/rules/`，而不是挪到 `.agents/legacy-rules/` 等归档目录。经对真实 Y3 项目（`anhinga`）核查，这些 `.mdc` 文件并非历史参考归档，而是被 `y3-lua-pipeline`、`y3-auto-test`、`y3-lua-review`、`y3-ui-generator` 等技能通过相对路径（如 `../../rules/api-safety.mdc`、`../../rules/mcp-rules.mdc`）直接引用的活跃规则文档，改名目录会导致技能引用断裂。

## 备选方案

- **挪到 `.agents/legacy-rules/`**：放弃。会直接破坏现有 Y3 技能中的 `../../rules/*.mdc` 相对路径引用。
- **将 `rules/`、`memory/`、`knowledge/`、`templates/` 同步复制进 `.claude/`**：放弃。违背 `.agents/` 作为单一 **Canonical Store** 的设计原则。

## 影响

- Antigravity 的活跃规则扫描仅匹配 `.agents/rules/*.md`，保留 `.mdc` 后缀既不会与 Antigravity 自动加载冲突，又能保证 `.agents/skills/*/` 下的 `../../rules/*.mdc` 相对引用全部有效。
- 在执行 Claude Code 的 **Skill Projection**（`.agents/skills/` → `.claude/skills/`）时，必须自动将跨目录相对引用（`../../rules/`、`../../memory/`、`../../knowledge/`、`../../templates/`、`../../spec-config.json`）改写为 `.agents/...`，确保 Claude 技能直接读取同一份共享资产。
