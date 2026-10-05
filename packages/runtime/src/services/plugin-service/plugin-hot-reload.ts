/**
 * 插件热重载监视器
 *
 * 从 plugin-activator.ts 抽取的 fs.watch 子系统：debounce + 超时强杀 +
 * reload fan-out。自包含 watchers / debounce timers 状态，通过构造时注入的
 * hooks 回调（deactivate / activate / 强杀 / 状态查询）与 activator 交互，
 * 从而把「文件监视」职责从「激活状态机」中分离出来。
 */

import { watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'

import type { PluginSource } from './plugin-types.js'

/** Hot-reload 需要从 Activator 借用的能力（构造时注入） */
export interface HotReloadHooks {
  /** 停用插件（含 postMessage + 等待回复） */
  deactivate(pluginId: string): Promise<void>
  /** 重新激活插件 */
  activate(pluginId: string): Promise<void>
  /**
   * 强杀 Worker：deactivate 超时时的兜底。若插件无活跃 worker 则为 no-op。
   * 注意：调用方在之后仍会调用 disposeContext / setState 清理本地状态，
   * 与原始实现保持一致（无论是否有 worker，超时后都清理 context + 置 UNLOADED）。
   */
  forceTerminate(pluginId: string): Promise<void>
  /** dispose 插件 subscriptions 并清理 context（强杀后调用） */
  disposeContext(pluginId: string): void
  /** 标记插件状态（强杀后置为 UNLOADED） */
  setState(pluginId: string, state: 'UNLOADED'): void
  /** 查询插件当前状态（用于 reload 时判断是否 ACTIVE） */
  getState(pluginId: string): string | undefined
}

/** Callback to broadcast plugin status changes */
export type StatusChangeCallback = (payload: {
  pluginId: string
  oldStatus: string
  newStatus: string
}) => void

/** PluginHost 的最小接口——热重载需要 getWorkerHandle（已在 hooks 间接使用） */

const HOT_RELOAD_DEBOUNCE_MS = 300

interface ReloadContext {
  hooks: HotReloadHooks
  onStatusChange: StatusChangeCallback
}

/**
 * 管理外部插件的文件监视与热重载。
 *
 * 每个被监视的插件维护一个 FSWatcher 与一个 debounce 定时器；
 * 文件变更经 300ms 防抖后触发 performReload（deactivate → activate → 广播）。
 * 内置插件（source === 'built-in'）永不监视。
 */
export class PluginHotReloader {
  /** Hot-reload watchers: pluginId → FSWatcher */
  private watchers = new Map<string, FSWatcher>()
  /** Hot-reload debounce timers: pluginId → timeout handle */
  private reloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Reload context (hooks + callback) for each watched plugin */
  private reloadContexts = new Map<string, ReloadContext>()

  /**
   * Watch an external plugin's directory for changes and auto-reload.
   * Built-in plugins (source === 'built-in') are excluded.
   */
  watchAndReload(
    pluginId: string,
    pluginPath: string,
    source: PluginSource,
    hooks: HotReloadHooks,
    onStatusChange: StatusChangeCallback,
  ): void {
    // Built-in plugins: never watch
    if (source === 'built-in') return

    // Don't double-watch
    if (this.watchers.has(pluginId)) return

    // Store reload context for later use by debounce timer
    this.reloadContexts.set(pluginId, { hooks, onStatusChange })

    const watchDir = dirname(pluginPath)
    const watcher = watch(watchDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return

      // Only watch for JS/TS file changes
      if (!filename.endsWith('.js') && !filename.endsWith('.ts')) return

      // Debounce: 300ms
      const existing = this.reloadTimers.get(pluginId)
      if (existing) clearTimeout(existing)

      this.reloadTimers.set(pluginId, setTimeout(async () => {
        this.reloadTimers.delete(pluginId)
        const ctx = this.reloadContexts.get(pluginId)
        if (ctx) {
          await this.performReload(pluginId, ctx.hooks, ctx.onStatusChange)
        }
      }, HOT_RELOAD_DEBOUNCE_MS))
    })

    this.watchers.set(pluginId, watcher)
  }

  /**
   * Perform a hot reload: deactivate → activate → broadcast status change.
   */
  async performReload(
    pluginId: string,
    hooks: HotReloadHooks,
    onStatusChange: StatusChangeCallback,
  ): Promise<void> {
    const currentState = hooks.getState(pluginId)
    if (currentState !== 'ACTIVE') return // Only reload active plugins

    const oldStatus = 'active'

    // 1. Deactivate（墙钟已随 ADR-0112 退役：deactivate 抛错走热重载失败路径）
    await hooks.deactivate(pluginId)

    // 2. Re-activate
    await hooks.activate(pluginId)

    // 3. Notify frontend of status change
    const newStatus = hooks.getState(pluginId) === 'ACTIVE' ? 'active' : 'crashed'
    onStatusChange({ pluginId, oldStatus, newStatus })
  }

  /** Stop watching a specific plugin */
  stopWatching(pluginId: string): void {
    const watcher = this.watchers.get(pluginId)
    if (watcher) {
      watcher.close()
      this.watchers.delete(pluginId)
    }
    const timer = this.reloadTimers.get(pluginId)
    if (timer) {
      clearTimeout(timer)
      this.reloadTimers.delete(pluginId)
    }
  }

  /** Stop all watchers (used during shutdown) */
  stopAllWatchers(): void {
    for (const pluginId of this.watchers.keys()) {
      this.stopWatching(pluginId)
    }
  }
}
