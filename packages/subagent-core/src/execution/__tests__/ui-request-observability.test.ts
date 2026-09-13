// src/__tests__/ui-request-observability.test.ts
//
// M4 测试：ui-request-observability.ts — UiRequestObservability 纯逻辑类。
//
// 测试对象：extensions/universal/subagent-workflow/src/execution/ui-request-observability.ts
// 契约来源：类注释（per-session 去重 + resetMissingHandlerWarnings 清洗 + setMode/getMode 往返）
//
// UiRequestObservability 职责：
//   - setMode/getMode：sessionMode 往返存储
//   - notifyMissingHandler(sessionId)：per-session 去重，每 session 只 console.warn 一次
//   - resetMissingHandlerWarnings()：清去重集合，清洗后可重新 warn
//
// 纯逻辑无异步，测试最简单。console.warn spy 验证调用次数。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock 共享 logger，让 logger.warn 可被 spy（源码已从 console.warn 改为 logger.warn）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

import { UiRequestObservability } from "../ui/ui-request-observability.ts";

// ── 公共 fixture ──────────────────────────────────────────────

beforeEach(() => {
  loggerMock.warn.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UiRequestObservability — setMode/getMode 往返", () => {
  it("setMode('tui') → getMode() === 'tui'", () => {
    const obs = new UiRequestObservability();
    obs.setMode("tui");
    expect(obs.getMode()).toBe("tui");
  });

  it("setMode('rpc') → getMode() === 'rpc'", () => {
    const obs = new UiRequestObservability();
    obs.setMode("rpc");
    expect(obs.getMode()).toBe("rpc");
  });

  it("初始 getMode() === undefined（未 set）", () => {
    const obs = new UiRequestObservability();
    expect(obs.getMode()).toBeUndefined();
  });

  it("setMode(undefined) → getMode() === undefined（可重置）", () => {
    const obs = new UiRequestObservability();
    obs.setMode("json");
    obs.setMode(undefined);
    expect(obs.getMode()).toBeUndefined();
  });
});

describe("UiRequestObservability — notifyMissingHandler per-session 去重", () => {
  it("同 sessionId 调两次 → 只 warn 一次", () => {
    const obs = new UiRequestObservability();
    obs.notifyMissingHandler("s1");
    obs.notifyMissingHandler("s1");
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it("warn 内容含 sessionId 和 mode（可观测性）", () => {
    const obs = new UiRequestObservability();
    obs.setMode("tui");
    obs.notifyMissingHandler("s1");
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("session=s1"),
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("mode=tui"),
    );
  });
});

describe("UiRequestObservability — resetMissingHandlerWarnings 后可重新 warn", () => {
  it("notify(s1) → reset → notify(s1) → warn 被调 2 次", () => {
    const obs = new UiRequestObservability();
    obs.notifyMissingHandler("s1");
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);

    obs.resetMissingHandlerWarnings();

    obs.notifyMissingHandler("s1");
    expect(loggerMock.warn).toHaveBeenCalledTimes(2);
  });
});

describe("UiRequestObservability — 不同 session 各自首次 warn", () => {
  it("notify(s1) + notify(s2) → warn 被调 2 次（互不干扰）", () => {
    const obs = new UiRequestObservability();
    obs.notifyMissingHandler("s1");
    obs.notifyMissingHandler("s2");
    expect(loggerMock.warn).toHaveBeenCalledTimes(2);

    // 再次各自调用，已被去重，不再 warn
    obs.notifyMissingHandler("s1");
    obs.notifyMissingHandler("s2");
    expect(loggerMock.warn).toHaveBeenCalledTimes(2);
  });
});
