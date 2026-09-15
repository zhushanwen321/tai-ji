// src/__tests__/ui-interaction-model.test.ts
//
// W1 红灯测试：ui-interaction-model.ts — method 交互模型分类。
//
// 测试对象：extensions/universal/subagent-workflow/src/execution/ui-interaction-model.ts（新建）
// 契约来源：.fix-plans/00-master-summary.md §一 冲突 2「维度 1：透传判定规则」
//
// isDialogMethod(method):
//   - dialog（占输入焦点，等响应，需透传+排队）：select / confirm / input / editor → true
//   - fire-and-forget（纯展示/写入，不等响应）：notify / setStatus / setWidget /
//     setTitle / set_editor_text / 未知 method → false
//
// 红灯原因：ui-interaction-model.ts 尚未创建，import 失败。

import { describe, expect, it } from "vitest";

import { isDialogMethod } from "../ui/ui-interaction-model.ts";

describe("isDialogMethod — dialog 类 method（占输入焦点）", () => {
  it("select → true（含 ask_user channel 借道 select）", () => {
    expect(isDialogMethod("select")).toBe(true);
  });

  it("confirm → true", () => {
    expect(isDialogMethod("confirm")).toBe(true);
  });

  it("input → true", () => {
    expect(isDialogMethod("input")).toBe(true);
  });

  it("editor → true", () => {
    expect(isDialogMethod("editor")).toBe(true);
  });
});

describe("isDialogMethod — fire-and-forget 类 method（纯展示/写入）", () => {
  it("notify → false", () => {
    expect(isDialogMethod("notify")).toBe(false);
  });

  it("setStatus → false", () => {
    expect(isDialogMethod("setStatus")).toBe(false);
  });

  it("setWidget → false（含 gui_widget channel 借道 setWidget）", () => {
    expect(isDialogMethod("setWidget")).toBe(false);
  });

  it("setTitle → false", () => {
    expect(isDialogMethod("setTitle")).toBe(false);
  });

  it("set_editor_text → false", () => {
    expect(isDialogMethod("set_editor_text")).toBe(false);
  });
});

describe("isDialogMethod — 未知 method 默认 fire-and-forget", () => {
  it("未知 method 名 → false（未来 Pi 新增 method 不误判为 dialog）", () => {
    expect(isDialogMethod("some_future_method")).toBe(false);
  });

  it("空字符串 → false", () => {
    expect(isDialogMethod("")).toBe(false);
  });
});
