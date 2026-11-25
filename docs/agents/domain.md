# 领域文档约定（Domain Docs）

本文件说明各工程技能在探索和修改本仓库前，如何读取和遵守领域文档。

## 探索前必读

- 根目录 **`GLOSSARY.md`**（单上下文项目词汇表）
- **`docs/adr/`**：阅读与本次改动领域相关的架构决策记录（ADR）

如果上述文件尚未存在，请**静默跳过**，不要因此中断流程或要求提前补建；它们会在 `/grill-with-docs` 或 `/domain-modeling` 过程中按需沉淀。

## 目录结构（单上下文）

```text
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-canonical-agents-store-with-thin-adapters.md
│   └── 0002-keep-y3-mdc-rules-in-agents-rules.md
└── ...
```

## 遵循术语表

在编写 Issue 标题、规格、重构方案、假设或测试名称时，请使用 `GLOSSARY.md` 中定义的标准术语，避免使用表中 `_Avoid_` 列出的同义词。如发现缺少某个核心概念，可留给 `/domain-modeling` 补充。

## 显式标注 ADR 冲突

如果新方案与已有 ADR 冲突，请显式指出而非静默覆盖，例如：

> _与 ADR-0001 存在冲突，建议重新讨论，原因是……_
