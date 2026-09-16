/**
 * useChat —— chat 业务编排（P3 chat 域 w5，createUseChat factory，core 平台无关）。
 *
 * [归位] 迁自 renderer composables/features/useChat.ts（563 行）。原样迁移 + deps 注入：
 * api 调用经 ChatApiPort（IF6）；session.* 事件处理经 sessionStore（SessionStoreLike）；
 * toast/t/useCompactQueue 经 UseChatDeps 注入。core 不 import @/api / @/stores / @/composables。
 * renderer composables/features/useChat.ts 改为薄包装（useChat()=createUseChat(rendererDeps)），
 * 20 个消费方零 import 改动（对齐 w4 createChatStore + defineStore wrapper 模式）。
 *
 * 数据流链（plan-frontend §3 UC-2）：
 *   Composer → useChat.send → store.appendUser + api.chat.send
 *            → api.transport.send(ws) → mock 回流 ServerMessage
 *            → api.events.streamSubscribe → store.applyMessageEvent（message.* 单一入口）
 *            → MessageStream 响应式渲染 + useVirtuaFollow.followIfStuck
 *
 * hydrate：首次进入 session 调 api.chat.getHistory 注入历史（含 tool_call/summary），
 * 让 UC-2 切换会话可见块类型丰富度（G2-006）。messages 为 applyEntry reducer 重放投影
 * （W20 D5，详见 hydrateHistory 注释）。
 *
 * abort：调 api.chat.abort（方法存在，中断流转 DEFERRED G-025）。
 */
import type { Segment, ServerMessage } from '@taiji/shared'
import { segmentsToPrompt } from '@taiji/shared'
import {
  subscribeSession,
  clearSubscription,
  invalidateSubscription,
  resetSubscriptionStates,
} from '../../coordination/subscription-state'
import type { ChatStoreInstance } from './store'
import { historyWindowFromReply } from './truncated-window'
import { collectImagesFromMessages, persistImagesNewestFirst, disposeImageCacheForSession } from './image-cache'
import { createMessageCoalescer } from './delta-coalescer'
import { getExecutingBash } from './bash-effects'
import { toErrorMessage } from '../../utils/error-message'
import type { EnsureStreamSubDeps, SessionStoreLike, UseChatDeps } from './use-chat-types'
import type { DeliveryFrameEntry } from './api-port'
import {
  replaceDeliveryProjection,
  captureMorphSegments,
  clearDeliveryProjection,
  resetDeliveryProjectionForTest,
} from './effects/user-delivery'

// 类型契约原样迁 use-chat-types.ts（max-lines 行为保持抽取，纯类型零运行时）；
// re-export 保持既有 import 路径（domain/chat/index.ts 与 __tests__ 经 './useChat'
// 消费）零改动。[u3b] SubmitQueuedEntryDeps 已随 defer flush 退役摘除。
export type {
  CompactQueueEntrySnapshot,
  CompactQueueLike,
  EnsureStreamSubDeps,
  SessionStoreLike,
  UseChatDeps,
} from './use-chat-types'

/**
 * subagent 占位 chip 自动 slug 的进制（base36：0-9a-z）——时间戳编码更紧凑；
 * slug 仅作展示/唯一标识（用户无感自动生成），无需可读性。
 */
const SUBAGENT_SLUG_RADIX = 36

/**
 * 会话级流式订阅表（sessionId → 取消函数）。
 *
 * [HISTORICAL] 为什么不能 per-send 订阅：
 *   原 send() 在 `await chatApi.send()` resolve 后于 finally 里 unsub。但服务端 message.send
 *   在 pi ack（prompt 已接收，非生成完成）即回 message.status{sent}，rpc-client.prompt()
 *   明确「resolves when pi acknowledges receipt (not when generation completes)」。
 *   故 finally 在首个 chunk 到达前就拆订阅 → 流式事件全丢。
 *   改为会话级长订阅：首次 send 时订阅一次，由 message_start/complete/error 驱动 streaming 状态，
 *   不在 ack 时拆订阅。
 *
 * [w5 clarify Q1 / TD2] 保持模块级 Map（不套 useSessionScopedState）：useChat 是「全局 sid
 * 协调器」（所有方法显式接收 sid，无 sidRef），与 core coordination/subscription-state.ts
 * 同模式（ADR-0049 例外：模块级单例 Map + 测试 reset）。useSessionScopedState 契约要求
 * sidRef + reactive 容器，useChat 无 sidRef 且记录的是 unsub 函数（非 reactive 状态），
 * 强行套用破坏消费方签名 + 语义错位（w4 retrospect 教训 #3：handoff 范式要求需结合代码
 * 所在层判断适用性）。
 */
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：会话级流订阅表（ADR-0049 例外：全局 sid 协调器模块级 Map，上方注释已述）
const streamSubscriptions = new Map<string, () => void>()

/**
 * D-2 token 合帧器（W12，perf 07 §3.3.1 (7)）：模块级单例（与 streamSubscriptions 同模式）。
 *
 * 为什么模块级而非 per-subscription 实例：合帧窗口跨 sid 共享同一个 microtask
 * （异 sid 各自独立缓冲 key，互不阻塞），且 dispatch 闭包随消息携带（buffer 记首条的），
 * coalescer 自身不绑定 store 实例——多 fixture/多 store 场景天然安全。
 * 生命周期：enqueue 于 streamSubscribe 回调（下方）、flush(sid) 于 disposeSession（收口兜底）、
 * clear 于 resetChatModuleStateForTest（测试隔离）。
 */
const coalescer = createMessageCoalescer()

// [u4d-truncated-ui] [HISTORICAL] W4/N1 的 historyTruncatedSessions（ref<Set>，尾读截断
// →「加载更多」显隐）已退役：截断事实的 SSOT 迁为 chat store 截断窗口状态（truncated-window.ts，
// truncated/loadedTurns/totalTurnsEstimate 三字段随 u4b session.history 响应写入），布尔显隐
// 由 hasMoreHistory 派生读——同一 truncated 事实不再两处存储。

/**
 * MF-1：manual compact 的 compaction_end 到达标记（per-session）。
 * key 存在 = manual compact() in-flight；value=true = compaction_end 已到达（session.compacted
 * handler 置）。compact() catch 据此区分失败类型：ended=true（compaction 级——pi 已处理，
 * interpreter 经 message.error 进对话流，确定可见）→ 不 toast；ended=false（transport/busy 级——
 * RPC 未达 pi / dispatcher busy 预检拒绝，pi 未发 compaction_end，interpreter 不参与，零反馈）→ toast 兜底。
 * 仅 manual compact() 路径读写 key——auto-compaction 的 compaction_end handler 见 key 不在则跳过（不污染）。
 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：manual compact in-flight 到达标记（流程状态，非 GUI 数据）
const manualCompactionState = new Map<string, boolean>()

/**
 * [session-occupancy-send-closure D2 → 投递所有权内核 u3b 退役] per-session 未决直发记录
 * 已退役：唯一消费方 handleSendRejected（send.rejected handler）随「内核永远不拒绝用户消息」
 * （D5 排队取代拒绝）整体删除。git 可追溯。
 */

/**
 * [簇 A1 / session-dead 第三环 → 投递所有权内核 u3b 退役] defer 队列 flush 失败重投 timer（1s）、
 * 连续失败熔断阈值（N=5）与 per-session 失败计数三件套已整体退役（设计 §3.1 删除面）：重投职责
 * 由内核 backoff + settled 边沿 + 30s watchdog 三路吸收；S1 拒绝检测与 send.rejected 全链退役
 * （内核排队取代拒绝，D5）；renderer 不再持有待投递队列（useCompactQueue 退役归 u3c）。
 * 声明与全部读写点同批删除（零残留死状态），git 可追溯。
 */

/**
 * 重置 useChat 模块级状态（仅供测试隔离）。
 *
 * 清 streamSubscriptions（逐个调 unsub 解除 WS 订阅 + 清 Map）+ resetSubscriptionStates
 * （coordination/subscription-state 模块级 Map）。[u4d] 截断标记已迁 chat store 截断窗口
 * 状态（per-instance，测试各自 createChatStore 无需模块级 reset）。
 *
 * [TD3] handoff「resetChatModuleState 删除（cleanup 取代）」精神兑现：生产路径 session
 * 销毁由 disposeSession（已调 streamSubscriptions.delete + clearSubscription +
 * chat.disposeSession）+ triggerSessionCleanups 编排，本函数仅测试隔离用（与
 * resetSubscriptionStates 同定位）。renderer re-export as resetChatModuleState 保持
 * 旧测试 beforeEach 兼容。
 */
export function resetChatModuleStateForTest(): void {
  // 清空 stream 订阅：逐个调 unsub（解除 WS 订阅）+ 清空 Map
  for (const [, unsub] of streamSubscriptions) {
    try {
      unsub()
    // eslint-disable-next-line taste/no-silent-catch -- 测试隔离用：unsub 失败不应阻断其余订阅清理，仅记录便于诊断
    } catch (e) {
      console.warn('[useChat] stream unsub failed:', e)
    }
  }
  streamSubscriptions.clear()
  // D-2：清 coalescer 待刷缓冲——残留 buffer 会把上一用例 fixture 的 dispatch 闭包
  // （指向已 dispose 的 store）带进下一用例的 microtask flush，跨 fixture 污染。
  coalescer.clear()
  // [u4d] 截断窗口状态随 chat store per-instance，无需模块级 reset
  // MF-1：清 manual compact 标记（测试间不 reset 会泄漏到下一用例）
  manualCompactionState.clear()
  // [投递所有权内核 u3b] 清内核投影 + morph 段（测试间不 reset 会把上一用例的
  // session.delivery 投影带进下一用例的回执/morph 断言）
  resetDeliveryProjectionForTest()
  // wave:renderer-subscribe：重置 MessageBus 订阅状态（subscriptionStates 模块级 Map）。
  // 与 streamSubscriptions 同理——测试间不 reset 会泄漏到下一用例
  //（subscriptionStates 残留 → routeInbound gap 检测误判）。
  resetSubscriptionStates()
}

/**
 * 确保指定 session 已订阅流式事件（幂等：已订阅则 no-op）。
 *
 * 导出供 forkSessionAsk/selectSession/session-stream-sync 复用：这些路径需与正常 send
 * 同样的订阅建立（否则 pi 生成的流式回复被 events.dispatchSession 静默丢弃——无订阅者）。
 * 它们不走 useChat().send：send 内部 try/catch 吞错（仅 toast）会阻断 fork 占位 session
 * 的回滚，且其 busy→steer 路由对新 fork session 不适用。
 *
 * [TD5] deps 参数：ensureStreamSubscription 是模块级函数（非 factory 内），无法闭包拿
 * createUseChat 的 deps，故接收 EnsureStreamSubDeps（chatApi/toast/t 子集）。
 * renderer composables/features/useChat.ts 导出同名包装（coreEnsureStreamSubscription 别名
 * import + 注入 renderer deps），4 复用点零改动。
 */
/**
 * streamSubscribe 回调各分支的独立处理体（按处理阶段提取，主回调只留分发编排）。
 * 各 helper 接收窄化后的具体 ServerMessage（case 守卫窄化随值传递），行为与原内联分支逐字一致。
 */

/**
 * [投递所有权内核 u3b / D7] session.delivery 帧消费（state topic 全量快照，last-value）：
 * ① 投影整体替换（effects/user-delivery 模块级 ref，队列区/气泡 morph 的单一数据源，
 * u3c QueueBubble 单源化消费）；② 乐观气泡 morph 编排——非 direct 车道（steer/queued）的
 * 活跃条目（queued/in-flight/failed）命中有乐观气泡时：气泡移出对话流（truncateFrom）+
 * 原始 segments 捕获（送达回执时按原段按序入流，不降级纯文本）+ dispatching 占位回收。
 * direct 车道气泡保持待确认（送达回执经 message_end ① 标记匹配抵消占位，D7「既有
 * inflightCounts 抵消机制保留服务 direct」）；delivered 条目无 morph 面（其 transcript
 * 权威由 reducer 喂入，回执/快照两侧幂等）。
 *
 * 倒序 morph：多条连发气泡在流内连续尾排，truncateFrom(inclusive) 会截掉其后内容——
 * 从最后一条起逐条截，防前条 morph 误删后条气泡（气泡恒尾排：appendUser 尾插 +
 * morph 即移除，流内不残留中间气泡）。
 */
function handleSessionDelivery(
  sid: string,
  chat: ChatStoreInstance,
  msg: ServerMessage<'session.delivery'>,
): void {
  const entries = msg.payload.entries as DeliveryFrameEntry[]
  replaceDeliveryProjection(sid, entries)
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    // direct → 待确认气泡保持；delivered → transcript 权威已入流（reducer），无 morph 面
    if (entry.lane === 'direct' || entry.state === 'delivered') continue
    const bubble = chat.getMessages(sid).find((m) => m.id === entry.clientUuid)
    if (!bubble || bubble.role !== 'user') continue
    // 乐观气泡移出对话流（气泡 id = clientUuid，appendUser 契约；truncateFrom 幂等：
    // 已 morph/不存在的 id no-op）
    chat.truncateFrom(sid, entry.clientUuid, true)
    // 捕获原始 segments（user 气泡 content 承载 Segment[]——appendUser 契约），供送达
    // 回执按原段入流；宽形态防御（异常帧 content 非数组时包 text 单段，可见性不丢）。
    captureMorphSegments(
      sid,
      entry.clientUuid,
      Array.isArray(bubble.content)
        ? (bubble.content as unknown as Segment[])
        : [{ type: 'text', text: String(bubble.content ?? '') }],
    )
    // morph = 非 direct 车道：无「本条即将触发 message_start」的 dispatching 空窗，
    // 乐观占位立即回收（direct 车道占位仍由 message_start 自动清）
    chat.clearPendingSend(sid)
  }
}

/** subagent.directive：`@` 定向消息的可见气泡信号（composer-symbol-system §3.3.3a
 * live 链路）。runtime event-adapter 在 extension 留痕 custom_message entry 落盘后
 * 广播（message_end 锚定）；同 entry 的 message.customStart 前置帧走 generic 通路
 * （display:false 不可见，U2c 契约），可见气泡由本分支插入——与 reload 侧
 * mapSessionEntries 覆写 display:true 后投影的 Message 逐字段同形态（store.
 * appendSubagentDirective 注释），live ≡ reload（关键规则 9）。
 * [ADR-0049] per-session 隔离：校验 payload.sessionId === 订阅 sid，不匹配丢弃
 * （架构约定 7——消息带 sessionId，非本 session 忽略；per-sid 通道路由下恒等，
 * 显式校验是防御层）。 */
function handleSubagentDirective(
  sid: string,
  chat: ChatStoreInstance,
  msg: ServerMessage<'subagent.directive'>,
): void {
  if (msg.payload.sessionId === sid) {
    chat.appendSubagentDirective(sid, {
      subagentId: msg.payload.subagentId,
      slug: msg.payload.slug,
      direction: msg.payload.direction,
      text: msg.payload.text,
    })
  }
}

/** #6 + M4：compact 生命周期开始（interpreter 从 compaction_start 事件唯一驱动，走 session 通道）。
 * [u5b / D1] membership 已切 occupancy 派生（session.occupancy 帧，见 handleSessionOccupancy）
 * ——本 handler 只保留 reason 文案源维护（手动/自动浮层文案，ActivityStrip.vue 消费；行高常量族
 * 见 message-stream-layout.ts，原 useMessageStreamNotices.ts 于 2026-09-11 改名）。
 * 帧序：interpreter 同一挂点先发 session.compacting 再发 occupancy（event-interpreter
 * handleCompactionStart），reason 就位先于浮层显隐条件成立。 */
function handleSessionCompacting(
  sid: string,
  chat: ChatStoreInstance,
  msg: ServerMessage<'session.compacting'>,
): void {
  chat.setCompactingReason(sid, msg.payload.reason)
}

/** #6：compact 生命周期结束（成功/失败/取消均广播）。清除 reason 文案源（occupancy 的
 * compacting=false 由本事件之后的 session.occupancy 帧驱动）。
 * MF-1：compaction_end 到达标记（供 compact() catch 区分失败类型）。仅 manual compact
 * in-flight 时标记——auto-compaction 的 compaction_end handler 见 key 不在则跳过（不污染）。
 * 成功/失败/aborted 均置 true：只要 compaction_end 到达，说明 pi 已处理 compact，结果（含错误）
 * 由 interpreter 进对话流，catch 不再 toast（避免双提示 / 对 aborted 误提示失败）。
 * [HISTORICAL → u3b 退役] flush 触发源职责已随 defer 队列退役：压缩结束后的投递由内核
 * 对账器/投递通道接管（compaction_end 是 runtime 侧 Reconciler 触发点之一，D3），renderer
 * 不再触发 flush。行为连续性：压缩失败后队列照常投递（消息不丢优先）由内核保证。 */
function handleSessionCompacted(sid: string, chat: ChatStoreInstance): void {
  chat.setCompactingReason(sid, undefined)
  // MF-1：仅 manual compact in-flight 时标记——auto-compaction 的 compaction_end handler
  // 见 key 不在则跳过（不污染）。
  if (manualCompactionState.has(sid)) manualCompactionState.set(sid, true)
}

/** [u5b / D1+D3 → u3b/D7 简化] occupancy 投影消费（state topic：live 广播 + subscribeSession 的
 * stateSnapshot 回放同路径到达——WS 重连 resubscribeAll / 切回 session 时快照恢复，G4）。
 * 写入 chat store 投影分区（sessionPhase 单一数据源；send-route 的 UI 预测消费）。
 * [HISTORICAL → u3b 退役] defer 队列 flush 触发（「全 idle 且队列非空」→ 投递）已随 defer
 * 队列整体退役：投递时机由 runtime 内核驱动（occupancy 边沿是内核 lane 再判定的触发源，
 * renderer 只渲染投影）。本 handler 只保留投影写入。 */
function handleSessionOccupancy(
  sid: string,
  chat: ChatStoreInstance,
  msg: ServerMessage<'session.occupancy'>,
): void {
  chat.setOccupancy(sid, { turn: msg.payload.turn, compacting: msg.payload.compacting, bash: msg.payload.bash })
}

/** pi 改写 session 名（session_info_changed → session.renamed，见 event-adapter.ts）。
 * guard：payload.name 为空时跳过 —— 防 pi 推空名/旧名覆盖用户手动 rename 的值。
 * 用闭包 sid（对称 compacting/compacted handler）：session.* 走 session 级通道
 * (events.on(sid, ...))，payload.sessionId 恒等于订阅 sid，不信任 payload 可能的篡改。 */
function handleSessionRenamed(
  sid: string,
  sessionStore: SessionStoreLike,
  msg: ServerMessage<'session.renamed'>,
): void {
  if (msg.payload.name) {
    sessionStore.applySnapshot(sid, { label: msg.payload.name })
  }
}

/** 模型切换后 runtime 推送（model-service switchModel 末尾广播，含新 modelId/thinkingLevel；
 * usage 已随 D1 协议收敛移出本帧，只经 context.update 一条帧贯穿）。applySnapshot 单 session 快照按 D1b 合并
 * （undefined 字段 = 快照未涉及，不覆盖），不触发整表替换。
 * thinkingLevel optional：未设置时（undefined）不更新，保留旧值。 */
function handleSessionStateChanged(
  sessionStore: SessionStoreLike,
  msg: ServerMessage<'session.state_changed'>,
): void {
  if (msg.payload.sessionId) {
    sessionStore.applySnapshot(msg.payload.sessionId, {
      ...(msg.payload.modelId !== undefined && { modelId: msg.payload.modelId }),
      ...(msg.payload.thinkingLevel !== undefined && { thinkingLevel: msg.payload.thinkingLevel }),
    })
  }
}

/** pi 切模型 / 用户手切档位后推 thinking_level_changed（runtime event-adapter 转为此类型）。
 * 补 state_changed 的时序缺口：switchModel 的 broadcastSessionState 在 set_model RPC resolve 后
 * 立即广播，而 thinking_level_changed 事件可能晚到（异步），此时 state_changed 的 thinkingLevel 为空。
 * 本 handler 独立更新 thinkingLevel，不依赖两条消息的先后顺序。 */
function handleSessionThinkingLevelSet(
  sessionStore: SessionStoreLike,
  msg: ServerMessage<'session.thinkingLevelSet'>,
): void {
  if (msg.payload.sessionId && msg.payload.level) {
    sessionStore.applySnapshot(msg.payload.sessionId, { thinkingLevel: msg.payload.level })
  }
}

/**
 * [crash-resilience T4 回流修复] 恢复窗口过渡态的「新回合开始」收口 gate。
 *
 * 缺陷（Gate B A7 真机）：恢复窗口（respawnPending）内用户发消息 → runtime 侧用户消息
 * 触发的惰性恢复（ensureRestored join）先于 D7 自动恢复 timer 完成 → timer fire 时
 * 「already active/restoring — skip auto respawn」→ session.restored 帧永不发布
 * （restored 只由 attemptRespawn 自身执行的成功路径发布，惰性恢复成功路径不发布）。
 * 前端过渡态原本只等 restored/restoreFailed/30s 超时收口 → 超时后回落 dead 终态页，
 * 而 session 实际已恢复、消息已获回复——用户被迫手动「重新打开」。
 *
 * 收口信号 = 恢复窗口内该 session 的 message.message_start 到达：新 pi 已在处理用户
 * 消息，「恢复完成」事实成立（恢复窗口订阅自 exited 时建立，恢复后的帧必经本 handler）。
 * 执行与 useMessageEffects.handleSessionRestored 同构的收口：清过渡态 + T4 恢复提示条
 * （复用 respawnRestored 文案）+ dead 复位。幂等：restored 帧若仍到达（消息晚于 D7
 * 恢复完成的时序），其 handler 的 isRespawnPending 守卫使二次收口 no-op，不插双条。
 * 30s 超时 timer 到期时分区已清 → no-op 自清，无需跨模块取消。
 */
function consumeRespawnWindowOnTurnStart(
  sid: string,
  chat: ChatStoreInstance,
  sessionStore: SessionStoreLike,
  deps: EnsureStreamSubDeps,
): void {
  if (!chat.isRespawnPending(sid)) return
  chat.clearRespawnPending(sid)
  chat.appendRespawnNotice(sid, 'restored', deps.t('panel.message.respawnRestored'))
  sessionStore.revive(sid)
}

export function ensureStreamSubscription(
  sid: string,
  chat: ChatStoreInstance,
  sessionStore: SessionStoreLike,
  deps: EnsureStreamSubDeps,
): void {
  if (streamSubscriptions.has(sid)) return
  // wave:renderer-subscribe：升级为 subscribe + reconcile（DM4/IF8）。
  // 在 events 订阅之外，额外调 subscribeSession 建立 MessageBus 订阅：RPC 拉 snapshot 回放历史
  // （reconcile）+ 记 lastSeenSeq（routeInbound gap 检测基线）。两者职责分工：
  //   - events.on 订阅 = 消费端入口（message.*/session.* handler，UI 响应）
  //   - subscribeSession = 数据完整性层（seq 去重 + gap 补齐）
  // fire-and-forget（不 await）：ensureStreamSubscription 是同步函数（被 send/sendBash 等同步路径
  // 调用），不能改 async（破坏调用链签名）。subscribeSession 内部 catch 失败 console.warn，
  // 不标记 subscribed（下次可重试）。subscribe RPC 失败属连接级故障，WS 重连后重新建立。
  void subscribeSession(sid).catch((e) =>
    console.warn(`[useChat] subscribeSession failed for session ${sid}:`, e),
  )
  const unsub = deps.chatApi.streamSubscribe(sid, (msg) => {
    // [HISTORICAL → u3b 退役] send.rejected handler 已删除：内核排队取代拒绝（D5——内核
    // FIFO 无界接受，拒绝语义失去存在场景），乐观气泡经 session.delivery 帧 morph/回执
    // 闭环，renderer 不再需要拒绝回滚/兜底入队。
    if (msg.type === 'subagent.directive') {
      handleSubagentDirective(sid, chat, msg)
      return
    }
    // message.* → 单一入口（F2 重构：消除 double-dispatch）。
    // applyMessageEvent 内部经 effect 注册表执行该 type 的全部副作用（chunk 状态更新
    // + finalizeSession 收口），useChat 不再自己 switch message.*。message.* 处理完即 return，
    // 下方 session.* 分支仅处理跨 store 事件（compacting/renamed 等）。
    // [D-2/W12] text/thinking delta 经 coalescer microtask 合帧（同 sid 同 type 保序合并）；
    // 非 delta 消息在 coalescer 内先 flush 该 sid 缓冲再同步 dispatch（终态即时，保序）。
    // 只改 message.* 分发路径，订阅编排（streamSubscriptions/subscribeSession）不动。
    if (msg.type.startsWith('message.')) {
      // [crash-resilience T4 回流修复] 恢复窗口收口 gate（enqueue 前——同步于流式帧处理
      // 之前插 T4 提示条，保证条目在 assistant 气泡之前；非 message_start 帧 no-op）
      if (msg.type === 'message.message_start') {
        consumeRespawnWindowOnTurnStart(sid, chat, sessionStore, deps)
      }
      coalescer.enqueue(sid, msg, (m) => chat.applyMessageEvent(sid, m))
      return
    }
    // session.* → 跨 store 协调（sessionStore.applySnapshot / occupancy 投影），
    // 保留在 useChat（stores 间禁止互相 import）。case 体提取为上方同名 handle* helper。
    switch (msg.type) {
      // [fix-handoff-with-message] session.handoffStarted 不再处理：前端已删除「正在交接…」
      // system notice（改由 composer stop 按钮提供取消入口）。runtime 仍广播此消息，前端忽略即可。
      case 'session.compacting': {
        handleSessionCompacting(sid, chat, msg)
        break
      }
      case 'session.compacted': {
        handleSessionCompacted(sid, chat)
        break
      }
      case 'session.occupancy': {
        handleSessionOccupancy(sid, chat, msg)
        break
      }
      // [投递所有权内核 u3b / D7] 内核条目状态快照：队列区/气泡 morph 的单一数据源
      case 'session.delivery': {
        handleSessionDelivery(sid, chat, msg)
        break
      }
      case 'session.renamed': {
        handleSessionRenamed(sid, sessionStore, msg)
        break
      }
      case 'session.state_changed': {
        handleSessionStateChanged(sessionStore, msg)
        break
      }
      case 'session.thinkingLevelSet': {
        handleSessionThinkingLevelSet(sessionStore, msg)
        break
      }
      default:
        break
    }
  })
  streamSubscriptions.set(sid, unsub)
}


/**
 * [HISTORICAL → 投递所有权内核 u3b 退役] submitQueuedEntry（defer 队列 flush 的逐条提交
 * 入口，u4b/D5.1）已删除：defer 队列状态机整体退役（设计 §3.1 删除面），用户消息统一经
 * delivery.submit 提交（下方 submitNewMessage 编排），lane 判定与逐条投递由 runtime 内核
 * 承担（D1）。出站裸标记附加（簇 A2）随消息出站统一由内核出站侧负责，renderer 不再拼标记。
 * renderer 唯一消费方 useCompactQueue.doFlush 随 u3c 退役。git 可追溯。
 */

/**
 * createUseChat —— chat 业务编排 factory（P3 chat 域 w5；[投递所有权内核 u3b] 发送链
 * 收敛为统一 submit——乐观气泡 + delivery.submit，lane 判定移交 runtime 内核（D1），
 * renderer 不再判定车道也不再做任何时序防御（defer flush/S1/timer/熔断已退役））。
 *
 * [TD1] factory + wrapper 模式（对齐 w4 createChatStore）：core 不绑 renderer 跨域依赖，
 * 全经 UseChatDeps 注入。renderer useChat() 薄包装注入 deps，20 消费方零 churn。
 *
 * @param deps 依赖注入（chatApi/writeSegments/getChatStore/getSessionStore/toast/t）
 * @returns send/steer/followUp/abort/compact/editAndResend/hydrateHistory/loadMoreHistory/
 *          hasMoreHistory/disposeSession/sendBash/abortBash/clearQueueState
 */
export function createUseChat(deps: UseChatDeps) {
  const chat = deps.getChatStore()
  const session = deps.getSessionStore()
  // ensureStreamSubscription 模块级函数所需 deps 子集（TD5）
  const subDeps: EnsureStreamSubDeps = {
    chatApi: deps.chatApi,
    toast: deps.toast,
    t: deps.t,
  }

  /**
   * 统一提交编排器：把 segments 转成 promptText 并经 delivery.submit 提交（u3b/D1）。
   *
   * 调用方负责：appendUser / pendingSend 等乐观状态编排已上提至 submitNewMessage
   * （send/steer/followUp/editAndResend 四通路共享）。submitSegments 只管「文本化 +
   * 提交」核心步骤：
   *   1. segmentsToPrompt（pi prompt 文本，原文保真，image 段产出裸路径）
   *   2. 写 segments.json sidecar（clientUuid 关联，重开时回填 badge）——仅非纯文本消息
   *   3. chatApi.submitDelivery(promptText + clientUuid 标记, clientUuid)——内核出站
   *      裸标记由 runtime 出站侧统一附加（u3b 契约：标记 id = clientUuid 的裸 uuid 形态），
   *      renderer 不再拼投递确认标记（defer 时代的簇 A2 拼标记退役）
   *
   * 图片走路径模式（对齐 pi TUI）：路径已在 promptText 里（segmentsToText 产出裸路径），
   * LLM 自己调 read 工具读（vision/非 vision 模型都能处理）。不传 images base64 字段。
   *
   * @param sessionId           目标 session
   * @param segments            结构化 segments（含 image/file/text/skill/mention）
   * @param clientUuid          appendUser 生成的 user message id（`u-<uuid>`），
   *                            用作 segments.json 主键 + prompt 标记 uuid（建立 clientUuid ↔
   *                            pi userEntryId 映射，extension input hook 剥标记后写 custom
   *                            entry）+ delivery.submit 条目 id（回执/morph/resync 判重锚）
   * @param precomputedPromptText 调用方已算过的 segmentsToPrompt(segments)（非空白——调用方
   *                            !text.trim() 守卫保证）。传入复用避免 submitSegments
   *                            内部再算一遍（S4 修复，热路径去重）。
   */
  async function submitSegments(
    sessionId: string,
    segments: Segment[],
    clientUuid: string,
    precomputedPromptText?: string,
  ): Promise<void> {
    const promptText = precomputedPromptText ?? segmentsToPrompt(segments)
    // 最小写入：纯文本消息（全部 segment 为 text）跳过 sidecar + 标记——重开时 textToSegments
    // 降级与结构化回填渲染等价，只有非纯文本段（image/file/skill/mention/handoff）的 badge
    // 依赖映射回填。谓词对未知新类型默认保留写入（≠ text/slash 即写），失败方向安全。
    // 不变式：sidecar 条目存在 ⟺ 映射 custom entry 存在（两侧同谓词门控）。
    // [D4-d] slash 段（命令 chip）计入纯文本——无 badge 还原需求：UserBubble 已按归位序把
    // slash 段渲染为 `/name` 纯文本，与 reload 侧 textToSegments(归位文本) 同形（live ≡ reload），
    // 故不为此引入 sidecar 写入。本处谓词同时门控 sidecar 写入与 custom entry 标记
    //（[HISTORICAL] defer 重放路径 submitQueuedEntry 的同款谓词已随其退役）。
    const needsBackfill = segments.some((s) => s.type !== 'text' && s.type !== 'slash')
    // 写 segments.json sidecar（重开 session 时回填 image/file badge 用）。
    // 异步 fire-and-forget：失败 console.warn 不阻断（sidecar 丢失只是降级为占位文本，非硬错误）。
    // landing 态 session 尚未创建时（sessionId 为占位）不写——submitFirstMessage 在 session.create 后
    // 调 chat.send，send 内部 appendUser 用已创建的 newSid，故 submitSegments 收到的 sessionId 恒有效。
    if (needsBackfill && sessionId) {
      deps
        .writeSegments({
          sessionId,
          entry: { clientUuid, segments, timestamp: Date.now() },
        })
        .catch((e) => console.warn('[useChat] writeSegments failed:', e))
    }
    // 加 HTML 注释标记：pi extension 的 input hook 会剥离它（LLM 看不到），并建立
    // clientUuid ↔ userEntryId 映射（重开时按映射回填 segments）。纯文本轮不拼标记，
    // extension input hook 见不到标记即不写映射 custom entry（自然 no-op）。
    // 标记格式严格：`<!--taiji:msg:<uuid>-->`，uuid 是 clientUuid 完整值（u-<uuid>），
    // 与 extension TAG 正则（u-[0-9a-fA-F-]{36}）+ segments.json clientUuid key 严格一致。
    // [u3b] 本标记只服务 msg-id-mapper 映射回填（D8：与内核出站裸标记双标记共存，已登记）；
    // 投递身份的裸标记由内核出站侧统一附加。
    const markedPromptText = needsBackfill ? `${promptText}\n<!--taiji:msg:${clientUuid}-->` : promptText
    // 图片走路径模式（对齐 pi TUI）：路径已在 promptText 里（segmentsToText 产出裸路径），
    // LLM 自己调 read 工具读。不传 images base64 字段。
    // [u3b/D1] 统一提交：chatApi.send → chatApi.submitDelivery——lane 判定移交 runtime 内核，
    // reply 仅受理确认，权威状态演进经 session.delivery 状态帧（handleSessionDelivery 消费）。
    await deps.chatApi.submitDelivery(sessionId, markedPromptText, clientUuid)
  }

  /**
   * [投递所有权内核 u3b / D1+D7] 统一提交编排：appendUser 乐观气泡 → inflight 占位 →
   * ensureStreamSubscription → dispatching 占位 → submitSegments（delivery.submit）。
   * send / steer / followUp / editAndResend 四通路共享；lane 由 runtime 内核判定，失败
   * 回滚乐观副作用后原样上抛，由通路各自分型（send toast 不 throw / steer 转 false）。
   *
   * 返回 clientUuid（= 乐观气泡 id = 内核条目 id），供调用方断言/对账。
   */
  async function submitNewMessage(sid: string, segments: Segment[], promptText: string): Promise<string> {
    // appendUser 返回生成的 user message id（u-<uuid>），作为 clientUuid 传给 submitSegments
    // （写 segments.json sidecar + prompt 标记，建立 clientUuid ↔ pi userEntryId 映射）+
    // delivery.submit 条目 id（session.delivery 帧 / 送达回执标记 / morph 的身份锚）。
    const clientUuid = chat.appendUser(sid, segments)
    // 乐观气泡占位：其送达回执（message_end(user) ① 标记匹配）到达时抵消，防重复入流；
    // RPC 失败路径回滚（下方 catch）。[D7] direct 车道抵消机制保留。
    chat.incrementInflight(sid, 1)
    ensureStreamSubscription(sid, chat, session, subDeps)
    // dispatching 空窗占位（填 isGenerating 空窗，让停止按钮/输入可用性立即翻转）：
    // message_start 到达自动清；非 direct 车道由 session.delivery 帧的 morph 编排回收。
    chat.addPendingSend(sid)
    try {
      // S4：复用调用方算过的 promptText，避免 submitSegments 内部再调一次 segmentsToPrompt。
      await submitSegments(sid, segments, clientUuid, promptText)
    } catch (e) {
      // RPC 失败回滚（三件套）：pi/内核侧无消息、送达回执永不到来——
      // ① 乐观气泡移除（[u3b] 前身靠 send.rejected 兜底回滚，内核化后无拒绝帧，必须在
      //    此回滚，否则气泡永久悬挂）；truncateFrom 幂等（id 不存在 no-op）；
      // ② dispatching 占位回收；③ inflight 占位回收。
      // 错误反馈由通路 catch 分型（toast 或转 false），本函数不吞。
      chat.truncateFrom(sid, clientUuid, true)
      chat.clearPendingSend(sid)
      chat.decrementInflight(sid, 1)
      throw e
    }
    return clientUuid
  }

  /**
   * 发送消息：统一 submit（乐观气泡 + delivery.submit）。
   *
   * 流式状态由会话级订阅的事件驱动（message_start→true，complete/error→false），
   * 不依赖 submit 的 resolve 时机——避免 ack 早于首个 chunk 导致订阅被提前拆除。
   *
   * [u3b/D1] B 策略（busy→steer 本地判定）退役：busy 期发送不再本地转车道，统一乐观气泡
   * + delivery.submit——lane 判定移交 runtime 内核（queued/steer 车道气泡经 session.delivery
   * 帧 morph 为队列条目，D7）。
   *
   * 显式接收 sessionId：双 panel 下 Composer 各自有独立 sessionId（panel leaf 绑定），
   * send 目标由调用方传入，不读全局 session.activeId（否则 standby panel 发消息会串到 active panel）。
   */
  async function send(sessionId: string, segments: Segment[]): Promise<void> {
    const sid = sessionId
    if (segments.length === 0) return
    // `@` 定向分流（composer-symbol-system §3.3.4/§3.3.7）：含 subagent 段的消息改走
    // session.subagentAction RPC，不经 message.send 主 agent 通道（结构性保证无主 agent
    // turn，§3.3.8 命题 1）。分流点必须在下方两道 guard 之前：
    // - promptText 空 guard：subagent 段序列化为空串（路由标记），纯 chip 无文本时
    //   promptText 为空会被静默 return——定向路径要求「空文本给可读错误」（不静默丢）；
    // - isActive/steer：定向消息与主 agent turn 正交（extension 命令短路，不抢占 LLM
    //   回合），busy 时不应转 steer 队列。
    const subagentSeg = segments.find(
      (s): s is Extract<Segment, { type: 'subagent' }> => s.type === 'subagent',
    )
    if (subagentSeg) {
      await sendSubagentDirective(sid, segments, subagentSeg)
      return
    }
    const promptText = segmentsToPrompt(segments)
    if (!promptText.trim()) return

    // [u3b/D1] 统一 submit：乐观气泡 + delivery.submit（失败 toast 不 throw——错误已消化，
    // 消费侧 Composer.onSend 的 catch 不再触发；throw 只会变 unhandled rejection）。
    try {
      await submitNewMessage(sid, segments, promptText)
    } catch (e) {
      const msg = toErrorMessage(e)
      deps.toast.error(deps.t('composable.sendFailed', { msg }))
    }
  }

  /**
   * `@` 定向消息发送（send 的分流终点，composer-symbol-system §3.3.4）。
   *
   * 与普通 send 的行为差异（均有结构性理由，非省略）：
   * - 不 appendUser：pi 侧只落 extension 留痕的 subagent-directive custom entry（无 user
   *   entry，§3.3.7）。若 live 时插 user 气泡，重开 session 后 reload 链路只重建定向
   *   custom 消息——user 气泡消失，违反 live ≡ reload（关键规则 9）。可见气泡统一由
   *   subagent.directive 广播驱动的 store.appendSubagentDirective 产出。
   * - 不 addPendingSend：pendingSend 等 message_start 清（主 agent turn 信号），定向消息
   *   无主 agent turn（不消耗），置位会永久卡 isGenerating。
   * - 不写 segments.json sidecar：sidecar 的消费方是重开时按 clientUuid↔userEntryId 映射
   *   回填 user badge；定向消息无 user entry，条目必然孤立（无消费方），不写。
   * - ensureStreamSubscription 照做：subagent.directive 广播（插定向气泡）与
   *   message.customStart（extension 留痕 entry 的 generic 帧）都走会话级订阅。
   *
   * 错误处理对齐 send 的 catch 模式：toast + 不 throw（throw 只会变 unhandled rejection，
   * 消费侧 Composer.onSend 的 catch 不触发——错误已通过 toast 消化，消息不静默丢失）。
   *
   * @param sid 目标 session
   * @param segments 原始 segments（text/file/session/image 段照常序列化进定向文本——
   *                 定向消息也可以引用文件/session，§3.3.7「+ 普通 segments」）
   * @param subagentSeg 分流命中的 subagent 段（send 已保证存在）
   */
  async function sendSubagentDirective(
    sid: string,
    segments: Segment[],
    subagentSeg: Extract<Segment, { type: 'subagent' }>,
  ): Promise<void> {
    // subagent 段序列化为空串（shared/segments 路由标记），segmentsToPrompt 即
    // 其余段序列化：file → path(:L 范围)、session → #sessionId、image → 裸路径。
    const text = segmentsToPrompt(segments)
    // 空文本挡：纯 chip（或仅空白文本）时 text 为空白串，extension 无从处理——
    // 可读错误 + 不发 RPC（防御：上游 canSend 守卫通常已拦，此处兜底保证不静默）。
    // trim 判断必须显式：segmentsToPrompt 已去 trim 保真（Gate B 观测①修复），
    // 纯空白文本若不在此拦会直发 RPC。
    if (!text.trim()) {
      deps.toast.error(deps.t('composable.subagentDirectiveEmpty'))
      return
    }
    ensureStreamSubscription(sid, chat, session, subDeps)
    try {
      if (subagentSeg.subagentId) {
        // 已开 subagent 追问（§3.1.3 场景 1）：message 定向，subagentId 是浮层选中 record id
        await deps.chatApi.subagentAction(sid, 'message', {
          subagentId: subagentSeg.subagentId,
          text,
        })
      } else {
        // 新建占位 chip（§3.1.3 场景 2）：subagentId 空串。slug 自动生成（用户无感）——
        // chip 上的 slug 可能是 U2a 的 i18n 占位文案（如「新任务」），是展示占位不可作 id，
        // 一律用自动 slug 覆盖。
        const slug = 'chat-' + Date.now().toString(SUBAGENT_SLUG_RADIX)
        await deps.chatApi.subagentAction(sid, 'start', { slug, task: text })
      }
    } catch (e) {
      // RPC 失败（WS 断连 / extension 报「subagent 已结束」等）：toast 明确提示，
      // 消息不静默丢失（S8：留在输入区或明确失败提示——此处为后者，与 send 失败同款）。
      const msg = toErrorMessage(e)
      deps.toast.error(deps.t('composable.subagentDirectiveFailed', { msg }))
    }
  }

  /**
   * 追加 steer（AI 执行中补充消息）——[u3b/D1] 统一 submit 化。
   *
   * 旧实现（message.steer 直发 + pendingBuffer 暂存）已退役：lane 判定移交 runtime 内核，
   * 本方法与 send 同走乐观气泡 + delivery.submit（内核判 steer 车道 → 气泡 morph 队列条目），
   * pendingBuffer 计数腿不再存在。
   *
   * [D2] 返回值契约保持（Promise<boolean>）：true = 提交成功或无事发生（早退路径无投递
   * 动作、无错误，调用方无需恢复草稿）；false = RPC 失败（内部已 toast + 回滚乐观副作用，
   * 不 throw）——调用方（composer/submit.ts onSteer）据 false 恢复草稿（restoreSegments），
   * 否则 clearInput 已清空的输入静默丢失。
   *
   * 显式接收 sessionId：与 send 同理，per-panel 隔离，不读全局 activeId。
   */
  async function steer(sessionId: string, segments: Segment[]): Promise<boolean> {
    const sid = sessionId
    if (segments.length === 0) return true
    const promptText = segmentsToPrompt(segments)
    if (!promptText.trim() || !chat.isActive(sid)) return true

    try {
      await submitNewMessage(sid, segments, promptText)
      return true
    } catch (e) {
      const msg = toErrorMessage(e)
      deps.toast.error(deps.t('composable.supplementSendFailed', { msg }))
      return false
    }
  }

  /**
   * 追加 follow-up——[u3b/D1] 统一 submit 化（同 steer：内核 queued 车道承接「当前回合
   * 结束后另起一轮」语义，pendingBuffer 暂存退役）。
   * 非执行中按普通发送处理（避免 Alt+⏎ 死键）。
   *
   * 显式接收 sessionId：与 send 同理，per-panel 隔离。
   */
  async function followUp(sessionId: string, segments: Segment[]): Promise<void> {
    const sid = sessionId
    if (segments.length === 0) return
    const promptText = segmentsToPrompt(segments)
    if (!promptText.trim()) return

    // 非活跃（含空窗期）退化为普通发送，避免 Alt+⏎ 死键
    if (!chat.isActive(sid)) {
      await send(sid, segments)
      return
    }

    try {
      await submitNewMessage(sid, segments, promptText)
    } catch (e) {
      const msg = toErrorMessage(e)
      deps.toast.error(deps.t('composable.nextTurnSendFailed', { msg }))
    }
  }

  /**
   * 中断当前回合（G-025 流转 DEFERRED：方法存在，实际中断留联调）。
   * [W3/W4] abort 乐观清 dispatching——abort 语义就是「结束当前活跃态」，即便 pi 没真正停也无害。
   * 正常成功路径由 MessageDispatcher.abort 广播的 message.complete 驱动 finalizeSession 收口；
   * 失败路径（pi 死/getClientOrThrow 抛 handler_error → abort reject）若无此 catch，dispatching 永挂。
   *
   * 显式接收 sessionId：per-panel 隔离，不读全局 activeId。
   */
  async function abort(sessionId: string): Promise<void> {
    const sid = sessionId
    // [D-008] 乐观清 pendingSend（即便 pi 没真正停也无害）
    chat.clearPendingSend(sid)
    try {
      await deps.chatApi.abort(sid)
    } catch (e) {
      // abort 失败不重抛——用户已表达「停止」意图，UI 不应因 abort RPC 失败而卡住。
      // pendingSend 已清（乐观），实体收口靠 runtime 广播 message.complete{aborted} 兜底。
      const msg = toErrorMessage(e)
      deps.toast.error(deps.t('composable.stopFailed', { msg }))
    }
  }

  /**
   * 直接执行 bash 命令（composer-bash-execute，不经 LLM turn）。
   *
   * `!`/`!!` 前缀的 shell 文本原样透传，不走 segment 提取 / segmentsToPrompt / appendUser。
   * bash 不阻塞 active 态：与 AI turn 正交（pi bash RPC 独立执行，不抢占 LLM 回合）。
   * 实时反馈 + 结果由 message.bashStart / message.bashResult 广播驱动（runtime 负责，经
   * 会话级订阅的 applyMessageEvent 消费），故此处仅确保订阅存在 + 发 RPC。
   *
   * 错误处理与 abort/compact 对齐：toast + 不 throw（消费侧 Composer.onSend 已有 try/catch，
   * throw 只会变 unhandled rejection）。
   *
   * 显式接收 sessionId：per-panel 隔离，不读全局 activeId。
   */
  async function sendBash(sessionId: string, command: string, excludeFromContext: boolean): Promise<void> {
    const sid = sessionId
    ensureStreamSubscription(sid, chat, session, subDeps)
    try {
      await deps.chatApi.bash(sid, command, excludeFromContext)
    } catch (e) {
      // [①b timeout-slow-flow-wallclock D2/r4 极性修正] RPC 错误 reject（error envelope /
      // backstop 超时）与 bashResult 合成终态帧的到达时序：runtime 先广播终态帧再回 error
      // envelope，本 catch 执行时终态帧已被 bashResultEffect 消费。executingBash 是「命令
      // 执行中」瞬时态（bashStart 置 / bashResult·markBashError 清），「已收合成终态」=
      // 查询为空（取反）——为空 → 气泡已呈现终态（超时三步指引或错误输出），它是权威
      // 呈现面，再弹「失败」措辞 toast 冗余且误导（如超时后命令仍在跑，toast 却说 failed），
      // 抑制；非空（命令仍在执行 = env 逃生门下 renderer backstop 先到的形态）→ toast 是
      // 唯一提示，不抑制。与 compact 先例极性相反：manualCompactionState 是正向标志（终态
      // 到达置 true），此处是反向标志（终态到达清空）——「查到非空」绝不抑制。
      if (!getExecutingBash(sid)) {
        console.warn(`[useChat] sendBash RPC failed after terminal frame already rendered, toast suppressed, sid=${sid}`, e)
        return
      }
      const msg = toErrorMessage(e)
      deps.toast.error(deps.t('composable.bashFailed', { msg }))
    }
  }

  /**
   * 取消进行中的 bash 执行（调 pi abort_bash）。
   *
   * 错误处理与 abort 对齐：toast + 不 throw。
   */
  async function abortBash(sessionId: string): Promise<void> {
    const sid = sessionId
    try {
      await deps.chatApi.abortBash(sid)
    } catch (e) {
      // [W2] RPC 失败时 bashResult 广播不会到达，bash 消息永久卡在 streaming。
      // 主动找到 streaming bash 消息并标记为 error 态兜底。
      // [B2 PR#116 review] abortBash RPC 失败时 bashResult 广播不会到达，bash 消息永久卡在 streaming。
      // 调 store.markStreamingBashError 找到最后 streaming bash 消息标 error 态兼底（store 持有
      // 自己的 messages ref，useChat 不碰 ref——解耦 pinia Store/factory 产物的 messages 类型鸿沟）。
      const msg = toErrorMessage(e)
      chat.markStreamingBashError(sid, msg)
      deps.toast.error(deps.t('composable.stopFailed', { msg }))
    }
  }

  /**
   * 压缩上下文（#6 + M4）：确保会话级订阅（消费 session.compacting/compacted）→ 调 api.compact。
   *
   * 错误反馈（MF-1）：区分两类失败。pi 的 compact() 对失败/aborted 均 emit compaction_end 后 throw
   * （agent-session.js catch 块），故 RPC 必 reject 到此 catch。三类失败经同一 catch：
   *   - compaction 级（pi 已处理）：compaction_end{errorMessage} → interpreter 广播 message.error 进
   *     对话流（确定可见的错误源）；aborted → interpreter 视作非错误（不提示，取消语义）。compaction_end
   *     均先于 RPC error reply 经 stdout 到达 → session.compacted handler 先置 manualCompactionState=true，
   *     此处 catch 见 ended=true → 不 toast（避免与 interpreter 双提示 / 对 aborted 误提示失败）。
   *   - transport/busy 级（RPC 未达 pi / dispatcher busy 预检拒绝）：pi 未发 compaction_end，interpreter
   *     不参与 → 零反馈。此处 catch 见 ended=false → toast 兜底（AGENTS.md 规则 #3 错误必须可见）。
   * 不 throw（consumer fire-and-forget）。compacting 态由 session.compacted 复位（interpreter 发，必达）。
   *
   * 显式接收 sessionId：per-panel 隔离，不读全局 activeId。
   */
  async function compact(sessionId: string, customInstructions?: string): Promise<void> {
    const sid = sessionId
    ensureStreamSubscription(sid, chat, session, subDeps)
    // MF-1：标记 manual compact in-flight（key 存在），compaction_end 到达时 handler 置 value=true
    manualCompactionState.set(sid, false)
    try {
      await deps.chatApi.compact(sid, customInstructions)
    } catch (e) {
      const compactionEnded = manualCompactionState.get(sid) === true
      if (!compactionEnded) {
        // transport/busy 级失败：pi 未发 compaction_end（RPC 未达 pi / busy 预检拒绝），interpreter 不参与，
        // 零用户反馈——toast 兜底（AGENTS.md 规则 #3）。compaction 级失败由 interpreter 进对话流，不在此 toast。
        const msg = toErrorMessage(e)
        deps.toast.error(deps.t('composable.compactFailed', { msg }))
      }
      console.warn(`[useChat] compact RPC failed (compaction-ended=${compactionEnded}, surfaced via ${compactionEnded ? 'interpreter/dialog flow' : 'toast fallback'})`, e)
    } finally {
      manualCompactionState.delete(sid)
    }
  }

  /**
   * 编辑 user 消息并重新发送（原地替换语义，非 fork）：
   * 截断该 user 消息（含）及其后所有 → appendUser 新 segments → 走 submitSegments 流式。
   *
   * 与 fork 的区别：fork 复制到新 session 保留原 session；editAndResend 在当前 session
   * 原地替换（删旧 user + 其后 assistant，重新发送）。UI 层用 canEdit 守卫仅最后一条 user 可编辑，
   * 避免删除中间 user 导致其后对话丢失。
   *
   * 签名变更（阶段 3a）：从 `(sessionId, userMessageId, text: string)` 改为
   * `(sessionId, userMessageId, segments: Segment[])`。调用方（Turn.vue submitEdit）
   * 负责构造 segments——从原 user message 保留 image segments + 编辑后的 text segment。
   *
 * 委托 submitSegments：与 send 同通路（segmentsToPrompt + delivery.submit），image 段
 * 经 segmentsToText 产出裸路径进 prompt 文本（不丢）。
   *
   * 显式接收 sessionId：编辑可发生在非 active 的 standby panel，不能依赖全局 activeId。
   *
   * 孤立 sidecar 条目：editAndResend 写新 clientUuid 条目，旧消息（truncateFrom 截断的）
   * 的 sidecar 条目残留。不影响功能（重开按 piEntryId→clientUuid 精确匹配，孤立条目不引用），
   * 占少量磁盘（~200B/条）。完整清理随 session 删除/压缩统一治理（YAGNI，不在本函数做）。
   */
  async function editAndResend(sessionId: string, userMessageId: string, segments: Segment[]): Promise<void> {
    const promptText = segmentsToPrompt(segments)
    if (!promptText.trim() || chat.isActive(sessionId)) return
    chat.truncateFrom(sessionId, userMessageId, true)
    // [u3b/D1] 与 send 同一统一 submit 编排（乐观气泡 + inflight 占位 + delivery.submit）：
    // 编辑重发同样持有确认配额（其 message_end 走 ① 标记匹配回收），失败统一回滚。
    try {
      await submitNewMessage(sessionId, segments, promptText)
    } catch (e) {
      // [W2] 错误处理策略与 send/steer/followUp/abort 对齐：toast + 不 throw。
      // 消费侧 Turn.vue submitEdit 无 try/catch，不 throw 避免其产生 unhandled rejection（错误已通过 toast 消化）。
      const msg = toErrorMessage(e)
      deps.toast.error(deps.t('composable.sendFailed', { msg }))
    }
  }

  /**
   * 拉取并注入历史（首次进入 session）。
   * 无历史（空 session）也标记 hydrated，避免反复请求。
   *
   * [W20 D5 重放喂入侧] getHistory 返回的 messages 是 core applyEntry reducer 对
   * pi entry 日志的重放投影（runtime wire 层：getEntries → liftHistoryToEntries →
   * replayEntries，见 infra/pi/message-converter.ts）——hydrate 直接消费 reducer 产物，
   * 不做二次转换；getHistory RPC 链不变（session-service getEntries 增量现状保留）。
   * [W21 已接] 实时侧喂同一 reducer：message_end / tool_call_end 重构 entry 经
   * store.applyMessageEvent → applyEntryFrame 累积 per-session reducer state
   * （messages ref 的实时渲染仍走 overlay 路径，ref 与 reducer state 收敛归 W22 对账）。
   * [u6] loadMoreHistory 已改游标翻页（游标取分区最旧消息文件侧身份），hydrate 尾窗锚
   * 机制退役——两条历史读取路径（RPC getEntries entry 树重建 / 文件尾读 mapSessionEntries）
   * 都携带 entry 派生 id，游标身份稳定可得。
   */
  async function hydrateHistory(sessionId: string): Promise<void> {
    if (chat.isHydrated(sessionId)) return
    const reply = await deps.chatApi.getHistory(sessionId)
    // [u4d] 窗口状态随 hydrate 写入 store（SSOT：truncated/loadedTurns/totalTurnsEstimate
    // 单点存 chat store；N1 historyTruncatedSessions 双轨退役，hasMoreHistory 派生读）。
    chat.hydrate(sessionId, reply.messages, historyWindowFromReply(reply))
    // [D6-⑨ u7] toolResult 图片落盘 hydrate 编排（fire-and-forget 不阻塞历史注入）：
    // 收集消息序图片反转新→旧交 main 按序落盘、超帽即停；无 electronAPI 宿主（headless/
    // mock）内建 no-op。失败静默——渲染组件挂载兜底逐图重试。
    void persistImagesNewestFirst(sessionId, collectImagesFromMessages(reply.messages))
  }

  /**
   * N1: 查询 session 历史是否被截断（有更早的 turn 可加载）。
   * [u4d] 从 store 截断窗口状态派生（SSOT，无独立布尔表）。
   */
  function hasMoreHistory(sessionId: string): boolean {
    return chat.getHistoryWindow(sessionId)?.truncated ?? false
  }

  /**
   * 「加载更早」游标翻页（[u6] crash-resilience §3.3 D4 中期；原 W4 H4 getFullHistory
   * 全量通路退役——游标翻页完全替代）。
   *
   * 游标 = store 当前**最旧消息**的文件侧身份（`piEntryId ?? id`；live 消息只 append
   * 尾部，分区最旧恒为文件侧已加载最早消息）。runtime 按游标返回「锚点之前的最近
   * 窗口」（活跃/离线两路径共用语义），prependHistory 前插 + 窗口状态更新：
   * - 页响应 truncated=true = 锚前仍有更早历史 → 顶部条保持；false = 翻页到头 → 按钮消失。
   * - loadedTurns 累计各页（「已加载最近 N 轮」的 N 随翻页增长）；totalTurnsEstimate
   *   未读到头时取历史估计与页估计的较大者（均为下界），读到头时页值即精确总量。
   * - cursor 未命中（消息已被清理/超扫描域）→ runtime 返回空页 + truncated=false
   *   （翻页到头语义，不报错），分区不变、按钮收敛。
   *
   * 幂等：空页不写入（显式短路 + prependHistoryMut 空数组安全网）。RPC 失败不破坏
   * 现有消息（catch 吞错，与 hydrateHistory 的 markHistoryFailed 同策略），用户可重试。
   */
  async function loadMoreHistory(sessionId: string): Promise<void> {
    try {
      const oldest = chat.getMessages(sessionId)[0]
      const cursor = oldest ? (oldest.piEntryId ?? oldest.id) : undefined
      if (cursor === undefined) {
        // 分区为空却请求翻页（理论不可达：truncated=true 时分区非空）——防御短路
        console.warn(`[useChat] loadMoreHistory skipped for session ${sessionId}: empty partition (no cursor anchor)`)
        return
      }
      const reply = await deps.chatApi.getHistory(sessionId, { cursor })
      // 空页（翻页到头）短路：分区不变，仅窗口状态收敛（下方统一写）
      if (reply.messages.length > 0) {
        chat.prependHistory(sessionId, reply.messages)
      }
      const prev = chat.getHistoryWindow(sessionId)
      const page = historyWindowFromReply(reply)
      chat.setHistoryWindow(sessionId, {
        truncated: page.truncated,
        loadedTurns: (prev?.loadedTurns ?? 0) + page.loadedTurns,
        totalTurnsEstimate: page.truncated
          ? Math.max(prev?.totalTurnsEstimate ?? 0, page.totalTurnsEstimate)
          : page.totalTurnsEstimate,
      })
    // eslint-disable-next-line taste/no-silent-catch -- 加载更多是 best-effort：失败不破坏现有消息，用户可重试。与 hydrateHistory markHistoryFailed 同策略。
    } catch (e) {
      console.warn(`[useChat] loadMoreHistory failed for session ${sessionId}:`, e)
    }
  }

  /**
   * 清理指定 session 的全部资源（W1 / S3：deleteSession 调用）。
   *
   * 取消 WS 流式订阅（streamSubscriptions 模块级 Map）+ 清理 chat store per-session 状态
   * （[u4d] 截断窗口状态分区由 chat.disposeSession 统一清）。session 删除后若不取消订阅，
   * WS 事件仍会推给已删 session 的 handler，且 Map 永久增长。
   */
  function disposeSession(sessionId: string): void {
    const unsub = streamSubscriptions.get(sessionId)
    if (unsub) {
      unsub()
      streamSubscriptions.delete(sessionId)
    }
    // D-2：收口兜底——unsub 后不会再有新消息入缓冲，把该 sid 残留 delta 落地后再删分区。
    // 用 flush(sid) 而非 flushAll：其他 session 的合并窗口不应被本 session 的销毁提前打断。
    coalescer.flush(sessionId)
    // [u4d] 截断窗口状态由下方 chat.disposeSession 内统一清理（store 分区），无需单独清
    manualCompactionState.delete(sessionId) // MF-1：清 manual compact 标记
    // [投递所有权内核 u3b] 清内核投影 + morph 段（session 已销毁，帧/回执不再有意义）
    clearDeliveryProjection(sessionId)
    // wave:renderer-subscribe：清除 MessageBus 订阅状态（SubscriptionState）。
    // 与 streamSubscriptions.delete 配对——session 删除后若不清，routeInbound 的 gap 检测
    // 仍会读残留 state（lastSeenSeq 基线 stale），且 Map 永久增长。
    clearSubscription(sessionId)
    chat.disposeSession(sessionId)
    // [D6-⑨ u7 / MF-10] 图片缓存记账同点清理：帽满标记 + 本 session 落盘图的路径记账
    // （标记是 main 回执派生缓存非权威，清后由 main 重判；deleteSession / LRU 驱逐 /
    // fork 回滚 / stream-sync 移除全部经本函数收敛，单点接线）。
    disposeImageCacheForSession(sessionId)
  }

  return {
    send,
    steer,
    followUp,
    abort,
    compact,
    editAndResend,
    hydrateHistory,
    loadMoreHistory,
    hasMoreHistory,
    disposeSession,
    sendBash,
    abortBash,
    // [session-dead G1 → u3b 注记] forceQuit 后清 pi queue_update 快照——queueStates 分区
    // 已随 queue_update 计数腿退役不再写入（本转发保持返回面稳定，最终清理归 u5）；
    // 队列区数据源 = session.delivery 投影（disposeSession → clearDeliveryProjection 清理）。
    clearQueueState: (sessionId: string) => chat.clearQueueState(sessionId),
  }
}

/**
 * 失效指定 session 的本地流订阅标记（session.exited 时由 useMessageEffects 调用）。
 *
 * 收到 session.exited = 服务端订阅必然已被 bus.clearSession 清除（pi 死亡 →
 * removeSessionEntry → clearSession），本地两层幂等标记必须同步失效，否则 respawn 后
 * ensureStreamSubscription 被短路，链路断裂：
 * - streamSubscriptions 条目不清 → events 层 handler 不重挂 + 残留旧 handler（若只删
 *   标记不 unsub，重挂后同 sid 双 handler 双 dispatch）；
 * - subscriptionStates 条目不清（clearSubscription）→ subscribeSession 幂等守卫
 *   （subscribed=true）短路，不重发 subscribe RPC → 新 pi 的 message.* 定向推送无订阅者，
 *   UI 卡「进行中…」而回复实际已生成。
 *
 * 与 disposeSession 的区别：session 仍存在（dead 占位 UI 可「重新打开」），只失效订阅，
 * 不清 chat store 分区/截断窗口状态/manualCompaction 等业务状态。
 */
export function invalidateStreamSubscription(sessionId: string): void {
  const unsub = streamSubscriptions.get(sessionId)
  if (unsub) {
    unsub()
    streamSubscriptions.delete(sessionId)
  }
  // 收口兜底（对齐 disposeSession）：unsub 后不会再有新消息入缓冲，残留 delta 落地显示
  coalescer.flush(sessionId)
  // invalidateSubscription（非 clearSubscription）：额外清 in-flight 去重条目，防 respawn 后
  // 首次 ensureStreamSubscription 复用死 Promise 而不重发 subscribe RPC
  invalidateSubscription(sessionId)
}
