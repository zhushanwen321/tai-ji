# Subagent 持续对话 V2 实施 gap 分析

> **一句话结论**：V2 是**收敛/重构现有补丁机制为终态架构**，不是从零搭建。当前分支已有 v1「每轮 kill + resume」的完整实现（idle 状态机、消费确认制、`.idle` sidecar、reaper 豁免、notifier 轮次豁免），V2 的工作是**删的比写的多**——删掉一整套 kill-per-round 并发症，新增 lifecycle-manager（全新模块）+ agent_settled 信号 + 统一投递 + identity 子进程写。关键派发依据见末尾「三关键问题」与「派发策略」。
>
> **工作量定义**：S = 单一关注点 / <50 行净改动 / 无跨文件协调；M = 50-200 行 / 多文件协调 / 一个完整机制改造；L = >200 行 / 全新模块 / 大范围范式重构。

## 执行摘要（每文件一行）

| # | 文件 | 现状一句话 | gap 性质 | 工作量 |
|---|---|---|---|---|
| 1 | `execution/session-runner.ts` | agent_end handler 决定 keep-alive(MF-3/MF-4) 或 SIGTERM；父进程 fs 补写 identity；pump 只认 agent_end | 改+删+新增 | **L** |
| 2 | `execution/subagent-service.ts` | resumeRound 每轮重开 session；deliverToRunning 用 steer/followUp 命令；无 PID 持久化 | 改+删+新增 | **L** |
| 3 | `interface/subagent-actions.ts` | messageHandler 按 running/idle 二分流，idle 走 resumeRound（v1 重开） | 改（简化分流） | S-M |
| 4 | `execution/idle-marker.ts` | `.idle` sidecar 读写删工具模块（81 行） | **删整文件** | S |
| 5 | `execution/record-store.ts` | idle 重建分支 + STATUS_PRIORITY 含 idle 键；record 无 pid | 删+新增 | M |
| 6 | `execution/finalize-record.ts` | doFinalizeRoundToIdle 翻转 idle + 写 .idle + 补投 | **删整个函数** | S |
| 7 | `execution/worktree-manager.ts` | reaper 的 isOrphan 有 .idle 豁免判据 | 删判据 | S |
| 8 | `execution/notifier.ts` | dedupKey=`${id}:${round}` 轮次豁免；纯被动通知器（挂载点在 session-runner） | 删+改 | S-M |
| 9 | `execution/session-reconstructor.ts` | 按 customType 全量扫 identity；reconstructFromFile 不读 .idle | 基本不动 | S |
| 10 | `src/index.ts` | 有 session_shutdown（无 process 级 hook）；session_start 不写 identity | 新增 | M |
| 11 | `execution/lifecycle-manager.ts` | **不存在**（`orchestration/lifecycle.ts` 是 Workflow run 生命周期，无关） | **全新模块** | **L** |

## 关键发现（决定派发策略）

1. **lifecycle-manager.ts 完全不存在**，V2 的 5 项职责（idle timer / 全局 ceiling / shutdown 收割 / 孤儿扫描 / activate 互斥）全部从零新建。但部分能力散落现有代码可复用：keep-alive 超时骨架（session-runner MF-3/MF-4）、进程句柄 Map（`spawnedChildren`）、dispose 时 killAllSpawnedChildren。
2. **keep-alive（MF-3/MF-4）是改造复用，不是替换也不是共存**：MF-3/MF-4 是「agent_end 触发 kill，但有理由暂缓 kill」的临时保活；V2 idle timer 是「agent_settled 后不 kill，挂 timer 等续聊/超时」。setTimeout→SIGTERM 骨架可复用，但触发条件（后代/recentUnregister）和完成事件（agent_end→agent_settled）都要重构。
3. **统一投递：messageHandler 已支持续聊结构，但走 v1 resumeRound（每轮重开 session）**。deliverToRunning 的热路径（getChildByRecord→child.stdin）形态正确、V2 可复用，但因每轮 kill 进程句柄只在一个轮次内存活。V2 把进程生命周期从「单轮」拉长到「整个对话」即可原样复用这条热路径。
4. **identity fs 补写是独立 bug 源**（tree 污染），与 kill-per-round 正交——无论范式如何都要修，V2 改由子进程 session_start 写。

---

## 逐文件 gap 分析

### 1. `execution/session-runner.ts`（1139 行）— **L，核心战场**

| 关注点 | 现状 | V2 要求（§5.3） | gap |
|---|---|---|---|
| **agent_end handler** | `isAgentEndEvt` 守卫（L67-76）+ handler（L936-986）：非 willRetry 时读活跃后代，三分支决策 | 完成信号换挂 `agent_settled`（F6：agent_end 后 post-run loop 还跑） | **改**（M）：pump 加 `agent_settled` 守卫+handler，notify/idle timer/可回收状态全挂它 |
| **kill 分支** | 无活跃后代+无 recentUnregister → `child.kill("SIGTERM")`（L978）。**chatMode 完全不参与 kill 决策**，对话模式与一次性模式同构 | 对话模式（chatMode）**不 kill**，进空闲+启 idle timer | **改**（M）：加 chatMode 分支 → 不 kill + 启动 idle timer（委托 lifecycle-manager）。MF-3/MF-4 骨架可复用为 timer 模板 |
| **MF-3 recentUnregister 宽限** | `WAKEUP_GRACE_MS=15_000`（L111），应用 L975：后代刚完成、唤醒未到的竞态宽限 | V2 进程不因轮次死，竞态窗口从「每轮」缩到「仅崩溃」 | **改/删**（S）：MF-3 原始触发条件（recentUnregister）失效，超时骨架可并入 idle timer |
| **MF-4 活跃后代等待** | `computeWatchdogMs`（L128-134）：floor 30min + 5min/turn，应用 L963：有活后代时保活 | 同上，MF-4 触发条件（活后代）仍部分有效，但语义从「暂缓 kill」变「长驻等续聊」 | **改**（S）：保留「有活后代不回收」语义，并入 lifecycle-manager |
| **identity fs 补写** | 父进程 `fs.appendFileSync`（L1079-1100）写 custom entry（`SubagentIdentityData`，含 id/agent/mode/task/slug/startedAt/rootSessionId/parentRecordId/depth/forkDepth/chatMode） | identity 由**子进程** session_start hook 写（决策 5） | **删**（S）：删 L1079-1100 整段 |
| **childEnv 组装** | L745-764，仅 5 个 `PI_SUBAGENT_*` env（FORK_DEPTH/ROOT_SESSION_ID/SELF_RECORD_ID/DEPTH/ROOT_CWD） | 全字段经 env 传子进程（id/agent/mode/task/slug/startedAt/rootSessionId/parentRecordId/depth/forkDepth/chatMode） | **改**（S-M）：补全 ~8 个 identity env 字段 |
| **事件 pump** | L892-1000，按 `parsed.kind` 分发（header/event/response/extension_ui_request）；handleSdkEvent（L627-690）处理 tool/message/turn/compaction。**零 `agent_settled` 引用** | pump 加 `agent_settled` 跟踪 | **新增**（M）：加 `isAgentSettledEvt` 守卫 + handler |

**可复用**：`spawnedChildren` Map（L194）+ `getChildByRecord`（L243-245）+ `killAllSpawnedChildren`（dispose 调用）+ MF-3/MF-4 超时骨架。

### 2. `execution/subagent-service.ts`（1472 行）— **L，核心战场**

| 关注点 | 现状 | V2 要求（§5.3） | gap |
|---|---|---|---|
| **resumeRound** | L628-689：idle record 重新 spawn（`--session` resume）+ prompt。三重前置校验 + `record.status="running"`（L652 直接赋值）+ 从 record.identity 重建 resume 参数（防模型漂移，P-10）+ kickOffBackground | resumeRound 改为统一投递的**冷路径**（进程死了才走） | **改**（M）：逻辑大体复用（它本就是冷路径形态），改调用时机（从「每轮必走」→「进程死了才走」）+ 去掉 idle 前置校验（改判进程死活） |
| **idle→running CAS** | L652-653：**实际无 CAS**，直接 `record.status="running"`（绕过 tryTransition，因 tryTransition 只认 running→终态，execution-record.ts L557-562） | 删 idle→running CAS（终态无 idle 持久态） | **删**（S）：删 L652-653 + 放宽 tryTransition |
| **消费确认制（入队）** | `deliverToRunning` L584-589：`record.pendingMessages.push(...)` 投递前先入队 | 降级为 best-effort 重发（决策 6） | **删**（S）：删入队逻辑 |
| **消费确认制（清除）** | session-runner.ts `message_start` handler L677-691：`pendingMessages.shift()`（FIFO） | 同上 | **删**（S）：跨文件，与 session-runner 联动 |
| **消费确认制（补投）** | finalizeRoundToIdle 编排 L1283-1305 → doFinalizeRoundToIdle → `redeliverPendingMessages` L1306-1314 → resumeRound | 同上 | **删**（S-M）：删补投链路 |
| **PID 持久化** | **完全缺失**。ExecutionRecord（types.ts L338-414）无 pid 字段；子进程句柄在 session-runner `spawnedChildren` Map（进程内、不持久化、跨重启失效）；唯一进程控制是 `controller: AbortController`（只能 abort→SIGTERM，不能保留复用） | record 持久化 PID（收割/判活用，决策 7） | **新增**（M）：ExecutionRecord 加 pid 字段 + spawn 时记录 + record 持久化（与 record-store 联动） |
| **getChildByRecord** | session-runner.ts L243-245：从 `spawnedChildren` Map 取活进程。deliverToRunning 热路径用它（L593）→ child.stdin | 统一投递热路径复用它 | **不动**（S）：形态正确，V2 原样复用，只是生命周期拉长 |
| **deliverToRunning** | L582-604：getChildByRecord → `sendSteerCommand`/`sendFollowUpCommand` 写 child.stdin | 统一为 `prompt(streamingBehavior: interrupt?"steer":"followUp")`（决策 3） | **改**（M）：steer/followUp 命令路径改为 prompt+streamingBehavior 路径（pi 权威裁决） |

### 3. `interface/subagent-actions.ts`（510 行）— S-M

| 关注点 | 现状 | V2 要求（§5.3） | gap |
|---|---|---|---|
| **messageHandler** | L330-363：按 `record.status` 二分流——running→`deliverToRunning`（L348）；idle→`resumeRound`（L351）；终态→throw（L354）。入参只有 `interrupt`，无 `streamingBehavior` | 改为统一投递入口（streamingBehavior 裁决，无 steer 命令、无 clearQueue，父进程零 busy 状态） | **改**（S-M）：handler 是分流层（非实现层），改动小——去 running/idle 二分流，统一调「确保活进程+投递」。真正实现改动在 service 层 |

### 4. `execution/idle-marker.ts`（81 行）— S，删整文件

| 关注点 | 现状 | V2 要求（§5.3） | gap |
|---|---|---|---|
| **`.idle` sidecar 工具模块** | `writeIdleMarker`（L39-41）/`readIdleMarker`（L50-71）/`removeIdleMarker`（L78-82）+ `IdleMarker` interface（L12-22，含 id/sessionFile/rootSessionId/round）。纯工具模块，无内部调用 | **删除**（.idle sidecar 不再需要） | **删**（S）：整文件删除。调用方清理：finalize-record.ts（writeIdleMarker L228）、record-store.ts（readIdleMarker L328）、worktree-manager.ts（readIdleMarker L241 + import L29） |

### 5. `execution/record-store.ts`（477 行）— M

| 关注点 | 现状 | V2 要求（§5.3） | gap |
|---|---|---|---|
| **idle 重建分支** | `reconstructAll`（L300-406）分支 2.5（L375-382）：`.idle` sidecar 存在 → `markReconstructedStatus("idle")` + `rec.round = idle.round`。不查 pid 死活 | 删 idle 重建分支 | **删**（S）：删 L375-382。删后续聊态走分支 3（`.alive`+pid 存活→running） |
| **STATUS_PRIORITY** | L38-45，含 `idle:2`（L42）。消费于 `compareRecords`（L409-412），被 `collectRecords` sort（L251） | 删 idle 键 | **删**（S）：删 L42 `idle:2`。**必须同步删 types.ts L41 `ExecutionStatus` 的 `"idle"` 字面量**（否则 `Record<ExecutionStatus, number>` 类型报错） |
| **record 结构（PID）** | types.ts `ExecutionRecord`（L338-414）无 pid/processId/childPid；唯一进程控制 `controller: AbortController`（L413） | record 加 PID 持久化 | **新增**（M）：与 subagent-service 联动加 pid 字段 + 持久化 |
| **round 字段持久化** | round 仅存内存 record + `.idle` sidecar 两处 | 删 sidecar 后 round 跨重启丢失 | **需设计决策**（M）：round 在 V2 的去向后（notifier 删轮次豁免），若 UI 仍需显示轮次，要另寻持久化；若不需要可一并删除 |

### 6. `execution/finalize-record.ts`（276 行）— S，删整函数

| 关注点 | 现状 | V2 要求（§5.3） | gap |
|---|---|---|---|
| **doFinalizeRoundToIdle** | L206-276：对话模式轮次结束翻转 idle——写 `.idle` sidecar（L228）+ 删 `.alive`（L223）+ `record.status="idle"`（L244）+ `round+1`（L245）+ `emitUnregister`（L241）。**不**completeRecord / 不 archive / 不 cleanup worktree | 删 doFinalizeRoundToIdle | **删**（S）：整个函数删除（L206-276） |
| **消费确认补投** | L256-275：`pendingMessages.length>0` → 清空 → 合并文本 → `setTimeout(0)` 调 `redeliverPending`→resumeRound 重投 | 删补投 | **删**（S）：删 L256-275 |
| **入队/清除** | 本文件缺失（入队在 subagent-service L584-589，清除在 session-runner L677-691） | — | 本文件维度无 gap |

### 7. `execution/worktree-manager.ts`（311 行）— S

| 关注点 | 现状 | V2 要求（§5.3） | gap |
|---|---|---|---|
| **reaper .idle 豁免** | `scan`（L219-229）→ `isOrphan`（L239-259）。豁免判据 L240-243：`entry.sessionFile && readIdleMarker(sessionFile)` → return false（非孤儿）。判据是 sidecar 文件存在性（非 record.status、非 flag） | 删 reaper 的 .idle 豁免判据 | **删**（S）：删 L240-243 + import L29。删后 pid 死活主判据（L258：`pid>0 && !isProcessAlive`→孤儿）天然覆盖（V2 idle record pid 仍活，自然非孤儿） |

### 8. `execution/notifier.ts`（258 行）— S-M

| 关注点 | 现状 | V2 要求（§5.3） | gap |
|---|---|---|---|
| **对话模式 dedup 轮次豁免** | `BgNotifyRecord.status` 含 `"idle"`（L18）+ `round?`（L26-30）+ `dedupKey=\`${id}:${round??0}\``（L120-122）+ idle 文案（L236-238）。豁免是数据驱动（非分支）：对话模式 round 每轮不同 → 60s 内多轮不被吞 | dedup 回归一次性语义（删轮次豁免） | **删+改**（S）：删 round 字段（L26-30）、status 的 idle（L18）、idle 文案（L236-238）、dedupKey 回归 `${record.id}`（L120-122） |
| **完成信号挂载** | notifier 是**纯被动通知器**，不挂任何 pi 事件。挂载点在 session-runner.ts（agent_end handler 调 notify）。`doSend`（L191-219）用 `sendMessage({customType:"subagent-bg-notify", triggerTurn:true, deliverAs:"steer"})` 唤醒主 agent | 完成信号换挂 `agent_settled` | **改**（M，在 session-runner）：notifier 内部改动小；改的是调用方 session-runner 从 agent_end 触发改挂 agent_settled 触发 |

### 9. `execution/session-reconstructor.ts`（474 行）— S，基本不动

| 关注点 | 现状 | V2 要求（§5.3） | gap |
|---|---|---|---|
| **identity 全量扫** | `IDENTITY_CUSTOM_TYPE="subagent-identity"`（L130）；`isIdentityData`（L242-252）；扫描循环 L335-345（按 customType 全量扫，在 entries 遍历中匹配）；来源是 session.jsonl 文件 | 确认「按 customType 全量扫」仍成立（identity 位置变化后） | **不动**（S）：已成立，只要 identity 仍是 custom entry（无论子进程 session_start 写还是父进程 fs 补写），扫描逻辑不需改 |
| **水合逻辑** | `reconstructFromFile`（L293-466）：四阶段纯函数防御式重建。**不读 `.idle` sidecar**（round 来自 sidecar 由 reconstructAll 填，本函数不感知） | 水合逻辑适配「无 idle 持久态」 | **小改**（S）：本函数天然免疫（不读 sidecar）。主要适配在 reconstructAll（record-store）。`chatMode` 字段（SubagentIdentityData L102-104 写、L150 读）保留（业务模式标记，非状态机）；round 字段配合 record-store 设计决策处理 |

### 10. `src/index.ts`（557 行）— M

| 关注点 | 现状 | V2 要求（§5.3） | gap |
|---|---|---|---|
| **process 级 shutdown hook** | **完全缺失**。只有 `session_shutdown` hook（L397-440：dispose + pause runs + rejectAll）。`process.on`/`SIGTERM`/`SIGINT`/`beforeExit` 零命中——进程被 kill -9/崩溃时 session_shutdown 不触发，子进程不被收割 | 注册 shutdown hook（收割全部 activation，决策 7） | **新增**（M）：新增 `process.on` SIGTERM/SIGINT/beforeExit，调 lifecycle-manager 收割全部 activation |
| **session_start 写 identity** | session_start hook 存在（L214-356），但**不写 identity**（只做两域装配：subagents 域 + workflow 域） | 新增子进程 session_start hook（identity 写入，全字段 env） | **新增**（M）：给现有 hook 新增职责——读 `PI_SUBAGENT_*` env + `pi.appendEntry`。**需主/子进程判定**（extension 经 `--extension` 主子进程都加载，identity 只应在子进程写） |
| **已注册 hook 清单** | resources_discover（L112）、session_start（L214）、model_select（L360）、session_tree（L376）、session_shutdown（L397）+ 2 个 before_agent_start injector | — | 无 agent_settled 监听（需在 session-runner pump 加，非本文件） |

### 11. `execution/lifecycle-manager.ts`（V2 新增模块）— **L，全新**

| 职责 | 现状 | V2 要求（§5.2 模块 1） | gap |
|---|---|---|---|
| **idle timer** | 部分能力散落：MF-3（WAKEUP_GRACE_MS 15s）/MF-4（computeWatchdogMs 动态）是「agent_end 后暂缓 kill」的临时保活 | per-record idle timer（agent_settled arm / 新 turn disarm / 超时 SIGTERM） | **新增**（M）：新建。MF-3/MF-4 超时骨架可复用为模板，触发条件重构 |
| **全局 ceiling** | **完全缺失** | 全局活进程上限，最久空闲挤出（LRU） | **新增**（M）：全新 |
| **shutdown 收割** | 部分：`killAllSpawnedChildren`（session-runner，dispose 时调 subagent-service L408），但只在 session_shutdown 触发，无 process 级 hook | 父进程 shutdown hook 显式 SIGTERM 全部 activation | **新增**（S-M）：与 index.ts 的 process hook 联动 |
| **孤儿扫描** | 部分：worktree-manager `isOrphan` 按 pid 死活判（但维度是 worktree，非 subagent record） | 父进程启动时按持久化 PID 扫收孤儿 | **新增**（M）：全新。依赖 record 持久化 PID（与 record-store 联动） |
| **activate 互斥** | **完全缺失**。spawnedChildren Map 是单例但无互斥/串行化 | 单 activation 不变量（activate 前确认旧进程死透，并发 message 串行化） | **新增**（M）：全新 |

---

## 三关键问题详解

### (a) `lifecycle-manager.ts` 是否已存在？覆盖了哪些 V2 职责？

**不存在。** `execution/` 目录下无该文件；`src/orchestration/lifecycle.ts` 是 **Workflow run 生命周期**（pause/resume/abort/pauseRun/runWorkflow，D-12），与 subagent 进程生命周期无关。

V2 的 5 项职责（idle timer / 全局 ceiling / shutdown 收割 / 孤儿扫描 / activate 互斥）**全部从零新建**。但部分能力散落现有代码可复用：

| V2 职责 | 现有散落能力 | 复用程度 |
|---|---|---|
| idle timer | MF-3 `WAKEUP_GRACE_MS=15s`（session-runner L111）+ MF-4 `computeWatchdogMs`（L128-134）= setTimeout→SIGTERM 骨架 | **骨架可复用**，触发条件（后代/recentUnregister）需重构为（chatMode+agent_settled） |
| shutdown 收割 | `killAllSpawnedChildren`（session-runner，dispose 时 subagent-service L408 调） | **可复用**，但缺 process 级 hook（index.ts）触发 |
| 进程句柄 | `spawnedChildren: Map<recordId, ChildProcess>`（session-runner L194）进程内单例 + `getChildByRecord`（L243-245） | **可复用**，但不持久化、不跨重启 |
| 孤儿扫描 | worktree-manager `isOrphan`（L239-259）按 pid 死活判 | **维度错配**（worktree 维度非 subagent record 维度），需新建 record 维度扫描 |
| 全局 ceiling | 无 | **完全新建** |
| activate 互斥 | 无 | **完全新建** |

### (b) 现有 keep-alive（MF-3/MF-4）与 V2「agent_settled 信号 + idle timer」是什么关系？

**V2 是改造复用，不是替换，也不是共存。** 三者解决的是不同问题，但实现骨架可复用：

| 机制 | 解决的问题 | 触发 | 完成事件 | 动作 |
|---|---|---|---|---|
| **MF-3**（recentUnregister 宽限 15s） | 后代刚完成、唤醒 steer 尚在路上的竞态 | agent_end + recentUnregister（差集 0 但 60s 内有 unregister） | agent_end | 暂缓 kill 15s |
| **MF-4**（活跃后代等待，动态 30min+） | 有真实活后代，不能 kill | agent_end + pending.count>0 | agent_end | 暂缓 kill（动态超时） |
| **V2 idle timer** | 对话完成后进程长驻，等下一条消息或超时回收 | chatMode + agent_settled（真空闲） | **agent_settled**（F6：agent_end 后 post-run loop 还跑） | 启动 timer，超时 SIGTERM |

**关系判定**：
- **不是替换**：MF-3/MF-4 的超时骨架（setTimeout→child.kill SIGTERM，session-runner L963/L975）正是 V2 idle timer 想要的实现模板，直接复用。
- **不是共存**：V2 不保留 MF-3/MF-4 的原始触发条件。MF-3（recentUnregister 竞态）和 MF-4（活后代保活）是 v1 kill-per-round 下的竞态防护——V2 进程不因轮次死，竞态窗口从「每轮」缩到「仅崩溃」（决策 6），MF-3 的 recentUnregister 触发条件失效。
- **是改造复用**：V2 把「完成信号」从 agent_end 换成 agent_settled（F6），把「完成后的动作」从「kill（MF-3/MF-4 可暂缓）」换成「启动 idle timer（超时才 kill）」。代码层面，session-runner agent_end handler（L936-986）的三分支（MF-4 L963 / MF-3 L975 / kill L978）被重构为：chatMode+agent_settled → 委托 lifecycle-manager 启动 idle timer（不 kill）。MF-4 的「有活后代不回收」语义仍有价值，并入 lifecycle-manager 的 ceiling/timer 判据。

### (c) 统一投递：subagent-actions.ts 现在已支持 conversation 模式续聊吗？用什么机制？

**结构上已支持，但走的是 v1 的 resumeRound（每轮重开 session），不是 V2 的「进程保活下直接 prompt」。**

**现状机制**（`messageHandler` subagent-actions.ts L330-363，按 `record.status` 二分流）：
- **running 分支**（L348 `deliverToRunning`）：`getChildByRecord`（session-runner L243-245）拿 child handle → `sendSteerCommand`（interrupt=true）/ `sendFollowUpCommand`（interrupt=false）写 child.stdin。**这已是热路径形态**（V2 可复用），但因每轮 kill，child handle 只在一个轮次内存活。
- **idle 分支**（L351 `resumeRound`）：重新 spawn（`--session` resume）+ prompt。**这是 v1 每轮重启机制**（resumeRound L628-689），且**丢弃 interrupt 参数**（L351 只传 record/text，注释「interrupt 自动退化，agent 无感」）。
- **投递路径**：用 pi 的 `steer`/`follow_up` **命令**（sendSteerCommand/sendFollowUpCommand，subagent-service L603-604），**不是** V2 决策 3 要求的 `prompt(streamingBehavior)` 统一路径。

**V2 统一投递改的是**（决策 3）：
- 去掉 running/idle 二分流，统一为「getChild 判活 → 活则 `prompt(streamingBehavior: interrupt?"steer":"followUp")` / 死则 resume+prompt」。
- subagent-actions.ts 的 handler 改动小（分流简化，委托 service 统一函数）。
- 真正实现改动在 subagent-service：`deliverToRunning`（steer/followUp 命令）+ `resumeRound`（重开）**合并为统一投递函数**，从「steer/followUp 命令路径」改为「prompt+streamingBehavior 路径」（pi 权威裁决 busy/idle，父进程零状态镜像）。

---

## 派发策略建议

依据 gap 性质与依赖关系，建议按 4 组拆分（组内可并行，组间有依赖）：

### 组 1：纯删除（无依赖，可最先并行，各自独立）
- `idle-marker.ts` 删整文件 + 清理 3 处调用方引用（finalize-record L228 / record-store L328 / worktree-manager L241+L29）
- `finalize-record.ts` 删 doFinalizeRoundToIdle（L206-276）+ 补投（L256-275）
- `worktree-manager.ts` 删 .idle 豁免判据（L240-243 + import L29）
- `notifier.ts` 删轮次豁免（round/status.idle/dedupKey/idle 文案）
- `record-store.ts` 删 idle 重建分支（L375-382）+ STATUS_PRIORITY idle 键（L42，同步 types.ts L41）

**风险**：删除会破坏 idle 状态机闭环，删完后对话模式续聊暂时不可用（直到组 3 完成）。建议与组 3 同 PR，或组 1 只做"标记废弃 + 留 TODO"，组 3 一并删除。**长期方案是组 1+3 同一编码任务**。

### 组 2：identity 迁移（独立可并行，无依赖）
- `index.ts` 新增子进程 session_start hook 写 identity（需主/子进程判定）
- `session-runner.ts` childEnv 补全 identity env 字段（L745-764）
- `session-runner.ts` 删父进程 fs 补写（L1079-1100）
- `session-reconstructor.ts` 确认全量扫仍成立（基本不动）

**验收**：P-identity 探针——多轮后读 session 文件，parentId 链连续、identity 有 id/parentId、custom entry 不进 LLM context。

### 组 3：核心范式重构（关键路径，依赖组 1 删除）
- 新增 `execution/lifecycle-manager.ts`（idle timer + ceiling + shutdown 收割 + 孤儿扫描 + activate 互斥）— **L，建议独立编码任务**
- `session-runner.ts` agent_end→agent_settled 信号换挂 + kill 分支改（chatMode 不 kill，委托 lifecycle-manager）+ pump 加 agent_settled 跟踪
- `subagent-service.ts` resumeRound 改冷路径 + 删 idle→running CAS + deliverToRunning 改 prompt+streamingBehavior + record 持久化 PID
- `subagent-actions.ts` messageHandler 简化分流（统一投递）
- `index.ts` 新增 process 级 shutdown hook（调 lifecycle-manager 收割）
- `record-store.ts` record 加 pid 持久化（与 subagent-service 联动）

**验收**：场景 A（多轮热路径）、B（崩溃冷路径）、C（idle timeout 回收）、D（重启恢复）、G（孤儿防护）、H（残留不触发）。

### 组 4：待澄清的设计决策（不阻塞，但实施前需定）
- `round` 字段在 V2 的去向后（notifier 删轮次豁免后）：UI 是否仍需显示轮次？若需要，删 .idle sidecar 后要另寻持久化途径（内存 record 跨重启丢失）；若不需要可一并删除。
- idle timeout 默认值：P-timeout 实测定（候选 ≤ cacheTTL ~5min）。
- V2 §5.4 全部探针（P-keepalive 为承重探针，不通过则引入定期重启退路）。

---

## 数据来源

- V2 设计文档：`docs/design/subagent-continuous-chat-v2.md`（§5.2 六模块、§5.3 文件改动地图）
- 现状侦查：5 个 explorer subagent 并行侦查 11 个源文件（行号均经 grep -n 核实）
- 侦查日期：本次会话
