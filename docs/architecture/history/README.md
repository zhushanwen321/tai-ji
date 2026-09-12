# 历史版本归档

本目录存放**被整体取代的旧架构版本**。文档在此仅供追溯，**不代表当前架构**。

当前架构以 [`../../design.md`](../design.md) 为准，入口 [`../../../architecture.md`](../../../architecture.md)。

## 归档规则

- 触发：`design.md` 或某个架构方案被新版**整体取代**时归档
- 命名：`<里程碑>-<YYYY-MM-DD>/`，用语义命名（如 `pre-electron-2026-05`），不用版本号
- ADR **不进本目录**：ADR 自带 supersede 机制，被取代时改状态字段即可

## 已归档

- [pre-electron-2026-05/](pre-electron-2026-05/migration-plan.md) — Tauri → Electron 迁移方案（迁移完成后归档）
- [refactor-2026-06/](refactor-2026-06/migration-plan.md) — 2026-06 runtime/renderer 重构期的过程文档：migration-plan（5 阶段路线）、review-issues（D1–D9 盲点）、runtime-similar-code-review（重复代码审计方案）、plan/（各阶段细节）、changes/（阶段评审记录）、subsystems-plugin/（plugin 子系统 2026-05 期的 status / roadmap / remaining-work / extension-audit）。重构已完成，仅供追溯。
- [engine-abstraction-2026-09/](engine-abstraction-2026-09/subagent-engine-abstraction.md) — subagent 引擎中立抽象设计（EnginePort 进程内多引擎形态，P1-P5 已落地）。被引擎协议化（NDJSON stdio engine-protocol v1，引擎外移独立 CLI 包）整体取代，见头部取代声明；现行权威 = `docs/design/subagent-engine-protocolization.md` + `docs/design/subagent-post-convergence-architecture.md`。
- [chat-liveness-v1x-2026-09/](chat-liveness-v1x-2026-09/chat-domain-v1x-liveness-governance.md) — pi chat 域协议 v1.x 入引擎进程与轮次活性治理。chat 域独立协议面（host/roundLifecycle 通道族 / interact / RunParams.chat / 长驻会话状态机）已随 H1（subagent-chat-run-unification）整族退役，见头部 superseded 声明；现行权威 = `docs/design/subagent-chat-run-unification.md`。
