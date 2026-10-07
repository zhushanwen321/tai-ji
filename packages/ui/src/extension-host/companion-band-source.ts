/**
 * companion-band-source.ts —— CompanionBand 的依赖注入契约（W2 · T1，clarify Q1）。
 *
 * CompanionBand 内部消费 W1 交付的 createDialogRequestQueue(transport, sessionIdRef, source)
 * 三参数工厂，本文件定义其 transport / source 的 provide/inject 键（对齐 W3/W4 先例：
 * status-bar-source.ts / view-host-source.ts 的注入模式）。
 *
 * 壳（P5）provide 真实实现：
 *  - DialogRequestSource：把 S2 MessageBusBridge 的 InternalEventBus.on('ui-request')
 *    / WS plugin:uiRequestExpired 适配成 W1 定义的事件源接口；
 *  - UiResponseTransport：转发 extension.ui_response（pi 源）/ plugin.uiResponse（plugin 源）。
 *
 * 单测 global.provide mock；未注入时组件静默空态不崩（design-review R3）。
 */
import type { InjectionKey } from 'vue'
import type { OverlayState } from '@taiji/core'
import type { DialogRequestQueue, DialogRequestSource, UiResponseTransport } from './dialog-request-queue'

/** dialog 请求事件源（S2 bridge 适配入口）。 */
export const DIALOG_REQUEST_SOURCE_KEY: InjectionKey<DialogRequestSource> = Symbol('dialog-request-source')

/** dialog 响应回传通道（pi 源 sendPiResponse / plugin 源 sendPluginResponse）。 */
export const UI_RESPONSE_TRANSPORT_KEY: InjectionKey<UiResponseTransport> = Symbol('ui-response-transport')

/**
 * OverlayLifecycle 消费契约（IF9 状态机，arch-fix-v2 遗留闭环）。
 *
 * 壳（useExtensionHostBridge）provide OverlayLifecycle 实例（结构兼容本接口：getState/transition
 * 签名一致）。CompanionBand 经 inject 消费——minimize/restore 操作驱动状态机迁移
 * （expanded→minimized→restored），getState 派生 z-index（expanded 模态层 / minimized·restored
 * 覆盖层）。inject 缺失时组件静默空态不崩（design-review R3，同 source/transport 先例）。
 */
export interface OverlayLifecycleSource {
  /** 查 overlay 状态：分区或 requestId 不存在返回 undefined。sessionId 缺失落 __global__ 分区。 */
  getState(sessionId: string | undefined, requestId: string): OverlayState | undefined
  /** 状态迁移：非法迁移 no-op 不抛错（IF9 契约）。sessionId 缺失落 __global__ 分区。 */
  transition(sessionId: string | undefined, requestId: string, to: OverlayState): void
}

/** OverlayLifecycle 注入键（壳 provide 真实实例）。 */
export const OVERLAY_LIFECYCLE_KEY: InjectionKey<OverlayLifecycleSource> = Symbol('overlay-lifecycle')

/**
 * exited 分通道重置的 queue 句柄登记回调（remote-use U6 / D5 exited 分区清理段）。
 *
 * DialogRequestQueue 实例是 CompanionBand setup 内创建的组件私有对象（MF-5：queue 必须在
 * setup 顶层创建——内部 onScopeDispose 依赖 active effect scope），壳的 session.exited 编排
 * 无现成通道拿到实例。壳 provide 本回调；CompanionBand 创建 queue 后调用它把句柄回传，
 * 壳侧模块级持句柄、exited 时经其出口调 resetFor（dialog 通道具名重置）。
 *
 * 桌面壳不 provide（桌面 exited 清理走壳侧 store 单点，无 resetFor 需求）→ inject 缺失
 * 静默跳过，对齐 StatusBar/ViewHost 静默空态先例；ui 不得依赖壳，登记通道必须
 * provide/inject 形态。
 */
export type DialogQueueHandleRegistrar = (queue: DialogRequestQueue) => void

/** queue 句柄登记回调注入键（壳 provide、CompanionBand 消费；缺省静默跳过）。 */
export const DIALOG_QUEUE_HANDLE_KEY: InjectionKey<DialogQueueHandleRegistrar> = Symbol('dialog-queue-handle')

export type { OverlayState } from '@taiji/core'
export type { DialogRequest, DialogRequestOption, DialogRequestQueue, DialogRequestSource, UiResponseTransport } from './dialog-request-queue'
