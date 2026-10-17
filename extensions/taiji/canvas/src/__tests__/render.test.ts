// render.test.ts —— canvas 六工具共用 renderResult（pi TUI 侧）：折叠态一行摘要
// （details.summary，dim 染色）、展开态回原始 content 文本、无摘要异常形态回退。

import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { renderCanvasToolResult } from "../render.js";

// mock theme（fg 直通，便于断言纯文本；todo render.test.ts 同款）
const mockTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function renderedText(result: unknown, expanded: boolean): string {
  return renderCanvasToolResult(result, { expanded }, mockTheme).render(400).join("\n");
}

describe("renderCanvasToolResult", () => {
  it("折叠态（expanded=false）：渲染 details.summary 一行摘要，不含原始 JSON", () => {
    const result = {
      content: [{ type: "text", text: '{"canvases":[{"canvasId":"c1"}]}' }],
      details: { summary: "Listed 1 canvases" },
    };
    const out = renderedText(result, false);
    expect(out).toContain("Listed 1 canvases");
    expect(out).not.toContain("canvasId");
  });

  it("展开态（expanded=true）：渲染 content[0] 原始文本，不含摘要", () => {
    const result = {
      content: [{ type: "text", text: '{"canvases":[{"canvasId":"c1"}]}' }],
      details: { summary: "Listed 1 canvases" },
    };
    const out = renderedText(result, true);
    expect(out).toContain('{"canvases":[{"canvasId":"c1"}]}');
    expect(out).not.toContain("Listed 1 canvases");
  });

  it("折叠态但 details 缺失（异常形态）→ 回退 content 文本", () => {
    const result = { content: [{ type: "text", text: "raw payload" }] };
    expect(renderedText(result, false)).toContain("raw payload");
  });

  it("折叠态但 summary 非字符串 / 空串 → 回退 content 文本", () => {
    const base = { content: [{ type: "text", text: "raw payload" }] };
    expect(renderedText({ ...base, details: { summary: 42 } }, false)).toContain("raw payload");
    expect(renderedText({ ...base, details: { summary: "" } }, false)).toContain("raw payload");
  });

  it("六工具注册的 renderResult 行为一致（共用 renderCanvasToolResult，经 harness 抽查两个工具）", async () => {
    const { mountCanvas, toolOf } = await import("./helpers/canvas-harness.js");
    const harness = mountCanvas();
    const enter = toolOf(harness, "canvas_enter");
    const list = toolOf(harness, "canvas_list");
    expect(typeof enter.renderResult).toBe("function");
    expect(typeof list.renderResult).toBe("function");
    // 抽查经工具 handler 的折叠态渲染（handler 是各 registerTool 的方法包装，
    // 共用同一渲染内核；类型桩：theme 直通）
    type RenderFn = (r: unknown, o: { expanded: boolean }, t: unknown) => { render: (w: number) => string[] };
    const render = (fn: unknown, result: unknown) =>
      (fn as RenderFn)(result, { expanded: false }, mockTheme).render(400).join("\n");
    const sample = { content: [{ type: "text", text: "raw" }], details: { summary: 'Entered canvas "n"' } };
    expect(render(enter.renderResult, sample)).toContain('Entered canvas "n"');
    expect(render(list.renderResult, sample)).toContain('Entered canvas "n"');
  });
});
