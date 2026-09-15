<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-[360px]">
      <DialogHeader>
        <DialogTitle>{{ t('sidebar.renameDialog.title') }}</DialogTitle>
        <DialogDescription>{{ t('sidebar.renameDialog.desc') }}</DialogDescription>
      </DialogHeader>

      <form class="mt-2 space-y-4" @submit.prevent="onSubmit">
        <div class="space-y-2">
          <Label for="rename-session-label">{{ t('sidebar.renameDialog.nameLabel') }}</Label>
          <Input
            id="rename-session-label"
            ref="inputRef"
            v-model="label"
            :aria-invalid="hasVisibleError"
            aria-describedby="rename-session-label-message"
            :placeholder="t('sidebar.renameDialog.namePlaceholder')"
            autocomplete="off"
          />
          <p
            v-if="hasVisibleError"
            id="rename-session-label-message"
            class="text-[12px] font-medium text-danger"
          >
            {{ visibleError }}
          </p>
        </div>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" @click="onCancel">
            {{ t('sidebar.renameDialog.cancel') }}
          </Button>
          <Button type="submit" size="sm">
            {{ t('sidebar.renameDialog.confirm') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSessionStore } from '@/stores/session'

const { t } = useI18n()

const props = defineProps<{
  open: boolean
  sessionId: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: [payload: { sessionId: string; label: string }]
}>()

const session = useSessionStore()
const inputRef = ref<InstanceType<typeof Input> | null>(null)

const MAX_LABEL_LENGTH = 60

/** 单字段内联校验（label: min1/max60/无换行），返回错误文案或空串 */
function validateLabel(value: string): string {
  if (value.length < 1) return t('sidebar.renameDialog.validationRequired')
  if (value.length > MAX_LABEL_LENGTH) {
    return t('sidebar.renameDialog.validationMaxLength', { max: MAX_LABEL_LENGTH })
  }
  if (/[\r\n]/.test(value)) {
    return t('sidebar.renameDialog.validationPattern', { max: MAX_LABEL_LENGTH })
  }
  return ''
}

const label = ref('')
// 错误仅在校验值偏离打开时初值（用户输入过）或尝试提交后展示，对齐改写前表单库「初始未 touched 不报错」行为
const initialValue = ref('')
const submitAttempted = ref(false)

const validationError = computed(() => validateLabel(label.value))
const hasVisibleError = computed(
  () => (label.value !== initialValue.value || submitAttempted.value) && !!validationError.value,
)
const visibleError = computed(() => (hasVisibleError.value ? validationError.value : ''))

function currentLabel(): string {
  return session.list.find((s) => s.id === props.sessionId)?.label ?? ''
}

function focusInput(): void {
  nextTick(() => {
    const el = inputRef.value?.$el as HTMLInputElement | undefined
    el?.focus()
    el?.select()
  })
}

function resetState(): void {
  initialValue.value = currentLabel()
  label.value = initialValue.value
  submitAttempted.value = false
}

function onOpenChange(value: boolean): void {
  emit('update:open', value)
  if (value) {
    resetState()
    focusInput()
  }
}

function onCancel(): void {
  emit('update:open', false)
}

function onSubmit(): void {
  submitAttempted.value = true
  if (validationError.value) return
  emit('confirm', { sessionId: props.sessionId, label: label.value.trim() })
  emit('update:open', false)
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      resetState()
      focusInput()
    }
  },
  { immediate: true },
)
</script>
