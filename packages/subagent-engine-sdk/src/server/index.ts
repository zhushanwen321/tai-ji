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
import { EngineSdkError } from "../protocol/error-codes.ts";
import { toErrorMessage } from "../error-message.ts";

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
