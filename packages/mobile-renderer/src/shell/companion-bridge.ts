// companion-bridge —— 移动壳 companion 区（CompanionBand/AskUserForm）的数据源与回传装配
// （remote-use D7「ask-user 提问答复 ✅」行的壳侧拉通）+ 权限审批通道（D7「权限审批 ✅
// 手机可批」行的壳侧拉通）。
//
// 对话桥翻译层（WS source 适配 + dialog source/transport 工厂 + requestId 反查表）已下沉
// @taiji/ui/extension-host shell-adapters（双壳逐字节共享，含 [G1] 反查表泄漏语义文档）；
// 权限审批编排状态机（bus 订阅 + 畸形事件守卫 + expired 撤窗 + transport 回传 +
// BM3/D3 语义）已下沉同包 createPermissionRequestController（双壳共享，单测在同包
// __tests__/）。本模块只做移动壳裁决：
// - routeAskUser='companion'——无 Panel，CompanionBand 是 ask-user 的唯一消费面，dialog 全
//   method + askUser 全投递（v1 能力边界；桌面壳传 'panel' 分流给 Panel inline 独占）；
// - bus 模块级私有单例（桌面走 getExtensionBus 惰性单例，来源选择是壳裁决）；
// - 权限/对话两通道均模块级装配（bus 单例私居本模块；ESM 单次求值，listener 不会翻倍），
//   App.vue provide + 挂 CompanionBand / PermissionRequestDialog。
//
// 回传走 core 既有通路（不新造协议）：pi 源 extension.ui_response（sendExtensionUIResponse）、
// plugin 源 plugin.uiResponse（ws send）、审批源 plugin.approvePermissions/denyPermissions。
import { InternalEventBus, MessageBusBridge } from '@taiji/core/extension-host'
import {
  createCompanionDialogAdapters,
  createPermissionRequestController,
  createWsPluginMessageSource,
} from '@taiji/ui/extension-host'
import type { PermissionTransport, PermissionRequestState } from '@taiji/ui/extension-host'

// ── bus + bridge 单例（模块级；dialog 反查表由共享 factory 单点持有，见 shell-adapters）──

const bus = new InternalEventBus()
const bridge = new MessageBusBridge({ source: createWsPluginMessageSource(), bus })
void bridge // 构造即 subscribe；持有引用防误判可回收（dispose 在移动壳生命周期内不发生）

/**
 * 测试后门命名空间（生产代码禁止消费，对齐桌面壳 useExtensionHostBridge.__testing 先例）：
 * permission 链测试的 bus emit 入口（生产订阅面 = 下方 dialog/permission 两通道）。
 */
export const __testing = {
  mobileExtensionBus: bus,
}

// companion 数据源/回传对（App.vue provide 消费；G1 反查表泄漏语义两壳同持，见 shell-adapters）
const companionDialog = createCompanionDialogAdapters(bus, { routeAskUser: 'companion' })
export const mobileDialogRequestSource = companionDialog.source
export const mobileUiResponseTransport = companionDialog.transport

// ── permissionRequest 审批通道（D7 审批行，App 挂 PermissionRequestDialog）──
//
// 状态机本体在 @taiji/ui/extension-host createPermissionRequestController（双壳共享，
// 桌面 usePermissionRequest.ts 是同一 factory 的薄接线）；本模块只做移动壳装配：
// 模块级 controller（bus 单例私居本模块，ESM 单次求值），App.vue provide transport +
// 挂 PermissionRequestDialog，useMobilePermissionRequest 取弹窗状态。

const permissionController = createPermissionRequestController(bus)

/** 审批回传通道（permission-transport 契约的 factory 产出，App.vue provide 消费） */
export const mobilePermissionTransport: PermissionTransport = permissionController.transport

/** 取审批弹窗状态（App.vue setup 消费，template 绑定 Dialog props；同一 reactive 单例） */
export function useMobilePermissionRequest(): PermissionRequestState {
  return permissionController.state
}
