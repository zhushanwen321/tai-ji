// src/execution/engine/client/transport/control-client.ts
//
// [M3] RuntimeControlClient：extension 侧 control socket 客户端（设计 relay-spawn-transport
// §3.3 D5/D8、§3.4.3；u-m3-rt-transport）。进程级共享：一个宿主 pi 进程一条连接
// （module registry 按 socket 路径复用 + 引用计数），每通道一个 channelId；嵌套 task pi
// 是独立进程 → 自建连接（同一 socket）。职责 = 帧信封搬运 / hello/engine_open 握手与 id
// 关联 / engine_closed → 通道终局回调 / 出站背压队列（control-write-queue.ts）/ 连接死亡
// fan-out（engine_transport_lost，D5：通道终局 vs 连接死亡两分）；常量/类型/错误映射在
// control-shared.ts，R→C 帧解析在 control-inbound.ts。无心跳（ADR-0122 进程生死二态）。
//
// 错误面（D5/D8/D10）：connect/hello 失败 → engine_transport_unavailable（不静默回落
// local）；hello_reject version → engine_protocol_mismatch；ready 后连接丢失 →
// engine_transport_lost（不是 engine_crashed，不原地重试）；engine_open 超时 →
// engine_open_timeout；帧超限/队列溢出 → engine_frame_too_large / engine_backpressure_overflow（先具体码后 engine_closed）。

import * as net from "node:net";

import {
  EngineSdkError,
  SUBAGENT_CONTROL_FRAME_KINDS,
  SUBAGENT_CONTROL_PROTOCOL_VERSION,
  getLogger,
} from "@zhushanwen/subagent-engine-sdk";

import {
  CHANNEL_QUEUE_MAX_BYTES,
  CHANNEL_QUEUE_MAX_FRAMES,
  CONNECTION_QUEUE_MAX_BYTES,
  CONTROL_CLOSE_GRACE_MS,
  CONTROL_CONNECT_TIMEOUT_MS,
  CONTROL_HELLO_TIMEOUT_MS,
  CONTROL_MAX_FRAME_BYTES,
  ENGINE_OPEN_TIMEOUT_MS,
  makeTransportError,
  mapControlError,
  type ControlChannelHandlers,
  type ControlChannelIdentity,
  type ControlChannelOpenResult,
  type ControlChannelRecord,
  type ControlClientState,
  type ControlPendingOpen,
  type RuntimeControlClientOptions,
} from "./control-shared.ts";
import {
  parseControlInboundLine,
  type ControlInboundEngineClosed,
  type ControlInboundEngineFrame,
  type ControlInboundEngineOpenFailed,
  type ControlInboundEngineOpened,
  type ControlInboundError,
  type ControlInboundHelloOk,
  type ControlInboundHelloReject,
} from "./control-inbound.ts";
import { ControlWriteQueue } from "./control-write-queue.ts";
import type { EngineLaunchSpec, EngineTransportExitInfo } from "./types.ts";

const logger = getLogger("subagents");

/** 进程级共享表（socket 路径 → 客户端实例；D5 一个主 pi 一条连接）。 */
const sharedClients = new Map<string, RuntimeControlClient>();
/** 取得共享客户端（引用计数 +1）；不可用实例（lost/disposed）弃用后新建。 */
export function acquireRuntimeControlClient(opts: RuntimeControlClientOptions): RuntimeControlClient {
  const existing = sharedClients.get(opts.socketPath);
  if (existing !== undefined && existing.isUsable) {
    existing.acquire();
    return existing;
  }
  const created = new RuntimeControlClient(opts);
  sharedClients.set(opts.socketPath, created);
  created.acquire();
  return created;
}

/** control socket 客户端（一条连接多通道）：connect → openChannel → closeChannel → 连接死亡 fan-out；不自动重连。 */
export class RuntimeControlClient {
  readonly socketPath: string;
  private readonly hostKind: string;
  private readonly connectTimeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly openTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly maxFrameBytes: number;

  private state: ControlClientState = "idle";
  private refs = 0;
  private socket: net.Socket | undefined;
  private connectPromise: Promise<void> | undefined;
  private connectResolve: (() => void) | undefined;
  private connectReject: ((err: Error) => void) | undefined;
  private connectTimer: NodeJS.Timeout | undefined;
  private helloTimer: NodeJS.Timeout | undefined;
  private helloId: number | undefined;
  private nextId = 1;
  private buffer = "";
  private bufferBytes = 0;
  private readonly channels = new Map<string, ControlChannelRecord>();
  private readonly pendingOpens = new Map<string, ControlPendingOpen>();
  private readonly writeQueue: ControlWriteQueue;

  constructor(opts: RuntimeControlClientOptions) {
    this.socketPath = opts.socketPath;
    this.hostKind = opts.hostKind;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? CONTROL_CONNECT_TIMEOUT_MS;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? CONTROL_HELLO_TIMEOUT_MS;
    this.openTimeoutMs = opts.openTimeoutMs ?? ENGINE_OPEN_TIMEOUT_MS;
    this.closeGraceMs = opts.closeGraceMs ?? CONTROL_CLOSE_GRACE_MS;
    this.maxFrameBytes = opts.maxFrameBytes ?? CONTROL_MAX_FRAME_BYTES;
    this.writeQueue = new ControlWriteQueue({
      channelQueueMaxBytes: opts.channelQueueMaxBytes ?? CHANNEL_QUEUE_MAX_BYTES,
      channelQueueMaxFrames: opts.channelQueueMaxFrames ?? CHANNEL_QUEUE_MAX_FRAMES,
      connectionQueueMaxBytes: opts.connectionQueueMaxBytes ?? CONNECTION_QUEUE_MAX_BYTES,
    });
  }

  get isUsable(): boolean { return this.state !== "lost" && this.state !== "disposed"; }

  /** 在册通道数（共享连接复用/回收的观测面）。 */
  get channelCount(): number { return this.channels.size; }

  /** 引用计数 +1（transport 每次 open 一次；open 失败即归还）。 */
  acquire(): void {
    this.refs += 1;
  }

  /** 引用计数 -1；归零 = 无通道需要该连接，主动关停。 */
  release(): void {
    if (this.refs <= 0) return;
    this.refs -= 1;
    if (this.refs === 0) this.dispose();
  }

  /** 主动关停（幂等）：关连接 + 以 transport_lost 收口在册通道与在途 open。 */
  dispose(): void {
    if (this.state === "lost" || this.state === "disposed") return;
    const ready = this.state === "ready" || this.state === "hello";
    this.failFatal(makeTransportError(ready ? "engine_transport_lost" : "engine_transport_unavailable",
      "control client disposed by host"));
    this.state = "disposed";
  }

  /** 建立连接并完成 hello 握手（幂等；并发调用共享同一 promise）。 */
  connect(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.state === "lost" || this.state === "disposed") {
      return Promise.reject(makeTransportError("engine_transport_unavailable",
        `control client for ${this.socketPath} is no longer usable`));
    }
    if (this.connectPromise !== undefined) return this.connectPromise;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  /** 打开引擎通道：engine_open（id 关联）→ engine_opened（带 pid）；超时/连接死亡以具体码 reject。 */
  async openChannel(
    spec: EngineLaunchSpec,
    identity: ControlChannelIdentity,
    handlers: ControlChannelHandlers,
  ): Promise<ControlChannelOpenResult> {
    await this.connect();
    if (this.state !== "ready") {
      throw makeTransportError("engine_transport_unavailable", "control connection is not ready");
    }
    return new Promise<ControlChannelOpenResult>((resolve, reject) => {
      const id = this.nextId++;
      const key = String(id);
      const timer = setTimeout(() => {
        this.pendingOpens.delete(key);
        reject(makeTransportError("engine_open_timeout",
          `runtime did not answer engine_open (id=${id}) within ${this.openTimeoutMs}ms`));
      }, this.openTimeoutMs);
      this.pendingOpens.set(key, { id, handlers, resolve, reject, timer });
      const frame: Record<string, unknown> = {
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: SUBAGENT_CONTROL_FRAME_KINDS.engineOpen,
        id,
        launch: {
          engineId: spec.engineId,
          entryPath: spec.entryPath,
          args: [...spec.args],
          cwd: spec.cwd,
          envPrefixes: [...spec.envPrefixes],
          rootSessionId: identity.rootSessionId,
          ...(identity.parentRecordId !== undefined && identity.parentRecordId.length > 0
            ? { parentRecordId: identity.parentRecordId }
            : {}),
          ...(identity.depth !== undefined ? { depth: identity.depth } : {}),
        },
      };
      if (!this.sendRaw(frame)) {
        clearTimeout(timer);
        this.pendingOpens.delete(key);
        reject(makeTransportError("engine_transport_lost", "control connection is not writable"));
      }
    });
  }

  /** 写一行引擎帧（包进 engine_frame 信封）；false = 未受理（通道死/超限/溢出）。 */
  writeFrame(channelId: string, line: string): boolean {
    if (this.state !== "ready") return false;
    const channel = this.channels.get(channelId);
    if (channel === undefined || channel.closeRequested) return false;
    const envelope = `${JSON.stringify({ v: SUBAGENT_CONTROL_PROTOCOL_VERSION, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineFrame, channelId, line })}\n`;
    const bytes = Buffer.byteLength(envelope, "utf8");
    if (bytes > this.maxFrameBytes) {
      this.terminateOverloadedChannel(channel, makeTransportError("engine_frame_too_large",
        `engine frame envelope exceeded ${this.maxFrameBytes} bytes (no truncation)`));
      return false;
    }
    return this.appendEnvelope(channel, envelope, bytes);
  }

  /** 优雅关闭通道：发 engine_close，等 engine_closed 或 closeGraceMs 宽限（超时只放弃该通道，不关共享连接）。 */
  closeChannel(channelId: string, reason?: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (channel === undefined) return Promise.resolve();
    if (channel.closeRequested) return channel.closePromise ?? Promise.resolve();
    channel.closeRequested = true;
    const promise = this.beginCloseWait(channel);
    this.sendCloseFrame(channel);
    logger.debug(`[control-client] engine_close sent for ${channelId}${reason !== undefined ? ` (${reason})` : ""}`);
    return promise;
  }

  // 连接层

  private doConnect(): Promise<void> {
    this.state = "connecting";
    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      const socket = net.connect({ path: this.socketPath });
      this.socket = socket;
      this.connectTimer = setTimeout(() => {
        this.connectTimer = undefined;
        this.failFatal(makeTransportError("engine_transport_unavailable",
          `control socket connect timed out after ${this.connectTimeoutMs}ms (${this.socketPath})`));
      }, this.connectTimeoutMs);
      socket.once("connect", () => {
        if (this.state !== "connecting") return;
        this.clearConnectTimers();
        this.state = "hello";
        this.helloId = this.nextId++;
        this.helloTimer = setTimeout(() => {
          this.helloTimer = undefined;
          this.failFatal(makeTransportError("engine_transport_unavailable",
            `hello handshake timed out after ${this.helloTimeoutMs}ms (${this.socketPath})`));
        }, this.helloTimeoutMs);
        this.sendRaw({
          v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
          kind: SUBAGENT_CONTROL_FRAME_KINDS.hello,
          id: this.helloId,
          hostPid: process.pid,
          hostKind: this.hostKind,
        });
      });
      socket.on("data", (chunk: Buffer) => this.ingest(chunk));
      socket.on("error", (err: Error) => {
        logger.debug(`[control-client] socket error (close will follow): ${err.message}`);
      });
      socket.on("drain", () => this.writeQueue.flush(this.socket));
      socket.once("close", () => {
        if (this.state === "lost" || this.state === "disposed") return;
        this.failFatal(this.state === "ready"
          ? makeTransportError("engine_transport_lost", "control connection to runtime closed mid-flight")
          : makeTransportError("engine_transport_unavailable", "control socket closed before hello completed"));
      });
    });
  }

  /** 终局失败单点（幂等）：拒绝在途 open/未决议 connect，fan-out 在册通道，弃 socket，自摘共享表。 */
  private failFatal(err: EngineSdkError): void {
    if (this.state === "lost" || this.state === "disposed") return;
    this.state = "lost";
    this.clearConnectTimers();
    const rejectConnect = this.connectReject;
    this.connectResolve = undefined;
    this.connectReject = undefined;
    rejectConnect?.(err);
    const opens = [...this.pendingOpens.values()];
    this.pendingOpens.clear();
    for (const pending of opens) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    const channels = [...this.channels.values()];
    this.channels.clear();
    this.writeQueue.clear();
    for (const channel of channels) {
      this.completeChannelClose(channel);
      channel.handlers.onError(err);
    }
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      socket.removeAllListeners();
      socket.destroy();
    }
    if (sharedClients.get(this.socketPath) === this) sharedClients.delete(this.socketPath);
  }

  private clearConnectTimers(): void {
    if (this.connectTimer !== undefined) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    if (this.helloTimer !== undefined) {
      clearTimeout(this.helloTimer);
      this.helloTimer = undefined;
    }
  }

  // 接收面

  private ingest(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    this.bufferBytes += chunk.length;
    if (this.bufferBytes > this.maxFrameBytes && !this.buffer.includes("\n")) {
      // partial-line 上限（D8 对称防线）：runtime 侧本应保证不超限，防御性终局。
      this.failFatal(makeTransportError("engine_frame_too_large",
        `incoming control frame exceeded ${this.maxFrameBytes} bytes (partial line)`));
      return;
    }
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) this.handleLine(line);
      if (this.state === "lost" || this.state === "disposed") return;
      newlineIndex = this.buffer.indexOf("\n");
    }
    this.bufferBytes = Buffer.byteLength(this.buffer, "utf8");
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
      this.failFatal(makeTransportError("engine_frame_too_large",
        `incoming control frame exceeded ${this.maxFrameBytes} bytes`));
      return;
    }
    const parsed = parseControlInboundLine(line);
    if ("dropped" in parsed) {
      logger.warn(`[control-client] dropped control line (${parsed.dropped})`);
      return;
    }
    const frame = parsed.frame;
    switch (frame.kind) {
      case "hello_ok":
        this.handleHelloOk(frame);
        return;
      case "hello_reject":
        this.handleHelloReject(frame);
        return;
      case "engine_opened":
        this.handleEngineOpened(frame);
        return;
      case "engine_open_failed":
        this.handleEngineOpenFailed(frame);
        return;
      case "engine_frame":
        this.handleEngineFrame(frame);
        return;
      case "engine_closed":
        this.handleEngineClosed(frame);
        return;
      case "error":
        this.handleErrorFrame(frame);
        return;
      default:
        return;
    }
  }

  private handleHelloOk(frame: ControlInboundHelloOk): void {
    if (this.state !== "hello" || frame.id !== this.helloId) {
      logger.warn("[control-client] dropped hello_ok that does not match the pending hello id");
      return;
    }
    this.clearConnectTimers();
    this.state = "ready";
    const resolve = this.connectResolve;
    this.connectResolve = undefined;
    this.connectReject = undefined;
    resolve?.();
  }

  private handleHelloReject(frame: ControlInboundHelloReject): void {
    const message = frame.message ?? "runtime rejected hello";
    if (frame.reason === "version") {
      // D9：未知 v → engine_protocol_mismatch 偏差码（关闭共享连接、全部 channel 失败、
      // 不自动重试——failFatal 统一 fan-out）。
      this.failFatal(new EngineSdkError(
        "engine_protocol_mismatch",
        message,
        frame.recovery ?? "Upgrade the taiji app (runtime and extension ship together).",
      ));
      return;
    }
    this.failFatal(mapControlError(frame.code ?? "hello_reject", message, frame.recovery));
  }

  private handleEngineOpened(frame: ControlInboundEngineOpened): void {
    const key = String(frame.id ?? "");
    const pending = this.pendingOpens.get(key);
    if (pending === undefined) {
      // 迟到应答（本端已超时/换代）：runtime 侧通道已建但无人认领——补发 engine_close
      // 让 runtime 杀组回收（D4「迟到 engine_opened 丢弃并杀组」的扩展侧定义）。
      if (frame.channelId.length > 0) {
        this.sendRaw({
          v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
          kind: SUBAGENT_CONTROL_FRAME_KINDS.engineClose,
          channelId: frame.channelId,
        });
      }
      logger.warn(`[control-client] dropped late engine_opened (id=${key})`);
      return;
    }
    clearTimeout(pending.timer);
    this.pendingOpens.delete(key);
    if (frame.channelId.length === 0) {
      pending.reject(makeTransportError("engine_transport_unavailable",
        "runtime answered engine_opened without channelId"));
      return;
    }
    this.channels.set(frame.channelId, {
      channelId: frame.channelId,
      handlers: pending.handlers,
      closeRequested: false,
      closePromise: undefined,
      closeResolve: undefined,
      closeTimer: undefined,
    });
    logger.debug(`[control-client] engine channel opened ${frame.channelId} (pid=${String(frame.pid)})`);
    pending.resolve(frame.pid !== undefined ? { channelId: frame.channelId, pid: frame.pid } : { channelId: frame.channelId });
  }

  private handleEngineOpenFailed(frame: ControlInboundEngineOpenFailed): void {
    const key = String(frame.id ?? "");
    const pending = this.pendingOpens.get(key);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pendingOpens.delete(key);
    pending.reject(mapControlError(frame.code, frame.message, frame.recovery));
  }

  private handleEngineFrame(frame: ControlInboundEngineFrame): void {
    const channel = this.channels.get(frame.channelId);
    if (channel === undefined) {
      logger.debug(`[control-client] dropped engine_frame for unknown channel ${frame.channelId}`);
      return;
    }
    channel.handlers.onFrame(frame.line);
  }

  private handleEngineClosed(frame: ControlInboundEngineClosed): void {
    const channel = this.channels.get(frame.channelId);
    if (channel === undefined) {
      logger.debug(`[control-client] dropped engine_closed for unknown channel ${frame.channelId}`);
      return;
    }
    this.channels.delete(frame.channelId);
    if (frame.stderrTail !== undefined) channel.handlers.onStderr?.(frame.stderrTail);
    const info: EngineTransportExitInfo = {
      code: frame.code,
      signal: frame.signal,
      ...(frame.stderrTail !== undefined ? { stderrTail: frame.stderrTail } : {}),
      ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
    };
    this.completeChannelClose(channel);
    channel.handlers.onExit(info);
  }

  private handleErrorFrame(frame: ControlInboundError): void {
    const err = mapControlError(frame.code, frame.message, frame.recovery);
    if (frame.channelId === undefined) {
      // 连接级错误（D8 聚合溢出等）：fan-out 到全部在册通道（socket close 紧随）。
      for (const channel of [...this.channels.values()]) channel.handlers.onError(err);
      return;
    }
    const channel = this.channels.get(frame.channelId);
    if (channel === undefined) {
      logger.debug(`[control-client] dropped error frame for unknown channel ${frame.channelId}`);
      return;
    }
    if (channel.closeRequested && frame.code === "unknown_channel") {
      // 关闭请求的竞态应答（通道已终局）：engine_closed 不会再来，直接放手。
      this.channels.delete(frame.channelId);
      this.completeChannelClose(channel);
      return;
    }
    channel.handlers.onError(err);
  }

  // 发送面

  private sendRaw(frame: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) return false;
    try {
      socket.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch (err) {
      logger.debug(`[control-client] raw write failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private sendCloseFrame(channel: ControlChannelRecord): void {
    const envelope = `${JSON.stringify({ v: SUBAGENT_CONTROL_PROTOCOL_VERSION, kind: SUBAGENT_CONTROL_FRAME_KINDS.engineClose, channelId: channel.channelId })}\n`;
    this.appendEnvelope(channel, envelope, Buffer.byteLength(envelope, "utf8"));
  }

  /** 写或入队（背压队列消费；溢出按裁决关通道/关连接）。 */
  private appendEnvelope(channel: ControlChannelRecord, envelope: string, bytes: number): boolean {
    if (this.state !== "ready") return false;
    const outcome = this.writeQueue.append(this.socket, channel.channelId, envelope, bytes);
    switch (outcome) {
      case "written":
      case "queued":
        return true;
      case "no_socket":
        return false;
      case "connection_overflow":
        this.failFatal(makeTransportError("engine_backpressure_overflow",
          "control connection write queue overflow (aggregate)"));
        return false;
      case "channel_overflow":
        this.terminateOverloadedChannel(channel, makeTransportError("engine_backpressure_overflow",
          `channel write queue overflow for ${channel.channelId}`));
        return false;
      default:
        return false;
    }
  }

  /**
   * 通道级过载终局（D8：不丢帧不静默）：先建关闭登记与 engine_close（让 runtime 杀组），
   * 再以具体码回调宿主（回调可能同步触发宿主 close——关闭 promise 已就绪，避免重入）。
   */
  private terminateOverloadedChannel(channel: ControlChannelRecord, err: EngineSdkError): void {
    logger.warn(`[control-client] channel ${channel.channelId} terminated by transport error: ${err.message}`);
    if (!channel.closeRequested) {
      channel.closeRequested = true;
      this.writeQueue.purge(channel.channelId);
      this.beginCloseWait(channel);
      this.sendCloseFrame(channel);
    }
    channel.handlers.onError(err);
  }

  /** 关闭宽限（engine_close → engine_closed 或有界放弃；只影响本通道）。 */
  private beginCloseWait(channel: ControlChannelRecord): Promise<void> {
    if (channel.closePromise !== undefined) return channel.closePromise;
    channel.closePromise = new Promise<void>((resolve) => {
      channel.closeResolve = resolve;
      channel.closeTimer = setTimeout(() => {
        channel.closeTimer = undefined;
        logger.warn(`[control-client] engine_close grace elapsed, abandoning channel ${channel.channelId}`);
        this.channels.delete(channel.channelId);
        this.writeQueue.purge(channel.channelId);
        resolve();
      }, this.closeGraceMs);
    });
    return channel.closePromise;
  }

  private completeChannelClose(channel: ControlChannelRecord): void {
    if (channel.closeTimer !== undefined) {
      clearTimeout(channel.closeTimer);
      channel.closeTimer = undefined;
    }
    const resolve = channel.closeResolve;
    channel.closeResolve = undefined;
    resolve?.();
  }
}
