<script setup lang="ts">
// QueueStrip —— 移动壳队列条（remote-use D7 / impl-plan U10：流尾内嵌轻量队列条，修 A1）。
//
// busy 期消息经 core morph 移出对话流（投递所有权内核 u3b），此前移动壳无队列可视化——
// 排队消息「消失」且悬停撤回钮触屏不可达。本组件承接 D7 三件事：
// - 条目 = core 投影单读口 getDeliveryProjectionRef() 经 `deliveryQueueEntries` 谓词过滤
//   （U20 下沉唯一定义点，桌面 useQueueRows/ActivityStrip 同源——**禁壳内重写 lane 判定**）；
//   preview 直用帧值（runtime 装配已剥标记，显示层不二次加工），帧序 = 内核 FIFO 发送序。
// - 取消钮 = delivery.cancel（app-runtime 透传出口；queued 立即移除 / in-flight 收回-重投 /
//   不可撤判定全在 runtime 单点）。行随后续 session.delivery 状态帧消失（单源，无本地删除）。
// - 取消成功后全文回输入框草稿（composerInjection 通道 → MobileComposer 消费端
//   insertTextAtCursor 追加不覆盖——G5 同族语义：不回填即静默丢输入）。reply.segments
//   快照不消费（移动 composer 无 chip 呈现载体，与图片粘贴文本降级同因）——桌面空输入分支的
//   restoreSegments 整段恢复为双壳真差异（D9② 白名单 §6 登记）。
//
// 反馈通道：取消失败就近落条目级内联错误行（MobileComposer sendFailed 同款
// respondFailedId 范式：role=alert + 专用 testid；新取消尝试时清空，不跨条目残留旧错；
// core toast 契约的错误条承载 core 失败面文案，壳级条目反馈不挪用该单槽）。
// 移动壳不做 failed 行重试钮（D7 原文「条目状态 + 取消钮」，重试
// 面属桌面 QueueBubble 展示序；取消对 failed 条目同样有效，滞留条目有出路）。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from '@lucide/vue'
import { deliveryQueueEntries, getDeliveryProjectionRef } from '@taiji/core'
import type { DeliveryFrameEntry } from '@taiji/core'
import { cancelDelivery, composerInjectionStore } from '../shell/app-runtime'

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
// RPC 失败 / 不可撤 / 回填是三个独立失败面，各自明确反馈不静默（§3.4）；
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
</script>

<template>
  <!-- 空队列结构性不渲染（无占位空态）：显隐完全由投影帧驱动（core 单源，无本地布尔表） -->
  <div
    v-if="rows.length > 0"
    class="flex flex-col gap-1 rounded-lg border border-[var(--border)] bg-bg-input p-1.5"
    data-testid="mobile-queue-strip"
  >
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
