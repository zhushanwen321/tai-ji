/**
 * Browser drawer IPC handler。
 *
 * 对应 Browser Drawer Wave 1：注册 browser:create / navigate / hide / show / destroy
 * 五个 IPC channel，转发给 BrowserViewManager。
 *
 * [HISTORICAL] 不变量：
 * - IPC 参数用对象封装（AGENTS 关键规则 #1：emit/handle 单 payload 对象，禁止多 arg）。
 *   create / navigate 用 { sessionId, windowId } / { sessionId, url }，
 *   hide / show / destroy 用 sessionId（单值 channel，sender 不变）。
 * - handler 不做业务逻辑，仅转发；生命周期与错误处理在 BrowserViewManager 内。
 * - navigate 的 loadURL reject 会经 ipcMain.handle 自然变成 invoke rejection，
 *   renderer 侧 catch（W2 接）。
 *
 * 依赖方向：browser-handlers → electron(ipcMain) + interfaces(BrowserViewManager type-only)
 */
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { BrowserViewManager } from '../browser/browser-view-manager.js'
import { URL_PREVIEW_MAX_LENGTH, isAllowedNavigateUrl, isDangerousScheme } from './url-scheme-validators.js'

/**
 * 注册 browser drawer IPC handler。
 *
 * @param manager BrowserViewManager 实例（由 main.ts 构造注入）
 * @param _getMainWindow 主窗口取值器（W1 未用，W2 发事件给 renderer 时需要，预留参数避免后续改签名）
 */
export function registerBrowserHandlers(
  manager: BrowserViewManager,
  _getMainWindow: () => BrowserWindow | null,
): void {
  // 创建 view（attach 到 window，初始隐藏）
  ipcMain.handle('browser:create', (_event, { sessionId, windowId }: { sessionId: string; windowId: string }) => {
    manager.create(sessionId, windowId)
  })

  // 导航（loadURL 失败时 invoke reject）
  // [HISTORICAL] PR #100 B1 双层防御：handler 入口先校验 scheme（白名单），拒危险协议。
  // 渲染端 useUrlBar 也有黑名单（用户即时反馈），但 renderer 可被 XSS/console 绕过，
  // 主进程必须有第二层（白名单策略，独立于渲染端的黑名单，独立函数便于单测）。
  // scheme 校验失败时 invoke reject 带明确 reason，renderer .catch 接住后 toast。
  ipcMain.handle('browser:navigate', async (_event, { sessionId, url }: { sessionId: string; url: string }) => {
    if (isDangerousScheme(url)) {
      throw new Error(`[browser:navigate] rejected dangerous scheme: ${url.slice(0, URL_PREVIEW_MAX_LENGTH)}`)
    }
    if (!isAllowedNavigateUrl(url)) {
      throw new Error(`[browser:navigate] only http(s) URLs are allowed: ${url.slice(0, URL_PREVIEW_MAX_LENGTH)}`)
    }
    await manager.navigate(sessionId, url)
  })

  // 隐藏（keep-alive，不销毁）
  ipcMain.handle('browser:hide', (_event, sessionId: string) => {
    manager.hide(sessionId)
  })

  // 显示（恢复最近 rect）
  ipcMain.handle('browser:show', (_event, sessionId: string) => {
    manager.show(sessionId)
  })

  // 切换可见 view（Wave 4 per-session 隔离）：隐藏当前可见的其他 session view，显示 target session view。
  // 场景：renderer watch(focusedSessionId) → 切 session 时调，确保屏幕只显示新 session 的 view。
  ipcMain.handle('browser:focus', (_event, sessionId: string) => {
    manager.focus(sessionId)
  })

  // 历史导航（Wave 5）：后退 / 前进。sessionId 不存在或无法导航时无操作。
  // 单值 payload（裸 sessionId）。
  ipcMain.handle('browser:back', (_event, sessionId: string) => {
    manager.goBack(sessionId)
  })
  ipcMain.handle('browser:forward', (_event, sessionId: string) => {
    manager.goForward(sessionId)
  })

  // 缩放（Wave 5）：设置 / 读取缩放因子。
  // set-zoom 用单对象 payload（AGENTS 规则 #1，两个参数）；get-zoom 用裸 sessionId（单参数）。
  ipcMain.handle('browser:set-zoom', (_event, { sessionId, factor }: { sessionId: string; factor: number }) => {
    manager.setZoomFactor(sessionId, factor)
  })
  ipcMain.handle('browser:get-zoom', (_event, sessionId: string) => {
    return manager.getZoomFactor(sessionId)
  })

  // 读取选区（二期扩展点，Wave 6 预留）
  ipcMain.handle('browser:get-selection', (_event, sessionId: string) => {
    return manager.getSelection(sessionId)
  })

  // 销毁（removeChildView + webContents.destroy）
  ipcMain.handle('browser:destroy', (_event, sessionId: string) => {
    manager.destroy(sessionId)
  })

  // 设置 view 位置/尺寸（renderer 推送，CSS px = DIP，不乘 dpr）。
  // 单对象 payload（AGENTS 规则 #1）：{ sessionId, rect }。
  ipcMain.handle(
    'browser:set-rect',
    (_event, { sessionId, rect }: { sessionId: string; rect: { x: number; y: number; width: number; height: number } }) => {
      manager.setRect(sessionId, rect)
    },
  )
}
