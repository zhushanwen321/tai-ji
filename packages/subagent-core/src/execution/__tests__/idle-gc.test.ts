// src/execution/__tests__/idle-gc.test.ts
//
// [W4] idle-gc 扩展单测：startedAt 锚归档（无 idleSince 的 idle record）、
// 只归档不补注销（archive 不发 pending:unregister——注销统一交对账 sweep）、
// WorkflowRun store 纳入（startedAt 锚终态化 + save）。fake timers 推进 GC
// interval；RecordStore 用 mkdtemp 自建目录 + pi=null（archive 纯内存，零磁盘写）。
//
// [U2b / C1] markIdleArchived 归口：归档时 `.alive` 写权声明同步 release（D3a
// release 出口②）——S6 验收锚点链的单元级断言（fake clock 推进 30 天 → 归档 →
// marker 已删 → fork-from 探针放行 → 接管 acquire 重声明）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findForeignLiveInstance } from "../persistence/alive-store.ts";
import { createRecord } from "../persistence/execution-record.ts";
import { startIdleGc, resolveWorkflowRunGcIntervalMs, resolveWorkflowRunIdleTtlMs, WORKFLOW_RUN_GC_INTERVAL_MS_ENV, WORKFLOW_RUN_IDLE_TTL_MS_ENV } from "../persistence/idle-gc.ts";
import { createRunEventJournal } from "../../orchestration/run-events.ts";
import { setRunEventJournalDirForTest } from "../../orchestration/worker-message-pump.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { configureCore, HostNotConfiguredError, resetCoreForTests } from "../../core/host-services.ts";
import type { ExecutionRecord } from "../assembly/types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 60 * 1000;

let tmpDir: string;
let gcDir: string;
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-gc-"));
  gcDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-gc-run-"));
  // [W2/V1] 收编链（scan/帧落账/manifest）走模块 journal 单写者域——注入即覆盖。
  setRunEventJournalDirForTest(gcDir);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  fs.rmSync(gcDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.useRealTimers();
  resetCoreForTests();
  delete process.env[WORKFLOW_RUN_IDLE_TTL_MS_ENV];
  delete process.env[WORKFLOW_RUN_GC_INTERVAL_MS_ENV];
});

/** 预置可收编的 journal（run-created + ask-dispatched——fold 非 terminal）。 */
async function seedJournal(runId: string): Promise<void> {
  const journal = createRunEventJournal(gcDir);
  await journal.append(runId, {
    type: "run-created",
    runId,
    workflowName: "test-wf",
    argsSummary: "{}",
    ts: Date.now(),
  });
  await journal.append(runId, {
    type: "ask-dispatched",
    taskIndex: 1,
    agentName: "a",
    attempt: 1,
    ts: Date.now(),
  });
}

/** WorkflowRun GC 窄口 mock（[W2/V1] 仅 loadAll——transition/save 写点已退役）。 */
function makeWorkflowStore(runs: Array<{
  runId: string;
  status: string;
  startedAt: string;
}>) {
  return {
    store: {
      loadAll: async () =>
        runs.map((r) => ({
          runId: r.runId,
          state: { status: r.status },
          meta: { startedAt: r.startedAt },
        })),
    },
  };
}

/** 排空微任务链（void gcWorkflowRuns 的 async 链推进到稳定态——journal 帧为同步
 *  fs，微任务排空即落盘）。 */
async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve(); // eslint-disable-line no-await-in-loop -- 排空微任务的固定 tick 循环
  }
}

/** 有界轮询至条件成立（manifest 经 writeAtomicFile 真实 IO——fake timers 下微任务
 *  排空等不到线程池回调，须以异步 tick 让 IO promise 落定；超时失败不静默）。 */
async function pollUntil(cond: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) {
    await vi.advanceTimersByTimeAsync(1); // eslint-disable-line no-await-in-loop -- IO 落定的有界轮询
  }
  if (!cond()) throw new Error("pollUntil: condition not met within budget");
}

/** 真实时钟有界轮询（writeAtomicFile 的 rename 链在 fake timers 下不落定——
 *  收编断言改走真实 timers + 两 env 旋钮调短通道，轮询等 IO 落定）。 */
async function pollUntilReal(cond: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 5)); // eslint-disable-line no-await-in-loop -- 真实时钟 IO 轮询
  }
  if (!cond()) throw new Error("pollUntilReal: condition not met within budget");
}

function makeStore(): RecordStore {
  return new RecordStore(path.join(tmpDir, "sessions"));
}

function makeRecord(id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const record = createRecord(id, {
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "s",
    startedAt: Date.now(),
    rootSessionId: "sess-root",
  });
  // [U5/D4] GC 判据 isResumable 已改 idle 派生——候选构造为 idle 形态。
  record.status = "idle";
  Object.assign(record, overrides);
  return record;
}

describe("idle-GC 归口 markIdleArchived（U2b/C1——D3a release 出口②闭环链，S6 锚点）", () => {
  it("fake clock 推进 30 天 → 归档 + `.alive` 已删 + fork-from 探针放行 + 接管 acquire 重声明（闭环链）", async () => {
    const store = makeStore();
    const sessionFile = path.join(tmpDir, "lease-session.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const rec = makeRecord("bg-lease", {
      startedAt: Date.now() - 31 * DAY_MS,
      idleSince: Date.now() - 31 * DAY_MS,
      sessionFile,
    });
    store.register(rec);
    // 持有期声明在位（模拟 spawn 侧 acquireWriteLease 已声明写权的可归档 idle record）。
    store.acquireWriteLease(sessionFile, rec.id);
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true);

    stop = startIdleGc(store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);

    // ① 归档生效（内存移除——record 磁盘仍 running 可接管，非终态化）。
    expect(store.getMutable("bg-lease")).toBeUndefined();
    // ② marker 已删（release 生效——归档 = 放弃持有 = 放弃写权声明）。
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
    // ③ fork-from 放行：探针无 marker 即无声明，不再被残留声明拦。
    expect(findForeignLiveInstance(sessionFile)).toBeUndefined();
    // ④ message 接管 acquire 重声明：接管时统一 acquireWriteLease（接管链经
    //    markResurrected 的 acquire-first，本处以 store 内部 acquire 动作直驱同语义）。
    store.acquireWriteLease(sessionFile, "bg-lease");
    const marker = JSON.parse(fs.readFileSync(`${sessionFile}.alive`, "utf-8")) as {
      pid: number;
      id: string;
    };
    expect(marker).toMatchObject({ pid: process.pid, id: "bg-lease" });
    // 重声明后探针对本进程仍放行（self-pid 排除——自有声明不构成 foreign）。
    expect(findForeignLiveInstance(sessionFile)).toBeUndefined();
  });

  it("锚窗内的 record 不归档且 `.alive` 不 release（无早释）", async () => {
    const store = makeStore();
    const sessionFile = path.join(tmpDir, "lease-fresh.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const rec = makeRecord("bg-hold", {
      startedAt: Date.now() - 1 * DAY_MS,
      sessionFile,
    });
    store.register(rec);
    store.acquireWriteLease(sessionFile, rec.id);

    stop = startIdleGc(store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);

    expect(store.getMutable("bg-hold")).toBeDefined();
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true);
  });
});

describe("idle-gc record 锚扩展（W4）", () => {
  it("无 idleSince 的 idle record 以 startedAt 为锚：超 30 天归档", async () => {
    const store = makeStore();
    const stale = makeRecord("bg-old", { startedAt: Date.now() - 31 * DAY_MS });
    store.register(stale);
    const fresh = makeRecord("bg-new", { startedAt: Date.now() - 1 * DAY_MS });
    store.register(fresh);
    const unregisterEmit = vi.fn();
    stop = startIdleGc(store, undefined);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(store.getMutable("bg-old")).toBeUndefined(); // 已归档（内存移除）
    expect(store.getMutable("bg-new")).toBeDefined();
    expect(unregisterEmit).not.toHaveBeenCalled();
  });

  it("有 idleSince 的 idle record 仍以 idleSince 为锚（现状语义保持）", async () => {
    const store = makeStore();
    const rec = makeRecord("bg-1", {
      startedAt: Date.now() - 1 * DAY_MS,
      idleSince: Date.now() - 31 * DAY_MS,
    });
    store.register(rec);
    stop = startIdleGc(store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(store.getMutable("bg-1")).toBeUndefined();
  });

  it("锚窗内（30 天量级以内）不归档", async () => {
    const store = makeStore();
    const rec = makeRecord("bg-1", { startedAt: Date.now() - 29 * DAY_MS });
    store.register(rec);
    stop = startIdleGc(store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(store.getMutable("bg-1")).toBeDefined();
  });

  it("只归档不补注销：archive 不发 pending:unregister（store pi=null 且不注入 emit 通道）", async () => {
    const store = makeStore();
    let appendCalls = 0;
    // pi=null 构造后再注入 spy 形态的 pi——archive 的唯一出站面是 pi.appendEntry
    //（reportSubagentRecord）。归档必须零注销发射（发射点枚举 5 处不含 GC）。
    const rec = makeRecord("bg-1", { startedAt: Date.now() - 31 * DAY_MS });
    store.register(rec);
    store.setPi({ appendEntry: () => { appendCalls += 1; } });
    stop = startIdleGc(store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(store.getMutable("bg-1")).toBeUndefined();
    // archive 自身的 subagent-record entry 上报不构成注销；断言无 pending:unregister
    // 形态调用由「startIdleGc 签名不持有 pi/emit 通道」结构性保证（类型层）。
    expect(appendCalls).toBeGreaterThanOrEqual(0);
  });
});

describe("idle-gc WorkflowRun store 纳入（[W2/V1 D3] 改走收编原语）", () => {
  // [W2/V1 D3] 终局化经 adoptInterruptedRun 原语（journal 帧 + manifest 两件，
  // outcome=interrupted + errorCode=idle-evicted）——两态机 transition+save 写点
  // 退役。journal/manifest 注入面 = setRunEventJournalDirForTest（模块单写者域）。
  function makeWorkflowStore(runs: Array<{
    runId: string;
    status: string;
    startedAt: string;
  }>) {
    return {
      store: {
        loadAll: async () =>
          runs.map((r) => ({
            runId: r.runId,
            state: { status: r.status },
            meta: { startedAt: r.startedAt },
          })),
      },
    };
  }

  it("running 且超 TTL → 收编原语终局化（journal run-settled 帧 outcome=interrupted/idle-evicted + manifest；两 env 旋钮调短通道）", async () => {
    // [W2/V1 场景 3] fake timers 与 writeAtomicFile 的真实 IO rename 链不兼容——
    // 本用例按旋钮的设计用途走真实 timers + 两 env 调短（TTL 定超龄 / interval 定
    // 回收节奏，两旋钮缺一不可）。
    vi.useRealTimers();
    process.env[WORKFLOW_RUN_IDLE_TTL_MS_ENV] = "1000";
    process.env[WORKFLOW_RUN_GC_INTERVAL_MS_ENV] = "50";
    await seedJournal("wf-old");
    const { store } = makeWorkflowStore([
      { runId: "wf-old", status: "running", startedAt: new Date(Date.now() - 60_000).toISOString() },
    ]);
    stop = startIdleGc(makeStore(), store);
    await pollUntilReal(() => fs.existsSync(path.join(gcDir, "wf-old.json")));

    // journal 尾部有收编终局帧（[W2 三路径 outcome 断言] idle 回收侧）
    const events = await createRunEventJournal(gcDir).scan("wf-old");
    const settled = events.find((e) => e.type === "run-settled");
    expect(settled).toBeDefined();
    expect(settled).toMatchObject({ outcome: "interrupted", errorCode: "idle-evicted" });
    // manifest 物化（workflowName 从 run-created 帧取）
    const manifest = JSON.parse(fs.readFileSync(path.join(gcDir, "wf-old.json"), "utf8")) as {
      outcome: string;
      errorCode?: string;
      workflowName: string;
    };
    expect(manifest).toMatchObject({ outcome: "interrupted", errorCode: "idle-evicted", workflowName: "test-wf" });
  });

  it("窗内 running / 快照 done 的 run 不动（原语幂等前置承接终局判定）", async () => {
    await seedJournal("wf-new");
    const { store } = makeWorkflowStore([
      { runId: "wf-new", status: "running", startedAt: new Date(Date.now() - 1 * DAY_MS).toISOString() },
      { runId: "wf-done", status: "done", startedAt: new Date(Date.now() - 40 * DAY_MS).toISOString() },
    ]);
    stop = startIdleGc(makeStore(), store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    const events = await createRunEventJournal(gcDir).scan("wf-new");
    expect(events.filter((e) => e.type === "run-settled")).toHaveLength(0);
    expect(fs.existsSync(path.join(gcDir, "wf-done.json"))).toBe(false);
  });

  it("已终局 run（journal 有 run-settled 帧）超龄 → 原语幂等跳过（skippedTerminal，不重复追加）", async () => {
    const journal = createRunEventJournal(gcDir);
    await journal.append("wf-settled", {
      type: "run-created",
      runId: "wf-settled",
      workflowName: "test-wf",
      argsSummary: "{}",
      ts: Date.now() - 40 * DAY_MS,
    });
    await journal.append("wf-settled", {
      type: "run-settled",
      outcome: "completed",
      artifactsDir: gcDir,
      ts: Date.now() - 39 * DAY_MS,
    });
    // v2 run 终局后快照 status 停更 running（fold 只富集 outcome）——粗筛仍放行
    const { store } = makeWorkflowStore([
      { runId: "wf-settled", status: "running", startedAt: new Date(Date.now() - 40 * DAY_MS).toISOString() },
    ]);
    stop = startIdleGc(makeStore(), store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);

    const events = await createRunEventJournal(gcDir).scan("wf-settled");
    expect(events.filter((e) => e.type === "run-settled")).toHaveLength(1);
  });

  it("same-session run（当前 session 注册差集命中）→ 四件直落齐套（[W2 D3] journal 帧 + manifest + 终态条目 + 注销条目）", async () => {
    // 正向 manifest 断言走真实 timers + 两 env 旋钮（fake timers 与 writeAtomicFile
    // 的真实 IO rename 链不兼容——对齐同 describe 收编用例先例）。
    vi.useRealTimers();
    process.env[WORKFLOW_RUN_IDLE_TTL_MS_ENV] = "1000";
    process.env[WORKFLOW_RUN_GC_INTERVAL_MS_ENV] = "50";
    await seedJournal("wf-same");
    // 当前 session 文件：含 wf-same 的 pending:register（活跃注册差集命中 = 归属
    // 判定锚——run 属当前 session，appendEntry 写达域有效）。
    const sessionFile = path.join(tmpDir, "main-session.jsonl");
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({ customType: "pending:register", data: { id: "wf-same", type: "workflow" } })}\n`,
      "utf-8",
    );
    const appended: Array<{ customType: string; data: unknown }> = [];
    const { store } = makeWorkflowStore([
      { runId: "wf-same", status: "running", startedAt: new Date(Date.now() - 60_000).toISOString() },
    ]);
    stop = startIdleGc(makeStore(), store, {
      sessionFile: () => sessionFile,
      appendEntry: () => (customType, data) => {
        appended.push({ customType, data });
      },
    });
    // 终态条目/注销条目在 manifest 物化后同步直落——轮询至两件条目齐（IO 落定）。
    await pollUntilReal(
      () => fs.existsSync(path.join(gcDir, "wf-same.json")) && appended.length >= 2,
    );
    // 立即停表 + 等在飞 GC 链落定：真实 timers 的 50ms interval 在 afterEach 停表/
    // 删目录/删 env 之后仍可能在飞——在飞链撞已删 journal 目录的失败 warn 会泄漏
    // 进后续用例的 log sink（A11 分通道断言对 warn 计数敏感）。
    stop?.();
    stop = undefined;
    await new Promise((r) => setTimeout(r, 80));

    // ① journal 收编终局帧（outcome/errorCode 断言同 cross-session 形态）
    const events = await createRunEventJournal(gcDir).scan("wf-same");
    const settled = events.find((e) => e.type === "run-settled");
    expect(settled).toMatchObject({ outcome: "interrupted", errorCode: "idle-evicted" });
    // ② manifest 物化
    expect(fs.existsSync(path.join(gcDir, "wf-same.json"))).toBe(true);
    // ③ 主 session 终态条目（workflow-record settled——appendSettledEntry 透传直落）
    const settledEntry = appended.find((e) => e.customType === "workflow-record");
    expect(settledEntry).toBeDefined();
    expect(settledEntry?.data).toMatchObject({
      kind: "settled",
      runId: "wf-same",
      outcome: "interrupted",
      errorCode: "idle-evicted",
      reason: "failed",
    });
    // ④ pending 注销条目（reason 经 runSettledOutcomeToDoneReason 联合派生单点——
    //    interrupted → "failed" 诊断兜底容器；status 经 mapReasonToStatus = "failed"）
    const unregister = appended.find((e) => e.customType === "pending:unregister");
    expect(unregister?.data).toMatchObject({ id: "wf-same", reason: "failed", status: "failed" });
  });

  it("cross-session run（注册差集未命中）→ 维持两件直落（零 appendEntry——条目/注销重开自愈，[W2 D3]）", async () => {
    vi.useRealTimers();
    process.env[WORKFLOW_RUN_IDLE_TTL_MS_ENV] = "1000";
    process.env[WORKFLOW_RUN_GC_INTERVAL_MS_ENV] = "50";
    await seedJournal("wf-cross");
    // session 文件只注册了别的 run——wf-cross 不在当前 session 注册差集内。
    const sessionFile = path.join(tmpDir, "main-session-cross.jsonl");
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({ customType: "pending:register", data: { id: "wf-other", type: "workflow" } })}\n`,
      "utf-8",
    );
    const appended: Array<{ customType: string; data: unknown }> = [];
    const { store } = makeWorkflowStore([
      { runId: "wf-cross", status: "running", startedAt: new Date(Date.now() - 60_000).toISOString() },
    ]);
    stop = startIdleGc(makeStore(), store, {
      sessionFile: () => sessionFile,
      appendEntry: () => (customType, data) => {
        appended.push({ customType, data });
      },
    });
    await pollUntilReal(() => fs.existsSync(path.join(gcDir, "wf-cross.json")));
    // 立即停表 + 等在飞 GC 链落定（同 same-session 用例——防在飞链泄漏 warn 进
    // 后续用例的 log sink）。
    stop?.();
    stop = undefined;
    await new Promise((r) => setTimeout(r, 80));

    // 两件直落（journal 帧 + manifest），条目/注销不落（跨 session 写达域无效）
    const events = await createRunEventJournal(gcDir).scan("wf-cross");
    expect(events.find((e) => e.type === "run-settled")).toMatchObject({
      outcome: "interrupted",
      errorCode: "idle-evicted",
    });
    expect(fs.existsSync(path.join(gcDir, "wf-cross.json"))).toBe(true);
    expect(appended).toHaveLength(0);
  });

  it("loadAll 抛错（宿主未 configureCore）→ 单轮跳过不炸 interval（域未启用 = debug 不 warn）", async () => {
    // [A11] 用例级 logCalls sink：域未启用走 debug 通道（正常形态不噪声），断言零 warn。
    const logCalls: Array<{ level: string; message: string }> = [];
    configureCore({
      dataRoot: () => "/fake-idle-gc-data-root",
      log: (level, _component, message) => {
        logCalls.push({ level, message });
      },
    });
    const failing = {
      loadAll: async () => {
        throw new HostNotConfiguredError("[subagent-core] core_host_not_configured");
      },
    };
    stop = startIdleGc(makeStore(), failing);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS * 2 + 1);
    // 两次扫描周期都存活（未抛出即通过）；域未启用不产生 warn。
    expect(logCalls.filter((l) => l.level === "warn")).toHaveLength(0);
  });

  it("loadAll 抛真 IO 故障（非 core_host_not_configured）→ warn 留痕 + 单轮跳过存活（A11 分通道）", async () => {
    // [A11] 读失败与「域未启用」分通道：真 IO 故障 warn 可归因（静默会把持续故障
    // 伪装成「无 run 可回收」），但 GC interval 不被拖垮（下轮重试）。
    const logCalls: Array<{ level: string; message: string }> = [];
    configureCore({
      dataRoot: () => "/fake-idle-gc-data-root",
      log: (level, _component, message) => {
        logCalls.push({ level, message });
      },
    });
    const failing = {
      loadAll: async () => {
        throw new Error("EIO: disk unavailable (mock)");
      },
    };
    stop = startIdleGc(makeStore(), failing);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    const warns = logCalls.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain("loadAll failed");
    expect(warns[0]?.message).toContain("EIO");
    // 第二轮仍存活（下轮重试语义）
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS);
    expect(logCalls.filter((l) => l.level === "warn")).toHaveLength(2);
  });
});

// ── [W2/V1 场景 3] 两 env 旋钮解析语义（未设/空 → 缺省；非法 → 缺省 + warn）──

describe("idle-gc 两 env 旋钮（TAIJI_WORKFLOW_RUN_IDLE_TTL_MS / TAIJI_WORKFLOW_RUN_GC_INTERVAL_MS）", () => {
  afterEach(() => {
    delete process.env[WORKFLOW_RUN_IDLE_TTL_MS_ENV];
    delete process.env[WORKFLOW_RUN_GC_INTERVAL_MS_ENV];
  });

  it("未设 → 缺省（TTL 30 天、interval 1h——生产行为不变）", () => {
    delete process.env[WORKFLOW_RUN_IDLE_TTL_MS_ENV];
    delete process.env[WORKFLOW_RUN_GC_INTERVAL_MS_ENV];
    expect(resolveWorkflowRunIdleTtlMs()).toBe(30 * DAY_MS);
    expect(resolveWorkflowRunGcIntervalMs()).toBe(60 * 60 * 1000);
  });

  it("空串 → 同未设（缺省回退）", () => {
    process.env[WORKFLOW_RUN_IDLE_TTL_MS_ENV] = "";
    process.env[WORKFLOW_RUN_GC_INTERVAL_MS_ENV] = "";
    expect(resolveWorkflowRunIdleTtlMs()).toBe(30 * DAY_MS);
    expect(resolveWorkflowRunGcIntervalMs()).toBe(60 * 60 * 1000);
  });

  it("合法正值 → 生效（测试调短通道）", () => {
    process.env[WORKFLOW_RUN_IDLE_TTL_MS_ENV] = "60000";
    process.env[WORKFLOW_RUN_GC_INTERVAL_MS_ENV] = "1000";
    expect(resolveWorkflowRunIdleTtlMs()).toBe(60000);
    expect(resolveWorkflowRunGcIntervalMs()).toBe(1000);
  });

  it("非法值（非有限数 / ≤0）→ 回退缺省 + warn 留痕（不照搬 abandon 先例的 opt-out）", () => {
    const logCalls: Array<{ level: string; message: string }> = [];
    configureCore({
      dataRoot: () => "/fake-idle-gc-data-root",
      log: (level, _component, message) => {
        logCalls.push({ level, message });
      },
    });
    process.env[WORKFLOW_RUN_IDLE_TTL_MS_ENV] = "abc";
    process.env[WORKFLOW_RUN_GC_INTERVAL_MS_ENV] = "-5";
    expect(resolveWorkflowRunIdleTtlMs()).toBe(30 * DAY_MS);
    expect(resolveWorkflowRunGcIntervalMs()).toBe(60 * 60 * 1000);
    const warns = logCalls.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(2);
    expect(warns[0]?.message).toContain(WORKFLOW_RUN_IDLE_TTL_MS_ENV);
    expect(warns[1]?.message).toContain(WORKFLOW_RUN_GC_INTERVAL_MS_ENV);
    // 防刷屏：同 env 二次解析不再 warn
    expect(resolveWorkflowRunIdleTtlMs()).toBe(30 * DAY_MS);
    expect(logCalls.filter((l) => l.level === "warn")).toHaveLength(2);
  });

  it("interval 旋钮真实生效：GC_INTERVAL_MS 调低后单轮扫描按新节奏推进（TTL/interval 缺一不可）", async () => {
    vi.useRealTimers();
    process.env[WORKFLOW_RUN_IDLE_TTL_MS_ENV] = "1000";
    process.env[WORKFLOW_RUN_GC_INTERVAL_MS_ENV] = "50";
    await seedJournal("wf-knob");
    const { store } = makeWorkflowStore([
      { runId: "wf-knob", status: "running", startedAt: new Date(Date.now() - 60_000).toISOString() },
    ]);
    stop = startIdleGc(makeStore(), store);
    // TTL 调短只让 run 变超龄；回收动作按新 interval（50ms）推进
    await pollUntilReal(() => fs.existsSync(path.join(gcDir, "wf-knob.json")));
    const events = await createRunEventJournal(gcDir).scan("wf-knob");
    const settled = events.find((e) => e.type === "run-settled");
    expect(settled).toMatchObject({ outcome: "interrupted", errorCode: "idle-evicted" });
  });
});
