// src/execution/__tests__/chat-rounds-stdout-wedge-self-heal.test.ts
//
// [stdout-wedge self-heal] healEngineStdoutWedge 自愈段单测（ChatRounds 直构 +
// RemoteEngine/EngineClient 实例 + 方法级 spy 注入）。[modeless 波1] 自愈段随
// onOneShotSettledWatchdogTimeout 删除迁入 armRoundWatchdog 的 fire 处置
//（Continuation onWatchdogFire 后追加调用）；收口路径（kill + 失败轮 settle）归
// Continuation 统一流（conversation-continuation.test.ts 楔死轮用例覆盖），本文件
// 只测自愈段判据面。
//
// 设计依据（2026-09-15 实证事故）：单一 TaiJi-as-node 引擎进程（stdio socketpair）
// 前 3 个 run 的引擎→宿主事件通知全部静默丢失（宿主零 journal、run() 永不 resolve、
// settled-watchdog 30 分钟后 fire 误报失败），同一引擎后续 run 又全部正常——传输层
// 物理完好，事件在引擎侧写出后丢失（疑似 Bun×Electron-as-node×socketpair 冷启动
// 楔死）。自愈段在 fire 处置（kill + abort + disarm）之后追加：零事件判据 → warn
// 点名诊断；零事件且仅本 run 在册 → killEngineForStdoutWedge 杀引擎（下次派发
// respawn 新引擎）。
//
// 覆盖矩阵：
//   - 零事件 + 单路由（activeRunCount=1）→ 诊断 + killEngine 被调（reason 含 runId）；
//   - 零事件 + 多路由（activeRunCount=2）→ 只诊断不杀（并发 run 连坐防护）；
//   - 有事件（eventsReceivedForRun>0）→ 自愈段零动作（正常超时类 fire 行为零变化）；
//   - 非 cli 形态引擎（pi 未注册 stub 形态的 inproc port）→ 零动作零诊断。
// 自愈段判据面（零事件 / 在册路由数 / cli 形态 / 解析失败）逐项断言。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

const { killChildSpy } = vi.hoisted(() => ({ killChildSpy: vi.fn() }));
vi.mock("../engine/host/spawned-children.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/host/spawned-children.ts")>();
  return { ...actual, killRecordChildWithEscalation: killChildSpy };
});

import { ChatRounds, type ChatRoundsDeps } from "../service/chat-rounds.ts";
import { EngineClient } from "../engine/client/engine-client.ts";
import { RemoteEngine } from "../engine/client/remote-engine.ts";
import type { EngineCapabilities } from "../engine/types.ts";
import type { ExecutionRecord } from "../assembly/types.ts";
import { createRecord } from "../persistence/execution-record.ts";
import type { SettledWatchdogFireInfo } from "../lifecycle/settled-watchdog.ts";

/** fire 载荷（中段 30min 静默形态——事故现场的 fire 段）。 */
const FIRE: SettledWatchdogFireInfo = { phase: "mid-round", waitedMs: 1_800_000 };

const FAKE_CAPABILITIES: EngineCapabilities = {
  schemaEnforcement: "native",
  steer: "unsupported",
  conversation: "native",
  personaInjection: "flag",
  eventGranularity: "stream",
  sandbox: "emulated",
  sessionRead: "full",
  resume: "native",
  interrupt: "kill-only",
  permissionMode: "native",
  maxTurns: true,
};

let dataDir: string;
let client: EngineClient;

beforeEach(() => {
  killChildSpy.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.debug.mockClear();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdout-wedge-heal-"));
  // 未连接的 EngineClient（构造零副作用——不 spawn；fire 回调只读诊断面/调自愈杀链）。
  client = new EngineClient({
    engineId: "pi",
    command: process.execPath,
    args: [],
    hostKind: "test",
    dataDir,
    envPrefixes: [],
  });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** cli 形态 pi 引擎（RemoteEngine 包装被测 EngineClient）。 */
function makeRemotePiEngine(): RemoteEngine {
  return new RemoteEngine({
    engineId: "pi",
    client,
    manifest: { capabilities: FAKE_CAPABILITIES },
    dataDir,
    hostKind: "test",
  });
}

/** 楔死轮 running record。 */
function makeOneShotRecord(id: string): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "prov/model-1",
    mode: "background",
    task: "wedged task",
    slug: "wedge",
    startedAt: 1000,
    controller: new AbortController(),
  });
  record.status = "running";
  return record;
}

interface SpyBundle {
  eventsSpy: ReturnType<typeof vi.spyOn>;
  activeSpy: ReturnType<typeof vi.spyOn>;
  killSpy: ReturnType<typeof vi.spyOn>;
}

/** 方法级 spy 注入（eventsReceivedForRun / activeRunCount / killEngineForStdoutWedge）。 */
function spyOnClient(events: number, activeRuns: number): SpyBundle {
  return {
    eventsSpy: vi.spyOn(client, "eventsReceivedForRun").mockReturnValue(events),
    activeSpy: vi.spyOn(client, "activeRunCount").mockReturnValue(activeRuns),
    killSpy: vi.spyOn(client, "killEngineForStdoutWedge").mockResolvedValue(undefined),
  };
}

function makeChatRounds(resolveChatEnginePort: () => unknown): {
  chatRounds: ChatRounds;
} {
  // deps 只填 fire 回调触达面（getStore/getNotifyHost/resolveChatEnginePort），余项
  // fire 路径零触达——vi.fn() 占位（构造期零求值，不调用）。
  const deps = {
    assertReady: vi.fn(),
    getStore: vi.fn(),
    getModelService: vi.fn(),
    getCwd: vi.fn(),
    getWorktreeManager: vi.fn(),
    getNotifyHost: vi.fn(),
    getPool: vi.fn(),
    getPi: vi.fn(),
    getSessionRootId: vi.fn(),
    getStreamSink: vi.fn(),
    getUiObservability: vi.fn(),
    getRoundSupervisor: vi.fn(),
    getCollectCoordinator: vi.fn(),
    finalizeFailed: vi.fn(),
    finalizeAborted: vi.fn(),
    idleTimeoutRecycle: vi.fn(),
    archiveRecord: vi.fn(),
    taskSpecWithModel: vi.fn(),
    outcomeToAgentResult: vi.fn(),
    settleOneShotOutcome: vi.fn(),
    writeBindingForRecord: vi.fn(),
    effectiveMaxConcurrentFor: vi.fn(),
    resolveChatEnginePort,
  } as unknown as ChatRoundsDeps;
  return { chatRounds: new ChatRounds(deps) };
}

/** 自愈段点名诊断 warn 断言（任务规格文案：wedge suspected + relay log 证据源）。 */
function expectWedgeWarn(recordId: string): void {
  expect(loggerMock.warn).toHaveBeenCalledWith(
    expect.stringContaining("engine stdout leg wedge suspected (zero events received for this run;"),
  );
  expect(loggerMock.warn).toHaveBeenCalledWith(
    expect.stringContaining(`relay log at ~/.xyz-agent/logs/pi-relay-<date>-${recordId}.jsonl`),
  );
}

describe("[stdout-wedge self-heal] healEngineStdoutWedge 自愈段（[modeless 波1] watchdog fire 处置接线）", () => {
  it("零事件 + 单路由 → 点名诊断 + killEngineForStdoutWedge 被调（reason 含 runId）", () => {
    const record = makeOneShotRecord("sw-run-1");
    const spies = spyOnClient(0, 1);
    const { chatRounds } = makeChatRounds(() => makeRemotePiEngine());

    chatRounds.healEngineStdoutWedge(record);

    // 自愈段：诊断 + 杀引擎（fire-and-forget 已被调，reason 点名 runId）。
    expectWedgeWarn(record.id);
    expect(spies.killSpy).toHaveBeenCalledTimes(1);
    expect(spies.killSpy).toHaveBeenCalledWith(
      expect.stringContaining(record.id),
    );
  });

  it("零事件 + 多路由（其他活跃 run 在册）→ 只诊断不杀（并发 run 连坐防护）", () => {
    const record = makeOneShotRecord("sw-run-2");
    const spies = spyOnClient(0, 2);
    const { chatRounds } = makeChatRounds(() => makeRemotePiEngine());

    chatRounds.healEngineStdoutWedge(record);

    expectWedgeWarn(record.id); // 诊断仍发出（可诊断性）
    expect(spies.killSpy).not.toHaveBeenCalled(); // 不杀——组杀会连坐并发 run 的事件流
  });

  it("有事件（eventsReceivedForRun > 0）→ 自愈段零动作（正常超时类 fire 行为零变化）", () => {
    const record = makeOneShotRecord("sw-run-3");
    const spies = spyOnClient(5, 1);
    const { chatRounds } = makeChatRounds(() => makeRemotePiEngine());

    chatRounds.healEngineStdoutWedge(record);

    // 零 wedge 诊断、零杀引擎——判据面只看事件计数，与在册路由数无关（顺序短路）。
    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("stdout leg wedge suspected"),
    );
    expect(spies.killSpy).not.toHaveBeenCalled();
  });

  it("非 cli 形态引擎（inproc 形态 port）→ 零动作零诊断（无协议客户端可判）", () => {
    const record = makeOneShotRecord("sw-run-4");
    // pi 未注册 stub 同理（非 RemoteEngine 即零动作）；这里用裸 inproc 形态对象直测。
    const inprocPort = {
      id: "pi",
      capabilities: () => FAKE_CAPABILITIES,
      probe: vi.fn(),
      run: vi.fn(),
      read: vi.fn(),
    };
    const { chatRounds } = makeChatRounds(() => inprocPort);

    expect(() => chatRounds.healEngineStdoutWedge(record)).not.toThrow();

    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("stdout leg wedge suspected"),
    );
  });

  it("引擎解析抛错（未注册非 pi id）→ 自愈段静默跳过（错误不逃出 fire 回调）", () => {
    const record = makeOneShotRecord("sw-run-5");
    Object.assign(record, { engine: "zcode-unknown" }); // engine 只读——Object.assign 赋值（测试注入非 pi 未注册 id）
    const { chatRounds } = makeChatRounds(() => makeRemotePiEngine());

    expect(() => chatRounds.healEngineStdoutWedge(record)).not.toThrow();

    expect(loggerMock.debug).toHaveBeenCalledWith(
      expect.stringContaining("stdout-wedge self-heal skipped"),
    );
  });
});
