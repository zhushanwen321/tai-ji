// src/execution/__tests__/subagent-service-notify-gate.test.ts
//
// [u-svc / T4] 通知可靠性（subagent-service 侧三措施）：
//   - T4①/PS-2：kickOffChatRound.then notify 门按 closedReason 白名单放行——
//     parent-new/parent-fork 不注入（可能已切换的）新 session（A-6 决策落实）；
//   - T4②/PS-4：idleTimeoutMs 非法值（>2^31-1 / 非有限值）在 spawn 入口同步 fail-fast，
//     错误含合法范围（不静默 clamp、不静默不挂）；
//   - T4④/PS-5：shutdown flush 被 isIdle 门拦时，未投递 pending 复写落盘（ledger entry
//     通道，notifyId 幂等）供重启 replay——修复「flush 后 dispose 防丢失」注释承诺差距。
//
// mock 形态沿用 subagent-service-message-close.test.ts；notify-ledger 用真模块
//（bindNotifyLedgerHost + fake host 构造 pending）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// [W3 改写] 原 vi.mock(inproc pi 引擎目录/session-runner) 随删件消亡——chat 轮次走协议 seam
//（registerFakePiEngine 替身，kickOffChatRound 的 notify 门经 engine.run 应答驱动）。
import { registerFakePiEngine } from "./helpers/fake-engine-port.ts";
import { clearEngines } from "../engine/registry.ts";
import { bindNotifyLedgerHost, NOTIFY_LEDGER_CUSTOM_TYPE, _resetNotifyLedgerForTest } from "../notify-ledger.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { RecordStore } from "../record-store.ts";
import { notifyGateAllowsDelivery, SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import { MAX_TIMER_DELAY_MS } from "../../shared/timer-delay.ts";
import type { ExecutionRecord } from "../types.ts";

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "svc-notify-gate-"));
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
  sendMessage: ReturnType<typeof vi.fn>;
  on?: ReturnType<typeof vi.fn>;
} {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike & {
    appendEntry: ReturnType<typeof vi.fn>;
    events: { emit: ReturnType<typeof vi.fn> };
    sendMessage: ReturnType<typeof vi.fn>;
    on?: ReturnType<typeof vi.fn>;
  };
}

interface ServiceInternals {
  store: RecordStore;
}

type MockPi = ReturnType<typeof makePi>;

function setup(initOverrides: Partial<{ isIdle: () => boolean }> = {}): {
  agentDir: string;
  service: SubagentService;
  store: RecordStore;
  pi: MockPi;
} {
  const agentDir = makeTmpAgentDir();
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "root-session", isIdle: initOverrides.isIdle });
  const store = (service as unknown as ServiceInternals).store;
  return { agentDir, service, store, pi };
}

describe("T4① notify gate 三元组（[U5 / §3.2.7] 归档静默 / 放弃轮标记阻断 / 其余放行）", () => {
  it("blocks archived (gate ①) and abandoned-round hits (gate ②); allows settled/running without marks", () => {
    // ① intent=archived 静默（承接原 parent-new/parent-fork 阻断——编排性关闭即自动收起）。
    expect(notifyGateAllowsDelivery({ intent: "archived" })).toBe(false);
    // ② 放弃轮标记命中（承接原 cancelled 阻断防双发）：同世代回注轮 ≤ 标记轮 → 丢弃。
    expect(
      notifyGateAllowsDelivery({ lastAbandonedRound: { epoch: 0, round: 2 }, round: 2 }),
    ).toBe(false);
    // ② 两步判定第一步：回注声明世代 ≠ record 当前世代 → 丢弃。
    expect(
      notifyGateAllowsDelivery(
        { epoch: 1, lastAbandonedRound: { epoch: 0, round: 2 } },
        { epoch: 0, round: 2 },
      ),
    ).toBe(false);
    // ② 标记槽世代 ≠ 当前世代（reopen 残留）→ 标记自然失效，新世代正常轮放行。
    expect(
      notifyGateAllowsDelivery({ epoch: 1, round: 1, lastAbandonedRound: { epoch: 0, round: 2 } }),
    ).toBe(true);
    // 正常轮（round 已推进越过旧标记）放行——重复帧由 notifyId 去重兜底。
    expect(
      notifyGateAllowsDelivery({ round: 3, lastAbandonedRound: { epoch: 0, round: 2 } }),
    ).toBe(true);
    // 无标记无归档（settle 竞态迟到回注、user-close/gc 等真实收口）照旧回注。
    expect(notifyGateAllowsDelivery({})).toBe(true);
    expect(notifyGateAllowsDelivery({ round: 5 })).toBe(true);
  });

  it("kickOffChatRound 应答回注不注入 archived records（[U5] 编排性关闭自动收起 → gate ①静默）", async () => {
    const { agentDir, service, store, pi } = setup();
    clearEngines();
    const fake = registerFakePiEngine();
    const record = createRecord("sa-gate-new", {
      agent: "general-purpose",
      model: "test/model",
      mode: "background",
      slug: "t",
      task: "test",
      startedAt: 1000,
      rootSessionId: "root-session",
      controller: new AbortController(),
    });
    // 模拟 disposeAllRecords 先行编排性关闭（自动收起）后，迟到的 kickOffChatRound
    // 应答回注。[U5 适配] 新形态 = idle + intent=archived + 放弃轮标记（gate ①②
    // 双重阻断）——record 补 register 进 store 对齐「store 外 record 无编排性关闭
    // 可达」的生产形态。
    record.status = "idle";
    record.intent = "archived";
    record.lastAbandonedRound = { epoch: 0, round: 0 };
    store.register(record);
    // [W3] 轮次编排入口 kickOffChatRound（私有，bracket 调用先例）——协议 run 发起后
    // 挂起，编排性关闭先行，再模拟引擎应答（迟到回注被门拦）。
    // [R4 深绑改写] kickOffChatRound 本体已迁 RunOrchestration 聚合——bracket 路径
    // 改经聚合实例（断言对象与强度不变；this 绑定 = 聚合实例，即方法真实宿主）。
    const orchestration = (
      service as unknown as { runOrchestration: { kickOffChatRound: (...args: unknown[]) => void } }
    ).runOrchestration;
    const identity = {
      agent: "general-purpose",
      agentConfig: undefined,
      resolved: { model: { id: "model", name: "Model", provider: "test", reasoning: false }, thinkingLevel: undefined },
    };
    orchestration.kickOffChatRound(record, { task: "t", slug: "gate" }, identity, undefined, 1000);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "late round text" });
    await Promise.resolve();
    await Promise.resolve();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    service.dispose();
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("kickOffChatRound 应答回注对真实失败收口（gc 遗留形态）仍通知", async () => {
    const { agentDir, service, store, pi } = setup();
    clearEngines();
    const fake = registerFakePiEngine();
    const record = createRecord("sa-gate-gc", {
      agent: "general-purpose",
      model: "test/model",
      mode: "background",
      slug: "t",
      task: "test",
      startedAt: 1000,
      rootSessionId: "root-session",
      controller: new AbortController(),
    });
    // 同上：失败收口（idle + gc 遗留展示位——[U2 桥接] 旧终态形态读侧兼容）+
    // register 进 store 的完整生产形态——迟到回注按 CAS 输家路径走，三元组无阻断。
    record.status = "idle";
    record.endedAt = Date.now();
    record.closedReason = "gc";
    store.register(record);
    // [R4 深绑改写] kickOffChatRound 本体已迁 RunOrchestration 聚合——bracket 路径
    // 改经聚合实例（断言对象与强度不变；this 绑定 = 聚合实例，即方法真实宿主）。
    const orchestration = (
      service as unknown as { runOrchestration: { kickOffChatRound: (...args: unknown[]) => void } }
    ).runOrchestration;
    const identity = {
      agent: "general-purpose",
      agentConfig: undefined,
      resolved: { model: { id: "model", name: "Model", provider: "test", reasoning: false }, thinkingLevel: undefined },
    };
    orchestration.kickOffChatRound(record, { task: "t", slug: "gate" }, identity, undefined, 1000);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "round" });
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled());
    service.dispose();
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
});

describe("T4② idleTimeoutMs entry fail-fast", () => {
  let agentDir: string;
  let service: SubagentService;

  beforeEach(() => {
    ({ agentDir, service } = setup());
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("execute rejects idleTimeoutMs above the setTimeout limit with the valid range in the message", async () => {
    await expect(service.execute({ task: "x", slug: "test", idleTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).rejects.toThrow(
      new RegExp(`${MAX_TIMER_DELAY_MS}`),
    );
    await expect(service.execute({ task: "x", slug: "test", idleTimeoutMs: 3_000_000_000 })).rejects.toThrow(/2\^31-1/);
  });

  it("execute rejects non-finite idleTimeoutMs", async () => {
    await expect(service.execute({ task: "x", slug: "test", idleTimeoutMs: Number.NaN })).rejects.toThrow(/not a finite number/);
  });

  it("rejects before any record is created (no side effects)", async () => {
    const internals = service as unknown as ServiceInternals;
    await expect(service.executeAndAwait({ task: "x", slug: "test", idleTimeoutMs: 3_000_000_000 })).rejects.toThrow();
    expect(internals.store.listRunning()).toHaveLength(0);
  });

  it("accepts valid values (0 = explicit disable, positive within limit)", async () => {
    // 校验通过后执行链继续（runSpawn 被 mock，返回 undefined result 会在后续流程抛错/
    // 返回——但绝不能是 idleTimeoutMs 校验错误）
    await expect(service.execute({ task: "x", slug: "test", idleTimeoutMs: 0 })).rejects.not.toThrow(/idleTimeoutMs/);
  });
});

describe("T4④ shutdown flush blocked → pending persisted for replay", () => {
  let agentDir: string;
  let service: SubagentService;
  let pi: MockPi;

  beforeEach(() => {
    _resetNotifyLedgerForTest();
    ({ agentDir, service, pi } = setup({ isIdle: () => false }));
  });

  afterEach(() => {
    _resetNotifyLedgerForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("persists undelivered pending notifications as ledger entries on dispose when main agent is busy", () => {
    // 绑定真 ledger 并制造一条未投递 pending（isIdle=false → attemptDeliver 挂回 pending）
    const ledger = bindNotifyLedgerHost({
      appendLedgerEntry: (customType, data) => pi.appendEntry(customType, data),
      readSessionEntries: () => [],
      isIdle: () => false,
      onAgentSettled: () => {},
      sendDelivery: (message) => pi.sendMessage(message as never),
    });
    const recorded = ledger.record("notify-1", "Subagent x completed", { id: "sa-x", agent: "x" });
    expect(recorded).toBe(true);
    expect(ledger.pendingEntries()).toHaveLength(1);

    service.dispose();

    // 复写落盘：NOTIFY_LEDGER_CUSTOM_TYPE entry 携带 notifyId（幂等键）+ v1 schema
    const replayEntries = pi.appendEntry.mock.calls.filter(
      (c) => c[0] === NOTIFY_LEDGER_CUSTOM_TYPE && (c[1] as { notifyId?: string })?.notifyId === "notify-1",
    );
    expect(replayEntries.length).toBeGreaterThanOrEqual(2); // record 原账 + dispose 复写
    expect(replayEntries[0]?.[1]).toMatchObject({ v: 1, notifyId: "notify-1" });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("persisted to ledger for replay"),
      expect.objectContaining({ count: 1 }),
    );
    // 重启 replay 可重放：新 ledger 实例扫账面（含复写 entry）应入账该 pending
    const host2 = {
      appendLedgerEntry: vi.fn(),
      readSessionEntries: () =>
        pi.appendEntry.mock.calls
          .filter((c) => c[0] === NOTIFY_LEDGER_CUSTOM_TYPE)
          .map((c) => ({ type: "custom", customType: c[0], data: c[1] })),
      isIdle: () => false,
      onAgentSettled: () => {},
      sendDelivery: vi.fn(),
    };
    const ledger2 = bindNotifyLedgerHost(host2);
    expect(ledger2.recoverFromSession()).toBe(1);
  });

  it("does not rewrite when main agent is idle (flush already delivered)", () => {
    const ledger = bindNotifyLedgerHost({
      appendLedgerEntry: (customType, data) => pi.appendEntry(customType, data),
      readSessionEntries: () => [],
      isIdle: () => false,
      onAgentSettled: () => {},
      sendDelivery: (message) => pi.sendMessage(message as never),
    });
    ledger.record("notify-2", "content", { id: "sa-y" });
    pi.appendEntry.mockClear();

    // idle service：flush 投出（无门拦），dispose 无复写动作
    const idleService = new SubagentService({
      cwd: agentDir,
      modelService: new ModelConfigService({ agentDir, cwd: agentDir }),
    });
    const piIdle = makePi();
    idleService.initSession({ pi: piIdle, sessionId: "root-session", isIdle: () => true });
    idleService.dispose();
    expect(piIdle.appendEntry).not.toHaveBeenCalled();
  });
});
