# 架构文档目录规范

本目录存放 taiji 所有架构相关文档。入口是上一级的 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)，本 README 只说明**组织规则**。

## 目录结构

```
docs/architecture/
├── README.md                        # 本文件（规范说明）
├── design.md                        # 跨进程架构决策记录（D1–D9：双通道/启动时序/API Client/双维度模型/横切归宿）
├── feature-map.md                   # 功能开发地图（滚动快照，启动新 Phase 前更新）
│
│  ── 拓扑与治理 SSOT ──
├── renderer-package-topology.md     # renderer 终态包拓扑 SSOT（§1 包拓扑 / §2 core 分层）
├── runtime-layering.md              # runtime 三层分层 SSOT（边界规则 / ports 依赖倒置 / services→infra 受控例外登记）
├── project-session-model.md         # Project–Session 关系模型 SSOT
├── data-source-governance.md        # 数据治理：关键术语 + 五原则 + D1–D8 裁决索引
├── data-source-registry.md          # 数据源登记表（SSOT 索引 + 跨进程锁协议表）
├── integrity-hardening.md           # 完整性加固：三原则 + §/D/M 决策索引
├── extension-gui-protocol.md        # Extension GUI 渲染协议规范（含 §13 决策日志 / §15 挂载现状）
│
│  ── 机制域规格（按域分组）──
│  zcode 引擎域
├── zcode-engine-appserver-resident.md   # zcode 引擎 app-server 常驻化（共享 HOME / 无降级链）
├── zcode-session-db-isolation.md        # zcode 会话库隔离（ZCODE_SESSION_DB_PATH，GUI 侧边栏零污染）
│  pi 边界域 / 稳定性域
├── pi-boundary-reliability.md           # pi 语义吸收层四支柱（附录 D：派发域切片决策索引）
├── long-run-stability-architecture.md   # 长跑稳定性架构决策索引（D1-D7，E1-E7 已全部交付）
├── crash-forensics-and-watchdog.md      # 崩溃取证/看门狗/滚动重启技术方案（附录 E：无界等待两层裁决）
├── env-propagation-boundary.md          # 子进程 env 出站契约（C-proc-09，deny-by-default）
│  subagent core 域
├── subagent-core-package-extraction.md  # core 抽包 + 双宿主统一
├── subagent-engine-protocolization.md   # 引擎协议化（协议面权威 = engine-sdk protocol 源码，本文载决策）
├── engine-adaptation/                   # 外部 coding-agent 引擎适配映射（六引擎 × 协议 v1 的 type 级映射，入口 README.md）
├── subagent-chat-run-unification.md     # H1：chat 域统一进 run 域（resume 锚点续聊）
├── subagent-workflow-record-unification.md  # H2：workflow agent() record 归位
├── subagent-service-decomposition.md    # H3：SubagentService 上帝类拆分
├── subagent-record-persistence-consolidation.md  # H4：record 持久化单一写入口
├── subagent-permanent-session-model.md  # 永久会话模型（两态 + 万物可续聊，P0）
│  状态与前端域
├── state-truth-sync-architecture.md     # 状态真值同步（单一解析层 resolveLaunchConfig + 等价性守卫）
├── background-task-sidebar-view.md      # 后台命令侧边栏视图契约（registry.json SSOT + RPC + 广播）
├── pi-evolution-consistency-and-project-switcher.md  # pi 版本锚点守卫 + 模型目录单真相 + 项目切换器
│  发布与锁域
├── npm-publish-surface-guard.md         # npm 发布面一致性守卫（check-publish-surface.mjs 设计依据）
└── file-lock-unification-and-reaper-sink.md  # 文件锁统一 SSOT + 后台任务收殓下沉 runtime
```

> plugin 使用指南（内置插件开发 how-to）在 [`../plugins/built-in-plugin-guide.md`](../plugins/built-in-plugin-guide.md)（「怎么写」不属架构文档）。

> ADR 统一收录在 [`../adr/decisions.md`](../adr/decisions.md)（单文件 SSOT，沿用 ADR 编号）。**v3 能力设计 spec** 在 [`v3-specs/`](v3-specs/README.md)（v6 无对应物的功能/跨区联动设计 SSOT）；视觉设计权威 = [`../DESIGN.md`](../DESIGN.md)。

## 三条核心规则

### 1. 单一入口，不重复内容

`docs/ARCHITECTURE.md` 是「当前架构」唯一入口，**只放索引链接**。
- 改架构 → 改本目录内的具体文档（`design.md` 等）
- 入口的链接跟随更新，但**不在入口重复正文**

### 2. 归档即删除

被整体取代的设计文档**直接删除**（git 可追溯），不设归档目录：

| 触发条件 | 动作 |
|---------|------|
| 某架构方案被新方案取代且不再参考 | 直接删除；引用它的活文档同批改为「已删除，git 可追溯」或重指现行权威 |
| 实施型设计文档在落地完成后 | **压缩保留**或删除：代码注释以其决策编号（§/D/M/W）溯源的（如 data-source-governance / integrity-hardening）压缩为「原则 + 决策索引」；无溯源价值的直接删（如 conversation-stream） |
| constraints.json 的 authority 指向被删文档 | 同批重指到现行权威设计文档或实现代码，`node scripts/validate-constraints.mjs` 必须过 |
| ADR 决策被新决策取代 | decisions.md 中原条目压缩或在文末「已否谱系」留一行注记，不整条保留 |

### 3. ADR 规范

- 全部决策收录于 [`../adr/decisions.md`](../adr/decisions.md)（单文件 SSOT），只收录现行有效与部分有效的决策
- 编号沿用 ADR 编号——源码注释中的 `[ADR-XXXX]` 回链在 decisions.md 内解析
- 已过时/被推翻的决策在文末「已否谱系」留一行注记，不整条保留
- 约束登记号（C-xx-xx）指向 [docs/constraints.json](../constraints.json)，每条决策的「登记」列给出对应约束 id

## 什么算「架构相关」

| 属于本目录 | 不属于（留 docs/ 其他位置） |
|-----------|---------------------------|
| 系统分层 / 模块边界 / 依赖方向 | 视觉设计（[`../DESIGN.md`](../DESIGN.md)） |
| 跨进程通信 / 数据流 | 视觉范式（[`../DESIGN.md`](../DESIGN.md)） |
| 架构决策（ADR） | 编码规范（`docs/STANDARDS.md`） |
| 子系统设计 | 使用指南 / how-to（plugin 指南 → `docs/plugins/`，pi extension → `docs/extensions/`） |
| 架构调研（pi extension 通道参考） | UI 调研（TUI→GUI 映射等，留 `docs/extensions/`） |
| 迁移 / 重构路线（实施完成后删或压缩） | 竞品分析（`docs/extensions/archive/`） |

**判定标准**：描述「系统如何被组织和约束」→ 架构；描述「系统长什么样/怎么用」→ 其他。

## 与 AGENTS.md 的关系

`AGENTS.md`（项目根）是**编码规范 + 关键规则**，引用 [docs/adr/decisions.md](../adr/decisions.md) 的决策条目作为决策依据（编号沿用原 ADR 编号）。AGENTS.md 不重复架构内容，只链接。
