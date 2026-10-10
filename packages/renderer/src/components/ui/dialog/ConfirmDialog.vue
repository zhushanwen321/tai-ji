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
    <!-- 形态对齐 demo pages.css .pg-set .cpop（确认弹窗基准）：宽 min(360px, 100vw-48px)
         （窄窗两侧各留 24px）/ 圆角 --r-md(8px) / 标题→描述 8px（Header gap-y-2）/
         描述→按钮区 16px（网格 gap-[16px]，actions 自带 padding-top 退役） -->
    <DialogContent hide-close class="max-w-[min(360px,calc(100vw_-_48px))] gap-[16px] rounded-md">
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

      <!-- 钮形态族对齐 demo pages.css .pg-set .btn（32px 高 / 12px 水平内距 / 6px 间距 /
           --fw-mid 600 字重 / 字号 var(--text-sm)=13px）与 :12-15 内缩焦点环（2px accent 内缩
           1px，focus-visible:outline 声明 style 顶掉 cva outline-none 的 transparent，缺它
           outline-2/accent 不渲染）；消费点覆写，不动全局 cva 基类（基类 text-sm = 0.875rem ×
           html 14px = 12.25px，与 demo .btn 13px 差半像素档）。取消钮 ghost 字色对齐 demo
           .btn.ghost（neutral-mid，hover 提亮 fg）。 -->
      <div class="flex justify-end gap-2">
        <Button
          variant="ghost"
          :disabled="props.loading"
          class="h-[32px] px-[12px] gap-[6px] [font-weight:var(--fw-mid)] text-[length:var(--text-sm)] text-neutral-mid hover:text-neutral-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--focus-ring)] focus-visible:-outline-offset-1 focus-visible:shadow-none"
          @click="onCancel"
        >
          {{ props.cancelText }}
        </Button>
        <!-- danger 分支走 danger-solid 实底重钮（demo pages.css .btn.danger-solid 权威形态；
             danger 幽灵档权重不足），default 分支 accent 实底已对齐 .btn.solid -->
        <Button
          :variant="props.variant === 'danger' ? 'danger-solid' : 'default'"
          :disabled="props.loading"
          class="h-[32px] px-[12px] gap-[6px] [font-weight:var(--fw-mid)] text-[length:var(--text-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--focus-ring)] focus-visible:-outline-offset-1 focus-visible:shadow-none"
          @click="emit('confirm')"
        >
          <Loader2 v-if="props.loading" class="animate-spin" />
          {{ props.confirmText }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
