/**
 * per-connection 出站 FIFO（M3 设计 §3.3 D8 / D5 修复组 G2 m-rt-2）。
 *
 * 所有 R→C 帧（engine_frame 与控制帧）共用同一条队列：控制帧不得绕过背压，否则背压期
 * `engine_closed` 会越过已排队的 `engine_frame`——extension 收到通道终局后删除通道，
 * 后续到达的帧按 unknown channel 丢弃，最终 response 静默丢失。
 *
 * 职责边界：本类只管顺序、drain 恢复与溢出收尾；连接级上限判定与 per-channel 计数
 * 由 control-server 驱动（帧的 `onDequeued` 回调用于释放计数）。
 */
import type * as net from 'node:net'

export type OutboundWriteResult = 'written' | 'queued' | 'dropped'

export type OutboundFrame = {
  line: string
  bytes: number
  /** 帧出队（真正写出或连接销毁丢弃）时回调；直接写出的帧不会入队、不触发。 */
  onDequeued?: () => void
}

export class ConnectionOutboundQueue {
  private frames: OutboundFrame[] = []
  private bytes = 0
  private awaitingDrain = false
  private overflowed = false
  private closeAfterFlush = false
  private closeTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly socket: net.Socket,
    /** 排空等待上界：对端持续不读时兜底 destroy（显式失败动作的回收层有界兜底）。 */
    private readonly flushTimeoutMs: number,
  ) {}

  get pendingBytes(): number {
    return this.bytes
  }

  get hasOverflowed(): boolean {
    return this.overflowed
  }

  /** 连接级溢出已裁决：此后控制帧继续按 FIFO 收尾，数据面帧由调用方丢弃。 */
  markOverflowed(): void {
    this.overflowed = true
  }

  /**
   * 写入一帧：队列空 → 直接写；否则按 FIFO 入队。`socket.write` 返回 false 只登记
   * drain 等待——该帧已被 Node 受理，drain 时绝不重写（R3-N1 恰好一次投递）。
   */
  write(frame: OutboundFrame): OutboundWriteResult {
    if (this.socket.destroyed) return 'dropped'
    if (this.frames.length > 0 || this.awaitingDrain) {
      this.frames.push(frame)
      this.bytes += frame.bytes
      return 'queued'
    }
    let ok = false
    try {
      ok = this.socket.write(frame.line)
    } catch {
      return 'dropped' // 连接已死，close 链路接管
    }
    if (!ok) this.awaitingDrain = true
    return 'written'
  }

  /** drain 恢复：按序写出排队帧；排空后若已进入溢出收尾则 end。 */
  flush(): void {
    this.awaitingDrain = false
    while (this.frames.length > 0 && !this.awaitingDrain && !this.socket.destroyed) {
      const next = this.frames[0]
      let ok = false
      try {
        ok = this.socket.write(next.line)
      } catch {
        return // 连接已死，close 链路接管
      }
      this.frames.shift()
      this.bytes -= next.bytes
      next.onDequeued?.()
      if (!ok) this.awaitingDrain = true
    }
    this.finishIfDrained()
  }

  /**
   * 连接级溢出收尾：不再写完即 destroy（排队的 error 帧会丢），等队列排空后 end；
   * 对端持续不读时由 flushTimeoutMs 兜底 destroy。
   */
  beginCloseAfterFlush(): void {
    if (this.closeAfterFlush) return
    this.closeAfterFlush = true
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null
      if (!this.closeAfterFlush || this.socket.destroyed) return
      this.socket.destroy()
    }, this.flushTimeoutMs)
    this.finishIfDrained()
  }

  /** 连接销毁：丢弃未写出帧（逐个释放 per-channel 计数）、清定时器。 */
  dispose(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    this.closeAfterFlush = false
    for (const frame of this.frames) frame.onDequeued?.()
    this.frames = []
    this.bytes = 0
    this.awaitingDrain = false
  }

  private finishIfDrained(): void {
    if (!this.closeAfterFlush || this.socket.destroyed) return
    if (this.frames.length > 0 || this.awaitingDrain) return
    this.closeAfterFlush = false
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    try {
      this.socket.end()
    // eslint-disable-next-line taste/no-silent-catch -- 半关闭竞态：无需再关
    } catch {
      // 已 destroyed（竞态）：无需再关
    }
  }
}
