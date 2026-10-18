// src/execution/engine/client/transport/runtime.ts
//
// [M3] RuntimeEngineTransport：EngineTransport 契约的 runtime 实现（设计
// relay-spawn-transport §3.3 D4/D5、§3.4.3；u-m3-rt-transport）。托管态下引擎
// 进程由 runtime spawn（control server），extension 不再持有 ChildProcess：
// open(spec) = 「取进程级共享 RuntimeControlClient（一个主 pi 一条连接）→
// engine_open（rootSessionId/parentRecordId/depth 归属）→ engine_opened（pid）」；
// writeFrame = 包 engine_frame 信封；onFrame = 解包 engine_frame.line；onExit =
// engine_closed 映射（code/signal/reason/stderrTail）。channelId 是本实现内部键，
// 不外泄给 EngineClient（types.ts 契约边界）。
//
// 归属键来源（D4 env × spawn 点矩阵 / D5）：socket = CONTROL_ENV_SOCKET；rootSessionId
// 优先 spec.rootSessionId（宿主 run ctx 透传时），否则 control env 的
// CONTROL_ENV_ROOT_SESSION_ID（runtime 注入全链同值），再否则身份 env 的
// PI_SUBAGENT_ROOT_SESSION_ID；parentRecordId/depth 仅嵌套携带（来自本进程身份 env：
// PI_SUBAGENT_SELF_RECORD_ID / PI_SUBAGENT_DEPTH——引擎通道的父挂点）。socket 激活但
// root session 缺失 → 显式 engine_transport_unavailable（不发畸形帧等超时）。
//
// 进程面（pidfile/reaper）在本实现整体缺席（EngineClient 按 localTransport 实例有无
// 编排）——引擎进程归 runtime 所有（D7：runtime 组杀 + 连接关闭 fan-out）。

import {
  CONTROL_ENV_ROOT_SESSION_ID,
  CONTROL_ENV_SOCKET,
  EngineSdkError,
  SUBAGENT_IDENTITY_ENV,
} from "@zhushanwen/subagent-engine-sdk";

import { acquireRuntimeControlClient } from "./control-client.ts";
import {
  makeTransportError,
  type ControlChannelIdentity,
} from "./control-shared.ts";
import type {
  EngineLaunchSpec,
  EngineTransport,
  EngineTransportExitInfo,
  EngineTransportOpenResult,
} from "./types.ts";

/** RuntimeEngineTransport 构造参数（时间窗/上限透传共享客户端；测试注入小值）。 */
export type RuntimeEngineTransportOptions = {
  /** 引擎 id（诊断日志）。 */
  readonly engineId: string;
  /** 宿主种类（hello 帧 hostKind）。 */
  readonly hostKind: string;
  /** env 基座（control/身份键解析，缺省 = process.env）。 */
  readonly baseEnv?: Record<string, string | undefined>;
  /** stderr 出口（engine_closed 的 stderrTail 回宿主环形缓冲；缺省丢弃）。 */
  readonly onStderr?: (chunk: string) => void;
  readonly connectTimeoutMs?: number;
  readonly helloTimeoutMs?: number;
  readonly openTimeoutMs?: number;
  readonly closeGraceMs?: number;
  readonly maxFrameBytes?: number;
  readonly channelQueueMaxBytes?: number;
  readonly channelQueueMaxFrames?: number;
};

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value;
  }
  return "";
}

function parseDepth(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * runtime 引擎通道（EngineTransport 的托管实现）。每代引擎连接一个实例
 * （EngineClient 每次 connectOnce 新建）；共享 RuntimeControlClient 按引用计数回收。
 */
export class RuntimeEngineTransport implements EngineTransport {
  private readonly opts: RuntimeEngineTransportOptions;
  private client: ReturnType<typeof acquireRuntimeControlClient> | undefined;
  private channelId: string | undefined;
  private released = false;
  private exitNotified = false;
  private closePromise: Promise<void> | undefined;
  private readonly frameHandlers: Array<(line: string) => void> = [];
  private readonly exitHandlers: Array<(info: EngineTransportExitInfo) => void> = [];
  private readonly errorHandlers: Array<(err: EngineSdkError) => void> = [];

  constructor(opts: RuntimeEngineTransportOptions) {
    this.opts = opts;
  }

  /**
   * 打开引擎通道：取共享连接（缺失/hello 时建立）→ engine_open → engine_opened。
   * 连接失败/hello 被拒/归属键缺失 → 对应 transport 错误码上抛（不静默回落 local）。
   */
  async open(spec: EngineLaunchSpec): Promise<EngineTransportOpenResult> {
    const env = this.opts.baseEnv ?? process.env;
    const socketPath = firstNonEmpty(env[CONTROL_ENV_SOCKET]);
    if (socketPath.length === 0) {
      throw makeTransportError("engine_transport_unavailable",
        `engine "${this.opts.engineId}" has no control socket (${CONTROL_ENV_SOCKET} is empty)`);
    }
    const rootSessionId = firstNonEmpty(
      spec.rootSessionId,
      env[CONTROL_ENV_ROOT_SESSION_ID],
      env[SUBAGENT_IDENTITY_ENV.rootSessionId],
    );
    if (rootSessionId.length === 0) {
      throw makeTransportError("engine_transport_unavailable",
        `engine "${this.opts.engineId}" cannot open a runtime channel: ${CONTROL_ENV_ROOT_SESSION_ID} is not set`);
    }
    const parentRecordId = spec.parentRecordId ?? firstNonEmpty(env[SUBAGENT_IDENTITY_ENV.selfRecordId]);
    const depth = spec.depth ?? parseDepth(env[SUBAGENT_IDENTITY_ENV.depth]);
    const identity: ControlChannelIdentity = {
      rootSessionId,
      ...(parentRecordId.length > 0 ? { parentRecordId } : {}),
      ...(depth !== undefined ? { depth } : {}),
    };

    const client = acquireRuntimeControlClient({
      socketPath,
      hostKind: this.opts.hostKind,
      ...(this.opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: this.opts.connectTimeoutMs } : {}),
      ...(this.opts.helloTimeoutMs !== undefined ? { helloTimeoutMs: this.opts.helloTimeoutMs } : {}),
      ...(this.opts.openTimeoutMs !== undefined ? { openTimeoutMs: this.opts.openTimeoutMs } : {}),
      ...(this.opts.closeGraceMs !== undefined ? { closeGraceMs: this.opts.closeGraceMs } : {}),
      ...(this.opts.maxFrameBytes !== undefined ? { maxFrameBytes: this.opts.maxFrameBytes } : {}),
      ...(this.opts.channelQueueMaxBytes !== undefined
        ? { channelQueueMaxBytes: this.opts.channelQueueMaxBytes } : {}),
      ...(this.opts.channelQueueMaxFrames !== undefined
        ? { channelQueueMaxFrames: this.opts.channelQueueMaxFrames } : {}),
    });
    this.client = client;
    try {
      const result = await client.openChannel(spec, identity, {
        onFrame: (line) => this.dispatchFrame(line),
        onExit: (info) => this.handleChannelExit(info),
        onError: (err) => this.dispatchTransportError(err),
        onStderr: (chunk) => this.opts.onStderr?.(chunk),
      });
      this.channelId = result.channelId;
      return result.pid !== undefined ? { pid: result.pid } : {};
    } catch (err) {
      this.releaseClient();
      throw err;
    }
  }

  /** 写一行 engine-protocol 帧（包 engine_frame）；false = 未受理（通道死/超限/溢出）。 */
  writeFrame(line: string): boolean {
    const client = this.client;
    const channelId = this.channelId;
    if (client === undefined || channelId === undefined) return false;
    return client.writeFrame(channelId, line);
  }

  onFrame(handler: (line: string) => void): void {
    this.frameHandlers.push(handler);
  }

  onExit(handler: (info: EngineTransportExitInfo) => void): void {
    this.exitHandlers.push(handler);
  }

  /**
   * 订阅传输面错误（control 连接死亡 / 通道级 error 帧；types.ts 契约的可选成员）：
   * EngineClient 以具体码 reject 在途请求并标记不可用（D5/D8，不包装 engine_crashed）。
   */
  onTransportError(handler: (err: EngineSdkError) => void): void {
    this.errorHandlers.push(handler);
  }

  /**
   * 优雅关闭本通道：engine_close → engine_closed 或 closeGraceMs 宽限（只放弃该通道，
   * 不关共享连接）。已终局/从未 open 的调用幂等 resolve（不重复发帧）。
   */
  async close(reason = "engine channel close"): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const client = this.client;
    const channelId = this.channelId;
    if (client === undefined || channelId === undefined) {
      this.releaseClient();
      return;
    }
    const pending = client.closeChannel(channelId, reason);
    this.closePromise = pending.finally(() => {
      this.releaseClient();
    });
    return this.closePromise;
  }

  // ── 内部 ───────────────────────────────────────────────────────────────────

  private handleChannelExit(info: EngineTransportExitInfo): void {
    this.channelId = undefined;
    this.releaseClient();
    if (this.exitNotified) return;
    this.exitNotified = true;
    for (const handler of [...this.exitHandlers]) handler(info);
  }

  private dispatchFrame(line: string): void {
    for (const handler of this.frameHandlers) handler(line);
  }

  private dispatchTransportError(err: EngineSdkError): void {
    for (const handler of [...this.errorHandlers]) handler(err);
  }

  private releaseClient(): void {
    if (this.released) return;
    this.released = true;
    this.client?.release();
  }
}
