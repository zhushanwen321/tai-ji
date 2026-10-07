/**
 * domain/chat —— chat 域内聚模块（P3 strangler 迁移）。
 *
 * 组成：
 * - store-types.ts：共享类型基座（RetryState/FinalizeReason）
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
// [投递所有权内核 u3b] session.delivery 投影消费口（D7——队列区/气泡 morph 单一数据源，
// u3c QueueBubble 单源化消费；响应式读口 getDeliveryProjectionRef）
// findDeliveryEntry：撤回「在途条目」判定谓词（[MF-1-4] UserBubble / useChat 共享单点）
export {
  getDeliveryProjectionRef,
  findDeliveryEntry,
} from './effects/user-delivery'
export type { DeliveryFrameEntry, DeliverySubmitReply } from './api-port'
// [remote-use D5] lifecycle-effects factory：exited/restored/restoreFailed 的 core 最小语义
// 原语集合（双壳共享单一归属——桌面 useMessageEffects 叠壳扩展 / 移动壳 bootstrap 直接接线）
export { createLifecycleEffects } from './lifecycle-effects'
export type {
  LifecycleEffects,
  LifecycleEffectsDeps,
  LifecycleSessionActions,
  LifecycleNoticeTexts,
} from './lifecycle-effects'

// [remote-use D7/U20] 队列条目过滤谓词下沉（双壳同源：桌面 useQueueRows/ActivityStrip
// 改引本导出，移动壳队列条随同源；防第二定义点）
export * from './queue-projection'
export { createChatStore } from './store'

export type { ChatStoreOptions } from './store'
// [session-occupancy u5b] occupancy 投影类型（sessionPhase 数据源，P4 ActivityStrip/发送位消费）
export type { SessionOccupancyState } from './store'
export * from './derive-status'
// [session-dead C1 方案一] turn 进展观测面（设计 §3.3 D6/D7：结构事件边界派生计时 + ask_user 豁免）
export { createStreamingStateMachine, type StreamingStateMachineDeps, type SubagentStreamStateSnapshot, type SubagentStreamChunk } from './streaming-state-machine'
export type { ChatStoreInstance, ChatStoreReaders, ChatStoreOps } from './store'
// w5 chat-use-chat：useChat composable 迁移（createUseChat factory + ChatApiPort）
// w6 chat-ui-and-shell：chat 域纯逻辑（turn 分组/摘要）迁入
export * from './message-turns'
export * from './turn-aggregates'
export * from './summarize-turn'
export * from './trace-window'

export { createUseChat, ensureStreamSubscription, invalidateStreamSubscription, resetChatModuleStateForTest } from './useChat'
// [投递所有权内核 u3b] submitQueuedEntry / SubmitQueuedEntryDeps 已随 defer flush 退役摘除
export type { UseChatDeps, EnsureStreamSubDeps, SessionStoreLike } from './useChat'
// [remote-use D2/U5] 驱逐退订复合入口：sessionEntry.evictLru 双壳共接（evictIfNeeded +
// invalidateStreamSubscription + session.unsubscribe RPC 编排单点）
export { evictLruWithUnsubscribe } from './useChat'
export type { LruUnsubscribeDeps } from './useChat'
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
