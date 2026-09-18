// workflow-events-deps-getter.test.ts —— B3 单元验收面（skill-reload-nondestructive
// 设计 D3：makeDeps volatile 成员现读）：
//   ① 三面现读：pi 切换（模拟 reload 后 factory 重跑 setupWorkflowDomain）后，
//      旧 deps 对象经属性访问解析到新 pi——eventBus（pi.events 值成员 getter）/
//      log（pi.appendEntry 包装）/ onRunDone（完成通知经 pi.sendMessage 送出），
//      断言旧 pi 对应方法不再被调、新 pi 被调；
//   ② onRunDone 的 GuiContext 从槽上 sessionState 条目的 state.ctx 现读：模拟
//      adoption 换新 ctx（mode tui → rpc）后 details.__gui__ 跟进翻转——证明 ctx
//      解析源是会被 reload/adoption 更新的存活位置，不是 makeDeps 构造期快照；
//   ③ currentPi 登记点：setupWorkflowDomain 每次 factory 重跑覆盖槽上 volatile
//      绑定（同一 domain state 对象，B1 D2 槽前提）；
//   ④ lazyDeps 语义不回归：属性访问经 getWorkflowDeps → makeDeps 现读链路同样
//      解析新 pi。
//
// mock 手法对齐 workflow-events-reload-branch.test.ts（B1）：session-lifecycle 只
// mock setupSessionLifecycle（sessionState 填充入口受控）；notifyDone/trackNotifiedRunId
// 保留真实实现——黑盒断言「哪个 pi 收到调用」，不经 mock 短路。notify ledger 槽
// 显式清空（getBoundNotifyLedger 未 bind）保证 notifyDone 走降级直发路径
// （pi.sendMessage 可断言），不受同 worker 先跑测试文件的槽串扰影响。

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
import type { LauncherDeps, WorkflowRun } from "@zhushanwen/subagent-core";
import type { InFlightReporter } from "../host/inflight-reporter.ts";
import type { WorkflowDomainHandle } from "../workflow-events.ts";

// 槽 key（Symbol.for 同 key 即同一 symbol——与被测实现登记的 key 一致）
const WORKFLOW_DOMAIN_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.workflow-domain-state");
const DIALOG_QUEUE_KEY = Symbol.for("@zhushanwen/pi-subagents.dialogQueue");
// notify ledger 槽（notify-ledger.ts NOTIFY_LEDGER_SLOT_KEY）：清空保证降级直发路径
const NOTIFY_LEDGER_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.notifyLedger");

// ── fake 组件 ──────────────────────────────────────────────────────────────────

/** notifyDone 降级直发的 pi.sendMessage 首参形状（helpers.ts WorkflowNotifyDetails）。 */
interface SentMessage {
  customType: string;
  content: string;
  display: boolean;
  details: {
    runId: string;
    notifyId: string;
    __gui__?: unknown;
  };
}

function sentMessages(pi: ExtensionAPI): SentMessage[] {
  const fn = pi.sendMessage as unknown as { mock: { calls: [SentMessage, unknown][] } };
  return fn.mock.calls.map(([message]) => message);
}

/** onRunDone 真实链路（notifyDone + evictDoneRunsBeyondCap）够用的 done run 形状：
 *  evict 侧 cap 远大于 1 → excess<=0 早退，不触 meta.completedAt。 */
function makeDoneRun(runId: string): WorkflowRun {
  return {
    runId,
    spec: { scriptName: "deploy", slug: "deploy" },
    state: {
      status: "done",
      reason: undefined,
      scriptResult: { ok: true },
      calls: new Map(),
      trace: { toArray: () => [{ stepIndex: 1, agent: "builder", status: "done" }] },
    },
  } as never;
}

/** mode 是 GuiContext 面的唯一判定维度（isGuiCapable = mode==='rpc'）——
 *  tui（非 capable，无 __gui__）/ rpc（capable，有 __gui__）构造可翻转差异。 */
function makeCtx(sessionId: string, mode: "rpc" | "tui"): ExtensionContext {
  return {
    cwd: "/home/user/project",
    mode,
    hasUI: mode === "rpc",
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

function makeFakeLifecycleResult(sessionId: string, mode: "rpc" | "tui") {
  return {
    sessionId,
    store: { dispose: vi.fn(async () => {}) } as never,
    runs: new Map<string, WorkflowRun>(),
    sessionDir: "/tmp/subagent-workflow-deps-getter-test",
    runner: {} as never,
    ctx: makeCtx(sessionId, mode),
    storeHealthy: true,
  };
}

function makeReporter(): InFlightReporter {
  return {
    attachSession: vi.fn(),
    detachSession: vi.fn(),
    onInFlightChanged: vi.fn(),
  } as unknown as InFlightReporter;
}

function makePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
} {
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

let setupWorkflowDomain: typeof import("../workflow-events.ts").setupWorkflowDomain;

// ── 槽隔离（提权后槽是进程级共享态，防跨测试 / 跨测试文件串扰） ────────────────

function resetSlots(): void {
  Reflect.deleteProperty(globalThis, WORKFLOW_DOMAIN_SLOT_KEY);
  Reflect.deleteProperty(globalThis, DIALOG_QUEUE_KEY);
  Reflect.deleteProperty(globalThis, NOTIFY_LEDGER_SLOT_KEY);
}

/** 挂载 + session_start 装配受控条目（getWorkflowDeps 守卫要求条目 + storeHealthy）。 */
async function mountWithSession(
  sessionId: string,
  mode: "rpc" | "tui" = "rpc",
): Promise<{ pi: ExtensionAPI; handle: WorkflowDomainHandle; deps: LauncherDeps }> {
  const { pi, handlers } = makePi();
  const result = makeFakeLifecycleResult(sessionId, mode);
  mockSetupSessionLifecycle.mockResolvedValue(result);
  const handle = setupWorkflowDomain(pi, { inflightReporter: makeReporter() });
  await handlers.get("session_start")!({ type: "session_start" }, result.ctx);
  const resolution = handle.getWorkflowDeps(sessionId);
  if (!resolution.ok) throw new Error(`getWorkflowDeps failed: ${resolution.reason}`);
  return { pi, handle, deps: resolution.deps };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetSlots();
  setupWorkflowDomain = (await import("../workflow-events.ts")).setupWorkflowDomain;
});

afterEach(() => {
  resetSlots();
});

// ── ① 三面现读：pi 切换后旧 deps 解析到新 pi ──────────────────────────────────

describe("D3 makeDeps volatile 现读：pi 切换（模拟 reload factory 重跑）后旧 deps 解析到新 pi", () => {
  it("eventBus：旧 deps 对象在 factory 重跑后经属性访问解析到新 pi.events（切换前基线 = 旧 pi）", async () => {
    const { pi: pi1, deps } = await mountWithSession("sess-evbus");
    expect(deps.eventBus).toBe(pi1.events); // 切换前正常解析（非 getter 破坏）

    const { pi: pi2 } = makePi();
    setupWorkflowDomain(pi2, { inflightReporter: makeReporter() }); // 模拟 reload 后 factory 重跑

    expect(deps.eventBus).toBe(pi2.events); // 旧 deps 现读到新 pi
    expect(deps.eventBus).not.toBe(pi1.events);
  });

  it("log：旧 deps.log 的 workflow:log entry 落新 pi.appendEntry，旧 pi 不再被调", async () => {
    const { pi: pi1, deps } = await mountWithSession("sess-log");
    deps.log?.("debug", "test:component", "before reload", { phase: 1 });
    expect(pi1.appendEntry).toHaveBeenCalledTimes(1); // 切换前正常写入旧 pi

    const { pi: pi2 } = makePi();
    setupWorkflowDomain(pi2, { inflightReporter: makeReporter() });

    deps.log?.("debug", "test:component", "after reload", { phase: 2 });
    expect(pi2.appendEntry).toHaveBeenCalledWith(
      "workflow:log",
      expect.objectContaining({
        level: "debug",
        component: "test:component",
        message: "after reload",
        data: { phase: 2 },
      }),
    );
    expect(pi1.appendEntry).toHaveBeenCalledTimes(1); // 旧 pi 计数不增长 = 不再被调
    expect(pi2.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("onRunDone：完成通知经新 pi.sendMessage 送出（workflow-result 通道），旧 pi 不再被调", async () => {
    const { pi: pi1, deps } = await mountWithSession("sess-done");
    const { pi: pi2 } = makePi();
    setupWorkflowDomain(pi2, { inflightReporter: makeReporter() });

    deps.onRunDone?.(makeDoneRun("run-after-reload"));

    const messages = sentMessages(pi2);
    expect(messages).toHaveLength(1);
    expect(messages[0].customType).toBe("workflow-result");
    expect(messages[0].display).toBe(true);
    expect(messages[0].details.runId).toBe("run-after-reload");
    expect(sentMessages(pi1)).toHaveLength(0); // 旧 pi 零调用
  });
});

// ── ② onRunDone 的 GuiContext 从 state.ctx 现读 ────────────────────────────────

describe("D3 onRunDone 的 GuiContext：从槽上 sessionState 条目 state.ctx 现读", () => {
  it("adoption 换新 ctx（mode tui → rpc）后 details.__gui__ 跟进翻转——ctx 解析源是存活位置非构造期快照", async () => {
    const { pi, handle, deps } = await mountWithSession("sess-ctx", "tui");

    deps.onRunDone?.(makeDoneRun("run-old-ctx"));
    expect(sentMessages(pi).at(-1)?.details.__gui__).toBeUndefined(); // tui：非 gui capable

    // 模拟 adoption rebind：sessionState 条目（槽上存活对象）的 ctx 换新
    handle.state.sessionState.get("sess-ctx")!.ctx = makeCtx("sess-ctx", "rpc");

    deps.onRunDone?.(makeDoneRun("run-new-ctx"));
    expect(sentMessages(pi).at(-1)?.details.__gui__).toBeDefined(); // rpc：gui capable，__gui__ 生成
  });
});

// ── ③ currentPi 登记点 ─────────────────────────────────────────────────────────

describe("D3 currentPi 登记点：factory 重跑覆盖槽上 volatile 绑定", () => {
  it("setupWorkflowDomain 重跑后同一 domain state 的 currentPi 换新（登记点即 reload 更新点）", async () => {
    const { pi: pi1, handle } = await mountWithSession("sess-reg");
    expect(handle.state.currentPi).toBe(pi1);

    const { pi: pi2 } = makePi();
    const handle2 = setupWorkflowDomain(pi2, { inflightReporter: makeReporter() });

    expect(handle2.state).toBe(handle.state); // B1 D2 前提：同槽同对象
    expect(handle.state.currentPi).toBe(pi2);
  });
});

// ── ④ lazyDeps 语义不回归 ──────────────────────────────────────────────────────

describe("lazyDeps 语义不回归：属性访问经 getWorkflowDeps → makeDeps 现读链路", () => {
  it("pi 切换后经 lazyDeps 的 eventBus/log/onRunDone 属性访问同样解析新 pi", async () => {
    const { pi: pi1, handle } = await mountWithSession("sess-lazy");
    expect(handle.lazyDeps.eventBus).toBe(pi1.events); // 守卫 + 转发语义不变（切换前）

    const { pi: pi2 } = makePi();
    setupWorkflowDomain(pi2, { inflightReporter: makeReporter() });

    expect(handle.lazyDeps.eventBus).toBe(pi2.events); // lazy 链路同样现读新 pi
    handle.lazyDeps.log?.("debug", "lazy", "after reload");
    expect(pi2.appendEntry).toHaveBeenCalledTimes(1);
    expect(pi1.appendEntry).not.toHaveBeenCalled();
  });
});
