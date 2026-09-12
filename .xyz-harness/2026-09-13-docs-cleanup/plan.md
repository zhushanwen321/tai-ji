# docs/ 全量清理计划（2026-09-13）

> 依据：2026-09-13 四路并行调研（design / architecture / adr+extensions+todo+research / 根级+testing+feature-map+page-design），关键断言已抽查核实（design 后缀统计、ADR-0049 例外表形态、feat-remote-use 未合并、引用链 grep）。
> 理念：局部信息进代码（注释只写「为什么/坑/好处」，不写「做了什么」）；docs 只留跨模块串联、决策史、行为规范；机器可校验的优先于 md 转述。
> 本文件自身是过程产物，清理完成后随 harness 归档。

## 0. 处置动作代码表

| 代码 | 动作 | 含义 |
|---|---|---|
| **D** | `git rm` | 直接删除，git 历史可追溯，不迁移内容 |
| **M** | 移出 git | `git rm` + 复制到 `~/Documents/xyz-agent-archive/docs-cleanup-2026-09-13/`（竞品调研/第三方资料） |
| **S** | 下沉后删 | 先蒸馏「为什么/坑」到目标代码注释（挂 `// ADR-xxxx` 锚点），再 `git rm` 原文 |
| **R** | 精简保留 | 文件保留，章节级手术（删双写/死条目，改指针） |
| **K** | 保留不动 | — |
| **A** | 归档降级 | 不删但文件头加 `[ARCHIVED 2026-09-13]` 标注或移入 history/ |

## 1. 终态目录结构（目标态：767 文件 → 约 215 文件）

```
docs/
├── README.md                     # 索引 + 治理规则（R：补「下沉通道」判定行，见 §5.4）
├── architecture.md               # 系统架构总览（K）
├── constraints.md                # constraints.json 生成视图（K，勿手改）
├── constraints.json              # 机器权威（K）
├── pi-semantics.json             # pi 语义机器权威（K）
├── standards.md                  # 前端编码规范（R：467 行 → 约 200 行）
├── troubleshooting.md            # 排障（R：506 行 → 约 300 行，症状+命令+指针）
├── design-evolution.md           # UI 演变史（K）
├── release-notes.md              # 发布 notes 规范（K）
│
├── adr/                          # 决策史唯一家园：65 ADR + README（全 K，Batch 4 瘦身）+ 迁入 2 条（§2）
│
├── architecture/                 # 全局架构与契约：21 份（118 → 21）
│   ├── README.md  context.md  design.md  runtime-three-layer-design.md
│   ├── renderer-rebuild-architecture.md  project-session-model.md
│   ├── extension-gui-protocol.md
│   ├── data-source-governance.md（R：82KB → 原则层，删已实施细节）
│   ├── data-source-registry.md（K：scripts 消费的活 SSOT）
│   ├── integrity-hardening.md  subagent-engine-abstraction.md（R：删实施状态记录）
│   ├── conversation-stream-block-rendering.md（R：吸收 INVAR-M4-2′，见 §2）
│   ├── research/ 4 份外部最佳实践（K）
│   └── history/ 22 份（K：归档区原样保留）
│
├── design/                       # 跨模块运行时架构与全局机制：约 20 份（248 → 约 20 + 资产随主题处置）
│   （准入标准收紧为：跨 ≥2 个 package 的运行时机制/架构。单模块设计一律进包内 docs 或代码注释）
│   ├── pi-boundary-reliability.md  env-propagation-boundary.md
│   ├── crash-forensics-and-watchdog.md（§2 吸收 crash-resilience）
│   ├── long-run-stability-architecture.md  npm-publish-surface-guard.md
│   ├── chat-domain-v1x-liveness-governance.md  state-truth-sync-architecture.md
│   ├── panel-view-derivation-and-flow-lifecycle.md  renderer-deepening.md
│   ├── session-service-deepening.md  adversarial-review-fixes.md
│   ├── chat-stream-perf-architecture.md（R：删已实施标注段落）
│   ├── file-lock-unification-and-reaper-sink.md
│   ├── pi-evolution-consistency-and-project-switcher.md
│   ├── subagent-engine-protocolization.md  subagent-dispatch-reliability.md
│   ├── subagent-core-convergence.md  subagent-core-package-extraction.md
│   ├── subagent-core-sink-design.md  subagent-post-convergence-architecture.md
│   ├── subagent-permanent-session-model.md（K：当前分支活跃设计，untracked）
│   ├── zcode-engine-appserver-resident.md（R：删作废 D2/CLI 降级链，保 breaking 修订）
│   ├── zcode-session-db-isolation.md
│   ├── background-task-sidebar-view.md
│   └── tc-transport-consolidation.md
│
├── extensions/                   # 跨 extension 约定：9 份 + adr/ 28 份（61 → 37）
│   ├── development-guide.md（R：2397 行 → 约 1300 行，子代理专项下沉，见 §3.4）
│   ├── extension-conventions.md  logging-conventions.md  glossary.md（R：删已删包词条）
│   ├── gui-protocol-guide.md  local-dev-guide.md
│   ├── tool-schema-openai-compat.md  pi-tui-development-guide.md
│   ├── agent-authoring-guide.md（K：AGENTS.md 场景路由引用）
│   └── adr/ 28 份（K：pi-ext 编号体系原地保留，为唯一 ADR 家园，停用包内私有 ADR）
│
├── page-design/                  # 设计 SSOT + 资产（基本保留，4 份整合/归档，§3.8）
│
├── testing/                      # 19 份文件名全保留，内容手术（§3.7）
│
└── feature-map/
    └── 2026-09-11.md             # 只留最新一份滚动
```

终态总量：根级 9 + adr 68 + architecture 22（含 history/22 与 research/4）+ design 22 + extensions 37 + page-design ~11 + testing 19 + feature-map 1 ≈ **189 份**（现 767，约 -75%）。

## 2. 整合方案（跨文件合并，共 6 项）

| # | 整合 | 动作 | 锚点同步 |
|---|---|---|---|
| I1 | crash 域 3→1 | `crash-resilience.md` 五道防线内容并入 `crash-forensics-and-watchdog.md`（AGENTS.md 活锚点），原文件 D | AGENTS.md 无 crash-resilience 引用 ✓ |
| I2 | 滚动跟随不变量 | `chat-pin-bottom-fix.md` 的 INVAR-M4-2′ 迁入 `architecture/conversation-stream-block-rendering.md`（该文档已引用它），原文 S | `scripts/check-scroll-follow.mjs` 注释同步 |
| I3 | 稳定性调研收口 | `long-run-stability-prevention-deep-dive.md` 已实施项（O4-A 等）从正文删、未实施项并入 `long-run-stability-architecture.md`，原文件 D | — |
| I4 | 例外登记簿出 ADR | ADR-0049 的 ~80 行例外表迁至 `taste-lint` allowlist 或 `use-session-scoped-state.ts` 头注释；ADR 只留裁决判据 | ADR-0049 Checklist 段保留 |
| I5 | v6 设计收口 | `page-design/v6-design.md`、`v6-summary.md` 残值并入 `v6-master-spec.md` 后 D；`design-system.md` 活跃裁决（Notice Family）并入 master-spec，Card 原语细节 S 至 packages/ui 组件注释 | `design-tokens.md` 与 v6-tokens.css 双真值收敛单 SSOT（另立小任务） |
| I6 | 换色决策转正 | `page-design/2026-08-02-taiji-v3-color-decision.md` 转 ADR 格式迁入 `docs/adr/` | adr/README 索引补 0064/0065 时一并登记 |

明确**不整合**：subagent-* 架构 7 份演进文档（互相引用 + 被源码注释锚点引用，合并 = 全部锚点重写，成本 > 收益；靠 ADR/代码锚点维持演进链）。

## 3. 逐目录处置清单

### 3.1 docs/design/（248 → 约 22 + 资产随主题）

**Batch 1 批量 D（163 份，零知识损失）**：
- 全部 `*.impl-plan.md`（71）、`*.review*.md` / `*.impact-review*.md` / `*.consistency-review.md` / `*.sync-review.md`（84）、`*.acceptance.md` / `*.research-data.md` / `*.research-view-flow.md` / `*.p1-parity.md` / `gateb` / probe 类（8）——规则层脚本可判定
- 正文型过程台账 7 份：`complexity-debt-full-repayment.md`、`ext-simplify-index.md`、`pi-session-start-handler-idempotency-audit.md`、`renderer-over-engineering-audit-20260911.md`、`renderer-over-engineering-remediation.md`、`subagent-sync-collect.consistency-review.md`、`timeout-audit-2026-09.md`（裁决已被 AGENTS.md 规则 19 + subagent-core-unbounded-wait-audit 承载）
- 纯资产 8 份（demo html/css/js）+ `acceptance-shots/`、`probes/zcode-session-db/`、`structured-output-redesign.assets/`、`handoff/` 目录 → 随主题处置，一律 D

**Batch 3 下沉 S（63 份局部正文，先蒸馏后删）**——按域分批，下沉目标模式：

| 域 | 文件（代表） | 下沉目标 |
|---|---|---|
| extension 域（20） | base-tool-enhance、bridge-rewrite-pi-0.84、structured-output-redesign、rename-session-three-modes、plugin-intercept-injection、subagent-engine-awareness-injection、subagent-sync-collect(+v2) | `extensions/<pkg>/src/` 模块头注释 + 包 README（契约 SSOT 已在 `packages/extension-protocol`，删重复陈述） |
| ext-simplify-01~15（15） | **01/02 已实施 → S**；**9 份未审查 → 暂 K 待用户裁决是否继续做**；已实施其余 → S | 各包源码注释 |
| runtime 域（22） | idle-pi-reclamation、rpc-client-early-frame-buffer、runtime-stream-fault-isolation、session-dead-structural-fixes、session-occupancy-send-closure、sidecar-binding-sync、import-session、real-pi-test-hardening、update-*×3、timeout-streaming-ui-idle、timeout-slow-flow-wallclock、timeout-plugin-service-granularity、timeout-audit-hygiene-batch、pr-lifecycle-workflow、genstats-speed-llm-window | `packages/runtime/src/` 对应模块头注释（如 idle-pi-reclamation → `idle-pi-reaper.ts`「为什么跳过 bus.clearSession/PTY/插件 destroy」）；`update-*` 三篇 → update 域模块注释；timeout 类裁决已被 AGENTS.md 规则 19 承载，只蒸馏各文件独有的坑 |
| renderer/core 域（21） | chat-pin-bottom-fix（INVAR 先行 I2）、bash-running-stream-output、message-stream-editing-pin-identity、steer-followup-user-bubble-display、subagent-drawer-blank、subagent-nonpi-visibility-followups、subagent-sidebar-filter、composer-*×4、model-thinking-level-memory、landing-composer-session-file-symbols、catalog-provider-field-authority、coding-plan-quota-config-ux、llm-retry-settings、usage-page-fixes、release-artifact-size-optimization(+batch3) | `packages/renderer/src/composables/` / `packages/ui/src/features/` 对应文件头注释（如 chat-pin-bottom-fix 根因 → `useVirtuaFollow.ts` 头注释：virtua 0.50.0 坐标语义 + rAF-RO 时序坑） |
| 混合（1） | subagent-core-unbounded-wait-audit | 裁决框架已被 AGENTS.md 规则 19 引用为权威：把「权威裁决」段落迁入 AGENTS.md 引用的稳定位置（或 ADR 化），普查明细 D。**AGENTS.md 规则 19 引用需同步改** |

**K 全局保留（22 份）**：见 §1 终态树（含 zcode 两篇按 R 处理）。
**同步**：`scripts/check-doc-symbol-drift.mjs` DOC_MODULE_MAP 中 `catalog-provider-field-authority`、`update-multi-source`、`update-network-resilience`、`chat-stream-perf-architecture`（保留）、`ext-simplify-02`、`zcode-session-db-isolation`、`chat-domain-v1x-liveness-governance`（保留）的映射随下沉同批调整——被 S 文档删除时删映射项，K 保留的不动。

### 3.2 docs/architecture/（118 → 22）

**Batch 1 批量 D（73 份）**：
- review 系列目录 `refactor-2026-08/reviews/` 4 份 + 顶层 `*.review*.md` / `*.acceptance.md` 33 份（过程产物 37 份）
- superseded/过期 36 份：`renderer-target-architecture.md`、`v6-architecture-refactor.md`（AGENTS.md 已标 supersede 的历史引用，**先改 AGENTS.md 再删**）、`runtime-migration-progress.md`、`terminology.md`（R1-R3 落地、R4/R5 已被推翻）、`cw-store-workspace-decoupling.md`（**先改 ADR-0061 第 5 行链接为 git 历史说明**）、`refactor-2026-08/` 其余 10 份、`subsystems/plugin/` 旧设计 3 份（design-part1/part2/plan）
- `runtime-module-map.md`：唯二增量（interfaces.ts vs services/ports/ 分工）下沉两处文件头注释后 D

**Batch 3 下沉 S（25 份单模块设计）**：`composer-symbol-system.md`、`conversation-renderer-model-unification.md`、`conversation-history-unified-converter.md`、`conversation-turn-attribution.md(+closure)`、`conversation-error-visibility.md`、`steer-followup-conversation-decoupling.md`、`default-model-unified-exit.md`、`provider-config-pi-alignment.md`、`provider-arch-hardening.md`、`slash-commands-delivery-closure.md`、`pi-exit-notification-and-respawn.md`（onExit 闭包过期 sessionId 根因 → `process-manager.ts` 注释，why 价值高）、`restore-fork-attach-fix.md`、`builtin-extension-dev-build-split.md`、`subagent-engine-gui-visibility.md`、`subagent-realtime-channel.md`、`plugin-rendering/` 全组 6 份、`refactor-2026-08/05-extensions.md`（冻结态，解冻前暂 K，其余 W0-W5 已执行完的 D）
- `data-source-governance-plan.md`（120KB wave 执行规格）→ D；`data-source-governance.review.r1-r6` 6 份 → D

**K 保留（22 份）**：§1 终态树所列 + `subsystems/plugin/` 3 份分析类（pi-extension-analysis、vscode-extension-analysis、built-in-plugin-guide）+ README。

### 3.3 docs/adr/（66 → 66，Batch 4 瘦身）

- 全部 K（含 superseded 0007/0017/0061——最廉价的历史）
- 瘦身规则：Decision 段删「落地步骤」清单（537 处 `// ADR-xxxx` 代码锚点提供回链）；统一模板「背景/决策/后果」+ Status 头；ADR-0049 例外表迁出（I4）
- `adr/README.md`：补 0064/0065 索引 + I6 转正的新 ADR
- 迁入：I6 换色决策 1 条；（可选）idle-pi-reclamation「被否谱系」浓缩 1 条

### 3.4 docs/extensions/（61 → 37）

- **M 移出 git（15）**：`archive/` 14 份 + `vscode-extension-architecture-analysis.md`
- **S 下沉（11）**：`development-guide.md` §16-21、§23-24 子代理专项（~600 行）→ `extensions/universal/subagent-workflow/docs/`（包内已有 docs 先例）；`subagents/` 5 份 → 同包（按 v8.11 现状刷新后下沉，旧版 D）；`scheduler/design.md`、`smart-context/design.md(+html)` → 各包；`permission/rule-editor-interaction-design.md` → 迁 `docs/page-design/`（性质是 GUI 交互设计）
- **R 精简（4）**：development-guide（去重 §22 与 pi-tui 指南）、glossary（10 个专属词条 → 各包 README，已删包词条 D）、extension-conventions（SW peer 依赖/scheduler 专属段下沉）、logging-conventions（logger 用法示例 → `extensions/shared/extension-logger/src`）
- **K（9 + adr/28）**：§1 终态树所列；`extensions/adr/` 原地为 pi-ext 唯一 ADR 家园，subagent-workflow 包内私有 `docs/adr/` 3 条迁入合并编号

### 3.5 docs/todo/（51 → 4）

- **D（44-46）**：sidebar-sync 全系 12、post-merge-residual 8、review-fix-loop-efficiency 的 tier-1/tier-2/briefs/specs 13、cache-probe-design、extension-startup-config-mechanism、extension-log-cleanup-design、scoped-model-design、provider-config-quota-architecture、usage-stats-design、subagent-nonpi-terminal-reload 等——均有实现落地证据
  - **删前蒸馏**：sidebar-sync-design 的不变量 → subagent-workflow 包 docs；context-consistency 4 份删前**必须先改 ADR-0049 内对这 2 个文件的链接**（改指 git 历史）
- **K（4）**：`remote-use-merge-architecture.md`（feat-remote-use 分支核实存在、未合并）、`companion-surface-governance.md`（owner+期限 2026-10-01）、`subagent-core-native-empty-view-degrade.md`（裁剪到只剩 §4 ③级未做残项）、`review-fix-loop-efficiency/` tier-3（自述「暂时不做」+ 触发条件）

### 3.6 docs/research/（4 → 0）

- 全部 M（违反 README「竞品调研移出 git」规则）。前置：引擎能力矩阵 + 所选契约蒸馏 10 行进 `architecture/subagent-engine-abstraction.md`（该设计文档已不回链这 4 份，无入链，蒸馏是补充而非修复）

### 3.7 docs/testing/（19 份名保留，内容手术，Batch 2）

- `00-test-strategy-overview.md` R：删 §7 覆盖盘点表（时点快照，或改脚本生成）；修 §3.5 与 §2.1 的 mock 路径矛盾
- 各功能篇（01-13）R：testid 清单 → 组件 `data-testid` 旁注释；`文件:行号` 调用链 → 模块头注释（v6 迁移后行号已大面积失效）；**保留**手工冒烟清单 + mock 盲区表（文档独有信息）
- `visual/vlm-prompt-template.md`、`visual/baselines/` K（scripts 引用/视觉基线）

### 3.8 根级 + feature-map/ + page-design/

- 根级 9 份全保留；`standards.md` R（§2.1/§7.1/§9.1 改 lint 指针；§6 删指向 architecture.md；§3/§7.2 S；§7.2.6 死条目 D）；`troubleshooting.md` R（§3.7 见 troubleshooting 三分类：pi 坑机制长文删、留症状+grep+指针；#12/#13 留三行命令；修 git-service.ts 载体名漂移）
- `feature-map/`：保留 `2026-09-11.md`，其余 5 份 D（删前把 09-11 内旧版链接改 git 历史说明）
- `page-design/`：v6-design/v6-summary D（I5）；design-system.md 活跃内容并入 master-spec 后 A；usage-dashboard.md D（已上线，细节 S 至组件）；`session-trace/`、`streaming-trace-window/`、`markdown-filepath-redesign/` 子目录 D（一次性工作流产物，按 README 应在 harness）；其余 K

## 4. 引用链同步清单（已核查，Batch 0 / 同批执行）

| 引用方 | 引用 | 处置 |
|---|---|---|
| AGENTS.md（6 条） | renderer-target-architecture / v6-architecture-refactor（supersede 标注段）、base-tool-enhance、subagent-core-unbounded-wait-audit、zcode-engine-appserver-resident | Batch 0 改锚点（前两条删引用；后三条改指下沉目标/精简版） |
| AGENTS.md（其余 24 条） | 全部指向终态保留文档 | ✓ 无需动 |
| `scripts/check-doc-symbol-drift.mjs` | DOC_MODULE_MAP 14 份（7 对正文+impl-plan） | Batch 1/3 同批：被删文档的映射项删除，保留文档不动 |
| `docs/adr/0061` L5 | architecture/cw-store-workspace-decoupling.md | 改 git 历史说明 |
| ADR-0049 | todo/context-consistency 2 份 | 删 todo 文件前先改 ADR 链接 |
| `scripts/check-scroll-follow.mjs` 等 | chat-pin-bottom-fix、catalog-provider-field-authority 等 | I2/S 下沉时同步脚本注释 |
| 项目 skills（pr-cr-fix 等） | pr-lifecycle-workflow.md(+impl-plan)、agent-authoring-guide、terminology.md | pr-lifecycle-workflow S 时同步 skill 文件；agent-authoring-guide K 不动；terminology 删时查 skill 引用 |
| 源码注释锚点 10 文件 | Turn.vue、useVirtuaFollow.ts 等 | S 下沉时逐个改指新锚点（ADR 或包内位置） |
| `scripts/` 消费的活 SSOT | constraints.json/md、pi-semantics.json、data-source-registry.md、extension-conventions.md、troubleshooting.md、design-tokens.md | 全部在保留集 ✓ 精简 troubleshooting/design-tokens 时只删转述不删被引用锚点 |

## 5. 执行批次与验收

| 批次 | 内容 | 量级 | 验收 |
|---|---|---|---|
| **Batch 0** | 引用链前置：AGENTS.md 6 锚点、ADR-0061、ADR-0049→todo 链接、DOC_MODULE_MAP 预清理 | 4 文件 | `node scripts/check-doc-symbol-drift.mjs` 绿 |
| **Batch 1** | 纯删：design 163 + architecture 73 + todo 44 + research 4(M) + extensions/archive 15(M) + page-design ~12 + feature-map 5 ≈ **316 份** | 大但零风险 | grep 被删文件名在活文件零残留；`pnpm lint` 绿 |
| **Batch 2** | 双写消除：standards/troubleshooting/testing 章节手术 + ADR-0049 例外表迁出（I4） | 3 文件 | troubleshooting 被 scripts 引用的 9 处锚点仍在；TEST-STRATEGY 链接不断 |
| **Batch 3** | 下沉：design 63 + architecture 25 + extensions 11 → 蒸馏「为什么/坑」到目标注释后删（按域分 3 小批：extension → runtime → renderer/core） | ~99 份 | 每份下沉前跑目标包 `pnpm --filter <pkg> test`；tsc/eslint 双绿 |
| **Batch 4** | 整合 I1-I6 + ADR 瘦身 + adr/README 补索引 + docs/README 治理规则更新（补「单模块设计 → 蒸馏后删；为什么进模块注释 + ADR 锚点；过程产物落 .xyz-harness/ 不进 docs」）+ docs/README.md 目录树与实际终态对齐 | 6 整合 + 66 ADR | 全 grep 校验 + `render-constraints.mjs` 绿 |

**流程改造（防反弹）**：review/impl-plan/acceptance 类工作流产物从源头改落 `.xyz-harness/<date>-<slug>/`（docs/README.md 规则已有，dev-flow/tech-design skill 的产物路径需同步检查）；`ext-simplify` 9 份未审查设计保留待用户裁决。

**遗留小任务**（不阻塞清理）：design-tokens.md 与 v6-tokens.css 双真值收敛；data-source-registry.md 长期演进为「配置生成」（其自述终态）。
