// workflow-events-run-settled.test.ts —— runSettledEffects（onRunDone 四步终局
// 副作用管线）直测。
//
// 管线原是 makeDeps 闭包内嵌策略（顺序固化无独立测试面），提级具名导出后在此
// 直测：不挂 fake pi 全装配、不挂 index.ts、不 mock 兄弟功能模块（notifyDone /
// trackNotifiedRunId / evictDoneRunsBeyondCap 均真实实现）——只注入 fake env
// （stallWatchdog 转发 / 最小发送面 pi / 真 Set / 真 runs Map）。
//
// 四步顺序的可观测钉法：
// - step1（noteRunSettled）与 step2（notifyDone 的 sendMessage）的相对序经
//   步进哨兵数组直接断言；
// - step2 失败（中途失败分支）时 step3（track）与 step4（evict）不发生
//   ——证明 3/4 排在 2 之后；
// - 成功分支断言 step3（notifiedRunIds 纳入）与 step4（runs 淘汰）均已执行
//   ——track 无 throw 面、与 evict 无数据依赖，3↔4 相对序无行为差异（见
//   runSettledEffects 注释「顺序固化」）。
//
// notifyDone 走降级直发路径（ledger 槽未 bind → getBoundNotifyLedger() 为
// undefined）；stale 判定依据 ext-guards STALE_CTX_MARKER 文案子串，测试注入的
// 失败错误消息不含该串 → guardStaleCtx 判非 stale 原样上抛（真实语义）。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerFns } = vi.hoisted(() => ({
  loggerFns: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => loggerFns,
  setPiHandle: vi.fn(),
}));

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_RETAINED_DONE_RUNS } from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import { runSettledEffects, type RunSettledEffectsEnv } from "../workflow-events.ts";

// ── fake 组件 ──────────────────────────────────────────────────────────────────

interface FakeRunShape {
  runId: string;
  status?: string;
  reason?: string;
  startedAt?: string;
  completedAt?: string;
}

/** 最小 WorkflowRun 聚合根（notifyDone 读 trace/spec/scriptResult/calls，
 * evict 读 status/completedAt——与 handler-fences 的 makeFakeRun 同款构造形态）。 */
function makeRun(shape: FakeRunShape): WorkflowRun {
  return {
    runId: shape.runId,
    spec: { scriptName: `script-${shape.runId}` },
    state: {
      status: shape.status ?? "done",
      reason: shape.reason ?? "completed",
      scriptResult: undefined,
      calls: new Map(),
      trace: { toArray: () => [] },
    },
    meta: {
      startedAt: shape.startedAt ?? new Date(0).toISOString(),
      completedAt: shape.completedAt,
    },
  } as unknown as WorkflowRun;
}

function makeCtx(): ExtensionContext {
  // mode 非 "rpc" → isGuiCapable false → notifyDone 不走 __gui__ 载荷分支
  return { mode: "tui", hasUI: false } as unknown as ExtensionContext;
}

interface EnvHarness {
  env: RunSettledEffectsEnv;
  seq: string[];
  notifiedRunIds: Set<string>;
  runs: Map<string, WorkflowRun>;
  sendMessage: ReturnType<typeof vi.fn>;
  failSend: (err: Error) => void;
}

function makeEnv(): EnvHarness {
  const seq: string[] = [];
  const sendMessage = vi.fn(() => {
    seq.push("2:notifyDone(sendMessage)");
    return true;
  });
  const pi = { sendMessage } as unknown as ExtensionAPI;
  const notifiedRunIds = new Set<string>();
  const runs = new Map<string, WorkflowRun>();
  const env: RunSettledEffectsEnv = {
    stallWatchdog: {
      noteRunSettled: (runId) => {
        seq.push(`1:noteRunSettled(${runId})`);
      },
    },
    resolvePi: () => pi,
    notifiedRunIds,
    state: { ctx: makeCtx(), sessionDir: "/tmp/run-settled-test-session", runs },
    lsRef: { lastSessionId: "sess-run-settled" },
  };
  return {
    env,
    seq,
    notifiedRunIds,
    runs,
    sendMessage,
    failSend: (err) => {
      sendMessage.mockImplementation(() => {
        seq.push("2:notifyDone(sendMessage)");
        throw err;
      });
    },
  };
}

/** 预置 keepDone+1 个 done run（含本轮 run 的 completedAt 最新）→ evict 步骤
 * 恰好淘汰最旧 1 个（keepDone 单源 = MAX_RETAINED_DONE_RUNS）。 */
function seedRunsWithCapOverflow(h: EnvHarness, currentRun: WorkflowRun): void {
  h.runs.set(currentRun.runId, currentRun);
  for (let i = 0; i < MAX_RETAINED_DONE_RUNS; i++) {
    const run = makeRun({
      runId: `seed-${i}`,
      // ISO 字典序=时间序：早于本轮（new Date(0) 基线上递增 1ms），seed-0 最旧
      startedAt: new Date(i + 1).toISOString(),
      completedAt: new Date(i + 1).toISOString(),
    });
    h.runs.set(run.runId, run);
  }
}

// ── 用例 ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSettledEffects：四步固定顺序", () => {
  it("noteRunSettled 先于 notifyDone 发送；track 纳入去重窗口；evict 按单源 cap 裁剪最旧 done run", () => {
    const h = makeEnv();
    const run = makeRun({ runId: "wf-current", completedAt: new Date(10_000).toISOString() });
    seedRunsWithCapOverflow(h, run);

    runSettledEffects(h.env, run);

    // step1 < step2（步进哨兵直接断言相对序）
    expect(h.seq.slice(0, 2)).toEqual(["1:noteRunSettled(wf-current)", "2:notifyDone(sendMessage)"]);
    // step3：去重窗口纳入本轮 runId（notifyDone 降级直发受理后 track + 管线幂等 track）
    expect(h.notifiedRunIds.has("wf-current")).toBe(true);
    // step4：done 总数 = cap+1 → 恰淘汰最旧 1 个（seed-0），本轮 run（completedAt 最新）保留
    expect(h.runs.size).toBe(MAX_RETAINED_DONE_RUNS);
    expect(h.runs.has("seed-0")).toBe(false);
    expect(h.runs.has("seed-1")).toBe(true);
    expect(h.runs.has("wf-current")).toBe(true);
    // step4 的日志入参：keep 单源 cap + session 归属现读 lsRef
    expect(loggerFns.debug).toHaveBeenCalledWith("[subagent-workflow] evicted done runs beyond cap", {
      evicted: 1,
      keep: MAX_RETAINED_DONE_RUNS,
      sessionId: "sess-run-settled",
    });
    // 通知发送面参数：customType workflow-result + notifyId 幂等键前缀（真实 notifyDone 语义）
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [message] = h.sendMessage.mock.calls[0] as [
      { customType: string; details: { runId: string; notifyId: string } },
    ];
    expect(message.customType).toBe("workflow-result");
    expect(message.details.runId).toBe("wf-current");
    expect(message.details.notifyId).toBe("wf-done:wf-current");
  });

  it("notifyDone 非 stale 抛错 → 异常原样上抛，后续 track/evict 不执行（无内部围栏）", () => {
    const h = makeEnv();
    const run = makeRun({ runId: "wf-boom", completedAt: new Date(10_000).toISOString() });
    seedRunsWithCapOverflow(h, run);
    const runsSizeBefore = h.runs.size;
    h.failSend(new Error("relay send boom"));

    // 管线不吞错：上抛交由调用方 finalizeRun 的 onRunDone 独立 try 围栏（OR-4/B-4）
    expect(() => runSettledEffects(h.env, run)).toThrowError("relay send boom");

    // step1 已执行（先于失败点），step2 到达且失败
    expect(h.seq).toEqual(["1:noteRunSettled(wf-boom)", "2:notifyDone(sendMessage)"]);
    // step3 未执行：去重窗口不含 runId（notifyDone 降级路径发送失败不标记——重试通道保持）
    expect(h.notifiedRunIds.has("wf-boom")).toBe(false);
    // step4 未执行：runs 原样
    expect(h.runs.size).toBe(runsSizeBefore);
    expect(h.runs.has("seed-0")).toBe(true);
  });

  it("notifyDone 幂等早退（去重窗口已含 runId）不是失败：sendMessage 零调用，收尾步照常执行", () => {
    const h = makeEnv();
    const run = makeRun({ runId: "wf-dup", completedAt: new Date(10_000).toISOString() });
    seedRunsWithCapOverflow(h, run);
    h.notifiedRunIds.add("wf-dup"); // 预置：模拟重复收口

    runSettledEffects(h.env, run);

    // notifyDone 首行去重早退 → 发送面零调用
    expect(h.sendMessage).not.toHaveBeenCalled();
    // step1 / step3（幂等）/ step4 照常执行
    expect(h.seq).toEqual(["1:noteRunSettled(wf-dup)"]);
    expect(h.notifiedRunIds.has("wf-dup")).toBe(true);
    expect(h.runs.size).toBe(MAX_RETAINED_DONE_RUNS);
    expect(h.runs.has("seed-0")).toBe(false);
  });
});
