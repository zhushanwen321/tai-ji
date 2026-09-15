// src/__tests__/jsonl-run-store-throttle.test.ts
//
// workflow-record entry append 节流（[B-1]，语义对齐 core FileRunStore.save 的
// OR-5 ⑥a 节流）。
//
// 锁定的语义：
// - running 中间态：同一 runId 两次 entry append 间隔 < entryAppendMinIntervalMs
//   → 跳过 append（pi session JSONL append-only，节流前每次 flush 全量 append
//   累积单 run O(n²) 磁盘——高频 flush 落 entry 次数有界）；
// - 首 append 永不节流（新 run 至少一条 entry，loadAll 可发现）；
// - 终态（done）永不节流：节流窗口内到达的终态 flush 照常 append，loadAll
//   （entry 重建通路）恢复最终状态不丢；
// - state 文件 writeFile 不节流（每次 flush 照写最新快照——rewrite mode 覆盖写
//   无累积，本文件不重复断言其频率）；
// - entryAppendMinIntervalMs=0 = 禁用节流；
// - 默认间隔 = core DEFAULT_SAVE_MIN_INTERVAL_MS（60s，两实现面单源）。
//
// 时间推进用 vitest fake timers（默认 fake Date.now——节流判据的时间源）；
// flush 经 flushPendingSaves() 直发（绕开去抖 timer，不受 fake timers 推进约束），
// fs 真实 IO 不受 fake timers 影响。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SAVE_MIN_INTERVAL_MS } from "@zhushanwen/subagent-core/orchestration/file-run-store.ts";
import { Budget } from "@zhushanwen/subagent-core/orchestration/models/budget.ts";
import { Trace } from "@zhushanwen/subagent-core/orchestration/models/trace.ts";
import type { RunSpec } from "@zhushanwen/subagent-core/orchestration/models/run-spec.ts";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import { WorkflowRun } from "@zhushanwen/subagent-core/orchestration/models/workflow-run.ts";
import { mkCtx, mkPi } from "@zhushanwen/subagent-core/orchestration/__tests__/test-mocks.ts";
import { JsonlRunStore, WORKFLOW_RECORD_CUSTOM_TYPE } from "../jsonl-run-store.ts";

function makeSpec(): RunSpec {
  return {
    scriptSource: "module.exports = async () => {};",
    args: {},
    scriptName: "test-script",
    scriptPath: "/tmp/test.js",
    description: "test",
  };
}

function makeRun(runId: string, status: "running" | "done" = "running"): WorkflowRun {
  return WorkflowRun.reconstruct(
    runId,
    makeSpec(),
    {
      status,
      // done 快照缺 reason 触发 WorkflowRun I2 不变式错误（codec 拒收）——终态必带
      ...(status === "done" ? { reason: "completed" as const } : {}),
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
}

/** pi session JSONL 中的 workflow-record entry 数 = 实际 append 次数。 */
function recordEntryCount(entries: CustomEntry[]): number {
  return entries.filter((e) => e.type === "custom" && e.customType === WORKFLOW_RECORD_CUSTOM_TYPE).length;
}

describe("JsonlRunStore workflow-record entry append 节流（[B-1]）", () => {
  let tmpDir: string;
  let entries: CustomEntry[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-run-store-throttle-"));
    entries = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("高频 running flush：节流窗口内只 append 1 次（次数有界，state 文件照写）", async () => {
    const store = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mkPi(entries),
      ctx: mkCtx(entries),
      entryAppendMinIntervalMs: 1000,
    });
    const run = makeRun("wf-throttle-1");

    await store.save(run); // 冷路径首写：append #1（首 append 永不节流）
    // 热路径 save 的 Promise 由 flush settle——不 await save 本身（先 await 会死锁在
    // 「等 flush 才 settle」的批 Promise 上），flush 后统一 await（对齐 W2TC6 模式）
    for (let i = 0; i < 10; i++) {
      const p = store.save(run); // 热路径入去抖批
      await store.flushPendingSaves(); // 直发 flush——不推进时间，全部命中节流窗口
      await p;
    }
    expect(recordEntryCount(entries)).toBe(1);

    // 窗口过期后恢复 append：第 2 条
    vi.advanceTimersByTime(1000);
    const p2 = store.save(run);
    await store.flushPendingSaves();
    await p2;
    expect(recordEntryCount(entries)).toBe(2);
  });

  it("终态强制 append：节流窗口内到达的 done 照常 append，loadAll 从 entry 恢复终态", async () => {
    const store = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mkPi(entries),
      ctx: mkCtx(entries),
      entryAppendMinIntervalMs: 1000,
    });
    const runId = "wf-throttle-2";

    await store.save(makeRun(runId, "running")); // append #1
    vi.advanceTimersByTime(100);
    const pHot = store.save(makeRun(runId, "running"));
    await store.flushPendingSaves(); // 窗口内：跳过 append
    await pHot;
    expect(recordEntryCount(entries)).toBe(1);

    // 同 runId 终态到达（不推进时间——永不节流）
    await store.save(makeRun(runId, "done"));
    expect(recordEntryCount(entries)).toBe(2);

    // loadAll 优先从 workflow-record entry 重建——终态不丢
    const runs = await store.loadAll();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe(runId);
    expect(runs[0]?.state.status).toBe("done");
    expect(runs[0]?.state.reason).toBe("completed");
  });

  it("entryAppendMinIntervalMs=0 禁用节流：每次 flush 都 append", async () => {
    const store = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mkPi(entries),
      ctx: mkCtx(entries),
      entryAppendMinIntervalMs: 0,
    });
    const run = makeRun("wf-throttle-3");

    for (let i = 0; i < 3; i++) {
      if (i === 0) {
        await store.save(run); // 冷路径首写（同步 flush）
        continue;
      }
      const p = store.save(run); // 热路径
      await store.flushPendingSaves();
      await p;
    }
    expect(recordEntryCount(entries)).toBe(3);
  });

  it("默认构造：间隔 = DEFAULT_SAVE_MIN_INTERVAL_MS（60s，core 单源常量）", async () => {
    expect(DEFAULT_SAVE_MIN_INTERVAL_MS).toBe(60_000);
    const store = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mkPi(entries),
      ctx: mkCtx(entries),
    });
    const run = makeRun("wf-throttle-4");

    await store.save(run); // append #1
    vi.advanceTimersByTime(DEFAULT_SAVE_MIN_INTERVAL_MS - 1);
    const pHot = store.save(run);
    await store.flushPendingSaves(); // 差 1ms：跳过
    await pHot;
    expect(recordEntryCount(entries)).toBe(1);

    vi.advanceTimersByTime(1);
    const pNext = store.save(run);
    await store.flushPendingSaves(); // 恰好到期：append #2
    await pNext;
    expect(recordEntryCount(entries)).toBe(2);
  });

  it("runId 互不影响：runA 节流窗口内 runB 正常 append", async () => {
    const store = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mkPi(entries),
      ctx: mkCtx(entries),
      entryAppendMinIntervalMs: 1000,
    });

    await store.save(makeRun("wf-throttle-a"));
    await store.save(makeRun("wf-throttle-b")); // B 首 append 永不节流
    const pA = store.save(makeRun("wf-throttle-a")); // A 窗口内跳过
    const pB = store.save(makeRun("wf-throttle-b")); // B 窗口内跳过
    await store.flushPendingSaves();
    await Promise.all([pA, pB]);

    // A/B 各 1 条 = 2 条 total（A 第 2 次与 B 第 2 次均被各自窗口拦下）
    expect(recordEntryCount(entries)).toBe(2);
  });
});
