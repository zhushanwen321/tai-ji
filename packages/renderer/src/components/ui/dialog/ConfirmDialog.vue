<script setup lang="ts">
import { AlertTriangle, Loader2 } from '@lucide/vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '.'
import { Button } from '@/components/ui/button'

/**
 * 确认对话框原语 —— 收敛「标题 + 描述 + 取消/确认」骨架。
 * 复用本地 ui 原语（components/ui）的 Dialog/DialogContent 壳与 Button，禁止原生 button/dialog。
 * 开关走 v-model:open（confirm/cancel 仅做语义回调，关闭由 update:open 统一驱动）。
 */
interface Props {
  /** 受控开关（配合 v-model:open） */
  open: boolean
  /** 标题 */
  title: string
  /** 描述文案（可选） */
  description?: string
  /** 确认按钮文案 */
  confirmText?: string
  /** 取消按钮文案 */
  cancelText?: string
  /** 视觉变体：danger=红色警示确认；default=主色确认 */
  variant?: 'default' | 'danger'
  /** 确认中态：禁用按钮并显示 spinner，防重复提交 */
  loading?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  description: '',
  confirmText: '确认',
  cancelText: '取消',
  variant: 'danger',
  loading: false,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: []
  cancel: []
}>()

/** 取消：先回传 cancel 语义，再统一关闭弹窗 */
function onCancel(): void {
  emit('cancel')
  emit('update:open', false)
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent hide-close class="max-w-[360px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <!-- v6 §6.5：danger 三角 icon 降 size-4 -->
          <AlertTriangle
            v-if="props.variant === 'danger'"
            class="size-4 shrink-0 text-danger"
          />
          {{ props.title }}
        </DialogTitle>
        <DialogDescription v-if="props.description">{{ props.description }}</DialogDescription>
      </DialogHeader>

      <!-- 消费方可放置额外内容（如错误反馈） -->
      <slot />

      <div class="flex justify-end gap-2 pt-4">
        <Button variant="ghost" :disabled="props.loading" @click="onCancel">
          {{ props.cancelText }}
        </Button>
        <Button :variant="props.variant" :disabled="props.loading" @click="emit('confirm')">
          <Loader2 v-if="props.loading" class="animate-spin" />
          {{ props.confirmText }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
