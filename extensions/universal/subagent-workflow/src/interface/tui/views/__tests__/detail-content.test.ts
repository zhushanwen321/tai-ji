/**
 * detail-content 纯函数直测——与 WorkflowsView.driver.test.ts（经 view 驱动覆盖）
 * 互补：本文件直接单测 view 驱动不易逐一命中的分支面。
 *
 * 覆盖面：
 *   - statusLabel 四分支（入参收窄联合的编译期补齐运行时对照）
 *   - projectRecordProgress 投影口径（S1 等价表：toolCallCount = tool_start 计数、
 *     lastError = eventLog 末条 error 的 label、elapsed/turns/token 直读）
 *   - processDetailKey 全键位（PgUp/PgDn/Home/End）+ followTail 语义 + 视口 0 兜底
 *   - buildDetailContent 大正文截断（>OUTPUT_TRUNCATE_BYTES → 末 5 行 + (truncated)）
 *     与 worker diagnostics 封顶标签（>20 条 → last 20 of N）
 */
import { describe, expect, it } from "vitest";

import type { AgentEventLogEntry, SubagentRecord, WorkflowRun } from "@zhushanwen/subagent-core";
import type { ExecutionTraceNode } from "@zhushanwen/subagent-core";

import type { ThemeLike } from "../../../format/format.ts";
import {
  buildDetailContent,
  detailContentLength,
  processDetailKey,
  projectRecordProgress,
  statusLabel,
} from "../detail-content.ts";

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

describe("statusLabel 色档四分支", () => {
  it("completed→success / running→warning / failed→error / 其他→muted", () => {
    expect(statusLabel("completed", markingTheme)).toBe("success(completed)");
    expect(statusLabel("running", markingTheme)).toBe("warning(running)");
    expect(statusLabel("failed", markingTheme)).toBe("error(failed)");
    expect(statusLabel("pending" as ExecutionTraceNode["status"], markingTheme)).toBe("muted(pending)");
  });
});

describe("projectRecordProgress 投影口径（S1 等价表消费面）", () => {
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
