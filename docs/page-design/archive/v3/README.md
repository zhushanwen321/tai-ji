# archive/v3/ · 能力设计 spec 归档区

v3 视觉稿（shell/sidebar/panel/settings/overlays/workspace/overview/new-task）已被 v6 取代并于 2026-08-02 删除。本目录仅保留 **v6 没有对应物的功能/能力设计 spec**——这些是跨区联动、工作流编排、pi 协议适配的设计 SSOT，仍被代码或后续实现引用。

## 保留的能力 spec

| 子目录 | 性质 | 说明 |
|---|---|---|
| `coding-plan-quota/` | **活跃** | provider 额度查询设计（被 packages/ 7 处代码注释引用） |
| `flow-2-code-review/` | **活跃** | 产品主路径 Flow-2 时序设计（被 message.ts 引用） |
| `flow-3-subagent/` | **活跃** | 产品主路径 Flow-3 多 agent 编排 + 进度聚合 |
| `ask-user/` | **活跃** | inline ask-user 交互设计（被 AskUserOverlay.vue 引用） |
| `fast-fork/` | 待实现 | 快速分叉（Fork-to-Ask + 后台分支管理） |
| `fast-merge/` | 待实现 | 多分支差异聚合（依赖 fast-fork 基础层） |
| `fast-handoff/` | 待实现 | 一键交接到新 session |
| `subagent-panel/` | 活跃 | agent-call-streaming + workflow-extension-adaptation |
| `research/` | 实现调研 | pi steer/followup 队列机制调研 |
| `handoffs/` | 交接层 | 各能力 spec 的接手入口文档 |

## 根级文件

- `ui-skeleton.md` — L0-L4 递归骨架总纲（术语/拓扑参考，视觉部分以 v6 为准）
- `skeleton-chain.html` — 骨架链路可视化导航图
- `fast-fork-merge-handoff-plan.md` — fast-fork/merge/handoff 统一实现计划

## 视觉稿去哪了

v3 视觉稿（spec.md + draft-*.html）已被 v6 视觉规格取代：
- 当前视觉 SSOT：`docs/page-design/v6-master-spec.md` + `docs/page-design/v6-spec-*.html`（原 v6-design.md 已删除，git 可追溯）
- 当前原子 SSOT：`docs/page-design/v6-tokens.css`（原 design-tokens.md 已删除）
- 术语/拓扑定义：`docs/architecture/context.md`（v3 UI 结构术语章节）

v3 → v6 的完整演变叙事见 `docs/design-evolution.md`。
