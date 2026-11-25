# 分诊标签映射（Triage Labels）

工程技能内部使用以下 5 个标准分诊角色，本表将其映射为当前 GitHub 仓库的实际标签字符串。

| 标准分诊角色 | 本仓库标签 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 待维护者评估与分诊 |
| `needs-info` | `needs-info` | 等待提报者补充更多信息 |
| `ready-for-agent` | `ready-for-agent` | 规格已明确，可交由 Agent 自主实现 |
| `ready-for-human` | `ready-for-human` | 需要人工介入实现或决策 |
| `wontfix` | `wontfix` | 确认不予处理 |

当技能提及某一角色（例如“打上 `ready-for-agent` 标签”）时，请直接使用「本仓库标签」列中对应的标签名。
