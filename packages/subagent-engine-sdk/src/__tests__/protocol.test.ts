// src/__tests__/protocol.test.ts
//
// 协议面 v1 契约断言（W1 验收：impl-plan §2.1 规格逐项 + A6 协议层部分）。
// A6 完整真机验收（能力协商/relay/旋钮）归 W2+ 真机场景；本文件锁定协议层可自动
// 判定的子集：版本协商区间、错误码表、方法/通道全集、超时二分、量级常量、帧判别。

import { describe, expect, it } from "vitest";

import {
  CANCEL_SETTLE_GRACE_MS,
  CRASH_REBUILD_BACKOFF_MS,
  CRASH_REBUILD_MAX_ATTEMPTS,
  ENGINE_PROTOCOL_VERSION,
  ENGINE_EVENT_COALESCE_DEFAULT,
  ENGINE_EVENT_COALESCE_ENV,
  HANDSHAKE_TIMEOUT_MS,
  REVERSE_REQUEST_TIMEOUT_MS,
  STDERR_TAIL_CHARS,
  SUPPORTED_PROTOCOL_RANGE,
  isProtocolVersionCompatible,
} from "../protocol/engine-protocol.ts";
import {
  ErrorResponseFrame,
  isNotificationFrame,
  isRequestFrame,
  isResponseFrame,
  isReverseRequestFrame,
  type NotificationFrame,
  type RequestFrame,
  type ReverseRequestFrame,
  type SuccessResponseFrame,
} from "../protocol/frames.ts";
import {
  PROTOCOL_METHODS,
  type ProtocolMethod,
  type ProtocolParamsMap,
  type ProtocolResultMap,
  type RunContextParams,
  type RunParams,
} from "../protocol/methods.ts";
import type { AssertMutuallyAssignable } from "../protocol/contract-types.ts";
import {
  REVERSE_CHANNELS,
  REVERSE_CHANNEL_TIMEOUT_CLASS,
  type HostChildStateChangedParams,
} from "../protocol/reverse-channels.ts";
import {
  ENGINE_ERROR_CODE_PREFIX,
  ENGINE_PROTOCOL_ERROR_CODES,
  engineProtocolMismatchError,
  isEngineErrorPassthroughCode,
  isEngineProtocolErrorCode,
} from "../protocol/error-codes.ts";

describe("版本协商（A6① 协议层判据）", () => {
  it("ENGINE_PROTOCOL_VERSION = 1（impl-plan §2.1 写死）", () => {
    expect(ENGINE_PROTOCOL_VERSION).toBe(1);
  });

  it("core 支持区间 = [1, 2) 半开区间", () => {
    expect(SUPPORTED_PROTOCOL_RANGE).toEqual({ min: 1, max: 2 });
  });

  it("v1 兼容；v0（过旧）与 v2（过新）越界", () => {
    expect(isProtocolVersionCompatible(1)).toBe(true);
    expect(isProtocolVersionCompatible(0)).toBe(false);
    expect(isProtocolVersionCompatible(2)).toBe(false);
    expect(isProtocolVersionCompatible(99)).toBe(false);
  });

  it("非整数版本不兼容（防脏输入）", () => {
    expect(isProtocolVersionCompatible(1.5)).toBe(false);
    expect(isProtocolVersionCompatible(Number.NaN)).toBe(false);
  });

  it("engine_protocol_mismatch 错误含双方版本 + 升级指引（A6① 恢复指引契约）", () => {
    const err = engineProtocolMismatchError(99);
    expect(err.code).toBe("engine_protocol_mismatch");
    expect(err.message).toContain("99");
    expect(err.message).toContain("[1, 2)");
    // 恢复指引必须可操作：指向升级动作（全局规则：错误 → 恢复动作闭环）
    expect(err.recovery).toMatch(/upgrade/i);
    // data 携带结构化版本对（GUI/日志分流用）
    expect(err.data).toEqual({
      engineProtocolVersion: 99,
      supportedMin: 1,
      supportedMaxExclusive: 2,
    });
    // toStructured 投影即协议 error 帧载荷形态
    expect(err.toStructured()).toMatchObject({
      code: "engine_protocol_mismatch",
      recovery: err.recovery,
    });
  });
});

describe("量级常量（impl-plan §2.1 逐项写死）", () => {
  it("数据面反向请求 10s / 握手 10s / cancel 收敛 3s", () => {
    expect(REVERSE_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(HANDSHAKE_TIMEOUT_MS).toBe(10_000);
    expect(CANCEL_SETTLE_GRACE_MS).toBe(3_000);
  });

  it("崩溃重建 3 次上限 + 指数退避 1s/2s/4s", () => {
    expect(CRASH_REBUILD_MAX_ATTEMPTS).toBe(3);
    expect([...CRASH_REBUILD_BACKOFF_MS]).toEqual([1_000, 2_000, 4_000]);
  });

  it("stderr 崩溃现场尾部 400 字符", () => {
    expect(STDERR_TAIL_CHARS).toBe(400);
  });

  it("事件合并默认关闭（XYZ_ENGINE_EVENT_COALESCE=0，A1 逐字段等价前提）", () => {
    expect(ENGINE_EVENT_COALESCE_ENV).toBe("XYZ_ENGINE_EVENT_COALESCE");
    expect(ENGINE_EVENT_COALESCE_DEFAULT).toBe("0");
  });
});

describe("9 正向方法全集", () => {
  it("恰好 9 个方法，无多无少（v1 方法集；[H1] interact 已随 chat-run 统一退役）", () => {
    expect(PROTOCOL_METHODS).toHaveLength(9);
    expect([...PROTOCOL_METHODS]).toEqual([
      "initialize",
      "probe",
      "run",
      "cancel",
      "read",
      "listModels",
      "validateModel",
      "dispose",
      "ping",
    ]);
  });

  it("方法名联合与常量数组同源（编译期互证 + 运行时抽查）", () => {
    const sample: ProtocolMethod = "run";
    expect(PROTOCOL_METHODS).toContain(sample);
    // 类型面锁死：params/result 映射表键集 = 方法全集（缺方法 = 编译失败）
    type _ParamsKeys = AssertMutuallyAssignable<keyof ProtocolParamsMap, ProtocolMethod>;
    type _ResultKeys = AssertMutuallyAssignable<keyof ProtocolResultMap, ProtocolMethod>;
    const keyChecks: [_ParamsKeys, _ResultKeys] = [true, true];
    expect(keyChecks).toEqual([true, true]);
  });
});

describe("8 反向通道全集与超时二分（R9-2；[H1] v1.x 曾增的轮次相位通道已退役）", () => {
  it("恰好 8 个通道", () => {
    expect(REVERSE_CHANNELS).toHaveLength(8);
    expect([...REVERSE_CHANNELS]).toEqual([
      "host/log",
      "host/askUser",
      "host/permission",
      "host/streamDelta",
      "host/poolResolved",
      "host/handleReady",
      "host/childSpawned",
      "host/childStateChanged",
    ]);
  });

  it("二分：数据面 6 通道 10s 超时；人机交互 2 通道不设统一超时", () => {
    const dataPlane = REVERSE_CHANNELS.filter(
      (ch) => REVERSE_CHANNEL_TIMEOUT_CLASS[ch] === "data-plane",
    );
    const interaction = REVERSE_CHANNELS.filter(
      (ch) => REVERSE_CHANNEL_TIMEOUT_CLASS[ch] === "interaction",
    );
    expect(dataPlane).toEqual([
      "host/log",
      "host/streamDelta",
      "host/poolResolved",
      "host/handleReady",
      "host/childSpawned",
      "host/childStateChanged",
    ]);
    expect(interaction).toEqual(["host/askUser", "host/permission"]);
  });

  it("childStateChanged 载荷 killed 必含（类型层 required；运行时构造验证形状）", () => {
    const payload: HostChildStateChangedParams = {
      pid: 4242,
      recordId: "rec-1",
      state: "exited",
      killed: true,
      exitCode: 0,
    };
    expect(Object.hasOwn(payload, "killed")).toBe(true);
  });
});

describe("错误码表（impl-plan §2.1 逐项）", () => {
  it("9 个核心错误码齐全", () => {
    expect([...ENGINE_PROTOCOL_ERROR_CODES]).toEqual([
      "engine_not_found",
      "engine_protocol_mismatch",
      "engine_capability_unsupported",
      "engine_capability_mismatch",
      "engine_model_unknown",
      "engine_model_mismatch",
      "engine_handshake_timeout",
      "engine_crashed",
      "engine_probe_failed",
    ]);
  });

  it("收窄 guard：命中词表 true；其余 engine_* 前缀走透传判定", () => {
    expect(isEngineProtocolErrorCode("engine_crashed")).toBe(true);
    expect(isEngineProtocolErrorCode("engine_custom_boom")).toBe(false);
    expect(isEngineProtocolErrorCode("boom")).toBe(false);
    expect(isEngineErrorPassthroughCode("engine_custom_boom")).toBe(true);
    expect(isEngineErrorPassthroughCode("engine_crashed")).toBe(false);
    expect(isEngineErrorPassthroughCode("no_prefix")).toBe(false);
    expect(ENGINE_ERROR_CODE_PREFIX).toBe("engine_");
  });
});

describe("帧判别守卫（四帧型互斥判别，W2 行解析器消费）", () => {
  const req: RequestFrame = { id: 1, method: "run", params: {} };
  const okRes: SuccessResponseFrame = { id: 1, result: { handle: {}, outcome: {} } };
  const errRes: ErrorResponseFrame = {
    id: 1,
    error: { code: "engine_crashed", message: "m", recovery: "r" },
  };
  const note: NotificationFrame = {
    method: "event",
    params: { runId: "r1", seq: 1, event: { type: "text_delta", delta: "x" } },
  };
  const rev: ReverseRequestFrame = { id: "rev-1", method: "host/askUser", params: {} };

  it("①请求：数字 id + method + params，无 result/error", () => {
    expect(isRequestFrame(req)).toBe(true);
    expect(isRequestFrame(okRes)).toBe(false);
    expect(isRequestFrame(errRes)).toBe(false);
    expect(isRequestFrame(note)).toBe(false);
    // 反向请求形态（string id）不是正向请求
    expect(isRequestFrame(rev)).toBe(false);
  });

  it("②应答：result/error 互斥二选一（双有/双无都拒）", () => {
    expect(isResponseFrame(okRes)).toBe(true);
    expect(isResponseFrame(errRes)).toBe(true);
    expect(isResponseFrame({ id: 1 })).toBe(false);
    expect(isResponseFrame({ id: 1, result: {}, error: {} })).toBe(false);
    expect(isResponseFrame(note)).toBe(false);
  });

  it("③通知：无 id + method=event + runId/seq/event 形状", () => {
    expect(isNotificationFrame(note)).toBe(true);
    expect(isNotificationFrame({ method: "event", params: { runId: "r", seq: 1 } })).toBe(false);
    expect(isNotificationFrame(req)).toBe(false);
  });

  it("④反向请求：字符串 id + host/* 前缀", () => {
    expect(isReverseRequestFrame(rev)).toBe(true);
    expect(isReverseRequestFrame({ id: "x", method: "run", params: {} })).toBe(false);
    expect(isReverseRequestFrame(req)).toBe(false);
  });
});

describe("run.params.ctx 增量字段（F6 sessionRootId：relay 归属键 SESSION_ID 权威源）", () => {
  const v1Ctx: RunContextParams = { poolKey: "shared", cwd: "/tmp" };

  it("带 sessionRootId 的 run ctx 可构造（RunParams 形态承载）", () => {
    const run: RunParams = {
      runId: "run-1",
      task: { prompt: "do" },
      ctx: { ...v1Ctx, sessionRootId: "root-sess-9" },
    };
    expect(run.ctx.sessionRootId).toBe("root-sess-9");
  });

  it("v1 形态（无 sessionRootId）零破坏——additive 可选，旧宿主/引擎语义不变", () => {
    const run: RunParams = { runId: "run-1", task: { prompt: "do" }, ctx: v1Ctx };
    expect(run.ctx.sessionRootId).toBeUndefined();
  });
});

describe("run.params.ctx 增量字段（Option C sessionDir：宿主权威 subagent session 目录）", () => {
  const v1Ctx: RunContextParams = { poolKey: "shared", cwd: "/tmp" };

  it("带 sessionDir 的 run ctx 可构造（引擎据此组装 --session-dir，不自推导）", () => {
    const run: RunParams = {
      runId: "run-1",
      task: { prompt: "do" },
      ctx: { ...v1Ctx, sessionDir: "/agent/subagents/--Users-x-proj--/sessions" },
    };
    expect(run.ctx.sessionDir).toBe("/agent/subagents/--Users-x-proj--/sessions");
  });

  it("v1 形态（无 sessionDir）零破坏——additive 可选，旧引擎走 [LEGACY] fallback", () => {
    const run: RunParams = { runId: "run-1", task: { prompt: "do" }, ctx: v1Ctx };
    expect(run.ctx.sessionDir).toBeUndefined();
  });
});
