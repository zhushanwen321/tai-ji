/**
 * per-session timer 句柄清理工具（store.ts pendingSend timer 复用）。
 *
 * 从 chat.ts 提取以控制文件行数（max-lines 500 上限）。
 * 历史上还承载 streaming idle 超时 timer 三件套（arm/refresh/clear），该兜底机制
 * 已随「流式空闲超时」功能废弃整体删除——挂死流的回收由 runtime PingProbe（180s
 * 进程判死 abort）/ 断连统一收口 / 用户手动停止承接，前端不再设墙钟兜底。
 */

/** 清除 per-session timer（export：store.ts 复用，消除本地双份副本——两版语义等价，clearTimeout(undefined) 是 no-op） */
export function clearSessionTimer(timers: Map<string, ReturnType<typeof setTimeout>>, sessionId: string): void {
  const t = timers.get(sessionId)
  if (t !== undefined) {
    clearTimeout(t)
    timers.delete(sessionId)
  }
}
