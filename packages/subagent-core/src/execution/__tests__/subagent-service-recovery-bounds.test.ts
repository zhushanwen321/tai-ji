// src/execution/__tests__/subagent-service-recovery-bounds.test.ts
//
// [u-svc / T2] 服务侧回收上界与 kill 收敛：
//   - T2④/LC-2：closeChatIdle / cancelBackground 终止路径收敛到
//     killRecordChildWithEscalation（spy 断言调用点与参数）；
//   - T2⑥/PS-1：disposeAllRecords 补三回收面（controller.abort + kill + disarm idle timer
//     + disarm settled watchdog）；
//   - T2③/LC-1 + D9：Continuation 轮 armMidRoundNoProgress（挂载点在 kickOffChatRound
//     轮开跑；中段无进展检测 + 到期处置经 Continuation.onWatchdogFire → run 收敛失败
//     分支统一收口，error 含 'settled watchdog' 标记与恢复指引）。
//
// [W3 改写 → H1 U6] 替身 = 协议 seam（registerFakePiEngine）。[H1 U6] interact 断言
//（cancel/close 终止意图受理）随 interact 面退役删除：真实杀链 = 轮级 abort signal →
// 协议 cancel 帧（引擎侧杀链）+ 镜像置死记账 + 引擎退出链收割（红线①）；
// closeAfterRoundSettled 用例随载体退役删除（T2⑧ 段同前批登记归 pi 包）。
//
// mock 形态：真实 SubagentService + ServiceInternals cast 暴露 store + logger +
// spawned-children 的 kill 入口换 spy（importOriginal 保留镜像真实现）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// killRecordChildWithEscalation 换 spy（收敛调用点断言）；镜像真实现保留。
const { killChildSpy } = vi.hoisted(() => ({ killChildSpy: vi.fn() }));
vi.mock("../engine/host/spawned-children.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/host/spawned-children.ts")>();
  return { ...actual, killRecordChildWithEscalation: killChildSpy };
});

import { clearEngines } from "../engine/registry.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import { armSettledWatchdog, hasSettledWatchdog, SETTLED_MID_ROUND_NO_PROGRESS_MS, _resetSettledWatchdogsForTest } from "../settled-watchdog.ts";
import { armIdleTimer, hasIdleTimer, _resetLifecycleState } from "../lifecycle-manager.ts";
import { _resetCoreSpawnedChildrenMirrorForTest } from "../engine/host/spawned-children.ts";
import type { ExecutionRecord } from "../types.ts";

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "svc-recovery-bounds-"));
}

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

function makeRecord(overrides: Partial<ExecutionRecord> & { id?: string } = {}): ExecutionRecord {
  const { id = "sa-test", ...rest } = overrides;
  const r = createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "test",
    slug: "test",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
    controller: new AbortController(),
  });
  Object.assign(r, rest);
  return r;
}

interface ServiceInternals {
  store: RecordStore;
}

type MockPi = ReturnType<typeof makePi>;

function setup(): { agentDir: string; service: SubagentService; store: RecordStore; pi: MockPi; fake: FakePiEnginePort } {
  const agentDir = makeTmpAgentDir();
  clearEngines();
  const fake = registerFakePiEngine();
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "root-session" });
  const store = (service as unknown as ServiceInternals).store;
  return { agentDir, service, store, pi, fake };
}

/** bracket 调 private 方法（ServiceInternals cast 先例的扩展形态）。 */
function privateFn<K extends string>(service: SubagentService, key: K): (...args: never[]) => unknown {
  return (service as unknown as Record<string, (...args: never[]) => unknown>)[key];
}

/**
 * message 投递入口（[H1 U6] Continuation 编排：deliverChatMessage → onMessage →
 * 新 run + resume 锚点）。
 */
async function deliverChat(
  service: SubagentService,
  record: ExecutionRecord,
  text: string,
): Promise<void> {
  return (
    privateFn(service, "deliverChatMessage") as (
      this: SubagentService,
      r: ExecutionRecord,
      t: string,
    ) => Promise<void>
  ).call(service, record, text);
}

describe("T2④ service-side kill convergence", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: MockPi;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = setup());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("cancelBackground (via cancel) routes through killRecordChildWithEscalation + 引擎侧 cancel", async () => {
    const record = makeRecord({ id: "sa-cancel" });
    store.register(record);
    const ok = service.cancel(record.id);
    expect(ok).toBe(true);
    expect(killChildSpy).toHaveBeenCalledWith(record.id, "cancelBackground");
    // [H1 U6] 在途 run 的实际终止经 controller.abort → 轮级 signal（cancel 帧 + 杀链）；
    // 旧 interact cancel 受理断言随 interact 面退役。
  });

  it("closeChatIdle (via closeSubagent force:false on idle) routes through killRecordChildWithEscalation and disarms timers", async () => {
    const record = makeRecord({ id: "sa-close-idle" });
    store.register(record);
    armIdleTimer(record.id, () => {}); // Path A：idle timer armed（进程保活）
    armSettledWatchdog(record.id, () => {});
    await service["closeSubagent"](record, false);
    expect(killChildSpy).toHaveBeenCalledWith(record.id, "closeChatIdle");
    expect(hasIdleTimer(record.id)).toBe(false);
    expect(hasSettledWatchdog(record.id)).toBe(false);
    // [H1 U6] 旧引擎侧 close force 受理断言随 interact 面退役（无在跑轮无需进程回收，
    // Path A 保活进程由镜像记账 + reaper 兜底回收）。
  });

  it("disposeAllRecords applies all recovery surfaces: abort + escalation kill + disarm idle/settled timers", () => {
    const running = makeRecord({ id: "sa-dispose-run" });
    const idle = makeRecord({ id: "sa-dispose-idle" });
    store.register(running);
    store.register(idle);
    armIdleTimer(idle.id, () => {});
    armSettledWatchdog(idle.id, () => {});

    const count = service.disposeAllRecords("parent-new");

    expect(count).toBe(2);
    // 回收面 i：controller.abort
    expect(running.controller?.signal.aborted).toBe(true);
    expect(idle.controller?.signal.aborted).toBe(true);
    // 回收面 ii：kill 收敛到 escalation 入口
    expect(killChildSpy).toHaveBeenCalledWith(running.id, "disposeAllRecords (parent-new)");
    expect(killChildSpy).toHaveBeenCalledWith(idle.id, "disposeAllRecords (parent-new)");
    // 回收面 iii：idle timer + settled watchdog 双 disarm
    expect(hasIdleTimer(idle.id)).toBe(false);
    expect(hasSettledWatchdog(idle.id)).toBe(false);
    // record 终态化
    expect(running.status).toBe("closed");
    expect(idle.status).toBe("closed");
    expect(running.closedReason).toBe("parent-new");
  });
});

describe("T2③ hot-path settled watchdog", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: MockPi;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = setup());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    vi.useRealTimers();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("arms the settled watchdog after a successful hot-path prompt", async () => {
    // [H1 U2] deliverChatMessage = Continuation 派发（续聊轮需 sessionFile 锚点）
    const record = makeRecord({ id: "sa-hot-arm", sessionFile: path.join(agentDir, "sa-hot-arm.jsonl") });
    fs.writeFileSync(record.sessionFile!, "{}\n", "utf-8");
    store.register(record);
    await deliverChat(service, record, "hello");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    expect(hasSettledWatchdog(record.id)).toBe(true);
  });

  it("onMidTimeout: kills the child (engine cancel + round abort), fails the round via run settlement, error carries 'settled watchdog' marker and recovery hint", async () => {
    // fake timers 必须先于 arm 生效（useFakeTimers 不接管已存在的真实 timer）
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // [H1 U2] Continuation 轮需要 sessionFile 锚点
    const record = makeRecord({ id: "sa-hot-timeout", sessionFile: path.join(agentDir, "sa-hot-timeout.jsonl") });
    fs.writeFileSync(record.sessionFile!, "{}\n", "utf-8");
    store.register(record);
    await deliverChat(service, record, "hello");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    expect(hasSettledWatchdog(record.id)).toBe(true);

    // [D9 两段式] 轮开跑后挂中段：静默满中段窗长触发（本测试替身不驱动协议事件，
    // 中段静默形态直达）
    await vi.advanceTimersByTimeAsync(SETTLED_MID_ROUND_NO_PROGRESS_MS + 1);

    // kill 收敛入口被触发（[H1 U2] Continuation watchdog fire → killRoundChildForWatchdog，
    // source 含 phase 名——旧 onHotPathSettledWatchdogTimeout 的 "(hot path)" 标记退役）
    expect(killChildSpy).toHaveBeenCalledWith(record.id, "settled watchdog (mid-round)");
    // watchdog 到期自清（armedTimers 先删条目再执行回调）
    expect(hasSettledWatchdog(record.id)).toBe(false);
    // [H1 U2] fire abort 轮 signal → 在途 run 收敛（替身模拟 abort 合成失败终态）→
    // onRunSettled 失败分支簿记（chatMode → MF-6 回退 resumable）+ 失败通知
    fake.runs[0]!.settle({
      content: "",
      error: "engine_run_failed: run aborted (settled watchdog mid-round no-progress); the process was terminated to bound the wait. Recovery: check state with subagents action:'list', then re-send your message to continue.",
      exitCode: null,
    });
    await vi.waitFor(() => expect(record.resumable).toBe(true));
    expect(record.status).toBe("running");
    // [H1 U2 / D7] 失败轮 lastError 写失败原因（result = 前值 ?? 失败摘要——失败摘要
    // 由 Continuation 失败通知独立承载）
    expect(record.lastError).toContain("settled watchdog");
    expect(record.lastError).toContain("Recovery");
    expect(record.lastError).toContain("action:'list'");
    // 失败通知送达（Continuation 独立载荷——正文带失败摘要与恢复指引）
    expect(pi.sendMessage).toHaveBeenCalled();
    const sendMessageCalls = (pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[{ content?: string }]>;
    const notifyContent = sendMessageCalls[0]?.[0]?.content ?? "";
    expect(notifyContent).toContain("settled watchdog");
    // [H1 U6] 引擎侧终止意图（watchdog fire 的 cancel 受理断言）随 interact 面退役——
    // fire 的真实 kill = killRoundChildForWatchdog（镜像置死）+ abort 轮 signal → cancel 帧。
  });
});
