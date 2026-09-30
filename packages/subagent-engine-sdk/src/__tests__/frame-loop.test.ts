// src/__tests__/frame-loop.test.ts
//
// [§2.11 第二批] 共享帧循环（`server/index.ts`）的单测：分类分支逐条 + 应答管线
//（反向应答落地 / 引擎侧反向请求坏帧应答 / 正向请求分发与错误帧回转 / 静默忽略）。
//
// 为什么单独测：两引擎的 `server.test.ts` 已端到端覆盖同一条路径（52 例），但它们
// 是「整类服务器」视角；本文件把共享层的分支表直接钉住，避免将来某引擎的差异改动
// 让某分支只在另一引擎侧被覆盖。

import { describe, expect, it, vi } from "vitest";

import {
  classifyInboundFrame,
  handleInboundFrame,
  reverseRequestRejection,
  unknownMethodError,
  type FrameLoopContext,
} from "../server/index.ts";
import { EngineSdkError } from "../protocol/error-codes.ts";

function makeCtx(overrides: Partial<FrameLoopContext> = {}) {
  const written: unknown[] = [];
  const settled: Array<[number | string, unknown]> = [];
  const dispatched: Array<[number, string, unknown]> = [];
  const ctx: FrameLoopContext = {
    write: (frame) => { written.push(frame); },
    settleReverse: (id, frame) => { settled.push([id, frame]); },
    dispatch: (id, method, params) => { dispatched.push([id, method, params]); return { ok: true }; },
    toError: (err) => ({ code: "engine_run_failed", message: String(err), recovery: "injected" }),
    ...overrides,
  };
  return { ctx, written, settled, dispatched };
}

describe("classifyInboundFrame（判序即协议纪律）", () => {
  it("反向应答优先于一切（result / error 两形态都归此）", () => {
    expect(classifyInboundFrame({ id: 7, result: {} })).toEqual({ kind: "reverse-response", id: 7 });
    expect(classifyInboundFrame({ id: "host-1", error: { code: "x" } })).toEqual({ kind: "reverse-response", id: "host-1" });
  });

  it("反向请求帧（字符串 id + host/* method）→ 拒绝分支", () => {
    expect(classifyInboundFrame({ id: "h1", method: "host/askUser", params: {} }))
      .toEqual({ kind: "rejected-reverse-request", method: "host/askUser" });
  });

  it("正向请求：method 为 string 且 id 为 number", () => {
    expect(classifyInboundFrame({ id: 3, method: "run", params: { runId: "r" } }))
      .toEqual({ kind: "request", id: 3, method: "run", params: { runId: "r" } });
    // params 可缺席（协议宽容面）
    expect(classifyInboundFrame({ id: 4, method: "probe" }))
      .toEqual({ kind: "request", id: 4, method: "probe", params: undefined });
  });

  it("其余一律静默忽略：非对象 / 缺字段 / method 非 string / id 非 number", () => {
    for (const frame of [null, undefined, 42, "run", {}, { id: 1 }, { method: "run" }, { id: 1, method: 9 }, { id: "1", method: "run" }, { id: true, method: "run" }]) {
      // 注：`{ id, method, result }` 会先被 isResponseFrame 判成反向应答（判序在协议纪律里更高）——
      // 该形态由「反向应答优先」用例覆盖，此处只列真正无归属的帧。
      expect(classifyInboundFrame(frame).kind).toBe("ignore");
    }
  });
});

describe("handleInboundFrame（管线与副作用）", () => {
  it("反向应答 → settleReverse(id, frame)，不写帧、不分发", () => {
    const { ctx, written, settled, dispatched } = makeCtx();
    const frame = { id: 11, result: { ok: true } };
    handleInboundFrame(frame, ctx);
    expect(settled).toEqual([[11, frame]]);
    expect(written).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it("反向请求帧 → 逐字坏帧应答（id:0 + engine_protocol_bad_frame），不分发", () => {
    const { ctx, written, settled, dispatched } = makeCtx();
    handleInboundFrame({ id: "h1", method: "host/askUser", params: {} }, ctx);
    expect(written).toEqual([reverseRequestRejection("host/askUser")]);
    expect(written[0]).toEqual({
      id: 0,
      error: {
        code: "engine_protocol_bad_frame",
        message: "unexpected reverse request frame from host: host/askUser",
        recovery: "The engine protocol v1 only carries host/* requests engine→host.",
      },
    });
    expect(settled).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it("正向请求 → 分发并回结果帧（Promise 形态同款）", async () => {
    const { ctx, written, dispatched } = makeCtx();
    handleInboundFrame({ id: 5, method: "read", params: { p: 1 } }, ctx);
    expect(dispatched).toEqual([[5, "read", { p: 1 }]]);
    await vi.waitFor(() => expect(written).toEqual([{ id: 5, result: { ok: true } }]));
  });

  it("分发抛错（同步 throw）→ 经注入的 toError 回错误帧，不逃出帧循环", () => {
    const seen: unknown[] = [];
    const { ctx, written } = makeCtx({
      dispatch: () => { throw unknownMethodError(9, "nope"); },
      toError: (err) => { seen.push(err); return { code: "converted", message: "m", recovery: "r" }; },
    });
    expect(() => handleInboundFrame({ id: 9, method: "nope" }, ctx)).not.toThrow();
    expect(seen[0]).toBeInstanceOf(EngineSdkError);
    expect(written).toEqual([{ id: 9, error: { code: "converted", message: "m", recovery: "r" } }]);
  });

  it("分发返回 rejection → 同款错误帧", async () => {
    const { ctx, written } = makeCtx({
      dispatch: () => Promise.reject(new Error("boom")),
    });
    handleInboundFrame({ id: 12, method: "run" }, ctx);
    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toMatchObject({ id: 12, error: { code: "engine_run_failed", message: "Error: boom" } });
  });

  it("静默忽略分支零副作用", () => {
    const { ctx, written, settled, dispatched } = makeCtx();
    for (const frame of [null, { id: "1", method: "run" }, "garbage"]) handleInboundFrame(frame, ctx);
    expect([written.length, settled.length, dispatched.length]).toEqual([0, 0, 0]);
  });
});

describe("unknownMethodError（两引擎逐字一致的错误载荷）", () => {
  it("code / message / recovery 三件套（message 带 code 前缀 = EngineSdkError 的结构化形态）", () => {
    const err = unknownMethodError(2, "runX");
    const structured = err.toStructured();
    expect(structured.code).toBe("engine_protocol_unknown_method");
    expect(structured.message).toContain("unknown protocol method: runX (request id 2)");
    expect(structured.recovery).toBe("The engine speaks protocol v1; check the installed engine package version vs the host.");
  });
});
