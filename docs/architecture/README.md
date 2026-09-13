# 架构文档目录规范

本目录存放 xyz-agent 所有架构相关文档。入口是上一级的 [`../architecture.md`](../architecture.md)，本 README 只说明**组织规则**。

## 目录结构

> 2026-09-13 起 `docs/design/` 并入本目录（机制域规格与拓扑规格同目录，原「architecture/ 或 design/」双口准入改单口）。原 design 文档的消化史：19 份迁移（下表「机制域规格」各组）、9 份删除（决策谱系由承接文档的附录/头部注记承载，git 可追溯：dispatch→pi-boundary 附录 D、unbounded-wait-audit→crash-forensics 附录 E、early-wave 四份→package-extraction 头部、replay→troubleshooting §12、adversarial→check_prompt_outposts.py 头注释、chat-stream-perf/panel-view→代码注释）。

```
docs/architecture/
├── README.md                        # 本文件（规范说明）
├── design.md                        # 跨进程架构决策记录（D1–D9：双通道/启动时序/API Client/双维度模型/横切归宿）
├── context.md                       # 领域术语表（Session/Panel/Runtime 等）
│
│  ── 拓扑与治理 SSOT ──
├── renderer-package-topology.md     # renderer 终态包拓扑 SSOT（§1 包拓扑 / §2 core 分层；原 renderer-rebuild-architecture.md）
├── runtime-layering.md              # runtime 三层分层 SSOT（边界规则 / ports 依赖倒置 / services→infra 受控例外登记；原 runtime-three-layer-design.md）
├── project-session-model.md         # Project–Session 关系模型 SSOT
├── data-source-governance.md        # 数据治理：关键术语 + 五原则 + D1–D8 裁决索引（诊断/迁移史已删，git 可追溯）
├── data-source-registry.md          # 数据源登记表（SSOT 索引 + 跨进程锁协议表）
├── integrity-hardening.md           # 完整性加固：三原则 + §/D/M 决策索引（诊断/验收记录已删，git 可追溯）
├── extension-gui-protocol.md        # Extension GUI 渲染协议规范（含 §13 决策日志 / §15 挂载现状）
│
│  ── 机制域规格（原 design/，按域分组）──
│  zcode 引擎域
├── zcode-engine-appserver-resident.md   # zcode 引擎 app-server 常驻化（头部含 2026-09 breaking 修订：共享 HOME / 无降级链）
├── zcode-session-db-isolation.md        # zcode 会话库隔离（ZCODE_SESSION_DB_PATH，GUI 侧边栏零污染）
│  pi 边界域 / 稳定性域
├── pi-boundary-reliability.md           # pi 语义吸收层四支柱（附录 D = 派发域切片决策索引收编）
├── long-run-stability-architecture.md   # 长跑稳定性架构决策索引（D1-D7，E1-E7 已全部交付）
├── crash-forensics-and-watchdog.md      # 崩溃取证/看门狗/滚动重启技术方案（附录 E = 无界等待两层裁决收编）
├── env-propagation-boundary.md          # 子进程 env 出站契约（C-proc-09，deny-by-default）
│  subagent core 域
├── subagent-core-package-extraction.md  # core 抽包 + 双宿主统一（头部演进谱系收编 early-wave 四份）
├── subagent-engine-protocolization.md   # 引擎协议化（协议面权威 = engine-sdk protocol 源码，本文载决策）
├── subagent-chat-run-unification.md     # H1：chat 域统一进 run 域（resume 锚点续聊）
├── subagent-workflow-record-unification.md  # H2：workflow agent() record 归位
├── subagent-service-decomposition.md    # H3：SubagentService 上帝类拆分
├── subagent-record-persistence-consolidation.md  # H4：record 持久化单一写入口（终态语义被永久会话模型部分取代，头部演进注记）
├── subagent-permanent-session-model.md  # 永久会话模型（两态 + 万物可续聊，P0）
│  状态与前端域
├── state-truth-sync-architecture.md     # 状态真值同步（单一解析层 resolveLaunchConfig + 等价性守卫）
├── background-task-sidebar-view.md      # 后台命令侧边栏视图契约（registry.json SSOT + RPC + 广播）
├── pi-evolution-consistency-and-project-switcher.md  # pi 版本锚点守卫 + 模型目录单真相 + 项目切换器
│  发布与锁域
├── npm-publish-surface-guard.md         # npm 发布面一致性守卫（check-publish-surface.mjs 设计依据）
└── file-lock-unification-and-reaper-sink.md  # 文件锁统一 SSOT + 后台任务收殓下沉 runtime
```

> plugin 使用指南（内置插件开发 how-to）在 [`../plugins/built-in-plugin-guide.md`](../plugins/built-in-plugin-guide.md)（2026-09-13 迁出，`subsystems/` 目录解散——「怎么写」不属架构文档）。

> [HISTORICAL] 已删除的活文档与去向：`conversation-stream-block-rendering.md`（2026-09-13 删——INVAR-M4-2′ 权威 = `packages/renderer/src/composables/panel/useVirtuaFollow.ts` 头注释，contentBlocks 填充点契约 = `packages/core/src/domain/chat/message-turns.ts` `expandAssistantBlocks` 头注释）；`renderer-rebuild/ws-client-invariants.md` 规格沉入 `packages/core/src/transport/__tests__/ws-client.invariants.test.ts` 头部注释（2026-09-13）；`refactor-2026-08/05-extensions.md`（extension 冻结候选设计，⛔ 解冻后实施依据，非归档）已移至 [`../todo/extensions-refactor-candidates-2026-08.md`](../todo/extensions-refactor-candidates-2026-08.md)（含 2026-09-13 逐项复核状态块）。`history/` 归档目录、`research/` 调研、`architecture-overview` 图源均已删除（归档即删除策略，git 可追溯）。

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
| 实施型设计文档在落地完成后 | **压缩保留**或删除：代码注释以其决策编号（§/D/M/W）溯源的（如 data-source-governance / integrity-hardening）压缩为「原则 + 决策索引」；无溯源价值的直接删（如 conversation-stream） |
| constraints.json 的 authority 指向被删文档 | 同批重指到现行权威设计文档或实现代码，`node scripts/validate-constraints.mjs` 必须过 |
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
| 子系统设计 | 使用指南 / how-to（plugin 指南 → `docs/plugins/`，pi extension → `docs/extensions/`） |
| 架构调研（pi extension 通道参考） | UI 调研（TUI→GUI 映射等，留 `docs/extensions/`） |
| 迁移 / 重构路线（实施完成后删或压缩） | 竞品分析（`docs/extensions/archive/`） |

**判定标准**：描述「系统如何被组织和约束」→ 架构；描述「系统长什么样/怎么用」→ 其他。

## 与 AGENTS.md 的关系

`AGENTS.md`（项目根）是**编码规范 + 关键规则**，引用 `docs/adr/` 的 ADR 作为决策依据（如 `docs/adr/0017-...`）。AGENTS.md 不重复架构内容，只链接。
