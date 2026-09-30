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
import { EngineSdkError } from "../protocol/error-codes.ts";
import { isResponseFrame, isReverseRequestFrame } from "../protocol/frames.ts";

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
