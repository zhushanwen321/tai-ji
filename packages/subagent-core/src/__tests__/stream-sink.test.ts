/**
 * SubagentStream — text_delta streaming 生命周期测试。
 *
 * 覆盖：
 * - leading edge：第一个 delta 立即 flush
 * - trailing edge：100ms 内多个 delta 合并为一次 flush
 * - 多行文本：delta 含换行符时 split("\n") 正确
 * - dispose：清除 widget + 清 timer（幂等）
 * - dispose 后 onDelta 静默丢弃
 * - widgetKey 格式（subagent-stream-<recordId>）
 *
 * SubagentStream 内聚 buffer/timer 状态，通过 StreamSink 接口输出。
 * 测试用 mock sink 收集 setWidget 调用，vi.useFakeTimers 控制合并窗口时序。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type StreamSink, SubagentStream } from "../execution/assembly/stream-sink.ts";

/** mock sink：收集所有 setWidget 调用，便于断言。 */
function createMockSink(): StreamSink & { calls: { key: string; lines: string[] | undefined }[] } {
  const calls: { key: string; lines: string[] | undefined }[] = [];
  return {
    calls,
    setWidget(key: string, lines: string[] | undefined): void {
      calls.push({ key, lines });
    },
  };
}

describe("SubagentStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ============================================================
  // U1: leading edge — 第一个 delta 立即触发 flush
  // ============================================================
  describe("leading edge", () => {
    it("第一个 delta 立即 flush，不等 timer", () => {
      const sink = createMockSink();
      const stream = new SubagentStream("bg-test", sink);

      stream.onDelta("Hello");

      expect(sink.calls).toHaveLength(1);
      expect(sink.calls[0]).toEqual({
        key: "subagent-stream-bg-test",
        lines: ["Hello"],
      });
    });
  });

  // ============================================================
  // U2: trailing edge — 100ms 内多个 delta 合并为一次 flush
  // ============================================================
  describe("trailing edge", () => {
    it("leading 之后的 delta 在 100ms 窗口内合并为一次 flush", () => {
      const sink = createMockSink();
      const stream = new SubagentStream("bg-merge", sink);

      // leading flush
      stream.onDelta("A");
      expect(sink.calls).toHaveLength(1);

      // trailing delta 进入 buffer，等 timer
      stream.onDelta("B");
      stream.onDelta("C");
      expect(sink.calls).toHaveLength(1); // 还没 flush

      // 推进 timer
      vi.advanceTimersByTime(100);

      expect(sink.calls).toHaveLength(2); // leading + trailing
      expect(sink.calls[1]).toEqual({
        key: "subagent-stream-bg-merge",
        lines: ["ABC"], // 累积全文
      });
    });
  });

  // ============================================================
  // U3: 多行文本 — delta 含换行符时 split 正确
  // ============================================================
  describe("多行文本", () => {
    it("delta 含换行符 → widgetLines 按行拆分", () => {
      const sink = createMockSink();
      const stream = new SubagentStream("bg-multi", sink);

      stream.onDelta("line1\nline2\nline3");

      expect(sink.calls[0]).toEqual({
        key: "subagent-stream-bg-multi",
        lines: ["line1", "line2", "line3"],
      });
    });
  });

  // ============================================================
  // U4: dispose — 清除 widget + 清 timer（幂等）
  // ============================================================
  describe("dispose", () => {
    it("dispose 清除 widget（setWidget key, undefined）", () => {
      const sink = createMockSink();
      const stream = new SubagentStream("bg-disp", sink);

      stream.onDelta("X"); // leading flush
      stream.onDelta("Y"); // 开始 trailing timer
      stream.dispose();

      // dispose 调 setWidget(key, undefined) 清除 widget
      const lastCall = sink.calls[sink.calls.length - 1];
      expect(lastCall).toEqual({
        key: "subagent-stream-bg-disp",
        lines: undefined,
      });
    });

    it("dispose 后 trailing timer 不再触发 flush", () => {
      const sink = createMockSink();
      const stream = new SubagentStream("bg-timer", sink);

      stream.onDelta("X"); // leading flush
      stream.onDelta("Y"); // 开始 trailing timer
      stream.dispose(); // 清 timer

      const callCountBefore = sink.calls.length;
      vi.advanceTimersByTime(200); // timer 应已被清

      expect(sink.calls.length).toBe(callCountBefore); // 无新 flush
    });

    it("dispose 幂等——二次调用静默无副作用", () => {
      const sink = createMockSink();
      const stream = new SubagentStream("bg-idem", sink);

      stream.dispose();
      const callCountAfterFirst = sink.calls.length;

      stream.dispose(); // 二次 dispose
      expect(sink.calls.length).toBe(callCountAfterFirst); // 无新调用
    });
  });

  // ============================================================
  // U5: dispose 后 onDelta 静默丢弃
  // ============================================================
  describe("dispose 后 onDelta", () => {
    it("dispose 后调 onDelta 不触发任何 setWidget", () => {
      const sink = createMockSink();
      const stream = new SubagentStream("bg-late", sink);

      stream.dispose();
      const callCountAfterDispose = sink.calls.length;

      stream.onDelta("late delta");
      vi.advanceTimersByTime(200); // 确保没有延迟 flush

      expect(sink.calls.length).toBe(callCountAfterDispose); // 无新调用
    });
  });

  // ============================================================
  // U6: widgetKey 格式
  // ============================================================
  describe("widgetKey 格式", () => {
    it("widgetKey = subagent-stream-<recordId>", () => {
      const sink = createMockSink();
      const stream = new SubagentStream("bg-abc123", sink);

      stream.onDelta("x");

      expect(sink.calls[0]?.key).toBe("subagent-stream-bg-abc123");
    });
  });

  // ============================================================
  // U7: 空 delta 静默丢弃（不消耗 leading edge）
  // ============================================================
  describe("空 delta", () => {
    it("空字符串 onDelta 不触发 setWidget", () => {
      const sink = createMockSink();
      const stream = new SubagentStream("bg-empty", sink);

      stream.onDelta("");

      expect(sink.calls).toHaveLength(0);
    });

    it("空 delta 不消耗 leading edge——后续真实 delta 仍立即 flush", () => {
      const sink = createMockSink();
      const stream = new SubagentStream("bg-empty", sink);

      stream.onDelta("");   // 空串，不应消耗 leading
      stream.onDelta("Hi"); // 首个真实 delta，应立即 flush

      expect(sink.calls).toHaveLength(1);
      expect(sink.calls[0]?.lines).toEqual(["Hi"]);
    });
  });
});
