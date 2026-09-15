<template>
  <!--
    展示组件 · trace-list-item（列表项分发：台账行 / assistant 子 block 行 / context 分界行）。
    独立组件的原因：virtua <Virtualizer> slot 要求恰好 1 个 vnode（MessageStream M5 教训），
    分支收在本组件内，Virtualizer 与 v-for 两路径共用。
  -->
  <TraceRowItem
    v-if="item.kind === 'row'"
    :row="item.row"
    :selected="!!selected"
    :expanded="item.expanded"
    @select="(row) => emit('select', row)"
    @jump-parent="(row) => emit('jump-parent', row)"
    @toggle-expand="(row) => emit('toggle-expand', row)"
  />
  <TraceBlockRowItem
    v-else-if="item.kind === 'block'"
    :parent="item.parent"
    :index="item.index"
    :block="item.block"
    :headline="item.headline"
    :selected="!!selected"
    :result-state="item.resultState"
    @select="(key) => emit('select-block', key)"
  />
  <!-- context 分界行（demo .tr-divider：info 色两侧渐变线 + 说明文案；contextOnly 态由父级隐藏） -->
  <div
    v-else
    class="flex items-center gap-2.5 px-2 py-2.5 text-[length:var(--text-2xs)] text-info"
    data-testid="trace-context-divider"
  >
    <span aria-hidden="true" class="h-px flex-1 bg-gradient-to-r from-transparent via-info-soft to-transparent" />
    <span>{{ t('panel.trace.divider') }}</span>
    <span aria-hidden="true" class="h-px flex-1 bg-gradient-to-r from-transparent via-info-soft to-transparent" />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { TraceRow } from '@taiji/core/domain/session-trace'
import type { TraceDisplayItem } from '@/composables/features/trace/trace-display-items'
import TraceRowItem from './TraceRowItem.vue'
import TraceBlockRowItem from './TraceBlockRowItem.vue'

defineProps<{
  item: TraceDisplayItem
  selected?: boolean
}>()

const emit = defineEmits<{
  select: [row: TraceRow]
  'jump-parent': [row: TraceRow]
  'toggle-expand': [row: TraceRow]
  'select-block': [key: string]
}>()

const { t } = useI18n()
</script>
