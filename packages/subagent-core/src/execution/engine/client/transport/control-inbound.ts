// src/execution/engine/client/transport/control-inbound.ts
//
// [M3] control R→C 帧解析（u-m3-rt-transport）：单行 JSON → 收窄后的判别联合，供
// RuntimeControlClient 的接收状态机消费（把逐 kind 的形状守卫从状态机里剥出）。
// 帧 kind 词表单源 = SDK control-protocol.ts；engine_closed 的 reason 用 SDK 值域
// guard 收窄（未知值缺席）。engine_frame.line 是不透明字符串（本层不理解引擎协议）。

import {
  SUBAGENT_CONTROL_FRAME_KINDS,
  isSubagentControlClosedReason,
  isSubagentControlFrameKind,
} from "@zhushanwen/subagent-engine-sdk";

import { isRecord } from "./control-shared.ts";

export type ControlInboundHelloOk = { kind: "hello_ok"; id: unknown };
export type ControlInboundHelloReject = {
  kind: "hello_reject";
  id: unknown;
  reason: string | undefined;
  message: string | undefined;
  recovery: string | undefined;
  code: string | undefined;
};
export type ControlInboundEngineOpened = {
  kind: "engine_opened";
  id: unknown;
  channelId: string;
  pid: number | undefined;
};
export type ControlInboundEngineOpenFailed = {
  kind: "engine_open_failed";
  id: unknown;
  code: string;
  message: string;
  recovery: string | undefined;
};
export type ControlInboundEngineFrame = { kind: "engine_frame"; channelId: string; line: string };
export type ControlInboundEngineClosed = {
  kind: "engine_closed";
  channelId: string;
  code: number | null;
  signal: string | null;
  stderrTail: string | undefined;
  reason: string | undefined;
};
export type ControlInboundError = {
  kind: "error";
  channelId: string | undefined;
  code: string;
  message: string;
  recovery: string | undefined;
};

/** R→C 帧判别联合（hello_ok / hello_reject / engine_opened / engine_open_failed / engine_frame / engine_closed / error）。 */
export type ControlInboundFrame =
  | ControlInboundHelloOk
  | ControlInboundHelloReject
  | ControlInboundEngineOpened
  | ControlInboundEngineOpenFailed
  | ControlInboundEngineFrame
  | ControlInboundEngineClosed
  | ControlInboundError;

/** 解析裁决：frame = 已收窄；dropped = malformed（JSON 错）/ unknown（词表外）/ unexpected（C→R kind 误入）。 */
export type ControlInboundParse =
  | { frame: ControlInboundFrame }
  | { dropped: "malformed" | "unknown" | "unexpected" };

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalChannelId(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 解析一行 control 帧（R→C 面）。畸形/词表外/方向错 → dropped（调用方计数留痕）。 */
export function parseControlInboundLine(line: string): ControlInboundParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { dropped: "malformed" };
  }
  if (!isRecord(parsed) || !isSubagentControlFrameKind(parsed.kind)) {
    return { dropped: "unknown" };
  }
  switch (parsed.kind) {
    case SUBAGENT_CONTROL_FRAME_KINDS.helloOk:
      return { frame: { kind: "hello_ok", id: parsed.id } };
    case SUBAGENT_CONTROL_FRAME_KINDS.helloReject:
      return {
        frame: {
          kind: "hello_reject",
          id: parsed.id,
          reason: optionalString(parsed.reason),
          message: optionalString(parsed.message),
          recovery: optionalString(parsed.recovery),
          code: optionalString(parsed.code),
        },
      };
    case SUBAGENT_CONTROL_FRAME_KINDS.engineOpened:
      return {
        frame: {
          kind: "engine_opened",
          id: parsed.id,
          channelId: optionalChannelId(parsed.channelId),
          pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
        },
      };
    case SUBAGENT_CONTROL_FRAME_KINDS.engineOpenFailed:
      return {
        frame: {
          kind: "engine_open_failed",
          id: parsed.id,
          code: optionalString(parsed.code) ?? "spawn_failed",
          message: optionalString(parsed.message) ?? "engine_open failed",
          recovery: optionalString(parsed.recovery),
        },
      };
    case SUBAGENT_CONTROL_FRAME_KINDS.engineFrame:
      return {
        frame: {
          kind: "engine_frame",
          channelId: optionalChannelId(parsed.channelId),
          line: typeof parsed.line === "string" ? parsed.line : "",
        },
      };
    case SUBAGENT_CONTROL_FRAME_KINDS.engineClosed:
      return {
        frame: {
          kind: "engine_closed",
          channelId: optionalChannelId(parsed.channelId),
          code: typeof parsed.code === "number" ? parsed.code : null,
          signal: optionalString(parsed.signal) ?? null,
          stderrTail: optionalString(parsed.stderrTail),
          reason: isSubagentControlClosedReason(parsed.reason) ? parsed.reason : undefined,
        },
      };
    case SUBAGENT_CONTROL_FRAME_KINDS.error:
      return {
        frame: {
          kind: "error",
          channelId: optionalString(parsed.channelId),
          code: optionalString(parsed.code) ?? "engine_transport_unavailable",
          message: optionalString(parsed.message) ?? "runtime control error",
          recovery: optionalString(parsed.recovery),
        },
      };
    default:
      // hello / engine_open / engine_close 是 C→R 方向，不应出现在接收面。
      return { dropped: "unexpected" };
  }
}
