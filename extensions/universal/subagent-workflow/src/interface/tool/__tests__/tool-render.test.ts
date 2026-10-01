// src/interface/__tests__/tool-render.test.ts
//
// renderSubagentCall 行为测试：拍平后从顶层 args 提取 agent/slug/task。
//
// 背景：wave 3 flatten 把 task/slug/agent 等 13 字段从 args.startParam 嵌套层
// 移到 args 顶层。renderSubagentCall 的提取逻辑跟着改了，但之前无行为测试覆盖
// （sdk-contract.test.ts 只断言 renderCall 是 function，不断言行为）。此测试
// 锁住「拍平形态的 args 能被 renderSubagentCall 正确提取」——若有人改回
// args.startParam 路径，测试立即红。
//
// 不走 registerSubagentTool 注册路径——renderSubagentCall 是纯函数，直接 import
// 测试，避免 mock pi-ai/typebox/pi-tui 整条链。

import { describe, expect, it } from "vitest";

import type { Component } from "@earendil-works/pi-tui";

import { type RenderContext, renderSubagentCall, renderSubagentResult } from "../tool-render.ts";

// ── 最小 ThemeLike stub ──
// renderSubagentCall 只用 theme.fg/bold/dim（都是 (token, text) => string）。
// 不依赖真实 pi-tui 着色——我们只断言提取出的字符串出现在结果里。
function makeTheme(): {
  fg(color: string, text: string): string;
  bold(text: string): string;
} {
  return {
    // 把 token 作为 [token:...] 包裹器返回，便于断言时不依赖颜色映射。
    fg: (_color, text) => `<${_color}>${text}</${_color}>`,
    bold: (text) => `<b>${text}</b>`,
  };
}

// Text.render() 是 pi-tui 的方法。tool-render 返回 new Text(parts.join(""), 0, 0)。
// 测试只关心 parts.join("") 的文本内容——用反射取构造时传入的字符串。
// Component 类型在 pi-tui 中是 opaque，这里用最小的反射 helper。
function renderText(component: Component): string {
  // Text 实例在 pi-tui v0.x 把构造首参存为 .text 或私有字段；
  // 通过遍历可枚举属性找到首个 string 字段（绕过具体字段名差异）。
  const obj = component as unknown as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

const CTX: RenderContext = {
  invalidate: () => {},
};

describe("renderSubagentCall — 拍平形态提取（regression for wave 3 flatten）", () => {
  it("从顶层 args 提取 agent（默认 general-purpose）", () => {
    const out = renderText(renderSubagentCall(
      { action: "start", task: "do stuff", slug: "x" },
      makeTheme() as never,
      CTX,
    ));
    // 默认 agent 名（DEFAULT_AGENT_NAME）出现在结果里
    expect(out).toContain("general-purpose");
  });

  it("从顶层 args 提取显式 agent 名", () => {
    const out = renderText(renderSubagentCall(
      { action: "start", agent: "coder", task: "do stuff", slug: "x" },
      makeTheme() as never,
      CTX,
    ));
    expect(out).toContain("coder");
  });

  it("从顶层 args 提取 slug 并在 agent 后展示", () => {
    const out = renderText(renderSubagentCall(
      { action: "start", agent: "coder", task: "do stuff", slug: "fix-login" },
      makeTheme() as never,
      CTX,
    ));
    expect(out).toContain("coder");
    expect(out).toContain("fix-login");
  });

  it("task 不再渲染为 preview 行（标题块只有单行）", () => {
    const out = renderText(renderSubagentCall(
      { action: "start", agent: "coder", task: "Analyze the bug in parser", slug: "fix-parser" },
      makeTheme() as never,
      CTX,
    ));
    // task 预览行已移除——task 内容不进对话流（完整 task 在 /subagents 详情可见）
    expect(out).not.toContain("Analyze the bug in parser");
    expect(out).not.toContain("\n");
  });

  it("task 含换行时不进渲染（无 preview 泄漏）", () => {
    const out = renderText(renderSubagentCall(
      { action: "start", task: "first line\nsecond line", slug: "x" },
      makeTheme() as never,
      CTX,
    ));
    expect(out).not.toContain("first line");
    expect(out).not.toContain("second line");
    expect(out).not.toContain("\n");
  });

  // 关键回归：若有人把提取路径改回 args.startParam，这些顶层调用都会失败
  // （agent/slug 取不到，全用默认值）。此测试用顶层数据形态锁住 flatten。
  // task 不在断言里——task 已不渲染（上方用例锁定）。
  it("REGRESSION: 顶层 args 形态完整提取（防止回退到 startParam envelope）", () => {
    const out = renderText(renderSubagentCall(
      { action: "start", agent: "researcher", task: "search docs", slug: "search-docs" },
      makeTheme() as never,
      CTX,
    ));
    // agent + slug 都应被提取（默认值 fallback 也能过单字段断言，但同时命中的
    // 概率只有联合 fallback 才有——researcher/search-docs 都不是默认值）
    expect(out).toContain("researcher");
    expect(out).toContain("search-docs");
  });

  it("args 缺所有字段时不崩（最防御）", () => {
    expect(() => renderSubagentCall({}, makeTheme() as never, CTX)).not.toThrow();
    expect(() => renderSubagentCall(undefined, makeTheme() as never, CTX)).not.toThrow();
  });
});

// ============================================================
// renderSubagentResult — expanded / compact 分支等价（字节级回归锁）
// ============================================================
//
// buildExpandedLines 收敛为「compact + list/fork-from 特例」后的守卫：cancel /
// start(bg) 分支的 expanded 输出必须与 compact 逐字节相同（同一 render 宽度下
// 的完整字符串数组相等）；list / fork-from 的既有差异（session 行追加 / 源文件
// 完整路径 vs basename）锁住不被收敛误伤。

/** renderSubagentResult 的 result 入参形态（经函数签名推导，不依赖 mock 类型桩）。 */
type RenderResultInput = Parameters<typeof renderSubagentResult>[0];

/** 字节级比较用的渲染宽度（大于全部用例行宽，规避 truncLine 截断差异）。 */
const BYTE_LOCK_WIDTH = 160;

function renderBoth(details: unknown): { compact: string[]; expanded: string[] } {
  const result = { content: [{ type: "text", text: "{}" }], details } as RenderResultInput;
  const theme = makeTheme() as never;
  const compact = renderSubagentResult(
    result,
    { expanded: false, isPartial: false },
    theme,
    CTX,
  ).render(BYTE_LOCK_WIDTH);
  const expanded = renderSubagentResult(
    result,
    { expanded: true, isPartial: false },
    theme,
    CTX,
  ).render(BYTE_LOCK_WIDTH);
  return { compact, expanded };
}

describe("renderSubagentResult — expanded 与 compact 的分支关系（字节级）", () => {
  it("cancel：expanded 输出与 compact 逐字节相同", () => {
    const details = {
      action: "cancel",
      subagentId: "sa-cancel1",
      sessionFile: null,
      cancelResponse: { cancelled: true },
    };
    const { compact, expanded } = renderBoth(details);
    expect(expanded).toEqual(compact);
    expect(expanded.join("\n")).toContain("cancelled ");
    expect(expanded.join("\n")).toContain("sa-cancel1");
  });

  it("start(bg)：expanded 输出与 compact 逐字节相同", () => {
    const details = {
      action: "start",
      subagentId: "sa-start1",
      sessionFile: null,
      slug: "fix-login",
      model: undefined,
      bgResponse: { status: "running", mode: "background", message: "detached" },
    };
    const { compact, expanded } = renderBoth(details);
    expect(expanded).toEqual(compact);
    expect(expanded.join("\n")).toContain("background: ");
    expect(expanded.join("\n")).toContain("sa-start1");
  });

  it("fork-from：expanded 用完整源路径，compact 用 basename 短标签（差异锁定）", () => {
    const details = {
      action: "fork-from",
      subagentId: "sa-new1",
      sessionFile: null,
      forkFromResponse: {
        newSubagentId: "sa-new1",
        sourceSessionFile: "/tmp/sessions/old-abc.jsonl",
      },
    };
    const { compact, expanded } = renderBoth(details);
    expect(compact.join("\n")).not.toContain("/tmp/sessions/");
    expect(compact.join("\n")).toContain("old-abc.jsonl");
    expect(expanded.join("\n")).toContain("/tmp/sessions/old-abc.jsonl");
  });

  it("list：expanded 在 compact 之上追加 session 行（差异锁定）", () => {
    const details = {
      action: "list",
      subagentId: null,
      sessionFile: null,
      listResponse: {
        running: 1,
        items: [{
          subagentId: "sa-1",
          agent: "worker",
          slug: "scan",
          status: "running",
          duration: 12,
          sessionFile: "/tmp/sessions/sa-1.jsonl",
        }],
      },
    };
    const { compact, expanded } = renderBoth(details);
    expect(compact.join("\n")).not.toContain("session: ");
    expect(expanded.join("\n")).toContain("/tmp/sessions/sa-1.jsonl");
    expect(compact.join("\n")).not.toContain("/tmp/sessions/sa-1.jsonl");
    // compact 的行是 expanded 的前缀（追加不修改既有行）
    expect(expanded.slice(0, compact.length)).toEqual(compact);
  });
});
