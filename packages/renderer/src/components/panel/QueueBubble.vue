<!--
  展示组件 · 投递队列区（v6 §8.5 内嵌 composer-box 顶部；投递所有权内核 u3c / D7 单源化）。

  **单一数据源**：队列条目 = runtime 内核 `session.delivery` 状态帧派生视图（core
  getDeliveryProjectionRef），不再读 queue_update 快照 + 本地 defer 队列双拼（D7）。
  每条未送达消息一行：状态 chip（排队中 / 投递中 / 发送未确认）+ truncate 预览文本 +
  hover × 撤销（delivery.cancel，V9 queued 态 / V10 投递中收回-重投）+ 行内编辑钮（D6：
  peek 预填 + 锚定登记，全行可用含 failed——编排经 useQueueRows → 壳层 beginEdit）+
  编辑态提示条（锚定在册渲染，「放弃编辑」emit 解除锚定草稿保留；条目离场由壳层帧驱动
  watch 自动解除 → 提示条随之消失）+ failed 行重试钮
  （delivery.resync 单条重报，§3.4 失败行）。failed ≥2 时显示「重试全部失败项」（Q5：
  一次 resync 按显示序传全部 ids，runtime requeue 保传入相对序）。折叠口径（useQueueRows
  `foldQueueRows` 唯一定义点）：failed 行置顶且恒可见（重试/撤销入口不折叠），其余显前 3
  条 + 「+N」计数（+N 只计被折叠的非 failed 行）；「+N」为可点展开开关（Q2：点 +N 全显 /
  再点收起，展开态行操作天然可用）。

  [M4 queue 子域] 纯 props 展示（行数据/提示文案/展开态由 Composer 经 useQueueRows 算好
  传入），组件内不取数不持状态；撤销/重试/展开只 emit 事件，RPC 编排在 useQueueRows。

  [HISTORICAL] 前身（compact-defer-composer-queue u1 → 内核 u3c 退役）：
  - steer/followUp 只读行（Zap/Clock，源自 pi queue_update 快照）——pi 队列已是交接槽位，
    UI 不再镜像它（内核条目为唯一展示源）；延迟入槽期由本组件 in-flight/queued 行承接；
  - defer 行（本地 useCompactQueue 未提交条目 + 占用分档 chip + 富内容 +N 徽标）——
    useCompactQueue 整体退役；分档 chip 的「为什么排队」信息改由行 hover title 承载
    （panel.queueBubble.pendingHint*），富内容 +N 徽标退役（帧只携带 preview，无 segments，
    草稿恢复改由 cancel reply 的全文 + segments 快照承担，ADR-0043）。
-->
<template>
  <div
    v-if="rows.length > 0"
    class="qb-inline border-b border-[color-mix(in_oklch,var(--accent)_18%,transparent)] px-3.5 pt-2 pb-1.5"
    data-testid="queue-bubble"
  >
    <!-- 编辑态提示条（chat-flow-consistency D6）：锚定在册时显示（条目离场由壳层帧驱动
         watch 自动解除锚定 → 本条随之消失；「放弃编辑」解除锚定但草稿文本保留） -->
    <div
      v-if="editingClientUuid"
      class="mb-1 flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[length:var(--text-2xs)] text-accent"
      data-testid="queue-edit-banner"
    >
      <PenLine class="size-3 shrink-0" />
      <span class="min-w-0 flex-1 truncate">{{ t('panel.queueBubble.editingBanner') }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="h-auto shrink-0 px-1 py-px text-[length:var(--text-2xs)] text-accent underline-offset-2 hover:underline"
        :data-testid="'queue-edit-abandon'"
        :title="t('panel.queueBubble.editingBannerAbandonHint')"
        @click="emit('abandonEdit')"
      >
        {{ t('panel.queueBubble.editingBannerAbandon') }}
      </Button>
    </div>
    <div
      v-for="row in visibleRows"
      :key="row.clientUuid"
      class="qb-item group flex items-center gap-1.5 py-0.5 text-[length:var(--text-xs)]"
      :title="rowTitleOf(row)"
      :data-testid="`queue-item-${row.clientUuid}`"
    >
      <component
        :is="iconOf(row.state)"
        class="size-[13px] shrink-0"
        :class="toneOf(row.state)"
      />
      <span
        class="shrink-0 rounded-[var(--radius-sm)] px-1 py-px text-[length:var(--text-2xs)] leading-[1.4]"
        :class="chipClassOf(row.state)"
        :data-testid="`queue-state-${row.clientUuid}`"
      >{{ stateLabelOf(row.state) }}</span>
      <span class="qb-item-text min-w-0 flex-1 truncate text-neutral-fg">{{ row.preview }}</span>
      <!-- 行内编辑钮（chat-flow-consistency D6）：全行可用（queued/in-flight/failed——E7 failed 行
           同样可编辑），hover 揭示与 × 同范式；编排经 useQueueRows.onEditEntry → 壳层 beginEdit -->
      <span
        class="shrink-0 self-center opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100"
        :title="t('panel.queueBubble.editQueued')"
        :data-testid="`queue-edit-anchor-${row.clientUuid}`"
      >
        <Button
          variant="ghost"
          size="icon"
          class="size-5 rounded-sm p-0 text-neutral-dim hover:text-accent"
          :data-testid="`queue-edit-${row.clientUuid}`"
          @click="emit('edit', row.clientUuid)"
        >
          <PenLine class="size-3" />
        </Button>
      </span>
      <!-- 重试钮（仅 failed 行）：顺序为「重试 → 撤销」，撤销仍为 hover 揭示（对齐既有范式） -->
      <span
        v-if="row.state === 'failed'"
        class="shrink-0 self-center"
        :title="t('panel.queueBubble.retry')"
      >
        <Button
          variant="ghost"
          size="icon"
          class="size-5 rounded-sm p-0 text-danger"
          :data-testid="`queue-retry-${row.clientUuid}`"
          @click="emit('retry', row.clientUuid)"
        >
          <RefreshCw class="size-3" />
        </Button>
      </span>
      <span
        class="shrink-0 self-center opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100"
        :title="t('panel.queueBubble.cancelQueued')"
        :data-testid="`queue-cancel-anchor-${row.clientUuid}`"
      >
        <Button
          variant="ghost"
          size="icon"
          class="size-5 rounded-sm p-0 text-neutral-dim hover:text-danger"
          :data-testid="`queue-cancel-${row.clientUuid}`"
          @click="emit('cancel', row.clientUuid)"
        >
          <X class="size-3" />
        </Button>
      </span>
    </div>
    <!-- +N 展开开关（Q2）：点 +N 全显全部行，再点收起（aria-expanded 承载开关态） -->
    <Button
      v-if="overflowCount > 0"
      variant="ghost"
      size="sm"
      class="mt-0.5 h-auto px-1 py-px text-[length:var(--text-2xs)] text-neutral-dim"
      :aria-expanded="expanded"
      :aria-label="t('panel.queueBubble.expandQueued', { n: overflowCount })"
      :data-testid="'queue-expand'"
      @click="emit('toggleExpand')"
    >
      +{{ overflowCount }}
    </Button>
    <!-- 收起（Q2 展开态出口）：仅在收起后仍有溢出行时显示（溢出归零自然退位） -->
    <Button
      v-if="expanded && collapsedOverflowCount > 0"
      variant="ghost"
      size="sm"
      class="mt-0.5 h-auto px-1 py-px text-[length:var(--text-2xs)] text-neutral-dim"
      :aria-expanded="true"
      :aria-label="t('panel.queueBubble.collapseQueued')"
      :data-testid="'queue-collapse'"
      @click="emit('toggleExpand')"
    >
      {{ t('panel.queueBubble.collapseQueued') }}
    </Button>
    <!-- 重试全部失败项（Q5）：failed ≥2 时一次 RPC 保序重投全部失败条目 -->
    <Button
      v-if="failedCount >= 2"
      variant="ghost"
      size="sm"
      class="mt-0.5 h-auto px-1 py-px text-[length:var(--text-2xs)] text-danger"
      :data-testid="'queue-retry-all'"
      @click="emit('retryAll')"
    >
      {{ t('panel.queueBubble.retryAll') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Hourglass, PenLine, RefreshCw, X, Zap } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { foldQueueRows, type QueueRow } from '@/composables/panel/useQueueRows'

const props = defineProps<{
  /** 队列条目（调用方已按「非 direct 且未 delivered」过滤，帧序 = 内核 FIFO 发送序；显示折叠在本组件内经 foldQueueRows 完成） */
  rows: QueueRow[]
  /** 行 hover title（session 级单一值：按占用分档的「等什么结束」，由 Composer 传入） */
  hint: string
  /** +N 展开开关的展开态（per-session 分区持有，Composer 经 useQueueRows 传入，Q2） */
  expanded?: boolean
  /** 编辑态锚定的条目 id（chat-flow-consistency D6；null/undefined = 非编辑态，提示条不渲染） */
  editingClientUuid?: string | null
}>()

const emit = defineEmits<{
  /** × 撤销（delivery.cancel；queued 立即移除 / 投递中走内核收回-重投） */
  cancel: [clientUuid: string]
  /** 编辑（delivery.peek 预填 + 锚定登记，D6——单锚定判定与 peek 编排在壳层） */
  edit: [clientUuid: string]
  /** 重试（delivery.resync 单条重报，仅 failed 行渲染入口） */
  retry: [clientUuid: string]
  /** 重试全部失败项（delivery.resync 批量重报，failed ≥2 时渲染入口，Q5） */
  retryAll: []
  /** +N 展开开关切换（展开态持有在 useQueueRows 的 per-session 分区，Q2） */
  toggleExpand: []
  /** 放弃编辑（解除锚定，草稿文本保留——D6 提示条按钮） */
  abandonEdit: []
}>()

const { t } = useI18n()

/** 状态 → icon：queued 等待（Hourglass）/ in-flight 投递中（Zap，accent）/ failed 发送未确认（AlertCircle，danger） */
function iconOf(state: QueueRow['state']) {
  if (state === 'in-flight') return Zap
  if (state === 'failed') return AlertCircle
  return Hourglass
}

/** 状态 → icon 色（沿用 v6 语义色：等待=info / 进行中=accent / 失败=danger） */
function toneOf(state: QueueRow['state']): string {
  if (state === 'in-flight') return 'text-accent'
  if (state === 'failed') return 'text-danger'
  return 'text-info'
}

/** 状态 → chip 底/前景（soft 底 + 实色前景，对齐既有 defer 行 chip 形态） */
function chipClassOf(state: QueueRow['state']): string {
  if (state === 'in-flight') return 'bg-[var(--accent-soft)] text-accent'
  if (state === 'failed') return 'bg-[var(--danger-soft)] text-danger'
  return 'bg-info-soft text-info'
}

/** 状态 → 用户可见文案（G3：排队中 / 投递中；failed 统一「发送未确认」——结果未确定，
 *  与断连/受理失败两成因共用上界口径，事件详情由错误气泡承载，Q6） */
function stateLabelOf(state: QueueRow['state']): string {
  if (state === 'in-flight') return t('panel.queueBubble.stateInFlight')
  if (state === 'failed') return t('panel.queueBubble.stateFailed')
  return t('panel.queueBubble.stateQueued')
}

/** 行 hover title：failed 行在占用分档 hint 之外补判重说明（Q6 分层——行 = 状态 + 恢复指引） */
function rowTitleOf(row: QueueRow): string {
  if (row.state === 'failed') return `${props.hint}\n${t('panel.queueBubble.retryDedupHint')}`
  return props.hint
}

/**
 * 折叠口径唯一定义点 = useQueueRows `foldQueueRows`：failed 行置顶恒可见（重试入口
 * 不折叠，§3.4），其余按帧序填充剩余可见位；+N 只计被折叠的非 failed 行。
 * expanded = true 时全部行可见（overflowCount = 0）。
 */
const folded = computed(() => foldQueueRows(props.rows, { expanded: props.expanded === true }))
const visibleRows = computed(() => folded.value.visible)
const overflowCount = computed(() => folded.value.overflowCount)
/** 收起态溢出计数（收起出口的显示条件：收起后仍有被折叠行才显示「收起」） */
const collapsedOverflowCount = computed(() => foldQueueRows(props.rows).overflowCount)
const failedCount = computed(() => props.rows.filter((r) => r.state === 'failed').length)
</script>
