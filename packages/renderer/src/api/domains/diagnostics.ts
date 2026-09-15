// 诊断包导出域（crash-forensics-and-watchdog §3.3 D6 / u3b）。
// Electron IPC 平台门面（对齐 ./settings.ts 域形态：经 @/lib/ipc 二级适配——renderer 对
// electronAPI 的唯一适配点是 lib/ipc（spec §4 R1，B1 IPC 门面守卫禁直调 window.electronAPI）；
// 不进 api/index.ts 聚合——该门面只聚合 core transport 域）。
import { exportDiagnosticBundle as exportDiagnosticBundleIpc } from '@/lib/ipc'
import type { DiagnosticExportBundlePayload, DiagnosticExportBundleResult } from '@taiji/shared'

/**
 * 导出诊断包（DIAGNOSTICS_EXPORT_BUNDLE invoke 通道）。
 *
 * 三态永不 reject（main 侧零 rejection 契约，见 shared DiagnosticExportBundleResult）：
 * exported（含产物路径 + 摘要）/ canceled（用户取消保存对话框；web/mock 无 preload 同样
 * 归 canceled——没有保存对话框可弹 = 导出未发生）/ error（含具体 errno）。
 */
export async function exportDiagnosticBundle(
  payload?: DiagnosticExportBundlePayload,
): Promise<DiagnosticExportBundleResult> {
  return exportDiagnosticBundleIpc(payload)
}
