/**
 * notification-host-controller.ts —— NotificationHostController（DM3 消费端，audit 缺失消费方补齐）。
 *
 * 订阅 InternalEventBus 的 7 类通知/生命周期事件，做最小可行消费（完整 UX 待 P5）：
 * - plugin-crashed / plugin-notification / extension-notify → toast（经 deps.showToast 注入）
 * - plugin-config-changed / plugin-message-decoration / plugin-status-change → log 降级
 * - error → log 降级（D7 S3-W4 补齐：bridge 的 ERR2 错误此前零消费方，坏消息
 *   只进 bus 无处落地。console 消费满足可观测；不弹 toast——毒化插件的高频坏
 *   消息会刷屏，toast 只留给用户可行动的通知）
 *
 * 零 UI 依赖（AC7 边界，与 StatusBarController 同范式）：toast 函数经构造 deps 注入，
 * 壳（装配层）提供命令式 toast 实现。core 不 import 任何 Vue 单文件组件 / 不直连 toast UI 组件 /
 * 不耦合渲染层 toast composable。信息流向单向：runtime 广播 → bridge → bus → controller（feature D5，不反向读 domain）。
 *
 * listener 防翻倍（项目规则#2）：subscribe() 幂等，重复调用返回同一 dispose。
 */
import type { InternalEventBus } from './internal-event-bus'
import type { NotificationPayload } from './types'

/** NotificationHostController 依赖（壳注入）。零 UI 耦合：toast 是命令式函数，core 不知其来源。 */
export interface NotificationHostControllerDeps {
  bus: InternalEventBus
  deps: {
    /**
     * 弹 toast。level 映射由壳实现（error/warning/info），core 只透传字符串。
     * sessionId（extension-notify / plugin-notification 事件携带）一并透传——壳用它组装
     * session 定位信息（label/目录）与前台/后台过滤；无 session 语义的事件（如 plugin-crashed）
     * 不传。core 不解释 sessionId，仅搬运。
     */
    showToast: (message: string, level?: string, sessionId?: string) => void
    /** 日志降级通道（默认 console.warn）。最小消费的几类事件用它记录，不弹 UI。 */
    log?: (...args: unknown[]) => void
  }
}

export class NotificationHostController {
  private unsubscribe: (() => void)[] = []

  constructor(private deps: NotificationHostControllerDeps) {}

  /**
   * 订阅 7 类事件，返回取消订阅函数（listener 防翻倍，项目规则#2）。
   * 重复调用 subscribe() 直接返回已绑定的 dispose，不重复注册。
   */
  subscribe(): () => void {
    if (this.unsubscribe.length > 0) return this.dispose.bind(this)
    this.unsubscribe.push(this.deps.bus.on('plugin-crashed', (e) => this.handlePluginCrashed(e)))
    this.unsubscribe.push(this.deps.bus.on('plugin-notification', (e) => this.handleNotification(e.sessionId, e.notification)))
    this.unsubscribe.push(this.deps.bus.on('extension-notify', (e) => this.handleNotification(e.sessionId, e.notification)))
    this.unsubscribe.push(this.deps.bus.on('plugin-config-changed', (e) => this.handleConfigChanged(e)))
    this.unsubscribe.push(this.deps.bus.on('plugin-message-decoration', (e) => this.handleMessageDecoration(e)))
    this.unsubscribe.push(this.deps.bus.on('plugin-status-change', (e) => this.handleStatusChange(e)))
    // D7 S3-W4：error（bridge ERR2）此前零消费方——未知 type / payload 解析失败
    // 只进 bus 无处落地，毒化消息排查无迹可循。console 消费补齐最小可观测。
    this.unsubscribe.push(this.deps.bus.on('error', (e) => this.handleError(e)))
    return this.dispose.bind(this)
  }

  /** 取消全部订阅（幂等）。 */
  dispose(): void {
    for (const unsub of this.unsubscribe) unsub()
    this.unsubscribe = []
  }

  // ── handlers ──

  private handlePluginCrashed(e: { pluginId: string; error: string }): void {
    this.deps.deps.showToast(`插件 ${e.pluginId} 崩溃: ${e.error}`, 'error')
  }

  /** plugin-notification 与 extension-notify 同形（NotificationPayload），统一处理。sessionId 透传给壳组装定位行。 */
  private handleNotification(sessionId: string | undefined, notification: NotificationPayload): void {
    // NotificationPayload.level 经 index signature 为 unknown，收窄成 string 再透传
    const level = typeof notification.level === 'string' ? notification.level : undefined
    this.deps.deps.showToast(notification.message, level, sessionId)
  }

  private handleConfigChanged(e: { pluginId: string; config: unknown }): void {
    // 完整：刷新设置页（重载插件配置 UI），待 P5。当前最小：仅日志记录。
    this.deps.deps.log?.(`[extension-host] plugin ${e.pluginId} config changed`, e.config)
  }

  private handleMessageDecoration(e: {
    sessionId?: string
    decoration: { messageId: string; decoration: unknown }
  }): void {
    // 完整：进 chat 流渲染消息装饰（badge/标记），待 P5。当前最小：仅日志记录。
    this.deps.deps.log?.(`[extension-host] decoration for message ${e.decoration.messageId}`, e.decoration.decoration)
  }

  private handleStatusChange(e: { pluginId: string; status: string }): void {
    // 完整：插件状态分发/状态栏刷新，待 P5。当前最小：仅日志记录。
    this.deps.deps.log?.(`[extension-host] plugin ${e.pluginId} -> ${e.status}`)
  }

  /** error（bridge ERR2）：未知 type / payload 解析失败。log 降级，不弹 toast（防毒化刷屏）。 */
  private handleError(e: { source: string; message: string }): void {
    this.deps.deps.log?.(`[extension-host] bus error from ${e.source}: ${e.message}`)
  }
}
