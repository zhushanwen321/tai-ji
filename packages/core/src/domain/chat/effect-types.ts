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
} from '@taiji/shared'
import type { RetryState, FinalizeReason } from './store-types'
import type { MessagesRef } from './mutations'

/**
 * message.* 事件副作用上下文（store refs + 跨方法回调，模块级函数据此更新）。
 *
 * - messages/retryStates：原 ChunkContext，chunk 状态写入目标（[u5a] queueStates 维度退役）。
 * - applyFileChanges/markChangeSetsSuperseded：原 ChunkContext 回调（store 内合并逻辑）。
 * - finalizeSession + clearPendingSend：统一收口出口（替代 setStreaming flag 翻转）。
 */
export interface MessageEffectContext {
  /** D-1 容器范式：读数组需 `.value.get(sid)?.value ?? []`（内层是 per-session ShallowRef） */
  messages: MessagesRef
  retryStates: { value: Map<string, RetryState> }
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
  /**
   * 追加 user 消息（Segment[]，ADR-0043）。
   * 可选 id：提供则气泡沿用该 id，缺省自生成 `u-<uuid>`。保号消费方 = 送达回执的两分支
   * 入流（① morph 段 / ② 外来纯文本降级，effects/user-delivery）——重建气泡沿用提交时
   * clientUuid，使 live 窗口（未刷新，reconcile 仅切入/重试触发）的已送达消息可按
   * clientUuid 定位（消息撤回入口的结构前提：换号不在映射、不匹配文件末尾标记，撤回
   * 定位双通道会构造性 miss）。乐观插入（统一提交）不传 id，保持自生成现行为。
   * [B1 退役] 前身 queue_update 计数腿（drainN/reconcilePending）已随投递所有权内核删除。
   */
  appendUser: (sessionId: string, segments: Segment[], id?: string) => string
  /**
   * [W21] 重构 entry 喂 store 内 per-session reducer state（applyEntry）。
   * message_end / tool_call_end 等 entry 载体帧的 handler 经此把实时 feed 喂入与文件重放
   * （get_entries → replayEntries）同一个 reducer——effects 退化为 reducer 薄封装（状态类
   * 全走 reducer，副作用类保留 effect）。实现在 store.applyEntryFrame。
   */
  applyEntryFrame: (sessionId: string, entry: PiEntry) => void
  /**
   * [steer-bubble u0 / D2] per-session
   * inflight 投递确认计数读写——语义 = **已挂账待确认的投递数**（统一提交的乐观气泡其
   * 确认帧 message_end(user) 未到）。不变式 ≥ 0（decrement 钳制，配额漂移不产生负值），
   * 正常路径逐投递归零。实现在 store（getInflight 等）。
   */
  /** 读 per-session inflight 计数（无记录 = 0）。 */
  getInflight: (sessionId: string) => number
  /** inflight -= n（默认 1；message_end(user) 确认 / send 失败回滚）。钳制 ≥ 0，归零删条目。 */
  decrementInflight: (sessionId: string, n?: number) => void
  /** inflight 清零（abort（message.complete{aborted}）挂点，D4：确认基线随队列作废）。幂等。 */
  clearInflight: (sessionId: string) => void
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
