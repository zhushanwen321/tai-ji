/**
 * WindowManager Facade（implements IWindowManager）。
 *
 * 对应 spec §4.2 M2/M3「Window Manager」：窗口注册表 + 跨窗口 session 查询。
 *
 * [HISTORICAL] 不变量：
 * - Main 只保留单 panel 投影（v2 移除 split 后简化），window-manager 内部构造初始 state
 * - 不直接创建 BrowserWindow（创建委托 window-factory）
 * - fullscreen 状态变化通过 webContents.send 通知 renderer
 * - onWindowListChanged 回调：窗口 close 时触发，用于广播 window-list-updated
 *
 * 依赖方向：window-manager → interfaces + electron
 */
import { BrowserWindow } from 'electron'
import type { WindowState } from '@taiji/shared'
import type { IWindowManager } from '../interfaces.js'

/** 内部托管的窗口条目 */
interface ManagedWindow {
  windowId: string
  win: BrowserWindow
  state: WindowState
}

/**
 * WindowManager 实现。
 *
 * 使用方法：
 * ```ts
 * const wm = new WindowManager()
 * wm.register('win-1', win)
 * ```
 */
export class WindowManager implements IWindowManager {
  private windows = new Map<string, ManagedWindow>()
  private nextId = 1
  private onWindowListChanged?: () => void

  /** 设置窗口列表变化回调（create/close 触发） */
  setOnWindowListChanged(cb: () => void): void {
    this.onWindowListChanged = cb
  }

  /** 生成下一个窗口 id（win-1, win-2, ...） */
  generateId(): string {
    return `win-${this.nextId++}`
  }

  /** 注册窗口 + 绑定 fullscreen/closed 事件 */
  register(windowId: string, win: BrowserWindow): void {
    this.windows.set(windowId, { windowId, win, state: this.createInitialState(windowId) })

    // Notify renderer when macOS fullscreen state changes
    win.on('enter-full-screen', () => {
      win.webContents.send('fullscreen-changed', { isFullscreen: true })
    })
    win.on('leave-full-screen', () => {
      win.webContents.send('fullscreen-changed', { isFullscreen: false })
    })

    win.on('closed', () => {
      this.windows.delete(windowId)
      this.onWindowListChanged?.()
    })
  }

  /** 注销窗口（仅从 Map 移除，不关闭 BrowserWindow） */
  unregister(windowId: string): void {
    this.windows.delete(windowId)
  }

  /** 取窗口 BrowserWindow 引用 */
  get(windowId: string): BrowserWindow | undefined {
    return this.windows.get(windowId)?.win
  }

  /** 取所有窗口的 WindowState 投影（供桥接 handler） */
  getAll(): WindowState[] {
    return Array.from(this.windows.values()).map(w => w.state)
  }

  /** 聚焦窗口 */
  focus(windowId: string): void {
    const managed = this.windows.get(windowId)
    if (managed && !managed.win.isDestroyed()) {
      managed.win.focus()
    }
  }

  /** 关闭窗口 */
  close(windowId: string): void {
    const managed = this.windows.get(windowId)
    if (managed && !managed.win.isDestroyed()) {
      managed.win.close()
    }
  }

  /** 当前窗口数 */
  get windowCount(): number {
    return this.windows.size
  }

  /** 构造窗口初始 WindowState（单 panel 空叶子） */
  private createInitialState(windowId: string): WindowState {
    const panelId = `panel-${windowId}`
    return {
      windowId,
      panel: { id: panelId, sessionId: null },
      focusedPanelId: panelId,
      sessionIds: [],
    }
  }
}
