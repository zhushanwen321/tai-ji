<!--
  展示组件 · queue_update 待发送队列（draft-composer-states S8）。
  v6 §8.5：内嵌 composer-box 顶部（不再独立卡片）——去独立 border/bg-accent-soft、
  去 PENDING/N排队中 标签和计数 badge、去 chevron（不支持收起）、去 pulse-accent 闪烁动画。
  仅 border-b 与下方输入区分隔，融入 composer-box bg-input 背景。
  内容：每条一行，Zap（steer，accent）/ Clock（followup，info）/ Hourglass（defer，info）icon +
  truncate 文本；多条显前 3 条 + 「+N」。
  [compact-defer-composer-queue u1] defer 行扩展：composer 侧 defer 队列展示统一收口——
  Hourglass icon + 占用分档 chip（deferChip，session 级单一值）+ truncate 文本 + 富内容
  +N 徽标（segments 非 text 段 >0）+ hover × 撤销（emit removeDefer，仅未提交条目——
  已提交条目不渲染，见双数据源归一规则）。steer/followUp 行仍只读（pi 无 clear_queue
  RPC）；defer 行可撤（本地 useCompactQueue 分区，remove no-op 边界在 API 层）。
  生命周期绑定 store：message_start 到达 → store queueStates.delete → v-if 消失。

  [M4 queue 子域] 数据源唯一：纯 props 展示（state 由 Composer 经 chatStore.getQueueState
  读 core queueStates，core/domain/chat/store.ts；deferEntries 由 Composer 经 useCompactQueue
  peek 过滤未提交条目），组件内不取数不持状态。
-->
<template>
  <div
    v-if="flatItems.length > 0"
    class="qb-inline border-b border-[color-mix(in_oklch,var(--accent)_18%,transparent)] px-3.5 pt-2 pb-1.5"
    data-testid="queue-bubble"
  >
    <div
      v-for="(item, i) in visibleItems"
      :key="i"
      class="qb-item group flex items-center gap-1.5 py-0.5 text-[length:var(--text-xs)]"
      :title="item.type === 'defer' ? deferHint : undefined"
    >
      <component
        :is="iconOf(item.type)"
        class="size-[13px] shrink-0"
        :class="item.type === 'steering' ? 'text-accent' : 'text-info'"
      />
      <span
        v-if="item.type === 'defer'"
        class="shrink-0 rounded-[var(--radius-sm)] bg-info-soft px-1 py-px text-[length:var(--text-2xs)] leading-[1.4] text-info"
      >{{ deferChip }}</span>
      <span class="qb-item-text min-w-0 flex-1 truncate text-neutral-fg">{{ item.text }}</span>
      <span
        v-if="item.type === 'defer' && item.chipCount > 0"
        class="shrink-0 self-center rounded-[var(--radius-sm)] bg-surface-hover px-1 py-px text-[length:var(--text-xs)] leading-[1.4] text-neutral-dim"
        :title="t('panel.deferQueue.chipBadgeHint', { count: item.chipCount })"
        :data-testid="`defer-chips-${item.id}`"
      >{{ t('panel.deferQueue.chipBadge', { count: item.chipCount }) }}</span>
      <!-- [compact-defer-composer-queue u1] defer 行 hover × 撤销（未提交条目；已提交条目不渲染，
           × 无禁用态）。hover 揭示对齐 PendingBubble 既有范式（外层 span 承载 opacity 过渡，
           Button 承载交互）。 -->
      <span
        v-if="item.type === 'defer'"
        class="shrink-0 self-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        :title="t('panel.deferQueue.cancelQueued')"
        :data-testid="`defer-cancel-anchor-${item.id}`"
      >
        <Button
          variant="ghost"
          size="icon"
          class="size-5 rounded-sm p-0 text-neutral-dim hover:text-danger"
          :data-testid="`defer-cancel-${item.id}`"
          @click="emit('removeDefer', item.id)"
        >
          <X class="size-3" />
        </Button>
      </span>
    </div>
    <div
      v-if="overflowCount > 0"
      class="mt-0.5 pl-[21px] text-[length:var(--text-2xs)] text-neutral-dim"
    >
      +{{ overflowCount }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock, Hourglass, X, Zap } from '@lucide/vue'
import { DEFER_FLUSH_MARKER_RE } from '@xyz-agent/core'
import { Button } from '@/components/ui/button'
import type { QueueState } from '@/stores/chat'
import type { QueuedMessage } from '@/composables/panel/useCompactQueue'

const props = defineProps<{
  state: QueueState | undefined
  /** [compact-defer-composer-queue u1] 未提交 defer 条目（调用方已过滤 mode === undefined，入队序） */
  deferEntries: QueuedMessage[]
  /** defer 行 chip 文案（session 级单一值，占用分档由 Composer 算好传入） */
  deferChip: string
  /** defer 行 hover title（session 级单一值，占用分档由 Composer 算好传入） */
  deferHint: string
}>()

const emit = defineEmits<{
  removeDefer: [id: string]
}>()

const { t } = useI18n()

interface FlatItem {
  type: 'steering' | 'followUp' | 'defer'
  text: string
  id: string
  chipCount: number
}

/** steering 优先于 followUp（对齐 pi 队列消费顺序）→ defer（未提交恒在最后，对齐「最后投递」
 *  时序；flush 提交窗口内已提交条目已隐藏，不破坏该声称），展平为单列表。
 *  根门（flatItems.length > 0）不含 state 存在性——纯压缩入队场景 state === undefined 时
 *  defer 行必须可见。 */
const flatItems = computed<FlatItem[]>(() => {
  const list: FlatItem[] = []
  const s = props.state
  if (s?.steering?.length) {
    list.push(...s.steering.map((text) => ({ type: 'steering' as const, text: stripDeferMarker(text), id: '', chipCount: 0 })))
  }
  if (s?.followUp?.length) {
    list.push(...s.followUp.map((text) => ({ type: 'followUp' as const, text: stripDeferMarker(text), id: '', chipCount: 0 })))
  }
  if (props.deferEntries.length) {
    list.push(...props.deferEntries.map((m) => ({
      type: 'defer' as const,
      text: m.text,
      id: m.id,
      // [defer segments 化] 富内容 +N 徽标计数 = 非 text 段数（逻辑自 PendingBubble.chipCount 迁移）
      chipCount: m.segments.filter((seg) => seg.type !== 'text').length,
    })))
  }
  return list
})

function iconOf(type: FlatItem['type']) {
  if (type === 'steering') return Zap
  if (type === 'followUp') return Clock
  return Hourglass
}

/**
 * [簇 A2] 显示层剥 flush 提交确认标记：core submitQueuedEntry 在提交文本尾附加
 * `<!--xyz:msg:<entry.id>-->`（裸 uuid 形态，message_end(user) 回流确认的 identity 通道），
 * steer 通道文本会镜像进 pi queue_update 快照（本组件数据源），原始展示会暴露实现标记。
 * 正则 SSOT = core apply-entry-convert.ts DEFER_FLUSH_MARKER_RE（经 user-delivery
 * re-export import，禁复制字面量——形态漂移由 effects-defer-confirmation.test.ts
 * 标记族用例 + convert 投影剥标记用例双侧守卫）。
 */
function stripDeferMarker(text: string): string {
  return text.replace(DEFER_FLUSH_MARKER_RE, '').trimEnd()
}

/** 前 3 条可见（v6 §8.5：多条显前 2-3 条 + 「+N」；溢出口径覆盖三组总和） */
const VISIBLE_MAX = 3
const visibleItems = computed(() => flatItems.value.slice(0, VISIBLE_MAX))
const overflowCount = computed(() => Math.max(0, flatItems.value.length - VISIBLE_MAX))
</script>
