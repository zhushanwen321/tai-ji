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

export type ControlInboundHelloOk = {
  kind: typeof SUBAGENT_CONTROL_FRAME_KINDS.helloOk;
  id: unknown;
};
export type ControlInboundHelloReject = {
  kind: typeof SUBAGENT_CONTROL_FRAME_KINDS.helloReject;
  id: unknown;
  reason: string | undefined;
  message: string | undefined;
  recovery: string | undefined;
  code: string | undefined;
};
export type ControlInboundEngineOpened = {
  kind: typeof SUBAGENT_CONTROL_FRAME_KINDS.engineOpened;
  id: unknown;
  channelId: string;
  pid: number | undefined;
};
export type ControlInboundEngineOpenFailed = {
  kind: typeof SUBAGENT_CONTROL_FRAME_KINDS.engineOpenFailed;
  id: unknown;
  code: string;
  message: string;
  recovery: string | undefined;
};
export type ControlInboundEngineFrame = {
  kind: typeof SUBAGENT_CONTROL_FRAME_KINDS.engineFrame;
  channelId: string;
  line: string;
};
export type ControlInboundEngineClosed = {
  kind: typeof SUBAGENT_CONTROL_FRAME_KINDS.engineClosed;
  channelId: string;
  code: number | null;
  signal: string | null;
  stderrTail: string | undefined;
  reason: string | undefined;
};
export type ControlInboundError = {
  kind: typeof SUBAGENT_CONTROL_FRAME_KINDS.error;
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

function toHelloOkFrame(parsed: Record<string, unknown>): ControlInboundHelloOk {
  return { kind: SUBAGENT_CONTROL_FRAME_KINDS.helloOk, id: parsed.id };
}

function toHelloRejectFrame(parsed: Record<string, unknown>): ControlInboundHelloReject {
  return {
    kind: SUBAGENT_CONTROL_FRAME_KINDS.helloReject,
    id: parsed.id,
    reason: optionalString(parsed.reason),
    message: optionalString(parsed.message),
    recovery: optionalString(parsed.recovery),
    code: optionalString(parsed.code),
  };
}

function toEngineOpenedFrame(parsed: Record<string, unknown>): ControlInboundEngineOpened {
  return {
    kind: SUBAGENT_CONTROL_FRAME_KINDS.engineOpened,
    id: parsed.id,
    channelId: optionalChannelId(parsed.channelId),
    pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
  };
}

function toEngineOpenFailedFrame(parsed: Record<string, unknown>): ControlInboundEngineOpenFailed {
  return {
    kind: SUBAGENT_CONTROL_FRAME_KINDS.engineOpenFailed,
    id: parsed.id,
    code: optionalString(parsed.code) ?? "spawn_failed",
    message: optionalString(parsed.message) ?? "engine_open failed",
    recovery: optionalString(parsed.recovery),
  };
}

function toEngineFrameFrame(parsed: Record<string, unknown>): ControlInboundEngineFrame {
  return {
    kind: SUBAGENT_CONTROL_FRAME_KINDS.engineFrame,
    channelId: optionalChannelId(parsed.channelId),
    line: typeof parsed.line === "string" ? parsed.line : "",
  };
}

function toEngineClosedFrame(parsed: Record<string, unknown>): ControlInboundEngineClosed {
  return {
    kind: SUBAGENT_CONTROL_FRAME_KINDS.engineClosed,
    channelId: optionalChannelId(parsed.channelId),
    code: typeof parsed.code === "number" ? parsed.code : null,
    signal: optionalString(parsed.signal) ?? null,
    stderrTail: optionalString(parsed.stderrTail),
    reason: isSubagentControlClosedReason(parsed.reason) ? parsed.reason : undefined,
  };
}

function toErrorFrame(parsed: Record<string, unknown>): ControlInboundError {
  return {
    kind: SUBAGENT_CONTROL_FRAME_KINDS.error,
    channelId: optionalString(parsed.channelId),
    code: optionalString(parsed.code) ?? "engine_transport_unavailable",
    message: optionalString(parsed.message) ?? "runtime control error",
    recovery: optionalString(parsed.recovery),
  };
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
      return { frame: toHelloOkFrame(parsed) };
    case SUBAGENT_CONTROL_FRAME_KINDS.helloReject:
      return { frame: toHelloRejectFrame(parsed) };
    case SUBAGENT_CONTROL_FRAME_KINDS.engineOpened:
      return { frame: toEngineOpenedFrame(parsed) };
    case SUBAGENT_CONTROL_FRAME_KINDS.engineOpenFailed:
      return { frame: toEngineOpenFailedFrame(parsed) };
    case SUBAGENT_CONTROL_FRAME_KINDS.engineFrame:
      return { frame: toEngineFrameFrame(parsed) };
    case SUBAGENT_CONTROL_FRAME_KINDS.engineClosed:
      return { frame: toEngineClosedFrame(parsed) };
    case SUBAGENT_CONTROL_FRAME_KINDS.error:
      return { frame: toErrorFrame(parsed) };
    default:
      // hello / engine_open / engine_close 是 C→R 方向，不应出现在接收面。
      return { dropped: "unexpected" };
  }
}
