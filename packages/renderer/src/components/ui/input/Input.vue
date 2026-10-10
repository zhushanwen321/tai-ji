<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "@/lib/utils"

/**
 * 形态对齐 demo pages.css .pg-set .inp：高 32px / 边框 --border / 底 --bg-input /
 * 水平内边距 12px / 字号 --text-sm(13px)；焦点 = :focus-visible 2px accent outline
 * 内缩 1px（demo pages.css 焦点通道，--focus-ring = var(--accent)，与 Switch 原语
 * 同款；Chromium 文本框鼠标聚焦恒命中 :focus-visible，故鼠标/键盘同通道）。
 * 几何用绝对 px（rem 类随用户字号档缩放致几何漂移，
 * Switch 头注释同款纪律）。
 * [M7b] template 根级禁放 HTML 注释：单根组件会被注释变 fragment，$el 契约失效
 * （ChoiceQuestion/ScheduleForm 经 $el.focus() 聚焦本组件，U21 回归教训）。
 */
const props = defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  error?: boolean
  class?: HTMLAttributes["class"]
}>()

const emits = defineEmits<{
  (e: "update:modelValue", payload: string | number): void
}>()

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  defaultValue: props.defaultValue,
})
</script>

<template>
  <input v-model="modelValue" :class="cn('flex h-[32px] w-full rounded-md border border-input bg-bg-input px-[12px] text-[length:var(--text-sm)] file:border-0 file:bg-transparent file:text-neutral-fg file:text-sm file:font-medium placeholder:text-neutral-mid outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-1 disabled:cursor-not-allowed disabled:opacity-50', error && 'border-danger', props.class)">
</template>
