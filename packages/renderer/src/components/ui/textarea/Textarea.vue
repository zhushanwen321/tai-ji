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
// --text-sm(13px) / resize 纵向；焦点 = inset 中性边（与 Input 同构，M4a 决 5）。
// [M7b] template 根级禁放 HTML 注释（同 Input：单根组件会被注释变 fragment，$el 失效）。
</script>

<template>
  <textarea
    v-model="modelValue"
    :class="
      cn(
        'flex min-h-[40px] w-full resize-y rounded-md border border-input bg-bg-input px-[12px] py-[8px] text-[length:var(--text-sm)] placeholder:text-neutral-mid focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--border-strong)] disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )
    "
  />
</template>
