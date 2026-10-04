/**
 * Plugin 域 —— 订阅（onPlugins）+ 权限审批命令（approvePermissions/revokePermissions/denyPermissions）。
 *
 * approvePermissions/denyPermissions 是 permissionRequest 闭环的回传通道：
 * runtime 广播 plugin:permissionRequest → bridge → Dialog → 用户操作 → 本域命令
 * → runtime plugin-service.approvePermissions/denyPermissions → reply pong ack；
 * 插件列表刷新经 config.plugins 广播（approve 触发 activate 状态变化时由
 * plugin-service 广播，onPlugins 订阅消费）。
 * denyPermissions=拒绝本次申请（不回收已授权限）；revokePermissions=撤销全部已授权限
 * （基线协议面保留，审批弹窗的拒绝按钮不走它）。命令名对齐 runtime
 * transport/plugin-message-handler.ts。
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

/** 批准插件申请的权限（可部分选择）。reply pong ack；列表刷新经 config.plugins 广播。 */
export async function approvePermissions(pluginId: string, permissions: string[]): Promise<void> {
  // reply 为 pong ack（空 payload），await 只为等 RPC settle，无返回值可读
  await command('plugin.approvePermissions', { pluginId, permissions }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 撤销插件全部已授权限。reply pong ack；不改 PluginInfo 字段，无列表刷新广播。 */
export async function revokePermissions(pluginId: string): Promise<void> {
  await command('plugin.revokePermissions', { pluginId }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 拒绝插件本次权限申请（不回收已授权限）。reply pong ack；无列表刷新广播。 */
export async function denyPermissions(pluginId: string): Promise<void> {
  await command('plugin.denyPermissions', { pluginId }, RPC_BACKSTOP_TIMEOUT_MS)
}
