/**
 * 桥接 IPC handler（纯转发，无副作用）。
 *
 * 对应 spec §4.2 M4「桥接 handler」：getRuntimePort / getRuntimePortOffset /
 * getWindows / focusWindow / createWindow。
 * 只读 Main 内部状态或委托给 windowManager/runtime，无 OS 副作用。
 *
 * [HISTORICAL] 不变量：
 * - 桥接 handler 不做输入校验（只读/委托，无安全风险）
 * - createWindow 触发 broadcastWindowList（通知所有 renderer 窗口列表变化）
 * - windowManager.setOnWindowListChanged 注册 broadcastWindowList 回调
 *
 * 依赖方向：bridge-handlers → electron(ipcMain) + interfaces
 */
import { ipcMain, BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { sep } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import type { IpcHandlerDeps } from '../interfaces.js'

/**
 * 注册桥接 IPC handler（runtime port / 窗口管理系列）。
 *
 * @param deps 注入的依赖（runtime/windowManager/createWindow）
 */
export function registerBridgeHandlers(deps: IpcHandlerDeps): void {
  // ── runtime 端口 / token（只读 supervisor 状态）───────────────────
  ipcMain.handle('get-runtime-port', () => deps.runtime.port)
  ipcMain.handle('get-runtime-port-offset', () => deps.runtime.portOffset)
  // S1-W1（spec §3.3 D4）：WS auth token 下发通道①——renderer 经 preload
  // getRuntimeToken 读取（与 get-runtime-port 同模式），连接 open 后作首条 auth 消息发送。
  // 通道②（<dataDir>/runtime-token 文件）面向 CLI / 脚本，不经此 IPC。
  ipcMain.handle('get-runtime-token', () => deps.runtime.token)

  // ── 数据目录（只读，Settings 强制目录展示动态化用）─────────────────
  // 返回 ~ 缩写的展示路径（home 前缀 → ~），dev 下为 ~/.taiji-dev，prod 为 ~/.taiji。
  // 修复 SettingsResourcePage forcedDirs 硬编码 '~/.taiji/skills' 在 dev 下误导的问题。
  ipcMain.handle('get-data-dir', () => {
    const dir = getDataDir()
    const home = homedir()
    // 路径分隔符边界：home 自身（/Users/alice）满足 startsWith，但 /Users/alice2 不是其子路径，
    // 必须要求 home + sep 前缀才缩写，避免把同前缀兄弟目录误缩成 ~/lice2（M7-06）。
    return dir.startsWith(home + sep) ? '~' + dir.slice(home.length) : dir
  })

  // ── runtime 手动重启（崩溃重启用尽后，用户从状态条点重试触发）─────────
  // 委托 supervisor.restartRuntime：重置策略 + start + 广播端口/失败
  ipcMain.handle('runtime-restart', async () => {
    await deps.runtime.restartRuntime()
  })

  // ── 窗口管理 ─────────────────────────────────────────────────────
  ipcMain.handle('create-window', async (_event, options?: { sessionId?: string }) => {
    const windowId = deps.windowManager.generateId()
    const win = await deps.createWindow({ windowId, sessionId: options?.sessionId })
    deps.windowManager.register(windowId, win)
    // 通知所有已存在窗口：窗口列表变化
    broadcastWindowList()
    return { windowId }
  })

  ipcMain.handle('get-windows', () => {
    return deps.windowManager.getAll()
  })

  ipcMain.handle('focus-window', (_event, windowId: string) => {
    deps.windowManager.focus(windowId)
  })

  // 窗口列表变化回调：create/close 时触发广播
  deps.windowManager.setOnWindowListChanged(() => {
    broadcastWindowList()
  })
}

/**
 * 广播窗口列表变化到所有 renderer 进程。
 * 在 createWindow / window close 时触发。
 */
export function broadcastWindowList(): void {
  const allWindows = BrowserWindow.getAllWindows()
  for (const win of allWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send('window-list-updated')
    }
  }
}
