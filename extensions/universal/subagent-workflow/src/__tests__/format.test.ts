// src/__tests__/format.test.ts
import os from "node:os";

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  formatElapsed,
  formatElapsedSeconds,
  formatRunStatusElapsed,
  formatTokens,
  formatToolCall,
  padToVisible,
  sanitizeLabel,
  segFillColored,
  shortId,
  spinnerGlyph,
  statusGlyph,
  truncLine,
  wrapText,
  type ThemeLike,
} from "../interface/format.ts";

// ============================================================
// formatTokens
// ============================================================
describe("formatTokens", () => {
  it("shows plain value below 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(820)).toBe("820");
    expect(formatTokens(999)).toBe("999");
  });

  it("shows N.Nk between 1000 and 9999", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(8200)).toBe("8.2k");
    expect(formatTokens(9999)).toBe("10.0k");
  });

  it("shows rounded Nk at 10000+", () => {
    expect(formatTokens(10000)).toBe("10k");
    expect(formatTokens(23000)).toBe("23k");
    expect(formatTokens(99999)).toBe("100k");
  });
});

// ============================================================
// formatElapsedSeconds
// ============================================================
describe("formatElapsedSeconds", () => {
  it("shows Xs below 60", () => {
    expect(formatElapsedSeconds(0)).toBe("0s");
    expect(formatElapsedSeconds(12)).toBe("12s");
    expect(formatElapsedSeconds(59)).toBe("59s");
  });

  it("shows Xm Ys between 60 and 3599", () => {
    expect(formatElapsedSeconds(60)).toBe("1m0s");
    expect(formatElapsedSeconds(72)).toBe("1m12s");
    expect(formatElapsedSeconds(3599)).toBe("59m59s");
  });

  it("shows Xh Ym at 3600+", () => {
    expect(formatElapsedSeconds(3600)).toBe("1h0m");
    // 3700 → "1h1m"（单源锚断言）：views/format.ts 旧版无小时档曾输出 "61m40s"，
    // U11 宿主内合并后两侧统一取本实现的小时档语义。
    expect(formatElapsedSeconds(3700)).toBe("1h1m");
    expect(formatElapsedSeconds(3661)).toBe("1h1m");
    expect(formatElapsedSeconds(7325)).toBe("2h2m");
  });
});

// ============================================================
// formatElapsed
// ============================================================
describe("formatElapsed", () => {
  // 固定基准时间注入 now，避免依赖墙钟
  const NOW = 1_700_000_000_000;
  const startedAt = (secsAgo: number) => new Date(NOW - secsAgo * 1000).toISOString();

  it("returns '-' when startedAt is missing", () => {
    expect(formatElapsed(undefined, NOW)).toBe("-");
  });

  it("shows 0s below 1s and Xs below 60s", () => {
    expect(formatElapsed(startedAt(0.5), NOW)).toBe("0s");
    expect(formatElapsed(startedAt(12), NOW)).toBe("12s");
    expect(formatElapsed(startedAt(59), NOW)).toBe("59s");
  });

  it("shows XmYs below 1h（<1h 行为不变，U-1 修复断言）", () => {
    expect(formatElapsed(startedAt(60), NOW)).toBe("1m0s");
    expect(formatElapsed(startedAt(2730), NOW)).toBe("45m30s");
    expect(formatElapsed(startedAt(3599), NOW)).toBe("59m59s");
  });

  it("shows XhYm at 3600+（与 formatElapsedSeconds 同形态，U-1 修复断言）", () => {
    expect(formatElapsed(startedAt(3600), NOW)).toBe("1h0m");
    expect(formatElapsed(startedAt(4500), NOW)).toBe("1h15m");
    expect(formatElapsed(startedAt(7325), NOW)).toBe("2h2m");
  });
});

// ============================================================
// formatRunStatusElapsed（[H2 A2] run done 后 elapsed 冻结）
// ============================================================
describe("formatRunStatusElapsed", () => {
  const NOW = 1_700_000_000_000;
  const startedAt = (msOffset: number) => new Date(NOW + msOffset).toISOString();

  it("done run（completedAt 有值）→ 冻结于 completedAt - startedAt，与查询墙钟无关", () => {
    const start = startedAt(0);
    const completed = startedAt(65_000); // 运行 65s 后完成
    // 查询墙钟在完成 1 小时 / 1 天后：elapsed 仍恒为 65s（1m5s），不增长
    expect(formatRunStatusElapsed(start, completed, NOW + 3_600_000)).toBe("1m5s");
    expect(formatRunStatusElapsed(start, completed, NOW + 86_400_000)).toBe("1m5s");
  });

  it("running run（completedAt 缺省）→ 沿用 now 基准实时跳动", () => {
    const start = startedAt(0);
    expect(formatRunStatusElapsed(start, undefined, NOW + 12_000)).toBe("12s");
  });

  it("startedAt 缺省 → '-' 兜底；时钟回拨（completedAt < startedAt）→ 钳 0", () => {
    expect(formatRunStatusElapsed(undefined, startedAt(1000), NOW)).toBe("-");
    const lateStart = startedAt(5_000);
    const earlierCompleted = startedAt(1_000);
    expect(formatRunStatusElapsed(lateStart, earlierCompleted, NOW)).toBe("0s");
  });
});

// ============================================================
// statusGlyph
// ============================================================
describe("statusGlyph", () => {
  it("running → no icon, accent color", () => {
    expect(statusGlyph("running")).toEqual({ icon: undefined, color: "accent" });
  });

  it("done → checkmark, success", () => {
    expect(statusGlyph("closed")).toEqual({ icon: "✓", color: "success" });
  });

  it("closed → checkmark, success", () => {
    expect(statusGlyph("closed")).toEqual({ icon: "✓", color: "success" });
  });
});

// ============================================================
// spinnerGlyph
// ============================================================
describe("spinnerGlyph", () => {
  it("returns a frame for valid seed", () => {
    expect(spinnerGlyph(0)).toBe("⠋");
    expect(spinnerGlyph(1)).toBe("⠙");
    expect(spinnerGlyph(9)).toBe("⠏");
  });

  it("wraps around (mod 10)", () => {
    expect(spinnerGlyph(10)).toBe("⠋");
    expect(spinnerGlyph(15)).toBe("⠴"); // index 5
  });

  it("falls back to frame 0 on NaN", () => {
    expect(spinnerGlyph(NaN)).toBe("⠋");
  });

  it("handles negative seeds via abs", () => {
    expect(spinnerGlyph(-1)).toBe("⠙"); // abs(-1) % 10 = 1 → ⠙
    expect(spinnerGlyph(-10)).toBe("⠋");
  });

  it("falls back to frame 0 on Infinity", () => {
    expect(spinnerGlyph(Infinity)).toBe("⠋");
  });
});

// ============================================================
// sanitizeLabel
// ============================================================
describe("sanitizeLabel", () => {
  it("replaces CRLF/LF with single space", () => {
    expect(sanitizeLabel("line1\r\nline2\nline3")).toBe("line1 line2 line3");
  });

  it("replaces tabs with 2 spaces", () => {
    expect(sanitizeLabel("a\tb")).toBe("a  b");
  });

  it("collapses multiple consecutive newlines into one space", () => {
    // /[\r\n]+/g treats \r\n\r\n as one match → single space
    expect(sanitizeLabel("a\r\n\r\nb")).toBe("a b");
  });

  it("leaves clean text unchanged", () => {
    expect(sanitizeLabel("read foo.ts")).toBe("read foo.ts");
  });
});

// ============================================================
// padToVisible
// ============================================================
describe("padToVisible", () => {
  it("pads short text to width with trailing spaces", () => {
    expect(padToVisible("ab", 5)).toBe("ab   ");
  });

  it("returns unchanged when already at width", () => {
    expect(padToVisible("hello", 5)).toBe("hello");
  });

  it("returns unchanged when wider than width", () => {
    expect(padToVisible("hello world", 5)).toBe("hello world");
  });

  it("handles CJK width (2 columns per char)", () => {
    // 你好 = 4 visible columns
    expect(padToVisible("你好", 6)).toBe("你好  ");
  });
});

// ============================================================
// segFillColored
// ============================================================
describe("segFillColored", () => {
  it("returns empty string for width <= 0", () => {
    expect(segFillColored("title", "-", 0)).toBe("");
    expect(segFillColored("title", "-", -1)).toBe("");
  });

  it("pure fill when no title", () => {
    expect(segFillColored(undefined, "-", 5)).toBe("-----");
  });

  it("title + fill to width", () => {
    expect(segFillColored("Hi", "-", 5)).toBe("Hi---");
  });

  it("truncates title when wider than width", () => {
    const result = segFillColored("Hello World", "-", 5);
    // title visible width 11 > 5 → truncated to 5 (with ellipsis = 4 chars + …)
    expect(result.length).toBeLessThanOrEqual(10); // visible width 5 but may include ANSI
  });

  it("preserves ANSI in title and fill separately (no nesting color loss)", () => {
    const redTitle = "\x1b[31mHi\x1b[0m";
    const blueFill = "\x1b[34m-\x1b[0m";
    const result = segFillColored(redTitle, blueFill, 5);
    // title visible width = 2 ("Hi"), fill count = 3
    expect(result).toContain(redTitle);
    expect(result).toContain(blueFill);
    // fill repeated 3 times
    expect(result).toBe(redTitle + blueFill + blueFill + blueFill);
  });
});

// ============================================================
// truncLine
// ============================================================
describe("truncLine", () => {
  it("returns text unchanged when within width", () => {
    expect(truncLine("hello", 10)).toBe("hello");
    expect(truncLine("hello", 5)).toBe("hello");
  });

  it("returns empty string for width <= 0", () => {
    expect(truncLine("hello", 0)).toBe("");
  });

  it("truncates with ellipsis when exceeding width", () => {
    const result = truncLine("hello world", 8);
    // 纯文本截断不发 \x1b[0m（全局重置会破坏外层背景色）
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toContain("\x1b[0m");
    // visible width should be 8 (7 chars + ellipsis)
  });

  it("handles CJK characters (2 columns each)", () => {
    // 你好世界 = 8 visible columns; truncate to 5 → 2 chars (4 cols) + …
    const result = truncLine("你好世界", 5);
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toContain("\x1b[0m");
  });

  it("handles emoji correctly", () => {
    const result = truncLine("😀😁😂🤣😃", 3);
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toContain("\x1b[0m");
  });

  it("reapplies active ANSI styles before ellipsis (no background break)", () => {
    // red text that exceeds width → ellipsis should have red re-applied
    const input = "\x1b[31mhello world this is long\x1b[0m";
    const result = truncLine(input, 10);
    expect(result.endsWith("…\x1b[0m")).toBe(true);
    // The ellipsis should be preceded by the active red style (re-applied)
    // Check that the last grapheme sequence includes the red SGR before …
    expect(result).toMatch(/\x1b\[31m…\x1b\[0m$/);
  });

  it("clears style stack on reset code", () => {
    // text with reset in the middle → after reset, no style re-applied
    const input = "\x1b[31mab\x1b[0mcdefghijk";
    const result = truncLine(input, 6);
    // reset 后 activeStyles 为空 → 截断不发 \x1b[0m
    expect(result.endsWith("…")).toBe(true);
  });

  it("flattens newlines to spaces (single-line rendering safety)", () => {
    // 多行 prompt / turn.text 含 \n，单行渲染时 \n 会意外换行破坏行对齐。
    // truncLine 作为单行渲染入口必须剥离 \n（用空格替代保留词边界）。
    const multiLine = "只读任务：分析核心逻辑。\n项目根：/Users/test\n输出：报告";
    const result = truncLine(multiLine, 80);
    expect(result).not.toContain("\n");
    expect(result).toContain("只读任务");
    expect(result).toContain("项目根");
  });

  it("flattens \r\n sequences", () => {
    const crlf = "line1\r\nline2\r\nline3";
    const result = truncLine(crlf, 80);
    expect(result).not.toContain("\r");
    expect(result).not.toContain("\n");
  });
});

// ============================================================
// truncLine — legacy 对拍（indexOf 化重构的逐字节等价锚定）
// ============================================================

/**
 * 旧实现参照：改造前的 per-char 版本，逐字取自 git 历史（093e28fe3~1 的
 * format.ts truncLine）。现行实现（indexOf("\\x1b") 段跳过）必须与其逐字节
 * 等价——本函数即对拍 oracle，与 helpers-bounded-serialize.test.ts 的
 * legacySerialize 同形态（参照物随测试落盘，防「验证只存在于改造当时」）。
 */
const legacySegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function legacyTruncLine(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const flat = text.replace(/[\r\n]+/g, " ");
  if (visibleWidth(flat) <= maxWidth) return flat;

  const targetWidth = Math.max(0, maxWidth - 1);
  let result = "";
  let currentWidth = 0;
  let activeStyles: string[] = [];
  let i = 0;

  while (i < flat.length) {
    // 捕获 ANSI SGR 序列
    const ansiMatch = flat.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (ansiMatch) {
      const code = ansiMatch[0];
      result += code;

      if (code === "\x1b[0m" || code === "\x1b[m") {
        activeStyles = []; // reset → 清空栈
      } else {
        activeStyles.push(code);
      }
      i += code.length;
      continue;
    }

    // 找到下一段纯文本(非 ANSI)的边界
    let end = i;
    while (end < flat.length && !flat.slice(end).match(/^\x1b\[[0-9;]*m/)) {
      end++;
    }

    // 按 grapheme 迭代这段文本,累加到 targetWidth
    const textPortion = flat.slice(i, end);
    for (const seg of legacySegmenter.segment(textPortion)) {
      const grapheme = seg.segment;
      const graphemeWidth = visibleWidth(grapheme);

      if (currentWidth + graphemeWidth > targetWidth) {
        return result + activeStyles.join("") + "…" + (activeStyles.length ? "\x1b[0m" : "");
      }

      result += grapheme;
      currentWidth += graphemeWidth;
    }
    i = end;
  }

  // 理论上 visibleWidth 检查已提前返回,此行兜底
  return result + activeStyles.join("") + "…" + (activeStyles.length ? "\x1b[0m" : "");
}

/** 确定性 PRNG（mulberry32）：fuzz 用例固定 seed 生成，失败可按 case 编号 + seed 复现。 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 定向混排片段池：ASCII / CJK / emoji（含肤色修饰与 ZWJ 组合）/ SGR / 非 SGR ESC（OSC、CSI-K、裸 ESC）/ 换行。 */
const FUZZ_PIECES = [
  "plain", " ", "a", "0", "MiXeD-Case_123",
  "你好世界", "汉字宽度测试", "日本語テキスト",
  "😀", "😁😂🤣", "👍🏽", "👨‍👩‍👧‍👦", "é", "é",
  "\x1b[31m", "\x1b[0m", "\x1b[m", "\x1b[1;32m", "\x1b[38;5;196m",
  "\x1b[K", "\x1b]0;title\x07", "\x1bZ", "\x1b",
  "\n", "\r\n",
];

function genFuzzText(rand: () => number): string {
  const pieceCount = Math.floor(rand() * 40);
  let out = "";
  for (let p = 0; p < pieceCount; p++) {
    out += FUZZ_PIECES[Math.floor(rand() * FUZZ_PIECES.length)];
  }
  return out;
}

describe("truncLine — legacy 对拍（per-char 参照逐字节等价）", () => {
  it("定向 fuzz：300 随机 ESC/SGR/CJK/emoji 混排用例（固定 seed 可复现）与旧实现逐字节一致", () => {
    const rand = mulberry32(20260815);
    let truncated = 0;
    for (let i = 0; i < 300; i++) {
      const text = genFuzzText(rand);
      const maxWidth = Math.floor(rand() * 61); // 0..60，含 0/1 边界
      const actual = truncLine(text, maxWidth);
      expect(
        actual,
        `case #${i} text=${JSON.stringify(text)} maxWidth=${maxWidth}`,
      ).toBe(legacyTruncLine(text, maxWidth));
      if (actual.endsWith("…")) truncated++;
    }
    // 前置有效性：fuzz 确实命中了截断路径（否则对拍只测了「宽度内原样返回」早退分支）
    expect(truncated).toBeGreaterThan(100);
  });

  it("手工对抗用例：SGR 重叠 / OSC 内截断 / CSI-K 混排 / 串尾裸 ESC", () => {
    const cases: Array<[string, number]> = [
      ["\x1b[31m红\x1b[32m绿\x1b[1;4m加粗下划线尾巴超宽截断点", 9],
      ["AB\x1b]0;title\x07CDEFGHIJKLMNOP", 10],
      ["\x1b[31mred\x1b[K\x1b[32mgreen tail past width", 10],
      ["text almost at width limit\x1b", 22],
      ["before \x1bZ after bare esc tail", 12],
      ["\x1b[m你\x1b[0m好\x1b[38;5;196m世👨‍👩‍👧‍👦界".repeat(3), 14],
    ];
    for (const [text, maxWidth] of cases) {
      expect(truncLine(text, maxWidth)).toBe(legacyTruncLine(text, maxWidth));
    }
  });
});

// ============================================================
// wrapText
// ============================================================
describe("wrapText", () => {
  it("returns text as-is when shorter than width", () => {
    expect(wrapText("hello", 80)).toEqual(["hello"]);
  });

  it("wraps long text into multiple lines (no truncation)", () => {
    const text = "abcdefghij"; // 10 chars
    const lines = wrapText(text, 4);
    // 每行最多 4 列，10 字符 → 3 行（4+4+2），不截断不省略号
    expect(lines.join("")).toBe("abcdefghij");
    for (const l of lines.slice(0, -1)) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(4);
    }
  });

  it("preserves original newlines as paragraph breaks", () => {
    const text = "第一行\n第二行";
    const lines = wrapText(text, 80);
    expect(lines).toEqual(["第一行", "第二行"]);
  });

  it("wraps CJK text correctly (2 columns each)", () => {
    // 你好世界你好世界 = 8 CJK chars = 16 columns, wrap to 4 columns
    const text = "你好世界你好世界";
    const lines = wrapText(text, 4);
    // 每行最多 4 列 = 2 CJK chars, 共 4 行
    expect(lines).toHaveLength(4);
    expect(lines.join("")).toBe(text);
  });

  it("handles width <= 0 by returning original", () => {
    expect(wrapText("hello", 0)).toEqual(["hello"]);
  });

  it("preserves empty lines from blank paragraphs", () => {
    const text = "a\n\nb";
    expect(wrapText(text, 80)).toEqual(["a", "", "b"]);
  });
});

// ============================================================
// shortId
// ============================================================
describe("shortId", () => {
  it("returns sync id unchanged (run-N already short)", () => {
    expect(shortId("run-1")).toBe("run-1");
    expect(shortId("run-42")).toBe("run-42");
  });

  it("strips timestamp from background id (bg-tag-seq-<ts> → bg-tag-seq)", () => {
    // 算法回归：多段 id 取前 3 段（SHORT_ID_BG_SEGMENTS）。
    // 注意：当前 subagent ID 已改为 sa-<uuid>（见下面 sa- 用例），workflow ID 为 wf-<ts>-<rand>，
    // 实际不再产生 bg- 形态 id；此处保留作为 shortId 算法的多段降级回归（4 段 → 3 段）。
    expect(shortId("bg-f6f731-10-1719500000000")).toBe("bg-f6f731-10");
    expect(shortId("bg-abc123-99-1719500123456")).toBe("bg-abc123-99");
  });

  it("handles pure uuid and wf- runId (regression baseline)", () => {
    // 纯 UUID 回归（5段 → 取前3段）
    expect(shortId("550e8400-e29b-41d4-a716-446655440000")).toBe("550e8400-e29b-41d4");
    // wf- 前缀 runId 回归（3段 → 取前3段=原样）
    expect(shortId("wf-1719500000000-a1b2c3")).toBe("wf-1719500000000-a1b2c3");
  });

  it("keeps sa- prefix for subagent id (sa-<uuid> → sa-<uuid 前3段>)", () => {
    // sa- 前缀 subagent ID（保留前缀 + UUID 前 3 段）
    expect(shortId("sa-550e8400-e29b-41d4-a716-446655440000")).toBe("sa-550e8400-e29b-41d4");
  });
});

// ============================================================
// formatToolCall（表驱动分发：toolName → formatter，落空走 unknown 分支）
// ============================================================
// theme stub：tag 透传为 `tag(text)` 形态，断言输出即可同时钉住「文案 + 着色 token + 拼接顺序」。
const markingTheme: ThemeLike = {
  fg: (color, text) => `${color}(${text})`,
  bg: (color, text) => `${color}(${text})`,
  bold: (text) => `bold(${text})`,
  underline: (text) => `u(${text})`,
};

describe("formatToolCall", () => {
  it("formats bash with $ prefix and truncates long commands at 60 chars", () => {
    expect(formatToolCall("bash", { command: "echo hi" }, markingTheme)).toBe(
      "muted($ )toolOutput(echo hi)",
    );
    const long = "x".repeat(80);
    expect(formatToolCall("bash", { command: long }, markingTheme)).toBe(
      `muted($ )toolOutput(${"x".repeat(60)}...)`,
    );
    // command 缺省兜底 "..."
    expect(formatToolCall("bash", {}, markingTheme)).toBe("muted($ )toolOutput(...)");
  });

  it("formats read with optional :start-end range and file_path priority", () => {
    expect(formatToolCall("read", { file_path: "/tmp/a.ts" }, markingTheme)).toBe(
      "muted(read )accent(/tmp/a.ts)",
    );
    expect(
      formatToolCall("read", { path: "/tmp/a.ts", offset: 3, limit: 10 }, markingTheme),
    ).toBe("muted(read )accent(/tmp/a.ts)warning(:3-12)");
    // 仅 offset（无 limit）→ 单起始行号
    expect(formatToolCall("read", { path: "/tmp/a.ts", offset: 5 }, markingTheme)).toBe(
      "muted(read )accent(/tmp/a.ts)warning(:5)",
    );
    // file_path 优先于 path
    expect(
      formatToolCall("read", { file_path: "/p1.ts", path: "/p2.ts" }, markingTheme),
    ).toBe("muted(read )accent(/p1.ts)");
  });

  it("formats write with line count suffix and edit/ls as plain paths", () => {
    expect(formatToolCall("write", { file_path: "/a.md", content: "one\ntwo" }, markingTheme)).toBe(
      "muted(write )accent(/a.md)dim( (2 lines))",
    );
    expect(formatToolCall("write", { file_path: "/a.md", content: "one" }, markingTheme)).toBe(
      "muted(write )accent(/a.md)",
    );
    expect(formatToolCall("edit", { file_path: "/a.ts" }, markingTheme)).toBe(
      "muted(edit )accent(/a.ts)",
    );
    // ls 默认 "."（与 read/write/edit 的 "..." 兜底不同源——语义差异保留）
    expect(formatToolCall("ls", {}, markingTheme)).toBe("muted(ls )accent(.)");
  });

  it("formats find and grep with pattern and in-path suffix", () => {
    expect(formatToolCall("find", { pattern: "*.ts", path: "/src" }, markingTheme)).toBe(
      "muted(find )accent(*.ts)dim( in /src)",
    );
    expect(formatToolCall("grep", { pattern: "foo", path: "/src" }, markingTheme)).toBe(
      "muted(grep )accent(/foo/)dim( in /src)",
    );
  });

  it("falls back to unknown branch with args JSON preview (50-char truncate)", () => {
    const args = { alpha: 1 };
    expect(formatToolCall("web_search", args, markingTheme)).toBe(
      `accent(web_search)dim( ${JSON.stringify(args)})`,
    );
    const longArgs = { blob: "y".repeat(80) };
    const json = JSON.stringify(longArgs);
    expect(formatToolCall("custom", longArgs, markingTheme)).toBe(
      `accent(custom)dim( ${json.slice(0, 50)}...)`,
    );
  });

  it("treats prototype-chain key names as unknown (Map lookup, no Object.prototype hit)", () => {
    // 表驱动用 Map 查找的语义锚：普通对象下标会把 "constructor" 解析到原型链，
    // 这里必须与其它未知 toolName 同走 default 分支。
    expect(formatToolCall("constructor", {}, markingTheme)).toBe(
      "accent(constructor)dim( {})",
    );
  });

  it("abbreviates home-prefixed paths to ~ (display only)", () => {
    const home = os.homedir();
    expect(formatToolCall("edit", { file_path: `${home}/x/y.ts` }, markingTheme)).toBe(
      "muted(edit )accent(~/x/y.ts)",
    );
    // 非 home 前缀路径原样
    expect(formatToolCall("edit", { file_path: "/opt/x.ts" }, markingTheme)).toBe(
      "muted(edit )accent(/opt/x.ts)",
    );
  });
});
