<template>
  <!--
    诊断包导出动作（crash-forensics-and-watchdog §3.3 D6 / u3b）。
    双入口共享组件：设置 → 系统分区（SystemDiagnosticsSection，default 主按钮）+
    Panel 死态块（进程退出占位，ghost 次级按钮）。单组件收敛「导出前知情确认 +
    三态结果反馈」，两入口不得分叉确认/反馈行为。
  -->
  <!-- 确认对话框：知情文案 = shared DIAGNOSTIC_EXPORT_PRIVACY_NOTICE 原样展示。
       [D6 隐私判定补偿] 有意不走 i18n——该常量是 main 侧 summary.md 与 renderer
       对话框的共用 SSOT（防文案分叉），须保留「本机路径」「会话标识」知情要素。 -->
  <ConfirmDialog
    v-model:open="confirmOpen"
    :title="t('settings.system.diagnosticsConfirmTitle')"
    :description="privacyNotice"
    :confirm-text="t('settings.system.diagnosticsConfirmExport')"
    :cancel-text="t('settings.system.diagnosticsCancel')"
    variant="default"
    :loading="exporting"
    @confirm="onConfirm"
  />
  <Button
    :variant="variant"
    size="sm"
    data-testid="diagnostics-export-btn"
    :disabled="exporting"
    @click="confirmOpen = true"
  >
    <FileDown class="mr-1.5 size-3.5" aria-hidden="true" />
    {{ label ?? t('settings.system.diagnosticsExportBtn') }}
  </Button>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileDown } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { exportDiagnosticBundle } from '@/api/domains/diagnostics'
import { DIAGNOSTIC_EXPORT_PRIVACY_NOTICE } from '@taiji/shared'
import { useToast } from '@/composables/useToast'

withDefaults(defineProps<{
  /** 按钮视觉：default = 设置页主按钮；ghost = 死态块次级动作（对齐「重新打开」行） */
  variant?: 'default' | 'ghost'
  /** 按钮文案覆盖（死态块「导出诊断信息」）；缺省用设置页文案 */
  label?: string
}>(), {
  variant: 'default',
})

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

const confirmOpen = ref(false)
const exporting = ref(false)

/** D6 知情文案：shared 常量 SSOT 原样（与 main 侧 summary.md 同源）。 */
const privacyNotice = DIAGNOSTIC_EXPORT_PRIVACY_NOTICE

/**
 * 确认导出：loading 态防重复提交；三态永不 reject（shared 契约，无需 catch）。
 * exported → 成功 toast 含保存路径并关对话框；error → 错误 toast（含 errno 与
 * 重试指引），对话框保持开启（确认按钮即重试）；canceled → 静默关对话框。
 */
async function onConfirm(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    const res = await exportDiagnosticBundle()
    if (res.status === 'exported') {
      toastInfo(t('settings.system.diagnosticsExportSuccess', { path: res.path }))
      confirmOpen.value = false
    } else if (res.status === 'error') {
      toastError(t('settings.system.diagnosticsExportFailed', { code: res.error.code, message: res.error.message }))
    } else {
      confirmOpen.value = false
    }
  } finally {
    exporting.value = false
  }
}
</script>
