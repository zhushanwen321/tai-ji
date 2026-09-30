// lifecycle-recover-crashed.test.ts —— recoverCrashedRuns 崩溃恢复装配测试（U7/D8/B1
// → workflow-run-resume-revision [D2]/[D15]/[D1] 后形态）。
//
// 三步序列 = loadAll → 中断收编 → evict（[D15] 发起面第三路，经
// terminal-actions.interruptRun 入口；v1 兼容尾段已删除——收编只追加
// run-interrupted 转移事件，不覆盖任何文件）。本文件用真实 WorkflowRun +
// mock RunStore（可观察调用序列）。
//
// 覆盖：
// - running 残留 → run-interrupted 转移事件落 record（[D2] interrupted 暂停态，
//   非 done,failed——崩溃 ≠ 失败，可 resume）+ in-flight call 内存观测面收口 +
//   runs Map 注册
// - 内存观测面不变量：收编后 run.state.status 仍 running（活体写点停更语义——
//   终局判据归 record fold；「进程内持有重水合 running 聚合」与新语义一致）
// - hooks 每 running run 恰好一次、参数 {id, reason:"interrupted"}；无 hooks 不炸
// - onRunRecovered 同步 throw 被围栏捕获（warn 留痕），不中断其余 run 恢复
// - evict 步：超 MAX_RETAINED_DONE_RUNS 的 done run 被淘汰（最旧优先）
// - [D15] v1 尾段删除断言：收编不再调 store.save（无覆盖写——D1 store 单模式
//   后「恢复终态必须持久化」由 record 事件流构造性承载）
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { configureCore, resetCoreForTests } from "../../core/host-services.ts";
import {
  MAX_RETAINED_DONE_RUNS,
  recoverCrashedRuns,
} from "../lifecycle.ts";
import {
  setRunEventJournalDirForTest,
} from "../terminal-actions.ts";
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
    scriptSource: "async function execute() {}",
    args: {},
    scriptName: name,
    scriptPath: "/fake/test.js",
  };
}

/**
 * 重水合形态构造（对齐 store.loadAll 真实产物：running 快照无 runtime——
 * reconstruct 不恢复 worker）。
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

/** mock RunStore：loadAll 返回预置 runs，save 可观察。 */
function makeStore(loaded: WorkflowRun[]) {
  const saves: WorkflowRun[] = [];
  const store: RunStore = {
    loadAll: vi.fn(async () => loaded),
    save: vi.fn(async (run: WorkflowRun) => {
      saves.push(run);
    }),
    stateFilePath: vi.fn((runId: string) => `/fake/workflow-state/${runId}.jsonl`),
  };
  return { store, saves, saveSpy: store.save as ReturnType<typeof vi.fn> };
}

/** 预置 kill-9 形态 record 流基线（run-created + agent-started 落账后进程死亡）。 */
async function seedCrashedRecord(journalDir: string, runId: string, scriptName = "test-wf"): Promise<void> {
  const journal = createRunEventJournal(journalDir);
  await journal.append(runId, {
    type: "run-created",
    runId,
    workflowName: scriptName,
    argsSummary: "{}",
    ts: Date.now(),
  });
  await journal.append(runId, {
    type: "agent-started",
    taskIndex: 0,
    agentName: "a",
    attempt: 1,
    ts: Date.now(),
  });
}

/** mkdtemp + journal 注入的公共装配（afterEach 由调用方收尾）。 */
function useJournalDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  setRunEventJournalDirForTest(dir);
  return dir;
}

// ── 三步序列：中断收编 + 注册 ─────────────────────────────────

describe("recoverCrashedRuns — 三步序列（loadAll→中断收编→evict，[D2]/[D15]）", () => {
  it("running 残留：run-interrupted 转移事件落 record（errorCode=crashed）+ runs Map 注册 + 内存观测面 in-flight 收口", async () => {
    const journalDir = useJournalDir("wf-recover-basic-");
    try {
      await seedCrashedRecord(journalDir, "wf-1");
      const running = makeRun("wf-1", { status: "running" });
      const done = makeRun("wf-2", { status: "done", reason: "completed", completedAt: "2026-08-30T01:00:00.000Z" });
      const { store, saves } = makeStore([running, done]);
      const runs = new Map<string, WorkflowRun>();

      const result = await recoverCrashedRuns(store, runs, "Process killed (kill-9 or crash recovery)");

      // 返回计数口径：loaded 含 done 历史，recovered 只计中断收编条数
      expect(result.loaded).toBe(2);
      expect(result.recovered).toBe(1);

      // [D2] record 流：run-interrupted 转移事件（中断非终局——无 run-settled 帧）
      const events = await createRunEventJournal(journalDir).scan("wf-1");
      expect(events.map((e) => e.type)).toEqual(["run-created", "agent-started", "run-interrupted"]);
      const interrupted = events[2] as Extract<
        import("../run-events.ts").WorkflowRunEvent,
        { type: "run-interrupted" }
      >;
      expect(interrupted.errorCode).toBe("crashed"); // [D2] 中断来源标记：崩溃收编
      expect(interrupted.reason).toBe("Process killed (kill-9 or crash recovery)");
      // [D2] 中断非终局：不写 manifest 派生缓存
      expect(fs.existsSync(path.join(journalDir, "wf-1.json"))).toBe(false);
      // 内存观测面：state.error 记录 reason、status 维持 running（活体写点停更——
      // 终局判据归 record fold，重水合聚合保持「未终局」观感）
      expect(running.state.error).toBe("Process killed (kill-9 or crash recovery)");
      expect(running.state.status).toBe("running");
      // done run 原样（不进收编判定）
      expect(done.state.status).toBe("done");
      expect(done.state.reason).toBe("completed");
      // [D15] v1 尾段删除：收编零 store.save（无覆盖写）
      expect(saves).toHaveLength(0);
      // 全部 loaded run（含 done）注册进 runs Map
      expect(runs.size).toBe(2);
      expect(runs.get("wf-1")).toBe(running);
      expect(runs.get("wf-2")).toBe(done);
    } finally {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("多个 running run 全部收编；hooks 每个恰好一次、参数 {id, reason:'interrupted'}", async () => {
    const journalDir = useJournalDir("wf-recover-multi-");
    try {
      await seedCrashedRecord(journalDir, "wf-a");
      await seedCrashedRecord(journalDir, "wf-b");
      const r1 = makeRun("wf-a", { status: "running" });
      const r2 = makeRun("wf-b", { status: "running" });
      const { store } = makeStore([r1, r2]);
      const hookPayloads: Array<{ id: string; reason: string }> = [];

      await recoverCrashedRuns(store, new Map(), "test crash", {
        onRunRecovered: (payload) => hookPayloads.push(payload),
      });

      expect(hookPayloads).toEqual([
        { id: "wf-a", reason: "interrupted" },
        { id: "wf-b", reason: "interrupted" },
      ]);
      // record 流各落 run-interrupted
      for (const runId of ["wf-a", "wf-b"]) {
        const events = await createRunEventJournal(journalDir).scan(runId);
        expect(events.at(-1)?.type).toBe("run-interrupted");
      }
    } finally {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("无 hooks（缺省）不炸，收编语义不受影响", async () => {
    const journalDir = useJournalDir("wf-recover-nohooks-");
    try {
      await seedCrashedRecord(journalDir, "wf-nohooks");
      const run = makeRun("wf-nohooks", { status: "running" });
      const { store } = makeStore([run]);

      const result = await recoverCrashedRuns(store, new Map(), "crashed");
      expect(result.recovered).toBe(1);
    } finally {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("单 run 收编失败（record IO）不中断其余 run（warn + 继续恢复——旁路维护不放大失败）", async () => {
    const journalDir = useJournalDir("wf-recover-iofail-");
    try {
      await seedCrashedRecord(journalDir, "wf-ok");
      // wf-fail 无 record 基线：fold 空流 → interruptRun 表外转移（created ×
      // run-interrupted）→ 让位 false 不计数；wf-ok 照常收编
      const r1 = makeRun("wf-fail", { status: "running" });
      const r2 = makeRun("wf-ok", { status: "running" });
      const { store } = makeStore([r1, r2]);

      const result = await recoverCrashedRuns(store, new Map(), "crashed");
      expect(result.recovered).toBe(1); // 仅 wf-ok
      const events = await createRunEventJournal(journalDir).scan("wf-ok");
      expect(events.at(-1)?.type).toBe("run-interrupted");
    } finally {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("onRunRecovered 同步 throw 被围栏捕获（warn 留痕），不中断其余 run 恢复", async () => {
    resetCoreForTests();
    const logSpy = vi.fn();
    configureCore({ dataRoot: () => "/fake", log: logSpy });
    const journalDir = useJournalDir("wf-recover-hookthrow-");
    try {
      await seedCrashedRecord(journalDir, "wf-hook-throw");
      await seedCrashedRecord(journalDir, "wf-after-throw");
      const r1 = makeRun("wf-hook-throw", { status: "running" });
      const r2 = makeRun("wf-after-throw", { status: "running" });
      const { store } = makeStore([r1, r2]);
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

      // 循环未中断：后续 run 的 hook 仍被调用；两 run 收编照常
      expect(seen).toEqual(["wf-hook-throw", "wf-after-throw"]);
      for (const runId of ["wf-hook-throw", "wf-after-throw"]) {
        const events = await createRunEventJournal(journalDir).scan(runId);
        expect(events.at(-1)?.type).toBe("run-interrupted");
      }
      // 围栏可见性：warn 已发出且定位到出错的 run
      expect(
        logSpy.mock.calls.some(
          (c) => c[0] === "warn" && String(c[2]).includes("wf-hook-throw"),
        ),
      ).toBe(true);
    } finally {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      resetCoreForTests();
    }
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

// ── 步骤 3：evict（done run 内存有界性） ────────────────────

describe("recoverCrashedRuns — evict 步", () => {
  it("done run 超 MAX_RETAINED_DONE_RUNS 时淘汰最旧；恢复 run 必保留", async () => {
    // cap=20：造 22 个 done（completedAt 各异）+ 1 个 running（收编后不入终局集，
    // 恒保留——[D2] 中断非终局，isRunSettled=false 不参与淘汰）
    const journalDir = useJournalDir("wf-recover-evict-");
    try {
      await seedCrashedRecord(journalDir, "wf-recovered");
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

      // 22 个 done 裁到 K=20（最旧 2 个淘汰）；中断 run 非终局不参与淘汰 → 21 个在册
      expect(runs.size).toBe(MAX_RETAINED_DONE_RUNS + 1);
      expect(runs.has("wf-old-0")).toBe(false);
      expect(runs.has("wf-old-1")).toBe(false);
      expect(runs.has("wf-old-2")).toBe(true);
      // 中断 run 恒保留（可 resume——淘汰只作用于终局集）
      expect(runs.has("wf-recovered")).toBe(true);
      expect(runs.get("wf-recovered")).toBe(running);
    } finally {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("未超 cap 时 evict 为 no-op（全部保留）", async () => {
    const journalDir = useJournalDir("wf-recover-evict2-");
    try {
      await seedCrashedRecord(journalDir, "wf-r1");
      const loaded = [
        makeRun("wf-d1", { status: "done", reason: "completed", completedAt: "2026-08-01T00:00:00.000Z" }),
        makeRun("wf-r1", { status: "running" }),
      ];
      const { store } = makeStore(loaded);
      const runs = new Map<string, WorkflowRun>();

      await recoverCrashedRuns(store, runs, "crashed");

      expect(runs.size).toBe(2);
    } finally {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ── [D15] 中断收编接驳（杀进程恢复链的 core 侧半边）─────────────────
//
// recoverCrashedRuns 对 running 遗留 run 走 interruptRun 入口（run-interrupted
// 转移事件 + 中断条目补写通道），零覆盖写。kill-9 完整 fixture 断言（含条目
// 恰一条）在 u4a 场景批闭环，本段锁 core 侧接驳行为。

describe("recoverCrashedRuns — 中断收编接驳（[D15]）", () => {
  it("recovered run 的 record 尾部追加 run-interrupted + 中断条目回调恰一次（status 'interrupted'）", async () => {
    const journalDir = useJournalDir("wf-recover-adopt-");
    try {
      await seedCrashedRecord(journalDir, "wf-adopt-1");

      const run = makeRun("wf-adopt-1", { status: "running" });
      const { store } = makeStore([run]);
      const appended: Array<{ customType: string; data: unknown }> = [];
      const result = await recoverCrashedRuns(store, new Map(), "Process killed", {
        appendSettledEntry: (customType, data) => appended.push({ customType, data }),
      });

      expect(result.recovered).toBe(1);
      // record 尾部有收编 run-interrupted（[D2] 中断转移——非 run-settled 终态帧）
      const events = await createRunEventJournal(journalDir).scan("wf-adopt-1");
      expect(events.map((e) => e.type)).toEqual(["run-created", "agent-started", "run-interrupted"]);
      const interrupted = events[2] as Extract<
        import("../run-events.ts").WorkflowRunEvent,
        { type: "run-interrupted" }
      >;
      expect(interrupted.errorCode).toBe("crashed");
      expect(interrupted.reason).toBe("Process killed");
      // [D2] 中断非终局：零 manifest 物化
      expect(fs.existsSync(path.join(journalDir, "wf-adopt-1.json"))).toBe(false);
      // 中断条目补写回调恰一次（v2 interrupted 形态——status 暂停态收敛词）
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({
        customType: "workflow-record",
        data: expect.objectContaining({ v: 2, kind: "settled", runId: "wf-adopt-1", status: "interrupted" }),
      });
    } finally {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("双重启幂等：二次恢复时 run 已 done（loadAll 产物终态）→ 不再 dispatch，record 帧数不增长", async () => {
    const journalDir = useJournalDir("wf-recover-twice-");
    try {
      // 第一次 kill-9：预置静止 record 后收编（run-interrupted 落账恰一帧）
      await seedCrashedRecord(journalDir, "wf-adopt-2");
      const run = makeRun("wf-adopt-2", { status: "running" });
      const firstStore = makeStore([run]);
      await recoverCrashedRuns(firstStore.store, new Map(), "Process killed");
      expect(
        (await createRunEventJournal(journalDir).scan("wf-adopt-2")).filter(
          (e) => e.type === "run-interrupted",
        ),
      ).toHaveLength(1);

      // 「重启」：重水合产物已 done,failed——恢复循环不进 running 分支，record 无新增
      const reloaded = makeRun("wf-adopt-2", {
        status: "done",
        reason: "failed",
        completedAt: "2026-08-30T02:00:00.000Z",
      });
      const secondStore = makeStore([reloaded]);
      const result = await recoverCrashedRuns(secondStore.store, new Map(), "Process killed");
      expect(result.recovered).toBe(0);

      const events = await createRunEventJournal(journalDir).scan("wf-adopt-2");
      expect(events.filter((e) => e.type === "run-interrupted")).toHaveLength(1);
    } finally {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("重复收编幂等（二次恢复同一 running 聚合）：fold 已 interrupted → 让位不重复追加", async () => {
    const journalDir = useJournalDir("wf-recover-idem-");
    try {
      await seedCrashedRecord(journalDir, "wf-adopt-3");
      const run = makeRun("wf-adopt-3", { status: "running" });
      // 两次恢复循环都拿到 running 聚合（模拟外部再收编竞窗——loadAll 侧条目
      // 抑制在壳层，core 侧幂等由入口两道承接）
      const first = await recoverCrashedRuns(makeStore([run]).store, new Map(), "killed #1");
      const second = await recoverCrashedRuns(makeStore([run]).store, new Map(), "killed #2");
      expect(first.recovered).toBe(1);
      expect(second.recovered).toBe(0); // fold interrupted → skippedTerminal 让位
      const events = await createRunEventJournal(journalDir).scan("wf-adopt-3");
      expect(events.filter((e) => e.type === "run-interrupted")).toHaveLength(1);
    } finally {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
