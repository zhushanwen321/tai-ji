// src/execution/engine/client/transport/control-write-queue.ts
//
// [M3] control 出站背压队列（u-m3-rt-transport；设计 §3.3 D8）：socket 写回执模式
// （write 返回 false = 内核缓冲已满 → 后续帧入队，drain 时按 FIFO 冲队列）+ 双上限
// （单 channel 32MB/4096 帧；每连接每方向聚合 256MB）。溢出**不丢帧不静默**：返回
// 具体裁决（channel_overflow / connection_overflow）由 RuntimeControlClient 映射为
// engine_backpressure_overflow 并关通道/关连接。纯队列职责，不持有 socket/定时器。

import type * as net from "node:net";

type QueueUsage = { bytes: number; frames: number };
type QueuedEnvelope = { channelId: string; line: string; bytes: number };

/** append 裁决：written/queued = 已受理；no_socket/channel_overflow/connection_overflow = 未受理。 */
export type ControlQueueAppendOutcome =
  | "written"
  | "queued"
  | "no_socket"
  | "channel_overflow"
  | "connection_overflow";

/** 队列上限（构造注入；测试可给小值）。 */
export type ControlWriteQueueLimits = {
  channelQueueMaxBytes: number;
  channelQueueMaxFrames: number;
  connectionQueueMaxBytes: number;
};

export class ControlWriteQueue {
  private readonly channelQueue = new Map<string, QueueUsage>();
  private queue: QueuedEnvelope[] = [];
  private queueBytes = 0;
  private awaitingDrain = false;

  constructor(private readonly limits: ControlWriteQueueLimits) {}

  /**
   * 写一行或入队（line 已含换行）。socket 余量充足直写；背压中（awaitingDrain/队列非空）
   * 入队并核对上限——channel 溢出返回 channel_overflow（调用方关通道），连接聚合溢出
   * 返回 connection_overflow（调用方关连接）。
   */
  append(socket: net.Socket | undefined, channelId: string, line: string, bytes: number): ControlQueueAppendOutcome {
    if (socket === undefined || socket.destroyed) return "no_socket";
    if (this.awaitingDrain || this.queue.length > 0) {
      return this.enqueue(channelId, line, bytes);
    }
    let ok: boolean;
    try {
      ok = socket.write(line);
    } catch {
      return "no_socket";
    }
    if (!ok) this.awaitingDrain = true;
    return "written";
  }

  /** drain 恢复：按 FIFO 冲队列直到再次背压（socket 已死则保留队列由失败路径清）。 */
  flush(socket: net.Socket | undefined): void {
    if (socket === undefined || socket.destroyed) return;
    this.awaitingDrain = false;
    while (this.queue.length > 0 && !this.awaitingDrain) {
      const next = this.queue[0];
      if (next === undefined) break;
      let ok: boolean;
      try {
        ok = socket.write(next.line);
      } catch {
        return;
      }
      this.queue.shift();
      this.queueBytes -= next.bytes;
      this.releaseUsage(next.channelId, next.bytes);
      if (!ok) this.awaitingDrain = true;
    }
  }

  /** 丢弃某 channel 的全部积压帧（通道过载/关闭时；后到的帧不再入队——调用方先置关闸）。 */
  purge(channelId: string): void {
    if (this.queue.length === 0) return;
    const removed = this.queue.filter((entry) => entry.channelId === channelId);
    if (removed.length === 0) return;
    this.queue = this.queue.filter((entry) => entry.channelId !== channelId);
    for (const entry of removed) this.queueBytes -= entry.bytes;
    this.channelQueue.delete(channelId);
  }

  /** 整体清空（连接失败/关停）。 */
  clear(): void {
    this.channelQueue.clear();
    this.queue = [];
    this.queueBytes = 0;
    this.awaitingDrain = false;
  }

  private enqueue(channelId: string, line: string, bytes: number): ControlQueueAppendOutcome {
    if (this.queueBytes + bytes > this.limits.connectionQueueMaxBytes) {
      return "connection_overflow";
    }
    const usage = this.channelQueue.get(channelId) ?? { bytes: 0, frames: 0 };
    if (usage.bytes + bytes > this.limits.channelQueueMaxBytes
      || usage.frames + 1 > this.limits.channelQueueMaxFrames) {
      return "channel_overflow";
    }
    this.queue.push({ channelId, line, bytes });
    this.queueBytes += bytes;
    usage.bytes += bytes;
    usage.frames += 1;
    this.channelQueue.set(channelId, usage);
    return "queued";
  }

  private releaseUsage(channelId: string, bytes: number): void {
    const usage = this.channelQueue.get(channelId);
    if (usage === undefined) return;
    usage.bytes -= bytes;
    usage.frames -= 1;
    if (usage.frames <= 0) this.channelQueue.delete(channelId);
  }
}
