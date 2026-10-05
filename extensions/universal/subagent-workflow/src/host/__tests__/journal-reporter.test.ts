// journal-reporter.test.ts —— 壳层 journal 事件推送出口（event-push-channel W-P1）。
//
// 三视角：
//   ①使用者（runtime event-adapter 视角）——帧形状：title=SUBAGENT_JOURNAL_MARKER、
//     options=[JSON 报告]（domain/fileKey/events/sessionId/emittedAt）、控制面级
//     timeout 在场；
//   ②构建者——单帧单文件（fileKey 单数）；一次推送尝试在途时新事件并入待推缓冲，
//     成功后逐组继续；失败（无 ack）→ 待推缓冲整体丢弃不重推（设计 D5，与 inflight
//     的 dirty 重推刻意分叉——消费方有 seq 水位可判缺口）；
//   ③观察者——onJournalAppended 同步返回（不 await select，不进落盘主链）；
//     非 rpc 模式 no-op（不设 ctx，全程零帧）；detach 后通道静默。
//
// 与 inflight-reporter 的差异锚：无初始帧（报告语义是增量事件，空 session 无事件
// 可报，缺席语义归消费方冷读——设计 §3.3）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks（依赖收窄：logger 防文件落盘） ──

const extensionLoggerMock = vi.hoisted(() => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("@zhushanwen/pi-extension-logger", () => extensionLoggerMock);

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { JOURNAL_REPORT_ACK, SUBAGENT_JOURNAL_MARKER } from "@zhushanwen/extension-protocol";

import { createJournalReporter } from "../journal-reporter.ts";

const SELECT_TIMEOUT_MS = 1_000;

type SelectCall = { title: string; payload: string; timeout: number | undefined };

/** 可控 select 通道：每次调用的应答由用例逐帧裁决（ack / undefined / 抛错 / 挂起）。 */
function makeSelectChannel() {
  const calls: SelectCall[] = [];
  const pending: Array<(v: unknown) => void> = [];
  const select = vi.fn(
    (title: string, options: string[], opts?: { timeout?: number }): Promise<unknown> => {
      calls.push({ title, payload: options[0] ?? "", timeout: opts?.timeout });
      return new Promise((resolve) => pending.push(resolve));
    },
  );
  return {
    select,
    calls,
    /** resolve 第 N 帧（0 起）。 */
    settle(index: number, value: unknown): void {
      pending[index]?.(value);
    },
    settleAll(value: unknown): void {
      while (pending.length > 0) pending.shift()?.(value);
    },
  };
}

function makeCtx(channel: ReturnType<typeof makeSelectChannel>, sessionId = "sess-journal"): ExtensionContext {
  return {
    cwd: "/w",
    mode: "rpc",
    sessionManager: { getSessionId: () => sessionId },
    ui: { select: channel.select },
  } as unknown as ExtensionContext;

}

function makeNonRpcCtx(channel: ReturnType<typeof makeSelectChannel>): ExtensionContext {
  return {
    cwd: "/w",
    mode: "tui",
    sessionManager: { getSessionId: () => "sess-journal" },
    ui: { select: channel.select },
  } as unknown as ExtensionContext;
}

function parseFrame(call: SelectCall): Record<string, unknown> {
  return JSON.parse(call.payload) as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 推进 fake 时间并排空微任务（attempt 的 await 链走完）。 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("帧形状与单文件单帧（①使用者契约）", () => {
  it("onJournalAppended → 单帧报告（title/marker、domain/fileKey/events/sessionId、控制面 timeout）", async () => {
    const channel = makeSelectChannel();
    const reporter = createJournalReporter({ selectTimeoutMs: SELECT_TIMEOUT_MS });
    reporter.attachSession(makeCtx(channel));

    reporter.onJournalAppended("run", "wf-1", [{ type: "run-created", ts: 1, seq: 1 }]);
    await advance(0);

    expect(channel.calls).toHaveLength(1);
    expect(channel.calls[0].title).toBe(SUBAGENT_JOURNAL_MARKER);
    expect(channel.calls[0].timeout).toBe(SELECT_TIMEOUT_MS);
    const frame = parseFrame(channel.calls[0]);
    expect(frame.domain).toBe("run");
    expect(frame.fileKey).toBe("wf-1");
    expect(frame.events).toEqual([{ type: "run-created", ts: 1, seq: 1 }]);
    expect(frame.sessionId).toBe("sess-journal");
    expect(typeof frame.emittedAt).toBe("number");

    channel.settleAll(JOURNAL_REPORT_ACK);
    await advance(0);
  });

  it("在途期间同文件新事件并入待推缓冲（成功后作为下一帧）；不同文件逐帧发送（fileKey 单数契约）", async () => {
    const channel = makeSelectChannel();
    const reporter = createJournalReporter();
    reporter.attachSession(makeCtx(channel));

    reporter.onJournalAppended("run", "wf-1", [{ type: "run-created", ts: 1, seq: 1 }]);
    // 第一帧在途：同文件第二事件并入待推缓冲组；另一文件组队
    reporter.onJournalAppended("run", "wf-1", [{ type: "agent-started", ts: 2, seq: 2 }]);
    reporter.onJournalAppended("run", "wf-1", [{ type: "agent-settled", ts: 3, seq: 3 }]);
    reporter.onJournalAppended("record", "sa-1", [{ type: "record-created", ts: 4, seq: 1 }]);
    await advance(0);
    expect(channel.calls).toHaveLength(1); // 在途串行化：不并发发帧

    // 帧 0（run-created）ack 落定 → 缓冲组 wf-1（两事件已合并为一组）先发
    channel.settle(0, JOURNAL_REPORT_ACK);
    await advance(0);
    expect(channel.calls).toHaveLength(2);
    expect(parseFrame(channel.calls[1]).fileKey).toBe("wf-1");
    expect(parseFrame(channel.calls[1]).events).toEqual([
      { type: "agent-started", ts: 2, seq: 2 },
      { type: "agent-settled", ts: 3, seq: 3 },
    ]);

    // 组间 FIFO：record 组随后
    channel.settle(1, JOURNAL_REPORT_ACK);
    await advance(0);
    expect(channel.calls).toHaveLength(3);
    expect(parseFrame(channel.calls[2]).fileKey).toBe("sa-1");
    expect(parseFrame(channel.calls[2]).domain).toBe("record");
    channel.settle(2, JOURNAL_REPORT_ACK);
    await advance(0);
  });
});

describe("失败折叠（设计 D5：缓冲即弃不重推，完整性归消费方缺口补读）", () => {
  it("无 ack（超时形态）→ 待推缓冲整体丢弃；时间推进零重推，新事件重新起推", async () => {
    const channel = makeSelectChannel();
    const reporter = createJournalReporter();
    reporter.attachSession(makeCtx(channel));

    reporter.onJournalAppended("run", "wf-1", [{ type: "run-created", ts: 1, seq: 1 }]);
    await advance(0);
    channel.settle(0, undefined); // 首帧失败落定（超时形态）
    await advance(0);
    // 在途期间并入的事件随失败一并丢弃（缓冲即弃）
    expect(channel.calls).toHaveLength(1);

    await advance(60_000); // 无 timer 自动重试
    expect(channel.calls).toHaveLength(1);

    // 新的落盘事件重新起推（缓冲已清空，新事件是唯一载荷——不补发丢失事件）
    reporter.onJournalAppended("run", "wf-1", [{ type: "agent-started", ts: 2, seq: 2 }]);
    await advance(0);
    expect(channel.calls).toHaveLength(2);
    expect((parseFrame(channel.calls[1]).events as unknown[]).length).toBe(1);
    channel.settleAll(JOURNAL_REPORT_ACK);
    await advance(0);
  });

  it("非确认回包（任意字符串）不算送达，同款缓冲即弃", async () => {
    const channel = makeSelectChannel();
    const reporter = createJournalReporter();
    reporter.attachSession(makeCtx(channel));
    reporter.onJournalAppended("record", "sa-1", [{ type: "record-created", ts: 1, seq: 1 }]);
    await advance(0);
    channel.settle(0, '{"ok":1}');
    await advance(0);
    await advance(60_000);
    expect(channel.calls).toHaveLength(1);
  });
});

describe("生命周期与环境门控（③观察者）", () => {
  it("onJournalAppended 同步返回：select 永不落定也不挂调用方（detach 可丢弃在途帧与缓冲）", async () => {
    const channel = makeSelectChannel();
    const reporter = createJournalReporter();
    reporter.attachSession(makeCtx(channel));

    reporter.onJournalAppended("run", "wf-1", [{ type: "run-created", ts: 1, seq: 1 }]);
    await advance(0);
    // 第一帧挂起（模拟 runtime 无响应）——落盘出口调用仍同步返回
    expect(() => reporter.onJournalAppended("run", "wf-1", [{ type: "agent-started", ts: 2, seq: 2 }])).not.toThrow();

    // session 死后 detach：挂起帧被丢弃、缓冲清空，通道静止
    reporter.detachSession();
    channel.settleAll(undefined);
    await advance(60_000);
    expect(channel.calls).toHaveLength(1);
  });

  it("非 rpc 模式 no-op：不设 ctx，落盘事件零帧（裸 pi TUI 下 marker select 会弹真框）", async () => {
    const channel = makeSelectChannel();
    const reporter = createJournalReporter();
    reporter.attachSession(makeNonRpcCtx(channel));

    reporter.onJournalAppended("run", "wf-1", [{ type: "run-created", ts: 1, seq: 1 }]);
    await advance(60_000);
    expect(channel.calls).toHaveLength(0);
  });

  it("attach 前的落盘事件不进缓冲（无 ctx 直返——factory 阶段落盘点早于 session_start 的窗口）", async () => {
    const channel = makeSelectChannel();
    const reporter = createJournalReporter();
    reporter.onJournalAppended("run", "wf-1", [{ type: "run-created", ts: 1, seq: 1 }]);
    await advance(0);
    reporter.attachSession(makeCtx(channel));
    await advance(0);
    expect(channel.calls).toHaveLength(0); // 丢失面归消费方冷读收敛
  });
});
