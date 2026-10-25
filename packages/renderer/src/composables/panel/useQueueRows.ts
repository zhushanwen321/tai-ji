/**
 * useQueueRows —— composer 队列区（QueueBubble）数据源与撤销/重试编排（投递所有权内核 u3c / D7）。
 *
 * **单一数据源**：队列条目 = `session.delivery` 状态帧派生视图（core `getDeliveryProjectionRef()`，
 * state topic last-value 全量快照）。随报文更新的旧通路已随内核迁移退役：
 * - `queue_update`（steering/followUp 快照）不再直驱 UI（内核内部回执用，D7）；
 * - `useCompactQueue`（本地 defer 队列）整体退役（设计 §3.1 删除范围：入队/flush/S1/timer/
 *   熔断/confirmDelivery/drain 全部由内核 backoff+settled+watchdog、delivery.cancel/drain、
 *   送达回执接管）。
 *
 * 派生视图过滤（`deliveryQueueEntries`）：lane ≠ 'direct' 且 state ≠ 'delivered'——
 * - direct 投递路径：乐观气泡原位保留待确认（送达回执抵消 inflight 占位，D7），不进队列区；
 * - delivered：已入 transcript（reducer 权威），队列区隐去；
 * - queued / in-flight / failed：队列区一行（三态可见，G3「排队中/投递中」）。
 * 刷新/重连后队列区不丢：状态在 runtime 内核，state 帧重放即恢复（D7 效果项）。
 * 谓词本体已下沉 core（remote-use U20：`@taiji/core` `deliveryQueueEntries`，queue-projection
 * 单一定义点）——桌面消费点（本文件 + ActivityStrip）与移动壳队列条同源引用，防第二定义点。
 *
 * preview 直用帧值：runtime 帧装配（session-delivery-topic `deliveryPreview`）已剥投递标记
 * 并截断，帧契约测试断言无标记——显示层不再二次剥除（单点剥离，防双规则漂移）。
 * 队列区折叠（failed 置顶恒可见 / +N 计数 / +N 展开开关）见 `foldQueueRows`（显示序，不改帧序语义）。
 *
 * × 撤销（V9/V10）：queued 态立即移除；投递中（pi 槽位）走内核 clear_queue 全收 → 标记识别
 * → 其余条目保持相对序重投（收回-重投复用对账器路径）。reply.cancelled=false = 不可撤
 * （已 delivered 或收回失败），提示「已投递不可撤」（§3.4），条目由对账器下轮兜底。
 * 撤销成功的全文 + segments 快照交 `deps.restoreDraft` 回输入框草稿（ADR-0043 Segment[] 模型）。
 * 并发撤销（双行连点 / 与对账器同帧）由 runtime 兑现移交表闭环（chat-flow-consistency Q1：
 * 他径兑现的 cancel 应答同样返回 cancelled:true 携带全文）。
 *
 * 重试（§3.4 失败行）：failed 条目（两成因：受理失败 / 断连未确认）红色标识 + 重试钮 →
 * `delivery.resync` 单条重报；failed ≥2 时「重试全部」一次 resync 按显示序传全部 failedIds
 * （runtime 侧 requeue 保传入相对序，出站序 = 传入序；去重锚在 runtime，命中终态判重记录
 * 或 transcript 已送达的条目自动隐去）。
 *
 * ✎ 编辑（chat-flow-consistency D6）：行入口直通 deps.beginEdit（composer-shell 实现）——
 * 单锚定判定 → delivery.peek 取全文预填 + 锚定来源条目 id；发送时经 shell 分流通
 * delivery.edit 原位替换（位置不变 id 不变）。锚定活性/解除/提示条状态全在壳层。
 *
 * [ADR-0049] 本 composable 仅持展示态/瞬态的 per-session 分区（+N 展开标志、撤销单飞标志，
 * useSessionScopedState 工厂），数据态零持有——派生视图分区由 core 派生视图 ref 持有（内核
 * 状态帧是 runtime 派生视图数据），行派生为 per-call computed，session 切换/销毁无残留范围。
 */
import { computed, reactive, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Segment } from '@taiji/shared'
import { deliveryQueueEntries, getDeliveryProjectionRef } from '@taiji/core'
import type { DeliveryFrameEntry } from '@taiji/core'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { delivery } from '@/api/domains/delivery'
import { useChatStore } from '@/stores/chat'
import { useToast } from '@/composables/useToast'

/** 队列区一行（展示侧所需最小字段；lane 只参与过滤不掉进行数据）。 */
export interface QueueRow {
  /** 内核条目 id = 乐观气泡 id（`u-<uuid>`），撤销/重试的对账锚 */
  clientUuid: string
  /** 文本预览（runtime 侧可能截断——**禁止当全文消费**；草稿恢复走 cancel reply 全文，D7） */
  preview: string
  /** 内核条目态：queued（排队中）/ in-flight（投递中）/ failed（发送未确认，可重试） */
  state: DeliveryFrameEntry['state']
}

/** 队列区可见行数上限（v6 §8.5：多条显前 N 条 + 「+N」）。 */
export const QUEUE_VISIBLE_MAX = 3

/**
 * 队列区折叠口径（**唯一定义点**，QueueBubble 显示消费）：failed 行置顶且**恒可见**——
 * 失败条目（受理失败 / 断连未确认两成因）必须保留重试/撤销入口，不得折叠进「+N」静默
 * 滞留（§3.4）；其余行保持帧序填充剩余可见位。「+N」只计被折叠的非 failed 行（failed
 * 恒可见 → 溢出天然不含 failed）。`opts.expanded = true` 时全部行可见（overflowCount = 0，
 * +N 展开开关的展开态，Q2——点「+N」切换全显/收起，最简档无限高滚动）。
 * 仅显示序：不改 `deliveryQueueEntries` 的内核 FIFO 帧序语义。
 */
export function foldQueueRows(
  rows: readonly QueueRow[],
  opts?: { expanded?: boolean },
): { visible: QueueRow[]; overflowCount: number } {
  const failed = rows.filter((r) => r.state === 'failed')
  const active = rows.filter((r) => r.state !== 'failed')
  if (opts?.expanded === true) {
    return { visible: [...failed, ...active], overflowCount: 0 }
  }
  const visibleActive = Math.max(0, QUEUE_VISIBLE_MAX - failed.length)
  return {
    visible: [...failed, ...active.slice(0, visibleActive)],
    overflowCount: Math.max(0, active.length - visibleActive),
  }
}

/** 撤销/重试回草稿的注入点（Composer 壳提供——草稿/chip 操作属壳层 DOM 能力，本层不直连 inputRef）。 */
export interface QueueRowsDeps {
  /**
   * 撤销（×）成功后把消息送回输入框草稿。空输入 → 按 segments 整段恢复（text + chips）；
   * 已有输入 → 追加不覆盖（用户正在输入的内容不丢）。实现见 composer-shell。
   */
  restoreDraft: (payload: { text: string; segments?: Segment[] }) => void
  /**
   * ✎ 编辑入口（chat-flow-consistency D6）：单锚定不变式判定（同行幂等 no-op / 跨行拦截）
   * → delivery.peek 取全文 → 预填 composer 草稿 + 锚定来源条目 id（条目本身不动）。
   * 实现见 composer-shell（锚定分区 / peek RPC / 预填二分 / 提示条状态都在壳层，
   * 判定逻辑下沉 core queue-edit-anchor 双壳同源）。反馈（conflict toast / peek 失败提示）
   * 由实现方承担。
   */
  beginEdit: (clientUuid: string) => void
}

/** per-session 展示态分区（ADR-0049 工厂分区；数据态不在此）。 */
interface QueueUiPartition {
  /** +N 展开开关的展开态（Q2；会话切换经分区隔离自动重置） */
  expanded: boolean
  /** 会话级撤销单飞（Q10）：在途取消的 clientUuid；null = 无在途取消 */
  cancelling: string | null
}

export function useQueueRows(
  sessionId: ComputedRef<string | null>,
  deps: QueueRowsDeps,
): {
  rows: ComputedRef<QueueRow[]>
  hint: ComputedRef<string>
  /** +N 展开开关的展开态（per-session 分区，Q2） */
  expanded: ComputedRef<boolean>
  /** +N 展开开关切换（分区 update 单入口，Q2） */
  toggleExpanded: () => void
  onCancelEntry: (clientUuid: string) => Promise<void>
  /** ✎ 编辑（chat-flow-consistency D6）：单锚定判定 + peek 预填 + 锚定登记（编排见 deps.beginEdit） */
  onEditEntry: (clientUuid: string) => void
  onRetryEntry: (clientUuid: string) => Promise<void>
  /** 「重试全部失败项」（Q5）：failed ≥2 时由组件显示入口，一次 resync 按显示序传全部 ids */
  onRetryAllFailed: () => Promise<void>
} {
  const { t } = useI18n()
  const chatStore = useChatStore()
  const toast = useToast()
  const projection = getDeliveryProjectionRef()
  const ui = useSessionScopedState(sessionId, () => reactive<QueueUiPartition>({ expanded: false, cancelling: null }))

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

  /** 行 hover title：按占用分档（compacting > bash > 交接 > settling；与发送位/活动条同一 sessionPhase 真值）。 */
  const hint = computed(() => {
    const sid = sessionId.value
    if (!sid) return t('panel.queueBubble.pendingHint')
    const phase = chatStore.sessionPhase(sid)
    if (phase.compacting) return t('panel.queueBubble.pendingHintCompacting')
    if (phase.bash) return t('panel.queueBubble.pendingHintBash')
    if (phase.handingOff) return t('panel.queueBubble.pendingHintHandingOff')
    if (phase.turn !== 'idle') return t('panel.queueBubble.pendingHintSettling')
    return t('panel.queueBubble.pendingHint')
  })

  async function onCancelEntry(clientUuid: string): Promise<void> {
    const sid = sessionId.value
    if (!sid) return
    // 会话级撤销单飞（Q10，UX 防抖定位——正确性不依赖它，Q1 移交表已闭环并发撤销）：
    // 本会话已有在途取消则忽略本次点击（防误触双击发两条 cancel RPC）；分区隔离 =
    // 不同会话的队列区互不阻塞。RPC 有界（delivery.cancel 挂 RPC 兜底超时），单飞不会
    // 永久卡死；忽略静默（防抖静默惯例，与移动壳 aria-disabled 同款）。复位锚定进入时
    // 捕获的分区引用（中途切 session 不误复位新分区，旧分区随 RPC 完成复位）。
    const partition = ui.current.value
    if (partition.cancelling !== null) return
    partition.cancelling = clientUuid
    try {
      // 失败域拆分：cancelDelivery RPC / restoreDraft 回草稿是两个独立失败情形——混在一个 try
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
    } finally {
      partition.cancelling = null
    }
  }

  /** ✎ 编辑入口编排（D6）：行级入口直通壳层 beginEdit（单锚定/peek/预填全在壳层实现）。 */
  function onEditEntry(clientUuid: string): void {
    deps.beginEdit(clientUuid)
  }

  async function onRetryEntry(clientUuid: string): Promise<void> {
    const sid = sessionId.value
    if (!sid) return
    try {
      // 单条重报：去重 anchor 在 runtime（终态判重记录 + transcript 预检），已投递的条目
      // 在 reply.deduped 命中并经随后到达的 session.delivery 快照帧从队列区隐去——renderer
      // 不本地改派生视图（单源）。
      await delivery.resyncDelivery(sid, [clientUuid])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('panel.queueBubble.retryFailed', { msg }))
    }
  }

  async function onRetryAllFailed(): Promise<void> {
    const sid = sessionId.value
    if (!sid) return
    const failedIds = rows.value.filter((r) => r.state === 'failed').map((r) => r.clientUuid)
    if (failedIds.length === 0) return
    try {
      // 批量重报一次 RPC（Q5）：ids 按显示序传入（= failed 组内帧序），runtime requeue
      // 按传入相对序插队首 → 出站序 = 传入序（消除逐条重试在同出站窗口积压时的倒排）。
      await delivery.resyncDelivery(sid, failedIds)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('panel.queueBubble.retryFailed', { msg }))
    }
  }

  return {
    rows,
    hint,
    expanded: computed(() => ui.current.value.expanded),
    toggleExpanded: () => {
      ui.update((p) => {
        p.expanded = !p.expanded
      })
    },
    onCancelEntry,
    onEditEntry,
    onRetryEntry,
    onRetryAllFailed,
  }
}
