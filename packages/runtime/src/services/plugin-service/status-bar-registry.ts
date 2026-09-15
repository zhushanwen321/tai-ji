/**
 * Status Bar 注册表（StatusBarRegistry）
 *
 * 从 PluginService 抽出的正交职责：维护插件注册的 status bar item，
 * 并在变更时广播 `plugin:statusBarUpdate`（ADR-0015 契约不变）。
 *
 * 行为契约（与原 PluginService 完全一致）：
 * - itemKey = `${pluginId}:${id}`，空 text 表示移除该 item。
 * - 新增/更新/删除后广播当前全量 items。
 * - clearForPlugin(pluginId) 清理某插件全部 item（停用/卸载时调用），有变更才广播。
 * - getItems() 返回当前全量 item（供 renderer 主动拉取）。
 *
 * S3-W4（D7 限流与防毒化）：广播合并窗口——窗口内（默认 100ms，shared
 * PLUGIN_NOTIFY_LIMITS.STATUSBAR_COALESCE_MS）的多次更新合并为一次广播
 * （trailing-edge debounce），防高频 statusbar 更新刷屏前端。coalesceMs = 0
 * 退化为立即广播（兼容测试/同步语义）。
 *
 * 依赖：仅依赖一个 broadcast 回调（payload 为 { items }），不耦合 broker 细节。
 */

import { PLUGIN_NOTIFY_LIMITS } from '@taiji/shared'
import type { StatusBarItem } from '@taiji/shared'

/** 广播回调：把 status bar 更新推给前端（type 固定为 'plugin:statusBarUpdate'） */
export type StatusBarBroadcastFn = (payload: { items: StatusBarItem[] }) => void

/** StatusBarRegistry 构造选项 */
export interface StatusBarRegistryOptions {
  /**
   * 广播合并窗口（ms）。默认取 shared PLUGIN_NOTIFY_LIMITS.STATUSBAR_COALESCE_MS
   * （100ms）；传 0 关闭合并（每次更新立即广播）。
   */
  coalesceMs?: number
}

export class StatusBarRegistry {
  /** Status bar items registry，key 为 `${pluginId}:${id}` */
  readonly items = new Map<string, StatusBarItem>()

  private readonly broadcast: StatusBarBroadcastFn
  private readonly coalesceMs: number
  private pendingTimer: ReturnType<typeof setTimeout> | null = null

  constructor(broadcast: StatusBarBroadcastFn, options?: StatusBarRegistryOptions) {
    this.broadcast = broadcast
    this.coalesceMs = options?.coalesceMs ?? PLUGIN_NOTIFY_LIMITS.STATUSBAR_COALESCE_MS
  }

  /** Get all current status bar items */
  getItems(): StatusBarItem[] {
    return Array.from(this.items.values())
  }

  /**
   * Broadcast current status bar items to all clients.
   *
   * 合并窗口 > 0 时 trailing-edge debounce：窗口内重复调用合并为窗口到期后的
   * 一次广播（广播内容总是最新全量快照，合并不丢终态）。窗口 = 0 立即广播。
   */
  broadcastAll(): void {
    if (this.coalesceMs <= 0) {
      this.flush()
      return
    }
    if (this.pendingTimer !== null) return // 窗口已开：本次更新并入待发广播
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      this.flush()
    }, this.coalesceMs)
  }

  /** 立即发出一次广播（不经过合并窗口；flush 待发 timer 一并清掉） */
  private flush(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
    this.broadcast({ items: this.getItems() })
  }

  /** Clear all status bar items for a given plugin (used during deactivation) */
  clearForPlugin(pluginId: string): void {
    let changed = false
    for (const [key, item] of this.items) {
      if (item.pluginId === pluginId) {
        this.items.delete(key)
        changed = true
      }
    }
    if (changed) this.broadcastAll()
  }

  /** 停止接收更新并清理待发 timer（runtime 关停时调用；幂等） */
  dispose(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
  }
}
