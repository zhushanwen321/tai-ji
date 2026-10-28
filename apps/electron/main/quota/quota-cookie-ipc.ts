/**
 * quota:refresh-cookie IPC handler（额度查询 cookie 登录态刷新入口）。
 *
 * 经 QUOTA_REFRESH_COOKIE（'quota:refresh-cookie'）通道把隐藏窗口 cookie 刷新器
 * （cookie-refresher.ts）暴露为 renderer 入口。handler 不做业务逻辑，仅：
 * 输入校验（纯函数 isValidQuotaRefreshCookiePayload）→ 转发 refreshQuotaCookie。
 *
 * 错误契约：非法 payload reject（调用方 bug，对齐 browser-handlers 的 reject 形态）；
 * 刷新执行失败 resolve ok:false + error 文案（refreshQuotaCookie 永不 reject）。
 *
 * 先例 = sessions/session-export-ipc.ts：ipcMain.handle 注册幂等（registered 标志防
 * Electron「second handler」炸启动）+ 注册失败不炸 main 启动。
 *
 * 依赖方向：quota/quota-cookie-ipc → electron(ipcMain) + @taiji/shared + cookie-refresher
 * + logs/main-logger。
 */
import { ipcMain } from 'electron'
import { QUOTA_REFRESH_COOKIE, getQuotaRefreshTarget } from '@taiji/shared'
import type { QuotaRefreshCookiePayload, QuotaRefreshCookieResult } from '@taiji/shared'
import { refreshQuotaCookie } from './cookie-refresher.js'
import { mainLogger } from '../logs/main-logger.js'

/**
 * 输入校验（纯函数，参照 gateway/input-validators 形态）：fetcherId / providerId
 * 均非空 string 且 fetcherId 在 QUOTA_REFRESH_TARGETS 在册。IPC 边界无类型保障，
 * renderer 被破解时任意值可进——非在册 fetcher 直接 reject，不进刷新流程。
 */
export function isValidQuotaRefreshCookiePayload(payload: unknown): payload is QuotaRefreshCookiePayload {
  if (typeof payload !== 'object' || payload === null) return false
  const { fetcherId, providerId } = payload as Record<string, unknown>
  if (typeof fetcherId !== 'string' || fetcherId === '') return false
  if (typeof providerId !== 'string' || providerId === '') return false
  return getQuotaRefreshTarget(fetcherId) !== undefined
}

let registered = false

/**
 * 注册 QUOTA_REFRESH_COOKIE handler。ipc-handlers.ts 聚合点调用一次；幂等
 * （对齐 session-export-ipc：重复注册 Electron 会 throw，标志位防重复注册炸启动）。
 */
export function registerQuotaCookieRefreshHandler(): void {
  if (registered) return
  registered = true
  try {
    ipcMain.handle(
      QUOTA_REFRESH_COOKIE,
      async (_event, payload: unknown): Promise<QuotaRefreshCookieResult> => {
        if (!isValidQuotaRefreshCookiePayload(payload)) {
          // async 体内 throw → invoke rejection（对齐 browser:navigate 的非法参数 reject 契约）
          throw new Error('[quota:refresh-cookie] invalid payload: expected { fetcherId, providerId } with fetcherId registered in QUOTA_REFRESH_TARGETS')
        }
        return refreshQuotaCookie(payload)
      },
    )
    mainLogger.debug('[quota-cookie-ipc] registered', { channel: QUOTA_REFRESH_COOKIE })
  } catch (err) {
    // 注册失败（极端：channel 被占）不能炸 main 启动；刷新入口缺席只影响设置页刷新按钮
    // （对齐 session-export-ipc / diagnostics-export-ipc 先例的降级语义）
    mainLogger.warn('[quota-cookie-ipc] register failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
