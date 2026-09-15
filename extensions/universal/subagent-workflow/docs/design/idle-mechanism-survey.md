# idle 机制现状侦查报告

> **范围**：`extensions/subagent-workflow` 当前「轻量 idle」V2 实现下，6 个 idle 相关机制的精确代码现状。所有 file:line 经 grep + read 双重核实。
>
> **侦查期核心发现（结论先行）**：当前实现**已不是 v1 全量 idle 状态机**，而是「轻量 idle」过渡态——`idle-marker.ts` 整个模块（write/read/remove/重建分支）已被删除，`idle` 已是**纯内存态**（磁盘不可重建）。残留的 idle 代码分两类：(a) 仍在工作的轻量路径（onRoundSettled 首轮闭环 + resumeRound idle 守卫 + notifier round 豁免）；(b) **已部分失效的死路径**（hydrateIdleRecord 跨重启水合扫不到任何 idle record）。此外，「彻底删 idle」最大的风险点不是删除本身，而是 `resumeRound` 的 idle 守卫（`subagent-service.ts:631/654`）是**当前唯一的单 activation 互斥防线**——`lifecycle-manager.ts:321` 注释明确指出 `acquireActivateLock` 因此判冗余未接入。

---

## 关键背景澄清（任务文件指针修正）

| 任务原文 | 实际情况 |
|---|---|
| 机制 4 文件 `src/services/subagent-service.ts` | 实际在 `src/execution/subagent-service.ts`（无 `src/services/` 目录） |
| 机制 4 文件 `src/execution/session-pending.ts` | **该文件是「后代 keep-alive 判定」**（`pending:register`/`pending:unregister` 差集），与 `pendingMessages` 消费确认制**无关**。真正的消费确认制分布在 `types.ts` / `subagent-service.ts` / `session-runner.ts` / `finalize-record.ts` |
| handoff「轻量版只删了 `writeIdleMarker`」 | **不准确**：实际删了**整个 `idle-marker.ts` 模块**（`writeIdleMarker`/`readIdleMarker`/`removeIdleMarker`/`IdleMarker` interface 全删）+ `record-store.ts` reconstructAll 的 `.idle` 重建分支。`grep writeIdleMarker|readIdleMarker|removeIdleMarker|idle-marker|IdleMarker` 零命中 |

---

## 机制 1：notifier 轮次豁免

### 涉及位置
- `src/execution/notifier.ts:18` — `BgNotifyRecord.status` 联合类型含 `"idle"`
- `src/execution/notifier.ts:27-30` — `round?: number` 字段及其 dedup 语义注释
- `src/execution/notifier.ts:99` — `private readonly dedup = new Map<string, number>()`
- `src/execution/notifier.ts:120-123` — dedupKey 计算逻辑
- `src/execution/notifier.ts:236-238` — `case "idle":` 完成通知文案构造

### 当前逻辑
```ts
// notifier.ts:120-125
// dedup key 按 `id:round` 去重：对话模式每轮 round 不同 → 60s 内多轮回复不被吞（G1）；
// 非 chatMode round 恒定（0/undefined）→ key 同旧 `id`，行为完全不变（向后兼容）。
const dedupKey = `${record.id}:${record.round ?? 0}`;
const lastSeen = this.dedup.get(dedupKey);
if (lastSeen !== undefined && now - lastSeen < DEDUP_TTL_MS) return;
this.dedup.set(dedupKey, now);
```
首轮 notify 与续聊 notify 的区别：dedupKey 用 `id:round` 而非纯 `id`。chatMode 每轮 `round` 不同（由 doFinalizeRoundToIdle / onRoundSettled 递增），60s dedup TTL 内多轮回复各自占独立 key 不被吞；非 chatMode `round` 恒为 0/undefined，key 同旧 `id`，行为完全不变。

### 存在理由
chatMode 每轮完成都要 notify 主 agent，但 60s dedup 会把同 id 的快速多轮 notify 吞掉，用 round 做豁免 key 让每轮独立通过。

### 依赖方
- **写入 round**：`finalize-record.ts:234`（`record.round = (record.round ?? 0) + 1`）、`subagent-service.ts:1502`（onRoundSettled `record.round = (record.round ?? 0) + 1`）
- **消费 round/status**：`notifier.ts:97` `notify()`（构造 dedupKey）、`notifier.ts:236` `buildLlmContent`（idle 文案）

### 若删除影响
chatMode 多轮 notify 在 60s 内会被 dedup 吞（dedupKey 退化为纯 id），主 agent 收不到续聊回复 → V2 G1 多轮上下文体验断裂。删除前需先让进程长驻后 notify 回归「一次性语义」（V2 §2.3 第一类 + 决策 6 要求），即去掉 round 豁免、dedupKey 回归 `${record.id}`。

---

## 机制 2：idle 字面量 + STATUS_PRIORITY idle 键

### 涉及位置
**定义**
- `src/execution/types.ts:41` — `ExecutionStatus` 联合类型含 `"idle"`（`Record<ExecutionStatus, number>` 要求枚举完整，删 idle 键必须同步删此字面量）
- `src/execution/record-store.ts:37-44` — STATUS_PRIORITY 定义（`idle:2` 在 `:41`）

**赋值（写 idle）**
- `src/execution/finalize-record.ts:233` — `record.status = "idle"`（doFinalizeRoundToIdle）
- `src/execution/subagent-service.ts:1499` — `record.status = "idle"`（onRoundSettled 首轮轻量路径）
- `src/execution/subagent-service.ts:814` — `record.status = "idle"`（hydrateIdleRecord 水合后设）

**消费/判断（读 idle）**
- `src/execution/subagent-service.ts:449` — 终态判定 `s !== "done" && ... && s !== "idle"`
- `src/execution/subagent-service.ts:631` — resumeRound 守卫 `if (record.status !== "idle")`
- `src/execution/subagent-service.ts:797` — hydrateIdleRecord 扫描 `.find(r => r.id === id && r.status === "idle")`
- `src/execution/subagent-service.ts:846` — closeSubagent `else if (record.status === "idle")`
- `src/execution/subagent-service.ts:1184` — runAndFinalize early return `if (record.chatMode && record.status === "idle")`
- `src/execution/subagent-service.ts:1203-1211` — chatMode done/failed→idle 分流
- `src/interface/subagent-actions.ts:353` — messageHandler `else if (record.status === "idle")`
- `src/interface/subagent-actions.ts:132` — close handler `case "idle":`
- `src/interface/gui-mappers.ts:44` / `:70` — UI 映射（idle→running 显示 + pause icon）
- `src/interface/format.ts:185` — `case "idle":`
- `src/execution/record-store.ts:400` — compareRecords `STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]`
- `src/execution/notifier.ts:18` / `:236` — status union + idle case

### 当前逻辑
```ts
// record-store.ts:37-44
const STATUS_PRIORITY: Record<ExecutionStatus, number> = {
  running: 0,
  failed: 1,
  crashed: 1,
  idle: 2,        // waiting 语义：介于失败态与 done 之间
  cancelled: 2,
  done: 3,
};
```
`idle` 排在 failed/crashed(1) 与 done(3) 之间，让 chatMode 等待续聊的 record 在 `/subagents list` 排序时排在终态之前。

### 存在理由
idle 是 chatMode 轮次完成的非终态中间态，需与 done/failed 终态区分，列表排序 + UI 显示 + 消息分流都依赖它。

### 依赖方
- 列表排序：`record-store.ts:399-401` `compareRecords`
- UI 显示：`gui-mappers.ts:44/70`（idle→"running"+pause icon）、`format.ts:185`
- 消息分流：`subagent-actions.ts:353`、`subagent-service.ts:631/846/1184`
- notify：`notifier.ts:18`（status union）

### 若删除影响
- `ExecutionStatus` 去掉 `"idle"` 字面量 → `Record<ExecutionStatus, number>` 类型要求 STATUS_PRIORITY 同步删键（否则编译报错），所有 `record.status = "idle"` / `=== "idle"` / `!== "idle"` 赋值判断编译报错（上文 16+ 处）。
- **必须先有运行时替代判定**：当前「进程在但空闲」的语义需要另一个表达。候选：`lifecycle-manager.hasIdleTimer(id)`（idle timer armed = 空闲态）或 `getChildByRecord(id)` 进程死活判定。无替代前删 idle 会丢失「chatMode record 完成一轮、待续聊」的 UI/路由语义。

---

## 机制 3：doFinalizeRoundToIdle

### 涉及位置
- `src/execution/finalize-record.ts:205-276` — `doFinalizeRoundToIdle` 定义
- `src/execution/finalize-record.ts:48-57` — `redeliverPending` 依赖（FinalizeDeps）
- `src/execution/finalize-record.ts:221-225` — removeAliveMarker block（**注意：无 writeIdleMarker**）
- `src/execution/finalize-record.ts:230` — `deps.emitUnregister(record.id, "idle")`
- `src/execution/finalize-record.ts:233-234` — `record.status = "idle"` + `record.round += 1`
- `src/execution/finalize-record.ts:245-260` — 残留 pendingMessages 补投（MF-1）
- `src/execution/subagent-service.ts:1330-1346` — `finalizeRoundToIdle` 委托方法
- `src/execution/subagent-service.ts:1204` / `:1211` — runAndFinalize 调用点（done 分流 / MF-6 failed|cancelled 分流）
- `src/execution/subagent-service.ts:1359-1366` — `redeliverPendingMessages`

### 当前逻辑
```ts
// finalize-record.ts:205-234（节选核心副作用）
export async function doFinalizeRoundToIdle(deps, record, result): Promise<void> {
  deps.clearThrottle(record.id);
  record.result = result.text || (result.error ? `round did not complete: ${result.error}` : record.result);
  if (record.sessionFile) {
    try { removeAliveMarker(record.sessionFile); }
    catch (err) { bestEffort(err, "removeAliveMarker (doFinalizeRoundToIdle)"); }
  }
  deps.emitUnregister(record.id, "idle");
  record.status = "idle";
  record.round = (record.round ?? 0) + 1;
  // ... 245-260: 残留 pendingMessages 补投（MF-1）
}
```
做的事：clearThrottle + 设 record.result（MF-2，否则 notifier idle 回复正文恒 `(empty)`）+ removeAliveMarker + emitUnregister + status=idle + round+1 + 残留 pendingMessages 补投（MF-1）。

### 「轻量版只删 writeIdleMarker」核实结论
**不准确**。轻量版删除范围远大于 writeIdleMarker：
1. **整个 `idle-marker.ts` 模块已不存在**（grep `writeIdleMarker|readIdleMarker|removeIdleMarker|idle-marker|IdleMarker` 零命中）
2. `record-store.ts` reconstructAll（:299-405）的 `.idle` 重建分支已删（当前只有 `.cancelled`/`.finalized`/`.alive+pid→running`/`crashed` 四分支，无 idle 分支）
3. doFinalizeRoundToIdle 内的 `writeIdleMarker` 调用确已移除（当前只调 removeAliveMarker）

### 存在理由
chatMode 轮次完成（done/failed/cancelled）需把 record 从 tryTransition 设的终态覆盖回 idle（可恢复非终态），保留内存 + worktree 等续聊。MF-6：失败/取消轮次也回退 idle（可重试）而非终态销毁。

### 依赖方
- `runAndFinalize`（`subagent-service.ts:1204` chatMode done 分流、`:1211` chatMode failed/cancelled MF-6 分流）经 `finalizeRoundToIdle`（:1330）调用
- **注意：首轮正常完成已不走此函数**——agent_settled 时 `onRoundSettled`（:1499）先设 idle，runAndFinalize 在 `:1184` early return，不进 :1204 分流。doFinalizeRoundToIdle 当前主要服务于失败/取消轮次的 MF-6 回退（Inferred：正常 done 路径被 onRoundSettled 抢先短路）

### 若删除影响
- chatMode 失败/取消轮次的 MF-6 回退 idle 路径断（record 会停在 failed/cancelled 终态，无法 message 续聊）
- MF-1 残留 pendingMessages 补投链路断（非 chatMode deliverToRunning 的消息在进程死亡竞态窗口会丢，但 chatMode deliverMessage 本不依赖它）
- onRoundSettled 轻量路径（:1499）不调此函数，故首轮正常完成不受影响

---

## 机制 4：pendingMessages 消费确认制

> **文件指针修正**：任务指向的 `src/execution/session-pending.ts` 实际是「后代 keep-alive 判定」（`pending:register`/`pending:unregister` 差集，用于 agent_end 后判活后代），与 `pendingMessages` 消费确认制无关。真正的三环分布如下。

### 涉及位置
**入队**
- `src/execution/types.ts:387` — `pendingMessages?: PendingMessage[]` 字段定义
- `src/execution/subagent-service.ts:586-591` — deliverToRunning 投递前 push

**清除**
- `src/execution/session-runner.ts:742-743` — message_start(role=user) FIFO shift

**补投**
- `src/execution/finalize-record.ts:245-260` — doFinalizeRoundToIdle 内发现残留 → redeliverPending 回调
- `src/execution/subagent-service.ts:1359-1366` — redeliverPendingMessages → resumeRound 重投

### 当前逻辑
```ts
// 入队：subagent-service.ts:583-591（deliverToRunning，先入队再写 stdin）
deliverToRunning(record, text, interrupt): void {
  record.pendingMessages ??= [];
  record.pendingMessages.push({ id: crypto.randomUUID(), text, interrupt, sentAt: Date.now() });
  const child = getChildByRecord(record.id);
  if (!child) { /* MF-1 竞态窗口：入队后不 throw，等 finalize 补投 */ return; }
  if (interrupt) sendSteerCommand(child, text); else sendFollowUpCommand(child, text);
}
```
```ts
// 清除：session-runner.ts:742-743（message_start handler）
if (raw.message?.role === "user" && record.pendingMessages && record.pendingMessages.length > 0) {
  record.pendingMessages.shift();  // FIFO 1:1 消费确认
}
```
**三环**：投递前入队（deliverToRunning）→ pi 消费该 user 消息时 message_start shift 清除（1:1 FIFO）→ 进程死亡时残留的合并文本经 resumeRound 重投（doFinalizeRoundToIdle → redeliverPendingMessages）。

**关键边界**：仅 `deliverToRunning`（非 chatMode busy 投递）走此机制；chatMode 的 `deliverMessage`（`subagent-service.ts:717`）用 prompt+streamingBehavior 统一语义，**完全不碰 pendingMessages**。

### 存在理由
防 busy→kill 竞态：进程跑完一轮被 kill 时，刚投的 follow_up/steer 可能未被 pi 消费就随进程死亡，入队 + 补投保证不丢。

### 依赖方
- 入队：`subagent-service.ts:583` deliverToRunning
- 清除：`session-runner.ts:729-745` message_start handler（turn_start :729 不清除，防 1:N 破坏 FIFO）
- 补投：`finalize-record.ts:205` doFinalizeRoundToIdle → `subagent-service.ts:1359` redeliverPendingMessages → `:624` resumeRound
- 触发入口：`subagent-actions.ts:351`（messageHandler running 分流 → deliverToRunning）

### 若删除影响
- 非 chatMode busy 投递的消息在「record 仍 running 但子进程刚 close」竞态窗口会丢（V2 决策 6 明确要降级为 best-effort 重发，删除符合 V2 方向）
- chatMode 路径不受影响（deliverMessage 本不依赖 pendingMessages）
- 需同步删：types.ts:387 字段、deliverToRunning 入队、session-runner 清除、doFinalizeRoundToIdle 补投块

---

## 机制 5：resumeRound 的 idle 检查 + hydrateIdleRecord

### 涉及位置
**idle 守卫 + CAS 翻转（单 activation 互斥）**
- `src/execution/subagent-service.ts:631` — `if (record.status !== "idle")` throw
- `src/execution/subagent-service.ts:654` — `record.status = "running"`（绕过 tryTransition）

**跨重启水合**
- `src/execution/subagent-service.ts:762` — getRecordForAction 调 hydrateIdleRecord
- `src/execution/subagent-service.ts:773-797` — hydrateIdleRecord 定义（:797 是实际 find 调用）
- `src/execution/subagent-service.ts:814` — 水合后设 `record.status = "idle"`

### 当前逻辑
```ts
// subagent-service.ts:624-654（resumeRound 前置校验 + CAS，节选）
resumeRound(record, text): void {
  this.assertReady();
  if (record.status !== "idle") {              // ← idle 守卫（:631）
    throw new Error(`subagent ${record.id} is not ready for a new message (current state: ${record.status})...`);
  }
  if (!record.sessionFile) { throw new Error(...); }
  if (!record.controller) { throw new Error(...); }
  record.status = "running";                    // ← 手动翻转，绕过 tryTransition（:654）
  // ... resume spawn
}
```
**单 activation 互斥**：idle 检查（:631）与 running 翻转（:654）之间无 await，是同步 CAS。同一 recordId 的并发 message 只有一个能过 idle 检查（第一个把 status 翻成 running），另一个 throw「not ready」。`lifecycle-manager.ts:321` 注释明确：`acquireActivateLock`（防线 iii）因此判冗余未接入。

**hydrateIdleRecord（跨重启水合，当前为死路径）**：
```ts
// subagent-service.ts:793-797
private hydrateIdleRecord(id): ExecutionRecord | undefined {
  const found = this.store.collectRecords(1000, "all", undefined)
    .find((r) => r.id === id && r.status === "idle");   // ← 扫磁盘找 idle record
  if (!found) return undefined;
  // ... createRecord + 设 status=idle/sessionFile/round
}
```

### 存在理由
- **resumeRound idle 守卫**：防止非 idle record 重复 resume spawn；**兼做当前唯一的单 activation 互斥**（防双写者交错 append 写坏 session 文件）
- **hydrateIdleRecord**：跨重启（G4 场景 C）内存空时从磁盘水合 idle record 续聊

### 依赖方
- resumeRound 调用方：`deliverMessage` 冷路径（`subagent-service.ts:723`）、messageHandler idle 分流（`subagent-actions.ts:351`）、redeliverPendingMessages（`subagent-service.ts:1365`）
- hydrateIdleRecord 调用方：`getRecordForAction`（`subagent-service.ts:762`）

### 若删除影响
**（a）删 resumeRound idle 守卫（:631）—— 高风险**
失去当前唯一的单 activation 互斥。`acquireActivateLock`（lifecycle-manager）未接入，并发 message 可能双 spawn → 双进程交错 append 同一 session 文件 → **双写者毁文件**（V2 §3.1 决策 7：比脏 entry 断 tree 致命一个量级）。**删除前必须先接 `acquireActivateLock` 或等价互斥机制**。

**（b）删 hydrateIdleRecord —— 低风险（当前已是死路径）**
`record-store.ts` reconstructAll（:299-405）无 idle 分支（只有 `.cancelled`/`.finalized`/`.alive+pid→running`/`crashed`），**collectRecords 永不返回 status="idle" 的 record** → hydrateIdleRecord 的 find 永远返回 undefined → 跨重启续聊水合当前实际无效。其文档注释（subagent-service.ts:745「从磁盘 .idle sidecar 重建 idle record」）**已陈旧**（.idle sidecar 模块已删）。删除它无行为变化，但 V2 跨重启恢复（G4 场景 C）需要重新设计水合路径（Inferred：改用 `.alive`+pid 判定或 record 持久化 PID）。

---

## 补查：chatMode 分流点

### 涉及位置
- `src/interface/subagent-actions.ts:346-362` — messageHandler 分流

### 当前逻辑
```ts
// subagent-actions.ts:346-362
// [V2 决策 3] chatMode 统一投递：按进程死活分流（热路径 prompt+streamingBehavior / 冷路径 resume），
if (record.chatMode) {
  service.deliverMessage(record, text, interrupt);        // V2 统一投递（按进程死活分流，不看 status）
} else if (record.status === "running") {
  service.deliverToRunning(record, text, interrupt);      // 非 chatMode busy（走 pendingMessages 消费确认制）
} else if (record.status === "idle") {
  service.resumeRound(record, text);                      // 非 chatMode idle 续聊（防御性，非 chatMode 不该进 idle）
} else {
  throw new Error(`subagent ${id} has ended (status: ${record.status})...`);
}
```
**分流条件**：`record.chatMode` 优先（V2 决策 3），把 chatMode 从 status 二分流里提出来走 `deliverMessage`（内部按 `getChildByRecord` 死活分流热/冷路径）；非 chatMode 才走 running/idle 二分流。

### 存在理由
chatMode 进程长驻（V2），idle 态进程仍活，续聊应走热路径 prompt 而非重开 session；非 chatMode 仍走 v1 的 running/idle 二分流。

### 依赖方
- chatMode 分支：`deliverMessage`（`subagent-service.ts:717`）→ 内部热路径 sendPromptCommand / 冷路径 resumeRound
- running 分支：`deliverToRunning`（`:583`）
- idle 分支：`resumeRound`（`:624`）

### 若删除 idle 影响
chatMode 分支（:348）不看 status，不受影响。非 chatMode 的 idle 分支（:351）实际是防御性兜底（idle 是 chatMode 专属态，非 chatMode record 不该进 idle），删除它需确认非 chatMode 路径不会误设 idle。

---

## 机制间依赖图

```
┌─────────────────────────────────────────────────────────────────────┐
│  idle 状态的两个写入点（设 record.status="idle" + round+=1）          │
│                                                                     │
│  [首轮正常完成] onRoundSettled                                       │
│    subagent-service.ts:1499-1503                                    │
│    （轻量路径：不写 sidecar / 不补投 / 不调 doFinalizeRoundToIdle）   │
│                                                                     │
│  [失败/取消轮次] doFinalizeRoundToIdle                               │
│    finalize-record.ts:205-276                                       │
│    （含 removeAliveMarker + emitUnregister + MF-1 补投）             │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ 设 status="idle" + round+=1
                           ▼
  ┌────────────────────────────────────────────────────────────────┐
  │  下游消费 idle 状态                                              │
  │                                                                  │
  │  [机制5] resumeRound idle 守卫  subagent-service.ts:631          │
  │    └─ 兼当前唯一单 activation 互斥（:654 CAS 翻转）              │
  │    └─ lifecycle-manager.acquireActivateLock 因此判冗余未接入      │
  │                                                                  │
  │  [机制1] notifier dedup         notifier.ts:122                  │
  │    └─ 读 round 做 id:round 豁免 key（首轮 vs 续聊区分）           │
  │                                                                  │
  │  [机制2] STATUS_PRIORITY        record-store.ts:41               │
  │    + 各处 === "idle" / !== "idle" 判断（16+ 处）                  │
  │    + UI 映射 / 列表排序 / 消息分流                                │
  └────────────────────────────────────────────────────────────────┘

  [机制4] pendingMessages 消费确认制 —— 与 idle 解耦但补投依赖 idle
    入队 deliverToRunning (subagent-service.ts:586)   ← 仅非 chatMode
    清除 message_start(user) (session-runner.ts:742)
    补投 doFinalizeRoundToIdle → redeliverPendingMessages → resumeRound
            ↑ 必须先 record.status=idle，resumeRound 的 idle 守卫才放行

  顶层入口：chatMode 分流 (subagent-actions.ts:348)
    chatMode → deliverMessage (V2 统一，不经 idle 投递判定，
                但冷路径调 resumeRound → 受机制5 idle 守卫约束)
    非chatMode running → deliverToRunning → [机制4]
    非chatMode idle   → resumeRound → [机制5]
```

**一句话概括**：两个写入点（onRoundSettled 轻量 / doFinalizeRoundToIdle 完整）设 idle+round → 三类下游消费（resumeRound idle 守卫兼单 activation 互斥 / notifier round 豁免 / STATUS_PRIORITY + 16 处 idle 判断）；pendingMessages 消费确认制与 idle 解耦但其补投链路必须经 idle 守卫；chatMode 分流是顶层入口。**删除 idle 的最大风险是 resumeRound idle 守卫（:631）是当前唯一单 activation 互斥，必须先接 acquireActivateLock**；最大已失效部分是 hydrateIdleRecord（reconstructAll 无 idle 分支，跨重启水合当前为死路径）。
