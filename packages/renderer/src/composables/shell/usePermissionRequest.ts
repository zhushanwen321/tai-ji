/**
 * usePermissionRequest —— permissionRequest 下行消息闭环驱动（audit §12.1）。
 *
 * 职责：把 ExtensionHost bridge 已 emit 的 `plugin-permission-request` InternalEvent
 * 驱动成 PermissionRequestDialog 的可见状态，并 provide 真实 PermissionTransport
 * （permission-transport.ts 注释明说「壳 P5 provide 真实实现」）转发 WS 命令通道。
 *
 * 消息流：runtime 广播 plugin:permissionRequest → MessageBusBridge 归一 →
 * bus 'plugin-permission-request' → 本 composable 写 reactive state →
 * App.vue <PermissionRequestDialog :pending> 弹窗。
 *
 * 超时撤窗（timeout-plugin-service D3）：runtime 广播 plugin:permissionRequestExpired
 * （审批等待超时，取消非判拒——payload { pluginId }，无 sessionId → global 通道）。
 * 该帧不经 MessageBusBridge（bridge 无此归一项），本 composable 直接订阅 WS global
 * 通道消费（同 extension-host-dialog.ts onUiRequestExpired 的「保留 WS 路径不经 bus」先例）。
 * 按 pluginId 匹配撤回：命中才置 pending=false；不匹配（陈旧广播 vs 新插件的弹窗）noop，
 * 无挂起弹窗时 noop 幂等（迟到批准对已删 pending noop 语义的前端对称面）。
 *
 * 回传流：用户批准/拒绝 → Dialog 经 inject(PERMISSION_TRANSPORT_KEY) 调
 * transport.approve/revoke → 本 composable 调 api/domains/plugin 的
 * approvePermissions/revokePermissions（command('plugin.approvePermissions' /
 * 'plugin.revokePermissions')）→ runtime plugin-service → reply config.plugins。
 *
 * 全局弹窗（session 无关）：permissionRequest 一次一个，新请求到来覆盖旧 state
 * （不做队列）。
 */
import { reactive, type App } from 'vue'
import type { InternalEventBus } from '@taiji/core'
import { PERMISSION_TRANSPORT_KEY, type PermissionTransport } from '@taiji/ui/extension-host'
import { onGlobal } from '@taiji/core/transport/api'
import * as pluginApi from '@taiji/core/transport/api/domains/plugin'

/** 弹窗可见状态（供 App.vue 绑定 Dialog props）。 */
interface PermissionRequestState {
  /** 申请权限的插件 id */
  pluginId: string
  /** 插件申请的权限列表 */
  permissions: string[]
  /** 请求是否挂起（true=弹窗打开；RPC 回传成功/失败后置 false） */
  pending: boolean
}

/**
 * 模块级 reactive 单例（全局弹窗，session 无关）。
 * 模块级 reactive 不绑定任何 effectScope，跟随应用生命周期存活——
 * 符合「全局弹窗」语义，App.vue 卸载（HMR/退出）随之销毁。
 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：权限弹窗全局单例状态（session 无关的全局弹窗，上方注释已述）
const state = reactive<PermissionRequestState>({
  pluginId: '',
  permissions: [],
  pending: false,
})

/** bus / WS 订阅退订句柄（HMR/重复初始化幂等：先退订旧 handler）。 */
let unsubscribe: (() => void) | null = null
let unsubscribeExpired: (() => void) | null = null

/**
 * 装配 permissionRequest 闭环（main.ts 挂载前调用一次）。
 *
 * - bus.on('plugin-permission-request') 写 state 弹窗
 * - onGlobal 订阅 plugin:permissionRequestExpired 超时撤窗（D3，取消非判拒）
 * - app.provide(PERMISSION_TRANSPORT_KEY, transport) 注入真实 RPC 回传
 *
 * @param app Vue 应用实例（provide 全局注入，须在 mount 前）
 * @param bus ExtensionHost 共享 bus 单例（getExtensionBus()，与 bridge 同实例）
 */
export function initPermissionRequest(app: App, bus: InternalEventBus): void {
  // 幂等：重复初始化先退订（HMR/测试场景防 listener 翻倍，项目规则#2）
  unsubscribe?.()
  unsubscribeExpired?.()
  unsubscribe = bus.on('plugin-permission-request', (e) => {
    // bridge 已保留整个 permissions 数组（见 core message-bus-bridge.ts parsePermissionRequest），
    // 直接透传给 PermissionRequestDialog（props.permissions: string[]）消费。
    state.pluginId = e.request.pluginId
    state.permissions = e.request.permissions
    state.pending = true
  })

  // 超时撤窗（timeout-plugin-service D3）：审批等待到期，runtime 取消本次激活并广播。
  // payload 无 sessionId（审批弹窗全局单例、session 无关）→ 走 global 通道。
  unsubscribeExpired = onGlobal((msg) => {
    if (msg.type !== 'plugin:permissionRequestExpired') return
    const payload = msg.payload as { pluginId?: unknown }
    if (typeof payload.pluginId !== 'string') return
    // 按 pluginId 匹配：陈旧 expired 广播不得误撤后到插件的新审批弹窗（全局单例被
    // 新请求覆盖后，旧插件的迟到广播只应 noop）；无挂起弹窗时 noop 幂等。
    if (state.pending && state.pluginId === payload.pluginId) {
      state.pending = false
    }
  })

  // 真实 transport：转发 WS 命令（plugin.approvePermissions / plugin.revokePermissions）。
  // 壳层归位至此（permission-transport.ts 契约由本 provide 兑现）；RPC 收口在 api/domains/plugin.ts。
  // 回传成功/失败均置 pending=false 关闭弹窗，避免卡死（项目规则#3 状态重置）。
  const transport: PermissionTransport = {
    approve(pluginId: string, permissions: string[]): void {
      void pluginApi.approvePermissions(pluginId, permissions)
        .then(() => {
          state.pending = false
        })
        .catch((err: unknown) => {
          console.warn('[permission] approvePermissions failed', err)
          state.pending = false
        })
    },
    revoke(pluginId: string): void {
      void pluginApi.revokePermissions(pluginId)
        .then(() => {
          state.pending = false
        })
        .catch((err: unknown) => {
          console.warn('[permission] revokePermissions failed', err)
          state.pending = false
        })
    },
  }
  app.provide(PERMISSION_TRANSPORT_KEY, transport)
}

/**
 * 取 permissionRequest 弹窗状态（App.vue setup 调用，template 绑定 Dialog props）。
 * 返回同一 reactive 单例，多组件共享。
 */
export function usePermissionRequest(): PermissionRequestState {
  return state
}
