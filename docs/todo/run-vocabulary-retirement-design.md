# run 词汇退役与内活性状态唯一读口 —— 现状盘点、退役顺序与失效面分析

> 对应 `docs/todo/subagent-workflow-issues.md` §2.0 表 D6 的 (a) 与 (b) 两项「出设计 → 执行」。
> D6(c)（core 保留领域词表、协议侧线格式与领域词表分离）已定，本文不涉及。
>
> 本文只做现状盘点、顺序/判据/失效面分析，**不含实现方案与代码片段**。

## 0. 取证方式与快照时点

- 取证时点：HEAD `25385e582`，2026-09-30T05:06Z。
- **行号会漂移**：同一 worktree 内另有会话在并行提交（取证期间 HEAD 从 `270d85c13` 前进到 `25385e582`，其中 commit「sink the run journal dir resolution into persistence」把 `scanRunEvents` / `resolveRunEventJournal` / `runEventJournalPathOf` 从 `orchestration/terminal-actions.ts` 迁到了 `execution/persistence/run-event-journal.ts`，连带 `terminal-actions.ts` 行号整体前移约 100 行）。本文所有位置引用同时给出**符号名**，行号仅作时点参考；执行前须按符号名重新定位。
- 全部结论来自本次实际读到的源码行；未能证实的条目集中列在 §3「待确认」。
- 本文引用的命令均在仓库根执行，`node_modules`、`packages/*/dist`、`apps/electron/resources` 产物目录已排除。

---

## 1. (a) v1 兼容层现状盘点

### 1.1 范围界定

D6(a) 的退役对象 = `WorkflowRun.state.status`（`RunExecutionSnapshot.status`，两态 `running | done`）与 `RunStatus` 类型及其派生表。它与 `shared` 的 `WorkflowRunStatus`（三态投影，`packages/shared/src/workflow.ts:25`）是**两个不同类型**，后者是投影词表、不在退役范围内（仅在展示层被引用，见 §1.4）。

### 1.2 类型与词表定义面（实测）

命令：

```
grep -rnE "\bRunStatus\b" --include=*.ts --include=*.tsx --include=*.vue --include=*.mjs \
  packages extensions e2e | grep -v node_modules | grep -v "subagent-core/dist/" \
  | grep -v "apps/electron/resources"
```

命中：**26 处 / 11 个文件**，其中非测试命中 **20 处**。

| 位置 | 符号 | 性质 |
|---|---|---|
| `orchestration/models/types.ts:8` | 注释 | 词表说明（`RunStatus = "running" \| "done"`，2 态） |
| `orchestration/models/types.ts:39` | `RunStatus` | **类型定义（唯一）** |
| `orchestration/models/types.ts:50` | `VALID_RUN_TRANSITIONS` | 转移表 |
| `orchestration/models/types.ts:55` | `ALL_RUN_STATUSES` | 词表成员表 |
| `orchestration/models/types.ts:66` | `isDone` | 派生判定 |
| `orchestration/models/types.ts:70-71` | `canRunTransition` | 派生判定 |
| `orchestration/models/run-state.ts:21,35` | `RunExecutionSnapshot.status: RunStatus` | **字段声明** |
| `orchestration/models/workflow-run.ts:32,159` | `transition(target: RunStatus, …)` | 聚合根状态机方法签名 |
| `orchestration/workflow-run-summary.ts:17,38` | `WorkflowRunSummary.status: RunStatus \| "interrupted"` | 投影输出类型 |
| `orchestration/terminal-actions.ts:81,727` | `isRunSettled` 形参 `{ state: { status: RunStatus } }` | 判据入参类型 |
| `index.ts:482` | barrel `export type { RunStatus }` | 公开导出面 |
| `runtime/src/services/session/workflow-extractor.ts:28` | 注释 | 仅注释引用 |
| `extensions/universal/subagent-workflow/src/interface/format.ts:24,435,443` | `StatusText = RunStatus \| "interrupted" \| DoneReason \| "pending"` | **展示层联合类型成员** |
| 测试 4 文件 | — | 仅测试 |

**零消费面（实测）**：

```
grep -rnE "ALL_RUN_STATUSES|VALID_RUN_TRANSITIONS|\bisDone\(" --include=*.ts packages extensions e2e
```

命中仅 4 处，全部在 `types.ts` 自身的定义体内——`ALL_RUN_STATUSES`、`VALID_RUN_TRANSITIONS`、`isDone` **在全仓（含测试）零消费**。`canRunTransition` 的唯一消费点是 `workflow-run.ts:167`（即 `transition()` 内部）。

### 1.3 写入点（全量，实测）

命令：

```
grep -rnE "status: \"(running|done)\"|this\.state\.status = " --include=*.ts \
  packages/subagent-core/src/orchestration extensions/universal/subagent-workflow/src \
  | grep -v __tests__ | grep -v "\.test\.ts"
```

排除非 run 域的同类字面量（record 条目 `status`、trace 节点 `status`、工具返回 `details.status`）后，**对 `RunExecutionSnapshot.status` 的写入点共 5 处**：

| # | 位置 | 符号 | 性质 |
|---|---|---|---|
| W1 | `orchestration/lifecycle.ts:282` | `createRunningRun` | **活体新建写点**（构造即 `running`） |
| W2 | `orchestration/models/workflow-run.ts:183` | `WorkflowRun.transition` | **变更写点（生产零调用）**——唯一把已存在聚合改成 `done` 的地方 |
| W3 | `orchestration/resume-run.ts:782` | `rebuildRunFromRecord` | **恢复路径写点**（resume 重建，恒 `running`） |
| W4 | `extensions/.../jsonl-run-store.ts:497` | `foldRecordStreamToRun`（无 run-settled 帧分支） | **恢复路径写点**（loadAll 重建，恒 `running`） |
| W5 | `extensions/.../jsonl-run-store.ts:518` | `foldRecordStreamToRun`（有 run-settled 帧分支） | **恢复路径写点**（loadAll 重建，恒 `done`） |

W2 的关键实测结论：

```
grep -rn "transition(\"done\"\|transition('done'" --include=*.ts packages extensions
```

生产代码命中 **0 处**（仅注释）；`run.transition("done", …)` 的 8 处调用**全部在测试**（`worker-exit-without-result.test.ts:182`、`worker-message-pump-run-events.test.ts:200,252`、`worker-message-pump-finalize-run.test.ts:252`、`error-recovery-rebuild-failure.test.ts:200`、`lifecycle.test.ts:191,536,621`、`jsonl-run-store-session-file.test.ts:372`）。`WorkflowRun.transition` 是**生产死方法**——连带 `meta.completedAt`（`workflow-run.ts:185`，`transition` 内唯一写入）在活体路径上也不再被写；这与 `evictDoneRunsBeyondCap` 的注释（`lifecycle.ts:602-607`「活体终局后 meta.completedAt 不再更新」）一致。

测试夹具中的直写（属测试面，随类型删除一并清理）：`robustness-low-batch1.test.ts:67,76`、`worker-exit-without-result.test.ts:84`、`worker-message-pump-handlers.test.ts:94,234,289,342`、`tool-workflow.test.ts:799`。

### 1.4 读取点（全量，实测）

命令：

```
grep -rnE "run\.state\.status|this\.state\.status|state\.status\s*=" --include=*.ts \
  packages/subagent-core/src/orchestration extensions/universal/subagent-workflow/src \
  | grep -v "/__tests__/" | grep -v "\.test\.ts" | grep -v "^\S*: *\*"
```

命中 **16 处 / 5 个文件**。逐条性质：

| # | 位置 | 符号 / 用途 | 分类 |
|---|---|---|---|
| R1 | `workflow-run.ts:120,125` | `validateInvariants`（I1：`running ⟺ runtime !== undefined`） | 聚合自校验（随字段删） |
| R2 | `workflow-run.ts:137` | `validateInvariantI2`（`done ⟹ reason !== undefined`） | 聚合自校验（随字段删） |
| R3 | `workflow-run.ts:167,169` | `transition` 转移合法性 | **死路径**（W2 无生产调用） |
| R4 | `workflow-run.ts:208,210` | `assignRuntime` 前置 `status === "running"` | 聚合自校验 |
| R5 | `workflow-run.ts:247,249` | `replaceRuntime` 前置 `status === "running"` | 聚合自校验 |
| R6 | `workflow-run-summary.ts:60` | `runSummary`：`settled !== undefined \|\| run.state.status === "done"` | **展示活体数据面**（第二支） |
| R7 | `terminal-actions.ts:727-728` | `isRunSettled`：`run.state.status === "done" \|\| settledRunRecords.has(...)` | **运行判据**（第二支） |
| R8 | `lifecycle.ts:738` | `recoverCrashedRuns` 收编候选筛选 `status === "running"` | **恢复路径读** |
| R9 | `lifecycle.ts:448` | debug 日志载荷 | 日志（可删） |
| R10 | `lifecycle.ts:498` | debug 日志载荷 | 日志（可删） |
| R11 | `worker-message-pump.ts:1011` | debug 日志载荷 | 日志（可删） |
| R12 | `runtime/.../workflow-extractor.ts:481-482,564` | 对 **v1 冻结快照条目**的值级检查与投影 | 历史数据读面（非聚合字段） |

另有间接消费（不直接读字段，经 R6 派生，构成「展示活体数据面」的下游）：

- `interface/tool-workflow.ts:485 displayStatusOf` → `runSummary(run).status`
- `interface/display-state.ts:48 runDisplayStateOf` → `runSummary`
- `interface/views/WorkflowsView.ts` 头部徽标 / footer abort 可用性 / 渲染签名
- `interface/commands.ts:290-291` 列表排序权重表
- `interface/format.ts:443` `StatusText` 联合类型（`RunStatus` 的 `running` / `done` 是**活体展示入参值**：`displayStatusOf` 与 trace 节点状态都会落进这个联合）
- `workflow-events.ts:398-400` 判活

### 1.5 分类小结

**展示活体数据面（不能删，只能换源）**

- R6 `runSummary` 的 `state.status === "done"` 分支。它的实际作用是让**重水合 done run** 在重启后仍投影为 `done`——进程内终局注册表 `settledRunRecords` 在重启后为空，此时该分支是**唯一**判据。删掉而不换源，重启后历史 done run 会显示成 `running`/`interrupted`。
- R7 `isRunSettled` 的同一分支，影响面比展示更重：`abortRun` 的已终局 no-op（`lifecycle.ts:502`）、`terminateRunningRuns` 的跳过（`lifecycle.ts:558`）、`evictDoneRunsBeyondCap` 的淘汰白名单（`lifecycle.ts:631`）三处都经它。**删掉而不换源 → 重水合 done run 永不淘汰，runs Map 内存无界**。
- `format.ts:443` `StatusText` 的 `RunStatus` 成员（展示层联合类型）。
- `worker-message-pump.ts` 中 7 处 `isRunSettled` 前置检查（`:468,831,1045,1104,1152,1198,1230`）经 R7 间接依赖。

**纯兼容读（可删，随字段一起走）**

- R1–R5：全部是聚合根围绕 `status` 的自我保护（不变式与前置条件），字段删除即消失。
- R9–R11：三处 debug 日志载荷，换 `displayStatusOf` 或直接去掉即可。
- `types.ts` 的 `ALL_RUN_STATUSES` / `VALID_RUN_TRANSITIONS` / `isDone`：全仓零消费，直接删。
- R3：`transition` 死路径，连同 W2 一起删。

**恢复路径写点**

- W3 `resume-run.ts:782`（resume 重建）。
- W4 / W5 `jsonl-run-store.ts:497,518`（loadAll 重建）。这两处是 R6 / R7 那个「done 分支」存在的**唯一理由**——它们是把「终局」写回聚合字段的地方。

**历史数据读面（非聚合字段，另行处置）**

- R12 `workflow-extractor.ts`：读的是 session 文件里 v1 全量快照条目的 `state.status`，而 v1 快照条目已停写（`WORKFLOW_RECORD_CUSTOM_TYPE` 的现行写点全在 `workflow-record-entry.ts` 的 v2 两态条目上）。属冻结历史读面，不在本次字段退役的写读链上。

### 1.6 已存在的机器检查现状

`eslint.config.mjs:523-573` 有一块针对 run 两态机的 `no-restricted-syntax` 守卫：

- 选择器：`CallExpression[callee.property.name='transition'][arguments.0.value='done']`
- 白名单（文件级）：`orchestration/lifecycle.ts`、`extensions/.../jsonl-run-store.ts`，外加测试豁免。
- 规则文案声称白名单理由是「`recoverCrashedRuns` 快照收敛 + 壳 `reconcileRunningFinality`」。

实测两处**已失真**：

1. 白名单的两个文件里**当前没有任何 `transition("done")` 调用**（§1.3 实测生产命中 0）——守卫目前恒不触发。
2. 文案引用的 `reconcileRunningFinality` **全仓不存在**（`grep -rn "reconcileRunningFinality"` 零命中）；`recoverCrashedRuns` 现行走 `interruptRun`（`lifecycle.ts:747` 起），不再写两态机终局。

即：这道守卫的**前提与白名单都已失效**，退役时应整块删除，而不是继续维护。

### 1.7 建议退役顺序

原则：**先换读、再停写、最后删类型**。反过来做（先停写）会让 R6 / R7 立刻失去判据，重水合 done run 的展示与内存淘汰同时坏掉。

#### 第 1 步：换源「恢复路径写点 run 的终局判定」（R6 + R7）

- **换什么**：把 R6 / R7 里 `state.status === "done"` 这一支的判据来源，从聚合字段改为**重建时的 fold 结果**——重建点（W3/W4/W5）本来就持有「有无 run-settled 帧」这一事实（`jsonl-run-store.ts:490 lastRunSettledEvent`、`resume-run.ts` 的 fold），该事实应随重建产物直接带到消费面，而不是绕道聚合字段再读回来。
- **判据**：`grep -rnE 'state\.status === "done"' packages/subagent-core/src packages/runtime/src extensions/universal/subagent-workflow/src | grep -v __tests__` 命中数 = 0；且重水合 done run 的**三处行为**单测全绿（展示投影 = done / `isRunSettled` = true / `evictDoneRunsBeyondCap` 可淘汰）。
- **风险**：`evictDoneRunsBeyondCap` 是 done run 内存有界性的唯一来源（`lifecycle.ts:88-93` 注释明载「内存上限 = K × 聚合大小」）。换源漏改这一处 = 内存无界，且症状滞后（长时间跑才显形），必须有三处行为断言兜底。

#### 第 2 步：清死方法与零消费表

- **删什么**：`WorkflowRun.transition`（W2 + R3）、`canRunTransition`、`VALID_RUN_TRANSITIONS`、`ALL_RUN_STATUSES`、`isDone`；`eslint.config.mjs` 的 `transition("done")` 守卫块（前提与白名单已失效，见 §1.6）。
- **判据**：`grep -rnE "\b(isDone|ALL_RUN_STATUSES|VALID_RUN_TRANSITIONS|canRunTransition)\b" packages extensions` 命中数 = 0；`grep -rn "transition(\"done\"" packages extensions` 只剩测试（或同步清零）；`pnpm lint` 不再报该守卫。
- **风险**：`WorkflowRun` 的 I1/I2（R1/R2）与 `assignRuntime`/`replaceRuntime` 前置（R4/R5）随 `status` 消失后，聚合根**失去自我保护**。「终局 run 不可复活」这一约束必须确认在调用面（pump 层的 `isRunSettled` 前置，7 处）已有等价覆盖；否则会出现「已终局 run 被重新 assignRuntime」的静默复活。

#### 第 3 步：删字段与类型

- **删什么**：`RunExecutionSnapshot.status`（`run-state.ts:35`）、`RunStatus`（`types.ts:39`）、barrel 导出（`index.ts:482`）；三个恢复/新建构造点（W1/W3/W4/W5）不再携带生命周期轴。
- **换什么**：`WorkflowRunSummary.status`（`workflow-run-summary.ts:38`）与展示层 `StatusText`（`format.ts:443`）的 `RunStatus` 成员，改用三态投影词表（`shared` `WorkflowRunStatus` 或 `display-state.ts` 的 `RunDisplayState`）表达。
- **判据**：`grep -rnE "\bRunStatus\b" packages extensions e2e | grep -v node_modules | grep -v dist` 命中数 = 0（历史注释同步清扫）；`subagent-core` / `runtime` / `shared` / `extensions` 四包 typecheck 绿（词表删除的阻断由编译期承载，见 ADR-0080 ⑦）。
- **风险**：`StatusText` 是展示层联合类型，`format.ts` 的 `statusColorToken` / `formatStatusBadge` 两个 switch 与 `tui-kit` 都吃它；成员替换会让「两态成员名与三态成员名部分重合」这件事失去类型保护，需确认 switch 的穷尽性断言仍然成立。

#### 第 4 步：清测试与注释残留

- **删什么**：8 处 `run.transition("done", …)` 测试调用、`run.state.status = …` 测试夹具直写（§1.3 末段清单）、`e2e/fixtures/skill-reload-real-helpers.ts:29,251` 的 `snapshot.state.status` 注释与读取、`workflow-extractor.ts:28` 等注释里的 `RunStatus` 引用。
- **判据**：§1.2 的 `RunStatus` 命令命中数 = 0；§1.3 的写点命令在生产与测试两侧均为 0。
- **风险**：低（纯清理）。唯一需注意：`e2e/fixtures` 的 `snapshot.state.status` 读的是历史 session 快照形态，属冻结历史数据，清理时要与 R12 的历史读面口径一致——不能顺手把历史数据读面也删了（那需要另一份裁决）。

---

## 2. (b) 内活性状态唯一读口分析

### 2.1 现状：「一个 run 当前在跑什么 / 进度如何」由哪些读口分别读出（实测）

共 **5 个直接读口 + 2 个派生面**，跨 3 个进程/扩展边界：

**R-A. 进程内聚合根快照（`WorkflowRun.state`）——活体真源**

写入方 = `worker-message-pump.ts`：`trace.append`（`:715`）、`calls.set`（`:746,763`）、`errorLogs.push`（`:528`）、budget 经 `executeAgentCall`（`:825`）。

读方：

- TUI `interface/views/WorkflowsView.ts`：trace（`:153,224,321,327,458,601,709,1048`）、budget（`:226,714,1066`）、errorLogs（`:233`）
- `interface/views/detail-content.ts:225`（errorLogs）
- `workflow-notify.ts:194,260`（trace）
- `workflow-events.ts:543`（`calls.size` 计数）
- `terminal-actions.ts:1198,1209`（`closeOutInFlightCalls` 读写 calls/trace）
- `terminal-actions.ts:1378-1379`（`callCount` / `usedTokens` 进终态条目）
- `run-events.ts:163`（calls）

**R-B. per-call 进度投影（record store 查询）——TUI 的 token/工具数/活动/耗时唯一来源**

链路：`commands.ts:322` 注入 `() => service.queries.collectRecordsByParentRunId(run.runId, LIST_LIMIT)` → `subagent-service.ts:409` → `record-store.ts:986 collectRecordsByParentRunId` → `mergedRecords` 四源合并（磁盘重建 `reconstructAll` ∪ entry 源 ∪ manifest 源 ∪ 内存源）→ `WorkflowsView.ts:150 collectNodeLiveProgress` 按 task+startedAt 配对到 running trace 节点 → `detail-content.ts:72 projectRecordProgress` 产出 `LiveProgressView`（`detail-content.ts:51`）。

**R-C. 进程内状态机 fold 检查点与终局记录注册表**

- `terminal-actions.ts:108 liveRunStates: Map<runId, RunLifecycleState>`——per-run 活体状态，`appendTransition` 写入（terminal 时 delete），`dispatchRunTriggerInner:518` 读。**只承载生命周期，不承载任何进度量**（无 trace/budget/calls）。
- `terminal-actions.ts:721 settledRunRecords: Map<runId, RunSettlementRecord>`——终局记录，`isRunSettled:727` / `settledRecordOf:732` 读。
- 两者都是**模块级全局 Map，key 只有 runId，不按 journal 目录分区**。

**R-D. record 流全量 fold（每次 IO，无缓存）**

- `terminal-actions.ts:264 scanRunEvents` → `foldRunState:138`（壳内、事件投递用）
- `run-registry.ts:120 projectRunRegistryEvents`（纯投影，无 IO）
- 壳 `JsonlRunStore.loadAll` → `foldRecordStreamToRun`（`jsonl-run-store.ts`，重建聚合）；`JsonlRunStore.settledRecordOf:616` 每次调用**重新读该 run 的整条流**
- core `resume-run.ts:750 rebuildRunFromRecord`（resume 资格与重放）

**R-E. runtime 每会话内存投影（tailer + 增量 fold）——renderer 侧唯一读口**

- `runtime/src/services/session/journal-projection.ts:655 SessionJournalProjection`
- 持 `sources.runFolds: Map<runId, RunEventFoldCheckpoint>`，经 `createEventDirectoryTailer`（`:689`）增量 `foldRunEventCheckpoint`（`:766 applyRunEvents`）续读；`recompute:778` 合并成 `workflows: Map<runId, WorkflowRunRecord>`
- 出口：`sessionApi.getWorkflows` → renderer `stores/workflow.ts:266` → `TrayNativePanel.vue` / `WorkflowTab.vue` / `tray-tone.ts` / `useTrayCounts.ts`

**R-F（派生）. 渲染签名与缓存**

`WorkflowsView.ts:221 computeRenderSignature` + 200ms tick + `cache{key,lines}`；签名把 R-A 的 trace/budget/errorLogs 与 R-B 的 live 七字段一并纳入。

**R-G（派生）. shared 投影词表**

`shared/workflow.ts:25 WorkflowRunStatus` 三态 / `:165 WorkflowRunRecord`；runtime `workflow-extractor.ts:481,564` 是 v1 冻结快照的历史读面（已停写）。

**关键事实：fold 检查点已经存在，且已经是增量缓存。**

`run-events.ts:941 RunEventFoldCheckpoint`（`state` + `lastSeq` + `created`/`asks`/`phases`/`interrupted`/`resumed`/`runSettled` 骨架）、`foldRunEventCheckpoint:1153`、`INITIAL_RUN_EVENT_FOLD:947`。它已被 runtime 投影当作进程内缓存使用。所以 D6(b) 的实质不是「新建缓存」，而是**把 R-A/R-B/R-C/R-D 四个读口收敛到这一个 fold 产物上**。

### 2.2 失效条件逐条分析

| # | 失效条件 | 现状机制（实测） | 失效面 | 判断 |
|---|---|---|---|---|
| E1 | **tail 截断**（文件变短 / 重建 / 轮转） | `readEventTail` 的 `truncated` 标志 → 从 0 全量重读；tailer `onReset` 回调删除 fold（`journal-projection.ts:701`） | 无陈旧值：截断即全量重放。代价是一拍延迟（offset 只落完整行边界，末段不完整行留待下次） | **可控**（机制已在） |
| E2 | **坏帧**（行可解析、但转移表外） | `foldRunEventCheckpoint` catch → `onBrokenFrame` → `break`，**checkpoint 不推进 `lastSeq`**（`run-events.ts:1180-1204`） | 下一批增量会重新喂同一帧、再次 `break` → **该 run 的 fold 永久冻结在坏帧前，直到文件被截断/重建或进程重启**。注意区分：解析层坏行是「跳过 + 计数」（`journal-tail.ts` 头注），转移层坏帧没有对应的跳过规则 | **不可控（需额外机制）** |
| E3 | **跨进程写** | `journal-tail.ts:29` 明载「extension 与 runtime 各自 tail 同一批 journal 文件」；fs.watch 在 macOS 有静默丢事件前科，靠周期复查兜底（缺省 **30s**，可注入） | 唯一读口若落在某个进程内，另一进程的写入最坏 **30s** 后才可见。且 R-C（`liveRunStates`）与 R-E（`runFolds`）是两份互不失效的独立缓存 | **可控但需接受上界**（需下调复查间隔或改事件驱动） |
| E4 | **重启** | 冷启动 `attach()`（`journal-projection.ts:737`）全量重放；壳 `session-lifecycle.ts` 经 `recoverCrashedRuns` → `loadAll` | 缓存清空后重放，语义正确。**但壳 `JsonlRunStore` 与 runtime `journal-projection` 是两套独立重建实现**（`foldRecordStreamToRun` vs `foldRunEventCheckpoint` + `mergeJournalProjection`），同一 run 在 TUI 与 renderer 两处可能投影出不同形态 | **可控，但收敛前必须先统一两套重建** |
| E5 | **run 终局** | terminal 是吸收态；`liveRunStates` 在 terminal 时 delete（`appendTransition` 内），`settledRunRecords` 保留 | 终局后的迟到非诊断帧走 `transition` → 表外 → 落进 E2 的同一条**永久卡死路径**（`worker-log` 帧有单独水位放行，`run-events.ts:1167-1175`） | **需额外机制**（须有「terminal 后忽略非诊断帧」的显式规则） |
| E6 | **目录参数化 / 多实例** | `liveRunStates` 与 `settledRunRecords` 是模块级 Map，**只按 runId 分区**；`journalDir` 只进 `foldRunState` 的解析参数。`runId` 形态 = `wf-<Date.now()>-<随机 base36 片段>`（`lifecycle.ts:95`），未做全局唯一性保证 | 多 session / runtime 收编链（显式传 `journalDir`）并发时，同名 runId 会串读另一目录的 fold | **需额外机制**（fold 缓存须按 (dir, runId) 分区，或先证实 runId 全局唯一） |
| E7 | **目录不存在 / pi 延迟写入窗口** | `recordsDir` / `runJournalDir` 为 undefined 时 `SessionJournalProjection` 降级为 entry-only（无 tailer） | 该降级形态下 fold 缓存恒空 → 唯一读口无进度可读 | **可控**（已知降级，语义显式，但唯一读口必须保留这条降级路径） |
| E8 | **record 文件被保留窗清理** | `run-state-evidence` 维护轮按保留窗清理已终局 run 的 record 流 + manifest | 缓存与磁盘不再一致（缓存有、磁盘无）。对终局 run 无害，但缓存条目必须随 run 淘汰回收，否则内存无界 | **可控**（已有 `forgetSettledRecord` 同生命周期回收先例） |
| E9 | **无 seq 存量行与带 seq 新行混排** | 无 seq 的行不跳过、不推进水位（D7 兼容读，`run-events.ts` fold 注释） | 每轮增量都会重放这些行。若 `transition` 对重放不幂等，则触发 E2 卡死 | **待确认**（见 §3） |
| E10 | **同一 run 被两套 fold 读** | 壳 `JsonlRunStore` 每次全量读（无缓存）与 runtime tailer 增量读并存 | 两者语义一致，无冲突；但「唯一读口」若只收敛其中一套，另一套仍是第二事实 | **可控**（需明确收敛哪一套） |

### 2.3 结论

**建议：暂不做「fold checkpoint 作为内活性状态唯一读口」；先做 §1.7 的 (a) 退役，再把 E2 / E5 / E6 三项前置补掉后重审。**

理由（全部基于实测）：

1. **收敛的前提不成立**。唯一读口要成立，缓存失效面必须可控；而 E2（转移层坏帧永久卡死 fold 且无跳过规则）、E5（终局后迟到帧走同一条卡死路径）、E6（fold 缓存不按目录分区）三项当前分别是「不可控」与「需额外机制」。
2. **收敛会把现在被掩盖的问题暴露出来**。今天 E2 的卡死是**无害**的——因为 R-A（聚合快照）是独立的活体真源，TUI 仍能看到真实进度，坏帧只影响 fold 侧。一旦 fold 成为唯一读口，同一个坏帧就会让该 run 的进度与状态**永久冻结**，而没有任何旁路可读。
3. **当前并不存在一个「能同时产出状态与进度」的 fold**。`RunEventFoldCheckpoint` 只承载状态机 + `created/asks/phases/interrupted/resumed/runSettled` 骨架，**不承载 budget / errorLogs / calls 详情 / trace 节点**；后者由壳 `foldRecordStreamToRun` 另行重建（`budget` / `errorLogs` / `calls` 各一段独立折叠逻辑）。「唯一读口」要覆盖 R-A 的全部字段，前提是先把这两套 fold 合一——这本身就是独立工作量，不是缓存引入问题。

**若做，最小落地形态（不含实现）：**

- **持缓存者**：core 侧——`RunEventFoldCheckpoint` 与 `foldRunEventCheckpoint` 已经是正确的形态与位置（纯函数、`lastSeq` 水位、增量接续），扩展它承载进度骨架比在壳侧另起缓存更合理。消费方（runtime `SessionJournalProjection` 与壳）共用同一 checkpoint 类型与同一 fold 函数，而不是各自折叠。
- **谁失效它**：三条缺一不可——① tailer 的 `onReset`（截断，已有）；② **显式的坏帧跳过规则**（当前缺失，是 E2/E5 的正解）；③ 周期复查（已有，但 30s 上界需下调或改事件驱动，E3）。另外必须把缓存按 (journalDir, runId) 分区（E6）。
- **如何证明不会读到陈旧值**：以 `lastSeq` 水位 + 文件 stat 戳做双重校验——**先例已存在**：`record-store-rebuild.ts:389 isFreshCache` 用 jsonl 的 mtime/size + binding + events 三戳判缓存新鲜度，`record-store.ts:1406 reconstructAll` 还用目录 mtime 做整目录快路径。断言形态应是「缓存命中 ⟹ 戳未变」，而不是「缓存命中 ⟹ 假定未变」。

---

## 3. 待确认

1. **`runId` 是否全局唯一**（决定 E6 能否只按 runId 分区缓存）。已知形态 = `wf-<Date.now()>-<随机片段>`（`lifecycle.ts:95`），无唯一性保证代码；缺的是「跨 journal 目录同名是否可达」的判定（需查 `runId` 的消费面是否假设全局唯一）。
2. **`transition` 对重放事件的幂等性**（决定 E9 是否触发 E2 卡死）。缺的是：无 seq 存量行与带 seq 新行混排时，重复喂入同一 `run-created` / `agent-started` 是否抛表外转移的实测。
3. **壳 `JsonlRunStore` 与 runtime `journal-projection` 两套重建的投影等价性**是否有现成断言覆盖（E4）。本次只核实到两者是不同实现（`foldRecordStreamToRun` vs `foldRunEventCheckpoint` + `mergeJournalProjection`），未找到对拍测试。
4. **`liveRunStates` 的回收面是否覆盖全部终局路径**（E8 内存有界性）。已核实 `appendTransition` 在 terminal 时 delete；未逐一核实 `evictDoneRunsBeyondCap` / `forgetSettledRecord` 路径是否也清 `liveRunStates`。
5. **R12（`workflow-extractor.ts` 的 v1 冻结快照读面）是否属于本次退役范围**。它读的是历史 session 条目的 `state.status`，不是聚合字段；是否随「裁决点 7 清理自然消亡」需要另行裁决。
6. **`eslint.config.mjs` 守卫块的删除时点**：其前提与白名单已失效（§1.6），是随第 2 步一起删，还是先修文案再删，需定。
