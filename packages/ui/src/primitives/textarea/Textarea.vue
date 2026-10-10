<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { useVModel } from '@vueuse/core'
import { cn } from '../../lib/utils'

/**
 * Textarea —— shadcn-vue 风格多行输入原子组件。
 * 存在意义：no-native-html-elements 规则禁止组件外裸用 <textarea>，
 * Composer 输入区需此原语。
 * 形态收敛（settings 输入框统一裁决）：与 renderer 侧 @/components/ui/textarea 副本同源
 * 同形态，对齐 demo pages.css .pg-set .ta——底 --bg-input / 内边距 8px 12px / 字号
 * --text-sm / resize 纵向；焦点双通道 = 边框提亮 --border-strong + :focus-visible 2px
 * var(--focus-ring)（焦点指示唯一令牌）outline 内缩 1px。error = 校验三件套边框通道
 * （border-danger + aria-invalid，文案归表单层行内渲染）。
 */
const props = defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
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
