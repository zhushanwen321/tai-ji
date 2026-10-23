// src/execution/engine/client/transport/control-shared.ts
//
// [M3] RuntimeControlClient 共享件（u-m3-rt-transport）：control 时间窗/上限常量、
// 通道回调/归属/选项类型、runtime 裁决 code → SDK 错误码映射。control-client.ts（连接
// 与通道生命周期）与 runtime.ts（EngineTransport 实现）共用；不 import 二者（无环）。
//
// 错误映射规则（D10）：SDK transport 族与已知 engine_ 前缀码原样透传；runtime 侧裁决
// 字面按语义分流到与 local transport 同型的失败面：资源耗尽（channel_limit / 写队列
// 溢出）→ engine_backpressure_overflow（channel_limit 在 detail 显式标注「通道数上限，
// 非字节背压」）；归属键不可用（session）→ engine_transport_unavailable；启动裁决失败
// （invalid_launch / spawn_failed）→ engine_crashed（与 local 启动解析错误同型，
// EngineClient.connectOnce 保留本函数写入的 controlCode 标记与 runtime frame 的
// recovery）；unknown_channel（非关闭竞态）→ 原 code 透传（通道终局，不是连接丢失——
// D10 的 engine_transport_lost 只表示 control 连接中途丢失）。宿主只认 SDK 词表。

import { ENGINE_TRANSPORT_ERROR_RECOVERY, EngineSdkError } from "@zhushanwen/subagent-engine-sdk";

import { GLOBAL_SLOT_KEYS } from "../../../../shared/global-slots.ts";
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

/** engine_open 归属键（rootSessionId 必填非空；parentRecordId/depth/recordId 可选携带）。 */
export type ControlChannelIdentity = {
  rootSessionId: string;
  parentRecordId?: string;
  depth?: number;
  /**
   * [S-10] 本通道的自申报 record id（launch.recordId wire 扩展，channel 树父链挂点）。
   * 值源 = run 的 record 锚（ctx.resume?.recordId ?? ctx.taskId）；probe 先行建立的
   * 通道缺席（无树挂点，收割依赖结构性兜底）。见 types.ts EngineLaunchSpec.recordId。
   */
  recordId?: string;
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
  /**
   * 连接绑定的根 session id（共享复用键的组成部分，R2A-N1）：runtime 在一个连接上以
   * 首个 engine_open 固定 conn.rootSessionId，后续不同根的 open 一律 `session` 拒绝——
   * 因此「同 socket 一条连接」的共享单位必须细化到 (socketPath, rootSessionId)。
   * 缺省（直接构造，不经 acquireRuntimeControlClient）= 不登记共享表。
   */
  rootSessionId?: string;
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

/**
 * 共享键（(socketPath, rootSessionId)；根缺失 = 空串桶）。[R2A-N1] 根必须参与复用键：
 * runtime 一条连接只服务一个根（首 open 定根、无重置点），见 control-client 共享表注释。
 */
export function controlClientKey(socketPath: string, rootSessionId: string | undefined): string {
  return `${socketPath}\u0000${rootSessionId ?? ""}`;
}

/**
 * [C-state-20] control 客户端进程级共享表的槽访问（S-7；spawned-children.ts 同款
 * globalThis[Symbol.for] 槽纪律）：workspace 源码 / npm dist / pi jiti 三实例化通道下
 * 模块级 Map 会分裂成两份，双包实例共存时每个 (socket, root) 各起一条连接——复用
 * 语义（controlClientKey 注释）要求跨实例共享同一张表。值类型在消费侧
 * （control-client.ts）收窄为 Map of RuntimeControlClient。
 */
const SHARED_CLIENTS_SLOT_KEY = Symbol.for(GLOBAL_SLOT_KEYS.runtimeControlClients);

export function sharedControlClientsSlot<T>(): Map<string, T> {
  let slot = Reflect.get(globalThis, SHARED_CLIENTS_SLOT_KEY) as Map<string, T> | undefined;
  if (slot === undefined) {
    slot = new Map<string, T>();
    Reflect.set(globalThis, SHARED_CLIENTS_SLOT_KEY, slot);
  }
  return slot;
}

/** runtime 裁决字面 → SDK 错误码收敛表（按 D10 语义分流；唯一收敛点）。 */
const CONTROL_CODE_TO_TRANSPORT_CODE: Record<string, string> = {
  engine_open_timeout: "engine_open_timeout",
  engine_frame_too_large: "engine_frame_too_large",
  engine_backpressure_overflow: "engine_backpressure_overflow",
  // 连接级 channel 上限与写队列溢出同属资源耗尽面（D8：显式失败、不丢帧）；
  // 具体面（通道数 vs 字节背压）由 mapControlError 在 detail 显式区分。
  channel_limit: "engine_backpressure_overflow",
  // 归属键不可用（root session 与连接绑定不一致）：连接/hello 级失败面。
  session: "engine_transport_unavailable",
  // 启动裁决失败：与 local transport 的启动错误同型（connectOnce 包装 engine_crashed）。
  // controlCode 标记经 data 透传——connectOnce 据此保留 runtime frame 的 recovery。
  invalid_launch: "engine_crashed",
  spawn_failed: "engine_crashed",
  // 请求 id 复用是宿主侧协议违规：按不可用终局（不重试），recovery 用 runtime 帧文案。
  duplicate: "engine_transport_unavailable",
  // 通道已不存在（非关闭竞态）= 通道终局，**不是**连接丢失：D10 的
  // engine_transport_lost 专指 control 连接中途丢失，通道级 unknown_channel 时连接
  // 仍然存活——原 code 透传，避免把排障方向误导到连接故障面。
  unknown_channel: "unknown_channel",
};

/** 通道终局（unknown_channel 透传）的兜底 recovery（runtime 帧未携带时）。 */
const CHANNEL_TERMINAL_RECOVERY =
  "The engine channel no longer exists on the runtime (already closed or unknown id). "
  + "The control connection itself is still alive — re-run the task and the host opens a new channel.";

/** engine_crashed 收敛面缺省 recovery（runtime 帧未携带时使用；定位指向 runtime 日志）。 */
const CRASHED_CONTROL_RECOVERY =
  "The runtime failed to launch the engine (see the control code in the detail). "
  + "Inspect the runtime log, then re-run the task.";

/** engine_open_failed / error 帧的 code → EngineSdkError（见文件头映射规则）。 */
export function mapControlError(code: string, message: string, recovery?: string): EngineSdkError {
  const mapped = CONTROL_CODE_TO_TRANSPORT_CODE[code]
    ?? (code.startsWith("engine_") ? code : "engine_transport_unavailable");
  // channel_limit 与字节背压同属资源耗尽码面（engine_backpressure_overflow），但成因
  // 与处置不同（通道数上限 vs 写队列积压）——detail 显式标注，按 code 搜索不会误归因。
  const detail = mapped === code
    ? message
    : code === "channel_limit"
      ? `${message} (control code: channel_limit — channel-count limit, not write-queue byte backpressure)`
      : `${message} (control code: ${code})`;
  const recoveryText = recovery !== undefined && recovery.length > 0
    ? recovery
    : mapped === "engine_crashed"
      ? CRASHED_CONTROL_RECOVERY
      : mapped === "unknown_channel"
        ? CHANNEL_TERMINAL_RECOVERY
        : (ENGINE_TRANSPORT_ERROR_RECOVERY as Record<string, string>)[mapped]
          ?? ENGINE_TRANSPORT_ERROR_RECOVERY.engine_transport_unavailable;
  // controlCode 标记 = 「本错误由 runtime 帧裁决」的机器可读面（connectOnce 用它
  // 区分「runtime 启动裁决失败映射的 engine_crashed」与「宿主侧兜底包装」，保留
  // runtime 帧的专用 recovery，R2A-N3③）。
  return new EngineSdkError(mapped, detail, recoveryText, { controlCode: code });
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
