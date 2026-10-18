// src/__tests__/control-protocol.test.ts
//
// [M3 u-foundation] control 通道协议契约词表测试：版本 / 帧 kind 词表 / engine_closed
// reason 值域 + guard 收窄。契约单源 = protocol/control-protocol.ts；消费方
// （u-m3-control / u-m3-rt-transport）落地时以本词表为准，禁手写字面量。

import { describe, expect, it } from "vitest";

import {
  SUBAGENT_CONTROL_PROTOCOL_VERSION,
  SUBAGENT_CONTROL_FRAME_KINDS,
  SUBAGENT_CONTROL_CLOSED_REASONS,
  isSubagentControlFrameKind,
  isSubagentControlClosedReason,
} from "../protocol/control-protocol.ts";

describe("control 协议版本（§3.3 D8：SUBAGENT_CONTROL_PROTOCOL_VERSION = 1）", () => {
  it("版本恒 1（未知 v → hello_reject {reason:\"version\"}，D9 版本矩阵）", () => {
    expect(SUBAGENT_CONTROL_PROTOCOL_VERSION).toBe(1);
  });
});

describe("帧 kind 词表（§3.4.3 帧表 10 成员）", () => {
  it("词表成员与字面量精确锁定（hello/hello_ok/hello_reject/engine_open/engine_opened/engine_open_failed/engine_frame/engine_close/engine_closed/error）", () => {
    expect(SUBAGENT_CONTROL_FRAME_KINDS).toEqual({
      hello: "hello",
      helloOk: "hello_ok",
      helloReject: "hello_reject",
      engineOpen: "engine_open",
      engineOpened: "engine_opened",
      engineOpenFailed: "engine_open_failed",
      engineFrame: "engine_frame",
      engineClose: "engine_close",
      engineClosed: "engine_closed",
      error: "error",
    });
  });

  it("kind 字面量两两不同（判别值不得撞名）", () => {
    const values = Object.values(SUBAGENT_CONTROL_FRAME_KINDS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("guard 收窄：在册 kind true，未知/非字符串 false", () => {
    expect(isSubagentControlFrameKind("hello")).toBe(true);
    expect(isSubagentControlFrameKind("engine_frame")).toBe(true);
    expect(isSubagentControlFrameKind("engine_closed")).toBe(true);
    expect(isSubagentControlFrameKind("handshake")).toBe(false); // 非 control 帧词表不得混入
    expect(isSubagentControlFrameKind("engine_boom")).toBe(false);
    expect(isSubagentControlFrameKind(1)).toBe(false);
    expect(isSubagentControlFrameKind(undefined)).toBe(false);
  });
});

describe("engine_closed reason 值域（D8/D10：四值）", () => {
  it("值域成员精确锁定（engine_exit/engine_signal/killed_by_control/open_timeout）", () => {
    expect(SUBAGENT_CONTROL_CLOSED_REASONS).toEqual({
      engineExit: "engine_exit",
      engineSignal: "engine_signal",
      killedByControl: "killed_by_control",
      openTimeout: "open_timeout",
    });
  });

  it("guard 收窄：在册 reason true，未知/非字符串 false", () => {
    expect(isSubagentControlClosedReason("engine_exit")).toBe(true);
    expect(isSubagentControlClosedReason("killed_by_control")).toBe(true);
    expect(isSubagentControlClosedReason("crashed")).toBe(false);
    expect(isSubagentControlClosedReason("")).toBe(false);
    expect(isSubagentControlClosedReason(null)).toBe(false);
  });
});
