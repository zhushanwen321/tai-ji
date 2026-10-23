---
name: pr-cr-fix-merge
description: >-
  索引 skill：在 feature worktree 内先执行完整 PR 生命周期（pr-cr-fix：开 PR →
  门禁 → review → 修复 → push），push 完成后无缝衔接合并发布（merge：9 阶段
  合并 + Electron/npm 发布 + worktree 清理），一条链跑完。
  触发词："pr-cr-fix-merge"、"PR 完走后合并发布"、"review 完直接合并"、
  "一条龙合并发版"。
  不用于 只需要 PR 流程（用 pr-cr-fix）、只需要合并发布（用 merge）、
  或 npm 预发布（用 prerelease）。
---

# pr-cr-fix-merge

索引 skill：组合 [pr-cr-fix](../pr-cr-fix/SKILL.md) 与 [merge](../merge/SKILL.md)。
本文件不复制两个 skill 的任何流程内容；执行 = 按顺序各执行一遍两个 skill 本体。

## 执行顺序

**cwd = feature worktree 根目录**（`git rev-parse --show-toplevel`），全程在
当前 feature worktree 发起；merge 各阶段脚本自行操作 main worktree（其 SKILL
内的 cwd 隔离规则照抄执行）。

1. **第一段 pr-cr-fix**：按 `../pr-cr-fix/SKILL.md` 完整执行——阶段 1（开 PR +
   static gate）→ 阶段 1.5/1.6（度量 + 覆盖率门禁）→ 阶段 2（review+fix）→
   阶段 3a（终局三道 gate）→ 阶段 3b（push）。终点 = push 完成、远端 ref 与
   本地 HEAD 一致。zcode 环境走路径 2（CreateWorkflow + pr-lifecycle.dwf.ts）；
   pi 环境走路径 1（pi 版 pr-lifecycle 单 workflow）。
2. **第二段 merge**：第一段终点即 merge 前置条件（feature 分支已有 PR）。按
   `../merge/SKILL.md` 从阶段 0 开始完整执行，`<worktree-dir>` = 当前 feature
   worktree 目录名（basename）。终点 = 阶段 7 清理完成 + 合并总结报告。

## 衔接约定

- 两段共用 remote `github`（GitHub）。第一段 push 后不做任何额外 git 操作
  （不切分支、不补 commit）直接进第二段——merge 阶段 0.5 自会做 commit 整理
- 授权语义：用户发起本 skill = 授权完整链路（含 PR push / 版本 tag push /
  Release 发布）；两个内建 skill 中仍需用户当场确认的点保持原样——merge
  阶段 3.7 烧真实 token 的 e2e 默认不跑，除非用户当场明确要求
- 冲突裁决：两个 skill 的关键约束同时生效；执行细节冲突时以 merge 侧为准
  （第二段操作 main worktree 与发布线，破坏面更大）
