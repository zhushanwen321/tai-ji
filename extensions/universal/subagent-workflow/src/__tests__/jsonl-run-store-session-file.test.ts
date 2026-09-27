// src/__tests__/jsonl-run-store-session-file.test.ts
//
// W1: jsonl-run-store 序列化/反序列化 sessionFile round-trip 测试
//
// 防的 bug：sessionFile 加入 AgentCall + ExecutionTraceNode 后，序列化时必须写入快照，
// 反序列化时必须恢复——否则跨 session 重水合后 agent 的 session jsonl
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
import { WORKFLOW_RECORD_CUSTOM_TYPE } from "@zhushanwen/subagent-core";
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
 */
function makeRunningRun(runId: string): WorkflowRun {
  const trace = new Trace();
  trace.append(makeTraceNode(0));
  return WorkflowRun.reconstruct(
    runId,
    makeSpec(),
    {
      status: "running",
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

  it("save → loadAll 完整 round-trip: 反序列化后 AgentCall.sessionFile 可读", async () => {
    // 闭环测试：serialize（save）→ deserialize（loadAll）→ 验证 run.state.calls 的 AgentCall.sessionFile
    const sessionFilePath = "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl";

    // mock pi + ctx 共享同一 entries 数组：save 写 pointer entry，loadAll 读同一组 entries
    const entries: CustomEntry[] = [];
    const mockPi = mkPi(entries);
    const mockCtx = mkCtx(entries);

    const storeWithCtx = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mockPi,
      ctx: mockCtx,
    });

    const run = makeRunWithDoneCall();
    await storeWithCtx.save(run);

    const loaded = await storeWithCtx.loadAll();
    expect(loaded).toHaveLength(1);
    const restoredCall = loaded[0]!.state.calls.get(0);
    expect(restoredCall).toBeDefined();
    expect(restoredCall!.sessionFile).toBe(sessionFilePath);
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

  it("mkdir 抛 ENOENT（sessionDir 被并发清理）→ save 静默返回，不抛 unhandled rejection", async () => {
    const run = makeRunWithDoneCall();
    const spy = vi
      .spyOn(fs.promises, "mkdir")
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOENT: no such file or directory, mkdir"), {
          code: "ENOENT",
        }),
      );
    // run 已终态 + 工作目录消失 → save 放弃持久化，resolve undefined（不抛）
    await expect(store.save(run)).resolves.toBeUndefined();
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

  it("W2TC1: 热路径去抖合并：3 次 save 合并 1 次写盘、内容为 flush 时刻最新状态", async () => {
    const run = makeRunningRun("run-w2tc1");
    // 首写冷路径立即落盘（writtenOnce 记录，热路径前提）
    await store.save(run);
    const wfSpy = vi.spyOn(fs.promises, "writeFile");

    // 热路径 3 次 save（同一 run 引用 mutate，中间态演进）
    run.state.trace.append(makeTraceNode(1));
    const p1 = store.save(run);
    run.state.trace.append(makeTraceNode(2));
    const p2 = store.save(run);
    const p3 = store.save(run);

    // advance 前：无写盘，文件停留首写状态（1 个节点）
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

  it("W2TC3: 同批多次调用共享同一 flush Promise——timer 触发路径全 resolved", async () => {
    const run = makeRunningRun("run-w2tc3a");
    await store.save(run);
    const p1 = store.save(run);
    const p2 = store.save(run);
    const p3 = store.save(run);
    await vi.advanceTimersByTimeAsync(200);
    // 同批全部 resolved（成功场景无 rejected）
    await Promise.all([p1, p2, p3]);
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

  it("W2TC7: 终态冷路径同步 flush：立即落盘（绕过 timer）+ 终态 workflow-record entry", async () => {
    const mockPi = mkPi();
    const store7 = new JsonlRunStore({ sessionDir: tmpDir, pi: mockPi });
    const run = makeRunningRun("run-w2tc7");
    await store7.save(run); // 首写 + entry
    expect(mockPi.appendEntry).toHaveBeenCalledTimes(1);

    const pHot = store7.save(run); // 热路径批 pending
    run.transition("done", "completed");
    await store7.save(run); // 终态冷路径

    // 不 advance 立即读磁盘：终态优先持久化（去抖窗口内的崩溃不吞终态）
    expect(readStateFile(tmpDir, "run-w2tc7").state.status).toBe("done");
    // 合并的热路径批 Promise 一并 resolved
    await pHot;
    // 终态冷路径合并批 1 次 flush → 1 条终态 entry（首写 + 终态 = 2 条）
    expect(mockPi.appendEntry).toHaveBeenCalledTimes(2);
    // advance 后无追加写
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockPi.appendEntry).toHaveBeenCalledTimes(2);
  });

  it("W2TC8: 首写冷路径（跨 session resume）：本 store 实例首 save 立即落盘 + entry", async () => {
    const mockPi = mkPi();
    const storeA = new JsonlRunStore({ sessionDir: tmpDir, pi: mockPi });
    const run = makeRunningRun("run-w2tc8");

    // 实例 A 首写：status 是 running 也立即落盘（首写判定优先于 status）
    await storeA.save(run);
    expect(readStateFile(tmpDir, "run-w2tc8").state.status).toBe("running");
    // 首写即写 entry（即使 status 是 running——新 store 实例对该 runId 的首写就落 entry）
    expect(mockPi.appendEntry).toHaveBeenCalledTimes(1);

    // 实例 B（另一 session 的 store）对同一 runId 再 save：又是一次实例首写
    const storeB = new JsonlRunStore({ sessionDir: tmpDir, pi: mockPi });
    run.state.trace.append(makeTraceNode(9));
    await storeB.save(run);
    // 跨实例各 1 条 entry（实例级 writtenOnce 判定）
    expect(mockPi.appendEntry).toHaveBeenCalledTimes(2);
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
    const p3 = store.save(run);
    await vi.advanceTimersByTimeAsync(200);
    await p3;
    expect(readStateFile(tmpDir, "run-w2tc4").state.status).toBe("running");
  });

  it("W2TC4(ES9): 首写失败回滚 writtenOnce——running 中间态 save 重走冷路径补写指针", async () => {
    const mockPi = mkPi();
    const store4 = new JsonlRunStore({ sessionDir: tmpDir, pi: mockPi });
    const run = makeRunningRun("run-w2tc4b");

    // 首写冷路径遇 writeFile EACCES reject。[B3 顺序反转] 后权威 entry 先于 state
    // 文件写入：appendEntry 已成功落账（1 次）——「state 缺而 entry 有」是读侧无害
    // 形态（loadAll 读序 entry > state），不再是待补窗口。
    vi.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    await expect(store4.save(run)).rejects.toThrow("permission denied");
    expect(mockPi.appendEntry).toHaveBeenCalledTimes(1); // 权威 entry 已先落（B3）

    // 恢复 IO 后 running 中间态 save：不经 timer 立即落盘（首写资格已回滚，冷路径重写双通道）
    const p = store4.save(run);
    await p; // 冷路径同步 flush 完成
    expect(readStateFile(tmpDir, "run-w2tc4b").state.status).toBe("running");
    // entry 不重复 append：首写的 appendEntry 已成功（B3 权威先落）且 run 未变，
    // 重试的 running 中间态按 [B-1] 节流跳过——权威 entry 已是最新快照，无需重复。
    expect(mockPi.appendEntry).toHaveBeenCalledTimes(1);
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

  it("W2TC5: 冷路径 mkdir ENOENT → save Promise resolves（对齐 W3 既有语义）", async () => {
    const run = makeRunningRun("run-w2tc5b");
    // running 首写冷路径（与 W3 的 done 用例互补）：mkdir ENOENT → 静默 resolve
    vi.spyOn(fs.promises, "mkdir").mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file or directory, mkdir"), {
        code: "ENOENT",
      }),
    );
    await expect(store.save(run)).resolves.toBeUndefined();
  });
});

describe("W6: workflow-record entry 计数（= flush 次数；save 级不放大）", () => {
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

  it("W2TC6(W17): entry 计数 = flush 次数：首写+终态各 1、中间去抖批合并（N save → 1 entry）、终态 entry 含 done", async () => {
    const mockPi = mkPi();
    // entryAppendMinIntervalMs=0 禁用 [B-1] 节流：本用例锁定「去抖批合并 → save 级
    // 不放大」的 entry 计数语义；running 中间态 append 节流由 jsonl-run-store-throttle.test.ts 锁定
    const store6 = new JsonlRunStore({ sessionDir: tmpDir, pi: mockPi, entryAppendMinIntervalMs: 0 });
    const run = makeRunningRun("run-w2tc6");

    // 创建首写 flush → 1 条 entry
    await store6.save(run);
    expect(mockPi.appendEntry).toHaveBeenCalledTimes(1);

    // 3 轮 running 中间态：每轮窗口内 2 次 save（热路径批合并）→ 各 1 次 flush → 各 1 条 entry
    for (let i = 1; i <= 3; i++) {
      run.state.trace.append(makeTraceNode(i));
      const p1 = store6.save(run);
      const p2 = store6.save(run);
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all([p1, p2]);
    }
    expect(mockPi.appendEntry).toHaveBeenCalledTimes(4); // save 级不放大（2 save → 1 flush → 1 entry）

    // done 终态 flush → 1 条 entry，快照携带终态（验收「entry 序列含终态」）
    run.transition("done", "completed");
    await store6.save(run);
    expect(mockPi.appendEntry).toHaveBeenCalledTimes(5);
    const calls = mockPi.appendEntry.mock.calls;
    expect(calls[4]![0]).toBe(WORKFLOW_RECORD_CUSTOM_TYPE);
    expect(asRecordData(calls[4]![1]).snapshot.state.status).toBe("done");
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

  it("W2TC11: 链上前序 flush 失败不传染后续批（链尾吞链错误，错误只经批 Promise 传播）", async () => {
    const run = makeRunningRun("run-w2tc11b");
    await store.save(run); // 首写
    vi.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );

    const p1 = store.save(run);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p1).rejects.toThrow("permission denied"); // flush#1 失败经批 Promise 传播

    // 链未断：flush#2 正常执行并落盘
    run.state.trace.append(makeTraceNode(1));
    const p2 = store.save(run);
    await vi.advanceTimersByTimeAsync(200);
    await p2;
    expect(readStateFile(tmpDir, "run-w2tc11b").state.trace).toHaveLength(2);
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
  let store: JsonlRunStore;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-crash-"));
    store = new JsonlRunStore({ sessionDir: tmpDir });
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

  it("W2TC13: 去抖窗口崩溃语义：未 flush 的 run 对 loadAll 不可见（丢失边界 = 最后一次成功 flush）", async () => {
    // mockPi + mockCtx entries 数组模式（对齐 W1 round-trip 用例）
    const entries: CustomEntry[] = [];
    const mockPi = mkPi(entries);
    const mockCtx = mkCtx(entries);

    const storeA = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mockPi,
      ctx: mockCtx,
      // entryAppendMinIntervalMs=0 禁用 [B-1] 节流：本用例锁定去抖窗口的崩溃丢失边界；
      // 节流窗口（entry 追加落后真实状态）由 jsonl-run-store-throttle.test.ts 锁定
      entryAppendMinIntervalMs: 0,
    });
    const run = makeRunningRun("run-w2tc13");
    await storeA.save(run); // 首写冷路径落盘 + 创建指针

    // 去抖窗口内「崩溃」：中间态批 pending（不 advance；save Promise 留引用供
    // 对照阶段 await，防 unhandled rejection）
    run.state.trace.append(makeTraceNode(1));
    const pHot = storeA.save(run);

    // 重启恢复：新 store 实例 loadAll 只能看到最后一次成功 flush 的状态
    const storeB = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded1 = await storeB.loadAll();
    expect(loaded1).toHaveLength(1);
    expect(loaded1[0]!.state.trace.toArray()).toHaveLength(1); // 中间态丢失（崩溃窗口 ≤saveDebounceMs 的已接受语义）

    // 对照锚点：advance 后（无崩溃）新 loadAll 返回含中间态的最新快照
    await vi.advanceTimersByTimeAsync(200);
    await pHot; // 热批 flush 落盘完成
    const loaded2 = await storeB.loadAll();
    expect(loaded2).toHaveLength(1);
    expect(loaded2[0]!.state.trace.toArray()).toHaveLength(2);
  });
});

// ── W17: workflow-record 自描述 entry（D4 收敛：entry > state 文件 > 空）──────
//
// 持久化形态从「state 文件 + workflow-state-link 指针 entry」收敛为自描述完整记录：
// 每次成功 flush append 一条 workflow-record entry（pi 文件 = 持久化权威），state 文件
// 降级纯性能缓存；旧 link entry 兼容读取（优先级低，存量 run 不静默丢失——#9 踩坑）。

describe("W17: workflow-record 自描述 entry 重建（entry > state 文件 > 空）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-w17-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("customType 常量字面量钉住：WORKFLOW_RECORD_CUSTOM_TYPE === 'workflow-record'", () => {
    // 写点引用常量（单源）；本断言钉住常量与消费方（W18 runtime extractor）约定的
    // 字面量拼写，防重命名漂移后静默丢重建。
    expect(WORKFLOW_RECORD_CUSTOM_TYPE).toBe("workflow-record");
  });

  it("save 落 workflow-record entry 序列：customType + v1 + 完整快照（running → done 终态）", async () => {
    const entries: CustomEntry[] = [];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries) });
    const run = makeRunningRun("run-w17-shape");
    await store.save(run); // 首写 flush → entry 1（running）
    run.transition("done", "completed");
    await store.save(run); // 终态 flush → entry 2（done）

    const wfEntries = entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE);
    expect(wfEntries).toHaveLength(2);

    const first = asRecordData(wfEntries[0]!.data);
    expect(first.v).toBe(1);
    expect(first.snapshot.runId).toBe("run-w17-shape");
    expect(first.snapshot.state.status).toBe("running");

    const last = asRecordData(wfEntries[1]!.data);
    expect(last.v).toBe(1);
    expect(last.snapshot.state.status).toBe("done"); // entry 序列含终态
  });

  it("新 entry 重建用例：loadAll 优先扫 workflow-record——state 文件删除后仍完整重建（纯性能缓存证明）", async () => {
    const entries: CustomEntry[] = [];
    const storeA = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mkPi(entries),
      ctx: mkCtx(entries),
    });
    const run = makeRunWithDoneCall();
    await storeA.save(run);

    // 删除 state 文件（模拟缓存清理/丢失）——entry 是唯一残留源
    fs.rmSync(path.join(tmpDir, "workflow-state", "run-test-001.jsonl"));

    const storeB = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await storeB.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.runId).toBe("run-test-001");
    expect(loaded[0]!.state.status).toBe("done");
    // 自描述快照完整：AgentCall.sessionFile 等重水合字段在位（不依赖 state 文件）
    expect(loaded[0]!.state.calls.get(0)!.sessionFile).toBe(
      "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
    );
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

  it("读序优先级：同 runId 既有 workflow-record entry 又有旧 link（state 文件为旧 running 快照）→ entry 终态胜出", async () => {
    const entries: CustomEntry[] = [];
    const storeA = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries) });
    const run = makeRunningRun("run-w17-prio");
    await storeA.save(run); // entry 1（running）+ state 文件（running）
    run.transition("done", "completed");
    await storeA.save(run); // entry 2（done）+ state 文件（done）

    // 把 state 文件回写为旧 running 快照（从 entry 1 提取完整快照），并 seed 旧 link 指针
    const filePath = path.join(tmpDir, "workflow-state", "run-w17-prio.jsonl");
    fs.writeFileSync(
      filePath,
      JSON.stringify(asRecordData(entries[0]!.data).snapshot) + "\n",
      "utf8",
    );
    const seedEntries: CustomEntry[] = [
      ...entries,
      {
        type: "custom",
        customType: "workflow-state-link",
        data: { runId: "run-w17-prio", path: filePath },
        id: "seed-pointer",
        parentId: null,
        timestamp: new Date().toISOString(),
      },
    ];

    const storeB = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(seedEntries) });
    const loaded = await storeB.loadAll();
    expect(loaded).toHaveLength(1);
    // entry 最后一条（done）胜出——不被 link 指向的旧 state 文件（running）回退
    expect(loaded[0]!.state.status).toBe("done");
  });

  it("entry v guard：v:2 的 workflow-record entry（未来 schema）→ 跳过不崩（对齐 W16 消费约定）", async () => {
    // snapshot 本身是合法 wf-run-v2 快照，但 entry 层 v=2 ≠ 1 → 整条跳过（不猜测解析）
    const capture: CustomEntry[] = [];
    const storeA = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(capture) });
    await storeA.save(makeRunningRun("run-w17-v2"));
    const snapshot = asRecordData(capture[0]!.data).snapshot;

    const entries: CustomEntry[] = [
      {
        type: "custom",
        customType: WORKFLOW_RECORD_CUSTOM_TYPE,
        data: { v: 2, snapshot },
        id: "seed-future-entry",
        parentId: null,
        timestamp: new Date().toISOString(),
      },
    ];
    const storeB = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    await expect(storeB.loadAll()).resolves.toEqual([]);
  });
});
