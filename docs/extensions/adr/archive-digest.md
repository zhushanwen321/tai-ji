# Pi-Ext ADR 档案摘要（archive digest）

本文件是被压缩的**非载荷 pi-ext ADR 档案**：原文件已删除，每号保留一行结论 + 去向，逐号可查。全文见 git 历史（`git log --diff-filter=D -- docs/extensions/adr/` 或对应编号文件名）。

在册 ADR（pi-ext-002 / 011 / 014 / 019 / 021 / 022 / 030 / 032）见同目录原文件。

> 注意：本目录早期 ADR 描述的 `subagent-workflow` 源码结构（record-store / session-reconstructor / resource-discovery.ts 等模块）已随引擎化重构演进为 host / injectors / interface 分层 + jsonl-run-store 持久化，文中「代码已消亡」均指现行树中无对应实现，git 历史可追溯。

<a id="pi-ext-001"></a>
### ADR-001：Subagent 架构与使用模型（superseded：决策 1、3）
- 结论：subagent = spawn 独立 `pi --mode json` 进程（上下文隔离/并行/模型专精三价值）+ background 自动注入；决策 2/4/5 的 prompt 工程结论与 D-007/D-018（fork 深度硬限、worktree tmpdir 隔离、两级降级）仍有参考价值。
- 去向：进程模型被 in-process `createAgentSession()`（源项目 ADR-025，未随迁）与 background 注入被 [pi-ext-027](#adr-027subagent-执行记录与会话持久化l1l2acceptedl1-已废弃) 取代；现行 subagent 架构见 `docs/extensions/subagents/architecture.md`。

<a id="pi-ext-003"></a>
### ADR-003：Evidence-based completion（Accepted）
- 结论：Goal 强制任务分解 + 全部完成 + 具体证据才能标记完成（complete_task 无 evidence 抛错、tasks 未全清 complete_goal 抛错），在 API 层阻止模型预算压力下偷工减料；探索性目标应用 Todo 而非 Goal。
- 去向：已实现——`extensions/universal/goal/`（goal 引擎现役包）。

<a id="pi-ext-004"></a>
### ADR-004：Memory Session File Creation via copyFileSync（Accepted）
- 结论：subagent memory 模式用 `copyFileSync(mainSessionFile, memoryFilePath)` 创建 `{basename}.mem-{id}.jsonl` 持久会话文件（`--fork` 无法控制路径与命名），后续 `--session <path>` 续跑。
- 去向：代码已消亡（subagent memory 模式未随迁本仓），git 历史可追溯。

<a id="pi-ext-005"></a>
### ADR-005：Extension Composability Protocol（proposed，DEPRECATED）
- 结论：orchestrator/capability/observer 角色分类 + OrchestratorLifecycle 生命周期接口 + steering bus + composer 扩展（orchestrator 栈）提案，用于 orchestrator 扩展安全嵌套。
- 去向：未实施，已废弃——引用的 pi-statusline / pi-context-engineering / pi-evolve-daily 包已删除。

<a id="pi-ext-006"></a>
### ADR-006：渐进式上下文压缩（proposed）
- 结论：L0（零成本清理）→ L1（规则化摘要 + recall_context 取回）→ L2（紧急截断）三级管道，经 `context` 事件在 LLM 调用前做零 LLM 成本压缩，与原生 Compaction 互补。
- 去向：未实施（proposed）；现行上下文压缩 = `extensions/universal/smart-context/`（agent 自决 compact_context 工具 + 双模式摘要接管）。

<a id="pi-ext-009"></a>
### ADR-009：grill-with-docs 集成为 Phase 1/2 Skill 内的 Step（Accepted，源项目）
- 结论：术语精确化 + CONTEXT.md + ADR 记录拆为 MUST + Nullable Step 嵌入现有 Phase，而非独立 Phase——流程摩擦（非功能缺失）是核心问题，独立 Phase 加剧摩擦。
- 去向：源项目（xyz-harness）时期决策，未随迁本仓，已废弃。

<a id="pi-ext-010"></a>
### ADR-010：Skill 发现策略——无 fallback，硬失败（Accepted，源项目）
- 结论：只用 `before_agent_start` 注入的 skills 列表，不尝试 fallback 路径，不在列表即抛异常终止——错误应在第一时间暴露而非运行中读到旧内容。
- 去向：精神由 pi-ext-031 继承（manifest 严格校验：声明路径不存在即发现失败，不 fallback）；现行资源发现逻辑内联于 `extensions/universal/subagent-workflow/src/session-lifecycle.ts`。

<a id="pi-ext-012"></a>
### ADR-012：TS 侧引入 js-yaml 解析 review 文件（Accepted，源项目）
- 结论：gate tool 用 js-yaml `safeLoad` 解析 review YAML frontmatter（正则无法处理嵌套字段且静默返回 fail），TS 与 Python 两侧同源 libyaml 语义，消除「同一文件两种解析结果」。
- 去向：代码已消亡（extensions 现无 js-yaml 依赖，review 编排已内化为 pr-cr-fix review agents），git 历史可追溯。

<a id="pi-ext-013"></a>
### ADR-013：不兼容历史 Topic 格式（Accepted，源项目）
- 结论：V5 格式升级（frontmatter 扁平化、gate 深度统一、test_execution schema）只对新 topic 生效，历史 `.xyz-harness/` 旧文件不迁移不兼容——兼容旧格式增加复杂度而收益为零。
- 去向：已实施完毕（源项目历史决策），纯历史无现行锚点。

<a id="pi-ext-017"></a>
### ADR-017：Todo 使用独立轻量循环而非复用 Goal 的 Loop（Accepted）
- 结论：todo 实现自己约 50 行的轻量 agent loop（无状态机/无 budget，仅停滞时注入 context），不共享 goal 的 7 态状态机——本质区别（AI 自发轻量追踪 vs 用户驱动正式循环）+ 独立 npm 包隔离 + 复杂度不匹配。
- 去向：已实现——`extensions/universal/todo/`。

<a id="pi-ext-020"></a>
### ADR-020：Coding-Workflow 依赖 Workflow Extension（Accepted）
- 结论：经 `pi.__workflowRun` 约定通道（`session_start` 时暴露 `orchestrator.runAndWait()`）复用 workflow 的 parallel/callCache/budget 编排能力，`extension-dependencies.json` 声明 optional 缺失降级。
- 去向：已实现且通道仍活跃——`extensions/universal/subagent-workflow/src/index.ts`（`pi.__workflowRun`）；两包合并背景见 pi-ext-030。

<a id="pi-ext-023"></a>
### ADR-023：GoalRuntimeState Mixed-Frequency Tech Debt（Accepted，tech debt record）
- 结论：`GoalRuntimeState` flat interface 混装配置/每 turn/事件/UI flag 五种变更频率字段（序列化全量 dump、debug 困难）——暂不重构，记录为已知技术债；死字段 `turnCount` 已清理；分层时优先 config/runtime 两层。
- 去向：已实现（技术债登记，保持现状）——`extensions/universal/goal/src/`（GoalRuntimeState：session.ts / persistence.ts）。

<a id="pi-ext-024"></a>
### ADR-024：skill tracker 主动声明替代被动监听（Accepted，DEPRECATED）
- 结论：skill 使用追踪从被动监听 read SKILL.md（误报污染数据）改为 agent 主动调 `use_skill` tool 声明——误报零容忍、接受概率性漏报；cancelled/abandoned 语义区分。
- 去向：未实施即废弃——pi-evolve-daily 包已删除。

<a id="pi-ext-027"></a>
### ADR-027：Subagent 执行记录与会话持久化 L1+L2（Accepted；L1 history.jsonl 已废弃）
- 结论：执行记录与会话内容持久化到 `~/.pi/agent/subagents/<encoded-cwd>/` 与主 session 物理隔离；L1 history.jsonl 后被废弃（session.jsonl 是唯一 source of truth），L2 会话持久化（SessionManager.create 落盘 + 详情回看 + 30 天 TTL GC）有效；明确不做运行中 background agent 跨进程恢复（L3）。
- 去向：历史实现（record-store / session-reconstructor）已随 subagent-workflow 引擎化重构演进，现行持久化 = `extensions/universal/subagent-workflow/src/jsonl-run-store.ts`（WorkflowRun 聚合根 JSONL + pi session entry 快照）；身份解耦演进见 pi-ext-034/035。

<a id="pi-ext-029"></a>
### ADR-029：全流程 Workflow 接管 coding-execute + per-call cwd + worktree 编排（Partially superseded）
- 结论：workflow 机器强制力闭环堵死「小任务跳过 test/review」的认知层逃逸；per-call cwd（两条执行链）、worktree 生命周期内建（原生 git worktree add/remove，4 phase）、agent 渐进式调 cw（显式传 workspacePath）、test 调度字段 dependsOn/parallelGroup、砍 pending-env、store WAL + busy_timeout 六项决策。
- 去向：被 [pi-ext-030](pi-ext-030-subagents-workflow-merge.md) 部分取代（执行载体：独立 pi-workflow 包 + SubprocessAgentRunner → 两包合并单执行链）；决策 2 的 worktree 编排知识转移到 coding-execute skill，其余正交决策（cwd / cw 调用 / plan schema / WAL）仍有效。

<a id="pi-ext-031"></a>
### ADR-031：统一资源发现（agent .md 与 workflow .js 共享扫描逻辑）（Accepted）
- 结论：`resource-discovery` 单模块统一 7 源扫描（user `.pi/agent` / user `.agents` / npm global / dev symlink / project `.pi` / `.pi/.tmp` / project `.agents`，末级目录名参数化），全部 user 级路径走 `getAgentDir()` 尊重 `PI_CODING_AGENT_DIR`；manifest（`pi.agents`/`pi.workflows`）严格校验，废弃 discovery.json。
- 去向：已实现——原独立模块 `resource-discovery.ts` 已内联，现行发现逻辑在 `extensions/universal/subagent-workflow/src/session-lifecycle.ts` 与 `src/host/pi-host.ts`。

<a id="pi-ext-033"></a>
### ADR-033：subagent UI 透传通用化架构（method 交互模型 + channel 注册表正交）（Accepted）
- 结论：透传 + 排队由 Pi method 交互模型决定（dialog 类 select/confirm/input/editor 自动透传 + L2 排队；fire-and-forget 仅 GUI 透传；TUI 纯展示不透传），业务路由由 channel 注册表（NUL 前缀 marker 解析，提取位置依赖 method）决定——新增 channel 零改 adapter/session-runner/SubagentService。
- 去向：已实现——透传通道现行落点 `extensions/taiji/plugin-bridge/src/index.ts`（ASK_USER_MARKER 经 select 通道中转）；subagent-workflow 侧原 ui-channels/dialog-queue 模块已随重构演进。

<a id="pi-ext-034"></a>
### ADR-034：Subagent 执行记录 Manifest（REJECTED，不可行）
- 结论：v0/v0.1 均存在三个结构性缺陷无法用补丁解决——legacy 双读无 join key（identity 补写失败的 session 永远 join 不回）、PID reuse + manifest 探活循环依赖（record 身份不能锚定进程生命周期）、persist-before-archive 崩溃窗口（fsync+rename 之间的半成品状态无恢复设计）；保留作失败原因记录与教训（质疑设计本身，不接受「补 X 就能跑」）。
- 去向：被 pi-ext-035 取代（从 record 身份系统、legacy 兼容、持久化语义三个根问题重新设计）。

<a id="pi-ext-035"></a>
### ADR-035：Record 身份从 transcript 解耦（Accepted）
- 结论：record id 改 `crypto.randomUUID()`、独立 manifest 文件作 source of truth（write-tmp + fsync + rename 原子写）、RPC `get_state` 握手取 sessionFile（不依赖 stdout header，不改 Pi 源码）、PID 仅作临时探测（ALIVE_SOFT_TIMEOUT_MS 24h→1h）、status 4 态（running/completed/failed/cancelled，crashed 不进 manifest）、损坏数据跳过不降级。
- 去向：曾实现（manifest 方案），已随 subagent-workflow 引擎化重构演进，现行执行记录持久化 = `extensions/universal/subagent-workflow/src/jsonl-run-store.ts`；git 历史可追溯。

<a id="pi-ext-036"></a>
### ADR-036：Statusline Footer Aggregation（proposed，DEPRECATED）
- 结论：解决 pi-permission 与 pi-statusline 的 `setFooter` 单例覆盖冲突——statusline 作 canonical owner 提供 footer line 注册协议（globalThis Symbol 握手 + pending-flush，仿 ask-user 模式），permission 撤自有 setFooter 改注册 line renderer（order=2）。
- 去向：未实施即消亡——pi-statusline 包已删除，permission 侧 consumer 握手协议（footer-provider.ts / statusline-palette.ts）2026-08-13 删除。
