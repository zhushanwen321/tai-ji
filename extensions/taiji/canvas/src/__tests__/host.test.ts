// host.test.ts —— 宿主检测真值表（设计：env 信号 + ctx.mode === "rpc" 完整谓词；
// 非 taiji GUI 宿主不进入 select）。

import { describe, expect, it } from "vitest";

import { hostGateError, isTaijiGuiHost, isTaijiHost } from "../host.js";
import { withExtLogEnv } from "./helpers/canvas-harness.js";

describe("isTaijiHost / isTaijiGuiHost", () => {
  it("env 信号缺失 = 非宿主（mode 无关）", () =>
    withExtLogEnv(undefined, () => {
      expect(isTaijiHost()).toBe(false);
      expect(isTaijiGuiHost({ mode: "rpc" })).toBe(false);
    }));

  it("env=1 但 mode 非 rpc（TUI / json / print）= 非 GUI 宿主（env 泄漏形态，禁入 select）", () =>
    withExtLogEnv("1", () => {
      expect(isTaijiHost()).toBe(true);
      expect(isTaijiGuiHost({ mode: "tui" })).toBe(false);
      expect(isTaijiGuiHost({ mode: "json" })).toBe(false);
      expect(isTaijiGuiHost({ mode: "print" })).toBe(false);
    }));

  it("env=1 + rpc = taiji GUI 宿主", () =>
    withExtLogEnv("1", () => {
      expect(isTaijiGuiHost({ mode: "rpc" })).toBe(true);
    }));

  it("env 非 '1' 值 = 非宿主（严格等值判定）", () =>
    withExtLogEnv("0", () => {
      expect(isTaijiHost()).toBe(false);
    }));
});

describe("hostGateError", () => {
  it("结构化错误含「画布需要 taiji 宿主」与恢复动作", () => {
    const err = hostGateError();
    expect(err.message).toContain("画布需要 taiji 宿主");
    expect(err.message).toContain("恢复动作");
  });
});
