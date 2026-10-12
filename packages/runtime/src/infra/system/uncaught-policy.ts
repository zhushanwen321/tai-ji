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
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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

// ── 逃逸取证落盘（排障前置改造，2026-10-11 用户裁决）────────────────────
//
// 背景：dev 实例 uncaught exception 风暴死循环（原 docs/todo 登记已随本改造删除，
// git 可追溯）——异常经 inspector 通道的 console.error 同步格式化深栈，格式化自身
// 再抛 → 重新进入 uncaughtException handler → 主线程 CPU 100%、shutdown 走不完，
// 异常内容零落盘（排障无证据）。本函数在 handler 入口用独立通道写一行零格式化
// 取证行，让下一次风暴留下痕迹。

/** 取证行 message 截断上限（单行小文件目标，防巨型 message 在风暴循环里放大写入量）。 */
const ESCAPE_LOG_MESSAGE_MAX_LENGTH = 200
/** ISO 日期 YYYY-MM-DD 的字符长度（文件名日期段）。 */
const ISO_DATE_LENGTH = 10

/** 取证行来自哪条进程级逃逸通道（日志行内的 kind 标记）。 */
export type ProcessEscapeKind = 'uncaught-exception' | 'unhandled-rejection'

/**
 * 进程级异常逃逸的一行级原子取证落盘。
 *
 * 铁律（每条都服务「不在风暴里再触发异常」）：
 * - **禁止访问 err.stack**——getter 触发 V8 惰性深栈格式化，正是风暴热点；只取
 *   name + message 首行（截断 ≤200 字符）。
 * - **appendFileSync 同步直写**——不走 logger（logger 可能已故障）、不经异步缓冲
 *   队列（进程死亡即丢，crash journal 同理由排除）；整个函数体包 try/catch，任何
 *   读取/写入失败静默吞（在异常处置路径上再抛 = 递归放大）。
 *
 * 文件：logsDir 下 `runtime-uncaught-<date>.log`（runtime- 前缀复用 logger.ts
 * cleanExpiredLogs 的保留期清理；date 命名对齐主日志惯例）。logsDir 由调用方经
 * getDataDir() 动态推导传入，本模块不持路径状态。now 可注入，测试固定时刻控制
 * 文件名日期与时间戳（recordWatermarkDailySample 同款注入模式）。
 */
export function appendProcessEscapeLog(
  logsDir: string,
  kind: ProcessEscapeKind,
  err: unknown,
  now: Date = new Date(),
): void {
  try {
    const name = err instanceof Error ? err.name : `<${typeof err}>`
    // 铁律落地：只取 message 首行 + 截断，全程不触碰 stack
    const message = String(err instanceof Error ? err.message : err).split(/\r?\n/)[0] ?? ''
    const detail = message.length > ESCAPE_LOG_MESSAGE_MAX_LENGTH
      ? message.slice(0, ESCAPE_LOG_MESSAGE_MAX_LENGTH)
      : message
    const line = `[${now.toISOString()}] [${kind}] ${name}: ${detail}\n`
    mkdirSync(logsDir, { recursive: true })
    appendFileSync(join(logsDir, `runtime-uncaught-${now.toISOString().slice(0, ISO_DATE_LENGTH)}.log`), line)
  // eslint-disable-next-line taste/no-silent-catch -- 取证 best-effort：磁盘满/权限/路径不可用等任何失败都不得在异常处置路径上再抛（递归回逃逸 handler 即放大事故）
  } catch {
    // no-op
  }
}
