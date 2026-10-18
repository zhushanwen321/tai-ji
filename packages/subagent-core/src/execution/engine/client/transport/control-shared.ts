// src/execution/engine/client/transport/control-shared.ts
//
// [M3] RuntimeControlClient 共享件（u-m3-rt-transport）：control 时间窗/上限常量、
// 通道回调/归属/选项类型、runtime 裁决 code → SDK 错误码映射。control-client.ts（连接
// 与通道生命周期）与 runtime.ts（EngineTransport 实现）共用；不 import 二者（无环）。
//
// 错误映射规则（D10）：SDK transport 族与已知 engine_ 前缀码原样透传；runtime 侧裁决
// 字面（session/channel_limit/duplicate/invalid_launch/spawn_failed/unknown_channel）
// 收敛为 transport 族错误码——宿主只认 SDK 词表。

import { ENGINE_TRANSPORT_ERROR_RECOVERY, EngineSdkError } from "@zhushanwen/subagent-engine-sdk";

import type { EngineTransportExitInfo } from "./types.ts";

// ── 时间窗与上限（设计 §3.3 D8：三个独立窗口 + 双上限；客户端侧与 runtime 侧各自独立
//    有界，同一 wire 语义。单字面量形态：eslint no-magic-numbers 只豁免 VariableDeclarator
//    直挂字面量，表达式换算「32 * 1024 * 1024」会触警）──────────────────────────
export const CONTROL_CONNECT_TIMEOUT_MS = 5_000;
export const CONTROL_HELLO_TIMEOUT_MS = 10_000;
export const ENGINE_OPEN_TIMEOUT_MS = 10_000;
export const CONTROL_CLOSE_GRACE_MS = 3_000;
/** 32 MiB：control 信封单帧上限（engine_frame.line 是其中的字符串载荷）。 */
export const CONTROL_MAX_FRAME_BYTES = 33_554_432;
/** 32 MiB / 4096 帧：每 channel 单方向待写队列上限。 */
export const CHANNEL_QUEUE_MAX_BYTES = 33_554_432;
export const CHANNEL_QUEUE_MAX_FRAMES = 4_096;
/** 256 MiB：每连接每方向全部 channel 待写字节总和上限（聚合上界）。 */
export const CONNECTION_QUEUE_MAX_BYTES = 268_435_456;

/** 通道回调面（RuntimeEngineTransport 消费；onStderr 收到 engine_closed 的 stderrTail）。 */
export type ControlChannelHandlers = {
  onFrame: (line: string) => void;
  onExit: (info: EngineTransportExitInfo) => void;
  onError: (err: EngineSdkError) => void;
  onStderr?: (chunk: string) => void;
};

/** engine_open 归属键（rootSessionId 必填非空；parentRecordId/depth 仅嵌套携带）。 */
export type ControlChannelIdentity = {
  rootSessionId: string;
  parentRecordId?: string;
  depth?: number;
};

/** openChannel 结果（channelId 是 control 层内部键，RuntimeEngineTransport 不外泄）。 */
export type ControlChannelOpenResult = {
  channelId: string;
  pid?: number;
};

/** RuntimeControlClient 构造参数（时间窗/上限可注入小值，测试用）。 */
export type RuntimeControlClientOptions = {
  socketPath: string;
  hostKind: string;
  connectTimeoutMs?: number;
  helloTimeoutMs?: number;
  openTimeoutMs?: number;
  closeGraceMs?: number;
  maxFrameBytes?: number;
  channelQueueMaxBytes?: number;
  channelQueueMaxFrames?: number;
  connectionQueueMaxBytes?: number;
};

/** SDK transport 错误构造（recovery 从 SDK 单源取；五码 + 透传码共用）。 */
export function makeTransportError(code: string, detail: string): EngineSdkError {
  const recovery = (ENGINE_TRANSPORT_ERROR_RECOVERY as Record<string, string>)[code]
    ?? ENGINE_TRANSPORT_ERROR_RECOVERY.engine_transport_unavailable;
  return new EngineSdkError(code, detail, recovery);
}

/** runtime 裁决字面 → SDK 传输码收敛表（SDK 词表未收录 control 帧 code；唯一收敛点）。 */
const CONTROL_CODE_TO_TRANSPORT_CODE: Record<string, string> = {
  engine_open_timeout: "engine_open_timeout",
  engine_frame_too_large: "engine_frame_too_large",
  engine_backpressure_overflow: "engine_backpressure_overflow",
  unknown_channel: "engine_transport_lost",
};

/** engine_open_failed / error 帧的 code → EngineSdkError（见文件头映射规则）。 */
export function mapControlError(code: string, message: string, recovery?: string): EngineSdkError {
  const mapped = CONTROL_CODE_TO_TRANSPORT_CODE[code]
    ?? (code.startsWith("engine_") ? code : "engine_transport_unavailable");
  const detail = mapped === code ? message : `${message} (control code: ${code})`;
  const recoveryText = recovery !== undefined && recovery.length > 0
    ? recovery
    : (ENGINE_TRANSPORT_ERROR_RECOVERY as Record<string, string>)[mapped]
      ?? ENGINE_TRANSPORT_ERROR_RECOVERY.engine_transport_unavailable;
  return new EngineSdkError(mapped, detail, recoveryText);
}

/** unknown → 普通对象收窄（外部帧解析入口 guard）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 在途 engine_open（id 关联；超时/连接死亡时以具体码 reject）。 */
export type ControlPendingOpen = {
  id: number;
  handlers: ControlChannelHandlers;
  resolve: (result: ControlChannelOpenResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/** 在册引擎通道（engine_opened 建，engine_closed/close 宽限终点删）。 */
export type ControlChannelRecord = {
  channelId: string;
  handlers: ControlChannelHandlers;
  closeRequested: boolean;
  closePromise: Promise<void> | undefined;
  closeResolve: (() => void) | undefined;
  closeTimer: NodeJS.Timeout | undefined;
};

/** 客户端连接状态（idle → connecting → hello → ready；lost/disposed 终态）。 */
export type ControlClientState =
  | "idle"
  | "connecting"
  | "hello"
  | "ready"
  | "lost"
  | "disposed";
