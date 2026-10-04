/**
 * useQueueRows —— composer 队列区（QueueBubble）数据源与撤销/重试编排（投递所有权内核 u3c / D7）。
 *
 * **单一数据源**：队列条目 = `session.delivery` 状态帧投影（core `getDeliveryProjectionRef()`，
 * state topic last-value 全量快照）。随报文更新的旧通路已随内核迁移退役：
 * - `queue_update`（steering/followUp 快照）不再直驱 UI（内核内部回执用，D7）；
 * - `useCompactQueue`（本地 defer 队列）整体退役（设计 §3.1 删除面：入队/flush/S1/timer/
 *   熔断/confirmDelivery/drain 全部由内核 backoff+settled+watchdog、delivery.cancel/drain、
 *   送达回执接管）。
 *
 * 投影过滤（`deliveryQueueEntries`）：lane ≠ 'direct' 且 state ≠ 'delivered'——
 * - direct 车道：乐观气泡原位保留待确认（送达回执抵消 inflight 占位，D7），不进队列区；
 * - delivered：已入 transcript（reducer 权威），队列区隐去；
 * - queued / in-flight / failed：队列区一行（三态可见，G3「排队中/投递中」）。
 * 刷新/重连后队列区不丢：状态在 runtime 内核，state 帧重放即恢复（D7 效果项）。
 *
 * preview 直用帧值：runtime 帧装配（session-delivery-topic `deliveryPreview`）已剥投递标记
 * 并截断，帧契约测试断言无标记——显示层不再二次剥除（单点剥离，防双规则漂移）。
 * 队列区折叠（failed 置顶恒可见 / +N 计数）见 `foldQueueRows`（显示序，不改帧序语义）。
 *
 * × 撤销（V9/V10）：queued 态立即移除；投递中（pi 槽位）走内核 clear_queue 全收 → 标记识别
 * → 其余条目保持相对序重投（收回-重投复用对账器路径）。reply.cancelled=false = 不可撤
 * （已 delivered 或收回失败），提示「已投递不可撤」（§3.4），条目由对账器下轮兜底。
 * 撤销成功的全文 + segments 快照交 `deps.restoreDraft` 回输入框草稿（ADR-0043 Segment[] 模型）。
 *
 * 重试（§3.4 重试耗尽行）：failed 条目红色标识 + 重试钮 → `delivery.resync` 单条重报
 * （去重锚在 runtime，命中终态判重记录的条目自动隐去）。
 *
 * [ADR-0049] 本 composable 不持 per-session 状态：投影分区由 core 投影 ref 持有（内核状态
 * 帧是 runtime 投影数据），行派生为 per-call computed，session 切换/销毁无残留面。
 */
import { computed, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Segment } from '@taiji/shared'
import { getDeliveryProjectionRef } from '@taiji/core'
import type { DeliveryFrameEntry } from '@taiji/core'
import { delivery } from '@/api/domains/delivery'
import { useChatStore } from '@/stores/chat'
import { useToast } from '@/composables/useToast'

/** 队列区一行（展示面所需最小字段；lane 只参与过滤不掉进行数据）。 */
export interface QueueRow {
  /** 内核条目 id = 乐观气泡 id（`u-<uuid>`），撤销/重试的对账锚 */
  clientUuid: string
  /** 文本预览（runtime 侧可能截断——**禁止当全文消费**；草稿恢复走 cancel reply 全文，D7） */
  preview: string
  /** 内核条目态：queued（排队中）/ in-flight（投递中）/ failed（重试耗尽，可重试） */
  state: DeliveryFrameEntry['state']
}

/**
 * 队列区条目过滤（**唯一定义点**，QueueBubble 行渲染与 ActivityStrip 副文案计数共用）：
 * 非 direct 车道且未 delivered 的内核条目，保持帧序（= 内核 FIFO 发送序）。
 */
export function deliveryQueueEntries(entries: readonly DeliveryFrameEntry[]): DeliveryFrameEntry[] {
  return entries.filter((e) => e.lane !== 'direct' && e.state !== 'delivered')
}

/** 队列区可见行数上限（v6 §8.5：多条显前 N 条 + 「+N」）。 */
export const QUEUE_VISIBLE_MAX = 3

/**
 * 队列区折叠口径（**唯一定义点**，QueueBubble 显示消费）：failed 行置顶且**恒可见**——
 * 重试耗尽条目必须保留重试/撤销入口，不得折叠进「+N」静默滞留（§3.4）；其余行保持帧序
 * 填充剩余可见位。「+N」只计被折叠的非 failed 行（failed 恒可见 → 溢出天然不含 failed）。
 * 仅显示序：不改 `deliveryQueueEntries` 的内核 FIFO 帧序语义。
 */
export function foldQueueRows(rows: readonly QueueRow[]): { visible: QueueRow[]; overflowCount: number } {
  const failed = rows.filter((r) => r.state === 'failed')
  const active = rows.filter((r) => r.state !== 'failed')
  const visibleActive = Math.max(0, QUEUE_VISIBLE_MAX - failed.length)
  return {
    visible: [...failed, ...active.slice(0, visibleActive)],
    overflowCount: Math.max(0, active.length - visibleActive),
  }
}

/** 撤销/重试回草稿的注入面（Composer 壳提供——草稿/chip 操作属壳层 DOM 能力，本层不直连 inputRef）。 */
export interface QueueRowsDeps {
  /**
   * 撤销（×）成功后把消息送回输入框草稿。空输入 → 按 segments 整段恢复（text + chips）；
   * 已有输入 → 追加不覆盖（用户正在输入的内容不丢）。实现见 composer-shell。
   */
  restoreDraft: (payload: { text: string; segments?: Segment[] }) => void
}

export function useQueueRows(
  sessionId: ComputedRef<string | null>,
  deps: QueueRowsDeps,
): {
  rows: ComputedRef<QueueRow[]>
  hint: ComputedRef<string>
  onCancelEntry: (clientUuid: string) => Promise<void>
  onRetryEntry: (clientUuid: string) => Promise<void>
} {
  const { t } = useI18n()
  const chatStore = useChatStore()
  const toast = useToast()
  const projection = getDeliveryProjectionRef()

  const rows = computed<QueueRow[]>(() => {
    const sid = sessionId.value
    if (!sid) return []
    // preview 直用帧值（runtime 装配已剥标记截断，见文件头）——本层不做二次文本加工
    return deliveryQueueEntries(projection.value.get(sid) ?? []).map((e) => ({
      clientUuid: e.clientUuid,
      preview: e.preview,
      state: e.state,
    }))
  })

  /** 行 hover title：按占用分档（compacting > bash > settling；与发送位/活动条同一 sessionPhase 真值）。 */
  const hint = computed(() => {
    const sid = sessionId.value
    if (!sid) return t('panel.queueBubble.pendingHint')
    const phase = chatStore.sessionPhase(sid)
    if (phase.compacting) return t('panel.queueBubble.pendingHintCompacting')
    if (phase.bash) return t('panel.queueBubble.pendingHintBash')
    if (phase.turn !== 'idle') return t('panel.queueBubble.pendingHintSettling')
    return t('panel.queueBubble.pendingHint')
  })

  async function onCancelEntry(clientUuid: string): Promise<void> {
    const sid = sessionId.value
    if (!sid) return
    // 失败域拆分：cancelDelivery RPC / restoreDraft 回草稿是两个独立失败面——混在一个 try
    // 会把「回草稿失败」误标成「撤销失败」（撤销已成功、行随 state 帧消失，文案与事实相反）。
    let reply: Awaited<ReturnType<typeof delivery.cancelDelivery>>
    try {
      reply = await delivery.cancelDelivery(sid, clientUuid)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('panel.queueBubble.cancelFailed', { msg }))
      return
    }
    if (!reply.cancelled) {
      // 不可撤（已 delivered / 收回失败）：明确反馈而非静默——条目由对账器下轮兜底（§3.4）
      toast.error(reply.reason ? t('panel.queueBubble.cancelUnavailableWithReason', { reason: reply.reason }) : t('panel.queueBubble.cancelUnavailable'))
      return
    }
    // runtime 契约承诺 cancelled=true 携带完整文本——缺失/空白是契约违规，出声而非静默回
    // 空草稿（条目已撤销，静默 = 用户文本无痕丢失且无重输提示）。
    const content = reply.content ?? ''
    if (!content.trim()) {
      toast.error(t('panel.queueBubble.restoreContentMissing'))
      return
    }
    try {
      deps.restoreDraft({ text: content, segments: reply.segments })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('panel.queueBubble.restoreDraftFailed', { msg }))
    }
  }

  async function onRetryEntry(clientUuid: string): Promise<void> {
    const sid = sessionId.value
    if (!sid) return
    try {
      // 单条重报：去重 anchor 在 runtime（终态判重记录），已投递的条目在 reply.deduped 命中
      // 并经随后到达的 session.delivery 快照帧从队列区隐去——renderer 不本地改投影（单源）。
      await delivery.resyncDelivery(sid, [clientUuid])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('panel.queueBubble.retryFailed', { msg }))
    }
  }

  return { rows, hint, onCancelEntry, onRetryEntry }
}
