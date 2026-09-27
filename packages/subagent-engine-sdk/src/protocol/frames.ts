// src/protocol/frames.ts
//
// 帧型四类（传输 = stdio NDJSON，每行一个 JSON 对象）。设计权威源：
// 设计 §3.3 帧型 + impl-plan §2.1「帧型四类」。
//
//   ① 请求（core → 引擎）        { id, method, params }
//   ② 应答（引擎 → core）        { id, result } | { id, error }
//   ③ 通知（引擎 → core，无 id） { method: "event", params }
//   ④ 反向请求（引擎 → core）    { id, method: "host/*", params }（必须应答）
//
// id 形态：正向请求 id = number（core 单调计数）；反向请求 id = string（引擎侧命名，
// 如 "rev-1"）；应答 id = 请求或反向请求 id 原样回传（number | string）。
// 实现面（行解析、请求关联、反向路由）归 W2 EngineClient；本文件只定帧型与判别。

import type { AgentEvent } from "./contract-types.ts";

/** 协议错误对象（error 帧载荷与反向请求错误应答共用形态）。 */
export interface ProtocolError {
  /** 错误码（error-codes.ts 词表 + 其余 engine_* 引擎自报透传）。 */
  code: string;
  /** 人类可读详情。 */
  message: string;
  /** 恢复指引：指向具体下一步（命令 / 配置路径 / 升级动作），非安慰性文案。 */
  recovery: string;
  /** 结构化附参（如 engine_protocol_mismatch 的双方版本）。 */
  data?: Record<string, unknown>;
}

// ============================================================
// ① 请求（core → 引擎）
// ============================================================

export interface RequestFrame {
  id: number;
  method: string;
  params: unknown;
}

// ============================================================
// ② 应答（引擎 → core）
// ============================================================

export interface SuccessResponseFrame {
  id: number | string;
  result: unknown;
}

export interface ErrorResponseFrame {
  id: number | string;
  error: ProtocolError;
}

export type ResponseFrame = SuccessResponseFrame | ErrorResponseFrame;

// ============================================================
// ③ 通知（引擎 → core，无 id）
// ============================================================

/** event 通知载荷：runId 关联在途 run；seq 单调递增（基线①结构等价断言对象）。 */
export interface EventNotificationParams {
  runId: string;
  seq: number;
  event: AgentEvent;
}

export interface NotificationFrame {
  method: "event";
  params: EventNotificationParams;
}

// ============================================================
// ④ 反向请求（引擎 → core，必须应答）
// ============================================================

export interface ReverseRequestFrame {
  id: string;
  method: string;
  params: unknown;
}

/** 反向请求的应答（core → 引擎，沿 ResponseFrame 通道回传；id = 反向请求 id 原样）。 */
export type ReverseResponseResult =
  /** 数据面类：处理确认。 */
  | { ok: true }
  /** 人机交互类（askUser）两阶段第一阶段：已受理，结果异步到达（R9-2）。 */
  | { ack: true }
  /** 未实现的交互能力（设计：未实现回 unsupported，引擎自行降级）。 */
  | { unsupported: true };

// ============================================================
// 判别守卫（W2 行解析器消费；结构判定，不抛错）
// ============================================================

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** ① 请求：有数字 id + method + params，且无 result/error（与②应答区分）。 */
export function isRequestFrame(frame: unknown): frame is RequestFrame {
  return (
    isRecord(frame) &&
    typeof frame.id === "number" &&
    typeof frame.method === "string" &&
    "params" in frame &&
    !("result" in frame) &&
    !("error" in frame)
  );
}

/** ② 应答：有 id（number|string）且 result/error 二选一。 */
export function isResponseFrame(frame: unknown): frame is ResponseFrame {
  if (!isRecord(frame) || !("id" in frame)) return false;
  const idOk = typeof frame.id === "number" || typeof frame.id === "string";
  if (!idOk) return false;
  const hasResult = "result" in frame;
  const hasError = "error" in frame;
  return hasResult !== hasError;
}

/** ③ 通知：无 id，method === "event"，params 含 runId/seq/event。 */
export function isNotificationFrame(frame: unknown): frame is NotificationFrame {
  return (
    isRecord(frame) &&
    !("id" in frame) &&
    frame.method === "event" &&
    isRecord(frame.params) &&
    typeof frame.params.runId === "string" &&
    typeof frame.params.seq === "number" &&
    isRecord(frame.params.event) &&
    typeof frame.params.event.type === "string"
  );
}

/** ④ 反向请求：有字符串 id + host/* method + params（与①的区别 = id 形态与 method 前缀）。 */
export function isReverseRequestFrame(frame: unknown): frame is ReverseRequestFrame {
  return (
    isRecord(frame) &&
    typeof frame.id === "string" &&
    typeof frame.method === "string" &&
    frame.method.startsWith("host/") &&
    "params" in frame
  );
}
