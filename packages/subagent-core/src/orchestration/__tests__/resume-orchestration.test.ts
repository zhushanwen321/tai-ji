// src/orchestration/__tests__/resume-orchestration.test.ts
//
// [U2] resumeRun 编排原语测试（workflow-run-resume-revision §3.3 D7/D12/D13 +
// 机制文档场景 9/15/17 的脚本层形态）。
//
// 覆盖：
// - 复活主链：run-resumed 落 record（锁段内）+ 聚合重建（回放集 done + result
//   全文 / 重派集不建条目）+ worker 接管 + v2 注册条目 + pending:register
// - 场景 15（同进程双 resume）：串行第二次资格拒绝 + 并发形态恰一成功；record
//   只有一套 run-resumed
// - 场景 9（跨进程双 resume，脚本层）：锁互斥（mkdir 原子性构造性保证——待验证
//   检查点 2 已核实 proper-lockfile 实装；ELOCKED 拒绝文案 + 预置锁拒绝）；
//   record 无交错事件
// - 场景 17（resume 后 abort）：cancelled 终局正常写入 + 对 cancelled 再 resume
//   明确拒绝
// - 资格校验族：run 不存在 / 终局 run / 从未中断的 run / D13 嵌套拒绝
// - D12 完整性拒绝：半截行 / seq 断档 / settled 缺 result（场景 18 resume 侧）
// - 裁决点 7：v2 条目失败干净拒绝（run-resumed 未落）
// - D10 预算预检：活跃段已耗尽拒绝
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ResumeRejectionError,
  resumeRun,
} from "../resume-run.ts";
import { abortRun } from "../lifecycle.ts";
import { setRunEventJournalDirForTest } from "../terminal-actions.ts";
import { createRunEventJournal } from "../run-events.ts";
import type { WorkflowRunEvent } from "../run-events.ts";
import type { LifecycleDeps } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";

// ── helpers ──────────────────────────────────────────────────

const T0 = 1_770_000_000_000;
const SCRIPT_SOURCE = "async function execute({ agent }) { await agent('step1'); }";

let journalDir: string;

beforeEach(() => {
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-orchestration-"));
  setRunEventJournalDirForTest(journalDir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function scanEvents(runId: string): Promise<readonly WorkflowRunEvent[]> {
  return createRunEventJournal(journalDir).scan(runId);
}

/** 预置「崩溃收编后」record 流：2 settled + 1 in-flight + run-interrupted。 */
async function seedInterruptedRecord(
  runId: string,
  opts: { scriptSource?: string; scriptPath?: string; withSessionFile?: boolean } = {},
): Promise<void> {
  const journal = createRunEventJournal(journalDir);
  await journal.append(runId, {
    type: "run-created",
    runId,
    workflowName: "test-wf",
    argsSummary: "{}",
    scriptSource: opts.scriptSource ?? SCRIPT_SOURCE,
    ...(opts.scriptPath !== undefined ? { scriptPath: opts.scriptPath } : {}),
    ts: T0,
  });
  await journal.append(runId, {
    type: "agent-started",
    taskIndex: 0,
    agentName: "collector",
    attempt: 1,
    ts: T0 + 1_000,
  });
  await journal.append(runId, {
    type: "agent-settled",
    taskIndex: 0,
    attempt: 1,
    outcome: "done",
    durationMs: 5_000,
    result: {
      content: "result-0",
      ...(opts.withSessionFile === true ? { sessionFile: "/fake/sessions/member-a.jsonl" } : {}),
    },
    ts: T0 + 6_000,
  });
  await journal.append(runId, {
    type: "agent-started",
    taskIndex: 1,
    agentName: "collector",
    attempt: 1,
    ts: T0 + 7_000,
  });
  await journal.append(runId, {
    type: "run-interrupted",
    errorCode: "crashed",
    reason: "test crash",
    ts: T0 + 8_000,
  });
}

/** mock LifecycleDeps（workerHost.start 返回 fake handle——不发消息，run 静置 running）。 */
function makeDeps(): {
  deps: LifecycleDeps;
  runs: Map<string, import("../models/workflow-run.ts").WorkflowRun>;
  appendEntry: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  workerStarts: number[];
} {
  const runs = new Map();
  const appendEntry = vi.fn();
  const emit = vi.fn();
  const workerStarts: number[] = [];
  const deps: LifecycleDeps = {
    store: { save: vi.fn(async () => {}), loadAll: vi.fn(async () => []), stateFilePath: vi.fn(() => "") },
    workerHost: {
      start: vi.fn(() => {
        workerStarts.push(Date.now());
        return {
          postMessage: vi.fn(),
          terminate: vi.fn(async () => {}),
        } as unknown as WorkerHandle;
      }),
    },
    runner: { run: vi.fn(async () => ({ content: "" })) },
    runs,
    appendEntry,
    eventBus: { emit },
    onRunDone: vi.fn(),
    log: vi.fn(),
  };
  return { deps, runs, appendEntry, emit, workerStarts };
}

function expectRejection(p: Promise<unknown>, fragment: string): Promise<void> {
  return expect(p).rejects.toMatchObject({
    name: "ResumeRejectionError",
    message: expect.stringContaining(fragment),
  });
}

// ── 复活主链 ─────────────────────────────────────────────────

describe("resumeRun — 复活主链（方案 A 同 runId 复活）", () => {
  it("run-resumed 落 record + 聚合重建（回放集 done+result / 重派集不建条目）+ worker 接管 + v2 条目 + pending:register", async () => {
    await seedInterruptedRecord("wf-main", { scriptPath: "/abs/workflows/fan-out.js" });
    const { deps, runs, appendEntry, emit } = makeDeps();

    const returned = await resumeRun("wf-main", deps, { now: () => T0 + 100_000 });

    expect(returned).toBe("wf-main");
    // record：run-resumed 转移事件（interrupted → running，锁段内自完成）
    const events = await scanEvents("wf-main");
    expect(events.map((e) => e.type)).toEqual([
      "run-created",
      "agent-started",
      "agent-settled",
      "agent-started",
      "run-interrupted",
      "run-resumed",
    ]);
    // 聚合重建：回放集（taskIndex 0）done + result 全文；重派集（taskIndex 1）无条目
    const run = runs.get("wf-main");
    expect(run).toBeDefined();
    expect(run!.state.status).toBe("running");
    expect(run!.runtime).toBeDefined();
    expect(run!.spec.scriptSource).toBe(SCRIPT_SOURCE);
    // 锚定恢复：scriptPath 从 run-created 帧逐字恢复（worker 沙箱 _shared 定位来源）
    expect(run!.spec.scriptPath).toBe("/abs/workflows/fan-out.js");
    const replayed = run!.state.calls.get(0);
    expect(replayed?.status).toBe("done");
    expect(replayed?.result?.content).toBe("result-0");
    expect(run!.state.calls.has(1)).toBe(false);
    // v2 注册条目（裁决点 7：锁段内、先于复活事件）
    expect(appendEntry).toHaveBeenCalledTimes(1);
    const [customType, entry] = appendEntry.mock.calls[0] as [string, { kind: string; runId: string }];
    expect(customType).toBe("workflow-record");
    expect(entry.kind).toBe("registered");
    expect(entry.runId).toBe("wf-main");
    // pending 信号（复活 = 对当前 session 重新可见）
    expect(emit).toHaveBeenCalledWith("pending:register", expect.objectContaining({ id: "wf-main" }));
  });

  it("旧格式帧（无 scriptPath 载荷）：重建回落空串（现状行为不劣化，inline 脚本不受影响）", async () => {
    await seedInterruptedRecord("wf-legacy"); // 不传 scriptPath = scriptPath 载荷落地前的旧格式帧
    const { deps, runs } = makeDeps();

    await resumeRun("wf-legacy", deps, { now: () => T0 + 100_000 });

    expect(runs.get("wf-legacy")!.spec.scriptPath).toBe("");
  });

  it("D8 档 3（会话文件不可知/不存在）：重派集成员不补收、不建条目——worker 重放时真实派发", async () => {
    // in-flight call 的 agent 无既有 settled 帧（无 sessionFile 可知）→ 档 3
    await seedInterruptedRecord("wf-tier3");
    const { deps, runs } = makeDeps();

    await resumeRun("wf-tier3", deps, { now: () => T0 + 100_000 });

    const events = await scanEvents("wf-tier3");
    // 无补收帧（档 3 不落 settled）
    expect(events.filter((e) => e.type === "agent-settled")).toHaveLength(1);
    expect(runs.get("wf-tier3")!.state.calls.has(1)).toBe(false);
  });
});

// ── 场景 15：同进程双 resume ──────────────────────────────────

describe("场景 15 — 同进程双 resume：恰一次生效，第二次明确拒绝", () => {
  it("串行第二次：fold=running 资格拒绝；record 只有一套 run-resumed", async () => {
    await seedInterruptedRecord("wf-dbl");
    const { deps } = makeDeps();

    await resumeRun("wf-dbl", deps, { now: () => T0 + 100_000 });
    await expectRejection(
      resumeRun("wf-dbl", deps, { now: () => T0 + 200_000 }),
      "not 'interrupted'",
    );

    const events = await scanEvents("wf-dbl");
    expect(events.filter((e) => e.type === "run-resumed")).toHaveLength(1);
  });

  it("并发形态（Promise.allSettled）：恰一成功一拒绝；record 一套 run-resumed 无交错事件", async () => {
    await seedInterruptedRecord("wf-race");
    const { deps } = makeDeps();

    const results = await Promise.allSettled([
      resumeRun("wf-race", deps, { now: () => T0 + 100_000 }),
      resumeRun("wf-race", deps, { now: () => T0 + 100_001 }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // 拒绝形态：锁互斥（ELOCKED）或资格（fold=running）——两者都是「明确拒绝」
    const reason = rejected[0].reason as Error;
    expect(reason).toBeInstanceOf(ResumeRejectionError);

    const events = await scanEvents("wf-race");
    expect(events.filter((e) => e.type === "run-resumed")).toHaveLength(1);
    // 无交错事件：尾三帧恰为 interrupted → run-resumed（无第二套派发痕迹）
    expect(events.slice(-2).map((e) => e.type)).toEqual(["run-interrupted", "run-resumed"]);
  });
});

// ── 场景 9：跨进程双 resume（脚本层——锁互斥行为面）────────────

describe("场景 9 — 跨进程双 resume：锁被占 → 明确拒绝（恰一成功）", () => {
  it("锁目录预置在场（另一进程持有）：ELOCKED 拒绝，文案指明另一进程 + 恢复指引", async () => {
    await seedInterruptedRecord("wf-lock");
    // 预置锁（proper-lockfile 的锁形态 = <target>.lock 目录；模拟另一进程持锁）
    fs.mkdirSync(path.join(journalDir, "wf-lock.resume.lock"), { recursive: true });
    const { deps } = makeDeps();

    await expectRejection(resumeRun("wf-lock", deps), "resumed by another process");

    // 拒绝路径零状态变更：record 无 run-resumed
    const events = await scanEvents("wf-lock");
    expect(events.some((e) => e.type === "run-resumed")).toBe(false);
  });

  it("锁正常释放：成功 resume 后锁工件自清（下次 resume 不被自身锁阻塞）", async () => {
    await seedInterruptedRecord("wf-rel");
    const { deps } = makeDeps();

    await resumeRun("wf-rel", deps, { now: () => T0 + 100_000 });
    expect(fs.existsSync(path.join(journalDir, "wf-rel.resume.lock"))).toBe(false);
  });
});

// ── 场景 17：resume 后 abort ─────────────────────────────────

describe("场景 17 — resume 后 abort：cancelled 终局正常写入，对 cancelled 再 resume 明确拒绝", () => {
  it("resume → abortRun → run-settled(cancelled) 落 record → 再 resume 拒绝（already settled）", async () => {
    await seedInterruptedRecord("wf-abort");
    const { deps } = makeDeps();

    await resumeRun("wf-abort", deps, { now: () => T0 + 100_000 });
    await abortRun("wf-abort", deps, "user aborted");

    const events = await scanEvents("wf-abort");
    const settled = events.at(-1);
    expect(settled?.type).toBe("run-settled");
    expect((settled as { outcome?: string }).outcome).toBe("cancelled");

    await expectRejection(resumeRun("wf-abort", deps), "already settled");
    // 二次拒绝零新增事件
    expect((await scanEvents("wf-abort")).filter((e) => e.type === "run-resumed")).toHaveLength(1);
  });
});

// ── 资格校验族 ───────────────────────────────────────────────

describe("resumeRun — 资格校验（错了明说）", () => {
  it("record 流不存在：拒绝（含 legacy run 不可续指引）", async () => {
    const { deps } = makeDeps();
    await expectRejection(resumeRun("wf-ghost", deps), "no record stream");
  });

  it("终局 run（run-settled 在场）：拒绝（only interrupted runs can be resumed）", async () => {
    const journal = createRunEventJournal(journalDir);
    await journal.append("wf-done", {
      type: "run-created",
      runId: "wf-done",
      workflowName: "test-wf",
      argsSummary: "{}",
      scriptSource: SCRIPT_SOURCE,
      ts: T0,
    });
    await journal.append("wf-done", {
      type: "run-settled",
      outcome: "done",
      artifactsDir: journalDir,
      ts: T0 + 1_000,
    });
    const { deps } = makeDeps();
    await expectRejection(resumeRun("wf-done", deps), "already settled");
  });

  it("从未中断的 run（fold=running，无 run-interrupted 帧）：拒绝", async () => {
    const journal = createRunEventJournal(journalDir);
    await journal.append("wf-live", {
      type: "run-created",
      runId: "wf-live",
      workflowName: "test-wf",
      argsSummary: "{}",
      scriptSource: SCRIPT_SOURCE,
      ts: T0,
    });
    const { deps } = makeDeps();
    await expectRejection(resumeRun("wf-live", deps), "not 'interrupted'");
  });

  // D13 嵌套词法拒绝已随嵌套 workflow() 功能移除而删除（检测对象不存在，场景 20 退役）
});

// ── D12 record 完整性校验（场景 18 resume 侧）─────────────────

describe("resumeRun — D12 完整性拒绝（损坏面）", () => {
  /** 手写 record 流文件（严格行由调用方拼——seq 显式控制以构造断档）。 */
  function writeRawRecord(runId: string, lines: unknown[]): void {
    fs.writeFileSync(
      path.join(journalDir, `${runId}.record.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );
  }

  const createdLine = { type: "run-created", runId: "wf-broken", workflowName: "w", argsSummary: "{}", scriptSource: "x", ts: T0, seq: 1 };

  it("半截行（末尾 JSON 截断）：拒绝 + 恢复指引", async () => {
    fs.writeFileSync(
      path.join(journalDir, "wf-broken.record.jsonl"),
      `${JSON.stringify(createdLine)}\n{"type":"run-interrupted","ts":${T0 + 1},"seq":2`, // 第二行截断
      "utf8",
    );
    const { deps } = makeDeps();
    await expectRejection(resumeRun("wf-broken", deps), "corrupted");
  });

  it("seq 断档（跳号 = 丢行/截断）：拒绝", async () => {
    writeRawRecord("wf-broken", [
      createdLine,
      { type: "run-interrupted", ts: T0 + 1, seq: 3 }, // 跳过 seq 2
    ]);
    const { deps } = makeDeps();
    await expectRejection(resumeRun("wf-broken", deps), "seq gap");
  });

  it("agent-settled 缺 result 全文：拒绝（D12 非法形态）", async () => {
    writeRawRecord("wf-broken", [
      createdLine,
      { type: "agent-started", taskIndex: 0, agentName: "a", attempt: 1, ts: T0 + 1, seq: 2 },
      { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 1, ts: T0 + 2, seq: 3 },
      { type: "run-interrupted", errorCode: "crashed", ts: T0 + 3, seq: 4 },
    ]);
    const { deps } = makeDeps();
    await expectRejection(resumeRun("wf-broken", deps), "no result payload");
  });
});

// ── 裁决点 7 + D10 预检 ──────────────────────────────────────

describe("resumeRun — v2 条目补写与预算预检", () => {
  it("appendEntry 失败：干净拒绝（run-resumed 未落，状态无损可重试）", async () => {
    await seedInterruptedRecord("wf-entryfail");
    const { deps } = makeDeps();
    (deps.appendEntry as ReturnType<typeof vi.fn>) = vi.fn(() => {
      throw new Error("session not writable");
    });

    await expectRejection(resumeRun("wf-entryfail", deps), "could not register");
    const events = await scanEvents("wf-entryfail");
    expect(events.some((e) => e.type === "run-resumed")).toBe(false);
    expect(events.at(-1)?.type).toBe("run-interrupted");
  });

  it("D10 预算预检：真实活跃段已耗尽 → 拒绝（搁置不计、已耗不退）", async () => {
    await seedInterruptedRecord("wf-budget");
    const { deps } = makeDeps();
    // 活跃段 = T0+1000..T0+7000 ≈ 6s（created → 末条执行事件）
    await expectRejection(
      resumeRun("wf-budget", deps, { budgetTimeMs: 5_000, now: () => T0 + 10 * 24 * 3600 * 1000 }),
      "exhausted its time budget",
    );
  });

  it("D10 预算预检：跨天搁置后仍有剩余 → 通过（场景 16 的不被秒拒，编排层）", async () => {
    await seedInterruptedRecord("wf-budget-ok");
    const { deps, runs } = makeDeps();
    // 预算 60s、活跃 6s、搁置 10 天 → 剩余 54s，resume 成功
    await expect(
      resumeRun("wf-budget-ok", deps, { budgetTimeMs: 60_000, now: () => T0 + 10 * 24 * 3600 * 1000 }),
    ).resolves.toBe("wf-budget-ok");
    expect(runs.get("wf-budget-ok")).toBeDefined();
  });
});
