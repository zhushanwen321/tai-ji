// EngineClient 状态机测试（W2）：impl-plan §2.2 / 验收 A6①⑦ / A8①④ / §7.2 R9-2/R9-2b/R9-3。
//
// [单测层极端测试整治] 原形态每用例 spawn fake-engine.mjs 真子进程 ×22 + waitFor 5s
// 预算（负载下无上界）。处置 = 协议状态机 mock 化：mock 的只是「子进程端点」——
// ScriptedLocalTransport（LocalEngineTransport 子类，open 不 spawn / close 不杀，
// 继承的进程段在 child===undefined 下全部 no-op）内置与 fake-engine.mjs 同语义的
// 动作解释器，客户端状态机（握手 / 请求关联 / 反向路由 / 超时域二分 / 崩溃终局 /
// 收割编排 / pidfile 清扫接线）全真。真进程全链保留 2 条挂 TAIJI_TEST_INTEGRATION
// 门控（本地默认跳过、CI 真跑）。stdin fd 不外泄（R9-4②）由 SDK spawn 单测兜底。
//
// 分层说明：stdout 半行残片上限（MAX_LINE_BYTES 丢头留尾）是 transport 层逻辑，
// 用例已迁 transport-local.test.ts（进程端点桩轨）；本文件只保留客户端侧
// 「非 NDJSON 行丢弃 + 后续帧照常解析」半。

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INTEGRATION_TESTS_ENABLED,
  INTEGRATION_TESTS_SKIP_REASON,
} from "../../../../../../../test-guard/integration-gate.ts";
import { EngineClient, type RunRoute } from "../engine-client.ts";
import { probePidAliveness, pidfilePath, readPidfile, writePidfileAtomic } from "../pid-file.ts";
import { waitFor } from "./helpers/wait-for.ts";
import { LocalEngineTransport } from "../transport/local.ts";
import type {
  EngineLaunchSpec,
  EngineTransport,
  EngineTransportExitInfo,
  EngineTransportOpenResult,
} from "../transport/types.ts";
import {
  _resetCoreSpawnedChildrenMirrorForTest,
  hasLiveProcessHandleCore,
} from "../../host/spawned-children.ts";
import {
  _resetHostUiRequestEndpointForTest,
  setHostUiRequestEndpoint,
} from "../../host/host-ui-endpoint.ts";

const FAKE_ENGINE = fileURLToPath(new URL("./__fixtures__/fake-engine.mjs", import.meta.url));

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "w2-engine-client-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.useRealTimers();
  // [D3 槽现读] host/askUser 应答端经 host-ui-endpoint 槽注入——用例后必须清空，
  // 防跨用例/跨文件串扰（槽是进程级 globalThis 状态）
  _resetHostUiRequestEndpointForTest();
});

// ── 子进程端点桩：ScriptedLocalTransport（in-process 假引擎）──────────────────

/** 引擎端点脚本（动作语义对齐 __fixtures__/fake-engine.mjs 的 --run-actions 解释器）。 */
interface EngineScript {
  /** initialize 应答协议版本（缺省 1；99 = 版本协商越界）。 */
  protocolVersion?: number;
  /** open 后首个 initialize 帧即崩溃（crash 模式）：写 stderr 样本 + exit code。 */
  crashOnInitialize?: { code: number; stderr: string };
  /** run 动作序列（spawnGrandchild/rawStdout 是真进程专属，不在端点桩值域）。 */
  runActions?: RunAction[];
}

type RunAction =
  | { op: "emit"; seq?: number; event: unknown; runId?: string }
  | { op: "streamDelta"; delta?: string; runId?: string }
  | { op: "handleReady"; sessionRef?: Record<string, string>; runId?: string }
  | { op: "childSpawned"; pid: number; recordId?: string }
  | {
      op: "childStateChanged";
      pid: number;
      recordId?: string;
      state?: string;
      killed?: boolean;
      exitCode?: number;
      signal?: string;
    }
  | { op: "log"; level?: string; component?: string; message?: string }
  | { op: "askUser"; request?: unknown; runId?: string; seq?: number; echoEvent?: boolean }
  | { op: "delay" }
  | { op: "exit"; code?: number; stderr?: string };

/** fake-engine.mjs 同款 capabilities/models（manifest 诊断比对的数据面）。 */
const FAKE_CAPABILITIES = {
  schemaEnforcement: "emulated",
  steer: "unsupported",
  conversation: "unsupported",
  personaInjection: "prompt",
  eventGranularity: "stream",
  sandbox: "emulated",
  sessionRead: "full",
  resume: "cold",
  interrupt: "kill-only",
  permissionMode: "fixed",
  maxTurns: false,
} as const;

const FAKE_MODELS = [
  { id: "glm-4.6", aliases: ["glm"], canonicalRef: "zai/glm-4.6" },
  { id: "mimo-v2.6-flash", canonicalRef: "xiaomi-token-plan-cn/mimo-v2.6-flash" },
];

function fakeRunResult(runId: string): Record<string, unknown> {
  return {
    handle: {
      v: 1,
      engineId: "fake",
      sessionRef: { sessionId: `fake-session-${runId}` },
      poolKey: "shared",
      engineVersion: "fake-1.0.0",
      adapterVersion: "fake-adapter",
    },
    outcome: {
      content: `fake-content-${runId}`,
      engineId: "fake",
      exitCode: 0,
      durationMs: 1,
    },
  };
}

/** childStateChanged 反向请求载荷（协议形态单点书写；__fixtures__/fake-engine.mjs 是被
 * spawn 的独立脚本不共享本模块，其同语义动作为对齐副本——改协议时两处同步）。 */
function childStateChangedPayload(
  action: Extract<RunAction, { op: "childStateChanged" }>,
): Record<string, unknown> {
  return {
    pid: action.pid,
    recordId: action.recordId,
    state: action.state ?? "exited",
    killed: action.killed ?? false,
    ...(action.exitCode !== undefined ? { exitCode: action.exitCode } : {}),
    ...(action.signal !== undefined ? { signal: action.signal } : {}),
  };
}

/** run-1 占位 run 请求（prompt "p"、cwd=dataDir；两轨用例共用的样板收敛点）。 */
function requestRun1(client: EngineClient): Promise<unknown> {
  return client.request("run", { runId: "run-1", task: { prompt: "p" }, ctx: { cwd: dataDir } });
}

/** run 往返断言面：run 终态 content + 首轮三路反向路由（event/delta/handleReady）各达一次。 */
function expectRunRoundTrip(
  result: { outcome: { content: string } },
  routes: { events: unknown[]; deltas: string[]; readyPartials: Array<{ sessionRef: Record<string, string> }> },
): void {
  expect(result.outcome.content).toBe("fake-content-run-1");
  expect(routes.events).toContainEqual({ type: "text_delta", delta: "hello" });
  expect(routes.deltas).toEqual(["stream-1"]);
  expect(routes.readyPartials).toEqual([{ sessionRef: { sessionId: "s-1" } }]);
}

interface WireFrame {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

/**
 * 进程端点桩：LocalEngineTransport 子类——open 不 spawn（回 fake pid 回执）、
 * writeFrame 交端点解释器（动作语义对齐 fake-engine.mjs）、close 不杀（继承实现在
 * child===undefined 下进程段全部 no-op，pid getter / isProcessAlive / pidfile 清扫
 * 接线等客户端消费面保持真实）。每代引擎连接一份实例（对齐生产 connectOnce 换代）。
 */
class ScriptedLocalTransport extends LocalEngineTransport {
  private readonly ownOpts: ConstructorParameters<typeof LocalEngineTransport>[0];
  private readonly script: EngineScript;
  private readonly lineSubscribers: Array<(line: string) => void> = [];
  private readonly exitSubscribers: Array<(info: EngineTransportExitInfo) => void> = [];
  private readonly askUserFinal = new Map<string, unknown>();
  private readonly askUserWaiters = new Set<() => void>();
  private alive = true;
  /** 端点收到的全部出站帧（断言面）。 */
  readonly sentFrames: string[] = [];
  /** close 收到的 reason 序列（杀链/优雅关闭断言面）。 */
  readonly closeReasons: string[] = [];
  openedSpec: EngineLaunchSpec | undefined;

  constructor(
    opts: ConstructorParameters<typeof LocalEngineTransport>[0],
    script: EngineScript,
    readonly fakePid: number,
  ) {
    super(opts);
    this.ownOpts = opts;
    this.script = script;
  }

  override get pid(): number | undefined {
    return this.alive ? this.fakePid : undefined;
  }

  override isProcessAlive(): boolean {
    return this.alive;
  }

  override async open(spec: EngineLaunchSpec): Promise<EngineTransportOpenResult> {
    this.openedSpec = spec;
    return { pid: this.fakePid };
  }

  override writeFrame(line: string): boolean {
    if (!this.alive) return false;
    this.sentFrames.push(line);
    let frame: WireFrame;
    try {
      frame = JSON.parse(line) as WireFrame;
    } catch {
      return true;
    }
    void this.endpointHandle(frame);
    return true;
  }

  override onFrame(handler: (line: string) => void): void {
    this.lineSubscribers.push(handler);
  }

  override onExit(handler: (info: EngineTransportExitInfo) => void): void {
    this.exitSubscribers.push(handler);
  }

  override async close(reason = "engine channel close"): Promise<void> {
    this.closeReasons.push(reason);
    await super.close(reason);
  }

  /** 测试钩子：模拟引擎 stdout 行（真实链路 = transport 行切分后的一行）。 */
  emitLine(line: string): void {
    for (const handler of [...this.lineSubscribers]) handler(line);
  }

  /** 测试钩子：模拟引擎终局（exit 事件投影）。 */
  emitExit(info: EngineTransportExitInfo): void {
    if (!this.alive) return;
    this.alive = false;
    for (const handler of [...this.exitSubscribers]) handler(info);
  }

  private emitStderr(chunk: string): void {
    this.ownOpts.onStderr?.(chunk);
  }

  private send(frame: object): void {
    this.emitLine(JSON.stringify(frame));
  }

  private reverseRequest(id: string, method: string, params: unknown): void {
    this.send({ id, method, params });
  }

  private async endpointHandle(frame: WireFrame): Promise<void> {
    if (frame.method === undefined) {
      // 反向请求的应答（id 字符串）：ack-only 不落终态（两阶段协议，R9-2），其余唤醒等待方
      if (typeof frame.id === "string") {
        const r = frame.result as Record<string, unknown> | undefined;
        const isAckOnly =
          r !== null && typeof r === "object" &&
          "ack" in r && !("value" in r) && !("cancelled" in r) && !("unsupported" in r);
        if (!isAckOnly) {
          this.askUserFinal.set(frame.id, r);
          for (const waiter of this.askUserWaiters) waiter();
        }
      }
      return;
    }
    switch (frame.method) {
      case "initialize": {
        if (this.script.crashOnInitialize) {
          this.emitStderr(this.script.crashOnInitialize.stderr);
          this.emitExit({ code: this.script.crashOnInitialize.code, signal: null });
          return;
        }
        this.send({
          id: frame.id,
          result: {
            protocolVersion: this.script.protocolVersion ?? 1,
            engineId: "fake",
            engineVersion: "fake-1.0.0",
            adapterVersion: "fake-adapter",
            capabilities: FAKE_CAPABILITIES,
            models: FAKE_MODELS,
          },
        });
        return;
      }
      case "ping":
        this.send({ id: frame.id, result: { pong: true } });
        return;
      case "dispose":
        this.send({ id: frame.id, result: { ok: true } });
        // 引擎 dispose 应答后自然退出（fake-engine.mjs 同语义）
        this.emitExit({ code: 0, signal: null });
        return;
      case "run": {
        const params = (frame.params ?? {}) as { runId?: string };
        const runId = params.runId ?? "run-1";
        await this.playRunActions(runId, frame.id as number);
        if (!this.alive) return;
        this.send({ id: frame.id, result: fakeRunResult(runId) });
        return;
      }
      default:
        this.send({
          id: frame.id,
          error: {
            code: "engine_unknown_method",
            message: `unknown method ${frame.method}`,
            recovery: "inspect the fake engine scenario",
          },
        });
    }
  }

  private async playRunActions(runId: string, requestId: number): Promise<void> {
    for (const action of this.script.runActions ?? []) {
      if (!this.alive) return; // run 已被引擎死亡打断
      // 动作间让出一拍微任务：反向请求的数据范围分发（handleDataPlaneRequest 以
      // Promise.resolve().then 派发）在下一动作前落地——对齐真实链路逐行到达的
      // 时序（childSpawned 先落镜像，exit 再触发 teardown；否则 killAll 清空后
      // 迟到的分发会把镜像重新填上）。
      await Promise.resolve();
      switch (action.op) {
        case "emit":
          this.send({
            method: "event",
            params: { runId: action.runId ?? runId, seq: action.seq ?? 1, event: action.event },
          });
          break;
        case "streamDelta":
          this.reverseRequest(`rev-stream-${requestId}`, "host/streamDelta", {
            runId: action.runId ?? runId,
            delta: action.delta ?? "",
          });
          break;
        case "handleReady":
          this.reverseRequest(`rev-ready-${requestId}`, "host/handleReady", {
            runId: action.runId ?? runId,
            sessionRef: action.sessionRef ?? { sessionId: "fake-session" },
            poolKey: "shared",
          });
          break;
        case "childSpawned":
          this.reverseRequest(`rev-child-${requestId}`, "host/childSpawned", {
            pid: action.pid,
            recordId: action.recordId,
          });
          break;
        case "childStateChanged":
          this.reverseRequest(`rev-childst-${requestId}`, "host/childStateChanged", childStateChangedPayload(action));
          break;
        case "log":
          this.reverseRequest(`rev-log-${requestId}`, "host/log", {
            level: action.level ?? "debug",
            component: action.component ?? "fake",
            message: action.message ?? "",
          });
          break;
        case "askUser": {
          const revId = `rev-ask-${requestId}-${Math.random().toString(36).slice(2, 7)}`;
          this.reverseRequest(revId, "host/askUser", {
            runId: action.runId ?? runId,
            request: action.request ?? { method: "select", id: "q1" },
          });
          // 等两阶段最终结果（ack 之后 core 异步补帧②）——挂起至结果到达
          await new Promise<void>((resolve) => {
            const waiter = (): void => {
              if (this.askUserFinal.has(revId)) {
                this.askUserWaiters.delete(waiter);
                resolve();
              }
            };
            this.askUserWaiters.add(waiter);
            waiter();
          });
          const final = this.askUserFinal.get(revId);
          if (action.echoEvent !== false) {
            this.send({
              method: "event",
              params: {
                runId: action.runId ?? runId,
                seq: action.seq ?? 99,
                event: { type: "error", message: `askUser-result:${JSON.stringify(final)}` },
              },
            });
          }
          break;
        }
        case "delay":
          // 引擎长跑不回 run 终态（真实 fixture 用独立进程真实时钟 delay；端点桩以
          // 永不 resolve 表达「run 保持挂起」，timer 域留给宿主侧 fake timers 检查）
          await new Promise<void>(() => {});
          break;
        case "exit":
          if (action.stderr !== undefined) this.emitStderr(action.stderr);
          this.emitExit({ code: action.code ?? 137, signal: null });
          return;
      }
    }
  }
}

/** 端点桩客户端：resolveTransport 每代换新 ScriptedLocalTransport（对齐生产换代语义）。 */
class ScriptedEngineClient extends EngineClient {
  private readonly scriptFactory: () => EngineScript;
  readonly transports: ScriptedLocalTransport[] = [];

  constructor(script: EngineScript, overrides: Partial<ConstructorParameters<typeof EngineClient>[0]> = {}) {
    super({
      engineId: "fake",
      command: process.execPath,
      args: [],
      hostKind: "test",
      hostVersion: "test-host-1.0",
      dataDir,
      envPrefixes: [],
      ...overrides,
    });
    this.scriptFactory = () => script;
  }

  protected override resolveTransport(): EngineTransport {
    const transport = new ScriptedLocalTransport(
      {
        engineId: "fake",
        dataDir,
        hostKind: "test",
        engineCmdlineMatcher: () => false,
        // 与生产 createLocalTransport 同源的 stderr 环形缓冲接线（appendStderrTail 测试 seam）
        onStderr: (chunk) => this.appendStderrTail(chunk),
      },
      this.scriptFactory(),
      ScriptedEngineClient.nextFakePid++,
    );
    this.transports.push(transport);
    return transport;
  }

  private static nextFakePid = 42_000;

  get currentTransport(): ScriptedLocalTransport | undefined {
    return this.transports[this.transports.length - 1];
  }
}

describe("EngineClient 帧往返与握手（进程端点桩）", () => {
  it("ensureConnected：open + initialize 握手 → ready（端点 pid 独立；客户端状态机全真）", async () => {
    const client = new ScriptedEngineClient({});
    await client.ensureConnected();
    expect(client.currentState).toBe("ready");
    expect(client.enginePid).toBeDefined();
    expect(client.enginePid).not.toBe(process.pid);
    expect(client.currentTransport!.openedSpec).toMatchObject({
      engineId: "fake",
      entryPath: process.execPath,
      args: [],
    });
    await client.dispose();
  });

  it("版本协商越界：engine_protocol_mismatch（含双方版本 + 升级指引）+ 该引擎标记不可用", async () => {
    const client = new ScriptedEngineClient({ protocolVersion: 99 });
    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
    expect(client.currentState).toBe("unavailable");
    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
    await expect(client.dispose()).resolves.toBeUndefined(); // dispose 幂等不抛
  });

  it("initialize 应答与 manifest 诊断不一致 → warn 留痕（仅诊断，不阻断 ready）", async () => {
    const warnMessages: string[] = [];
    const client = new ScriptedEngineClient({}, {
      manifestDiagnostics: {
        capabilities: {
          schemaEnforcement: "native",
          steer: "native",
          conversation: "native",
          personaInjection: "file",
          eventGranularity: "coarse",
          sandbox: "native",
          sessionRead: "partial",
          resume: "native",
          interrupt: "native",
          permissionMode: "native",
          maxTurns: true,
        },
      },
    });
    const original = console.warn;
    console.warn = (...parts: unknown[]) => {
      warnMessages.push(parts.join(" "));
    };
    try {
      await client.ensureConnected();
    } finally {
      console.warn = original;
    }
    expect(client.currentState).toBe("ready");
    expect(warnMessages.some((m) => m.includes("capabilities differ from manifest"))).toBe(true);
    await client.dispose();
  });
});

describe("EngineClient 反向通知路由（run 作用域 + 镜像）", () => {
  it("event 通知 / streamDelta / handleReady 路由到 run 作用域回调；handleReady 回填 partial handle", async () => {
    const events: unknown[] = [];
    const deltas: string[] = [];
    const readyPartials: Array<{ sessionRef: Record<string, string> }> = [];
    const route: RunRoute = {
      onEvent: (e) => {
        events.push(e);
      },
      onStreamDelta: (d) => {
        deltas.push(d);
      },
      onHandleReady: (partial) => {
        readyPartials.push(partial);
      },
    };
    const client = new ScriptedEngineClient({
      runActions: [
        { op: "emit", seq: 1, event: { type: "text_delta", delta: "hello" } },
        { op: "streamDelta", delta: "stream-1" },
        { op: "handleReady", sessionRef: { sessionId: "s-1" } },
      ],
    });
    const unregister = client.registerRunRoute("run-1", route);
    await client.ensureConnected();
    const result = (await requestRun1(client)) as {
      handle: { sessionRef: Record<string, string> };
      outcome: { content: string };
    };
    expectRunRoundTrip(result, { events, deltas, readyPartials });
    expect(client.getPartialHandle()).toEqual({ sessionRef: { sessionId: "s-1" } });
    unregister();
    await client.dispose();
  });

  it("host/childSpawned + host/childStateChanged → 镜像落项/更新（onMirrorChanged 注入点已删，经 mirror 快照观测）", async () => {
    const client = new ScriptedEngineClient({
      runActions: [
        { op: "childSpawned", pid: 4242, recordId: "rec-1" },
        { op: "childStateChanged", pid: 4242, recordId: "rec-1", state: "exited", killed: true, exitCode: 3 },
      ],
    });
    await client.ensureConnected();
    await requestRun1(client);
    expect(client.mirror.getEntry(4242)).toMatchObject({
      pid: 4242,
      state: "exited",
      killed: true,
      exitCode: 3,
    });
    await client.dispose();
    // dispose → 整体置死 + 清空（失效语义 2+3）
    expect(client.mirror.size).toBe(0);
  });

  it("host/log 数据范围 → 缺省 logger facade 不抛（log 注入点已删，恒走缺省）", async () => {
    const client = new ScriptedEngineClient({
      runActions: [{ op: "log", level: "warn", component: "fake-comp", message: "log-line-1" }],
    });
    await client.ensureConnected();
    await requestRun1(client);
    // run 应答成功即 host/log 分发未抛（分发抛错也回 ok，但缺省 logger 自身不得炸）。
    expect(client.currentState).toBe("ready");
    await client.dispose();
  });
});

describe("stdout 非 NDJSON 行（客户端半；半行残片上限在 transport-local 桩轨）", () => {
  it("垃圾行丢弃留痕 + 截断不得破坏后续帧边界（后续 run 应答照常解析）", async () => {
    const warnMessages: string[] = [];
    const client = new ScriptedEngineClient({});
    await client.ensureConnected();
    const original = console.warn;
    console.warn = (...parts: unknown[]) => {
      warnMessages.push(parts.join(" "));
    };
    try {
      // 真实链路里这行 = 半行残片截断后被换行冲刷出的垃圾行（transport 层已丢头留尾）
      client.currentTransport!.emitLine("x".repeat(200));
      const result = (await requestRun1(client)) as { outcome: { content: string } };
      expect(result.outcome.content).toBe("fake-content-run-1");
    } finally {
      console.warn = original;
    }
    // 冲刷出的垃圾行按 non-NDJSON 丢弃留痕
    expect(warnMessages.some((m) => m.includes("dropped non-NDJSON stdout line"))).toBe(true);
    await client.dispose();
  });
});

describe("镜像桥接 → core 镜像映射（u7a 数据范围桥接）", () => {
  // bridge 写的是 core 进程级单例镜像（globalThis[Symbol.for] 槽），测试间必须隔离。
  beforeEach(() => {
    _resetCoreSpawnedChildrenMirrorForTest();
  });

  it("childSpawned → core 镜像登记活句柄；自然退出（state:exited, killed:false）→ 置死不登记活句柄", () => {
    const client = new ScriptedEngineClient({});
    client.mirror.recordSpawned(4242, "rec-bridge");
    expect(hasLiveProcessHandleCore("rec-bridge")).toBe(true);

    // pi 子进程自行退出/崩溃的载荷形态：killed=false（child.killed 只在我方 kill 过
    // 才为 true）、state=exited——映射必须置死 core 镜像项，否则 countInFlight 虚高
    // （幻影在途拖住滚动重启判据）+ isResumable 恒 false（resumable 说谎）。
    client.mirror.recordStateChanged({
      pid: 4242,
      recordId: "rec-bridge",
      state: "exited",
      killed: false,
      exitCode: 1,
    });
    expect(hasLiveProcessHandleCore("rec-bridge")).toBe(false);
  });

  it("被杀退出（state:exited, killed:true）→ 置死（既有行为不回归）", () => {
    const client = new ScriptedEngineClient({});
    client.mirror.recordSpawned(4243, "rec-killed");
    expect(hasLiveProcessHandleCore("rec-killed")).toBe(true);
    client.mirror.recordStateChanged({
      pid: 4243,
      recordId: "rec-killed",
      state: "exited",
      killed: true,
      signal: "SIGTERM",
    });
    expect(hasLiveProcessHandleCore("rec-killed")).toBe(false);
  });
});

describe("host/askUser ack 两阶段（R9-2）", () => {
  it("host/askUser 应答端（槽注入）：先回 {ack:true}，handler 结果异步补帧②（引擎 echo 结果 event）", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const client = new ScriptedEngineClient({
      runActions: [
        { op: "emit", seq: 1, event: { type: "text_delta", delta: "before" } },
        { op: "askUser", request: { method: "select", id: "q1", title: "pick" } },
      ],
    });
    // [D3] 构造后经槽登记（生产 = SubagentService init/initSession 写点）——reverse-router
    // 消费时现读，构造期不固化值的情形
    setHostUiRequestEndpoint(async (req) => {
      expect(req.method).toBe("select");
      return { value: "answer-A" };
    });
    const unregister = client.registerRunRoute("run-1", {
      onEvent: (e) => {
        events.push(e as { type: string; message?: string });
      },
    });
    await client.ensureConnected();
    await requestRun1(client);
    unregister();
    const echo = events.find((e) => e.message?.startsWith("askUser-result:"));
    expect(echo?.message).toContain('"value":"answer-A"');
    await client.dispose();
  });

  it("handler 抛错 → 引擎收 {cancelled:true}（dialog-queue 应答链同款兜底）", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const client = new ScriptedEngineClient({
      runActions: [{ op: "askUser", request: { method: "confirm", id: "q2" } }],
    });
    setHostUiRequestEndpoint(async () => {
      throw new Error("handler exploded");
    });
    const unregister = client.registerRunRoute("run-1", {
      onEvent: (e) => {
        events.push(e as { type: string; message?: string });
      },
    });
    await client.ensureConnected();
    await requestRun1(client);
    unregister();
    const echo = events.find((e) => e.message?.startsWith("askUser-result:"));
    expect(echo?.message).toContain('"cancelled":true');
    await client.dispose();
  });

  it("槽无应答端 → {unsupported:true}（未实现的交互能力，引擎自行降级）", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    _resetHostUiRequestEndpointForTest(); // 槽显式清空（防其他文件的进程级槽残留）
    const client = new ScriptedEngineClient({
      runActions: [{ op: "askUser", request: { method: "input", id: "q3" } }],
    });
    const unregister = client.registerRunRoute("run-1", {
      onEvent: (e) => {
        events.push(e as { type: string; message?: string });
      },
    });
    await client.ensureConnected();
    await requestRun1(client);
    unregister();
    const echo = events.find((e) => e.message?.startsWith("askUser-result:"));
    expect(echo?.message).toContain('"unsupported":true');
    await client.dispose();
  });
});

describe("超时域二分（fake timers，R9-2 / R9-2b）", () => {
  it("快答数据范围挂起 10s → 引擎故障：杀链 + 在途 run 失败（engine_crashed）", async () => {
    vi.useFakeTimers();
    const client = new ScriptedEngineClient({
      runActions: [
        // streamDelta 挂起宿主消费方 + 引擎长跑保持 run 在途（端点桩 delay 永不 resolve）
        { op: "streamDelta", delta: "hang" },
        { op: "delay" },
      ],
    });
    const unregister = client.registerRunRoute("run-1", {
      onStreamDelta: () => new Promise<void>(() => {}), // 宿主消费方死锁
    });
    await client.ensureConnected();
    const runFailed = expect(requestRun1(client)).rejects.toMatchObject({ code: "engine_crashed" });
    // 分步推进：guardTimer 10s 计时由 fake timers 驱动，循环小步推进直到杀链生效
    // （teardown → state 离开 ready）。端点桩帧到达是微任务序，advance 内联 flush。
    for (let i = 0; i < 200 && client.currentState === "ready"; i += 1) {
      await vi.advanceTimersByTimeAsync(500);
    }
    await runFailed;
    expect(client.currentState).not.toBe("ready"); // 杀链已执行
    expect(client.currentTransport!.closeReasons.length).toBeGreaterThan(0); // 通道关闭已编排
    unregister();
    await client.dispose();
  });

  it("人机交互通道 ack 后永不计时：handler 挂 60s 不判引擎故障（R9-2 负向 + ADR-0047）", async () => {
    vi.useFakeTimers();
    const client = new ScriptedEngineClient({
      runActions: [{ op: "askUser", request: { method: "select", id: "q-hang" } }],
    });
    setHostUiRequestEndpoint(() => new Promise(() => {})); // 用户永不回答（槽注入，D3）
    await client.ensureConnected();
    const enginePid = client.enginePid!;
    void requestRun1(client).catch(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    // ack 已回（引擎继续跑），handler 挂起不触发任何杀链
    expect(client.currentState).toBe("ready");
    expect(client.enginePid).toBe(enginePid);
    expect(client.currentTransport!.closeReasons).toEqual([]); // 杀链零拉起
    vi.useRealTimers(); // dispose 收尾走真实时钟（端点桩无真实进程依赖，直接收敛）
    await client.dispose();
  });
});

describe("引擎崩溃与终局（A8①③）", () => {
  it("run 中引擎死亡：在途 run 失败（engine_crashed + stderr 尾）+ 镜像清空（pidfile 清理在真进程门控轨）", async () => {
    const client = new ScriptedEngineClient({
      runActions: [
        { op: "childSpawned", pid: 5151, recordId: "rec-crash" },
        { op: "exit", code: 137, stderr: "mid-run crash sample\n" },
      ],
    });
    await client.ensureConnected();
    expect(client.enginePid).toBeDefined();
    await expect(requestRun1(client)).rejects.toSatisfy((err: Error & { code?: string }) => {
      expect(err.code).toBe("engine_crashed");
      expect(err.message).toContain("stderr tail");
      expect(err.message).toContain("mid-run crash sample");
      return true;
    });
    expect(client.currentState).toBe("exited");
    expect(client.mirror.size).toBe(0); // 崩溃后镜像清空（读点回落「无句柄」）
    await client.dispose();
  });

  it("stderr 常驻排空：环形缓冲只留尾 400 字符（宿主侧不落盘）", async () => {
    const client = new ScriptedEngineClient({
      crashOnInitialize: { code: 1, stderr: `fatal: fake engine boot failure ${"x".repeat(600)}\n` },
    });
    // crash 模式：initialize 帧到达即死（stderr 写 600+ 字符样本）→ initialize 无应答 →
    // 一次即标记不可用 reject engine_crashed（ADR-0122：无自动重建）。
    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_crashed" });
    expect(client.stderrTailText.length).toBeLessThanOrEqual(401);
    expect(client.stderrTailText).toContain("x"); // 尾部内容保留（头部被截）
    expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(false);
    await client.dispose();
  });

  it("初建失败：一次即标记不可用（恒 throw，含恢复指引；ADR-0122 无自动重建）", async () => {
    const client = new ScriptedEngineClient({
      crashOnInitialize: { code: 1, stderr: "fatal: fake engine boot failure\n" },
    });
    await expect(client.ensureConnected()).rejects.toSatisfy(
      (err: Error & { code?: string; recovery?: string }) => {
        expect(err.code).toBe("engine_crashed");
        expect(err.message).toContain("failed to start");
        expect(err.recovery).toContain("unavailable until the next host start");
        return true;
      },
    );
    expect(client.currentState).toBe("unavailable");
    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_crashed" });
    await client.dispose();
  });

  it("运行期崩溃恢复：调用方显式重连（ensureConnected）后重建成功（新 pid）；连接复用不重建", async () => {
    const client = new ScriptedEngineClient({});
    await client.ensureConnected();
    const firstPid = client.enginePid!;
    // 模拟崩溃（exit 事件投影，同步终局——确定性，无需轮询）
    client.currentTransport!.emitExit({ code: null, signal: "SIGKILL" });
    expect(client.currentState).toBe("exited");
    await client.ensureConnected();
    expect(client.currentState).toBe("ready");
    expect(client.enginePid).not.toBe(firstPid); // 新一代通道（fake pid 递增）
    const pidAfterRebuild = client.enginePid;
    await client.ensureConnected(); // 连接复用：不重建
    expect(client.enginePid).toBe(pidAfterRebuild);
    expect(client.transports).toHaveLength(2);
    await client.dispose();
  });
});

describe("收割与停机编排（R9-1；进程组真杀在真进程门控轨）", () => {
  it("dispose：帧 → 端点应答后自然退出 → 关闭编排；幂等；killAll 在已死通道上不抛", async () => {
    const client = new ScriptedEngineClient({});
    await client.ensureConnected();
    const transport = client.currentTransport!;
    await client.dispose();
    expect(transport.sentFrames.some((line) => line.includes('"dispose"'))).toBe(true);
    expect(transport.closeReasons).toContain("dispose");
    expect(client.currentState).toBe("disposed");
    await expect(client.dispose()).resolves.toBeUndefined(); // 幂等
    await expect(client.killAll("again")).resolves.toBeUndefined(); // 已终局不抛
  });
});

describe("pidfile 启动期清扫（EngineClient 接线，R9-3）", () => {
  it("首次 ensureConnected 前清扫同 id 陈旧 pidfile（宿主死残留被删；清扫经 localTransport 真实接线）", async () => {
    // 陈旧 pidfile：宿主 pid 与引擎 pid 均为不可达高位（probePidAliveness → ESRCH 判死，
    // 真实探测是 process.kill 系统调用——无子进程、确定性）
    const stalePath = pidfilePath(dataDir, "fake", "pi", 999_999_990);
    writePidfileAtomic(stalePath, {
      enginePid: 999_999_991,
      hostPid: 999_999_990,
      engineStartTime: null,
      engineId: "fake",
      hostKind: "pi",
      writtenAt: new Date().toISOString(),
    });
    expect(existsSync(stalePath)).toBe(true);

    const client = new ScriptedEngineClient({});
    await client.ensureConnected(); // 启动清扫发生在这里（connectOnce 内、open 前）
    expect(existsSync(stalePath)).toBe(false); // 陈旧文件被清（防 N 次崩溃重启堆积）
    await client.dispose();
  });
});

// ── 真进程全链（fake-engine.mjs 真子进程；进程事实 = 判据③，挂集成门控）──────────
// 覆盖端点桩无法承载的进程面：真 spawn 握手 + 实例 pidfile 写入/清理（enginePid/
// hostPid/engineStartTime 真值）+ run 反向路由真链 + POSIX 进程组收割（含组内后代）。
describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `EngineClient 真进程全链（W2 冒烟）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
    function makeRealClient(
      overrides: Partial<ConstructorParameters<typeof EngineClient>[0]> = {},
    ): EngineClient {
      return new EngineClient({
        engineId: "fake",
        command: process.execPath,
        args: [FAKE_ENGINE],
        hostKind: "test",
        hostVersion: "test-host-1.0",
        dataDir,
        envPrefixes: [],
        ...overrides,
      });
    }

    it("spawn + initialize 握手 → ready + 实例 pidfile 内容 + run 反向路由 + dispose 清理 pidfile", async () => {
      const events: unknown[] = [];
      const deltas: string[] = [];
      const readyPartials: Array<{ sessionRef: Record<string, string> }> = [];
      const client = makeRealClient({
        args: [
          FAKE_ENGINE,
          "--run-actions",
          JSON.stringify([
            { op: "emit", seq: 1, event: { type: "text_delta", delta: "hello" } },
            { op: "streamDelta", delta: "stream-1" },
            { op: "handleReady", sessionRef: { sessionId: "s-1" } },
          ]),
        ],
      });
      const unregister = client.registerRunRoute("run-1", {
        onEvent: (e) => {
          events.push(e);
        },
        onStreamDelta: (d) => {
          deltas.push(d);
        },
        onHandleReady: (partial) => {
          readyPartials.push(partial);
        },
      });
      await client.ensureConnected();
      expect(client.currentState).toBe("ready");
      expect(client.enginePid).toBeDefined();
      expect(client.enginePid).not.toBe(process.pid);
      const path = pidfilePath(dataDir, "fake", "test", process.pid);
      expect(existsSync(path)).toBe(true);
      expect(readPidfile(path)).toMatchObject({
        enginePid: client.enginePid,
        hostPid: process.pid,
        hostKind: "test",
        engineId: "fake",
      });
      expect(readPidfile(path)?.engineStartTime).not.toBeNull(); // POSIX 真值（R9-3b）
      const result = (await requestRun1(client)) as { outcome: { content: string } };
      expectRunRoundTrip(result, { events, deltas, readyPartials });
      unregister();
      await client.dispose();
      expect(existsSync(path)).toBe(false); // dispose 清理
    });

    it("killAll：负 pid 按进程组终止连带组内后代（引擎 + grandchild 全灭）+ 镜像置死 + pidfile 清理", async () => {
      const client = makeRealClient({
        args: [
          FAKE_ENGINE,
          "--run-actions",
          JSON.stringify([{ op: "spawnGrandchild", recordId: "rec-grand" }]),
        ],
      });
      const unregister = client.registerRunRoute("run-1", {});
      void client
        .ensureConnected()
        .then(() => requestRun1(client))
        .catch(() => {});
      await waitFor(() => client.mirror.size > 0);
      const grandchildPid = client.mirror.snapshot()[0]!.pid;
      const enginePid = client.enginePid!;
      expect(probePidAliveness(grandchildPid)).toBe(true);

      await client.killAll("test harvest");
      // 组内双亡（detached 后代不覆盖——R9-1 已接受代价，不在断言范围）
      await waitFor(() => probePidAliveness(grandchildPid) === false);
      await waitFor(() => probePidAliveness(enginePid) === false);
      expect(client.mirror.size).toBe(0);
      expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(false);
      unregister();
    });
  },
);
