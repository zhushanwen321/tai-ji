# scheduler 投递模型简化：steer 直投（ext-simplify-08 投递面 supersede）

> **一句话结论**：把 scheduler 的到期投递从「session-delivery 内核 park 队列（busy gate + 防重标记 + TTL + 合批 + per-message settled 回调记账）」简化为「tick 到期直接 `pi.sendMessage(steer)` + 受理即记账」；删除 delivery handle 装配、防重标记、`QUEUE_DEDUPE_TTL`、`handleSettled` 与 `schedule` 工具的 `force` 参数。触发链：2026-09-14 验收观测 idle 期 ~10min 精确延迟投递 → 归因为投递链时序反转缺陷 → 用户裁决投递模型过重，提醒类注入应立即 steer 打断，整体大幅简化。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-scheduler`（v0.6.0）非 force 任务经 `@xyz-agent/session-delivery` 内核投递：busy 时消息 park 在内核内存队列等 `agent_settled` 边沿、多任务合批、投递终态经 per-message `onSettled` 回调驱动 scheduler 记账（runCount/nextRunAt 推进），防重标记 `queuedInDeliveryAt` + 10min TTL 防止「入队未终态」窗口的重复入队。
- **C（冲突）**：ext-simplify-08 验收（2026-09-14）观测到 idle 长静默期 interval 任务出现 4 次复现的 **~10min 精确延迟**注入（impl-plan 风险 10）。归因（源码 + 探针实验闭环）：pi extension API `sendMessage` 是 fire-and-forget 返回 `undefined`（0.84.4 与 0.85.1 实装一致），delivery 内核对 void 返回在 `port.send` 同步调用栈内完成全部终态链——`handleSettled` 的 `delete(标记)` 先于 `dispatchViaDelivery` 的 `set(标记)` 执行（空删），标记置位后永久残留，TTL 内每 30s tick 的 dispatch 全被 gate 拦截，**下一轮投递 = 上一轮投递 + 恰好 10min**（600s 整除 30s tick，放行只差毫秒级回调延迟）。引入点 `752ca6433`（2026-08-23 scheduler 迁移 delivery 内核），非 ext-simplify-08 本批。
- **Q（问题）**：修复路径二选一——微任务化内核 settle 时序（保留全部机制，±1 行）还是拆层（投递模型整体简化）？
- **A（答案）**：用户裁决拆层：投递语义需求重新定价——提醒类注入不需要「必达 + 合批 + 不打断」，绝大部分场景应**立即 steer 打断**。全任务统一 `{deliverAs:'steer', triggerTurn:true}` 直投 + 受理即记账；delivery 链路与 force 字段整体删除；三条代价（busy 打断 / abort 丢轮 / 无合批）按四要素登记接受。

**层声明**：技术方案设计层（下一层产物 = 可实施的代码任务 + 测试改造清单）。

**裁决记录**：2026-09-14 用户在归因分析会话中拍板（「绝大部分场景甚至应该立刻打断 agent 的执行，steer 进去就解决了，先做成这种模式的，整体大幅度简化」）；`force` 参数处置经选项确认选「删除字段」（工具 schema breaking change，0.x minor 版本承载）。

---

## 1. 背景：被替换的投递链与归因结论

### 1.1 现投递链（0.6.0，将被整体替换的部分）

```
tick 扫描（30s）→ 到期任务 pending → dispatchTask
  force 任务 → backend.sendMessage(followUp) 直投
  非 force 任务 → delivery.send() 入内核内存队列 + queuedInDeliveryAt.set(taskId, now)
    ├─ agent busy：park，等 agent_settled 边沿 / watchdog 复核 → flush
    └─ agent idle：立即 doSend → pi.sendMessage(followUp)
  终态 → onSettled(msg, 'delivered') → handleSettled：delete 标记 + 记账
```

### 1.2 归因结论（自包含摘要，完整证据链见变更历史索引）

时序反转三事实：① pi `sendMessage` 包装（runner.bindCore）无 return → extension 侧拿到 `undefined`；② delivery 内核 `attemptSend` 对非 thenable 返回同步走 `onSendOk → onSettled`（「void = 受理成功」的旧 port 兼容）；③ scheduler `dispatchViaDelivery` 的标记 `set` 在 `delivery.send()` 返回之后。三者在 idle 立投路径叠加：**settle 链（含 delete 标记 + advance 记账）在 `send()` 的同步调用栈内先跑完，`set` 后置且此后无人删除** → 标记残留 10min，tick 每 30s 重试 dispatch 全被 gate 拦，TTL 过期放行后再反转、再残留——周期性 10min 节奏。busy park 路径（先 set 后投）时序正常不触发——解释了「验收前两轮正常、后续 10min」与「P3 预演（sleep 占忙）两轮正常」的全部形态差异。探针实验复现：第二轮注入 = 第一轮注入 + 10min23ms，`PROBE-GATE` 17 连拦、queuedAt 恒为上轮 SET 时刻。

### 1.3 「直接投」的既有先例

`force` 路径（`dispatchDirect`）一直是「调 `pi.sendMessage` → `await`（实际为 undefined，立即通过）→ 记账」的直投形态，无队列无标记，idle/busy 均立即可投。本次简化 = 把全量任务收敛到该形态并从 followUp 换 steer。

## 2. 设计目标

1. **投递一步化**：tick 到期 → `pi.sendMessage(prompt, {deliverAs:'steer', triggerTurn:true})` → 调用返回即记账。无中间层、无跨层回调契约。
2. **bug 载体消失**：防重标记、TTL、settled 回调绑定全部删除——10min 延迟缺陷的机制载体不复存在（受理即记账，无「入队未终态」窗口，防重不再需要）。
3. **工具面简化**：`schedule` 删除 `force` 参数（全部任务统一语义）；创建回显删 `no-force`/`force` 标签。
4. **调度本体不动**：tick 轮询 + pending 状态机、rate limit（6 次/分钟）、append-only 记账（upsert/advance/toggle/delete）、croner 解析、resume 重放、importer 一次性迁移——全部保留。

**In-scope**：`extensions/universal/scheduler/`（src + tests + package.json version bump 0.6.0 → 0.7.0）；本文档 + ext-simplify-08 设计文档头部 supersede 注记；changeset；`.tmp/dev-flow/ext-simplify-group-a.impl-plan.md` 风险 10 登记收口（归因结论 + 以简化移除载体关闭）。
**Out-of-scope**：`packages/session-delivery`（保留——runtime 的 session-manager send 通路与 subagent-workflow 仍在消费；其 per-message settled 语义对 runtime 零影响，runtime 不配 onSettled）；runtime / subagent-workflow 的 delivery 装配；scheduler 的 event sourcing 存储层。

## 3. 现状：投递模型为何可以砍

**本章结论：现有投递链的全部高级语义（必达 + 合批 + 不打断）都服务于一个「礼貌提醒」的产品假设；用户裁决该假设过重——提醒的价值在到达速度而非礼貌，steer 打断是期望行为而非缺陷。**

逐机制清账：

| 机制 | 服务的语义 | 简化后 |
|---|---|---|
| park 队列 + busy gate | 不打断当前 run（after-run 意图） | 删——steer 立即插入当前 turn 是**期望行为**（用户点名） |
| 防重标记 + TTL | 「入队未终态」窗口防重复入队 + 回调丢失兜底 | 删——受理即记账后窗口不存在（`nextRunAt` 调用即推进，tick 不再重标 pending） |
| 合批 | 多任务同刻到期省 turn/token | 删——各自独立注入，N 任务 N 条消息（代价 c 登记） |
| per-message settled 回调 | 跨层记账契约（本次 bug 的载体） | 删——记账在 dispatch 调用栈内同步完成 |

pi 侧语义（0.84.4/0.85.1 实装一致，types.d.ts:300 `deliverAs?: "steer" \| "followUp" \| "nextTurn"`；agent-session.js sendCustomMessage 分支）：`isStreaming && triggerTurn!==false` 时 `deliverAs==='steer'` → `agent.steer()`（插入当前流式 turn）；`!isStreaming && triggerTurn` → `await _runAgentPrompt()`（开新 turn）。`{deliverAs:'steer', triggerTurn:true}` 即「busy 打断、idle 开新 turn」的全场景单参数。

## 4. 终态：使用者眼里将是什么样的

### 4.1 成功路径

```
[agent] schedule { prompt: "check CI", schedule: "*/10 * * * *" }
[tool 返回] Task "check CI" (a3f2c1d8) created. every 10m (cron), expires 7d
           Next 5 runs: ...

到期（tick 30s 粒度内发现）：
  agent 空闲 → 消息开新 turn 注入，模型立即处理
  agent 正忙 → steer 插入当前 turn，模型在本轮内即看到提醒
schedule_control list：runCount +1、nextRunAt 推进（与注入同 tick，不再有 10min 延迟形态）
```

### 4.2 失败路径（带恢复指引）

- **`pi.sendMessage` 同步 throw**（session 关闭等）：catch → `lastStatus='failed'` + history 记录 + `pending` 保留 → 下个 tick 自动重试（既有 force 路径行为不变）。👉 会话恢复后自动续投，无需人工干预；连续失败看 widget 的 failed 状态。
- **用户 abort 清空 pi 队列**（已接受代价 b）：steer 消息在 pi steering 队列中被 `clearQueue()` 清掉——该轮丢失但已记账。👉 下个周期自然继续（interval）；once 任务丢失不可自动恢复（见 §5 代价 b 重审触发）。
- **rate limit**（>6 次/分钟）：dispatch no-op、pending 保留，下个 tick 重试（现状行为不变）。

## 5. 关键决策与权衡

**D1：直投 steer（用户裁决）vs 修契约保内核**

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| steer 直投（选） | 投递链与调度器同层，无跨包契约；bug 载体消失；代码净删约 -150 行（runtime/index + 4 个测试文件） | 低-中：src 8 文件 + tests 10 文件改/删 | 三条已接受代价（下表）；工具参数 breaking | ✅ |
| 内核 settle 微任务化（方案 A） | 机制全保留，±1 行修 bug | 最低 | 复杂度维持；跨层时序契约需测试锚定；下一个 void port 消费方仍可能踩 | ❌（投递语义已被裁决过重，修 bug 不解决过重） |
| followUp 直投（不打断版） | 同直投但保留「turn 结束后注入」 | 同 steer | 与用户点名的「立即打断」相悖 | ❌ |

**已接受代价（四要素格式，按 AGENTS.md 设计已接受代价约定）**：

| # | 代价 | 量级 | 恢复路径 | 重审触发 | 判定 |
|---|---|---|---|---|---|
| a | **busy 时打断当前 turn**：steer 消息插入正在执行的 run，模型本轮内转向处理提醒 | 每个到期注入在 busy 期都会发生（设计内行为，非异常） | N/A（期望行为） | 用户/使用方反馈「提醒打断重要任务」成为痛点 → 重议 after-run 可选参数（届时以 schedule 工具参数形态回归，非投递层机制） | 可接受 |
| b | **abort 丢轮**：steer 消息在 pi steering 队列时用户 abort → `clearQueue()` 清队，该轮丢失但已记账（at-least-once 降级为「受理后 at-most-once」） | 仅「注入恰在 pi 队列停留的短窗口内用户 abort」的交集场景；interval 任务丢一轮 | 下个周期自然继续 | once 任务 abort 丢失的实际投诉 | 可接受（提醒类丢一轮的代价远小于 10min 级延迟） |
| c | **无合批**：N 个任务同刻到期 = N 条独立注入、各触发一次 turn | 任务密度高时 token/调用成本线性 | N/A | 多任务重度使用后 token 成本显著 → 重议合批（届时在 dispatch 层做窗口合并，不回投递内核） | 可接受（当前 MAX_TASKS=50、rate limit 6/min 已天然限流） |

## 6. 实现机制（文件清单）

| 文件 | 动作 | 要点 |
|---|---|---|
| `src/runtime.ts` | 改（大删） | 删 `delivery` 构造参数/字段、`dispatchViaDelivery`、`handleSettled`、`queuedInDeliveryAt`、`QUEUE_DEDUPE_TTL_*`、tick 末尾 `delivery.flush()`；`dispatchTaskInner` 收敛为单一 `dispatchDirect` 路径并改传 `{deliverAs:'steer', triggerTurn:true}`；`onDispatchSuccess` 的 `countRate` 参数随 delivery 路径删除而简化；`addTask` 删 `force` 赋值 |
| `src/index.ts` | 改 | 删 `createDelivery` 装配、`settledHandlerRef`、`deliveryHandle` 生命周期（session_start 创建/session_shutdown dispose）；`SchedulerRuntime` 构造去掉 delivery 实参 |
| `src/backend.ts` | 改 | `sendMessage` opts 类型 `deliverAs?: 'followUp'` → `'steer'` |
| `src/tool.ts` | 改 | `ScheduleParams` 删 `force` 字段；解构与 `service.create` 调用同步；`controlGuidelines` 中 force/delivery 描述改写 |
| `src/service.ts` | 改 | 创建回显删 `forceLabel`；`run` action 注释改 |
| `src/types.ts` | 改 | `ScheduledTask.force`、`TaskSnapshot.force`、`AddOptions.force` 删 |
| `src/replay.ts` | 改 | upsert 折叠删 `force: snapshot.force`（旧 JSONL entry 中的 force 字段成为被忽略的多余字段，无害） |
| `src/importer.ts` | 改 | 旧 store 迁移删 force 读取（旧 force/non-force 任务统一收敛到新直投语义） |
| `src/__tests__/` | 删+改 | 删：`U4-ONSETTLED`、`U4-PARK_GATE`、`U4-AFTER_RUN_INTENT`（投递链专属）；改：`U4-DISPATCH_INFLIGHT`（守卫保留但断言改直投形态）、`index-generation`（装配断言删 delivery 段）、`index-session-start`、`runtime`（dispatch 用例改 steer 直投断言）、`service`/`tool`/`commands`/`replay`/`importer`/`widget`/`backend` 中 force 相关断言清理；`mock-backend.ts` sendMessage 签名跟随 |
| `package.json` | 改 | version 0.6.0 → 0.7.0；dependencies 删 `@xyz-agent/session-delivery` |

错误规格不变量：`sendMessage` throw → failed 记账 + pending 保留 + 不 rethrow（tick 继续其他任务）；rate limit 拦截 → pending 保留（现状语义）；`addTask`/`toggle`/`delete`/advance 记账链零变化。

## 7. 验收（真实场景）

| # | 场景 | 通过标准 |
|---|---|---|
| V1 | **idle 周期触发回归**（原 bug 场景）：pi CLI 本地源码 + 单任务 1m interval + 纯 idle 静置 ≥12min | 每轮注入延迟 ≤ tick 粒度 + 投递开销（~35s 内），**无 10min 延迟形态**；advance entry 逐轮 +1、nextRunAt = at+60s |
| V2 | **busy 打断**：长 prompt 让 agent busy 跨任务到期 | 到期后 ≤35s 内消息以 steer 形态出现在当前 run 内（session JSONL entry 序列佐证），记账同步推进 |
| V3 | 工具面回归：`schedule` 不带 force 建任务成功、回显无 force 标签；旧调用带 force → typebox 参数校验报错（可理解的错误形态）；`schedule_control list/run/toggle/delete` 全操作正常；会话重开任务恢复（replay 兼容旧 entry 多余 force 字段） |
| V4 | 邻居零影响：`pnpm extensions:typecheck && extensions:lint && extensions:test` 三连绿；`packages/session-delivery` 套件零改动全绿（包本身不动）；runtime 包 delivery 消费套件抽查绿 |

V1 与本次归因实验（/tmp/sched-idle-probe-data，10min23ms 复现）构成同场景对照。

## 8. 实施

单 commit 交付（同包内简化 + 测试改造一体）；实施后同步：①ext-simplify-08 设计文档头部 supersede 注记；②impl-plan 风险 10 登记「已归因（时序反转三事实）+ 以投递模型简化移除缺陷载体关闭」；③changeset（@zhushanwen/pi-scheduler minor：投递模型简化 + force 参数移除 breaking）。

---

## 附录：变更历史

- v1（2026-09-14）：初稿。触发链 = ext-simplify-08 验收风险 10 观测归因（idle 10min 精确延迟：pi sendMessage void 返回 + delivery 内核同步 settle + scheduler set-after-send 时序反转致防重标记永久残留）+ 用户裁决投递模型过重（steer 直拍打断 + 大幅简化 + force 字段删除）。归因证据：源码实读（pi 0.84.4/0.85.1 sendCustomMessage 与 runner.bindCore 包装、delivery.ts attemptSend/onSendReceipt、runtime.ts dispatchViaDelivery）+ 探针实验复现（探针已从源码还原，实验数据留存 /tmp/sched-idle-probe-data）。
