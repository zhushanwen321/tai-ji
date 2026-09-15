/**
 * uncaughtException 分级策略（2026-09-04 runtime 整机崩溃事故护栏，D 级最后一道）。
 *
 * 背景：relay 对端半关闭后子进程 stdout 回调里的同步 `conn.write` 抛 EPIPE，逃逸为
 * uncaughtException → 整机 graceful shutdown → 全部 session 中断（Electron 自动重启
 * 恢复实测 ~16s）。源头修复（writeFrame/endConn/conn error listener）已拦截已知路径，
 * 本模块是兜底分级：**连接级流错误**与**逻辑级崩溃**分开处置。
 *
 * 分级依据：SAFE_STREAM_ERROR_CODES 中的错误码只可能产自流/文件描述符操作（socket、
 * pipe、stdio），抛出点必然在流事件回调链内，不触碰 runtime 自身数据结构——进程状态
 * 可信。未知错误码（TypeError / RangeError / 业务逻辑异常等）语义上进程一致性已不可
 * 保证，维持 index.ts 的 graceful shutdown + exit(1) 原语义（supervisor 重启兜底）。
 *
 * 注意：新增错误码必须论证「唯一来源是 IO 且影响限于单连接/单流」，禁止把业务异常
 * 错误码加进来当「良性」处理（那会把真 bug 静默化）。
 */

/**
 * 已识别为连接/流级噪声的错误码（出现即 log 继续运行，不 shutdown）：
 * - EPIPE / ECONNRESET / ECONNABORTED：对端断开后本端仍写/读（TCP/pipe 两侧）
 * - ERR_STREAM_DESTROYED：destroyed 流上的 write/end（生命周期竞态）
 * - ERR_STREAM_WRITE_AFTER_END：本端 end() 后再 write（半关闭自动 end 的孪生场景）
 */
export const SAFE_STREAM_ERROR_CODES: ReadonlySet<string> = new Set([
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
])

/** 判定异常是否为已识别的连接/流级噪声（分级 log-continue 的充分条件）。 */
export function isContainedStreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  return typeof code === 'string' && SAFE_STREAM_ERROR_CODES.has(code)
}
