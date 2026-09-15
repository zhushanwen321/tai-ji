/**
 * permission-transport.ts —— PermissionRequestDialog 的 RPC 回传注入契约（W2 · T1，clarify Q4）。
 *
 * runtime PluginActivator 广播 plugin:permissionRequest（payload { pluginId, permissions: string[] }）
 * 后，PermissionRequestDialog 弹出权限列表；用户批准/拒绝时经本 transport 完成 RPC 回路：
 *  - approve → plugin.approvePermissions（只批准勾选的权限）
 *  - revoke → plugin.revokePermissions（拒绝全部）
 *
 * 壳（P5）provide 真实实现（转发 renderer api/domains 的 WS 命令通道）；
 * 单测 mock；未注入时组件只 emit 不 RPC（design-review T3 cost 的降级路径，不崩）。
 */
import type { InjectionKey } from 'vue'

/** 插件权限审批 RPC 回传通道。 */
export interface PermissionTransport {
  /** 批准指定权限集合（可部分选择）。对齐 WS 命令 plugin.approvePermissions。 */
  approve(pluginId: string, permissions: string[]): void
  /** 拒绝全部权限。对齐 WS 命令 plugin.revokePermissions。 */
  revoke(pluginId: string): void
}

export const PERMISSION_TRANSPORT_KEY: InjectionKey<PermissionTransport> = Symbol('permission-transport')
