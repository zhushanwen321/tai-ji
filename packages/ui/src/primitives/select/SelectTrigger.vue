<script setup lang="ts">
import type { SelectTriggerProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { SelectIcon, SelectTrigger } from 'reka-ui'
import { ChevronDown } from '@lucide/vue'
import { cn } from '../../lib/utils'

/**
 * SelectTrigger —— 触发器，形态收敛到 demo pages.css .pg-set .sel-btn（与 renderer 侧
 * @/components/ui/select/SelectTrigger 副本同源同形态）：高 32px、水平内边距 10px、
 * 边框 --border / 底 --bg-input、hover 边框提亮 --border-strong。焦点 = :focus-visible
 * 2px var(--focus-ring)（焦点指示唯一令牌，= accent 别名）outline 内缩 1px，旧
 * ring-inset 双环通道退役。右侧自带 ChevronDown 10px --neutral-mid。
 * 尺寸可通过 class 覆盖（如 h-8）。
 *
 * gap-2 + whitespace-nowrap：间距对齐 demo .sel-btn { gap: 8px }；nowrap 防止
 * 「High / Max」这类带空格文案在窄触发器（如 w-[88px]）里折行。
 */
const props = defineProps<SelectTriggerProps & { class?: HTMLAttributes['class'] }>()
const delegatedProps = reactiveOmit(props, 'class')
</script>

<template>
  <SelectTrigger
    v-bind="delegatedProps"
    :class="
      cn(
        'flex h-[32px] w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-border bg-bg-input px-[10px] text-[length:var(--text-sm)] text-neutral-fg outline-none transition-colors hover:border-border-strong placeholder:text-neutral-mid focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--focus-ring)] focus-visible:-outline-offset-1 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-neutral-mid',
        props.class,
      )
    "
  >
    <slot />
    <SelectIcon as-child>
      <ChevronDown class="size-[10px] shrink-0 text-neutral-mid transition-transform duration-[var(--duration)] ease-[var(--ease)]" />
    </SelectIcon>
  </SelectTrigger>
</template>
