// file-run-store-throttle.test.ts —— FileRunStore save 节流（OR-5 单 run 快照 O(n²) 修复 ⑥a）。
//
// 语义锁定：
// - running 中间态：同一 runId 两次落盘间隔 < saveMinIntervalMs → 跳过 append
//   （高频 save 落盘次数有界 = ceil(run 时长 / 间隔)）；
// - 首写永不节流（新 run 至少一条快照，loadAll 可发现）；
// - 终态（done）永不节流（最终状态必落盘，节流窗口内到达也不丢）；
// - runId 之间互不影响；saveMinIntervalMs=0 = 禁用节流；
// - 默认间隔 DEFAULT_SAVE_MIN_INTERVAL_MS = 60s。
//
// 时间推进用 vitest fake timers（默认 fake Date.now——save 节流判据的时间源）；
// fs 真实 IO 不受 fake timers 影响。

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureCore, resetCoreForTests, type HostServices } from "../../core/host-services.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import { DEFAULT_SAVE_MIN_INTERVAL_MS, FileRunStore } from "../file-run-store.ts";

let dataRoot: string;

beforeEach(() => {
  resetCoreForTests();
  dataRoot = mkdtempSync(join(tmpdir(), "file-run-store-throttle-"));
  const host: HostServices = {
    dataRoot: () => dataRoot,
    log: () => {},
  };
  configureCore(host);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetCoreForTests();
  rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 构造可持久化的 WorkflowRun（对齐 file-run-store.test.ts makeRun 模式）。 */
function makeRun(runId: string, status: "running" | "done" = "running"): WorkflowRun {
  return WorkflowRun.reconstruct(
    runId,
    {
      scriptSource: "export function execute() { return 'ok'; }",
      args: { topic: "demo" },
      scriptName: "test-script",
      scriptPath: "/fake/test.js",
      parameters: { type: "object" },
      budgetTokens: 1000,
    },
    {
      status,
      ...(status === "done" ? { reason: "completed" as const } : {}),
      budget: new Budget({ maxTokens: 1000, usedTokens: 1, usedCost: 0, totalCallCount: 1 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: "2026-09-01T00:00:00.000Z" },
  );
}

/** 某 runId 的 state 文件行数 = 实际落盘快照次数。 */
function snapshotLineCount(runId: string): number {
  const content = readFileSync(join(dataRoot, "workflow-state", `${runId}.jsonl`), "utf8");
  return content.split("\n").filter((l) => l.trim() !== "").length;
}

describe("FileRunStore save 节流（OR-5 ⑥a）", () => {
  it("高频 running save：节流窗口内只落盘 1 次（落盘次数有界）", async () => {
    const store = new FileRunStore({ saveMinIntervalMs: 1000 });
    const run = makeRun("wf-throttle-1");

    for (let i = 0; i < 10; i++) {
      await store.save(run); // 不推进时间——全部命中节流窗口
    }
    expect(snapshotLineCount("wf-throttle-1")).toBe(1);
  });

  it("窗口过期后恢复落盘：次数 = 窗口数 + 1（首写）", async () => {
    const store = new FileRunStore({ saveMinIntervalMs: 1000 });
    const run = makeRun("wf-throttle-2");

    await store.save(run); // 首写（窗口 0 时刻）
    vi.advanceTimersByTime(600);
    await store.save(run); // 窗口内：跳过
    vi.advanceTimersByTime(400); // 累计 1000ms = 窗口到期
    await store.save(run); // 落盘第 2 行
    vi.advanceTimersByTime(999);
    await store.save(run); // 差 1ms：跳过
    expect(snapshotLineCount("wf-throttle-2")).toBe(2);

    vi.advanceTimersByTime(1);
    await store.save(run); // 恰好到期：落盘第 3 行
    expect(snapshotLineCount("wf-throttle-2")).toBe(3);
  });

  it("终态强制落盘：节流窗口内到达的 done 不被跳过，loadAll 恢复最终状态", async () => {
    const store = new FileRunStore({ saveMinIntervalMs: 1000 });
    const runId = "wf-throttle-3";

    await store.save(makeRun(runId, "running"));
    vi.advanceTimersByTime(100);
    await store.save(makeRun(runId, "running")); // 窗口内：跳过
    expect(snapshotLineCount(runId)).toBe(1);

    // 同 runId 终态到达（不推进时间——永不节流）
    await store.save(makeRun(runId, "done"));
    expect(snapshotLineCount(runId)).toBe(2);

    const runs = await store.loadAll();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state.status).toBe("done");
    expect(runs[0]?.state.reason).toBe("completed");
  });

  it("首写永不节流：新 runId 第一次 save 必落盘（loadAll 可发现）", async () => {
    const store = new FileRunStore({ saveMinIntervalMs: 1000 });

    await store.save(makeRun("wf-throttle-4"));
    const runs = await store.loadAll();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("wf-throttle-4");
  });

  it("runId 互不影响：runA 节流窗口内 runB 正常落盘", async () => {
    const store = new FileRunStore({ saveMinIntervalMs: 1000 });

    await store.save(makeRun("wf-throttle-a"));
    await store.save(makeRun("wf-throttle-b"));
    await store.save(makeRun("wf-throttle-a")); // A 窗口内跳过
    await store.save(makeRun("wf-throttle-b")); // B 窗口内跳过

    expect(snapshotLineCount("wf-throttle-a")).toBe(1);
    expect(snapshotLineCount("wf-throttle-b")).toBe(1);
  });

  it("saveMinIntervalMs=0 禁用节流：每次 save 都落盘", async () => {
    const store = new FileRunStore({ saveMinIntervalMs: 0 });
    const run = makeRun("wf-throttle-5");

    for (let i = 0; i < 3; i++) {
      await store.save(run);
    }
    expect(snapshotLineCount("wf-throttle-5")).toBe(3);
  });

  it("默认构造：间隔 = DEFAULT_SAVE_MIN_INTERVAL_MS（60s）", async () => {
    expect(DEFAULT_SAVE_MIN_INTERVAL_MS).toBe(60_000);
    const store = new FileRunStore(); // 缺省构造即生产形态
    const run = makeRun("wf-throttle-6");

    await store.save(run);
    vi.advanceTimersByTime(DEFAULT_SAVE_MIN_INTERVAL_MS - 1);
    await store.save(run);
    expect(snapshotLineCount("wf-throttle-6")).toBe(1);

    vi.advanceTimersByTime(1);
    await store.save(run);
    expect(snapshotLineCount("wf-throttle-6")).toBe(2);
  });
});
