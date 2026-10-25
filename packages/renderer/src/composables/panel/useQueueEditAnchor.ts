/**
 * 队列编辑锚定 composable（chat-flow-consistency D6 + design-queue-delivery Q3/Q4 补章）。
 *
 * 从 composer-shell 拆出（script 行数上限；内聚块 = 锚定分区 + 离场自动解除 + ✎ peek 预填 +
 * 发送分流 delivery.edit）。判定逻辑（单锚定不变式 / 活性派生）在 core queue-edit-anchor
 * 双壳同源；本层只做装配与 UI 编排（toast / 预填 / 发送分流）。
 */
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Ref } from 'vue'
import { deliveryQueueEntries, getDeliveryProjectionRef } from '@taiji/core'
import {
  clearQueueEdit,
  isQueueEditAlive,
  startQueueEdit,
  type QueueEditAnchorPartition,
} from '@taiji/core/domain/composer'
import { segmentsToPrompt, type Segment } from '@taiji/shared'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { delivery } from '@/api/domains/delivery'
import { useToast } from '@/composables/useToast'

/** 入参：壳层装配产物（真源留在 composer-shell，本层只消费） */
interface QueueEditAnchorDeps { // oe-exempt:20261024:framework:壳层装配契约（composer-shell 单装配点依赖注入面，随 D6 双壳扩展增实现）
  sessionIdRef: Ref<string | null>
  /** 草稿文本（清空草稿解除路径的边沿信号源） */
  draft: Ref<string>
  /** 已附 chips（空输入判定：无文本且无 chip 才算空） */
  attachedItems: Ref<unknown[]>
  /** 预填回调（壳层 restoreToDraft：空输入整段恢复含 chips / 非空追加不覆盖） */
  restoreToDraft: (payload: { text: string; segments?: Segment[] }) => void
  /** subagent 通道（锚定编辑不适用，发送直通） */
  isSubagentLane: Ref<boolean>
  /** 普通发送（降级路径与无锚定路径的透传目标） */
  laneSend: (sid: string, segments: Segment[]) => Promise<boolean>
}

export function useQueueEditAnchor(deps: QueueEditAnchorDeps) {
  const { sessionIdRef, draft, attachedItems, restoreToDraft, isSubagentLane, laneSend } = deps
  const { t } = useI18n()
  const { info: toastInfo, error: toastError } = useToast()

  // 锚定 = composer 草稿记住来源条目 id（per-session 分区，与草稿同区——切走留在分区、
  // 切回随草稿一并恢复，Q4 裁决 1）。
  const anchorState = useSessionScopedState(sessionIdRef, () => reactive<QueueEditAnchorPartition>({ clientUuid: null }))
  const deliveryProjection = getDeliveryProjectionRef()
  /** 锚定活性数据源：当前会话的队列派生行（core deliveryQueueEntries 谓词——queued/in-flight/failed）。 */
  const anchorQueueRows = computed(() => {
    const sid = sessionIdRef.value
    if (!sid) return []
    return deliveryQueueEntries(deliveryProjection.value.get(sid) ?? [])
  })
  /** 编辑态（提示条显隐）：锚定在册即编辑态——失效锚定由下方 watch 帧驱动自动解除（单写点）。 */
  const editingQueueClientUuid = computed(() => anchorState.current.value.clientUuid)
  watch(
    () => {
      const uuid = anchorState.current.value.clientUuid
      if (uuid === null) return null
      return isQueueEditAlive(anchorQueueRows.value, uuid) ? uuid : null
    },
    (alive) => {
      // 条目离场自动解除（Q3 帧驱动信号）：静默清锚定 + 提示条消失，草稿文本保留（下次
      // 发送自然降级普通新消息）；不发 toast——发送时 edit 回执分类兜底，帧驱动解除只负责
      // 提示条不撒谎。切走期间帧仍更新，切回瞬间本 watch 即时反映离场（Q4 穷举 3 口径）。
      if (alive === null && anchorState.current.value.clientUuid !== null) {
        clearQueueEdit(anchorState.current.value)
      }
    },
  )
  watch(
    () => ({ sid: sessionIdRef.value, has: draft.value.trim().length > 0 || attachedItems.value.length > 0 }),
    (nv, ov) => {
      // 清空草稿解除（Q4 解除路径 2）：仅同一会话内「有内容 → 空」边沿触发（发送 clearInput
      // 与用户手动删空共用；切会话的保存/恢复链 sid 变化，不误清新会话分区锚定）。
      if (nv.sid === ov.sid && ov.has && !nv.has) clearQueueEdit(anchorState.current.value)
    },
  )

  /**
   * 编辑入口（Q4 单锚定不变式）：同行再点幂等 no-op（不重新 peek 不覆盖草稿）；编辑他行时
   * 拦截 + toast（锚定不切换——放弃后两步达成同效）。意图登记先行（peek 往返窗口内跨行
   * 点击已被 conflict 拦），peek 返回后校验锚定仍在本条目（往返期间用户可能已放弃）再预填。
   * 预填二分与撤销回填同语义（restoreToDraft：空输入整段恢复含 chips / 非空追加不覆盖）。
   */
  function beginQueueEntryEdit(clientUuid: string): void {
    const sid = sessionIdRef.value
    if (!sid) return
    const partition = anchorState.current.value
    const outcome = startQueueEdit(partition, clientUuid)
    if (outcome === 'already-editing-same') return
    if (outcome === 'conflict') {
      toastInfo(t('panel.composer.queueEditConflict'))
      return
    }
    void delivery
      .peekDelivery(sid, clientUuid)
      .then((reply) => {
        // 往返期间锚定已被放弃/切换（再点他行等）：放弃预填，锚定以现值为准
        if (anchorState.current.value.clientUuid !== clientUuid) return
        if (!reply.found || !reply.content || !reply.content.trim()) {
          clearQueueEdit(anchorState.current.value)
          toastInfo(t('panel.composer.queueEditGone'))
          return
        }
        restoreToDraft({ text: reply.content, segments: reply.segments })
      })
      .catch((e: unknown) => {
        if (anchorState.current.value.clientUuid !== clientUuid) return
        clearQueueEdit(anchorState.current.value)
        const msg = e instanceof Error ? e.message : String(e)
        toastError(t('panel.composer.queueEditPeekFailed', { msg }))
      })
  }

  /** 放弃编辑（提示条按钮）：解除锚定但草稿文本保留（放弃的是保位意图，不是文本）。 */
  function abandonQueueEdit(): void {
    clearQueueEdit(anchorState.current.value)
  }

  /**
   * 发送分流（D6 锚定编辑通路）：锚定活 → delivery.edit 原位替换（成功 = 无乐观气泡——
   * 条目已在队列区，preview 随 session.delivery 帧更新，A5「位置不变、id 不变」）；
   * edited=false 四值降级 = 内容按普通新消息发出（不丢）+ toast 分型（Q3 处置同构不变式）。
   * RPC 异常不上抛捕获（对齐 laneSend 契约外的异常语义）——由调用方 useComposerSend 的
   * catch 恢复草稿 + toast（内容不丢，重发时锚定存活则再次尝试保位）。
   * subagent 通道 / 无锚定 / 锚定已离场（活性窄缝）：透传 laneSend 普通发送（锚定离场时
   * 顺手解除——活性 watch 的兜底同步点）。
   */
  function sendWithQueueEdit(sid: string, segments: Segment[]): Promise<boolean> {
    // 无锚定路径同步透传 laneSend 的 promise（非 async 直返——零额外微任务，调用方的
    // isSending 复位时序与无包装形态完全一致；锚定分支才进 async 流程）
    const anchorUuid = anchorState.current.value.clientUuid
    if (isSubagentLane.value || anchorUuid === null) return laneSend(sid, segments)
    if (!isQueueEditAlive(anchorQueueRows.value, anchorUuid)) {
      clearQueueEdit(anchorState.current.value)
      return laneSend(sid, segments)
    }
    return (async (): Promise<boolean> => {
      const reply = await delivery.editDelivery(sid, anchorUuid, segmentsToPrompt(segments), segments)
      clearQueueEdit(anchorState.current.value)
      if (reply.edited) return true
      // 失败四值降级：内容按普通新消息发出（不丢）+ toast 分型（Q3 处置同构不变式）
      toastInfo(t(queueEditReplyToastKey(reply.reason)))
      return laneSend(sid, segments)
    })()
  }

  /** edit 回执 reason → toast 文案 key（四值分型，Q3；undefined = 契约违规按 unconfirmed 口径兜底）。 */
  function queueEditReplyToastKey(reason: 'delivered' | 'unconfirmed' | 'cancelled' | 'not-found' | undefined): string {
    switch (reason) {
      case 'delivered':
        return 'panel.composer.queueEditDelivered'
      case 'cancelled':
        return 'panel.composer.queueEditCancelled'
      case 'not-found':
        return 'panel.composer.queueEditNotFound'
      default:
        return 'panel.composer.queueEditUnconfirmed'
    }
  }

  return { editingQueueClientUuid, beginQueueEntryEdit, abandonQueueEdit, sendWithQueueEdit }
}
