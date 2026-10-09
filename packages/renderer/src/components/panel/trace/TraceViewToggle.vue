<template>
  <!--
    展示组件 · trace-view-toggle（session-trace D5a：SegmentedTab「对话 | Trace」）。
    放 main panel header 右侧按钮组（ui-replica M2：demo .seg 40px 卡头档 —— 凹陷槽 bg-input +
    r-sm 6px 槽 + 2px 内衬；按钮 h-26px（--hb-segbtn）/ 13px 字（--hb-segfs）/ 15px 图标（--hb-segicon）/
    r-xs 4px；激活 = bg-elevated 中性浮起 + accent 1px 内描边 + 600 字重（demo 选中态单一范式），
    未选中 hover 无底仅提字色。总高 30px 内收于 40px 卡头）。
    视图状态 per-session 分区（store view 字段，D5c：切换不重建数据，仅切渲染分支）。
  -->
  <div
    class="flex shrink-0 gap-0.5 rounded-sm bg-bg-input p-[2px] [-webkit-app-region:no-drag]"
    data-testid="trace-view-toggle"
  >
    <Button
      v-for="seg in segments"
      :key="seg.value"
      variant="ghost"
      size="sm"
      class="h-[26px] gap-1 rounded-[var(--radius-xs)] px-2.5 text-[length:var(--text-sm)]"
      :class="modelValue === seg.value
        ? 'bg-bg-elevated font-semibold text-neutral-fg shadow-[inset_0_0_0_1px_var(--accent)] hover:bg-bg-elevated'
        : 'text-neutral-dim hover:bg-transparent hover:text-neutral-fg'"
      :data-testid="`trace-view-toggle-${seg.value}`"
      :aria-pressed="modelValue === seg.value"
      :disabled="disabled"
      @click="emit('update:modelValue', seg.value)"
    >
      <component :is="seg.icon" class="size-[15px] shrink-0" stroke-width="1.8" />
      {{ seg.label }}
    </Button>
  </div>
</template>

<script setup lang="ts">
/**
 * 「对话 | Trace」两段切换。v-model 双向绑（消费方 PanelHeader 绑 store 的 view 字段）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessageSquare, ListTree } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { Component } from 'vue'
import type { TraceMainView } from '@/composables/features/trace/useSessionTrace'

defineProps<{
  modelValue: TraceMainView
  /** landing（无 session）态 = true：两段钮均 disabled（demo Workbench.vue :disabled="route.name === 'new-task'" 同款——分段恒渲染，仅空态不可点） */
  disabled?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: TraceMainView]
}>()

const { t } = useI18n()

interface SegmentDef {
  value: TraceMainView
  label: string
  icon: Component
}

const segments = computed<SegmentDef[]>(() => [
  { value: 'chat', label: t('panel.trace.viewChat'), icon: MessageSquare },
  { value: 'trace', label: t('panel.trace.viewTrace'), icon: ListTree },
])
</script>
