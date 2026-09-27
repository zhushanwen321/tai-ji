// src/__tests__/jsonl-run-store-session-file.test.ts
//
// JsonlRunStore 壳侧归属面汇总件：save 去抖 / flush 串行链 / dispose、state 投影
// round-trip（sessionFile / trace 裁剪保真）、workflow-record 条目面（v1 停写锚定 +
// v2 收编读面 + rebind 补写）、codec 切换 golden 字节锚、adoption 投影重发保序与
// stale guard（被测对象是 JsonlRunStore 本体的条目收敛到本件）。
//
// 起源防的 bug：sessionFile 加入 AgentCall + ExecutionTraceNode 后，序列化时必须
// 写入快照，反序列化时必须恢复——否则跨 session 重水合后 agent 的 session jsonl
// 路径丢失，overlay 无法定位。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// logger mock（文件级）：jsonl-run-store.ts 模块级 getLogger 拿到此 mock，
// W2TC10 断言 dispose 后 save no-op 的 debug 留痕；其余 describe 不消费 logger。
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@zhushanwen/subagent-core/core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

import type { CustomEntry } from "@earendil-works/pi-coding-agent";

import { AgentCall } from "@zhushanwen/subagent-core";
import { Budget } from "@zhushanwen/subagent-core";
import { Trace } from "@zhushanwen/subagent-core";
import type { ExecutionTraceNode } from "@zhushanwen/subagent-core";
import type { RunSpec } from "@zhushanwen/subagent-core";
import { WorkflowRun } from "@zhushanwen/subagent-core";
import {
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_ENTRY_VERSION,
  fromRunSnapshot,
  toRunSnapshot,
} from "@zhushanwen/subagent-core";
import { JsonlRunStore } from "../jsonl-run-store.ts";
import { mkCtx, mkPi } from "@zhushanwen/subagent-core/testing/orchestration/__tests__/test-mocks.ts";

function makeSpec(): RunSpec {
  return {
    scriptSource: "module.exports = async () => {};",
    args: {},
    scriptName: "test-script",
    scriptPath: "/tmp/test.js",
    description: "test",
  };
}

function makeTraceNode(stepIndex: number): ExecutionTraceNode {
  return {
    stepIndex,
    agent: "worker",
    task: "do thing",
    model: "default",
    status: "pending",
  };
}

function makeRunWithDoneCall(): WorkflowRun {
  const trace = new Trace();
  const node = makeTraceNode(0);
  trace.append(node);
  const call = new AgentCall(
    0,
    {
      prompt: "task",
      agent: "worker",
      cwd: "/tmp",
    },
    node,
  );
  // 模拟已完成 agent call：带 sessionId + sessionFile
  call.markRunning();
  call.markDone({
    content: "done",
    sessionId: "session-abc",
    sessionFile: "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
  });
  call.setSessionId("session-abc");
  call.setSessionFile("/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl");
  trace.update(0, {
    status: "completed",
    result: call.result,
    completedAt: new Date().toISOString(),
    sessionId: "session-abc",
    sessionFile: "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
  });

  return new WorkflowRun(
    "run-test-001",
    makeSpec(),
    {
      status: "done",
      reason: "completed",
      budget: new Budget(),
      calls: new Map([[0, call]]),
      trace,
      errorLogs: [],
    },
    { startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
  );
}

/**
 * W4+ fixture：running 状态 run（热路径去抖测试的前提）。
 *
 * 用 WorkflowRun.reconstruct 构造——running 且 runtime undefined 违反 I1
 * （持久化的 running 快照无 worker），constructor 会抛错；reconstruct 跳过 I1
 * 校验（可信快照重水合语义）。serializeRun 不读 runtime 字段，序列化合法。
 * 热路径「中间态演进」直接对同一 run 引用 trace.append 后再次 save（latestRun 语义）。
 * status="done" 变体（吸收条目用）：reason 必须显式传——codec I2 不变式（终态必带）。
 */
function makeRunningRun(
  runId: string,
  status: "running" | "done" = "running",
  reason?: "completed" | "failed" | "aborted" | "budget_limited" | "time_limited",
): WorkflowRun {
  const trace = new Trace();
  trace.append(makeTraceNode(0));
  return WorkflowRun.reconstruct(
    runId,
    makeSpec(),
    {
      status,
      ...(reason ? { reason } : {}),
      budget: new Budget(),
      calls: new Map(),
      trace,
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
}

/** 读 run 状态文件并解析快照（W4+ 断言「磁盘真实内容」用）。 */
function readStateFile(
  tmpDir: string,
  runId: string,
): { state: { status: string; trace: Array<{ stepIndex: number }> } } {
  const raw = fs.readFileSync(path.join(tmpDir, "workflow-state", `${runId}.jsonl`), "utf8");
  return JSON.parse(raw.trim()) as { state: { status: string; trace: Array<{ stepIndex: number }> } };
}

/** unknown → workflow-record entry data 的运行时收窄（taste/no-unsafe-cast：断言前先收窄，
 *  对齐 record-store.test.ts 的 asEntryData 模式）。 */
function asRecordData(
  d: unknown,
): { v: number; snapshot: { runId: string; state: { status: string } } } {
  if (typeof d !== "object" || d === null) throw new Error("entry data is not an object");
  return d as { v: number; snapshot: { runId: string; state: { status: string } } };
}

/** [W1 / D7] 手工 v1 快照 entry（兼容层夹具：真实 codec 快照 + 存量 v1 信封）。 */
function v1RecordEntry(run: WorkflowRun): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: {
      v: 1,
      snapshot: toRunSnapshot(run),
      updatedAt: new Date().toISOString(),
    },
    id: `seed-v1-${run.runId}-${Math.random().toString(36).slice(2, 8)}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** [W1 / D1] 手工 v2 注册条目夹具（字段集 = core lifecycle 写点同构）。 */
function v2RegisteredEntry(runId: string, journalPath: string): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: {
      v: WORKFLOW_RECORD_ENTRY_VERSION,
      kind: "registered",
      runId,
      workflowName: "test-script",
      scriptName: "test-script",
      slug: "test-script",
      startedAt: Date.now(),
      journalPath,
    },
    id: `seed-v2-reg-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** [W1 / D1] 手工 v2 终态条目夹具（kind: settled）。 */
function v2SettledEntry(runId: string): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: {
      v: WORKFLOW_RECORD_ENTRY_VERSION,
      kind: "settled",
      runId,
      status: "done",
      reason: "completed",
      outcome: "completed",
      settledAt: Date.now(),
      callCount: 1,
      usedTokens: 0,
    },
    id: `seed-v2-settled-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** [W1 / D4] 向 stateDir 的 journal 文件追加一帧（raw JSONL——模拟 core 写者落账）。 */
function appendJournalLine(tmpDir: string, runId: string, line: Record<string, unknown>): void {
  const journalPath = path.join(tmpDir, "workflow-state", `${runId}.events.jsonl`);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.appendFileSync(journalPath, `${JSON.stringify(line)}\n`, "utf8");
}

describe("W1: JsonlRunStore sessionFile 序列化 round-trip", () => {
  let tmpDir: string;
  let store: JsonlRunStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-test-"));
    store = new JsonlRunStore({ sessionDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("save + loadAll round-trip: AgentCall.sessionFile 保留", async () => {
    const run = makeRunWithDoneCall();
    await store.save(run);

    // 从磁盘直接读快照验证 sessionFile 写入了序列化
    const stateDir = path.join(tmpDir, "workflow-state");
    const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const raw = fs.readFileSync(path.join(stateDir, files[0]!), "utf8");
    const snapshot = JSON.parse(raw.trim());
    const serializedCall = snapshot.state.calls[0];
    expect(serializedCall.sessionFile).toBe(
      "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
    );
  });

  it("save + loadAll round-trip: ExecutionTraceNode.sessionFile 保留", async () => {
    const run = makeRunWithDoneCall();
    await store.save(run);

    const raw = fs.readFileSync(
      path.join(tmpDir, "workflow-state", "run-test-001.jsonl"),
      "utf8",
    );
    const snapshot = JSON.parse(raw.trim());
    const traceNode = snapshot.state.trace[0];
    expect(traceNode.sessionFile).toBe(
      "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
    );
  });

  it("save → state 投影 round-trip: sessionFile 经 state 文件快照保留（[W1] 恢复聚合经 journal，call 级详情在投影/锚点面）", async () => {
    // [W1 / D1] 闭环改写：条目通道停写后 call 级详情的持久化面 = state 物化投影
    // （可删可重建；步骤级恢复读面 = journalPath 锚点 + runtime 投影）。本用例锁定
    // 投影往返保真：save → state 文件 → fromRunSnapshot → AgentCall.sessionFile 可读。
    const sessionFilePath = "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl";

    const entries: CustomEntry[] = [];
    const storeWithCtx = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mkPi(entries),
      ctx: mkCtx(entries),
    });

    const run = makeRunWithDoneCall();
    await storeWithCtx.save(run);

    const raw = fs.readFileSync(
      path.join(tmpDir, "workflow-state", "run-test-001.jsonl"),
      "utf8",
    );
    const restored = fromRunSnapshot(JSON.parse(raw.trim()));
    expect(restored).toBeDefined();
    const restoredCall = restored!.state.calls.get(0);
    expect(restoredCall).toBeDefined();
    expect(restoredCall!.sessionFile).toBe(sessionFilePath);
  });

  /** 10000 字符 result 的已完成 call run（W1TC11 裁剪断言用——模式对齐 makeRunWithDoneCall）。 */
  function makeRunWithLongDoneCall(): WorkflowRun {
    const trace = new Trace();
    const node = makeTraceNode(0);
    trace.append(node);
    const call = new AgentCall(0, { prompt: "task", agent: "worker" }, node);
    call.markRunning();
    // markDone 存全量 result（AgentCall.result 不裁）
    call.markDone({ content: "q".repeat(10000), sessionId: "session-abc" });
    call.setSessionId("session-abc");
    // trace.update 经入口裁剪——节点持裁剪副本
    trace.update(0, {
      status: "completed",
      result: call.result,
      completedAt: new Date().toISOString(),
      sessionId: "session-abc",
    });

    return new WorkflowRun(
      "run-trim-001",
      makeSpec(),
      {
        status: "done",
        reason: "completed",
        budget: new Budget(),
        calls: new Map([[0, call]]),
        trace,
        errorLogs: [],
      },
      { startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
    );
  }

  it("W1TC11: jsonl save/load round-trip——save 落盘 trace 裁剪 + calls[].result 全量；state 投影回读逐字节一致（[W1] 停写后投影即 round-trip 面）", async () => {
    const entries: CustomEntry[] = [];
    const storeTrim = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mkPi(entries),
      ctx: mkCtx(entries),
    });

    const run = makeRunWithLongDoneCall();
    await storeTrim.save(run);

    // 读磁盘快照验证落盘形态
    const raw = fs.readFileSync(
      path.join(tmpDir, "workflow-state", "run-trim-001.jsonl"),
      "utf8",
    );
    const snapshot = JSON.parse(raw.trim()) as {
      state: {
        trace: Array<{ result?: { content: string } }>;
        calls: Array<{ result?: { content: string }; traceNode: { result?: { content: string } } }>;
      };
    };

    // trace 投影瘦身生效：trace[0] 含标记
    expect(snapshot.state.trace[0]!.result!.content).toContain(
      "[trace result truncated, original 10000 chars]",
    );
    // calls[].traceNode 是同一裁剪后节点引用（剥 live 后的 rest），亦含标记
    expect(snapshot.state.calls[0]!.traceNode.result!.content).toContain(
      "[trace result truncated, original 10000 chars]",
    );
    // 顶层 calls[].result 字段不裁——全量 10000
    expect(snapshot.state.calls[0]!.result!.content).toHaveLength(10000);

    // [W1 / D1] 条目通道停写：save 零 workflow-record entry，loadAll 对「只有 state
    // 投影、无注册条目」的会话返回空（投影可删可重建，非重建源）——round-trip 回读
    // 面 = state 文件 fromRunSnapshot（call 级详情的持久化投影/恢复面）。
    expect(entries).toHaveLength(0);
    const restored = fromRunSnapshot(JSON.parse(raw.trim()));
    expect(restored).toBeDefined();
    expect(restored!.runId).toBe("run-trim-001");
    // fromArray 不再裁，与落盘形态逐字节一致（无标记嵌套）
    const restoredContent = restored!.state.trace.toArray()[0]!.result!.content;
    expect(restoredContent).toBe(snapshot.state.trace[0]!.result!.content);
    expect(restoredContent.match(/truncated/g)).toHaveLength(1);
  });
});

describe("W2: RunStore.stateFilePath 暴露 run 状态文件路径", () => {
  let tmpDir: string;
  let store: JsonlRunStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-test-"));
    store = new JsonlRunStore({ sessionDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("stateFilePath(runId) 返回 <sessionDir>/workflow-state/<runId>.jsonl", () => {
    const result = store.stateFilePath("run-foo");
    expect(result).toBe(path.join(tmpDir, "workflow-state", "run-foo.jsonl"));
  });
});

// ── W9: 快照版本守卫（v2 当前 / v1 跳过）──────────────────────────────
//
// U2 快照格式 v1→v2（status 两态、无 pausedAt）。v1 遗留文件经 loadAll 静默跳过
// （D-5 边界声明：旧 run 历史价值低，不做兼容迁移）。

describe("W9: 快照版本守卫（v2 当前 / v1 跳过）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-ver-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("v1 头快照（升级前遗留）→ loadAll 静默跳过：不崩、不显示", async () => {
    // 模拟 v1 时代的遗留快照（版本头 wf-run-v1）。版本守卫只比对 v 字段，
    // status 值不影响跳过判定——v1 running 残留同样静默消失不显示（D-5 边界声明）。
    const stateDir = path.join(tmpDir, "workflow-state");
    fs.mkdirSync(stateDir, { recursive: true });
    const filePath = path.join(stateDir, "run-legacy-v1.jsonl");
    const legacySnapshot = {
      v: "wf-run-v1",
      runId: "run-legacy-v1",
      state: { status: "running", calls: [], trace: [], errorLogs: [] },
      meta: { startedAt: new Date().toISOString() },
    };
    fs.writeFileSync(filePath, JSON.stringify(legacySnapshot) + "\n", "utf8");

    const entries: CustomEntry[] = [
      {
        type: "custom",
        customType: "workflow-state-link",
        data: { runId: "run-legacy-v1", path: filePath },
        id: "seed-pointer",
        parentId: null,
        timestamp: new Date().toISOString(),
      },
    ];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });

    // 版本不匹配 → deserializeRun 返回 null → loadAll 跳过（空数组），不崩
    await expect(store.loadAll()).resolves.toEqual([]);
  });

  it("新快照 version === wf-run-v2：status 两态、meta 投影无 pausedAt", async () => {
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const run = makeRunningRun("run-v2-check");
    await store.save(run);

    const raw = fs.readFileSync(
      path.join(tmpDir, "workflow-state", "run-v2-check.jsonl"),
      "utf8",
    );
    const snapshot = JSON.parse(raw.trim()) as {
      v: string;
      state: { status: string };
      meta: Record<string, unknown>;
    };
    // 版本头 v2（持久化契约锚定字面量）
    expect(snapshot.v).toBe("wf-run-v2");
    // status 两态（running/done）
    expect(snapshot.state.status).toBe("running");
    // F6：meta 投影不再含 pausedAt 字段
    expect(snapshot.meta).not.toHaveProperty("pausedAt");
  });
});

// W3: save 兜底容错——run 工作目录被并发清理时 mkdir 抛 ENOENT，save 静默返回。
//
// 防的 bug（PR #166 CI 回归）：review-fix-loop-e2e 等 runAndWait 测试中，
// handleReturn 的 run.transition("done") 同步改 status 后，runAndWait 轮询发现 done
// 并 resolve，测试 afterEach 随即 rmSync 删除 sessionDir；此时 handleReturn 内 in-flight
// 的 await save 尚未完成，mkdir 遇到目录链被并发删除 → ENOENT。原实现 await save 让错误
// 冒泡为 unhandled promise rejection（worker-host onMessage 无 catch），CI exit 1。
// 修复：save 仅容错 ENOENT（run 已终态，状态不再变化，持久化无意义也无法完成）→ silent return；
// 非 ENOENT 错误（EACCES/ENOSPC 等真实磁盘问题）仍重新抛出，不掩盖。
//
// 注：真正的 ENOENT 只在 rmSync 与 mkdir 并发时出现（串行 rmSync 后 mkdir {recursive:true}
// 会重建目录而非抛 ENOENT），故用 mock 直接锁定 save 的容错判定逻辑，不依赖竞态时序复现。
describe("W3: JsonlRunStore.save 兜底容错（run 工作目录被并发清理时的竞态）", () => {
  let tmpDir: string;
  let store: JsonlRunStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-enoent-"));
    store = new JsonlRunStore({ sessionDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    vi.restoreAllMocks();
  });

  it("mkdir 抛 ENOENT（sessionDir 被并发清理）→ save 静默返回，不抛 unhandled rejection（done 终态与 running 首写冷路径同机制）", async () => {
    // done 终态（原 W3）与 running 首写冷路径（原 W2TC5b）同断言：ENOENT 容错与 status 无关
    const spy = vi
      .spyOn(fs.promises, "mkdir")
      .mockRejectedValue(
        Object.assign(new Error("ENOENT: no such file or directory, mkdir"), {
          code: "ENOENT",
        }),
      );
    // run 已终态 + 工作目录消失 → save 放弃持久化，resolve undefined（不抛）
    await expect(store.save(makeRunWithDoneCall())).resolves.toBeUndefined();
    // running 首写冷路径同判（放弃持久化不抛）
    await expect(store.save(makeRunningRun("run-w3-running"))).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it("mkdir 抛非 ENOENT 错误（EACCES）→ save 重新抛出，不掩盖真实磁盘问题", async () => {
    const run = makeRunWithDoneCall();
    const spy = vi
      .spyOn(fs.promises, "mkdir")
      .mockRejectedValueOnce(
        Object.assign(new Error("permission denied"), { code: "EACCES" }),
      );
    await expect(store.save(run)).rejects.toThrow("permission denied");
    expect(spy).toHaveBeenCalled();
  });
});

// ── W4-W8: save 去抖（cw swf-perf wave2，W2TC1-15）──────────────────────
//
// 状态机前提：热路径 = running 中间态且本实例已首写（writtenOnce 已记）→ 进去抖批；
// 冷路径 = 本实例首写（任何 status）或 status !== "running"（done）→ 同步
// flush 绕过 timer。所有用例先做一次冷路径首写 + await 落盘，再进热路径。
//
// fake timers 惯例对齐 lifecycle.test.ts（vi.useFakeTimers + advanceTimersByTimeAsync）；
// writeFile/mkdir 计数用 vi.spyOn 保留原实现（真实落盘，读磁盘断言内容）。

describe("W4: save 去抖（热路径合并 / 冷路径同步 flush）", () => {
  let tmpDir: string;
  let store: JsonlRunStore;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-debounce-"));
    store = new JsonlRunStore({ sessionDir: tmpDir });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("W2TC1: 热路径去抖合并：3 次 save 合并 1 次写盘、内容为 flush 时刻最新状态、零条目写", async () => {
    const entries: CustomEntry[] = [];
    const store1 = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries) });
    const run = makeRunningRun("run-w2tc1");
    // 首写冷路径立即落盘（writtenOnce 记录，热路径前提）
    await store1.save(run);
    const wfSpy = vi.spyOn(fs.promises, "writeFile");

    // 热路径 3 次 save（同一 run 引用 mutate，中间态演进）
    run.state.trace.append(makeTraceNode(1));
    const p1 = store1.save(run);
    run.state.trace.append(makeTraceNode(2));
    const p2 = store1.save(run);
    const p3 = store1.save(run);

    // advance 前：无写盘，文件停留首写状态（1 个节点）——去抖窗口内「崩溃」的
    // 丢失边界 = 最后一次成功 flush（原 W2TC13 断言面并入）
    expect(wfSpy).not.toHaveBeenCalled();
    expect(readStateFile(tmpDir, "run-w2tc1").state.trace).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(200);
    // 3 个 save() Promise 全部 resolved（await 落盘完成——fake timers 不等真实 IO）
    await Promise.all([p1, p2, p3]);
    // N=3 合并 1 次写盘
    expect(wfSpy).toHaveBeenCalledTimes(1);
    // latestRun 语义：写的是 flush 时刻最新聚合状态（node1 + node2 都在）
    const snap = readStateFile(tmpDir, "run-w2tc1");
    const steps = snap.state.trace.map((n) => n.stepIndex);
    expect(steps).toContain(1);
    expect(steps).toContain(2);
    // [W1 / D1] 停写锚定（原 W2TC13 停写面并入）：热批 flush 落投影，条目通道零写
    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(0);
  });

  it("W2TC2: 终态 save 绕过 timer 立即落盘：合并 pending 批 + 取消 timer 无二次写", async () => {
    const run = makeRunningRun("run-w2tc2");
    await store.save(run); // 首写
    const wfSpy = vi.spyOn(fs.promises, "writeFile");

    const p1 = store.save(run); // 热路径批 pending（1 个未 settle Promise）
    run.transition("done", "completed");
    const p2 = store.save(run); // 终态冷路径
    // pending 批（save #1）settlers 并入终态批合并 settle（await 落盘完成）
    await p1;
    await p2;

    // 不 advance（timer 未走）：终态已落盘
    expect(readStateFile(tmpDir, "run-w2tc2").state.status).toBe("done");

    // timer 已取消：advance 后无第二次写，终态内容不被中间态覆盖
    await vi.advanceTimersByTimeAsync(1000);
    expect(wfSpy).toHaveBeenCalledTimes(1);
    expect(readStateFile(tmpDir, "run-w2tc2").state.status).toBe("done");
  });

  it("W2TC3: 冷路径合并 pending 批 settlers 共同 settle——await p4 后 p1-p3 全部 resolved", async () => {
    const run = makeRunningRun("run-w2tc3b");
    await store.save(run);
    const p1 = store.save(run);
    const p2 = store.save(run);
    const p3 = store.save(run);
    run.transition("done", "completed");
    const p4 = store.save(run); // 冷路径合并 p1-p3 的批
    await p4; // 终态写盘完成后 resolve
    // settlers 数组统一 settle，无悬挂 Promise（防 unhandled rejection）
    await Promise.all([p1, p2, p3]);
    expect(readStateFile(tmpDir, "run-w2tc3b").state.status).toBe("done");
  });

  it("W2TC7: 终态冷路径同步 flush：立即落盘（绕过 timer）+ 零条目写（[W1] 停写锚定）", async () => {
    const mockPi = mkPi();
    const store7 = new JsonlRunStore({ sessionDir: tmpDir, pi: mockPi });
    const run = makeRunningRun("run-w2tc7");
    await store7.save(run); // 首写
    expect(mockPi.appendEntry).not.toHaveBeenCalled();

    const pHot = store7.save(run); // 热路径批 pending
    run.transition("done", "completed");
    await store7.save(run); // 终态冷路径

    // 不 advance 立即读磁盘：终态优先持久化（去抖窗口内的崩溃不吞终态）
    expect(readStateFile(tmpDir, "run-w2tc7").state.status).toBe("done");
    // 合并的热路径批 Promise 一并 resolved
    await pHot;
    // [W1 / D1] 停写锚定：全程零 workflow-record entry（恢复权威在 journal，
    // 条目只剩注册 + 终态两条 v2 小条目，写点不在 save 面）
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
    // advance 后无追加写
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });

  it("W2TC8: 首写冷路径（跨 session resume）：本 store 实例首 save 立即落盘投影，零条目写", async () => {
    const mockPi = mkPi();
    const storeA = new JsonlRunStore({ sessionDir: tmpDir, pi: mockPi });
    const run = makeRunningRun("run-w2tc8");

    // 实例 A 首写：status 是 running 也立即落盘（首写判定优先于 status）
    await storeA.save(run);
    expect(readStateFile(tmpDir, "run-w2tc8").state.status).toBe("running");
    expect(mockPi.appendEntry).not.toHaveBeenCalled();

    // 实例 B（另一 session 的 store）对同一 runId 再 save：又是一次实例首写
    const storeB = new JsonlRunStore({ sessionDir: tmpDir, pi: mockPi });
    run.state.trace.append(makeTraceNode(9));
    await storeB.save(run);
    // 停写锚定：跨实例均零条目；state 投影承载最新状态（trace 2 节点）
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
    expect(readStateFile(tmpDir, "run-w2tc8").state.trace).toHaveLength(2);
  });

  it("W2TC15: saveDebounceMs 构造参数可调：短参数窗口生效", async () => {
    const store50 = new JsonlRunStore({ sessionDir: tmpDir, saveDebounceMs: 50 });
    const run = makeRunningRun("run-w2tc15");
    await store50.save(run); // 首写
    const wfSpy = vi.spyOn(fs.promises, "writeFile");

    run.state.trace.append(makeTraceNode(1));
    const p = store50.save(run);
    await vi.advanceTimersByTimeAsync(49);
    expect(wfSpy).not.toHaveBeenCalled(); // 窗口未到
    await vi.advanceTimersByTimeAsync(1);
    await p; // flush 落盘完成
    expect(wfSpy).toHaveBeenCalledTimes(1); // 50ms 参数生效
  });

  it("高频 running flush：零条目写，state 文件每次 flush 照写最新投影（[W1 / D1] 停写锚）", async () => {
    // 原 throttle 件并入：原节流通道（O(n²) 防线）随停写退役——flush 直发（绕开
    // 去抖 timer），fs 真实 IO 不受 fake timers 影响
    const entries: CustomEntry[] = [];
    const storeHi = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries) });
    const run = makeRunningRun("run-w2tc-throttle-hi");

    await storeHi.save(run); // 冷路径首写
    for (let i = 0; i < 10; i++) {
      run.state.trace.append({ stepIndex: i + 1, agent: "a", task: "t", model: "m", status: "pending" });
      const p = storeHi.save(run); // 热路径入去抖批
      await storeHi.flushPendingSaves(); // 直发 flush
      await p;
    }
    // 停写红线：高频 flush 零条目（原节流通道的写点已消除——零是唯一有界值）
    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(0);
    // state 物化投影照写：最终 flush 时刻的最新状态（初始 node0 + 10 个高频节点全量在盘）
    expect(readStateFile(tmpDir, "run-w2tc-throttle-hi").state.trace).toHaveLength(11);
  });

  it("多 run 并发 flush：全部零条目写，各自 state 文件独立落盘（[W1 / D1] 停写锚）", async () => {
    const entries: CustomEntry[] = [];
    const storeMulti = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries) });

    await storeMulti.save(makeRunningRun("run-throttle-a"));
    await storeMulti.save(makeRunningRun("run-throttle-b"));
    const pA = storeMulti.save(makeRunningRun("run-throttle-a"));
    const pB = storeMulti.save(makeRunningRun("run-throttle-b"));
    await storeMulti.flushPendingSaves();
    await Promise.all([pA, pB]);

    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(0);
    expect(readStateFile(tmpDir, "run-throttle-a").state.status).toBe("running");
    expect(readStateFile(tmpDir, "run-throttle-b").state.status).toBe("running");
  });
});

describe("W5: 批 settle 与 IO 错误语义", () => {
  let tmpDir: string;
  let store: JsonlRunStore;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-ioerr-"));
    store = new JsonlRunStore({ sessionDir: tmpDir });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("W2TC4: flush IO 错误 reject 批内全部调用 + 失败不粘滞（下一 save 开新批）", async () => {
    const run = makeRunningRun("run-w2tc4");
    await store.save(run); // 首写
    vi.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );

    const p1 = store.save(run);
    const p2 = store.save(run); // 同批两次调用
    await vi.advanceTimersByTimeAsync(200);
    // 批内全部 Promise rejects 同一错误（EACCES 消息传播）
    await expect(p1).rejects.toThrow("permission denied");
    await expect(p2).rejects.toThrow("permission denied");

    // 失败不粘滞：pending Map 条目已清除，下一 save 开新批正常 flush 成功
    //（含失败后的中间态演进内容——原 W2TC11b「链上前序失败不传染后续批」断言并入）
    run.state.trace.append(makeTraceNode(1));
    const p3 = store.save(run);
    await vi.advanceTimersByTimeAsync(200);
    await p3;
    expect(readStateFile(tmpDir, "run-w2tc4").state.status).toBe("running");
    expect(readStateFile(tmpDir, "run-w2tc4").state.trace).toHaveLength(2);
  });

  it("W2TC4(ES9): 首写失败回滚 writtenOnce——running 中间态 save 重走冷路径补写投影", async () => {
    const mockPi = mkPi();
    const store4 = new JsonlRunStore({ sessionDir: tmpDir, pi: mockPi });
    const run = makeRunningRun("run-w2tc4b");

    // 首写冷路径遇 writeFile EACCES reject（state 投影未落）。[W1] 条目通道已停写，
    // 回滚语义收敛为「下次 save 重走冷路径立即重试投影写」。
    vi.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    await expect(store4.save(run)).rejects.toThrow("permission denied");
    expect(mockPi.appendEntry).not.toHaveBeenCalled(); // 停写锚定：失败路径亦零条目

    // 恢复 IO 后 running 中间态 save：不经 timer 立即落盘（首写资格已回滚，冷路径重写）
    const p = store4.save(run);
    await p; // 冷路径同步 flush 完成
    expect(readStateFile(tmpDir, "run-w2tc4b").state.status).toBe("running");
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });

  it("W2TC5: ENOENT 静默语义保留——热路径去抖批 mkdir ENOENT resolve 全部批 Promise", async () => {
    const run = makeRunningRun("run-w2tc5");
    await store.save(run); // 首写
    vi.spyOn(fs.promises, "mkdir").mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file or directory, mkdir"), {
        code: "ENOENT",
      }),
    );

    const p1 = store.save(run); // 热路径批 pending
    await vi.advanceTimersByTimeAsync(200);
    await p1; // resolved（不抛 unhandled rejection）
    // 无新写入：内容停留首写状态
    expect(readStateFile(tmpDir, "run-w2tc5").state.trace).toHaveLength(1);
  });
});

describe("W6: flush 次数与停写锚定（save 级不放大）", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-ptr-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("W2TC6(W1): flush 计数 = 去抖批合并（N save → 1 flush）、全程零条目写、终态投影含 done", async () => {
    const mockPi = mkPi();
    const store6 = new JsonlRunStore({ sessionDir: tmpDir, pi: mockPi });
    const run = makeRunningRun("run-w2tc6");
    const wfSpy = vi.spyOn(fs.promises, "writeFile");

    // 创建首写 flush → 1 次写盘
    await store6.save(run);
    expect(wfSpy).toHaveBeenCalledTimes(1);

    // 3 轮 running 中间态：每轮窗口内 2 次 save（热路径批合并）→ 各 1 次 flush
    for (let i = 1; i <= 3; i++) {
      run.state.trace.append(makeTraceNode(i));
      const p1 = store6.save(run);
      const p2 = store6.save(run);
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all([p1, p2]);
    }
    expect(wfSpy).toHaveBeenCalledTimes(4); // save 级不放大（2 save → 1 flush）

    // done 终态 flush → 1 次写盘，投影携带终态
    run.transition("done", "completed");
    await store6.save(run);
    expect(wfSpy).toHaveBeenCalledTimes(5);
    expect(readStateFile(tmpDir, "run-w2tc6").state.status).toBe("done");
    // [W1 / D1] 停写锚定：全程零 workflow-record entry
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });
});

describe("W7: flushPendingSaves / dispose / 串行链", () => {
  let tmpDir: string;
  let store: JsonlRunStore;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-dispose-"));
    store = new JsonlRunStore({ sessionDir: tmpDir });
    loggerMock.debug.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("W2TC9: flushPendingSaves 立即刷全部 pending 批且 store 保持可用", async () => {
    const runA = makeRunningRun("run-w2tc9a");
    const runB = makeRunningRun("run-w2tc9b");
    await store.save(runA);
    await store.save(runB); // 两 runId 首写

    const pa = store.save(runA); // 两批独立 pending
    runB.state.trace.append(makeTraceNode(1));
    const pb = store.save(runB);

    await store.flushPendingSaves(); // 不 advance 直接刷
    expect(readStateFile(tmpDir, "run-w2tc9a").state.status).toBe("running");
    expect(readStateFile(tmpDir, "run-w2tc9b").state.trace).toHaveLength(2);
    await Promise.all([pa, pb]); // 两批 save Promise 全部 resolved

    // store 保持可用：后续 save 正常进入新去抖批
    const pa2 = store.save(runA);
    await vi.advanceTimersByTimeAsync(200);
    await pa2;
  });

  it("W2TC10: dispose 刷 pending + 停 timer + 幂等 + dispose 后 save 静默 no-op + debug 日志", async () => {
    const run = makeRunningRun("run-w2tc10");
    await store.save(run); // 首写
    const wfSpy = vi.spyOn(fs.promises, "writeFile");
    const pHot = store.save(run); // 热路径批 pending
    wfSpy.mockClear(); // 清零基准

    const d1 = store.dispose();
    const d2 = store.dispose(); // 并发交叠第二次
    expect(d1).toBe(d2); // 同一 Promise 引用（dispose 缓存自身 Promise，幂等）
    await Promise.all([d1, d2]);
    await pHot; // pending 批已刷、settled

    expect(wfSpy).toHaveBeenCalledTimes(1); // 第二次 dispose 不重复刷（清零基准 === 1）
    const d3 = store.dispose(); // 串行第三次
    expect(d3).toBe(d1); // 返回同一已 resolve 的 Promise
    await d3;

    // timer 清除：advance 后无追加写
    await vi.advanceTimersByTimeAsync(1000);
    expect(wfSpy).toHaveBeenCalledTimes(1);

    // dispose 后 save 返回 resolved Promise 且不写盘（静默 no-op）
    run.transition("done", "completed");
    await expect(store.save(run)).resolves.toBeUndefined();
    expect(wfSpy).toHaveBeenCalledTimes(1);

    // debug 日志留痕（R5 断言锚点：含 runId，不外抛）
    expect(loggerMock.debug).toHaveBeenCalled();
    const debugDump = loggerMock.debug.mock.calls.map((c) => String(c[0])).join("\n");
    expect(debugDump).toContain("run-w2tc10");
  });

  it("W2TC10b: dispose 进行中（pending flush 未落定）新 save 立即被拦截（disposed 同步置位先于 flush 收集）", async () => {
    const run = makeRunningRun("run-w2tc10b");
    await store.save(run); // 首写
    // 时序控制：dispose 收批 flush 的 writeFile 挂 gate（dispose 久久不 settle）
    vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
    let gateResolve!: () => void;
    const gate = new Promise<void>((r) => {
      gateResolve = r;
    });
    const wfSpy = vi.spyOn(fs.promises, "writeFile");
    wfSpy.mockImplementationOnce(() => gate);

    run.state.trace.append(makeTraceNode(1));
    const pHot = store.save(run); // 热批 pending
    const d = store.dispose(); // 同步段：disposed=true → flushPendingSaves 收批挂链；flush#1 在 gate 上挂起

    // dispose 窗口内（d 未 settle）迟到 save：disposed 已置位 → R5 静默 no-op，
    // 不产生第二次写盘（折叠前内联实现同等时序）
    run.transition("done", "completed");
    await expect(store.save(run)).resolves.toBeUndefined();
    expect(wfSpy).toHaveBeenCalledTimes(1); // 仅 dispose 收批的那次 flush 在写

    gateResolve();
    await d;
    await pHot; // 收批 settlers（含热批）settle
    expect(wfSpy).toHaveBeenCalledTimes(1); // 窗口内 save 未追加写
    expect(readStateFile(tmpDir, "run-w2tc10b").state.status).toBe("running");
  });

  it("W2TC11: per-runId 串行 flush 链——前一 flush in-flight 时后续 flush 排队，无并发 writeFile", async () => {
    const run = makeRunningRun("run-w2tc11");
    await store.save(run); // 首写
    // mkdir 立即 resolve：时序控制点收敛到 writeFile（真实 mkdir 的 IO 完成时机
    // 不受 fake timers 管，会挡住 writeFile 的调用观察）
    vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
    const wfSpy = vi.spyOn(fs.promises, "writeFile");

    // 第一次 writeFile 调用返回手动 gate 控制的 pending Promise，之后恢复原实现
    let gateResolve!: () => void;
    const gate = new Promise<void>((r) => {
      gateResolve = r;
    });
    wfSpy.mockImplementationOnce(() => gate);

    run.state.trace.append(makeTraceNode(1));
    const p1 = store.save(run); // save#1
    await vi.advanceTimersByTimeAsync(200); // flush#1 触发，writeFile#1 挂起
    expect(wfSpy).toHaveBeenCalledTimes(1);

    run.state.trace.append(makeTraceNode(2));
    const p2 = store.save(run); // save#2 新批
    await vi.advanceTimersByTimeAsync(200); // flush#2 timer 到点，排队等待 flush#1
    expect(wfSpy).toHaveBeenCalledTimes(1); // writeFile 仅 1 次（无并发）

    gateResolve(); // 释放 flush#1
    await p1;
    await p2; // flush#2 在 flush#1 完成后顺序执行
    expect(wfSpy).toHaveBeenCalledTimes(2);
    // flush#2 落盘 save#2 时刻的最新状态
    expect(readStateFile(tmpDir, "run-w2tc11").state.trace).toHaveLength(3);
  });

  it("W2TC14: 不同 runId 批互不阻塞：并发 workflow 各自独立去抖", async () => {
    const runA = makeRunningRun("run-w2tc14a");
    const runB = makeRunningRun("run-w2tc14b");
    await store.save(runA);
    await store.save(runB); // 两 runId 首写

    // runA 的 writeFile 挂 gate（慢 IO），其他路径（runB）正常；mkdir 立即 resolve
    //（时序控制点收敛到 writeFile，真实 mkdir 的 IO 完成不受 fake timers 管）
    vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    const pathA = path.join(tmpDir, "workflow-state", "run-w2tc14a.jsonl");
    let gateResolve!: () => void;
    const gate = new Promise<void>((r) => {
      gateResolve = r;
    });
    vi.spyOn(fs.promises, "writeFile").mockImplementation(
      (p: unknown, ...rest: unknown[]) =>
        String(p) === pathA
          ? gate.then(() =>
              (realWriteFile as (p: unknown, ...r: unknown[]) => Promise<void>)(p, ...rest),
            )
          : (realWriteFile as (p: unknown, ...r: unknown[]) => Promise<void>)(p, ...rest),
    );

    const pa = store.save(runA); // runA 批
    runA.state.trace.append(makeTraceNode(1)); // 中间态演进（serialize-at-flush）
    runB.state.trace.append(makeTraceNode(1));
    const pb = store.save(runB); // runB 批
    await vi.advanceTimersByTimeAsync(200);
    await pb; // runB 真实写盘完成

    // runA flush 挂起中，runB 已落盘（无全局锁，per-runId 独立链）
    expect(readStateFile(tmpDir, "run-w2tc14b").state.trace).toHaveLength(2);
    // runA 文件停留首写状态（热批被 gate 挂起未写入）
    expect(readStateFile(tmpDir, "run-w2tc14a").state.trace).toHaveLength(1);

    gateResolve(); // 释放 runA
    await pa;
    expect(readStateFile(tmpDir, "run-w2tc14a").state.trace).toHaveLength(2);
  });
});

describe("W8: 去抖窗口崩溃语义与 timer unref", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-crash-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("W2TC12: 去抖 timer 必须 unref（不钉住 extension 进程）", async () => {
    const fakeTimer = { unref: vi.fn(), ref: vi.fn() };
    const setTimeoutSpy = vi.fn(() => fakeTimer);
    const clearTimeoutSpy = vi.fn();
    vi.stubGlobal("setTimeout", setTimeoutSpy);
    vi.stubGlobal("clearTimeout", clearTimeoutSpy);

    const run = makeRunningRun("run-w2tc12");
    // 全程用同一 store50 实例：首写必须落在 store50 上（writtenOnce 是 per-instance，
    // 用另一个实例首写会让本实例的 save 走冷路径，测不到建批 timer）
    const store50 = new JsonlRunStore({ sessionDir: tmpDir, saveDebounceMs: 50 });
    await store50.save(run); // 首写冷路径：不经 timer
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    const p = store50.save(run); // 热路径建批
    // setTimeout 以构造参数 50 被调用，返回的 timer unref() 恰 1 次
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 50);
    expect(fakeTimer.unref).toHaveBeenCalledTimes(1);

    void store50.save(run); // 并入已有批：不重复创建 timer
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    // 不 advance（timer 是 stub 假对象永不触发）；save Promise 由 store 实例持有，
    // tmpDir 随 afterEach 清理，无悬挂写盘
    void p;
  });
});

// ── W17/W1: workflow-record 条目面（[W1 / D1] v1 停写 + v2 注册/终态两写点读面）──
//
// [W1] 介质归位后形态：壳 save 零条目写（v1 全量快照停写）；主 session 条目只剩
// 注册（core lifecycle 写）+ 终态（core finalizeRun 写 / 壳 loadAll 幂等补写）两条
// v2 小条目；v1 快照 entry 与旧 link 指针保留为兼容读层（D7，夹具喂入）。

describe("W17/W1: workflow-record 条目面（v1 停写锚定 + v2 收编读面）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-w17-"));
    loggerMock.warn.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("customType 常量字面量钉住：WORKFLOW_RECORD_CUSTOM_TYPE === 'workflow-record'", () => {
    // 写点引用常量（单源）；本断言钉住常量与消费方（W18 runtime extractor）约定的
    // 字面量拼写，防重命名漂移后静默丢重建。
    expect(WORKFLOW_RECORD_CUSTOM_TYPE).toBe("workflow-record");
  });

  it("[W1 停写锚定] save（running → done 全程）零 workflow-record entry；state 投影承载终态", async () => {
    const entries: CustomEntry[] = [];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries) });
    const run = makeRunningRun("run-w17-shape");
    await store.save(run);
    run.transition("done", "completed");
    await store.save(run);

    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(0);
    expect(readStateFile(tmpDir, "run-w17-shape").state.status).toBe("done");
  });

  it("终态 flush：零条目写，state 投影携带终态（恢复权威在 journal，state 是投影）", async () => {
    const entries: CustomEntry[] = [];
    const storeT = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries) });
    const runId = "run-w17-terminal-flush";

    await storeT.save(makeRunningRun(runId));
    const pHot = storeT.save(makeRunningRun(runId)); // 热路径入去抖批
    await storeT.flushPendingSaves(); // 直发 flush（绕开去抖 timer）
    await pHot;
    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(0);

    await storeT.save(makeRunningRun(runId, "done", "completed"));
    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(0);
    expect(readStateFile(tmpDir, runId).state.status).toBe("done");
  });

  it("[D4 接管] store rebind 后 v2 终态条目补写走新 pi（旧 pi 不再收 entry）", async () => {
    const entriesOld: CustomEntry[] = [];
    const entriesNew: CustomEntry[] = [];
    const runId = "run-w17-rebind";
    // v2 收编面夹具：注册条目 + journal 已终局（终态条目缺失 → loadAll 幂等补写）
    const journalPath = path.join(tmpDir, "workflow-state", `${runId}.events.jsonl`);
    appendJournalLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    appendJournalLine(tmpDir, runId, { type: "run-settled", outcome: "completed", artifactsDir: tmpDir, ts: 2000, seq: 2 });
    const seedEntries: CustomEntry[] = [v2RegisteredEntry(runId, journalPath)];

    const store = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mkPi(entriesOld),
      ctx: mkCtx(seedEntries),
    });
    // rebind 换源：条目补写面路由到新 pi
    store.rebind(mkPi(entriesNew), mkCtx(seedEntries));

    const loaded = await store.loadAll();
    expect(loaded[0]?.state.status).toBe("done");
    expect(loaded[0]?.state.reason).toBe("completed");

    // 补写落新 pi：seed 注册之外恰 1 条终态条目（kind: settled）
    const wfNew = entriesNew.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE);
    expect(wfNew).toHaveLength(1);
    expect((wfNew[0]!.data as { kind?: string }).kind).toBe("settled");
    // 旧 pi 不再收 entry（appendEntry 源已换新）
    expect(entriesOld).toHaveLength(0);
  });

  it("[W1 journal 权威] state 文件删除后 loadAll 仍从 journal 重建（journal 唯一事实源证明）", async () => {
    const runId = "run-w1-journal";
    const journalPath = path.join(tmpDir, "workflow-state", `${runId}.events.jsonl`);
    appendJournalLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    appendJournalLine(tmpDir, runId, { type: "ask-settled", taskIndex: 0, attempt: 1, outcome: "completed", durationMs: 5, ts: 2000, seq: 2 });
    appendJournalLine(tmpDir, runId, { type: "run-settled", outcome: "completed", artifactsDir: tmpDir, ts: 3000, seq: 3 });
    // state 文件预先存在后删除（模拟缓存清理/丢失）——journal 是唯一残留事实源
    fs.writeFileSync(path.join(tmpDir, "workflow-state", `${runId}.jsonl`), "{}\n", "utf8");
    fs.rmSync(path.join(tmpDir, "workflow-state", `${runId}.jsonl`));

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, journalPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.runId).toBe(runId);
    expect(loaded[0]!.state.status).toBe("done");
    expect(loaded[0]!.state.reason).toBe("completed");
    // 终态条目缺失 → 幂等补写恰 1 条（收编条目半边）；载荷与 core finalizeRun 同构
    const settledEntries = entries.filter(
      (e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE && (e.data as { kind?: string }).kind === "settled",
    );
    expect(settledEntries).toHaveLength(1);
    const data = settledEntries[0]!.data as Record<string, unknown>;
    expect(data["v"]).toBe(WORKFLOW_RECORD_ENTRY_VERSION);
    expect(data["kind"]).toBe("settled");
    expect(data["runId"]).toBe(runId);
    expect(data["status"]).toBe("done");
    expect(data["outcome"]).toBe("completed");
    expect(data["reason"]).toBe("completed");
    expect(data["settledAt"]).toBe(3000);
    expect(data["callCount"]).toBe(1); // journal ask-settled 帧数投影
  });

  it("[W1 收编幂等] 终态条目已在 → 补写跳过；双重启 loadAll 不重复追加", async () => {
    const runId = "run-w1-idem";
    const journalPath = path.join(tmpDir, "workflow-state", `${runId}.events.jsonl`);
    appendJournalLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    appendJournalLine(tmpDir, runId, { type: "run-settled", outcome: "failed", errorCode: "engine_crashed", reason: "boom", artifactsDir: tmpDir, ts: 3000, seq: 2 });

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, journalPath), v2SettledEntry(runId)];
    const storeA = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await storeA.loadAll();
    expect(loaded[0]!.state.status).toBe("done");
    expect(loaded[0]!.state.reason).toBe("failed");
    expect(loaded[0]!.state.error).toBe("boom");
    // 条目已在：不追加（数量不变）
    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(2);

    // 第二次启动（新 store 实例读同一 session 面）：仍恰 2 条，零重复追加
    const storeB = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    await storeB.loadAll();
    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(2);
  });

  it("[W1 非终局不补写] journal 无 run-settled → running 交恢复链，零条目追加", async () => {
    const runId = "run-w1-running";
    const journalPath = path.join(tmpDir, "workflow-state", `${runId}.events.jsonl`);
    appendJournalLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    appendJournalLine(tmpDir, runId, { type: "ask-settled", taskIndex: 0, attempt: 1, outcome: "completed", durationMs: 5, ts: 2000, seq: 2 });

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, journalPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.state.status).toBe("running");
    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(1);
  });

  it("[W1 坏行宽容收编] journal 中部坏行 → 跳过 + warn 计数，重建不受阻", async () => {
    const runId = "run-w1-badline";
    const journalPath = path.join(tmpDir, "workflow-state", `${runId}.events.jsonl`);
    appendJournalLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    fs.appendFileSync(journalPath, "{truncated-not-json\n", "utf8"); // 中部坏行
    appendJournalLine(tmpDir, runId, { type: "run-settled", outcome: "completed", artifactsDir: tmpDir, ts: 3000, seq: 2 });

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, journalPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.state.status).toBe("done"); // run-settled 帧可解析即终态（与坏行位置无关）
    expect(loggerMock.warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("bad journal line");
  });

  it("[W1 中断收编] 注册条目指向缺失 journal 且无终态条目 → degraded running 重建交恢复链", async () => {
    const runId = "run-w1-missing";
    const entries: CustomEntry[] = [
      v2RegisteredEntry(runId, path.join(tmpDir, "workflow-state", `${runId}.events.jsonl`)),
    ];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    // 设计 §3.1 失败路径样例「全文件不可解析 → 该 run 按中断收编」：静默跳过会让
    // 该实体对恢复链与 abandon 扫描全部不可见（adoptInterruptedRun 对空 journal
    // 返回 skippedMissing）——degraded running 基线交恢复链收编（journal
    // run-settled 追加归恢复链；空流撞 created × run-settled 表外转移时由其围栏
    // 降级 state 快照面收编）。
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.runId).toBe(runId);
    expect(loaded[0]!.state.status).toBe("running");
    expect(loggerMock.warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(runId);
  });

  it("[W1 双面证据·条目在] journal 空/缺 + 终态条目在 → 跳过不重建（条目即终局证据）", async () => {
    const runId = "run-w1-missing-settled";
    const entries: CustomEntry[] = [
      v2RegisteredEntry(runId, path.join(tmpDir, "workflow-state", `${runId}.events.jsonl`)),
      v2SettledEntry(runId),
    ];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    // 终态条目在 = 非 interrupted 先在证据（D4 双面证据条目面）→ 不重建不收编
    //（journal 已被保留窗口清理的终态 run 同形态——呈现面归条目读者）
    await expect(store.loadAll()).resolves.toEqual([]);
    expect(loggerMock.warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("settled entry present");
  });

  it("[W1 双面证据·终局帧损坏] journal 终局帧不可解析 + 终态条目在 → 按条目终局重建 done，不追加第二条 settled 条目", async () => {
    const runId = "run-w1-settled-entry-final";
    const journalPath = path.join(tmpDir, "workflow-state", `${runId}.events.jsonl`);
    appendJournalLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    // 终局帧损坏而其余行可解析：fold 停在 dispatched——交恢复链会追加
    // run-settled(failed) 与第二条 settled(failed) 条目，与既有 done 条目构成
    // D4 明文要防的两记录面矛盾（last-wins 读者显示 failed 覆盖 done）
    fs.appendFileSync(journalPath, '{"type":"run-settled","outcome":"compl\n', "utf8");

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, journalPath), v2SettledEntry(runId)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.state.status).toBe("done");
    expect(loaded[0]!.state.reason).toBe("completed"); // 终局语义以先在条目证据为准
    // 条目数量不变（2）——不追加第二条 settled 条目
    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(2);
  });

  it("[W1 分流] 混合会话：v1 夹具实体（终局调和）与 v2 实体（journal 权威）同批重建互不干扰", async () => {
    // v1 实体：running entry + journal 终局帧 → 兼容层调和 adopted
    const v1RunId = "run-mix-v1";
    appendJournalLine(tmpDir, v1RunId, { type: "run-settled", outcome: "completed", artifactsDir: tmpDir, ts: 500, seq: 9 });
    // v2 实体：注册条目 + journal 终局 → journal 权威重建
    const v2RunId = "run-mix-v2";
    const v2Journal = path.join(tmpDir, "workflow-state", `${v2RunId}.events.jsonl`);
    appendJournalLine(tmpDir, v2RunId, { type: "run-created", runId: v2RunId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    appendJournalLine(tmpDir, v2RunId, { type: "run-settled", outcome: "failed", reason: "boom", artifactsDir: tmpDir, ts: 2000, seq: 2 });

    const entries: CustomEntry[] = [
      v1RecordEntry(makeRunningRun(v1RunId)),
      v2RegisteredEntry(v2RunId, v2Journal),
    ];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    const byId = new Map(loaded.map((r) => [r.runId, r]));
    expect(loaded).toHaveLength(2);
    expect(byId.get(v1RunId)?.state.status).toBe("done"); // v1 兼容层调和
    expect(byId.get(v1RunId)?.state.reason).toBe("completed");
    expect(byId.get(v2RunId)?.state.status).toBe("done"); // v2 journal 权威
    expect(byId.get(v2RunId)?.state.reason).toBe("failed");
  });

  it("旧 link 兼容用例：存量 session（workflow-state-link + state 文件，无 workflow-record entry）→ loadAll 经 link 重建", async () => {
    // 存量形态构造：旧版扩展（无 pi 注入路径）只落 state 文件，session JSONL 里有 link 指针
    const storeA = new JsonlRunStore({ sessionDir: tmpDir });
    await storeA.save(makeRunWithDoneCall());
    const filePath = path.join(tmpDir, "workflow-state", "run-test-001.jsonl");
    expect(fs.existsSync(filePath)).toBe(true);

    const entries: CustomEntry[] = [
      {
        type: "custom",
        customType: "workflow-state-link",
        data: { runId: "run-test-001", path: filePath },
        id: "seed-pointer",
        parentId: null,
        timestamp: new Date().toISOString(),
      },
    ];
    const storeB = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await storeB.loadAll();
    expect(loaded).toHaveLength(1); // 存量 run 不静默丢失（#9）
    expect(loaded[0]!.state.calls.get(0)!.sessionFile).toBe(
      "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
    );
  });

  it("[W1 v1 兼容层] 同 runId 既有 v1 快照 entry 又有旧 link（state 文件为旧 running 快照）→ entry 终态胜出", async () => {
    const runDone = makeRunningRun("run-w17-prio");
    runDone.transition("done", "completed");
    const runRunning = makeRunningRun("run-w17-prio");
    const seedEntries: CustomEntry[] = [
      v1RecordEntry(runRunning), // entry 1（running）
      v1RecordEntry(runDone), // entry 2（done）
    ];

    // 把 state 文件写为旧 running 快照（从 entry 1 提取完整快照），并 seed 旧 link 指针
    const filePath = path.join(tmpDir, "workflow-state", "run-w17-prio.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(asRecordData(seedEntries[0]!.data).snapshot) + "\n",
      "utf8",
    );
    seedEntries.push({
      type: "custom",
      customType: "workflow-state-link",
      data: { runId: "run-w17-prio", path: filePath },
      id: "seed-pointer",
      parentId: null,
      timestamp: new Date().toISOString(),
    });

    const storeB = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(seedEntries) });
    const loaded = await storeB.loadAll();
    expect(loaded).toHaveLength(1);
    // entry 最后一条（done）胜出——不被 link 指向的旧 state 文件（running）回退
    expect(loaded[0]!.state.status).toBe("done");
  });

  it("entry 形态守卫：v2 但 kind 不在词表（半写/漂移）→ 静默跳过不崩（对齐 future-v 的不猜测解析）", async () => {
    const entries: CustomEntry[] = [
      {
        type: "custom",
        customType: WORKFLOW_RECORD_CUSTOM_TYPE,
        data: { v: WORKFLOW_RECORD_ENTRY_VERSION, kind: "migrated" },
        id: "seed-unknown-kind",
        parentId: null,
        timestamp: new Date().toISOString(),
      },
    ];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    await expect(store.loadAll()).resolves.toEqual([]);
  });
});

// ── ⛔5 golden：codec 切换字节锚（自 snapshot-codec 件并入）─────────────────
//
// golden 行 = 切换前本地 serializeRun 对 done run 的真实落盘字节（改造前经临时探针
// 采集，fixture 与 makeDoneRunWithLive 同一构造；[H2 W3] live 字段随 ExecutionTraceNode
// 类型退役，构造不再 attach——golden 行本就无 live 键，字节不变）。切 codec 后此字节
// 必须不变（版本衔接 D4 裁决①：pi 存量逐字节可读）。

/** golden 行（单行 JSON，键序即 serializeRun 对象字面量序）。 */
const GOLDEN_SNAPSHOT_LINE =
  '{"v":"wf-run-v2","runId":"wf-golden-noref","spec":{"scriptSource":"module.exports = async () => {};","args":{"topic":"demo"},"scriptName":"test-script","scriptPath":"/tmp/test.js","description":"test"},"state":{"status":"done","reason":"completed","budget":{"maxTokens":4096,"maxCost":1.5,"maxTimeMs":60000,"usedTokens":4321,"usedCost":0.42,"totalCallCount":3},"calls":[{"id":0,"opts":{"prompt":"task","agent":"worker","cwd":"/tmp"},"status":"done","attempts":1,"result":{"content":"done","sessionId":"session-abc","sessionFile":"/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl"},"sessionId":"session-abc","sessionFile":"/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl","traceNode":{"stepIndex":0,"agent":"worker","task":"do thing","model":"default","status":"completed","startedAt":"2026-08-30T00:00:01.000Z","completedAt":"2026-08-30T00:00:02.000Z","sessionId":"session-abc","sessionFile":"/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl"}}],"trace":[{"stepIndex":0,"agent":"worker","task":"do thing","model":"default","status":"completed","startedAt":"2026-08-30T00:00:01.000Z","completedAt":"2026-08-30T00:00:02.000Z","sessionId":"session-abc","sessionFile":"/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl"}],"errorLogs":[{"level":"warn","message":"worker retry 1"}],"scriptResult":{"ok":true}},"meta":{"startedAt":"2026-08-30T00:00:00.000Z","completedAt":"2026-08-30T00:00:03.000Z","workerErrorCount":1,"scriptErrorCount":0}}';

function makeCodecSpec(withBudgetRef: boolean): RunSpec {
  const spec: RunSpec = {
    scriptSource: "module.exports = async () => {};",
    args: { topic: "demo" },
    ...(withBudgetRef ? { budgetRef: new Budget({ maxTokens: 999 }) } : {}),
    scriptName: "test-script",
    scriptPath: "/tmp/test.js",
    description: "test",
  };
  return spec;
}

/**
 * done run（calls 带 result/sessionId/sessionFile，budget 全字段）。
 * [H2 W3] 原「含 live 字段」构造随 ExecutionTraceNode.live 字段退役删除——节点
 * 不再携带运行期附属对象（设计 D2），golden 行（本就无 live 键）字节不变。
 */
function makeDoneRunWithLive(runId: string, withBudgetRef: boolean): WorkflowRun {
  const sessionFile = "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl";
  const node = {
    stepIndex: 0,
    agent: "worker",
    task: "do thing",
    model: "default",
    status: "completed" as const,
    startedAt: "2026-08-30T00:00:01.000Z",
    completedAt: "2026-08-30T00:00:02.000Z",
    sessionId: "session-abc",
    sessionFile,
  };
  const trace = new Trace();
  trace.append(node);
  const call = new AgentCall(0, { prompt: "task", agent: "worker", cwd: "/tmp" }, node);
  call.markRunning();
  call.markDone({ content: "done", sessionId: "session-abc", sessionFile });
  call.setSessionId("session-abc");
  call.setSessionFile(sessionFile);

  return WorkflowRun.reconstruct(
    runId,
    makeCodecSpec(withBudgetRef),
    {
      status: "done",
      reason: "completed",
      budget: new Budget({
        maxTokens: 4096,
        maxCost: 1.5,
        maxTimeMs: 60000,
        usedTokens: 4321,
        usedCost: 0.42,
        totalCallCount: 3,
      }),
      calls: new Map([[0, call]]),
      trace,
      errorLogs: [{ level: "warn", message: "worker retry 1" }],
      scriptResult: { ok: true },
    },
    {
      startedAt: "2026-08-30T00:00:00.000Z",
      completedAt: "2026-08-30T00:00:03.000Z",
      workerErrorCount: 1,
      scriptErrorCount: 0,
    },
  );
}

function readStateLine(tmpDir: string, runId: string): string {
  return fs
    .readFileSync(path.join(tmpDir, "workflow-state", `${runId}.jsonl`), "utf8")
    .trim();
}

describe("⛔5: 快照往返与实施前逐字节一致（codec 切换 D4）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-codec-golden-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("done run 落盘行 === 改造前 serializeRun golden 字节（[H2 W3] 节点无 live 字段）", async () => {
    const entries: CustomEntry[] = [];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries) });

    await store.save(makeDoneRunWithLive("wf-golden-noref", false));

    expect(readStateLine(tmpDir, "wf-golden-noref")).toBe(GOLDEN_SNAPSHOT_LINE);
  });

  it("spec.budgetRef 剔除（codec 单源裁决的投影差异）：落盘 = 无 budgetRef 同构形态", async () => {
    // 嵌套 run 的 spec.budgetRef 是进程内共享引用（非持久化数据）——codec 剔除后
    // 落盘字节 = 同 run 去 budgetRef 形态（仅 runId 不同）。钉住防无意回退。
    const entries: CustomEntry[] = [];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries) });

    await store.save(makeDoneRunWithLive("wf-golden-ref", true));

    const goldenWithRefStripped = GOLDEN_SNAPSHOT_LINE.replace(
      '"runId":"wf-golden-noref"',
      '"runId":"wf-golden-ref"',
    );
    expect(readStateLine(tmpDir, "wf-golden-ref")).toBe(goldenWithRefStripped);
    const parsed: unknown = JSON.parse(readStateLine(tmpDir, "wf-golden-ref"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const spec = (parsed as { spec: Record<string, unknown> }).spec;
    expect("budgetRef" in spec).toBe(false);
  });
});

// ── D4 投影重发保序（自 adoption 件并入——被测对象是 JsonlRunStore 串行链）────

describe("D4 投影重发保序：窗口内终态 → state 投影终态收敛（[W1] 条目通道退役后投影即持久化面）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("窗口内终态：adoption 重发后 state 投影收敛终态 + journal 权威读回终态 + 终态条目补写落新 pi", async () => {
    const entriesNew: CustomEntry[] = [];
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-adopt-order-"));
    try {
      const runId = "wf-order-1";
      // v2 收编面夹具：注册条目 + journal 已终局（loadAll 读回终态的证据源）。
      // 帧时间戳用近期值——后续 save 触发的 retention sweep（D5 判据①）只裁
      // 「终态超窗」足迹，远古时间戳会被误判超窗裁掉（测试夹具语义 = 窗口内存活）。
      const journalPath = path.join(sessionDir, "workflow-state", `${runId}.events.jsonl`);
      appendJournalLine(sessionDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: Date.now() - 60_000, seq: 1 });
      appendJournalLine(sessionDir, runId, { type: "run-settled", outcome: "completed", artifactsDir: sessionDir, ts: Date.now() - 30_000, seq: 2 });
      const seedEntries: CustomEntry[] = [v2RegisteredEntry(runId, journalPath)];

      const store = new JsonlRunStore({
        sessionDir,
        pi: mkPi([]),
        ctx: mkCtx(seedEntries),
      });
      const run = makeRunningRun(runId);
      await store.save(run); // 窗口内首写（running 投影落盘）
      // 窗口内终态：内存对象变终态
      run.transition("done", "completed");

      // adoption：rebind（新 pi + stale guard）+ 投影重发（经串行链）
      const piNew = mkPi(entriesNew);
      store.rebind(piNew, mkCtx(seedEntries));
      await store.resendSnapshots(new Map([[run.runId, run]]));

      // 终态是该 runId 投影的最后一次写盘内容（绕链并发写会物理乱序，走链后链内闭合）
      expect(readStateFile(sessionDir, runId).state.status).toBe("done");
      // last-ways 读回终态（崩溃恢复不误判的反向证明）+ 终态条目幂等补写恰 1 条落新 pi
      const restored = await store.loadAll();
      expect(restored.find((r) => r.runId === runId)?.state.status).toBe("done");
      expect(restored.find((r) => r.runId === runId)?.state.reason).toBe("completed");
      const wfNew = entriesNew.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE);
      expect(wfNew).toHaveLength(1);
      expect((wfNew[0]!.data as { kind?: string }).kind).toBe("settled");
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("in-flight 去抖批与重发同链竞争：done 恒为 state 投影的最后落盘形态（done 之后无更旧状态）", async () => {
    const entriesOld: CustomEntry[] = [];
    const entriesNew: CustomEntry[] = [];
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-adopt-order2-"));
    try {
      const store = new JsonlRunStore({
        sessionDir,
        pi: mkPi(entriesOld),
        ctx: mkCtx([]),
        saveDebounceMs: 200,
      });
      const run = makeRunningRun("wf-order-2");
      await store.save(run); // 冷路径：running 投影落盘
      const pHot = store.save(run); // 热路径并入去抖批（timer 未推进）

      // reload 窗口：rebind + 两次投影重发（重发#1 时 run 尚 running，随后窗口内终态）
      const piNew = mkPi(entriesNew);
      store.rebind(piNew, mkCtx([]));
      const runs = new Map([[run.runId, run]]);
      const p1 = store.resendSnapshots(runs);
      run.transition("done", "completed");
      const p2 = store.resendSnapshots(runs);
      vi.advanceTimersByTime(200); // 去抖批到期，挂同一串行链尾
      await Promise.all([pHot, p1, p2]);

      // 保序红线：终态恒为该 runId 投影的最后落盘形态——绕链直接写会与 in-flight
      // flush 物理乱序（最后落盘 running），走链后由链内闭合保证
      expect(readStateFile(sessionDir, "wf-order-2").state.status).toBe("done");
      // [W1 / D1] 停写锚定：新旧 pi 零 workflow-record entry
      expect(entriesNew.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(0);
      expect(entriesOld.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(0);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ── D5 store stale guard（自 adoption 件并入——被测对象是 JsonlRunStore rebind 面）──

describe("D5 store stale guard：rebind 后窗口内 stale appendEntry 统一 debug 丢弃", () => {
  it("stale 抛错不进错误路径：loadAll 终态条目补写被守卫丢弃（不 reject）、save 照常 settle、state 文件照写", async () => {
    const staleMessage = "Extension runner is stale after session replacement";
    const entriesStale: CustomEntry[] = [];
    const piStale = mkPi(entriesStale, {
      appendEntry: vi.fn(() => {
        throw new Error(staleMessage);
      }),
    });
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-adopt-stale-"));
    try {
      // v2 收编面夹具：注册条目 + journal 已终局（终态条目缺失 → loadAll 幂等补写）
      const runId = "wf-stale-1";
      const journalPath = path.join(sessionDir, "workflow-state", `${runId}.events.jsonl`);
      appendJournalLine(sessionDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
      appendJournalLine(sessionDir, runId, { type: "run-settled", outcome: "completed", artifactsDir: sessionDir, ts: 2000, seq: 2 });
      const seedEntries: CustomEntry[] = [v2RegisteredEntry(runId, journalPath)];

      const store = new JsonlRunStore({
        sessionDir,
        ctx: mkCtx(seedEntries),
      });
      // rebind 后新 pi 随下一次 reload 窗口变 stale（appendEntry 抛 PS-30 文案）
      store.rebind(piStale, mkCtx(seedEntries));

      // 补写撞 stale → guardStaleCtx 分诊丢弃（debug 留痕），loadAll 不 reject、
      // 读回终态（条目是投影锚：stale 窗口内缺失由下次 loadAll 幂等补写自愈）
      const loaded = await store.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.state.status).toBe("done");
      expect(entriesStale).toHaveLength(0); // stale 条目被丢弃

      // state 文件照写语义保留：save 正常 settle（无条目面——[W1] 停写）
      const doneRun = makeRunningRun("wf-stale-2", "done", "completed");
      await expect(store.save(doneRun)).resolves.toBeUndefined();
      const stateFile = path.join(sessionDir, "workflow-state", "wf-stale-2.jsonl");
      expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).state.status).toBe("done");
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
