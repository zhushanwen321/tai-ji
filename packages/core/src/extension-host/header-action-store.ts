/**
 * header-action-store.ts —— HeaderActionStore（AP-1 headerAction 点位的运行时状态容器）。
 *
 * headerAction 的可变字段（badge/tooltip/disabled）per-session 分区缓存：声明侧静态形状
 * （title/icon/commandId/order）在 ContributionRegistry，运行时可变状态经
 * plugin:headerActionUpdate 广播帧写入本 store（按 (sessionId, headerActionId) 定位）。
 * 徽标是 per-session 语义（多会话/split 下各显各的，AP-1），故分区键 = sessionId。
 *
 * 范式 = ViewHostStore（per-session 分区 + InternalEventBus 订阅 + onChange 响应式粘合）：
 * - plugin:headerActionUpdate → set 写入对应会话分区
 * - session-destroyed → clearForSession（防内存泄漏，ERR4 同族）
 * - clearForPlugin(pluginId)：插件崩溃/禁用/卸载清理（AP-1 生命周期）。接线归消费方
 *   （订阅 plugin:statusChange / plugin:crashed 后调用）；ViewHostStore 无 plugin 维度
 *   清理范式，本 store 按 AP-1 设计显式提供。
 */
import type { InternalEventBus } from './internal-event-bus'
import type { SessionScopedMap } from './utils/session-scoped-map'

/** headerAction 运行时状态条目（badge ≤4 字符的截断由渲染端承担，store 存帧原文）。 */
export interface HeaderActionEntry {
  headerActionId: string
  pluginId: string
  badge?: string
  tooltip?: string
  disabled?: boolean
  updatedAt: number
}

/** set 的输入形状（plugin:headerActionUpdate payload 的运行时字段面，缺 headerActionId/sessionId 定位键）。 */
export interface HeaderActionSetInput {
  pluginId: string
  badge?: string
  tooltip?: string
  disabled?: boolean
}

export interface HeaderActionStoreDeps {
  bus: InternalEventBus
  /** 分区值类型：headerActionId → HeaderActionEntry（per-session 分区） */
  sessionScoped: SessionScopedMap<Map<string, HeaderActionEntry>>
}

export class HeaderActionStore {
  private unsubscribe: (() => void)[] = []

  constructor(private deps: HeaderActionStoreDeps) {}

  /** 订阅 plugin:headerActionUpdate（写入）+ session-destroyed（清理）。返回取消订阅函数（幂等）。 */
  subscribe(): () => void {
    if (this.unsubscribe.length > 0) return this.dispose.bind(this)
    this.unsubscribe.push(this.deps.bus.on('plugin:headerActionUpdate', (e) => {
      this.set(e.headerAction.sessionId, e.headerAction.headerActionId, e.headerAction)
    }))
    this.unsubscribe.push(this.deps.bus.on('session-destroyed', (e) => {
      this.clearForSession(e.sessionId)
    }))
    return this.dispose.bind(this)
  }

  /** 读单个 headerAction 的运行时状态（未写入过返回 undefined——声明侧静态形状不在本 store）。 */
  get(sessionId: string, headerActionId: string): HeaderActionEntry | undefined {
    return this.deps.sessionScoped.get(sessionId)?.get(headerActionId)
  }

  /** 写（覆盖语义：同 (sessionId, headerActionId) 二次写入以最新帧为准）。 */
  set(sessionId: string, headerActionId: string, input: HeaderActionSetInput): void {
    this.deps.sessionScoped.update(sessionId, (partition) => {
      partition.set(headerActionId, {
        headerActionId,
        pluginId: input.pluginId,
        badge: input.badge,
        tooltip: input.tooltip,
        disabled: input.disabled,
        updatedAt: Date.now(),
      })
    })
    this.notifyListeners()
  }

  /** 清空该 session 全部 headerAction 状态（session-destroyed）。幂等。 */
  clearForSession(sessionId: string): void {
    this.deps.sessionScoped.cleanup(sessionId)
    this.notifyListeners()
  }

  /**
   * 清空某插件在全部会话的 headerAction 状态（AP-1 生命周期：崩溃/禁用/卸载）。
   * 清空后变空的分区整体移除（不留空 Map）；无匹配条目时 no-op。幂等。
   */
  clearForPlugin(pluginId: string): void {
    for (const sessionId of this.deps.sessionScoped.keys()) {
      const partition = this.deps.sessionScoped.get(sessionId)
      if (!partition) continue
      let removed = false
      for (const [id, entry] of partition) {
        if (entry.pluginId === pluginId) {
          partition.delete(id)
          removed = true
        }
      }
      if (removed && partition.size === 0) this.deps.sessionScoped.cleanup(sessionId)
    }
    this.notifyListeners()
  }

  private listeners = new Set<() => void>()
  /** 注册状态变化监听（renderer 响应式粘合，同 ViewHostStore.onChange）。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private notifyListeners(): void {
    for (const fn of this.listeners) fn()
  }

  /** 取消全部订阅并清空监听（幂等）。 */
  dispose(): void {
    for (const unsub of this.unsubscribe) unsub()
    this.unsubscribe = []
    this.listeners.clear()
  }
}
