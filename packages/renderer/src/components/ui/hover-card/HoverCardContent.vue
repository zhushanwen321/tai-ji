<script setup lang="ts">
import type { HoverCardContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { HoverCardContent, HoverCardPortal, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * HoverCardContent —— hover 触发的浮层原语（§2a 上下文容量 / §2f 已附条目）。
 * 与 PopoverContent 同源样式，hover 态生命周期由 reka-ui HoverCard 管理。
 * z-index = --z-hovercard(500)（demo 梯队：hovercard 不压 modal、与 dialog 分档；
 * 原 z-[90] 不在梯队）。圆角 --r-lg(12px)：demo hover 详情卡三参照一致
 * （.sess-pop/.qs-panel/.stats-pop 均 var(--r-lg)），与菜单族 PopoverContent 的 8px 分档。
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
          'z-[var(--z-hovercard)] min-w-[240px] rounded-lg border border-border-strong bg-bg-elevated p-0 text-neutral-fg shadow-2 outline-none reka-popover-transition',
          props.class,
        )
      "
    >
      <slot />
    </HoverCardContent>
  </HoverCardPortal>
</template>
