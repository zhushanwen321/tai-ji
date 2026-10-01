<!--
  发音词典行编辑器（ai-voice-tts 设计 §5.2 长尾四区；MiniMax pronunciation_dict.tone /
  StepFun pronunciation_map 共用行格式「原文 → 替换」，逐条添加删除）。
  v-model：TtsPronunciationRule[]（行数组本体归父级表单态）。
-->
<template>
  <div class="flex flex-col gap-2">
    <div
      v-for="(_, i) in modelValue"
      :key="i"
      class="flex items-center gap-2"
      :data-testid="`tts-pronunciation-row-${i}`"
    >
      <Input
        v-model="modelValue[i]!.from"
        :data-testid="`tts-pronunciation-from-${i}`"
        type="text"
        :placeholder="t('settings.tts.pronunciationFromPlaceholder')"
        :disabled="disabled"
        class="h-8 flex-1 text-[12px]"
      />
      <span class="text-[12px] text-neutral-dim" aria-hidden="true">&rarr;</span>
      <Input
        v-model="modelValue[i]!.to"
        :data-testid="`tts-pronunciation-to-${i}`"
        type="text"
        :placeholder="t('settings.tts.pronunciationToPlaceholder')"
        :disabled="disabled"
        class="h-8 flex-1 text-[12px]"
      />
      <Button
        variant="ghost"
        size="icon"
        class="size-7 shrink-0 text-neutral-dim hover:text-neutral-fg"
        :data-testid="`tts-pronunciation-remove-${i}`"
        :title="t('settings.tts.removeRule')"
        :aria-label="t('settings.tts.removeRule')"
        :disabled="disabled"
        @click="removeRow(i)"
      >
        <X class="size-[14px]" />
      </Button>
    </div>
    <div>
      <Button
        variant="secondary"
        size="dense"
        :data-testid="`tts-pronunciation-add-${testid}`"
        :disabled="disabled"
        @click="addRow"
      >
        <Plus class="mr-1 size-[14px]" />
        {{ t('settings.tts.addRule') }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Plus, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { TtsPronunciationRule } from './tts-form-model'

const { t } = useI18n()

defineProps<{
  /** 测试 id 前缀（多实例不撞 testid；父级传 providerId）。 */
  testid: string
  disabled?: boolean
}>()

const modelValue = defineModel<TtsPronunciationRule[]>({ required: true })

function addRow(): void {
  modelValue.value = [...modelValue.value, { from: '', to: '' }]
}

function removeRow(index: number): void {
  modelValue.value = modelValue.value.filter((_, i) => i !== index)
}
</script>
