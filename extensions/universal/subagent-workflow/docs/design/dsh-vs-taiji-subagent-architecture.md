# dsh vs taiji Subagent 架构对比分析与 taiji 目标架构建议

> **分析基线**
> - dsh 侧：`deepseek-harness` master @ `47f9438`。权威文档 `docs/subsystems/subagent.md` / `core.md`；源码 `packages/subagent/subagent/src/`（continuation.ts 1483 行为核心）、`tool-subagent` / `tool-subagent-control` / `tool-subagent-report`。
> - taiji 侧：本 worktree `feat-subagent-continuous-chat`，`extensions/subagent-workflow`。设计文档 `docs/design/`（V2 SSOT、V3 三层统一模型、v2-step5、v2-defense、v2-impl-gap、SP-8 可见性）；源码 `src/execution/` + `src/interface/`。
> - 方法：两侧均做了文档精读 + 源码级行号核实（本报告所有 file:line 均为核实过的引用）。

---

## 0. TL;DR

1. **本质差异一句话**：dsh 把 subagent 做成「**同进程内、自带持久化的 Session + 至多一个 Activation（驻期）**」；taiji 把 subagent 做成「**独立 pi 子进程，进程只是 session 文件的活缓存**」。
2. **dsh 的多轮对话是"持久化会话天然可续"**：Agent inbox 是唯一队列、状态全部派生（`running/waiting/settled` 由 Agent 状态 + 所有权集合推导，不存第二个状态机）、冷恢复只靠「descriptor 折叠 + `agents.resume()`」。副作用面存在但高度内聚（ChildLock、销毁事务、settlement 时序）。
3. **taiji 的多轮对话是"进程保活 + 文件兜底"**：V1「每轮 kill + resume」的补丁机制群（idle 状态机、消费确认制三环、`.idle` sidecar、重建矩阵、reaper 豁免、notifier 轮次豁免、idle→running CAS）已被 V2 删除（净减 ~270-330 行）；V3 三层模型（L1 record 逻辑态 / L2 进程物理态 / L3 归属恢复）的 9 个子方案 **8 个已落地**（SP-1~6、SP-8/9），SP-7 按设计 deferred。
4. **当前残留副作用**（按用户关心的四类归纳）：① 复杂状态机——L1 仍保留 `idle` 字面量（偏离 V3 原案两态终态）；② 并发——`acquireActivateLock` 缺 30s 超时兜底、idle CAS 与锁双保险并存（注释与代码矛盾）；③ 一致性/孤儿——**D12 异步 EPIPE error listener 未加**（unhandled 'error' 可崩主进程连坐全部活跃 subagent）、upgrade 竞态探针未闭环、L2 探活横跨 4 个半独立簿记；④ hack session——已收敛到「子进程经 `pi.appendEntry` 写 identity custom entry」的受控形态，无父进程 fs 补写。
5. **目标架构结论**：taiji **不能照搬 dsh 的同进程模型**（独立子进程隔离是 taiji 的硬约束：沙箱、崩溃隔离、模型/资源隔离），但 dsh 的 **7 条机制原则**可以在跨进程约束下完整映射。推荐以 V3 三层模型为骨架做「dsh 化收敛」，分两期：**A 期可靠性收口**（D12 error listener、D3 锁超时、文档-代码同步、upgrade 竞态闭环）→ **B 期状态收敛**（删 idle/cancelled 字面量，互斥职责全部移交锁，即 V3 方案 A 终态）。

---

## 1. 两侧系统画像

### 1.1 dsh：持久化 Session + 至多一个 Activation

```
persisted Session（durable，JSONL/SQLite，含 meta.parentSession / origin:'subagent' / delegationDepth / seedLength）
  -> optional live Activation（进程内驻期 epoch）
       -> 一个私有持有的 AgentHandle
       -> Agent inbox 是唯一 turn FIFO（next-turn / next-step 双队列，持久化为 agent/inbox/spliced 事件）
       -> ownedChildren: Set<SessionId>（本驻期拥有、尚未释放的子）
```

- **child 身份 = Session id**，跨 Activation 稳定；`subagent/descriptor` 是 append-only log-only 事件（无 surfaceOp、不进 model history、抗 compaction），携带 mode（one-shot/continuable）+ provider/model/persona/toolFilter——它是「能不能续聊」的唯一持久判定。
- **continuation manager（`continuation.ts`）只拥有**：驻留权（activation admission）、直接父授权、live 所有权图、冷恢复、child-first 销毁、结算送达。**turn 的排队与执行完全归 agent-loop 的 inbox**——「No continuable path creates a Task or an intermediate result-bearing wrapper」。
- **one-shot 是完全独立的另一条路**：`SubagentProvider.start()` → `SubagentRun`（result Promise + dispose），与 continuable 互不纠缠。

### 1.2 taiji：独立 pi 子进程，进程是 session 文件的活缓存

```
主 pi 进程（extension 运行处）
  ├─ record（ExecutionRecord：L1 逻辑态 + identity + rootSessionId + chatMode，内存 + manifest）
  ├─ spawnedChildren: Map<recordId, ChildProcess>（L2 权威句柄表，进程内不持久化）
  └─ spawn → 子进程 pi --mode rpc [--session <file>]（stdin/stdout 管道，argv 镜像，PI_SUBAGENT_* env 贯穿身份）
        └─ 子进程自己的 SessionManager + session 文件（JSONL，唯一状态源；identity entry 由子进程 session_start 写）
```

- 热路径：进程活 → `prompt(streamingBehavior: interrupt?"steer":"followUp")` 写 stdin，**pi 权威裁决 busy/idle**，父进程零状态镜像。
- 冷路径：进程死 → `resumeRound` 重新 spawn `--session <file>`（model/thinkingLevel 从 identity 防漂移）。
- 生命周期：`agent_settled` 是真空闲信号（非 `agent_end`）；idle timer 超时 SIGTERM passivate；ceiling 8 + LRU 挤出；三道收割防线（shutdown hook 显式 kill / stdin EOF 级联自杀 / 启动孤儿扫描 deferred）。

### 1.3 根本差异

| | dsh | taiji |
|---|---|---|
| 执行体 | 同进程 Agent（Session + Activation） | 独立 OS 子进程（pi --mode rpc） |
| 状态源 | 持久化 Session（含 inbox、descriptor 事件） | session 文件（JSONL）+ manifest + sidecar |
| 多轮语义 | 持久化会话天然可续，followup 路由只看 Activation 驻留 | 进程保活（热路径）+ 文件恢复（冷路径） |
| 队列 | Agent inbox（唯一 FIFO，持久化） | pi 内建 followUp/steer 队列（进程内存） |
| 状态机 | **无第二状态机**（派生） | L1 四态 + L2 物理簿记（V3 三层模型） |
| 恢复 | descriptor 折叠 + `ctx.agents.resume()`，不经过 provider | reconstructAll 四分支 + resume spawn |
| 进程边界成本 | 无（同进程串行是免费午餐） | 身份传递、探活、孤儿、双写者全要显式付费 |

---

## 2. 维度对比

### D1 进程模型与会话模型

**dsh**：进程边界被 Provider seam 抽象掉——`spawn`/`fork`/`acp`/`codex`/`claude-code`/`dsh-sdk` 七种 provider 同 registry 并存。但对 **continuable** 而言 provider 只参与一件事：`prepareContinuable()` 返回 detached 的 `ContinuableCreateSpec`（仅可选 parent-history seed，`types.ts:253-281`）——**之后整个生命周期（身份保留、Agent 创建、prompt 投递、冷恢复、所有权、销毁）全部归 continuation manager**，provider 再也见不到 child 的 Agent/句柄/turn/teardown。冷恢复**不经过 provider**（`continuation.ts:883-932`：`persistence.inspect` → 授权 → descriptor 折叠 → `agents.resume()`）。

**taiji**：只有 spawn 一种进程形态（`runSpawn`，`session-runner.ts:600`）。argv 镜像（`argv-mirror.ts`）、`--mode rpc`、piped stdio 非 detach、task 不经过 argv 而是 spawn 后立即 `sendPromptCommand`。跨进程身份靠 6+ 个 `PI_SUBAGENT_*` env 贯穿（`session-runner.ts:818-838`）。

**对比要点**：dsh 用「provider 只贡献 detached 创建数据」把进程模型从生命周期中剥离，这是它副作用少的第一个结构性原因——taiji 的进程模型与生命周期纠缠在 `session-runner.ts`/`subagent-service.ts` 两个大文件里，进程细节（argv/env/stdio/resume 参数）与状态机（idle timer/CAS/守卫）同处一室。

### D2 多轮对话与消息投递（队列语义）

**dsh**：
- `followup(parent, childId, content)` 路由**只看 Activation 驻留**：running → 入同一 Activation 的 inbox；waiting → 唤醒同一 Agent；absent → cold-resume 新 Activation（`continuation.ts:461-463`）。
- **Agent inbox 是唯一队列**：`next-turn`（FIFO，`followup`）/ `next-step`（steer/inject）。send_message 在 child busy 时**排队而非抢占**——「it waits until its current turn finishes, so it cannot redirect work already underway」。
- 接受的每条消息只有一个可观测顺序；`MessageId` 在 inbox 接受时即返回，不等待 turn 开始或写入 log。
- `interrupt_agent` = 同步授权 + `agent.cancel(keepInbox:true)`，**fire-and-return**；未认领的 inbox 工作与后代完整保留，只停当前 turn。
- 反方向：`report` 工具（child 主动报告，quiet=inject / wakeup=followup，不结束 child 的 turn）+ **manager-owned settlement notice**（见 D5）。

**taiji**：
- `message` 单入口：归属守卫（`rootSessionId === sessionRootId`）→ chatMode/upgrade 许可 → 热路径 `prompt(streamingBehavior)` / 冷路径 `resumeRound`。
- 队列语义**由 pi 权威裁决**（V2 决策 3，F3/F4/F7 源码核实）：busy 时 followUp 排队 / steer 抢占；idle 时 streamingBehavior 被忽略、正常开新 turn——父进程零 busy 镜像，**从结构上消灭了 v1 的 steer/followUp 残留污染**。
- interrupt:true 在对方 idle 时自动退化为普通新消息。
- 反方向：notifier 完成唤醒（`subagent-bg-notify` customType + `triggerTurn:true` + `deliverAs:"steer"`，busy 退避 + 退避上限强制发）。

**对比要点**：两侧的"唯一队列 + 权威裁决"哲学惊人一致——dsh 的 inbox FIFO ≒ taiji 的 pi followUp 队列；dsh 的"不抢占" ≒ taiji 的 followUp 语义；dsh 的 interrupt（只停当前 turn、保留队列）≒ taiji 的 steer。差异在**队列的持久性**：dsh inbox 持久化为 session 事件（崩溃恢复后队列仍在），taiji 的 pi 队列在进程内存（崩溃丢队列，但消息源是父 agent 的 tool call 文本，天然可重放——V2 决策 6 best-effort 重发正是建立在这个事实上）。**taiji 不需要持久化队列**：父进程死了子进程 EOF 自杀，队列恢复无意义；父进程活着时它是唯一 sender，重发语义由主 agent 掌握。

### D3 生命周期状态模型（状态机复杂度）

**dsh**：
- `ActivationState = 'running' | 'waiting' | 'settled'` 是**增量推导**而非显式状态机（`continuation.ts:159, 870-873`）：
  ```ts
  private stateOf(activation: Activation): ActivationState {
    if (activation.handle.agent.status === 'running' || activation.accepted.size > 0) return 'running'
    if (activation.ownedChildren.size > 0) return 'waiting'
    return 'settled'
  }
  ```
- 「manager derives these internal conditions from Agent quiescence and the owned-child set **rather than maintaining a second execution state machine**」——这是全设计最核心的一句话。Agent 的真实状态在 agent-loop，manager 不镜像它、只派生自己需要的三个谓词。
- 持久化层**完全没有**"子代理状态机"：Session 自带历史，descriptor 判定可续性，header 判定父关系。

**taiji**：
- L1 四态字面量：`running | idle | cancelled | closed`（`types.ts:45`）+ `ClosedReason` 子枚举（`parent-shutdown | parent-fork | parent-new | user-close | cancelled | gc`，`types.ts:58`）。done/failed/crashed 已合并进 closed（SP-1）。
- L2 无字面量，但有 **4 个半独立簿记**：`spawnedChildren` Map（句柄表）、`idleTimers` + `hasIdleTimer`（派生）、`.alive` sidecar + `isProcessAlive`（持久化探活）、`acquireActivateLock`（spawning 互斥）。
- 历史演进账：v1 完整 idle 状态机（idle 持久态 + sidecar + 重建矩阵 + reaper 豁免 + notifier 轮次豁免 + idle→running CAS）→ V2 删到「轻量 idle」→ V3 三层模型。V3 原案 L1 只有 active/closed 两态，实现修订保留了 idle/cancelled（有文档化理由：deliverMessage 分流、resumeRound 守卫、UI 显示都直接消费 idle 字面量）。

**对比要点（用户关心的"复杂状态机"）**：taiji 为跨进程付的第一笔税就是状态机。dsh 同进程可以直接读 `agent.status` 和所有权集合，taiji 跨进程看不到子进程内部状态，只能自己记 L1（逻辑）+ L2（物理）。**V3 三层模型已经是这笔税的最优解**——把纠缠的三件事拆成正交三层；但实现仍未走到终态：`idle` 字面量留在 L1（等价于 dsh 的"waiting"语义，但 dsh 是派生的、taiji 是存储的，存储态就有漂移风险，hydrateIdleRecord 死路径就是历史教训）。**收敛方向 = V3 方案 A**：L1 只剩 active/closed，idle 语义全部由 `hasIdleTimer` + 进程死活派生（v2-step5 决策 2 的 isChatModeIdle 谓词）。

### D4 并发与互斥

**dsh**：
- 同进程事件循环天然串行，无需跨进程锁。真正需要的是**每 child 的交付/释放/dispose 线性化**：`ChildLock`（`continuation.ts:320-341`）——关键判定（settle 判定与 dispose 打开）在**同一把锁的临界区**内完成（`:1244-1250`），杜绝「交付观察到正在被 teardown 的 handle」。
- **销毁事务的"存在"即准入 cutoff**：`Activation.disposal` 一旦打开，任何新投递要么等释放后 cold-resume、要么拒绝；重入 teardown 收敛到同一事务（`:220-225`）。
- caller 的 AbortSignal **只在 inbox acceptance 前有效**；接受后 manager 拥有 Activation 独立于 caller。

**taiji**：
- 双写者风险是**物理级**的：两个进程交错 append 同一 session 文件会直接毁文件（V2 决策 7：比脏 entry 断 tree 致命一个量级）。
- 互斥演进：v1/v2 靠 `resumeRound` 的 idle 守卫 + 同步 CAS 兼职（v2-defense 已论证其正确性：Node 单线程、①②之间无 await）→ V3 D3 接入 `acquireActivateLock`（链式 Promise 排队锁，`lifecycle-manager.ts:344-355`）+ finally 释放，冷路径双保险（`subagent-service.ts:894`）。
- 当前缺口：**D3 设计的 30s 锁超时兜底未实现**（代码只有链式 + finally）；idle CAS 与锁并存，`lifecycle-manager.ts:336-343` 注释仍写"冗余不接入"与代码相悖。
- EPIPE：同步 write 抛错捕获 + 转冷路径重放已做（`subagent-service.ts:862-889`），连续 2 次才报错。

**对比要点**：dsh 的并发复杂度内聚在 ChildLock + disposal 事务两个机制里，且都服务于「交付看见一致的世界」；taiji 的并发复杂度分布在 CAS + 锁 + EPIPE + EOF 自杀四件套，且**互斥语义仍在两处**（CAS 是第一道、锁是第二道）。终态应是**单一互斥源**：锁（含超时兜底）承担全部 spawning 互斥，CAS 随 idle 字面量一起删除——这正是 v2-step5 B-1 + V3 D3 的承诺，尚未完全兑现。

### D5 一致性 / 孤儿 / 父子联动

**dsh**：
- **所有权图显式**：每个 Activation 记 `ownedChildren: Set<SessionId>`；parent 在 ownedChildren 非空时是 `waiting` 而非 `settled`，因此**父不会在孙未释放时提前销毁**——孤儿被类型系统般的不变量挡在门外。
- **child-first disposal + top-down cancel**（`continuation.ts:1297-1320`）：释放永远子先、取消传播永远自顶向下；整树 drain（`drain`/`drainDescendants`）等所有已 admit 的 materialization 完成，逐分支 await 全部失败也继续。
- **settlement 是 manager 自己的账**：对每个 caller 拿到过 id 的 child 无条件送达一条 `subagent-settled` notice（provenance 独立于 child 的 report，防止 transcript 把运行时账记到 child 头上）；送达发生在**释放父所有权之前**（否则父会提前被判 quiescent）；父已在 teardown 时只 inject 不唤醒（唤醒 quiescent Agent 会开新 turn）。notice 送达失败**永不阻塞 disposal**（父已不在 live 就静默丢弃，重试会永久 pin 祖先在 waiting）。
- 孤儿语义：durable Session 跨进程存活，进程内 teardown 只是释放驻期；跨进程正常 shutdown 走 manager-wide drain。

**taiji**：
- 三道防线（V2 决策 7）：① shutdown hook 显式 `markAllSpawnedChildrenDead`（`index.ts:114-133, 632-642`，SIGTERM/SIGINT/beforeExit + 多信号 guard）；② 子进程 stdin EOF 自杀（免费兜底，piped stdio 下必然生效）；③ 启动孤儿扫描 **deferred**（SP-7，触发条件 = spawn 改 detach，当前不实施）。
- 父子联动矩阵（V3 L3 + SP-4 已落地）：fork/new **前置**级联关闭（`session_before_fork`/`session_before_tree` → `disposeAllRecords(reason)` → record 标 `closed{reason:parent-fork/parent-new}` + worktree 清理）→ `recentlyCascaded` 内存数组 → 下一个 loop 的 before_agent_start 注入告知（一次性，60s 超时清空）；compact → 每 loop 注入活跃 subagent 快照（不依赖摘要质量）；session 删除 → EOF 级联 + manifest 残留由 30 天 session-file-gc 收。
- notifier：完成唤醒挂 `agent_settled`（真空闲），busy 退避 + 上限强制发；dedup 回归纯 id。

**对比要点**：两侧在"父子联动"上做了**同一个决策的不同实现**——dsh 靠派生 waiting 让父"自动等待"后代；taiji 靠显式矩阵在父事件发生时级联处理。差异根源：dsh 的子在同一进程内天然可被父 observe；taiji 的子跨进程，父 fork 时物理上带不走也管不到子进程，级联关闭 + 告知是跨进程约束下的正确解（V3 D6 已否决过继/冷克隆：双写者变种 + 语义混乱）。**这个方向不需要改**，需要补的是告知的降级路径（list 输出含 closed reason，已设计）+ 文档同步。

### D6 持久化与恢复（含"hack session 结构"盘点）

**dsh**：
- 持久化 = Session 本身（session store + 可选 sessionPersistence）。descriptor 是**唯一新增的 durable 结构**：log-only、无 surfaceOp、不进 model history、抗 compaction、append-only；resume 时 `seedLength` 边界 + 自 suffix 折叠（last-wins，child 自己的 descriptor 覆盖 fork-seeded 祖先的）。
- 冷恢复授权：`loaded.meta.parentSession` 必须等于**精确 live 直接父**；descriptor 缺失或 mode ≠ continuable → `NOT_RESUMABLE`（fail loud）。
- 枚举不 load Agent、不 parse descriptor 热路径：projection fold + 三阶梯缓存（live watermark / 冷 checkpoint / persistence.inspect 重折叠），缓存纯加速，失败静默回落到权威重折。
- 侵入盘点：`SessionEventMap` 增 `subagent/descriptor`；`MessageSourceMap` 增 `coordinator`/`subagent-report`/`subagent-settled` 三种 kind；`AgentOptions.subagentDepth`；policy override 事件（sandbox/approval pin never，source:'delegation'）。**全部是类型层增强 + durable 事件，无全局运行时注册表 hack、无改写 session 内部结构**。

**taiji**：
- 持久化 = session 文件（子进程 pi 单写者顺序 append）+ manifest（原子写 tmp→fsync→rename，best-effort）+ 三个 sidecar（`.alive` pid 探活 / `.finalized` 正常结束标记 / `.cancelled` tombstone）。
- identity entry：customType `subagent-identity`，**由子进程 session_start 经 `pi.appendEntry` 写**（`index.ts:342-381`）——V2 决策 5 修复了 v1 最严重的一次 hack（父进程 fs 补写缺 id/parentId → 污染 `_buildIndex` leafId → message tree 断成两棵，实测事故）。custom entry 不进 LLM context（F11），累积无害。
- 跨重启恢复（SP-2 已修）：reconstructAll 四分支——cancelled tombstone→cancelled；.finalized→closed；.alive + pid 活 + <1h→running；**兜底→idle（可冷 resume）**（原 crashed 终态已删）。`getRecordForAction` 内存未命中时从磁盘重建续操作（取代死路径 hydrateIdleRecord）。
- 侵入盘点（已收敛形态）：identity entry（子进程写，格式所有者 = pi）；chatMode 标记（内存 + identity entry 字段）；customType 消息（`subagent-status` / `subagent-bg-notify` / `subagent:manifest-*`）；6+ 个 env；3 个 sidecar 文件；before_agent_start 注入（extension hook，非侵入文件结构）。

**对比要点（用户关心的"hack session 结构"）**：dsh 的答案是「**把 hack 变成正式的 durable 事件类型**」——descriptor 是 SessionEventMap 的正式成员，log-only 语义在 core 层定义；taiji 的答案是「**把写入权交还给格式所有者**」——identity 由子进程（session 文件的所有者）写，父进程零 fs 直写。**两条路都正确**，taiji 受限于 pi 上游（SessionEventMap 不可扩展、custom entry 是 pi 提供的唯一合法外挂点），identity entry + customType 消息已是最小侵入形态。残留风险不在结构而在**时机**：upgrade 置 chatMode 后、子进程重写 identity 前主进程崩溃 → 磁盘 identity 仍 false、升级内存态丢失（V3 SP-5 探针，未闭环）。dsh 的对应机制（descriptor 在 manager 保留 id 时就同步写 seed）没有这个窗口。

### D7 权限与归属

**dsh**：直接父记录在持久化 `SessionHeader.parentSession`；followup 要求**精确 live 直接父 Agent**；interrupt 授权是 live 祖先或 human parent address，manager 对 live Activation 的 recorded lineage 校验；`MessageSource` 只记账不授权。self/sibling/stale 一律拒绝（UNAUTHORIZED），absent target 是 accepted no-op（防探测 + 幂等）。

**taiji**：`rootSessionId` spawn 时盖章（SP-8 后经 env 贯穿真 ROOT，`sessionRootId` 与 `sessionId` 语义正交）；`getRecordForAction` 统一校验 `record.rootSessionId === this.sessionRootId`，失配与不存在统一"not found or not owned"（防探测）。多主 agent 挂靠同一 subagent 已明确否决（record 状态跨进程分裂 + 双写者变种，V3 Out-of-scope）。

**对比要点**：dsh 的授权粒度是「live 直接父」，taiji 是「root session 归属」。taiji 更粗但符合其形态（跨进程没有 live 对象可验）；fork 场景 dsh 靠 drainDescendants 停掉 host 的子树，taiji 靠级联关闭——语义等价，落地方式不同。

### D8 枚举与可见性

**dsh**：`listChildren` / `listDescendants`——live-preferred merge（session store + persistence），**不 load 不 resume 任何 Agent**；`origin:'subagent'` 分类 + projection fold 给身份；descendants 走完整树 pre-order（普通 session 和 one-shot 是遍历节点，continuable 孙辈可发现）；每行带 durable parentId + depth。列表是 snapshot 不是 delivery promise，授权检查仍在 service。

**taiji**：`reconstructAll` 扫 sessions 目录 JSONL → identity 恢复 → `rootSessionId === ROOT` 过滤（SP-8 已修深层断裂：env 四元贯穿 + ROOT_CWD 统一落盘编码）；display 层 `[L2]/[L3]` depth 标签 + parent/children 详情已就绪。缺陷：列表基于**磁盘重建 + 过滤**，没有 dsh 的 live 优先合并与缓存阶梯——但 taiji 的 live 状态本来就只能在主进程内存（record），磁盘只有终态残留，语义差异可接受。

### D9 工具面（模型视角）

**dsh**：`subagent`（每 provider 一个实例，start-time 能力 fail-loud 校验：outputSchema/depthLimit/toolFilter/persona）+ 全局 `send_message`/`interrupt_agent`/`list_agents` + child 侧 `report`。continuable 模式下 start 返回 `{subagentId}` 不等待结果，settlement notice 独立于工具结果送达。背景优先（background-first delegation）。

**taiji**：`subagent`（start/message/close + conversation:true 声明 + idleTimeoutMs 透传）+ `/subagents` list 命令。one-shot 完成后自动可续聊（SP-5 upgrade）。工具面语义密度低于 dsh（无 report 工具、无 interrupt 与 send 分离——message 带 interrupt:true 参数），但对单进程主 agent 场景够用。**可选增强（不必须）**：upgrade 语义已把 one-shot/chatMode 二元打平，工具面可考虑像 dsh 一样收敛为「start 返回 id + 统一 message」，但这属于产品面不是架构面。

### D10 复杂度账与失败模式

**dsh 的复杂度**（诚实清单）：① `accepted` 集合补 Agent.status 的假 idle 窗口；② 销毁事务的竞态收敛（disposal 留在 map 里让并发交付看到同一 closing 边界）；③ cold resume 的多授权路径与 seedLength 边界自洽；④ settlement notice 时序（必须在 releaseOwnership 之前）。**总机制数约 6 个**，全部服务于 5 个明确不变量（单 Activation、inbox 唯一队列、disposal 即 cutoff、child-first、settle/dispose 同临界区）。

**taiji 的复杂度**（诚实清单）：V1 并发症群（已删）→ V2 五机制（lifecycle-manager 五职责）→ V3 九 SP。当前实现的总机制数约 **15+**（四态 L1、四簿记 L2、锁、EPIPE、EOF、三级联、hook 注入、sidecar 三件、manifest、GC 双路径、upgrade、turn-limiter reset…），其中**为跨进程付费的部分**约一半（探活、身份贯穿、孤儿、双写者、EPIPE），**为历史演进付费的部分**约 1/4（idle 字面量残留、双保险互斥、陈旧注释）。

**失败模式对比**：
- dsh 最坏失败：resume 时 persistence 不可用 → fail loud 拒绝（不静默降级）；notice 丢失 → 父少一次提醒（不影响正确性）。
- taiji 最坏失败：**异步 EPIPE unhandled 'error' → 主进程崩溃 → 全部活跃 subagent EOF 自杀 → 用户丢全部活跃上下文**（D12 已识别、修复未完成，当前最大敞口）；双写者 → session 文件毁（已被锁+CAS 双保险挡住）。

---

## 3. 副作用账本（用户四类关切 × 两侧对照）

| 副作用类别 | taiji 历史 | taiji 现状 | dsh 对应 |
|---|---|---|---|
| **① 复杂状态机** | v1 完整 idle 状态机 + 5 个并发症机制（消费确认制三环、.idle sidecar+重建矩阵、reaper 豁免、notifier 轮次豁免、idle→running CAS），V2 净减 ~270-330 行 | V3 三层模型 + L1 四态；`idle` 字面量残留（偏离两态终态） | **零存储状态机**：三态派生自 Agent 状态 + 所有权集合（continuation.ts:870-873） |
| **② 并发问题** | idle 守卫身兼两职（idle 判断 + 唯一互斥）；双写者毁文件风险 | 锁（无超时兜底）+ CAS 双保险；异步 EPIPE 无 error listener | ChildLock 每 child 线性化 + disposal 事务即准入 cutoff；同进程无双写者概念 |
| **③ 一致性/孤儿** | fork 归属断裂（被杀 + 失联双输）；compact 吞引用；跨重启 crashed 不可续 | SP-2/3/4 已修（级联关闭 + 告知 + 快照注入 + 兜底→idle）；upgrade 竞态未闭环；L2 四簿记可能不同步 | 所有权图 + waiting 派生 + child-first disposal + drain；孤儿被不变量结构性挡死 |
| **④ hack session 结构** | **父进程 fs 补写 identity**（缺 id/parentId → leafId 污染 → tree 断裂，实测事故） | 子进程 `pi.appendEntry` 写 identity（所有权归还）；custom entry 不进 context；sidecar ×3 + env ×6 + customType ×4 | descriptor 为正式 durable 事件类型（log-only）；MessageSource kind 增强；无 fs 直写、无全局注册表 |

---

## 4. 机制归因：为什么 dsh 副作用少，taiji 能不能学

**dsh 副作用少的五个结构性原因**：

1. **状态全部派生，不存储**。存储态必然有"写了没读/读时已漂移"的窗口（taiji 的 hydrateIdleRecord 死路径、crashed 兜底错判都是存储态漂移）。派生态只有一个来源（Agent 真实状态 + 所有权集合），永不漂移。
2. **唯一队列**。inbox 是唯一 FIFO，所有消息一个可观测顺序；「不可抢占」让"消息能不能改道正在跑的工作"这个问题不存在。
3. **销毁事务 = 准入 cutoff**。「开始销毁」是所有参与者可见的原子事实，交付/释放/dispose 在同一临界区判定——把竞态收敛成顺序。
4. **结算与报告分离**。report 是 child 的选择，settlement 是 manager 的义务（无条件送达，含 child 根本没机会报告的情形）——父在最坏情况下不失明。
5. **持久化身份自证**。descriptor 是 child log 的正式事件，恢复判定 = 「log 里有版本匹配的 descriptor + 精确 live 父」——不依赖任何进程内存或 sidecar。

**taiji 能不能学：能，但有三条边界**：

- **不能学"同进程"**：独立子进程是 taiji 的硬约束（沙箱隔离、崩溃隔离、模型/资源隔离、pi 生态兼容）。因此 dsh 靠同进程免费获得的东西（事件循环串行、live 对象授权、registry 观察、agent.status 直读），taiji 必须显式付费（锁、rootSessionId 盖章、探活、EPIPE 兜底）。**这笔税交得起，但每一笔都要有且仅有一处**——当前 L2 四簿记就是"同一件事付了四次税"。
- **不能学"持久化队列"**：taiji 的队列在 pi 进程内存，崩溃即失。但 taiji 的 sender（主 agent 的 tool call 文本）天然可重放，best-effort 重发 + 结算通知（notifier）已经是正确等价物。**不要**为此把队列持久化到 session 文件——那会重新引入写文件竞态。
- **能学且该学的是前五条的全部**：派生、唯一队列（已做：streamingBehavior 权威裁决）、准入 cutoff（锁的排队语义已接近）、结算经理化（notifier 已接近，缺"无条件送达"的兜底审计）、身份自证（identity entry 已做，缺 upgrade 竞态闭环）。

---

## 5. taiji 目标架构建议

### 5.1 架构定位（一句话）

**以 V3 三层模型为骨架、按 dsh 的五条原则做收敛的"跨进程 subagent 终态"**：

> 每个 subagent = 一个 durable record（L1：active/closed 两态，lastResult + closedReason 表达事实）+ 至多一个子进程（L2：纯性能缓存，派生判定）+ 归属与恢复凭证（L3：rootSessionId + session 文件 + identity entry）。
> 消息单入口路由 = f(L1, L2)；互斥唯一源 = acquireActivateLock（排队 + 超时兜底）；队列唯一源 = pi 的 followUp/steer（父进程零镜像）；结算 = notifier 无条件送达（挂 agent_settled）；恢复 = session 文件 + identity entry（与进程死活无关）。

### 5.2 目标模型（逐层定稿）

**L1（record 逻辑态，终态 = V3 方案 A）**
- `active | closed` 两态。删除 `idle` 与 `cancelled` 字面量：
  - `idle`（=「对话轮次完成、可续聊」）改为派生谓词 `isChatModeIdle(record) = record.chatMode && hasIdleTimer(record.id) && !busy`（v2-step5 决策 2 已定义，B-3/B-4 未完全落地）。消费点：deliverMessage 分流（chatMode 优先分流后 idle 分支本就是防御性兜底）、UI 排序/图标、resumeRound 守卫（改为锁 + 进程死活判定）。
  - `cancelled` 并入 `closed{reason:"cancelled"}`（v3 原案；实现修订保留了它，但终态收敛时理由已消失——消费点只有显示分支，成本可接受）。
- `chatMode` 许可位保留（start 时声明 + message 自动 upgrade），直到 upgrade 全面验证后可评估打平（与 dsh 的"descriptor mode"同构，不急）。
- 迁移护栏：`Record<ExecutionStatus, T>` 类型强制全覆盖（B-4 已有先例）；删除后 net 行数应再减。

**L2（进程物理态，单源化）**
- 唯一权威句柄表 = `spawnedChildren` Map；`hasIdleTimer` 派生空闲；`.alive` sidecar 只服务跨重启探活（判定"热路径可行否"），**不再与活进程判定重复**——收掉四簿记为两簿记（进程内句柄表 + 跨重启 sidecar）。
- 互斥唯一源 = `acquireActivateLock`，**补 30s 超时兜底**（D3 承诺）；删除 resumeRound 的 idle CAS（随 idle 字面量一起），双保险降为单保险；`lifecycle-manager.ts:336-343` / `index.ts:629` 陈旧注释同步更新为「已接入，见 v3 D3」。
- EPIPE：**立即补 `child.stdin.on("error")` 异步监听**（D12 核心前置，当前最大可靠性敞口）——同步 write 捕获只覆盖一半；补上后主进程崩溃风险消除。

**L3（归属与恢复）**
- 现状已达标（SP-4/SP-8 已落地）：rootSessionId 贯穿、fork/new 级联关闭 + 告知、compact 快照注入、worktree 级联清理。
- 补两处：① upgrade 竞态闭环——upgrade 时**同步把 chatMode 落盘**（manifest 或立即触发 identity 重写；V3 SP-5 探针"实施时定"，现在该定了：接受丢失 vs 落盘，推荐落盘 manifest，重启时以 manifest ∪ identity 为准）；② 告知降级路径已设计（list 输出含 closed reason），补实现即可。

### 5.3 落地分期

**A 期：可靠性收口（本分支可直接做，4 个独立小改动）**
1. `stdin-writer.ts` + `session-runner.ts`：`child.stdin.on("error")` 异步监听（D12）——最高优先级。
2. `lifecycle-manager.ts`：`acquireActivateLock` 加 30s 超时兜底 + 陈旧注释同步（D3）。
3. `subagent-actions.ts` / manifest：upgrade 落盘（SP-5 探针闭环）。
4. 文档回写：V3 §5.1.1 分期表、`finalize-record.ts:221` 的 `.idle` 残留注释、S2 验收标准改判（idle 保留的偏离）。

**B 期：状态收敛（V3 方案 A 终态，中等重构）**
5. 删 `idle`/`cancelled` 字面量 → L1 两态 + `isChatModeIdle` 派生（B-3/B-4 + 实现修订的反转）。
6. resumeRound 守卫改锁 + 进程死活；CAS 删除；单互斥源达成。
7. L2 簿记收敛（句柄表 + sidecar 两源）。

**C 期：触发条件未到，明确不做**
- SP-7 孤儿扫描（spawn 改 detach 时激活）；多 sender mailbox/broker（V2 §3.5 触发条件：第二个 sender 类型出现）；树级资源总量控制（V3 D8 known limitation）。

### 5.4 反面清单（保持少副作用的关键约束）

- **不**为队列做持久化（pi 队列 + 调用方重放已等价于 dsh 持久化 inbox）。
- **不**引入 per-record 父侧 mailbox（多 sender 出现前是纯复杂度）。
- **不**做 fork 归属过继 / 冷克隆（双写者变种，V3 D6 已否决）。
- **不**新增任何 status 字面量（任何新中间态都必须先问「能不能从 hasIdleTimer/句柄表/closedReason 派生」）。
- **不**让父进程再 fs 直写 session 文件（identity 所有权已归还子进程，永不回退）。
- **不**让 runtime（taiji 应用侧）编排 pi 行为——应用侧是旁观 + UI 同步层（AGENTS.md 规则 17 的跨层教训：subagent 完成后的续跑由 extension 的 notifier 经 `triggerTurn` 发起，runtime 只转发事件；前端 subagent panel 消费 notifier/customType 事件即可，不要在 runtime 里再造一个状态机）。

### 5.5 应用侧（taiji runtime/前端）对应建议

- runtime 保持「事件翻译 + UI 同步」定位：`subagent-bg-notify` / `subagent-status` / manifest 事件 → 前端 subagent panel 的 task tree。
- 前端状态机零引入：subagent 状态由 extension 的事件流驱动（`agent_settled`→notify→panel 更新），panel 只做展示映射，不做自己的生命周期状态机——否则会复制 V1 的教训到 UI 层。
- 重开 session 可见性：subagent record 的持久化链路已闭环（identity entry + reconstructAll），前端 hydrate 从 `/subagents` 等价数据源取即可，不要自建持久化。

---

## 6. 结论

1. **dsh 与 taiji 是同一个问题（多轮 subagent）的两种形态**：dsh 用「持久化会话即状态」回避了绝大多数副作用，taiji 用「进程保活 + 文件兜底」在跨进程约束下重造了等价能力。taiji 的 V2/V3 演进（V1 补丁群 → V2 减法 → V3 三层）已经把副作用从 20+ 机制压到 15 上下，方向正确。
2. **剩下的副作用全部有明确解**：D12 error listener、D3 锁超时、idle 字面量删除（方案 A）、upgrade 落盘、文档-代码同步——五件事做完，taiji 的 subagent 架构就到达了「跨进程约束下的 dsh 等价终态」。
3. **不变量清单（实现与后续维护的锚）**：单 activation（锁，唯一互斥源）；session 文件单写者（子进程，父零直写）；状态可派生不存储；队列唯一（pi 权威裁决）；结算无条件送达（notifier）；恢复只看凭证（session 文件 + identity），与进程死活无关。
