/**
 * plugin-message-source.ts —— PluginMessageSource（IF1）。
 *
 * MessageBusBridge 的消息来源注入接口（TC1）：core 与 transport 解耦。
 * 壳（桌面壳 bootstrap）把 transport 层（ws-client 收到的 plugin:* / extension:* 消息流）
 * 适配成 PluginMessageSource 注入；单测注入 MockMessageSource 驱动 AC8。
 *
 * type 取值（IF1 注释）：
 * - 9 个 plugin:*：config / crashed / messageDecoration / notification / permissionRequest /
 *   statusBarUpdate / statusChange / statusSetUpdate / uiRequest
 * - 5 个 extension:*：extension:widget / extension:widgetGui / extension:status /
 *   extension:notify / extension.ui_request
 */
export interface IncomingPluginMessage {
  type: string
  sessionId?: string
  payload: unknown
}

export interface PluginMessageSource {
  /**
   * 订阅消息流。返回 unsubscribe：调用即停止接收（防 listener 翻倍，项目规则#2）。
   */
  subscribe(handler: (msg: IncomingPluginMessage) => void): () => void
}

/**
 * MockMessageSource —— 单测用内存实现（IF1）。
 * subscribe 返回 unsubscribe；emit(msg) 同步调全部订阅 handler。
 */
export class MockMessageSource implements PluginMessageSource {
  private handlers = new Set<(msg: IncomingPluginMessage) => void>()

  subscribe(handler: (msg: IncomingPluginMessage) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** 同步派发一条消息给全部订阅者（unsubscribe 后的 handler 不再收到）。 */
  emit(msg: IncomingPluginMessage): void {
    for (const h of this.handlers) {
      h(msg)
    }
  }

  /** 当前订阅者数量（测试断言防泄漏用）。 */
  listenerCount(): number {
    return this.handlers.size
  }
}
