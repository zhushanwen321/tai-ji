# 架构文档目录规范

本目录存放 xyz-agent 所有架构相关文档。入口是上一级的 [`../architecture.md`](../architecture.md)，本 README 只说明**组织规则**。

## 目录结构

```
docs/architecture/
├── README.md                            # 本文件（规范说明）
├── design.md                            # 当前生效的完整架构设计
├── context.md                           # 领域术语表（Session/Panel/Runtime 等）
├── renderer-rebuild-architecture.md     # renderer 终态包拓扑 SSOT（§3 包拓扑 / §4 core 分层）
├── runtime-three-layer-design.md        # runtime transport/services/infra 三层设计
├── project-session-model.md             # Project–Session 关系模型 SSOT
├── conversation-stream-block-rendering.md # 对话流分块渲染架构（live ≡ reload 等价）
├── data-source-governance.md            # 数据源治理（跨进程写协议/锁/损坏隔离）
├── data-source-registry.md              # 数据源登记表（SSOT 索引）
├── integrity-hardening.md               # 架构完整性加固（进程生命周期自愈/安全不变量机制化）
├── extension-gui-protocol.md            # Extension GUI 渲染协议规范（含 §13 决策日志 / §15 挂载现状）
├── architecture-overview.drawio/.png    # 全局架构图源文件与导出
├── subsystems/                          # 子系统架构（plugin/）
└── research/                            # 架构调研参考（pi extension RPC/TUI 通道清单，非 UI）
```

> [HISTORICAL] `history/` 历史归档目录已于 2026-09-13 删除（归档即删除策略，git 可追溯）。

> [HISTORICAL] 已散出的活文档：`renderer-rebuild/ws-client-invariants.md` 规格已沉入 `packages/core/src/transport/__tests__/ws-client.invariants.test.ts` 头部注释（2026-09-13）；`refactor-2026-08/05-extensions.md`（extension 冻结候选设计，⛔ 解冻后实施依据，非归档）已移至 [`../todo/extensions-refactor-candidates-2026-08.md`](../todo/extensions-refactor-candidates-2026-08.md)（含 2026-09-13 逐项复核状态块）。

> ADR 统一在 [`../adr/`](../adr/)（索引见其 README.md）。**v3 能力设计 spec** 在 `docs/page-design/archive/v3/`（v6 无对应物的功能/跨区联动设计 SSOT），设计系统权威文档在 `docs/page-design/` 根（原 design-tokens.md / design-system.md 已删除，残值并入 v6-master-spec.md，git 可追溯）。

## 三条核心规则

### 1. 单一入口，不重复内容

`docs/architecture.md` 是「当前架构」唯一入口，**只放索引链接**。
- 改架构 → 改本目录内的具体文档（`design.md` 等）
- 入口的链接跟随更新，但**不在入口重复正文**

### 2. 归档即删除

被整体取代的设计文档**直接删除**（git 可追溯），不设归档目录：

| 触发条件 | 动作 |
|---------|------|
| 某架构方案被新方案取代且不再参考 | 直接删除；引用它的活文档同批改为「已删除，git 可追溯」或重指现行权威 |
| constraints.json 的 authority 指向被删文档 | 同批重指到现行权威设计文档或实现代码，`node scripts/render-constraints.mjs` 必须过 |
| ADR 被新 ADR 取代 | **不删除**——在原 ADR 写 `Status: Superseded by ADR-NNNN`，新 ADR 引用旧 ADR（supersede 机制内建） |

### 3. ADR 规范

- 文件名：`NNNN-kebab-case-title.md`（4 位序号 + 短横线标题）
- 必含字段：`# NNNN: 标题` + `## 状态`（已接受/已废弃/已被取代）+ `## 背景` + `## 决策` + `## 理由`
- 被取代时：原 ADR 状态改 `已被 ADR-NNNN 取代`，**不删除**——ADR 本身就是历史记录链
- 序号严格递增，不复用

## 什么算「架构相关」

| 属于本目录 | 不属于（留 docs/ 其他位置） |
|-----------|---------------------------|
| 系统分层 / 模块边界 / 依赖方向 | UI 设计稿（`docs/page-design/`） |
| 跨进程通信 / 数据流 | 设计规范（`docs/page-design/v6-master-spec.md`） |
| 架构决策（ADR） | 编码规范（`docs/standards.md`） |
| 子系统设计（plugin 等） | 功能规划（`docs/feature-map/`） |
| 架构调研（pi extension 通道参考） | UI 调研（TUI→GUI 映射等，留 `docs/extensions/`） |
| 迁移 / 重构路线 | 竞品分析（`docs/extensions/archive/`） |

**判定标准**：描述「系统如何被组织和约束」→ 架构；描述「系统长什么样/怎么用」→ 其他。

## 与 AGENTS.md 的关系

`AGENTS.md`（项目根）是**编码规范 + 关键规则**，引用 `docs/adr/` 的 ADR 作为决策依据（如 `docs/adr/0017-...`）。AGENTS.md 不重复架构内容，只链接。
