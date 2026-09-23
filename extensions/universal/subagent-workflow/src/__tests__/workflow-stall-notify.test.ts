// src/__tests__/workflow-stall-notify.test.ts
//
// [P4 / D6-2] stall informational 通知单测（impl-plan P4 验收条款 d：超阈值恰好
// 一次、文案含不终止声明）。
//
// 覆盖面：
//   - 超阈值（journal 尾帧 ts 早于 20min 阈值）→ 恰好一条 informational 通知
//     （customType workflow-stall、无 triggerTurn——informational 不打断主 agent）
//   - 文案含「仍在运行 / 无需干预 / 不自动终止」声明（still running / no action
//     is needed / NOT be terminated）
//   - 恰好一次：二次 tick 零重发（stallNotifiedRunIds 标记先于发送落下）
//   - 阈值内零通知（journal 尾帧新鲜）
//   - 数据源：事件 journal 尾帧 ts；journal 缺文件回退 run 起点（meta.startedAt）
//   - 非 running run 零通知
//
// mock 手法对齐 workflow-events-deps-getter.test.ts：session-lifecycle mock 受控
// sessionState 填充；notifyDone/notifyStall 保留真实实现（黑盒断言 sendMessage）。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSetupSessionLifecycle, loggerFns } = vi.hoisted(() => ({
  mockSetupSessionLifecycle: vi.fn(),
  loggerFns: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../session-lifecycle.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-lifecycle.ts")>();
  return { ...actual, setupSessionLifecycle: mockSetupSessionLifecycle };
});

vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => loggerFns,
  setPiHandle: vi.fn(),
}));

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import type { InFlightReporter } from "../host/inflight-reporter.ts";
import type { WorkflowDomainHandle } from "../workflow-events.ts";
import { peekStallWatchdog } from "../workflow-stall-watchdog.ts";

const WORKFLOW_DOMAIN_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.workflow-domain-state");
const DIALOG_QUEUE_KEY = Symbol.for("@zhushanwen/pi-subagents.dialogQueue");
const NOTIFY_LEDGER_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.notifyLedger");

const STALL_TICK_MS = 60_000;
const STALL_THRESHOLD_MS = 20 * 60 * 1000;

// ── fake 组件（deps-getter 测试同款） ──────────────────────────

function sentMessages(pi: ExtensionAPI): { customType: string; content: string; display: boolean; details?: unknown; options?: unknown }[] {
  const fn = pi.sendMessage as unknown as { mock: { calls: unknown[][] } };
  return fn.mock.calls.map(([message, options]) => {
    const m = message as { customType: string; content: string; display: boolean; details?: unknown };
    return { ...m, options };
  });
}

function makeRunningRun(runId: string, startedAt?: string): WorkflowRun {
  return {
    runId,
    spec: { scriptName: "deploy", slug: "deploy" },
    meta: { startedAt: startedAt ?? new Date().toISOString() },
    state: {
      status: "running",
      calls: new Map(),
      trace: { toArray: () => [] },
    },
  } as never;
}

function makeCtx(sessionId: string): ExtensionContext {
  return {
    cwd: "/home/user/project",
    mode: "rpc",
    hasUI: true,
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    model: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/home/user/.pi/agent/sessions/${sessionId}.jsonl`,
      getEntries: () => [],
    },
    ui: { select: vi.fn() },
  } as unknown as ExtensionContext;
}

function makeReporter(): InFlightReporter {
  return {
    attachSession: vi.fn(),
    detachSession: vi.fn(),
    onInFlightChanged: vi.fn(),
  } as unknown as InFlightReporter;
}

function makePi(): { pi: ExtensionAPI; handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown> } {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler as (event: unknown, ctx: ExtensionContext) => unknown);
    },
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function resetSlots(): void {
  Reflect.deleteProperty(globalThis, WORKFLOW_DOMAIN_SLOT_KEY);
  Reflect.deleteProperty(globalThis, DIALOG_QUEUE_KEY);
  Reflect.deleteProperty(globalThis, NOTIFY_LEDGER_SLOT_KEY);
  Reflect.deleteProperty(globalThis, Symbol.for("@zhushanwen/pi-subagents.workflow-stall-watchdog"));
}

/** 临时 sessionDir + 预写 journal 尾帧（ts 由调用方控制，控制「最近进展」时点）。 */
function makeSessionDirWithJournal(runId: string, lastFrameTs: number): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-stall-test-"));
  mkdirSync(join(dir, "workflow-state"), { recursive: true });
  writeFileSync(
    join(dir, "workflow-state", `${runId}.events.jsonl`),
    `${JSON.stringify({ type: "run-created", ts: lastFrameTs })}\n`,
  );
  return dir;
}

function makeFakeLifecycleResult(sessionId: string, sessionDir: string, runs: Map<string, WorkflowRun>) {
  return {
    sessionId,
    store: { dispose: vi.fn(async () => {}) } as never,
    runs,
    sessionDir,
    runner: {} as never,
    ctx: makeCtx(sessionId),
    storeHealthy: true,
  };
}

let setupWorkflowDomain: typeof import("../workflow-events.ts").setupWorkflowDomain;

interface Mounted {
  pi: ExtensionAPI;
  handle: WorkflowDomainHandle;
  tmpDir: string;
  sessionId: string;
}

async function mount(sessionId: string, sessionDir: string, runs: Map<string, WorkflowRun>): Promise<Mounted> {
  const { pi, handlers } = makePi();
  const result = makeFakeLifecycleResult(sessionId, sessionDir, runs);
  mockSetupSessionLifecycle.mockResolvedValue(result);
  const handle = setupWorkflowDomain(pi, { inflightReporter: makeReporter() });
  await handlers.get("session_start")!({ type: "session_start" }, result.ctx);
  return { pi, handle, tmpDir: sessionDir, sessionId };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetSlots();
  vi.useFakeTimers();
  setupWorkflowDomain = (await import("../workflow-events.ts")).setupWorkflowDomain;
});

afterEach(() => {
  // 清本测试装配的 stall watchdog timer（fake timers 下 interval 句柄真实存在）
  peekStallWatchdog()?.dispose();
  vi.useRealTimers();
  resetSlots();
});

// ── 验收条款 d ───────────────────────────────────────────────

describe("stall informational 通知（D6-2）", () => {
  it("超阈值：恰好一条通知，文案含不终止声明，informational 无 triggerTurn", async () => {
    vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
    const runId = "wf-stall-slow";
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-stall-root-"));
    // 尾帧 ts = now - 25min（超 20min 阈值）
    const stalledTs = Date.now() - (STALL_THRESHOLD_MS + 5 * 60_000);
    const journalDir = makeSessionDirWithJournal(runId, stalledTs);
    rmSync(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 20 });

    const runs = new Map<string, WorkflowRun>([[runId, makeRunningRun(runId)]]);
    const { pi } = await mount("sess-1", journalDir, runs);

    await vi.advanceTimersByTimeAsync(STALL_TICK_MS);

    const messages = sentMessages(pi);
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.customType).toBe("workflow-stall");
    expect(message.display).toBe(true);
    expect(message.options).toBeUndefined(); // 无 triggerTurn——informational 不打断主 agent
    expect(message.content).toContain("still running");
    expect(message.content).toContain("no action is needed");
    expect(message.content).toContain("NOT be terminated");
    expect(message.content).toContain("deploy");
    const details = message.details as Record<string, unknown>;
    expect(details["runId"]).toBe(runId);
    expect(details["thresholdMs"]).toBe(STALL_THRESHOLD_MS);
    // 恰好一次标记已落（Set 先于发送）
    expect(peekStallWatchdog()?.hasNotified(runId)).toBe(true);
  });

  it("恰好一次：二次 tick 零重发", async () => {
    vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
    const runId = "wf-stall-once";
    const journalDir = makeSessionDirWithJournal(runId, Date.now() - (STALL_THRESHOLD_MS + 60_000));
    const runs = new Map<string, WorkflowRun>([[runId, makeRunningRun(runId)]]);
    const { pi } = await mount("sess-2", journalDir, runs);

    await vi.advanceTimersByTimeAsync(STALL_TICK_MS);
    expect(sentMessages(pi)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(STALL_TICK_MS);
    expect(sentMessages(pi)).toHaveLength(1); // 零重发
  });

  it("阈值内（journal 尾帧新鲜）零通知；journal 缺文件回退 run 起点", async () => {
    vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
    const freshDir = makeSessionDirWithJournal("wf-stall-fresh", Date.now() - 60_000);
    // 无 journal 的 run：startedAt 25min 前 → 回退起点判定 stall（另一 session 条目不可行
    // ——单 run 断言面拆两用例太重，此处 fresh 断言零通知，回退路径下一条单独断言）
    const runs = new Map<string, WorkflowRun>([["wf-stall-fresh", makeRunningRun("wf-stall-fresh")]]);
    const { pi } = await mount("sess-3", freshDir, runs);

    await vi.advanceTimersByTimeAsync(STALL_TICK_MS);
    expect(sentMessages(pi)).toHaveLength(0);
  });

  it("journal 缺文件 → 回退 run 起点（startedAt 超阈值仍通知，不因无帧静默）", async () => {
    vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
    const emptyDir = mkdtempSync(join(tmpdir(), "wf-stall-empty-"));
    const startedAt = new Date(Date.now() - (STALL_THRESHOLD_MS + 10 * 60_000)).toISOString();
    const runs = new Map<string, WorkflowRun>([["wf-stall-nojournal", makeRunningRun("wf-stall-nojournal", startedAt)]]);
    const { pi } = await mount("sess-4", emptyDir, runs);

    await vi.advanceTimersByTimeAsync(STALL_TICK_MS);
    const messages = sentMessages(pi);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain("NOT be terminated");
  });

  it("非 running run（已终局）零通知", async () => {
    vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
    const emptyDir = mkdtempSync(join(tmpdir(), "wf-stall-done-"));
    const doneRun = {
      ...makeRunningRun("wf-stall-done"),
      state: { status: "done", reason: "completed", calls: new Map(), trace: { toArray: () => [] } },
    } as unknown as WorkflowRun;
    const runs = new Map<string, WorkflowRun>([["wf-stall-done", doneRun]]);
    const { pi } = await mount("sess-5", emptyDir, runs);

    await vi.advanceTimersByTimeAsync(STALL_TICK_MS);
    expect(sentMessages(pi)).toHaveLength(0);
  });
});
