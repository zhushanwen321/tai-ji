// src/__tests__/ui-channels.test.ts
//
// W1 红灯测试：ui-channels.ts — channel 提取（marker 解析）+ channel 注册表。
//
// 测试对象：extensions/universal/subagent-workflow/src/execution/ui-channels.ts（新建）
// 契约来源：.fix-plans/00-master-summary.md §一 冲突 2「维度 2：channel 注册表」
//
// parseChannel(req): ExtensionUiRequest → { channel?, channelPayload? }
//   - select → 从 title 解析 NUL 前缀（parseFromMarkerString）
//   - setWidget → 从 widgetLines[0] 解析 NUL 前缀（parseFromMarkerArray）
//   - 其他 method → {}（无 channel）
//
// marker 格式：\0<UPPER_CASE_ID>[:]<JSON-payload?>
//   - ASK_USER_MARKER = "\0XYZ_ASK_USER"，payload 在 options[0]
//   - GUI_WIDGET_MARKER = "\0XYZ_GUI_WIDGET:" + JSON，payload 在同行
// channel 名规范化：去 "XYZ_" 前缀，小写化（XYZ_ASK_USER → ask_user）
//
// UiChannelRegistry:
//   - register(channel, handler) / resolve(channel) / list()
//
// 边界：无 NUL 前缀 → {}；JSON parse 失败 → {}（不抛）；字段缺失 → {}
//
// 红灯原因：ui-channels.ts 尚未创建，import 失败。

import { describe, expect, it, vi } from "vitest";

import {
  createUiChannelRegistry,
  type ExtensionUiRequestLike,
  parseChannel,
} from "../ui/ui-channels.ts";

// ── 测试 fixture 构造助手 ────────────────────────────────────
// ExtensionUiRequestLike 是 parseChannel 入参的最小形状（method + 对应字段）。

function selectReq(title: string, options?: string[]): ExtensionUiRequestLike {
  return { method: "select", title, options };
}

function setWidgetReq(widgetKey: string, widgetLines: string[] | undefined): ExtensionUiRequestLike {
  return { method: "setWidget", widgetKey, widgetLines };
}

// ── ASK_USER_MARKER 样本（真实 Pi 协议格式） ─────────────────
// title = "\0XYZ_ASK_USER"，options[0] = JSON.stringify({questions, allowCancel})
const ASK_USER_MARKER = "\0XYZ_ASK_USER";
const askUserPayload = {
  questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
  allowCancel: true,
};

// ── GUI_WIDGET_MARKER 样本（真实 Pi 协议格式） ───────────────
// widgetLines[0] = "\0XYZ_GUI_WIDGET:" + JSON.stringify({component:{...}})
const GUI_WIDGET_MARKER_PREFIX = "\0XYZ_GUI_WIDGET:";
const guiWidgetPayload = { component: { name: "StatusCard", props: { ok: true } } };

describe("parseChannel — select method（从 title 解析 NUL 前缀）", () => {
  it("title 含 ASK_USER_MARKER → channel='ask_user' + payload 从 options[0] 解析", () => {
    const req = selectReq(ASK_USER_MARKER, [JSON.stringify(askUserPayload)]);
    const result = parseChannel(req);
    expect(result.channel).toBe("ask_user");
    expect(result.channelPayload).toEqual(askUserPayload);
  });

  it("title 无 NUL 前缀 → {}（普通 select，无 channel）", () => {
    const req = selectReq("Choose a plan", ["basic", "pro"]);
    const result = parseChannel(req);
    expect(result.channel).toBeUndefined();
    expect(result.channelPayload).toBeUndefined();
  });

  it("title 含 marker 但 options 缺失 → channel 解析但 payload undefined", () => {
    // marker 在 title，但 options 为空 → channel 名仍可提取，payload 无来源
    const req = selectReq(ASK_USER_MARKER);
    const result = parseChannel(req);
    expect(result.channel).toBe("ask_user");
  });
});

describe("parseChannel — setWidget method（从 widgetLines[0] 解析 NUL 前缀）", () => {
  it("widgetLines[0] 含 GUI_WIDGET_MARKER → channel='gui_widget' + payload", () => {
    const req = setWidgetReq("w1", [GUI_WIDGET_MARKER_PREFIX + JSON.stringify(guiWidgetPayload)]);
    const result = parseChannel(req);
    expect(result.channel).toBe("gui_widget");
    expect(result.channelPayload).toEqual(guiWidgetPayload);
  });

  it("widgetLines 无 NUL 前缀 → {}（普通 setWidget）", () => {
    const req = setWidgetReq("w1", ["plain content line"]);
    const result = parseChannel(req);
    expect(result.channel).toBeUndefined();
  });

  it("widgetLines 为 undefined → {}", () => {
    const req = setWidgetReq("w1", undefined);
    const result = parseChannel(req);
    expect(result.channel).toBeUndefined();
  });

  it("widgetLines 为空数组 → {}", () => {
    const req = setWidgetReq("w1", []);
    const result = parseChannel(req);
    expect(result.channel).toBeUndefined();
  });
});

describe("parseChannel — 其他 method（无 channel 提取位置）", () => {
  it("confirm → {}", () => {
    const result = parseChannel({ method: "confirm", title: "t", message: "m" });
    expect(result.channel).toBeUndefined();
  });

  it("input → {}", () => {
    const result = parseChannel({ method: "input", title: "t" });
    expect(result.channel).toBeUndefined();
  });

  it("notify → {}", () => {
    const result = parseChannel({ method: "notify", message: "hi" });
    expect(result.channel).toBeUndefined();
  });
});

describe("parseChannel — channel 名规范化规则", () => {
  it("去 XYZ_ 命名空间前缀 + 小写化（XYZ_ASK_USER → ask_user）", () => {
    const req = selectReq("\0XYZ_ASK_USER", [JSON.stringify({ x: 1 })]);
    expect(parseChannel(req).channel).toBe("ask_user");
  });

  it("XYZ_GUI_WIDGET: 带冒号后缀 → gui_widget（去前缀 + 去冒号 + 小写）", () => {
    const req = setWidgetReq("k", ["\0XYZ_GUI_WIDGET:" + JSON.stringify({ y: 2 })]);
    expect(parseChannel(req).channel).toBe("gui_widget");
  });
});

describe("parseChannel — 边界（不抛错）", () => {
  it("marker 后 payload 非法 JSON → 不抛错，channel 仍解析（payload undefined）", () => {
    const req = selectReq(ASK_USER_MARKER, ["not-valid-json{"]);
    expect(() => parseChannel(req)).not.toThrow();
    const result = parseChannel(req);
    expect(result.channel).toBe("ask_user");
  });

  it("GUI_WIDGET_MARKER 后非法 JSON → 不抛错", () => {
    const req = setWidgetReq("k", [GUI_WIDGET_MARKER_PREFIX + "broken{json"]);
    expect(() => parseChannel(req)).not.toThrow();
  });
});

// ── UiChannelRegistry ────────────────────────────────────────

describe("UiChannelRegistry — 注册 + 解析 + 列举", () => {
  it("register 后 resolve 返回注册的 handler", () => {
    const registry = createUiChannelRegistry();
    const handler = vi.fn();
    registry.register("ask_user", handler);
    expect(registry.resolve("ask_user")).toBe(handler);
  });

  it("未注册的 channel resolve 返回 undefined", () => {
    const registry = createUiChannelRegistry();
    expect(registry.resolve("unknown")).toBeUndefined();
  });

  it("list 返回所有已注册 channel 名", () => {
    const registry = createUiChannelRegistry();
    registry.register("ask_user", vi.fn());
    registry.register("gui_widget", vi.fn());
    const names = registry.list().sort();
    expect(names).toEqual(["ask_user", "gui_widget"]);
  });

  it("list 空注册表返回 []", () => {
    const registry = createUiChannelRegistry();
    expect(registry.list()).toEqual([]);
  });

  it("重复 register 同名 channel 覆盖旧 handler", () => {
    const registry = createUiChannelRegistry();
    const old = vi.fn();
    const fresh = vi.fn();
    registry.register("ask_user", old);
    registry.register("ask_user", fresh);
    expect(registry.resolve("ask_user")).toBe(fresh);
    expect(registry.list()).toEqual(["ask_user"]);
  });
});
