/**
 * [premature-timeout §5.2 D2] message.complete 恢复分支（误判收口自愈）。
 *
 * 从 registry.ts 的 'message.complete' handler 抽出（效果注册表行数守卫）：
 * idle timer 误判收口（timeout → error + prematureTimeout 标）的气泡，在迟到的
 * message.complete 到达时恢复真实终态。恢复谓词（r2 复审 SG-3 对齐实装帧形态——
 * complete 帧不携带实体 id）=「complete 帧到达（按 session 路由）∧ 打标 id 快照非空
 * ∧ 目标实体仍处 timeout error 态」。命中实体按 stopReason 定真实终态（全集映射对齐
 * event-adapter STOP_REASON_MAP 映射后值域 end_turn/max_tokens/tool_use/error/aborted/
 * content_filter）：
 * - end_turn/max_tokens/tool_use/content_filter（+未识别值兜底，对齐 handler 的 isErrorStop
 *   判定）→ status:'complete' + 末位命中气泡权威 content 覆盖 + usage 回填 + 清标；
 * - error → status:'error' + errorMessage 写 Message.error（追加形态双通道同语义）+ 清标；
 * - aborted → status:'complete' + 清标（用户主动停，abort 路径无权威 content——保留截断累积值）。
 * 无快照（未打标 session）时 takePrematureTimeoutIds 返回空集 → 本函数 no-op 返回 false，
 * 「complete 对已终态气泡不改状态、不回填」的 P-C 现状保持不回归。
 */
import type { Message } from '@taiji/shared'
import { commitMessages, terminalMessagePatch, type MessagesRef } from '../mutations'

export interface CompleteRecoveryDeps {
  messages: MessagesRef
  sessionId: string
  /** 恢复映射的基线列表（handler 内 streaming 收口 map 的落盘结果，changed 时为 next） */
  base: Message[]
  stopReason: string | undefined
  errorMessage: string | undefined
  finalContent: string | undefined
  /** complete 原始 payload（末位命中气泡 usage 回填读值用） */
  payload: Record<string, unknown>
  lastAssistantIdx: number
  /** 打标 id 快照消费口（store 注入，读并清——恢复命中即时机①） */
  takePrematureTimeoutIds: (sessionId: string) => ReadonlySet<string>
}

/** 执行恢复；返回是否命中至少一个误判气泡（供 handler 抑制秒败纯 error 气泡追加）。 */
export function recoverPrematureTimeoutMessages(deps: CompleteRecoveryDeps): boolean {
  const { messages, sessionId, base, stopReason, errorMessage, finalContent, payload, lastAssistantIdx, takePrematureTimeoutIds } = deps
  const timeoutIds = takePrematureTimeoutIds(sessionId)
  if (timeoutIds.size === 0) return false
  const isErrorStop = stopReason === 'error'
  let recovered = false
  const recoveredNext = base.map((m, i) => {
    if (!timeoutIds.has(m.id)) return m
    // 谓词第三腿：目标实体仍处 timeout error 态（按构造恒真——快照非空期间无新 turn/
    // 无非 timeout finalize；防御校验防异常序列把已恢复实体二次改写）
    if (m.status !== 'error' || m.prematureTimeout !== true) return m
    recovered = true
    // 终态字段 patch 单源（与 registry streaming 收口分支同语义，S4-A6）；
    // 恢复分支额外清 prematureTimeout 打标（仅此分支需要）
    return {
      ...terminalMessagePatch(m, i, { lastAssistantIdx, isErrorStop, errorMessage, finalContent, payload }),
      prematureTimeout: undefined,
    }
  })
  if (recovered) commitMessages(messages, sessionId, recoveredNext)
  return recovered
}
