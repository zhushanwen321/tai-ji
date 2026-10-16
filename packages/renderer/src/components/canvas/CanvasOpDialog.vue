<!--
  CanvasOpDialog —— 画布用户操作对话框（单一表单载体；problem-solve-canvas §3.1(3)）。

  规格驱动：字段清单来自 canvas-ops.ts opSpecOf（title/fields/required），本组件只渲染
  与收集——九类用户操作（选定/否决/转移/评论/编辑/判据/处置/派发/方向裁决）共用一个
  实例，操作语义不内联在组件里（防九个对话框组件各行其是）。控件全量 @taiji/ui
  （禁原生表单元素）；required 为空拦截提交；criterias 字段 = 多行原文一行一条。
-->
<template>
  <Dialog :open="open">
    <DialogContent class="max-w-md" data-testid="canvas-op-dialog">
      <DialogHeader>
        <DialogTitle>{{ t(spec.titleKey) }}</DialogTitle>
        <DialogDescription>{{ t('panel.canvas.op.dialogDesc') }}</DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-3">
        <!-- 换选前置告知（select 迁移语义：旧选定子树将进入待重审——D9） -->
        <p
          v-if="spec.replacedOptionId"
          class="rounded-sm border border-warn bg-warn-soft px-2 py-1.5 text-[length:var(--text-2xs)] text-warn"
          data-testid="canvas-op-replace-hint"
        >
          {{ t('panel.canvas.op.replaceHint', { previous: replacedLabel }) }}
        </p>

        <div v-for="field in spec.fields" :key="field.key" class="flex flex-col gap-1.5">
          <Label :for="`canvas-op-field-${field.key}`" class="text-[length:var(--text-2xs)] text-neutral-mid">
            {{ t(field.labelKey) }}<span v-if="field.required" class="text-danger"> *</span>
          </Label>
          <Textarea
            v-if="field.kind === 'textarea' || field.kind === 'criterias'"
            :id="`canvas-op-field-${field.key}`"
            v-model="values[field.key]"
            :rows="field.kind === 'criterias' ? 4 : 3"
            :placeholder="field.placeholderKey ? t(field.placeholderKey) : undefined"
            :data-testid="`canvas-op-field-${field.key}`"
          />
          <Select
            v-else-if="field.kind === 'select'"
            v-model="values[field.key]"
          >
            <SelectTrigger :id="`canvas-op-field-${field.key}`" :data-testid="`canvas-op-field-${field.key}`">
              <SelectValue :placeholder="field.placeholderKey ? t(field.placeholderKey) : undefined" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="opt in field.options ?? []"
                :key="opt.value"
                :value="opt.value"
                :data-testid="`canvas-op-option-${opt.value}`"
              >{{ t(opt.labelKey) }}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            v-else
            :id="`canvas-op-field-${field.key}`"
            v-model="values[field.key]"
            :placeholder="field.placeholderKey ? t(field.placeholderKey) : undefined"
            :data-testid="`canvas-op-field-${field.key}`"
          />
        </div>

        <p v-if="submittedEmpty" class="text-[length:var(--text-2xs)] text-danger" data-testid="canvas-op-required-error">
          {{ t('panel.canvas.op.requiredMissing') }}
        </p>
      </div>

      <div class="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" data-testid="canvas-op-cancel" @click="emit('cancel')">
          {{ t('panel.canvas.op.cancel') }}
        </Button>
        <Button variant="default" size="sm" :disabled="busy" data-testid="canvas-op-submit" @click="submit">
          {{ t(spec.submitKey) }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { CanvasOpSpec, CanvasOpValues } from './canvas-ops'

const props = defineProps<{
  open: boolean
  spec: CanvasOpSpec
  /** 提交中（mutate 在途——防重复提交）。 */
  busy?: boolean
  /** 换选提示里的旧选定标题（展示用）。 */
  replacedLabel?: string
}>()

const emit = defineEmits<{
  submit: [values: CanvasOpValues]
  cancel: []
}>()

const { t } = useI18n()

const values = reactive<CanvasOpValues>({})
const submittedEmpty = ref(false)

// 打开时按字段回填初值（编辑内容/判据），关闭清残留
watch(
  () => [props.open, props.spec],
  () => {
    submittedEmpty.value = false
    for (const key of Object.keys(values)) delete values[key]
    if (!props.open) return
    for (const field of props.spec.fields) {
      if (field.initial !== undefined) values[field.key] = field.initial
    }
  },
  { immediate: true },
)

function submit(): void {
  const missing = props.spec.fields.some(
    (f) => f.required && (values[f.key] ?? '').trim() === '',
  )
  if (missing) {
    submittedEmpty.value = true
    return
  }
  submittedEmpty.value = false
  emit('submit', { ...values })
}
</script>
