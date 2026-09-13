// src/__tests__/host-mode.test.ts
//
// W1 红灯测试：host-mode.ts 主进程运行模式分类工具。
//
// 测试对象：extensions/universal/subagent-workflow/src/execution/host-mode.ts（新建）
// 契约来源：.fix-plans/00-master-summary.md §一 冲突 4 + §2.5（W4 守卫消费点）
//
// 三个导出：
//   - resolveHostMode(mode): ExtensionMode | undefined → "tui" | "gui" | "headless"
//   - willRespondToAskUser(mode): boolean（tui/gui → true，headless → false）
//   - hasInteractiveUI(mode): boolean（非 headless → true）
//
// 红灯原因：host-mode.ts 尚未创建，import 失败。

import { describe, expect, it } from "vitest";

import {
  hasInteractiveUI,
  resolveHostMode,
  willRespondToAskUser,
} from "../assembly/host-mode.ts";

describe("resolveHostMode — ExtensionMode 聚合为 HostMode", () => {
  it('"tui" → "tui"（纯 Pi TUI，ctx.ui.custom 可用）', () => {
    expect(resolveHostMode("tui")).toBe("tui");
  });

  it('"rpc" → "gui"（xyz-agent GUI，sidecar 通道）', () => {
    expect(resolveHostMode("rpc")).toBe("gui");
  });

  it('"json" → "headless"（无交互通道）', () => {
    expect(resolveHostMode("json")).toBe("headless");
  });

  it('"print" → "headless"（无交互通道）', () => {
    expect(resolveHostMode("print")).toBe("headless");
  });

  it('undefined → "headless"（向后兼容：mode 未穿透时按 headless）', () => {
    expect(resolveHostMode(undefined)).toBe("headless");
  });
});

describe("willRespondToAskUser — 主进程是否响应子进程 ask_user", () => {
  it("tui → true（冲突 3 裁决：TUI 必须注入 handler）", () => {
    expect(willRespondToAskUser("tui")).toBe(true);
  });

  it("rpc → true（GUI 透传所有 UI）", () => {
    expect(willRespondToAskUser("rpc")).toBe(true);
  });

  it("json → false（headless 无 UI 通道）", () => {
    expect(willRespondToAskUser("json")).toBe(false);
  });

  it("print → false（headless 无 UI 通道）", () => {
    expect(willRespondToAskUser("print")).toBe(false);
  });

  it("undefined → false（向后兼容）", () => {
    expect(willRespondToAskUser(undefined)).toBe(false);
  });
});

describe("hasInteractiveUI — 是否有交互 UI 通道", () => {
  it("tui → true", () => {
    expect(hasInteractiveUI("tui")).toBe(true);
  });

  it("rpc → true", () => {
    expect(hasInteractiveUI("rpc")).toBe(true);
  });

  it("json → false", () => {
    expect(hasInteractiveUI("json")).toBe(false);
  });

  it("print → false", () => {
    expect(hasInteractiveUI("print")).toBe(false);
  });

  it("undefined → false", () => {
    expect(hasInteractiveUI(undefined)).toBe(false);
  });
});
