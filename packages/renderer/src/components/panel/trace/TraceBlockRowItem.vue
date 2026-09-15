<template>
  <!--
    展示组件 · trace-block-row-item（assistant 聚合行展开后的子 block 行，纯展示层派生）。
    对齐：前导占位与 TraceRowItem 的 seq 列同宽（w-12），block badge 落在父行 kind
    badge 的正下方。badge 与 kind badge 同款自适应宽 pill（内容定宽会溢出：
    thinking/toolCall 文字长于固定槽宽）。toolCall 子行尾缀配对结果态（ok/error）——
    子行是「调用 + 结果态」，与紧随的 TOOL 结果行配对呈现，非重复渲染。
  -->
  <div
    class="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-[5px] transition-colors duration-[var(--duration-fast)] ease-[var(--ease)] hover:bg-surface-2"
    :class="selected ? 'bg-surface-hover hover:bg-surface-hover' : ''"
    :data-testid="`trace-block-row-${parent.seq}-${index}`"
    :data-block-kind="blockBadgeLabel(block)"
    :title="headline || blockBadgeLabel(block)"
    @click="emit('select', traceBlockKey(parent.key, index))"
  >
    <!-- 结构占位：与 TraceRowItem 的 seq 列（w-12，含 chevron 槽）同宽，block badge
         落在父行 kind badge 正下方 -->
    <span class="w-12 shrink-0" aria-hidden="true" />
    <span
      class="shrink-0 rounded px-1.5 py-px font-mono text-[length:var(--text-3xs)] tracking-wide"
      :class="BLOCK_BADGE_CLASS[block.kind]"
    >{{ blockBadgeLabel(block) }}</span>
    <span
      class="min-w-0 flex-1 truncate text-[length:var(--text-xs)]"
      :class="[
        selected ? 'text-accent' : block.kind === 'thinking' ? 'text-neutral-mid' : 'text-neutral-fg',
      ]"
    >{{ headline || blockBadgeLabel(block) }}</span>
    <span
      v-if="resultState"
      class="shrink-0 font-mono text-[length:var(--text-3xs)]"
      :class="resultState === 'error' ? 'text-danger' : 'text-neutral-faint'"
    >{{ resultState }}</span>
  </div>
</template>

<script setup lang="ts">
/**
 * 子 block 行渲染。headline 纯数据展示（trace-display-items 派生产物），
 * 选中 key 经 traceBlockKey 组装（展示层 block 寻址 SSOT）。
 */
import type { TraceContentBlock, TraceRow } from '@taiji/core/domain/session-trace'
import { traceBlockKey } from '@/composables/features/trace/trace-display-items'
import { BLOCK_BADGE_CLASS, blockBadgeLabel } from './trace-kind-style'

defineProps<{
  parent: TraceRow
  index: number
  block: TraceContentBlock
  headline: string
  selected: boolean
  /** toolCall 的配对结果态（TOOL 行 isError；未配对省略）。 */
  resultState?: 'ok' | 'error'
}>()

const emit = defineEmits<{ select: [key: string] }>()
</script>
