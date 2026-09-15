<script setup lang="ts">
import type { HoverCardContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { HoverCardContent, HoverCardPortal, useForwardPropsEmits } from 'reka-ui'
import { cn } from '../../lib/utils'

/**
 * HoverCardContent —— hover 触发的浮层原语（§2a 上下文容量 / §2f 已附条目）。
 * 与 PopoverContent 同源样式，hover 态生命周期由 reka-ui HoverCard 管理。
 */
const props = withDefaults(
  defineProps<HoverCardContentProps & { class?: HTMLAttributes['class'] }>(),
  { sideOffset: 6 },
)
const emits = defineEmits<{ 'update:open': [payload: boolean] }>()

const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <HoverCardPortal>
    <HoverCardContent
      v-bind="forwarded"
      :class="
        cn(
          'z-[90] min-w-[240px] rounded-md border border-border-strong bg-bg-elevated p-0 text-neutral-fg shadow-2 outline-none reka-popover-transition',
          props.class,
        )
      "
    >
      <slot />
    </HoverCardContent>
  </HoverCardPortal>
</template>
