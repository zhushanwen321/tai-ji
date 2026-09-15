// src/execution/__tests__/config-collect-sync.test.ts
//
// collectSync 节 sanitize（E5）测试（subagent-sync-collect U1 foundation）。
// E5（设计 §3.1.5）：config 坏值（负数/非枚举/坏类型）逐字段回默认，不炸启动，
// 与 maxConcurrent sanitize 同判（正整数/枚举成员校验）。
//
// 纯函数测试：无文件 IO、无 timer 依赖——不触真实数据目录（红线）。

import { describe, expect, it, vi, beforeEach } from "vitest";

// logger mock（D6 #8 坏值 warn 断言；config.test.ts 同款拦 getLogger）
const loggerMock = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { DEFAULT_COLLECT_SYNC, DEFAULT_CONFIG, sanitizeCollectSync } from "../assembly/config.ts";

beforeEach(() => {
  loggerMock.warn.mockClear();
});

// ============================================================
// 权威默认值
// ============================================================

describe("DEFAULT_COLLECT_SYNC", () => {
  it("matches the design defaults (async / 4000 / 24000)", () => {
    expect(DEFAULT_COLLECT_SYNC).toEqual({
      default: "async",
      perItemChars: 4000,
      totalChars: 24000,
    });
  });

  it("DEFAULT_CONFIG omits collectSync (缺省键缺失：startupConfig 声明守护保持绿，消费方 ?? 兜底)", () => {
    expect(DEFAULT_CONFIG.collectSync).toBeUndefined();
  });
});

// ============================================================
// sanitizeCollectSync（E5）
// ============================================================

describe("sanitizeCollectSync (E5)", () => {
  it("passes a fully valid node through", () => {
    expect(
      sanitizeCollectSync({ default: "sync", perItemChars: 8000, totalChars: 48000 }),
    ).toEqual({ default: "sync", perItemChars: 8000, totalChars: 48000 });
  });

  it("fills per-field defaults for a partial node (部分覆盖合法)", () => {
    expect(sanitizeCollectSync({ default: "sync" })).toEqual({
      default: "sync",
      perItemChars: 4000,
      totalChars: 24000,
    });
    expect(sanitizeCollectSync({ totalChars: 12000 })).toEqual({
      default: "async",
      perItemChars: 4000,
      totalChars: 12000,
    });
  });

  it("returns undefined for a missing node (消费方读 DEFAULT_COLLECT_SYNC 兜底)", () => {
    expect(sanitizeCollectSync(undefined)).toBeUndefined();
  });

  it("falls back to default for non-enum collectSync.default values (E5 非枚举)", () => {
    for (const bad of ["immediate", "SYNC", "batch", 1, 0, true, null]) {
      expect(sanitizeCollectSync({ default: bad })?.default).toBe("async");
    }
  });

  it("accepts both enum members", () => {
    expect(sanitizeCollectSync({ default: "sync" })?.default).toBe("sync");
    expect(sanitizeCollectSync({ default: "async" })?.default).toBe("async");
  });

  it("falls back to default for negative/zero/fraction/non-numeric budgets (E5 负数)", () => {
    for (const bad of [-1, 0, -4000, 1.5, "4000", null]) {
      expect(sanitizeCollectSync({ perItemChars: bad })?.perItemChars).toBe(4000);
      expect(sanitizeCollectSync({ totalChars: bad })?.totalChars).toBe(24000);
    }
    expect(sanitizeCollectSync({ perItemChars: Number.NaN })?.perItemChars).toBe(4000);
    expect(sanitizeCollectSync({ perItemChars: Number.POSITIVE_INFINITY })?.perItemChars).toBe(4000);
  });

  it("returns undefined for non-object scalar nodes (E5 坏类型)", () => {
    for (const bad of [null, 42, "sync", true]) {
      expect(sanitizeCollectSync(bad)).toBeUndefined();
    }
  });

  it("treats an array node as an object with all-bad fields (whole-defaults)", () => {
    expect(sanitizeCollectSync([])).toEqual(DEFAULT_COLLECT_SYNC);
  });

  it("never throws on arbitrary garbage (E5 不炸启动)", () => {
    expect(() =>
      sanitizeCollectSync({ default: Symbol("x"), perItemChars: {}, totalChars: NaN }),
    ).not.toThrow();
  });

  it("D6 #8：显式坏值字段回默认时 warn 一条（含字段名与原值）；缺省字段不 warn", () => {
    // 全好字段（含合法部分覆盖）→ 零 warn
    sanitizeCollectSync({ default: "sync", perItemChars: 8000 });
    expect(loggerMock.warn).not.toHaveBeenCalled();

    // 显式坏值（default 非枚举 + totalChars 负数）→ 一条 warn 列出两个坏字段
    sanitizeCollectSync({ default: "immediate", perItemChars: 8000, totalChars: -5 });
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '[subagents] config collectSync invalid field(s) reverted to defaults: default="immediate", totalChars=-5',
    );

    // 缺省字段（部分覆盖）不算坏值——warn 计数不增
    loggerMock.warn.mockClear();
    sanitizeCollectSync({ perItemChars: 4000 });
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
