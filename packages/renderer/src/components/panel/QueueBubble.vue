<!--
  展示组件 · 投递队列区（v6 §8.5 内嵌 composer-box 顶部；投递所有权内核 u3c / D7 单源化）。

  **单一数据源**：队列条目 = runtime 内核 `session.delivery` 状态帧投影（core
  getDeliveryProjectionRef），不再读 queue_update 快照 + 本地 defer 队列双拼（D7）。
  每条未送达消息一行：状态 chip（排队中 / 投递中 / 发送失败）+ truncate 预览文本 +
  hover × 撤销（delivery.cancel，V9 queued 态 / V10 投递中收回-重投）+ failed 行重试钮
  （delivery.resync 单条重报，§3.4 重试耗尽行）。折叠口径（useQueueRows `foldQueueRows`
  唯一定义点）：failed 行置顶且恒可见（重试/撤销入口不折叠），其余显前 3 条 + 「+N」
  （+N 只计被折叠的非 failed 行）。

  [M4 queue 子域] 纯 props 展示（行数据/提示文案由 Composer 经 useQueueRows 算好传入），
  组件内不取数不持状态；撤销/重试只 emit 事件，RPC 编排在 useQueueRows。

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
    <div
      v-for="row in visibleRows"
      :key="row.clientUuid"
      class="qb-item group flex items-center gap-1.5 py-0.5 text-[length:var(--text-xs)]"
      :title="hint"
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
        class="shrink-0 self-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
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
import { AlertCircle, Hourglass, RefreshCw, X, Zap } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { foldQueueRows, type QueueRow } from '@/composables/panel/useQueueRows'

const props = defineProps<{
  /** 队列条目（调用方已按「非 direct 且未 delivered」过滤，帧序 = 内核 FIFO 发送序；显示折叠在本组件内经 foldQueueRows 完成） */
  rows: QueueRow[]
  /** 行 hover title（session 级单一值：按占用分档的「等什么结束」，由 Composer 传入） */
  hint: string
}>()

const emit = defineEmits<{
  /** × 撤销（delivery.cancel；queued 立即移除 / 投递中走内核收回-重投） */
  cancel: [clientUuid: string]
  /** 重试（delivery.resync 单条重报，仅 failed 行渲染入口） */
  retry: [clientUuid: string]
}>()

const { t } = useI18n()

/** 状态 → icon：queued 等待（Hourglass）/ in-flight 投递中（Zap，accent）/ failed 重试耗尽（AlertCircle，danger） */
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

/** 状态 → 用户可见文案（G3：排队中 / 投递中；failed 明说失败并配重试钮） */
function stateLabelOf(state: QueueRow['state']): string {
  if (state === 'in-flight') return t('panel.queueBubble.stateInFlight')
  if (state === 'failed') return t('panel.queueBubble.stateFailed')
  return t('panel.queueBubble.stateQueued')
}

/**
 * 折叠口径唯一定义点 = useQueueRows `foldQueueRows`：failed 行置顶恒可见（重试入口
 * 不折叠，§3.4），其余按帧序填充剩余可见位；+N 只计被折叠的非 failed 行。
 */
const folded = computed(() => foldQueueRows(props.rows))
const visibleRows = computed(() => folded.value.visible)
const overflowCount = computed(() => folded.value.overflowCount)
</script>
