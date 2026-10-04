<script setup lang="ts">
/**
 * TextQuestion —— text 问题渲染器（无 options 的纯自由文本分支抽出，设计 D2/D5）。
 *
 * 答案写 `${key}__other` 键位（逐字继承现状纯 other 形态——无 options 题答案只写
 * __other 不写主 key，编码在壳 onSubmit 收口）；此处只负责文本编辑上报。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Textarea } from '@/components/ui/textarea'
import type { TextQuestion } from '@zhushanwen/extension-protocol'
import type { QuestionState } from './question-state'

const props = defineProps<{
  question: TextQuestion
  modelValue: QuestionState
}>()
const emit = defineEmits<{
  'update:modelValue': [state: QuestionState]
}>()

const { t } = useI18n()

/** 文本双向绑定（v-model 代理到状态上报） */
const text = computed({
  get: () => props.modelValue.otherText,
  set: (v: string) => emit('update:modelValue', { ...props.modelValue, otherText: v }),
})
</script>

<template>
  <!-- 无 options 的纯自由文本输入 -->
  <Textarea
    v-model="text"
    rows="3"
    :placeholder="t('extensionUI.inputPlaceholder')"
    data-testid="form-free-text"
  />
</template>
