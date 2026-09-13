# ADR-0025: File View 语义重定义为全项目文件树

- 状态：Accepted

> **性质**：产品语义 D-不可逆决策（推翻旧 spec）。本文档定义语义，不含实现细节。
> **关联**：[ADR-0024 FileChanges 通道](0024-filechanges-channel.md)（ChangeSetCard 历史态与本 ADR 的现在态互补）、[ADR-0026 懒加载策略](0026-file-tree-lazy-loading.md)。
> **溯源**：`[from: 2026-06-28-sidebar-project-file-tree §1, decisions D-001]`

## 上下文

旧 `sidebar/spec.md §视图切换` 定义 File View 的计数为「当前 active session 改动文件数」，即 File View = 改动文件清单（读 chatStore 聚合的 fileChanges）。这与用户预期和 handoff 文档矛盾：用户期望「浏览整个项目的文件结构」，而非只看 agent 本次改的文件。

## 决策

**推翻旧语义**。File View = session cwd 下的**完整目录树**（浏览整个项目结构），不再是改动文件清单。

- **数据源**：runtime `file.tree`（请求-响应，返回 cwd 完整目录树）+ `git.status` overlay（M/A/D/U 角标，独立 facet）
- **git 标注**：D-003 裁定 git.status 是现在态权威源（覆盖未改动/暂存/untracked 全态），message.file_changes 只覆盖 agent 本次改的文件，撑不起全树标注。两者互补：File View 走 git.status（现在态），ChangeSetCard 走 fileChanges（历史态，ADR-0024）
- **根目录**：当前 active session 的 cwd（D-002）。无 active session 显空态引导选 session

## 与 ChangeSetCard 的关系（避免混淆）

| 组件 | 数据源 | 覆盖范围 | 时态 |
|------|--------|---------|------|
| File View（侧栏）| file.tree + git.status | 全项目文件 | 现在态（工作区快照）|
| ChangeSetCard（消息流）| message.fileChanges | agent 本次改的文件 | 历史态（单回合增量）|

两者正交：File View 浏览全项目，ChangeSetCard 追踪 agent 改动。重开 session 后，File View 显示当前工作区状态（git.status 重拉），ChangeSetCard 历史块由 convertPiHistory 还原（ADR-0024 + #9 修复）。

## 被否方案

- **维持改动清单语义**：与用户预期矛盾，且无法浏览未改动的文件结构

## 落地证据

- `src-electron/renderer/src/components/sidebar/FileView.vue`：读 fileTreeStore.tree（完整树），不再读 chatStore.fileChanges
- `src-electron/renderer/src/components/sidebar/Sidebar.vue`：fileCount 改为 fileTreeStore 顶层节点数
- W4 重写时彻底替换了旧的「改动文件列表」实现（删本地 TreeNode，改用 shared FileNode）
