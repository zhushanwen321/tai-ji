// src/__tests__/transport-error-codes.test.ts
//
// [M1/M2/M3 u-foundation] relay-spawn-transport 错误码词表测试（设计 §3.3 D10）：
// engine 侧 3 码 + runtime 控制面 5 码。验收条款①「错误码过 ^engine_ pattern」——
// 协议 error 帧 code 词法约束（schema.ts protocolErrorSchema pattern ^engine_）对全部
// 新码成立；家族分离（不进 ENGINE_PROTOCOL_ERROR_CODES 主词表）与 recovery 文案
// 完整性同文件锁定。

import { describe, expect, it } from "vitest";

import {
  ENGINE_SPAWN_DELIVERY_ERROR_CODES,
  ENGINE_TRANSPORT_ERROR_CODES,
  ENGINE_SPAWN_DELIVERY_ERROR_RECOVERY,
  ENGINE_TRANSPORT_ERROR_RECOVERY,
  ENGINE_PROTOCOL_ERROR_CODES,
  EngineSdkError,
} from "../index.ts";

describe("引擎侧 spawn/送达错误码（D10 engine 侧 3 码，u-m2-engine-ack 消费）", () => {
  it("词表成员精确锁定", () => {
    expect([...ENGINE_SPAWN_DELIVERY_ERROR_CODES]).toEqual([
      "engine_prompt_not_delivered",
      "engine_prompt_rejected",
      "engine_spawn_handshake_timeout",
    ]);
  });

  it("recovery 文案键完整且非空（键完整性由 Record<Code, string> 类型 + 运行时断言双兜底）", () => {
    for (const code of ENGINE_SPAWN_DELIVERY_ERROR_CODES) {
      const recovery = ENGINE_SPAWN_DELIVERY_ERROR_RECOVERY[code];
      expect(typeof recovery).toBe("string");
      expect(recovery.length).toBeGreaterThan(0);
    }
    expect(Object.keys(ENGINE_SPAWN_DELIVERY_ERROR_RECOVERY).length).toBe(
      ENGINE_SPAWN_DELIVERY_ERROR_CODES.length,
    );
  });
});

describe("runtime 控制面传输错误码（D10 runtime 侧 5 码，connectOnce preserve 白名单）", () => {
  it("词表成员精确锁定（D5：connectOnce 原样保留 code 与 recovery，不再包装 engine_crashed）", () => {
    expect([...ENGINE_TRANSPORT_ERROR_CODES]).toEqual([
      "engine_transport_unavailable",
      "engine_transport_lost",
      "engine_open_timeout",
      "engine_frame_too_large",
      "engine_backpressure_overflow",
    ]);
  });

  it("recovery 文案键完整且非空", () => {
    for (const code of ENGINE_TRANSPORT_ERROR_CODES) {
      const recovery = ENGINE_TRANSPORT_ERROR_RECOVERY[code];
      expect(typeof recovery).toBe("string");
      expect(recovery.length).toBeGreaterThan(0);
    }
    expect(Object.keys(ENGINE_TRANSPORT_ERROR_RECOVERY).length).toBe(
      ENGINE_TRANSPORT_ERROR_CODES.length,
    );
  });
});

describe("全族共同契约（验收条款①：^engine_ pattern + 家族分离）", () => {
  it("8 码全部过 ^engine_ 前缀（协议 error 帧 code 词法约束 schema.ts protocolErrorSchema pattern）", () => {
    const all = [...ENGINE_SPAWN_DELIVERY_ERROR_CODES, ...ENGINE_TRANSPORT_ERROR_CODES];
    expect(all).toHaveLength(8);
    for (const code of all) {
      expect(code).toMatch(/^engine_/);
    }
  });

  it("家族分离：两族 8 码互不重复且都不进 ENGINE_PROTOCOL_ERROR_CODES 主词表（主词表=引擎 error 帧+core 同步拦截核心集，13 成员不扩）", () => {
    const all = [...ENGINE_SPAWN_DELIVERY_ERROR_CODES, ...ENGINE_TRANSPORT_ERROR_CODES];
    expect(new Set(all).size).toBe(8);
    const core = new Set<string>(ENGINE_PROTOCOL_ERROR_CODES);
    for (const code of all) {
      expect(core.has(code)).toBe(false);
    }
    expect(ENGINE_PROTOCOL_ERROR_CODES).toHaveLength(13);
  });

  it("EngineSdkError 载体形态：message = <code>: <detail> 前缀约定 + toStructured() 协议 error 帧投影", () => {
    const err = new EngineSdkError(
      "engine_transport_lost",
      "control connection closed mid-flight",
      ENGINE_TRANSPORT_ERROR_RECOVERY.engine_transport_lost,
    );
    expect(err.code).toBe("engine_transport_lost");
    expect(err.message).toBe("engine_transport_lost: control connection closed mid-flight");
    expect(err.recovery).toBe(ENGINE_TRANSPORT_ERROR_RECOVERY.engine_transport_lost);
    const structured = err.toStructured();
    expect(structured).toMatchObject({
      code: "engine_transport_lost",
      message: "engine_transport_lost: control connection closed mid-flight",
    });
  });
});
