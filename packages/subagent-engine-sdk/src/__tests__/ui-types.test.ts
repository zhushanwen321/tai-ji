// src/__tests__/ui-types.test.ts
//
// isUiResponse 四成员判别守卫（ui-types.ts，S7 修复引入）：引擎侧应答落位前
// 防宿主畸形帧静默流入 UI 队列。覆盖合法四形态（value/confirmed/cancelled/ack）
// 与非法形态（非 object/null、类型不符、字面量不符），对齐消费方
// packages/pi-subagent-cli/src/server.ts 的守卫语义。

import { isUiResponse } from "../ui-types.ts";
import { describe, expect, it } from "vitest";

describe("isUiResponse", () => {
  it("accepts { value: string } (select/input/editor answer)", () => {
    expect(isUiResponse({ value: "x" })).toBe(true);
  });

  it("accepts { confirmed: boolean } (confirm answer)", () => {
    expect(isUiResponse({ confirmed: true })).toBe(true);
  });

  it("accepts { cancelled: true } (cancel)", () => {
    expect(isUiResponse({ cancelled: true })).toBe(true);
  });

  it("accepts { ack: true } (fire-and-forget)", () => {
    expect(isUiResponse({ ack: true })).toBe(true);
  });

  it("rejects null", () => {
    expect(isUiResponse(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isUiResponse(undefined)).toBe(false);
  });

  it("rejects bare string", () => {
    expect(isUiResponse("value")).toBe(false);
  });

  it("rejects number", () => {
    expect(isUiResponse(42)).toBe(false);
  });

  it("rejects empty object (no member matches)", () => {
    expect(isUiResponse({})).toBe(false);
  });

  it("rejects { value: number } (type mismatch)", () => {
    expect(isUiResponse({ value: 42 })).toBe(false);
  });

  it("rejects { cancelled: false } (literal mismatch)", () => {
    expect(isUiResponse({ cancelled: false })).toBe(false);
  });
});
