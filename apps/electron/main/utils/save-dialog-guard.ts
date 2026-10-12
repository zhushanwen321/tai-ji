/**
 * save dialog 打开失败的降级分流单源（导出族 IPC handler 共用）。
 *
 * 错误三态契约：对话框崩溃不向 renderer 抛 invoke rejection，降级为可判定的
 * EDIALOG error；取消/未选路径分流 canceled；成功返回 save 供调用方继续导出。
 */
import { mainLogger } from '../logs/main-logger.js'

export type SaveDialogGuardResult<T> =
  | { status: 'canceled' }
  | { status: 'ok'; save: T }
  | { status: 'error'; error: { code: 'EDIALOG'; message: string } }

export async function runSaveDialogGuarded<T extends { canceled: boolean; filePath?: string }>(
  opts: { logTag: string; show: () => Promise<T> },
): Promise<SaveDialogGuardResult<T>> {
  let save: T
  try {
    save = await opts.show()
  } catch (err) {
    // 对话框崩溃同样降级为可判定的错误三态（不向 renderer 抛 invoke rejection）
    mainLogger.warn(`[${opts.logTag}] save dialog failed: ${err instanceof Error ? err.message : String(err)}`)
    return { status: 'error', error: { code: 'EDIALOG', message: '保存对话框打开失败' } }
  }
  if (save.canceled || save.filePath === undefined) return { status: 'canceled' }
  return { status: 'ok', save }
}
