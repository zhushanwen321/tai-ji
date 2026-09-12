<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "../../lib/utils"

const props = defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  // 只触发 border-danger 边框态，不自带错误文案：文案归表单层（FormMessage 惯例）承载，
  // Input 内嵌文案会破坏表单分层（P1-3 裁决，范式见 docs/page-design/v6-master-spec.md §5.1）
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
  <input v-model="modelValue" :class="cn('flex h-10 w-full rounded-md border border-input bg-surface-2 px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-neutral-fg file:text-sm file:font-medium placeholder:text-neutral-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-ring disabled:cursor-not-allowed disabled:opacity-50', error && 'border-danger', props.class)">
</template>
