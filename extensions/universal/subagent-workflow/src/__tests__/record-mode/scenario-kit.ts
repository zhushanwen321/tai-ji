// src/__tests__/record-mode/scenario-kit.ts
//
// [u4a] 验收场景族夹具（设计 workflow-run-resume-revision §4 场景 1-23/25）。
//
// 夹具原则（与 helpers.ts 同源，扩展到 resume 真链路）：
// - 崩溃前置态 = record 流经 core journal 生产写入器构造（createRunEventJournal
//   append——与生产单写者落盘形态逐字节同源）。**写侧载荷前置缺口声明**：生产链
//   terminal-actions 的 dispatchRunCreated/dispatchAgentSettled 现不写
//   scriptSource/result 全文（u2 deviations 登记、待编排层裁决归属），真跑
//   runWorkflow 产生的流无法被 resumeRun 的 [D12] 检查②消费——场景以「构造崩溃
//   态 → resume 起全真链路」形态覆盖（resumeRun 锁/校验/三档/重建、worker 真线程
//   重放、收编/维护轮真代码全部执行，唯一被夹具替代的是崩溃前的事件写入器）。
// - resume 侧不 mock：真 WorkerHostImpl（node:worker_threads）+ 真 resumeRun
//   + 真 record 读写；唯一替身 = faux runner（AgentRunner 的 LLM 层替身，场景表
//   「faux-pi 协议替身注入」的 vitest 内形态——派发捕获 + 行为队列可控）。
// - 全部写删目标 = mkdtempSync 自建自删（测试红线：不触真实数据目录）。
import * as fs from "node:fs";
import * as path from "node:path";

import {
  createRunEventJournal,
  recoverCrashedRuns,
  runSummary,
  WorkerHostImpl,
} from "@zhushanwen/subagent-core";
import type { WorkflowRun, WorkflowRunEvent } from "@zhushanwen/subagent-core";
import { setRunEventJournalDirForTest } from "@zhushanwen/subagent-core/orchestration/terminal-actions.ts";
import { resumeRun, type ResumeRunOptions } from "@zhushanwen/subagent-core/orchestration/resume-run.ts";
import type { AgentRunner, LifecycleDeps } from "@zhushanwen/subagent-core/orchestration/models/ports.ts";
import type { AgentResult } from "@zhushanwen/subagent-core/orchestration/models/types.ts";

import { JsonlRunStore } from "../../jsonl-run-store.ts";
import {
  appendEvents,
  askDispatched,
  askSettled,
  mkCtxWith,
  mkRecordEnv,
  registeredEntry,
  runCreated,
  type RecordFixtureEnv,
} from "./helpers.ts";

/** 场景时间基准（确定性 ts 注入——帧 ts 不依赖墙钟）。 */
export const T0 = 1_759_000_000_000;

// ── 场景脚本（worker 顶层形态：注入段提供 agent/parallel/phase/log 全局）──────

/** 场景 1/4：三调用串行（A → B → C）。agent() 对象形态显式指定 agent 名。 */
export const THREE_CALL_SERIAL_SCRIPT =
  "const a = await agent({ prompt: 'call A', agent: 'A' });\nconst b = await agent({ prompt: 'call B', agent: 'B' });\nconst c = await agent({ prompt: 'call C', agent: 'C' });\nreturn { a, b, c };";

/** 场景 5：4 路并行波次。 */
export const PARALLEL_FOUR_SCRIPT =
  "const rs = await parallel([\n  () => agent({ prompt: 'call P1', agent: 'P1' }),\n  () => agent({ prompt: 'call P2', agent: 'P2' }),\n  () => agent({ prompt: 'call P3', agent: 'P3' }),\n  () => agent({ prompt: 'call P4', agent: 'P4' }),\n]);\nreturn rs;";

/** 场景 11：pipeline 值依赖（stage2 prompt 拼 stage1 result）。 */
export const PIPELINE_VALUE_SCRIPT =
  "const s1 = await agent({ prompt: 'produce items', agent: 'stage1' });\n" +
  "const s2 = await agent({ prompt: 'review: ' + s1, agent: 'stage2' });\nreturn { s1, s2 };";

/** 场景 10：非确定性来源在脚本逻辑层（Date.now 不进 prompt）。 */
export const NONDET_LOGIC_SCRIPT =
  "const started = Date.now();\nconst a = await agent({ prompt: 'call A', agent: 'A' });\nlog('elapsed-local ' + (Date.now() - started));\nconst b = await agent({ prompt: 'call B', agent: 'B' });\nconst c = await agent({ prompt: 'call C', agent: 'C' });\nreturn { c };";

/** 场景 13：schema 模式调用（canonical JSON 往返面）。 */
export const SCHEMA_CALL_SCRIPT =
  "const a = await agent({ prompt: 'structured', agent: 'schemad', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } });\n" +
  "const b = await agent({ prompt: 'plain', agent: 'plain' });\nreturn { a, b };";

/** 场景 23：phase 跨续聊（phase1 与 phase2 各一次同名 agent 调用）。 */
export const PHASE_CROSS_SCRIPT =
  "phase('p1');\nconst a = await agent({ prompt: 'round one', agent: 'shared' });\nphase('p2');\nconst b = await agent({ prompt: 'round two', agent: 'shared' });\nreturn { a, b };";

// ── faux-pi 替身（AgentRunner 的 LLM 层协议替身）─────────────────────────────

/** 单次派发的可控行为（队列按派发序消耗；耗尽后默认 ok）。 */
export type FauxStep =
  | { kind: "ok"; content?: string }
  | { kind: "error"; message: string }
  | { kind: "hang" };

export interface FauxDispatch { // oe-exempt:20260929:test:faux dispatch capture shape (test fixture infra)
  /** 第几次真实派发（1 起——回放命中不计入：零 token 断言的计数面）。 */
  seq: number;
  opts: Record<string, unknown>;
}

export interface FauxRunnerHandle { // oe-exempt:20260929:test:faux runner handle shape (test fixture infra)
  runner: AgentRunner;
  steps: FauxStep[];
  dispatches: FauxDispatch[];
  /** 解锁某个 hang 派发（受控完成）。 */
  release(seq: number, content: string): void;
}

export function makeFauxRunner(
  defaultContent: (seq: number) => string = (seq) => `faux-result-${seq}`,
): FauxRunnerHandle {
  const steps: FauxStep[] = [];
  const dispatches: FauxDispatch[] = [];
  const gates = new Map<number, (r: AgentResult) => void>();
  const runner: AgentRunner = {
    async run(opts: Record<string, unknown>): Promise<AgentResult> {
      const seq = dispatches.length + 1;
      dispatches.push({ seq, opts });
      const step: FauxStep = steps[seq - 1] ?? { kind: "ok" };
      if (step.kind === "error") {
        // 可重试失败形态：executeAgentCall 的重试判据 = result.error 在场
        //（throw 会走 worker 错误矩阵，不是调用级重试——场景 21 的注入面）
        return { content: "", error: step.message, durationMs: 1 };
      }
      if (step.kind === "hang") {
        return await new Promise<AgentResult>((resolve) => gates.set(seq, resolve));
      }
      return { content: step.content ?? defaultContent(seq), durationMs: 5 };
    },
  };
  return {
    runner,
    steps,
    dispatches,
    release: (seq, content) => {
      gates.get(seq)?.({ content, durationMs: 5 });
    },
  };
}

// ── 场景环境（journal 锚 + store 目录 + 进程内活体态清理）────────────────────

export interface ScenarioEnv extends RecordFixtureEnv { // oe-exempt:20260929:test:scenario env (fixture env + kit state) (test fixture infra)
  /** 注入 core journal 测试锚（同时清 liveRunStates——terminal-actions 单点语义）。 */
  rebindJournalAnchor(): void;
}

export function mkScenarioEnv(label: string): ScenarioEnv {
  const env = mkRecordEnv(`scenario-${label}`);
  setRunEventJournalDirForTest(env.stateDir);
  return {
    ...env,
    rebindJournalAnchor: () => setRunEventJournalDirForTest(env.stateDir),
    cleanup: () => {
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(env.sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

// ── 崩溃前置态构造（record 流 seed）──────────────────────────────────────────

export interface SeedCallSpec { // oe-exempt:20260929:test:seed call shape (test fixture infra)
  agent: string;
  phase?: string;
  outcome?: "done" | "failed" | "cancelled";
  /** settled 的 result 全文（agent-settled 帧载荷——[D1] 全文入事件）。 */
  result?: unknown;
}

export interface SeedRunSpec { // oe-exempt:20260929:test:seed run shape (test fixture infra)
  scriptSource: string;
  workflowName?: string;
  ts?: number;
  /** 已完成调用（started + settled 对，按 taskIndex 顺序落）。 */
  settled?: SeedCallSpec[];
  /** 在途调用（仅 started 帧——三档恢复的重派集）。 */
  inflight?: SeedCallSpec[];
  /** 落 run-interrupted 崩溃收编帧（缺省 true）。 */
  interrupted?: boolean;
  errorCode?: string;
  reason?: string;
}

/** 崩溃收编后的 record 流构造（生产 journal 写入器；taskIndex 按落序分配）。 */
export async function seedCrashedRun(env: RecordFixtureEnv, runId: string, spec: SeedRunSpec): Promise<void> {
  const t0 = spec.ts ?? T0;
  const events: Array<WorkflowRunEvent | Record<string, unknown>> = [
    runCreated({ ts: t0, runId, scriptSource: spec.scriptSource, ...(spec.workflowName !== undefined ? { workflowName: spec.workflowName } : {}) }),
  ];
  let ts = t0 + 100;
  let taskIndex = 0;
  for (const call of spec.settled ?? []) {
    events.push(askDispatched({ ts: ts++, taskIndex, agentName: call.agent, ...(call.phase !== undefined ? { phase: call.phase } : {}) }));
    events.push(
      askSettled({
        ts: ts++,
        taskIndex,
        outcome: call.outcome ?? "done",
        result: call.result ?? { content: `settled-result-${taskIndex}`, durationMs: 100 },
      }),
    );
    taskIndex += 1;
  }
  for (const call of spec.inflight ?? []) {
    events.push(askDispatched({ ts: ts++, taskIndex, agentName: call.agent, ...(call.phase !== undefined ? { phase: call.phase } : {}) }));
    taskIndex += 1;
  }
  if (spec.interrupted !== false) {
    events.push({
      type: "run-interrupted",
      errorCode: spec.errorCode ?? "crashed",
      ...(spec.reason !== undefined ? { reason: spec.reason } : { reason: "Process killed (scenario fixture)" }),
      ts: ts++,
    });
  }
  await appendEvents(env, runId, events);
}

// ── resume 侧 deps 装配（真 WorkerHost + 真 store + faux runner + 捕获面）────

export interface ScenarioDeps { // oe-exempt:20260929:test:scenario deps bundle shape (test fixture infra)
  deps: LifecycleDeps;
  runs: Map<string, WorkflowRun>;
  faux: FauxRunnerHandle;
  /** deps.scheduleTimeBudget 捕获（D10 预算折算断言面）。 */
  budgetSchedules: Array<{ runId: string; ms: number }>;
  /** deps.appendEntry 捕获（裁决点 7 v2 注册条目断言面）。 */
  appendedEntries: Array<{ type: string; data: unknown }>;
  /** deps.eventBus.emit 捕获（pending:register 断言面）。 */
  emitted: Array<{ event: string; payload: unknown }>;
}

export function makeScenarioDeps(env: RecordFixtureEnv, faux: FauxRunnerHandle): ScenarioDeps {
  const runs = new Map<string, WorkflowRun>();
  const budgetSchedules: Array<{ runId: string; ms: number }> = [];
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const deps: LifecycleDeps = {
    store: new JsonlRunStore({ sessionDir: env.sessionDir }),
    workerHost: new WorkerHostImpl(),
    runner: faux.runner,
    runs,
    appendEntry: (type: string, data: unknown) => {
      appendedEntries.push({ type, data });
    },
    eventBus: {
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
    },
    scheduleTimeBudget: (runId: string, ms: number) => {
      budgetSchedules.push({ runId, ms });
      const timer = setTimeout(() => {}, Math.max(ms, 1));
      timer.unref();
      return timer;
    },
    log: () => {},
  };
  return { deps, runs, faux, budgetSchedules, appendedEntries, emitted };
}

// ── resume / 收编 / 观察原语 ────────────────────────────────────────────────

/** resumeRun 场景入口（journalDir 显式锚定——与 seed 流同目录）。 */
export function resumeScenarioRun(
  env: RecordFixtureEnv,
  sd: ScenarioDeps,
  runId: string,
  options?: Omit<ResumeRunOptions, "journalDir">,
): Promise<string> {
  return resumeRun(runId, sd.deps, { journalDir: env.stateDir, ...options });
}

/** 真收编链（recoverCrashedRuns：loadAll fold → interruptRun 落 run-interrupted）。 */
export async function adoptCrashedRun(
  env: RecordFixtureEnv,
  runId: string,
): Promise<{ recovered: number; runs: Map<string, WorkflowRun> }> {
  const runs = new Map<string, WorkflowRun>();
  const store = new JsonlRunStore({
    sessionDir: env.sessionDir,
    ctx: mkCtxWith([registeredEntry(runId, env.recordPath(runId))]) as never,
  });
  const result = await recoverCrashedRuns(store, runs, "Process killed (scenario fixture)");
  return { recovered: result.recovered, runs };
}

/** 读 record 流全部帧（断言面）。 */
export async function scanScenarioEvents(env: RecordFixtureEnv, runId: string): Promise<readonly WorkflowRunEvent[]> {
  return createRunEventJournal(env.stateDir).scan(runId);
}

/** 轮询至终局（runSummary 投影——活体终局源 = 终局记录注册表）。 */
export async function waitForScenarioSettled(
  runs: Map<string, WorkflowRun>,
  runId: string,
  timeoutMs = 20_000,
): Promise<{ status: string; reason?: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = runs.get(runId);
    if (run) {
      const summary = runSummary(run);
      if (summary.status !== "running") {
        return { status: summary.status, reason: summary.reason, error: summary.error };
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} did not settle within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 进程级死亡的进程内等价（场景 4/12 的「kill pi 进程」）：终止 worker thread、
 * 清 run 注册表与 core 活体态（setRunEventJournalDirForTest 重设在同实现内
 * 顺带 liveRunStates.clear——terminal-actions 单点语义）。record 流原样在盘。
 */
export function simulateProcessDeath(env: RecordFixtureEnv, deps: LifecycleDeps, runId: string): void {
  const run = deps.runs.get(runId);
  run?.releaseRuntime();
  deps.runs.delete(runId);
  setRunEventJournalDirForTest(env.stateDir);
}

/** 双进程 driver 的 marker 文件路径（锁段握手——scenario-09 消费）。 */
export function driverMarkerPath(stateDir: string, name: string): string {
  return path.join(stateDir, `driver-${name}.marker`);
}

// ── tsx 子进程 probe（跨包实装断言的载体）──────────────────────────────────
//
// vitest 的 vite resolver 不解析跨包物理相对路径（session-reader 包外的测试文件
// import 不到其实装），tsx 子进程的纯 node 解析可以——D16 ③ 断言（session-reader
// 概览/家族链）经 driver-session-reader.ts 在子进程内执行。

/** 本文件物理目录（record-mode/——driver 脚本同目录锚）。 */
function thisFileDir(): string {
  return path.dirname(new URL(import.meta.url).pathname);
}

/** 逐级向上定位 node_modules/.bin/tsx（物理推导，不依赖 cwd / 仓库层数假设）。 */
export function locateTsx(): string {
  let dir = thisFileDir();
  for (;;) {
    const candidate = path.join(dir, "node_modules", ".bin", "tsx");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("tsx not found in any ancestor node_modules");
    dir = parent;
  }
}

/** 跑 driver-session-reader 断言子进程（exit 0 = 断言全过）。 */
export async function runSessionReaderProbe(
  mode: "overview-interrupted" | "overview-resumed" | "overview-corrupt-tolerant" | "family-files",
  recordPath: string,
  runId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const { spawn } = await import("node:child_process");
  const driver = path.join(thisFileDir(), "driver-session-reader.ts");
  const childEnv = { ...process.env };
  delete childEnv.VITEST; // 子进程不继承测试防线（生产形态解析）
  const child = spawn(locateTsx(), [driver], {
    env: { ...childEnv, WF_PROBE_MODE: mode, WF_PROBE_RECORD_PATH: recordPath, WF_PROBE_RUN_ID: runId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`session-reader probe [${mode}] timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  if (code !== 0) {
    throw new Error(`session-reader probe [${mode}] failed (exit ${code}): ${stderr.trim()}`);
  }
}
