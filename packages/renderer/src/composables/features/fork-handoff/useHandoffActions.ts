/**
 * useHandoffActions —— sidebar fast-handoff 操作集合（参照 useForkActions）。
 *
 * 职责：handoff 会话的两类入口编排（直接 handoff / 进 composer handoff 模式带 focus 备注）。
 * 跨 api + stores 编排在此层完成（铁律 1：唯一跨 api + stores 的层）。
 *
 * 与 fork 的差异：
 * - fork 从指定 assistant 分叉（需 fromMessageId 锚点）；handoff 始终从末条 assistant 打包文档
 *   （runtime 让源 session 跑 handoff turn 生成文档），无 fromMessageId 参数。
 * - fork 完成后留原线 + forkNotice 反馈行；handoff 完成后跳转到新 session（useHandoffEffect
 *   订阅 session.handoffComplete → selectSession(newSessionId)），无反馈行组件。
 * - handoff 进行中状态记录在 chat store（isHandingOff，handingOffSessions Set），供 LRU 豁免、
 *   clearIndependentTransient 等逻辑控制；取消入口在 composer stop 按钮（后续读 isHandingOff 路由 abort）。
 *
 * 拆分原因：与 useForkActions 对称，独立 composable 职责内聚。参照 useForkActions 范式
 * （调用方注入 focusedSessionId ref，内部自行获取 stores/api）。
 */
import type { Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { session as sessionApi } from '@/api'
import { useChatStore } from '@/stores/chat'
import { useToast } from '@/composables/useToast'
import { triggerEnterHandoffMode } from '@/composables/panel/useHandoffModeChannel'
import { toErrorMessage } from '@taiji/core'

/**
 * Handoff 操作 composable。
 *
 * @param focusedSessionId 焦点 panel 绑定的 session（来自 useSidebar，驱动 ⌘H 快捷键的 handoff 源）。
 *   注入而非内部派生：focusedSessionId 是 useSidebar 的派生状态（代理 core use-session），复用避免重复定义 + 单一来源。
 */
export function useHandoffActions(focusedSessionId: Ref<string | null>) {
  const chat = useChatStore()
  const { t } = useI18n()
  const { error: toastError } = useToast()

  /**
   * 触发 handoff：runtime 让源 session 跑 handoff turn 生成文档 → runtime 从 agent_end 提取 text
   * → 新建 session 注入 doc 触发新 turn。reply sanitize 后拼到 handoff prompt 末尾告知 agent 下一 session 关注点。
   * 置 handingOff=true 给 UI 即时反馈；完成由 useHandoffEffect 订阅 session.handoffComplete 复位 + 跳转。
   * 失败时复位 handingOff + rethrow（调用方决定 toast 反馈，参照 forkSession 的 rethrow 模式）。
   *
   * Staging Mode（ADR-0056）：staging 传 composer 暂存的模型/thinking 覆盖，用于新 session 创建。
   * 源 session turn 仍用源 session 自身模型，不受 override 影响。
   *
   * @param srcSessionId 源 session（runtime 从其 agent_end 提取文档）
   * @param reply 可选用户备注（sanitize 后拼到 handoff prompt 末尾）
   * @param staging 可选暂存配置（modelOverride/thinkingOverride，来自 composer Staging Mode）
   */
  async function handoff(
    srcSessionId: string,
    reply?: string,
    staging?: { modelOverride?: string; thinkingOverride?: string },
  ): Promise<void> {
    chat.setHandingOff(srcSessionId, true)
    try {
      await sessionApi.handoff(srcSessionId, reply, staging)
    } catch (e) {
      // 触发失败 → 复位 handingOff（等不到 handoffComplete 广播），避免 UI 卡「正在交接」
      chat.setHandingOff(srcSessionId, false)
      throw e
    }
  }

  /**
   * 取消进行中的 handoff（乐观清 handingOff 反馈 + 委托 abortHandoff RPC 中断 handoff inflight）。
   * runtime abort（client.abort + 清 listener/timer）后不会广播 session.handoffComplete
   * （onTurnEnd 检测 aborted 跳过新建），故乐观清 handingOff（与 fork 的 abort 对称）。
   * RPC 失败时恢复 handingOff 状态 + toast 通知用户——handoff turn 仍在跑，UI 需保持「正在交接」。
   */
  async function abortHandoff(sessionId: string): Promise<void> {
    chat.setHandingOff(sessionId, false)
    try {
      await sessionApi.abortHandoff(sessionId)
    } catch (e) {
      // RPC 失败 → 恢复 handingOff（handoff turn 仍在跑，稍后 handoffComplete 会跳新 session）
      chat.setHandingOff(sessionId, true)
      const msg = toErrorMessage(e)
      toastError(t('panel.message.handoffAbortFailed', { error: msg }))
      console.warn('[handoff] abortHandoff RPC failed, handoff turn may continue:', e)
    }
  }

  /**
   * 找当前焦点 session 的末条 assistant 消息（⌘H 全局快捷键默认 handoff 点）。
   * 全局快捷键无 hover 上下文，按对称 fork 的 lastAssistantOfFocused 默认从末条 assistant handoff。
   * handoff 无需 messageId（runtime 从 agent_end 提取文档），故只返回 { sessionId }。
   * 无焦点 session 或无 assistant 消息时返回 null（调用方静默 no-op）。
   */
  function lastAssistantOfFocused(): { sessionId: string } | null {
    const sid = focusedSessionId.value
    if (!sid) return null
    const msgs = chat.getMessages(sid)
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'assistant') return { sessionId: sid }
    }
    return null
  }

  /**
   * 从末条 assistant 直接 handoff（⌘H）：runtime 从末条 assistant 跑 handoff turn 提取文档到新 session。
   * 完成经 session.handoffComplete 广播 → useHandoffEffect 跳转新 session。
   * 无末条 assistant 时静默 no-op（无文档可打包）。
   */
  async function handoffFromLastAssistant(): Promise<void> {
    const last = lastAssistantOfFocused()
    if (!last) return
    await handoff(last.sessionId)
  }

  /**
   * 从末条 assistant 进入 composer handoff 模式（带 focus 备注）：
   * 经 useHandoffModeChannel 发 signal，Composer 监听后调自身 enterHandoffMode（聚焦输入框等用户键入 focus 备注）。
   * 无末条 assistant 时静默 no-op。
   */
  async function enterHandoffModeFromLastAssistant(): Promise<void> {
    const last = lastAssistantOfFocused()
    if (!last) return
    triggerEnterHandoffMode(last.sessionId)
  }

  return {
    handoff,
    abortHandoff,
    handoffFromLastAssistant,
    enterHandoffModeFromLastAssistant,
  }
}
