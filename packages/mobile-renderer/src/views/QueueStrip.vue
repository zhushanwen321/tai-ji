<script setup lang="ts">
// QueueStrip —— 移动壳队列条（remote-use D7 / impl-plan U10：流尾内嵌轻量队列条，修 A1）。
//
// busy 期消息经 core morph 移出对话流（投递所有权内核 u3b），此前移动壳无队列可视化——
// 排队消息「消失」且悬停撤回钮触屏不可达。本组件承接 D7 三件事：
// - 条目 = core 派生视图单读口 getDeliveryProjectionRef() 经 `deliveryQueueEntries` 谓词过滤
//   （U20 下沉唯一定义点，桌面 useQueueRows/ActivityStrip 同源——**禁壳内重写 lane 判定**）；
//   preview 直用帧值（runtime 装配已剥标记，显示层不二次加工），帧序 = 内核 FIFO 发送序。
// - 取消钮 = delivery.cancel（app-runtime 透传出口；queued 立即移除 / in-flight 收回-重投 /
//   不可撤判定全在 runtime 单点）。行随后续 session.delivery 状态帧消失（单源，无本地删除）。
// - 取消成功后全文回输入框草稿（composerInjection 通道 → MobileComposer 消费端
//   insertTextAtCursor 追加不覆盖——G5 同族语义：不回填即静默丢输入）。reply.segments
//   快照不消费（移动 composer 无 chip 呈现载体，与图片粘贴文本降级同因）——桌面空输入分支的
//   restoreSegments 整段恢复为双壳真差异（D9② 白名单 §6 登记）。
// - 行内编辑钮（chat-flow-consistency D6 移动壳最小形态）：行内编辑 → peek 取全文预填 + 锚定
//   登记发送侧 delivery.edit 原位替换（MobileComposer 分流）；编辑态提示条 + 单锚定三裁决
//   （同行幂等 / 跨行拦截 / 非空追加），锚定分区在 app-runtime（Map + cleanup，桌面
//   useSessionScopedState 同范式，判定逻辑 core queue-edit-anchor 双壳同源）。
//
// 反馈通道：取消失败就近落条目级内联错误行（MobileComposer sendFailed 同款
// respondFailedId 范式：role=alert + 专用 testid；新取消尝试时清空，不跨条目残留旧错；
// core toast 契约的错误条承载 core 失败情形文案，壳级条目反馈不挪用该单槽）。
// 移动壳不做 failed 行重试钮（D7 原文「条目状态 + 取消钮」，重试
// 面属桌面 QueueBubble 展示序；取消对 failed 条目同样有效，滞留条目有出路）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PenLine, X } from '@lucide/vue'
import { deliveryQueueEntries, getDeliveryProjectionRef } from '@taiji/core'
import { isQueueEditAlive } from '@taiji/core/domain/composer'
import type { DeliveryFrameEntry } from '@taiji/core'
import {
  beginQueueEdit,
  cancelDelivery,
  clearQueueEditFor,
  composerInjectionStore,
  peekDelivery,
  queueEditAnchorOf,
} from '../shell/app-runtime'

const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()

// ── 行派生（core 谓词单源消费，非本地重写）────────────────────────────────

const projection = getDeliveryProjectionRef()

const rows = computed<DeliveryFrameEntry[]>(() =>
  deliveryQueueEntries(projection.value.get(props.sessionId) ?? []),
)

/** 三态徽标文案（state 词表 = DeliveryFrameEntry['state']；delivered 被谓词滤除渲染不可达，
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

// ── 取消编排（对齐桌面 useQueueRows.onCancelEntry：失败域拆分 + 全文回草稿）──────
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

/**
 * 全文回草稿（经 composerInjection 通道，消费端 = MobileComposer）。
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

// ── 队列条目编辑（chat-flow-consistency D6 移动壳最小形态）──────────────────────────
// 形态：行内常驻编辑钮（触屏无 hover——长按手势不做，与取消钮同范式并列；Q4「最小形态
// 对齐三裁决」的实质要求 = 单锚定/幂等/拦截，形态对齐移动壳既有按钮链）。三裁决：
// 同行再点幂等 no-op（不重新 peek 不覆盖草稿）/ 编辑他行拦截（提示行反馈）/ 预填遇非空
// 输入 = 注入通道 '\n\n' 追加不覆盖（与撤销回填同通道同语义）。锚定活性 = 帧驱动 watch
//（条目离场自动解除 → 提示条消失，草稿保留静默降级）；发送侧 delivery.edit 分流在
// MobileComposer（读 queueEditAnchorOf），本组件只管入口与提示条。
const editNotice = ref('')

/** 编辑态锚定 id（null = 非编辑态；提示条显隐 + 重复点击编辑的幂等判定同源） */
const editingClientUuid = computed(() => queueEditAnchorOf(props.sessionId))

// 条目离场自动解除（Q3 帧驱动信号）：行集更新后锚定不在行中 → 静默清锚定（草稿保留，
// 发送自然降级普通新消息；不发 toast——发送时 edit 回执分类兜底）
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
    <!-- 编辑相关提示行（conflict 拦截 / peek 失败 / 条目已离场；新尝试清空不跨条目残留） -->
    <p
      v-if="editNotice && !editingClientUuid"
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
    <div
      v-for="row in rows"
      :key="row.clientUuid"
      class="flex items-center gap-2"
      data-testid="mobile-queue-row"
    >
      <span
        class="shrink-0 text-xs text-neutral-dim"
        :data-testid="`mobile-queue-state-${row.state}`"
      >{{ stateText(row.state) }}</span>
      <span class="min-w-0 flex-1 truncate text-sm text-neutral-fg">{{ row.preview }}</span>
      <!-- 编辑钮（chat-flow-consistency D6）：常驻触达（触屏无 hover），编排见 onEditEntry -->
      <div
        role="button"
        tabindex="0"
        class="shrink-0 cursor-pointer rounded p-1 text-neutral-dim transition-colors outline-none active:text-neutral-fg focus-visible:ring-2 focus-visible:ring-accent"
        data-testid="mobile-queue-edit"
        :aria-label="t('mobile.queueStrip.edit')"
        @click="onEditEntry(row.clientUuid)"
        @keydown.enter="onEditEntry(row.clientUuid)"
      >
        <PenLine class="size-3.5" />
      </div>
      <!-- role="button" 条目（原生 button 由 vue_rules_checker 拦，先例 = SessionListItem） -->
      <div
        role="button"
        tabindex="0"
        class="shrink-0 cursor-pointer rounded p-1 text-neutral-dim transition-colors outline-none active:text-neutral-fg focus-visible:ring-2 focus-visible:ring-accent"
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
