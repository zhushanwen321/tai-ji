// src/__tests__/jsonl-run-store-snapshot-codec.test.ts
//
// ⛔5 codec 存量往返等值（下沉收口 D4/U11——jsonl-run-store 切 core run-snapshot codec）。
//
// 防的 bug：切换 codec 后快照投影漂移——pi 存量 session（wf-run-v2 行）必须逐字节
// 可读可写。golden 行 = 切换前本地 serializeRun 对 done run 的真实落盘字节
// （改造前经临时探针采集，fixture 与本文件 makeDoneRunWithLive 同一构造；
// [H2 W3] live 字段随 ExecutionTraceNode 类型退役，构造不再 attach——golden 行
// 本就无 live 键，字节不变）。
//
// 断言结构：
// 1. golden 逐字节——切 codec 后 state 文件落盘行与切换前逐字节一致（含
//    v="wf-run-v2"、键序）；
// 2. entry ≡ state 文件——workflow-record entry 的 snapshot 与 state 文件同一份
//    （W17「不二次序列化」语义在 codec 切换后保持）；
// 3. spec.budgetRef 剔除——codec 单源裁决的唯一投影差异（嵌套 run 落盘少一脏字段），
//    用例钉住防无意回退；
// 4. 往返幂等——toRunSnapshot → fromRunSnapshot → toRunSnapshot 深等值（重水合保真）；
// 5. [H2 W3] live 字段退役回归——节点无运行期附属对象，落盘行自然无 live 键
//    （原 live-strip 隔离断言随字段删除退役）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import { AgentCall } from "@zhushanwen/subagent-core/orchestration/models/agent-call.ts";
import { Budget } from "@zhushanwen/subagent-core/orchestration/models/budget.ts";
import { Trace } from "@zhushanwen/subagent-core/orchestration/models/trace.ts";
import type { RunSpec } from "@zhushanwen/subagent-core/orchestration/models/run-spec.ts";
import { WorkflowRun } from "@zhushanwen/subagent-core/orchestration/models/workflow-run.ts";
import { fromRunSnapshot, toRunSnapshot } from "@zhushanwen/subagent-core/orchestration/run-snapshot.ts";
import { JsonlRunStore, WORKFLOW_RECORD_CUSTOM_TYPE } from "../jsonl-run-store.ts";
import { mkPi } from "@zhushanwen/subagent-core/orchestration/__tests__/test-mocks.ts";

const SESSION_FILE = "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl";

/**
 * ⛔5 golden：改造前本地 serializeRun 的落盘行（单行 JSON，含 live 字段 run——
 * live 已被 strip，traceNode/trace 均无 live 键；键序即 serializeRun 对象字面量序）。
 * 切换 core codec 后此字节必须不变（版本衔接 D4 裁决①：pi 存量逐字节可读）。
 */
const GOLDEN_SNAPSHOT_LINE =
  '{"v":"wf-run-v2","runId":"wf-golden-noref","spec":{"scriptSource":"module.exports = async () => {};","args":{"topic":"demo"},"scriptName":"test-script","scriptPath":"/tmp/test.js","description":"test"},"state":{"status":"done","reason":"completed","budget":{"maxTokens":4096,"maxCost":1.5,"maxTimeMs":60000,"usedTokens":4321,"usedCost":0.42,"totalCallCount":3},"calls":[{"id":0,"opts":{"prompt":"task","agent":"worker","cwd":"/tmp"},"status":"done","attempts":1,"result":{"content":"done","sessionId":"session-abc","sessionFile":"/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl"},"sessionId":"session-abc","sessionFile":"/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl","traceNode":{"stepIndex":0,"agent":"worker","task":"do thing","model":"default","status":"completed","startedAt":"2026-08-30T00:00:01.000Z","completedAt":"2026-08-30T00:00:02.000Z","sessionId":"session-abc","sessionFile":"/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl"}}],"trace":[{"stepIndex":0,"agent":"worker","task":"do thing","model":"default","status":"completed","startedAt":"2026-08-30T00:00:01.000Z","completedAt":"2026-08-30T00:00:02.000Z","sessionId":"session-abc","sessionFile":"/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl"}],"errorLogs":[{"level":"warn","message":"worker retry 1"}],"scriptResult":{"ok":true}},"meta":{"startedAt":"2026-08-30T00:00:00.000Z","completedAt":"2026-08-30T00:00:03.000Z","workerErrorCount":1,"scriptErrorCount":0}}';

function makeSpec(withBudgetRef: boolean): RunSpec {
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
  const node = {
    stepIndex: 0,
    agent: "worker",
    task: "do thing",
    model: "default",
    status: "completed" as const,
    startedAt: "2026-08-30T00:00:01.000Z",
    completedAt: "2026-08-30T00:00:02.000Z",
    sessionId: "session-abc",
    sessionFile: SESSION_FILE,
  };
  const trace = new Trace();
  trace.append(node);
  const call = new AgentCall(0, { prompt: "task", agent: "worker", cwd: "/tmp" }, node);
  call.markRunning();
  call.markDone({ content: "done", sessionId: "session-abc", sessionFile: SESSION_FILE });
  call.setSessionId("session-abc");
  call.setSessionFile(SESSION_FILE);

  return WorkflowRun.reconstruct(
    runId,
    makeSpec(withBudgetRef),
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

/** unknown → workflow-record entry data 的运行时收窄（taste/no-unsafe-cast：先收窄再断言）。 */
function asRecordData(d: unknown): { v: number; snapshot: Record<string, unknown> } {
  if (typeof d !== "object" || d === null) throw new Error("entry data is not an object");
  const rec = d as { v?: unknown; snapshot?: unknown };
  if (typeof rec.v !== "number" || typeof rec.snapshot !== "object" || rec.snapshot === null) {
    throw new Error("entry data is not a workflow-record");
  }
  return rec as { v: number; snapshot: Record<string, unknown> };
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

  it("workflow-record entry snapshot 与 state 文件同一份字节（W17 不二次序列化）", async () => {
    const entries: CustomEntry[] = [];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries) });

    await store.save(makeDoneRunWithLive("wf-golden-noref", false));

    expect(entries).toHaveLength(1);
    expect(entries[0]!.customType).toBe(WORKFLOW_RECORD_CUSTOM_TYPE);
    expect(JSON.stringify(asRecordData(entries[0]!.data).snapshot)).toBe(
      readStateLine(tmpDir, "wf-golden-noref"),
    );
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

  it("往返幂等：toRunSnapshot → fromRunSnapshot → toRunSnapshot 深等值", () => {
    const run = makeDoneRunWithLive("wf-roundtrip", false);

    const snap1 = toRunSnapshot(run);
    const rehydrated = fromRunSnapshot(snap1);
    expect(rehydrated).toBeDefined();
    const snap2 = toRunSnapshot(rehydrated!);

    expect(snap2).toEqual(snap1);
    // 重水合保真抽查：终态与 call 附件字段在位
    expect(rehydrated!.state.status).toBe("done");
    expect(rehydrated!.state.calls.get(0)!.sessionFile).toBe(SESSION_FILE);
  });

  it("[H2 W3] live 字段退役回归：节点无运行期附属对象，落盘行自然无 live 键", async () => {
    const entries: CustomEntry[] = [];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries) });
    const run = makeDoneRunWithLive("wf-live-isolation", false);

    await store.save(run);

    const parsed: unknown = JSON.parse(readStateLine(tmpDir, "wf-live-isolation"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const state = (parsed as { state: { calls: Array<{ traceNode: Record<string, unknown> }>; trace: Array<Record<string, unknown>> } }).state;
    // [H2 W3] ExecutionTraceNode.live 已删除（设计 D2）——strip 分支随字段退役，
    // 节点不再携带运行期对象，落盘行无 live 键由类型层面收敛（回归锁定）。
    expect("live" in state.calls[0]!.traceNode).toBe(false);
    expect("live" in state.trace[0]!).toBe(false);
  });
});
