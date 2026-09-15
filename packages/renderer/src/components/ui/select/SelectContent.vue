<script setup lang="ts">
import type { SelectContentEmits, SelectContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import {
  SelectContent,
  SelectPortal,
  SelectViewport,
  useForwardPropsEmits,
} from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * SelectContent —— 下拉浮层。样式与 PopoverContent 对齐（冷蓝暗色 elevated 浮层）。
 * 默认 popper 模式：position="popper"，跟随触发器对齐。
 *
 * z-index 取 1100：高于 Dialog（z-1000），保证嵌在 Dialog 内的 Select（如
 * ProviderEditModal 类型/上下文/思考策略）下拉时不被 DialogContent 压住。
 * 与 PopoverContent 同属「浮层」层级，统一规则。
 */
const props = withDefaults(
  defineProps<SelectContentProps & { class?: HTMLAttributes['class'] }>(),
  { position: 'popper', sideOffset: 6 },
)
const emits = defineEmits<SelectContentEmits>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SelectPortal>
    <SelectContent
      v-bind="forwarded"
      :class="
        cn(
          'relative z-[1100] max-h-[var(--reka-select-content-available-height)] min-w-[var(--reka-select-trigger-width)] overflow-hidden rounded-md border border-border-strong bg-bg-elevated text-neutral-fg shadow-2 outline-none reka-popover-transition',
          props.class,
        )
      "
    >
      <SelectViewport class="p-1">
        <slot />
      </SelectViewport>
    </SelectContent>
  </SelectPortal>
</template>
