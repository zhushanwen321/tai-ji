// src/__tests__/record-mode/helpers.ts
//
// [D1] record 单源形态的测试夹具族（场景 6 重建保真 / 场景 18 损坏拒绝共用；
// u4a 验收测试族的 record 形态夹具将复用本件——任务书 workflow-run-resume-revision
// u-foundation 行「夹具族一并落此目录」）。
//
// 夹具原则：写入侧经 core journal 实装（createRunEventJournal——生产单写者的
// 落盘形态），不经手工字符串拼行；损坏形态例外（损坏本身就是被测输入，直写
// raw 字节）。全部写删目标 = mkdtempSync 自建自删（测试红线）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { CustomEntry } from "@earendil-works/pi-coding-agent";

import {
  RUN_EVENTS_SUFFIX,
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_ENTRY_VERSION,
  createRunEventJournal,
} from "@zhushanwen/subagent-core";
import type { WorkflowRunEvent } from "@zhushanwen/subagent-core";

/** 自建自删的临时 workflow-state 环境（store 的 sessionDir 锚 + record 流路径构造）。 */
export interface RecordFixtureEnv { // oe-exempt:20260929:test:record-mode fixture env contract (test infra)
  sessionDir: string;
  stateDir: string;
  recordPath(runId: string): string;
  cleanup(): void;
}

export function mkRecordEnv(label: string): RecordFixtureEnv {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), `wf-record-${label}-`));
  const stateDir = path.join(sessionDir, "workflow-state");
  return {
    sessionDir,
    stateDir,
    recordPath: (runId: string) => path.join(stateDir, `${runId}${RUN_EVENTS_SUFFIX}`),
    cleanup: () => fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  };
}

/**
 * 经 core journal 实装（生产写入器）追加事件——写入序即落盘序，与生产单写者链
 * 的落盘形态逐字节同源（区别只在调用方不经 dispatchRunTrigger 队列）。
 */
export async function appendEvents(env: RecordFixtureEnv, runId: string, events: Array<WorkflowRunEvent | Record<string, unknown>>): Promise<void> {
  const journal = createRunEventJournal(env.stateDir);
  for (const event of events) {
    await journal.append(runId, event as WorkflowRunEvent);
  }
}

/** 直写 raw 字节（损坏形态夹具专用——损坏本身就是被测输入）。 */
export function writeRawLines(env: RecordFixtureEnv, runId: string, lines: string[]): void { // oe-exempt:20260929:wip:consumer scenario-18 lands in the same D1 batch (u4a commit)
  fs.mkdirSync(env.stateDir, { recursive: true });
  fs.writeFileSync(env.recordPath(runId), lines.join("\n") + "\n", "utf8");
}

/** v2 注册条目夹具（journalPath 锚点 = record 流路径——新形态实体）。 */
export function registeredEntry(runId: string, journalPath: string): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: {
      v: WORKFLOW_RECORD_ENTRY_VERSION,
      kind: "registered",
      runId,
      workflowName: "fidelity-script",
      scriptName: "fidelity-script",
      slug: "fidelity-script",
      startedAt: Date.now(),
      journalPath,
    },
    id: `reg-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** 内存 fake 的 pi ctx（getEntries 返回注入 entries；无 pi appendEntry 面）。 */
export function mkCtxWith(entries: CustomEntry[]): { sessionManager: { getEntries(): CustomEntry[] } } {
  return { sessionManager: { getEntries: () => [...entries] } };
}

// ── 事件载荷构造器（词表现行 7 事件中本域相关的子集；ts 显式注入保证确定性）──

export function runCreated(opts: {
  ts: number;
  runId: string;
  workflowName?: string;
  scriptSource: string;
  /** run-created 帧的 scriptPath 锚定载荷（生产写面 dispatchRunCreated 随帧落；缺省 = 旧格式帧）。 */
  scriptPath?: string;
  argsSummary?: string;
  /** run-created 帧的 args 全文（设计 §3.1 载荷表——生产写面 dispatchRunCreated 随帧落）。 */
  args?: Record<string, unknown>;
  model?: string;
}): WorkflowRunEvent {
  return {
    type: "run-created",
    ts: opts.ts,
    runId: opts.runId,
    workflowName: opts.workflowName ?? "fidelity-script",
    argsSummary: opts.argsSummary ?? "{}",
    ...(opts.args !== undefined ? { args: opts.args } : {}),
    scriptSource: opts.scriptSource,
    ...(opts.scriptPath !== undefined ? { scriptPath: opts.scriptPath } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  } as WorkflowRunEvent;
}

export function askDispatched(opts: { ts: number; taskIndex: number; agentName: string; phase?: string; attempt?: number }): WorkflowRunEvent {
  return {
    type: "agent-started",
    ts: opts.ts,
    taskIndex: opts.taskIndex,
    agentName: opts.agentName,
    attempt: opts.attempt ?? 1,
    ...(opts.phase !== undefined ? { phase: opts.phase } : {}),
  } as WorkflowRunEvent;
}

export function askSettled(opts: {
  ts: number;
  taskIndex: number;
  attempt?: number;
  outcome: "done" | "failed" | "cancelled";
  errorCode?: string;
  durationMs?: number;
  result?: unknown;
}): WorkflowRunEvent {
  return {
    type: "agent-settled",
    ts: opts.ts,
    taskIndex: opts.taskIndex,
    attempt: opts.attempt ?? 1,
    outcome: opts.outcome,
    ...(opts.errorCode !== undefined ? { errorCode: opts.errorCode } : {}),
    durationMs: opts.durationMs ?? 100,
    result: opts.result,
  } as WorkflowRunEvent;
}

export function runSettled(opts: { ts: number; outcome: string; errorCode?: string; reason?: string }): WorkflowRunEvent {
  return {
    type: "run-settled",
    ts: opts.ts,
    outcome: opts.outcome,
    ...(opts.errorCode !== undefined ? { errorCode: opts.errorCode } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    artifactsDir: "/tmp/fidelity-artifacts",
  } as WorkflowRunEvent;
}
