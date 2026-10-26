// format.test.ts —— subagent-workflow C01 簇合并产物（round5-G）。
// 共同被测业务模块：`src/interface/format/format.ts`。mock 相容：单侧 mock @zhushanwen/subagent-core/orchestration/workflow-files.ts——合并后 mock 全文件生效，未 mock 方用例经产物自检全绿核对。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/format.test.ts（78 用例，skip 0）
//   - src/__tests__/list-component.test.ts（46 用例，skip 0）
//   - src/interface/format/__tests__/display-state.test.ts（16 用例，skip 0）
//   - src/interface/tui/__tests__/list-view.test.ts（8 用例，skip 0）
//   - src/interface/tui/views/__tests__/WorkflowsView.driver.test.ts（30 用例，skip 0）
//   - src/interface/tui/views/__tests__/WorkflowsView.test.ts（29 用例，skip 0）
//   - src/interface/tui/views/__tests__/detail-content.test.ts（11 用例，skip 0）

import os from 'node:os'
import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { foldRunEventCheckpoint, INITIAL_RUN_EVENT_FOLD, type AgentEventLogEntry, type DisplayItem, type ExecutionTraceNode, type RunEventFoldCheckpoint, type WorkflowRunEvent, type SubagentService, type SubagentRecord, doneReasonToRunOutcome, noteRebuiltSettlement, type DoneReason, type WorkflowRun, saveWorkflow, type WorkerLogEntry } from '@zhushanwen/subagent-core'
import { buildPhaseGroups, formatDisplayItem, formatElapsed, formatElapsedSeconds, formatEventLine, formatPhaseLine, formatRunStatusElapsed, formatStatusBadge, formatTokens, formatToolCall, formatTraceEventLine, sanitizeLabel, shortId, spinnerGlyph, statusDotStr, statusGlyph, firstLineSanitized, type ThemeLike } from '../../../format/format.ts'
import { padToVisible, segFillColored, truncLine, wrapText } from '../../tui-kit.ts'
import { SubagentsListComponent } from '../../list-component.ts'
import { processKey, createSubagentsView } from '../../list-view.ts'
import { type DetailKeyContext, type KeyHandler, type KeyResult, type NotifyFn, type TuiLike, type ViewState } from '../../list-shared.ts'
import { formatRunBadge, isFailedTerminal, runDisplaySignaturePart, runDisplayStateOf, runToneOf } from '../../../format/display-state.ts'
import { type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { promises as fsPromises } from 'node:fs'
import { createWorkflowsView, collectNodeLiveProgress, computeRenderSignature } from '../WorkflowsView.ts'
import { type LiveProgressView, buildDetailContent, detailContentLength, processDetailKey, projectRecordProgress, statusLabel } from '../detail-content.ts'

vi.mock("@zhushanwen/subagent-core/orchestration/workflow-files.ts", () => ({
  saveWorkflow: vi.fn(),
}));

// ======== 来源：format.test.ts ========
describe("format", () => {
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

    it("closed → checkmark, success", () => {
      expect(statusGlyph("closed")).toEqual({ icon: "✓", color: "success" });
    });

    // [U2 两态] idle 承接旧 closed 分支视觉基线（✓ success）——实现中 idle/closed 是同
    // 一个 case 分支，独立断言防未来拆分 idle case 时静默漂移。（F 修：原「done →
    // checkmark」用例名实不符、与 closed 用例逐字重复，改测真实零覆盖缺口 idle 分支；
    // 自 status-refactor.test.ts 迁并的 idle 条同契约，合并为一条。）
    it("idle → checkmark, success（承接旧 closed 分支视觉基线）", () => {
      expect(statusGlyph("idle")).toEqual({ icon: "✓", color: "success" });
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
 * 等价——本函数即对拍的最终裁决角色，与 helpers-bounded-serialize.test.ts 的
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

  // ============================================================
  // phase 分组消费折叠派生视图（[D3] phase 状态机与展示分组同源——workflow-run-resume-revision U3）
  // ============================================================

  /** fresh fold 初值：Map 半边逐用例独立实例（INITIAL_RUN_EVENT_FOLD 的 phases 是
 * 模块级共享 Map，D3 自愈分支的原地写入会跨 fold 调用残留——独立初值使本组
 * 断言只依赖单条流自身，不受用例执行序影响）。 */
  function freshFold(): RunEventFoldCheckpoint {
    return { ...INITIAL_RUN_EVENT_FOLD, asks: new Map(), phases: new Map() };
  }

  /** record 事件帧构造 helper（seq 由数组序 +1 推导——fold 严格递增契约）。 */
  function seqEvents(events: Array<Omit<WorkflowRunEvent, "seq">>): WorkflowRunEvent[] {
    return events.map((e, i) => ({ ...e, seq: i + 1 }) as WorkflowRunEvent);
  }

  /** trace 节点构造（settled → completed + completedAt；在途 → running）。 */
  function traceNode(
    stepIndex: number,
    agent: string,
    phase: string | undefined,
    settled: boolean,
  ): ExecutionTraceNode {
    return {
      stepIndex,
      agent,
      task: "",
      model: "",
      status: settled ? "completed" : "running",
      ...(phase !== undefined ? { phase } : {}),
      startedAt: "2026-09-28T00:00:00.000Z",
      ...(settled ? { completedAt: "2026-09-28T00:00:01.000Z" } : {}),
    };
  }

  describe("buildPhaseGroups × fold 派生视图同源（D3/检查点 6 展示侧）", () => {
    /** 基准流：p1 两 call 全落定（含 phase-settled）、p2 一 call 在途、崩溃收编。 */
    const baseEvents = seqEvents([
      { type: "run-created", ts: 1, runId: "wf-1", workflowName: "demo", argsSummary: "{}" },
      { type: "phase-started", ts: 2, phase: "p1" },
      { type: "agent-started", ts: 3, taskIndex: 1, agentName: "alpha", attempt: 1, phase: "p1" },
      { type: "agent-settled", ts: 4, taskIndex: 1, attempt: 1, outcome: "done", durationMs: 10 },
      { type: "agent-started", ts: 5, taskIndex: 2, agentName: "beta", attempt: 1, phase: "p1" },
      { type: "agent-settled", ts: 6, taskIndex: 2, attempt: 1, outcome: "done", durationMs: 10 },
      { type: "phase-settled", ts: 7, phase: "p1" },
      { type: "phase-started", ts: 8, phase: "p2" },
      { type: "agent-started", ts: 9, taskIndex: 3, agentName: "gamma", attempt: 1, phase: "p2" },
      { type: "run-interrupted", ts: 10, errorCode: "crashed" },
    ]);
    const baseNodes = [
      traceNode(1, "alpha", "p1", true),
      traceNode(2, "beta", "p1", true),
      traceNode(3, "gamma", "p2", false),
    ];

    it("分组归属同源：组名集 ≡ fold phases 派生视图键集（数据源 = agent-started 的 phase 载荷）", () => {
      const fold = foldRunEventCheckpoint(baseEvents, () => {}, freshFold());
      const groups = buildPhaseGroups(baseNodes, fold.phases);
      expect(new Set(groups.map((g) => g.name))).toEqual(new Set([...fold.phases.keys()]));
      expect(groups.map((g) => g.nodes.map((n) => n.stepIndex))).toEqual([[1, 2], [3]]);
    });

    it("完成判定同源：fold settledAt 有无 ⟷ 组 settled（p1 settled / p2 running）", () => {
      const fold = foldRunEventCheckpoint(baseEvents, () => {}, freshFold());
      const groups = buildPhaseGroups(baseNodes, fold.phases);
      const p1 = groups.find((g) => g.name === "p1")!;
      const p2 = groups.find((g) => g.name === "p2")!;
      expect(fold.phases.get("p1")!.settledAt).toBeDefined();
      expect(p1.settled).toBe(true);
      expect(p1.doneCount).toBe(2);
      expect(fold.phases.get("p2")!.settledAt).toBeUndefined();
      expect(p2.settled).toBe(false);
      expect(p2.doneCount).toBe(0);
    });

    it("完整事件流上，未注入派生视图的节点计数推导 ≡ fold 派生视图判定（活体既有调用形态的同源性）", () => {
      const fold = foldRunEventCheckpoint(baseEvents, () => {}, freshFold());
      const withProjection = buildPhaseGroups(baseNodes, fold.phases);
      const derived = buildPhaseGroups(baseNodes);
      expect(derived.map((g) => [g.name, g.settled])).toEqual(
        withProjection.map((g) => [g.name, g.settled]),
      );
    });

    it("D3 自愈窗口：phase-started 缺失（postMessage 丢失）→ fold 按 agent-started 载荷自愈建行，分组归组不受影响", () => {
      const events = baseEvents.filter((e) => !(e.type === "phase-started" && e.phase === "p1"));
      const fold = foldRunEventCheckpoint(events, () => {}, freshFold());
      expect(fold.phases.has("p1")).toBe(true); // 自愈行在场（startedAt = 首 agent-started ts）
      expect(fold.phases.get("p1")!.startedAt).toBe(3);
      const groups = buildPhaseGroups(baseNodes, fold.phases);
      expect(groups.map((g) => g.name).sort()).toEqual(["p1", "p2"]);
    });

    it("无 phase 归属节点 → (default) 匿名组；fold 派生视图无该行 → 计数推导兜底", () => {
      const nodes = [traceNode(1, "alpha", undefined, true), traceNode(2, "beta", undefined, false)];
      const fold = foldRunEventCheckpoint(seqEvents([
        { type: "run-created", ts: 1, runId: "wf-2", workflowName: "d", argsSummary: "{}" },
        { type: "agent-started", ts: 2, taskIndex: 1, agentName: "alpha", attempt: 1 },
        { type: "agent-settled", ts: 3, taskIndex: 1, attempt: 1, outcome: "done", durationMs: 1 },
        { type: "agent-started", ts: 4, taskIndex: 2, agentName: "beta", attempt: 1 },
      ]), () => {}, freshFold());
      const groups = buildPhaseGroups(nodes, fold.phases);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.name).toBe("");
      expect(groups[0]!.settled).toBe(false); // doneCount 1/2 → 推导兜底 false
      expect(fold.phases.size).toBe(0);
    });

    it("formatPhaseLine 的 dot 随组 settled 切换（settled → success 色 / 未 settled → warning 色）", () => {
      const fold = foldRunEventCheckpoint(baseEvents, () => {}, freshFold());
      const groups = buildPhaseGroups(baseNodes, fold.phases);
      const p1Line = formatPhaseLine(groups.find((g) => g.name === "p1")!, 0, false, markingTheme, 40);
      const p2Line = formatPhaseLine(groups.find((g) => g.name === "p2")!, 1, false, markingTheme, 40);
      expect(p1Line).toContain("success(●)");
      expect(p2Line).toContain("warning(●)");
      expect(p1Line).toContain("1 p1 2/2");
      expect(p2Line).toContain("2 p2 0/1");
    });
  });

  // ============================================================
  // [§2.2] run 域展示映射的可见错误回归
  // ============================================================
  describe("run 域展示映射（§2.2 回归）", () => {
    it("formatStatusBadge('done') 出 success 徽标而非 muted 裸字（对拍锚：与 formatRunBadge 同文案表）", () => {
      // formatStatusBadge 与 formatRunBadge 同一徽标文案表：done 终局出 success 徽标，
      // 不落 default 的 muted 裸字。
      expect(formatStatusBadge("done", markingTheme)).toBe("success(✓ completed)");
      // 既有词表分支不被去重破坏
      expect(formatStatusBadge("completed", markingTheme)).toBe("success(✓ completed)");
      expect(formatStatusBadge("running", markingTheme)).toBe("warning(● running)");
      expect(formatStatusBadge("failed", markingTheme)).toBe("error(✗ failed)");
    });

    it("statusDotStr 的色档与徽标一致：预算耗尽/超时归 error，中断归 muted", () => {
      // statusDotStr 经私有 statusColorToken；此前 budget_limited/time_limited 落 muted，
      // 与 formatStatusBadge 的 error 档冲突（同一状态一个当错误一个当灰）。
      expect(statusDotStr("budget_limited", markingTheme)).toContain("error(");
      expect(statusDotStr("time_limited", markingTheme)).toContain("error(");
      expect(statusDotStr("interrupted", markingTheme)).toContain("muted(");
      expect(statusDotStr("completed", markingTheme)).toContain("success(");
      // §3.3.8 cancelled（run 终局收尾在途成员）=「未交付且非失败」中性档，与 interrupted 同 muted
      expect(statusDotStr("cancelled", markingTheme)).toContain("muted(");
    });
  });

  // ============================================================
  // formatEventLine / formatTraceEventLine / formatDisplayItem /
  // formatStatusBadge(default) / firstLineSanitized — 分支直测补面
  // （消费方渲染路径经 list-component / detail-content / bg-notify 测试覆盖，
  //   此处钉住导出纯函数自身的词表分支，与渲染测试互补）
  // ============================================================
  describe("formatEventLine 词表分支", () => {
    const entry = (over: Partial<AgentEventLogEntry>): AgentEventLogEntry =>
      ({ type: "tool_start", label: "read", ts: 0, ...over }) as AgentEventLogEntry;

    it("tool_end：done → ✓ success / failed → ✗ error", () => {
      expect(formatEventLine(entry({ type: "tool_end", status: "done" }), markingTheme))
        .toBe("tool: read success(✓)");
      expect(formatEventLine(entry({ type: "tool_end", status: "failed" }), markingTheme))
        .toBe("tool: read error(✗)");
    });

    it("turn_end：空摘要/turn 占位 → dim ── turn ──；有摘要 → toolOutput 摘要", () => {
      expect(formatEventLine(entry({ type: "turn_end", label: "turn" }), markingTheme))
        .toBe("dim(── turn ──)");
      expect(formatEventLine(entry({ type: "turn_end", label: "调查完成，待复核" }), markingTheme))
        .toBe("toolOutput(调查完成，待复核)");
    });

    it("error → label + ✗；未知类型 → 裸 label（default 分支）", () => {
      expect(formatEventLine(entry({ type: "error" }), markingTheme)).toBe("tool: read error(✗)");
      expect(formatEventLine(entry({ type: "mystery" as never }), markingTheme)).toBe("read");
    });
  });

  describe("formatTraceEventLine 词表分支（detail live Activity 行）", () => {
    const entry = (over: Partial<AgentEventLogEntry>): AgentEventLogEntry =>
      ({ type: "tool_start", label: "write", ts: 0, ...over }) as AgentEventLogEntry;

    it("tool_start → →；tool_end done/failed → ✓/✗（error 档）；turn_end → dim ∘；error → ✗；未知 → 裸 label", () => {
      expect(formatTraceEventLine(entry({ type: "tool_start" }), markingTheme)).toBe("→ write");
      expect(formatTraceEventLine(entry({ type: "tool_end", status: "done" }), markingTheme)).toBe("✓ write");
      expect(formatTraceEventLine(entry({ type: "tool_end", status: "failed" }), markingTheme)).toBe("error(✗ write)");
      expect(formatTraceEventLine(entry({ type: "turn_end", label: "t1" }), markingTheme)).toBe("dim(∘ t1)");
      expect(formatTraceEventLine(entry({ type: "error" }), markingTheme)).toBe("error(✗ write)");
      expect(formatTraceEventLine(entry({ type: "mystery" as never }), markingTheme)).toBe("write");
    });
  });

  describe("formatDisplayItem 分支", () => {
    it("text 项 → toolOutput 正文（缺省空串）", () => {
      expect(formatDisplayItem({ type: "text", text: "hello" }, markingTheme)).toBe("toolOutput(hello)");
      expect(formatDisplayItem({ type: "text" }, markingTheme)).toBe("toolOutput()");
    });

    it("tool 项：name/args 缺省兜底 + done/failed 尾标 + 进行中无尾标", () => {
      expect(formatDisplayItem({ type: "tool" }, markingTheme)).toContain("unknown");
      expect(formatDisplayItem({ type: "tool", name: "bash", args: { command: "ls" }, status: "done" }, markingTheme))
        .toContain("success(✓)");
      expect(formatDisplayItem({ type: "tool", name: "bash", args: { command: "ls" }, status: "failed" }, markingTheme))
        .toContain("error(✗)");
      expect(formatDisplayItem({ type: "tool", name: "bash", args: { command: "ls" } }, markingTheme))
        .not.toContain("✓");
    });
  });

  describe("formatStatusBadge 兜底分支", () => {
    it("词表外状态（pending）→ muted 裸字（与 muted 档 default 一致）", () => {
      expect(formatStatusBadge("pending", markingTheme)).toBe("muted(pending)");
    });
  });

  describe("firstLineSanitized", () => {
    it("取首个非空行并压平残余换行/Tab（sanitizeLabel 口径）", () => {
      expect(firstLineSanitized("\n\n  second line\nthird\tline")).toBe("second line");
      expect(firstLineSanitized(undefined)).toBe("");
      expect(firstLineSanitized("a\tb")).toBe("a  b");
    });
  });
});

// ======== 来源：list-component.test.ts ========
describe("list-component", () => {
  // ── KeyResult 常量（语义清晰，避到处写字面量对象） ──

  const KEY_NONE: KeyResult = { changed: false, exit: false };

  const KEY_CHANGED: KeyResult = { changed: true, exit: false };

  const KEY_EXIT: KeyResult = { changed: false, exit: true };

  // ── 键序列（pi-tui 实装，processKey 直测用；node_modules @earendil-works/pi-tui/dist/
  //    keys.js LEGACY_KEY_SEQUENCES + KEY_CODES，与运行时 matchesKey 判定同源） ──

  const ESC = "\x1b";

  const UP = "\x1b[A";

  const DOWN = "\x1b[B";

  const ENTER = "\r";

  const RETURN = "\n";

  const BACKSPACE = "\x7f";

  const PAGE_UP = "\x1b[5~";

  const PAGE_DOWN = "\x1b[6~";

  const HOME = "\x1b[H";

  const END = "\x1b[F";

  // ── stub 工厂 ──

  /** 透传 theme（list-component 经 format.ts 调用 fg/bold，ThemeLike 要求 4 方法齐全）。 */
  function makeTheme(): ThemeLike {
    return {
      fg: (_tag: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      underline: (text: string) => text,
    } as ThemeLike;
  }

  /** service stub：list-component 只调 collectRecords(limit) 单参数 + getFullRecord（[perf]
 *  选中项详情懒加载，mock 回 undefined → fullRecordOf 回退 light record，与旧行为一致）。
 *  部分对象直接断言为 SubagentService（duck-type）。
 *  [D4 聚合跟随] 读侧经 service.queries（成员与平铺键同引用，spy 断言不受影响）。 */
  function makeService(records: SubagentRecord[] = []): SubagentService {
    const collectRecords = vi.fn(() => records);
    const getFullRecord = vi.fn(() => undefined as SubagentRecord | undefined);
    return {
      collectRecords,
      getFullRecord,
      queries: {
        collectRecords,
        getFullRecord,
        findRecord: vi.fn(() => undefined),
        lookupRecordAnyState: vi.fn(() => undefined),
        onChange: vi.fn(() => () => {}),
      },
    } as unknown as SubagentService;
  }

  /** processKey 直测的最小 service stub：两阶段键位只触达 cancel。 */
  function makeCancelService(cancel: (id: string) => boolean = () => true): SubagentService {
    return { cancel } as unknown as SubagentService;
  }

  /** record fixture（字段见 types.ts SubagentRecord）。 */
  function makeRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
    return {
      id: "run-1",
      agent: "worker",
      task: "do the thing",
      status: "closed",
      mode: "sync",
      startedAt: 1000,
      endedAt: 2000,
      rootSessionId: undefined,
      parentRecordId: undefined,
      depth: 0,
      turns: 1,
      totalTokens: 10,
      model: "test/model",
      thinkingLevel: undefined,
      eventLog: [],
      displayItems: [],
      result: "ok",
      error: undefined,
      sessionFile: undefined,
      ...over,
    };
  }

  /** 构造 N 条 records（agent/task 含索引便于断言可见性）。 */
  function makeRecords(n: number): SubagentRecord[] {
    return Array.from({ length: n }, (_, i) =>
      makeRecord({ id: `run-${i}`, agent: `agent-${i}`, task: `task-${i}` }),
    );
  }

  type MakeOpts = {
    records?: SubagentRecord[];
    rows?: number;
    selectedIdx?: number;
    detailMode?: boolean;
    keyHandler?: KeyHandler;
  }

  /** 构造组件 + 暴露 service/tui/state 供断言。 */
  function makeComponent(opts: MakeOpts = {}) {
    const records = opts.records ?? [];
    const service = makeService(records);
    const theme = makeTheme();
    const tui = {
      requestRender: vi.fn(),
      terminal: { rows: opts.rows ?? 24 },
    };
    const state: ViewState = {
      selectedIdx: opts.selectedIdx ?? 0,
      scrollOffset: 0,
      filterText: "",
      detailMode: opts.detailMode ?? false,
      disposed: false,
      syncCancelHint: false,
    };
    const keyHandler: KeyHandler = opts.keyHandler ?? (() => KEY_NONE);
    const comp = new SubagentsListComponent(
      service,
      theme,
      tui as TuiLike,
      state,
      () => {},
      () => {},
      keyHandler,
    );
    return { comp, service, theme, tui, state };
  }

  // ============================================================
  // SubagentsListComponent
  // ============================================================
  describe("SubagentsListComponent", () => {
    beforeEach(() => {
      // spinner 帧由 Math.floor(Date.now()/250) 选取，锁定时间避免 flaky。
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // ── render 三分支调度 ──────────────────────────────────
    describe("render 分支调度", () => {
      it("rows < MIN_TERM_ROWS(8) → too small 提示", () => {
        const { comp } = makeComponent({ records: [], rows: 5 });
        const joined = comp.render(80).join("\n");
        expect(joined).toContain("too small");
        expect(joined).toContain("need >=");
      });

      it("空 records → emptyBox（含 (no subagent records) 文案）", () => {
        const { comp } = makeComponent({ records: [], rows: 24 });
        const joined = comp.render(80).join("\n");
        expect(joined).toContain("(no subagent records)");
        // 紧凑小框不渲染分屏分区线
        expect(joined).not.toContain("Records");
      });

      it("有 records → splitBox（含 record 的 task + agent 文本）", () => {
        const rec = makeRecord({ agent: "researcher", task: "investigate bug" });
        const { comp } = makeComponent({ records: [rec], rows: 24 });
        const joined = comp.render(80).join("\n");
        expect(joined).toContain("researcher"); // 左列 agent
        expect(joined).toContain("investigate bug"); // 右列 task 首行
        expect(joined).toContain("Records"); // 分区线标题
        expect(joined).toContain("Detail");
      });
    });

    // ── hasRunning ────────────────────────────────────────
    describe("hasRunning", () => {
      it("records 全是 closed（终态）→ false", () => {
        const { comp } = makeComponent({
          // v4 B-1：done/failed 等旧终态已收敛为 closed（fixture 同步迁移）
          records: [makeRecord({ status: "closed" }), makeRecord({ status: "closed" })],
        });
        expect(comp.hasRunning()).toBe(false);
      });

      it("records 含一个 running → true", () => {
        const { comp } = makeComponent({
          records: [
            makeRecord({ id: "a", status: "closed" }),
            makeRecord({ id: "b", status: "running" }),
          ],
        });
        expect(comp.hasRunning()).toBe(true);
      });
    });

    // ── 左列视口窗口 ──────────────────────────────────────
    describe("左列视口窗口", () => {
      it("records 数 > bodyH → render 行数 ≤ rows（不溢出终端）", () => {
        // rows=24 → 内框高 innerRows = 24 - PAD_ROWS(2) = 22；bodyH = 22 - SPLIT_FIXED_LINES(6) = 16。
        // 30 条 records 远超 bodyH，选中行在中间。断言输出总行数 == rows（overlay 填满全屏），
        // 且左列只渲染 bodyH 条（不溢出导致底框被推出终端）。
        const records = makeRecords(30);
        const { comp } = makeComponent({ records, rows: 24, selectedIdx: 15 });
        const lines = comp.render(80);
        expect(lines.length).toBe(24); // 填满全屏，不溢出
        // 中间 record 的 agent 不在视口窗口外应仍可见（窗口居中显示 selectedIdx 附近）。
        const joined = lines.join("\n");
        expect(joined).toContain("agent-15"); // 选中行在视口内
      });

      it("selectedIdx 在尾部 → 视口贴底（最后一条可见）", () => {
        const records = makeRecords(30);
        const { comp } = makeComponent({ records, rows: 24, selectedIdx: 29 });
        const joined = comp.render(80).join("\n");
        expect(joined).toContain("agent-29"); // 尾部 record 仍可见（视口贴底）
      });
    });

    // ── 右列预览兜底链 ────────────────────────────────────
    describe("右列预览兜底链 (renderRightPreview)", () => {
      it("record 有 displayItems → 输出含 displayItems 内容", () => {
        const rec = makeRecord({
          displayItems: [{ type: "text", text: "partial analysis output" }],
        });
        const { comp } = makeComponent({ records: [rec], rows: 24 });
        const joined = comp.render(80).join("\n");
        expect(joined).toContain("partial analysis output");
      });

      it("record 无 displayItems 但有 eventLog → 回退 eventLog（输出含 event 标签）", () => {
        const rec = makeRecord({
          displayItems: [],
          eventLog: [{ type: "tool_start", label: "Read file.ts", ts: 1500 }],
        });
        const { comp } = makeComponent({ records: [rec], rows: 24 });
        const joined = comp.render(80).join("\n");
        // formatEventLine 的 tool_start 输出 "tool: <label>"
        expect(joined).toContain("tool:");
        expect(joined).toContain("Read file.ts");
      });

      it("record 两者都无 → 输出 (no output) 兜底文案", () => {
        const rec = makeRecord({ displayItems: [], eventLog: [] });
        const { comp } = makeComponent({ records: [rec], rows: 24 });
        const joined = comp.render(80).join("\n");
        expect(joined).toContain("(no output)");
      });
    });

    // ── handleInput ───────────────────────────────────────
    describe("handleInput", () => {
      it("disposed → 直接返回，不调用 keyHandler", () => {
        const keyHandler = vi.fn(() => KEY_NONE);
        const { comp, state } = makeComponent({ keyHandler });
        state.disposed = true;
        comp.handleInput("x");
        expect(keyHandler).not.toHaveBeenCalled();
      });

      it("keyHandler 返回 exit → 调用 closeFn 关闭 overlay", () => {
        const keyHandler = vi.fn(() => KEY_EXIT);
        const { comp } = makeComponent({ keyHandler });
        const closeFn = vi.fn();
        comp.setCloseFn(closeFn);
        comp.handleInput("\x1b"); // Esc
        expect(closeFn).toHaveBeenCalledTimes(1);
      });

      it("keyHandler 返回 changed → invalidate + requestRender", () => {
        const keyHandler = vi.fn(() => KEY_CHANGED);
        const { comp, tui } = makeComponent({ keyHandler });
        comp.handleInput("\x1b[B"); // Down
        expect(tui.requestRender).toHaveBeenCalledTimes(1);
      });

      it("keyHandler 返回 none → 不 invalidate / 不 close / 不 requestRender", () => {
        const keyHandler = vi.fn(() => KEY_NONE);
        const closeFn = vi.fn();
        const { comp, tui } = makeComponent({ keyHandler });
        comp.setCloseFn(closeFn);
        comp.handleInput("x");
        expect(closeFn).not.toHaveBeenCalled();
        expect(tui.requestRender).not.toHaveBeenCalled();
      });

      it("exit 优先于 changed（exit=true 时只 close，不 requestRender）", () => {
        const keyHandler = vi.fn(() => ({ changed: true, exit: true }));
        const closeFn = vi.fn();
        const { comp, tui } = makeComponent({ keyHandler });
        comp.setCloseFn(closeFn);
        comp.handleInput("\x1b");
        expect(closeFn).toHaveBeenCalledTimes(1);
        expect(tui.requestRender).not.toHaveBeenCalled();
      });
    });

    // ── render 缓存 ───────────────────────────────────────
    describe("render 缓存", () => {
      it("相同 width 连续两次 render → 返回相同结果（缓存命中）", () => {
        const records = [makeRecord({ agent: "cached-agent" })];
        const { comp } = makeComponent({ records, rows: 24 });
        const first = comp.render(80);
        const second = comp.render(80);
        // 缓存命中：返回同一引用（buildLines 未重新执行）。
        expect(second).toBe(first);
      });

      it("invalidate 后再 render → 重建（结果内容相同但引用不同）", () => {
        const records = [makeRecord()];
        const { comp } = makeComponent({ records, rows: 24 });
        const first = comp.render(80);
        comp.invalidate();
        const second = comp.render(80);
        expect(second).not.toBe(first); // 引用不同 → 重建
        expect(second).toEqual(first); // 内容相同
      });

      it("不同 width → 不命中缓存（重新构建）", () => {
        const records = [makeRecord()];
        const { comp } = makeComponent({ records, rows: 24 });
        const w80 = comp.render(80);
        const w100 = comp.render(100);
        // 宽度不同 → 不同 key → 重建。行数应随宽度变化内容（至少引用不同）。
        expect(w100).not.toBe(w80);
      });
    });

    // ── detailMode 切换 ───────────────────────────────────
    describe("detailMode 切换", () => {
      it("detailMode=true → footer 含 Esc back + 右侧锚定提示 Pinned", () => {
        const rec = makeRecord({ agent: "pinned-agent" });
        const { comp } = makeComponent({ records: [rec], rows: 24, detailMode: true });
        const joined = comp.render(80).join("\n");
        expect(joined).toContain("Esc back to list");
        expect(joined).toContain("Pinned:");
        expect(joined).toContain("pinned-agent");
      });

      it("detailMode=false → footer 含 navigate / Enter detail（非锚定文案）", () => {
        const rec = makeRecord();
        const { comp } = makeComponent({ records: [rec], rows: 24, detailMode: false });
        const joined = comp.render(80).join("\n");
        expect(joined).toContain("Enter detail");
        expect(joined).not.toContain("Pinned:");
      });

      it("detailMode 下完整详情含 result + sessionFile（预览阶段不显示 sessionFile）", () => {
        const rec = makeRecord({
          result: "final report content",
          sessionFile: "/tmp/session-abc.jsonl",
        });
        // 预览阶段
        const previewComp = makeComponent({ records: [rec], rows: 24, detailMode: false });
        const previewJoined = previewComp.comp.render(80).join("\n");
        expect(previewJoined).toContain("Enter for full detail"); // 预览阶段提示
        // 详情阶段
        const detailComp = makeComponent({ records: [rec], rows: 24, detailMode: true });
        const detailJoined = detailComp.comp.render(80).join("\n");
        expect(detailJoined).toContain("final report content"); // Result 段
        expect(detailJoined).toContain("Result:");
        expect(detailJoined).toContain("session-abc.jsonl"); // sessionFile
      });

      // ── [U8 / §3.2.1 展示层词汇收敛] stopReason 只在详情/排障面板出现 ──
      it("detail 元数据行：idle ∧ stopReason → 追加 stopped: <reason>；running / 无字段省略", () => {
        const idleRec = makeRecord({ id: "sa-idle", status: "idle", stopReason: "interrupted" });
        const { comp } = makeComponent({ records: [idleRec], rows: 24, detailMode: true });
        const joined = comp.render(80).join("\n");
        expect(joined).toContain("stopped: interrupted");

        // running（在途，无停因）与无 stopReason 的 idle（存量数据）不出现停因段
        const runningRec = makeRecord({ id: "sa-run", status: "running" });
        const runComp = makeComponent({ records: [runningRec], rows: 24, detailMode: true });
        expect(runComp.comp.render(80).join("\n")).not.toContain("stopped:");
        const legacyRec = makeRecord({ id: "sa-legacy", status: "idle" });
        const legacyComp = makeComponent({ records: [legacyRec], rows: 24, detailMode: true });
        expect(legacyComp.comp.render(80).join("\n")).not.toContain("stopped:");
      });
    });

    // ── 帧缓存 collectRecordsFrame（TC3/IF3/DM5）──────────
    describe("帧缓存 collectRecordsFrame", () => {
      it("同一帧（TTL 50ms 内）hasRunning + render 只触发 1 次 service.collectRecords", () => {
        // fake timers 已锁 Date.now()（beforeEach）→ 帧内多次消费共享同一份 records
        const rec = makeRecord({ id: "a", status: "running" });
        const { comp, service } = makeComponent({ records: [rec], rows: 24 });
        expect(comp.hasRunning()).toBe(true); // 第 1 次扫描
        comp.render(80); // buildLines 消费（帧命中，不重扫）
        comp.handleInput("x"); // handleInput 消费（帧命中）
        expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(1);
      });

      it("advance 100ms 后 TTL 过期 → 重扫（collectRecords 递增）", () => {
        const rec = makeRecord({ id: "a", status: "running" });
        const { comp, service } = makeComponent({ records: [rec], rows: 24 });
        comp.render(80);
        expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(100); // > FRAME_TTL_MS(50)
        // 镜像 animTimer 真实序列：hasRunning（帧消费点）→ invalidate → render。
        // hasRunning 直接走帧缓存（不经 render 行缓存），TTL 过期 → 重扫
        expect(comp.hasRunning()).toBe(true);
        expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(2);
        comp.invalidate();
        comp.render(80); // 重建行，但帧刚刷新（100ms 后的同一时刻）→ 不再重扫
        expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(2);
      });

      it("invalidate 不清帧缓存：invalidate 后同帧 render 仍命中（不重扫）", () => {
        // timer 序列 hasRunning → invalidate → requestRender 的共享前提：
        // invalidate 只清渲染行缓存（cachedKey/cachedLines），帧缓存由 TTL 独立保证
        const rec = makeRecord({ id: "a", status: "running" });
        const { comp, service } = makeComponent({ records: [rec], rows: 24 });
        const first = comp.render(80);
        expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(1);
        comp.invalidate();
        const second = comp.render(80);
        expect(second).not.toBe(first); // 渲染行缓存已清 → 重建
        expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(1); // 帧缓存未清 → 不重扫
      });

      it("detailMode 渲染路径（buildDetailContent children）同帧共享：render 仍只 1 次扫描", () => {
        // 选中项有子 record → buildDetailContent 内 children 计算消费 collectRecordsFrame
        const parent = makeRecord({ id: "p", status: "closed" });
        const child = makeRecord({ id: "c", parentRecordId: "p" });
        const { comp, service } = makeComponent({ records: [parent, child], rows: 24, detailMode: true });
        const joined = comp.render(80).join("\n");
        expect(joined).toContain("children:");
        expect(vi.mocked(service.collectRecords)).toHaveBeenCalledTimes(1); // buildLines + children 同帧合一
      });
    });
  });

  // ============================================================
  // processKey（list-view）纯函数直接单测——两阶段焦点按键分发。
  // 重构前该函数无直接测试（仅经上方 keyHandler 注入间接触达），
  // 以下补齐阶段 1（list）/ 阶段 2（detail）全键位覆盖。
  // 键序列取 pi-tui 实装（见文件头部键序列常量注释），与运行时 matchesKey 判定同源。
  // ============================================================

  // ── fixture 工厂（对齐上方 list-component 用例形态，makeRecord 共用） ──

  function makeState(over: Partial<ViewState> = {}): ViewState {
    return {
      selectedIdx: 0,
      scrollOffset: 0,
      filterText: "",
      detailMode: false,
      disposed: false,
      ...over,
    };
  }

  function makeNotify() {
    // vi.fn() 可调用形态与 NotifyFn 结构兼容；断言走 .mock.calls
    return vi.fn();
  }

  function call(
    data: string,
    state: ViewState,
    opts: {
      records?: SubagentRecord[];
      selected?: SubagentRecord | null;
      service?: SubagentService | null;
      detailCtx?: DetailKeyContext;
      notify?: NotifyFn;
    } = {},
  ) {
    return processKey(
      data,
      opts.records ?? [makeRecord()],
      state,
      opts.selected ?? null,
      opts.service ?? null,
      opts.detailCtx,
      opts.notify,
    );
  }

  // ============================================================
  // 阶段 1（list 焦点，detailMode=false）
  // ============================================================
  describe("processKey — 阶段 1（list）", () => {
    it("escape with filter clears it and resets selection (changed, no exit)", () => {
      const state = makeState({ filterText: "wo" });
      const r = call(ESC, state);
      expect(state.filterText).toBe("");
      expect(state.selectedIdx).toBe(0);
      expect(r).toEqual({ changed: true, exit: false });
    });

    it("escape without filter exits the overlay (no change)", () => {
      const r = call(ESC, makeState());
      expect(r).toEqual({ changed: false, exit: true });
    });

    it("up clamps at 0", () => {
      const state = makeState({ selectedIdx: 0 });
      const r = call(UP, state);
      expect(state.selectedIdx).toBe(0);
      expect(r).toEqual({ changed: true, exit: false });
    });

    it("up moves selection up", () => {
      const state = makeState({ selectedIdx: 2 });
      call(UP, state);
      expect(state.selectedIdx).toBe(1);
    });

    it("down clamps at records.length - 1", () => {
      const records = [makeRecord(), makeRecord({ id: "run-2" })];
      const state = makeState({ selectedIdx: 1 });
      const r = call(DOWN, state, { records });
      expect(state.selectedIdx).toBe(1);
      expect(r).toEqual({ changed: true, exit: false });
    });

    it("enter with selected record enters detail mode top-aligned", () => {
      const selected = makeRecord();
      const state = makeState({ selectedIdx: 0, scrollOffset: 7 });
      const r = call(ENTER, state, { selected });
      expect(state.detailMode).toBe(true);
      expect(state.scrollOffset).toBe(0);
      expect(r).toEqual({ changed: true, exit: false });
    });

    it("return key behaves identically to enter", () => {
      const state = makeState();
      const r = call(RETURN, state, { selected: makeRecord() });
      expect(state.detailMode).toBe(true);
      expect(r).toEqual({ changed: true, exit: false });
    });

    it("enter without selection is a no-op (none)", () => {
      const state = makeState();
      const r = call(ENTER, state, { records: [], selected: null });
      expect(state.detailMode).toBe(false);
      expect(r).toEqual({ changed: false, exit: false });
    });

    it("backspace deletes last filter char; without filter is none", () => {
      const state = makeState({ filterText: "abc" });
      const r = call(BACKSPACE, state);
      expect(state.filterText).toBe("ab");
      expect(state.selectedIdx).toBe(0);
      expect(r).toEqual({ changed: true, exit: false });

      const empty = makeState();
      const r2 = call(BACKSPACE, empty);
      expect(r2).toEqual({ changed: false, exit: false });
    });

    it("printable ascii char appends to filter", () => {
      const state = makeState({ filterText: "ru" });
      const r = call("n", state);
      expect(state.filterText).toBe("run");
      expect(r).toEqual({ changed: true, exit: false });
    });

    it("unhandled multi-char sequence (pageUp) in list stage is none, not filter input", () => {
      const state = makeState();
      const r = call(PAGE_UP, state);
      expect(state.filterText).toBe("");
      expect(r).toEqual({ changed: false, exit: false });
    });
  });

  // ============================================================
  // 阶段 2（detail 焦点，detailMode=true）
  // ============================================================
  describe("processKey — 阶段 2（detail）", () => {
    const detailCtx: DetailKeyContext = { viewportHeight: 5, contentLines: 10 };

    it("escape returns to list and resets scroll to top", () => {
      const state = makeState({ detailMode: true, scrollOffset: 4 });
      const r = call(ESC, state);
      expect(state.detailMode).toBe(false);
      expect(state.scrollOffset).toBe(0);
      expect(r).toEqual({ changed: true, exit: false });
    });

    it("up/down scroll by single step, clamped to [0, max]", () => {
      const state = makeState({ detailMode: true, scrollOffset: 3 });
      expect(call(UP, state, { detailCtx })).toEqual({ changed: true, exit: false });
      expect(state.scrollOffset).toBe(2);

      const bottom = makeState({ detailMode: true, scrollOffset: 5 });
      call(DOWN, bottom, { detailCtx });
      expect(bottom.scrollOffset).toBe(5); // max = contentLines - viewportHeight = 5

      const mid = makeState({ detailMode: true, scrollOffset: 2 });
      call(DOWN, mid, { detailCtx });
      expect(mid.scrollOffset).toBe(3);
    });

    it("pageUp/pageDown scroll by viewport height with clamping", () => {
      const state = makeState({ detailMode: true, scrollOffset: 4 });
      call(PAGE_UP, state, { detailCtx });
      expect(state.scrollOffset).toBe(0); // max(0, 4-5)

      const state2 = makeState({ detailMode: true, scrollOffset: 2 });
      call(PAGE_DOWN, state2, { detailCtx });
      expect(state2.scrollOffset).toBe(5); // min(max=5, 2+5)
    });

    it("home/end jump to top/bottom", () => {
      const state = makeState({ detailMode: true, scrollOffset: 3 });
      call(HOME, state, { detailCtx });
      expect(state.scrollOffset).toBe(0);

      const state2 = makeState({ detailMode: true, scrollOffset: 1 });
      call(END, state2, { detailCtx });
      expect(state2.scrollOffset).toBe(5);
    });

    it("pageUp without detailCtx falls back to PAGE_SCROLL_DEFAULT", () => {
      const state = makeState({ detailMode: true, scrollOffset: 3 });
      call(PAGE_UP, state);
      // PAGE_SCROLL_DEFAULT 来自 tui-kit（终端兜底步长）——只断言未越界为负即可钉住回退路径
      expect(state.scrollOffset).toBe(0);
    });

    it("x stops a running record via service.cancel and notifies info", () => {
      const cancel = vi.fn(() => true);
      const notify = makeNotify();
      const selected = makeRecord({ id: "run-9", status: "running" });
      const state = makeState({ detailMode: true });
      const r = call("x", state, { selected, service: makeCancelService(cancel), notify });
      expect(cancel).toHaveBeenCalledWith("run-9");
      expect(notify.mock.calls.some(([msg]) => msg === "Requested stop for run-9")).toBe(true);
      expect(r).toEqual({ changed: true, exit: false });
    });

    it("x on a non-running record only warns and does not change", () => {
      const cancel = vi.fn(() => true);
      const notify = makeNotify();
      const selected = makeRecord({ id: "run-9", status: "closed" });
      const state = makeState({ detailMode: true });
      const r = call("x", state, { selected, service: makeCancelService(cancel), notify });
      expect(cancel).not.toHaveBeenCalled();
      expect(notify.mock.calls.some(([msg]) => msg.startsWith("Cannot stop: record is closed"))).toBe(true);
      expect(r).toEqual({ changed: false, exit: false });
    });

    it("x without service notifies error and does not change", () => {
      const notify = makeNotify();
      const state = makeState({ detailMode: true });
      const r = call("x", state, { selected: makeRecord({ status: "running" }), service: null, notify });
      expect(notify.mock.calls.some(([msg]) => msg === "Runtime not ready, cannot stop")).toBe(true);
      expect(r).toEqual({ changed: false, exit: false });
    });

    it("unhandled key in detail stage is none (no state change)", () => {
      const state = makeState({ detailMode: true, scrollOffset: 1 });
      const r = call("z", state, { detailCtx });
      expect(r).toEqual({ changed: false, exit: false });
      expect(state.scrollOffset).toBe(1);
      expect(state.detailMode).toBe(true);
    });
  });
});

// ======== 来源：display-state.test.ts ========
describe("display-state", () => {
  const markingTheme: ThemeLike = {
    fg: (color, text) => `${color}(${text})`,
    bg: (color, text) => `${color}(${text})`,
    bold: (text) => `bold(${text})`,
    underline: (text) => `u(${text})`,
  };

  /** 每次构造唯一 runId——终局记录注册表按 runId 分区，跨用例不复用条目。 */
  let displayRunSeq = 0;

  /** 最小 run 形态（display-state 读 runSummary：runId/spec/meta/state 四组字段）。 */
  function makeRun(shape: {
    status?: string;
    reason?: string;
    interruptedAt?: string;
    budget?: { usedTokens: number; maxTokens?: number; usedCost: number };
  } = {}): WorkflowRun {
    const runId = `wf-display-${displayRunSeq++}`;
    const status = shape.status ?? "running";
    // [D6(a) 第 1 步] 终局判定源 = 终局记录注册表：done 形态 fixture 必须携带注册表
    // 条目（生产 = 壳重建点 noteRebuiltSettlement 注入 run-settled 帧事实）——
    // doneReason 经 outcome 往返（budget_limited 需 errorCode 同载）。
    if (status === "done") {
      const doneReason = (shape.reason ?? "completed") as DoneReason;
      noteRebuiltSettlement(runId, {
        outcome: doneReasonToRunOutcome(doneReason),
        ...(doneReason === "budget_limited" ? { errorCode: "budget_limited" as const } : {}),
        settledAt: Date.parse("2026-09-30T02:00:00.000Z"),
      });
    }
    return {
      runId,
      spec: { scriptName: "display-wf" },
      meta: { startedAt: "2026-09-30T00:00:00.000Z", ...(shape.interruptedAt ? { interruptedAt: shape.interruptedAt } : {}) },
      state: {
        status,
        ...(shape.reason !== undefined ? { reason: shape.reason } : {}),
        budget: shape.budget ?? { usedTokens: 0, maxTokens: 200_000, usedCost: 0 },
        trace: { toArray: () => [] },
        errorLogs: [],
      },
    } as unknown as WorkflowRun;
  }

  describe("runDisplayStateOf（三态派生视图与可中断性）", () => {
    it("running → status running + abortable", () => {
      const ds = runDisplayStateOf(makeRun());
      expect(ds.status).toBe("running");
      expect(ds.abortable).toBe(true);
      expect(ds.doneReason).toBeUndefined();
    });

    it("interrupted（meta.interruptedAt）→ 不可中断、无 doneReason", () => {
      const ds = runDisplayStateOf(makeRun({ interruptedAt: "2026-09-30T01:00:00.000Z" }));
      expect(ds.status).toBe("interrupted");
      expect(ds.abortable).toBe(false);
    });

    it("done + reason → 不可中断 + doneReason 透传", () => {
      const ds = runDisplayStateOf(makeRun({ status: "done", reason: "failed" }));
      expect(ds.status).toBe("done");
      expect(ds.abortable).toBe(false);
      expect(ds.doneReason).toBe("failed");
    });

    it("记账侧透传活体快照（含 maxTokens 缺席形态）", () => {
      const ds = runDisplayStateOf(makeRun({ budget: { usedTokens: 1234, usedCost: 0.5 } }));
      expect(ds.accounting).toEqual({ usedTokens: 1234, usedCost: 0.5 });
    });
  });

  describe("映射表（色调 / 徽标 / 失败族）", () => {
    it.each([
      [{}, "warning", "warning(● running)"],
      [{ interruptedAt: "t" }, "muted", "muted(○ interrupted)"],
      [{ status: "done", reason: "completed" }, "success", "success(✓ completed)"],
      [{ status: "done" }, "success", "success(✓ completed)"],
      [{ status: "done", reason: "failed" }, "error", "error(✗ failed)"],
      [{ status: "done", reason: "aborted" }, "error", "error(✗ aborted)"],
      [{ status: "done", reason: "budget_limited" }, "error", "error(⚠ budget)"],
      [{ status: "done", reason: "time_limited" }, "error", "error(⚠ timeout)"],
      // [subagent-observability §3.3.8 消费链①] partially_succeeded 独立档（不落失败族
      // 红档——「一半成功」呈现为全败 = 故障 B 反方向失真；场景 2 TUI 呈现断言）
      [{ status: "done", reason: "partially_succeeded" }, "warning", "warning(◐ partial)"],
    ] as const)("形态 %j → tone %s / badge %s", (shape, tone, badge) => {
      const ds = runDisplayStateOf(makeRun(shape as never));
      expect(runToneOf(ds)).toBe(tone);
      expect(formatRunBadge(ds, markingTheme)).toBe(badge);
    });

    it("失败族判定只认 done + 非 completed、非 partially_succeeded（§3.3.8 独立档排除）", () => {
      expect(isFailedTerminal(runDisplayStateOf(makeRun({ status: "done", reason: "failed" })))).toBe(true);
      expect(isFailedTerminal(runDisplayStateOf(makeRun({ status: "done", reason: "completed" })))).toBe(false);
      expect(isFailedTerminal(runDisplayStateOf(makeRun({ status: "done" })))).toBe(false);
      expect(isFailedTerminal(runDisplayStateOf(makeRun()))).toBe(false);
      expect(isFailedTerminal(runDisplayStateOf(makeRun({ status: "done", reason: "partially_succeeded" })))).toBe(false);
    });

    it("run 域徽标与 format.ts 的既有徽标逐字一致（同输入同输出，防两表漂移）", () => {
      const cases: Array<[never, string]> = [
        [{} as never, "running"],
        [{ interruptedAt: "t" } as never, "interrupted"],
        [{ status: "done", reason: "completed" } as never, "completed"],
        [{ status: "done", reason: "failed" } as never, "failed"],
        [{ status: "done", reason: "aborted" } as never, "aborted"],
        [{ status: "done", reason: "budget_limited" } as never, "budget_limited"],
        [{ status: "done", reason: "time_limited" } as never, "time_limited"],
      ];
      for (const [shape, legacyStatus] of cases) {
        const ds = runDisplayStateOf(makeRun(shape));
        expect(formatRunBadge(ds, markingTheme)).toBe(formatStatusBadge(legacyStatus as never, markingTheme));
      }
    });

    it("签名片段：生命周期侧全字段进签名（状态/原因/可中断性任一变化即失效）", () => {
      const running = runDisplaySignaturePart(runDisplayStateOf(makeRun()));
      const failed = runDisplaySignaturePart(runDisplayStateOf(makeRun({ status: "done", reason: "failed" })));
      const completed = runDisplaySignaturePart(runDisplayStateOf(makeRun({ status: "done", reason: "completed" })));
      expect(new Set([running, failed, completed]).size).toBe(3);
      expect(running).toContain("running");
    });
  });
});

// ======== 来源：list-view.test.ts ========
describe("list-view", () => {
  const ESC = "\x1b";

  const plainTheme: ThemeLike = {
    bg: (_color: string, text: string) => text,
    fg: (_tag: string, text: string) => text,
    bold: (text: string) => text,
    underline: (text: string) => text,
  };

  function makeRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
    return {
      id: "run-1",
      agent: "worker",
      task: "do the thing",
      status: "closed",
      mode: "sync",
      startedAt: 1000,
      endedAt: 2000,
      depth: 0,
      turns: 1,
      totalTokens: 10,
      model: "test/model",
      eventLog: [],
      displayItems: [],
      result: "ok",
      ...over,
    } as SubagentRecord;
  }

  interface ListComponentView { // oe-exempt:20260930:test:test double shape for component capture (test infra)
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
    hasRunning(): boolean;
  }

  interface Driver { // oe-exempt:20260930:test:test fixture harness shape (test infra)
    component: ListComponentView;
    done: Promise<void>;
    notifies: Array<{ msg: string; type?: string }>;
    service: {
      collectRecords: ReturnType<typeof vi.fn>;
      onChange: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
    };
    unsubscribe: ReturnType<typeof vi.fn>;
    tui: { terminal: { columns: number; rows: number }; requestRender: ReturnType<typeof vi.fn> };
  }

  function openDriver(opts: { records?: SubagentRecord[]; directId?: string } = {}): Driver {
    const records = opts.records ?? [makeRecord()];
    const unsubscribe = vi.fn();
    const collectRecords = vi.fn(() => records);
    const onChange = vi.fn(() => unsubscribe);
    const cancel = vi.fn(() => true);
    const getFullRecord = vi.fn(() => undefined as SubagentRecord | undefined);
    const service = {
      queries: { collectRecords, onChange, getFullRecord, findRecord: vi.fn(() => undefined), lookupRecordAnyState: vi.fn(() => undefined) },
      cancel,
    } as unknown as SubagentService;
    const tui = { terminal: { columns: 100, rows: 30 }, requestRender: vi.fn() };
    const notifies: Array<{ msg: string; type?: string }> = [];
    let component!: ListComponentView;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const ctx = {
      mode: "tui",
      ui: {
        notify: (msg: string, type?: string) => notifies.push({ msg, type }),
        custom: (
          factory: (t: unknown, th: unknown, kb: unknown, d: (v: void) => void) => ListComponentView,
        ): Promise<void> => {
          component = factory(tui, plainTheme, {}, () => resolveDone());
          return done;
        },
      },
    } as unknown as ExtensionContext;
    void createSubagentsView(service, plainTheme, ctx, opts.directId);
    return { component, done, notifies, service: { collectRecords, onChange, cancel }, unsubscribe, tui };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createSubagentsView factory", () => {
    it("打开即返回可用组件：render 出行、无 directId 时零 notify", () => {
      const d = openDriver();
      expect(d.component.render(100).length).toBeGreaterThan(0);
      expect(d.notifies).toEqual([]);
      expect(d.service.onChange).toHaveBeenCalledTimes(1);
    });

    it("directId 未命中 → warning notify，仍打开列表", () => {
      const d = openDriver({ directId: "ghost" });
      expect(d.notifies).toEqual([{ msg: 'No record found for id "ghost", showing all', type: "warning" }]);
      expect(d.component.render(100).length).toBeGreaterThan(0);
    });

    it("directId 命中 → 直接进详情模式（esc 先退详情而非关闭 overlay）", async () => {
      const d = openDriver({ directId: "run-1" });
      d.component.handleInput(ESC); // detailMode=true → 退出详情，overlay 保持
      const resolved = await Promise.race([d.done.then(() => true), Promise.resolve(false)]);
      expect(resolved).toBe(false);
      expect(d.unsubscribe).not.toHaveBeenCalled();
      // 再按 esc（list 模式无 filter）→ 关闭
      d.component.handleInput(ESC);
      await d.done;
      expect(d.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("G-017 防叠加：第二个 overlay 打开时关闭前一个（前一 done 落定 + 解订）", async () => {
      const d1 = openDriver();
      const d2 = openDriver();
      await d1.done; // 前一个被 activeView.close() 关闭
      expect(d1.unsubscribe).toHaveBeenCalledTimes(1);
      // d2 仍存活：esc 关闭
      d2.component.handleInput(ESC);
      await d2.done;
      expect(d2.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("onChange 防抖：120ms 窗口内多次触发只重绘一次；disposed 后触发早退", async () => {
      const d = openDriver();
      const fire = d.service.onChange.mock.calls[0][0] as () => void;
      fire();
      fire();
      fire();
      vi.advanceTimersByTime(120);
      expect(d.tui.requestRender).toHaveBeenCalledTimes(1);
      // 关闭后触发 → disposed 早退，不再重绘
      d.component.handleInput(ESC);
      await d.done;
      const calls = d.tui.requestRender.mock.calls.length;
      fire();
      vi.advanceTimersByTime(120);
      expect(d.tui.requestRender.mock.calls.length).toBe(calls);
    });

    it("animTimer：有 running record 时 250ms 帧刷新；全终态后停止浪费刷新", () => {
      const d = openDriver({ records: [makeRecord({ status: "running" })] });
      expect(d.component.hasRunning()).toBe(true);
      vi.advanceTimersByTime(250);
      expect(d.tui.requestRender).toHaveBeenCalledTimes(1);
      // 记录集变全终态（collectRecords 每次重查）→ hasRunning false → 不再 invalidate
      (d.service.collectRecords as ReturnType<typeof vi.fn>).mockReturnValue([makeRecord({ status: "closed" })]);
      vi.advanceTimersByTime(250);
      expect(d.tui.requestRender).toHaveBeenCalledTimes(1);
    });

    it("wrappedDone 幂等：esc 关闭后重复关闭不再解订/不再 done", async () => {
      const d = openDriver();
      d.component.handleInput(ESC);
      await d.done;
      // 组件 closeFn 幂等（state.disposed 早退），二次 esc 无副作用
      d.component.handleInput(ESC);
      expect(d.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("cancel 接线：详情模式对 running record 按 x → service.cancel + info notify", () => {
      const d = openDriver({ records: [makeRecord({ id: "run-x", status: "running" })], directId: "run-x" });
      d.component.handleInput("x");
      expect(d.service.cancel).toHaveBeenCalledWith("run-x");
      expect(d.notifies).toEqual([{ msg: "Requested stop for run-x", type: "info" }]);
    });
  });
});

// ======== 来源：WorkflowsView.driver.test.ts ========
describe("WorkflowsView.driver", () => {
  // ── 键序列（pi-tui 实装转义序列，与 list-component.test.ts 同源） ──

  const ESC = "\x1b";

  const UP = "\x1b[A";

  const DOWN = "\x1b[B";

  const ENTER = "\r";

  const BACKSPACE = "\x7f";

  const PAGE_UP = "\x1b[5~";

  const PAGE_DOWN = "\x1b[6~";

  const HOME = "\x1b[H";

  const END = "\x1b[F";

  const T0 = 1_700_000_000_000;

  // ── fixtures ─────────────────────────────────────────────────

  /** plain theme：着色方法原样返回（断言业务文本而非 ANSI 码）。 */
  const plainTheme: ThemeLike = {
    bg: (_color: string, text: string) => text,
    fg: (_tag: string, text: string) => text,
    bold: (text: string) => text,
    underline: (text: string) => text,
  };

  function makeNode(stepIndex: number, over: Partial<ExecutionTraceNode> = {}): ExecutionTraceNode {
    return {
      stepIndex,
      agent: "worker",
      task: `task ${stepIndex} do things`,
      model: "test-model",
      status: "running",
      phase: "build",
      startedAt: new Date(T0 + stepIndex * 1000).toISOString(),
      ...over,
    } as ExecutionTraceNode;
  }

  /** 带两个显式 phase（build×2 + deploy×1）与一个无 phase 节点的默认 trace。 */
  function defaultNodes(): ExecutionTraceNode[] {
    return [
      makeNode(0),
      makeNode(1),
      makeNode(2, { phase: "deploy" }),
      makeNode(3, { phase: undefined }),
    ];
  }

  let driverRunSeq = 0;

  function makeRun(
    nodes: ExecutionTraceNode[],
    opts: { status?: string; errorLogs?: WorkerLogEntry[]; description?: string; outcome?: "done" | "partially_succeeded" } = {},
  ): WorkflowRun {
    const runId = `wf-driver-${driverRunSeq++}`;
    const status = opts.status ?? "running";
    if (status === "done") {
      noteRebuiltSettlement(runId, { outcome: opts.outcome ?? "done", settledAt: Date.parse("2026-09-27T00:00:00.000Z") });
    }
    return {
      runId,
      spec: { scriptName: "driver-wf", slug: "dw", description: opts.description ?? "driver workflow" },
      meta: { startedAt: new Date(T0).toISOString() },
      state: {
        status,
        budget: { usedTokens: 5000, maxTokens: 200_000, usedCost: 0.0123 },
        trace: { toArray: () => nodes },
        errorLogs: opts.errorLogs ?? [],
      },
    } as unknown as WorkflowRun;
  }

  function makeSub(over: Partial<SubagentRecord> = {}): SubagentRecord {
    return {
      id: "sa-driver",
      task: "task 0 do things",
      status: "running",
      startedAt: T0,
      turns: 2,
      totalTokens: 1200,
      eventLog: [
        { type: "tool_start", label: "read", ts: T0 },
        { type: "tool_start", label: "write", ts: T0 },
      ] as AgentEventLogEntry[],
      ...over,
    } as SubagentRecord;
  }

  // ── 驱动器 ───────────────────────────────────────────────────

  interface ViewComponent { // oe-exempt:20260930:test:test double shape for component capture (test infra)
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
  }

  interface Driver { // oe-exempt:20260930:test:test fixture harness shape (test infra)
    nodes: ExecutionTraceNode[];
    component: ViewComponent;
    tui: { terminal: { columns: number; rows: number }; requestRender: ReturnType<typeof vi.fn> };
    notifies: Array<{ msg: string; level: string }>;
    abort: ReturnType<typeof vi.fn>;
    done: Promise<void>;
  }

  function openDriver(opts: {
    nodes?: ExecutionTraceNode[];
    status?: string;
    errorLogs?: WorkerLogEntry[];
    description?: string;
    liveRecords?: () => SubagentRecord[];
    abortImpl?: (runId: string) => Promise<void>;
  } = {}): Driver {
    const nodes = opts.nodes ?? defaultNodes();
    const run = makeRun(nodes, opts);
    const tui = { terminal: { columns: 100, rows: 30 }, requestRender: vi.fn() };
    const notifies: Array<{ msg: string; level: string }> = [];
    let component!: ViewComponent;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const ctx = {
      mode: "tui",
      ui: {
        custom: (
          factory: (t: unknown, th: unknown, kb: unknown, d: (v: void) => void) => ViewComponent,
        ): Promise<void> => {
          component = factory(tui, plainTheme, {}, () => resolveDone());
          return done;
        },
        notify: (msg: string, level: string) => {
          notifies.push({ msg, level });
        },
      },
    } as unknown as ExtensionContext;
    const abort = vi.fn(opts.abortImpl ?? (() => Promise.resolve()));
    void createWorkflowsView(run, plainTheme, ctx, { abort }, "/state/snapshots/wf.json", opts.liveRecords);
    return { nodes, component, tui, notifies, abort, done };
  }

  /** 微任务冲刷（abort/saveWorkflow/saveTraceToFile 的 .then 链在断言前落定）。 */
  async function flush(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  beforeEach(() => {
    vi.mocked(saveWorkflow).mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── 渲染范围 ───────────────────────────────────────────────────

  describe("WorkflowsView L0 渲染", () => {
    it("初绘：header（名/slug/描述/state 路径）+ phase 列表 + 右侧 agent 概览 + footer", () => {
      const d = openDriver();
      const lines = d.component.render(100);
      const joined = lines.join("\n");
      expect(lines[0]).toContain("╭");
      expect(joined).toContain("driver-wf");
      expect(joined).toContain("dw");
      expect(joined).toContain("driver workflow");
      expect(joined).toContain("state: /state/snapshots/wf.json");
      expect(joined).toContain("1 build 0/2");
      expect(joined).toContain("2 deploy 0/1");
      expect(joined).toContain("3 (unnamed) 0/1");
      expect(joined).toContain("2 agents");
      // footer：running 态含 abort 快捷键
      expect(joined).toContain("↑↓ phase · ⏎ enter");
      expect(joined).toContain("a abort");
      expect(joined).toContain("esc back");
    });

    it("无 description 的 run：header 仍渲染右侧状态段（walled 分支）", () => {
      const d = openDriver({ description: undefined });
      const joined = d.component.render(100).join("\n");
      expect(joined).toContain("driver-wf");
      expect(joined).toContain("0/4 agents");
    });

    it("render 缓存命中返回同一数组；invalidate 后重建", () => {
      const d = openDriver();
      const first = d.component.render(100);
      expect(d.component.render(100)).toBe(first);
      d.component.invalidate();
      expect(d.component.render(100)).not.toBe(first);
    });
  });

  describe("WorkflowsView 导航（↑↓/enter/escape）", () => {
    it("L0 ↓ 切 phase：选中标记移到第二项，右侧列跟随", () => {
      const d = openDriver();
      d.component.handleInput(DOWN);
      const lines = d.component.render(100);
      const joined = lines.join("\n");
      expect(joined).toContain("❯ ● 2 deploy");
      expect(joined).not.toContain("❯ ● 1 build");
    });

    it("L0 enter → L1：footer 切 agent 提示，右列渲染 agent 行（live 缺省走终态统计）", () => {
      const d = openDriver();
      d.component.handleInput(ENTER);
      const lines = d.component.render(100);
      const joined = lines.join("\n");
      expect(joined).toContain("↑↓ agent · ⏎ detail");
      expect(joined).toContain("worker");
      expect(joined).toContain("test-model");
    });

    it("L1 enter → L2 详情：Detail 标题 + Prompt 段 + Outcome；enter 切换 prompt 展开", () => {
      const d = openDriver();
      d.component.handleInput(ENTER); // L1
      d.component.handleInput(ENTER); // L2
      const folded = d.component.render(100).join("\n");
      expect(folded).toContain("Detail");
      expect(folded).toContain("Prompt · 1 lines · ⏎ expand");
      expect(folded).toContain("Still running...");

      d.component.handleInput(ENTER); // 展开 prompt
      const expanded = d.component.render(100).join("\n");
      expect(expanded).toContain("⏎ collapse");
      expect(expanded).toContain("task 0 do things");
    });

    it("多行 prompt 折叠：显示前 3 行 + more lines 计数；展开后全量", () => {
      const task = Array.from({ length: 6 }, (_, i) => `line-${i}`).join("\n");
      const d = openDriver({ nodes: [makeNode(0, { task })] });
      d.component.handleInput(ENTER);
      d.component.handleInput(ENTER);
      const folded = d.component.render(100).join("\n");
      expect(folded).toContain("Prompt · 6 lines · ⏎ expand");
      expect(folded).toContain("3 more lines");
      d.component.handleInput(ENTER);
      const expanded = d.component.render(100).join("\n");
      expect(expanded).toContain("line-5");
    });

    it("escape 逐级降级；L0 escape 关闭 overlay（done 落定）；关闭后按键与 tick 空转", async () => {
      const d = openDriver();
      d.component.handleInput(ENTER);
      d.component.handleInput(ENTER);
      expect(d.component.render(100).join("\n")).toContain("PgUp/PgDn scroll");
      d.component.handleInput(ESC);
      expect(d.component.render(100).join("\n")).toContain("⏎ detail");
      d.component.handleInput(ESC);
      expect(d.component.render(100).join("\n")).toContain("⏎ enter");
      d.component.handleInput(ESC);
      await d.done;
      // disposed 后：handleInput 不再消费（abort 不触发）、tick 不再重绘
      const callsBefore = d.tui.requestRender.mock.calls.length;
      d.component.handleInput("a");
      expect(d.abort).not.toHaveBeenCalled();
      vi.advanceTimersByTime(600);
      expect(d.tui.requestRender.mock.calls.length).toBe(callsBefore);
    });

    it("L2 ↑↓ 切 agent：重置详情滚动与 prompt 展开", () => {
      const d = openDriver();
      d.component.handleInput(ENTER); // L1
      d.component.handleInput(ENTER); // L2
      d.component.handleInput(ENTER); // 展开 prompt
      expect(d.component.render(100).join("\n")).toContain("⏎ collapse");
      d.component.handleInput(DOWN); // 切到本 phase 第二个 agent
      const joined = d.component.render(100).join("\n");
      expect(joined).toContain("task 1 do things");
      expect(joined).toContain("⏎ expand");
    });
  });

  describe("WorkflowsView L2 详情滚动（PgUp/PgDn/Home/End + 位置指示）", () => {
    /** 长 task（30 行）保证 detail 内容超出视口（rows=30 → viewH=14）。 */
    function longTaskDriver(): Driver {
      const task = Array.from({ length: 30 }, (_, i) => `prompt-line-${i}`).join("\n");
      return openDriver({ nodes: [makeNode(0, { task })] });
    }

    it("running + followTail 默认钉底：指示显示末窗；PgUp 上滚脱离跟随；Home 回顶；End 回底", () => {
      const d = longTaskDriver();
      d.component.handleInput(ENTER); // L1
      d.component.handleInput(ENTER); // L2
      d.component.handleInput(ENTER); // 展开 prompt（30 行 → 内容超出视口）
      const bottom = d.component.render(100).join("\n");
      expect(bottom).toMatch(/Detail \(\d+-\d+\/\d+\)/); // 位置指示（内容 > 视口才出现）
      expect(bottom).toContain("prompt-line-29");

      d.component.handleInput(PAGE_UP);
      const paged = d.component.render(100).join("\n");
      expect(paged).toContain("prompt-line-15");
      expect(paged).not.toContain("prompt-line-29");

      d.component.handleInput(HOME);
      const top = d.component.render(100).join("\n");
      expect(top).toContain("prompt-line-0");
      expect(top).not.toContain("prompt-line-14");

      d.component.handleInput(END);
      expect(d.component.render(100).join("\n")).toContain("prompt-line-29");
    });

    it("PgDn 向下翻页；未命中滚动键回退导航链（up/down 仍切 agent）", () => {
      const d = longTaskDriver();
      d.component.handleInput(ENTER);
      d.component.handleInput(ENTER);
      d.component.handleInput(ENTER); // 展开 prompt
      d.component.handleInput(HOME);
      d.component.handleInput(PAGE_DOWN);
      const paged = d.component.render(100).join("\n");
      expect(paged).toContain("prompt-line-14");

      // 非 L2 滚动键（如 'w'）落到快捷键链尾（无副作用），up 仍走导航链——
      // 单 agent 场景两者都不改滚动窗口（offset 保持 14）
      d.component.handleInput("w");
      d.component.handleInput(UP);
      const joined = d.component.render(100).join("\n");
      expect(joined).toContain("prompt-line-14");
      expect(joined).not.toContain("prompt-line-28");
    });
  });

  describe("WorkflowsView abort / 快捷键", () => {
    it("running 时 'a' → actions.abort(runId)，成功后重绘", async () => {
      const d = openDriver();
      d.component.handleInput("a");
      expect(d.abort).toHaveBeenCalledWith(expect.any(String));
      await flush();
      expect(d.tui.requestRender).toHaveBeenCalled();
    });

    it("abort 拒绝 → notify error（不静默吞）", async () => {
      const d = openDriver({ abortImpl: () => Promise.reject(new Error("boom")) });
      d.component.handleInput("a");
      await flush();
      expect(d.notifies).toEqual([{ msg: "Abort failed: boom", level: "error" }]);
    });

    it("非 running（done）时 'a' 不触发 abort", () => {
      const d = openDriver({ status: "done", nodes: [makeNode(0, { status: "completed" })] });
      d.component.handleInput("a");
      expect(d.abort).not.toHaveBeenCalled();
    });
  });

  describe("WorkflowsView save overlay（'s'）", () => {
    function openSave(): Driver {
      const d = openDriver();
      d.component.handleInput("s");
      return d;
    }

    it("'s' 进入 save mode：标题/目的地预览/输入行（初值 scriptName）", () => {
      const d = openSave();
      const joined = d.component.render(100).join("\n");
      expect(joined).toContain("Save dynamic workflow");
      expect(joined).toContain(".pi/workflows/driver-wf.js");
      expect(joined).toContain("> driver-wf\u2588");
      expect(joined).toContain("Enter to save · Esc to cancel");
    });

    it("可打印字符追加 + backspace 删除（输入行实时可见）", () => {
      const d = openSave();
      d.component.handleInput("x");
      expect(d.component.render(100).join("\n")).toContain("> driver-wfx\u2588");
      d.component.handleInput(BACKSPACE);
      expect(d.component.render(100).join("\n")).toContain("> driver-wf\u2588");
    });

    it("空名 enter → Please enter a name；esc 退出 save mode", () => {
      const d = openSave();
      for (let i = 0; i < "driver-wf".length; i++) d.component.handleInput(BACKSPACE);
      d.component.handleInput(ENTER);
      expect(d.component.render(100).join("\n")).toContain("Please enter a name");
      d.component.handleInput(ESC);
      expect(d.component.render(100).join("\n")).not.toContain("Save dynamic workflow");
    });

    it("enter 保存成功：saveWorkflow 接线（scriptName, 输入名），overlay 关闭", async () => {
      vi.mocked(saveWorkflow).mockResolvedValue("Saved to .pi/workflows/saved-wf.js");
      const d = openSave();
      for (let i = 0; i < "driver-wf".length; i++) d.component.handleInput(BACKSPACE);
      for (const ch of "saved-wf") d.component.handleInput(ch);
      d.component.handleInput(ENTER);
      expect(vi.mocked(saveWorkflow)).toHaveBeenCalledWith("driver-wf", "saved-wf");
      await flush();
      const joined = d.component.render(100).join("\n");
      expect(joined).not.toContain("Save dynamic workflow");
    });

    it("enter 保存失败：错误消息回显在 overlay（不关闭）", async () => {
      vi.mocked(saveWorkflow).mockRejectedValue(new Error("refusing to overwrite non-tmp workflow"));
      const d = openSave();
      d.component.handleInput(ENTER);
      await flush();
      const joined = d.component.render(100).join("\n");
      expect(joined).toContain("refusing to overwrite non-tmp workflow");
      expect(joined).toContain("Save dynamic workflow");
    });
  });

  describe("WorkflowsView trace 导出（'S'）", () => {
    it("导出 Markdown：mkdir→writeFile 链 + 成功 notify（含 header/phase/节点全段）", async () => {
      const mkdir = vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
      const writeFile = vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
      const nodes = [
        makeNode(0, {
          status: "completed",
          completedAt: new Date(T0 + 60_000).toISOString(),
          result: {
            content: "all done",
            usage: { input: 900, output: 100 },
            toolCalls: [{ name: "read", input: "/a.ts" }],
          },
        }),
      ];
      const d = openDriver({ nodes, errorLogs: [{ level: "error", message: "E-1" }] });
      d.component.handleInput("S");
      await flush();
      expect(mkdir).toHaveBeenCalledWith(expect.stringContaining("workflow-traces"), { recursive: true });
      expect(writeFile).toHaveBeenCalledTimes(1);
      const [path, content] = vi.mocked(writeFile).mock.calls[0] as unknown as [string, string];
      expect(path).toContain("workflow-traces/");
      expect(path).toMatch(/wf-driver-\d+\.md$/);
      expect(content).toContain("# Workflow Trace: driver-wf");
      expect(content).toContain("Status: running");
      expect(content).toContain("Budget: 5000/200000 tokens, $0.0123");
      expect(content).toContain("## Phase: build");
      expect(content).toContain("### [#0] worker — completed");
      expect(content).toContain("**Activity:**");
      expect(content).toContain("- read(/a.ts)");
      expect(content).toContain("all done");
      expect(d.notifies[0]?.level).toBe("info");
      expect(d.notifies[0]?.msg).toContain("Trace saved: ");
    });

    it("导出失败（mkdir 拒绝）→ notify error（Save failed 指引）", async () => {
      vi.spyOn(fsPromises, "mkdir").mockRejectedValue(new Error("EACCES: no perms"));
      const d = openDriver();
      d.component.handleInput("S");
      await flush();
      expect(d.notifies).toEqual([{ msg: "Save failed: EACCES: no perms", level: "error" }]);
    });

    it("[§3.3.8 终局失真同型面] 部分交付 run（partially_succeeded）导出 trace 头部 Status 行带原因后缀（与完成通知 done (${reason}) 同形）", async () => {
      vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
      const writeFile = vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
      const d = openDriver({
        status: "done",
        outcome: "partially_succeeded",
        nodes: [makeNode(0, { status: "completed" }), makeNode(1, { status: "failed" })],
      });
      d.component.handleInput("S");
      await flush();
      const [, content] = vi.mocked(writeFile).mock.calls[0] as unknown as [string, string];
      expect(content).toContain("Status: done (partially_succeeded)");
    });
  });

  describe("WorkflowsView tick 条件失效（200ms）", () => {
    it("首 tick 必失效重绘；签名不变跳过；trace 变化后恢复重绘", () => {
      const d = openDriver();
      vi.advanceTimersByTime(200);
      expect(d.tui.requestRender).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(200);
      expect(d.tui.requestRender).toHaveBeenCalledTimes(1); // 同秒桶同签名 → 跳过
      d.nodes.push(makeNode(4));
      vi.advanceTimersByTime(200);
      expect(d.tui.requestRender).toHaveBeenCalledTimes(2);
    });

    it("live record 变化驱动重绘（签名含 live 字段）", () => {
      const subs = [makeSub()];
      const d = openDriver({ liveRecords: () => subs });
      vi.advanceTimersByTime(200);
      expect(d.tui.requestRender).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(200);
      expect(d.tui.requestRender).toHaveBeenCalledTimes(1);
      // 原位替换 record（token 数变化 → 配对派生视图变 → 签名变）。追加同分候选不改派生视图
      // （startedAt 最近邻贪心仍取首个，签名不变——非本用例目标）。
      subs[0] = makeSub({ totalTokens: 2400 });
      vi.advanceTimersByTime(200);
      expect(d.tui.requestRender).toHaveBeenCalledTimes(2);
    });
  });

  describe("WorkflowsView live 进度渲染（liveRecords 注入）", () => {
    it("L1 agent 行 live 路径：tok/tools/elapsed 来自 store record 派生视图", () => {
      const d = openDriver({
        liveRecords: () => [makeSub({ totalTokens: 1200, turns: 2 })],
      });
      d.component.handleInput(ENTER);
      const joined = d.component.render(100).join("\n");
      expect(joined).toContain("1k tok");
      expect(joined).toContain("2 tools");
    });

    it("L2 详情 live 路径：当前活动行 + 最近事件 + 实时 Outcome（含 lastError）", () => {
      const d = openDriver({
        liveRecords: () => [
          makeSub({
            currentActivity: { type: "tool", label: "bash" },
            eventLog: [
              { type: "tool_start", label: "read", ts: T0 },
              { type: "error", label: "EPIPE: broken pipe", ts: T0 },
            ] as AgentEventLogEntry[],
          }),
        ],
      });
      d.component.handleInput(ENTER);
      d.component.handleInput(ENTER);
      const joined = d.component.render(100).join("\n");
      expect(joined).toContain("⎿ tool: bash");
      expect(joined).toContain("→ read");
      expect(joined).toContain("Running ·");
      expect(joined).toContain("EPIPE: broken pipe");
    });

    it("L2 详情 live 零活动：显示 (starting...) 占位", () => {
      const d = openDriver({ liveRecords: () => [makeSub({ eventLog: [], turns: 0, totalTokens: 0 })] });
      d.component.handleInput(ENTER);
      d.component.handleInput(ENTER);
      expect(d.component.render(100).join("\n")).toContain("(starting...)");
    });

    it("L2 详情 worker diagnostics：errorLogs 渲染 level 前缀行", () => {
      const d = openDriver({
        errorLogs: [
          { level: "error", message: "wave 1 failed" },
          { level: "warn", message: "retrying" },
        ],
      });
      d.component.handleInput(ENTER);
      d.component.handleInput(ENTER);
      const joined = d.component.render(100).join("\n");
      expect(joined).toContain("Worker diagnostics · 2 entries");
      expect(joined).toContain("[error] wave 1 failed");
      expect(joined).toContain("[warn] retrying");
    });

    it("终态节点 Activity 截断标签：toolCalls 超 3 条显示 last N of M", () => {
      const toolCalls = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, input: "{}" }));
      const d = openDriver({
        nodes: [makeNode(0, { status: "completed", result: { content: "ok", toolCalls } })],
      });
      d.component.handleInput(ENTER);
      d.component.handleInput(ENTER);
      const joined = d.component.render(100).join("\n");
      expect(joined).toContain("Activity · last 3 of 5 tool calls");
      expect(joined).toContain("t4({})");
      expect(joined).not.toContain("t0({})");
    });

    it("终态节点 Outcome：error 优先于 content；超预算内容截断 + (truncated) 标记", () => {
      const big = "x".repeat(120_000);
      const d = openDriver({
        nodes: [
          makeNode(0, { status: "failed", result: { error: "agent crashed", content: big } }),
        ],
      });
      d.component.handleInput(ENTER);
      d.component.handleInput(ENTER);
      const joined = d.component.render(100).join("\n");
      expect(joined).toContain("agent crashed");
      expect(joined).not.toContain("xxxx");

      const d2 = openDriver({
        nodes: [makeNode(0, { status: "completed", result: { content: `head\n${big}` } })],
      });
      d2.component.handleInput(ENTER);
      d2.component.handleInput(ENTER);
      const joined2 = d2.component.render(100).join("\n");
      expect(joined2).toContain("(truncated)");
    });
  });
});

// ======== 来源：WorkflowsView.test.ts ========
describe("WorkflowsView", () => {
  // ── Fixtures（duck typing）──

  const T0 = 1_700_000_000_000; // 固定 epoch ms

  function makeLiveView(overrides: Partial<LiveProgressView> = {}): LiveProgressView {
    return {
      totalTokens: 0,
      toolCallCount: 0,
      elapsedSeconds: 5,
      turns: 0,
      eventLog: [],
      currentActivity: undefined,
      lastError: undefined,
      ...overrides,
    };
  }

  function makeEventLog(entries: Partial<AgentEventLogEntry>[] = []): AgentEventLogEntry[] {
    return entries.map((e, i) => ({ type: "tool_start", label: `t-${i}`, ts: T0, ...e })) as AgentEventLogEntry[];
  }

  function makeNode(overrides: Partial<ExecutionTraceNode> = {}): ExecutionTraceNode {
    return {
      stepIndex: 0,
      agent: "worker",
      task: "do",
      model: "default",
      status: "running",
      ...overrides,
    };
  }

  type RunShape = {
    status?: string;
    budget?: { usedTokens: number; maxTokens?: number; usedCost: number };
    nodes?: ExecutionTraceNode[];
    errorLogs?: WorkerLogEntry[];
  }

  function makeRun(shape: RunShape = {}): WorkflowRun {
    return makeRunWithId(`wf-sig-${signatureRunSeq++}`, shape);
  }

  /** [W2/V1] runId 唯一化 + spec 最小子集（displayStatusOf → core runSummary 派生视图
 *  读 runId/spec.scriptName——签名测试的 mock 需携带该最小字段集）。
 *  [D6(a) 第 1 步] 终局判定源 = 终局记录注册表：done 形态 fixture 必须携带注册表
 *  条目（生产 = 壳重建点 noteRebuiltSettlement 注入 run-settled 帧事实）。 */
  let signatureRunSeq = 0;

  function makeRunWithId(runId: string, shape: RunShape): WorkflowRun {
    const status = shape.status ?? "running";
    if (status === "done") {
      noteRebuiltSettlement(runId, { outcome: "done", settledAt: Date.parse("2026-09-27T00:00:00.000Z") });
    }
    return {
      runId,
      spec: { scriptName: "sig-wf" },
      meta: { startedAt: "2026-09-27T00:00:00.000Z" },
      state: {
        status,
        budget: shape.budget ?? { usedTokens: 0, maxTokens: 200_000, usedCost: 0 },
        trace: { toArray: () => shape.nodes ?? [] },
        errorLogs: shape.errorLogs ?? [],
      },
    } as unknown as WorkflowRun;
  }

  /** 单节点 run + 该节点的 live 派生视图（最常见断言形态的便捷封装）。 */
  function runWithLive(nodeOverrides: Partial<ExecutionTraceNode>, live: LiveProgressView) {
    const node = makeNode(nodeOverrides);
    return {
      run: makeRun({ nodes: [node] }),
      live: new Map<number, LiveProgressView>([[node.stepIndex, live]]),
    };
  }

  /** plain theme: 着色方法直接返回原文，无 ANSI 色码——测试断言纯文本。
 *  bg/underline 为宽 ThemeLike 接口的 no-op 实现（workflow 渲染范围只用 fg/bold）。 */
  const plainTheme: ThemeLike = {
    bg: (_color: string, text: string) => text,
    fg: (_tag: string, text: string) => text,
    bold: (text: string) => text,
    underline: (text: string) => text,
  };

  /** collectNodeLiveProgress 配对用 run：只含 trace 节点面（task/status/startedAt）。 */
  function makeRunShape(nodes: { stepIndex: number; task: string; status: string; startedAt: string }[]): WorkflowRun {
    return {
      state: { trace: { toArray: () => nodes } },
    } as unknown as WorkflowRun;
  }

  function makeSub(over: Partial<SubagentRecord> = {}): SubagentRecord {
    return {
      id: "sa-match",
      task: "调研 A",
      status: "running",
      startedAt: T0,
      turns: 0,
      totalTokens: 0,
      eventLog: [],
      ...over,
    } as SubagentRecord;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("computeRenderSignature — 基础确定性", () => {
    it("同输入同签名（含 live 派生视图，elapsedSeconds 固定值确定）", () => {
      const { run, live } = runWithLive({}, makeLiveView());
      expect(computeRenderSignature(run, live, T0)).toBe(computeRenderSignature(run, live, T0));
    });

    it("静态 run（无 live、同秒桶）200ms 内签名不变", () => {
      const run = makeRun({ nodes: [makeNode({ status: "completed" })] });
      expect(computeRenderSignature(run, new Map(), T0)).toBe(computeRenderSignature(run, new Map(), T0 + 200));
    });

    it("秒桶跨秒（now 相差 1s 桶）→ 签名变", () => {
      const run = makeRun();
      expect(computeRenderSignature(run, new Map(), T0)).not.toBe(computeRenderSignature(run, new Map(), T0 + 1000));
    });
  });

  describe("computeRenderSignature — run 级字段", () => {
    it("run.state.status 变化 → 签名变", () => {
      const a = makeRun({ status: "running" });
      const b = makeRun({ status: "done" });
      expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
    });

    it("completed/total 变化（节点 status 推导）→ 签名变", () => {
      const a = makeRun({ nodes: [makeNode({ status: "running" })] });
      const b = makeRun({ nodes: [makeNode({ status: "completed" })] });
      expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
    });

    it("budget tokens 量化值变化 → 签名变", () => {
      const a = makeRun({ budget: { usedTokens: 1500, maxTokens: 200_000, usedCost: 0.01 } });
      const b = makeRun({ budget: { usedTokens: 2500, maxTokens: 200_000, usedCost: 0.01 } });
      expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
    });

    it("budget cost 第 4 位小数变化（toFixed(4) 可见精度）→ 签名变", () => {
      // 0.0100 vs 0.0101：量化展示相同到第 3 位，第 4 位是渲染可见精度
      const a = makeRun({ budget: { usedTokens: 0, maxTokens: 200_000, usedCost: 0.0100 } });
      const b = makeRun({ budget: { usedTokens: 0, maxTokens: 200_000, usedCost: 0.0101 } });
      expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
    });

    it("run.state.errorLogs 追加 → 签名变（末条内容入指纹）", () => {
      const a = makeRun({ errorLogs: [{ level: "error", message: "E-0" }] });
      const b = makeRun({ errorLogs: [{ level: "error", message: "E-0" }, { level: "warn", message: "W-1" }] });
      expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
    });

    it("errorLogs 封顶后 length 不变内容移（push+slice(-MAX_ERROR_LOGS)）→ 签名仍变（指纹非 length）", () => {
      // 模拟 error-recovery 的变异路径：push 后 slice(-500) 截断。两次 state 均 500 条
      // （length 相同），仅末条/窗口内容不同——指纹含末条内容才不漏失效。
      const MAX_ERROR_LOGS = 500;
      const mk = (n: number): WorkerLogEntry => ({ level: "error", message: `E-${n}` });
      const before: WorkerLogEntry[] = Array.from({ length: MAX_ERROR_LOGS }, (_, i) => mk(i));
      const after = [...before, mk(MAX_ERROR_LOGS)].slice(-MAX_ERROR_LOGS); // E-1..E-500
      expect(after).toHaveLength(MAX_ERROR_LOGS); // 前置校验：封顶后 length 不变
      const a = makeRun({ errorLogs: before });
      const b = makeRun({ errorLogs: after });
      expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
    });
  });

  describe("computeRenderSignature — 节点级字段（store record 派生视图）", () => {
    it("节点 status 变化 → 签名变", () => {
      const a = makeRun({ nodes: [makeNode({ status: "running" })] });
      const b = makeRun({ nodes: [makeNode({ status: "failed" })] });
      expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
    });

    it("live.totalTokens 变化 → 签名变", () => {
      const a = runWithLive({}, makeLiveView({ totalTokens: 1000 }));
      const b = runWithLive({}, makeLiveView({ totalTokens: 2000 }));
      expect(computeRenderSignature(a.run, a.live, T0)).not.toBe(computeRenderSignature(b.run, b.live, T0));
    });

      it("live.toolCallCount 变化（store 派生视图：eventLog tool_start 计数）→ 签名变", () => {
      const a = runWithLive({}, makeLiveView({ toolCallCount: 1 }));
      const b = runWithLive({}, makeLiveView({ toolCallCount: 2 }));
      expect(computeRenderSignature(a.run, a.live, T0)).not.toBe(computeRenderSignature(b.run, b.live, T0));
    });

    it("live.elapsedSeconds 变化 → 签名变（跨秒推进）", () => {
      const run = makeRun({ nodes: [makeNode()] });
      const before = computeRenderSignature(run, new Map([[0, makeLiveView({ elapsedSeconds: 5 })]]), T0);
      const after = computeRenderSignature(run, new Map([[0, makeLiveView({ elapsedSeconds: 6 })]]), T0);
      expect(after).not.toBe(before);
    });

    it("live.turns 计数变化 → 签名变", () => {
      const a = runWithLive({}, makeLiveView({ turns: 1 }));
      const b = runWithLive({}, makeLiveView({ turns: 2 }));
      expect(computeRenderSignature(a.run, a.live, T0)).not.toBe(computeRenderSignature(b.run, b.live, T0));
    });

    it("live.eventLog 追加（length 变化）→ 签名变", () => {
      const a = runWithLive({}, makeLiveView({ eventLog: makeEventLog([{ type: "tool_start", label: "read" }]) }));
      const b = runWithLive({}, makeLiveView({ eventLog: makeEventLog([{ type: "tool_start", label: "read" }, { type: "tool_end", label: "read" }]) }));
      expect(computeRenderSignature(a.run, a.live, T0)).not.toBe(computeRenderSignature(b.run, b.live, T0));
    });

    it("live.currentActivity 出现 / 变化（type+label）→ 签名变", () => {
      const noActivity = runWithLive({}, makeLiveView({ currentActivity: undefined }));
      const withTool = runWithLive({}, makeLiveView({ currentActivity: { type: "tool", label: "write" } }));
      const otherLabel = runWithLive({}, makeLiveView({ currentActivity: { type: "tool", label: "bash" } }));

      const s0 = computeRenderSignature(noActivity.run, noActivity.live, T0);
      const s1 = computeRenderSignature(withTool.run, withTool.live, T0);
      const s2 = computeRenderSignature(otherLabel.run, otherLabel.live, T0);
      expect(s1).not.toBe(s0); // 出现
      expect(s2).not.toBe(s1); // label 变
    });

    it("live.lastError 出现（内容入签名）→ 签名变", () => {
      const a = runWithLive({}, makeLiveView({ lastError: undefined }));
      const b = runWithLive({}, makeLiveView({ lastError: "EPIPE: broken pipe" }));
      expect(computeRenderSignature(a.run, a.live, T0)).not.toBe(computeRenderSignature(b.run, b.live, T0));
    });

    it("node.sessionFile 出现 → 签名变", () => {
      const a = makeRun({ nodes: [makeNode({})] });
      const b = makeRun({ nodes: [makeNode({ sessionFile: "/tmp/sessions/run-0.jsonl" })] });
      expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
    });
  });

  describe("computeRenderSignature — 多节点与无 live 终态", () => {
      it("多节点：live 派生视图按 stepIndex 配对生效（live 值出现 / 消失 / 挂到另一节点 → 签名变）", () => {
      // 对比式断言：同一 run 换 live 派生视图驱动签名变化——词法格式串是内部表示非契约，
      // 不作为主证明（结构快照见下一条）。
      const run = makeRun({
        nodes: [
          makeNode({ stepIndex: 0, status: "completed" }),
          makeNode({ stepIndex: 1, status: "running" }),
        ],
      });
      const noLive = new Map<number, LiveProgressView>();
      const liveOnNode1 = new Map<number, LiveProgressView>([[1, makeLiveView({ totalTokens: 500 })]]);
      const liveOnNode0 = new Map<number, LiveProgressView>([[0, makeLiveView({ totalTokens: 500 })]]);

      const base = computeRenderSignature(run, noLive, T0);
      // live 值出现（挂到节点 1）→ 签名变
      expect(computeRenderSignature(run, liveOnNode1, T0)).not.toBe(base);
      // 同值 live 挂到另一节点 → 签名也变（配对按 stepIndex 生效，非全局均摊）
      expect(computeRenderSignature(run, liveOnNode0, T0)).not.toBe(computeRenderSignature(run, liveOnNode1, T0));
      // live 值消失 → 签名回落基线
      expect(computeRenderSignature(run, noLive, T0)).toBe(base);
    });

    // 结构快照（不承担主证明）：签名段集 = run 级五段 + 每节点一段；
    // 段内词法编码是内部表示，不锁定。
    it("多节点结构快照：两节点 run 签名共 7 段（run 级 5 + 节点 2）", () => {
      const run = makeRun({
        nodes: [makeNode({ stepIndex: 0 }), makeNode({ stepIndex: 1 })],
      });
      expect(computeRenderSignature(run, new Map(), T0).split("|")).toHaveLength(7);
    });

    it("节点重排（trace 数组序对调，stepIndex 维度）→ 签名变", () => {
      // 同一节点集、字段值均不变，仅 trace 数组顺序对调——nodeParts 按 trace 序拼接，
      // 首字段 stepIndex 随之换位，签名必变（不漏失效）。
      const first = makeNode({ stepIndex: 0, status: "completed" });
      const second = makeNode({ stepIndex: 1, status: "running" });
      const live = new Map([[1, makeLiveView()]]);
      const a = makeRun({ nodes: [first, second] });
      const b = makeRun({ nodes: [second, first] });
      expect(computeRenderSignature(a, live, T0)).not.toBe(computeRenderSignature(b, live, T0));
    });

    it("无节点 run 签名仅含 run 级五段（status/秒桶/completed-total/budget/errorLogs）", () => {
      const sig = computeRenderSignature(makeRun({ nodes: [] }), new Map(), T0);
      expect(sig.split("|")).toHaveLength(5);
    });
  });

  // ── collectNodeLiveProgress 配对（[H2 W3] store record live 进度配对） ──
  //
  // 配对规则：task 标签匹配 + startedAt 最近邻 + 贪心唯一；终态 node 不配；
  // 无匹配 record（重试间隙）返回空。
      // SubagentRecord 派生视图字段集（eventLog/turns/totalTokens 等）的派生视图恒等由 core 侧
      // record-store 测试锁定，此处消费派生视图字段集。

  describe("collectNodeLiveProgress 配对", () => {
      it("task 全等匹配：running node ↔ running record，派生视图挂到 stepIndex", () => {
      const run = makeRunShape([{ stepIndex: 0, task: "调研 A", status: "running", startedAt: new Date(T0).toISOString() }]);
      const live = collectNodeLiveProgress(run, [makeSub({ totalTokens: 42 })]);
      expect(live.get(0)?.totalTokens).toBe(42);
    });

    it("多候选（parallel 同 prompt）取 startedAt 最近邻，贪心一一不重复消费", () => {
      const run = makeRunShape([
        { stepIndex: 0, task: "调研 A", status: "running", startedAt: new Date(T0).toISOString() },
        { stepIndex: 1, task: "调研 A", status: "running", startedAt: new Date(T0 + 5000).toISOString() },
      ]);
      const near0 = makeSub({ id: "sa-near0", startedAt: T0 + 10, totalTokens: 100 });
      const near1 = makeSub({ id: "sa-near1", startedAt: T0 + 5010, totalTokens: 200 });
      const live = collectNodeLiveProgress(run, [near1, near0]);
      expect(live.get(0)?.totalTokens).toBe(100); // node0(startedAt=T0) 最近 = near0
      expect(live.get(1)?.totalTokens).toBe(200); // node1(T0+5s) 最近 = near1
    });

    it("终态 node 不配对；task 不匹配（不同 prompt）不配对", () => {
      const run = makeRunShape([
        { stepIndex: 0, task: "调研 A", status: "completed", startedAt: new Date(T0).toISOString() },
        { stepIndex: 1, task: "写总结", status: "running", startedAt: new Date(T0).toISOString() },
      ]);
      const live = collectNodeLiveProgress(run, [makeSub({ task: "调研 A", totalTokens: 99 })]);
      expect(live.size).toBe(0); // node0 终态跳过；node1 task 不匹配
    });

    it("重试间隙（无 running record）→ 空 map（views 走终态 fallback 渲染）", () => {
      const run = makeRunShape([{ stepIndex: 0, task: "调研 A", status: "running", startedAt: new Date(T0).toISOString() }]);
      const live = collectNodeLiveProgress(run, [makeSub({ status: "closed" })]);
      expect(live.size).toBe(0);
    });
  });

  // ── buildDetailContent session 路径行渲染 ──
  //
  // TUI 渲染测试：buildDetailContent 在 agent 终态时渲染 session: 路径行。
  //
  // 防的 bug：node.sessionFile 有值但 TUI detail 不显示——用户在交互面板里
  // 看不到 agent 的 session jsonl 路径，无法定位文件做后续查看。

  describe("buildDetailContent session 路径行渲染", () => {
    it("node.sessionFile 有值 → 详情末尾渲染 session: <路径>", () => {
      const sessionPath = "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl";
      const node = makeNode({
        status: "completed",
        sessionFile: sessionPath,
        result: { content: "done" },
      });
      const lines = buildDetailContent(node, { promptExpanded: false }, makeRun(), plainTheme, 120, Date.now());
      const sessionLine = lines.find((l) => l.includes("session:"));
      expect(sessionLine).toBeDefined();
      expect(sessionLine).toContain(sessionPath);
    });

    it("node.sessionFile undefined（窗口期）→ 不渲染 session: 行", () => {
      const node = makeNode({ status: "completed", sessionFile: undefined, result: { content: "done" } });
      const lines = buildDetailContent(node, { promptExpanded: false }, makeRun(), plainTheme, 120, Date.now());
      const sessionLine = lines.find((l) => l.includes("session:"));
      expect(sessionLine).toBeUndefined();
    });

    it("长路径截断到 mainWidth（防溢出）", () => {
      const longPath = "/very/long/path/" + "x".repeat(200) + "/session.jsonl";
      const node = makeNode({ status: "completed", sessionFile: longPath, result: { content: "done" } });
      const narrowWidth = 60;
      const lines = buildDetailContent(node, { promptExpanded: false }, makeRun(), plainTheme, narrowWidth, Date.now());
      const sessionLine = lines.find((l) => l.includes("session:"));
      expect(sessionLine).toBeDefined();
      // 截断后行宽不超过 mainWidth + 边框余量
      expect(sessionLine!.length).toBeLessThanOrEqual(narrowWidth);
    });
  });
});

// ======== 来源：detail-content.test.ts ========
describe("detail-content", () => {
  const T0 = 1_700_000_000_000;

  /** 记录色 token 的 marking theme（断言色档而非文本形态）。 */
  const markingTheme: ThemeLike = {
    bg: (_color: string, text: string) => text,
    fg: (tag: string, text: string) => `${tag}(${text})`,
    bold: (text: string) => text,
    underline: (text: string) => text,
  };

  /** 无色 theme（内容断言用）。 */
  const plainTheme: ThemeLike = {
    bg: (_color: string, text: string) => text,
    fg: (_tag: string, text: string) => text,
    bold: (text: string) => text,
    underline: (text: string) => text,
  };

  function makeRun(errorLogs: Array<{ level: string; message: string }> = []): WorkflowRun {
    return {
      state: { errorLogs },
    } as unknown as WorkflowRun;
  }

  function makeNode(over: Partial<ExecutionTraceNode> = {}): ExecutionTraceNode {
    return {
      stepIndex: 0,
      agent: "worker",
      task: "do",
      model: "test-model",
      status: "running",
      startedAt: new Date(T0).toISOString(),
      ...over,
    } as ExecutionTraceNode;
  }

  function makeSub(over: Partial<SubagentRecord> = {}): SubagentRecord {
    return {
      id: "sa-1",
      task: "do",
      status: "running",
      startedAt: T0,
      turns: 1,
      totalTokens: 500,
      eventLog: [],
      ...over,
    } as SubagentRecord;
  }

  describe("statusLabel 色档分支", () => {
    it("completed→success / running→warning / failed→error / cancelled 与其他→muted", () => {
      expect(statusLabel("completed", markingTheme)).toBe("success(completed)");
      expect(statusLabel("running", markingTheme)).toBe("warning(running)");
      expect(statusLabel("failed", markingTheme)).toBe("error(failed)");
      expect(statusLabel("pending" as ExecutionTraceNode["status"], markingTheme)).toBe("muted(pending)");
      // §3.3.8 cancelled（run 终局收尾在途成员）=「未交付且非失败」中性档，与 pending 同 muted
      expect(statusLabel("cancelled", markingTheme)).toBe("muted(cancelled)");
    });
  });

  describe("projectRecordProgress 派生视图口径（S1 等价表消费方）", () => {
    it("toolCallCount = tool_start 计数；lastError = 末条 error 的 label；字段直读", () => {
      const rec = makeSub({
        totalTokens: 1234,
        turns: 3,
        endedAt: T0 + 5000,
        currentActivity: { type: "tool", label: "bash" },
        eventLog: [
          { type: "tool_start", label: "read", ts: T0 },
          { type: "tool_end", label: "read", ts: T0 + 10, status: "done" },
          { type: "tool_start", label: "write", ts: T0 + 20 },
          { type: "error", label: "EPIPE: broken pipe", ts: T0 + 30 },
        ] as AgentEventLogEntry[],
      });
      const view = projectRecordProgress(rec);
      expect(view.totalTokens).toBe(1234);
      expect(view.toolCallCount).toBe(2); // 两条 tool_start
      expect(view.turns).toBe(3);
      expect(view.elapsedSeconds).toBe(5); // endedAt - startedAt
      expect(view.currentActivity).toEqual({ type: "tool", label: "bash" });
      expect(view.lastError).toBe("EPIPE: broken pipe");
    });

    it("末条非 error → lastError undefined；空 eventLog → 零计数", () => {
      const view = projectRecordProgress(makeSub({ eventLog: [{ type: "tool_end", label: "read", ts: T0, status: "done" } as AgentEventLogEntry] }));
      expect(view.lastError).toBeUndefined();
      expect(view.toolCallCount).toBe(0);
      const empty = projectRecordProgress(makeSub({ eventLog: [] }));
      expect(empty.lastError).toBeUndefined();
      expect(empty.currentActivity).toBeUndefined();
    });
  });

  describe("processDetailKey 全键位（followTail 语义 + 边界 clamp）", () => {
    const ctx = { viewportHeight: 10, contentLines: 35, isRunning: true };

    it("PgUp：上翻一屏 + 脱离跟随；不越顶（clamp 0）", () => {
      expect(processDetailKey("\x1b[5~", { scrollOffset: 12, followTail: true }, ctx))
        .toEqual({ scrollOffset: 2, followTail: false, handled: true });
      expect(processDetailKey("\x1b[5~", { scrollOffset: 3, followTail: true }, ctx))
        .toEqual({ scrollOffset: 0, followTail: false, handled: true });
    });

    it("PgDn：下翻一屏 + 到底恢复跟随；中途未到底保持脱离", () => {
      expect(processDetailKey("\x1b[6~", { scrollOffset: 0, followTail: false }, ctx))
        .toEqual({ scrollOffset: 10, followTail: false, handled: true });
      // max = 35 - 10 = 25；10+10=20 < 25 → 仍脱离
      expect(processDetailKey("\x1b[6~", { scrollOffset: 10, followTail: false }, ctx))
        .toEqual({ scrollOffset: 20, followTail: false, handled: true });
      // 20+10=30 > 25 → clamp 到底 → 恢复跟随
      expect(processDetailKey("\x1b[6~", { scrollOffset: 20, followTail: false }, ctx))
        .toEqual({ scrollOffset: 25, followTail: true, handled: true });
    });

    it("Home 回顶脱离跟随；End 回底恢复跟随；未命中键 handled=false 原值透传", () => {
      expect(processDetailKey("\x1b[H", { scrollOffset: 9, followTail: true }, ctx))
        .toEqual({ scrollOffset: 0, followTail: false, handled: true });
      expect(processDetailKey("\x1b[F", { scrollOffset: 0, followTail: false }, ctx))
        .toEqual({ scrollOffset: 25, followTail: true, handled: true });
      expect(processDetailKey("x", { scrollOffset: 7, followTail: false }, ctx))
        .toEqual({ scrollOffset: 7, followTail: false, handled: false });
    });

    it("视口 0 → PgUp/PgDn 走 PAGE_SCROLL_DEFAULT 步长；空内容 max=0", () => {
      expect(processDetailKey("\x1b[5~", { scrollOffset: 30, followTail: true }, { viewportHeight: 0, contentLines: 0, isRunning: false }))
        .toEqual({ scrollOffset: 20, followTail: false, handled: true });
      expect(processDetailKey("\x1b[6~", { scrollOffset: 5, followTail: false }, { viewportHeight: 0, contentLines: 0, isRunning: false }))
        .toEqual({ scrollOffset: 0, followTail: true, handled: true }); // max=0 → next=min(0,15)=0 → clamp 到底恢复跟随
    });
  });

  describe("buildDetailContent 区段分支（view 驱动外的边角）", () => {
    it("超预算正文（>100KB）：保留头部 100KB 后渲染末 5 行 + (truncated) 标记", () => {
      const big = `${Array.from({ length: 10 }, (_, i) => `L${i}-` + "x".repeat(20_000)).join("\n")}`;
      const lines = buildDetailContent(makeNode({ status: "completed", result: { content: big } }), { promptExpanded: false }, makeRun(), plainTheme, 120, T0);
      const joined = lines.join("\n");
      expect(joined).toContain("(truncated)");
      // 头部 100KB ≈ 前 5 行（L0..L4，L4 中途截断）→ 末 5 行窗口 = L0..L4；L5..L9 不出现
      expect(joined).toContain("L0-");
      expect(joined).toContain("L4-");
      expect(joined).not.toContain("L5-");
      expect(joined).not.toContain("L9-");
    });

    it("worker diagnostics 封顶：>20 条显示 last 20 of N 标签，只渲染末 20 条", () => {
      const logs = Array.from({ length: 21 }, (_, i) => ({ level: "error", message: `E-${i}` }));
      const lines = buildDetailContent(makeNode({ status: "completed", result: { content: "ok" } }), { promptExpanded: false }, makeRun(logs), plainTheme, 200, T0);
      const joined = lines.join("\n");
      expect(joined).toContain("Worker diagnostics · last 20 of 21");
      expect(joined).toContain("[error] E-20");
      expect(joined).not.toContain("[error] E-0\n");
      // 单条 → "1 entry" 单数形态
      const single = buildDetailContent(makeNode({ status: "completed" }), { promptExpanded: false }, makeRun([{ level: "warn", message: "w" }]), plainTheme, 200, T0);
      expect(single.join("\n")).toContain("Worker diagnostics · 1 entry");
    });

    it("终态无工具调用（completed）→ (no activity recorded)；detailContentLength 与内容行数一致", () => {
      const node = makeNode({ status: "completed", result: { content: "done" } });
      const lines = buildDetailContent(node, { promptExpanded: false }, makeRun(), plainTheme, 120, T0);
      expect(lines.join("\n")).toContain("(no activity recorded)");
      expect(detailContentLength(node, { promptExpanded: false }, makeRun(), plainTheme)).toBe(lines.length);
    });

    it("live 路径零活动 + running 无 live → Still running...", () => {
      const live = projectRecordProgress(makeSub({ eventLog: [], turns: 0, totalTokens: 0 }));
      const lines = buildDetailContent(makeNode(), { promptExpanded: false }, makeRun(), plainTheme, 120, T0, live);
      expect(lines.join("\n")).toContain("(starting...)");
      const noLive = buildDetailContent(makeNode(), { promptExpanded: false }, makeRun(), plainTheme, 120, T0);
      expect(noLive.join("\n")).toContain("Still running...");
    });
  });
});
