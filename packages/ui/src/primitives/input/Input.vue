<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "../../lib/utils"

const props = defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  // 只触发 border-danger 边框态，不自带错误文案：文案归表单层（FormMessage 惯例）承载，
  // Input 内嵌文案会破坏表单分层（P1-3 裁决）。校验三件套（demo settings spec §6）：
  // error 同时置 aria-invalid，行内错误文案由消费方在字段正下方渲染。
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

// 形态收敛（settings 输入框统一裁决）：与 renderer 侧 @/components/ui/input 副本同源同形态，
// 对齐 demo pages.css .pg-set .inp——高 32px / 底 --bg-input / 水平内边距 12px / 字号
// --text-sm；焦点双通道 = 边框提亮 --border-strong + :focus-visible outline 2px
// var(--focus-ring)（焦点指示唯一令牌，= accent 别名）内缩 1px。旧形态（h-10
// bg-surface-2 ring-inset ring-accent-ring）退役：settings 域同一输入框范式不允许两套
// （ProviderEditBody / ProviderQuickSetup 等未覆写高度的消费点随之统一 32px）。
// [M7b] template 根级禁放 HTML 注释：注释会让单根组件变 fragment，$el 契约失效
// （SearchModal open autofocus 经 $el 聚焦本组件；renderer Input 头注释同款教训）。
</script>

<template>
  <input v-model="modelValue" :aria-invalid="error ? 'true' : undefined" :class="cn('flex h-[32px] w-full rounded-md border border-input bg-bg-input px-[12px] text-[length:var(--text-sm)] file:border-0 file:bg-transparent file:text-neutral-fg file:text-sm file:font-medium placeholder:text-neutral-mid outline-none focus-visible:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--focus-ring)] focus-visible:-outline-offset-1 disabled:cursor-not-allowed disabled:opacity-50', error && 'border-danger', props.class)">
</template>
