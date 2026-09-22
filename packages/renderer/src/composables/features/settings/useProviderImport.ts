/**
 * useProviderImport —— 从其他 agent 迁移 Provider 配置的业务编排（W2 · cw-2026-07-26-migration-other-agents）。
 *
 * 承载有限状态机 idle → loading-preview → previewing → applying，封装 preview/apply RPC
 * 与 toast 结果反馈，让 ProviderPage.vue 仅持有展示态。
 *
 * 数据流：
 *   onImportSelect(source)
 *     → config.previewImportProviders(source)
 *     → 成功：存 importId + importPreview，转入 'previewing'
 *     → 失败（envelope error 或 transport reject）：toast 报错，回 'idle'
 *   onImportConfirm(selectedIds)
 *     → config.applyImportProviders(importId, selectedIds)
 *     → 成功：toast 导入/跳过/失败统计 + key 缺失提示；有失败项保留 preview 供回查（RD-4#12），
 *       全部成功才复位 idle
 *     → 失败（envelope error 或 transport reject）：保持 'previewing' 允许重试
 *
 * 注意：config.previewImportProviders/applyImportProviders 在 transport 层（请求超时、
 * WebSocket 断连 pending.rejectAll、传输发送失败）会 reject Promise，故两个 async 函数
 * 都用 try/catch 包裹 await，避免 importState 卡死在 'loading-preview'/'applying'。
 *
 * 依赖方向：@taiji/shared 类型 + @/api(config) + useToast + i18n。
 */
import { ref } from 'vue'
import { config } from '@/api'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import type {
  ProviderSource,
  ProviderImportPreview,
  ProviderImportResult,
  ProviderImportedItem,
} from '@taiji/shared'

const t = i18n.global.t

/**
 * 凭据形态 → 提示 i18n key 表（成员顺序即 toast 顺序）：env/oauth/command/env-bundle
 * 四态的「providers + orphanCredentials 两源计数 > 0 即 toast」为同构逻辑，表驱动单循环。
 * missing（仅统计 providers、文案无 count）与 orphan 总数是差异分支，不在此表。
 */
const CREDENTIAL_TYPE_HINTS = [
  { type: 'env', key: 'settings.provider.importToast.envVarNeeded' },
  { type: 'oauth', key: 'settings.provider.importToast.oauthSkipped' },
  { type: 'command', key: 'settings.provider.importToast.commandInjection' },
  { type: 'env-bundle', key: 'settings.provider.importToast.envBundleSkipped' },
] as const

/** 导入流程状态 */
type ImportState = 'idle' | 'loading-preview' | 'previewing' | 'applying'

export function useProviderImport() {
  const { info: toastInfo, error: toastError } = useToast()

  const importState = ref<ImportState>('idle')
  const importSource = ref<ProviderSource | null>(null)
  const importId = ref<string | null>(null)
  const importPreview = ref<ProviderImportPreview | null>(null)
  const importError = ref('')

  /** 选中源 agent → 拉 preview（transport reject 时回 idle + toast） */
  async function onImportSelect(source: ProviderSource): Promise<void> {
    importSource.value = source
    importState.value = 'loading-preview'
    importError.value = ''
    try {
      const result = await config.previewImportProviders(source)
      if ('error' in result) {
        importError.value = result.error.message
        importState.value = 'idle'
        toastError(result.error.message)
        return
      }
      importId.value = result.importId
      importPreview.value = result.preview
      importError.value = ''
      importState.value = 'previewing'
    } catch (e) {
      // transport 层 reject（请求超时 / WebSocket 断连 pending.rejectAll / 传输发送失败）
      const msg = e instanceof Error ? e.message : String(e)
      importError.value = msg
      importState.value = 'idle'
      toastError(msg)
    }
  }

  /** 确认导入 → apply（失败保持对话框开允许重试） */
  async function onImportConfirm(selectedIds: string[]): Promise<void> {
    if (!importId.value) return
    importState.value = 'applying'
    importError.value = ''
    try {
      const result = await config.applyImportProviders(importId.value, selectedIds)
      if ('error' in result) {
        importError.value = result.error.message
        importState.value = 'previewing'
        return
      }
      reportImportSuccess(result.result, selectedIds)
      // RD-4#12：有失败项时保留 preview（不 reset），让用户可在弹窗回查失败条目——此前成功后
      // 立刻 resetImportState() 清空 preview，用户无法回查。全部成功才 reset 关闭弹窗。保留期间
      // importState 留 'previewing'（弹窗不关）；用户关闭弹窗（onPreviewDialogToggle）或重新
      // 导入（onImportSelect）时清空。注：弹窗内「灰显失败行」需 ProviderImportPreviewDialog
      // （packages/ui，非本包域）渲染 result 逐条 status，本包仅保留 preview 数据供回查 +
      // toast 已报 failedCount；行级灰显列为跨包协调项。
      if (result.result.failedCount > 0) {
        importState.value = 'previewing'
      } else {
        resetImportState()
      }
    } catch (e) {
      // transport 层 reject（请求超时 / WebSocket 断连 pending.rejectAll / 传输发送失败）：
      // 回 previewing 保留对话框允许重试 + toast
      const msg = e instanceof Error ? e.message : String(e)
      importError.value = msg
      importState.value = 'previewing'
      toastError(msg)
    }
  }

  /** apply 成功后的结果反馈编排：success/failed 统计 toast → 凭据形态提示 → quota 提示（顺序即既有约定） */
  function reportImportSuccess(result: ProviderImportResult, selectedIds: string[]): void {
    const { imported, failedCount } = result
    const ok = imported.filter((i) => i.status === 'imported').length
    toastInfo(t('settings.provider.importToast.success', { count: ok }))
    if (failedCount > 0) {
      toastError(t('settings.provider.importToast.failed', { count: failedCount }))
    }
    toastCredentialTypeHints(selectedIds)
    toastQuotaAutoEnabled(imported)
  }

  /**
   * wave 4 import-credential-types：分类提示选中 provider 的凭据形态
   * - missing：apiKey 空，需手填；env：$ENV 引用，需确保环境变量已设；oauth：Phase 2 跳过
   * sa3 F1：组 2 孤儿凭据同样参与凭据形态统计（providerId 是勾选 id）
   * sa3 F1（B.5/M4）：command 态导入后 toast 命令注入警告；env-bundle 态提示 Phase 1 跳过
   */
  function toastCredentialTypeHints(selectedIds: string[]): void {
    const selectedProviders = importPreview.value?.providers.filter((p) => selectedIds.includes(p.id)) ?? []
    // sa3 F1：组 2 孤儿凭据同样参与凭据形态统计（providerId 是勾选 id）
    const selectedOrphans = importPreview.value?.orphanCredentials?.filter((o) => selectedIds.includes(o.providerId)) ?? []
    // missing 仅 providers 参与（孤儿凭据恒有 key 或已跳过），文案无 count
    const missingCount = selectedProviders.filter((p) => p.credentialType === 'missing').length
    if (missingCount > 0) {
      toastInfo(t('settings.provider.importToast.partialKeyMissing'))
    }
    // 表驱动：每类计数 = providers + orphans 两源合计（两源字段名不同，注意映射）
    for (const { type, key } of CREDENTIAL_TYPE_HINTS) {
      const count =
        selectedProviders.filter((p) => p.credentialType === type).length +
        selectedOrphans.filter((o) => o.credentialType === type).length
      if (count > 0) {
        toastInfo(t(key, { count }))
      }
    }
    if (selectedOrphans.length > 0) {
      toastInfo(t('settings.provider.importToast.orphanImported', { count: selectedOrphans.length }))
    }
  }

  /**
   * coding-plan 额度显示自动开启提示（导入即默认同意）：runtime 在结果条目标记
   * quotaAutoEnabled（写 extras 成功才置位），前端不推算不实报。单条带 name，多条带 count
   */
  function toastQuotaAutoEnabled(imported: ProviderImportedItem[]): void {
    const quotaEnabledItems = imported.filter((i) => i.status === 'imported' && i.quotaAutoEnabled)
    if (quotaEnabledItems.length === 1) {
      toastInfo(t('settings.provider.importToast.quotaAutoEnabledOne', { name: quotaEnabledItems[0].name }))
    } else if (quotaEnabledItems.length > 1) {
      toastInfo(t('settings.provider.importToast.quotaAutoEnabledMany', { count: quotaEnabledItems.length }))
    }
  }

  /** 预览弹窗开关受控：关闭（非 applying）时复位导入态 */
  function onPreviewDialogToggle(open: boolean): void {
    if (!open && importState.value !== 'applying') {
      resetImportState()
    }
  }

  function resetImportState(): void {
    importState.value = 'idle'
    importSource.value = null
    importId.value = null
    importPreview.value = null
    importError.value = ''
  }

  return {
    importState,
    importSource,
    importId,
    importPreview,
    importError,
    onImportSelect,
    onImportConfirm,
    onPreviewDialogToggle,
    resetImportState,
  }
}
