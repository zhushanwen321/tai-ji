/**
 * chat store 共享类型（从 chat.ts 提取，供 chunk-processor 等模块引用，避免循环依赖）。
 */

/**
 * 自动重试运行态（W06-B）。auto_retry_start 设置，auto_retry_end 清空。
 * 对应 event-adapter message.auto_retry_start payload（attempt/maxAttempts/delayMs/errorMessage）。
 */
export interface RetryState {
  attempt?: number
  maxAttempts?: number
  delayMs?: number
  errorMessage?: string
}

/**
 * 消息队列运行态（W06-B）。auto_retry 与 steer/follow_up 排队无关；
 * queue_update 反映 pi 队列里的 steering（steer 排队）和 followUp（follow-up 排队）。
 */
export interface QueueState {
  steering?: string[]
  followUp?: string[]
}

/**
 * finalizeSession 收口原因（与 system-arch §5 reason 字段对齐）。
 *
 * reason → 终态映射（finalizeSession 内部不变式）：
 *   normal       → message:complete, toolCall:end_not_received（诚实态，迟到 tool_call_end 覆盖到 completed）
 *   aborted      → message:complete, toolCall:end_not_received（同上，D-008 message 保持 complete）
 *   stream_error → message:error,     toolCall:error
 *   error        → message:error,     toolCall:error
 *   timeout      → message:error,     toolCall:end_not_received
 *   disconnect   → message:error,     toolCall:end_not_received
 *   restart      → message:error,     toolCall:end_not_received
 */
export type FinalizeReason =
  | 'normal'
  | 'aborted'
  | 'stream_error'
  | 'error'
  | 'timeout'
  | 'disconnect'
  | 'restart'
