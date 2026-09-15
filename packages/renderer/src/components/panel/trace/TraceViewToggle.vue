<template>
  <!--
    展示组件 · trace-view-toggle（session-trace D5a：SegmentedTab「对话 | Trace」）。
    放 main panel header 右侧按钮组（demo .seg 同源：凹陷槽 bg-bg-input + p-[2px]，
    active = bg-bg-elevated 中性浮起；v6 §3.4 tab 型范式）。
    高度约束：header h-[22px]（traffic light 共线，traffic-light-layout.md）——本控件整体
    h-[18px]，紧凑于 sidebar SegmentedTab（h-7，icon-only 4 段等宽不适用本场景）。
    视图状态 per-session 分区（store view 字段，D5c：切换不重建数据，仅切渲染分支）。
  -->
  <div
    class="flex shrink-0 gap-0.5 rounded-md bg-bg-input p-[2px] [-webkit-app-region:no-drag]"
    data-testid="trace-view-toggle"
  >
    <Button
      v-for="seg in segments"
      :key="seg.value"
      variant="ghost"
      size="sm"
      class="h-[14px] gap-1 rounded-sm px-2.5 text-[length:var(--text-2xs)]"
      :class="modelValue === seg.value ? 'bg-bg-elevated text-neutral-fg hover:bg-bg-elevated' : 'text-neutral-dim hover:bg-transparent hover:text-neutral-fg'"
      :data-testid="`trace-view-toggle-${seg.value}`"
      :aria-pressed="modelValue === seg.value"
      @click="emit('update:modelValue', seg.value)"
    >
      <component :is="seg.icon" class="size-3 shrink-0" />
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
