// src/execution/__tests__/best-effort-pi-call.test.ts
//
// [§1.4 (b)] pi 通知/条目通道 best-effort 执行单测：
//   1. isPiStaleCtxError 分诊命中（PS-30 文案）/不命中（其他错误 / 非 Error 值）；
//   2. bestEffortPiCall：pi 不在场 no-op / 正常调用透传 / stale 抛错 warn 一次（进程级
//      去重）/ 非 stale 抛错逐次 warn（不吞真实异常）/ 抛错不冒泡。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import {
  bestEffortPiCall,
  isPiStaleCtxError,
  PI_STALE_CTX_MARKER,
} from "../assembly/best-effort.ts";

beforeEach(() => {
  loggerMock.warn.mockClear();
  loggerMock.debug.mockClear();
  loggerMock.error.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPiStaleCtxError（PS-30 包内分诊）", () => {
  it("命中：错误文案含 stale after session replacement", () => {
    expect(
      isPiStaleCtxError(
        new Error(
          "This extension ctx is stale after session replacement or reload. Do not use a captured pi.",
        ),
      ),
    ).toBe(true);
  });

  it("不命中：其他错误 / 非 Error 值", () => {
    expect(isPiStaleCtxError(new Error("some other failure"))).toBe(false);
    expect(isPiStaleCtxError("stale after session replacement")).toBe(false); // 非 Error 的字符串
    expect(isPiStaleCtxError(undefined)).toBe(false);
  });

  it("标记值与 ext-guards STALE_CTX_MARKER 同值（PS-30 双侧锁定）", () => {
    expect(PI_STALE_CTX_MARKER).toBe("stale after session replacement");
  });
});

describe("bestEffortPiCall", () => {
  it("pi 不在场（null/undefined）→ no-op，call 不执行", () => {
    const call = vi.fn();
    bestEffortPiCall(null, "ctx-a", call);
    bestEffortPiCall(undefined, "ctx-a", call);
    expect(call).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("正常调用透传（拿到非空句柄）且无留痕", () => {
    const pi = { appendEntry: vi.fn() };
    bestEffortPiCall(pi, "ctx-b", (active) => {
      active.appendEntry("t", { x: 1 });
    });
    expect(pi.appendEntry).toHaveBeenCalledWith("t", { x: 1 });
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("stale 抛错：warn 留痕一次（进程级去重），后续 stale 静默，异常不冒泡", () => {
    const staleErr = new Error(`ctx ${PI_STALE_CTX_MARKER}`);
    const call = vi.fn(() => {
      throw staleErr;
    });
    expect(() => bestEffortPiCall({}, "ctx-c", call)).not.toThrow();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const first = String(loggerMock.warn.mock.calls[0]?.[0]);
    expect(first).toContain("pi ctx stale after session replacement");
    expect(first).toContain("ctx-c");
    expect(first).toContain("recovery: none required");

    // 第二次 stale：去重静默（不刷屏），仍不冒泡。
    expect(() => bestEffortPiCall({}, "ctx-c2", call)).not.toThrow();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it("非 stale 抛错：逐次 warn 留痕（含 context 与错误信息），不吞真实异常信号", () => {
    let n = 0;
    const call = vi.fn(() => {
      n += 1;
      throw new Error(`boom-${n}`);
    });
    expect(() => bestEffortPiCall({}, "ctx-d", call)).not.toThrow();
    expect(() => bestEffortPiCall({}, "ctx-d", call)).not.toThrow();
    expect(loggerMock.warn).toHaveBeenCalledTimes(2);
    expect(String(loggerMock.warn.mock.calls[0]?.[0])).toContain("best-effort pi call failed (ctx-d): boom-1");
    expect(String(loggerMock.warn.mock.calls[1]?.[0])).toContain("boom-2");
  });

  it("rethrowNonStale：stale 照吞（去重后静默），非 stale 原样重抛（失败传播契约写点）", () => {
    const warnCountBefore = loggerMock.warn.mock.calls.length;
    const staleErr = new Error(`ctx ${PI_STALE_CTX_MARKER}`);
    // stale 类照吞（本文件前序用例已触发进程级去重 → 此处静默，warn 计数不增长）。
    expect(() =>
      bestEffortPiCall({}, "ctx-e", () => {
        throw staleErr;
      }, { rethrowNonStale: true }),
    ).not.toThrow();
    expect(loggerMock.warn.mock.calls.length).toBe(warnCountBefore);

    const realErr = new Error("append entry failed (disk full)");
    expect(() =>
      bestEffortPiCall({}, "ctx-e", () => {
        throw realErr;
      }, { rethrowNonStale: true }),
    ).toThrowError(realErr);
    // 非 stale 重抛路径不走留痕（上游围栏负责）。
    expect(loggerMock.warn.mock.calls.length).toBe(warnCountBefore);
  });
});
