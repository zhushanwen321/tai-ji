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
 * - create 失败 reject（display-containers §7.4 错误通道）：manager.create 抛出经 handle
 *   变成 invoke rejection，renderer caller catch 落错误占位（重试 = create + show + navigate）。
 * - 显示收口 / 转发键清单的契约类通道（overlay-state / shields / forward-keys）payload
 *   经 gateway 纯函数校验，非法即 reject（error envelope 带原因）。
 *
 * 依赖方向：browser-handlers → electron(ipcMain) + interfaces(BrowserViewManager type-only)
 */
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { BrowserViewManager } from '../browser/browser-view-manager.js'
import { URL_PREVIEW_MAX_LENGTH, isAllowedNavigateUrl, isDangerousScheme } from './url-scheme-validators.js'
import { parseOverlayDisplayState, parseShieldFacesPayload } from '../browser/gateway/display-gate.js'
import { forwardKeyRegistry } from '../browser/gateway/forward-keys.js'

/** 'browser:forward-keys' 的 op 字面量（set=全量重报；register/unregister=注册/注销增量） */
/** 'browser:forward-keys' 的请求体（单 payload 对象，AGENTS 规则 #1）：
 *  set = 全量重报（替换整个清单）；add/remove = 注册/注销增量（可同请求组合） */
interface ForwardKeyRequest { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  set?: string[]
  add?: string[]
  remove?: string[]
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((k) => typeof k === 'string')
}

function parseForwardKeyRequest(payload: unknown): ForwardKeyRequest {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('[browser:forward-keys] payload must be an object')
  }
  const { set, add, remove } = payload as Record<string, unknown>
  if (set !== undefined && !isStringArray(set)) {
    throw new Error('[browser:forward-keys] set must be a string array')
  }
  if (add !== undefined && !isStringArray(add)) {
    throw new Error('[browser:forward-keys] add must be a string array')
  }
  if (remove !== undefined && !isStringArray(remove)) {
    throw new Error('[browser:forward-keys] remove must be a string array')
  }
  if (set === undefined && add === undefined && remove === undefined) {
    throw new Error('[browser:forward-keys] payload must carry set / add / remove')
  }
  if (set !== undefined && (add !== undefined || remove !== undefined)) {
    throw new Error('[browser:forward-keys] set (全量重报) cannot combine with add / remove (增量)')
  }
  return {
    ...(set !== undefined ? { set } : {}),
    ...(add !== undefined ? { add } : {}),
    ...(remove !== undefined ? { remove } : {}),
  }
}
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
  // 创建 view（attach 到 window，初始隐藏）。
  // §7.4 错误通道：create 失败抛出 → invoke reject（renderer caller catch 落错误占位 + 重试）。
  ipcMain.handle('browser:create', async (_event, { sessionId, windowId }: { sessionId: string; windowId: string }) => {
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

  // 切换可见 view（Wave 4 per-session 隔离；display-containers §7.4 R3 收口后语义）：
  // hide-only 收口 + 浮层随行豁免——非「浮层开 ∧ 内容 browser」态恒只隐藏不显示，
  // 显示唯一触发 = browser-view-manager.applyDisplay 统一谓词。
  // 场景：renderer watch(focusedSessionId) → 切 session 时调。
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

  // ── 显示收口事实源上报（display-containers §7.4 show 统一谓词 / 层级共存守卫）────

  // 浮层开合/内容切换上报：{ open, content, sessionId }（关浮层/换出 browser 内容 → 隐藏 view；
  // 重开 → 恢复显示）。非法 payload reject（error envelope）。
  ipcMain.handle('browser:overlay-state', async (_event, payload: unknown) => {
    manager.setOverlayState(parseOverlayDisplayState(payload))
  })

  // shieldsView 遮蔽面全量上报：{ faces: [{ id, fullscreen, rect? }] }（模态表面聚合 §6.7
  // 的 view 遮蔽族；全屏无条件隐藏 / 非全屏几何相交（双阈值滞回））。非法 payload reject。
  ipcMain.handle('browser:shields', async (_event, payload: unknown) => {
    manager.setShieldsViewFaces(parseShieldFacesPayload(payload))
  })

  // 转发键清单上报（§7.4 [MANDATORY]）：{ set?: string[], add?: string[], remove?: string[] }。
  // set = 全量重报（清单初始化 / settings 重录快捷键 / renderer 重载两个触发面的收敛手段）；
  // add/remove = 注册/注销增量。入清单约束（仅 mod 前缀组合，Esc 不入）由 registry
  // 强制，违规项进 rejected（不入清单）。返回 { accepted, rejected } 供上报方核对。
  ipcMain.handle('browser:forward-keys', async (_event, payload: unknown) => {
    const request = parseForwardKeyRequest(payload)
    if (request.set) return forwardKeyRegistry.set(request.set)
    return forwardKeyRegistry.update({ add: request.add, remove: request.remove })
  })
}
