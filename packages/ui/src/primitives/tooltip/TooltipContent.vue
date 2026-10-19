<script setup lang="ts">
import type { TooltipContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { TooltipContent, TooltipPortal, useForwardPropsEmits } from 'reka-ui'
import { cn } from '../../lib/utils'

/**
 * TooltipContent —— 主题化提示浮层（对齐 PopoverContent / HoverCardContent 同源档：
 * bg-bg + border + shadow-2，2026-10-13 用户裁决 demo 方案 A 浮层族）。
 *
 * 与两位多内容浮层兄弟的分档：tooltip 是单行/少行纯文本提示，圆角取 radius-sm（6px，
 * 输入框/标签档）、内边距紧凑（10×6）、字号 text-xs、上限 max-w 280px（长文案折行
 * 不横铺）；多行文本（headerAction tooltip 的 `\n` 拼接）由 whitespace-pre-line 承载。
 * z-index = --z-hovercard(500)：与 hover 详情卡同档（都不压 dialog/modal）。
 *
 * inheritAttrs=false + $attrs 手动绑到内部 reka TooltipContent：本封装模板单根是
 * TooltipPortal（Teleport 根），Vue 对 Teleport 根不继承 fallthrough attrs——消费方
 * 的 data-testid / 额外监听会静默丢弃，显式转发后落到真正的浮层 DOM（PopoverContent
 * / HoverCardContent 已修形态一致）。
 */
const props = withDefaults(
  defineProps<TooltipContentProps & { class?: HTMLAttributes['class'] }>(),
  { sideOffset: 6 },
)
defineOptions({ inheritAttrs: false })
const emits = defineEmits<{ 'update:open': [payload: boolean] }>()

const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <TooltipPortal>
    <TooltipContent
      v-bind="{ ...forwarded, ...$attrs }"
      :class="
        cn(
          'z-[var(--z-hovercard)] max-w-[280px] rounded-[var(--radius-sm)] border border-border bg-bg px-[10px] py-[6px] text-[length:var(--text-xs)] leading-relaxed text-neutral-fg-2 shadow-2 outline-none reka-popover-transition whitespace-pre-line',
          props.class,
        )
      "
    >
      <slot />
    </TooltipContent>
  </TooltipPortal>
</template>
