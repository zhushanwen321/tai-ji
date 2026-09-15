/**
 * Plugin 域 —— 订阅（onPlugins）+ 权限审批命令（approvePermissions/revokePermissions）。
 *
 * approvePermissions/revokePermissions 是 permissionRequest 闭环的回传通道：
 * runtime 广播 plugin:permissionRequest → bridge → Dialog → 用户操作 → 本域命令
 * → runtime plugin-service.approvePermissions/revokePermissions → reply config.plugins。
 * 契约见 contract.md §2.6（命令名对齐 runtime transport/plugin-message-handler.ts）。
 *
 * 依赖方向：events（订阅）+ command（类型化请求/动作原语）。
 */
import type { PluginInfo } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'
import * as events from '../events'

export function onPlugins(handler: (plugins: PluginInfo[]) => void): () => void {
  return events.onGlobalType('config.plugins', (msg) => {
    handler(msg.payload.plugins)
  })
}

/** 批准插件申请的权限（可部分选择）。reply config.plugins（插件列表刷新，调用方忽略）。 */
export async function approvePermissions(pluginId: string, permissions: string[]): Promise<void> {
  // reply（config.plugins）由后续广播刷新，此处用 void 显式丢弃 Promise<{plugins}> 返回值，
  // 保持 Promise<void> 签名（command<K> 返回 Promise<ReplyPayloadMap[K]>，不可隐式赋给 void）
  void await command('plugin.approvePermissions', { pluginId, permissions }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 拒绝插件申请的全部权限。reply config.plugins（插件列表刷新，调用方忽略）。 */
export async function revokePermissions(pluginId: string): Promise<void> {
  // 同 approvePermissions：void 丢弃 reply 返回值
  void await command('plugin.revokePermissions', { pluginId }, RPC_BACKSTOP_TIMEOUT_MS)
}
