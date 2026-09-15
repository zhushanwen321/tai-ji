/**
 * logs 保留期清理手动触发 IPC handler（crash-resilience A9② 验收调试口）。
 *
 * 经 DEBUG_RUN_LOG_RETENTION（'debug:run-log-retention'）通道把 main 侧每日清理定时器
 * 的触发函数 `runLogRetentionNow()` 暴露为手动入口（空参 invoke）：dev 调试 / 验收时
 * 配 `TAIJI_LOG_KEEP_DAYS` 小保留期立即复扫 logs/，验证「清理不只启动时跑」并断言超龄
 * runtime-* / pi-* 文件被清、固定名 stderr 文件不误删（清理语义全部在 log-retention.ts
 * 的 cleanExpiredLogs，本文件只做 IPC 接线）。
 *
 * **验收调试入口，无鉴权面（本地 app 内），不进任何产品 UI**——renderer 产品代码不得
 * 调用；handler 返回 LogRetentionResult 的通道镜像 DebugRunLogRetentionResult
 * （ipc-payloads.ts，preload 签名共用）。零抛错：runLogRetentionNow 全路径容错
 * （目录缺失静默 {0,0} / 单文件失败 best-effort 跳过），invoke 无 rejection 面。
 */
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { DebugRunLogRetentionResult } from '@taiji/shared'
import { DEBUG_RUN_LOG_RETENTION } from '@taiji/shared'
import { runLogRetentionNow } from './log-retention.js'
import { mainLogger } from './main-logger.js'

let registered = false

/**
 * 注册 DEBUG_RUN_LOG_RETENTION handler。ipc-handlers.ts 聚合点调用一次；
 * 幂等（重复注册 Electron 会 throw「second handler」，标志位防重复注册炸启动，
 * 对齐 renderer-log-handler 同款）。
 */
export function registerLogRetentionDebugHandler(): void {
  if (registered) return
  registered = true
  try {
    ipcMain.handle(DEBUG_RUN_LOG_RETENTION, (_event: IpcMainInvokeEvent): DebugRunLogRetentionResult => {
      const result = runLogRetentionNow()
      mainLogger.debug('[log-retention-ipc] manual retention sweep triggered', { ...result })
      return result
    })
    mainLogger.debug('[log-retention-ipc] registered', { channel: DEBUG_RUN_LOG_RETENTION })
  // eslint-disable-next-line taste/no-silent-catch -- 注册失败（极端：channel 被占）不能炸 main 启动；调试口缺席只影响 dev 触发面，每日定时器清理不受影响
  } catch {
    // no-op
  }
}
