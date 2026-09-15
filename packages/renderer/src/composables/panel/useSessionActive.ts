/**
 * useSessionActive —— session 级「对话进行中」信号（CW wave session-active-ssot T4）。
 *
 * 从 derivedStatus 派生：session 处于 streaming/waiting/working/pending/compacting/retrying
 * 任一态时视为「进行中」。驱动 Turn 的 sessionActive prop（sticky/折叠 disabled/trace 展开/
 * 完成收起等「进行中」相关 UI）。
 *
 * ask-user 关键修复（M3）：message.complete 让 isStreaming false，但 session 仍 waiting
 * （ask-user pending 接入 waiting，T3）→ isSessionActive 保持 true → 对话流不收起。
 * subagent 后台跑（working 态）同理（TC8）。
 *
 * subagent 虚拟 session 特殊处理：虚拟 session 无真实 derivedStatus（JSONL 镜像，无 chat.isActive
 * 等信号，derivedStatus 退化返回 done）。回退到 forceWorking（虚拟 session running 时 true → 进行中）。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import { useSessionDerivations } from '@/composables/features/chat/useSessionDerivations'
import { isSubagentVirtualId } from '@/stores/subagent'
import type { DerivedStatus } from '@/types'

/** 「对话进行中」的派生态集合（done/stopped/error 为终态，不在此列） */
const SESSION_ACTIVE_STATUSES: ReadonlySet<DerivedStatus> = new Set([
  'streaming',
  'waiting',
  'working',
  'pending',
  'compacting',
  'retrying',
])

/**
 * @param sessionId 当前 panel 绑定的 session id（响应式）
 * @param forceWorking subagent 虚拟 session 的 forceWorking（虚拟 session 回退用）
 */
export function useSessionActive(
  sessionId: Ref<string | null>,
  forceWorking: ComputedRef<boolean>,
): ComputedRef<boolean> {
  const { derivedStatus } = useSessionDerivations()
  return computed(() => {
    const sid = sessionId.value
    if (!sid) return false
    if (isSubagentVirtualId(sid)) return forceWorking.value
    return SESSION_ACTIVE_STATUSES.has(derivedStatus(sid).value)
  })
}
