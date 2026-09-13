# ADR-030: subagents + workflow 合并为 pi-subagent-workflow（单包 + 统一执行链 + 分层配额 + 删sync通知合并）

## Status

Accepted

> 本 ADR 承接并 supersede ADR-026（未迁移——属源项目工程决策，两包架构，**完全 superseded**）与 [ADR-029](archive-digest.md#pi-ext-029)（全流程 workflow 接管，**部分 superseded**——仅 worktree 编排决策 2 被取代，per-call cwd / cw 调用 / plan.json schema 等决策仍有效）。
> 见本文 Consequences 段「被取代的 ADR」。

## Context

### 背景：三主题拆分合并

原 `@zhushanwen/pi-subagents`（进程内 subagent 执行运行时）与 `@zhushanwen/pi-workflow`（通用 DAG 执行引擎）是两个独立 npm 包，共享约 1200 行重复代码（pi-runner、agent-discovery、concurrency-gate、execution-record、jsonl-to-agent-event、extractYamlField），各自走独立的 Pi 子进程 spawn 路径。

合并工作按三个 topic 拆分渐进推进：

- **T1（swf-merge-exec-chain）**：包结构合并 + 执行链统一（SubprocessAgentRunner 委托 SubagentService.executeAndAwait）+ `workflow()` 函数落地。
- **T2（swf-delayer-pool-notify）**：删除 sync 模式 + 并发池分层配额（maxConcurrent=6，按 depth 分层）+ 通知合并（BgNotifier 删除，统一为 `pending:unregister` EventBus 事件）。
- **T3（swf-scripts-docs-adr，本 ADR 所属）**：预制脚本（chain/parallel/scatter-gather/map-reduce）+ 文档/ADR 收尾 + 旧包 deprecated 标记。

### 动机

1. **消除两条独立执行链的重复与割裂**：pi-workflow 的 SubprocessAgentRunner 原独立 spawn pi 子进程；pi-subagents 已改为进程内 `createAgentSession()`。两套路径各自维护 agent 发现、并发控制、执行记录，逻辑漂移风险高。
2. **统一执行模型让 workflow 嵌套走同一执行链**：`workflow()` 调 `workflow()` 的嵌套编排（顺序/并行/scatter-gather/map-reduce）要求父子调用共享同一执行链 + 嵌套护栏（MAX_FORK_DEPTH），否则跨包嵌套无法实现。
3. **单包交付降低安装/版本同步成本**：用户不再需要同时安装并版本同步两个强耦合的包。

### 执行链统一需求

pi-workflow 的 SubprocessAgentRunner 原独立 spawn pi 子进程执行 agent；合并后委托 pi-subagents 的 SubagentService.executeAndAwait，形成单执行链。`executeAndAwait` 提供 sync-await 接口供编排层使用，内部仍走 background pipeline（不注入 followUp，靠嵌套护栏防止失控）。详见 T1 code-architecture.md §4 UC-3 时序图。

## Decision

### 决策 1：合并为一包 `@zhushanwen/pi-subagent-workflow`

两包源码合并为单包，三层架构（Interface / Orchestration / Execution）。旧两包（pi-subagents / pi-workflow）原样保留代码不动，仅标记 deprecated + 提供迁移指引（D-004）。

**承接 ADR-026 放弃的 L3A 立场**：ADR-026 Decision 段决定「不做 L3A 交互式编排」。本合并将 L3A 能力承接进单包——`workflow()` 嵌套编排（顺序/scatter-gather/map-reduce 等高级编排）与 `agent()` 即席编排在同一包内共存，不再追求独立 L3A 包。即：L3A 不是「不做」，而是「合并进通用编排包，不单独成包」。

### 决策 2：统一执行链（SubprocessAgentRunner 委托 SubagentService）

SubprocessAgentRunner（原 workflow 侧）改造为委托 SubagentService.executeAndAwait（原 subagents 侧），消除第二条 spawn 路径。`onEvent` 签名从 raw 事件升级为 `AgentEvent`，删除 jsonl-to-agent-event 中间层。合并后 `session-runner.runSpawn` 是唯一的 Pi 子进程 spawn 点。详见 T1 code-architecture.md §3 SAR/SS 签名表 + §5 Deep Module。

### 决策 3：分层配额 + workflow 嵌套

ConcurrencyPool 默认 `maxConcurrent = 6`（**来源：T2 system-architecture §并发池分层配额**）。嵌套时按 depth 分层分配配额：`acquire(priority, effectiveMaxConcurrent = max(1, maxConcurrent - depth))`，即 depth=N 的子层可用配额 = `max(1, 6 - N)`，保底 1 槽防饿死。例：顶层 workflow（depth=0）可用 6 槽；其内再 fork workflow（depth=1）可用 5 槽；depth=5 时保底 1 槽。

`workflow()` 函数支持 workflow 嵌套编排（顺序 chain / 并行 parallel / scatter-gather / map-reduce 四种模式），内置通用编排 workflow 见 `extensions/subagent-workflow/workflows/`（可直接 `workflow run`，见 [ADR-032](./pi-ext-032-builtin-orchestration-workflows.md)）。详见 T2 code-architecture.md §2.1 ConcurrencyPool 改造。

### 决策 4：删 sync 模式 + 通知合并

删除 subagent tool 的 sync（`wait:true`）模式，只保留 background 模式。原 BgNotifier 删除，通知统一为 `pending:unregister` EventBus 事件（payload 扩展 `result` / `error` / `patchFile`）。pending-notifications 扩展消费该事件，替代 BgNotifier 的 followUp 注入职责。详见 T2 code-architecture.md §2.3 emitPendingUnregister + §4 删除清单。

## Consequences

### 正面

- **单包交付**：用户只需安装 `@zhushanwen/pi-subagent-workflow`，无需版本同步两包。
- **执行链单一**：SubprocessAgentRunner 委托 SubagentService，消除重复 spawn 路径，嵌套调用走同一执行链 + MAX_FORK_DEPTH 护栏。
- **嵌套能力**：`workflow()` 支持 workflow 嵌套编排，内置通用编排 workflow（chain/parallel/scatter-gather/map-reduce）开箱即用，`workflow run <name>` 直接执行（详见 [ADR-032](./pi-ext-032-builtin-orchestration-workflows.md)）。
- **通知统一**：EventBus 单一机制（`pending:unregister`），pending-notifications 集中消费，删除 BgNotifier 双轨。

### 负面

- **旧包迁移成本**：已安装 pi-subagents / pi-workflow 的用户需迁移到新包（deprecated 指引 + CHANGELOG 迁移路径，见 T3 #8）。
- **包体积增大**：两包合并后单包体积 > 原单包（但 < 两包之和，去重后净增有限）。
- **sync 模式移除**：依赖 subagent sync（`wait:true`）的调用方需改用 background + `pending:unregister` 通知（T2 决策 4）。

### 被取代的 ADR

| ADR | supersede 范围 | 说明 |
|-----|---------------|------|
| ADR-026（未迁移——属源项目工程决策） | **完全 superseded** | 两包架构 → 单包合并；L3A 能力合并进单包（决策 1 承接，不做独立 L3A 包的立场保留） |
| [ADR-029](archive-digest.md#pi-ext-029) | **部分 superseded** | 仅 worktree 编排（决策 2）被取代——worktree 生命周期知识转移到 `coding-execute` skill（T3 UC-11，内容来自该决策原文）；per-call cwd（决策 1）已实现且仍活跃；cw 调用（决策 3）/ plan.json schema（决策 4）/ 砍 pending-env（决策 5）/ SQLite WAL（决策 6）与合并正交，逐决策标注仍有效 |
