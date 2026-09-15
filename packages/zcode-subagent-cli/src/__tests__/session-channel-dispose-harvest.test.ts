// session-channel-dispose-harvest.test.ts —— P0-1 U5 dispose 前收割单测（机制层）。
//
// 设计权威源：docs/design/timeout-zcode-turn-and-settled-watchdog.md §3.4（退化路径）、
// §6 D7（dispose 收割兜底）、§11 P-Z3（close 吞没 → dispose 触发 failAllTurns）。
// P-Z3 的「close 事件吞没」在真实子进程形态不可确定性注入（Node child 进程退出后
// stdio 关闭即触发 close 事件）——真实现场归 Gate B；本文件用 mock 连接承载机制层
// 可判定形态：不触发 onClose（= close 吞没的机制等价物）→ dispose → 在途 turn 收敛
// 为明确失败。与 zcode-engine-dispose.test.ts（fake-appserver 子进程集成面）互补。
//
// 覆盖：
//   ① close 吞没形态：dispose 触发 failAllTurns——在途 turn 于 dispose 时收割
//     （P-Z3 核心断言），收割后到达的终态不再改写（settled 守卫）；
//   ② grace 窗口内全部终态化：并发多会话 turn 全量收割，不留永久 pending；
//   ③ 正常 close 主路径零回归：onClose 收割先行 → dispose no-op 不改写收割错误；
//   ④ 终态已落定（成功）后 dispose：settled 守卫不改写已成功结果；
//   ⑤ dispose 收割后 closeSession 短路：runTurn finally 不再发 session/close
//     （防写死进程/惰性重建——D7 收割语义的必要闭环）+ 正常完成对照（发 close）；
//   ⑥ 二次 dispose 幂等。

import { afterEach, describe, expect, it } from "vitest";

import type { AppServerConnection } from "../connection.ts";
import {
  SessionChannel,
  type SessionTurnResult,
  type SessionTurnOptions,
} from "../session-channel.ts";

// ============================================================
// mock 连接 + 驱动器（与 session-channel-turn-timers.test.ts 同形态，
// 增补 onClose handler 的手动触发面——close 吞没注入的机制等价物）
// ============================================================

interface MockChannel {
  ch: SessionChannel;
  /** 我方发出的请求帧流水（method 序可断言）。 */
  requests: Array<{ method: string; params: unknown }>;
  /** 手动触发连接崩溃广播（close 吞没形态 = 不触发；正常形态 = 测试显式触发）。 */
  emitClose: (reason: string) => void;
  emit: (method: string, params: unknown) => void;
  emitTerminal: (sessionId: string | undefined, status: string) => void;
}

let sidSeq = 0;

function makeMockChannel(): MockChannel {
  const notifications = new Map<string, (params: unknown) => void>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const closeHandlers = new Set<(reason: string) => void>();
  const conn = {
    alive: true,
    onNotification: (method: string, h: (params: unknown) => void) => {
      notifications.set(method, h);
      return () => notifications.delete(method);
    },
    onClose: (h: (reason: string) => void) => {
      closeHandlers.add(h);
      return () => closeHandlers.delete(h);
    },
    request: (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "session/create") {
        sidSeq += 1;
        return Promise.resolve({ session: { sessionId: `sess_h${sidSeq}` } });
      }
      if (method === "session/send") return Promise.resolve({ accepted: true });
      if (method === "session/read") return Promise.resolve({ messages: [] });
      return Promise.resolve({});
    },
  } as unknown as AppServerConnection;
  const ch = new SessionChannel(conn);
  return {
    ch,
    requests,
    emitClose: (reason) => {
      for (const fn of [...closeHandlers]) fn(reason);
    },
    emit: (method, params) => notifications.get(method)?.(params),
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
  /** onSessionCreated 回填（getter——回调晚于 tracker 构造，值拷贝会恒空）。 */
  readonly sessionId: string;
}

function startTurn(ch: SessionChannel, opts: SessionTurnOptions = {}): TurnTracker {
  let sessionId = "";
  const promise = ch.runTurn({ workspacePath: "/tmp/ws-harvest", mode: "yolo" }, "任务", {
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
    get sessionId(): string {
      return sessionId;
    },
  };
  void promise.then(
    (r) => {
      t.outcome = "fulfilled";
      t.result = r;
    },
    (e) => {
      t.outcome = "rejected";
      t.error = e;
    },
  );
  return t;
}

/** 排空微任务链（create→subscribe→send 全是已 resolve 的 promise——一拍 setTimeout 足够）。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle(t: TurnTracker): Promise<void> {
  await t.promise.then(
    () => undefined,
    () => undefined,
  );
}

let enginesChannels: SessionChannel[] = [];
afterEach(() => {
  for (const ch of enginesChannels.splice(0)) ch.dispose();
});

// ============================================================
// dispose 收割（P0-1 U5/D7：close 缺失/被吞没的退化路径闭合）
// ============================================================

describe("dispose 收割（P-Z3 机制层：close 吞没 → dispose 触发 failAllTurns）", () => {
  it("close 吞没形态：dispose 时在途 turn 收割为明确失败，迟到终态不再改写", async () => {
    const m = makeMockChannel();
    enginesChannels.push(m.ch);
    const t = startTurn(m.ch);
    await flush();
    expect(t.outcome).toBe("pending"); // send 已发、无终态——在途

    m.ch.dispose(); // close 吞没（onClose 未触发）→ dispose 收割兜底
    await settle(t);

    expect(t.outcome).toBe("rejected");
    const err = t.error as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("已 dispose");
    expect(err.message).toContain("收割");
    expect(err.message).toContain("恢复指引");
    // 收割后到达的权威终态：settled 守卫——落定结果不改写
    m.emitTerminal(t.sessionId, "success");
    expect(t.outcome).toBe("rejected");
    expect((t.error as Error).message).toBe(err.message);
  });

  it("grace 窗口内全部终态化：并发双会话 turn 全量收割，不留永久 pending", async () => {
    const m = makeMockChannel();
    enginesChannels.push(m.ch);
    const t1 = startTurn(m.ch);
    const t2 = startTurn(m.ch);
    await flush();
    expect(t1.sessionId).not.toBe(t2.sessionId); // 双会话确实并发
    expect(t1.outcome).toBe("pending");
    expect(t2.outcome).toBe("pending");

    m.ch.dispose();
    await Promise.all([settle(t1), settle(t2)]);

    expect(t1.outcome).toBe("rejected");
    expect(t2.outcome).toBe("rejected");
    expect((t1.error as Error).message).toContain("已 dispose");
    expect((t2.error as Error).message).toContain("已 dispose");
  });

  it("正常 close 主路径零回归：onClose 收割先行（错误=连接层 reason），dispose no-op 不改写", async () => {
    const m = makeMockChannel();
    enginesChannels.push(m.ch);
    const t = startTurn(m.ch);
    await flush();

    m.emitClose("进程退出（code=0 signal=SIGTERM）"); // onClose 主路径收割（正常 close 到达）
    await settle(t);
    expect(t.outcome).toBe("rejected");
    const onCloseErr = t.error as Error;
    expect(onCloseErr.message).toContain("app-server 进程退出");

    m.ch.dispose(); // activeTurns 已空——幂等 no-op，收割错误不被 dispose 文案改写
    expect(t.outcome).toBe("rejected");
    expect((t.error as Error).message).toBe(onCloseErr.message);
  });

  it("终态已落定（成功）后 dispose：settled 守卫不改写已成功结果", async () => {
    const m = makeMockChannel();
    enginesChannels.push(m.ch);
    const t = startTurn(m.ch);
    await flush();
    m.emitTerminal(t.sessionId, "success");
    await settle(t);
    expect(t.outcome).toBe("fulfilled");

    m.ch.dispose(); // 已成功收尾的 turn 不受 dispose 收割影响
    expect(t.outcome).toBe("fulfilled");
    expect(t.result?.terminal).toEqual({ status: "success", source: "turn.terminal" });
  });

  it("dispose 收割后 closeSession 短路：finally 不发 session/close（防写死进程/惰性重建）；正常完成对照=发 close", async () => {
    const m1 = makeMockChannel();
    enginesChannels.push(m1.ch);
    const t1 = startTurn(m1.ch);
    await flush();
    m1.ch.dispose();
    await settle(t1);
    await flush(); // runTurn finally 的 closeSession 已过
    expect(t1.outcome).toBe("rejected");
    expect(m1.requests.map((r) => r.method)).not.toContain("session/close");

    // 对照：正常完成的 turn，finally 发 session/close（D4 用后即毁——零回归面）
    const m2 = makeMockChannel();
    enginesChannels.push(m2.ch);
    const t2 = startTurn(m2.ch);
    await flush();
    m2.emitTerminal(t2.sessionId, "success");
    await settle(t2);
    expect(t2.outcome).toBe("fulfilled");
    expect(m2.requests.map((r) => r.method)).toContain("session/close");
  });

  it("二次 dispose 幂等：无在途 turn 时 dispose 是 no-op 不抛", async () => {
    const m = makeMockChannel();
    enginesChannels.push(m.ch);
    expect(() => m.ch.dispose()).not.toThrow();
    expect(() => m.ch.dispose()).not.toThrow();
  });
});
