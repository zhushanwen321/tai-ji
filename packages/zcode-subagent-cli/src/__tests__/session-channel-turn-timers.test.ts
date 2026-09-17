// session-channel-turn-timers.test.ts —— P0-1 U1 turn 等待两 timer 状态机单测。
//
// 设计锚点：D1（idle
// 主判定 + 宽上界回收兜底）/ D2（env 配置通道）/ U1（lastTerminalStatus +
// lookupTurn 归因放宽）。验收映射：
//   ① 事件流活跃 → idle 持续刷新不触发（活跃任务零误杀）
//   ② 静默超 idle 阈值 → TurnTimeoutError（idle 形态）
//   ③ 总时长超宽上界 → TurnTimeoutError（ceiling 形态，事件活跃仍回收）
//   ④ 事件刷新不影响总上界倒数（fire 时刻 = 阈值精确值）
//   ⑤ env 覆盖生效 + 0=关闭语义（env 与显式传参两通道）
//   ⑥ 迟到 turn.terminal status 只记录不改写已落定结果（D5①/S5）
//
// 与 session-channel.test.ts（fake-appserver 子进程 + 真实 timer）互补：本文件用
// mock 连接 + fake timers 驱动纯状态机——timer 时序断言（刷新/倒数/精确 fire 点）
// 必须时钟可控才可判定。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import { getLogger } from "@zhushanwen/subagent-engine-sdk";
import type { AppServerConnection } from "../connection.ts";
import {
  ZCODE_TURN_IDLE_TIMEOUT_ENV,
  ZCODE_TURN_MAX_TIMEOUT_ENV,
  ZCODE_TURN_IDLE_TIMEOUT_MS,
  ZCODE_TURN_MAX_TIMEOUT_MS,
} from "../constants.ts";
import {
  SessionChannel,
  TurnTimeoutError,
  type SessionTurnResult,
  type SessionTurnOptions,
} from "../session-channel.ts";

// ============================================================
// mock 连接 + 驱动器（SessionChannel 只触 conn 的 onNotification/onClose/request/alive）
// ============================================================

interface MockChannel {
  ch: SessionChannel;
  /** 我方发出的请求帧流水（method 序可断言）。 */
  requests: Array<{ method: string; params: unknown }>;
  /** 挂起中的 session/read 应答放行器（终态后收尾窗口可控）。 */
  readGates: Array<(v: unknown) => void>;
  emit: (method: string, params: unknown) => void;
  emitDelta: (sessionId: string | undefined, delta: string) => void;
  emitFinalFrame: (sessionId: string, response: string) => void;
  emitTerminal: (sessionId: string | undefined, status: string) => void;
}

let sidSeq = 0;

function makeMockChannel(opts: { gateRead?: boolean } = {}): MockChannel {
  const notifications = new Map<string, (params: unknown) => void>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const readGates: Array<(v: unknown) => void> = [];
  const conn = {
    alive: true,
    onNotification: (method: string, h: (params: unknown) => void) => {
      notifications.set(method, h);
      return () => notifications.delete(method);
    },
    onClose: (_h: (reason: string) => void) => () => {},
    request: (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "session/create") {
        sidSeq += 1;
        return Promise.resolve({ session: { sessionId: `sess_t${sidSeq}` } });
      }
      if (method === "session/send") return Promise.resolve({ accepted: true });
      if (method === "session/read") {
        if (opts.gateRead === true) {
          return new Promise((resolve) => readGates.push(resolve));
        }
        return Promise.resolve({ messages: [] });
      }
      return Promise.resolve({});
    },
  } as unknown as AppServerConnection;
  const ch = new SessionChannel(conn);
  return {
    ch,
    requests,
    readGates,
    emit: (method, params) => notifications.get(method)?.(params),
    emitDelta: (sessionId, delta) =>
      notifications
        .get("session/event")
        ?.({ sessionId, payload: { delta } }),
    emitFinalFrame: (sessionId, response) =>
      notifications
        .get("session/event")
        ?.({ sessionId, payload: { response } }),
    // A.2：telemetry 帧不标会话归属——sessionId 传 undefined 即真实形态
    emitTerminal: (sessionId, status) =>
      notifications
        .get("v4/telemetry/event")
        ?.({ kind: "turn.terminal", status, sessionId }),
  };
}

interface TurnTracker {
  outcome: "pending" | "fulfilled" | "rejected";
  result: SessionTurnResult | undefined;
  error: unknown;
  promise: Promise<SessionTurnResult>;
  sessionId: string;
}

function startTurn(ch: SessionChannel, opts: SessionTurnOptions = {}): TurnTracker {
  let sessionId = "";
  const promise = ch.runTurn({ workspacePath: "/tmp/ws-timers", mode: "yolo" }, "任务", {
    onSessionCreated: (sid) => {
      sessionId = sid;
    },
    ...opts,
  });
  const t: TurnTracker = {
    outcome: "pending",
    result: undefined,
    error: undefined,
    promise,
    sessionId: "",
  };
  void promise.then(
    (r) => {
      t.outcome = "fulfilled";
      t.result = r;
    },
    (e) => {
      t.outcome = "rejected";
      t.error = e;
    }
  );
  // sessionId 经 onSessionCreated 回填——闭包读的是 t.sessionId 快照，改为代理
  Object.defineProperty(t, "sessionId", {
    get: () => sessionId,
  });
  return t;
}

/** fake timers 下把 runTurn 的 setup 微任务链（create→subscribe→send）推到挂起点。 */
async function flushSetup(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

const warnLogger = getLogger("subagents");
let warnSpy: MockInstance<(msg: string, data?: unknown) => void>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  warnSpy = vi.spyOn(warnLogger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const MIN = 60_000;

// ============================================================
// ① 事件刷新——活跃事件流 idle 永不触发
// ============================================================

describe("① idle 主判定：事件刷新（P0-1 D1）", () => {
  it("短阈值：每 900ms 一个 delta（阈值 1s）连续 5 轮 → idle 不触发，终态正常 resolve", async () => {
    const m = makeMockChannel();
    const t = startTurn(m.ch, { idleTimeoutMs: 1_000, turnTimeoutMs: 0 }); // 关总上界隔离变量
    await flushSetup();
    expect(t.sessionId).not.toBe("");
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(900); // < 1s 阈值
      m.emitDelta(t.sessionId, `片段${i}`); // 事件到达 → idle 重挂
      expect(t.outcome).toBe("pending");
    }
    m.emitTerminal(undefined, "success");
    await t.promise;
    expect(t.outcome).toBe("fulfilled");
    expect(t.result?.terminal).toEqual({ status: "success", source: "turn.terminal" });
  });

  it("默认阈值（30min idle / 60min 上界）：每 29min 一个事件，59min 处终态 → 全程不判死", async () => {
    const m = makeMockChannel();
    const t = startTurn(m.ch);
    await flushSetup();
    await vi.advanceTimersByTimeAsync(29 * MIN);
    m.emitDelta(t.sessionId, "a");
    await vi.advanceTimersByTimeAsync(29 * MIN);
    m.emitDelta(t.sessionId, "b");
    await vi.advanceTimersByTimeAsync(1 * MIN); // 累计 59min < 60min 上界
    m.emitTerminal(undefined, "success");
    await t.promise;
    expect(t.outcome).toBe("fulfilled");
    // 累计 59min 时若 idle 不刷新早已判死——活到 59min 即刷新语义的直接证据
    expect(t.result?.response).toBe("ab");
  });
});

// ============================================================
// ② 静默判死——TurnTimeoutError（idle 形态）
// ============================================================

describe("② idle 静默判死（P0-1 D1）", () => {
  it("整轮无事件：静默达阈值 → TurnTimeoutError kind=idle（lastEventAt=undefined）", async () => {
    const m = makeMockChannel();
    const t = startTurn(m.ch, { idleTimeoutMs: 1_000, turnTimeoutMs: 0 });
    await flushSetup();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.outcome).toBe("rejected");
    const err = t.error as TurnTimeoutError;
    expect(err).toBeInstanceOf(TurnTimeoutError);
    expect(err.kind).toBe("idle");
    expect(err.thresholdMs).toBe(1_000);
    expect(err.elapsed).toBe(1_000);
    expect(err.lastEventAt).toBeUndefined();
    expect(err.message).toContain("连续 1000ms");
    expect(err.message).toContain("终态"); // 既有消费方 /终态/ 语境兼容
    expect(err.message).toContain("engine: pi");
  });

  it("有事件后静默：lastEventAt 记最后事件时刻，自此刻起算静默判死", async () => {
    const m = makeMockChannel();
    const t = startTurn(m.ch, { idleTimeoutMs: 1_000, turnTimeoutMs: 0 });
    await flushSetup();
    const t0 = Date.now(); // fake 时钟起点 = 挂载后基准（真实 epoch，非 0）
    await vi.advanceTimersByTimeAsync(400);
    m.emitDelta(t.sessionId, "最后的事件");
    await vi.advanceTimersByTimeAsync(1_000); // 自最后事件起 1s（总时长 1.4s）
    expect(t.outcome).toBe("rejected");
    const err = t.error as TurnTimeoutError;
    expect(err.kind).toBe("idle");
    expect(err.elapsed).toBe(1_400);
    expect(err.lastEventAt).toBe(t0 + 400);
  });
});

// ============================================================
// ③④ 总上界判死——事件活跃仍回收（chatty-wedge）；刷新不影响上界倒数
// ============================================================

describe("③④ 总上界回收兜底（P0-1 D1）", () => {
  it("③ 事件流持续活跃：总上界到点仍判死 → TurnTimeoutError kind=ceiling + env 自救指引", async () => {
    const m = makeMockChannel();
    const t = startTurn(m.ch, { idleTimeoutMs: 1_000, turnTimeoutMs: 5_000 });
    await flushSetup();
    // 每 800ms 一个事件 ×6（ idle 每次刷新，从不触发），末次事件在 4900ms
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(800);
      m.emitDelta(t.sessionId, `c${i}`);
    }
    await vi.advanceTimersByTimeAsync(100); // 4900ms
    m.emitDelta(t.sessionId, "c6");
    await vi.advanceTimersByTimeAsync(200); // 5100ms > 5000ms 上界
    expect(t.outcome).toBe("rejected");
    const err = t.error as TurnTimeoutError;
    expect(err).toBeInstanceOf(TurnTimeoutError);
    expect(err.kind).toBe("ceiling"); // 不是 idle——事件流活跃，idle 从未触发
    expect(err.thresholdMs).toBe(5_000);
    expect(err.message).toContain("总上界");
    expect(err.message).toContain("chatty-wedge");
    expect(err.message).toContain("终态");
    expect(err.message).toContain(ZCODE_TURN_MAX_TIMEOUT_ENV);
    expect(err.message).toContain("0 关闭");
  });

  it("④ 事件刷新不影响总上界倒数：5 次刷新后 fire 时刻仍 = 阈值精确值", async () => {
    const m = makeMockChannel();
    const t = startTurn(m.ch, { idleTimeoutMs: 1_000, turnTimeoutMs: 5_000 });
    await flushSetup();
    const t0 = Date.now(); // fake 时钟起点 = 挂载后基准（真实 epoch，非 0）
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(800);
      m.emitDelta(t.sessionId, `c${i}`);
    }
    await vi.advanceTimersByTimeAsync(900); // 3200+900=4100ms 处再刷一次（idle 截止 5100 > 上界 5000，避免同刻 tie）
    m.emitDelta(t.sessionId, "c4");
    await vi.advanceTimersByTimeAsync(1_000); // 5100ms，上界在 5000ms 已 fire
    const err = t.error as TurnTimeoutError;
    expect(err.kind).toBe("ceiling");
    expect(err.elapsed).toBe(5_000); // 刷新只重挂 idle，总上界从挂载起固定倒数
    expect(err.lastEventAt).toBe(t0 + 4_100); // 刷新被记账（事件确实到达过）
  });
});

// ============================================================
// ⑤ env 覆盖生效 + 0=关闭语义（env 与显式传参两通道）
// ============================================================

describe("⑤ 配置通道（P0-1 D2）", () => {
  it("env 覆盖 idle：TAIJI_ZCODE_TURN_IDLE_TIMEOUT_MS=500 → 静默 500ms 判死（默认 30min 被覆盖）", async () => {
    vi.stubEnv(ZCODE_TURN_IDLE_TIMEOUT_ENV, "500");
    vi.stubEnv(ZCODE_TURN_MAX_TIMEOUT_ENV, "0"); // 关上界隔离变量
    const m = makeMockChannel();
    const t = startTurn(m.ch);
    await flushSetup();
    await vi.advanceTimersByTimeAsync(500);
    const err = t.error as TurnTimeoutError;
    expect(err).toBeInstanceOf(TurnTimeoutError);
    expect(err.kind).toBe("idle");
    expect(err.thresholdMs).toBe(500);
  });

  it("env 覆盖总上界：TAIJI_ZCODE_TURN_MAX_TIMEOUT_MS=800 → 事件活跃 800ms 判死（kind=ceiling）", async () => {
    vi.stubEnv(ZCODE_TURN_MAX_TIMEOUT_ENV, "800");
    vi.stubEnv(ZCODE_TURN_IDLE_TIMEOUT_ENV, "600000"); // idle 10min 不干扰
    const m = makeMockChannel();
    const t = startTurn(m.ch);
    await flushSetup();
    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(300);
    m.emitDelta(t.sessionId, "活跃中");
    await vi.advanceTimersByTimeAsync(500);
    const err = t.error as TurnTimeoutError;
    expect(err.kind).toBe("ceiling");
    expect(err.thresholdMs).toBe(800);
    expect(err.lastEventAt).toBe(t0 + 300);
  });

  it("env 0=关闭两 timer：静默 2 小时无任何判死 + 关闭 warn 明示后果（A10①），终态仍可 resolve", async () => {
    vi.stubEnv(ZCODE_TURN_IDLE_TIMEOUT_ENV, "0");
    vi.stubEnv(ZCODE_TURN_MAX_TIMEOUT_ENV, "0");
    const m = makeMockChannel();
    const t = startTurn(m.ch);
    await flushSetup();
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(t.outcome).toBe("pending"); // 无隐式判死
    m.emitTerminal(undefined, "success");
    await t.promise;
    expect(t.outcome).toBe("fulfilled");
    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warns.some((w) => w.includes("idle 主判定") && w.includes("已关闭"))).toBe(true);
    expect(warns.some((w) => w.includes("总上界") && w.includes("已关闭"))).toBe(true);
  });

  it("显式传参 0=关闭（优先级高于 env）：idleTimeoutMs/turnTimeoutMs=0 压过 env 正值", async () => {
    vi.stubEnv(ZCODE_TURN_IDLE_TIMEOUT_ENV, "500");
    vi.stubEnv(ZCODE_TURN_MAX_TIMEOUT_ENV, "600");
    const m = makeMockChannel();
    const t = startTurn(m.ch, { idleTimeoutMs: 0, turnTimeoutMs: 0 });
    await flushSetup();
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN); // 远超两个 env 值
    expect(t.outcome).toBe("pending"); // 显式 0 = 关闭，env 未生效
    m.emitTerminal(undefined, "success");
    await t.promise;
    expect(t.outcome).toBe("fulfilled");
  });

  it("显式传参覆盖 env：idleTimeoutMs=60000 压过 env=500，60s 判死", async () => {
    vi.stubEnv(ZCODE_TURN_IDLE_TIMEOUT_ENV, "500");
    vi.stubEnv(ZCODE_TURN_MAX_TIMEOUT_ENV, "0");
    const m = makeMockChannel();
    const t = startTurn(m.ch, { idleTimeoutMs: 60_000 });
    await flushSetup();
    await vi.advanceTimersByTimeAsync(600);
    expect(t.outcome).toBe("pending"); // env 500 未生效——显式传参优先
    await vi.advanceTimersByTimeAsync(59_400);
    const err = t.error as TurnTimeoutError;
    expect(err.kind).toBe("idle");
    expect(err.thresholdMs).toBe(60_000);
  });

  it("env 非法值 warn + 回落默认：'abc' → 30min 默认阈值生效", async () => {
    vi.stubEnv(ZCODE_TURN_IDLE_TIMEOUT_ENV, "abc");
    vi.stubEnv(ZCODE_TURN_MAX_TIMEOUT_ENV, "0");
    const m = makeMockChannel();
    const t = startTurn(m.ch);
    await flushSetup();
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(t.outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1 * MIN);
    const err = t.error as TurnTimeoutError;
    expect(err.kind).toBe("idle");
    expect(err.thresholdMs).toBe(ZCODE_TURN_IDLE_TIMEOUT_MS); // 默认 30min
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("非法"))
    ).toBe(true);
  });

  it("默认值锚定：env 未设时 idle=30min、总上界=60min（⛔P-Z0/P-Z1 标定前先验值）", () => {
    expect(ZCODE_TURN_IDLE_TIMEOUT_MS).toBe(30 * MIN);
    expect(ZCODE_TURN_MAX_TIMEOUT_MS).toBe(60 * MIN);
    expect(ZCODE_TURN_IDLE_TIMEOUT_ENV).toBe("TAIJI_ZCODE_TURN_IDLE_TIMEOUT_MS");
    expect(ZCODE_TURN_MAX_TIMEOUT_ENV).toBe("TAIJI_ZCODE_TURN_MAX_TIMEOUT_MS");
  });
});

// ============================================================
// ⑥ 迟到 turn.terminal：只记录不改写已落定结果（D5①/S5 归因放宽）
// ============================================================

describe("⑥ 迟到权威终态只记录不改写（P0-1 D5①/S5）", () => {
  it("final-frame 先落定 → 迟到 turn.terminal(status=error) 记入 lastTerminalStatus，落定结果不被改写", async () => {
    const m = makeMockChannel({ gateRead: true }); // 挂起 read——制造 runTurn 收尾窗口
    const t = startTurn(m.ch);
    await flushSetup();
    m.emitFinalFrame(t.sessionId, "全文"); // 宽松终态先落定（final-frame 恒 success）
    await flushSetup();
    expect(m.requests.some((r) => r.method === "session/read")).toBe(true);
    m.emitTerminal(undefined, "error"); // 权威终态迟到（telemetry 无 sid——真实形态）
    expect(m.readGates).toHaveLength(1);
    m.readGates[0]({ messages: [] }); // 放行 read → runTurn resolve
    await t.promise;
    expect(t.outcome).toBe("fulfilled");
    expect(t.result?.terminal).toEqual({ status: "success", source: "final-frame" }); // 不改写
    expect(t.result?.lastTerminalStatus).toBe("error"); // 只记录
  });

  it("带 sid 的迟到 turn.terminal 同样精确归因到已落定 turn 并记录", async () => {
    const m = makeMockChannel({ gateRead: true });
    const t = startTurn(m.ch);
    await flushSetup();
    m.emitFinalFrame(t.sessionId, "全文");
    await flushSetup();
    m.emitTerminal(t.sessionId, "error"); // 带 sid 形态（归因放宽的精确分支）
    m.readGates[0]({ messages: [] });
    await t.promise;
    expect(t.result?.terminal).toEqual({ status: "success", source: "final-frame" });
    expect(t.result?.lastTerminalStatus).toBe("error");
  });

  it("turn.terminal 先到（权威先落定）：terminal 与 lastTerminalStatus 同值记录", async () => {
    const m = makeMockChannel();
    const t = startTurn(m.ch);
    await flushSetup();
    m.emitTerminal(undefined, "error");
    await t.promise;
    expect(t.result?.terminal).toEqual({ status: "error", source: "turn.terminal" });
    expect(t.result?.lastTerminalStatus).toBe("error");
  });

  it("多在途宁丢勿错不回退：一落定一在途时迟到 terminal 归因到在途 turn，落定者不记录", async () => {
    const m = makeMockChannel({ gateRead: true });
    const t1 = startTurn(m.ch);
    await flushSetup();
    m.emitFinalFrame(t1.sessionId, "全文一"); // t1 落定，read 挂起（在册窗口）
    const t2 = startTurn(m.ch);
    await flushSetup();
    m.emitTerminal(undefined, "success"); // 无 sid：唯一在途 = t2 → 归因 t2
    await flushSetup(); // t2 settle 后的 read 请求在微任务里才发出——先推到位再放行
    expect(m.readGates).toHaveLength(2);
    m.readGates[0]({ messages: [] }); // 放行 t1 的 read
    m.readGates[1]({ messages: [] }); // 放行 t2 的 read（gateRead 对两个 turn 都生效）
    await t1.promise;
    await t2.promise;
    expect(t1.result?.terminal).toEqual({ status: "success", source: "final-frame" });
    expect(t1.result?.lastTerminalStatus).toBeUndefined(); // 多在途宁丢勿错
    expect(t2.result?.terminal).toEqual({ status: "success", source: "turn.terminal" });
  });
});
