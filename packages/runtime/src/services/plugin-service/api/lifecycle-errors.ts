/**
 * 插件生命周期（toggle / uninstall）失败语义收口（RT-6#6）。
 *
 * 背景：PluginService.togglePlugin / uninstallPlugin 此前对失败只 console.error，
 * 仍回 `config.plugins` 成功形状——用户开关回弹、卸载重启后复活，全程无错误/指引
 * （假成功观感，B 类吞噬）。本模块把「失败 → 领域错误」的构造与磁盘删除的 best-effort
 * 包装收口到一处，供 PluginService 门面调用：
 *
 * - `pluginToggleFailedError` / `pluginUninstallPartialError`：带 `.code` 的领域错误。
 *   transport server.ts 的全局 catch 透传 `.code` 成 error 信封（L4 增强），与
 *   extension-message-handler 的 ExtensionInstallError 透传范式同通路。可行动指引
 *   直接并进 message——全局 catch 只透传 code + message（不读 hint 字段），
 *   而 transport/plugin-message-handler.ts 不在本批改动域内，无法为其加 hint 通道。
 * - `removePluginDiskFiles`：installer.uninstall 的 best-effort 包装。磁盘删除失败
 *   仍不阻断 uninstall 的内存清理（Fix-5 语义不变），但把失败原因交还调用方，
 *   由 uninstallPlugin 在收口时抛出——「卸载重启后复活」必须让用户看到失败。
 */

import type { IPluginInstaller } from '../../ports/plugin-installer.js'
import { errorWithCode, toErrorMessage } from '../../../utils/errors.js'

/** toggle 失败错误码（前端据此区分「开关失败」与其它 handler_error） */
export const PLUGIN_TOGGLE_FAILED = 'PLUGIN_TOGGLE_FAILED'
/** uninstall 部分失败错误码（内存已拆、盘上残留，重启后可能复活） */
export const PLUGIN_UNINSTALL_PARTIAL = 'PLUGIN_UNINSTALL_PARTIAL'

/**
 * 构造 toggle 失败领域错误（携带 code + 可行动指引）。
 *
 * @param pluginId 目标插件
 * @param enabled   attempted 目标状态（true = 启用，false = 禁用）
 * @param err       底层失败（toErrorMessage 归一化）
 */
export function pluginToggleFailedError(
  pluginId: string,
  enabled: boolean,
  err: unknown,
): Error & { code: string | number } {
  return errorWithCode(
    `Failed to ${enabled ? 'enable' : 'disable'} plugin '${pluginId}': ${toErrorMessage(err)}. ` +
      `The plugin list has been refreshed to the actual state — retry from the list.`,
    PLUGIN_TOGGLE_FAILED,
  )
}

/**
 * 构造 uninstall 部分失败领域错误（内存清理已完成，磁盘残留）。
 *
 * @param pluginId 目标插件
 * @param reason   磁盘删除失败原因（toErrorMessage 归一化后的消息）
 */
export function pluginUninstallPartialError(
  pluginId: string,
  reason: string,
): Error & { code: string | number } {
  return errorWithCode(
    `Plugin '${pluginId}' was removed from the running session but its on-disk files ` +
      `could not be deleted (${reason}) — it may reappear after restart. ` +
      `Delete the plugin directory manually and retry.`,
    PLUGIN_UNINSTALL_PARTIAL,
  )
}

/**
 * external 插件磁盘目录删除（best-effort 包装）。
 *
 * 语义：installer.uninstall 抛错时记 console.error 留痕（文案与历史逐字一致，既有测试
 * 按 `stringContaining('on-disk removal')` + 归一化消息断言）并返回失败原因；调用方
 * （uninstallPlugin）继续完成内存清理，收口时再抛 pluginUninstallPartialError。
 *
 * @returns 失败原因字符串；成功返回 undefined
 */
export async function removePluginDiskFiles(
  installer: IPluginInstaller,
  pluginId: string,
  pluginPath: string,
): Promise<string | undefined> {
  try {
    await installer.uninstall(pluginId, pluginPath)
    return undefined
  } catch (err: unknown) {
    const message = toErrorMessage(err)
    console.error(
      `[plugin-service] on-disk removal during uninstall failed (continuing in-memory cleanup) for ${pluginId}:`,
      message,
    )
    return message
  }
}
