<script setup lang="ts">
// QueueStrip v2 —— 移动壳队列条（remote-use-mobile-v2 §6.22 投递状态机；v1 views/QueueStrip
// 的重写承接，v1 文件清退归 u-cleanup）。
//
// 严格跟随 session.delivery 快照条目状态机渲染（§6.22 采用段，不预设「生成中 = 排队」——
// 活跃回合内提交走 steer 注入，条目通常短现即隐）：
// - queued   → 「排队中」+ 取消 ×（delivery.cancel；queued 立即移除判定全在 runtime 单点）
// - in-flight → 「投递中」，不可取消（受理后毫秒级转投递中，× 恒不可用——显示与事实一致）
// - failed   → 「发送未确认」+ 重试（delivery.resync，§6.22 复审 F6 自 u-channels 移入）
// - delivered / cancelled → 不显示。delivered 由 core deliveryQueueEntries 谓词滤除；
//   cancelled 结构性不显示——快照条目状态词表无 cancelled（DeliveryFrameEntry.state =
//   queued/in-flight/delivered/failed，取消的条目从快照离场），验收条款的该断言由内核
//   结构性保证，壳层无过滤面。
// 条目 = core 派生视图单读口 getDeliveryProjectionRef() 经 deliveryQueueEntries 谓词过滤
// （**禁壳内重写 lane 判定**）；preview 直用帧值，帧序 = 内核 FIFO 发送序。
//
// 取消编排（v1 承接）：取消成功全文回输入框草稿（composerInjection 通道 → Composer 消费端
// insertTextAtCursor 追加不覆盖）；行内编辑（chat-flow-consistency D6 锚定 + peek 预填 +
// delivery.edit 原位替换）全量保留。
//
// 反馈通道：取消/重试失败就近落条目级内联错误行（respondFailedId 范式：role=alert + 专用
// testid；新尝试时清空不跨条目残留）；core toast 契约的错误条承载 core 失败情形文案，壳级
// 条目反馈不挪用该单槽。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PenLine, RotateCcw, X } from '@lucide/vue'
import { deliveryQueueEntries, getDeliveryProjectionRef } from '@taiji/core'
import type { DeliveryFrameEntry } from '@taiji/core'
import { isQueueEditAlive } from '@taiji/core/domain/composer'
import {
  beginQueueEdit,
  cancelDelivery,
  clearQueueEditFor,
  composerInjectionStore,
  peekDelivery,
  queueEditAnchorOf,
  resyncDelivery,
} from '../shell/app-runtime'

const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()

// ── 行派生（core 谓词单源消费，非本地重写）────────────────────────────────

const projection = getDeliveryProjectionRef()

/** §6.22 状态机渲染集 = core deliveryQueueEntries 谓词输出（非 direct ∧ 未 delivered）；
 *  cancelled 不在快照条目状态词表（取消即离场），无壳层过滤面。 */
const rows = computed<DeliveryFrameEntry[]>(() =>
  deliveryQueueEntries(projection.value.get(props.sessionId) ?? []),
)

/** 状态徽标文案（state 词表 = DeliveryFrameEntry['state']；delivered 被谓词滤除渲染不可达，
 *  空串为类型完备性占位——若未来谓词放宽也不出假文案） */
const STATE_TEXT_KEY: Record<DeliveryFrameEntry['state'], string> = {
  queued: 'mobile.queueStrip.stateQueued',
  'in-flight': 'mobile.queueStrip.stateInFlight',
  failed: 'mobile.queueStrip.stateFailed',
  delivered: '',
}

function stateText(state: DeliveryFrameEntry['state']): string {
  return t(STATE_TEXT_KEY[state])
}

// ── 取消编排（仅 queued；失败域拆分 + 全文回草稿，v1 承接）──────────────────
// RPC 失败 / 不可撤 / 回填是三个独立失败情形，各自明确反馈不静默（§3.4）；
// cancellingId 全局单飞：并发取消的 reply 乱序会把反馈错挂到别的条目上。

const cancellingId = ref<string | null>(null)
const cancelError = ref('')

async function onCancelEntry(clientUuid: string): Promise<void> {
  if (cancellingId.value !== null) return
  cancellingId.value = clientUuid
  cancelError.value = ''
  let reply: Awaited<ReturnType<typeof cancelDelivery>>
  try {
    reply = await cancelDelivery(props.sessionId, clientUuid)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    cancelError.value = t('mobile.queueStrip.cancelFailed', { msg })
    cancellingId.value = null
    return
  }
  cancellingId.value = null
  if (!reply.cancelled) {
    // 不可撤（已 delivered / 收回失败）：明确反馈而非静默——条目由内核状态帧下轮收敛
    cancelError.value = reply.reason
      ? t('mobile.queueStrip.cancelUnavailableWithReason', { reason: reply.reason })
      : t('mobile.queueStrip.cancelUnavailable')
    return
  }
  // runtime 契约承诺 cancelled=true 携带完整文本——缺失/空白是契约违规，出声而非静默回
  // 空草稿（条目已撤销，静默 = 用户文本无痕丢失且无重输提示）。
  const content = reply.content ?? ''
  if (!content.trim()) {
    cancelError.value = t('mobile.queueStrip.restoreContentMissing')
    return
  }
  requestDraftRestore(content)
}

// ── failed 重试编排（§6.22 复审 F6）：delivery.resync 重报，幂等去重在 runtime 单点 ──
// resync reply.deduped = 已在内核活跃集被去重的 uuid（重试幂等的回执面）；条目重报后的
// 状态演进由 session.delivery 状态帧驱动（queued → in-flight → …），本组件零本地状态迁移。

const resyncingId = ref<string | null>(null)
const resyncError = ref('')

async function onRetryEntry(clientUuid: string): Promise<void> {
  if (resyncingId.value !== null) return
  resyncingId.value = clientUuid
  resyncError.value = ''
  try {
    await resyncDelivery(props.sessionId, [clientUuid])
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    resyncError.value = t('mobile.queueStrip.resyncFailed', { msg })
  } finally {
    resyncingId.value = null
  }
}

/**
 * 全文回草稿（经 composerInjection 通道，消费端 = Composer）。
 * 槽位已有同会话待消费 text → '\n\n' 累积（桌面 restoreToDraft 追加语义）；他会话残留
 * → 覆盖（跨会话槽位串文本是错误语义）。
 */
function requestDraftRestore(text: string): void {
  const pending = composerInjectionStore.pendingInjection.value
  const stacked =
    pending && pending.sessionId === props.sessionId && pending.text
      ? `${pending.text}\n\n${text}`
      : text
  composerInjectionStore.requestInjection({
    target: 'current',
    sessionId: props.sessionId,
    text: stacked,
  })
}

// ── 队列条目编辑（chat-flow-consistency D6，v1 承接）────────────────────────────
// 行内常驻编辑钮（触屏无 hover）：peek 取全文预填 + 锚定登记发送侧 delivery.edit 原位替换。
// 三裁决：同行再点幂等 no-op / 编辑他行拦截 / 预填遇非空输入 = 注入通道 '\n\n' 追加不覆盖。
// 锚定活性 = 帧驱动 watch（条目离场自动解除）；发送侧 delivery.edit 分流在 Composer
//（读 queueEditAnchorOf），本组件只管入口与提示条。
const editNotice = ref('')

/** 编辑态锚定 id（null = 非编辑态；提示条显隐 + 重复点击编辑的幂等判定同源） */
const editingClientUuid = computed(() => queueEditAnchorOf(props.sessionId))

// 条目离场自动解除（Q3 帧驱动信号）：行集更新后锚定不在行中 → 静默清锚定（草稿保留，
// 发送自然降级普通新消息）；发送时 edit 回执分类兜底
watch(
  () => {
    const uuid = queueEditAnchorOf(props.sessionId)
    return uuid === null ? null : isQueueEditAlive(rows.value, uuid) ? uuid : null
  },
  (alive) => {
    if (alive === null && queueEditAnchorOf(props.sessionId) !== null) {
      clearQueueEditFor(props.sessionId)
    }
  },
)

async function onEditEntry(clientUuid: string): Promise<void> {
  // 每次新尝试先清空上一次提示（不跨条目残留）；conflict 拦截提示随后与编辑条并存——
  // 渲染门不按 editingClientUuid 抑制（conflict 场景拦截只发生在锚定在册时）
  editNotice.value = ''
  const outcome = beginQueueEdit(props.sessionId, clientUuid)
  if (outcome === 'already-editing-same') return
  if (outcome === 'conflict') {
    editNotice.value = t('mobile.queueStrip.editConflict')
    return
  }
  let reply: Awaited<ReturnType<typeof peekDelivery>>
  try {
    reply = await peekDelivery(props.sessionId, clientUuid)
  } catch (e) {
    if (queueEditAnchorOf(props.sessionId) === clientUuid) clearQueueEditFor(props.sessionId)
    const msg = e instanceof Error ? e.message : String(e)
    editNotice.value = t('mobile.queueStrip.editPeekFailed', { msg })
    return
  }
  // peek 往返期间锚定已被放弃（提示条「放弃编辑」）：放弃预填
  if (queueEditAnchorOf(props.sessionId) !== clientUuid) return
  if (!reply.found || !reply.content || !reply.content.trim()) {
    clearQueueEditFor(props.sessionId)
    editNotice.value = t('mobile.queueStrip.editGone')
    return
  }
  requestDraftRestore(reply.content)
}

/** 放弃编辑（提示条按钮）：解除锚定但草稿文本保留（放弃的是保位意图，不是文本）。 */
function onAbandonEdit(): void {
  clearQueueEditFor(props.sessionId)
  editNotice.value = ''
}
</script>

<template>
  <!-- 空队列结构性不渲染（无占位空态）：显隐完全由派生视图帧驱动（core 单源，无本地布尔表） -->
  <div
    v-if="rows.length > 0"
    class="flex flex-col gap-1 rounded-lg border border-[var(--border)] bg-bg-input p-1.5"
    data-testid="mobile-queue-strip"
  >
    <!-- 编辑态提示条（chat-flow-consistency D6）：锚定在册渲染，「放弃编辑」解除锚定草稿保留；
         条目离场由帧驱动 watch 自动解除 → 本条随之消失 -->
    <div
      v-if="editingClientUuid"
      class="flex items-center gap-1.5 rounded-md bg-[var(--accent-soft)] px-1.5 py-1 text-xs text-accent"
      data-testid="mobile-queue-edit-banner"
    >
      <PenLine class="size-3 shrink-0" />
      <span class="min-w-0 flex-1">{{ t('mobile.queueStrip.editingBanner') }}</span>
      <span
        role="button"
        tabindex="0"
        class="shrink-0 cursor-pointer underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
        data-testid="mobile-queue-edit-abandon"
        @click="onAbandonEdit"
        @keydown.enter="onAbandonEdit"
      >{{ t('mobile.queueStrip.editingBannerAbandon') }}</span>
    </div>
    <!-- 编辑相关提示行（conflict 拦截 / peek 失败；每次新尝试开头清空不跨条目残留） -->
    <p
      v-if="editNotice"
      class="text-xs text-neutral-fg"
      role="status"
      data-testid="mobile-queue-edit-notice"
    >
      {{ editNotice }}
    </p>
    <!-- 取消失败内联错误行（respondFailedId 范式：role=alert + 专用 testid） -->
    <p
      v-if="cancelError"
      class="text-xs text-neutral-fg"
      role="alert"
      data-testid="mobile-queue-strip-error"
    >
      {{ cancelError }}
    </p>
    <!-- 重试失败内联错误行（§6.22 failed 重试通路；与取消错误分键不互相覆盖） -->
    <p
      v-if="resyncError"
      class="text-xs text-neutral-fg"
      role="alert"
      data-testid="mobile-queue-resync-error"
    >
      {{ resyncError }}
    </p>
    <div
      v-for="row in rows"
      :key="row.clientUuid"
      class="flex items-center gap-2"
      data-testid="mobile-queue-row"
    >
      <span
        class="shrink-0 text-xs text-neutral-mid"
        :data-testid="`mobile-queue-state-${row.state}`"
      >{{ stateText(row.state) }}</span>
      <span class="min-w-0 flex-1 truncate text-sm text-neutral-fg">{{ row.preview }}</span>
      <!-- 重试钮（§6.22 仅 failed）：delivery.resync 重报，幂等去重在 runtime 单点；
           min-h --m-tap = 44px 触控热区（§2 目标 2 拇指可达） -->
      <div
        v-if="row.state === 'failed'"
        role="button"
        tabindex="0"
        class="flex min-h-[var(--m-tap)] shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-1.5 text-xs text-accent transition-colors outline-none active:text-neutral-fg focus-visible:ring-2 focus-visible:ring-accent"
        data-testid="mobile-queue-retry"
        :aria-label="t('mobile.queueStrip.retry')"
        :aria-disabled="resyncingId !== null"
        @click="onRetryEntry(row.clientUuid)"
        @keydown.enter="onRetryEntry(row.clientUuid)"
      >
        <RotateCcw class="size-3.5" />
        <span>{{ t('mobile.queueStrip.retry') }}</span>
      </div>
      <!-- 编辑钮（chat-flow-consistency D6）：常驻触达（触屏无 hover），编排见 onEditEntry；
           图标钮 44px 热区（--m-tap，视觉尺寸仍由内部 size-3.5 图标承载） -->
      <div
        role="button"
        tabindex="0"
        class="flex min-h-[var(--m-tap)] min-w-[var(--m-tap)] shrink-0 cursor-pointer items-center justify-center rounded p-1 text-neutral-mid transition-colors outline-none active:text-neutral-fg focus-visible:ring-2 focus-visible:ring-accent"
        data-testid="mobile-queue-edit"
        :aria-label="t('mobile.queueStrip.edit')"
        @click="onEditEntry(row.clientUuid)"
        @keydown.enter="onEditEntry(row.clientUuid)"
      >
        <PenLine class="size-3.5" />
      </div>
      <!-- 取消钮（§6.22 仅 queued：in-flight 不可取消——受理后条目不可撤，× 不渲染即禁）；
           44px 取消热区（§7.2 F6 行明示，--m-tap 档，视觉尺寸由 size-3.5 图标承载） -->
      <div
        v-if="row.state === 'queued'"
        role="button"
        tabindex="0"
        class="flex min-h-[var(--m-tap)] min-w-[var(--m-tap)] shrink-0 cursor-pointer items-center justify-center rounded p-1 text-neutral-mid transition-colors outline-none active:text-neutral-fg focus-visible:ring-2 focus-visible:ring-accent"
        data-testid="mobile-queue-cancel"
        :aria-label="t('mobile.queueStrip.cancel')"
        :aria-disabled="cancellingId !== null"
        @click="onCancelEntry(row.clientUuid)"
        @keydown.enter="onCancelEntry(row.clientUuid)"
      >
        <X class="size-3.5" />
      </div>
    </div>
  </div>
</template>
