// 会话 JSONL 导出域（ui-replica-demo-fidelity 待立项通道 1，2026-10-12 立项）。
// Electron IPC 平台门面（对齐 ./diagnostics.ts 域形态：经 @/lib/ipc 二级适配——renderer 对
// electronAPI 的唯一适配点是 lib/ipc（spec §4 R1，B1 IPC 门面守卫禁直调 window.electronAPI）；
// 不进 api/index.ts 聚合——该门面只聚合 core transport 域）。
import { exportSessionJsonl as exportSessionJsonlIpc } from '@/lib/ipc'
import type { SessionJsonlExportPayload, SessionJsonlExportResult } from '@taiji/shared'

/**
 * 导出会话 JSONL（SESSION_EXPORT_JSONL invoke 通道）。
 *
 * 三态永不 reject（main 侧零 rejection 契约，见 shared SessionJsonlExportResult）：
 * exported（含产物路径 + 字节数）/ canceled（用户取消保存对话框；web/mock 无 preload 同样
 * 归 canceled——没有保存对话框可弹 = 导出未发生）/ error（含具体错误码：EPATH 源路径越界
 * 三树 / EINVALID 会话文件缺失 / EDIALOG / fs errno）。源路径三树校验与落点确认（保存
 * 对话框）都在 main 侧，本域函数只做透传。
 */
export async function exportSessionJsonl(
  payload: SessionJsonlExportPayload,
): Promise<SessionJsonlExportResult> {
  return exportSessionJsonlIpc(payload)
}
