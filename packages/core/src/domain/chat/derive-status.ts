/**
 * deriveStatus 派生逻辑（纯函数，renderer-model M3 搬迁归位）。
 *
 * 原位于 renderer `composables/logic/sessionStatus.ts`（D6 → 方案 C 优化版 9 态），
 * 2026-07-02 架构返工 C3 下沉到 renderer logic 层；M3 继续下 core：
 * 它是纯函数（读 chat store 分区），不依赖任何 composable 闭包 / 副作用，归 core 域。
 * renderer 保留 re-export（sessionStatus.ts / types.ts）转发，消费方 import 路径零改动；
 * DOT_CLASS / STATUS_ICON 等视觉映射（CSS 类属展示层）仍留 renderer。
 *
 * 派生信号 → DerivedStatus 映射依据（9 态）。
 * 优先级：waiting > retrying > compacting > streaming > working > pending > error > stopped > done。
 *
 * - toolCall.status 'running' → waiting（tool 执行中/待审批，agent 暂停）
 * - hasFormOverlayPending → waiting（富交互表单等用户输入，agent 阻塞；走 extension.ui_request
 *   通道不产生 toolCall running，需独立判定，与 toolCall waiting 并列最高优先级）
 * - chat.retryStates 存在 → retrying（自动重试中）
 * - isCompacting → compacting（上下文压缩中）
 * - isGenerating 或 Message.status 'streaming' → streaming（文本流式）
 * - hasBackgroundWork → working（主 turn 结束但有 background subagent/workflow 仍在跑）
 * - isActive（仅 pendingSend）→ pending（已提交待确认）
 * - Message.status 'error' → error
 * - Message.isInterrupted → stopped（用户 abort / 进程退出）
 */
import type { Message, SessionStatus } from '@taiji/shared'
import type { RetryState } from './store-types'

/** SessionStatus 前端派生状态：9 态扩展版（方案 C 优化版 v3 + working 后台任务态）
 * working：主 agent turn 已结束但有 background subagent/workflow 仍在 running（workflow
 * 一次性生命周期 D-2：paused 态已删）。 */
export type DerivedStatus =
  | 'streaming'
  | 'pending'
  | 'compacting'
  | 'waiting'
  | 'retrying'
  | 'working'
  | 'done'
  | 'stopped'
  | 'error'

/**
 * deriveStatus 消费的 chat store 最小结构接口（结构性类型）。
 * 兼容 renderer pinia wrapper（useChatStore 实例）与 core factory 产物（createChatStore），
 * core 域不依赖 renderer store 类型（防循环依赖）。
 */
export interface DeriveStatusChat {
  getMessages(sessionId: string): Message[]
  getRetryState?(sessionId: string): RetryState | undefined
  isGenerating(sessionId: string): boolean
}

const ERROR_STATUS = 'error'
const STREAMING_STATUS = 'streaming'
const TOOL_RUNNING = 'running'

/** 等待工具执行/审批判定（最优先：工具阻塞时即使后面有流式也不应显示 streaming）：
 *  最后一条 assistant 的末位 toolCall 处于 running。 */
function isWaitingOnToolCall(last: Message | undefined): boolean {
  if (last?.role !== 'assistant') return false
  const tools = last.toolCalls ?? []
  return tools.length > 0 && tools[tools.length - 1].status === TOOL_RUNNING
}

/** 文本流式生成判定：isGenerating（streaming 实体存在）或最后一条消息 streaming。 */
function isTextStreaming(chat: DeriveStatusChat, sessionId: string, last: Message | undefined): boolean {
  return chat.isGenerating(sessionId) || last?.status === STREAMING_STATUS
}

/** W6：未 hydrate（messages 为空）→ 用元数据终态兜底，无则 done。
 *  瞬态（streaming/compacting/waiting/retrying/pending）已在主函数上方分支处理，
 *  此处仅处理无消息历史的终态显示。 */
function terminalStatusWithoutMessages(metaStatus?: SessionStatus): DerivedStatus {
  if (metaStatus === 'error') return 'error'
  if (metaStatus === 'stopped') return 'stopped'
  return 'done'
}

/** 有消息历史时的终态判定：error > stopped（assistant 被中断）> done。 */
function terminalStatusOfLastMessage(last: Message): DerivedStatus {
  if (last.status === ERROR_STATUS) return 'error'
  if (last.role === 'assistant' && last.isInterrupted) return 'stopped'
  return 'done'
}

/**
 * 派生 session 9 态。
 *
 * [W1] isActive 作为 UI 层 SSOT：消除提交后到 message_start 之间空窗期的状态不一致。
 * isActive 包含 pendingSend（用户已提交但 pi 未确认）+ isGenerating（streaming 实体存在）。
 * 取代原 isStreaming 参数，不再受 activeId 限定。
 *
 * [W6] metaStatus：未 hydrate session（messages 为空）的终态兜底。去全量预 hydrate 后，
 * 侧栏未访问的 session 无消息历史，靠 runtime session_end 元数据（done/error/stopped）兜底。
 * 瞬态（streaming/compacting/waiting/...）由 chat store 的 Set 派生，不依赖 metaStatus。
 *
 * @param sessionId 目标 session
 * @param chat chat store 实例（读 getMessages / getRetryState / isGenerating 分区）
 * @param isActive 该 session 是否活跃（pendingSend ∨ isGenerating）
 * @param isCompacting 该 session 是否处于 compact 互斥态
 * @param hasBackgroundWork 该 session 是否有 background subagent/workflow 仍在 running
 * @param metaStatus runtime session 元数据 status（未 hydrate 兜底用，W6）
 * @param hasFormOverlayPending 该 session 是否有富交互表单 overlay 请求 pending（CW wave
 *   `session-active-ssot` T3）。表单走 extension.ui_request 通道，不产生 toolCall
 *   running，故需独立于 toolCall 的 waiting 判定；优先级最高（agent 阻塞等用户输入）。
 *   判定键 = form 键（新 form 帧原生携带、legacy askUser/scheduleCreate 帧经归一层
 *   附加后统一命中），权威口径见 renderer stores/extension-ui.ts hasPendingBlockingOverlay。
 */
export function deriveStatus(
  sessionId: string,
  chat: DeriveStatusChat,
  isActive: boolean,
  isCompacting = false,
  hasBackgroundWork = false,
  metaStatus?: SessionStatus,
  hasFormOverlayPending = false,
): DerivedStatus {
  const msgs = chat.getMessages(sessionId)
  const last = msgs[msgs.length - 1]

  // 等待工具执行/审批（最优先：工具阻塞时即使后面有流式也不应显示 streaming）
  if (isWaitingOnToolCall(last)) return 'waiting'

  // 富交互表单 pending → waiting（与 toolCall waiting 并列最高优先级）。
  // 表单走 extension.ui_request 通道不产生 toolCall running，需独立判定：
  // agent 阻塞等待用户回答期间，即使后续有流式文本/重试态也不应脱离 waiting（用户输入优先）。
  if (hasFormOverlayPending) return 'waiting'

  // 自动重试中
  if (chat.getRetryState?.(sessionId)) return 'retrying'

  // 上下文压缩中
  if (isCompacting) return 'compacting'

  // 文本流式生成中
  if (isTextStreaming(chat, sessionId, last)) return 'streaming'

  // 主 turn 结束但有 background subagent/workflow 仍在 running
  if (hasBackgroundWork) return 'working'

  // 已提交、等待 pi 确认（pendingSend 空窗期）
  if (isActive) return 'pending'

  if (!last) return terminalStatusWithoutMessages(metaStatus)
  return terminalStatusOfLastMessage(last)
}
