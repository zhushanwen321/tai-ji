/**
 * 桥接 IPC handler（纯转发，无副作用）。
 *
 * 对应 spec §4.2 M4「桥接 handler」：getRuntimePort / getRuntimePortOffset /
 * getWindows / focusWindow / createWindow。
 * 只读 Main 内部状态或委托给 windowManager/runtime，无 OS 副作用。
 * remote-access 域（get-remote-access-info / rotate-remote-access-token /
 * set-remote-access-enabled）是本文件的受控例外：写配置文件 + 触发 runtime 重启，
 * 有输入校验（isValidRemoteAccessEnabled）——写侧与重启链委托 remote-access store
 * 与 supervisor 公开 API，本文件不持配置状态。
 *
 * [HISTORICAL] 不变量：
 * - 桥接 handler 不做输入校验（只读/委托，无安全风险；remote-access 域除外，见上）
 * - createWindow 触发 broadcastWindowList（通知所有 renderer 窗口列表变化）
 * - windowManager.setOnWindowListChanged 注册 broadcastWindowList 回调
 *
 * 依赖方向：bridge-handlers → electron(ipcMain) + interfaces + remote-access(store/lan)
 */
import { ipcMain, BrowserWindow } from 'electron'
import { homedir, networkInterfaces } from 'node:os'
import { sep } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import type { IpcHandlerDeps } from '../interfaces.js'
import { enumerateLanAddresses } from '../remote-access/lan-addresses.js'
import { readRemoteAccessConfig, rotateRemoteAccessToken, setRemoteAccessEnabled } from '../remote-access/store.js'
import { isValidRemoteAccessEnabled } from './input-validators.js'

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

  // ── remote-access 连接信息（配置 + LAN 候选 + 轮换 + 开关切换）────────
  // remote-access D2/D6/D9：main 是 remote-access.json 唯一写方；连接 URL 候选 =
  // LAN IPv4 枚举 × 当前 runtime 端口（runtime 未启动 → 空列表，面板不产死链接）。
  ipcMain.handle('get-remote-access-info', () => buildRemoteAccessInfo(deps))

  // 轮换 token：重写文件即生效（runtime 每次握手热读，不触发重启），返回新配置
  ipcMain.handle('rotate-remote-access-token', () => {
    rotateRemoteAccessToken()
    return buildRemoteAccessInfo(deps)
  })

  // 开关切换：先落盘，开关状态实际变化且 runtime 在跑时重启 runtime（listen host 与
  // argv 是启动期一次性决策）；runtime 未跑（mock/未启动）只落盘，下次启动自然生效
  ipcMain.handle('set-remote-access-enabled', async (_event, enabled: unknown) => {
    if (!isValidRemoteAccessEnabled(enabled)) {
      throw new Error('set-remote-access-enabled: enabled must be a boolean')
    }
    const before = readRemoteAccessConfig().enabled
    setRemoteAccessEnabled(enabled)
    let restarted = false
    if (enabled !== before && deps.runtime.port !== null) {
      await restartRuntimeForRemoteAccess(deps)
      restarted = true
    }
    return { ...buildRemoteAccessInfo(deps), restarted }
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

// ── remote-access 连接信息（helper，模式对齐 broadcastWindowList：实时取窗口，不存引用）──

/** 连接信息 payload（renderer 面板消费；token 仅桌面 IPC 通道分发，不走 HTTP 面）。 */
interface RemoteAccessInfo {
  enabled: boolean
  token: string
  createdAt: string
  /** LAN 直连候选（`http://<ip>:<port>`；runtime 未启动为空数组） */
  urls: string[]
}

/** 当前配置 + LAN 候选（端口来自 supervisor 的既有端口发现，未启动为 null → 空列表）。 */
function buildRemoteAccessInfo(deps: IpcHandlerDeps): RemoteAccessInfo {
  const config = readRemoteAccessConfig()
  return {
    enabled: config.enabled,
    token: config.token,
    createdAt: config.createdAt,
    urls: enumerateLanAddresses(networkInterfaces(), deps.runtime.port),
  }
}

/**
 * 开关切换触发的 runtime 重启（remote-access D9/E7）。
 *
 * 复用 supervisor 既有重启链的公开原子步骤：stop()（markStopping 保证 exit 不被
 * 崩溃链误判）→ start()（幂等守卫 + 完整启动时序：找端口 → spawn → 健康检查 → 写端口文件）。
 * 不走 restartRuntime()——它对存活进程幂等短路（直接广播端口不重启），而开关切换
 * 恰恰需要真重启让 listen host / argv 变化生效。重启成功后按 supervisor 崩溃重启链
 * 同款广播形态通知全部窗口：runtime-restarting（进重连等待态）→ runtime-port（新端口重连）。
 *
 * start() 失败（spawn/健康检查）时异常向上抛（invoke rejection，面板展示失败）——
 * 此时 runtime 已停，renderer 可经既有 runtime-restart IPC 手动重试。
 */
async function restartRuntimeForRemoteAccess(deps: IpcHandlerDeps): Promise<void> {
  await deps.runtime.stop()
  const port = await deps.runtime.start()
  broadcastToAllWindows('runtime-restarting', { attempt: 0 })
  broadcastToAllWindows('runtime-port', port)
}

/** 广播事件到所有存活窗口（对齐 RuntimeSupervisor.broadcastToAllWindows 语义）。 */
function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
