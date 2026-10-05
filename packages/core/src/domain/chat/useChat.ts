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
 * hydrate：历史注入的生产通路 = session 域 reconcile（use-session 三处点击切入统一入口，
 * store.hydrate 消费，含图片落盘编排）。messages 为 applyEntry reducer 重放投影（W20 D5）。
 *
 * abort：调 api.chat.abort（方法存在，中断流转 DEFERRED G-025）。
 */
import type { Segment, ServerMessage, ServerMessageUnion, CompactErrorCode, MessageBlockedCode } from '@taiji/shared'
import { segmentsToPrompt, restoreRevokedDraft, markerLiteral, MESSAGE_BLOCKED_CODE } from '@taiji/shared'
import {
  subscribeSession,
  clearSubscription,
  invalidateSubscription,
  resetSubscriptionStates,
} from '../../coordination/subscription-state'
import type { ChatStoreInstance } from './store'
import { historyWindowFromReply } from './truncated-window'
import { disposeImageCacheForSession } from './image-cache'
import { toErrorMessage } from '../../utils/error-message'
import type { EnsureStreamSubDeps, SessionStoreLike, UseChatDeps } from './use-chat-types'
import type { DeliveryFrameEntry, DeliveryCancelReply, DeliverySubmitReply } from './api-port'
import type { RevokeMessageErrorCode } from '@taiji/shared'
import { createDevOnceFrameWarn } from './effects/registry'
import {
  replaceDeliveryProjection,
  captureMorphSegments,
  clearDeliveryProjection,
  resetDeliveryProjectionForTest,
  findDeliveryEntry,
} from './effects/user-delivery'

// 类型契约原样迁 use-chat-types.ts（max-lines 行为保持抽取，纯类型零运行时）；
// re-export 保持既有 import 路径（domain/chat/index.ts 与 __tests__ 经 './useChat'
// 消费）零改动。[u3b] SubmitQueuedEntryDeps 已随 defer flush 退役摘除。
export type {
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
 * [U5 消息撤回 D8] revokeMessage 六错误码 → toast 文案 key 映射（D8 错误规格表呈现列为
 * SSOT——改码/改呈现先改设计表再同步此处）。busy 用 D2 附带裁决同款文案（按钮置灰是第一
 * 道防线，服务端 busy 到达 = 置灰漏网的服务端兜底）。
 */
const REVOKE_ERROR_TOAST_KEYS: Record<RevokeMessageErrorCode, string> = {
  busy: 'composable.revokeBusy',
  'no-mapping': 'composable.revokeNoMapping',
  'extension-missing': 'composable.revokeExtensionMissing',
  'nav-failed': 'composable.revokeNavFailed',
  'pi-reclaimed': 'composable.revokePiReclaimed',
  'workflow-running': 'composable.revokeWorkflowRunning',
}

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

// [u4d-truncated-ui] [HISTORICAL] W4/N1 的 historyTruncatedSessions（ref<Set>，尾读截断
// →「加载更多」显隐）已退役：截断事实的 SSOT 迁为 chat store 截断窗口状态（truncated-window.ts，
// truncated/loadedTurns/totalTurnsEstimate 三字段随 u4b session.history 响应写入），布尔显隐
// 由 hasMoreHistory 派生读——同一 truncated 事实不再两处存储。

/**
 * RPC 失败的 toast 抑制判别（msg-pipeline-debloat D4-2）：按 error envelope 分类码路由，
 * 不依赖事件到达顺序推断。
 *
 * envelope 携带 runtime 分类码（CompactErrorCode / MessageBlockedCode，词表 SSOT 在
 * shared protocol.ts）= 错误的
 * 用户可见呈现已由 runtime 侧编排——compact_busy → 对话流 system 提示（dispatcher
 * stream_warn）；compact_failed → interpreter 对话流（compaction 级失败）或 session
 * 状态面（ensureActive 失败）；message_blocked → 错误气泡（dispatcher 广播——BeforeSend
 * hook 否决，message.send / message.bash / delivery.submit 三 handler 统一落此码）。
 * 此时再弹全局错误 toast 属双提示，抑制。
 *
 * 其余形态保守回退为 toast 兜底（错误可见性优先，AGENTS.md 规则 3）：
 * - 未知分类码（runtime 未来新增码而 renderer 未升级）——宁可多弹不可吞；
 * - renderer pending 层机械码 'timeout' / 'overflow' / 'unknown'（RPC 未达 runtime /
 *   溢出驱逐 / envelope 无 code 归一）——runtime 侧呈现未发生；
 * - 无 code（WS 断连 rejectAll / 本地异常）。
 */
function isTransportLevelFailure(e: unknown, classifiedCodes: readonly string[]): boolean {
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return true
  return !classifiedCodes.includes(code)
}

/** compact RPC 的已分类码集合（词表 SSOT = shared CompactErrorCode）。 */
const COMPACT_CLASSIFIED_CODES: readonly CompactErrorCode[] = ['compact_busy', 'compact_failed']

/** hook 否决类 RPC 的已分类码（message.send / message.bash / delivery.submit 三 handler
 * 对 blocked 失败落的同一码，dispatcher 已广播 message.error 错误气泡）。值经 shared
 * 词表单点引用（MESSAGE_BLOCKED_CODE，与 CompactErrorCode 同 SSOT）——本文件不再
 * 手抄字面量，码名漂移在编译期即失配。 */
const BLOCKED_CLASSIFIED_CODE: MessageBlockedCode = MESSAGE_BLOCKED_CODE

/**
 * [session-occupancy-send-closure D2 → 投递所有权内核 u3b 退役] per-session 未决直发记录
 * 已退役：唯一消费方 handleSendRejected（send.rejected handler）随「内核永远不拒绝用户消息」
 * （D5 排队取代拒绝）整体删除。git 可追溯。
 */

/**
 * [消息投递可靠性 A-bash] per-session bashResult 终态帧观测计数（sid → 已见帧数）。
 *
 * 用途（**仅作 toast 抑制提示，不参与投递判定**）：sendBash 据
 * 「本次调用窗口内终态帧是否到达」决定是否抑制失败 toast——终态已渲染时气泡终态是权威
 * 呈现面，再弹「失败」措辞 toast 冗余且误导（如超时后命令仍在跑）。投递判定（是否恢复
 * `!command` 草稿）只看 RPC 回执状态（BashDispatchReceipt）：帧是可丢弃的推送信号，帧
 * 丢失不得导致「未执行」误判（误判会触发草稿恢复 → 用户重发 → 命令双执行）。
 * 计数在 streamSubscribe 回调内**同步**递增（先于 coalescer dispatch，不受合帧节拍影响）。
 * 窗口比对（entry 快照）天然排除历史帧；bash↔bash 互斥（预检拒绝），窗口内该 sid 的终态帧
 * 必属本次命令。清理：resetChatModuleStateForTest / disposeSession（与同文件其余模块级 Map 同模式）。
 */

// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，流程观测态）：bash 终态帧观测计数
const bashTerminalFrameCounts = new Map<string, number>()

/**
 * [pi1-disposition-chat-flow U2①② / D1③⑤] 本地提交的命令条目登记表（sid → clientUuid →
 * 投影在场标记）。登记点 = submitNewMessage 收到受理回执 `isCommand === true`（内核 D2 识别
 * 结果随回执返回，U1⑨）。登记成员 = 唯一「永无 message_end 标记回执」的条目族（命令条目
 * D2② 不注标出站），其气泡终局只可能来自两路：
 * - 终局通知 session.deliveryHandled（D1③，主路径）→ handleSessionDeliveryHandled 静默清除；
 * - 通知丢失（断线窗口）/ runtime 重启（tombstone 内存态丢失 D14①）→ 孤儿对账兜底（D1⑤，
 *   判据 =「曾经在场」+ 终态双分支「不在投影 ∨ delivered 终态在场」）。
 *
 * 操作域刻意收窄为登记在册的命令条目：普通消息条目终局必有 transcript 痕迹，气泡去留由
 * 回执链管（direct 原位保留 / morph 段重建入流）——孤儿对账若操作普通条目，会在「快照帧
 * 先于 message_end 回执到达」窗口把已送达的气泡清掉且降级入流被 direct 车道豁免，构成
 * 文本丢失面。命令条目撤销后清除恒正确（cancel 成功 → 内核删条目 → 下一帧「不在投影」
 * 分支清气泡，原文已回填草稿；cancel 竞态落败 → delivered 在场 → 命令已执行，清气泡同样
 * 正确），故无需单独的「本端取消中」豁免集合。
 *
 * 成员删除点：handled 通知 / 孤儿清除 / disposeSession / resetChatModuleStateForTest。
 * 生命周期上界 = 命令条目终局即摘除，无长会话膨胀形态。
 */
// taste:allow-no-data-owner W24-EX-C（进程内流程状态——命令条目终局登记，无 GUI 直接消费方；
// 登记于登记表 §4 ⑧ W24-EX-C 条目，队列条目本体归主表 #6 投影/内核）
const handledDeliveryTargets = new Map<string, Map<string, { seenInProjection: boolean }>>()

/** 登记一个本地提交的命令条目（submitNewMessage 受理回执 isCommand 时调）。 */
function registerHandledDeliveryTarget(sid: string, clientUuid: string): void {
  let partition = handledDeliveryTargets.get(sid)
  if (!partition) {
    partition = new Map()
    handledDeliveryTargets.set(sid, partition)
  }
  // 受理回执晚于首帧快照到达的时序差形态（广播路径快于 RPC reply）：投影已有该条目时直接
  // 补记「曾经在场」，防首帧证据丢失使孤儿判定保守悬挂一轮。
  partition.set(clientUuid, { seenInProjection: findDeliveryEntry(sid, clientUuid) !== undefined })
}

/**
 * [pi1-disposition-chat-flow U2③ / D10③] extension.error 命令来源 toast 的同 key 限频窗：
 * 同 key（extensionName + error 文本）弹出后 60s 内不重复弹。量级取 goal 循环事故回合间隔
 * （2026-09-08：64 分钟约 320 回合 ≈ 12s/回合）的数倍，覆盖命令循环重试刷屏形态（D10③；
 * 参数为模块常量，实施期可校准）。导出供测试 import（禁魔数复制漂移）。
 */
export const EXTENSION_COMMAND_ERROR_RATE_LIMIT_MS = 60_000

/** 同 key 最近弹出时刻（key = extensionName + '\n' + error 文本，不含 sessionId——同 key
 * 跨 session 去重，D10③「同 key（extensionName + error 文本）」）。过期条目在写入前惰性
 * 清扫（无定时器，对齐 user-delivery morphSegmentsBySession TTL 先例）。清理挂点：
 * resetChatModuleStateForTest（测试隔离，与同文件其余模块级 Map 同模式）。
 */
// taste:allow-no-data-owner W24-EX-C（进程内流程状态——toast 展示层限频时刻，非数据一致性
// 事实；错误数据本体已逐条完整留痕 runtime 日志 + extension.error WS 消息，D10③ 时间平抑登记；
// 登记于登记表 §4 ⑧ W24-EX-C 条目）
const extensionCommandErrorLastShownAt = new Map<string, number>()

/**
 * [RD-1#9 / R1-B12 双轨收敛] 未列 session.* 帧类型的一次性 dev warn（观测补齐，非行为变更）。
 *
 * streamSubscribe 回调的 session.* switch default 对「有意 no-op」的帧（exited/restored/
 * commands/stats_update 等，消费方在 renderer 侧 message bus 或另一订阅面）与「协议漂移」
 * （runtime 新增而前端漏接）不可区分——去重后一次/类型，dev 下留痕、生产零开销。
 * 「dev 门 + Set 去重 + warn」三段式收敛到 registry.createDevOnceFrameWarn 工厂（与
 * registry 未注册 message.* 帧观测同一实现）；session.* 前缀过滤是本调用点的语义差异，
 * 留在本地：app.info / config.* / plugin:* / rollingRestart:* 等全局帧经同一
 * streamSubscribe 到达，本就由其他域消费，warn 会是误报。
 * 清理：resetChatModuleStateForTest（测试隔离，与同文件其余模块级 Map 同模式）。
 */
const sessionFrameWarn = createDevOnceFrameWarn(
  (type, sid) =>
    `[useChat] unhandled session frame type ${type} (sid=${sid}) — no case in ensureStreamSubscription handler;` +
    ` frame is a no-op here (consumed elsewhere by design, or protocol drift)`,
)
function warnUnhandledSessionFrame(type: string, sid: string): void {
  if (!type.startsWith('session.')) return
  sessionFrameWarn.warn(type, sid)
}

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
  // [消息投递可靠性 A-bash] 清 bash 终态帧观测计数（残留计数会让下一用例的 sendBash
  // 误判「本次窗口已见终态」，错误地抑制失败提示）
  bashTerminalFrameCounts.clear()
  // [pi1-disposition-chat-flow U2] 清命令条目登记表 + extension.error 限频表（残留成员会把
  // 上一用例的命令条目/限频状态带进下一用例的 handled/孤儿对账/toast 断言）
  handledDeliveryTargets.clear()
  extensionCommandErrorLastShownAt.clear()
  // [u4d] 截断窗口状态随 chat store per-instance，无需模块级 reset
  // [投递所有权内核 u3b] 清内核投影 + morph 段（测试间不 reset 会把上一用例的
  // session.delivery 投影带进下一用例的回执/morph 断言）
  resetDeliveryProjectionForTest()
  // wave:renderer-subscribe：重置 MessageBus 订阅状态（subscriptionStates 模块级 Map）。
  // 与 streamSubscriptions 同理——测试间不 reset 会泄漏到下一用例
  //（subscriptionStates 残留 → routeInbound gap 检测误判）。
  resetSubscriptionStates()
  // [RD-1#9] 清未列 session.* 帧类型的 warn 去重集合（测试间不 reset 会让下一用例的
  // 「一次/类型」断言因上一用例已 warn 过而静默失效）。
  sessionFrameWarn.reset()
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
 * [pi1-disposition-chat-flow U2② / D1⑤] 孤儿对账——handled 终局通知丢失后的静默清除兜底。
 *
 * 触发面：session.delivery 快照帧到达（含断线重连 stateSnapshot 回放，同一 handler 路径）。
 * 判据（三条同时成立才清除，操作域 = handledDeliveryTargets 登记在册的命令条目）：
 * ①「曾经在场」正向证据（seenInProjection——曾出现在此前任一帧投影；受理窗口内快照不含
 *   新条目属正常态，无此条件的「不在投影即清除」会在连发场景误清未受理气泡，设计 V8 反向）；
 * ② 终态判据双分支：已不在当前投影（runtime 重启 tombstone 内存态丢失 D14①），或在当前
 *   投影中呈 delivered 终态（tombstone 仍在 50 条 delivered 窗口内——通知丢失 + runtime
 *   存活的重连形态 D14①b）；
 * ③ 操作域已在登记点收窄为命令条目（见 handledDeliveryTargets 注——普通条目由回执链管，
 *   不进本判据）。
 *
 * 与下方 morph 循环是同函数相邻分支（impl-plan U2 检查点）：对账只清登记在册的命令条目、
 * morph 只处理非 direct 车道的活跃条目，操作域互斥不重叠。
 * 清除动作 = finalizeHandledEntry（handled 同形态静默清除：移除乐观气泡 + 清空窗计时器 +
 * 递减在途计数，无错误提示 D1④）。
 */
function reconcileHandledOrphans(
  sid: string,
  chat: ChatStoreInstance,
  entries: DeliveryFrameEntry[],
): void {
  const partition = handledDeliveryTargets.get(sid)
  if (!partition || partition.size === 0) return
  const projectionIds = new Set(entries.map((e) => e.clientUuid))
  for (const [clientUuid, mark] of partition) {
    if (!mark.seenInProjection) continue
    const inProjection = projectionIds.has(clientUuid)
    if (inProjection) {
      const state = entries.find((e) => e.clientUuid === clientUuid)?.state
      if (state !== 'delivered') continue
    }
    // 双分支命中：不在投影（分支 A）∨ delivered 终态在场（分支 B）
    partition.delete(clientUuid)
    if (partition.size === 0) handledDeliveryTargets.delete(sid)
    finalizeHandledEntry(sid, clientUuid, chat)
  }
}

/** [D1⑤] 「曾经在场」证据标记（投影替换点记录）：本帧 entries 命中的登记成员置位，
 * 供后续帧孤儿判定。本帧不计入本帧判定（reconcileHandledOrphans 先于本函数执行）——
 * 「曾出现在此前任一帧投影」的严格语义，首见即 delivered 的帧保守不清（悬挂至下一帧，
 * 误清零风险优先，D1⑤ 保守方向）。 */
function markHandledTargetsSeenInProjection(sid: string, entries: DeliveryFrameEntry[]): void {
  const partition = handledDeliveryTargets.get(sid)
  if (!partition || partition.size === 0) return
  for (const entry of entries) {
    const mark = partition.get(entry.clientUuid)
    if (mark) mark.seenInProjection = true
  }
}

/**
 * [pi1-disposition-chat-flow U2① / D1③④] session.deliveryHandled 终局通知消费：命令条目
 * 被 pi 接管（handled disposition）后内核一对一通知，前端按 handled 同形态静默清除——
 * 回滚三件套（移除乐观气泡 + 清空窗计时器 + 递减在途计数），**无错误提示**（handled =
 * 命令已执行，非失败形态；执行结果经 pi 回合事件正常入流）。
 * 只对登记在册成员动作：外来命令条目（plugin send_to_session / 收养等无本地乐观面的提交）
 * 无气泡可移除、无挂账可回收，误动 clearPendingSend/decrementInflight 会误伤同 session
 * 其他在途提交。
 * [ADR-0049] per-session 隔离：payload.sessionId 校验（对齐 handleSubagentDirective 防御层）。
 */
function handleSessionDeliveryHandled(
  sid: string,
  chat: ChatStoreInstance,
  msg: ServerMessage<'session.deliveryHandled'>,
): void {
  if (msg.payload.sessionId !== sid) return
  const partition = handledDeliveryTargets.get(sid)
  if (!partition?.has(msg.payload.clientUuid)) return
  partition.delete(msg.payload.clientUuid)
  if (partition.size === 0) handledDeliveryTargets.delete(sid)
  finalizeHandledEntry(sid, msg.payload.clientUuid, chat)
}

/**
 * [D1④] handled 形态静默清除三件套（U2① 终局通知与 U2② 孤儿对账共用，「按 handled 同
 * 形态」的单一实现）：① 移除乐观气泡（truncateFrom 幂等：已 morph / 不存在的 id no-op）；
 * ② 清 dispatching 占位（clearPendingSend，纯 Set 操作）；③ 递减在途计数（钳制幂等）。
 * 无错误提示（handled = 命令已执行的正常终局）。
 */
function finalizeHandledEntry(sid: string, clientUuid: string, chat: ChatStoreInstance): void {
  chat.truncateFrom(sid, clientUuid, true)
  chat.clearPendingSend(sid)
  chat.decrementInflight(sid, 1)
}

/**
 * [pi1-disposition-chat-flow U2③ / D10③] extension.error 帧消费——命令失败 toast（白名单
 * 放行的最小通路）。放行判据 = 仅 `errorEvent === 'command'`（pi 命令 handler 抛错的固定
 * 标记，agent-session.js `_tryExecuteExtensionCommand` catch 分支；事件 handler 抛错为
 * 事件名、生命周期错误为 register_provider 等标记，其余来源保持现状静默——完整失败体验
 * 归 D14④ 独立立项）。同 key（extensionName + error 文本）去重 + 限频窗见
 * EXTENSION_COMMAND_ERROR_RATE_LIMIT_MS。
 * [ADR-0049] per-session 隔离：payload.sessionId 校验。payload 在 shared 为
 * Record<string, unknown> 占位（ServerMessageMapBase 未收录），字段经守卫收窄（禁 any）。
 */
function handleExtensionErrorFrame(
  sid: string,
  msg: ServerMessage<'extension.error'>,
  deps: EnsureStreamSubDeps,
): void {
  const p = msg.payload as {
    sessionId?: unknown
    extensionName?: unknown
    error?: unknown
    errorEvent?: unknown
  }
  if (p.errorEvent !== 'command') return
  if (p.sessionId !== sid) return
  const rawName = typeof p.extensionName === 'string' ? p.extensionName : ''
  const rawError = typeof p.error === 'string' ? p.error : p.error == null ? '' : String(p.error)
  const key = `${rawName}\n${rawError}`
  const now = Date.now()
  // 惰性清扫过期条目（无定时器；防长会话不同 key 累积无上界）
  for (const [k, at] of extensionCommandErrorLastShownAt) {
    if (now - at >= EXTENSION_COMMAND_ERROR_RATE_LIMIT_MS) extensionCommandErrorLastShownAt.delete(k)
  }
  const lastShownAt = extensionCommandErrorLastShownAt.get(key)
  if (lastShownAt !== undefined && now - lastShownAt < EXTENSION_COMMAND_ERROR_RATE_LIMIT_MS) return
  extensionCommandErrorLastShownAt.set(key, now)
  // extensionName 形态 = "command:<命令名>"（D10③ 载荷锚定：extensionPath 语义经
  // runtime event-adapter 改名入 extensionName 字段）——剥前缀补 "/" 得用户可读命令名。
  const name = rawName.startsWith('command:') ? `/${rawName.slice('command:'.length)}` : rawName
  deps.toast.error(deps.t('composable.extensionCommandFailed', { name, msg: rawError }))
}

/**
 * [投递所有权内核 u3b / D7] session.delivery 帧消费（state topic 全量快照，last-value）：
 * ① 投影整体替换（effects/user-delivery 模块级 ref，队列区/气泡 morph 的单一数据源，
 * u3c QueueBubble 单源化消费）；② 乐观气泡 morph 编排——非 direct 车道（steer/queued）的
 * 活跃条目（queued/in-flight/failed）命中有乐观气泡时：气泡移出对话流（truncateFrom）+
 * 原始 segments 捕获（送达回执时按原段按序入流，不降级纯文本）+ dispatching 占位回收。
 * direct 车道气泡保持待确认（送达回执经 message_end ① 标记匹配抵消占位，D7「既有
 * inflightCounts 抵消机制保留服务 direct」）；delivered 条目无 morph 面（其 transcript
 * 权威由 reducer 喂入，回执/快照两侧幂等）。
 * [pi1-disposition-chat-flow U2②] 投影替换后插入孤儿对账相邻分支 + 「曾经在场」证据标记
 * （见 reconcileHandledOrphans / markHandledTargetsSeenInProjection）。
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
  // 形态守卫（对齐 registry A5 形态门控）：entries 非数组 = 坏帧，整体丢弃——先投影替换
  // 后 morph 的两段消费在坏帧上会产生「投影已换、morph 未做」的半更新，守卫前置于两段之前。
  const rawEntries: unknown = msg.payload.entries
  if (!Array.isArray(rawEntries)) return
  const entries = rawEntries as DeliveryFrameEntry[]
  replaceDeliveryProjection(sid, entries)
  // [U2② / D1⑤] 孤儿对账（handled 通知丢失兜底）→ 本帧证据标记——先判定后标记，
  // 「曾经在场」不含本帧（严格「此前任一帧」语义）；两分支与下方 morph 循环操作域互斥。
  reconcileHandledOrphans(sid, chat, entries)
  markHandledTargetsSeenInProjection(sid, entries)
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

/**
 * [U5 消息撤回 D6] 统一撤回编排（模块级编排体，handleSessionDelivery 同款形态）：
 * 在途 / 已送达双态路由 + reply 消费。
 *
 * 路由判定（内核投影 state 未 delivered = 在途，判定形态与 useQueueRows 队列气泡的
 * deliveryQueueEntries 同源——state !== 'delivered'）：
 * - 在途（未注入层）→ 既有 delivery.cancel 两段式收回（内核删除 + clear_queue 分拣），
 *   与队列气泡 × 撤销共用同一 runtime 管道；
 * - 已送达（S8 已消费层）→ session.revokeMessage（runtime 七步编排，树内回退）。
 *
 * 已送达 reply 消费：revoked:true → 重拉 history（reply 即刷新信号——session_tree 不经
 * RPC 流，无事件可订阅，主动拉是主路径，D3）+ content 经 restoreRevokedDraft（D7 两层
 * 切条，shared SSOT）回填草稿；revoked:false → 按 D8 错误码 toast（映射 SSOT 在
 * REVOKE_ERROR_TOAST_KEYS）。
 */
async function handleRevokeMessage(
  sid: string,
  targetId: string,
  chat: ChatStoreInstance,
  deps: UseChatDeps,
): Promise<void> {
  // D6 路由：内核投影中该条目仍活跃（未 delivered）→ 在途分支（[MF-1-4] 判定谓词与
  // UserBubble 共享 findDeliveryEntry 单一实现——投影宿主同源，禁两处内联 find 漂移）
  const pendingEntry = findDeliveryEntry(sid, targetId)
  if (pendingEntry && pendingEntry.state !== 'delivered') {
    await handleCancelPendingDelivery(sid, targetId, deps)
    return
  }
  let reply: Awaited<ReturnType<UseChatDeps['chatApi']['revokeMessage']>>
  try {
    reply = await deps.chatApi.revokeMessage(sid, targetId)
  } catch (e) {
    const msg = toErrorMessage(e)
    deps.toast.error(deps.t('composable.revokeFailed', { msg }))
    return
  }
  if (!reply.revoked) {
    deps.toast.error(deps.t(REVOKE_ERROR_TOAST_KEYS[reply.error]))
    return
  }
  // 成功：重拉 history 替换对话流（树回退后 live ≡ reload，reconcileHistory 是汇合点）。
  try {
    const history = await deps.chatApi.getHistory(sid)
    chat.reconcileHistory(sid, history.messages, historyWindowFromReply(history))
  } catch (e) {
    // best-effort 降级：撤回已生效（runtime ⑥校验过才 reply），重拉失败只 stale 不失真——
    // warn 留痕，对话流由下次切入/刷新的既有主动拉收敛；重抛会破坏 fire-and-forget 契约。
    console.warn(`[useChat] post-revoke history refresh failed for ${sid}:`, e)
  }
  // 草稿回填（D7）：content 含投递裸标记，剥标记/整批切条后送 composer
  const draft = restoreRevokedDraft(reply.content)
  if (!draft.trim()) return
  try {
    deps.restoreDraft?.(sid, { text: draft })
  } catch (e) {
    // best-effort 降级：回填是撤回的增强不是前提（重拉已做，原文在旧分支文件可审计）；
    // 壳层 DOM 故障不重抛——fire-and-forget 契约 + warn 留痕。
    console.warn(`[useChat] post-revoke draft restore failed for ${sid}:`, e)
  }
}

/**
 * [U5 消息撤回 D6] 在途撤回腿：delivery.cancel + reply 消费（cancel reply 的 content
 * 已由 runtime 剥标记——WS handler 链统一剥除，回填直用不经 restoreRevokedDraft）。
 * 竞态落败（cancelled=false = 点击瞬间已注入）→ 指引转已送达层撤回，不静默。
 */
async function handleCancelPendingDelivery(sid: string, clientUuid: string, deps: UseChatDeps): Promise<void> {
  let reply: DeliveryCancelReply
  try {
    reply = await deps.chatApi.cancelDelivery(sid, clientUuid)
  } catch (e) {
    const msg = toErrorMessage(e)
    deps.toast.error(deps.t('composable.revokeCancelFailed', { msg }))
    return
  }
  if (!reply.cancelled) {
    deps.toast.error(deps.t('composable.revokeDeliveredRace'))
    return
  }
  // runtime 契约承诺 cancelled=true 携带完整文本——缺失/空白是契约违规，出声而非静默回空草稿
  const content = reply.content ?? ''
  if (!content.trim()) {
    deps.toast.error(deps.t('composable.revokeRestoreContentMissing'))
    return
  }
  // [MF-1-2] 撤回入口的草稿回填为纯文本：composerInjection 通道是单值 text 语义（四符号
  // 体系三互斥 schema，无 segments 承载位），chips 完整恢复的通道是队列区 restoreToDraft
  // （composer-shell，restoreSegments 同款）；本路径保留文本回填不降级可见性。
  try {
    deps.restoreDraft?.(sid, { text: content })
  } catch (e) {
    // best-effort 降级：撤销已在 runtime 完成（条目随 state 帧消失），回填失败只 warn——
    // 重抛破坏 fire-and-forget 契约，用户可从对话流/队列区确认状态后手动复制。
    console.warn(`[useChat] post-cancel draft restore failed for ${sid}:`, e)
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
 * [HISTORICAL → u3b 退役] flush 触发源职责已随 defer 队列退役：压缩结束后的投递由内核
 * 对账器/投递通道接管（compaction_end 是 runtime 侧 Reconciler 触发点之一，D3），renderer
 * 不再触发 flush。行为连续性：压缩失败后队列照常投递（消息不丢优先）由内核保证。 */
function handleSessionCompacted(sid: string, chat: ChatStoreInstance): void {
  chat.setCompactingReason(sid, undefined)
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
  // [u5a 收口扩展 / #12 对称腿] 权威帧兜底乐观态：三维全 idle 的权威投影到达 = runtime
  // 确认无 turn 在途 —— 此时本地 pendingSend 乐观置位（send 前置，正常由 message_start
  // 清）若仍在，说明该次发送走了「无 turn 回流」通路（pi 扩展命令同步执行：手敲
  // `/schedule …` 等），message_start 永远不会来。权威帧在此清 optimistic pendingSend，
  // 否则 isActive（isGenerating ∨ pendingSend 并集）永久 true → steer placeholder + abort
  // 按钮卡死（与 runtime occupancy 卡 dispatching 同源的镜像缺陷，runtime 侧收口由
  // message-dispatcher willExecuteAsExtensionCommand 补齐，本处补齐前端乐观腿）。
  // 与 idle 判据同形（三维全 idle）防误清 bash/compacting 窗口；正常 turn 路径的 idle 帧
  // 到达时 pendingSend 已被 message_start 清（幂等无副作用）。
  // （main 侧 u5a 原含的 defer flush 腿已随 defer 队列退役不合并——投递时机由 runtime
  // 内核驱动，见文件头 [HISTORICAL → u3b 退役] 注。）
  if (
    msg.payload.turn === 'idle'
    && !msg.payload.compacting
    && !msg.payload.bash
    && chat.isPendingSend(sid)
  ) {
    chat.clearPendingSend(sid)
  }
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
 * 本 gate 的覆盖子态（msg-pipeline-debloat D3 后）：惰性恢复跨 D7 自动恢复 timer fire
 * 完成——attemptRespawn fire 时复查 isRestoring 让位裸 return（early return 不置
 * attemptInFlight），timer 已被 fire 回调删除、失败计数 0 → facade 尾部三信号门控皆
 * miss，restored 帧不发（D7-41 登记的判据残余洞）→ 本 gate 是该子态唯一收口。
 *
 * 有帧子态（三信号任一命中）无需本 gate：restored 帧恒先于 message_start（facade 尾部
 * 同步发布，早于新 pi 处理用户消息），收口已由 useMessageEffects.handleSessionRestored
 * 完成；帧已收口后 message_start 再到达时，本 gate 的 isRespawnPending 守卫使二次收口
 * no-op（handleSessionRestored 自身无该守卫，不插双条靠的是「帧恒先于 message_start」
 * 时序 + 本守卫）。
 *
 * 缺陷史（Gate B A7 真机，防御对象）：恢复窗口（respawnPending）内用户发消息 → 惰性
 * 恢复（ensureRestored join）先于 D7 timer 完成 → timer fire 让位 → 无 restored 帧 →
 * 前端过渡态只等 restored/restoreFailed/30s 超时收口 → 超时后回落 dead 终态页，而
 * session 实际已恢复、消息已获回复——用户被迫手动「重新打开」。
 *
 * 收口信号 = 恢复窗口内该 session 的 message.message_start 到达：新 pi 已在处理用户
 * 消息，「恢复完成」事实成立（恢复窗口订阅自 exited 时建立，恢复后的帧必经本 handler）。
 * 执行与 useMessageEffects.handleSessionRestored 同构的收口：清过渡态 + T4 恢复提示条
 * （复用 respawnRestored 文案）+ dead 复位。30s 超时 timer 到期时分区已清 → no-op
 * 自清，无需跨模块取消。
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

/** session.* → 跨 store 协调（sessionStore.applySnapshot / occupancy 投影），保留在 useChat
 *（stores 间禁止互相 import）。case 体提取为上方同名 handle* helper；未列 session.* 类型
 * 的 no-op 观测（RD-1#9）走 warnUnhandledSessionFrame。（原 streamSubscribe 回调内联 switch
 * 逐字迁移。） */
function handleSessionFrame(
  sid: string,
  chat: ChatStoreInstance,
  sessionStore: SessionStoreLike,
  deps: EnsureStreamSubDeps,
  msg: ServerMessageUnion,
): void {
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
    // [pi1-disposition-chat-flow U2① / D1③] handled 终局通知：命令条目静默清除
    case 'session.deliveryHandled': {
      handleSessionDeliveryHandled(sid, chat, msg)
      break
    }
    // [pi1-disposition-chat-flow U2③ / D10③] extension.error 白名单放行（最小通路）：
    // 仅 errorEvent === 'command' 来源进 toast（同 key 去重 + 限频），其余静默
    case 'extension.error': {
      handleExtensionErrorFrame(sid, msg, deps)
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
    default: {
      // [RD-1#9] 未列 session.* 类型的 no-op 观测（dev，一次/类型）：本分支对
      // session.exited / restored / restoreFailed / commands / stats_update 等帧是
      // 「有意的 no-op」（消费方在 renderer 侧 message bus 或另一订阅面），但旧实现
      // 零痕迹——协议漂移（runtime 新增 session.* 而前端漏接）在 dev 下不可见。
      // Set 去重防刷屏；非 session.* 前缀（app.info / config.* / plugin:* 等全局帧
      // 经同一 streamSubscribe 到达，本就由其他域消费）不 warn，避免误报噪音。
      warnUnhandledSessionFrame(msg.type, sid)
      break
    }
  }
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
    // message.* 帧直推 store（原 D-2/W12 coalescer 合帧层已删：P6 门真机 242 delta
    // enqueue=commit、批大小恒 1，合帧窗口结构性零命中——合帧不产生行为差异，纯空转）。
    // dispatch 错误隔离（RD-1#5，自原 coalescer 非 delta 分支下沉）：applyMessageEvent
    // 链路（→ effects registry）抛错不得沿订阅回调逆传炸掉本 handler（否则后续流式帧
    // 全部丢失），仅 warn 记录后半执行帧，后续帧正常处理。
    if (msg.type.startsWith('message.')) {
      // [消息投递可靠性 A-bash] bashResult 终态帧观测计数（sendBash 的 toast 抑制提示，
      // 不参与投递判定——判定看 RPC 回执）：同步递增先于合帧 dispatch，渲染节拍不影响提示可用性。
      if (msg.type === 'message.bashResult') {
        bashTerminalFrameCounts.set(sid, (bashTerminalFrameCounts.get(sid) ?? 0) + 1)
      }
      // [crash-resilience T4 回流修复] 恢复窗口收口 gate（dispatch 前——同步于流式帧处理
      // 之前插 T4 提示条，保证条目在 assistant 气泡之前；非 message_start 帧 no-op）
      if (msg.type === 'message.message_start') {
        consumeRespawnWindowOnTurnStart(sid, chat, sessionStore, deps)
      }
      try {
        chat.applyMessageEvent(sid, msg)
      } catch (e) {
        // best-effort 降级策略：单帧副作用失败仅 warn 落盘，不逆传中断订阅回调——
        // 后续流式帧继续消费（对齐 useChat 其余 best-effort catch 同一取舍）。
        console.warn(`[useChat] dispatch failed for session ${sid} (${msg.type}) — this frame's side effects may be partial:`, e)
      }
      return
    }
    // session.* → 跨 store 协调（编排细则见 handleSessionFrame）
    handleSessionFrame(sid, chat, sessionStore, deps, msg)
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
 * @returns send/followUp/abort/compact/editAndResend/loadMoreHistory/
 *          hasMoreHistory/disposeSession/sendBash/abortBash
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
   * （send/followUp/editAndResend 三通路共享）。submitSegments 只管「文本化 +
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
   * @param clientUuid          提交前生成的 user message id（`u-<uuid>`），受理确认后
   *                            同 id 上屏气泡（appendUser 显式 id 入参）。用作 segments.json
   *                            主键 + prompt 标记 uuid（建立 clientUuid ↔
   *                            pi userEntryId 映射，extension input hook 剥标记后写 custom
   *                            entry）+ delivery.submit 条目 id（回执/morph/resync 判重锚）
   * @param precomputedPromptText 调用方已算过的 segmentsToPrompt(segments)（非空白——调用方
   *                            !text.trim() 守卫保证）。必传：唯一调用点 submitNewMessage
   *                            恒传；原「缺省时内部兜底重算」的分支无运行时命中且会掩盖
   *                            调用方契约违反（S4 修复目的即消除重复计算），已删。
   * @returns 受理回执 DeliverySubmitReply（[pi1-disposition-chat-flow U2⑤] 调用方消费
   *                            isCommand 命令标志登记命令条目终局操作域；原 pendingSend
   *                            计时器豁免随 30s 空窗 timer 退役）。
   */
  async function submitSegments(
    sessionId: string,
    segments: Segment[],
    clientUuid: string,
    precomputedPromptText: string,
  ): Promise<DeliverySubmitReply> {
    const promptText = precomputedPromptText
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
    const markedPromptText = needsBackfill ? `${promptText}\n${markerLiteral(clientUuid)}` : promptText
    // 图片走路径模式（对齐 pi TUI）：路径已在 promptText 里（segmentsToText 产出裸路径），
    // LLM 自己调 read 工具读。不传 images base64 字段。
    // [u3b/D1] 统一提交：chatApi.send → chatApi.submitDelivery——lane 判定移交 runtime 内核，
    // reply 仅受理确认，权威状态演进经 session.delivery 状态帧（handleSessionDelivery 消费）。
    // [MF-1-2 / ADR-0043] segments 快照随提交上网（仅富消息——与 sidecar 写入同一 needsBackfill
    // 谓词门控）：runtime 按 clientUuid 持有，cancel/drain 回草稿时随全文返回（chips 完整恢复）。
    return await deps.chatApi.submitDelivery(
      sessionId,
      markedPromptText,
      clientUuid,
      undefined,
      needsBackfill ? segments : undefined,
    )
  }

  /**
   * [投递所有权内核 u3b / D1+D7] 统一提交编排：ensureStreamSubscription → submitSegments
   * （delivery.submit）→ **受理回执到达后**气泡上屏（appendUser + inflight 占位 +
   * dispatching 占位）。
   * send / followUp / editAndResend 三通路共享；lane 由 runtime 内核判定，失败原样上抛
   * （无乐观副作用可回滚——气泡/占位在受理确认前不存在），由通路各自分型
   * （send toast 不 throw / followUp 转 false；输入恢复走调用方 restoreSegments 契约）。
   *
   * [ADR-0112 ⑨ UI 跟随事实 / defense-mechanism-cleanup 遗留 5] 受理回执前不上屏等待态
   * 气泡：runtime 确认受理（delivery.submit reply 同步受理确认）才出现气泡——UI 不预测、
   * 不假造中间态。RPC 飞行窗口的用户反馈由 Composer 层 isSending 承担（非消息气泡）。
   *
   * 返回 clientUuid（= 乐观气泡 id = 内核条目 id），供调用方断言/对账。
   */
  async function submitNewMessage(sid: string, segments: Segment[], promptText: string): Promise<string> {
    // clientUuid 前移生成（u-<uuid>）：作为 submitSegments 的条目 id（session.delivery 帧 /
    // 送达回执标记 / morph 的身份锚 + clientUuid ↔ pi userEntryId 映射），受理确认后同一 id
    // 上屏气泡（appendUser 显式 id 入参，气泡 id = 内核条目 id 契约不变）。
    const clientUuid = `u-${crypto.randomUUID()}`
    ensureStreamSubscription(sid, chat, session, subDeps)
    // S4：复用调用方算过的 promptText，避免 submitSegments 内部再调一次 segmentsToPrompt。
    const reply = await submitSegments(sid, segments, clientUuid, promptText)
    // 受理确认到达 → 气泡上屏 + 占位挂账（此后送达回执 message_end(user) ① 标记匹配抵消，
    // D7 direct 车道抵消机制保留）。极端时序守卫：message_end 送达回执先于 submit reply
    // 到达（reply 与事件帧异通道无顺序契约）时投影已 delivered——气泡照常上屏（事实成立），
    // 跳过 inflight 挂账（回执已消费，挂账永无抵消配额——泄漏面）。判定谓词复用
    // findDeliveryEntry 单一实现（[MF-1-4] 禁内联 find 漂移）。
    chat.appendUser(sid, segments, clientUuid)
    if (findDeliveryEntry(sid, clientUuid)?.state !== 'delivered') {
      chat.incrementInflight(sid, 1)
    }
    // dispatching 空窗占位（填 isGenerating 空窗，让停止按钮/输入可用性立即翻转）：
    // message_start 到达自动清；非 direct 车道由 session.delivery 帧的 morph 编排回收；
    // 命令挂起（handled disposition 交互挂起等）由 session.deliveryHandled 终局清
    //（U2①）——事件驱动收口，无墙钟兜底（ADR-0112）。
    chat.addPendingSend(sid)
    // [pi1-disposition-chat-flow U2⑤] 命令条目登记（受理回执 isCommand，内核 D2 识别结果）：
    // handled 通知/孤儿对账的操作域（命令条目 = 永无 message_end 回执的唯一条目族，见
    // handledDeliveryTargets 注）；收尾凭据 = session.deliveryHandled 终局通知（U2①）或
    // 命令失败 toast（U2③）。isCommand 缺省（旧 runtime）= 普通消息，链路零变化。
    // （原 U2⑤ 30s 空窗计时器豁免随计时器整体退役——ADR-0112 时间平抑红线，收口全事件驱动。）
    if (reply.isCommand === true) {
      registerHandledDeliveryTarget(sid, clientUuid)
    }
    return clientUuid
  }

  /**
   * 发送消息：统一 submit（乐观气泡 + delivery.submit）。
   *
   * [R2-A5 失败信号] 返回值（Promise<boolean>）：true = 提交成功或无事
   * 发生（空输入/空白 prompt 早退——无投递动作、无丢失面，调用方无需恢复）；false =
   * RPC 失败（内部已消化——transport 级 toast、hook 否决级经 runtime 错误气泡抑制
   * toast；乐观副作用已回滚）——调用方（dispatch send）据
   * `=== false`（严格比较——false = RPC 失败需恢复草稿）restoreSegments
   * 恢复草稿。不 throw（W2「内部消化」契约不变）。
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
  async function send(sessionId: string, segments: Segment[]): Promise<boolean> {
    const sid = sessionId
    if (segments.length === 0) return true
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
      // 定向通路失败信号同契约传递（内部已 toast，false = 输入未消费可恢复）
      return sendSubagentDirective(sid, segments, subagentSeg)
    }
    const promptText = segmentsToPrompt(segments)
    if (!promptText.trim()) return true

    // [u3b/D1] 统一 submit：乐观气泡 + delivery.submit（失败 toast 不 throw——错误已消化，
    // 消费侧 Composer.onSend 的 catch 不再触发；throw 只会变 unhandled rejection）。
    // toast 抑制判别（msg-pipeline-debloat D4-2，对齐 sendBash/compact 既有接法）：
    // message_blocked（BeforeSend hook 否决）= runtime dispatcher 已广播 message.error
    // 错误气泡（乐观回滚已由 submitNewMessage catch 完成）——再弹 toast 属同一失败
    // 双提示，抑制；transport 级（断连/超时/未知码）保守 toast 兜底。
    try {
      await submitNewMessage(sid, segments, promptText)
      return true
    } catch (e) {
      if (isTransportLevelFailure(e, [BLOCKED_CLASSIFIED_CODE])) {
        const msg = toErrorMessage(e)
        deps.toast.error(deps.t('composable.sendFailed', { msg }))
        return false
      }
      console.warn(`[useChat] send RPC failed (classified envelope, toast suppressed, sid=${sid})`, e)
      return false
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
   * [R2-A5 失败信号] 返回 boolean 与 send 同契约：true = 提交成功；false = 空文本挡/
   * RPC 失败（内部已 toast，输入未消费——send 分流点原样透传给调用方恢复草稿）。
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
  ): Promise<boolean> {
    // subagent 段序列化为空串（shared/segments 路由标记），segmentsToPrompt 即
    // 其余段序列化：file → path(:L 范围)、session → #sessionId、image → 裸路径。
    const text = segmentsToPrompt(segments)
    // 空文本挡：纯 chip（或仅空白文本）时 text 为空白串，extension 无从处理——
    // 可读错误 + 不发 RPC（防御：上游 canSend 守卫通常已拦，此处兜底保证不静默）。
    // trim 判断必须显式：segmentsToPrompt 已去 trim 保真（Gate B 观测①修复），
    // 纯空白文本若不在此拦会直发 RPC。
    if (!text.trim()) {
      deps.toast.error(deps.t('composable.subagentDirectiveEmpty'))
      return false
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
      return true
    } catch (e) {
      // RPC 失败（WS 断连 / extension 报「subagent 已结束」等）：toast 明确提示，
      // 消息不静默丢失（S8：留在输入区或明确失败提示——此处为后者，与 send 失败同款）。
      const msg = toErrorMessage(e)
      deps.toast.error(deps.t('composable.subagentDirectiveFailed', { msg }))
      return false
    }
  }

  /**
   * 追加 follow-up——[u3b/D1] 统一 submit 化（内核 queued 车道承接「当前回合
   * 结束后另起一轮」语义）。
   * 非执行中按普通发送处理（避免 Alt+⏎ 死键）。
   *
   * [R2-A5 失败信号] 返回值（Promise<boolean>）：true = 提交成功或无事
   * 发生（空输入/空白 prompt 早退无丢失面）；false = RPC 失败（内部已消化 + 回滚乐观
   * 副作用，不 throw——transport 级 toast、hook 否决级经 runtime 错误气泡抑制 toast）
   * ——调用方（composer submit.onFollowUp）据 `=== false`
   * restoreSegments 恢复草稿，否则 clearInput 已清空的输入静默丢失。
   *
   * 显式接收 sessionId：与 send 同理，per-panel 隔离。
   */
  async function followUp(sessionId: string, segments: Segment[]): Promise<boolean> {
    const sid = sessionId
    if (segments.length === 0) return true
    const promptText = segmentsToPrompt(segments)
    if (!promptText.trim()) return true

    // 非活跃（含空窗期）退化为普通发送，避免 Alt+⏎ 死键（失败信号原样透传 send 契约）
    if (!chat.isActive(sid)) {
      return send(sid, segments)
    }

    try {
      await submitNewMessage(sid, segments, promptText)
      return true
    } catch (e) {
      // toast 抑制判别同 send（D4-2）：message_blocked = runtime 已广播错误气泡，
      // 抑制 toast；transport 级保守 toast 兜底。
      if (isTransportLevelFailure(e, [BLOCKED_CLASSIFIED_CODE])) {
        const msg = toErrorMessage(e)
        deps.toast.error(deps.t('composable.nextTurnSendFailed', { msg }))
        return false
      }
      console.warn(`[useChat] followUp RPC failed (classified envelope, toast suppressed, sid=${sid})`, e)
      return false
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
   * [R2-A5 失败信号] 返回值（Promise<boolean>）：true = RPC 受理成功；false = RPC 失败
   * （内部已 toast 或终态帧已呈现故抑制 toast）——调用方（dispatch bash）据 `=== false`
   * 留痕输入未恢复（restoreInput 待壳层注入）。早退无。
   *
   * [消息投递可靠性 A-bash] 返回值（Promise<boolean>）契约（与 send 同语义）：
   *   false = 可证明命令未执行（调用方恢复 !command 草稿安全）——RPC 回执
   *     status==='rejected'（busy 预检拒绝 / 空命令不变式 / restore 失败 / 消息未送达
   *     runtime）。bash 无乐观面可回滚（气泡由 bashStart/bashResult 帧驱动、executingBash
   *     由帧置/清、本函数零 appendUser/零 inflight/零 pendingSend）→ 回滚对象结构性为空、
   *     无悬空标记。
   *   true = 命令已执行或可能已执行（调用方不得恢复 !command——恢复后用户重发即命令双
   *     执行）：① 回执 status 为 'started'/'settled'（权威回执证明已执行）；② 回执不可达
   *     （catch：断连 rejectAll / backstop 超时 / pending 驱逐）——无法证明未执行，保守按
   *     已执行处置（误判「未执行」恢复草稿 = 双执行；误判「已执行」最坏是草稿不恢复需重输，
   *     方向性取舍：双执行是更严重错误）。
   * 判定只看 RPC 回执（BashDispatchReceipt）：bashStart/bashResult 帧与帧观测计数是可丢弃
   * 的呈现信号（仅作 toast 抑制提示），帧丢失不得导致「未执行」误判。
   * 不 throw（W2 家族契约不变）。
   *
   * 显式接收 sessionId：per-panel 隔离，不读全局 activeId。
   */
  async function sendBash(sessionId: string, command: string, excludeFromContext: boolean): Promise<boolean> {
    const sid = sessionId
    ensureStreamSubscription(sid, chat, session, subDeps)
    // [消息投递可靠性 A-bash] 帧观测基线：toast 抑制提示判据（不参与投递判定）
    const bashFramesAtEntry = bashTerminalFrameCounts.get(sid) ?? 0
    const terminalFrameRendered = (): boolean => (bashTerminalFrameCounts.get(sid) ?? 0) > bashFramesAtEntry
    try {
      const receipt = await deps.chatApi.bash(sid, command, excludeFromContext)
      if (receipt.status === 'rejected') {
        // 未执行（回执权威判定）→ false 交调用方恢复 !command 草稿（安全：不会双执行）。
        // busy 预检的用户反馈由 send.rejected handler 的 toast 承担（不重复弹）；其余
        // rejected 形态（restore 失败等）回执带 error，此处 toast 不静默。
        if (receipt.error) {
          deps.toast.error(deps.t('composable.bashFailed', { msg: receipt.error }))
        }
        return false
      }
      // 'started' | 'settled'：已执行 → true（恢复 !command 会双执行）。失败原因可见提示；
      // 终态帧已渲染时抑制（气泡终态是权威呈现面——超时三步指引或错误输出，再弹「失败」
      // 措辞 toast 冗余且误导），①b 抑制极性不变。
      if (receipt.error && !terminalFrameRendered()) {
        deps.toast.error(deps.t('composable.bashFailed', { msg: receipt.error }))
      }
      return true
    } catch (e) {
      // 回执不可达（已送出但 reply 没回来：断连 rejectAll / renderer backstop 超时 /
      // pending 驱逐）：命令可能已执行 → 保守 true（调用方不恢复草稿，防双执行）。
      // 「可证明未执行」的传输失败（消息未送达 runtime）已在端口层翻译为 rejected 回执，
      // 不会走到此分支。toast 用「状态未知」诚实措辞（不得说「失败」——那会诱导用户重发）。
      console.warn(`[useChat] sendBash receipt unavailable (command may have executed), sid=${sid}`, e)
      const msg = toErrorMessage(e)
      if (!terminalFrameRendered()) {
        deps.toast.error(deps.t('composable.bashOutcomeUnknown', { msg }))
      }
      return true
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
   * 错误反馈（msg-pipeline-debloat D4-2 分类码路由）：按 error envelope 分类码判别 toast
   * 抑制，不依赖 compaction_end 与 RPC reply 的到达顺序。
   *   - compact_busy（dispatcher busy 预检拒绝）：对话流 system 提示已由 runtime stream_warn
   *     编排 → 抑制 toast。
   *   - compact_failed（pi 层失败 / ensureActive 恢复失败）：interpreter 对话流（compaction
   *     级，含 aborted 取消语义）或 session 状态面已呈现 → 抑制 toast。
   *   - 其余（未知分类码 / pending 机械码 timeout·overflow·unknown / 无码断连）：runtime
   *     侧呈现未发生，保守 toast 兜底（AGENTS.md 规则 #3 错误必须可见）。
   * 不 throw（consumer fire-and-forget）。compacting 态由 session.compacted 复位（interpreter 发，必达）。
   * [R2-A5 失败信号] 返回值（Promise<boolean>）：true = RPC 受理成功；false = RPC reject
   * （分类码级 / transport 级均算——错误面已按上述路由消化）——调用方（dispatch send
   * 的 /compact 分支）据 `=== false` restoreSegments 恢复草稿。
   *
   * 显式接收 sessionId：per-panel 隔离，不读全局 activeId。
   */
  async function compact(sessionId: string, customInstructions?: string): Promise<boolean> {
    const sid = sessionId
    ensureStreamSubscription(sid, chat, session, subDeps)
    try {
      await deps.chatApi.compact(sid, customInstructions)
      return true
    } catch (e) {
      if (isTransportLevelFailure(e, COMPACT_CLASSIFIED_CODES)) {
        // transport 级失败：runtime 侧无分类码呈现，toast 兜底。分类码级失败由 runtime
        // 编排的呈现面（对话流 / session 状态）承担，不在此 toast。
        const msg = toErrorMessage(e)
        deps.toast.error(deps.t('composable.compactFailed', { msg }))
        console.warn(`[useChat] compact RPC failed (transport-level, toast fallback)`, e)
      } else {
        console.warn(`[useChat] compact RPC failed (classified envelope, toast suppressed, surfaced via runtime-orchestrated channels)`, e)
      }
      return false
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
   * [R2-A5 失败信号] 返回值（Promise<boolean>）：true = 提交成功或无事发生（空白 prompt/
   * active session 早退无丢失面）；false = RPC 失败（内部已消化——transport 级 toast、
   * hook 否决级经 runtime 错误气泡抑制 toast）。
   *
   * 显式接收 sessionId：编辑可发生在非 active 的 standby panel，不能依赖全局 activeId。
   *
   * 孤立 sidecar 条目：editAndResend 写新 clientUuid 条目，旧消息（truncateFrom 截断的）
   * 的 sidecar 条目残留。不影响功能（重开按 piEntryId→clientUuid 精确匹配，孤立条目不引用），
   * 占少量磁盘（~200B/条）。完整清理随 session 删除/压缩统一治理（YAGNI，不在本函数做）。
   */
  async function editAndResend(sessionId: string, userMessageId: string, segments: Segment[]): Promise<boolean> {
    const promptText = segmentsToPrompt(segments)
    if (!promptText.trim() || chat.isActive(sessionId)) return true
    chat.truncateFrom(sessionId, userMessageId, true)
    // [u3b/D1] 与 send 同一统一 submit 编排（乐观气泡 + inflight 占位 + delivery.submit）：
    // 编辑重发同样持有确认配额（其 message_end 走 ① 标记匹配回收），失败统一回滚。
    try {
      await submitNewMessage(sessionId, segments, promptText)
      return true
    } catch (e) {
      // [W2] 错误处理策略与 send/followUp/abort 对齐：不 throw（消费侧 Turn.vue submitEdit
      // 无 try/catch，throw 只会变 unhandled rejection）。错误呈现同 send 的分类码路由
      // （D4-2）：message_blocked（hook 否决）= runtime 已广播错误气泡，抑制 toast；
      // transport 级保守 toast 兜底。
      if (isTransportLevelFailure(e, [BLOCKED_CLASSIFIED_CODE])) {
        const msg = toErrorMessage(e)
        deps.toast.error(deps.t('composable.sendFailed', { msg }))
        return false
      }
      console.warn(`[useChat] editAndResend RPC failed (classified envelope, toast suppressed, sid=${sessionId})`, e)
      return false
    }
  }

  /**
   * [U5 消息撤回 D6] 统一撤回编排：在途 / 已送达双态路由 + reply 消费（fire-and-forget，
   * 不 throw——错误全部经 toast 消化，与 abort/compact 同契约）。编排体在模块级
   * handleRevokeMessage（handleSessionDelivery 同款形态——factory 保持行数门禁内）。
   */
  function revokeMessage(sessionId: string, targetId: string): Promise<void> {
    return handleRevokeMessage(sessionId, targetId, chat, deps)
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
 * 现有消息（catch 吞错，用户可重试）。
   *
   * [RD-1#4] 失败显形：返回 false（原 void 签名）——失败时分区与 truncated 窗口均不变
   * （「已到头」与「失败」在窗口状态上不可区分，旧签名让调用方只能静默复位 loading，
   * 用户侧症状 = 「点了没反应、无失败提示」）。调用方（useLoadMoreHistory）据此落
   * loadMoreError 态，由对话流顶部条渲染可重试错误行。
   *
   * @returns true = 本次翻页成功（含空页/到头语义，窗口状态已收敛）；
   *          false = 失败（RPC 抛错 / 游标缺失），分区与窗口状态均未变，可重试。
   */
  async function loadMoreHistory(sessionId: string): Promise<boolean> {
    try {
      const oldest = chat.getMessages(sessionId)[0]
      const cursor = oldest ? (oldest.piEntryId ?? oldest.id) : undefined
      if (cursor === undefined) {
        // 分区为空却请求翻页（理论不可达：truncated=true 时分区非空）——防御短路
        console.warn(`[useChat] loadMoreHistory skipped for session ${sessionId}: empty partition (no cursor anchor)`)
        return false
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
      return true
    } catch (e) {
      // best-effort 降级：失败不破坏现有消息（分区与 truncated 窗口均不变），用户可重试；
      // false 返回值让调用方显形（useLoadMoreHistory 落 loadMoreError，RD-1#4）。
      console.warn(`[useChat] loadMoreHistory failed for session ${sessionId}:`, e)
      return false
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
    // [u4d] 截断窗口状态由下方 chat.disposeSession 内统一清理（store 分区），无需单独清
    // [投递所有权内核 u3b] 清内核投影 + morph 段（session 已销毁，帧/回执不再有意义）
    clearDeliveryProjection(sessionId)
    // [消息投递可靠性 A-bash] 帧观测计数随 session 销毁回收（防 Map 永久增长 + 跨 session 误判）
    bashTerminalFrameCounts.delete(sessionId)
    // [pi1-disposition-chat-flow U2] 命令条目登记表随 session 销毁回收（session 已删除，
    // handled/孤儿清除不再有意义）
    handledDeliveryTargets.delete(sessionId)
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
    followUp,
    abort,
    compact,
    editAndResend,
    revokeMessage,
    loadMoreHistory,
    hasMoreHistory,
    disposeSession,
    sendBash,
    abortBash,
    // [u5a 退役] 前身 clearQueueState 转发（forceQuit 清 pi queue_update 快照）已删：
    // queueStates 分区及其读写面随本单元退役，pi 槽位回收由 delivery.drain 承担（u3c）。
    // 队列区数据源 = session.delivery 投影（disposeSession → clearDeliveryProjection 清理）。
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
 * 不清 chat store 分区/截断窗口状态等业务状态。
 */
export function invalidateStreamSubscription(sessionId: string): void {
  const unsub = streamSubscriptions.get(sessionId)
  if (unsub) {
    unsub()
    streamSubscriptions.delete(sessionId)
  }
  // invalidateSubscription（非 clearSubscription）：额外清 in-flight 去重条目，防 respawn 后
  // 首次 ensureStreamSubscription 复用死 Promise 而不重发 subscribe RPC
  invalidateSubscription(sessionId)
}
