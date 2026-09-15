<script setup lang="ts">
import type { PopoverContentEmits, PopoverContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { PopoverContent, PopoverPortal, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * PopoverContent —— composer 工具区浮层原语。
 * 默认冷蓝浮层样式（bg-elevated/border-strong/shadow-2），向上开由调用方传 side="top"。
 * sideOffset 默认 6（draft .pop.float: bottom calc(100% + 6px)）。
 * z-index 1100 与 SelectContent 统一，高于 Dialog(1000)，确保嵌在 Dialog 内的 Popover 不被压住。
 */
const props = withDefaults(
  defineProps<PopoverContentProps & { class?: HTMLAttributes['class'] }>(),
  { sideOffset: 6 },
)
const emits = defineEmits<PopoverContentEmits>()

const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <PopoverPortal>
    <PopoverContent
      v-bind="forwarded"
      :class="
        cn(
          'z-[1100] min-w-[240px] rounded-md border border-border-strong bg-bg-elevated p-0 text-neutral-fg shadow-2 outline-none reka-popover-transition',
          props.class,
        )
      "
    >
      <slot />
    </PopoverContent>
  </PopoverPortal>
</template>
