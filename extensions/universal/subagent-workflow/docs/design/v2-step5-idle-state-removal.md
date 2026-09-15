# 删除轻量 idle 状态机技术方案（V2 Step 5 控制流改造）

> **一句话结论**：当前的「轻量 idle」是一个**自相矛盾的中间态**——idle 已是纯内存态（`idle-marker.ts` 整个模块已删、磁盘不可重建），但代码里仍保留着试图从磁盘水合 idle 的 `hydrateIdleRecord`（已是**死路径**，导致 V2 跨重启续聊场景 C/D 当前**实际不可用**），且 `resumeRound` 的 idle 守卫身兼两职（idle 判断 + **当前唯一的单 activation 互斥**）。因此「彻底删 idle」不是纯删除任务，而是三个连锁问题的协同重构：① 先接 `acquireActivateLock` 补上互斥（否则双写者毁 session 文件）② 用 `hasIdleTimer`/进程死活替代 16+ 处 idle 判断的「空闲」语义 ③ 重设计跨重启恢复（修掉 hydrateIdleRecord 死路径这个潜伏缺陷）。收益是代码净减 + 顺手修掉跨重启 bug + 消除守卫身兼两职的认知负担；代价是中等重构（handoff 估「L 工作量」基本准确）。

## 层声明

- **当前层**：技术方案设计（状态机简化 + 并发互斥重构 + 恢复路径重设计）
- **下一层产物**：可实现的代码改动（`lifecycle-manager` 接入互斥 + `subagent-service`/`record-store`/`notifier`/`finalize-record`/`types` 删 idle + 跨重启水合重设计 + 测试）
- **性质**：涉及运行时行为（并发互斥、进程死活判定、跨重启恢复）、数据流（idle 状态的生产/消费/持久化）、错误处理（双写者防护） → 设计准则 5/6/7 全部 P0 适用
- **现状基线**：`docs/design/idle-mechanism-survey.md`（6 个 idle 机制精确代码现状，所有 file:line 经双重核实）
- **与既有文档关系**：本文是 V2 §5.3「删除 v1 并发症」中 idle 状态机部分的完整设计，自包含；`v2-defense-ii-iii-resolution.md` 的「防线 iii 冗余」结论**以保留轻量 idle 为前提**，本文若落地则该结论需更新（互斥改由 acquireActivateLock 承担）

---

## §1 背景目标

### SCQA

- **S（情境）**：V2 持续对话核心范式已实施验证（场景 A 多轮热路径稳定）。实施时为让 notify 守卫放行，把 v1 的完整 idle 状态机降级为「轻量 idle」保留——删了 `idle-marker.ts` 模块（磁盘持久化），但保留了内存 idle 字面量 + 相关判断。
- **C（冲突）**：这个「轻量」妥协留下一个自相矛盾的中间态：idle 成了纯内存态（磁盘不可重建），但 `hydrateIdleRecord`（跨重启水合）仍试图从磁盘扫 idle record——而 `reconstructAll` 早已没有 idle 分支，所以它**永远扫不到**，是个死路径。后果是 V2 设计目标 G3/G4（崩溃可恢复、跨重启续聊）当前**实际不工作**：主进程重启后 chatMode record 全变 crashed，续聊 throw "has ended"。同时 `resumeRound` 的 idle 守卫被迫身兼两职——既是 idle 判断，又是当前唯一的单 activation 互斥（防双写者）。
- **Q（问题）**：要不要彻底删掉 idle 状态机达成 V2 §5.3 终态？删的话三个连锁问题（activation 互斥、空闲语义替代、跨重启恢复）怎么协同处理？还是只修潜伏的跨重启 bug、保留轻量 idle？
- **A（答案）**：见 §3 方案对比。核心是「删 idle」必须与「接 acquireActivateLock + 重设计跨重启」捆绑，不能只删；而「只修 bug 保留 idle」是最小代价但留下技术债。本文给出三条路径的完整对比与决策。

### 系统是什么（idle 在当前实现里的角色）

**chatMode subagent 的轮次生命周期**（V2 进程长驻范式）：

```
start {conversation:true}
  → spawn 子进程 → record.status="running" → 跑首轮 turn
  → agent_settled（首轮完成）
  → onRoundSettled 回调（subagent-service.ts:1499）：record.status="idle" + round+=1 + armIdleTimer
  → [进程保持活着，进入空闲]   ← idle 态 = 「进程在、刚完成一轮、等续聊」
  → message（续聊）
  → deliverMessage 判进程死活：热路径 prompt / 冷路径 resumeRound
  → resumeRound 的 idle 守卫（:631）放行 + CAS 翻 running（:654）→ 跑下一轮
  → ... 循环
```

**idle 的语义**：chatMode record 轮次完成后的**非终态中间态**——既不是 running（没在跑 turn），也不是 done/failed（没结束、可续聊）。它被 16+ 处代码消费：列表排序（`STATUS_PRIORITY` idle:2 排在 failed 与 done 之间）、UI 显示（idle→running+pause icon）、消息分流（messageHandler idle 分流）、resumeRound 守卫、notifier 文案。

**关键事实**（决定方案，均经核实）：

| # | 事实 | 验证 |
|---|---|---|
| F1 | `idle-marker.ts` 整个模块已删（write/read/remove/interface 全无），idle 是**纯内存态**，磁盘不可重建 | ✅ grep `writeIdleMarker\|readIdleMarker\|removeIdleMarker\|idle-marker\|IdleMarker` 整个 src 零命中 |
| F2 | `reconstructAll`（record-store.ts:299-405）四分支（cancelled/done-failed/running/crashed）**无 idle 分支** → `collectRecords` 永不返回 idle record | ✅ grep + read 双重核实 |
| F3 | `hydrateIdleRecord`（subagent-service.ts:792）的 `.find(r => r.status === "idle")` 因 F2 **永远返回 undefined** → 跨重启水合是死路径；其注释（:745「从磁盘 .idle sidecar 水合」）已陈旧 | ✅ 由 F2 推导 + read 确认 |
| F4 | 跨重启后 chatMode record 落入 reconstructAll 兜底分支（分支4）变 **crashed**（子进程已 EOF 自杀、pid 死），messageHandler 走 else 分支 throw "has ended" → **V2 场景 C/D 跨重启续聊当前不可用** | ✅ 由 F2/F3 + subagent-actions.ts:346-362 分流逻辑推导 |
| F5 | `resumeRound` idle 守卫（:631）+ CAS 翻转（:654）之间无 await，是同步 CAS = 当前**唯一的单 activation 互斥**；`acquireActivateLock`（lifecycle-manager:321）因此判冗余未接入 | ✅ read 确认（与 `v2-defense-ii-iii-resolution.md` 一致） |
| F6 | `onRoundSettled`（:1499）抢先设 idle 后，runAndFinalize 在 :1184 early return，正常完成首轮**不走** doFinalizeRoundToIdle；后者当前主要服务失败/取消轮次的 MF-6 回退 | ✅ explorer 报告 + read 确认 |

### 设计目标

| # | 目标 | 含义 | 当前状态 |
|---|---|---|---|
| G1 | activation 安全 | 删 idle 后并发 message 不会双 spawn 双写者毁 session 文件 | ⚠️ 当前靠 idle 守卫（身兼两职），删 idle 必须先补互斥 |
| G2 | 空闲语义清晰 | 「进程活但空闲」有明确判定，UI/排序/分流不依赖 idle 字面量 | ⚠️ 当前 16+ 处依赖 idle 字面量 |
| G3 | 跨重启恢复可用 | 主进程重启后续聊能接上之前对话（V2 场景 C/D） | ❌ **当前坏**（F4，hydrateIdleRecord 死路径） |
| G4 | 代码减负 | 消除守卫身兼两职的认知负担 + 死路径 + 轮次豁免等 v1 残留 | ⚠️ 当前是中间态 |

### In-scope / Out-of-scope

**In-scope**：idle 字面量删除、activation 互斥接入、空闲语义替代判定、跨重启恢复重设计、notifier 轮次豁免去留、pendingMessages 消费确认制去留（仅非 chatMode）。

**Out-of-scope**：
- chatMode 进程长驻范式本身（已验证，不动）
- deliverMessage 统一投递语义（V2 决策 3，已落地，不动）
- deliverToRunning（非 chatMode busy 投递）的整体重构——仅评估其 pendingMessages 依赖的连带删除

---

## §2 现状与问题分析

### 2.1 问题 A：idle 守卫身兼两职（删 idle 的硬连锁）

`resumeRound`（subagent-service.ts:624）的前两行：

```ts
if (record.status !== "idle") { throw new Error(`...not ready (current state: ${record.status})...`); }  // :631 守卫
// ... 校验 ...
record.status = "running";  // :654 CAS 翻转（注释：「绕过 tryTransition，idle→running 恢复非终态 CAS」）
```

这两行同时承担两个职责：
- **职责 1（idle 判断）**：只允许 idle 态 record 续聊（终态/running 拒绝）——这是 idle 状态机的语义。
- **职责 2（activation 互斥）**：:631 检查与 :654 翻转之间无 await，同步 CAS，保证同一 record 并发 message 只有一个能进入 spawn——这是单 activation 不变量（防双写者）。

**冲突**：若删 idle 状态机，:631 的守卫消失，职责 2（互斥）随之消失。`acquireActivateLock`（lifecycle-manager 骨架）当前未接入（因 F5 判冗余）。**不接互斥就删 idle = 并发 message 双 spawn = 双进程交错 append 同一 session 文件 = 双写者毁文件**（V2 决策 7：比脏 entry 断 tree 致命一个量级）。

所以「删 idle」与「接 acquireActivateLock」是**硬连锁**，必须同 PR。

### 2.2 问题 B：跨重启恢复当前是坏的（潜伏缺陷，F4）

主进程重启后的 chatMode record 重建路径：

```
主进程重启 → record-store.reconstructAll
  → 读 .alive sidecar：子进程已 EOF 自杀（piped stdio，F10）→ pid 死
  → 分支3（.alive+pid存活）不命中 → 分支4 兜底 → status = "crashed"
  → collectRecords 返回 crashed record（无 idle record，F2）

用户 message 该 record → getRecordForAction（:762）
  → store.getMutable 命中 crashed record（内存有）
  → hydrateIdleRecord（:792）.find(status==="idle") → undefined（F3 死路径）
  → 返回 crashed record → messageHandler else 分支 → throw "has ended"
```

**结果**：V2 设计目标 G3（崩溃可恢复）、G4（主进程重启恢复，场景 C/D）当前**不工作**。chatMode subagent 一旦经历主进程重启，就变成 crashed 终态，无法续聊。

**严重性评估**：这不是「回归」（核心范式刚验证场景 A，场景 C/D 从未验证过），而是「未完成的功能 + 认知偏差」——handoff 把 hydrateIdleRecord 描述为「在用」，实际它是死路径。但它是 V2 明确承诺的目标（G3/G4），长期必须修。**删 idle 时顺便修这个，比单独修更经济**（都要改 reconstructAll 的重建逻辑）。

### 2.3 问题 C：16+ 处 idle 判断的替代（纯工作量）

idle 字面量被 16+ 处消费（见 idle-mechanism-survey 机制 2）。删除前必须有「进程活但空闲」的替代判定。当前已有的基础设施：

- `lifecycle-manager.hasIdleTimer(recordId)`：idle timer armed = 空闲态（agent_settled arm、新 turn disarm）。这是最贴切的替代——idle timer 的 arm/disarm 语义本就对应「空闲/忙碌」。
- `session-runner.getChildByRecord(id)` + `child.killed`：进程死活判定（deliverMessage 已用）。

替代不是「找 16 处逐个替换」这么简单——有些是 UI/排序（可用 hasIdleTimer）、有些是路由分流（messageHandler 已按 chatMode 优先分流，idle 分支是防御性兜底）、有些是状态机转换（需重新设计）。

### 2.4 物理数据流：idle 的生产与消费

```
┌─ idle 生产（两个写入点）──────────────────────────────────────┐
│  [首轮正常完成] onRoundSettled (subagent-service.ts:1499)     │
│    设 status="idle" + round+=1 + armIdleTimer                 │
│  [失败/取消轮次 MF-6] doFinalizeRoundToIdle (finalize-record:233) │
│    设 status="idle" + round+=1 + removeAliveMarker + 补投     │
└─────────────────────────┬───────────────────────────────────┘
                          ▼ (内存态，磁盘不可重建 — F1)
┌─ idle 消费 ──────────────────────────────────────────────────┐
│  resumeRound 守卫 (:631) + CAS (:654)  ← 兼 activation 互斥   │
│  notifier dedup (:122) id:round 豁免                          │
│  STATUS_PRIORITY (:41) 排序 + UI 映射 + 消息分流 (16+ 处)      │
└──────────────────────────────────────────────────────────────┘
                          ▼ (跨重启 — F3/F4 坏)
┌─ 跨重启水合（死路径）─────────────────────────────────────────┐
│  hydrateIdleRecord (:792) .find(status==="idle") → 永远 undef │
│  实际：record 落 crashed 分支 → 续聊 throw "has ended"        │
└──────────────────────────────────────────────────────────────┘
```

---

## §3 解决方案

### 3.1 终态（方案 B 落地后，使用者视角）

**多轮热路径（不变，G2）**：
```
[用户] start {conversation:true, task:"..."} → 首轮完成 → notify
[用户] message {text:"继续"} → 热路径 prompt（进程活）→ 第二轮 → notify
[用户] message {text:"再继续"} → 热路径 → 第三轮 → notify
[机制] 进程全程不 kill；每轮 agent_settled 后 armIdleTimer（空闲）；message disarm + prompt
[列表] /subagents 显示该 record 为 "idle/waiting"（由 hasIdleTimer 派生，非 status 字面量）
```

**跨重启恢复（修复后，G3）**：
```
[用户] （对话进行中）主进程被重启
[机制] 子进程 EOF 自杀；record 的 .alive sidecar + session 文件留盘
[用户] 重启后 message 该 subagent
[机制] reconstructAll 分支3 读 .alive（pid 死）→ 但 session 文件在 → 识别为「可恢复的 chatMode record」
       → 冷路径 resume spawn（--session 重开）→ prompt → 上下文保留（parentId 链连续）
[结果] ✅ 续聊引用重启前对话（修复 F4）
```

**并发 message 不双写（G1）**：
```
[用户] 同一 record 快速发两条 message（进程死，都走冷路径）
[机制] acquireActivateLock 串行化：msg1 拿锁 spawn → 注册 child → release；msg2 等锁 → 拿到锁 → getChildByRecord 命中活 child → 热路径 prompt（不再 spawn）
[结果] ✅ 只有一个活进程，无双写者
```

**失败路径（互斥锁泄漏）**：
```
[机制] msg1 拿锁后 spawn 异常 → 必须在 finally release（覆盖 close/error/abort 全退出路径）
[失败] 若漏 release → msg2 永久挂起（死锁）
[恢复] 👉 需给锁加超时兜底（如 spawn 后 N 秒未 release 自动释放），或用 controller.abort 信号联动 release
```

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 维持轻量 idle 不动** | ❌ 中间态（纯内存 + 死水合 + 守卫身兼两职）长期是技术债；G3 跨重启坏着 | 零 | 中（G3 一直坏，用户撞上跨重启续聊就失效） | ❌ 不推荐（留 bug） |
| **B 彻底删 idle + 接互斥 + 重设计跨重启**（V2 §5.3 终态） | ✅ 终态干净：互斥归 acquireActivateLock、空闲归 hasIdleTimer、跨重启归 .alive+session 重建；消除守卫身兼两职 + 死路径 | 中-高：互斥接入（退出路径全覆盖）+ 16 处替代 + 跨重启重设计 + 测试 | 中（互斥接入有死锁风险，需超时兜底） | ✅ **追求 V2 终态时推荐** |
| **C 仅修跨重启 bug，保留轻量 idle**（最小修复） | ⚠️ 修了 F4 但留下守卫身兼两职 + 死路径代码（hydrateIdleRecord 改活或删+重建） | 低-中：改 reconstructAll 让 chatMode record 可恢复（不依赖 idle sidecar） | 低 | ✅ **快速止血时推荐** |

**被否方案 A 的后果**（若用它，§2.2 的例子持续存在）：用户在 chatMode 对话中途重启 taiji/pi，再 message 该 subagent 报 "has ended"，对话丢失。这是 V2 承诺的 G3/G4，留着就是承诺不兑现。

**方案 B vs C 的核心权衡**：B 是终态（一次做完，代码净减，但中-高成本 + 互斥死锁风险）；C 是止血（快速修 bug，但留技术债）。**推荐**：若本分支目标是合并一个干净的 V2 终态 → B；若目标是尽快让用户用上跨重启恢复 → C，B 留后续。两者不冲突（C 是 B 的子集——C 修的跨重启逻辑在 B 里会被重写但方向一致）。

### 3.3 关键决策与权衡（方案 B 详细设计）

#### 决策 1：activation 互斥 — 接入 acquireActivateLock + 超时兜底

- **选择**：`deliverMessage` 冷路径（resumeRound）前 `await acquireActivateLock(record.id)`，spawn + 注册 child 后 release（finally）。
- **退出路径全覆盖**（lifecycle-manager TODO 原指出的难点）：release 必须覆盖 runSpawn 的全部退出——正常 close / error / abort / chatMode resolve。方案：把 release 挂在 `kickOffBackground` 的 Promise 链 finally（runAndFinalize 无论成功失败都过 finally），而非散落在各退出点。
- **死锁兜底**：spawn 后若异常导致 release 未调（如 runSpawn 同步抛），加锁超时（如 30s 自动 release + warn），或用 `record.controller.signal` 的 abort 联动 release。
- **被否**：保留 idle 守卫当互斥（=方案 A，不删 idle）——身兼两职的认知负担留存。
- **探针**（⛔ 实施期）：P-mutex-1 并发双 message 断言只 spawn 一次；P-mutex-2 spawn 异常后锁释放（不死锁）；P-mutex-3 长时间不 release 超时兜底生效。

#### 决策 2：空闲语义替代 — hasIdleTimer 派生

- **选择**：UI/排序/分流的「空闲」判定改用 `hasIdleTimer(record.id)`（armed = 空闲）。新增派生谓词 `isChatModeIdle(record)` = `record.chatMode && hasIdleTimer(record.id) && !记录在跑 turn`。
- **依据**：idle timer 的 arm/disarm 语义（agent_settled arm、新 turn disarm）本就精确对应「空闲/忙碌」，比 status 字面量更贴近真相（status 是推断，timer 是事实）。
- **替代映射**：
  - `STATUS_PRIORITY` 删 idle 键 → chatMode 空闲 record 的排序用 hasIdleTimer 派生优先级
  - UI 映射（gui-mappers）：idle→running+pause 改为 hasIdleTimer→pause
  - messageHandler idle 分支（:351）：chatMode 已优先分流（:348），idle 分支是防御性兜底，删 idle 后该分支消失
- **被否**：用 getChildByRecord+child.killed 判定——它判的是「进程死活」不是「空闲」，busy 时进程也活，无法区分空闲/忙碌。

#### 决策 3：跨重启恢复重设计 — .alive + session 文件识别 chatMode 可恢复

- **选择**：`reconstructAll` 增加对 chatMode record 的可恢复识别——读 session 文件的 identity entry（含 chatMode 字段，V2 决策 5 子进程写），若 chatMode=true 且 session 文件在 → 标记为「可冷路径 resume」（非 crashed 终态）。
- **流程**：重启后 message 该 record → getRecordForAction 水合（重写，不再扫 idle）→ 识别为可恢复 chatMode → deliverMessage 冷路径 resume spawn → 上下文保留。
- **删 hydrateIdleRecord**：它是死路径（F3），删除无行为变化；其职责（跨重启水合）由新的 chatMode 可恢复识别承担。
- **依据**：identity entry 已持久化 chatMode 字段（V2 决策 5），reconstructFromFile 能读到；.alive sidecar 的 pid 死活只决定「热路径可行否」，不决定「能否冷路径恢复」（session 文件在就能 resume）。
- **探针**（⛔ 实施期）：P-restart-1 重启后续聊引用重启前对话（parentId 链连续）；P-restart-2 无孤儿残留。

#### 决策 4：notifier 轮次豁免 — 删 round，回归一次性语义

- **选择**：`dedupKey` 从 `${id}:${round}` 回归 `${id}`（V2 §2.3 第一类 + 决策 6）。进程长驻后，notify 语义回归一次性——每轮完成 notify 一次，60s dedup 防的是「同一条完成的重复 notify」（如 onRoundSettled + kickOffBackground.then 双发），不是「多轮」。
- **依据**：V2 进程长驻，多轮 notify 本就是不同事件（不同 agent_settled），不该被 dedup 吞。当前用 round 豁免是「为绕开 dedup 吞多轮」的补丁，删 idle 后 round 字段消失，豁免随之消失，dedup 回归纯 id。
- **被否**：保留 round 豁免——round 字段依赖 idle 状态机（doFinalizeRoundToIdle/onRoundSettled 递增），删 idle 后 round 无来源。

#### 决策 5：pendingMessages 消费确认制 — 删（仅影响非 chatMode）

- **选择**：删除 pendingMessages 入队/清除/补投三环（types.ts 字段 + deliverToRunning 入队 + session-runner 清除 + doFinalizeRoundToIdle 补投）。符合 V2 决策 6（降级为 best-effort 重发）。
- **影响范围**：仅非 chatMode 的 `deliverToRunning`（busy 投递）。chatMode 的 deliverMessage 本不碰它（V2 决策 3 统一投递）。
- **代价**：非 chatMode busy 投递在「record 仍 running 但子进程刚 close」竞态窗口的消息会丢——V2 决策 6 明确接受（崩溃重发语义，类比网络重传）。
- **被否**：保留——它是 v1 每轮 kill 范式的并发症（防 busy→kill 竞态），V2 进程长驻下竞态窗口从「每轮」缩到「仅崩溃」，维护三环机制不划算（准则 8 减法）。

---

## §4 验收（真实场景，非单测）

**改动规模**：大（状态机简化 + 互斥重构 + 恢复重设计）。以下场景真实环境验证，单测仅回归辅助。

### 场景 1：多轮热路径 + 空闲显示（回溯 G2，核心不回归）

- **步骤**：① `start {conversation:true}` 起 subagent；② 等 notify；③ 连发 3 轮 message；④ `/subagents list`。
- **通过标准**：每轮无新 spawn（spawn 次数=1）；parentId 链连续；列表显示该 record 为 waiting/idle 态（hasIdleTimer 派生）；每轮 notify 主 agent 收到（不被 dedup 吞）。

### 场景 2：跨重启恢复（回溯 G3，修复 F4，最关键）

- **步骤**：① chatMode 对话进行中（≥2 轮）；② 重启主进程（同 session-dir）；③ `/subagents list` 显示该 record（水合，非 crashed）；④ `message` 续聊。
- **通过标准**：续聊引用重启前对话（parentId 链连续）；无 "has ended"；重启时旧子进程被收割（无孤儿）；机制侧断言 reconstructAll 识别为可恢复 chatMode（非 crashed 兜底）。

### 场景 3：并发 message 不双写（回溯 G1，互斥验证）

- **步骤**：① chatMode record 进空闲（进程活）；② `kill <pid>` 模拟进程死；③ 快速连发两条 message（都走冷路径）。
- **通过标准**：只 spawn 一次（机制侧监控 spawn 次数=1）；session 文件 parentId 链完整（无双写痕迹）；第二条 message 等锁后走热路径（投递给第一个 spawn 的进程）。

### 场景 4：互斥锁异常释放（回溯 G1，死锁防护）

- **步骤**：① mock runSpawn 同步抛异常；② 并发 message。
- **通过标准**：锁被释放（finally 或超时兜底）；后续 message 不永久挂起；日志 warn 锁超时（若走超时路径）。

### 场景 5：失败轮次可续聊重试（回溯 MF-6，doFinalizeRoundToIdle 删除后替代）

- **步骤**：① chatMode 某轮失败（如 tool 报错）；② `message` 重试。
- **通过标准**：失败轮次后 record 仍可续聊（非终态）；重试轮次正常跑。验证 doFinalizeRoundToIdle 删除后 MF-6 语义由新机制承担。

---

## §5 下一层拆分

### 5.1 实现路径（方案 B，建议分阶段可独立验收）

| 阶段 | 改动 | justification | 验收 |
|---|---|---|---|
| **B-1 接互斥** | lifecycle-manager acquireActivateLock 接入 deliverMessage 冷路径 + finally release + 超时兜底 | 决策 1。**必须最先做**——它是删 idle 的前置（补上职责 2） | 场景 3/4 |
| **B-2 修跨重启** | reconstructAll 识别 chatMode 可恢复 + 删 hydrateIdleRecord 死路径 + getRecordForAction 水合重写 | 决策 3。修 F4 潜伏 bug，可独立合并（=方案 C） | 场景 2 |
| **B-3 替代空闲语义** | 新增 isChatModeIdle 派生 + STATUS_PRIORITY 删 idle 键 + UI 映射改 hasIdleTimer | 决策 2。B-1/B-2 后进行，此时互斥与恢复不依赖 idle | 场景 1 的列表显示 |
| **B-4 删 idle 字面量** | 删 ExecutionStatus idle + 16 处判断 + onRoundSettled/doFinalizeRoundToIdle 设 idle 改为 arm timer only | 决策 2 收尾。编译器强制全覆盖（Record<ExecutionStatus> 类型） | tsc exit 0 + 全测试 |
| **B-5 删 v1 残留** | notifier dedup 回归纯 id（决策 4）+ 删 pendingMessages 三环（决策 5）+ 删 doFinalizeRoundToIdle（职责被 B-1/B-3 取代） | 决策 4/5。减法收尾 | 场景 1 notify + 场景 5 |

**关键依赖序**：B-1（互斥）→ B-3（替代）→ B-4（删 idle）。B-2（跨重启）与 B-1/B-3 并行无依赖，可先做（=方案 C 提前止血）。B-5 最后。

### 5.2 文件改动地图

| 文件 | 改动 |
|---|---|
| `execution/lifecycle-manager.ts` | acquireActivateLock 接入（B-1）+ 超时兜底 |
| `execution/subagent-service.ts` | deliverMessage 冷路径加锁（B-1）+ resumeRound 删 idle 守卫（B-4）+ hydrateIdleRecord 删除+水合重写（B-2）+ onRoundSettled 改 arm-only（B-4） |
| `execution/record-store.ts` | reconstructAll 加 chatMode 可恢复识别（B-2）+ STATUS_PRIORITY 删 idle（B-3） |
| `execution/types.ts` | ExecutionStatus 删 "idle"（B-4）+ 删 pendingMessages 字段（B-5） |
| `execution/notifier.ts` | dedupKey 回归纯 id（B-5）+ status union 删 idle |
| `execution/finalize-record.ts` | 删 doFinalizeRoundToIdle（B-5）+ 删补投块 |
| `execution/session-runner.ts` | 删 message_start pendingMessages 清除（B-5） |
| `interface/subagent-actions.ts` | messageHandler 删 idle 分支（B-4） |
| `interface/gui-mappers.ts` / `format.ts` | idle 显示改 hasIdleTimer 派生（B-3） |

### 5.3 待验证检查点（实施期）

- **互斥退出路径全覆盖**：runSpawn 的 close/error/abort/chatMode resolve 四条退出是否都过 finally release（P-mutex-2）。这是 lifecycle-manager TODO 原难点，B-1 实施时逐一验证。
- **hasIdleTimer 与 busy 的一致性**：idle timer disarm 时机（新 turn 开始）是否与「进程开始忙」完全同步——若 disarm 晚于实际 turn 开始，窗口期 hasIdleTimer 误报空闲。核实 arm/disarm 触发点（agent_settled arm / 投递 disarm）。
- **跨重启 chatMode 识别准确性**：reconstructAll 读 identity entry 的 chatMode 字段是否在所有 chatMode record 都写入了（V2 决策 5 子进程 session_start 写，冷路径 resume 也触发 F9）。
- **net 行数**：V2 设计预估净减 ~270-330 行；B 落地后实测对比（删的 idle/补投/doFinalizeRoundToIdle/hydrateIdleRecord vs 加的互斥接入/派生谓词/chatMode 识别）。

### 5.4 方案 C 的最小子集（若选择快速止血）

若不立即做方案 B，仅修 F4（跨重启 bug）：执行 B-2 单步（reconstructAll 识别 chatMode 可恢复 + 删 hydrateIdleRecord 死路径 + 水合重写），保留轻量 idle。代价：守卫身兼两职 + 死路径代码痕迹留存，但 G3 跨重启恢复可用。B-2 是 B 的真子集，后续做 B 时该步会被重写但方向一致，不浪费。

---

## 附录：与既有结论的关系

- **`v2-defense-ii-iii-resolution.md`「防线 iii 冗余」**：该结论前提是「保留轻量 idle（status CAS 守卫还在）」。本文方案 B 落地后，status CAS 守卫随 idle 一起删，activation 互斥改由 acquireActivateLock 承担——届时需更新该文档的防线 iii 章节（从「冗余」改为「承接 idle 守卫的互斥职责」）。
- **V2 §5.3「删除 v1 并发症」**：本文是其中 idle 状态机部分的完整设计；notifier 轮次豁免（决策 4）、消费确认制降级（决策 5）对应 V2 §2.3 第一类的「真并发症，终态下消失」。
- **idle-mechanism-survey.md**：本文现状基线，所有 file:line 引用源自该报告并经独立核实。
