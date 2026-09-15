/**
 * 诊断包导出 IPC handler（crash-forensics-and-watchdog §3.3 D6，实施计划 u3a）。
 *
 * 经 DIAGNOSTICS_EXPORT_BUNDLE（'diagnostics:export-bundle'）通道把诊断打包主体
 * （./export-diagnostic-bundle.ts exportDiagnosticBundle）暴露为 renderer 入口：
 * main 先经 dialog.showSaveDialog 让用户自选保存位置（D6；u3b 确认对话框在 renderer
 * 侧弹出，知情文案共用 shared DIAGNOSTIC_EXPORT_PRIVACY_NOTICE），取消返回 canceled，
 * 打包/写盘失败归一进 result.error（具体 errno）——本文件只做 IPC 接线，收集与 zip
 * 语义全在 export-diagnostic-bundle.ts。
 *
 * 先例 = logs/log-retention-ipc.ts：ipcMain.handle 注册幂等（registered 标志防 Electron
 * 「second handler」炸启动）+ 零抛错（invoke 无 rejection 面，失败形态对齐
 * DiagnosticExportBundleResult 三态契约）。
 */
import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { DiagnosticExportBundlePayload, DiagnosticExportBundleResult } from '@taiji/shared'
import { DIAGNOSTICS_EXPORT_BUNDLE } from '@taiji/shared'
import { exportDiagnosticBundle } from './export-diagnostic-bundle.js'
import type { ExportDiagnosticBundleOptions } from './export-diagnostic-bundle.js'
import { mainLogger } from '../logs/main-logger.js'

/** 保存对话框返回形态（Electron SaveDialogReturnValue 的测试最小投影）。 */
export interface SaveDialogResult {
  canceled: boolean
  filePath?: string
}

/** 依赖注入面：测试注入对话框桩 / 打包桩，生产用 electron 与真实实现。 */
export interface DiagnosticsExportIpcDeps {
  /** 保存对话框；缺省 dialog.showSaveDialog（聚焦窗口，无聚焦窗口直接 canceled） */
  showSaveDialog?: (options: { title: string; defaultPath?: string }) => Promise<SaveDialogResult>
  /** 打包主体；缺省 exportDiagnosticBundle（真实收集 + zip 落盘） */
  exportBundle?: (options: ExportDiagnosticBundleOptions) => DiagnosticExportBundleResult
  /** app 版本来源；缺省 electron app.getVersion() */
  appVersion?: () => string
}

let registered = false

/**
 * 注册 DIAGNOSTICS_EXPORT_BUNDLE handler。ipc-handlers.ts 聚合点调用一次；幂等
 * （对齐 log-retention-ipc：重复注册 Electron 会 throw，标志位防重复注册炸启动）。
 */
export function registerDiagnosticsExportHandler(deps: DiagnosticsExportIpcDeps = {}): void {
  if (registered) return
  registered = true
  const showSave =
    deps.showSaveDialog ??
    (async (options: { title: string; defaultPath?: string }): Promise<SaveDialogResult> => {
      // 无聚焦窗口直接 canceled（pick-directory 先例：降级目标对称，不弹后台窗口）
      const focusedWin = BrowserWindow.getFocusedWindow()
      if (!focusedWin) return { canceled: true }
      const result = await dialog.showSaveDialog(focusedWin, {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
      return { canceled: result.canceled, filePath: result.filePath }
    })
  const exportBundle = deps.exportBundle ?? exportDiagnosticBundle
  const appVersion = deps.appVersion ?? (() => app.getVersion())

  try {
    ipcMain.handle(
      DIAGNOSTICS_EXPORT_BUNDLE,
      async (_event: IpcMainInvokeEvent, payload?: DiagnosticExportBundlePayload): Promise<DiagnosticExportBundleResult> => {
        let save: SaveDialogResult
        try {
          save = await showSave({ title: '导出诊断包', defaultPath: payload?.defaultPath })
        } catch (err) {
          // 对话框崩溃同样降级为可判定的错误三态（不向 renderer 抛 invoke rejection）
          mainLogger.warn(`[diagnostics-export-ipc] save dialog failed: ${err instanceof Error ? err.message : String(err)}`)
          return { status: 'error', error: { code: 'EDIALOG', message: '保存对话框打开失败' } }
        }
        if (save.canceled || save.filePath === undefined) return { status: 'canceled' }
        const result = exportBundle({ outPath: save.filePath, appVersion: appVersion() })
        if (result.status === 'exported') {
          mainLogger.info('[diagnostics-export-ipc] bundle exported', {
            path: result.path,
            bytes: result.bytes,
            entries: result.entryCount,
          })
        } else if (result.status === 'error') {
          mainLogger.warn(`[diagnostics-export-ipc] export failed (${result.error.code}): ${result.error.message}`)
        }
        return result
      },
    )
    mainLogger.debug('[diagnostics-export-ipc] registered', { channel: DIAGNOSTICS_EXPORT_BUNDLE })
  // eslint-disable-next-line taste/no-silent-catch -- 注册失败（极端：channel 被占）不能炸 main 启动；导出入口缺席只影响设置页导出，崩溃台账与巡检不受影响（对齐 log-retention-ipc）
  } catch {
    // no-op
  }
}
