<script setup lang="ts">
import type { LabelProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { cn } from "../../lib/utils"
import { Label } from "reka-ui"

// 形态对齐 demo pages.css .pg-set .flab：--text-xs(12px) + fw-mid(600)。
// [M7b] template 根级禁放 HTML 注释（同 Input：单根组件会被注释变 fragment，$el 失效）。
const props = defineProps<LabelProps & { class?: HTMLAttributes["class"] }>()
</script>

<template>
  <Label
    :class="cn(
      'text-[length:var(--text-xs)] font-semibold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      props.class,
    )"
  >
    <slot />
  </Label>
</template>
