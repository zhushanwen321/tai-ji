# chat 域 — 架构决策记录

`store.ts`（chat store factory，IF1 契约）的设计决策记录。`store.ts` 内仅保留与代码
行为直接绑定的短契约注释；本文件记录范式选择、响应式策略、流式块类型、收口出口
设计等「为什么这么写」的决策依据。

## factory 模式（IF1 契约）

core 不绑 pinia store id（平台无关，pinia store 注册是 shell 关切），暴露 `createChatStore()`
factory（无参）返回 store 对象（state + actions）。renderer 经 `defineStore('chat', () => createChatStore())`
薄包装注册到 pinia。core factory 主体零 renderer 跨域 import（grep 验证，TC3）。

core 单测在 `effectScope` 内直接调 `createChatStore` 验证 factory 产物（不经 pinia）。factory
内部用 `onScopeDispose`（清 timer），调用方需在 effectScope 上下文内执行。

## per-session 分区范式（ADR-0049）

per-session 分区保持 `ref(Map<sessionId, T>)`。ADR-0049 把「单例 + `Map<sid,T>`」
明确列为 **Map 分区派（SSOT）正确范式**，store 的 `ref(Map)` 正是此范式的 store 层实现。

`useSessionScopedState` 是该范式在 composable 层的便捷封装（需 sidRef），store 服务全量 sid
无 sidRef 可传，故不套用（clarify Q1）。DM1 精神（Map 分区派，非 watch 清理派）由 `ref(Map)` 满足。

## 状态撕裂防护（streaming 派生）

无命令式 `isStreaming` flag，streaming 状态从 message 实体派生：`isGenerating(sid)` computed scan。
`pendingSend` Set 承载跨 session 顺序发送。`finalizeSession` 统一收口出口（所有异常路径的单一收口，非翻 flag）。

streaming 派生用 **per-session 惰性派生缓存** `sessionStreamingFlags`
（`Map<sid, ComputedRef<boolean>>`）——每个 flag 是定义在其 sid 分区 ref
上的 computed，SSOT 仍是消息数组（零 drift，物理不可撕裂），惰性创建（`isGenerating(sid)` 首次
查询才建才算），判定谓词：`m.role === 'assistant' && m.status === 'streaming'`。
A session 的 token 提交只失效 A 的 flag，不触发跨 session 的全 Map 重扫（长对话卡顿放大器）。
**flags Map 与 messages Map 同生共死**：`disposeSession` 与 LRU 驱逐
（`makeLruEvictDeps` 的 deleteMessageKey）删 messages 分区时同步删对应 flag——漏删即慢泄漏。

**bash 不计入 streaming 派生（B1）**：仅扫
`m.role === 'assistant' && m.status === 'streaming'`。`bashStartEffect` 创建的 bash 消息是
`role:'system', status:'streaming'`——纯 bash 执行期间若计入此集合，`isGenerating(sid)===true`
→ `isActive(sid)===true`，用户发普通消息会被错误路由到 steer，Composer isBusy 为真，停止按钮按
assistant abort 动作而非 abortBash，与「bash 不阻塞」核心承诺矛盾。bash 消息生命周期由
`bashResultEffect` / `markBashError` 独立管理（不依赖此 `isGenerating` 派生）。

## 响应式策略

`messages` 是 `shallowRef<Map<sessionId, Message[]>>`（W1）。shallowRef 下 `Map` mutation 不触发
响应式，所有变更走「取出 → 新数组 → set」的不可变更新（经 `commitMessages` helper：新 Map + set +
赋值 `.value`），确保 Vue 对 Map 的集合响应性可靠触发。消除万级深 proxy（每条 Message 的嵌套对象
不再被代理），降低长对话内存与 GC 压力（ADR 0039）。computed 在 shallowRef 下依赖 `messages.value`
的整体替换（commitMessages 已保证），正确重算。

## 流式块类型覆盖（spec §9 G2-006 + draft-message-stream §4 七类块）

- `text`（message_start/text_delta/complete）—— 主流式路径
- `thinking`（thinking_start/thinking_delta/thinking_end）—— 折进 trace
- `tool_call`（tool_call_start/tool_call_end）—— 折进 trace，失败整块红框
- `error`（message.error / message.complete stopReason:error）—— 挂最后 assistant 块

历史 fixture（含 summary 收尾 text / 预置 tool_call）由 `hydrate` 注入，不走流式。

`applyMessageEvent` 是 `message.*` 事件的单一入口（F2 重构：消除 double-dispatch）。
`useChat.ensureStreamSubscription` 收到 `message.*` 后调本方法，不再自己 switch。内部经
`dispatchMessageEvent` 查 effect 注册表（`effects/registry.ts`），执行该 type 的全部副作用：
(a) chunk 状态更新（messages/retryStates/queueStates）+ (b) 终态收口（finalizeSession）。
行为等价：与原 `appendAssistantChunk(applyChunk) + finalizeSession` 串联一致——handler 内先更新
chunk 状态后收口实体。非 `message.*` / 未注册 type no-op（等价原 applyChunk default return）。

## FileChanges 通道（flow-2，ADR-0024 + W11 WP-L3-11）

`message.file_changes` 事件由 runtime event-adapter 解析 pi 工具调用后推送（协议类型见
ADR-0024 D7，待 flow-2 实施时加入 `ServerMessageType` 联合）。数据流处理骨架见
`applyFileChanges()`，类型契约已就绪（F2-1），逻辑 DEFERRED。

## 子域控制器委托

- **handoff（fast-handoff）**：`handingOff` 瞬时态子域控制器，对称 `compactingSessions`。
  `handingOffSessions` ref + per-session 超时兜底 timer 内聚在 `chat-handoff.ts`；store 经
  `createHandoffController()` 组合后原样透出公共 API（isHandingOff/setHandingOff 等），行为与
  原内联实现零变化。设计选择见 `chat-handoff.ts` 顶部注释。
- **changeset（W10，ADR-0024 D5 baseline diff）**：变更集 5 态状态机 + FileChange 合并逻辑
  内聚在 `chat-changeset.ts`；`messages` ref 由本 store 拥有并注入（`applyFileChanges` 据此
  定位目标 assistant message），`changeSetStatuses` ref 由控制器内部独占。设计选择与公共 API
  见 `chat-changeset.ts` 顶部注释。
- **streaming 状态机（B6）**：3 个原模块级状态机编排函数 + 2 个新提取的瞬态清理 helper 内聚
  为 factory（`streaming-state-machine.ts`），本 store 仅委托。
- **timers（D-003/D-007）**：streaming timer 从 `chat-timers.ts` 提取，闭包注入
  `finalizeSession`。
- **LRU（W3 H3）**：驱逐依赖（messages/hydrated 稳定 ref + `isLruExempt` 闭包）在 setup 时构造
  一次复用（`makeLruEvictDeps` 内部又用 getter 延迟读取，无快照陈旧），三个 evict 函数共享，
  避免每次 evict 重建闭包对象。

## 收口出口设计

### finalizeSession — 唯一收口（D-007 真收口非翻 flag）

session 级统一收口：把 streaming/running 实体推到终态 + 清 pendingSend + 清 timer。幂等
（D-010 sealed）：重复调用不报错，sealed 后实体不变。不处理 usage 回填（message.complete
handler 单独 enrichment）。bash 侧独立清理由 bashResultEffect/
markBashError 承载，不应被 assistant 收口误清。`reason` 决定 message.status
+ toolCall.status 终态映射（见 `FinalizeReason`）。

### finalizeAllStreaming / resetTransientStates — 断连兜底全清

`finalizeAllStreaming`（F1 修正 + W3 瞬态全收口）：遍历所有可能持有瞬态态的 session，对每个有
瞬态态的调 `resetTransientStates`。useConnection runtime 重启/失败/断连时调此 helper，确保后台
session 的全部瞬态指示位收口，避免 UI 在断连后永久卡「生成中 / 压缩中 / 重试中 / 队列中」。
遍历范围是 `messages.keys() ∪ occupancy 投影中 compacting 的 sid ∪ retryStates ∪ queueStates` 的并集——不能只
遍历 `messages.keys()`（compacting / retry / queue 可能独立于消息存在，如 session.occupancy 帧直接写 occupancy 投影、
auto_retry_start 只写 retryStates 不写 messages），仅遍历 messages 会漏掉这些 session。

`resetTransientStates`（W3）：一次性清理指定 session 的全部瞬态指示位。背景：断连 / runtime 重启
等异常路径下，compactingSessions / retryStates / queueStates 不再有事件驱动清理（断连意味着
不会再有 session.compacted / auto_retry_end / queue_update 到达），若不主动清则永久残留。与
`finalizeSession` 的关系：finalizeSession 是消息流正常/异常收口（只清 streaming 实体 + pendingSend
+ timer，保留 session 级独立状态如 compacting——compaction 由 session.compacted 事件独立清，
不能被消息收尾误清）；resetTransientStates 是更广的「断连兜底全清」，在 finalizeSession 基础上
额外清 compacting / retry / queue。

### disposeSession — per-session 状态全清（deleteSession 调用，S3）

deleteSession 必须同步清掉 chat store 的 per-session 状态（messages / hydrated / pendingSend /
compactingSessions / retryStates / queueStates / failedHistory / changeSetStatuses），否则频繁
建删 session 后内存单调增长。此函数一次性清理该 session 的所有分区数据 + 取消 timer + 清 LRU
时序记录（R5）。Map ref 不可变写（新 Map + delete + 赋值 `.value`）保证响应式；
`changeSetStatuses` 按 `${sessionId}:` 前缀过滤删除。

## 相关文档

- ADR-0039（shallowRef 内存）、ADR-0041（streaming 派生缓存，已被 W11 D-3 per-session 惰性
  flag 取代）、ADR-0043（Segment[]）、ADR-0049（per-session Map 分区派）、ADR-0024（FileChanges 协议）
- 块处理：`chunk-processor.ts` / `bash-effects.ts` / `streaming-state-machine.ts`
- 子域控制器：`handoff.ts` / `changeset.ts` / `timers.ts` / `lru.ts`
