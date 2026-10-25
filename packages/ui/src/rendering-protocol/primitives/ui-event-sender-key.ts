/**
 * text-input 值回传注入 key —— rendering-protocol 输入原语与宿主壳层的注入契约
 * （provider-plugin-access D8：输入值变更即回传，插件侧始终持有最新值；确认动作
 * 复用 action-bar 按钮点击）。
 *
 * 契约形态对齐 action-executor-key.ts（ACTION_EXECUTOR_KEY）：@taiji/ui 只定义
 * 最小结构接口，宿主壳层 provide 真实实现（对齐 PRIMITIVE_RENDER_KEY 注入范式）；
 * 本文件不 import core 类型，避免 ui→core 反向依赖。viewId 不进本接口——渲染该树
 * 的宿主（ViewHost 接线）在闭包内已知 viewId，回传通道的 (pluginId, viewId) 归
 * 接线方组装，原语只报 (componentId, event, value)。
 */
import type { InjectionKey } from 'vue'

/** 最小结构接口：宿主 uiEvent 通道的结构兼容面（WS plugin.uiEvent 帧的组装方） */
export interface UiEventSender { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  send(componentId: string, event: string, value: unknown): void
}

export const UI_EVENT_SENDER_KEY: InjectionKey<UiEventSender> = Symbol('ui-event-sender')
