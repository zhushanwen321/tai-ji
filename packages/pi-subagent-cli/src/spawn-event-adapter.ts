// src/spawn-event-adapter.ts
//
// pi 子进程 stdout JSON 事件流的解析器（W7 迁 pi 包，core engines/pi/
// spawn-event-adapter.ts 等价副本；SdkEvent/错误格式化改包内形态）。
//
// RPC mode 不向 stdout 输出 header 行（只有 json/print mode 才输出），故
// spawn-runner 额外通过 get_state RPC 握手回填 sessionFile/sessionId。两种
// stdout 行形态本模块统一解析：
//   1. header 行（json/print mode 首行）：{ type: "session", id, timestamp, cwd, ... }
//   2. 事件行：{ type: "tool_execution_start" | "message_end" | ..., ... }
//
// 本模块只做「行 → 分类事件对象」的纯解析，不做累积/翻译（那是 spawn-runner 的职责）。
//
// 容错原则：stdout 是流式输出，任何单行解析失败都不应中断进程。

import * as fs from "node:fs";
import * as path from "node:path";

import type { ToolCallResult } from "@zhushanwen/subagent-engine-sdk";

import { toErrorMessage } from "./error-message.ts";

/**
 * pi stdout 的 SdkEvent 形态（core execution/assembly/types.ts SdkEvent 的结构子集——
 * spawn-runner 的翻译 switch 只消费这些字段；SDK 契约类型未收该类型，包内自持）。
 */
export interface SdkEvent {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: ToolCallResult;
  isError?: boolean;
  message?: {
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total: number };
    };
    stopReason?: string;
    errorMessage?: string;
  };
  reason?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  [key: string]: unknown;
}

/** pi stdout header 行（session 元信息）。type 固定为 "session"。 */
export interface SpawnSessionHeader {
  readonly type: "session";
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly parentSession?: string;
  readonly version?: number;
}

/** Pi 原生 extension_ui_request 的方法特定字段（按 method 平铺）。
 *  与 Pi rpc-types.ts L230-265 的 RpcExtensionUIRequest 1:1 对应。 */
export type ExtensionUiRequest =
  | { method: "select"; title: string; options: string[]; timeout?: number }
  | { method: "confirm"; title: string; message: string; timeout?: number }
  | { method: "input"; title: string; placeholder?: string; timeout?: number }
  | { method: "editor"; title: string; prefill?: string }
  | { method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { method: "setStatus"; statusKey: string; statusText: string | undefined }
  | {
      method: "setWidget";
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { method: "setTitle"; title: string }
  | { method: "set_editor_text"; text: string }
  // 未知 method fallback：保留原始字段，避免协议演进时丢信息
  | { method: string; raw: Record<string, unknown> };

/** 解析后的 extension_ui_request 顶层形状（type 守卫用）。 */
interface ExtensionUiRequestEnvelope {
  type: "extension_ui_request";
  id: string;
  method: string;
  [key: string]: unknown;
}

/** Pi 原生 RPC response 顶层形状（type 守卫用）。 */
interface RpcResponseEnvelope {
  type: "response";
  command: string;
  success: boolean;
  id?: string;
  data?: unknown;
  error?: string;
  [key: string]: unknown;
}

/** parseSpawnLine 的分类结果。 */
export type ParsedSpawnLine =
  | { kind: "header"; header: SpawnSessionHeader }
  | { kind: "event"; event: SdkEvent }
  | {
      kind: "response";
      id?: string;
      command: string;
      success: boolean;
      data?: unknown;
      error?: string;
    }
  | { kind: "extension_ui_request"; id: string; request: ExtensionUiRequest }
  | { kind: "invalid"; raw: string; error: string };

/**
 * 判断解析出的 JSON 是否为 header 行（type === "session"）。
 * 校验所有必需字段（id/timestamp/cwd），缺任一则不收窄。
 */
function isSessionHeader(obj: unknown): obj is SpawnSessionHeader {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    r.type === "session" &&
    typeof r.id === "string" &&
    typeof r.timestamp === "string" &&
    typeof r.cwd === "string"
  );
}

/** 判断解析出的 JSON 是否为 Pi 原生 RPC response（{type:"response",command,success}）。 */
function isRpcResponse(obj: unknown): obj is RpcResponseEnvelope {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    r.type === "response" &&
    typeof r.command === "string" &&
    typeof r.success === "boolean"
  );
}

/**
 * 判断解析出的 JSON 是否为 Pi 原生 extension_ui_request
 * （平铺格式 {type:"extension_ui_request", id, method, ...}）。
 *
 * 判定必须在 event 分支之前——它也有 type 字段，靠 type 值区分。
 */
function isExtensionUiRequest(obj: unknown): obj is ExtensionUiRequestEnvelope {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    r.type === "extension_ui_request" &&
    typeof r.id === "string" &&
    typeof r.method === "string"
  );
}

/** 必填 string 字段提取：类型不符降级空串（仍归类已知 method，不丢 method 信息）。 */
function reqStr(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === "string" ? v : "";
}

/** string[] 字段提取：数组剔除非字符串元素；非数组降级 onMissing。 */
function strArrayField<T extends string[] | undefined>(
  r: Record<string, unknown>,
  key: string,
  onMissing: T,
): string[] | T {
  const v = r[key];
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : onMissing;
}

/** timeout 条件展开：非 number 不挂键。 */
function optTimeout(r: Record<string, unknown>): { timeout?: number } {
  return typeof r.timeout === "number" ? { timeout: r.timeout } : {};
}

/** placeholder 条件展开：非 string 不挂键。 */
function optPlaceholder(r: Record<string, unknown>): { placeholder?: string } {
  return typeof r.placeholder === "string" ? { placeholder: r.placeholder } : {};
}

/** prefill 条件展开：非 string 不挂键。 */
function optPrefill(r: Record<string, unknown>): { prefill?: string } {
  return typeof r.prefill === "string" ? { prefill: r.prefill } : {};
}

/** notifyType 条件展开：仅接受三种已知枚举值。 */
function optNotifyType(
  r: Record<string, unknown>,
): { notifyType?: "info" | "warning" | "error" } {
  const v = r.notifyType;
  return v === "info" || v === "warning" || v === "error" ? { notifyType: v } : {};
}

/** widgetPlacement 条件展开：仅接受两种已知枚举值。 */
function optWidgetPlacement(
  r: Record<string, unknown>,
): { widgetPlacement?: "aboveEditor" | "belowEditor" } {
  const v = r.widgetPlacement;
  return v === "aboveEditor" || v === "belowEditor" ? { widgetPlacement: v } : {};
}

/**
 * 从已通过守卫的 envelope 构造 ExtensionUiRequest 变体（按 method 平铺提取，
 * 与 Pi rpc-types.ts L230-265 1:1）。未知 method 走 string fallback（保留 raw）。
 */
function buildExtensionUiRequest(env: ExtensionUiRequestEnvelope): ExtensionUiRequest {
  const r: Record<string, unknown> = env;
  switch (env.method) {
    case "select":
      return {
        method: "select",
        title: reqStr(r, "title"),
        options: strArrayField(r, "options", []),
        ...optTimeout(r),
      };
    case "confirm":
      return {
        method: "confirm",
        title: reqStr(r, "title"),
        message: reqStr(r, "message"),
        ...optTimeout(r),
      };
    case "input":
      return {
        method: "input",
        title: reqStr(r, "title"),
        ...optPlaceholder(r),
        ...optTimeout(r),
      };
    case "editor":
      return {
        method: "editor",
        title: reqStr(r, "title"),
        ...optPrefill(r),
      };
    case "notify":
      return {
        method: "notify",
        message: reqStr(r, "message"),
        ...optNotifyType(r),
      };
    case "setStatus":
      return {
        method: "setStatus",
        statusKey: reqStr(r, "statusKey"),
        statusText: typeof r.statusText === "string" ? r.statusText : undefined,
      };
    case "setWidget":
      return {
        method: "setWidget",
        widgetKey: reqStr(r, "widgetKey"),
        widgetLines: strArrayField(r, "widgetLines", undefined),
        ...optWidgetPlacement(r),
      };
    case "setTitle":
      return {
        method: "setTitle",
        title: reqStr(r, "title"),
      };
    case "set_editor_text":
      return {
        method: "set_editor_text",
        text: reqStr(r, "text"),
      };
    default:
      return { method: env.method, raw: r };
  }
}

/**
 * 解析 pi stdout 的一行。
 *
 * 分类规则（判定顺序关键——extension_ui_request 必须在 event 之前判定）：
 *   - 空白行 → null；合法 JSON 按 type 值分派 header/ui_request/response/event
 *   - 非法 JSON / 无 type → invalid（记录 error，不抛——单行损坏不中断流）
 */
export function parseSpawnLine(line: string): ParsedSpawnLine | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (err) {
    return {
      kind: "invalid",
      raw: trimmed,
      error: toErrorMessage(err),
    };
  }

  if (isSessionHeader(obj)) {
    return { kind: "header", header: obj };
  }

  if (isExtensionUiRequest(obj)) {
    return { kind: "extension_ui_request", id: obj.id, request: buildExtensionUiRequest(obj) };
  }

  if (isRpcResponse(obj)) {
    return {
      kind: "response",
      ...(typeof obj.id === "string" ? { id: obj.id } : {}),
      command: obj.command,
      success: obj.success,
      ...(obj.data !== undefined ? { data: obj.data } : {}),
      ...(typeof obj.error === "string" ? { error: obj.error } : {}),
    };
  }

  // 事件行：必须有 type 字段（SdkEvent 契约）
  if (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as Record<string, unknown>).type === "string"
  ) {
    return { kind: "event", event: obj as SdkEvent };
  }

  return {
    kind: "invalid",
    raw: trimmed,
    error: "JSON missing string 'type' field",
  };
}

/**
 * 从已收集的 header + 事件流推导子进程的 session 文件路径。
 *
 * pi session 文件命名规则（session-manager.ts:846）：
 *   `${fileTimestamp}_${sessionId}.jsonl`，fileTimestamp = header.timestamp 的
 *   冒号/点替换为连字符。
 */
export function deriveSessionFilePath(
  header: SpawnSessionHeader,
  sessionDir: string,
): string {
  const fileTimestamp = header.timestamp.replace(/[:.]/g, "-");
  return `${sessionDir}/${fileTimestamp}_${header.id}.jsonl`;
}

/**
 * 在 sessionDir 中按 sessionId 后缀匹配查找实际存在的 session 文件（命名规则
 * 变化时的兜底）。@returns 匹配到的文件绝对路径，或 undefined。
 */
export function findSessionFileByHeaderId(
  sessionDir: string,
  sessionId: string,
): string | undefined {
  try {
    const files = fs.readdirSync(sessionDir);
    const match = files.find((f) => f.endsWith(`_${sessionId}.jsonl`));
    return match ? path.join(sessionDir, match) : undefined;
  } catch {
    return undefined;
  }
}
