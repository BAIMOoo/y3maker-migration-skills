# Y3Maker 迁移术语表

用于统一本仓库在将遗留 Y3Maker / CodeMaker 项目资产迁移至多 Harness 共享目录结构时的核心概念命名。

## 术语定义

**Legacy Source（遗留真源）**:
Y3 项目中只读的 `.y3maker/` 目录，是首次迁移与后续重复同步的唯一上游真源。
_Avoid_: 旧目录、老工程、源仓库

**Canonical Store（共享正本）**:
Y3 项目中与具体 Harness 无关的 `.agents/` 共享目录，集中存放唯一一份迁移后的 skills、活跃 `.mdc` 规则、knowledge、memory、templates 及迁移基线状态。
_Avoid_: 公共目录、通用目录、共享文件夹

**Harness（运行宿主）**:
支持发现项目 skills、规则与 MCP 配置的 AI 编码代理运行时，本仓库首批覆盖 Codex、Claude Code、Antigravity 与 DSH（DeepSeek Harness）。
_Avoid_: IDE、平台、客户端、工具

**Harness Adapter（宿主适配层）**:
在 Canonical Store 之外生成的极薄平台专属输出层，仅用于承载某个 Harness 无法直接从 `.agents/` 读取的约定（例如 MCP 配置或 Claude 技能投影）。
_Avoid_: 包装器、插件壳、镜像层

**Skill Projection（技能投影）**:
受 Migration Manifest 跟踪的单向副本同步机制，将 `.agents/skills/` 投影到 `.claude/skills/`，并把跨目录相对路径改写回 `.agents/`，从而避免重复复制非 skill 目录。
_Avoid_: 软链、符号链接、目录联接、重复拷贝

**Migration Manifest（迁移清单）**:
记录每次迁移文件哈希基线的状态文件，使重复同步能够自动更新未手工改动的副本，同时把冲突项保护为 `blocked`、把上游已删项标记为 `orphaned`。
_Avoid_: 锁文件、状态缓存

**MCP Scope（MCP 迁移范围）**:
在写入任何 Harness 的 MCP 配置前由用户显式选择的边界（`project`、`user` 或 `skip`），用于保证绝不隐式修改用户全局配置。
_Avoid_: MCP 模式、全局开关
