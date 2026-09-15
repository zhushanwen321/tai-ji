// src/__tests__/bg-notify-render.test.ts
//
// background 完成通知的渲染测试。
//
// 核心契约：renderBgNotifyMessage 必须返回带紫色背景 + 圆角边框的组件——
// Pi 的 CustomMessageComponent 对 customRenderer 返回值是「裸 addChild」，
// 返回裸 Text 会丢失紫色背景。本测试钉死「施加 customMessageBg + 边框」这一行为。
//
// 测试用 mock theme（bg 记录调用色 token），不依赖真实 Pi Theme。

import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { renderBgNotifyMessage } from "../interface/bg-notify-render.ts";

/**
 * 构造 mock theme：bg 记录被调用的色 token，fg/bold 透传文本。
 *
 * 真实 theme.fg/bg 会包裹 ANSI 码；这里透传纯文本，让断言可读。
 * 边框/背景 token 通过 bgColors 记录。
 */
function makeTheme(): { theme: Theme; bgColors: string[]; fgColors: string[] } {
  const bgColors: string[] = [];
  const fgColors: string[] = [];
  const theme = {
    fg: (tag: string, text: string) => {
      fgColors.push(tag);
      return text;
    },
    bold: (text: string) => text,
    bg: (color: string, text: string) => {
      bgColors.push(color);
      return text;
    },
  };
  return { theme: theme as Theme, bgColors, fgColors };
}

describe("renderBgNotifyMessage", () => {
  it("单条 done → 施加 customMessageBg 背景 + 边框 + 内容可见", () => {
    const { theme, bgColors } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "closed", agent: "worker", id: "bg-1", result: "All green" } },
      { expanded: false },
      theme,
    );

    expect(comp).toBeDefined();
    const lines = comp!.render(80);
    const joined = lines.join("\n");
    // 紫色背景施加（内容行 ≥ 1 次）
    expect(bgColors.filter((c) => c === "customMessageBg").length).toBeGreaterThanOrEqual(1);
    // 圆角边框
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("╮");
    expect(lines[lines.length - 1]).toContain("╰");
    expect(lines[lines.length - 1]).toContain("╯");
    for (let i = 1; i < lines.length - 1; i++) {
      expect(lines[i]).toContain("│");
    }
    // 前景内容仍在
    expect(joined).toContain("worker");
    expect(joined).toContain("All green");
  });

  it("id 用 shortId 截断（bg-tag-seq-ts → bg-tag-seq）", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "closed", agent: "w", id: "bg-f6f731-10-1719500000000", result: "ok" } },
      { expanded: false },
      theme,
    );
    const joined = comp!.render(80).join("\n");
    // shortId 对 background id 取前 3 段（bg/tag/seq）
    expect(joined).toContain("bg-f6f731-10");
    // 完整时间戳不应出现
    expect(joined).not.toContain("1719500000000");
  });

  it("单条 failed → 内容含 Error + agent", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "closed", agent: "scout", id: "bg-2", error: "boom" } },
      { expanded: false },
      theme,
    );
    expect(comp).toBeDefined();
    const joined = comp!.render(80).join("\n");
    expect(joined).toContain("scout");
    expect(joined).toContain("Error");
    expect(joined).toContain("boom");
  });

  it("批量 → 施加 customMessageBg + 边框，每条 agent 可见", () => {
    const { theme, bgColors } = makeTheme();
    const comp = renderBgNotifyMessage(
      {
        details: {
          batch: true,
          items: [
            { status: "closed", agent: "alpha", id: "1", result: "r1" },
            { status: "closed", agent: "beta", id: "2", error: "e2" },
          ],
        },
      },
      { expanded: false },
      theme,
    );
    expect(comp).toBeDefined();
    const lines = comp!.render(80);
    const joined = lines.join("\n");
    expect(bgColors).toContain("customMessageBg");
    expect(joined).toContain("alpha");
    expect(joined).toContain("beta");
    // 边框
    expect(lines[0]).toContain("╭");
    expect(lines[lines.length - 1]).toContain("╰");
  });

  it("closed + closedReason=cancelled → 内容含 cancelled（v4 B-1 cancelled 折入 closed）", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "closed", closedReason: "cancelled", agent: "w", id: "bg-3" } },
      { expanded: false },
      theme,
    );
    expect(comp).toBeDefined();
    expect(comp!.render(80).join("\n")).toContain("cancelled");
  });

  // ── U3 C-outcome：渲染器切读 outcome ──

  it("[U3] details 携带 outcome='failed' → verb 为 failed + Error 行（直读一等字段）", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "closed", outcome: "failed", agent: "w", id: "bg-4", error: "kaboom" } },
      { expanded: false },
      theme,
    );
    const joined = comp!.render(80).join("\n");
    expect(joined).toContain("failed");
    expect(joined).toContain("Error");
    expect(joined).toContain("kaboom");
  });

  it("[U3] details 携带 outcome='completed' → verb 为 finished，结果行可见", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "closed", outcome: "completed", agent: "w", id: "bg-5", result: "ok" } },
      { expanded: false },
      theme,
    );
    const joined = comp!.render(80).join("\n");
    expect(joined).toContain("finished");
    expect(joined).toContain("ok");
  });

  it("[U3] outcome 优先于 closedReason（一等字段胜出）", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      {
        details: {
          status: "closed", outcome: "cancelled", closedReason: "gc", agent: "w", id: "bg-6",
        },
      },
      { expanded: false },
      theme,
    );
    const joined = comp!.render(80).join("\n");
    expect(joined).toContain("cancelled");
  });

  it("[U3] 升级前旧消息重放（details 无 outcome，仅 closedReason+error）→ deriveOutcome 兑底不崩溃", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      {
        details: {
          status: "closed", closedReason: "gc", error: "legacy boom", agent: "w", id: "bg-7",
        },
      },
      { expanded: false },
      theme,
    );
    const joined = comp!.render(80).join("\n");
    expect(joined).toContain("failed");
    expect(joined).toContain("legacy boom");
  });

  it("[U3] 非法 outcome 值按缺失处理（防御性收窄，不崩溃，兑底派生）", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      {
        details: {
          status: "closed", outcome: "bogus", closedReason: "gc", result: "fine", agent: "w", id: "bg-8",
        },
      },
      { expanded: false },
      theme,
    );
    const joined = comp!.render(80).join("\n");
    expect(joined).toContain("finished");
  });

  it("details 缺失/结构不全 → undefined（走 Pi 默认渲染兜底）", () => {
    const { theme } = makeTheme();
    expect(renderBgNotifyMessage({ details: undefined }, { expanded: false }, theme)).toBeUndefined();
    expect(renderBgNotifyMessage({ details: { foo: 1 } }, { expanded: false }, theme)).toBeUndefined();
    // 缺 status / agent
    expect(
      renderBgNotifyMessage({ details: { id: "x", agent: "w" } }, { expanded: false }, theme),
    ).toBeUndefined();
    expect(
      renderBgNotifyMessage({ details: { status: "closed", id: "x" } }, { expanded: false }, theme),
    ).toBeUndefined();
  });

  it("details 无效时不施加任何背景（兜底路径不应泄漏背景色）", () => {
    const { theme, bgColors } = makeTheme();
    renderBgNotifyMessage({ details: undefined }, { expanded: false }, theme);
    expect(bgColors).not.toContain("customMessageBg");
  });

  // ── model 显示 ──

  it("record 带 model → 内容含 model 字符串（agent 后、状态描述前）", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "closed", agent: "general-purpose", model: "anthropic/sonnet-4-5", id: "bg-1", result: "ok" } },
      { expanded: false },
      theme,
    );
    const joined = comp!.render(80).join("\n");
    expect(joined).toContain("anthropic/sonnet-4-5");
    // agent 和状态仍在
    expect(joined).toContain("general-purpose");
    expect(joined).toContain("finished");
  });

  it("record 无 model → 向后兼容，不渲染 model 段不崩", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "closed", agent: "worker", id: "bg-2", result: "r" } },
      { expanded: false },
      theme,
    );
    const joined = comp!.render(80).join("\n");
    expect(joined).toContain("worker");
    expect(joined).toContain("finished");
  });

  // ── ANSI 背景 safety ──

  it("着色行截断的 \\x1b[0m 被替换为精确 reset（不破坏背景）", () => {
    // mock theme 产生真实 ANSI（fg 用 italic \x1b[3m..\x1b[23m，bold 用 \x1b[1m..\x1b[22m）
    const theme = {
      fg: (_tag: string, text: string) => `\x1b[3m${text}\x1b[23m`,
      bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
      bg: (_color: string, text: string) => `\x1b[48;5;95m${text}\x1b[49m`,
    } as Theme;
    // 关键：用窄 width + 长 agent 名，让 head 行在 truncLine 内被真正截断
    // head 行含 ANSI（fg 包裹），截断时 activeStyles 非空 → 会产生 \x1b[0m
    const longAgent = "a".repeat(60);
    const comp = renderBgNotifyMessage(
      { details: { status: "closed", agent: longAgent, id: "bg-1", result: "ok" } },
      { expanded: false },
      theme,
    );
    const lines = comp!.render(30);
    // 内容行（非边框）不应含 \x1b[0m（会破坏背景）
    const contentLines = lines.slice(1, -1);
    expect(contentLines.length).toBeGreaterThan(0);
    for (const line of contentLines) {
      expect(line).not.toContain("\x1b[0m");
    }
    // 正向验证：sanitizeAnsiForBg 把 \x1b[0m 替换成了精确 reset（\x1b[39m）
    // 如果截断真的发生了，内容行应含 \x1b[39m（sanitize 的替换产物）
    const hasSanitized = contentLines.some((l) => l.includes("\x1b[39m"));
    expect(hasSanitized).toBe(true);
  });

  // ── 窄宽度退化 ──

  it("极窄宽度（width < 5）退化：无边框，不崩溃，有背景", () => {
    const { theme, bgColors } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "closed", agent: "w", id: "bg-1", result: "ok" } },
      { expanded: false },
      theme,
    );
    // width=3 < MIN_BORDER_WIDTH(5)，应退化为无边框模式
    const lines = comp!.render(3);
    expect(lines.length).toBeGreaterThan(0);
    // 不应有边框字符（退化模式）
    for (const line of lines) {
      expect(line).not.toContain("╭");
      expect(line).not.toContain("│");
    }
    // 仍施加背景
    expect(bgColors).toContain("customMessageBg");
  });

  it("批量场景边框完整：所有中间行含 │", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      {
        details: {
          batch: true,
          items: [
            { status: "closed", agent: "alpha", id: "1", result: "r1" },
            { status: "closed", agent: "beta", id: "2", error: "e2" },
            { status: "closed", closedReason: "cancelled", agent: "gamma", id: "3" },
          ],
        },
      },
      { expanded: false },
      theme,
    );
    const lines = comp!.render(80);
    // 顶底边框
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("╮");
    expect(lines[lines.length - 1]).toContain("╰");
    expect(lines[lines.length - 1]).toContain("╯");
    // 所有中间行都应有左右 │
    for (let i = 1; i < lines.length - 1; i++) {
      expect(lines[i]).toContain("│");
    }
  });
});
