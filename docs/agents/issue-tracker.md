# 任务跟踪器：GitHub Issues

本仓库的规格（Spec）与任务票（Ticket）均以 GitHub Issues 形式存放，所有操作通过 `gh` CLI 完成。

## 操作约定

- **创建 Issue**：`gh issue create --title "..." --body "..."`（多行正文使用 heredoc 或文件传入）。
- **读取 Issue**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列出 Issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label` 与 `--state` 过滤。
- **关联父子 Issue（sub-issue）**：`gh issue create --parent <parent> ...`，或事后执行 `gh issue edit <parent> --add-sub-issue <child>`（需 `gh` 2.94+）。旧版 `gh` 可用：`gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`（传数字数据库 ID）。若不支持 sub-issue，在子 Issue 顶部注明 `Part of #<parent>`。
- **阻塞依赖（Blocking）**：优先使用 GitHub 原生 Issue 依赖关系：`gh issue create --blocked-by <n>,<n> ...` 或 `gh issue edit <child> --add-blocked-by <blocker>`（需 `gh` 2.94+）。旧版 `gh` 可用：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`（`<blocker-db-id>` 通过 `gh api repos/<owner>/<repo>/issues/<n> --jq .id` 获取）。若不可用，退回在子 Issue 顶部写 `Blocked by: #<n>, #<n>`。当所有前置阻塞 Issue 关闭时，该任务票即解除阻塞。
- **统计未关闭的阻塞项**：`gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`（返回 `0` 表示可开始）；或 `gh issue view <n> --json blockedBy --jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'`。
- **发表评论**：`gh issue comment <number> --body "..."`。
- **增删标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。
- **关闭 Issue**：先用 `gh issue comment <number> --body "..."` 写明结论，再执行 `gh issue close <number>`。

仓库名由 `git remote -v` 自动推断。仅向用户自己的仓库（`BAIMOoo/y3maker-migration-skills`）提交 Issue，切勿误提交到上游模板仓库；首次创建前可用 `gh repo view --json nameWithOwner` 复核目标仓库。

## Pull Request 分诊面

**PRs as a request surface: no.**（如后续决定将外部 PR 纳入分诊队列，可改为 `yes`；`/triage` 会读取此标记。）

当设置为 `yes` 时，PR 沿用同一套标签与状态流转，使用 `gh pr view`、`gh pr diff`、`gh pr comment`、`gh pr edit`、`gh pr close` 操作。

## 技能指令映射

- 当技能要求「publish to the issue tracker」时：创建一个 GitHub Issue。
- 当技能要求「fetch the relevant ticket」时：按上方「读取 Issue」命令拉取内容。

## Wayfinding 约定

用于 `/wayfinder`：以单个带 `wayfinder:map` 标签的 Issue 作为总图（Map），子任务票作为其 sub-issue（标签为 `wayfinder:<type>`，如 `research`/`prototype`/`grilling`/`task`），认领时执行 `gh issue edit <n> --add-assignee @me`，完成后评论结论、关闭子 Issue 并在 Map 中补充指针。
