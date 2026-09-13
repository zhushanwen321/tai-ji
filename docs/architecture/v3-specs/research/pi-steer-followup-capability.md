# pi Steer / FollowUp 能力调研

> 归档 xyz-agent 上层 composer 复用 pi 底层 steer/followUp 能力的全部源码调研结论。
> 来源：三轮调研（`agent.ts` / `agent-session.ts` / `agent-loop.ts` / `rpc-*.ts` / `interactive-mode.ts`）。
> 用途：作为 composer 队列设计的唯一事实依据，避免基于错误假设动手。

## 一、核心机制：两个独立队列 + 优先 drain

pi 在 Agent 层和 Session 层各维护一份队列镜像：

| 层 | 数据结构 | 作用 |
|---|---|---|
| Agent（agent.ts:147-148） | `steeringQueue` / `followUpQueue`（PendingMessageQueue） | 真正参与 loop drain 的队列 |
| AgentSession（agent-session.ts:268-270） | `_steeringMessages` / `_followUpMessages`（string[]） | UI 显示 + 撤回用的文本镜像，入队时同步写入 |

入队时两边都写（`_queueSteer` 同时 push 文本镜像 + 调 `agent.steer()`）；被 loop 消费时，Session 层靠监听 `message_start` 事件从镜像里 splice 掉（agent-session.ts:484-493）。

drain 优先级（agent-loop.ts:174-262，回答所有问题的根）：

```
内层循环 while (有工具调用 || steering 非空):
    注入 pending → streamLLM → 执行工具
    pending = drain(steering)        ← steering 每轮都查，有绝对优先权
内层退出后:
    fu = drain(followUp)             ← 只有 steering 全空且无工具，才看 followUp
    有 fu ? continue 外层 : break
```

**关键结论**：steering 队列整体优先于 followUp 队列。只要 steering 还有货，followUp 永远不会被消费，哪怕 followUp 是先发的。

## 二、交错 steer/followUp 的处理

假设在 agent 跑第一个工具时快速连发：steer(A) → followUp(B) → steer(C) → followUp(D)

队列状态：`steeringQueue = [A, C]`（FIFO，按入队顺序），`followUpQueue = [B, D]`。

### 默认 one-at-a-time 模式（agent.ts:212-213 默认值）

```
turn1: 工具跑完 → drain steering → [A] → 注入 → LLM(A)     ← A 生效
turn2: 工具跑完 → drain steering → [C] → 注入 → LLM(C)     ← C 生效
turn3: 无工具，steering 空 → 退出内层
       drain followUp → [B] → 注入 → LLM(B)                ← B 生效
turn4: drain followUp → [D] → 注入 → LLM(D)                ← D 生效
       全空 → agent_end
```

实际生效顺序：**A → C → B → D**。不是输入顺序 A→B→C→D，也不是 A→C→D→B。因为：
- 队列内严格 FIFO（A 先于 C，B 先于 D）
- 队列间 steering 整体插队（A、C 都在 B、D 前）

每条消息触发独立的一次 LLM 调用，所以是 4 次 LLM round-trip。

### all 模式（`set_steering_mode("all")` / `set_follow_up_mode("all")`）

`PendingMessageQueue.drain()` 一次性吐出全部（agent.ts:132-137）：turn1 工具完 → drain steering → [A, C] → 注入两条 user msg → 一次 LLM 调用；无工具退出 → drain followUp → [B, D] → 一次 LLM 调用 → agent_end。共 2 次 round-trip。多条消息在同一次 LLM 调用里作为连续的 user message 出现（agent-loop.ts:182-190 的 for 循环逐条 emit + push）。

### 中途又来 steer

turn2 跑 C 时又发 steer(E)：turn2 工具完 → drain steering → [E] → LLM(E)，E 插在 B、D 前面。steer 永远能插到所有未消费的 followUp 前，无论 followUp 等了多久。这是 steer 和 followUp 最本质的语义差：**steer 是「插队」，followUp 是「排队等关门」**。

## 三、撤回逻辑：只能全清，不能逐条

pi 当前的一个设计限制，TUI 和 RPC 都一样。

### TUI（interactive-mode.ts:3485-3770）

`app.message.dequeue` 快捷键 → `handleDequeue()` → `restoreQueuedMessagesToEditor()`：

```ts
// interactive-mode.ts:3750-3761
private restoreQueuedMessagesToEditor(options?) {
    const { steering, followUp } = this.clearAllQueues();  // ← 一次性全清
    const allQueued = [...steering, ...followUp];
    if (allQueued.length === 0) return 0;
    const queuedText = allQueued.join("\n\n");
    // ... 合并进编辑器
}
```

`clearAllQueues()` → `session.clearQueue()`（agent-session.ts:1381-1389）把两个镜像数组全置空 + `agent.clearAllQueues()`（agent.ts:284-287）把两个真实队列也清空。

行为：
- ✅ 把所有未消费的 steer + followUp 合并成一段文本塞回编辑器供修改
- ❌ 不能只撤最后一条。没有 `popSteering()` / `removeLastFollowUp()` 这种 API
- ❌ 已被 drain 的无法撤回。一条消息一旦进了 LLM 上下文（message_start 触发后），它就是历史，撤不回来
- ⚠️ `restoreQueuedMessagesToEditor({ abort: true })` 在 Esc 中断时也会触发（interactive-mode.ts:1513, 1667, 2407），所以按 Esc 会顺便把队列全倒回编辑器

### 为什么不能逐条撤回

Session 层的镜像数组 `_steeringMessages` / `_followUpMessages` 是 `string[]`，技术上完全支持 `splice(index, 1)`，但：
1. SDK 只暴露了 `clearQueue()`（全清）和 `getSteeringMessages()` / `getFollowUpMessages()`（只读），没有单条删除 API
2. Agent 层的 PendingMessageQueue 更封闭——`messages` 是 private，只有 `enqueue` / `drain` / `clear`，连按索引删都没有

要实现逐条撤回，需扩展 SDK：PendingMessageQueue 加 `removeAt(index)` 或 `popLast()`，AgentSession 加 `removeLastSteering()` 等，并同步两份镜像。目前没有这个能力。

## 四、RPC 支持矩阵

| 能力 | RPC 命令 | 状态 | 源码 |
|---|---|---|---|
| 发 steer | `{type:"steer", message}` | ✅ | rpc-mode.ts:414-416 |
| 发 followUp | `{type:"follow_up", message}` | ✅ | rpc-mode.ts:418-421 |
| prompt + 行为指定 | `{type:"prompt", streamingBehavior}` | ✅ | rpc-mode.ts:393-411 |
| 中断 | `{type:"abort"}` | ✅ | rpc-mode.ts:423-426 |
| 改队列模式 | `set_steering_mode` / `set_follow_up_mode` | ✅ | rpc-mode.ts:508-513 |
| 队列实时状态（事件推送） | `queue_update` 事件 | ✅ | agent-session.ts:466 → rpc-mode.ts:354-356 直接 output(event) |
| 队列计数（轮询） | `get_state` → `pendingMessageCount` | ✅ | rpc-types.ts:98 |
| 清空队列 | — | ❌ 无此命令 | grep clearQueue in rpc 无结果 |
| 撤回/恢复到编辑器 | — | ❌ 无此命令 | dequeue 是 TUI 专属 |
| 队列内容数组（轮询） | — | ❌ 只有 count，数组要走事件 | RpcSessionState 无 steering/followUp 字段 |

**结论**：RPC 能发 steer/followUp、能收 `queue_update` 事件拿到完整数组内容，但没有原生的「撤回/清空队列」命令。

## 五、Use Case 完整分析

**UC-1 发完 steer 想改内容**：只能和所有其他队列消息一起全清回编辑器改。操作：按 `app.message.dequeue`（TUI）→ 改 → 重新发。代价：其他还没消费的 steer/followUp 也被倒出来了，要重新决定每条的去向。

**UC-2 发完 followUp 想升级成 steer（让它早点生效）**：❌ 不能直接改类型。队列类型在入队时就定了。绕法：dequeue 全清 → 把那条用 Enter（steer）重发，其余按需。

**UC-3 交错发了多条，想调整顺序**：❌ 不能单条移动。队列内严格 FIFO。绕法：dequeue 全清 → 按想要的顺序重发。

**UC-4 steer 已经生效了（LLM 已经读到），想撤回**：❌ 完全不能。已经进 messages 数组和 LLM 上下文。唯一办法：abort + 用 `/fork` 从更早的 entry 分叉（rpc-types.ts:32 的 fork 命令），或新建 session 重来。

**UC-5 agent 正在跑长工具（5 分钟 bash），想插话**：steer 能入队，但要等这个工具跑完才生效（工具执行不可中断，agent-loop.ts:208 的 `executeToolCalls` 是 await 的）。想立刻停：只能 abort（Esc），abort 会中断工具 + 整个 run，不是「插话」是「喊停」。

**UC-6 agent 快结束了，想让它干完接着干下一件**：用 followUp：agent 自然结束 → drain followUp → 自动续一轮。vs 直接等结束再 prompt：followUp 不用等 agent_end 事件往返，时序上更紧凑；但语义上等价。

**UC-7 RPC 客户端想做「草稿箱」（先攒着，确认了再发）**：可行：客户端本地维护草稿，`queue_update` 事件同步服务端队列状态做对账。撤回已入队的：❌ 服务端无 API。只能 abort + 重发。

**UC-8 一条消息想让 LLM 一次性看到多条 user input（而非分多轮）**：用 all 模式：`set_steering_mode("all")` → 多条 steer 合并成一次 LLM 调用的连续 user message。默认 one-at-a-time：每条单独一轮 LLM，token 开销大但每条都能得到独立响应。

## 六、abort 后队列会丢吗？—— 不会丢，而且会「复活」

abort 不清队列，反而会让残留的 steer 在下次发消息时自动注入，这通常不是想要的。

### 源码证据链

1. **abort 不碰队列**。`session.abort()`（agent-session.ts:1413-1416）只做两件事：

```ts
async abort(): Promise<void> {
    this.abortRetry();
    this.agent.abort();        // ← 只 abort，不 clearQueues
    await this.agent.waitForIdle();
}
```

`agent.abort()`（agent.ts:300-302）更简单：`abortController.abort()`，只置 abort 标志。对比 `clearQueue()`（agent-session.ts:1381-1389）——它才会调 `agent.clearAllQueues()`。abort 和 clearQueue 是两个完全独立的操作。

2. **abort 后残留队列会被下次 prompt「捡起来」**。abort 让 loop 在 agent-loop.ts:196 命中 `stopReason === "aborted"` → 直接 return，跳过了 drain 逻辑（253/257 行）。所以队列里的消息原封不动留着。然后发新消息时，`session.prompt()` 走非 streaming 分支（abort 后 isStreaming=false），调 `agent.prompt()` → `runAgentLoop` → `runLoop`。而 runLoop 第一行（agent-loop.ts:167）：

```ts
let pendingMessages = (await config.getSteeringMessages?.()) || [];  // ← 残留的 steer 在这被 drain
```

### 实际时序（abort + 重发的陷阱）

```
发 steer(A)    → steeringQueue=[A]，发 queue_update(steering:[A])
发 followUp(B) → followUpQueue=[B]，发 queue_update(followUp:[B])
发 abort       → loop 退出，队列不变：steeringQueue=[A], followUpQueue=[B]
发 prompt(C)   → isStreaming=false，走非 streaming 分支
               → agent.prompt([C]) → runLoop
               → 开头 drain steering → pendingMessages=[A]
               → 注入 A 和 C 一起发给 LLM！
```

结果：以为只发了 C，实际 LLM 收到的是 A（之前 abort 掉的 steer）+ C。**A 被悄悄「复活」了**。followUp 的 B 要等 A+C 这轮跑完且无工具时才被注入。这几乎肯定不是想要的——abort 就是想作废之前的输入。

## 七、queue_update 事件的具体用法

### 事件结构（agent-session.ts:131-135）

```ts
{
    type: "queue_update";
    steering: readonly string[];   // 当前所有未消费的 steer 文本，FIFO 顺序
    followUp: readonly string[];   // 当前所有未消费的 followUp 文本，FIFO 顺序
}
```

### 触发时机（共 5 个点，`_emitQueueUpdate` 的全部调用）

| 行号 | 触发时机 | 队列变化 |
|---|---|---|
| 1245 | 入队 steer（`_queueSteer`） | steering 多一条 |
| 1262 | 入队 followUp（`_queueFollowUp`） | followUp 多一条 |
| 487 | steer 被消费（message_start 且在 steering 镜像里命中） | steering 少一条 |
| 493 | followUp 被消费（同上，查 followUp 镜像） | followUp 少一条 |
| 1387 | clearQueue() 全清 | 两个都变空 |

入队、出队（被消费）、清空，三个时机都有事件。客户端只靠这一个事件就能维护一份和服务端完全同步的队列镜像，不用轮询。

### RPC 客户端的正确用法

RPC 模式下，rpc-mode.ts:354-356 把所有 AgentSessionEvent 直接 `output(event)` 推给客户端。客户端这样接：

```ts
let localSteering: string[] = [];
let localFollowUp: string[] = [];
client.onEvent((event) => {
    if (event.type === "queue_update") {
        localSteering = [...event.steering];   // 全量覆盖，不用算 diff
        localFollowUp = [...event.followUp];
    }
});
```

**陷阱**：abort 不发 `queue_update`（abort 不改队列）。所以只能依赖入队时收到的最后一个 `queue_update` 快照。如果 abort 后服务端队列被外部清了（目前 RPC 做不到，但 TUI 的 dequeue 会），本地镜像就过期。要绝对准确，需要加 `get_queued_messages` 轮询命令。

## 八、能力边界结论

| 问题 | 答案 |
|---|---|
| RPC 能提交 steer + followUp 吗 | ✅ 能，`{type:"steer"}` 和 `{type:"follow_up"}` |
| abort 后队列丢吗 | ❌ 不丢，原样保留在服务端 |
| 重新发消息后旧队列怎样 | ⚠️ 会被自动注入（steering 在下次 loop 开头 drain），发的 C 会和残留的 A 一起进 LLM |
| 客户端没存草稿能找回吗 | ⚠️ 靠 `queue_update` 事件能拿到完整文本，但前提是入队时还在监听。abort 后想查当前队列，没有 RPC 命令可查（get_state 只给 count 不给内容） |
| 能清掉残留队列吗 | ❌ RPC 无此命令。必须扩展 RpcCommand 加 `clear_queue` |
| queue_update 怎么用 | 监听它，用 steering/followUp 数组全量覆盖本地镜像即可，入队/出队/清空都会触发 |

**核心结论**：abort + 重发场景在 RPC 下会静默复活之前的 steer，这是真实的可用性问题。根因是 RPC 缺 `clear_queue` 命令，且 abort 和 clearQueue 被设计成独立操作。要做可靠的草稿管理，必须扩展 RPC 协议加 `clear_queue`（以及建议加 `get_queued_messages`），否则单靠客户端无法保证一致性。

## 九、对 composer 设计的影响（决策记录）

基于上述能力边界，composer 的 steer/followUp 队列设计结论：

### 当前版本决定（2026-06）

1. **队列只读展示，不做写操作**。待生效队列（steering / followUp）在 RPC 下只能入队 + 可见，无法清除/撤回/改类型。composer 不提供 dequeue / 编辑 / 删除按钮——避免假按钮（点了服务端队列清不掉，反而误导）。
2. **入队后不可修改**。底层无单条撤回 API（PendingMessageQueue 无 `removeAt`），UI 不暴露任何入队后的修改入口。已 drain 进 LLM 的消息完全不可撤回。
3. **快捷键统一 Alt+Enter**。steer = `Enter`（追加当前回合），followUp = `Alt+Enter`（回合后开新轮）。仅在 AI 执行中（S6）触发；非执行中两键均为普通发送。
4. **双队列分栏视图**。订阅 `queue_update` 维护本地镜像，分组展示 steering（先生效）/ followUp（后生效），忠实反映底层 A→C→B→D 的真实生效顺序，不用单 FIFO 掩盖 steer 插队语义。

### 暂不实现（依赖后端扩展）

- **立刻打断提交**（abort + 转普通 prompt + 清队列）：abort 不清队列会静默复活 steer，在 RPC 无 `clear_queue` 前无法可靠实现「停掉重发」。
- **逐条撤回**：依赖 PendingMessageQueue 加 `removeAt` / AgentSession 加 `removeLastSteering`。
- **all 模式 toggle**：默认隐藏，作为高级设置项（省 token 但无逐条响应）。

### 后端 TODO（composer 能力上限的依赖）

1. RPC 协议扩展 `clear_queue` 命令 → rpc-mode.ts 调 `session.clearQueue()`
2. 建议**同时**加 `get_queued_messages`（轮询查完整内容，弥补 abort 不发 queue_update 的快照过期问题）
3. PendingMessageQueue 加 `removeAt(index)` → AgentSession 加 `removeLastSteering()` 等 → 才能做真正的逐条撤回
