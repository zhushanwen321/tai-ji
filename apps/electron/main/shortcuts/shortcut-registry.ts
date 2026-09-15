/**
 * ShortcutRegistry Facade（implements IShortcutRegistry）。
 *
 * 对应 spec §4.2 M5。原 shortcuts.ts 是平铺函数，本次提升为 class 并
 * 区分全局快捷键（globalShortcut）vs 窗口快捷键（accelerator）的注册时机。
 *
 * [HISTORICAL] 不变量：
 * - globalShortcut.register 对已占用的组合静默失败 → 注册前判断 globalShortcut.isRegistered（去重）
 * - 当前 2 个快捷键（CommandOrControl+1/3）都是全局的，通过 win.webContents.send('shortcut', type) 转发
 * - unregisterAll 幂等
 *
 * 依赖方向：shortcut-registry → electron(globalShortcut/BrowserWindow) + interfaces
 */
import { BrowserWindow, globalShortcut } from 'electron'
import type { IShortcutRegistry } from '../interfaces.js'

/** 快捷键类型（对应 renderer 监听的 type 字段） */
type ShortcutType = 'standard' | 'focus'

/** 快捷键映射表：accelerator → type */
const SHORTCUTS: Record<string, ShortcutType> = {
  'CommandOrControl+1': 'standard',
  'CommandOrControl+3': 'focus',
}

/**
 * ShortcutRegistry 实现。
 *
 * 使用方法：
 * ```ts
 * const registry = new ShortcutRegistry()
 * registry.registerGlobal(mainWindow)
 * registry.unregisterAll()
 * ```
 */
export class ShortcutRegistry implements IShortcutRegistry {
  /**
   * 注册全局快捷键。通过 win.webContents.send('shortcut', type) 转发到渲染进程。
   *
   * W7 窗口重建语义：已注册的 accelerator 先 unregister（解绑旧窗口回调）再 register（绑当前 win）；
   * 同时检查 register 返回值，被其他 app 占用（返回 false）时 console.warn。
   */
  registerGlobal(win: BrowserWindow): void {
    for (const [accelerator, type] of Object.entries(SHORTCUTS)) {
      // W7 窗口重建（reload / 崩溃恢复）时，globalShortcut 注册表可能残留「已注册」状态。
      // 若像旧实现那样 `if (isRegistered) continue` 跳过，会保留绑定到旧（已销毁）窗口的回调，
      // 导致新窗口收不到 'shortcut' 事件。这里先 unregister 解绑旧回调，再 register 绑定到当前 win。
      if (globalShortcut.isRegistered(accelerator)) {
        globalShortcut.unregister(accelerator)
      }
      // [HISTORICAL] spec M5：globalShortcut.register 对被其他 app 占用的组合返回 false（静默失败），
      // 必须检查返回值，失败时 warn 提示（被占用仅在 register 时才能发现）。
      const ok = globalShortcut.register(accelerator, () => {
        if (!win.isDestroyed()) {
          win.webContents.send('shortcut', type)
        }
      })
      if (!ok) {
        console.warn(
          `[shortcut] 全局快捷键注册失败：${accelerator}（可能被其他应用占用）`,
        )
      }
    }
  }

  /** 注销所有已注册的快捷键（幂等） */
  unregisterAll(): void {
    globalShortcut.unregisterAll()
  }
}
