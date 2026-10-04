/**
 * WS 出站背压观测（code-harden RT-1#7）：发送侧 bufferedAmount 阈值 warn。
 *
 * 背景：broker.send/broadcast/reply 与 message-bus.broadcastText 此前只检查 readyState
 * 即 ws.send——OPEN 但对端不读（渲染进程卡死/慢消费）时发送缓冲持续堆积，无任何指标，
 * 大广播不可归因。ws 库不提供缓冲上限保护（ws#359 维护者立场：应用自查 bufferedAmount），
 * 故本模块只做观测（warn 计数），不做丢弃/断连——处置决策留给排障侧。
 *
 * 阈值 1MB：ws 库 README 背压示例的常用量级；本机回环 + 单消费方的常态值接近 0，
 * 超过 1MB 即「对端持续不消费」的明确信号，误报率可忽略。
 *
 * 去重语义：每个 socket 从「低于阈值」进入「超阈值」态时 warn 一次（附当前堆积字节数），
 * 持续超阈值不重复刷日志；降回阈值内后再次越限才产生下一条 warn。WeakMap 不阻碍
 * socket 回收。
 */

/** 背压告警阈值（字节）。量级依据见模块注释。 */
const BACKPRESSURE_WARN_BYTES = 1_048_576

/** 处于「已 warn 的超阈值态」的 socket 集合（退出超阈值态即移除，允许再次越限时再 warn）。 */
const backpressureWarned = new WeakMap<object, boolean>()

/**
 * 发送后检查 socket 发送缓冲堆积，超阈值时 warn（每 socket 每次进入超阈值态一条）。
 * bufferedAmount 缺省（mock / 非 WS 实现）时 no-op——观测设施不能成为发送路径的崩溃源。
 *
 * @param socket 发送目标（ws 库 WebSocket 或满足同形契约的 BusClient）
 * @param channel 日志归因标签（send / broadcast / reply / publish）
 */
export function warnIfBacklogged(socket: { bufferedAmount?: number }, channel: string): void {
  let amount: number | undefined
  try {
    amount = socket.bufferedAmount
  } catch {
    return
  }
  if (typeof amount !== 'number') return
  if (amount > BACKPRESSURE_WARN_BYTES) {
    if (backpressureWarned.get(socket) === true) return
    backpressureWarned.set(socket, true)
    console.warn(`[backpressure] ws send buffer over threshold: channel=${channel} bufferedAmount=${amount}B (> ${BACKPRESSURE_WARN_BYTES}B) — peer not consuming, outbound frames queued`)
  } else {
    backpressureWarned.delete(socket)
  }
}
