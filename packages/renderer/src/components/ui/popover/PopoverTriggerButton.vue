<script setup lang="ts">
/**
 * Panel popover 通用 trigger 按钮（架构审查 D4）。
 *
 * 统一 ModelSelectPopover / ThinkingLevelPopover / AddMenuPopover 三者重复的 trigger：
 * 包裹 `PopoverTrigger as-child` + `Button variant="ghost"`，内建共享类名、
 * 可选 ChevronDown（rotate 随 open）、leading-icon / default 两个 slot。
 *
 * 三种形态：
 *  - 文本 trigger（ModelSelect）：default slot 放 label，showChevron=true
 *  - 图标+文本 trigger（ThinkingLevel）：leading slot 放 icon，default 放 label，showChevron=true
 *  - 纯图标 trigger（AddMenu）：仅 leading slot，showChevron=false
 */
import type { HTMLAttributes } from 'vue'
import { ChevronDown } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { PopoverTrigger } from '@/components/ui/popover'
import {
  TRIGGER_ICON_CLASS,
  TRIGGER_TEXT_CLASS,
} from '@/composables/logic/popover-styles'

const props = withDefaults(
  defineProps<{
    /** popover 是否展开（控制 ChevronDown 旋转方向） */
    open?: boolean
    /** 是否显示尾部 ChevronDown（文本/图标+文本 trigger 用，纯图标 trigger 关闭） */
    showChevron?: boolean
    /** trigger 基础类来源：text = 文本型（含 label），icon = 纯图标型 */
    variant?: 'text' | 'icon'
    /** 原生 title（tooltip） */
    title?: string
    /** 追加类（与基础类经 cn 合并） */
    class?: HTMLAttributes['class']
  }>(),
  {
    open: false,
    showChevron: true,
    variant: 'text',
  },
)
</script>

<template>
  <PopoverTrigger as-child>
    <Button
      variant="ghost"
      :size="props.variant === 'icon' ? 'icon' : undefined"
      :class="[
        props.variant === 'icon' ? TRIGGER_ICON_CLASS : TRIGGER_TEXT_CLASS,
        props.variant === 'text' && 'gap-1',
        props.class,
      ]"
      :title="props.title"
    >
      <!-- leading icon（Brain / Plus 等小图标） -->
      <slot name="leading" />
      <!-- label 文本 -->
      <slot />
      <ChevronDown
        v-if="props.showChevron"
        class="ml-px size-[9px] transition-transform duration-[var(--duration)] ease-[var(--ease)]"
        :class="props.open && 'rotate-180'"
      />
    </Button>
  </PopoverTrigger>
</template>
