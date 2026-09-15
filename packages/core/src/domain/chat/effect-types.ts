/**
 * message.* 事件 effect 类型（从 renderer chat-message-effects.ts 提前抽取，IF2）。
 *
 * 抽取动机：bash-effects.ts 的 bashStartEffect/bashResultEffect 参数依赖
 * MessageEffectContext/MessageEffectHandler，原定义在 renderer chat-message-effects.ts
 * （w3 才拆）。为让 bash-effects.ts 能迁入 core 且单一来源，把这两个类型提前抽到此文件。
 * renderer chat-message-effects.ts 改 import type from '@taiji/core' + re-export。
 *
 * 内容原样搬迁（含注释），零语义改动。
 */
import type {
  ChangeSetStatus,
  FileChange,
  PiEntry,
  Segment,
  SteerFollowUpMode,
} from '@taiji/shared'
import type { RetryState, QueueState, FinalizeReason } from './store-types'
import type { MessagesRef } from './mutations'

/**
 * message.* 事件副作用上下文（store refs + 跨方法回调，模块级函数据此更新）。
 *
 * - messages/retryStates/queueStates：原 ChunkContext，chunk 状态写入目标。
 * - applyFileChanges/markChangeSetsSuperseded：原 ChunkContext 回调（store 内合并逻辑）。
 * - finalizeSession + clearPendingSend：统一收口出口（替代 setStreaming flag 翻转）。
 */
export interface MessageEffectContext {
  /** D-1 容器范式：读数组需 `.value.get(sid)?.value ?? []`（内层是 per-session ShallowRef） */
  messages: MessagesRef
  retryStates: { value: Map<string, RetryState> }
  queueStates: { value: Map<string, QueueState> }
  /** file_changes case 调 store.applyFileChanges（合并逻辑在 store 内） */
  applyFileChanges: (
    sessionId: string,
    messageId: string,
    changes: FileChange[],
    changeSetStatus: ChangeSetStatus,
    isFullSet: boolean,
  ) => void
  /** changeSetInvalidated case 调 store.markChangeSetsSuperseded（commit 后旧卡片过期） */
  markChangeSetsSuperseded: (sessionId: string) => void
  /** 统一收口出口（替代 setStreaming）。终态 handler 调。
   *  reason 决定终态映射；handler 自己改 entity status 后调此方法（幂等：entity 已终态则 no-op，
   *  只清 pendingSend + timer）。errorText 可选：error/stream_error 时写入。 */
  finalizeSession: (sessionId: string, reason: FinalizeReason, errorText?: string) => void
  /** message_start 清空窗（替代 setStreaming 隐式清 dispatching）。 */
  clearPendingSend: (sessionId: string) => void
  /** message_start 挂载 streaming 超时兜底 timer（防 complete 永不到的 pi 静默卡死）。 */
  armStreamingTimer: (sessionId: string) => void
  /**
   * 追加 user 消息（Segment[]，ADR-0043）。
   * m2 阶段 queue_update 投递时经 drainN 计数 FIFO 取 segments 后 appendUser 进对话流。
   */
  appendUser: (sessionId: string, segments: Segment[]) => string
  /**
   * [W14] queue_update 投递信号：计数 FIFO 取前 n 条 pending segments（D1 表末行 + D6）。
   * 不按文本匹配——pi 入队存 skill 展开后文本 ≠ 提交原文，文本相等匹配必挂。
   * queue_update handler 经 countDrained 差集算出被投递条数 N，调 drainN(sid, mode, N)。
   */
  drainN: (sessionId: string, sendMode: SteerFollowUpMode, n: number) => Segment[][]
  /**
   * [W14] 深度结构性对账（D6：深度权威 = pi pendingMessageCount，经帧数组 steering/followUp
   * 等值投影——pendingMessageCount 字段本身投递侧裁剪移除后前端已无直接消费方）——偏差时
   * 全量重对 pendingBuffer（见 store.reconcilePending）。
   * [steer-bubble u2 / D4] 投递侧（queue_update 每帧）调用已移除（会吃掉腿 2 还没回填的
   * segments，F3 不可逆放大器）；现调用点：G-023 时点（message_start(assistant)）僵尸清理
   * （传快照深度；abort 不再调用——pi abort 不清队列，buffer 随 pi 保留，D4 修订 2026-08-30）。
   */
  reconcilePending: (sessionId: string, depth: number) => void
  /**
   * [W21] 重构 entry 喂 store 内 per-session reducer state（applyEntry）。
   * message_end / tool_call_end 等 entry 载体帧的 handler 经此把实时 feed 喂入与文件重放
   * （get_entries → replayEntries）同一个 reducer——effects 退化为 reducer 薄封装（状态类
   * 全走 reducer，副作用类保留 effect）。实现在 store.applyEntryFrame。
   */
  applyEntryFrame: (sessionId: string, entry: PiEntry) => void
  /**
   * [steer-bubble u0 / docs/design/steer-followup-user-bubble-display.md D2] per-session
   * inflight 投递确认计数读写——语义 = **已显示待确认的投递数**（steer/followUp 气泡已
   * 进对话流或 send 乐观插入，其确认帧 message_end(user) 未到）。不变式 ≥ 0（decrement
   * 钳制，配额漂移不产生负值），正常路径逐投递归零。实现在 store（getInflight 等），
   * 本单元只注入契约，消费接线归 u1（message_end 确认 −1）与 u2（腿 1 消费 +m /
   * abort 清零）。
   */
  /** 读 per-session inflight 计数（无记录 = 0）。 */
  getInflight: (sessionId: string) => number
  /** inflight += n（默认 1；腿 1 消费按 drainN 实取数传 m，send 乐观插入 +1）。n ≤ 0 no-op。 */
  incrementInflight: (sessionId: string, n?: number) => void
  /** inflight -= n（默认 1；message_end(user) 确认 / send 失败回滚）。钳制 ≥ 0，归零删条目。 */
  decrementInflight: (sessionId: string, n?: number) => void
  /** inflight 清零（abort（message.complete{aborted}）挂点，D4：确认基线随队列作废）。幂等。 */
  clearInflight: (sessionId: string) => void
  /**
   * [premature-timeout §5.2 D2] 读并清 per-session timeout 打标 id 快照（恢复消费口，时机①）。
   * message.complete handler 恢复分支据此定位「仍处 timeout error 态」的误判收口实体；
   * 无快照返回空集。实现在 streaming-state-machine（finalizeMessages 现场记录）。
   */
  takePrematureTimeoutIds: (sessionId: string) => ReadonlySet<string>
  /**
   * [premature-timeout §5.2 D2] 清 per-session 打标快照（message_start 新 turn 作废旧标，时机③——
   * 防跨 turn 错配：旧 turn 打标未恢复，新 turn 开始后其 complete 不得恢复旧气泡）。幂等。
   */
  clearPrematureTimeoutIds: (sessionId: string) => void
}

/**
 * 单个 message.* type 的 effect handler。
 *
 * 签名约定：接收上下文 + sessionId + payload，内部执行该 type 的全部副作用
 * （chunk 状态更新 + lifecycle flag）。返回值无意义（统一 void）。
 *
 * payload 类型：ADR-0016 类型基础。ServerMessageMap 对多数 message.* 用
 * Record<string, unknown> 占位（未收紧），handler 内用 readString 等安全窄化，
 * 与原 applyChunk 完全一致（不引入 any）。
 */
export type MessageEffectHandler = (
  ctx: MessageEffectContext,
  sessionId: string,
  payload: Record<string, unknown>,
) => void
