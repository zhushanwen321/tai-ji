/**
 * status-bar-controller.ts —— StatusBarController（IF8 + AC7）。
 *
 * 两 scope 状态栏聚合器：订阅 InternalEventBus 的 plugin-status-bar-update /
 * plugin-status-set-update / extension-status / session-destroyed，按 scope 分流聚合。
 * per-session 分区用 createSessionScopedMap（ADR-0049 范式，DM2），global 聚合经同一
 * sessionScoped 的保留分区（GLOBAL_SCOPE_KEY，MF-2 R2——壳注入 reactive 容器时 in-place
 * mutate 可被 Vue 追踪）。信息流向单向：runtime 广播 → bridge → bus → controller（feature D5，
 * 不反向读 domain）。
 *
 * AC7：绝不 import domain store（静态 import 检查由 scripts/verify-extension-host-boundaries.mjs
 * 强制——本文件只依赖 types + internal-event-bus + utils/session-scoped-map）。
 *
 * 聚合规则（clarify Q3 裁决 + ERR5 替换语义）：
 * - plugin-status-bar-update items 逐项按 scope 分流：scope==='global'（或缺失）→
 *   GLOBAL_SCOPE_KEY 保留分区 items；
 *   scope==='per-session' → sessionScoped 分区（分区键优先级 item.sessionId > event.sessionId
 *   > '__global__' 兜底）
 *   **替换语义（ERR5）**：runtime 每次任一 item 变化都广播**当前全量** items（status-bar-registry
 *   broadcastAll），各分区做全量快照同步——同 key（`${pluginId}:${id}` 复合键）更新不累积、
 *   广播外条目删除（runtime 删 item / clearForPlugin 后前端同步消失）、未提及分区清空
 * - plugin-status-set-update → 分区 setEntries（sessionId 缺失 → '__global__'）
 * - extension-status → 分区 extensionStatus（sessionId 缺失 → '__global__'）
 * - session-destroyed → sessionScoped.cleanup(sid)（ERR4 防内存泄漏）
 */
import type { InternalEventBus } from './internal-event-bus'
import type { SessionScopedMap } from './utils/session-scoped-map'
import type { StatusBarEntry, StatusSetEntry, ExtensionStatusEntry } from './types'

/** 无 sessionId 时的分区兜底键（与 overlay-lifecycle 的 GLOBAL_OVERLAY_KEY 语义一致）。 */
export const GLOBAL_STATUS_KEY = '__global__'

/**
 * global scope 聚合的 sessionScoped 保留分区键（MF-2 R2）。
 *
 * global scope 条目不再存 controller 私有 raw 数组，改经注入的 sessionScoped 保留分区存储：
 * 壳注入 reactive 分区容器时，replaceAllWith 的 in-place mutate 走 proxy set trap → 前端
 * computed 追踪有效（core 保持零 Vue 依赖，只依赖注入容器；旧实现 reactive() 包装私有数组
 * 不拦截 raw 原地 mutate，global 状态栏永不更新）。与 GLOBAL_STATUS_KEY（per-session 项无
 * sessionId 的兜底分区）语义不同，二者分离。
 */
export const GLOBAL_SCOPE_KEY = '__global_scope__'

/** per-session 分区状态容器（IF8 契约）。 */
export interface StatusBarSessionState {
  items: StatusBarEntry[]
  setEntries: StatusSetEntry[]
  extensionStatus?: ExtensionStatusEntry
}

export interface StatusBarControllerDeps {
  bus: InternalEventBus
  sessionScoped: SessionScopedMap<StatusBarSessionState>
}

export class StatusBarController {
  private unsubscribe: (() => void)[] = []

  constructor(private deps: StatusBarControllerDeps) {}

  /** 订阅四类事件，返回取消订阅函数（listener 防翻倍，项目规则#2）。 */
  subscribe(): () => void {
    if (this.unsubscribe.length > 0) return this.dispose.bind(this)
    this.unsubscribe.push(this.deps.bus.on('plugin-status-bar-update', (e) => this.handleStatusBarUpdate(e)))
    this.unsubscribe.push(this.deps.bus.on('plugin-status-set-update', (e) => this.handleStatusSetUpdate(e)))
    this.unsubscribe.push(this.deps.bus.on('extension-status', (e) => this.handleExtensionStatus(e)))
    this.unsubscribe.push(this.deps.bus.on('session-destroyed', (e) => this.deps.sessionScoped.cleanup(e.sessionId)))
    return this.dispose.bind(this)
  }

  /** 取状态栏条目：global scope 或 per-session 分区（分区不存在返回空数组）。 */
  getItems(scope: 'global'): StatusBarEntry[]
  getItems(scope: 'per-session', sessionId: string): StatusBarEntry[]
  getItems(scope: 'per-session' | 'global', sessionId?: string): StatusBarEntry[] {
    // global scope 存 sessionScoped 保留分区（GLOBAL_SCOPE_KEY，MF-2 R2）：
    // 壳注入 reactive 容器时读路径被 Vue 追踪，in-place mutate 触发重算。
    // 用 get 而非 getOrDefault——渲染期只读，不产生建分区副作用。
    if (scope === 'global') return this.deps.sessionScoped.get(GLOBAL_SCOPE_KEY)?.items ?? []
    const sid = sessionId ?? GLOBAL_STATUS_KEY
    return this.deps.sessionScoped.get(sid)?.items ?? []
  }

  /** 取 per-session 分区全部状态（items + setEntries + extensionStatus），供 s4 渲染。 */
  getSessionState(sessionId: string): StatusBarSessionState | undefined {
    return this.deps.sessionScoped.get(sessionId)
  }

  /** 分区键优先级：item.sessionId > event.sessionId > '__global__'（clarify Q3）。 */
  private resolvePartitionKey(itemSessionId: string | undefined, eventSessionId: string | undefined): string {
    return itemSessionId ?? eventSessionId ?? GLOBAL_STATUS_KEY
  }

  /**
   * 条目稳定键：pluginId + id 复合（ERR5 替换语义的判等依据）。
   * id 在 plugin 内唯一（ContributionRecord 契约），跨插件防碰撞故复合 pluginId。
   */
  private static entryKey(item: StatusBarEntry): string {
    return `${item.pluginId}:${item.id}`
  }

  /**
   * 全量快照同步（in-place，分区数组引用稳定）：同 key 就地替换、广播外条目删除（runtime 已删）、
   * 新条目追加。incoming 是该分区在当前广播全量中的子集。
   */
  private replaceAllWith(items: StatusBarEntry[], incoming: StatusBarEntry[]): void {
    const incomingKeys = new Set(incoming.map((i) => StatusBarController.entryKey(i)))
    for (let i = items.length - 1; i >= 0; i--) {
      if (!incomingKeys.has(StatusBarController.entryKey(items[i]))) items.splice(i, 1)
    }
    for (const item of incoming) {
      const key = StatusBarController.entryKey(item)
      const idx = items.findIndex((existing) => StatusBarController.entryKey(existing) === key)
      if (idx === -1) items.push(item)
      else items[idx] = item
    }
  }

  private handleStatusBarUpdate(e: { sessionId?: string; items: StatusBarEntry[] }): void {
    // 广播是全量快照：global 分区同步为「非 per-session 子集」。经 sessionScoped 保留分区
    // （GLOBAL_SCOPE_KEY）存储——壳注入 reactive 容器时 in-place mutate 走 proxy set trap
    this.deps.sessionScoped.update(GLOBAL_SCOPE_KEY, (s) =>
      this.replaceAllWith(s.items, e.items.filter((i) => i.scope !== 'per-session')),
    )

    // per-session 项按分区键分组（item.sessionId > event.sessionId > '__global__'）
    const groups = new Map<string, StatusBarEntry[]>()
    for (const item of e.items) {
      if (item.scope !== 'per-session') continue
      const key = this.resolvePartitionKey(item.sessionId, e.sessionId)
      const list = groups.get(key)
      if (list) list.push(item)
      else groups.set(key, [item])
    }
    for (const [key, incoming] of groups) {
      this.deps.sessionScoped.update(key, (s) => this.replaceAllWith(s.items, incoming))
    }
    // 未提及分区：快照中无其条目 = runtime 已全部删除 → 清空分区（防「删除不消失」+ Map 增长）。
    // GLOBAL_SCOPE_KEY 是 global scope 保留分区，不在 per-session 快照语义内，跳过
    const mentioned = new Set(groups.keys())
    for (const key of this.deps.sessionScoped.keys()) {
      if (!mentioned.has(key) && key !== GLOBAL_SCOPE_KEY) this.deps.sessionScoped.cleanup(key)
    }
  }

  private handleStatusSetUpdate(e: { sessionId?: string; status: StatusSetEntry[] }): void {
    const key = e.sessionId ?? GLOBAL_STATUS_KEY
    this.deps.sessionScoped.update(key, (s) => {
      s.setEntries.push(...e.status)
    })
  }

  private handleExtensionStatus(e: { sessionId?: string; status: ExtensionStatusEntry }): void {
    const key = e.sessionId ?? GLOBAL_STATUS_KEY
    this.deps.sessionScoped.update(key, (s) => {
      s.extensionStatus = e.status
    })
  }

  /** 取消全部订阅（幂等）。 */
  dispose(): void {
    for (const unsub of this.unsubscribe) unsub()
    this.unsubscribe = []
  }
}
