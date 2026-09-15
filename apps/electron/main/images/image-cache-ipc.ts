/**
 * image-cache IPC handler（crash-resilience §3.3 D6-⑨ / u7-memory-governance）。
 *
 * 接收 renderer 经 IMAGE_CACHE_WRITE 通道委托的 toolResult base64 图片，落盘
 * `~/.taiji/cache/images/<sessionId>/<sha256>.<ext>` 并回填路径引用（renderer 是
 * 浏览器环境无 fs——落盘执行方 = main，设计显式声明）。核心生命周期（幂等写 / size 帽 /
 * 孤儿扫描 / 软上限）在 ./image-cache.ts，本文件只做 IPC 两侧职责：
 * - **payload 运行时再校验**：renderer 在崩溃/中毒状态下可能发出畸形 payload，类型不作
 *   信任依据（对齐 renderer-log-handler 同款信任边界）；sessionId 非法（含路径穿越载荷）
 *   整批拒绝返回空结果，不 throw
 * - **handler 零抛错**：落盘失败吞没为 quota-full 之外的 error-free 降级（invalid 结果），
 *   图片缓存故障不得放大为 main 崩溃或 invoke rejection 风暴（消息流不阻断，设计占位语义）
 * - **启动清扫挂点**：注册时同步执行孤儿扫描 + 软上限（main 模块加载期、app ready 前
 *   调用；sync 清扫量级 = 目录条目级 stat，模块加载期内完成，先于窗口创建）
 */
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { ImageCacheWriteImage, ImageCacheWritePayload, ImageCacheWriteResult } from '@taiji/shared'
import { IMAGE_CACHE_WRITE } from '@taiji/shared'
import { runImageCacheStartupSweep, writeImagesNewestFirst } from './image-cache.js'

/** payload 运行时校验：sessionId 字符串 + images 非空数组（元素延后逐图判 invalid）。 */
function isValidPayload(payload: unknown): payload is ImageCacheWritePayload {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  if (typeof p.sessionId !== 'string' || p.sessionId === '') return false
  return Array.isArray(p.images) && p.images.length > 0
}

/** 单元素宽校验（字段类型不对齐 → invalid，逐图降级不整批拒）。 */
function toImage(raw: unknown): ImageCacheWriteImage {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return { data: typeof r.data === 'string' ? r.data : '', mimeType: typeof r.mimeType === 'string' ? r.mimeType : '' }
}

/**
 * 注册 IMAGE_CACHE_WRITE handler + 启动清扫。ipc-handlers.ts 聚合点单行调用；
 * 清扫用生产目录推导（无注入——测试直接调 image-cache.ts 纯函数）。
 */
export function registerImageCacheHandlers(): void {
  // 启动清扫（孤儿扫描 30 天 + 全局软上限 512MB）：fire-and-forget，故障静默
  //（sync 函数，量级 = 目录条目级 stat，不阻塞窗口创建时序；同步执行保证清扫在
  // 首次 hydrate 落盘前完成口径——启动竞态下先写后扫也无害：孤儿判据不看「是否刚写」
  // 看 mtime 30 天）
  runImageCacheStartupSweep()
  ipcMain.handle(IMAGE_CACHE_WRITE, (_event: IpcMainInvokeEvent, payload: unknown): ImageCacheWriteResult => {
    if (!isValidPayload(payload)) {
      return { results: [], quotaFull: false }
    }
    try {
      const result = writeImagesNewestFirst(payload.sessionId, payload.images.map(toImage))
      return result
    } catch {
      // 路径穿越（getImageCacheDir throw）/ fs 异常：整批降级 invalid（不阻断消息流）
      return {
        results: payload.images.map(() => ({ status: 'invalid' as const })),
        quotaFull: false,
      }
    }
  })
}
