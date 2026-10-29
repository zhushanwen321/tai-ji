<script setup lang="ts">
/**
 * SegmentedControl —— 移动端段控（二/三/四选一；remote-use-mobile-v2 §6.9 / spec §6.6）。
 *
 * 规格：--surface-2 轨道，选中 --bg-elevated + --neutral-fg + shadow-1（「tab 型」
 * 选中态，不用彩色描边或色条，对齐桌面 SegmentedTab 范式 DESIGN.md §5.3）；
 * 每段 ≥44px 触控（--m-tap）；role="tablist" + aria-selected 语义。
 *
 * 段元素 = @taiji/ui Button（variant=ghost 基座）：项目规范禁原生 button；Button 的
 * cva 基类（inline-flex/rounded-md/text-sm/transition）经 tailwind-merge 与段级类
 * 合并，字号/高度等冲突档由本组件类（后写）胜出。
 */
import { computed } from 'vue'
import { cn } from '../../lib/utils'
import { Button } from '../button'

export interface SegmentedOption {
  value: string
  label: string
}

const props = defineProps<{
  modelValue: string
  options: SegmentedOption[]
  /** tablist 的读屏名称（aria-label，必填——段控没有可见标题时读屏唯一锚点） */
  label: string
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

/**
 * roving tabindex 锚点段下标：选中段；无选中（非段值形态 modelValue 为空串、四段全不
 * 点亮）落首段——全 -1 会把段控整体键盘锁死（tab 进不去），首段 0 保 tablist 可达。
 */
const anchorIndex = computed(() => {
  const i = props.options.findIndex((o) => o.value === props.modelValue)
  return i >= 0 ? i : 0
})
</script>

<template>
  <div class="flex rounded-lg bg-surface-2 p-1" role="tablist" :aria-label="label" data-testid="segmented-control">
    <Button
      v-for="(option, index) in options"
      :key="option.value"
      variant="ghost"
      role="tab"
      :aria-selected="option.value === modelValue"
      :tabindex="index === anchorIndex ? 0 : -1"
      class="min-h-[var(--m-tap)] flex-1 text-[length:var(--m-text-sub)]"
      :class="
        cn(
          option.value === modelValue
            ? 'bg-bg-elevated font-medium text-neutral-fg shadow-1'
            : 'text-neutral-mid active:text-neutral-fg',
        )
      "
      :data-testid="`segmented-option-${option.value}`"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </Button>
  </div>
</template>
