// src/__tests__/ui-request-observability.test.ts
//
// M4 测试：ui-request-observability.ts — UiRequestObservability 纯逻辑类。
//
// 测试对象：packages/subagent-core/src/execution/ui/ui-request-observability.ts
// 契约来源：类注释（setMode/getMode 往返）
//
// UiRequestObservability 职责：
//   - setMode/getMode：sessionMode 往返存储
//
// 纯逻辑无异步，测试最简单。

import { describe, expect, it } from "vitest";

import { UiRequestObservability } from "../ui/ui-request-observability.ts";

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
