// src/server/index.ts
//
// [§2.11 第一批] 引擎协议服务器的**共享零件**（SDK `./server` 子入口）。
//
// 背景：pi 与 zcode 两个引擎包各持一份 `EngineProtocolServer`（协议主循环 ~60% 逐字
// 同文：帧分类/分发/握手/反向请求等待表/错误帧构造），改一处漏一处即漂移。第一批只
// 收敛**声明与纯函数**部分（零行为面），把打包面（tsup entry + exports 子入口）先
// 打通；后续批次把 `handleFrame` / `dispatch` / `initialize` / 反向请求客户端与
// `settleReverse` 逐步迁入，引擎差异经适配器钩子注入。
//
// 为什么放 SDK 而不是 core：引擎包不得依赖 core（边界守卫
// `.githooks/check-engine-sdk-boundary.mjs` / `scripts/check-engine-package-boundary.mjs`）；
// SDK 是两个引擎唯一的共同依赖。
import { toErrorMessage } from "../error-message.ts";
import { ENGINE_PROTOCOL_VERSION } from "../protocol/engine-protocol.ts";
import type { AgentCallOpts, AgentEvent } from "../protocol/contract-types.ts";
import { EngineSdkError } from "../protocol/error-codes.ts";
import { isResponseFrame, isReverseRequestFrame } from "../protocol/frames.ts";
import type { InitializeParams, InitializeResult, RunContextParams } from "../protocol/methods.ts";
import type { ReverseRequestClock } from "../spawn.ts";

/** 出站帧写入面（各引擎 main.ts 注入 process.stdout；测试注入内存缓冲）。 */
export type FrameWriter = (frame: unknown) => void;

/**
 * 反向请求应答等待缺省上限（ms）——数据面分类 core 侧 10s，两阶段等待放宽一档兜底。
 *
 * 两个引擎此值必须相同：它是「宿主应答迟到多久算超时」的协议面常数，分叉会让同一宿主
 * 在不同引擎下得到不同的超时语义。
 */
export const REVERSE_TIMEOUT_DEFAULT_MS = 60_000;

/** 单个 run 的在途登记（cancel 帧路由 + 事件 seq 计数）。 */
export interface ActiveRun { // oe-exempt:20260930:framework:SDK 协议面契约类型——两引擎服务器共用的在途登记形态（引擎包不得依赖 core，契约落 SDK）
  controller: AbortController;
  seq: number;
}

/**
 * 反向请求在途登记（引擎 → 宿主请求的应答等待项）。
 *
 * `method` 是 pi 引擎的扩展位（settle 时按通道守卫应答形态，如 askUser 的 UI 应答面
 * 检查）；zcode 无该通道守卫，可缺省。
 */
export interface ReversePending { // oe-exempt:20260930:framework:SDK 协议面契约类型——两引擎服务器共用的应答等待项（pi 用 method 扩展位）
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method?: string;
}

/** 协议错误帧载荷（`{code,message,recovery}` 三件套——宿主据此渲染恢复指引）。 */
export interface ProtocolErrorPayload { // oe-exempt:20260930:framework:SDK 协议面契约类型——错误帧三件套载荷（两引擎与宿主消费）
  code: string;
  message: string;
  recovery: string;
}

/**
 * 异常 → 协议错误帧载荷。
 *
 * `EngineSdkError` 自带结构化（`toStructured()`，含引擎侧恢复指引）；其余异常落
 * `engine_run_failed` + 调用方给的恢复指引文案（各引擎的日志位置不同，故 recovery
 * 由调用方注入而不是在这里写死）。
 */
export function toProtocolError(err: unknown, recovery: string): ProtocolErrorPayload {
  if (err instanceof EngineSdkError) return err.toStructured();
  return { code: "engine_run_failed", message: toErrorMessage(err), recovery };
}

// ── [§2.11 第二批] 入站帧循环（两引擎逐字同文部分） ──────────────────────────
//
// 抽的是两引擎 `EngineProtocolServer.handleFrame` 的**分类 + 应答管线**：帧分类、反向
// 请求帧在引擎侧的坏帧应答、正向请求的分发与错误帧回转、无法归类帧的静默忽略。回环里
// 引擎特有的部分（反向应答的两阶段 ack 语义、9 方法表本体）留在各引擎，经
// `FrameLoopContext` 注入。

/** 入站帧分类结果（纯判定、零副作用，便于单测逐分支断言）。 */
export type InboundFrameAction =
  | { kind: "reverse-response"; id: number | string }
  | { kind: "rejected-reverse-request"; method: string }
  | { kind: "request"; id: number; method: string; params: unknown }
  | { kind: "ignore" };

/**
 * 入站帧 → 动作。
 *
 * 判序即协议纪律：①反向应答（对端在等的 host/* 应答）②反向请求（引擎不发 host/*，
 * 属非法入站 → 坏帧应答）③正向请求（`id` 为 number 且 `method` 为 string）④其余静默
 * 忽略（stdout 是独占协议通道，不回显坏帧防对端解析器混乱）。
 */
export function classifyInboundFrame(frame: unknown): InboundFrameAction {
  if (isResponseFrame(frame)) return { kind: "reverse-response", id: frame.id };
  if (isReverseRequestFrame(frame)) return { kind: "rejected-reverse-request", method: String(frame.method) };
  if (
    typeof frame === "object" && frame !== null && "id" in frame && "method" in frame &&
    typeof (frame as { method: unknown }).method === "string"
  ) {
    const { id, method, params } = frame as { id: unknown; method: string; params?: unknown };
    if (typeof id === "number") return { kind: "request", id, method, params };
  }
  return { kind: "ignore" };
}

/** 引擎侧收到反向请求帧时的坏帧应答（`id: 0` = 非请求应答，对端只记坏帧）。 */
export function reverseRequestRejection(method: string): { id: number; error: ProtocolErrorPayload } {
  return {
    id: 0,
    error: {
      code: "engine_protocol_bad_frame",
      message: `unexpected reverse request frame from host: ${method}`,
      recovery: "The engine protocol v1 only carries host/* requests engine→host.",
    },
  };
}

/** 未知协议方法错误（两引擎逐字一致；表查找失败时抛，经 `toError` 转错误帧）。 */
export function unknownMethodError(id: number, method: string): EngineSdkError {
  return new EngineSdkError(
    "engine_protocol_unknown_method",
    `unknown protocol method: ${method} (request id ${id})`,
    "The engine speaks protocol v1; check the installed engine package version vs the host.",
  );
}

/** 帧循环所需的最小上下文（引擎侧实现注入；每引擎构造一次，不在每帧重建）。 */
export interface FrameLoopContext { // oe-exempt:20260930:framework:SDK 协议面契约类型——两引擎帧循环共用的注入面（引擎包不得依赖 core，契约落 SDK）
  /** 出站帧写入面。 */
  write: FrameWriter;
  /** 反向应答帧落地（各引擎的两阶段 ack 语义在此，**刻意不统一**）。 */
  settleReverse(id: number | string, frame: { result?: unknown; error?: unknown }): void;
  /** 正向请求分发（9 方法表；抛出的错误经 `toError` 转错误帧）。 */
  dispatch(id: number, method: string, params: unknown): unknown;
  /** 错误 → 错误帧载荷（各引擎的恢复指引文案不同，故由引擎注入）。 */
  toError(err: unknown): ProtocolErrorPayload;
}

/** 跑一帧（分类 → 落地）。返回值仅用于测试可读性，生产调用方忽略。 */
export function handleInboundFrame(frame: unknown, ctx: FrameLoopContext): InboundFrameAction {
  const action = classifyInboundFrame(frame);
  switch (action.kind) {
    case "reverse-response":
      ctx.settleReverse(action.id, frame as { result?: unknown; error?: unknown });
      return action;
    case "rejected-reverse-request":
      ctx.write(reverseRequestRejection(action.method));
      return action;
    case "request": {
      // 同步抛错也归错误帧：共享层不依赖「dispatch 必是 async」这一前提（同步实现同样合法）。
      let result: unknown;
      try {
        result = ctx.dispatch(action.id, action.method, action.params);
      } catch (err) {
        ctx.write({ id: action.id, error: ctx.toError(err) });
        return action;
      }
      void Promise.resolve(result).then(
        (value) => ctx.write({ id: action.id, result: value }),
        (err) => ctx.write({ id: action.id, error: ctx.toError(err) }),
      );
      return action;
    }
    case "ignore":
      return action;
  }
}

// ── [§2.11 第三批] 反向请求客户端 / 运行事件通知 / 初始化握手（两引擎逐字同文部分） ──
//
// 留在各引擎的部分：应答侧 `settleReverse`（pi 的两阶段 ack + askUI 应答面检查 vs zcode
// ack 即结算，**语义不同不得合并**）、9 方法表本体、`run` 前门。这里只抽发送侧与握手。

/**
 * 反向请求发送（引擎 → 宿主请求的发出与等待登记）。
 *
 * 语义（两条都是踩过坑的）：
 *   - 计时兜底在**发出侧**武装——应答侧不重复武装，两阶段 ack 只延长等待而不重置计时。
 *   - `write` 同步抛错（stdout 关闭等）就地收尾：清 pending + 停 timer + 记 clock 后转
 *     reject；不让异常同步逃出 Promise executor（逃出 = pending 条目与 timer 残留，
 *     且 reject 无人消费时仍是 unhandled rejection 面）。
 */
export interface ReverseRequestSendContext { // oe-exempt:20260930:framework:SDK 协议面契约类型——两引擎反向请求发送侧共用注入面（引擎包不得依赖 core，契约落 SDK）
  write: FrameWriter;
  pending: Map<string, ReversePending>;
  timeoutMs: number;
  clock?: ReverseRequestClock;
  /** 请求 id 分配（各引擎可带自己的前缀与计数器）。 */
  nextId(): string;
  /** 实现特有的 pending 附加字段（pi 记 `method` 供应答面检查用；zcode 不记）。 */
  pendingExtras?(method: string): Partial<ReversePending>;
}

export function sendReverseRequest(
  ctx: ReverseRequestSendContext,
  method: string,
  params: unknown,
): Promise<unknown> {
  const id = ctx.nextId();
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      ctx.pending.delete(id);
      ctx.clock?.settled(id);
      reject(new Error(`reverse request ${method} (${id}) timed out after ${ctx.timeoutMs}ms`));
    }, ctx.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    ctx.pending.set(id, { resolve, reject, timer, ...(ctx.pendingExtras?.(method) ?? {}) });
    ctx.clock?.started(id);
    try {
      ctx.write({ id, method, params });
    } catch (err) {
      ctx.pending.delete(id);
      clearTimeout(timer);
      ctx.clock?.settled(id);
      reject(new Error(`reverse request ${method} (${id}) could not be written: ${toErrorMessage(err)}`));
    }
  });
}

/** 运行事件通知帧（`seq` 单调：无在途登记时取 0，仅作占位而非序号源）。 */
export function writeRunEvent(
  write: FrameWriter,
  activeRuns: Map<string, ActiveRun>,
  runId: string,
  event: AgentEvent,
): void {
  const active = activeRuns.get(runId);
  const seq = active !== undefined ? ++active.seq : 0;
  write({ method: "event", params: { runId, seq, event } });
}

/** 初始化握手所需的最小上下文（版本协商共用；引擎实例面与适配器版本由引擎注入）。 */
export interface InitializeHandshakeContext { // oe-exempt:20260930:framework:SDK 协议面契约类型——两引擎初始化握手共用注入面（引擎包不得依赖 core，契约落 SDK）
  /** 引擎实例 id（`EnginePort.id`）。 */
  engineId: string;
  /** 引擎包自己的适配器版本常量（各包独立版本号）。 */
  adapterVersion: string;
  /** 能力位（`EnginePort.capabilities()` 的返回值）。 */
  capabilities: InitializeResult["capabilities"];
  /** 可用模型列表；`null` = 本引擎不提供（应答里不带 models 字段）。 */
  listModels(): Array<{ id: string }> | null;
}

/**
 * 初始化握手：协议版本协商（越界 → `engine_protocol_mismatch`）+ 能力与模型应答。
 *
 * 版本比对用严格相等：v1 系列内仍以 `ENGINE_PROTOCOL_VERSION` 为准（宿主与引擎同批发布），
 * 放宽比对会让「装了旧引擎」静默通过，后续方法缺失才炸在更远处。
 */
export function initializeEngine(
  params: InitializeParams,
  ctx: InitializeHandshakeContext,
): InitializeResult {
  if (params?.protocolVersion !== ENGINE_PROTOCOL_VERSION) {
    throw new EngineSdkError(
      "engine_protocol_mismatch",
      `host protocol version ${String(params?.protocolVersion)} is not compatible with engine protocol v${ENGINE_PROTOCOL_VERSION}`,
      `Upgrade the engine package or the host so both speak protocol v${ENGINE_PROTOCOL_VERSION}.`,
    );
  }
  const models = ctx.listModels();
  return {
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    engineId: ctx.engineId,
    engineVersion: ctx.adapterVersion,
    adapterVersion: ctx.adapterVersion,
    capabilities: ctx.capabilities,
    ...(models !== null ? { models: models.map((m) => ({ id: m.id })) } : {}),
  };
}

// ── [§2.11 第四批] run 前门的纯逻辑部分（其余差异经核实为引擎固有，不抽） ────────
//
// `run` 方法两侧的**顺序骨架**（未初始化拒绝 → 建 controller → 登记在途 → 组 fullTask
// → engine.run → 拆 handle → finally 注销）看着同形，但中段被引擎固有逻辑切开：pi 有
// resume 帧断言 + `bindAskUser` 绑定/解绑 + 自己的 ctx 组装，zcode 的 ctx 是**内联**构造
// （无 `buildRunContext` 方法，含 ctxModel 解析 / stream / onHandleReady 三个反向通道）。
// 把这些差异用 5 个钩子包成一个 `dispatchRun` 会得到一个全是 unknown 接缝的配置对象，
// 净收益为负——故 run 段**只抽两处纯逻辑**，其余按引擎差异保留（结论登记见
// docs/todo/subagent-workflow-issues.md §2.11）。

/** run 前门未初始化拒绝（两引擎逐字一致的协议错误）。 */
export function notInitializedError(): EngineSdkError {
  return new EngineSdkError(
    "engine_protocol_not_initialized",
    "run before initialize is a protocol violation",
    "The host must complete the initialize handshake before dispatching runs.",
  );
}

/**
 * 协议 `task` 子集 + `ctx` 还原 = 本地全量 `AgentCallOpts`（与宿主侧
 * `RemoteEngine.toSdkTaskSubset` 镜像）。
 *
 * 还原纪律：`model` / `cwd` **有值才写**（wire additive 语义）——写 `undefined` 会覆盖
 * 引擎侧缺省值，worktree 隔离与模型选择都会静默走错。
 */
export function assembleFullTask(task: AgentCallOpts, ctx: RunContextParams): AgentCallOpts {
  return {
    ...task,
    ...(ctx.model !== undefined ? { model: ctx.model } : {}),
    ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
  };
}
