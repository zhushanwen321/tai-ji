// src/__tests__/prompt-ack.test.ts
//
// [relay-spawn-transport §3.4.2 M2 / D3] PromptAckTracker 状态机单测。
//
// 被测对象 = createPromptAckTracker 的五态转移与守卫（pending →
// settled(acked|rejected|timeout|lost) → disposed）：
//   - prompt response 是唯一成功回执：success:true（disposition started/queued/
//     handled 三态皆可，缺 disposition 亦可）→ acked，onFailure 不触发；
//   - success:false → rejected（带 pi error 文本，有界），立即结算不等窗口；
//   - 零输出超时（fake timers 推进 30s）→ timeout，detail 携带诊断五元组摘要；
//   - onChannelActivity 只取消零输出计时器不 settle（S8b 不误杀面）；未武装
//     （register 前）调用 no-op；
//   - failNow（stdin-unavailable / epipe）→ lost 立即失败；已 settle 后 no-op；
//   - 迟到 response（settled 后）留痕忽略，不重复结算；dispose 幂等。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
// stdin-writer.test.ts 同款：mock SDK barrel getLogger（其余成员透传），断言留痕面
vi.mock("@zhushanwen/subagent-engine-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhushanwen/subagent-engine-sdk")>();
  return {
    ...actual,
    getLogger: () => loggerMock,
  };
});

import {
  createPromptAckTracker,
  DEFAULT_PROMPT_ACK_TIMEOUT_MS,
  PROMPT_ACK_TIMEOUT_ENV,
  resolvePromptAckTimeoutMs,
  type PromptAckDiagnostics,
  type PromptAckResult,
} from "../prompt-ack.ts";

// ── helpers ──

/** 零输出形态的诊断快照（timeout 场景的基线：prompt 写入后无任何 stdout）。 */
function silentDiagnostics(overrides: Partial<PromptAckDiagnostics> = {}): PromptAckDiagnostics {
  return {
    pid: 4242,
    bytesWritten: 120,
    stdoutBytes: 64,
    stdoutBytesAfterPrompt: 0,
    stdoutSeen: false,
    getStateAnswered: false,
    ...overrides,
  };
}

type TrackerHarness = {
  tracker: ReturnType<typeof createPromptAckTracker>;
  failures: PromptAckResult[];
  diagnostics: PromptAckDiagnostics;
}

function makeTracker(opts: { timeoutMs?: number; diagnostics?: PromptAckDiagnostics } = {}): TrackerHarness {
  const diagnostics = opts.diagnostics ?? silentDiagnostics();
  const failures: PromptAckResult[] = [];
  const tracker = createPromptAckTracker({
    recordId: "rec-ack-test",
    timeoutMs: opts.timeoutMs ?? DEFAULT_PROMPT_ACK_TIMEOUT_MS,
    diagnostics: () => diagnostics,
    onFailure: (r) => failures.push(r),
  });
  return { tracker, failures, diagnostics };
}

/** prompt response 帧分发的快捷形态（与 pump response 分支同参）。 */
function dispatchPrompt(
  h: TrackerHarness,
  id: string | undefined,
  success: boolean,
  data?: unknown,
  error?: string,
): void {
  h.tracker.dispatch(id, "prompt", success, data, error);
}

beforeEach(() => {
  vi.useFakeTimers();
  loggerMock.debug.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// settled = acked（prompt response 是唯一成功回执）
// ============================================================

describe("acked（唯一成功回执 = prompt response success:true）", () => {
  it.each([
    ["started", { disposition: "started" }],
    ["queued", { disposition: "queued" }],
    ["handled", { disposition: "handled" }],
  ])("success:true + disposition=%s → acked（三种受理形态皆合法，D3 不只认 started）", (expected, data) => {
    const h = makeTracker();
    h.tracker.register("id-1");
    dispatchPrompt(h, "id-1", true, data);

    expect(h.failures).toEqual([]); // acked 不触发 onFailure
    // 留痕面：ack latency debug 日志（S8 日志有 ack latency）+ 无失败 warn
    const debugs = loggerMock.debug.mock.calls.map((c) => String(c[0]));
    expect(debugs.some((m) => m.includes("prompt acked") && m.includes(`disposition=${expected}`))).toBe(true);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("success:true 且 data 无 disposition → acked（disposition 缺省不失败）", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    dispatchPrompt(h, "id-1", true, { other: 1 });
    expect(h.failures).toEqual([]);
  });

  it("acked 后 tracker 结算：迟到同 id response 留痕忽略（不重复结算）", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    dispatchPrompt(h, "id-1", true, { disposition: "started" });
    dispatchPrompt(h, "id-1", true, { disposition: "queued" });

    expect(loggerMock.warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("late prompt response"))).toBe(true);
    expect(h.failures).toEqual([]);
  });
});

// ============================================================
// settled = rejected（success:false，立即结算）
// ============================================================

describe("rejected（success:false → engine_prompt_rejected 面，不等 30s）", () => {
  it("success:false → onFailure(rejected)，detail 带 pi error 文本", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    dispatchPrompt(h, "id-1", false, undefined, "model quota exceeded");

    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatchObject({ kind: "rejected", detail: "model quota exceeded" });
    expect(loggerMock.warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("prompt rejected by pi"))).toBe(true);
  });

  it("success:false 且无 error 文本 → detail 兜底占位（不产 undefined 文案）", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    dispatchPrompt(h, "id-1", false);
    expect(h.failures[0]).toMatchObject({ kind: "rejected", detail: "(no error text from pi)" });
  });

  it("超长 pi error 文本 → detail 有界（outcome.error 不爆）", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    dispatchPrompt(h, "id-1", false, undefined, "x".repeat(10_000));
    const detail = (h.failures[0] as { kind: "rejected"; detail: string }).detail;
    expect(detail.length).toBeLessThanOrEqual(600);
    expect(detail).toContain("(+");
  });
});

// ============================================================
// dispatch 过滤（只有 command==="prompt" 且 id 匹配才结算）
// ============================================================

describe("dispatch 过滤", () => {
  it("get_state response（command 不匹配）→ no-op，pending 不受扰", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    h.tracker.dispatch("state-id", "get_state", true, { sessionFile: "/x" });

    expect(h.failures).toEqual([]);
    // 计时器仍在：推进 30s 仍正常超时
    vi.advanceTimersByTime(DEFAULT_PROMPT_ACK_TIMEOUT_MS);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]!.kind).toBe("timeout");
  });

  it("id 不匹配 / id undefined → no-op", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    dispatchPrompt(h, "other-id", true);
    dispatchPrompt(h, undefined, true);

    expect(h.failures).toEqual([]);
    // 不误结算：prompt response 正确 id 仍可 acked
    dispatchPrompt(h, "id-1", true, { disposition: "started" });
    expect(h.failures).toEqual([]);
  });
});

// ============================================================
// settled = timeout（零输出判定，fake timers）
// ============================================================

describe("timeout（零输出判定：30s 完全零输出才失败）", () => {
  it("register 武装计时器；满窗零输出 → onFailure(timeout)，detail 含诊断五元组摘要", () => {
    const h = makeTracker({
      diagnostics: silentDiagnostics({ lastEventType: "message_end", getStateAnswered: true }),
    });
    h.tracker.register("id-1");

    vi.advanceTimersByTime(DEFAULT_PROMPT_ACK_TIMEOUT_MS - 1);
    expect(h.failures).toEqual([]); // 窗口内不失败

    vi.advanceTimersByTime(1);
    expect(h.failures).toHaveLength(1);
    const failure = h.failures[0] as { kind: "timeout"; detail: string };
    expect(failure.kind).toBe("timeout");
    // 五元组 + 窗口字段全部进 detail（诊断摘要）
    expect(failure.detail).toContain(`within ${DEFAULT_PROMPT_ACK_TIMEOUT_MS}ms`);
    expect(failure.detail).toContain("pid=4242");
    expect(failure.detail).toContain("bytesWritten=120");
    expect(failure.detail).toContain("stdoutBytes=64");
    expect(failure.detail).toContain("stdoutBytesAfterPrompt=0");
    expect(failure.detail).toContain("getStateAnswered=true");
    expect(failure.detail).toContain("lastEventType=message_end");
    // 结构化留痕：timeout warn（诊断五元组同款内容）
    expect(loggerMock.warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("prompt not delivered"))).toBe(true);
  });

  it("先 settle（acked）后计时器到期 → 不重复结算、无 onFailure", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    dispatchPrompt(h, "id-1", true);
    vi.advanceTimersByTime(DEFAULT_PROMPT_ACK_TIMEOUT_MS * 2);

    expect(h.failures).toEqual([]);
  });

  it("已 settle 后迟到 prompt response → 留痕忽略且不重复 kill/结算", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    vi.advanceTimersByTime(DEFAULT_PROMPT_ACK_TIMEOUT_MS);
    expect(h.failures).toHaveLength(1);

    dispatchPrompt(h, "id-1", true, { disposition: "started" });
    expect(h.failures).toHaveLength(1); // 不覆盖已有 failure
    expect(loggerMock.warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("late prompt response"))).toBe(true);
  });
});

// ============================================================
// onChannelActivity（stdout 活性只取消计时器，不 settle）
// ============================================================

describe("onChannelActivity（S8b：get_state 有应答但 prompt response 延迟 → 不杀不判失败）", () => {
  it("register 后任意 stdout 行 → 取消零输出计时器（推进远超窗口不失败）", () => {
    const h = makeTracker();
    h.tracker.register("id-1");

    vi.advanceTimersByTime(1_000);
    h.tracker.onChannelActivity();
    vi.advanceTimersByTime(DEFAULT_PROMPT_ACK_TIMEOUT_MS * 10);

    expect(h.failures).toEqual([]); // 计时器已取消：不误杀
    expect(h.tracker.stdoutSeen).toBe(true);
  });

  it("活性不 settle：活性后仍以 prompt response 结算（acked）", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    h.tracker.onChannelActivity();

    // 无 response 到达 → 无结算（活性不是回执、不是 pending 状态——只是日志）
    vi.advanceTimersByTime(DEFAULT_PROMPT_ACK_TIMEOUT_MS * 2);
    expect(h.failures).toEqual([]);

    // 之后 prompt response 到达 → 仍按 acked 结算
    dispatchPrompt(h, "id-1", true, { disposition: "started" });
    expect(h.failures).toEqual([]);
  });

  it("register 前的 stdout（如握手应答先达）→ no-op（不计入写入后活性，计时器照常武装）", () => {
    const h = makeTracker();
    h.tracker.onChannelActivity(); // 未武装
    expect(h.tracker.stdoutSeen).toBe(false);

    h.tracker.register("id-1");
    vi.advanceTimersByTime(DEFAULT_PROMPT_ACK_TIMEOUT_MS);
    expect(h.failures).toHaveLength(1); // 写入后确实零输出 → 正常超时
  });

  it("首次活性记 prompt ack delayed warn（含诊断摘要），只记一条", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    h.tracker.onChannelActivity();
    h.tracker.onChannelActivity(); // 计时器已清：no-op

    const warns = loggerMock.warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("prompt ack delayed"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("pid=4242");
  });
});

// ============================================================
// failNow（stdin-unavailable / epipe：立即失败不等 30s）
// ============================================================

describe("failNow（lost：立即失败）", () => {
  it("stdin-unavailable → onFailure(lost) 立即触发，计时器清空，诊断摘要进 detail", () => {
    const h = makeTracker();
    h.tracker.register("id-1");

    h.tracker.failNow("stdin-unavailable", "child stdin missing or already destroyed");

    expect(h.failures).toHaveLength(1);
    const failure = h.failures[0] as { kind: "lost"; reason: string; detail: string };
    expect(failure.kind).toBe("lost");
    expect(failure.reason).toBe("stdin-unavailable");
    expect(failure.detail).toContain("stdin-unavailable");
    expect(failure.detail).toContain("child stdin missing");
    expect(failure.detail).toContain("pid=4242");
    // 计时器已清：推进不再触发第二次
    vi.advanceTimersByTime(DEFAULT_PROMPT_ACK_TIMEOUT_MS * 2);
    expect(h.failures).toHaveLength(1);
  });

  it("epipe → lost（reason=epipe），detail 带原始写错误", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    h.tracker.failNow("epipe", "EPIPE on stdin write (prompt command)");
    expect(h.failures[0]).toMatchObject({ kind: "lost", reason: "epipe" });
    expect((h.failures[0] as { detail: string }).detail).toContain("EPIPE");
  });

  it("已 settle 后 failNow → no-op（不覆盖 acked，不重复 onFailure）", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    dispatchPrompt(h, "id-1", true);
    h.tracker.failNow("epipe", "late pipe break");
    expect(h.failures).toEqual([]);
  });
});

// ============================================================
// dispose（幂等：清 timer、清登记表、标记 disposed）
// ============================================================

describe("dispose", () => {
  it("pending 态 dispose → 计时器清除（推进不超时），后续 dispatch/register no-op", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    h.tracker.dispose();

    vi.advanceTimersByTime(DEFAULT_PROMPT_ACK_TIMEOUT_MS * 2);
    expect(h.failures).toEqual([]);

    dispatchPrompt(h, "id-1", false, undefined, "late rejection");
    h.tracker.register("id-2");
    h.tracker.failNow("epipe", "after dispose");
    expect(h.failures).toEqual([]); // disposed 后全部入口失效
  });

  it("dispose 幂等（重复调用不抛不重复触发）", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    expect(() => {
      h.tracker.dispose();
      h.tracker.dispose();
    }).not.toThrow();
    expect(h.failures).toEqual([]);
  });

  it("register 在已 settle 后 → warn 留痕 no-op（新 id 不武装计时器）", () => {
    const h = makeTracker();
    h.tracker.register("id-1");
    dispatchPrompt(h, "id-1", true);
    loggerMock.warn.mockClear();

    h.tracker.register("id-2");
    vi.advanceTimersByTime(DEFAULT_PROMPT_ACK_TIMEOUT_MS * 2);
    expect(h.failures).toEqual([]);
    expect(loggerMock.warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("register after settled"))).toBe(true);
  });
});

// ============================================================
// 窗口配置（env 覆盖 + 0 = 逃生舱关闭）
// ============================================================

describe("resolvePromptAckTimeoutMs", () => {
  it("env 缺省 → 默认 30s", () => {
    expect(resolvePromptAckTimeoutMs({})).toBe(30_000);
    expect(resolvePromptAckTimeoutMs({ [PROMPT_ACK_TIMEOUT_ENV]: "" })).toBe(30_000);
    expect(DEFAULT_PROMPT_ACK_TIMEOUT_MS).toBe(30_000);
  });

  it("env 正数覆盖生效；0 = 关闭零输出看门狗（逃生舱）；非法值回落默认", () => {
    expect(resolvePromptAckTimeoutMs({ [PROMPT_ACK_TIMEOUT_ENV]: "5000" })).toBe(5_000);
    expect(resolvePromptAckTimeoutMs({ [PROMPT_ACK_TIMEOUT_ENV]: "0" })).toBe(0);
    expect(resolvePromptAckTimeoutMs({ [PROMPT_ACK_TIMEOUT_ENV]: "-3" })).toBe(30_000);
    expect(resolvePromptAckTimeoutMs({ [PROMPT_ACK_TIMEOUT_ENV]: "abc" })).toBe(30_000);
  });

  it("timeoutMs=0 → register 不武装计时器（推进任意时长不失败，ack 结算不受影响）", () => {
    const h = makeTracker({ timeoutMs: 0 });
    h.tracker.register("id-1");
    vi.advanceTimersByTime(3_600_000);
    expect(h.failures).toEqual([]);

    dispatchPrompt(h, "id-1", true, { disposition: "queued" });
    expect(h.failures).toEqual([]); // acked 正常
  });
});
