<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { useVModel } from '@vueuse/core'
import { cn } from '@/lib/utils'

/**
 * Textarea —— shadcn-vue 风格多行输入原子组件。
 * 存在意义：no-native-html-elements 规则禁止组件外裸用 <textarea>，
 * Composer 输入区需此原语。
 */
const props = defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  /** 校验错误态（demo settings spec §6 三件套）：border-danger + aria-invalid；
   *  错误文案归表单层在字段正下方行内渲染，不内嵌（与 Input.error 同分层）。 */
  error?: boolean
  class?: HTMLAttributes['class']
}>()

const emits = defineEmits<{
  (e: 'update:modelValue', payload: string | number): void
}>()

const modelValue = useVModel(props, 'modelValue', emits, {
  passive: true,
  defaultValue: props.defaultValue,
})

// 形态对齐 demo pages.css .pg-set .ta：底 --bg-input / 内边距 8px 12px / 字号
// --text-sm(13px) / resize 纵向；焦点双通道 = 边框提亮 --border-strong + :focus-visible
// 2px var(--focus-ring) outline 内缩 1px（焦点指示唯一令牌，与 Input/Switch 原语同款）。
// [M7b] template 根级禁放 HTML 注释（同 Input：单根组件会被注释变 fragment，$el 失效）。
</script>

<template>
  <textarea
    v-model="modelValue"
    :aria-invalid="error ? 'true' : undefined"
    :class="
      cn(
        'flex min-h-[40px] w-full resize-y rounded-md border border-input bg-bg-input px-[12px] py-[8px] text-[length:var(--text-sm)] placeholder:text-neutral-mid outline-none focus-visible:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--focus-ring)] focus-visible:-outline-offset-1 disabled:cursor-not-allowed disabled:opacity-50',
        props.error && 'border-danger',
        props.class,
      )
    "
  />
</template>
