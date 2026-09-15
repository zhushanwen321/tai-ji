/**
 * IPC handler 注册入口。
 *
 * 对应 spec §4.2 M4「OS Gateway」Facade：编排特权 + 桥接 + browser 三类 handler 的注册。
 * 把原来一个函数 8+ handler 的内联实现拆为 privileged / bridge / browser 三个模块。
 *
 * 依赖方向：ipc-handlers → interfaces + privileged-handlers + bridge-handlers + browser-handlers
 */
import type { IpcHandlerDeps } from '../interfaces.js'
import { registerPrivilegedHandlers } from './privileged-handlers.js'
import { registerBridgeHandlers } from './bridge-handlers.js'
import { registerBrowserHandlers } from './browser-handlers.js'
import { registerUpdateHandlers } from './update-handlers.js'
import { registerSoundHandlers } from './sound-handlers.js'
import { registerRendererLogHandler } from '../logs/renderer-log-handler.js'
import { registerImageCacheHandlers } from '../images/image-cache-ipc.js'
import { registerLogRetentionDebugHandler } from '../logs/log-retention-ipc.js'
import { registerDiagnosticsExportHandler } from '../diagnostics/diagnostics-export-ipc.js'

/**
 * 注册所有 IPC handlers（特权 + 桥接 + browser drawer + 自动升级（含代理配置） + 系统提示音
 * + renderer 错误上报）。
 *
 * @param deps 注入依赖（实现由 main.ts 构造 MainContext 后提供）
 */
export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  registerPrivilegedHandlers(deps)
  registerBridgeHandlers(deps)
  registerBrowserHandlers(deps.browserViewManager, deps.getMainWindow)
  registerUpdateHandlers(deps)
  registerSoundHandlers()
  registerRendererLogHandler()
  // [D6-⑨ u7] toolResult 图片落盘（含启动清扫：孤儿扫描 + 软上限）
  registerImageCacheHandlers()
  // [A9②] logs 保留期清理手动触发（验收调试口，无鉴权面，不进产品 UI）
  registerLogRetentionDebugHandler()
  // [crash-forensics D6 u3a] 诊断包导出（设置页/死态页入口，保存对话框由 main 弹出）
  registerDiagnosticsExportHandler()
}
