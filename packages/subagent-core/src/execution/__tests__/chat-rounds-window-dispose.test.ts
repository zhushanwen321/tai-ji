// src/execution/__tests__/chat-rounds-window-dispose.test.ts
//
// [U3 pi-workflow-run-resource-model] chat 域窗口实例接线单测（impl-plan u3 验收；
// fake client，不拉真实进程）：
//   1. 轮 idle 后 pi 窗口实例 dispose（finalizeRoundToIdle 收尾追加——chat 域轮终
//      唯一编排收口，成功/失败两分支同经此处）；
//   2. revive 后 respawn 新实例 + resume 续写（断言新实例登记 + 续写 run 请求携带
//      resume 锚点——session 文件冷续写锚；实例层 respawn 与锚层续写并存不互斥）；
//   3. shared-service 引擎（缺省网关判定）解析透传 registry 单例、轮 idle 不误杀
//      （chat 域透传保形，与 u2 验收④同判据）。
// 权威源：技术设计 §3.3 决策 1/2、§5 U3 + ADR-0079；接线点 = ChatRounds.
// finalizeRoundToIdle / resolveRoundEnginePort / pi-host-binding.resolveHostPiEnginePort。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

vi.mock("../lifecycle/lifecycle-manager.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lifecycle/lifecycle-manager.ts")>();
  return { ...actual, armIdleTimer: vi.fn(), disarmIdleTimer: vi.fn() };
});

import { ChatRounds, type ChatRoundsDeps } from "../service/chat-rounds.ts";
import { RecordEngineIdentityError } from "../engine/common/session-view-service.ts";
import type { AgentCallOpts } from "../../orchestration/models/types.ts";
import { resetWorkflowWindowEngineStatesForTest, setWorkflowWindowEngineGateway } from "../engine/routing.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import type { EngineCapabilities, EngineHandle, ProbeReport, SessionView } from "../engine/types.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../engine/port.ts";
import type { AgentOutcome } from "@zhushanwen/subagent-engine-sdk";
import type { ExecutionRecord } from "../domain/record-model.ts";
import type { ExecuteOptions } from "../assembly/types.ts";
import { createRecord } from "../persistence/execution-record.ts";
import { makePi } from "./helpers/pi-mock.ts";

// ── 替身 ─────────────────────────────────────────────────────

/** 引擎能力位全集（conversation=native——revive 资格 gate 放行 pi 路径）。 */
function fakeCapabilities(): EngineCapabilities {
  return {
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
}

/** 窗口实例替身：run 载荷捕获（resume 锚点断言）+ dispose 计数。每个实例由网关
 *  工厂独立创建——respawn 断言（新实例 ≠ 旧实例）依赖这一点。 */
class FakeWindowEnginePort implements EnginePort {
  readonly id: string;
  disposed = 0;
  readonly runCalls: Array<{ task: AgentCallOpts; ctx: RunContext }> = [];
  /** 本实例回填给 record 的 pi session 文件（pi 锚的锚源；测试可注入）。 */
  sessionFile = "";

  constructor(id: string) {
    this.id = id;
  }

  capabilities(): EngineCapabilities {
    return fakeCapabilities();
  }

  async probe(): Promise<ProbeReport> {
    return { ok: true, engineVersion: "fake-1", checks: [{ name: "invocation", ok: true }] };
  }

  run(task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> {
    this.runCalls.push({ task, ctx });
    const handle: EngineHandle = {
      data: { v: 1, engineId: this.id, sessionRef: {}, adapterVersion: "fake-1" },
    };
    const outcome: AgentOutcome = {
      content: `ok (${this.id})`,
      engineId: this.id,
      sessionId: `session-${this.id}`,
      // pi 会话锚回填载体：轮终经 outcome.sessionFile 写 record.sessionFile，
      // 下一轮 resume 锚点即派生自它（session 文件冷续写的锚源）。
      sessionFile: this.sessionFile,
    };
    return Promise.resolve({ handle, outcome });
  }

  async read(_handle: EngineHandle): Promise<SessionView> {
    return { engineId: this.id, turns: [], source: "outcome-only" };
  }

  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

// ── 夹具 ─────────────────────────────────────────────────────

let dataDir: string;

beforeEach(() => {
  resetWorkflowWindowEngineStatesForTest();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-window-dispose-"));
});

afterEach(() => {
  resetWorkflowWindowEngineStatesForTest();
  clearEngines();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 轮窗口网关（per-window 全放行）：每次 createPort 产出独立实例并计创建数。 */
function usePerWindowGateway(ports: FakeWindowEnginePort[]): { created: () => number } {
  let created = 0;
  setWorkflowWindowEngineGateway({
    processModelOf: () => "per-window",
    createPort: (engineId) => {
      created += 1;
      const port = new FakeWindowEnginePort(engineId);
      port.sessionFile = path.join(dataDir, `session-${created}.jsonl`);
      ports.push(port);
      return port;
    },
  });
  return { created: () => created };
}

/** running record（chat 域 Continuation 轮次载体的最小形态）。 */
function makeRunningRecord(id: string): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    mode: "background",
    task: "chat window task",
    slug: "chat-window",
    startedAt: 1000,
    controller: new AbortController(),
  });
  record.status = "running";
  return record;
}

/** ChatRounds 直构（stdout-wedge 单测同款；本测试触达面补齐 store/pool/通知面）。
 *  overrides = 逐成员覆盖注入面（[§1.4 (a)] 等待排序用例消费）。 */
function makeChatRounds(record: ExecutionRecord, overrides: Partial<ChatRoundsDeps> = {}): ChatRounds {
  const store = {
    // 轮终簿记的最小语义 mimic：翻 idle + round+1（revive 资格判定依赖 status 翻边）。
    markRoundIdle: vi.fn((_id: string, _outcome: unknown) => {
      record.status = "idle";
      record.round = (record.round ?? 0) + 1;
    }),
    markRoundStarted: vi.fn(),
    register: vi.fn(),
    reportRecordTransition: vi.fn(),
  };
  const deps = {
    assertReady: vi.fn(),
    getStore: vi.fn(() => store),
    getModelService: vi.fn(() => ({})),
    getCwd: vi.fn(() => dataDir),
    getWorktreeManager: vi.fn(() => ({})),
    getNotifyHost: vi.fn(() => ({
      notifyComplete: vi.fn(),
      notify: vi.fn(),
      emitPendingUnregister: vi.fn(),
    })),
    getPool: vi.fn(() => ({ acquire: vi.fn(async () => {}), release: vi.fn() })),
    getPi: vi.fn(() => null),
    // [§1.4 (a)] 轮终「句柄就绪」等待：本测试 pi 恒 null（从未注入形态）——直通 null
    //（waitForUsablePi 对从未注入立即返回，语义等价）。
    waitForPiReady: vi.fn(async () => null),
    getSessionRootId: vi.fn(() => null),
    getStreamSink: vi.fn(() => null),
    getUiObservability: vi.fn(() => ({ getMode: () => undefined })),
    finalizeFailed: vi.fn(),
    finalizeAborted: vi.fn(),
    idleTimeoutRecycle: vi.fn(),
    archiveRecord: vi.fn(),
    taskSpecWithModel: vi.fn(
      (opts: ExecuteOptions, model: string | undefined): AgentCallOpts =>
        ({ prompt: opts.task, ...(model !== undefined ? { model } : {}) }) as AgentCallOpts,
    ),
    outcomeToAgentResult: vi.fn(),
    settleOneShotOutcome: vi.fn(),
    writeBindingForRecord: vi.fn(),
    effectiveMaxConcurrentFor: vi.fn(() => 4),
    resolveChatEnginePort: vi.fn(),
  } as unknown as ChatRoundsDeps;
  return new ChatRounds({ ...deps, ...overrides });
}

// ── 用例 ─────────────────────────────────────────────────────

describe("chat 轮窗口实例接线（U3）", () => {
  it("验收①：轮 idle 后 pi 窗口实例 dispose（经窗口解析创建登记，轮终收尾释放）", async () => {
    registerEngine("pi", () => new FakeWindowEnginePort("pi-registry"));
    const ports: FakeWindowEnginePort[] = [];
    const gateway = usePerWindowGateway(ports);
    const record = makeRunningRecord("u3-win-idle-1");
    const chatRounds = makeChatRounds(record);

    chatRounds.startFirstChatRound(record, { task: "round-1", slug: "chat-window" });

    // 轮终簿记 + 窗口释放都到达（detached 派发链经 waitFor 收敛）
    await vi.waitFor(() => {
      expect(record.sessionFile).toBeDefined();
      expect(ports[0]!.disposed).toBe(1);
    });
    expect(gateway.created()).toBe(1); // 轮内恰一次创建（轮内复用窗口实例）
    expect(ports[0]!.runCalls).toHaveLength(1);
    expect(record.sessionFile).toBe(ports[0]!.sessionFile); // pi 锚经 run 应答回填
  });

  it("验收②：revive 后 respawn 新实例 + resume 续写（新实例登记 + run 请求带 resume 锚点）", async () => {
    registerEngine("pi", () => new FakeWindowEnginePort("pi-registry"));
    const ports: FakeWindowEnginePort[] = [];
    const gateway = usePerWindowGateway(ports);
    const record = makeRunningRecord("u3-win-revive-1");
    const chatRounds = makeChatRounds(record);

    // 轮 1：跑完落 idle，实例随轮 idle 释放
    chatRounds.startFirstChatRound(record, { task: "round-1", slug: "chat-window" });
    await vi.waitFor(() => expect(ports[0]!.disposed).toBe(1));

    // pi 锚可解析判据 = session 文件在盘（isAnchorResolvable fs.existsSync）——
    // 冷续写锚源落盘后 revive 才走「原样 resume 续写」分支
    const sessionFile = ports[0]!.sessionFile;
    fs.writeFileSync(sessionFile, "{}\n");

    chatRounds.deliverChatMessage(record, "revive message");

    // 轮 2 在全新实例上跑（respawn）：创建计数 +1、run 落新实例
    await vi.waitFor(() => {
      expect(ports[1]).toBeDefined();
      expect(ports[1]!.runCalls).toHaveLength(1);
    });
    expect(ports[1]!).not.toBe(ports[0]!); // respawn：新实例 ≠ 旧实例
    expect(ports[0]!.disposed).toBe(1); // 旧实例保持已释放
    expect(gateway.created()).toBe(2); // 恰一次新创建（登记后轮内复用，零多余创建）

    // 续写 run 请求携带 resume 锚点（recordId 关联键 + session 文件冷续写锚）
    const ctx = ports[1]!.runCalls[0]!.ctx;
    expect(ctx.resume).toEqual({
      recordId: record.id,
      resume: { sessionRef: { recordId: record.id, sessionFile } },
    });

    // 新实例登记的构造性证明：dispose 只经窗口表 disposeAll 触达——未登记实例
    // 不可能被收尾释放；轮 2 idle 后新实例被释放 = 登记发生过的唯一通路。
    await vi.waitFor(() => expect(ports[1]!.disposed).toBe(1));
  });

  it("验收③：shared-service 引擎（缺省网关）解析透传 registry 单例，轮 idle 不误杀", async () => {
    const sharedPort = new FakeWindowEnginePort("zcode-like");
    sharedPort.sessionFile = path.join(dataDir, "shared-session.jsonl");
    registerEngine("zcode-like", () => sharedPort);
    const record = makeRunningRecord("u3-win-shared-1");
    Object.assign(record, { engine: "zcode-like" }); // engine 只读——Object.assign 注入非 pi 显式 id
    const chatRounds = makeChatRounds(record);

    chatRounds.startFirstChatRound(record, { task: "round-1", slug: "chat-window" });

    await vi.waitFor(() => {
      expect(record.sessionFile).toBe(sharedPort.sessionFile);
      expect(sharedPort.runCalls).toHaveLength(1);
    });
    // 非 pi 分支经窗口解析单点透传 registry：run 走注册表单例本体（缺省网关零创建）
    // 轮 idle 收尾不误杀 shared-service 单例（dispose 通道归 registry/停机链，现状保形）
    expect(sharedPort.disposed).toBe(0);
  });

  it("引擎身份域损坏守卫：record 带原生引擎锚却无 engine 字段 → 显式抛错（不按 pi 判定/派发）", () => {
    registerEngine("pi", () => new FakeWindowEnginePort("pi-registry"));
    const record = makeRunningRecord("u3-win-corrupt-engine");
    // 原生引擎锚在场（zcode 形态）但没有 engine 字段 = 写侧身份域丢失
    record.engineHandle = {
      sessionRef: { sessionId: "sess-corrupt", dbPath: "db.sqlite" },
      poolKey: "shared",
    };
    const chatRounds = makeChatRounds(record);

    let err: unknown;
    try {
      chatRounds.engineSupportsConversation(record);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RecordEngineIdentityError);
    expect((err as RecordEngineIdentityError).recordId).toBe("u3-win-corrupt-engine");
    expect((err as RecordEngineIdentityError).message).toContain(
      "refusing to route it to the default engine 'pi'",
    );

    // 缺省路径保形：无 engine 且无锚 → pi 缺省走能力位判定（不抛）
    const plain = makeRunningRecord("u3-win-plain-engine");
    expect(chatRounds.engineSupportsConversation(plain)).toBe(true);
  });
});

// ── [§1.4 (a)] 轮终收尾的「句柄就绪」有界等待：等待期间簿记不执行，新代际注入后
// 完成写（FinalizeDeps.pi 读取发生在等待 resolve 之后——写携带新句柄）。

describe("[§1.4 (a)] 轮终收尾句柄就绪等待（finalizeRoundToIdle × waitForPiReady）", () => {
  it("waitForPiReady 挂起期间不读 pi（簿记未开始）；resolve 新句柄后完成写", async () => {
    const record = makeRunningRecord("sa-wait-pi");
    const newPi = makePi();
    let resolveWait: ((pi: unknown) => void) | undefined;
    const waitForPiReady = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveWait = resolve;
        }) as never as Promise<null>,
    );
    const getPi = vi.fn(() => newPi as never);
    const chatRounds = makeChatRounds(record, { waitForPiReady, getPi });

    const done = chatRounds.finalizeRoundToIdle(record, { kind: "success", content: "ok" });
    await Promise.resolve();
    await Promise.resolve();
    expect(waitForPiReady).toHaveBeenCalledTimes(1);
    // 等待期间：FinalizeDeps 组装未开始（pi 读取 = 簿记写面入口，未触达）。
    expect(getPi).not.toHaveBeenCalled();

    resolveWait!(newPi);
    await done;
    // 等待结束后才读 pi——轮终条目写携带新代际句柄（reload 后落新权威 session）。
    expect(getPi).toHaveBeenCalledTimes(1);
    expect(getPi.mock.results[0]?.value).toBe(newPi);
  });
});
