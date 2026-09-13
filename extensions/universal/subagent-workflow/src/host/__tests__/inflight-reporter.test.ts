// inflight-reporter.test.ts —— 壳层在途上报出口（u7a，设计 §3.3 D5）。
//
// 三视角：
//   ①使用者（runtime event-adapter 视角）——帧形状：title=SUBAGENT_INFLIGHT_MARKER、
//     options=[JSON 帧]（inFlight/sessionId/emittedAt）、控制面级 timeout 在场；
//   ②构建者——初始上报（attachSession 触发，无需任何 subagent 调用）→ ack 清失败
//     计数；失败折叠 + 延迟重试；推送在途期间多次迁移合并为单帧且携带最新绝对计数；
//   ③观察者——onInFlightChanged 同步返回（不 await select，不进生命周期链）；
//     detachSession 停重试，session 死后通道静默。
//
// [HISTORICAL] 行为于 9f914b749 变更：kind='initial'|'delta' 帧字段与 initialAcked
// 状态机作为死面删除（消费方 event-adapter 从不读 kind，绝对计数语义下帧间等价；
// 该 commit 漏改本文件致断言失效）。断言已对齐现行协议形状——SubagentInFlightReport
// 无 kind 字段，kind 断言改为 undefined 锁形（防字段悄悄回流）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks（依赖收窄：logger 防文件落盘；core barrel 只留快照函数可控点） ──

const extensionLoggerMock = vi.hoisted(() => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

const mockSnapshot = vi.hoisted(() => vi.fn((): { inFlight: number } => ({ inFlight: 0 })));

vi.mock("@zhushanwen/pi-extension-logger", () => extensionLoggerMock);
vi.mock("@zhushanwen/subagent-core", () => ({ getInFlightSnapshot: mockSnapshot }));

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INFLIGHT_REPORT_ACK, SUBAGENT_INFLIGHT_MARKER } from "@xyz-agent/extension-protocol";

import { createInFlightReporter } from "../inflight-reporter.ts";

const RETRY_MS = 50;
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

function makeCtx(channel: ReturnType<typeof makeSelectChannel>, sessionId = "sess-u7a"): ExtensionContext {
  return {
    cwd: "/w",
    mode: "rpc",
    sessionManager: { getSessionId: () => sessionId },
    ui: { select: channel.select },
  } as unknown as ExtensionContext;
}

function parseFrame(call: SelectCall): Record<string, unknown> {
  return JSON.parse(call.payload) as Record<string, unknown>;
}

beforeEach(() => {
  mockSnapshot.mockImplementation(() => ({ inFlight: 0 }));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 推进 fake 时间并排空微任务（attempt 的 await 链走完）。 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("初始上报（D5：触发时点 = extension 加载完成 / session 就绪）", () => {
  it("attachSession 即发初始帧（count=当下快照，无需任何 subagent 调用）", async () => {
    const channel = makeSelectChannel();
    const reporter = createInFlightReporter({ retryDelayMs: RETRY_MS, selectTimeoutMs: SELECT_TIMEOUT_MS });

    reporter.attachSession(makeCtx(channel));
    await advance(0);

    expect(channel.calls).toHaveLength(1);
    expect(channel.calls[0].title).toBe(SUBAGENT_INFLIGHT_MARKER);
    expect(channel.calls[0].timeout).toBe(SELECT_TIMEOUT_MS);
    const frame = parseFrame(channel.calls[0]);
    expect(frame.kind).toBeUndefined(); // kind 已删（9f914b749）：锁现行协议形状，防字段回流
    expect(frame.inFlight).toBe(0);
    expect(frame.sessionId).toBe("sess-u7a");
    expect(typeof frame.emittedAt).toBe("number");

    channel.settleAll(INFLIGHT_REPORT_ACK);
    await advance(0);
  });

  it("初始未送达前发生的迁移不产生第二帧（合并为单帧，ack 后补推最新快照）", async () => {
    const channel = makeSelectChannel();
    const reporter = createInFlightReporter({ retryDelayMs: RETRY_MS });
    reporter.attachSession(makeCtx(channel));
    await advance(0);

    mockSnapshot.mockImplementation(() => ({ inFlight: 2 }));
    reporter.onInFlightChanged();
    reporter.onInFlightChanged();
    await advance(0);
    expect(channel.calls).toHaveLength(1); // 推送在途 → 只置脏，无第二帧

    channel.settleAll(INFLIGHT_REPORT_ACK);
    await advance(0);
    expect(channel.calls).toHaveLength(2);
    const delta = parseFrame(channel.calls[1]);
    expect(delta.kind).toBeUndefined(); // kind 已删（9f914b749）：帧间等价，无 initial/delta 之分
    expect(delta.inFlight).toBe(2); // 补推帧携带最新绝对计数
  });
});

describe("绝对计数语义（每帧携带当下值，非增量）", () => {
  it("连续迁移各帧均为整值快照（2 → 0，不做加减）", async () => {
    const channel = makeSelectChannel();
    const reporter = createInFlightReporter({ retryDelayMs: RETRY_MS });
    reporter.attachSession(makeCtx(channel));
    await advance(0);
    channel.settleAll(INFLIGHT_REPORT_ACK);
    await advance(0);

    mockSnapshot.mockImplementation(() => ({ inFlight: 2 }));
    reporter.onInFlightChanged();
    await advance(0);
    mockSnapshot.mockImplementation(() => ({ inFlight: 0 }));
    reporter.onInFlightChanged(); // attempt(count=2) 仍在途 → 置脏合并
    expect(channel.calls).toHaveLength(2);

    // 前帧 ack 落定后，脏标记触发补推（携带此刻快照 0）
    channel.settleAll(INFLIGHT_REPORT_ACK);
    await advance(0);
    expect(channel.calls).toHaveLength(3);
    expect(parseFrame(channel.calls[1]).inFlight).toBe(2);
    expect(parseFrame(channel.calls[2]).inFlight).toBe(0);
    channel.settleAll(INFLIGHT_REPORT_ACK);
  });
});

describe("失败折叠 + 延迟重试直至成功一次（D5 缺席语义②）", () => {
  it("select resolve undefined（超时/旧版 runtime）→ 折叠重试；重试帧携带完整快照；ack 后停", async () => {
    const channel = makeSelectChannel();
    const reporter = createInFlightReporter({ retryDelayMs: RETRY_MS, selectTimeoutMs: SELECT_TIMEOUT_MS });
    reporter.attachSession(makeCtx(channel));
    await advance(0);
    expect(channel.calls).toHaveLength(1);

    // 首帧无人 ack，select 以 undefined 落定（超时形态）→ 折叠
    channel.settle(0, undefined);
    await advance(RETRY_MS - 1);
    expect(channel.calls).toHaveLength(1); // 未到退避点不重试
    await advance(1);
    expect(channel.calls).toHaveLength(2);
    const retryFrame = parseFrame(channel.calls[1]);
    expect(retryFrame.kind).toBeUndefined(); // kind 已删（9f914b749）：重试帧与普通帧等价
    expect(retryFrame.inFlight).toBe(0); // 重试帧携带完整绝对计数快照

    // 重试帧得到 ack → 重试停止；随后迁移照常送达
    channel.settle(1, INFLIGHT_REPORT_ACK);
    await advance(RETRY_MS * 10);
    expect(channel.calls).toHaveLength(2);

    reporter.onInFlightChanged();
    await advance(0);
    expect(channel.calls).toHaveLength(3);
    expect(parseFrame(channel.calls[2]).inFlight).toBe(0);
    channel.settleAll(INFLIGHT_REPORT_ACK);
  });

  it("select 通道抛错同样折叠进重试路径", async () => {
    const channel = makeSelectChannel();
    const reporter = createInFlightReporter({ retryDelayMs: RETRY_MS });
    reporter.attachSession(makeCtx(channel));
    await advance(0);
    channel.settle(0, new Error("channel blew up"));
    await advance(RETRY_MS);
    expect(channel.calls.length).toBeGreaterThanOrEqual(2);
    channel.settleAll(INFLIGHT_REPORT_ACK);
    await advance(0);
  });

  it("非确认回包（旧版 runtime 的任意字符串）不算送达，继续重试", async () => {
    const channel = makeSelectChannel();
    const reporter = createInFlightReporter({ retryDelayMs: RETRY_MS });
    reporter.attachSession(makeCtx(channel));
    await advance(0);
    channel.settle(0, '{"ok":1}');
    await advance(RETRY_MS);
    expect(channel.calls).toHaveLength(2);
    channel.settleAll(INFLIGHT_REPORT_ACK);
    await advance(0);
  });
});

describe("不阻塞生命周期主链（D5 接线约束①）", () => {
  it("onInFlightChanged 同步返回：select 永不落定也不挂调用方（detach 可丢弃在途帧）", async () => {
    const channel = makeSelectChannel();
    const reporter = createInFlightReporter({ retryDelayMs: RETRY_MS });
    reporter.attachSession(makeCtx(channel));
    await advance(0);

    // 第一帧挂起（模拟 runtime 无响应）——迁移调用仍同步返回
    expect(() => reporter.onInFlightChanged()).not.toThrow();

    // session 死后 detach：挂起帧被丢弃，重试链静止（时间推进零新调用）
    reporter.detachSession();
    channel.settleAll(undefined);
    await advance(RETRY_MS * 5);
    expect(channel.calls).toHaveLength(1);
  });

  it("detachSession 清掉待发重试定时器（session 已死，重试语义随之终结）", async () => {
    const channel = makeSelectChannel();
    const reporter = createInFlightReporter({ retryDelayMs: RETRY_MS });
    reporter.attachSession(makeCtx(channel));
    await advance(0);
    reporter.detachSession();
    channel.settleAll(undefined); // 在途帧失败落定——ctx 已空，不排新重试
    await advance(RETRY_MS * 10);
    expect(channel.calls).toHaveLength(1);
  });
});
