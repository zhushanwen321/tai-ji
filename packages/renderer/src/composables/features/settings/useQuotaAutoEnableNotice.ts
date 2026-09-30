/**
 * useQuotaAutoEnableNotice —— 「新增即默认同意」自动开启 coding-plan 额度显示的 toast 提示。
 *
 * runtime setProvider 新建分支写成功才回传 quotaAutoEnabled（services/quota-auto-enable.ts，
 * 不实报告禁止），本 composable 只负责把该信号转成用户可见提示（含「可在设置中关闭」指引）。
 * 与导入路径的 quotaAutoEnabled toast（useProviderImport）同语义：只在写成功时提示。
 */
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'

export function useQuotaAutoEnableNotice() {
  const toast = useToast()

  /** quotaAutoEnabled 为真且有可展示名时提示（回退 name 提示语境：QuickSetup 传 data.name ?? providerId，编辑体传查得的展示名）。 */
  function notifyQuotaAutoEnabled(enabled: boolean | undefined, name: string | undefined): void {
    if (!enabled || !name) return
    toast.info(i18n.global.t('settings.provider.quotaAutoEnabledToast', { name }))
  }

  return { notifyQuotaAutoEnabled }
}
