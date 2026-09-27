// lifecycle-recover-crashed.test.ts —— recoverCrashedRuns 崩溃恢复四步装配测试（U7/D8/B1）。
//
// 四步序列 = loadAll → failed → save → evict（平移 pi session_start 恢复循环，
// pending:unregister 宿主事件经 hooks 外置）。本文件用真实 WorkflowRun（真实
// 状态机 + I1/I2 不变式）+ mock RunStore（可观察调用序列）。
//
// 覆盖：
// - running 残留 → done,failed（state.error=reason）+ save 落盘 + runs Map 注册
// - 序列：hooks 在 transition 后、save 前（对齐 pi emit 位置）；save 收到的已是终态 run
// - done run 原样保留（不重复 save）但也注册进 runs Map
// - hooks 每 running run 恰好一次、参数 {id, reason:"failed"}；无 hooks 不炸
// - 单 run save 失败不中断其余 run（幂等恢复）；loadAll 失败向上抛
// - onRunRecovered 同步 throw 被围栏捕获（warn 留痕），不中断其余 run 恢复
// - evict 步：超 MAX_RETAINED_DONE_RUNS 的 done run 被淘汰（最旧优先）
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { configureCore, resetCoreForTests } from "../../core/host-services.ts";
import {
  MAX_RETAINED_DONE_RUNS,
  recoverCrashedRuns,
} from "../lifecycle.ts";
import { setRunEventJournalDirForTest } from "../worker-message-pump.ts";
import { createRunEventJournal } from "../run-events.ts";
import { Budget } from "../models/budget.ts";
import type { RunStore } from "../models/ports.ts";
import type { RunSpec } from "../models/run-spec.ts";
import { Trace } from "../models/trace.ts";
import type { DoneReason } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";

// ── helpers ──────────────────────────────────────────────────

function makeSpec(name = "test-wf"): RunSpec {
  return {
    scriptSource: "execute() {}",
    args: {},
    scriptName: name,
    scriptPath: "/fake/test.js",
  };
}

/**
 * 重水合形态构造（对齐 store.loadAll 真实产物：running 快照无 runtime——
 * reconstruct 不恢复 worker，transition 的 releaseRuntime 对 undefined no-op）。
 */
function makeRun(
  runId: string,
  opts: {
    status?: "running" | "done";
    reason?: DoneReason;
    completedAt?: string;
    error?: string;
    scriptName?: string;
  } = {},
): WorkflowRun {
  const status = opts.status ?? "running";
  const state = {
    status,
    ...(status === "done"
      ? { reason: opts.reason ?? "completed" }
      : {}),
    budget: new Budget({ maxTokens: 1000 }),
    calls: new Map(),
    trace: new Trace(),
    errorLogs: [],
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  };
  const meta = {
    startedAt: "2026-08-30T00:00:00.000Z",
    ...(opts.completedAt !== undefined ? { completedAt: opts.completedAt } : {}),
  };
  return WorkflowRun.reconstruct(runId, makeSpec(opts.scriptName), state, meta);
}

/** mock RunStore：loadAll 返回预置 runs，save 可观察（可注入失败）。 */
function makeStore(loaded: WorkflowRun[], opts: { failSaveFor?: string } = {}) {
  const saves: WorkflowRun[] = [];
  const store: RunStore = {
    loadAll: vi.fn(async () => loaded),
    save: vi.fn(async (run: WorkflowRun) => {
      if (opts.failSaveFor !== undefined && run.runId === opts.failSaveFor) {
        throw new Error("disk full");
      }
      saves.push(run);
    }),
    stateFilePath: vi.fn((runId: string) => `/fake/workflow-state/${runId}.jsonl`),
  };
  return { store, saves, saveSpy: store.save as ReturnType<typeof vi.fn> };
}

// ── 四步序列：failed 转换 + save + 注册 ─────────────────────

describe("recoverCrashedRuns — 四步序列（loadAll→failed→save→evict）", () => {
  it("running 残留转 done,failed：state.error=reason + save 落盘 + 注册进 runs Map", async () => {
    const running = makeRun("wf-1", { status: "running" });
    const done = makeRun("wf-2", { status: "done", reason: "completed", completedAt: "2026-08-30T01:00:00.000Z" });
    const { store, saves } = makeStore([running, done]);
    const runs = new Map<string, WorkflowRun>();

    const result = await recoverCrashedRuns(store, runs, "Process killed (kill-9 or crash recovery)");

    // 返回计数口径：loaded 含 done 历史快照，recovered 只计 running→failed 转换
    expect(result.loaded).toBe(2);
    expect(result.recovered).toBe(1);

    // 步骤 2：running → done,failed（I2：done 必有 reason）
    expect(running.state.status).toBe("done");
    expect(running.state.reason).toBe("failed");
    expect(running.state.error).toBe("Process killed (kill-9 or crash recovery)");
    expect(running.meta.completedAt).toBeDefined();
    // done run 原样（未被二次转换）
    expect(done.state.status).toBe("done");
    expect(done.state.reason).toBe("completed");
    expect(done.state.error).toBeUndefined();
    // 步骤 3：仅转换的 run 落盘（done 不重复 save）
    expect(saves).toHaveLength(1);
    expect(saves[0].runId).toBe("wf-1");
    // 全部 loaded run（含 done）注册进 runs Map
    expect(runs.size).toBe(2);
    expect(runs.get("wf-1")).toBe(running);
    expect(runs.get("wf-2")).toBe(done);
  });

  it("序列：hooks 回调在 transition 后、save 前；save 收到的已是终态 run", async () => {
    const run = makeRun("wf-seq", { status: "running" });
    const calls: string[] = [];
    const statusesAtSave: Array<string | undefined> = [];
    const store: RunStore = {
      loadAll: vi.fn(async () => [run]),
      save: vi.fn(async (r: WorkflowRun) => {
        calls.push(`save:${r.runId}`);
        statusesAtSave.push(r.state.status);
      }),
      stateFilePath: vi.fn(() => "/fake"),
    };

    await recoverCrashedRuns(store, new Map(), "crashed", {
      onRunRecovered: (payload) => calls.push(`hook:${payload.id}`),
    });

    // hook 先于 save（对齐 pi：emit 在 transition 后、save 前）
    expect(calls).toEqual(["hook:wf-seq", "save:wf-seq"]);
    // save 收到的 run 已是 done,failed（终态落盘语义）
    expect(statusesAtSave).toEqual(["done"]);
  });

  it("多个 running run 全部恢复；hooks 每个恰好一次、参数 {id, reason:'failed'}", async () => {
    const r1 = makeRun("wf-a", { status: "running" });
    const r2 = makeRun("wf-b", { status: "running" });
    const { store, saves } = makeStore([r1, r2]);
    const hookPayloads: Array<{ id: string; reason: string }> = [];

    await recoverCrashedRuns(store, new Map(), "test crash", {
      onRunRecovered: (payload) => hookPayloads.push(payload),
    });

    expect(r1.state.status).toBe("done");
    expect(r2.state.status).toBe("done");
    expect(saves).toHaveLength(2);
    expect(hookPayloads).toEqual([
      { id: "wf-a", reason: "failed" },
      { id: "wf-b", reason: "failed" },
    ]);
  });

  it("无 hooks（缺省）不炸，恢复语义不受影响", async () => {
    const run = makeRun("wf-nohooks", { status: "running" });
    const { store, saves } = makeStore([run]);

    await recoverCrashedRuns(store, new Map(), "crashed");

    expect(run.state.status).toBe("done");
    expect(saves).toHaveLength(1);
  });

  it("单 run save 失败不中断其余 run（warn + 继续恢复）", async () => {
    const r1 = makeRun("wf-fail", { status: "running" });
    const r2 = makeRun("wf-ok", { status: "running" });
    const { store, saves } = makeStore([r1, r2], { failSaveFor: "wf-fail" });

    await expect(
      recoverCrashedRuns(store, new Map(), "crashed"),
    ).resolves.toEqual({ loaded: 2, recovered: 2 });

    // 失败 run 状态机转换已发生（内存终态），仅落盘失败
    expect(r1.state.status).toBe("done");
    expect(r2.state.status).toBe("done");
    expect(saves.map((r) => r.runId)).toEqual(["wf-ok"]);
  });

  it("onRunRecovered 同步 throw 被围栏捕获（warn 留痕），不中断其余 run 恢复", async () => {
    // warn 断言经宿主 log 端口 spy 捕获（logger facade 每次调用动态解析宿主实现，
    // 对齐 file-run-store.test.ts 的配置态隔离模式）
    resetCoreForTests();
    const logSpy = vi.fn();
    configureCore({ dataRoot: () => "/fake", log: logSpy });

    const r1 = makeRun("wf-hook-throw", { status: "running" });
    const r2 = makeRun("wf-after-throw", { status: "running" });
    const { store, saves } = makeStore([r1, r2]);
    const seen: string[] = [];

    await expect(
      recoverCrashedRuns(store, new Map(), "crashed", {
        onRunRecovered: (payload) => {
          seen.push(payload.id);
          if (payload.id === "wf-hook-throw") {
            throw new Error("host notification channel down");
          }
        },
      }),
    ).resolves.toEqual({ loaded: 2, recovered: 2 });

    // 循环未中断：后续 run 的 hook 仍被调用；两 run 状态机转换 + 落盘照常
    //（含 throw 的 r1——围栏包住整个迭代的宿主事件点，save 不受牵连）
    expect(seen).toEqual(["wf-hook-throw", "wf-after-throw"]);
    expect(r1.state.status).toBe("done");
    expect(r2.state.status).toBe("done");
    expect(saves.map((r) => r.runId)).toEqual(["wf-hook-throw", "wf-after-throw"]);
    // 围栏可见性：warn 已发出且定位到出错的 run
    expect(
      logSpy.mock.calls.some(
        (c) => c[0] === "warn" && String(c[2]).includes("wf-hook-throw"),
      ),
    ).toBe(true);

    resetCoreForTests();
  });

  it("loadAll 失败向上抛（fail-fast 策归宿主决定）", async () => {
    const store: RunStore = {
      loadAll: vi.fn(async () => {
        throw new Error("store corrupted");
      }),
      save: vi.fn(async () => {}),
      stateFilePath: vi.fn(() => "/fake"),
    };

    await expect(
      recoverCrashedRuns(store, new Map(), "crashed"),
    ).rejects.toThrow("store corrupted");
  });
});

// ── 步骤 4：evict（done run 内存有界性） ────────────────────

describe("recoverCrashedRuns — evict 步", () => {
  it("done run 超 MAX_RETAINED_DONE_RUNS 时淘汰最旧；恢复 run（completedAt 最新）必保留", async () => {
    // cap=20：造 22 个 done（completedAt 各异）+ 1 个 running（恢复后 completedAt=当下最新）
    const loaded: WorkflowRun[] = [];
    for (let i = 0; i < MAX_RETAINED_DONE_RUNS + 2; i++) {
      loaded.push(
        makeRun(`wf-old-${i}`, {
          status: "done",
          reason: "completed",
          // ISO 字典序=时间序：i 越小越旧
          completedAt: `2026-08-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        }),
      );
    }
    const running = makeRun("wf-recovered", { status: "running" });
    loaded.push(running);
    const { store } = makeStore(loaded);
    const runs = new Map<string, WorkflowRun>();

    await recoverCrashedRuns(store, runs, "crashed");

    // 23 个 done（22 + 1 恢复）裁到 K=20：最旧 3 个被淘汰
    expect(runs.size).toBe(MAX_RETAINED_DONE_RUNS);
    expect(runs.has("wf-old-0")).toBe(false);
    expect(runs.has("wf-old-1")).toBe(false);
    expect(runs.has("wf-old-2")).toBe(false);
    expect(runs.has("wf-old-3")).toBe(true);
    // 恢复转换的 run completedAt 为 transition 时刻（全局最新）必在保留端
    expect(runs.has("wf-recovered")).toBe(true);
    expect(runs.get("wf-recovered")).toBe(running);
  });

  it("未超 cap 时 evict 为 no-op（全部保留）", async () => {
    const loaded = [
      makeRun("wf-d1", { status: "done", reason: "completed", completedAt: "2026-08-01T00:00:00.000Z" }),
      makeRun("wf-r1", { status: "running" }),
    ];
    const { store } = makeStore(loaded);
    const runs = new Map<string, WorkflowRun>();

    await recoverCrashedRuns(store, runs, "crashed");

    expect(runs.size).toBe(2);
  });
});


// ── [W1 / D4] journal 收编接驳（杀进程恢复链的 core 侧半边）─────────────────
//
// recoverCrashedRuns 对 running 遗留 run 先走 dispatchFinalRunSettle（journal
// run-settled 帧 + manifest 物化，与活体终局同一 dispatch 链）再 state 快照直改
// ——证据落点对称（此前旁路直改 state、journal 永缺终局帧）。kill-9 完整
// fixture 断言（含条目恰一条）在 u1-shell 批闭环，本段锁 core 侧接驳行为。

describe("recoverCrashedRuns — journal 收编接驳（W1 / D4）", () => {
  it("recovered run 的 journal 尾部追加 run-settled(failed) + manifest 物化 + hooks.appendSettledEntry 恰一次", async () => {
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-recover-adopt-"));
    setRunEventJournalDirForTest(journalDir);
    try {
      // 预置 kill-9 形态 journal：run-created + ask-dispatched 落账后进程死亡
      const journal = createRunEventJournal(journalDir);
      await journal.append("wf-adopt-1", {
        type: "run-created",
        runId: "wf-adopt-1",
        workflowName: "test-wf",
        argsSummary: "{}",
        ts: Date.now(),
      });
      await journal.append("wf-adopt-1", {
        type: "ask-dispatched",
        taskIndex: 0,
        agentName: "a",
        attempt: 1,
        ts: Date.now(),
      });

      const run = makeRun("wf-adopt-1", { status: "running" });
      const { store } = makeStore([run]);
      const appended: Array<{ customType: string; data: unknown }> = [];
      const result = await recoverCrashedRuns(store, new Map(), "Process killed", {
        appendSettledEntry: (customType, data) => appended.push({ customType, data }),
        // [W1 / D4 收编定界] 本用例锁定 v2 实体收编路径——注入 v2 定界命中
        isV2RegisteredEntry: () => true,
      });

      expect(result.recovered).toBe(1);
      // journal 尾部有收编 run-settled（interrupted 终局的 failed 形态，reason 承载
      // kill 文本——「收编 run-settled(interrupted)」的 outcome 维 = failed）
      const events = await createRunEventJournal(journalDir).scan("wf-adopt-1");
      expect(events.map((e) => e.type)).toEqual(["run-created", "ask-dispatched", "run-settled"]);
      const settled = events[2] as Extract<
        import("../run-events.ts").WorkflowRunEvent,
        { type: "run-settled" }
      >;
      expect(settled.outcome).toBe("failed");
      expect(settled.reason).toBe("Process killed");
      // manifest 物化（writeRunTerminalManifest 经 dispatch 链的 appendTransition）
      expect(
        fs.existsSync(path.join(journalDir, "wf-adopt-1.json")),
      ).toBe(true);
      // 条目补写回调恰一次（v2 settled 形态）
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({
        customType: "workflow-record",
        data: expect.objectContaining({ v: 2, kind: "settled", runId: "wf-adopt-1" }),
      });
    } finally {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("双重启幂等：二次恢复时 run 已 done（loadAll 产物终态）→ 不再 dispatch，journal 帧数不增长", async () => {
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-recover-twice-"));
    setRunEventJournalDirForTest(journalDir);
    try {
      // 第一次 kill-9：预置静止 journal 后收编（run-settled 落账恰一帧）
      const journal = createRunEventJournal(journalDir);
      await journal.append("wf-adopt-2", {
        type: "run-created",
        runId: "wf-adopt-2",
        workflowName: "test-wf",
        argsSummary: "{}",
        ts: Date.now(),
      });
      const run = makeRun("wf-adopt-2", { status: "running" });
      const firstStore = makeStore([run]);
      await recoverCrashedRuns(firstStore.store, new Map(), "Process killed", {
        // [W1 / D4 收编定界] v2 收编路径锁定用例——注入 v2 定界命中
        isV2RegisteredEntry: () => true,
      });
      expect(
        (await createRunEventJournal(journalDir).scan("wf-adopt-2")).filter(
          (e) => e.type === "run-settled",
        ),
      ).toHaveLength(1);

      // 「重启」：重水合产物已 done,failed（state 快照已收敛）——恢复循环不进
      // running 分支，journal 无新增 run-settled
      const reloaded = makeRun("wf-adopt-2", {
        status: "done",
        reason: "failed",
        completedAt: "2026-08-30T02:00:00.000Z",
      });
      const secondStore = makeStore([reloaded]);
      const result = await recoverCrashedRuns(secondStore.store, new Map(), "Process killed");
      expect(result.recovered).toBe(0);

      const events = await createRunEventJournal(journalDir).scan("wf-adopt-2");
      expect(events.filter((e) => e.type === "run-settled")).toHaveLength(1);
    } finally {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  // [W1 / D4 收编定界分流] 设计 §3.3 D4：v1 快照条目实体（未定界为 v2）走 W1 前
  // 旁路直改兼容层——不落 journal / manifest / 条目（D7「旧会话行为完全不变」）。
  it("v1 实体（定界未命中）走兼容旧分支：state 直改 done,failed，journal/条目零写入", async () => {
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-recover-v1-"));
    setRunEventJournalDirForTest(journalDir);
    try {
      // 预置静止 journal（模拟 P1b-1~W1 间有 journal 的存量 v1 run——未定界为 v2）
      const journal = createRunEventJournal(journalDir);
      await journal.append("wf-v1-1", {
        type: "run-created",
        runId: "wf-v1-1",
        workflowName: "test-wf",
        argsSummary: "{}",
        ts: Date.now(),
      });
      await journal.append("wf-v1-1", {
        type: "ask-dispatched",
        taskIndex: 0,
        agentName: "a",
        attempt: 1,
        ts: Date.now(),
      });

      const run = makeRun("wf-v1-1", { status: "running" });
      const { store, saves } = makeStore([run]);
      const appended: Array<{ customType: string; data: unknown }> = [];
      const result = await recoverCrashedRuns(store, new Map(), "Process killed", {
        appendSettledEntry: (customType, data) => appended.push({ customType, data }),
        isV2RegisteredEntry: () => false,
      });

      expect(result.recovered).toBe(1);
      // state 旁路直改（兼容层语义不变）
      expect(run.state.status).toBe("done");
      expect(run.state.reason).toBe("failed");
      expect(run.state.error).toBe("Process killed");
      expect(saves).toHaveLength(1);
      // journal 零新增帧（无 run-settled 收编帧）、条目零回调（无 v2 孤儿 settled）
      const events = await createRunEventJournal(journalDir).scan("wf-v1-1");
      expect(events.map((e) => e.type)).toEqual(["run-created", "ask-dispatched"]);
      expect(appended).toHaveLength(0);
    } finally {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
