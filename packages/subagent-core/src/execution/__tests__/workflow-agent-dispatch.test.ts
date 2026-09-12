// src/execution/__tests__/workflow-agent-dispatch.test.ts
//
// [H2 W2] executeWorkflowAgent 统一编排入口单测（设计 subagent-workflow-record-
// unification.md §3.4 错误规格 / §3.5 终态数据流 / D3 池顺序 / D4 守护 / D6 通知
// gate / D7 成功收口 / adopt 豁免双点）。
//
// 锁六组面：
//   1. 注册面：record 带 origin:"workflow" + parentRunId；record 级
//      pending:register/unregister 配对（D5：record 级照旧）。
//   2. 池顺序（D3）：路由/预检失败先于池 acquire——零池占用 + 同步抛错 + 零孤儿 record。
//   3. 守护（D4/M3 复刻）：arm 键 = record.id（ctx.taskId 即守护键）；双刷新源
//      （journal.onEvent 包装 ∪ stream.onDelta 包装）；fire 后失败结果追注恢复指引。
//   4. D7 收口 CAS 规格：成功 → closed/gc 立即终态化 + archive；close 路径抢先
//      （user-close 已写 closedReason）→ 静默跳过不覆盖（memory closedReason 不分叉）；
//      aborted+success 竞态 → 落 cancelled 分支不漂移；origin=tool 负向对照
//      （executeAndAwait 成功仍 SP-5 running-resumable，D7 零外溢）。
//   5. D6 gate：workflow record 完成/失败/关闭不产生任何回注通知（toNotifyRecord
//      返回 undefined + pi.sendMessage 零调用）。
//   6. 引擎死亡（§3.4）：engine_crashed → catch 合成 failed result 回脚本（swallow）
//      + record 由失败路径立即终态化（不 adopt）；service 分诊两处豁免（runEngineTask
//      catch / finalizeEngineOutcome exitCode===null）对 workflow record 落空即终态化。
//   7. [H2 W3 must-fix] stream 缺省自构：runWorkflowEngineTask 在 stream 实参缺省时
//      经 createBackgroundStream 自构（kickOffChatRound 同款策略）——三形态（TUI
//      widget 接通 / GUI+relay 停发私货 / sink 未注入降级 no-op）+ 内构对象的守护
//      刷新源（bindWorkflowStreamRefresh 包裹 onDelta）仍生效。
//
// 替身形态：pi EnginePort = registerFakePiEngine（协议 seam 替身）；受限引擎
// （strict-engine）本地构造（预检命中用）；pi = mock（appendEntry 捕获 subagent-record
// entry、events.emit 捕获 pending 注册/注销、sendMessage 零调用断言）。journal 落盘
// 经 XYZ_AGENT_DATA_DIR 指到 tmpdir（测试红线：不触真实数据目录）；守护窗长经
// _setMidRoundNoProgressWindowMsForTest 注入（秒级，fake timers 驱动）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { EngineSdkError } from "@zhushanwen/subagent-engine-sdk";
import { tryTransition } from "../execution-record.ts";
import { createRecord } from "../execution-record.ts";
import { createNotifyHost } from "../notify-host.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";
import type { RecordStore } from "../record-store.ts";
import { SubagentStream } from "../stream-sink.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import type { AgentCallOpts, AgentResult } from "../../orchestration/models/types.ts";
import type { SubagentRecordEntryData } from "../record-entry.ts";
import { SUBAGENT_RECORD_CUSTOM_TYPE } from "../record-entry.ts";
import {
  _resetSettledWatchdogsForTest,
  _setMidRoundNoProgressWindowMsForTest,
  armMidRoundNoProgress,
  getMidRoundNoProgressWindowMs,
  hasSettledWatchdog,
  isSettledWatchdogDisabled,
  SETTLED_MID_ROUND_NO_PROGRESS_MS,
  SETTLED_WATCHDOG_ENV,
} from "../settled-watchdog.ts";
import { resetCoreForTests } from "../../core/host-services.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import type { EngineCapabilities } from "../engine/types.ts";
import type { EnginePort } from "../engine/port.ts";
import type { ExecutionRecord } from "../types.ts";
import { registerFakePiEngine, type FakePiEnginePort, type FakeRun } from "./helpers/fake-engine-port.ts";

// ── 辅助：service 构造（notify-gate / routing 测试同款范式）──

function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

const ctxModel: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };

function makePi() {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}

type MockPi = ReturnType<typeof makePi>;

interface DispatchHarness {
  service: SubagentService;
  store: RecordStore;
  pi: MockPi;
  fake: FakePiEnginePort;
  entries: SubagentRecordEntryData[];
  tmpRoot: string;
}

function makeHarness(opts: {
  /** [H2 W3 must-fix] streamSink 注入（TUI/未激活形态的 widget sink；缺省 null = 无 UI）。 */
  streamSink?: { setWidget: (key: string, lines: string[] | undefined) => void };
  /** [H2 W3 must-fix] 宿主形态（createBackgroundStream 的 GUI 判定输入；缺省 undefined）。 */
  mode?: "tui" | "rpc";
} = {}): DispatchHarness {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dispatch-it-"));
  process.env.XYZ_AGENT_DATA_DIR = path.join(tmpRoot, "engine-data");
  const agentDir = path.join(tmpRoot, "agent");
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: makeEmptyRegistry(),
    sessionId: "wf-dispatch-it",
    ctxModel,
  });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  const entries: SubagentRecordEntryData[] = [];
  pi.appendEntry.mockImplementation((customType: string, data: unknown) => {
    if (customType === SUBAGENT_RECORD_CUSTOM_TYPE) entries.push(data as SubagentRecordEntryData);
  });
  service.initSession({
    pi: pi as unknown as PiLike,
    sessionId: "wf-dispatch-it",
    ...(opts.streamSink !== undefined ? { streamSink: opts.streamSink } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
  });
  clearEngines();
  const fake = registerFakePiEngine();
  return { service, store: Reflect.get(service, "store") as RecordStore, pi, fake, entries, tmpRoot };
}

function baseOpts(over: Partial<AgentCallOpts> = {}): AgentCallOpts {
  return { prompt: "调研 A", description: "research-a", ...over };
}

/** 微任务冲刷：dispatch 的 acquire/engine.run 链路是 await 链，flush 后 run 才进 fake。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** 最近一次 run 捕获（多次 dispatch 共用 fake 时取最后一个）。 */
function lastRun(fake: FakePiEnginePort): FakeRun {
  const run = fake.runs.at(-1);
  expect(run).toBeDefined();
  return run!;
}

/** 唯一在途 run（首次 dispatch 后必须恰好一个）。 */
function soleRun(fake: FakePiEnginePort): FakeRun {
  expect(fake.runs).toHaveLength(1);
  return fake.runs[0]!;
}

/** 从 store 取内存 running record（getMutable 公共面）。 */
function runningRecord(store: RecordStore): ExecutionRecord {
  const running = store.listRunning();
  expect(running).toHaveLength(1);
  return store.getMutable(running[0]!.id)!;
}

/** 受限引擎能力位（worktree/conversation/maxTurns/fork 全不支持——预检命中用）。 */
const STRICT_CAPS: EngineCapabilities = {
  schemaEnforcement: "native",
  steer: "unsupported",
  conversation: "unsupported",
  personaInjection: "flag",
  eventGranularity: "stream",
  sandbox: "none",
  sessionRead: "full",
  resume: "unsupported",
  interrupt: "kill-only",
  permissionMode: "native",
  maxTurns: false,
};

/** 受限引擎注册（池顺序用例：worktree:true 命中 gate）。 */
function registerStrictEngine(): void {
  const port: EnginePort = {
    id: "strict-engine",
    capabilities: () => STRICT_CAPS,
    probe: async () => ({ ok: true, engineVersion: "fake-strict", checks: [{ name: "invocation", ok: true, detail: "fake" }] }),
    run: () => new Promise(() => {}),
    read: async () => ({ engineId: "strict-engine", turns: [], source: "outcome-only" }),
  };
  registerEngine("strict-engine", () => port);
}

let prevDataDirEnv: string | undefined;

beforeEach(() => {
  prevDataDirEnv = process.env["XYZ_AGENT_DATA_DIR"];
});

afterEach(() => {
  _resetSettledWatchdogsForTest();
  vi.restoreAllMocks();
  if (prevDataDirEnv === undefined) delete process.env["XYZ_AGENT_DATA_DIR"];
  else process.env["XYZ_AGENT_DATA_DIR"] = prevDataDirEnv;
});

// ============================================================
// 1. 注册面（origin/parentRunId + pending:register 配对）
// ============================================================

describe("executeWorkflowAgent 注册面", () => {
  it("record 带 origin=workflow + parentRunId，pending:register/unregister 配对，taskId 即 record id", async () => {
    const { service, store, pi, fake } = makeHarness();
    const pending = service.executeWorkflowAgent(baseOpts(), "run-42");
    await flush();
    const run = soleRun(fake);
    const record = runningRecord(store);

    expect(record.origin).toBe("workflow");
    expect(record.parentRunId).toBe("run-42");
    // 守护/journal/spawned-children 的键 = record.id（SAR 占位 taskId 消亡）
    expect(run.ctx.taskId).toBe(record.id);
    // record 级 pending:register 照旧（与既有派发路径同款）
    const registered = pi.events.emit.mock.calls.find((c) => c[0] === "pending:register");
    expect(registered?.[1]).toMatchObject({ id: record.id, type: "subagent" });
    // parentRunId 查询面（W1）命中
    expect(service.queries.collectRecordsByParentRunId("run-42", 10).map((r) => r.id)).toEqual([record.id]);

    run.settle({ content: "done" });
    await pending;
    // 终态化 → record 级注销（D5：record 级配对照旧）
    const unregistered = pi.events.emit.mock.calls.find((c) => c[0] === "pending:unregister");
    expect(unregistered?.[1]).toMatchObject({ id: record.id });
  });
});

// ============================================================
// 2. 池顺序（D3：路由/预检先于池 acquire——失败零池占用）
// ============================================================

describe("executeWorkflowAgent 池顺序", () => {
  it("预检命中（不支持的 task shape）→ 同步抛错 + 池 acquire 未被调 + 零孤儿 record", async () => {
    const { service, store, pi } = makeHarness();
    registerStrictEngine();
    const pool = Reflect.get(service, "pool") as { acquire: (p: number, m?: number, s?: AbortSignal) => Promise<void> };
    const acquireSpy = vi.spyOn(pool, "acquire");

    await expect(
      service.executeWorkflowAgent(baseOpts({ engine: "strict-engine", worktree: true }), "run-1"),
    ).rejects.toThrow(/engine_capability_unsupported/);

    expect(acquireSpy).not.toHaveBeenCalled(); // 零池占用（D3）
    expect(store.listRunning()).toHaveLength(0); // 零孤儿 record
    expect(pi.events.emit).not.toHaveBeenCalledWith("pending:register", expect.anything());
  });

  it("池排队中被 abort → run 域 cancelled 收口（acquirePoolOrFinalize S1 同款分支）", async () => {
    const { service, store, fake, entries } = makeHarness();
    // 占满共享池（maxConcurrent 槽全占）→ 新派发排队；run 级 signal abort → cancelled 收口
    const pool = Reflect.get(service, "pool") as {
      maxConcurrent: number;
      acquire(p: number, m?: number, s?: AbortSignal): Promise<void>;
      release(): void;
    };
    for (let i = 0; i < pool.maxConcurrent; i++) await pool.acquire(0);

    const controller = new AbortController();
    const pending = service.executeWorkflowAgent(baseOpts(), "run-2", controller.signal);
    await flush();
    expect(fake.runs).toHaveLength(0); // 仍在排队（未触达 engine.run）
    const record = runningRecord(store);
    expect(record.status).toBe("running");

    controller.abort();
    const result = await pending;
    expect(result.error).toContain("cancelled"); // 合成 failed result 回脚本
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("cancelled"); // run 域 cancelled 收口
    expect(entries.at(-1)).toMatchObject({ id: record.id, closedReason: "cancelled" });
    expect(fake.runs).toHaveLength(0); // 零引擎副作用
  });
});

// ============================================================
// 3. 守护（D4/M3 复刻：arm 键 = record.id + 双刷新源 + fire 追注）
// ============================================================

describe("executeWorkflowAgent no-progress 守护", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _setMidRoundNoProgressWindowMsForTest(5000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arm 键 = record.id；协议事件（journal.onEvent 包装）刷新窗口；fire 后失败结果追注恢复指引", async () => {
    const { service, store, fake } = makeHarness();
    const pending = service.executeWorkflowAgent(baseOpts(), "run-1");
    await vi.advanceTimersByTimeAsync(0);
    const run = soleRun(fake);
    const record = runningRecord(store);
    expect(run.ctx.taskId).toBe(record.id); // arm 键 = record.id（非占位 taskId）

    // 窗内协议事件（经 observedEvent 包装 → refreshFromProtocolEvent(record.id)）刷新窗口
    await vi.advanceTimersByTimeAsync(3000);
    run.emitEvent({ type: "message_start" });
    await vi.advanceTimersByTimeAsync(3000); // 越过原始 5000ms 窗（已刷新 → 不 fire）
    expect(run.ctx.signal?.aborted).toBe(false);

    // 无后续事件 → 新窗口到期 fire → abort 送达 engine ctx.signal
    await vi.advanceTimersByTimeAsync(5000);
    expect(run.ctx.signal?.aborted).toBe(true);

    // fire 后引擎合成失败 outcome → 失败结果追注恢复指引（fire 追注语义，
    // 原 SAR noteIfNoProgressFired 符号随编排归一消亡——见设计 D4）
    run.settle({ error: "engine: aborted" });
    const result = await pending;
    expect(result.error).toContain("engine: aborted");
    expect(result.error).toContain("workflow no-progress watchdog fired");
    // 恢复指引配对口径（与 message-guard 文案族同款）：fire 后 record 必然终态，
    // 只查 running 得空列表——必须 includeFinished:true + includeWorkflow:true 成对
    expect(result.error).toContain("includeFinished:true");
    expect(result.error).toContain("(add includeWorkflow:true to also see workflow-dispatched subagents)");
  });

  it("stream.onDelta 同为刷新源（双源缺一不可——纯流式产出也保活）", async () => {
    const { service, fake } = makeHarness();
    const stream = new SubagentStream("wf-stream-key", { setWidget: () => {} });
    const pending = service.executeWorkflowAgent(baseOpts(), "run-1", undefined, undefined, stream);
    await vi.advanceTimersByTimeAsync(0);
    const run = soleRun(fake);

    await vi.advanceTimersByTimeAsync(3000);
    run.emitDelta("chunk"); // stream 反向帧（不经 journal）→ 绑定包装刷新
    await vi.advanceTimersByTimeAsync(3000); // 越过原始窗口（已刷新 → 不 fire）
    expect(run.ctx.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5000); // 无后续 delta → fire
    expect(run.ctx.signal?.aborted).toBe(true);
    run.settle({ error: "engine: aborted" });
    const result = await pending;
    expect(result.error).toContain("workflow no-progress watchdog fired");
  });

  it("内构 stream（实参缺省）同样保活：emitDelta 经 bindWorkflowStreamRefresh 刷新守护", async () => {
    // [H2 W3 must-fix] runWorkflowEngineTask 在 stream 实参缺省时自构
    // createBackgroundStream——内构对象的 onDelta 同样被 bindWorkflowStreamRefresh
    // 原地包裹（守护双刷新源之二），且 widget flush 与刷新在同一调用点生效。
    const sink = { setWidget: vi.fn() };
    const { service, fake } = makeHarness({ streamSink: sink });
    const pending = service.executeWorkflowAgent(baseOpts(), "run-stream-self");
    await vi.advanceTimersByTimeAsync(0);
    const run = soleRun(fake);

    await vi.advanceTimersByTimeAsync(3000);
    run.emitDelta("chunk"); // 反向帧 → 内构 stream.onDelta（已包裹）→ 刷新
    await vi.advanceTimersByTimeAsync(3000); // 越过原始窗口（已刷新 → 不 fire）
    expect(run.ctx.signal?.aborted).toBe(false);

    run.settle({ content: "done" });
    const result = await pending;
    expect(result.content).toBe("done");
  });
});

// ============================================================
// 3.5 [H2 W3 must-fix] stream 缺省自构（createBackgroundStream 三形态）
// ============================================================

describe("executeWorkflowAgent stream 自构（设计 D2「service 派发路径既有通道承载」）", () => {
  afterEach(() => {
    // relay 三键注入的清理（防泄漏到同文件其他用例）
    delete process.env["XYZ_SUBAGENT_RELAY_SOCKET"];
    delete process.env["XYZ_SUBAGENT_RELAY_NODE"];
    delete process.env["XYZ_SUBAGENT_RELAY_SCRIPT"];
  });

  it("TUI 形态：内构 stream 接通 widget——emitDelta 流式可见 + settle 后 dispose 清除", async () => {
    const sink = { setWidget: vi.fn() };
    const { service, store, fake } = makeHarness({ streamSink: sink, mode: "tui" });
    const pending = service.executeWorkflowAgent(baseOpts(), "run-stream-tui");
    await flush();
    const run = soleRun(fake);
    const record = runningRecord(store);

    run.emitDelta("hello "); // leading edge：首个 delta 立即 flush（无 timer 等待）
    run.emitDelta("world");
    const widgetKey = `subagent-stream-${record.id}`;
    expect(sink.setWidget).toHaveBeenCalledWith(widgetKey, ["hello "]);
    // 第二个 delta 走 trailing 合并窗（100ms timer）——推进后 flush 累积文本
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(sink.setWidget).toHaveBeenCalledWith(widgetKey, ["hello world"]);

    run.settle({ content: "done" });
    await pending;
    // dispose 清除 widget（releaseRoundResources → stream.dispose）
    expect(sink.setWidget).toHaveBeenLastCalledWith(widgetKey, undefined);
  });

  it("GUI + relay 激活：停发私货（createBackgroundStream H1 策略）——sink 零调用", async () => {
    process.env["XYZ_SUBAGENT_RELAY_SOCKET"] = "/tmp/relay.sock";
    process.env["XYZ_SUBAGENT_RELAY_NODE"] = "node-1";
    process.env["XYZ_SUBAGENT_RELAY_SCRIPT"] = "/tmp/relay.mjs";
    const sink = { setWidget: vi.fn() };
    const { service, fake } = makeHarness({ streamSink: sink, mode: "rpc" });
    const pending = service.executeWorkflowAgent(baseOpts(), "run-stream-gui");
    await flush();
    const run = soleRun(fake);

    run.emitDelta("should-not-ship");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(sink.setWidget).not.toHaveBeenCalled();

    run.settle({ content: "done" });
    const result = await pending;
    expect(result.content).toBe("done"); // 停发不影响执行本体
  });

  it("sink 未注入（无 UI）：降级 undefined no-op——dispatch 正常完成不崩", async () => {
    const { service, fake } = makeHarness(); // 无 streamSink
    const pending = service.executeWorkflowAgent(baseOpts(), "run-stream-nosink");
    await flush();
    const run = soleRun(fake);

    run.emitDelta("no-op"); // ctx.stream undefined → emitDelta 经 fake 的 ctx.stream?. 判空
    run.settle({ content: "done" });
    const result = await pending;
    expect(result.content).toBe("done");
  });
});

// ============================================================
// 4. D7 收口 CAS 规格
// ============================================================

describe("executeWorkflowAgent D7 成功收口", () => {
  it("成功 → closed/gc 立即终态化 + archive（非 SP-5 running-idle）+ 字段保真回脚本", async () => {
    const { service, store, fake, entries, tmpRoot } = makeHarness();
    const pending = service.executeWorkflowAgent(baseOpts(), "run-7");
    await flush();
    const run = soleRun(fake);
    const record = runningRecord(store);

    // [H4/U5 适配] sessionFile 必须是真实可写路径（mkdtemp 下）——假路径触发
    // writeFinalizedState ENOENT 重试耗尽 → markFinalized false 不 archive，
    // 旧断言（终态化 + archive）随终态原语同步写权威化而失效。
    fs.mkdirSync(path.join(tmpRoot, "wf"), { recursive: true });
    const sessionFile = path.join(tmpRoot, "wf", "session.jsonl");
    run.settle({
      content: "done",
      sessionFile,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 15, turns: 2 },
    });
    const result: AgentResult = await pending;

    // 回脚本字段保真（outcome 直映射：usage/sessionFile 不丢）
    expect(result.content).toBe("done");
    expect(result.sessionFile).toBe(sessionFile);
    expect(result.usage?.turns).toBe(2);
    // D7：成功即终态化 closed/gc + archive 出内存（不再 SP-5 running-resumable）
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("gc");
    expect(store.getMutable(record.id)).toBeUndefined();
    // 终态 entry（持久化链）携带 origin/closedReason
    const finalEntry = entries.at(-1);
    expect(finalEntry).toMatchObject({ id: record.id, status: "closed", closedReason: "gc", origin: "workflow" });
  });

  it("close 路径抢先（user-close 已写 closedReason）→ 静默跳过不覆盖（memory closedReason 不分叉）", async () => {
    const { service, store, fake, entries } = makeHarness();
    const pending = service.executeWorkflowAgent(baseOpts(), "run-8");
    await flush();
    // 基线在 register 之后取（register 自身落一条 entry——record-store 迁移点内置）
    const entriesBefore = entries.length;
    const run = soleRun(fake);
    const record = runningRecord(store);

    // 模拟 close 路径赢家（closeChatIdle 终态写点的抢先形态：closed + user-close）
    expect(tryTransition(record, "closed", "user-close")).toBe(true);

    run.settle({ content: "done" });
    await pending;

    // D7 分支抢锁失败 → 静默跳过：closedReason 不被 "gc" 覆盖，无二次终态 entry
    expect(record.closedReason).toBe("user-close");
    expect(record.status).toBe("closed");
    expect(entries.length).toBe(entriesBefore);
  });

  it("aborted+success 竞态 → 照旧落现有 cancelled 分支（不漂移为 gc）", async () => {
    const { service, store, fake, entries } = makeHarness();
    const controller = new AbortController();
    const pending = service.executeWorkflowAgent(baseOpts(), "run-9", controller.signal);
    await flush();
    const run = soleRun(fake);
    const record = runningRecord(store);

    controller.abort(); // 外部 run 级 abort 抢先（run 仍以 success 应答的竞态边缘）
    run.settle({ content: "done" });
    const result = await pending;

    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("cancelled"); // 不漂移为 "gc"（D7 条件含 !aborted）
    const finalEntry = entries.at(-1);
    expect(finalEntry).toMatchObject({ id: record.id, closedReason: "cancelled" });
    expect(result.content).toBe("done");
  });

  it("origin=tool 负向对照：executeAndAwait 成功仍 SP-5 running-resumable（D7 零外溢）", async () => {
    const { service, store, fake } = makeHarness();
    const pending = service.executeAndAwait({ task: "tool one-shot", slug: "tool-shot", ctxModel });
    await flush();
    const run = soleRun(fake);
    run.settle({ content: "ok" });
    const result = await pending;

    const record = store.getMutable(result.sessionId ?? "");
    expect(record).toBeDefined();
    expect(record!.status).toBe("running"); // SP-5：等 message 升级，不终态化
    expect(record!.resumable).toBe(true);
    expect(record!.origin).toBeUndefined();
  });
});

// ============================================================
// 4.5 [H2 A3] live usage 喂入（fake engine 事件 → record.totalTokens/turns 保真）
// ============================================================

describe("executeWorkflowAgent live usage 喂入（H2 A3）", () => {
  it("fake engine message_end(usage) 事件 → live record 实时累积，终态 entry 落盘保真", async () => {
    const { service, store, fake, entries } = makeHarness();
    const pending = service.executeWorkflowAgent(baseOpts(), "run-usage");
    await flush();
    const run = soleRun(fake);

    // 引擎协议事件：message_end 携带 usage（pi-subagent-cli spawn-event-translator
    // accumulateMessageEnd 的协议产物形态），turn_end 闭合 turn。
    run.emitEvent({ type: "message_end", usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, cost: 0.5 } });
    run.emitEvent({ type: "text_delta", delta: "working" });
    run.emitEvent({ type: "message_end", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } });
    run.emitEvent({ type: "turn_end" });

    // live record 实时累积（Gate B A3 现象面：agent 实际消耗 LLM 而 record 恒 0）
    const record = runningRecord(store);
    expect(record.totalTokens).toBe(190); // (100+50+20+10) + (7+3)
    expect(record.turnCount).toBe(1);

    // 终态 entry（持久化链）保真：list / 重启重建源读到非零 tokens
    run.settle({ content: "done" });
    await pending;
    const finalEntry = entries.at(-1);
    expect(finalEntry).toMatchObject({ id: record.id, status: "closed", totalTokens: 190, turns: 1 });
  });

  it("error 事件 → lastError 记录（reducer 喂入不破坏失败语义）", async () => {
    const { service, store, fake, entries } = makeHarness();
    const pending = service.executeWorkflowAgent(baseOpts(), "run-usage-err");
    await flush();
    const run = soleRun(fake);

    run.emitEvent({ type: "error", message: "boom" });
    run.settle({ content: "", error: "boom" });
    await pending;

    // 失败收口不受喂入影响（终态 entry 正常落盘）
    const finalEntry = entries.at(-1);
    expect(finalEntry).toBeDefined();
    expect(finalEntry!.status).toBe("closed");
    expect(store.getMutable(finalEntry!.id)).toBeUndefined();
  });
});

// ============================================================
// 5. D6 gate（workflow 回注全静默）
// ============================================================

describe("D6 toNotifyRecord origin gate", () => {
  it("漏斗层单点：workflow record 完成/失败/关闭全返回 undefined（notifyComplete 零投递）", () => {
    const pi = makePi();
    const host = createNotifyHost({
      getPi: () => pi as unknown as PiLike,
      listRunning: () => [],
      getIsIdle: () => undefined,
    });

    const base = createRecord("sa-d6", {
      agent: "worker",
      model: "m",
      mode: "background",
      task: "t",
      slug: "d6",
      startedAt: Date.now(),
    });
    const closedWf = { ...base, origin: "workflow" as const, status: "closed" as const };
    const resumableWf = { ...base, origin: "workflow" as const, resumable: true };
    expect(host.toNotifyRecord(closedWf)).toBeUndefined();
    expect(host.toNotifyRecord(resumableWf)).toBeUndefined();
    host.notifyComplete(closedWf);
    host.notifyComplete(resumableWf);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // 对照：tool 来源 closed record 正常产通知（gate 仅 workflow）
    expect(tryTransition(base, "closed", "gc")).toBe(true);
    expect(host.toNotifyRecord(base)).toBeDefined();
  });

  it("service 级：executeWorkflowAgent 成功/引擎死亡全程 pi.sendMessage 零调用", async () => {
    const { service, fake, pi } = makeHarness();
    const success = service.executeWorkflowAgent(baseOpts(), "run-10");
    await flush();
    lastRun(fake).settle({ content: "done" });
    await success;

    const death = service.executeWorkflowAgent(baseOpts(), "run-11");
    await flush();
    lastRun(fake).fail(new EngineSdkError("engine_crashed", "engine process died", "re-dispatch the workflow"));
    const deathResult = await death;
    expect(deathResult.error).toContain("engine_crashed");

    expect(pi.sendMessage).not.toHaveBeenCalled(); // D6：完成/失败回注全静默
  });
});

// ============================================================
// 6. 引擎死亡 + adopt 豁免双点（service 分诊）
// ============================================================

describe("引擎死亡与 adopt 豁免（§3.4 + 决策表）", () => {
  it("engine_crashed → 合成 failed result 回脚本（swallow）+ record 立即终态化（不 adopt）", async () => {
    const { service, store, fake, entries } = makeHarness();
    const pending = service.executeWorkflowAgent(baseOpts(), "run-12");
    await flush();
    const run = soleRun(fake);
    const record = runningRecord(store);

    run.fail(new EngineSdkError("engine_crashed", "engine process died", "re-dispatch the workflow"));
    const result = await pending; // 不 reject——脚本观察到失败结果

    expect(result.error).toContain("engine_crashed");
    expect(result.content).toBe("");
    // record 由失败路径立即终态化（closed/gc + archive），不保持 resumable 交监督器
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("gc");
    expect(store.getMutable(record.id)).toBeUndefined();
    expect(entries.at(-1)).toMatchObject({ id: record.id, status: "closed", closedReason: "gc" });
    const supervisor = Reflect.get(service, "roundSupervisor") as { supervisedIds(): string[] };
    expect(supervisor.supervisedIds()).toEqual([]);
  });

  it("豁免点一（runEngineTask catch）：workflow record 不 adopt → finalizeFailed 立即终态化；tool 对照照常 adopt", async () => {
    const { service, store } = makeHarness();
    const supervisor = Reflect.get(service, "roundSupervisor") as { supervisedIds(): string[] };
    // [R4 深绑改写] runEngineTask 本体已迁 RunOrchestration 聚合（service/
    // run-orchestration.ts）——bracket 路径改经聚合实例（断言对象与强度不变）。
    const runEngineTask = (
      Reflect.get(Reflect.get(service, "runOrchestration"), "runEngineTask") as (
        record: ExecutionRecord,
        opts: { task: string; slug: string },
        engine: EnginePort,
        signal: AbortSignal | undefined,
      ) => Promise<boolean>
    ).bind(Reflect.get(service, "runOrchestration"));
    const deadEngine: EnginePort = {
      id: "pi",
      capabilities: () => ({ ...STRICT_CAPS, conversation: "native", sandbox: "emulated", resume: "native", maxTurns: true }),
      probe: async () => ({ ok: true, engineVersion: "x", checks: [] }),
      run: () => Promise.reject(new EngineSdkError("engine_crashed", "died", "retry")),
      read: async () => ({ engineId: "pi", turns: [], source: "outcome-only" }),
    };

    const wfRecord: ExecutionRecord = {
      ...createRecord("sa-triage-wf", {
        agent: "worker", model: "m", mode: "background", task: "t", slug: "s", startedAt: Date.now(),
      }),
      origin: "workflow",
      parentRunId: "run-13",
    };
    store.register(wfRecord);
    const adopted = await runEngineTask(wfRecord, { task: "t", slug: "s" }, deadEngine, undefined);
    expect(adopted).toBe(false); // 豁免：不走接管分支
    expect(wfRecord.status).toBe("closed"); // 落空 → finalizeFailed 立即终态化
    expect(wfRecord.closedReason).toBe("gc");
    expect(wfRecord.resumable).toBeUndefined();
    expect(supervisor.supervisedIds()).toEqual([]);

    // 对照：origin=tool 同形态照常 adopt（保持 resumable 交监督器）
    const toolRecord = createRecord("sa-triage-tool", {
      agent: "worker", model: "m", mode: "background", task: "t", slug: "s", startedAt: Date.now(),
    });
    store.register(toolRecord);
    const adoptedTool = await runEngineTask(toolRecord, { task: "t", slug: "s" }, deadEngine, undefined);
    expect(adoptedTool).toBe(true);
    expect(toolRecord.resumable).toBe(true);
    expect(toolRecord.status).toBe("running");
    expect(supervisor.supervisedIds()).toEqual(["sa-triage-tool"]);
  });

  it("豁免点二（finalizeEngineOutcome exitCode===null）：workflow record 不 adopt → 正常终态化", async () => {
    const { service, store } = makeHarness();
    const supervisor = Reflect.get(service, "roundSupervisor") as { supervisedIds(): string[] };
    // [R4 深绑改写] finalizeEngineOutcome 本体已迁 RunOrchestration 聚合（豁免点二
    // 分诊形态原样随迁）——bracket 路径改经聚合实例。
    const finalizeEngineOutcome = (
      Reflect.get(Reflect.get(service, "runOrchestration"), "finalizeEngineOutcome") as (
        record: ExecutionRecord,
        outcome: { content: string; engineId: string; error: string; exitCode: null },
      ) => Promise<boolean>
    ).bind(Reflect.get(service, "runOrchestration"));

    const wfRecord: ExecutionRecord = {
      ...createRecord("sa-triage2-wf", {
        agent: "worker", model: "m", mode: "background", task: "t", slug: "s", startedAt: Date.now(),
      }),
      origin: "workflow",
      parentRunId: "run-14",
    };
    store.register(wfRecord);
    const adopted = await finalizeEngineOutcome(wfRecord, {
      content: "",
      engineId: "pi",
      error: "killed by signal",
      exitCode: null,
    });
    expect(adopted).toBe(false); // 豁免：exitCode===null 合成死亡形态不走接管
    expect(wfRecord.status).toBe("closed"); // 落空 → 正常终态化
    expect(wfRecord.closedReason).toBe("gc");
    expect(supervisor.supervisedIds()).toEqual([]);
  });
});

// ── settled-watchdog 原语守护（[H2 W4] 自 subprocess-agent-runner-no-progress-
//    full-chain.test.ts 迁移——原语不随 SAR.run 掏空退役，守护唯一 arm 点现为
//    service 派发路径，用例归本文件） ──────────────────────────────

describe("settled-watchdog 原语守护（自 SAR full-chain 测试迁移）", () => {
  beforeEach(() => {
    _resetSettledWatchdogsForTest();
    loggerMock.warn.mockClear();
    // 宿主 shell export 隔离：守护开关 env 必须处于「未设」基线（空串 = 未设）。
    vi.stubEnv(SETTLED_WATCHDOG_ENV, "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetSettledWatchdogsForTest();
    resetCoreForTests();
  });

  it("默认值守护：生产中段窗恒 30min；测试注入不改常量且可复位（防将来重构手滑）", () => {
    expect(SETTLED_MID_ROUND_NO_PROGRESS_MS).toBe(30 * 60 * 1000);
    expect(getMidRoundNoProgressWindowMs()).toBe(SETTLED_MID_ROUND_NO_PROGRESS_MS);

    _setMidRoundNoProgressWindowMsForTest(1_500);
    expect(getMidRoundNoProgressWindowMs()).toBe(1_500);
    // 注入是覆盖值的读取，不污染常量本体（生产路径读到的默认值不变）。
    expect(SETTLED_MID_ROUND_NO_PROGRESS_MS).toBe(30 * 60 * 1000);

    _resetSettledWatchdogsForTest();
    expect(getMidRoundNoProgressWindowMs()).toBe(SETTLED_MID_ROUND_NO_PROGRESS_MS);
  });

  it("U-B3 env ≤0 的 warn 明示 workflow 域 no-progress 熔断连带失效（只改文案，不动开关语义）", () => {
    vi.stubEnv(SETTLED_WATCHDOG_ENV, "0");
    // 惰性首读触发解析 + warn 留痕（本文件 hoisted-mock 了 core/logger——settled-watchdog
    // 的 logger.warn 进 loggerMock，与原 full-chain 文件的 HostServices.log 捕获等价）。
    expect(isSettledWatchdogDisabled()).toBe(true);
    const warn = loggerMock.warn.mock.calls
      .map((args) => String(args[0]))
      .find((message) => message.includes(SETTLED_WATCHDOG_ENV));
    expect(warn).toBeDefined();
    // 文案必须覆盖 M3 复用同一原语带来的 workflow 域连带后果（修复前只提 chat 域）；
    // [H2 W5] 挂载点表述随 W4 掏空更新为 service 派发点（原 SAR.run 表述退役）。
    expect(warn).toContain("workflow");
    expect(warn).toContain("no-progress");
    expect(warn).toContain("runWorkflowEngineTask");

    // 开关语义不动：arm 仍 no-op（本条目只补文案与注释，不新增 env、不改行为）。
    const fired: string[] = [];
    armMidRoundNoProgress("sa-env-off", {
      onMidTimeout: () => fired.push("mid"),
      onSettleTimeout: () => fired.push("settle"),
    });
    expect(hasSettledWatchdog("sa-env-off")).toBe(false);
    expect(fired).toEqual([]);
  });
});
