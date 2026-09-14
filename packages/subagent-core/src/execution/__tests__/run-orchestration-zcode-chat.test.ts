// src/execution/__tests__/run-orchestration-zcode-chat.test.ts
//
// [U6b] zcode chatMode record 的 Continuation 宿主侧接线验收（impl-plan §2 U6b 行，
// 设计 subagent-permanent-session-model.md §3.2.6 要点 3/4）：
//   - B-firstround：executeViaEngine 非 pi 分支对 conversation:true（zcode
//     conversation:'cold'——U6 后 capability gate 放行）走 Continuation.startFirstRound
//     ——轮末 markRoundIdle 收口（status 翻 idle [two-state-convergence U4/D3] + round+1 +
//     closedReason 清除），不走 kickOffEngineRun one-shot 编排（finalizeEngineOutcome
//     tryTransition：status='idle' + closedReason='gc' 且 round 不推进）；
//   - B-routing：会话轮引擎按 record.engine 经 registry 解析——zcode chatMode 轮
//     （首轮与续轮）派发到 zcode port，不再钉死 pi；续轮 resume 锚携带
//     engineHandle.sessionRef 的 zcode cold 形态（引擎侧 resume 读 + 新 session 注入）；
//   - onHandleReady 回填：非 pi 会话轮 RunContext 挂运行中句柄回填通道（覆写语义
//     ——cold 续聊每轮换新 session，旧 sessionId 必须被替换，否则锚停在旧 session）；
//     pi 会话轮不挂（pi 锚面 = outcome.sessionFile 回填，pi 行为零变化）。
//
// 形态：SubagentService 全链集成（真实 RunOrchestration 接线 + registerEngine 假
// zcode 引擎替身 + registerFakePiEngine 协议替身）；锚可解析性 fixture = 真实
// node:sqlite tmp 库（isAnchorResolvable 的 zcode 判据，与 conversation-continuation
// U6 用例同款）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentCallOpts } from "../../orchestration/models/types.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../engine/port.ts";
import type {
  AgentEvent,
  EngineCapabilities,
  EngineHandle,
  ProbeReport,
  SessionView,
} from "../engine/types.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import type { ModelRegistryLike } from "../assembly/model-resolver.ts";
import type { RecordStore } from "../persistence/record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import { _resetLifecycleState } from "../lifecycle/lifecycle-manager.ts";
import { _resetSettledWatchdogsForTest } from "../lifecycle/settled-watchdog.ts";
import { _resetCoreSpawnedChildrenMirrorForTest } from "../engine/host/spawned-children.ts";
import type { ExecutionRecord } from "../assembly/types.ts";

// ============================================================
// zcode cold 引擎替身（conversation:'cold'——B-firstround 的 capability 判据；
// run 挂起捕获，settle/emitHandleReady/emitEvent 由用例驱动）
// ============================================================

class ZcodeColdRun {
  readonly task: AgentCallOpts;
  readonly ctx: RunContext;
  private resolveRun!: (r: EngineRunResult) => void;
  readonly promise: Promise<EngineRunResult>;

  constructor(task: AgentCallOpts, ctx: RunContext) {
    this.task = task;
    this.ctx = ctx;
    this.promise = new Promise<EngineRunResult>((res) => {
      this.resolveRun = res;
    });
  }

  /** 模拟 zcode 引擎 create 应答后的运行中句柄回传（§3.4 不变量 3——onSessionCreated）。 */
  emitHandleReady(sessionRef: Record<string, string>): void {
    this.ctx.onHandleReady?.({ sessionRef });
  }

  /** 模拟引擎协议事件（live reducer 喂入路径）。 */
  emitEvent(event: AgentEvent): void {
    this.ctx.onEvent?.(event);
  }

  /** 模拟 run 应答（成功轮——outcome.content = 本轮内容；zcode 锚不经 outcome，会话锚由 emitHandleReady 承载）。 */
  settle(content: string): void {
    this.resolveRun({
      handle: {
        data: {
          v: 1,
          engineId: "zcode",
          sessionRef: { dbPath: "<db>" },
          adapterVersion: "zcode-cold-fake",
        } satisfies EngineHandle["data"],
      },
      outcome: { content, engineId: "zcode", durationMs: 5 },
    });
  }
}

class ZcodeColdEngine implements EnginePort {
  readonly id = "zcode";
  readonly runs: ZcodeColdRun[] = [];

  capabilities(): EngineCapabilities {
    // 对齐 zcode-subagent-cli manifest（U6 后）：conversation:'cold' 是本测试族的
    // 前提（capability-gate 判据 === 'unsupported' 才拒，'cold' 放行）。
    return {
      schemaEnforcement: "emulated",
      steer: "unsupported",
      conversation: "cold",
      personaInjection: "prompt",
      eventGranularity: "coarse",
      sandbox: "none",
      sessionRead: "full",
      resume: "cold",
      interrupt: "kill-only",
      permissionMode: "native",
      maxTurns: false,
    };
  }

  async probe(): Promise<ProbeReport> {
    return { ok: true, engineVersion: "fake-zcode-cold", checks: [{ name: "bin", ok: true }] };
  }

  run(task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> {
    const run = new ZcodeColdRun(task, ctx);
    this.runs.push(run);
    return run.promise;
  }

  async read(): Promise<SessionView> {
    return { engineId: this.id, turns: [], source: "outcome-only" };
  }
}

// ============================================================
// 环境：tmp agentDir + sqlite 锚库 + 双引擎注册 + service 装配
// ============================================================

interface ServiceInternals {
  store: RecordStore;
}

function makePi(): PiLike {
  return { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } } as unknown as PiLike;
}

const EMPTY_REGISTRY: ModelRegistryLike = {
  getAvailable: () => [],
  find: () => undefined,
  hasConfiguredAuth: () => true,
};

describe("U6b：zcode chatMode 的 Continuation 接线（B-firstround + B-routing + onHandleReady）", () => {
  let agentDir: string;
  let zcodeDir: string;
  let zcodeDb: string;
  let service: SubagentService;
  let store: RecordStore;
  let zcode: ZcodeColdEngine;
  let piEngine: FakePiEnginePort;
  let pi: PiLike;
  let prevDataDirEnv: string | undefined;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "u6b-zcode-chat-"));
    zcodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "u6b-zcode-db-"));
    zcodeDb = path.join(zcodeDir, "db.sqlite");
    prevDataDirEnv = process.env["XYZ_AGENT_DATA_DIR"];
    // 测试红线：store/引擎数据面不触真实数据目录
    process.env.XYZ_AGENT_DATA_DIR = path.join(agentDir, "engine-data");
    clearEngines();
    zcode = new ZcodeColdEngine();
    registerEngine("zcode", () => zcode);
    piEngine = registerFakePiEngine();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      modelRegistry: EMPTY_REGISTRY,
      sessionId: "root-session",
      ctxModel: { id: "m", name: "M", provider: "prov", reasoning: false },
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    pi = makePi();
    service.initSession({ pi, sessionId: "root-session" });
    store = (service as unknown as ServiceInternals).store;
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    if (prevDataDirEnv === undefined) delete process.env["XYZ_AGENT_DATA_DIR"];
    else process.env["XYZ_AGENT_DATA_DIR"] = prevDataDirEnv;
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    fs.rmSync(zcodeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 锚可解析性 fixture：向真实 sqlite 库插 session 条目（isAnchorResolvable 的 zcode 判据）。 */
  async function seedZcodeSession(sessionId: string): Promise<void> {
    const { DatabaseSync } = (await import("node:sqlite")) as {
      DatabaseSync: new (p: string) => unknown;
    };
    type Db = {
      exec: (s: string) => void;
      prepare: (s: string) => { run: (...a: unknown[]) => void };
      close: () => void;
    };
    const db = new DatabaseSync(zcodeDb) as unknown as Db;
    db.exec("CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, time_created INTEGER)");
    db.prepare("INSERT OR REPLACE INTO session (id, time_created) VALUES (?, 1)").run(sessionId);
    db.close();
  }

  function recordOf(id: string): ExecutionRecord {
    const rec = store.getMutable(id);
    expect(rec).toBeDefined();
    return rec!;
  }

  // ============================================================
  // B-firstround：非 pi 分支 conversation:true 走 Continuation 首轮
  // ============================================================

  it("[B-firstround] zcode conversation:true 首轮经 startFirstRound：派发 zcode port、resume={recordId} 无锚、settle 后 markRoundIdle 收口（running-resumable + round+1），非 one-shot 终态化（idle+closedReason='gc'）", async () => {
    const handle = await service.execute({
      task: "zcode cold chat",
      slug: "u6b-first",
      engine: "zcode",
      conversation: true,
    });

    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));
    expect(piEngine.runs.length).toBe(0);
    const record = recordOf(handle.subagentId);
    expect(record.chatMode).toBe(true);
    // chatMode 轮协议键必传（recordId 关联键）；首轮无 resume 锚
    expect(zcode.runs[0]!.ctx.resume).toEqual({ recordId: record.id });
    // taskSpec 透传 conversation（引擎侧 cold 会话判据）
    expect(zcode.runs[0]!.task.conversation).toBe(true);
    expect(zcode.runs[0]!.task.prompt).toBe("zcode cold chat");

    // 轮应答 → Continuation 轮末分流（markRoundIdle：status 翻 idle、
    // round+1、closedReason 清除——[two-state-convergence U4/D3]）——与 kickOffEngineRun one-shot 编排
    // （finalizeEngineOutcome：status='idle' + closedReason='gc' + round 不推进）
    // 的判别断言
    zcode.runs[0]!.settle("round one done");
    await vi.waitFor(() => expect(record.round).toBe(1));
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBeUndefined();
    expect(record.resumable).toBeUndefined();
    expect(record.result).toBe("round one done");
  });

  it("[B-routing] 续轮 message 派发到 zcode port（非 pi）：resume 锚携带 engineHandle.sessionRef（cold 形态）", async () => {
    await seedZcodeSession("sess_cold_1");
    const handle = await service.execute({
      task: "zcode cold chat",
      slug: "u6b-second",
      engine: "zcode",
      conversation: true,
    });
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));
    const record = recordOf(handle.subagentId);
    // 首轮 create 应答 → onHandleReady 回填锚（sessionRef；poolKey 恒 'shared' 为
    // 持久化形状成员——RecordStore engineHandle 断言用 record.engineHandle 自身核对）
    zcode.runs[0]!.emitHandleReady({ sessionId: "sess_cold_1", dbPath: zcodeDb });
    expect(record.engineHandle).toMatchObject({
      sessionRef: { sessionId: "sess_cold_1", dbPath: zcodeDb },
    });
    expect(record.engineHandle?.poolKey).toBe("shared");
    zcode.runs[0]!.settle("round one done");
    await vi.waitFor(() => expect(record.round).toBe(1));

    // 续轮：message → Continuation → kickOffChatRound 按 record.engine 路由
    await service.chatActions.deliverChatMessage(record, "second round");
    await vi.waitFor(() => expect(zcode.runs.length).toBe(2));
    expect(piEngine.runs.length).toBe(0);
    // resume 锚 = engineHandle.sessionRef 派生的 zcode cold 形态（引擎侧据此
    // session/resume 读历史 + session/create 新会话注入）
    expect(zcode.runs[1]!.ctx.resume).toEqual({
      recordId: record.id,
      resume: { sessionRef: { sessionId: "sess_cold_1", dbPath: zcodeDb } },
    });
    expect(zcode.runs[1]!.task.prompt).toBe("second round");
    expect(zcode.runs[1]!.task.conversation).toBe(true);
  });

  it("[B-routing/onHandleReady] 续轮新 sessionRef 覆写旧锚（cold 每轮换锚）——engineHandle.sessionRef 更新为新一轮 session 且落 entry", async () => {
    await seedZcodeSession("sess_cold_1");
    const handle = await service.execute({
      task: "zcode cold chat",
      slug: "u6b-anchor",
      engine: "zcode",
      conversation: true,
    });
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));
    const record = recordOf(handle.subagentId);
    zcode.runs[0]!.emitHandleReady({ sessionId: "sess_cold_1", dbPath: zcodeDb });
    zcode.runs[0]!.settle("round one done");
    await vi.waitFor(() => expect(record.round).toBe(1));

    await service.chatActions.deliverChatMessage(record, "second round");
    await vi.waitFor(() => expect(zcode.runs.length).toBe(2));
    // 第二轮 create 应答 → 新 sessionRef 覆写（补缺语义会把 'sess_cold_1' 残留成锚，
    // 引擎侧下一轮注入的历史就缺最新一轮——本用例锁定覆写）
    zcode.runs[1]!.emitHandleReady({ sessionId: "sess_cold_2", dbPath: zcodeDb });
    expect(record.engineHandle).toMatchObject({
      sessionRef: { sessionId: "sess_cold_2", dbPath: zcodeDb },
    });
    // 回填经 store.reportRecordTransition 落 entry（appendEvent 既有 engineHandle
    // 投影通道——GUI 经 entry 重建 record 即拿到新锚）
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "subagent-record",
      expect.objectContaining({
        id: record.id,
        engineHandle: { sessionRef: { sessionId: "sess_cold_2", dbPath: zcodeDb }, poolKey: "shared" },
      }),
    );

    zcode.runs[1]!.settle("round two done");
    await vi.waitFor(() => expect(record.round).toBe(2));
    // 第三轮 resume 锚已推进到新 session（闭环：锚随轮自更新）——先 seed 新条目
    //（isAnchorResolvable 的 zcode 判据 = 库条目在，未 seed 会误走 fresh 降级）
    await seedZcodeSession("sess_cold_2");
    await service.chatActions.deliverChatMessage(record, "third round");
    await vi.waitFor(() => expect(zcode.runs.length).toBe(3));
    expect(zcode.runs[2]!.ctx.resume).toEqual({
      recordId: record.id,
      resume: { sessionRef: { sessionId: "sess_cold_2", dbPath: zcodeDb } },
    });
  });

  it("[B-routing] 未注册引擎 id 的 Continuation 轮：registry 解析 throw 被承接为失败轮（record 可续，失败通知可达），不崩宿主", async () => {
    await seedZcodeSession("sess_cold_1");
    const handle = await service.execute({
      task: "zcode cold chat",
      slug: "u6b-unreg",
      engine: "zcode",
      conversation: true,
    });
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));
    const record = recordOf(handle.subagentId);
    zcode.runs[0]!.emitHandleReady({ sessionId: "sess_cold_1", dbPath: zcodeDb });
    zcode.runs[0]!.settle("round one done");
    await vi.waitFor(() => expect(record.round).toBe(1));

    // 引擎从 registry 摘除（模拟宿主重启后引擎包不可达的续轮形态）
    clearEngines();
    await service.chatActions.deliverChatMessage(record, "second round");
    // dispatchRoundAsync 的 catch 承接端口解析 throw → 失败轮末分流（markRoundIdle
    // failed：round+1 + lastError，record 落 idle 可续聊——不崩宿主）
    await vi.waitFor(() => expect(record.round).toBe(2));
    expect(record.status).toBe("idle");
    expect(record.lastError).toContain("engine_not_found");
  });

  // ============================================================
  // pi 防御：pi 会话轮行为零变化（不挂 onHandleReady）
  // ============================================================

  it("[防御] pi 缺省路由的会话轮：RunContext 不挂 onHandleReady（pi 锚面 = outcome.sessionFile 回填，不引入新回填通道）", async () => {
    const handle = await service.execute({ task: "pi chat", slug: "u6b-pi", conversation: true });
    await vi.waitFor(() => expect(piEngine.runs.length).toBe(1));
    expect(zcode.runs.length).toBe(0);
    const record = recordOf(handle.subagentId);
    expect(record.chatMode).toBe(true);
    expect(piEngine.runs[0]!.ctx.onHandleReady).toBeUndefined();
    // pi chatMode 轮协议键形态保持（recordId 关联键；首轮无锚）
    expect(piEngine.runs[0]!.ctx.resume).toEqual({ recordId: record.id });
    piEngine.runs[0]!.settle({ content: "pi round done" });
    await vi.waitFor(() => expect(record.round).toBe(1));
    expect(record.status).toBe("idle");
  });
});
