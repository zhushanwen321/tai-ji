/**
 * domain/chat —— chat 域内聚模块（P3 strangler 迁移）。
 *
 * 组成：
 * - store-types.ts：共享类型基座（RetryState/QueueState/FinalizeReason）
 * - mutations.ts：messages ref 不可变写入 helper（commitMessages/deleteMessages/truncateMessagesFrom/prependHistory）
 * - readers.ts：payload 窄化纯函数（readString/readRecord/.../readChangeSetStatus）
 *
 * 本目录为「原样迁移」（内容不动，仅改归位），语义由 __tests__/ 行为测试锁定。
 * 后续 wave：store.ts（chat store factory）、effects/、useChat.ts 等陆续迁入。
 */
export * from './store-types'
export * from './mutations'
export * from './readers'
export * from './lru'
export * from './changeset'
export * from './handoff'
export * from './chunk-processor'
export * from './bash-effects'
export * from './effect-types'
export * from './truncate-tool-output'
export { dispatchMessageEvent } from './effects/registry'
// [session-occupancy u4a] message_end(user) 三分支 ① 机制（defer 队列 provider 注入点）
export { setCompactQueueProviderForEffects, resetCompactQueueProviderForEffectsForTest } from './effects/user-delivery'
// [簇 A2] defer flush 投递确认标记正则（SSOT = apply-entry-convert，显示层剥标记 import 用）
export { DEFER_FLUSH_MARKER_RE } from './apply-entry-convert'
export type { CompactQueueLike, CompactQueueEntrySnapshot } from './useChat'
export { createChatStore } from './store'

export type { ChatStoreOptions } from './store'
// [session-occupancy u5b] occupancy 投影类型（sessionPhase 数据源，P4 ActivityStrip/发送位消费）
export type { SessionOccupancyState } from './store'
export * from './derive-status'
// [session-dead C1 方案一] turn 进展观测面（设计 §3.3 D6/D7：结构事件边界派生计时 + ask_user 豁免）
export { createStreamingStateMachine, type StreamingStateMachineDeps } from './streaming-state-machine'
export type { ChatStoreInstance, ChatStoreReaders, ChatStoreOps } from './store'
// w5 chat-use-chat：useChat composable 迁移（createUseChat factory + ChatApiPort）
// w6 chat-ui-and-shell：chat 域纯逻辑（turn 分组/摘要）迁入
export * from './message-turns'
export * from './turn-aggregates'
export * from './summarize-turn'
export * from './trace-window'

export { createUseChat, ensureStreamSubscription, invalidateStreamSubscription, resetChatModuleStateForTest } from './useChat'
// [session-occupancy u4b] defer 队列 flush 逐条提交入口（D5.1 send/steer 等价编排）
export { submitQueuedEntry } from './useChat'
export type { UseChatDeps, EnsureStreamSubDeps, SubmitQueuedEntryDeps, SessionStoreLike } from './useChat'
// [u4d-truncated-ui] 历史预算截断窗口状态（D4：store SSOT + 响应归一；use-session 切入链消费归一函数）
export { historyWindowFromReply } from './truncated-window'
export type { HistoryWindow, HistoryWindowReply } from './truncated-window'
// [D6-⑨ u7-memory-governance] toolResult 图片落盘编排（core 侧记账/顺序编排；落盘执行方在 main）
export {
  collectImagesFromMessages,
  disposeImageCacheForSession,
  getCachedImagePath,
  isSessionImageCacheFull,
  persistImagesNewestFirst,
  requestImageWrite,
  setImageCacheWritePort,
  _resetImageCacheForTest,
  type ImageCacheWritePort,
} from './image-cache'
export type { ChatApiPort, WriteSegmentsFn } from './api-port'
// w20 apply-entry：chat 视图态 reducer（D5 单一 reducer 双路喂入——重放侧）。
// 自包含纯函数模块（只依赖 @taiji/shared），供 runtime wire 层与 core store（W21）共用。
export {
  applyEntry,
  replayEntries,
  createInitialChatViewState,
} from './apply-entry'
export type {
  PiEntry,
  PiEntryBase,
  PiMessageEntry,
  PiMessageBody,
  PiCustomEntry,
  PiLabelEntry,
  PiCompactionEntry,
  PiBranchSummaryEntry,
  PiCustomMessageEntry,
  ChatViewState,
} from './apply-entry'
