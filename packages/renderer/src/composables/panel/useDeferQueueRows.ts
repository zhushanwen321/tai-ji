import { computed, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '@/stores/chat'
import { useCompactQueue, type QueuedMessage } from '@/composables/panel/useCompactQueue'

/**
 * [compact-defer-composer-queue u1] defer 行四出口（Composer script 行数约束拆出，
 * 先例 composer-focus-ring.ts；逻辑自 Composer.vue 原样搬移，零行为改动）：
 * - deferEntries：useCompactQueue 单例 peek 过滤未提交条目（mode === undefined——
 *   双数据源归一规则：已提交条目不渲染 defer 行，承接面分通道）
 * - deferChip / deferHint：chip 与 hover title 按 sessionPhase 分档
 *   （compacting > bash > 其他，与 PendingBubble.pendingHint 同优先级；hint 额外含
 *   settling 档——PendingBubble.vue 归 u2 删除，逻辑只迁不删）
 * - onRemoveDefer：remove 对未知/已提交 id 本就 no-op（边界在 API 层）；
 *   deferEntries 已过滤为未提交条目
 */
export function useDeferQueueRows(sessionId: ComputedRef<string | null>): {
  deferEntries: ComputedRef<QueuedMessage[]>
  deferChip: ComputedRef<string>
  deferHint: ComputedRef<string>
  onRemoveDefer: (id: string) => void
} {
  const { t } = useI18n()
  const chatStore = useChatStore()
  const queue = useCompactQueue()

  const deferEntries = computed<QueuedMessage[]>(() => {
    if (!sessionId.value) return []
    return queue.peek(sessionId.value).filter((m) => m.mode === undefined)
  })

  // defer 行 chip 分档（compacting > bash > 其他，与 PendingBubble.pendingHint 同优先级）
  const deferChip = computed(() => {
    if (!sessionId.value) return t('panel.deferQueue.deferChipFallback')
    const phase = chatStore.sessionPhase(sessionId.value)
    if (phase.compacting) return t('panel.deferQueue.deferChipCompacting')
    if (phase.bash) return t('panel.deferQueue.deferChipBash')
    return t('panel.deferQueue.deferChipFallback')
  })

  // defer 行 hover title 分档（自 PendingBubble.pendingHint 逻辑迁移；u2 删除组件后此处为唯一承载）
  const deferHint = computed(() => {
    if (!sessionId.value) return t('panel.deferQueue.pendingHint')
    const phase = chatStore.sessionPhase(sessionId.value)
    if (phase.compacting) return t('panel.deferQueue.pendingHintCompacting')
    if (phase.bash) return t('panel.deferQueue.pendingHintBash')
    if (phase.turn !== 'idle') return t('panel.deferQueue.pendingHintSettling')
    return t('panel.deferQueue.pendingHint')
  })

  function onRemoveDefer(id: string): void {
    if (sessionId.value) queue.remove(sessionId.value, id)
  }

  return { deferEntries, deferChip, deferHint, onRemoveDefer }
}
