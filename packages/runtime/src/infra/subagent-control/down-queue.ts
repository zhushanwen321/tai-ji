/**
 * per-channel 下行待写队列（M3 设计 §3.3 D8）。
 *
 * 从 control-server 抽出的独立状态机（max-lines 收口）：负责 engine stdin 的背压恢复与
 * per-channel / 连接聚合双上限判定；杀链与显式失败帧由调用方注入（`onOverflow`）。
 *
 * 投递语义（R3-N1）：`stdin.write` 返回 false 只表示内核缓冲已满——该帧已被 Node 受理，
 * 只登记 drain 等待、不入队重写；只有背压期到达的帧才真正入队。
 */
import { byteLengthOf } from './frames.js'

/** 引擎 stdin 的最小结构契约（生产 = ChildProcess.stdin；测试可注入 fake）。 */
export type DownStdin = {
  destroyed: boolean
  write(chunk: string): boolean
  once(event: 'drain', listener: () => void): unknown
}

export type ChannelDownQueueDeps = {
  channelId: string
  /** 当前引擎 stdin（引擎已死 → null/undefined，帧直接丢弃）。 */
  getStdin: () => DownStdin | null | undefined
  channelMaxBytes: number
  channelMaxFrames: number
  /** 连接级聚合读写（ConnState.downQueueBytes）。 */
  getConnectionBytes: () => number
  setConnectionBytes: (bytes: number) => void
  connectionMaxBytes: number
  /** 溢出裁决：control-server 发 error + 杀组（不丢帧不静默）。 */
  onOverflow: (detail: string, connectionLevel: boolean) => void
}

export class ChannelDownQueue {
  private pending: Array<{ line: string; bytes: number }> = []
  private pendingBytes = 0
  private awaitingDrain = false

  constructor(private readonly deps: ChannelDownQueueDeps) {}

  /** 写入一帧（或背压期入队）；溢出走 deps.onOverflow 显式失败。 */
  push(line: string): void {
    const stdin = this.deps.getStdin()
    if (stdin === undefined || stdin === null || stdin.destroyed) {
      console.debug(`[subagent-control] stdin unavailable, dropping frame channelId=${this.deps.channelId}`)
      return
    }
    const bytes = byteLengthOf(line) + 1
    if (this.awaitingDrain || this.pending.length > 0) {
      this.enqueue(stdin, line, bytes)
      return
    }
    let ok = false
    try {
      ok = stdin.write(`${line}\n`)
    } catch (e) {
      // 引擎已死（EPIPE 族）：exit 帧链路接管，丢帧降级
      console.debug(`[subagent-control] stdin write threw channelId=${this.deps.channelId}:`, e)
      return
    }
    // write false = 本帧已被 Node 受理并在 drain 前写出：只登记等待，绝不入队重写。
    if (!ok) this.armDrain(stdin)
  }

  /** 通道终结：释放队列并把连接级聚合计数扣回。 */
  dispose(): void {
    this.deps.setConnectionBytes(Math.max(0, this.deps.getConnectionBytes() - this.pendingBytes))
    this.pending = []
    this.pendingBytes = 0
    this.awaitingDrain = false
  }

  private enqueue(stdin: DownStdin, line: string, bytes: number): void {
    const channelOverflow = this.pendingBytes + bytes > this.deps.channelMaxBytes
      || this.pending.length + 1 > this.deps.channelMaxFrames
    const connectionOverflow = this.deps.getConnectionBytes() + bytes > this.deps.connectionMaxBytes
    if (channelOverflow || connectionOverflow) {
      const detail = connectionOverflow
        ? `engine stdin queue overflow (connection aggregate ${String(this.deps.getConnectionBytes() + bytes)} bytes)`
        : `engine stdin queue overflow (${String(this.pendingBytes + bytes)} bytes / ${String(this.pending.length + 1)} frames queued)`
      this.deps.onOverflow(detail, connectionOverflow)
      return
    }
    this.pending.push({ line, bytes })
    this.pendingBytes += bytes
    this.deps.setConnectionBytes(this.deps.getConnectionBytes() + bytes)
    this.armDrain(stdin)
  }

  private armDrain(stdin: DownStdin): void {
    if (this.awaitingDrain) return
    this.awaitingDrain = true
    stdin.once('drain', () => {
      this.flush()
    })
  }

  private flush(): void {
    this.awaitingDrain = false
    const stdin = this.deps.getStdin()
    if (stdin === undefined || stdin === null || stdin.destroyed) return
    while (this.pending.length > 0) {
      const next = this.pending[0]
      let ok = false
      try {
        ok = stdin.write(`${next.line}\n`)
      } catch {
        return // 引擎已死，exit 链路接管
      }
      // 已交给 Node（即便返回 false 也已被受理）→ 出队，绝不保留重写
      this.pending.shift()
      this.pendingBytes -= next.bytes
      this.deps.setConnectionBytes(Math.max(0, this.deps.getConnectionBytes() - next.bytes))
      if (!ok) {
        this.armDrain(stdin)
        return
      }
    }
  }
}
