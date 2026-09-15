/**
 * 特权 IPC handler（需 OS 能力）。
 *
 * 对应 spec §4.2 M4「特权 handler」：openExternal / pickDirectory。
 * 每个单独做输入校验（委托 input-validators）。
 *
 * [HISTORICAL] 不变量：
 * - openExternal 校验 http/https（isValidExternalUrl）
 * - pickDirectory 用 BrowserWindow.getFocusedWindow()（无聚焦窗口返回 canceled）
 * - pickFile 同范式：getFocusedWindow 降级 + defaultPath homedir 兜底 + try/catch 返回 canceled
 *
 * 依赖方向：privileged-handlers → electron(dialog/shell/BrowserWindow) + input-validators + interfaces
 */
import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { IpcHandlerDeps } from '../interfaces.js'
import { isValidAbsolutePath, isValidExternalUrl } from './input-validators.js'

/**
 * 注册特权 IPC handler（open-external / pick-directory / pick-file）。
 *
 * [wave:runtime-patch ipc-converge-a3 W2] write-session-image / migrate-session-image /
 * write-segments-metadata 3 个业务持久化 handler 已迁至 runtime session-service（WS）。
 * session 数据读写单一出口归 runtime，main 不再持 attachments 写逻辑。
 *
 * @param deps 注入的依赖
 */
export function registerPrivilegedHandlers(deps: IpcHandlerDeps): void {
  void deps
  // open-external：校验 http/https 后交给系统浏览器
  ipcMain.handle('open-external', async (_event, url: string): Promise<boolean> => {
    // [HISTORICAL] 安全检查：只允许 http/https 协议（防 file:// / javascript: 等）
    if (!isValidExternalUrl(url)) return false
    try {
      await shell.openExternal(url)
      return true
    } catch (err) {
      // openExternal 失败不致命，返回 false 让调用方降级
      console.error('[ipc] open-external failed:', err)
      return false
    }
  })

  // reveal-in-folder：在文件管理器中显示文件（trace MALFORMED 行「打开所在目录」恢复
  // 指引，§3.1）。输入校验：绝对路径（来源 runtime 快照 filePath；相对路径在 main cwd
  // 下解析歧义，直接拒绝）。showItemInFolder 对不存在文件静默 no-op，存在性不校验——
  // session JSONL 可能恰在删除窗口内，静默降级比误报错诚实。风格对齐 open-external
  //（try/catch + 返回 false 降级）。
  ipcMain.handle('reveal-in-folder', (_event, filePath: unknown): boolean => {
    if (!isValidAbsolutePath(filePath)) return false
    try {
      shell.showItemInFolder(filePath)
      return true
    } catch (err) {
      console.error('[ipc] reveal-in-folder failed:', err)
      return false
    }
  })

  // pick-directory：用聚焦窗口打开目录选择器（无聚焦窗口返回 canceled）
  // [W7] 风格对齐 open-external：dialog 抛异常时 console.error + 返回 {canceled:true, path:null}，
  // 而非依赖 ipcMain.handle 的 invoke rejection 兜底。降级目标对称：无聚焦窗口 / dialog 崩溃都返回 canceled。
  //
  // [HISTORICAL] defaultPath 兜底到 homedir：
  // 省略 defaultPath 时 macOS 原生目录选择器会用 OS 记忆的上次位置；若该位置已被删除，
  // Finder 会回退到 Documents（非预期，用户期望回退到 ~）。由渲染端传入候选 defaultPath
  //（通常是 currentCwd），主进程 existsSync 守卫——存在则用，否则降级 homedir。
  // 不能把"已删除目录"原样传给 dialog：否则又触发 OS 的 Documents 回退，丢失意义。
  ipcMain.handle(
    'pick-directory',
    async (_event, options?: { title?: string; defaultPath?: string }) => {
      const focusedWin = BrowserWindow.getFocusedWindow()
      if (!focusedWin) return { canceled: true, path: null }
      try {
        const fallbackPath =
          options?.defaultPath && existsSync(options.defaultPath)
            ? options.defaultPath
            : homedir()
        const result = await dialog.showOpenDialog(focusedWin, {
          properties: ['openDirectory'],
          title: options?.title ?? '选择项目目录',
          defaultPath: fallbackPath,
        })
        if (result.canceled || result.filePaths.length === 0) {
          return { canceled: true, path: null }
        }
        return { canceled: false, path: result.filePaths[0] }
      } catch (err) {
        console.error('[ipc] pick-directory failed:', err)
        return { canceled: true, path: null }
      }
    },
  )

  // pick-file：用聚焦窗口打开文件选择器（无聚焦窗口返回 canceled）。
  // [W7] 风格对齐 pick-directory：dialog 抛异常时 console.error + 返回 {canceled:true, path:null}，
  // 而非依赖 ipcMain.handle 的 invoke rejection 兜底。降级目标对称：无聚焦窗口 / dialog 崩溃都返回 canceled。
  //
  // [HISTORICAL] defaultPath 兜底到 homedir（与 pick-directory 同一不变量）：
  // 省略 defaultPath 时 macOS 原生文件选择器会用 OS 记忆的上次位置；若该位置已被删除，
  // Finder 会回退到 Documents（非预期，用户期望回退到 ~）。由渲染端传入候选 defaultPath，
  // 主进程 existsSync 守卫——存在则用，否则降级 homedir。
  //
  // filters 透传：渲染端传入 Electron 原生 FileFilter[]（{name, extensions}），主进程不转换
  // 直接传给 dialog，让渲染端决定业务类型（图片/文档/视频），IPC 保持薄通道语义。
  ipcMain.handle(
    'pick-file',
    async (
      _event,
      options?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> },
    ) => {
      const focusedWin = BrowserWindow.getFocusedWindow()
      if (!focusedWin) return { canceled: true, path: null }
      try {
        const fallbackPath =
          options?.defaultPath && existsSync(options.defaultPath) ? options.defaultPath : homedir()
        const result = await dialog.showOpenDialog(focusedWin, {
          properties: ['openFile'],
          title: options?.title ?? '选择文件',
          defaultPath: fallbackPath,
          filters: options?.filters,
        })
        if (result.canceled || result.filePaths.length === 0) {
          return { canceled: true, path: null }
        }
        return { canceled: false, path: result.filePaths[0] }
      } catch (err) {
        console.error('[ipc] pick-file failed:', err)
        return { canceled: true, path: null }
      }
    },
  )


  // ── 窗口控制（win/linux 自绘 traffic-light 圆点点击，shell spec §五方案 X）─────
  // mac 红黄绿是系统按钮不走这里。fromWebContents 按 sender 定位调用窗口，多窗口安全。
  ipcMain.handle('window-minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.handle('window-toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window-close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}
