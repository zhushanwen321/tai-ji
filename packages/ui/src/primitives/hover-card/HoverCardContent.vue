<script setup lang="ts">
import type { HoverCardContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { HoverCardContent, HoverCardPortal, useForwardPropsEmits } from 'reka-ui'
import { cn } from '../../lib/utils'

/**
 * HoverCardContent —— hover 触发的浮层原语（§2a 上下文容量 / §2f 已附条目）。
 * 与 PopoverContent 同源样式，hover 态生命周期由 reka-ui HoverCard 管理。
 * z-index = --z-hovercard(500)（demo 梯队：hovercard 不压 modal、与 dialog 分档；
 * 原 z-[90] 不在梯队）。圆角 12px（demo --r-lg = 本仓 --radius-lg，rounded-lg 档）：
 * demo hover 详情卡三参照一致（.sess-pop/.qs-panel/.stats-pop），与菜单族 PopoverContent 的 8px 分档。
 *
 * inheritAttrs=false + $attrs 手动绑到内部 reka HoverCardContent：本封装模板单根是
 * HoverCardPortal（渲染为 Teleport，非普通元素根），Vue 对 Teleport 根不继承 fallthrough
 * attrs——消费方传的 data-testid / 额外事件监听会在 Portal 边界被静默丢弃（Vue
 * "Extraneous non-props attributes" 警告），显式转发后落到真正的浮层 DOM（与 PopoverContent
 * 已修形态一致）。
 */
const props = withDefaults(
  defineProps<HoverCardContentProps & { class?: HTMLAttributes['class'] }>(),
  { sideOffset: 6 },
)
defineOptions({ inheritAttrs: false })
const emits = defineEmits<{ 'update:open': [payload: boolean] }>()

const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <HoverCardPortal>
    <HoverCardContent
      v-bind="{ ...forwarded, ...$attrs }"
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
