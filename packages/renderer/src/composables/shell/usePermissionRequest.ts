/**
 * usePermissionRequest —— 桌面壳 permissionRequest 装配薄接线。
 *
 * 状态机本体（bus 订阅 + 畸形事件守卫 + permissions 拷贝 + expired 撤窗 +
 * transport 回传 + BM3/D3 失败/超时语义）在 @taiji/ui/extension-host
 * createPermissionRequestController（双壳共享 factory，单测在同包 __tests__/）。
 * 本模块只做桌面壳装配裁决：
 * - init 时机：main.ts 挂载前调用一次（app.provide 须先于组件树 inject）
 * - bus 来源：getExtensionBus()（与 ExtensionHost bridge 同实例，main.ts 传入）
 * - 重复 init 幂等：dispose 旧 controller 再建（HMR/测试防 listener 翻倍，项目规则#2）
 *
 * 消费方：App.vue 经 usePermissionRequest() 取弹窗状态绑定
 * PermissionRequestDialog props；Dialog 经 inject(PERMISSION_TRANSPORT_KEY) 回传。
 */
import type { App } from 'vue'
import type { InternalEventBus } from '@taiji/core'
import {
  createPermissionRequestController,
  PERMISSION_TRANSPORT_KEY,
  type PermissionRequestController,
  type PermissionRequestState,
} from '@taiji/ui/extension-host'

/** 当前 controller（模块级；init 建 / 重复 init 先 dispose 旧）。 */
let controller: PermissionRequestController | null = null

/**
 * 装配 permissionRequest 闭环（main.ts 挂载前调用一次）：
 * 创建 controller（bus 订阅 + expired 撤窗 + transport）并
 * app.provide(PERMISSION_TRANSPORT_KEY, transport) 注入真实 RPC 回传。
 *
 * @param app Vue 应用实例（provide 全局注入，须在 mount 前）
 * @param bus ExtensionHost 共享 bus 单例（getExtensionBus()，与 bridge 同实例）
 */
export function initPermissionRequest(app: App, bus: InternalEventBus): void {
  // 幂等：重复初始化先退订（HMR/测试场景防 listener 翻倍，项目规则#2）
  controller?.dispose()
  controller = createPermissionRequestController(bus)
  app.provide(PERMISSION_TRANSPORT_KEY, controller.transport)
}

/**
 * 取 permissionRequest 弹窗状态（App.vue setup 调用，template 绑定 Dialog props）。
 * 返回当前 controller 的 reactive state，同批 init 生命周期内多组件共享同一引用。
 */
export function usePermissionRequest(): PermissionRequestState {
  if (!controller) {
    throw new Error(
      'usePermissionRequest() 调用于 initPermissionRequest() 之前——须先在 main.ts 挂载前 init（恢复动作：检查 main.ts 的 initPermissionRequest(app, getExtensionBus()) 调用时序）',
    )
  }
  return controller.state
}
