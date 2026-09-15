/**
 * useAppUpdate 的启动结果通知轴（D5 决策：上次升级终态的一次性 toast）。
 *
 * main 侧 cleanupCompletedUpdate 在 bootstrapMainWindow 之前运行，返回值缓存在进程级变量。
 * renderer 启动时 invoke 一次 update:getLaunchResult（consumed 一次性，main 清缓存）：
 * - done → info toast sidebar.update.upgradedToast
 * - failed → warning toast sidebar.update.upgradeFailed（A-D1：按错误码细分文案）
 * - rolled-back → warning toast sidebar.update.rolledBack
 *
 * 调用时机：initAutoCheck 内（use-app-update-autocheck.ts，Sidebar 挂载即触发，早于 30s 自动检查）。
 */
import { getLaunchResult as ipcGetLaunchResult } from '@/api/domains/settings'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import { resolveFailedToastKey } from './use-app-update-errors'

const t = i18n.global.t

/**
 * 读取启动结果并显示 toast 通知（D5 决策）。
 * 本函数与同目录其他模块一样是 initAutoCheck 内 fire-and-forget 的异步函数，
 * 非 setup 同步上下文用不了 useI18n()，照抄同目录 useProviderImport.ts 的 global.t 模式（B2 review）。
 */
export async function checkLaunchResult(): Promise<void> {
  try {
    const result = await ipcGetLaunchResult()
    if (!result) return
    const { info, warning } = useToast()
    if (result.status === 'done') {
      info(t('sidebar.update.upgradedToast', { version: result.version }))
    } else if (result.status === 'rolled-back') {
      warning(t('sidebar.update.rolledBack', { version: result.version }))
    } else if (result.status === 'failed') {
      // A-D1：按 result.json error 码映射具体原因+恢复指引，未知/缺失回退通用文案
      warning(t(resolveFailedToastKey(result.error)))
    }
  } catch (e) {
    // best-effort：启动结果通知失败不影响升级流程，用户下次启动仍可重试读取（main 侧缓存未 consumed）
    console.warn('[useAppUpdate] checkLaunchResult failed:', e)
  }
}
