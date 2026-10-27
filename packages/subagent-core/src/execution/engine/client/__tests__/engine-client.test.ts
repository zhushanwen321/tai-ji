// EngineClient / RemoteEngine / transport 族合并产物（round5-g C27）。
//
// 来源（基名，同包原独立 spec，用例逐字并入、各包一层同名 describe）：
//   engine-client / remote-engine / transport-runtime / transport-local /
//   transport-selection / reverse-router-slot-read / host-askuser-endpoint。
// 被测对象同域（EngineClient 及其 transport/远端门面），零 vi.mock：真 spawn
// fake-engine、真 unix socket、类继承端点桩与实例级 spyOn，模块装载一次供全部
// 用例复用。
//
// 同簇未并入：engine-client-reap.test.ts（唯一 vi.mock 件——killProcessTree spy +
// node:child_process spawn/spawnSync spy 与本产物各件的真 spawn / 真进程组收割
// 链硬互斥），保留独立文件。
//
// 多层 describe 前缀为来源区块名（可溯源性）；区块内用例与 hook 原样保留。
// 集成门控用例（TAIJI_TEST_INTEGRATION）维持原 skipIf 语义。
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ENGINE_TRANSPORT_ERROR_RECOVERY,
  EngineSdkError,
  getLogger,
  getLogger as sdkGetLogger,
  SUBAGENT_CONTROL_FRAME_KINDS,
  SUBAGENT_CONTROL_PROTOCOL_VERSION,
  type UiRequest,
} from "@zhushanwen/subagent-engine-sdk";

import {
  INTEGRATION_TESTS_ENABLED,
  INTEGRATION_TESTS_SKIP_REASON,
} from "../../../../../../../test-guard/integration-gate.ts";
import { configureCore, resetCoreForTests } from "../../../../core/host-services.ts";
import { getLogger as coreGetLogger } from "../../../../core/logger.ts";
import { GLOBAL_SLOT_KEYS } from "../../../../shared/global-slots.ts";
import { getSubagentSessionDir } from "../../../assembly/path-encoding.ts";
import { SubagentStream, createBackgroundStream } from "../../../assembly/stream-sink.ts";
import { EngineClient, type RunRoute, SUBAGENT_TRANSPORT_ENV } from "../engine-client.ts";
import {
  ARMED_RECEIPT_TIMEOUT_ENV,
  ARMED_RECEIPT_TIMEOUT_MS,
  CANCEL_SETTLE_GRACE_WINDOW_MS,
  RemoteEngine,
  type RemoteEngineManifestSnapshot,
} from "../remote-engine.ts";
import { pidfilePath, probePidAliveness, readPidfile, writePidfileAtomic } from "../pid-file.ts";
import { isForcedLocalTransport, usesRuntimeTransport } from "../transport-selection.ts";
import {
  RuntimeControlClient,
  acquireRuntimeControlClient,
} from "../transport/control-client.ts";
import {
  controlClientKey,
  mapControlError,
  type ControlChannelHandlers,
} from "../transport/control-shared.ts";
import { RuntimeEngineTransport, type RuntimeEngineTransportOptions } from "../transport/runtime.ts";
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
import { waitFor } from "./helpers/wait-for.ts";

// ── 来源区块：engine-client.test.ts ────────────────────────────────────────────────
describe("engine-client", () => {
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

  describe("stdout 非 NDJSON 行（客户端半；半行残片上限在 transport-local 桩层）", () => {
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
    it("run 中引擎死亡：在途 run 失败（engine_crashed + stderr 尾）+ 镜像清空（pidfile 清理在真进程门控组）", async () => {
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

  describe("收割与停机编排（R9-1；进程组真杀在真进程门控组）", () => {
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
});

// ── 来源区块：remote-engine.test.ts ────────────────────────────────────────────────
describe("remote-engine", () => {
  const FAKE_ENGINE = fileURLToPath(new URL("./__fixtures__/fake-engine.mjs", import.meta.url));

  /**
   * 默认 manifest capabilities 基线（与 fake 引擎 initialize 应答逐位一致——gate 位
   * 多声明判定的「一致放行」基线；多声明用例在此上单点改强）。
   */
  const FAKE_MATCHED_CAPS = {
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

  /** 轮询等待本文件用例量级 8s（引擎全链真 IO），经共享 waitFor 转发（真实 timers；
   *  引擎启动/信号传播是真实 IO，fake timers 会挂死自写轮询）。 */
  const waitForTrue = (predicate: () => boolean, timeoutMs = 8_000, stepMs = 25): Promise<void> =>
    waitFor(predicate, timeoutMs, stepMs);

  function waitForReady(client: EngineClient): Promise<void> {
    return waitForTrue(() => client.currentState === "ready");
  }

  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "w2-remote-engine-"));
    // [session-store-layout-inversion] wire ctx.sessionDir 恒有值（Gate B S6 协议契约
    // ——宿主绑定形态缺省推导 fail-fast）：harness 以「宿主进程有 session 绑定」形态
    // 注入贯穿 env（deriveHostSubagentSessionDir 缺省推导输入）+ dataDir env 把推导
    // 落点收进本 mkdtemp 目录（自建自删红线）。ctx 显式注入仍优先（逐用例覆盖）。
    vi.stubEnv("PI_SUBAGENT_ROOT_SESSION_ID", "sid-w2-remote-engine");
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    vi.useRealTimers();
    // [D3 槽现读] host/askUser 应答端经 host-ui-endpoint 槽注入——用例后清空防串扰
    _resetHostUiRequestEndpointForTest();
    // [D2] extensionPaths 注入用例 configureCore 的宿主配置，用例后复位防串扰
    resetCoreForTests();
  });

  interface Fixture {
    engine: RemoteEngine;
    client: EngineClient;
    cleanup: () => Promise<void>;
  }

  function makeEngine(
    manifestOverrides: Partial<RemoteEngineManifestSnapshot> = {},
    clientOverrides: Partial<ConstructorParameters<typeof EngineClient>[0]> = {},
    engineOverrides: Partial<ConstructorParameters<typeof RemoteEngine>[0]> = {},
  ): Fixture {
    const client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [FAKE_ENGINE],
      hostKind: "test",
      dataDir,
      envPrefixes: [],
      ...clientOverrides,
    });
    const engine = new RemoteEngine({
      engineId: "fake",
      client,
      dataDir,
      hostKind: "test",
      manifest: {
        capabilities: { ...FAKE_MATCHED_CAPS },
        modelCatalog: {
          dynamic: true,
          models: [
            { id: "glm-4.6", aliases: ["glm"], canonicalRef: "zai/glm-4.6" },
            { id: "mimo-v2.6-flash", canonicalRef: "xiaomi-token-plan-cn/mimo-v2.6-flash" },
          ],
        },
        ...manifestOverrides,
      },
      ...engineOverrides,
    });
    return { engine, client, cleanup: () => client.dispose() };
  }

  /** RunContext 构造（回调收集器）。 */
  function makeCtx(overrides: Partial<Parameters<RemoteEngine["run"]>[1]> = {}) {
    const events: unknown[] = [];
    return {
      ctx: {
        taskId: "run-1",
        poolKey: "shared",
        onEvent: (e: unknown) => {
          events.push(e);
        },
        ...overrides,
      } as Parameters<RemoteEngine["run"]>[1],
      events,
    };
  }

  /** 从 fake 引擎的 run-params 回显 event 解析引擎实际收到的帧载荷。 */
  function extractRunParams(events: unknown[]): { task: Record<string, unknown>; ctx: Record<string, unknown> } {
    const echo = events.find(
      (e) => (e as { type: string; message?: string }).type === "error"
        && typeof (e as { message?: string }).message === "string"
        && (e as { message: string }).message.startsWith("run-params:"),
    ) as { message: string };
    expect(echo).toBeDefined();
    return JSON.parse(echo.message.slice("run-params:".length));
  }

  describe("RemoteEngine 同步成员形态映射（必写死）", () => {
    it("capabilities()：直读 manifest 注册期快照（不触发连接——构造同步、无缓存）", () => {
      const { engine, client, cleanup } = makeEngine();
      const caps = engine.capabilities();
      expect(caps.schemaEnforcement).toBe("emulated");
      expect(caps.maxTurns).toBe(false);
      expect(client.currentState).toBe("idle"); // 同步成员不碰协议
      void cleanup;
    });

    it("listModelsFromManifest() 四态：省略 modelCatalog → null；dynamic:true+[] → null（无静态枚举情形，B1）；dynamic:false+[] → []（显式空清单）；静态非空 → 原样", async () => {
      const omitted = makeEngine({ modelCatalog: undefined });
      expect(omitted.engine.listModelsFromManifest()).toBeNull();
      const nullForm = makeEngine({ modelCatalog: null });
      expect(nullForm.engine.listModelsFromManifest()).toBeNull(); // null 合法等价省略
      // B1 缺陷根因用例：dynamic:true 声明清单运行期动态发现，静态空目录 ≠ 无模型——
      // 不得映射为 []（那会走 buildEmptyModelsHint「no credentialed models」误导拒绝派发）
      const dynamicEmpty = makeEngine({ modelCatalog: { dynamic: true, models: [] } });
      expect(dynamicEmpty.engine.listModelsFromManifest()).toBeNull();
      const explicitEmpty = makeEngine({ modelCatalog: { dynamic: false, models: [] } });
      expect(explicitEmpty.engine.listModelsFromManifest()).toEqual([]);
      const listed = makeEngine();
      expect(listed.engine.listModelsFromManifest()).toEqual([
        { id: "glm-4.6", aliases: ["glm"], canonicalRef: "zai/glm-4.6" },
        { id: "mimo-v2.6-flash", canonicalRef: "xiaomi-token-plan-cn/mimo-v2.6-flash" },
      ]);
      await Promise.all([omitted, nullForm, dynamicEmpty, explicitEmpty, listed].map((f) => f.cleanup()));
    });

    it("[listModels 异步面] 静态快照可枚举 → listModels() 同步返回快照（非 Promise，同步消费方保形）", async () => {
      const listed = makeEngine();
      const result = listed.engine.listModels();
      expect(result).not.toBeInstanceOf(Promise);
      expect(result).toEqual([
        { id: "glm-4.6", aliases: ["glm"], canonicalRef: "zai/glm-4.6" },
        { id: "mimo-v2.6-flash", canonicalRef: "xiaomi-token-plan-cn/mimo-v2.6-flash" },
      ]);
      expect(listed.client.currentState).toBe("idle"); // 静态面不触发连接
      const explicitEmpty = makeEngine({ modelCatalog: { dynamic: false, models: [] } });
      expect(explicitEmpty.engine.listModels()).toEqual([]); // 显式空清单同步保形
      await explicitEmpty.cleanup();
      await listed.cleanup();
    });

    it("[listModels 异步面] 无静态枚举（dynamic:true+[]）→ 协议 listModels 帧拿引擎活清单（async RPC；zcode/pi manifest 占位形态）", async () => {
      const fixture = makeEngine({ modelCatalog: { dynamic: true, models: [] } });
      try {
        const result = fixture.engine.listModels();
        expect(result).toBeInstanceOf(Promise);
        // fake 引擎 listModels 应答 = MODELS 常量（同 initialize models 面）
        await expect(result).resolves.toEqual([
          { id: "glm-4.6", aliases: ["glm"], canonicalRef: "zai/glm-4.6" },
          { id: "mimo-v2.6-flash", canonicalRef: "xiaomi-token-plan-cn/mimo-v2.6-flash" },
        ]);
        expect(fixture.client.currentState).toBe("ready"); // RPC 经真连接（ensureConnected）
      } finally {
        await fixture.cleanup();
      }
    });

    it("[listModels 异步面] 无静态枚举（省略 modelCatalog）→ 同样走协议帧（union 门面判据 = 快照 null）", async () => {
      const fixture = makeEngine({ modelCatalog: undefined });
      try {
        const result = fixture.engine.listModels();
        expect(result).toBeInstanceOf(Promise);
        await expect(result).resolves.toEqual([
          { id: "glm-4.6", aliases: ["glm"], canonicalRef: "zai/glm-4.6" },
          { id: "mimo-v2.6-flash", canonicalRef: "xiaomi-token-plan-cn/mimo-v2.6-flash" },
        ]);
      } finally {
        await fixture.cleanup();
      }
    });

    it("[listModels 异步面] RPC 失败 → 原样上浮（EngineSdkError code 保留；放行语义归偏好层消费方）", async () => {
      const failingClient = {
        ensureConnected: async () => {},
        request: async () => {
          throw new EngineSdkError("engine_transport_lost", "socket closed", "restart the engine");
        },
        dispose: async () => {},
      } as unknown as EngineClient;
      const engine = new RemoteEngine({
        engineId: "fake",
        client: failingClient,
        dataDir,
        hostKind: "test",
        manifest: {
          capabilities: { ...FAKE_MATCHED_CAPS },
          modelCatalog: { dynamic: true, models: [] },
        },
      });
      await expect(engine.listModels()).rejects.toThrow(/engine_transport_lost/);
    });

    it("validateModel 成员不实现：manifest 省略 → typeof validateModel === 'undefined'（消费方跳过校验恒放行）", () => {
      const { engine } = makeEngine({ modelCatalog: undefined });
      expect(typeof (engine as unknown as { validateModel?: unknown }).validateModel).toBe("undefined");
      const { engine: withCatalog } = makeEngine();
      expect(typeof (withCatalog as unknown as { validateModel?: unknown }).validateModel).toBe("function");
    });

    it("validateModel 判定：命中回 canonicalRef；alias 命中；未命中 dynamic:false → engine_model_unknown 同步拒；dynamic:true → 放行原样 ref", () => {
      const { engine } = makeEngine();
      expect(engine.validateModel("zai/glm-4.6")).toEqual({ canonicalRef: "zai/glm-4.6" });
      expect(engine.validateModel("glm")).toEqual({ canonicalRef: "zai/glm-4.6" }); // alias
      expect(engine.validateModel("mimo-v2.6-flash")).toEqual({
        canonicalRef: "xiaomi-token-plan-cn/mimo-v2.6-flash",
      });
      // dynamic:true：未命中放行、原样 ref（运行期引擎为权威；无斜杠 ref 拆分 = 契约变更④归 W3）
      expect(engine.validateModel("custom/new-model")).toEqual({ canonicalRef: "custom/new-model" });

      const staticEngine = makeEngine({ modelCatalog: { dynamic: false, models: [{ id: "only-model" }] } });
      expect(staticEngine.engine.validateModel("only-model")).toEqual({ canonicalRef: "only-model" });
      expect(() => staticEngine.engine.validateModel("unknown-ref")).toThrowError(/engine_model_unknown/);
      expect(() => staticEngine.engine.validateModel(undefined)).toThrowError(/engine_model_unknown/);
      // dynamic:true 下 undefined ref（查引擎缺省）→ 放行（缺省模型运行期自证）
      expect(engine.validateModel(undefined)).toEqual({ canonicalRef: "" });
    });
  });

  describe("RemoteEngine run 帧映射", () => {
    it("task 子集收窄（model/cwd 改挂 ctx）+ ctxModel 映射 provider/id", async () => {
      const { engine, cleanup } = makeEngine();
      const { ctx, events } = makeCtx({
        ctxModel: { id: "glm-5.1", name: "GLM", provider: "zai", reasoning: true },
      });
      const task = {
        prompt: "do things",
        model: "zai/glm-4.6",
        cwd: "/tmp/w2-cwd",
        engine: "pi",
        timeoutMs: 1_000,
        returnMeta: true,
        maxTurns: 5,
        description: "desc-x",
        worktree: true,
      };
      const result = await engine.run(task, ctx);
      // 宿主自持字段（engine/timeoutMs/returnMeta）与双写字段（model/cwd）不进 task 帧
      const wire = extractRunParams(events);
      expect(wire.task).toMatchObject({ prompt: "do things", maxTurns: 5, description: "desc-x", worktree: true });
      expect(wire.task).not.toHaveProperty("model");
      expect(wire.task).not.toHaveProperty("engine");
      expect(wire.task).not.toHaveProperty("timeoutMs");
      expect(wire.task).not.toHaveProperty("returnMeta");
      expect(wire.task).not.toHaveProperty("cwd");
      expect(wire.ctx).toMatchObject({
        cwd: "/tmp/w2-cwd",
        model: "zai/glm-4.6",
        ctxModel: "zai/glm-5.1",
      });
      // H1：schemaEnv wire 字段退役——schema 本体只经 task.schema 承载，ctx 不得重现该键
      expect(wire.task).not.toHaveProperty("schemaEnv");
      expect(wire.ctx).not.toHaveProperty("schemaEnv");
      // 运行期引擎 fallback 已删：ctx 不得重现留痕字段（防字段名复活）
      expect(wire.ctx).not.toHaveProperty("engineFallback");
      expect(wire.ctx).not.toHaveProperty("streamMode"); // 无 stream → 缺省（JSON 序列化丢 undefined 键）
      expect(result.outcome.content).toBe("fake-content-run-1");
      expect(result.handle.data.engineId).toBe("fake");
      expect(result.handle.data.adapterVersion).toBe("fake-adapter");
      await cleanup();
    });

    it("ctx.stream 存在 → streamMode stream；streamDelta 反向请求 → stream.onDelta（真 SubagentStream flush）", async () => {
      const flushed: Array<string[] | undefined> = [];
      const sink = {
        setWidget: (_key: string, lines: string[] | undefined) => {
          flushed.push(lines);
        },
      };
      const stream = new SubagentStream("w2-rec", sink);
      const { engine, cleanup } = makeEngine(undefined, {
        args: [
          FAKE_ENGINE,
          "--run-actions",
          JSON.stringify([{ op: "streamDelta", delta: "d1" }, { op: "streamDelta", delta: "d2" }]),
        ],
      });
      const { ctx, events } = makeCtx({ stream });
      await engine.run({ prompt: "p" }, ctx);
      const wire = extractRunParams(events);
      expect(wire.ctx.streamMode).toBe("stream");
      // leading edge 同步 flush（["d1"]）；trailing edge 100ms 合并——buffer 累积语义
      // （widget 是累积预览，flush 不清 buffer，现状实现特征）
      expect(flushed[0]).toEqual(["d1"]);
      await vi.waitFor(() => expect(flushed[1]).toEqual(["d1d2"]));
      stream.dispose();
      await cleanup();
    });

    it("ctx.sessionRootId → wire ctx.sessionRootId 逐字保真；缺省不传 → wire 无该键（F6 additive）", async () => {
      // 正向：根 session id 上 wire（pi 引擎 engine_open 归属键的权威来源）
      const withRoot = makeEngine();
      const { ctx: ctxRoot, events: eventsRoot } = makeCtx({ sessionRootId: "root-sess-f6" });
      await withRoot.engine.run({ prompt: "p" }, ctxRoot);
      expect(extractRunParams(eventsRoot).ctx.sessionRootId).toBe("root-sess-f6");

      // 负向：缺省 → wire ctx 不出现该键（undefined 不上 wire，旧引擎 additive 兼容）
      const bare = makeEngine();
      const { ctx: ctxBare, events: eventsBare } = makeCtx();
      await bare.engine.run({ prompt: "p" }, ctxBare);
      expect(extractRunParams(eventsBare).ctx).not.toHaveProperty("sessionRootId");

      await withRoot.cleanup();
      await bare.cleanup();
    });

    it("[B-U-1] ctx.sessionRootId → client.ensureConnected({rootSessionId})（engine_open 归属键权威源贯通）+ [S-10] recordId = resume.recordId ?? taskId", async () => {
      const fixture = makeEngine();
      const spy = vi.spyOn(fixture.client, "ensureConnected");
      const { ctx } = makeCtx({ sessionRootId: "root-sess-connect" });
      await fixture.engine.run({ prompt: "p" }, ctx);
      expect(spy).toHaveBeenCalledWith({ rootSessionId: "root-sess-connect", recordId: ctx.taskId });
      await fixture.cleanup();

      // 续聊轮：record 锚沿用原 record（resume.recordId 优先于新 taskId）
      const resumed = makeEngine();
      const resumedSpy = vi.spyOn(resumed.client, "ensureConnected");
      const { ctx: ctxResume } = makeCtx({ sessionRootId: "root-sess-connect" });
      ctxResume.resume = { recordId: "rec-original" };
      await resumed.engine.run({ prompt: "p2" }, ctxResume);
      expect(resumedSpy).toHaveBeenCalledWith({ rootSessionId: "root-sess-connect", recordId: "rec-original" });
      await resumed.cleanup();
    });

    it("[Option C] wire ctx.sessionDir = getSubagentSessionDir(env 同源推导)；ctx 显式注入优先", async () => {
      // [session-store-layout-inversion] 推导输入 = 贯穿 env PI_SUBAGENT_ROOT_SESSION_ID
      //（分区键 rootSessionId，agentDir/cwd 编码段退役）；beforeEach 已注入缺省 sid
      // 与 dataDir——本用例覆盖为用例专属值，期望值经同一单源公式推导。
      vi.stubEnv("PI_SUBAGENT_ROOT_SESSION_ID", "sid-w2-derive");
      try {
        // 正向：env 同源推导值上 wire（宿主单一权威 getSubagentSessionDir，引擎不自推导）
        const derived = makeEngine();
        const { ctx, events } = makeCtx();
        await derived.engine.run({ prompt: "p" }, ctx);
        expect(extractRunParams(events).ctx.sessionDir).toBe(
          getSubagentSessionDir("sid-w2-derive", dataDir),
        );

        // 宿主编排层显式注入（ctx.sessionDir）优先于 env 推导
        const injected = makeEngine();
        const { ctx: ctxInj, events: eventsInj } = makeCtx({ sessionDir: "/explicit/session-dir" });
        await injected.engine.run({ prompt: "p" }, ctxInj);
        expect(extractRunParams(eventsInj).ctx.sessionDir).toBe("/explicit/session-dir");

        await derived.cleanup();
        await injected.cleanup();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("[D2] HostServices.extensionPaths 端口 → wire ctx.extensionPaths 逐字保真；端口缺席 → 无该键；空数组显式上 wire", async () => {
      // 正向：宿主端口在场（pi 壳双形态注入源）→ wire ctx 逐字保真（pi 引擎侧逐项
      // 拼 --extension）
      configureCore({
        dataRoot: () => dataDir,
        log: () => {},
        extensionPaths: () => ["/staged/@zhushanwen/pi-structured-output"],
      });
      const withPaths = makeEngine();
      const { ctx: ctxP, events: eventsP } = makeCtx();
      await withPaths.engine.run({ prompt: "p" }, ctxP);
      expect(extractRunParams(eventsP).ctx.extensionPaths).toEqual([
        "/staged/@zhushanwen/pi-structured-output",
      ]);
      await withPaths.cleanup();

      // 空数组 = 显式「无扩展」声明——上 wire（区别于端口缺席的键不存在）
      configureCore({
        dataRoot: () => dataDir,
        log: () => {},
        extensionPaths: () => [],
      });
      const emptyPaths = makeEngine();
      const { ctx: ctxE, events: eventsE } = makeCtx();
      await emptyPaths.engine.run({ prompt: "p" }, ctxE);
      expect(extractRunParams(eventsE).ctx.extensionPaths).toEqual([]);
      await emptyPaths.cleanup();

      // 负向：端口缺席（宿主未实现 / 未 configureCore）→ wire ctx 不出现该键
      resetCoreForTests();
      const bare = makeEngine();
      const { ctx: ctxB, events: eventsB } = makeCtx();
      await bare.engine.run({ prompt: "p" }, ctxB);
      expect(extractRunParams(eventsB).ctx).not.toHaveProperty("extensionPaths");
      await bare.cleanup();
    });

    it("handleReady → RunContext 回调（运行中句柄回填；[池抽象降级] poolResolved 通道已退役）", async () => {
      const readies: Array<{ sessionRef: Record<string, string> }> = [];
      const { engine, cleanup } = makeEngine(undefined, {
        args: [
          FAKE_ENGINE,
          "--run-actions",
          JSON.stringify([
            { op: "handleReady", sessionRef: { sessionId: "s-9" } },
          ]),
        ],
      });
      const { ctx } = makeCtx({
        onHandleReady: (partial) => readies.push(partial),
      });
      const result = await engine.run({ prompt: "p" }, ctx);
      expect(readies).toEqual([{ sessionRef: { sessionId: "s-9" } }]);
      // run 终态 handle 来自引擎应答（非 handleReady 的 partial——那是运行中回填通道）
      expect(result.handle.data.sessionRef).toEqual({ sessionId: "fake-session-run-1" });
      await cleanup();
    });
  });

  describe("abort 分级（cancel 帧 + 收敛兜底窗）", () => {
    it("signal abort → cancel；引擎主动收敛（终态应答在兜底窗内）→ 引擎侧 abort 终态正常返回（窗满兜底不触发）", async () => {
      const controller = new AbortController();
      const { engine, client, cleanup } = makeEngine(undefined, {
        // run 受理后 delay 挂起（不与 --run-hang 组合——run-hang 丢弃 run 帧致
        // activeRun 恒 null，cancel-settle 永不生效，用例会退化为兜底窗路径）；
        // cancel 到达 → cancel-settle 同步回 abort 终态（引擎侧收敛，兜底窗不触发）。
        args: [
          FAKE_ENGINE,
          "--cancel-settle", "1",
          "--run-actions", JSON.stringify([{ op: "delay", ms: 60_000 }]),
        ],
      });
      const { ctx } = makeCtx({ signal: controller.signal });
      const runPromise = engine.run({ prompt: "p" }, ctx);
      // 先等连接就绪再 abort：本用例验证「run 受理后 cancel 收敛」，不是「连接期
      // abort」。高负载下本地引擎 spawn + 握手可超 100ms，墙钟定时会把 cancel 抢在
      // run 帧之前（fake engine 对无 activeRun 的 cancel 是 no-op → run 照常 60s
      // 延迟 → 用例 15s 超时；HEAD 源码在同等负载下同样复现，属既存测试竞态）。
      await waitForReady(client);
      controller.abort();
      const result = await runPromise;
      expect(result.outcome.error).toContain("engine_run_failed: aborted (fake)");
      expect(result.outcome.exitCode).toBeNull(); // 被信号杀死判据
      expect(result.handle.data.engineId).toBe("fake");
      await cleanup();
    }, 15_000);

    it("[S1 P1] cancel 收敛兜底窗常量 = 30s（pi 停轮收敛实测 15s 的 2× 量级——量级校准回归锚）", () => {
      // 历史误校准：SDK CANCEL_SETTLE_GRACE_MS(3s) 是控制范围单请求量级，被误用为
      // 任务级停轮收敛窗 → 常驻引擎在 pi 正常收敛途中被按进程组终止（S1 主路径 8/8 失败）。
      // 本断言锚定兜底窗按被保护对象粒度（任务级）校准，防止再被「优化」回秒级。
      expect(CANCEL_SETTLE_GRACE_WINDOW_MS).toBe(30_000);
    });

    it("[D1] cancel 未收敛（注入短兜底窗）→ 本地合成 abort 终态（不 reject）；per-window 引擎宿主不动（进程回收归窗口收尾 dispose 链）", async () => {
      const controller = new AbortController();
      const { engine, client, cleanup } = makeEngine(
        undefined,
        { args: [FAKE_ENGINE, "--run-hang", "1"] }, // 不收敛（FAKE_CANCEL_SETTLE 缺省 0）
        { cancelSettleGraceMs: 100 },
      );
      const { ctx } = makeCtx({ signal: controller.signal });
      const runPromise = engine.run({ prompt: "p" }, ctx);
      await waitForReady(client); // abort 抢在连接完成前会打断握手重建循环——先等 ready
      const enginePid = client.enginePid!;
      controller.abort();
      const result = await runPromise; // 注入 100ms 兜底窗超时 → 本地合成终态（record 必须收尾）
      expect(result.outcome.error).toContain("engine_run_failed");
      expect(result.outcome.error).toContain("aborted before terminal answer");
      expect(result.outcome.exitCode).toBeNull();
      // [D1] 定点杀链已退役：窗满只合成终态，宿主进程不动——薄壳回收由窗口收尾
      // dispose（dispose 请求 → 按进程组终止兜底）确定性承接。
      expect(client.currentState).toBe("ready");
      expect(probePidAliveness(enginePid)).toBe(true);
      await cleanup();
    }, 20_000);

    it("[D1 shared-service 分支语义保形] zcode 形态（processModel shared-service）cancel 未收敛 → 合成终态 + stall 出声不杀（引擎宿主存活）", async () => {
      const controller = new AbortController();
      const { engine, client, cleanup } = makeEngine(
        { processModel: "shared-service" },
        { args: [FAKE_ENGINE, "--run-hang", "1"] }, // 不收敛
        { cancelSettleGraceMs: 100 },
      );
      const { ctx } = makeCtx({ signal: controller.signal });
      const runPromise = engine.run({ prompt: "p" }, ctx);
      await waitForReady(client);
      const enginePid = client.enginePid!;
      // spy 目标 = core logger（remote-engine.ts 的留痕载体），非 SDK logger。
      const warnSpy = vi.spyOn(coreGetLogger("remote-engine"), "warn");
      controller.abort();
      const result = await runPromise; // 注入 100ms 兜底窗超时 → 本地合成终态
      expect(result.outcome.error).toContain("aborted before terminal answer");
      // [D1] shared-service 降级出口：不杀任何进程、不触发 dispose（dispose 对其是
      // 宿主停机/退役语义）——无进展 warn 出声（ADR-0047 静默 ≠ 卡死）。
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("stalled, not stopped"));
      warnSpy.mockRestore();
      expect(client.currentState).toBe("ready");
      expect(probePidAliveness(enginePid)).toBe(true);
      await cleanup();
    }, 20_000);
  });

  describe("失败分界（运行中合成 vs prepare 期 reject）", () => {
    it("运行中引擎崩溃 → 合成 error outcome（engine_crashed）+ 正常 handle（record 必须收尾）", async () => {
      const { engine, cleanup } = makeEngine(undefined, {
        args: [
          FAKE_ENGINE,
          "--run-actions",
          JSON.stringify([{ op: "exit", code: 137, stderr: "boom\n" }]),
        ],
      });
      const { ctx } = makeCtx();
      const result = await engine.run({ prompt: "p" }, ctx);
      expect(result.outcome.error).toContain("engine_crashed");
      expect(result.outcome.error).toContain("boom");
      expect(result.outcome.exitCode).toBeNull();
      expect(result.handle.data.v).toBe(1);
      await cleanup();
    });

    it("prepare 期失败（版本协商越界）→ reject，不产生 handle（进程创建前失败）", async () => {
      const { engine, cleanup } = makeEngine(undefined, {
        args: [FAKE_ENGINE, "--protocol-version", "99"],
      });
      const { ctx } = makeCtx();
      await expect(engine.run({ prompt: "p" }, ctx)).rejects.toMatchObject({
        code: "engine_protocol_mismatch",
      });
      await cleanup();
    }, 20_000);
  });

  /**
   * [m-core-2] 最小 EngineClient 替身：run 期错误注入（只实现 RemoteEngine.run 触达的
   * 成员；真实引擎/控制通道不在本用例范围）。
   */
  function makeStubClient(injected: {
    connectError?: EngineSdkError;
    requestError?: EngineSdkError;
  }): EngineClient {
    const stub = {
      ensureConnected: async (): Promise<void> => {
        if (injected.connectError !== undefined) throw injected.connectError;
      },
      getInitializeDiagnostics: () => undefined,
      registerRunRoute: () => () => {},
      request: async (): Promise<unknown> => {
        if (injected.requestError !== undefined) throw injected.requestError;
        throw new Error("stub: no request result configured");
      },
      getPartialHandle: () => undefined,
      cancelRun: async (): Promise<void> => {},
      dispose: async (): Promise<void> => {},
    };
    return stub as unknown as EngineClient;
  }

  function makeStubEngine(client: EngineClient): RemoteEngine {
    return new RemoteEngine({
      engineId: "stub-engine",
      client,
      dataDir,
      hostKind: "test",
      manifest: { capabilities: { ...FAKE_MATCHED_CAPS } },
    });
  }

  describe("[m-core-2] run 期 transport 失败码：合成 error outcome（不 reject）", () => {
    const RUN_PHASE_CODES = [
      "engine_transport_lost",
      "engine_frame_too_large",
      "engine_backpressure_overflow",
      "unknown_channel",
    ] as const;

    for (const code of RUN_PHASE_CODES) {
      it(`${code} → 正常返回 error outcome + 正常 handle`, async () => {
        const engine = makeStubEngine(makeStubClient({
          requestError: new EngineSdkError(code, `injected ${code}`, "inspect the transport"),
        }));
        const { ctx } = makeCtx();
        const result = await engine.run({ prompt: "p" }, ctx);
        expect(result.outcome.error).toContain(code);
        expect(result.outcome.exitCode).toBeNull();
        expect(result.handle.data.v).toBe(1);
      });
    }

    it("同码在 prepare 期（ensureConnected 抛）→ 仍 reject，不产生 handle", async () => {
      const engine = makeStubEngine(makeStubClient({
        connectError: new EngineSdkError("engine_transport_lost", "connection lost before run", "reconnect"),
      }));
      const { ctx } = makeCtx();
      await expect(engine.run({ prompt: "p" }, ctx)).rejects.toMatchObject({
        code: "engine_transport_lost",
      });
    });
  });

  describe("gate 位多声明 run 期判定（W3 契约⑤接线：manifest vs initialize 应答）", () => {
    it("多声明（manifest maxTurns true vs 引擎应答 false）→ run reject engine_capability_mismatch，run 帧未发出（无事件回显）", async () => {
      const { engine, cleanup } = makeEngine({
        capabilities: { ...FAKE_MATCHED_CAPS, maxTurns: true },
      });
      const { ctx, events } = makeCtx();
      await expect(engine.run({ prompt: "p" }, ctx)).rejects.toMatchObject({
        code: "engine_capability_mismatch",
      });
      expect(events).toHaveLength(0); // gate 拒在 run 帧发出前——引擎未收到 run
      await cleanup();
    });

    it("多声明（manifest sandbox emulated vs 引擎实态 none）→ 拒，错误消息含方向证据（manifest 声明 vs initialize 应答）", async () => {
      const { engine, cleanup } = makeEngine(undefined, {
        args: [FAKE_ENGINE, "--caps-override", JSON.stringify({ sandbox: "none" })],
      });
      const { ctx } = makeCtx();
      await expect(engine.run({ prompt: "p" }, ctx)).rejects.toThrowError(
        /manifest 声明的能力位 'sandbox（worktree）'（emulated）与引擎 initialize 应答不符（none）/,
      );
      await cleanup();
    });

    it("一致放行：manifest 与应答逐位一致 → run 正常完成（现有 run 帧映射用例同走此路径的显式锚点）", async () => {
      const { engine, cleanup } = makeEngine();
      const { ctx } = makeCtx();
      const result = await engine.run({ prompt: "p" }, ctx);
      expect(result.outcome.content).toBe("fake-content-run-1");
      await cleanup();
    });

    it("非 gate 位不一致（personaInjection manifest 'flag' vs 应答 'prompt'）→ 不阻断：run 完成 + 诊断范围仅 warn 留痕", async () => {
      const manifestCaps = { ...FAKE_MATCHED_CAPS, personaInjection: "flag" as const };
      const { engine, cleanup } = makeEngine(
        { capabilities: manifestCaps },
        { manifestDiagnostics: { capabilities: manifestCaps } },
      );
      const warnSpy = vi.spyOn(getLogger("subagents"), "warn");
      const { ctx } = makeCtx();
      const result = await engine.run({ prompt: "p" }, ctx);
      expect(result.outcome.content).toBe("fake-content-run-1"); // 放行
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("differ from manifest"));
      warnSpy.mockRestore();
      await cleanup();
    });
  });

  describe("read / probe / dispose 门面（[H1 U6] interact 断言随 interact 面退役删除）", () => {
    it("read 协议帧携带 dataDir（必填：存量池时代相对 dbPath 定位）", async () => {
      const { engine, cleanup } = makeEngine();
      const view = await engine.read({
        data: {
          v: 1,
          engineId: "fake",
          sessionRef: { sessionId: "s-read" },
          adapterVersion: "fake-adapter",
        },
      });
      expect(view.engineId).toBe("fake");
      expect(view.source).toBe("native");
      expect(view.turns).toHaveLength(1);
      await cleanup();
    });

    it("probe → ProbeReport；dispose → client 停机（幂等）", async () => {
      const { engine, cleanup } = makeEngine();
      const report = await engine.probe();
      expect(report.ok).toBe(true);
      expect(report.engineVersion).toBe("fake-1.0.0");
      await engine.dispose();
      await expect(engine.dispose()).resolves.toBeUndefined(); // 幂等
      await cleanup();
    });

    it("host/askUser 经 RemoteEngine 门面（应答端经 host-ui-endpoint 槽注入）：请求形状 = UiRequest", async () => {
      const seenRequests: UiRequest[] = [];
      const { engine, cleanup } = makeEngine(undefined, {
        args: [
          FAKE_ENGINE,
          "--run-actions",
          JSON.stringify([{ op: "askUser", request: { method: "confirm", id: "q-facade" } }]),
        ],
      });
      // [D3] 构造后经槽登记（reverse-router 消费时现读，构造期不固化值的情形）
      setHostUiRequestEndpoint(async (req) => {
        seenRequests.push(req);
        return { confirmed: true };
      });
      const { ctx, events } = makeCtx();
      await engine.run({ prompt: "p" }, ctx);
      expect(seenRequests).toEqual([{ method: "confirm", id: "q-facade" }]);
      const echo = events.find(
        (e) => typeof (e as { message?: string }).message === "string"
          && (e as { message: string }).message.startsWith("askUser-result:"),
      ) as { message: string };
      expect(echo.message).toContain('"confirmed":true');
      await cleanup();
    });
  });

  // ── [D3 协议版 P6] armed 回执等待门（宿主独立信号源；引擎侧自查断言之外的第二道
  //    防线——监控信号不与施控同源）。fake 引擎经 argv 通道驱动：--caps-override 模拟
  //    native 应答（schemaEnforcement 非 gate 位，不触发 gate 拒），--run-actions 播放
  //    armed / delay 动作。等待窗经 env 调短（量级常量锚定用例持有缺省值）。

  const ARMED_EVENT = {
    type: "armed",
    schemaEnvVar: "PI_WORKFLOW_SCHEMA",
    extensionPkg: "@zhushanwen/pi-structured-output",
  } as const;

  function makeNativeEngineActions(
    manifestCaps: Partial<RemoteEngineManifestSnapshot["capabilities"]> = {},
    runActions: ReadonlyArray<Record<string, unknown>>,
    engineOverrides: Partial<ConstructorParameters<typeof RemoteEngine>[0]> = {},
  ) {
    return makeEngine(
      { capabilities: { ...FAKE_MATCHED_CAPS, schemaEnforcement: "native", ...manifestCaps } },
      {
        args: [
          FAKE_ENGINE,
          "--caps-override",
          JSON.stringify({ schemaEnforcement: "native" }),
          "--run-actions",
          JSON.stringify(runActions),
        ],
      },
      engineOverrides,
    );
  }

  describe("armed 回执等待门（[D3 协议版 P6]）", () => {
    it("常量锚：等待窗缺省 10s + env 通道名（量级按启动期回执校准，env 供测试/排障覆盖）", () => {
      expect(ARMED_RECEIPT_TIMEOUT_MS).toBe(10_000);
      expect(ARMED_RECEIPT_TIMEOUT_ENV).toBe("TAIJI_SUBAGENT_ARMED_RECEIPT_TIMEOUT_MS");
    });

    it("native + schema 任务：窗内收到 armed → run 正常收敛，armed 事件照常转发 ctx.onEvent", async () => {
      process.env[ARMED_RECEIPT_TIMEOUT_ENV] = "8000";
      const { engine, cleanup } = makeNativeEngineActions(undefined, [
        { op: "emit", event: ARMED_EVENT },
      ]);
      const { ctx, events } = makeCtx();
      try {
        const result = await engine.run({ prompt: "p", schema: { type: "object" } }, ctx);
        expect(result.outcome.error).toBeUndefined();
        expect(result.outcome.content).toBe("fake-content-run-1");
        expect(events.some((e) => (e as { type?: string }).type === "armed")).toBe(true);
      } finally {
        delete process.env[ARMED_RECEIPT_TIMEOUT_ENV];
        await cleanup();
      }
    }, 20_000);

    it("native + schema 任务：窗满无回执 → 合成失败 outcome fail-fast（不 reject），错误含双形态恢复指引 + 旧引擎支", async () => {
      // 等待窗（80ms）< 引擎 run 应答时延（1s delay）：fail-fast 返回发生在 run 应答
      // 之前 = 「秒级失败」时序的直接证明（G1：断链 run 不得烧完整时长）。
      process.env[ARMED_RECEIPT_TIMEOUT_ENV] = "80";
      const { engine, cleanup } = makeNativeEngineActions(undefined, [
        { op: "delay", ms: 1000 },
      ]);
      const { ctx } = makeCtx();
      try {
        const startedAt = Date.now();
        const result = await engine.run({ prompt: "p", schema: { type: "object" } }, ctx);
        expect(Date.now() - startedAt).toBeLessThan(4000); // 远小于 5s 应答时延
        const error = result.outcome.error ?? "";
        expect(error).toContain("[schema-arming]");
        expect(error).toContain("armed receipt");
        // 双形态恢复指引（对齐 H3 文案语义）+ 协议版新增的旧引擎支
        expect(error).toContain("extension-service");
        expect(error).toContain("install @zhushanwen/pi-structured-output (peerDependency)");
        expect(error).toContain("schema-less workflow");
        expect(error).toContain("engine package too old");
        // cancel 帧已发（合成失败不等于引擎自停）+ exitCode null = cancel/回收终态族
        expect(result.outcome.exitCode).toBeNull();
        expect(result.handle.data.v).toBe(1);
      } finally {
        delete process.env[ARMED_RECEIPT_TIMEOUT_ENV];
        await cleanup();
      }
    }, 20_000);

    it("emulated 引擎豁免：schema 任务、窗满无回执也不 fail-fast（run 照常收敛）", async () => {
      // 缺省 manifest/应答 = emulated；run 应答时延（300ms）> 等待窗（80ms）——若门
      // 未豁免必合成失败，本用例断言成功即豁免的构造性证明。
      process.env[ARMED_RECEIPT_TIMEOUT_ENV] = "80";
      const { engine, cleanup } = makeEngine(undefined, {
        args: [FAKE_ENGINE, "--run-actions", JSON.stringify([{ op: "delay", ms: 300 }])],
      });
      const { ctx } = makeCtx();
      try {
        const result = await engine.run({ prompt: "p", schema: { type: "object" } }, ctx);
        expect(result.outcome.error).toBeUndefined();
        expect(result.outcome.content).toBe("fake-content-run-1");
      } finally {
        delete process.env[ARMED_RECEIPT_TIMEOUT_ENV];
        await cleanup();
      }
    }, 20_000);

    it("native + 无 schema 任务豁免：不建门，无回执不 fail-fast（H1 判据 = task.schema 声明形态）", async () => {
      process.env[ARMED_RECEIPT_TIMEOUT_ENV] = "80";
      const { engine, cleanup } = makeNativeEngineActions(undefined, [
        { op: "delay", ms: 300 },
      ]);
      const { ctx } = makeCtx();
      try {
        const result = await engine.run({ prompt: "p" }, ctx);
        expect(result.outcome.error).toBeUndefined();
        expect(result.outcome.content).toBe("fake-content-run-1");
      } finally {
        delete process.env[ARMED_RECEIPT_TIMEOUT_ENV];
        await cleanup();
      }
    }, 20_000);

    // ── [加固→D3 改造] armed 超时 fail-fast 路径的兜底窗 ──
    // 该路径不经过 wireAbortSignal 的 onAbort（无外部 abort signal），cancel 受理失败 /
    // 引擎不收敛两种形态的第二道回收 = 合成回调内武装的兜底 timer（grace 同源
    // cancelSettleGraceMs）到点处置：per-window 引擎对本实例 dispose（薄壳整体回收 =
    // 孙进程同进程组连带收割）；shared-service 引擎 stall 出声不回收（D3 裁决行）。

    it("[D3] armed 窗满 fail-fast + cancel 受理失败 → error 留痕 + 兜底窗武装（grace 到点 per-window 实例 dispose，引擎进程消亡）", async () => {
      process.env[ARMED_RECEIPT_TIMEOUT_ENV] = "80";
      const { engine, client, cleanup } = makeNativeEngineActions(undefined, [
        { op: "delay", ms: 1000 },
      ], { cancelSettleGraceMs: 60 });
      const { ctx } = makeCtx();
      const coreLogger = coreGetLogger("remote-engine");
      const errorSpy = vi.spyOn(coreLogger, "error");
      const cancelSpy = vi.spyOn(client, "cancelRun").mockRejectedValue(new Error("cancel channel wedged"));
      const enginePidReady = waitForReady(client);
      try {
        const runPromise = engine.run({ prompt: "p", schema: { type: "object" } }, ctx);
        await enginePidReady;
        const enginePid = client.enginePid!;
        const result = await runPromise;
        expect(result.outcome.error).toContain("armed receipt"); // fail-fast 合成（既有语义不变）
        // ① cancel 受理失败出声（原空 catch 吞信号）
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("armed receipt timeout cancel failed"));
        // ② 兜底 timer 武装并在 grace（300ms）到点触发：per-window 引擎 → 本实例
        //    dispose（dispose 请求 → 按进程组终止兜底），引擎进程消亡（薄壳整体回收）。
        await waitForTrue(() => probePidAliveness(enginePid) === false);
        await waitForTrue(() => client.currentState === "disposed");
      } finally {
        delete process.env[ARMED_RECEIPT_TIMEOUT_ENV];
        errorSpy.mockRestore();
        cancelSpy.mockRestore();
        await cleanup();
      }
    }, 20_000);

    it("[D3] armed 窗满 fail-fast + 引擎不收敛 → 兜底到点 per-window 实例 dispose（孙进程同进程组连带收割）", async () => {
      process.env[ARMED_RECEIPT_TIMEOUT_ENV] = "80";
      // run 受理后 spawn 孙进程（armed 永不到达——actions 无 emit）再长 delay 不应答：
      // armed 合成 + cancel 帧（受理成功但 CANCEL_SETTLES 缺省 0 不收敛）后孙进程仍活着，
      // 唯一回收者 = 武装的兜底 timer（grace 100ms）→ dispose 请求 → 按进程组终止兜底
      //（薄壳死 = 孙进程同组连带收割，P3）。
      const { engine, client, cleanup } = makeNativeEngineActions(undefined, [
        { op: "spawnGrandchild", recordId: "@runId" },
        { op: "delay", ms: 1500 },
      ], { cancelSettleGraceMs: 100 });
      const { ctx } = makeCtx();
      try {
        const runPromise = engine.run({ prompt: "p", schema: { type: "object" } }, ctx);
        // 孙进程上报镜像（childSpawned 反向通道写入 journal 记录 = 回收目标的确定性同步点）
        await waitForTrue(() => client.mirror.snapshot().some((e) => e.recordId === "run-1" && e.state === "running"));
        const child = client.mirror.snapshot().find((e) => e.recordId === "run-1");
        expect(child).toBeDefined();
        const result = await runPromise;
        expect(result.outcome.error).toContain("armed receipt"); // fail-fast 先于引擎应答（delay 1.5s）
        // 兜底窗到点 → 实例 dispose → 薄壳与孙进程一并消亡（进程组连带）
        await waitForTrue(() => probePidAliveness(child!.pid) === false);
        await waitForTrue(() => client.currentState === "disposed");
      } finally {
        delete process.env[ARMED_RECEIPT_TIMEOUT_ENV];
        await cleanup();
      }
    }, 20_000);

    it("[D3] armed 窗满 fail-fast + shared-service 引擎 → 兜底到点 stall 出声不回收（引擎宿主存活）", async () => {
      process.env[ARMED_RECEIPT_TIMEOUT_ENV] = "80";
      const { engine, client, cleanup } = makeEngine(
        { capabilities: { ...FAKE_MATCHED_CAPS, schemaEnforcement: "native" }, processModel: "shared-service" },
        {
          args: [
            FAKE_ENGINE,
            "--caps-override",
            JSON.stringify({ schemaEnforcement: "native" }),
            "--run-actions",
            JSON.stringify([{ op: "delay", ms: 1000 }]),
          ],
        },
        { cancelSettleGraceMs: 60 },
      );
      const { ctx } = makeCtx();
      const coreLogger = coreGetLogger("remote-engine");
      const warnSpy = vi.spyOn(coreLogger, "warn");
      // cancel 受理失败（mock）：阻断 cancel 帧到达引擎——否则引擎侧收敛使 runRequest
      // settle，兜底 timer 按「引擎侧已终态，回收失去标的」撤除（撤除点语义），stall
      // 分支不再可达；本用例锁的是受理失败形态下的 shared-service 降级出口。
      const cancelSpy = vi.spyOn(client, "cancelRun").mockRejectedValue(new Error("cancel channel wedged"));
      const errorSpyRef = vi.spyOn(coreLogger, "error");
      try {
        // run 先发起（ensureConnected 的触发点），waitForReady 并行轮询——
        // ready 前置等待无连接触发者会恒超时（用例 1 同款并行形态）。
        const runPromise = engine.run({ prompt: "p", schema: { type: "object" } }, ctx);
        await waitForReady(client);
        const enginePid = client.enginePid!;
        const result = await runPromise;
        expect(result.outcome.error).toContain("armed receipt");
        // 兜底 timer（grace 60ms）到点 → shared-service 分支 stall 出声（不回收）
        await waitForTrue(() => warnSpy.mock.calls.some((c) => String(c[0]).includes("armed receipt timeout fallback")));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("stalled, not stopped"));
        // shared-service 不触发 dispose（G4：误触发破坏 app-server 单例常驻）
        expect(client.currentState).toBe("ready");
        expect(probePidAliveness(enginePid)).toBe(true);
      } finally {
        delete process.env[ARMED_RECEIPT_TIMEOUT_ENV];
        warnSpy.mockRestore();
        cancelSpy.mockRestore();
        await cleanup();
      }
    }, 20_000);
  });
});

// ── 来源区块：transport-runtime.test.ts ────────────────────────────────────────────────
describe("transport-runtime", () => {
  const K = SUBAGENT_CONTROL_FRAME_KINDS;

  /** 轮询等待谓词成立（真实 socket/子进程时序有毫秒级延迟）。 */
  async function waitForSocket(predicate: () => boolean, what = "condition", timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`waitFor: ${what} not met within ${timeoutMs}ms`);
  }

  type FakeFrame = Record<string, unknown>;

  /**
   * 假 control server（unix socket，单行 JSON；帧词表/版本 = SDK 单源）。
   * 缺省行为：hello → hello_ok；engine_open → engine_opened（channelId ch-N）；engine_close
   * → engine_closed（engine_exit）；engine_frame → onEngineFrame 钩子（协议应答）。
   */
  class FakeControlServer {
    readonly frames: FakeFrame[] = [];
    /** engine_open 被连接级根绑定拒绝的记录（R2A-N1 回归面）。 */
    readonly openFailures: Array<{ code: unknown; launch: unknown }> = [];
    readonly dir: string;
    readonly socketPath: string;
    holdHello = false;
    holdOpen = false;
    rejectHelloVersion = false;
    autoCloseOnEngineClose = true;
    onEngineOpen: ((socket: net.Socket, frame: FakeFrame) => void) | undefined;
    onEngineFrame: ((socket: net.Socket, frame: FakeFrame) => void) | undefined;
    private readonly server: net.Server;
    private readonly conns = new Set<net.Socket>();
    private readonly buffers = new Map<net.Socket, string>();
    /** 连接级根绑定（模拟 runtime 的首 open 定根语义；无重置点）。 */
    private readonly connRoots = new Map<net.Socket, unknown>();
    private channelSeq = 0;

    private constructor(dir: string, socketPath: string) {
      this.dir = dir;
      this.socketPath = socketPath;
      this.server = net.createServer((socket) => this.handleConnection(socket));
    }

    static async start(): Promise<FakeControlServer> {
      const dir = mkdtempSync(join(tmpdir(), "u-m3-rt-"));
      const self = new FakeControlServer(dir, join(dir, "c.sock"));
      await new Promise<void>((resolve, reject) => {
        self.server.once("error", reject);
        self.server.listen(self.socketPath, () => {
          self.server.removeListener("error", reject);
          resolve();
        });
      });
      return self;
    }

    get connectionCount(): number {
      return this.conns.size;
    }

    /** 当前活连接的绑定根（R2A-N1：一条连接只应有一个根）。 */
    get activeConnectionRoots(): unknown[] {
      return [...this.connRoots.values()];
    }

    sendControl(socket: net.Socket, frame: FakeFrame): void {
      try {
        socket.write(`${JSON.stringify(frame)}\n`);
      } catch {
        // 对端已死：测试断言侧自行超时
      }
    }

    sendToAll(frame: FakeFrame): void {
      for (const socket of this.conns) this.sendControl(socket, frame);
    }

    /**
     * 逐段写原始字节到活连接（跨 chunk UTF-8 边界测试）：段间留 gap，保证客户端侧
     * 按两次 data 事件收到（段内可落在多字节字符中间）。
     */
    async sendRawChunks(chunks: Buffer[], gapMs = 30): Promise<void> {
      for (const socket of this.conns) {
        for (const chunk of chunks) {
          await new Promise<void>((resolve) => socket.write(chunk, () => resolve()));
          if (gapMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
        }
      }
    }

    sendEngineFrame(channelId: string, line: string): void {
      this.sendToAll({ v: SUBAGENT_CONTROL_PROTOCOL_VERSION, kind: K.engineFrame, channelId, line });
    }

    sendEngineClosed(channelId: string, info: Partial<{ code: number | null; signal: string | null; reason: string; stderrTail: string }> = {}): void {
      this.sendToAll({
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: K.engineClosed,
        channelId,
        code: info.code === undefined ? 0 : info.code,
        signal: info.signal === undefined ? null : info.signal,
        reason: info.reason ?? "engine_exit",
        ...(info.stderrTail !== undefined ? { stderrTail: info.stderrTail } : {}),
      });
    }

    sendError(channelId: string | undefined, code: string, message = code): void {
      this.sendToAll({
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: K.error,
        ...(channelId !== undefined ? { channelId } : {}),
        code,
        message,
        recovery: "test recovery",
      });
    }

    pauseConnections(): void {
      for (const socket of this.conns) socket.pause();
    }

    resumeConnections(): void {
      for (const socket of this.conns) socket.resume();
    }

    destroyConnections(): void {
      for (const socket of [...this.conns]) socket.destroy();
    }

    async close(): Promise<void> {
      this.destroyConnections();
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }

    private handleConnection(socket: net.Socket): void {
      this.conns.add(socket);
      this.buffers.set(socket, "");
      socket.on("data", (chunk: Buffer) => this.handleData(socket, chunk));
      socket.on("error", () => {
        // 测试替身：对端 RST 等预期内
      });
      socket.on("close", () => {
        this.conns.delete(socket);
        this.buffers.delete(socket);
        this.connRoots.delete(socket);
      });
    }

    private handleData(socket: net.Socket, chunk: Buffer): void {
      let buffer = (this.buffers.get(socket) ?? "") + chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof parsed !== "object" || parsed === null) continue;
        const frame = parsed as FakeFrame;
        this.frames.push(frame);
        this.handleFrame(socket, frame);
      }
      this.buffers.set(socket, buffer);
    }

    private handleFrame(socket: net.Socket, frame: FakeFrame): void {
      if (frame.kind === K.hello) {
        if (this.holdHello) return;
        if (this.rejectHelloVersion) {
          this.sendControl(socket, {
            v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
            kind: K.helloReject,
            id: frame.id,
            reason: "version",
            message: "protocol version mismatch",
            recovery: "upgrade",
            supported: [SUBAGENT_CONTROL_PROTOCOL_VERSION],
          });
          return;
        }
        this.sendControl(socket, {
          v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
          kind: K.helloOk,
          id: frame.id,
          runtimePid: process.pid,
          protocolVersion: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        });
        return;
      }
      if (frame.kind === K.engineOpen) {
        if (this.holdOpen) return;
        // 连接级根绑定（runtime control-server 同语义）：首个 open 定根，之后不同根
        // 一律 engine_open_failed{session}（连接根无重置点）——N1 的回归面。
        const launch = frame.launch as Record<string, unknown> | undefined;
        const root = launch?.rootSessionId;
        if (!this.connRoots.has(socket)) {
          this.connRoots.set(socket, root);
        } else if (this.connRoots.get(socket) !== root) {
          this.openFailures.push({ code: "session", launch });
          this.sendControl(socket, {
            v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
            kind: K.engineOpenFailed,
            id: frame.id,
            code: "session",
            message: `root session mismatch: connection bound to ${String(this.connRoots.get(socket))}, open carried ${String(root)}`,
            recovery: "One control connection serves one root session; open a new connection for another session.",
          });
          return;
        }
        if (this.onEngineOpen !== undefined) {
          this.onEngineOpen(socket, frame);
          return;
        }
        const channelId = `ch-${++this.channelSeq}`;
        this.sendControl(socket, {
          v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
          kind: K.engineOpened,
          id: frame.id,
          channelId,
          pid: process.pid,
        });
        return;
      }
      if (frame.kind === K.engineFrame) {
        this.onEngineFrame?.(socket, frame);
        return;
      }
      if (frame.kind === K.engineClose && this.autoCloseOnEngineClose) {
        this.sendEngineClosed(String(frame.channelId));
      }
    }
  }

  const openServers: FakeControlServer[] = [];
  const dataDirs: string[] = [];

  async function startServer(): Promise<FakeControlServer> {
    const server = await FakeControlServer.start();
    openServers.push(server);
    return server;
  }

  afterEach(async () => {
    for (const server of openServers.splice(0)) await server.close();
    for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeTransport(
    server: FakeControlServer,
    overrides: Partial<RuntimeEngineTransportOptions> = {},
  ): RuntimeEngineTransport {
    return new RuntimeEngineTransport({
      engineId: "fake",
      hostKind: "test",
      baseEnv: {
        TAIJI_SUBAGENT_CONTROL_SOCKET: server.socketPath,
        TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "sess-rt-1",
      },
      connectTimeoutMs: 1_000,
      helloTimeoutMs: 1_000,
      openTimeoutMs: 1_000,
      closeGraceMs: 60,
      ...overrides,
    });
  }

  function makeSpec(overrides: Partial<EngineLaunchSpec> = {}): EngineLaunchSpec {
    return {
      engineId: "fake",
      entryPath: process.execPath,
      args: ["--fake"],
      cwd: tmpdir(),
      envPrefixes: [],
      rootSessionId: "",
      ...overrides,
    };
  }

  function collectExits(transport: RuntimeEngineTransport): EngineTransportExitInfo[] {
    const exits: EngineTransportExitInfo[] = [];
    transport.onExit((info) => exits.push(info));
    return exits;
  }

  describe("RuntimeEngineTransport：control 通道全链（验收①）", () => {
    it("hello 关联 + engine_open→engine_opened（launch 归属键）+ 帧双向（engine_frame 信封）", async () => {
      const server = await startServer();
      const transport = makeTransport(server);
      const frames: string[] = [];
      transport.onFrame((line) => frames.push(line));

      const opened = await transport.open(makeSpec());
      expect(opened.pid).toBe(process.pid); // 假 server 回传 runtime pid（协议面 pid 透传）

      const hello = server.frames.find((f) => f.kind === K.hello);
      expect(hello).toMatchObject({
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: K.hello,
        hostPid: process.pid,
        hostKind: "test",
      });
      const open = server.frames.find((f) => f.kind === K.engineOpen);
      const launch = open?.launch as Record<string, unknown>;
      expect(launch).toMatchObject({
        engineId: "fake",
        entryPath: process.execPath,
        cwd: tmpdir(),
        rootSessionId: "sess-rt-1",
      });
      expect(launch.parentRecordId).toBeUndefined(); // 顶层无身份 env → 不携带嵌套键

      // C→R：writeFrame 包 engine_frame 信封（line 原样）
      const request = JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
      expect(transport.writeFrame(request)).toBe(true);
      await waitForSocket(() => server.frames.some((f) => f.kind === K.engineFrame && f.line === request), "engine_frame C→R");

      // R→C：解包 engine_frame.line 交给 onFrame
      server.sendEngineFrame("ch-1", JSON.stringify({ id: 1, result: { protocolVersion: 1 } }));
      await waitForSocket(() => frames.length === 1, "engine_frame R→C");
      expect(JSON.parse(frames[0]!) as unknown).toEqual({ id: 1, result: { protocolVersion: 1 } });

      await transport.close();
    });

    it("多通道同一连接：engine_open 应答乱序仍按 id 关联，帧按 channelId 路由不串", async () => {
      const server = await startServer();
      const replies: Array<{ socket: net.Socket; frame: FakeFrame }> = [];
      server.onEngineOpen = (socket, frame) => {
        replies.push({ socket, frame });
        if (replies.length !== 2) return;
        const [first, second] = replies as [{ socket: net.Socket; frame: FakeFrame }, { socket: net.Socket; frame: FakeFrame }];
        // 先回第二个（ch-b），再回第一个（ch-a）
        server.sendControl(second.socket, { v: 1, kind: K.engineOpened, id: second.frame.id, channelId: "ch-b", pid: 111 });
        server.sendControl(first.socket, { v: 1, kind: K.engineOpened, id: first.frame.id, channelId: "ch-a", pid: 222 });
      };
      const transportA = makeTransport(server);
      const transportB = makeTransport(server);
      const framesA: string[] = [];
      const framesB: string[] = [];
      transportA.onFrame((line) => framesA.push(line));
      transportB.onFrame((line) => framesB.push(line));

      const [openA, openB] = await Promise.all([transportA.open(makeSpec()), transportB.open(makeSpec())]);
      expect(server.connectionCount).toBe(1); // 进程级共享：两个通道一条连接
      expect(openA.pid).toBe(222); // 第一个 open 的应答后到（ch-a）
      expect(openB.pid).toBe(111);

      server.sendEngineFrame("ch-a", "for-a");
      server.sendEngineFrame("ch-b", "for-b");
      await waitForSocket(() => framesA.length === 1 && framesB.length === 1, "per-channel frame routing");
      expect(framesA).toEqual(["for-a"]);
      expect(framesB).toEqual(["for-b"]);

      await transportA.close();
      await transportB.close();
    });

    it("[S-10] openChannel identity.recordId → launch.recordId 上 wire；缺席不落键", async () => {
      const server = await startServer();
      const transport = makeTransport(server);
      await transport.open(makeSpec({ recordId: "rec-123" }));
      const withRecord = server.frames.find((f) => f.kind === K.engineOpen);
      expect((withRecord?.launch as Record<string, unknown>).recordId).toBe("rec-123");
      await transport.close();

      const bare = makeTransport(server);
      await bare.open(makeSpec());
      const opens = server.frames.filter((f) => f.kind === K.engineOpen);
      expect((opens.at(-1)?.launch as Record<string, unknown>).recordId).toBeUndefined();
      expect(Object.hasOwn(opens.at(-1)?.launch as object, "recordId")).toBe(false);
      await bare.close();
    });

    it("[m-core-1] 跨 chunk 的 UTF-8 多字节字符不被撕裂（StringDecoder 按字符边界切分）", async () => {
      const server = await startServer();
      server.onEngineOpen = (socket, frame) => {
        server.sendControl(socket, {
          v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
          kind: K.engineOpened,
          id: frame.id,
          channelId: "ch-utf8",
          pid: process.pid,
        });
      };
      const transport = makeTransport(server);
      const frames: string[] = [];
      transport.onFrame((line) => frames.push(line));
      await transport.open(makeSpec());

      const inboundLine = JSON.stringify({ id: 9, result: { text: "中文内容" } });
      const envelope = `${JSON.stringify({
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: K.engineFrame,
        channelId: "ch-utf8",
        line: inboundLine,
      })}\n`;
      const bytes = Buffer.from(envelope, "utf8");
      const charStart = bytes.indexOf(Buffer.from("中", "utf8"));
      expect(charStart).toBeGreaterThan(0);
      // 3 字节汉字拆到两个 chunk：切点落在字符内部（bytes[charStart..charStart+3)）。
      await server.sendRawChunks([bytes.subarray(0, charStart + 1), bytes.subarray(charStart + 1)], 30);

      await waitForSocket(() => frames.length === 1, "inbound engine frame after split chunks");
      expect(frames[0]).toBe(inboundLine);
      expect(frames[0]).not.toContain("\uFFFD");
      await transport.close();
    });

    it("engine_closed → onExit（code/signal/reason/stderrTail）；stderrTail 经 onStderr 出口", async () => {
      const server = await startServer();
      const stderr: string[] = [];
      const transport = makeTransport(server, { onStderr: (chunk) => stderr.push(chunk) });
      const exits = collectExits(transport);
      await transport.open(makeSpec());

      server.sendEngineClosed("ch-1", {
        code: 3,
        signal: "SIGKILL",
        reason: "killed_by_control",
        stderrTail: "fatal: engine exploded",
      });
      await waitForSocket(() => exits.length === 1, "onExit");
      expect(exits[0]).toEqual({
        code: 3,
        signal: "SIGKILL",
        reason: "killed_by_control",
        stderrTail: "fatal: engine exploded",
      });
      expect(stderr.join("")).toContain("fatal: engine exploded");
      // 通道已终局：再次 close 幂等立即 resolve（不重复发 engine_close）
      await transport.close();
      expect(server.frames.filter((f) => f.kind === K.engineClose)).toHaveLength(0);
    });

    it("engine_close 幂等：并发重复 close 只发一帧，engine_closed 到达后都 resolve", async () => {
      const server = await startServer();
      const transport = makeTransport(server);
      await transport.open(makeSpec());

      const first = transport.close();
      const second = transport.close();
      await Promise.all([first, second]);
      await waitForSocket(() => server.frames.some((f) => f.kind === K.engineClose), "engine_close sent");
      expect(server.frames.filter((f) => f.kind === K.engineClose)).toHaveLength(1);
    });

    it("engine_close 宽限：server 不回 engine_closed → close 在宽限后放弃该通道（不关共享连接）", async () => {
      const server = await startServer();
      server.autoCloseOnEngineClose = false;
      const transport = makeTransport(server, { closeGraceMs: 60 });
      await transport.open(makeSpec());
      const startedAt = Date.now();
      await transport.close();
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
      // 共享连接仍活（通道放弃不影响连接）：第二次 open 复用同一连接成功
      const again = makeTransport(server);
      await again.open(makeSpec());
      expect(server.connectionCount).toBe(1);
      await again.close();
    });
  });

  describe("共享客户端表：globalThis 槽承载（C-state-20 / S-7）", () => {
    const SLOT_KEY = Symbol.for(GLOBAL_SLOT_KEYS.runtimeControlClients);

    it("槽形态下 per-(socket, root) 复用键语义保留 + 表经 Symbol.for 槽可观察（跨模块实例共享）", async () => {
      const server = await startServer();
      const previousSlot = Reflect.get(globalThis, SLOT_KEY) as Map<string, RuntimeControlClient> | undefined;

      const a = acquireRuntimeControlClient({ socketPath: server.socketPath, hostKind: "test", rootSessionId: "sess-slot" });
      const b = acquireRuntimeControlClient({ socketPath: server.socketPath, hostKind: "test", rootSessionId: "sess-slot" });
      expect(b).toBe(a); // 同 (socket, root) 键复用同一实例（一条连接）
      const other = acquireRuntimeControlClient({ socketPath: server.socketPath, hostKind: "test", rootSessionId: "sess-slot-other" });
      expect(other).not.toBe(a); // 不同根不同连接（R2A-N1 复用键语义）

      // 表挂在 globalThis[Symbol.for(键)]（spawned-children.ts 同款槽纪律）：双包实例
      // （workspace 源码 / npm dist / pi jiti）经同一槽看到同一张表，模块级 Map 会分裂。
      const slot = Reflect.get(globalThis, SLOT_KEY) as Map<string, RuntimeControlClient>;
      expect(slot).toBeInstanceOf(Map);
      expect(slot.get(controlClientKey(server.socketPath, "sess-slot"))).toBe(a);

      // 「另一实例化通道」形态：手工换入新 Map，acquire 必须写入槽中现有 Map（读槽
      // 而非闭包模块级变量）——这是跨实例共享语义的构造性验证。
      const manualSlot = new Map<string, RuntimeControlClient>();
      Reflect.set(globalThis, SLOT_KEY, manualSlot);
      try {
        const viaOtherInstance = acquireRuntimeControlClient({
          socketPath: server.socketPath,
          hostKind: "test",
          rootSessionId: "sess-slot-third",
        });
        expect(manualSlot.size).toBe(1);
        expect(manualSlot.get(controlClientKey(server.socketPath, "sess-slot-third"))).toBe(viaOtherInstance);
        viaOtherInstance.release(); // refs 归零 → dispose 自摘
      } finally {
        // 恢复原槽，避免污染后续用例的共享状态
        if (previousSlot !== undefined) Reflect.set(globalThis, SLOT_KEY, previousSlot);
        else Reflect.deleteProperty(globalThis, SLOT_KEY);
      }

      // 引用归零 → dispose → 自摘（槽内不再保留死实例）
      a.release();
      b.release();
      other.release();
      await waitForSocket(() => server.connectionCount === 0, "slot clients released");
      expect(slot.has(controlClientKey(server.socketPath, "sess-slot"))).toBe(false);
    });
  });

  describe("RuntimeControlClient：连接死亡 fan-out（验收①③）", () => {
    it("连接死亡：在册通道 engine_transport_lost + 在途 open 全拒 + 客户端不可用不重试", async () => {
      const server = await startServer();
      const client = new RuntimeControlClient({
        socketPath: server.socketPath,
        hostKind: "test",
        connectTimeoutMs: 1_000,
        helloTimeoutMs: 1_000,
        openTimeoutMs: 1_000,
      });
      const errors: EngineSdkError[] = [];
      const handlers: ControlChannelHandlers = {
        onFrame: () => {},
        onExit: () => {},
        onError: (err) => errors.push(err),
      };
      await client.connect();
      await client.openChannel(makeSpec(), { rootSessionId: "sess-1" }, handlers);
      server.holdOpen = true;
      const pending = client.openChannel(makeSpec(), { rootSessionId: "sess-1" }, handlers);
      await waitForSocket(() => server.frames.filter((f) => f.kind === K.engineOpen).length === 2, "second engine_open");

      server.destroyConnections();
      await expect(pending).rejects.toMatchObject({ code: "engine_transport_lost" });
      await waitForSocket(() => errors.length === 1, "channel error fan-out");
      expect(errors[0]?.code).toBe("engine_transport_lost");
      expect(errors[0]?.recovery).toContain("control connection");
      expect(client.channelCount).toBe(0);
      expect(client.isUsable).toBe(false);
      await expect(client.connect()).rejects.toMatchObject({ code: "engine_transport_unavailable" });
      client.dispose();
    });
  });

  describe("传输错误码面（验收②）", () => {
    it("engine_open_timeout：runtime 迟不回应答 → open 以超时码 reject", async () => {
      const server = await startServer();
      server.holdOpen = true;
      const transport = makeTransport(server, { openTimeoutMs: 50 });
      await expect(transport.open(makeSpec())).rejects.toMatchObject({ code: "engine_open_timeout" });
    });

    it("迟到 engine_opened（本端已超时）→ 丢弃并补发 engine_close（不让 runtime 留下无人认领的通道）", async () => {
      const server = await startServer();
      server.holdOpen = true;
      const client = new RuntimeControlClient({
        socketPath: server.socketPath,
        hostKind: "test",
        connectTimeoutMs: 1_000,
        helloTimeoutMs: 1_000,
        openTimeoutMs: 50,
      });
      await client.connect();
      const handlers: ControlChannelHandlers = { onFrame: () => {}, onExit: () => {}, onError: () => {} };
      await expect(client.openChannel(makeSpec(), { rootSessionId: "sess-1" }, handlers))
        .rejects.toMatchObject({ code: "engine_open_timeout" });
      const openId = server.frames.find((f) => f.kind === K.engineOpen)?.id;
      server.sendToAll({ v: 1, kind: K.engineOpened, id: openId, channelId: "ch-late", pid: process.pid });
      await waitForSocket(
        () => server.frames.some((f) => f.kind === K.engineClose && f.channelId === "ch-late"),
        "late engine_close",
      );
      expect(client.channelCount).toBe(0);
      client.dispose();
    });

    it("engine_open_failed：runtime 拒开（spawn_failed）→ engine_crashed（与 local 启动失败同型）", async () => {
      const server = await startServer();
      server.onEngineOpen = (socket, frame) => {
        server.sendControl(socket, {
          v: 1,
          kind: K.engineOpenFailed,
          id: frame.id,
          code: "spawn_failed",
          message: "engine executor not found",
          recovery: "install the engine",
        });
      };
      const transport = makeTransport(server);
      await expect(transport.open(makeSpec())).rejects.toMatchObject({
        code: "engine_crashed",
        message: expect.stringContaining("spawn_failed"),
        recovery: "install the engine",
      });
    });

    it("D10 错误分型映射：runtime 裁决码按语义分流（逐码锁定）", () => {
      const cases: Array<[string, string]> = [
        ["session", "engine_transport_unavailable"],
        ["channel_limit", "engine_backpressure_overflow"],
        ["invalid_launch", "engine_crashed"],
        ["spawn_failed", "engine_crashed"],
        ["duplicate", "engine_transport_unavailable"],
        // [R2A-N3①] 通道终局（非关闭竞态）不是连接丢失：原 code 透传，不落
        // engine_transport_lost（D10 的 lost 专指 control 连接中途丢失）。
        ["unknown_channel", "unknown_channel"],
        ["engine_open_timeout", "engine_open_timeout"],
        ["engine_frame_too_large", "engine_frame_too_large"],
        ["engine_backpressure_overflow", "engine_backpressure_overflow"],
        // SDK transport 族 / 引擎透传码原样保留（不重复收敛）。
        ["engine_transport_lost", "engine_transport_lost"],
        ["engine_not_found", "engine_not_found"],
      ];
      for (const [controlCode, expected] of cases) {
        const err = mapControlError(controlCode, `detail-${controlCode}`);
        expect(err.code, controlCode).toBe(expected);
        if (expected !== controlCode) {
          expect(err.message, controlCode).toContain(`(control code: ${controlCode}`);
        }
        // [R2A-N3③] runtime 帧裁决的错误都带 controlCode 机器标记（connectOnce 据此
        // 保留启动裁决的专用 recovery）。
        expect(err.data?.controlCode, controlCode).toBe(controlCode);
      }
      // recovery 语义：crash 面有专用兜底（不借用 transport_unavailable 的可达性文案）
      expect(mapControlError("spawn_failed", "boom").recovery).toContain("runtime failed to launch");
      // [R2A-N3①] unknown_channel：透传 code + 通道终局 recovery（连接仍活），不是 lost。
      const unknown = mapControlError("unknown_channel", "unknown channel ch-9");
      expect(unknown.code).not.toBe("engine_transport_lost");
      expect(unknown.message).toContain("unknown channel ch-9");
      expect(unknown.recovery).toContain("control connection itself is still alive");
      // runtime 帧携带的 recovery 优先（排障指引不丢）。
      expect(mapControlError("unknown_channel", "gone", "Open the engine channel again with engine_open.").recovery)
        .toBe("Open the engine channel again with engine_open.");
      // [R2A-N3②] channel_limit 与字节背压区分：同 code 但 detail 显式标明「通道数上限」。
      const channelLimit = mapControlError("channel_limit", "connection channel limit (256) reached");
      expect(channelLimit.code).toBe("engine_backpressure_overflow");
      expect(channelLimit.message).toContain("channel-count limit, not write-queue byte backpressure");
    });

    it("engine_frame_too_large：出站信封超限 → writeFrame false + onTransportError 具体码（不截断）", async () => {
      const server = await startServer();
      const transport = makeTransport(server, { maxFrameBytes: 1_024 });
      const errors: EngineSdkError[] = [];
      transport.onTransportError((err) => errors.push(err));
      await transport.open(makeSpec());

      expect(transport.writeFrame("x".repeat(4_096))).toBe(false);
      expect(errors[0]?.code).toBe("engine_frame_too_large");
      // 过载通道已补发 engine_close（让 runtime 杀组回收）
      await waitForSocket(() => server.frames.some((f) => f.kind === K.engineClose), "engine_close after oversize");
      await transport.close();
    });

    it("engine_backpressure_overflow：socket 背压 + 单通道队列上限 → 具体码且通道终止", async () => {
      const server = await startServer();
      const transport = makeTransport(server, { channelQueueMaxBytes: 1_024 });
      const errors: EngineSdkError[] = [];
      transport.onTransportError((err) => errors.push(err));
      await transport.open(makeSpec());
      server.pauseConnections();

      const payload = "y".repeat(64 * 1024);
      const deadline = Date.now() + 5_000;
      while (errors.length === 0 && Date.now() < deadline) {
        transport.writeFrame(payload);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(errors[0]?.code).toBe("engine_backpressure_overflow");
      expect(transport.writeFrame(payload)).toBe(false);
      await transport.close();
    });

    it("背压队列 drain：连接恢复后积压帧按 FIFO 到达（不丢帧不串序）", async () => {
      const server = await startServer();
      const transport = makeTransport(server);
      await transport.open(makeSpec());
      server.pauseConnections();
      const payload = "z".repeat(64 * 1024);
      const lines = Array.from({ length: 16 }, (_, i) => `queued-${i}-${payload}`);
      for (const line of lines) transport.writeFrame(line);
      server.resumeConnections();
      await waitForSocket(
        () => lines.every((l) => server.frames.some((f) => f.kind === K.engineFrame && f.line === l)),
        "queued frames drained",
      );
      const received = server.frames.filter((f) => f.kind === K.engineFrame).map((f) => String(f.line));
      expect(received).toEqual(lines); // FIFO 且零丢失
      await transport.close();
    });

    it("engine_transport_unavailable：socket 不存在 / hello 超时（connect/hello 失败面，不静默 local）", async () => {
      const server = await startServer();
      const missing = new RuntimeEngineTransport({
        engineId: "fake",
        hostKind: "test",
        baseEnv: {
          TAIJI_SUBAGENT_CONTROL_SOCKET: join(tmpdir(), `u-m3-rt-missing-${process.pid}.sock`),
          TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "sess-rt-1",
        },
        connectTimeoutMs: 500,
      });
      await expect(missing.open(makeSpec())).rejects.toMatchObject({ code: "engine_transport_unavailable" });

      server.holdHello = true;
      const transport = makeTransport(server, { helloTimeoutMs: 60 });
      await expect(transport.open(makeSpec())).rejects.toMatchObject({ code: "engine_transport_unavailable" });
    });

    it("hello_reject version → engine_protocol_mismatch（D9 版本矩阵）", async () => {
      const server = await startServer();
      server.rejectHelloVersion = true;
      const transport = makeTransport(server);
      await expect(transport.open(makeSpec())).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
    });

    it("runtime 裁决 error 帧（channelId）→ 具体码经 onTransportError fan-out", async () => {
      const server = await startServer();
      const transport = makeTransport(server);
      const errors: EngineSdkError[] = [];
      transport.onTransportError((err) => errors.push(err));
      await transport.open(makeSpec());

      server.sendError("ch-1", "engine_backpressure_overflow", "socket queue overflow");
      await waitForSocket(() => errors.length === 1, "channel error frame");
      expect(errors[0]?.code).toBe("engine_backpressure_overflow");
      expect(errors[0]?.message).toContain("socket queue overflow");
      await transport.close();
    });

    it("launch 归属键：spec 优先，其次 control env；嵌套身份 env → parentRecordId/depth；root 缺失显式失败", async () => {
      const server = await startServer();
      const nested = makeTransport(server, {
        baseEnv: {
          TAIJI_SUBAGENT_CONTROL_SOCKET: server.socketPath,
          TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "sess-root-env",
          PI_SUBAGENT_SELF_RECORD_ID: "rec-parent",
          PI_SUBAGENT_DEPTH: "2",
        },
      });
      await nested.open(makeSpec());
      const launch = server.frames.find((f) => f.kind === K.engineOpen)?.launch as Record<string, unknown>;
      expect(launch).toMatchObject({
        rootSessionId: "sess-root-env",
        parentRecordId: "rec-parent",
        depth: 2,
      });
      await nested.close();

      const explicit = makeTransport(server);
      await explicit.open(makeSpec({ rootSessionId: "sess-from-run-ctx" }));
      const explicitLaunch = server.frames.filter((f) => f.kind === K.engineOpen).at(-1)?.launch as Record<string, unknown>;
      expect(explicitLaunch.rootSessionId).toBe("sess-from-run-ctx");
      await explicit.close();

      const noRoot = makeTransport(server, {
        baseEnv: { TAIJI_SUBAGENT_CONTROL_SOCKET: server.socketPath },
      });
      await expect(noRoot.open(makeSpec())).rejects.toMatchObject({ code: "engine_transport_unavailable" });

      // [B-U-1 嵌套优先级] spec（run ctx 真根）> control env（spawn 期 temp id）>
      // 身份 env（PI_SUBAGENT_ROOT_SESSION_ID = 嵌套真根）；spec 有值时不得被 env 遮蔽。
      const nestedExplicit = makeTransport(server, {
        baseEnv: {
          TAIJI_SUBAGENT_CONTROL_SOCKET: server.socketPath,
          TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "sess-spawn-temp",
          PI_SUBAGENT_ROOT_SESSION_ID: "sess-nested-root",
        },
      });
      await nestedExplicit.open(makeSpec({ rootSessionId: "sess-run-ctx" }));
      const nestedLaunch = server.frames.filter((f) => f.kind === K.engineOpen).at(-1)?.launch as Record<string, unknown>;
      expect(nestedLaunch.rootSessionId).toBe("sess-run-ctx");
      await nestedExplicit.close();
    });
  });

  // ── EngineClient 谓词接线（验收③④）─────────────────────────────────────────────

  /** 假 server 的引擎协议应答：initialize/dispose 各回 result（EngineClient 握手用）。 */
  function wireFakeEngineProtocol(server: FakeControlServer): void {
    server.onEngineFrame = (socket, frame) => {
      let parsed: { id?: number; method?: string };
      try {
        parsed = JSON.parse(String(frame.line)) as { id?: number; method?: string };
      } catch {
        return;
      }
      if (parsed.method !== "initialize" && parsed.method !== "dispose") return;
      server.sendControl(socket, {
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: K.engineFrame,
        channelId: frame.channelId,
        line: JSON.stringify({ id: parsed.id, result: { protocolVersion: SUBAGENT_CONTROL_PROTOCOL_VERSION } }),
      });
    };
  }

  function makeHostedClient(
    server: FakeControlServer,
    dataDir: string,
    baseEnv: Record<string, string | undefined> = {},
    engineId = "fake",
  ): EngineClient {
    return new EngineClient({
      engineId,
      command: process.execPath,
      args: ["--never-spawned"],
      hostKind: "test",
      dataDir,
      envPrefixes: [],
      baseEnv: {
        TAIJI_SUBAGENT_CONTROL_SOCKET: server.socketPath,
        TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "sess-rt-1",
        ...baseEnv,
      },
    });
  }

  /**
   * 假引擎协议应答（initialize + 任意正向方法）：R2A-N1/N2 用例需要 run/probe 级请求
   * 兑现（双客户端、并发 ensureConnected 后的实际派发）。
   */
  function wireEchoEngineProtocol(server: FakeControlServer, seenMethods: string[] = []): void {
    server.onEngineFrame = (socket, frame) => {
      let parsed: { id?: number; method?: string };
      try {
        parsed = JSON.parse(String(frame.line)) as { id?: number; method?: string };
      } catch {
        return;
      }
      if (parsed.method === undefined) return;
      seenMethods.push(parsed.method);
      const result = parsed.method === "initialize"
        ? { protocolVersion: SUBAGENT_CONTROL_PROTOCOL_VERSION }
        : { ok: parsed.method };
      server.sendControl(socket, {
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: K.engineFrame,
        channelId: frame.channelId,
        line: JSON.stringify({ id: parsed.id, result }),
      });
    };
  }

  describe("EngineClient：runtime transport 谓词接线（验收③④）", () => {
    it("[B-U-1] run ctx 权威根 → engine_open.rootSessionId（不被 control env 的 spawn 期 temp id 遮蔽）", async () => {
      const server = await startServer();
      wireFakeEngineProtocol(server);
      const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-data-"));
      dataDirs.push(dataDir);
      // control env 模拟 create 路径：ProcessManager 在 spawn 时注入 temp id（pi 自生成
      // sessionId 后 rekey 只改 runtime Map，不更新已 spawn 的 pi env）。
      const client = makeHostedClient(server, dataDir, {
        TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "spawn-temp-id",
      });

      await client.ensureConnected({ rootSessionId: "real-session-id-from-ctx" });
      expect(client.currentState).toBe("ready");
      const open = server.frames.find((f) => f.kind === K.engineOpen);
      expect((open?.launch as Record<string, unknown>).rootSessionId).toBe("real-session-id-from-ctx");
      await client.dispose();
    });

    it("[B-U-1] 探针先以 env 初值建连 → run ctx 真实根触发换代重连（engine_open 携带权威根）", async () => {
      const server = await startServer();
      wireFakeEngineProtocol(server);
      const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-data-"));
      dataDirs.push(dataDir);
      const client = makeHostedClient(server, dataDir, {
        TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "spawn-temp-id",
      });

      // 探针路径（无 run ctx）：control env 初值成为连接绑定值。
      await client.ensureConnected();
      const opens = server.frames.filter((f) => f.kind === K.engineOpen);
      expect((opens[0]?.launch as Record<string, unknown>).rootSessionId).toBe("spawn-temp-id");

      // run 路径携带 per-run 权威根：旧通道不可换绑（runtime 侧 session 不一致即拒），
      // 换代重连 + 新 engine_open 用真根。
      await client.ensureConnected({ rootSessionId: "real-session-id-from-ctx" });
      expect(client.currentState).toBe("ready");
      const reopened = server.frames.filter((f) => f.kind === K.engineOpen);
      expect(reopened).toHaveLength(2);
      expect((reopened[1]?.launch as Record<string, unknown>).rootSessionId).toBe("real-session-id-from-ctx");
      // 旧通道已发 engine_close（runtime 杀组回收）
      expect(server.frames.some((f) => f.kind === K.engineClose)).toBe(true);
      await client.dispose();
    });

    it("[DC-12] probe 携带权威根 → run 同根命中同一共享连接（单 open、零 rebind、无双 spawn）", async () => {
      const server = await startServer();
      wireEchoEngineProtocol(server);
      const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-dc12-"));
      dataDirs.push(dataDir);
      const client = makeHostedClient(server, dataDir, {
        TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "spawn-temp-id",
      });

      // probe（生产链路 = RemoteEngine.probe({rootSessionId})，service 层权威根注入）：
      // 与 run 用同一 (socket, root) 键 → 不再以 env temp 根另建一条连接。
      await client.ensureConnected({ rootSessionId: "real-root" });
      // run 同根 + record 锚：复用同一连接（无换代重连、无 engine_close grace 等待）。
      await client.ensureConnected({ rootSessionId: "real-root", recordId: "run-1" });

      const opens = server.frames.filter((f) => f.kind === K.engineOpen);
      expect(opens).toHaveLength(1);
      expect((opens[0]?.launch as Record<string, unknown>).rootSessionId).toBe("real-root");
      expect(server.connectionCount).toBe(1);
      expect(server.frames.some((f) => f.kind === K.engineClose)).toBe(false);
      await client.dispose();
    });

    it("[S-10] run 的 record 锚 → launch.recordId 上 wire；probe 先行的 open 不携带该键", async () => {
      const server = await startServer();
      wireEchoEngineProtocol(server);
      const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-s10-"));
      dataDirs.push(dataDir);
      const client = makeHostedClient(server, dataDir);
      await client.ensureConnected({ rootSessionId: "sess-s10", recordId: "rec-run-1" });
      const open = server.frames.find((f) => f.kind === K.engineOpen);
      expect((open?.launch as Record<string, unknown>).recordId).toBe("rec-run-1");
      await client.dispose();

      // probe 先行（无 run 上下文）：launch 不携带 recordId（wire 可选扩展，runtime
      // 侧 `?? null` 登记 = 无树挂点，收割依赖进程组 + 连接 fan-out 结构性兜底）。
      const serverProbe = await startServer();
      wireEchoEngineProtocol(serverProbe);
      const probeClient = makeHostedClient(serverProbe, dataDir);
      await probeClient.ensureConnected({ rootSessionId: "sess-s10" });
      const probeOpen = serverProbe.frames.find((f) => f.kind === K.engineOpen);
      expect((probeOpen?.launch as Record<string, unknown>).recordId).toBeUndefined();
      expect(Object.hasOwn(probeOpen?.launch as object, "recordId")).toBe(false);
      await probeClient.dispose();
    });

    it("[R2A-N1] 单 control server + 双 EngineClient：pi run（真根）先 / zcode probe（env temp 根）后 → 无 session mismatch、无永久 unavailable", async () => {
      const server = await startServer();
      wireEchoEngineProtocol(server);
      const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-n1-"));
      dataDirs.push(dataDir);
      // 两个引擎共享同一进程级 control env：create 路径的 spawn 期 temp 根。
      const env = { TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "spawn-temp-id" };
      const pi = makeHostedClient(server, dataDir, env, "pi");
      const zcode = makeHostedClient(server, dataDir, env, "zcode");

      // 顺序 A：pi run 先用真根建连。
      await pi.ensureConnected({ rootSessionId: "real-root" });
      // zcode probe 无 run ctx → env 回落 temp 根。旧实现落到 pi 的共享连接上 →
      // engine_open_failed{session} → probe 永久 unavailable。
      await zcode.ensureConnected();

      expect(pi.currentState).toBe("ready");
      expect(zcode.currentState).toBe("ready");
      expect(server.openFailures).toEqual([]);
      // 协议不变量：不同根各占一条连接，每条连接只绑一个根。
      expect(server.connectionCount).toBe(2);
      expect([...new Set(server.activeConnectionRoots)].sort()).toEqual(["real-root", "spawn-temp-id"]);
      // 两引擎的通道都真实可用（不是「标记 ready 但请求走不通」）。
      await expect(pi.request("run", { runId: "pi-run" })).resolves.toBeTruthy();
      await expect(zcode.request("probe", {})).resolves.toBeTruthy();

      // 顺序 B（反序，同一 server 新会话）：zcode probe 先（temp 根）→ pi run 后（真根
      // 不能在 temp 连接上 open 被拒）。
      const piB = makeHostedClient(server, dataDir, env, "pi-b");
      const zcodeB = makeHostedClient(server, dataDir, env, "zcode-b");
      await zcodeB.ensureConnected();
      await piB.ensureConnected({ rootSessionId: "real-root-b" });
      expect(piB.currentState).toBe("ready");
      expect(zcodeB.currentState).toBe("ready");
      expect(server.openFailures).toEqual([]);
      await expect(piB.request("run", { runId: "pi-run-b" })).resolves.toBeTruthy();
      await expect(zcodeB.request("probe", {})).resolves.toBeTruthy();

      await pi.dispose();
      await zcode.dispose();
      await piB.dispose();
      await zcodeB.dispose();
    });

    it("[R2A-N2] 探针后两个并发 ensureConnected（真根）→ 只生成一代连接，两 run 都成功", async () => {
      const server = await startServer();
      wireEchoEngineProtocol(server);
      const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-n2-"));
      dataDirs.push(dataDir);
      const client = makeHostedClient(server, dataDir, {
        TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "spawn-temp-id",
      });

      // 探针先建连（temp 根，通道 1）。
      await client.ensureConnected();
      // 并行两个 run：旧实现两次 rebind 各自起一代 connectOnce → 第三个 engine_open
      // 与误拆新 transport（transport_lost/unavailable）。单飞后只应有一次换绑 + 一次 open。
      await Promise.all([
        client.ensureConnected({ rootSessionId: "real-root" }),
        client.ensureConnected({ rootSessionId: "real-root" }),
      ]);

      const opens = server.frames.filter((f) => f.kind === K.engineOpen);
      expect(opens.map((f) => (f.launch as Record<string, unknown>).rootSessionId))
        .toEqual(["spawn-temp-id", "real-root"]);
      expect(server.openFailures).toEqual([]);
      expect(client.currentState).toBe("ready");
      // temp 连接在换绑后 refcount 归零被关停，只剩真根连接。
      await waitForSocket(() => server.connectionCount === 1, "temp connection disposed after rebind");
      expect(server.activeConnectionRoots).toEqual(["real-root"]);

      // 两个 run 共用同一代连接且都得到应答（不是「一个成功一个 transport_lost」）。
      const results = await Promise.all([
        client.request("run", { runId: "run-a" }),
        client.request("run", { runId: "run-b" }),
      ]);
      expect(results).toEqual([{ ok: "run" }, { ok: "run" }]);
      expect(client.currentState).toBe("ready");
      await client.dispose();
    });

    it("[B-U-3] 同失败形态分型等价（code 同为 engine_crashed）+ [R2A-N3③] runtime 帧 recovery 保留", async () => {
      // local：entry 子进程加载即退出（本地启动失败的真实形态）
      const localDir = mkdtempSync(join(tmpdir(), "u-m3-rt-local-dead-"));
      dataDirs.push(localDir);
      const deadEngine = join(localDir, "dead-engine.mjs");
      writeFileSync(deadEngine, "process.exit(1);\n", "utf8");
      const local = new EngineClient({
        engineId: "fake",
        command: process.execPath,
        args: [deadEngine],
        hostKind: "test",
        dataDir: localDir,
        envPrefixes: [],
        baseEnv: {},
      });
      let localCode: string | undefined;
      try {
        await local.ensureConnected();
      } catch (err) {
        localCode = (err as EngineSdkError).code;
      }
      expect(localCode).toBe("engine_crashed");

      // runtime：runtime 侧启动裁决失败（invalid_launch / spawn_failed）→ 同一 code 分型；
      // R2A-N3③：runtime 帧的专用 recovery 经 connectOnce 原样保留（不被宿主通用文案
      // 盖掉——恢复指引指向真实修复动作）。
      for (const controlCode of ["invalid_launch", "spawn_failed"] as const) {
        const server = await startServer();
        server.onEngineOpen = (socket, frame) => {
          server.sendControl(socket, {
            v: 1,
            kind: K.engineOpenFailed,
            id: frame.id,
            code: controlCode,
            message: controlCode === "invalid_launch"
              ? "entryPath is not an absolute existing path"
              : "engine executor not found",
            recovery: "resolve the engine entry from the descriptor",
          });
        };
        const runtimeDir = mkdtempSync(join(tmpdir(), "u-m3-rt-runtime-invalid-"));
        dataDirs.push(runtimeDir);
        const hosted = makeHostedClient(server, runtimeDir);
        await expect(hosted.ensureConnected({ rootSessionId: "real-session-id" })).rejects.toSatisfy(
          (err: Error & { code?: string; recovery?: string; message?: string }) => {
            expect(err.code).toBe("engine_crashed");
            expect(err.message).toContain(controlCode);
            // [R2A-N3③] 真实 open 路径的 recovery 断言：runtime 帧文案保留。
            expect(err.recovery).toBe("resolve the engine entry from the descriptor");
            return true;
          },
        );
        expect(hosted.currentState).toBe("unavailable");
      }
    });
    it("control env 激活 → runtime transport 被选中：ready 经 control 通道（零 spawn 零 pidfile）+ dispose 走 dispose 帧与 engine_close", async () => {
      const server = await startServer();
      wireFakeEngineProtocol(server);
      const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-data-"));
      dataDirs.push(dataDir);
      const client = makeHostedClient(server, dataDir);

      await client.ensureConnected();
      expect(client.currentState).toBe("ready");
      // runtime 模式无 local 进程面：不 spawn、无 pidfile（验收③）
      expect(client.enginePid).toBeUndefined();
      expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(false);
      const open = server.frames.find((f) => f.kind === K.engineOpen);
      expect((open?.launch as Record<string, unknown>).rootSessionId).toBe("sess-rt-1");

      const before = server.frames.length;
      await client.dispose();
      expect(client.currentState).toBe("disposed");
      const after = server.frames.slice(before);
      // 优雅关闭序：引擎协议 dispose 帧（engine_frame）→ engine_close（控制帧）
      expect(after.some((f) => f.kind === K.engineFrame && String(f.line).includes('"method":"dispose"'))).toBe(true);
      expect(after.some((f) => f.kind === K.engineClose)).toBe(true);
    });

    it("通道级 error 帧 → 在途请求以具体码 reject（不被后续 engine_closed 的 engine_crashed 覆盖）", async () => {
      const server = await startServer();
      wireFakeEngineProtocol(server);
      const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-data-"));
      dataDirs.push(dataDir);
      const client = makeHostedClient(server, dataDir);

      await client.ensureConnected();
      const pending = client.request("ping", {});
      await waitForSocket(
        () => server.frames.some((f) => f.kind === K.engineFrame && String(f.line).includes('"method":"ping"')),
        "ping frame",
      );
      // D8 顺序：先 error {code}，再 engine_closed——具体码不被 engine_crashed 覆盖
      server.sendError("ch-1", "engine_frame_too_large", "engine frame envelope too large");
      server.sendEngineClosed("ch-1", { code: null, signal: null, reason: "killed_by_control" });
      await expect(pending).rejects.toMatchObject({ code: "engine_frame_too_large" });
      // 通道级错误在 engine_closed 后回到 exited（下次 run 可重建——退避重试语义与引擎崩溃同型）；
      // 连接死亡无 engine_closed 跟随 → 保持 unavailable（不在同一连接重试）
      expect(client.currentState).toBe("exited");
    });

    it("[m-core-3] unknown_channel（通道终局、连接仍活）→ 不 markUnavailable；下一次 run 在活连接上重新 open", async () => {
      const server = await startServer();
      wireEchoEngineProtocol(server);
      const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-unknown-"));
      dataDirs.push(dataDir);
      const client = makeHostedClient(server, dataDir);

      await client.ensureConnected();
      expect(client.currentState).toBe("ready");

      // runtime 对 unknown_channel 只发 error 帧、不跟 engine_closed（D10：通道终局，
      // 不是连接丢失）。旧实现无条件 markUnavailable → 无 engine_closed 回落，永久不可用。
      server.sendError("ch-1", "unknown_channel", "unknown channel ch-1");
      await waitForSocket(() => client.currentState === "exited", "state falls back to exited");
      expect(client.currentState).not.toBe("unavailable");

      // 下一次 run 可重建：同一 control 连接上重新 engine_open（连接未死，不重连）。
      await client.ensureConnected();
      expect(client.currentState).toBe("ready");
      expect(server.frames.filter((f) => f.kind === K.engineOpen)).toHaveLength(2);
      expect(server.connectionCount).toBe(1);
      await expect(client.request("probe", {})).resolves.toBeTruthy();
      await client.dispose();
    });

    it("连接在 engine_open 期间死亡 → ensureConnected 以 engine_transport_lost 上抛（不包装）+ 标记不可用", async () => {
      const server = await startServer();
      server.holdOpen = true;
      const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-data-"));
      dataDirs.push(dataDir);
      const client = makeHostedClient(server, dataDir);

      const pending = client.ensureConnected();
      await waitForSocket(() => server.frames.some((f) => f.kind === K.engineOpen), "engine_open in flight");
      server.destroyConnections();
      await expect(pending).rejects.toMatchObject({ code: "engine_transport_lost" });
      expect(client.currentState).toBe("unavailable");
    });

    it("hello_reject version → engine_protocol_mismatch 原样上抛（不包装 engine_crashed）", async () => {
      const server = await startServer();
      server.rejectHelloVersion = true;
      const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-data-"));
      dataDirs.push(dataDir);
      const client = makeHostedClient(server, dataDir);

      await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
      expect(client.currentState).toBe("unavailable");
    });

    it("[ADR-0122] 握手期失败（initialize 版本不兼容）→ 清理回执 engine_closed 不复活 unavailable；再次 ensureConnected 仍抛原错误且不重新 engine_open", async () => {
      const server = await startServer();
      // 通道已 open、initialize 应答版本越界（握手失败的快速形态；超时形态
      // engine_handshake_timeout 走同一条 connectOnce catch → teardown + markUnavailable 路径）。
      server.onEngineFrame = (socket, frame) => {
        let parsed: { id?: number; method?: string };
        try {
          parsed = JSON.parse(String(frame.line)) as { id?: number; method?: string };
        } catch {
          return;
        }
        if (parsed.method !== "initialize") return;
        server.sendControl(socket, {
          v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
          kind: K.engineFrame,
          channelId: frame.channelId,
          line: JSON.stringify({ id: parsed.id, result: { protocolVersion: 999 } }),
        });
      };
      const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-handshake-"));
      dataDirs.push(dataDir);
      const client = makeHostedClient(server, dataDir);

      await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
      // 清理链（teardownProcess → engine_close → runtime 回 engine_closed → 通道终局）
      // 走完的确定性信号 = 共享 control 连接引用归零被关停（release 在 onExit 之后）。
      await waitForSocket(() => server.connectionCount === 0, "engine_closed processed (control connection released)");
      // 终局失败不得被清理回执复活（旧实现 onTransportExit 无条件 state = "exited"，
      // 会让下一次 ensureConnected 把终局错误当可重试、重新 spawn 引擎）。
      expect(client.currentState).toBe("unavailable");

      const opensBefore = server.frames.filter((f) => f.kind === K.engineOpen).length;
      await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
      expect(server.frames.filter((f) => f.kind === K.engineOpen)).toHaveLength(opensBefore);
      expect(client.currentState).toBe("unavailable");
    });
  });
});

// ── 来源区块：transport-local.test.ts ────────────────────────────────────────────────
describe("transport-local", () => {
  const FAKE_ENGINE = fileURLToPath(
    new URL("./__fixtures__/fake-engine.mjs", import.meta.url),
  );

  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "u-m3-local-transport-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeSpec(overrides: Partial<EngineLaunchSpec> = {}): EngineLaunchSpec {
    return {
      engineId: "fake",
      entryPath: process.execPath,
      args: [FAKE_ENGINE],
      cwd: dataDir,
      envPrefixes: [],
      rootSessionId: "", // local 实现忽略（runtime 归属键）
      ...overrides,
    };
  }

  /** NDJSON 帧行收集器（onFrame 订阅 + 行 JSON 解析）。 */
  function collectFrames(transport: EngineTransport): { raw: string[]; parsed: unknown[] } {
    const raw: string[] = [];
    const parsed: unknown[] = [];
    transport.onFrame((line) => {
      raw.push(line);
      try {
        parsed.push(JSON.parse(line) as unknown);
      } catch {
        // 非 NDJSON 行不进 parsed（协议契约外输出）
      }
    });
    return { raw, parsed };
  }

  // ── ① 帧面逻辑：进程端点桩（FakeChildProcess + 管道回声引擎）──────────────────

  /**
   * 进程端点桩：EventEmitter + PassThrough 双工管道，pid 取不可达高位（killProcessTree
   * 对其 ESRCH no-op，不触碰真实进程表）。实现 wireChild / close / waitForChildExit
   * 消费的 ChildProcess 面（on / removeAllListeners / pid / exitCode / signalCode /
   * stdin / stdout / stderr 流）。
   */
  class FakeChildProcess extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    constructor(readonly pid: number) {
      super();
    }
    kill(): boolean {
      return true;
    }
    /** 模拟进程终局：置 exit/signal 事实后派发 exit 事件（真实 ChildProcess 同点序）。 */
    emitExit(code: number | null, signal: NodeJS.Signals | null): void {
      if (signal !== null) {
        this.signalCode = signal;
        this.exitCode = null;
      } else {
        this.exitCode = code;
        this.signalCode = null;
      }
      this.emit("exit", code, signal);
    }
  }

  /** 管道回声引擎：stdin 行 → 最小协议应答（initialize/ping/run）→ stdout 行。 */
  function attachEchoEngine(child: FakeChildProcess): void {
    let buffer = "";
    child.stdin.setEncoding("utf-8");
    child.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.trim().length > 0) handleLine(line);
        idx = buffer.indexOf("\n");
      }
    });
    function send(frame: object): void {
      child.stdout.write(`${JSON.stringify(frame)}\n`);
    }
    function handleLine(line: string): void {
      let frame: { id?: number; method?: string };
      try {
        frame = JSON.parse(line) as { id?: number; method?: string };
      } catch {
        return;
      }
      switch (frame.method) {
        case "initialize":
          send({ id: frame.id, result: { protocolVersion: 1, engineId: "fake" } });
          break;
        case "ping":
          send({ id: frame.id, result: { pong: true } });
          break;
        case "run":
          send({
            id: frame.id,
            result: {
              handle: { v: 1, engineId: "fake", sessionRef: { sessionId: "fake-session-1" }, poolKey: "shared" },
              outcome: { content: "fake-content-run-1", engineId: "fake", exitCode: 0, durationMs: 1 },
            },
          });
          break;
        default:
          break;
      }
    }
  }

  /** PassThrough 管道传播是 nextTick 链——一个宏任务轮次内确定性到达。 */
  async function flushPipes(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  /** 装配接 FakeChildProcess 的 transport（spawn 注入点；其余路径全真）。 */
  function makeFakeChildTransport(
    overrides: Partial<ConstructorParameters<typeof LocalEngineTransport>[0]> = {},
  ): { transport: LocalEngineTransport; child: FakeChildProcess } {
    const child = new FakeChildProcess(999_999_999);
    const transport = new LocalEngineTransport({
      engineId: "fake",
      dataDir,
      hostKind: "test",
      engineCmdlineMatcher: () => false,
      // 进程端点桩注入（测试 seam，见 LocalEngineTransportOptions.spawnChildProcess 注释）
      spawnChildProcess: () => child as unknown as ChildProcess,
      ...overrides,
    });
    return { transport, child };
  }

  describe("LocalEngineTransport：帧面逻辑（进程端点桩，验收①）", () => {
    it("open：接线子进程端点（pid 回执独立）+ writeFrame→onFrame 帧往返 + 多帧连续写逐行投递（不粘连）", async () => {
      const { transport, child } = makeFakeChildTransport();
      attachEchoEngine(child);
      const frames = collectFrames(transport);
      const opened = await transport.open(makeSpec());
      expect(opened.pid).toBeDefined();
      expect(opened.pid).not.toBe(process.pid);

      expect(
        transport.writeFrame(JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: 1 } })),
      ).toBe(true);
      expect(transport.writeFrame(JSON.stringify({ id: 2, method: "ping", params: {} }))).toBe(true);
      await flushPipes();
      // 逐行投递：两帧都到达且 id 关联面不粘连
      const answered = frames.parsed.find((f) => (f as { id?: number }).id === 1) as {
        result?: { protocolVersion?: number };
      };
      expect(answered.result?.protocolVersion).toBe(1);
      const pong = frames.parsed.find((f) => (f as { id?: number }).id === 2) as { result?: { pong?: boolean } };
      expect(pong.result?.pong).toBe(true);
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
    });

    it("writeFrame 返回回执：进程死亡后（exitCode 非空）写帧 → false（宿主据以收口 in-flight）", async () => {
      const { transport, child } = makeFakeChildTransport();
      await transport.open(makeSpec());
      expect(transport.writeFrame(JSON.stringify({ id: 9, method: "ping", params: {} }))).toBe(true);
      child.exitCode = 1;
      expect(transport.writeFrame(JSON.stringify({ id: 9, method: "ping", params: {} }))).toBe(false);
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
    });

    it("onExit 终局投影：signal 投影（reason 缺席 = local 无 engine_closed 事实源）+ 多订阅各一次 + 幂等单派发", async () => {
      const { transport, child } = makeFakeChildTransport();
      const exits: EngineTransportExitInfo[] = [];
      transport.onExit((info) => exits.push(info));
      transport.onExit((info) => exits.push(info)); // 多订阅：各回调一次
      await transport.open(makeSpec());
      child.emitExit(null, "SIGKILL");
      // 每个订阅者各收到一次同一终局（两次订阅 = 两次回调，各一）
      expect(exits).toHaveLength(2);
      expect(exits[0]).toEqual(exits[1]);
      expect(exits[0]!.code).toBeNull();
      expect(exits[0]!.signal).toBe("SIGKILL");
      expect(exits[0]!.reason).toBeUndefined(); // reason 是 runtime engine_closed 值域
      // 二次终局（迟到的重复 exit 事件）不重复派发
      child.emit("exit", null, "SIGKILL");
      expect(exits).toHaveLength(2);
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
    });

    it("stderr 出口：引擎 stderr 经 onStderr 回调投递（宿主环形缓冲数据源）+ 正常退出终局投影 code", async () => {
      const stderrChunks: string[] = [];
      const { transport, child } = makeFakeChildTransport({ onStderr: (chunk) => stderrChunks.push(chunk) });
      const exits: EngineTransportExitInfo[] = [];
      transport.onExit((info) => exits.push(info));
      await transport.open(makeSpec());
      child.stderr.write("fatal: fake engine boot failure\n");
      await flushPipes();
      expect(stderrChunks.join("")).toContain("fatal: fake engine boot failure");
      child.emitExit(1, null);
      expect(exits[0]!.code).toBe(1);
      expect(exits[0]!.signal).toBeNull();
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
    });

    it("stdout 半行上限：持续无换行输出 → 残片丢头留尾 + 首截断 warn 一次；换行冲刷后垃圾行按行投递，后续合法帧照常", async () => {
      const warnMessages: string[] = [];
      const { transport, child } = makeFakeChildTransport();
      const frames = collectFrames(transport);
      await transport.open(makeSpec());
      const original = console.warn;
      console.warn = (...parts: unknown[]) => {
        warnMessages.push(parts.join(" "));
      };
      try {
        // 1.5 MiB 无换行垃圾（> 1 MiB 上限）分片写（残片经多次 data 事件反复超限）
        const total = 1_572_864;
        const chunkSize = 64 * 1024;
        for (let written = 0; written < total; written += chunkSize) {
          child.stdout.write("x".repeat(Math.min(chunkSize, total - written)));
        }
        await flushPipes();
        // 截断告警只发首截断一次
        expect(warnMessages.filter((m) => m.includes("stdout partial line exceeded"))).toHaveLength(1);
        // 换行冲刷：残片（截尾后的 1 MiB）成为一行投递给订阅方
        child.stdout.write("\n");
        await flushPipes();
        expect(frames.raw).toHaveLength(1);
        expect(frames.raw[0]).toBe("x".repeat(1_048_576));
        // 后续合法 NDJSON 帧照常逐行投递（截断不得破坏后续帧边界）
        child.stdout.write('{"id":9,"result":{"ok":true}}\n');
        await flushPipes();
        const ok = frames.parsed.find((f) => (f as { id?: number }).id === 9) as { result?: { ok?: boolean } };
        expect(ok.result?.ok).toBe(true);
      } finally {
        console.warn = original;
      }
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
    });
  });

  // ── ② EngineClient：transport 选择谓词 + 错误码 preserve 白名单（验收②③）────────

  /** 假 transport（open 行为可编程；不经 LocalEngineTransport——谓词/白名单面单测用）。 */
  function makeStubTransport(openImpl: () => Promise<{ pid?: number }>): EngineTransport {
    return {
      open: openImpl,
      writeFrame: () => false,
      onFrame: () => {},
      onExit: () => {},
      close: async () => {},
    };
  }

  class StubTransportClient extends EngineClient {
    private readonly stub: EngineTransport;
    constructor(stub: EngineTransport, opts: ConstructorParameters<typeof EngineClient>[0]) {
      super(opts);
      this.stub = stub;
    }
    protected override resolveTransport(): EngineTransport {
      return this.stub;
    }
  }

  /** 握手桩 transport：initialize/ping/run 帧照 fake-engine 语义回最小应答（谓词面单测——不 spawn）。 */
  class HandshakeStubTransport implements EngineTransport {
    private readonly frameHandlers: Array<(line: string) => void> = [];
    private readonly exitHandlers: Array<(info: EngineTransportExitInfo) => void> = [];
    private alive = true;

    async open(): Promise<EngineTransportOpenResult> {
      return { pid: 4242 };
    }

    writeFrame(line: string): boolean {
      if (!this.alive) return false;
      let frame: { id?: number; method?: string };
      try {
        frame = JSON.parse(line) as { id?: number; method?: string };
      } catch {
        return true;
      }
      if (frame.method === undefined) return true; // 反向请求应答帧
      switch (frame.method) {
        case "initialize":
          this.emit({ id: frame.id, result: { protocolVersion: 1, engineId: "fake" } });
          break;
        case "ping":
          this.emit({ id: frame.id, result: { pong: true } });
          break;
        case "run":
          this.emit({
            id: frame.id,
            result: {
              handle: { v: 1, engineId: "fake", sessionRef: { sessionId: "fake-session-1" }, poolKey: "shared" },
              outcome: { content: "fake-content-run-1", engineId: "fake", exitCode: 0, durationMs: 1 },
            },
          });
          break;
        case "dispose":
          this.emit({ id: frame.id, result: { ok: true } });
          this.alive = false;
          for (const handler of this.exitHandlers) handler({ code: 0, signal: null });
          break;
        default:
          break;
      }
      return true;
    }

    onFrame(handler: (line: string) => void): void {
      this.frameHandlers.push(handler);
    }

    onExit(handler: (info: EngineTransportExitInfo) => void): void {
      this.exitHandlers.push(handler);
    }

    async close(): Promise<void> {
      this.alive = false;
    }

    private emit(frame: object): void {
      const line = JSON.stringify(frame);
      for (const handler of this.frameHandlers) handler(line);
    }
  }

  /**
   * 谓词探针 client：resolveTransport 经 super 真实求值（谓词逻辑 = 被测面），记录选中
   * 分支；local 分支换握手桩（避免真 spawn），runtime 分支返回真实 transport（其连接
   * 失败面本身是被测行为，连接到不存在的 socket 路径 = 确定性立即失败，无真子进程）。
   */
  class PredicateProbeClient extends EngineClient {
    private readonly stub: HandshakeStubTransport;
    selected: "local" | "runtime" | undefined;
    constructor(stub: HandshakeStubTransport, opts: ConstructorParameters<typeof EngineClient>[0]) {
      super(opts);
      this.stub = stub;
    }
    protected override resolveTransport(): EngineTransport {
      const real = super.resolveTransport();
      const isRuntime = real instanceof RuntimeEngineTransport;
      this.selected = isRuntime ? "runtime" : "local";
      return isRuntime ? real : this.stub;
    }
  }

  describe("EngineClient transport 谓词与错误码 preserve（验收②③）", () => {
    function baseClientOpts(
      overrides: Partial<ConstructorParameters<typeof EngineClient>[0]> = {},
    ): ConstructorParameters<typeof EngineClient>[0] {
      return {
        engineId: "fake",
        command: process.execPath,
        args: [FAKE_ENGINE],
        hostKind: "test",
        hostVersion: "test-host-1.0",
        dataDir,
        envPrefixes: [],
        ...overrides,
      };
    }

    it("control env 激活 → engine_transport_unavailable（runtime transport 真实 connect 失败面；不静默 local）+ 零 spawn 零 pidfile（验收③）", async () => {
      const client = new PredicateProbeClient(
        new HandshakeStubTransport(),
        baseClientOpts({
          baseEnv: { TAIJI_SUBAGENT_CONTROL_SOCKET: join(tmpdir(), `u-m3-rt-missing-${process.pid}.sock`) },
        }),
      );
      await expect(client.ensureConnected()).rejects.toSatisfy(
        (err: Error & { code?: string; recovery?: string }) => {
          expect(err.code).toBe("engine_transport_unavailable");
          expect(err.recovery).toBe(ENGINE_TRANSPORT_ERROR_RECOVERY.engine_transport_unavailable);
          return true;
        },
      );
      expect(client.selected).toBe("runtime");
      // 标记不可用（不是 state 卡 connecting）+ 复现同码
      expect(client.currentState).toBe("unavailable");
      await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_transport_unavailable" });
      // 非本机路径绝对不 fallback：无引擎进程被 spawn，pidfile 未写（runtime 模式无 pidfile 面）
      expect(client.enginePid).toBeUndefined();
      expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(false);
    });

    it("control env 空串 → local 分支（谓词只看非空；ready）", async () => {
      const client = new PredicateProbeClient(
        new HandshakeStubTransport(),
        baseClientOpts({ baseEnv: { TAIJI_SUBAGENT_CONTROL_SOCKET: "" } }),
      );
      await client.ensureConnected();
      expect(client.selected).toBe("local");
      expect(client.currentState).toBe("ready");
      await client.dispose();
    });

    it("[D9] TAIJI_SUBAGENT_TRANSPORT=local 优先于 control env 激活判定（强制 local；ready）", async () => {
      const client = new PredicateProbeClient(
        new HandshakeStubTransport(),
        baseClientOpts({
          baseEnv: {
            // control env 本应选中 runtime（socket 路径甚至不存在）——逃生舱必须抢先。
            TAIJI_SUBAGENT_CONTROL_SOCKET: join(tmpdir(), `u-m3-rt-missing-${process.pid}.sock`),
            [SUBAGENT_TRANSPORT_ENV]: "local",
          },
        }),
      );
      await client.ensureConnected();
      expect(client.selected).toBe("local");
      expect(client.currentState).toBe("ready");
      await client.dispose();
    });

    it("[D9] 非 local 值不改变既有谓词（control env 仍选 runtime → 显式不可用）", async () => {
      const client = new PredicateProbeClient(
        new HandshakeStubTransport(),
        baseClientOpts({
          baseEnv: {
            TAIJI_SUBAGENT_CONTROL_SOCKET: join(tmpdir(), `u-m3-rt-missing-${process.pid}.sock`),
            [SUBAGENT_TRANSPORT_ENV]: "runtime",
          },
        }),
      );
      await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_transport_unavailable" });
      expect(client.selected).toBe("runtime");
      expect(client.currentState).toBe("unavailable");
    });

    it("transport 错误码经 connectOnce preserve：open 拒 engine_transport_lost → 原样上抛（不包装 failed-to-start）+ 标记不可用", async () => {
      const stub = makeStubTransport(() =>
        Promise.reject(
          new EngineSdkError(
            "engine_transport_lost",
            "control connection lost during engine_open",
            ENGINE_TRANSPORT_ERROR_RECOVERY.engine_transport_lost,
          ),
        ),
      );
      const client = new StubTransportClient(stub, {
        engineId: "fake",
        command: process.execPath,
        args: [FAKE_ENGINE],
        hostKind: "test",
        dataDir,
        envPrefixes: [],
      });
      await expect(client.ensureConnected()).rejects.toSatisfy(
        (err: Error & { code?: string; recovery?: string; message?: string }) => {
          expect(err.code).toBe("engine_transport_lost");
          expect(err.recovery).toBe(ENGINE_TRANSPORT_ERROR_RECOVERY.engine_transport_lost);
          expect(err.message).not.toContain("failed to start"); // 不包装成 engine_crashed
          return true;
        },
      );
      expect(client.currentState).toBe("unavailable");
    });

    it("非白名单错误维持既有 engine_crashed 包装（failed to start 文案）", async () => {
      const stub = makeStubTransport(() => Promise.reject(new Error("boom during open")));
      const client = new StubTransportClient(stub, {
        engineId: "fake",
        command: process.execPath,
        args: [FAKE_ENGINE],
        hostKind: "test",
        dataDir,
        envPrefixes: [],
      });
      await expect(client.ensureConnected()).rejects.toSatisfy(
        (err: Error & { code?: string; message?: string }) => {
          expect(err.code).toBe("engine_crashed");
          expect(err.message).toContain("failed to start: boom during open");
          return true;
        },
      );
      expect(client.currentState).toBe("unavailable");
    });

    it("engine_protocol_mismatch preserve（白名单既有成员，回归护栏）", async () => {
      const stub = makeStubTransport(() =>
        Promise.reject(new EngineSdkError("engine_protocol_mismatch", "engine speaks v99", "upgrade the engine package")),
      );
      const client = new StubTransportClient(stub, {
        engineId: "fake",
        command: process.execPath,
        args: [FAKE_ENGINE],
        hostKind: "test",
        dataDir,
        envPrefixes: [],
      });
      await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
      expect(client.currentState).toBe("unavailable");
    });
  });

  // ── ③ 进程治理真链（真 spawn fake-engine；进程事实 = 判据③，挂集成门控）──────────

  describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
    `LocalEngineTransport：真进程治理链（验收①③）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
    () => {
      function makeTransport(
        overrides: Partial<ConstructorParameters<typeof LocalEngineTransport>[0]> = {},
      ): LocalEngineTransport {
        return new LocalEngineTransport({
          engineId: "fake",
          dataDir,
          hostKind: "test",
          engineCmdlineMatcher: () => false,
          ...overrides,
        });
      }

      it("open 真进程：spawn 引擎 CLI（pid 独立）+ initialize 帧往返 + 多帧连续写逐行投递", async () => {
        const transport = makeTransport();
        const frames = collectFrames(transport);
        const opened = await transport.open(makeSpec());
        expect(opened.pid).toBeDefined();
        expect(opened.pid).not.toBe(process.pid);

        expect(
          transport.writeFrame(JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: 1 } })),
        ).toBe(true);
        expect(transport.writeFrame(JSON.stringify({ id: 2, method: "ping", params: {} }))).toBe(true);
        await waitFor(() => frames.parsed.some((f) => (f as { id?: number }).id === 2));
        const answered = frames.parsed.find((f) => (f as { id?: number }).id === 1) as {
          result?: { protocolVersion?: number };
        };
        expect(answered.result?.protocolVersion).toBe(1);
        const pong = frames.parsed.find((f) => (f as { id?: number }).id === 2) as { result?: { pong?: boolean } };
        expect(pong.result?.pong).toBe(true);
        await transport.close();
      });

      it("close：组杀引擎 + 组内后代连带（POSIX 进程组）+ pidfile 清理", async () => {
        const transport = makeTransport();
        const frames = collectFrames(transport);
        const opened = await transport.open(
          makeSpec({
            args: [FAKE_ENGINE, "--run-actions", JSON.stringify([{ op: "spawnGrandchild", recordId: "rec-grand" }])],
          }),
        );
        const enginePid = opened.pid!;
        // 驱动协议：initialize → run（spawnGrandchild 动作经反向通道上报孙进程 pid）
        transport.writeFrame(JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: 1 } }));
        transport.writeFrame(JSON.stringify({ id: 2, method: "run", params: { runId: "run-1", task: { prompt: "p" } } }));
        await waitFor(() =>
          frames.parsed.some((f) => (f as { method?: string }).method === "host/childSpawned"),
        );
        const grandchildPid = (
          frames.parsed.find((f) => (f as { method?: string }).method === "host/childSpawned") as {
            params?: { pid?: number };
          }
        )?.params?.pid;
        expect(grandchildPid).toBeDefined();
        expect(probePidAliveness(grandchildPid!)).toBe(true);

        await transport.close("u-m3-local harvest test");
        // 组内双亡（detached 后代不覆盖——既有已接受代价）
        await waitFor(() => probePidAliveness(grandchildPid!) === false);
        await waitFor(() => probePidAliveness(enginePid) === false);
        // pidfile 随 close 链清理（exit 投影段）
        expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(false);
      });

      it("pidfile 注册：open 写 engine.<hostKind>.<hostPid>.pid（local 模式专属，验收③正向面）；引擎死后 exit 投影清理", async () => {
        const transport = makeTransport();
        const path = pidfilePath(dataDir, "fake", "test", process.pid);
        expect(existsSync(path)).toBe(false);
        const opened = await transport.open(makeSpec());
        expect(existsSync(path)).toBe(true);
        // 引擎死后 exit 投影清理
        process.kill(opened.pid!, "SIGTERM");
        await waitFor(() => !existsSync(path));
        await transport.close();
      });
    },
  );
});

// ── 来源区块：transport-selection.test.ts ────────────────────────────────────────────────
describe("transport-selection", () => {
  const CONTROL_SOCKET = "TAIJI_SUBAGENT_CONTROL_SOCKET";
  const CONTROL_ON = { [CONTROL_SOCKET]: "/tmp/transport-selection.sock" };
  const sink = { setWidget: vi.fn() };
  /** engine-client 的 logger 来自 SDK facade（同一 component 单例）；spyOn 即拦截。 */
  const subagentsLogger = sdkGetLogger("subagents");

  describe("[m-core-4] usesRuntimeTransport：实际 transport 选择单源", () => {
    it("control env 非空 → runtime；空串/缺失 → local", () => {
      expect(usesRuntimeTransport(CONTROL_ON)).toBe(true);
      expect(usesRuntimeTransport({ [CONTROL_SOCKET]: "" })).toBe(false);
      expect(usesRuntimeTransport({})).toBe(false);
    });

    it("D9 逃生舱优先：control env 非空 + TAIJI_SUBAGENT_TRANSPORT=local → local", () => {
      const env = { ...CONTROL_ON, [SUBAGENT_TRANSPORT_ENV]: "local" };
      expect(isForcedLocalTransport(env)).toBe(true);
      expect(usesRuntimeTransport(env)).toBe(false);
      // trim 语义：带空白的 local 同样生效
      expect(usesRuntimeTransport({ ...CONTROL_ON, [SUBAGENT_TRANSPORT_ENV]: " local " })).toBe(false);
    });

    it("非法值不改变默认谓词", () => {
      expect(usesRuntimeTransport({ ...CONTROL_ON, [SUBAGENT_TRANSPORT_ENV]: "runtime" })).toBe(true);
      expect(usesRuntimeTransport({ ...CONTROL_ON, [SUBAGENT_TRANSPORT_ENV]: "bogus" })).toBe(true);
    });
  });

  describe("[m-core-4] createBackgroundStream：GUI widget 抑制按实际 transport", () => {
    it("GUI + runtime transport → 不创建（runtime tee 供数）", () => {
      expect(createBackgroundStream("rec-1", sink, "rpc", CONTROL_ON)).toBeUndefined();
    });

    it("GUI + control env + D9 forced local → 创建（本地 spawn 无 fd3/tee，恢复 widget 自供）", () => {
      const stream = createBackgroundStream("rec-1", sink, "rpc", {
        ...CONTROL_ON,
        [SUBAGENT_TRANSPORT_ENV]: "local",
      });
      expect(stream).toBeInstanceOf(SubagentStream);
      stream?.dispose();
    });

    it("GUI + 非托管（无 control env）→ 创建；TUI + 托管 → 创建", () => {
      const standalone = createBackgroundStream("rec-1", sink, "rpc", {});
      expect(standalone).toBeInstanceOf(SubagentStream);
      standalone?.dispose();

      const tui = createBackgroundStream("rec-1", sink, "tui", CONTROL_ON);
      expect(tui).toBeInstanceOf(SubagentStream);
      tui?.dispose();
    });

    it("sink=null 恒不创建", () => {
      expect(createBackgroundStream("rec-1", null, "rpc", CONTROL_ON)).toBeUndefined();
      expect(createBackgroundStream("rec-1", null, "rpc", {})).toBeUndefined();
    });
  });

  /** resolveTransport 是 protected（测试 seam）：子类只开观测口，不改行为。 */
  class ExposedEngineClient extends EngineClient {
    exposeResolveTransport(): void {
      this.resolveTransport();
    }
  }

  function makeClient(baseEnv: Record<string, string | undefined>): ExposedEngineClient {
    return new ExposedEngineClient({
      engineId: "selection",
      command: process.execPath,
      args: ["--never-spawned"],
      hostKind: "test",
      dataDir: join(tmpdir(), "transport-selection-no-io"),
      envPrefixes: [],
      baseEnv,
    });
  }

  describe("[m-core-5] transport 选择日志级别", () => {
    it("缺省 local 回落 → warn（设计 D5：空串/缺失 → local（warn））", () => {
      const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(() => {});
      makeClient({}).exposeResolveTransport();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("transport selected: local (no control env)"),
      );
      warnSpy.mockRestore();
    });

    it("D9 forced local → warn 留痕", () => {
      const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(() => {});
      makeClient({
        [CONTROL_SOCKET]: "/tmp/transport-selection.sock",
        [SUBAGENT_TRANSPORT_ENV]: "local",
      }).exposeResolveTransport();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("forcing local transport (D9 escape hatch)"),
      );
      warnSpy.mockRestore();
    });

    it("runtime transport → debug（不 warn）", () => {
      const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(() => {});
      const debugSpy = vi.spyOn(subagentsLogger, "debug").mockImplementation(() => {});
      makeClient(CONTROL_ON).exposeResolveTransport();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("transport selected: runtime control channel"),
      );
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    });
  });
});

// ── 来源区块：reverse-router-slot-read.test.ts ────────────────────────────────────────────────
describe("reverse-router-slot-read", () => {
  const FAKE_ENGINE = fileURLToPath(
    new URL("./__fixtures__/fake-engine.mjs", import.meta.url),
  );

  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "d3-slot-read-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    _resetHostUiRequestEndpointForTest();
  });

  interface RunOutcome {
    events: Array<{ type: string; message?: string }>;
  }

  /** 跑一个含单次 askUser 的 run，收集引擎 echo 的应答 event。 */
  async function runAskUser(
    client: EngineClient,
    runId: string,
    request: { method: string; id: string },
  ): Promise<RunOutcome> {
    const events: Array<{ type: string; message?: string }> = [];
    const unregister = client.registerRunRoute(runId, {
      onEvent: (e) => {
        events.push(e as { type: string; message?: string });
      },
    });
    try {
      await client.ensureConnected();
      await client.request("run", {
        runId,
        task: { prompt: "p" },
        ctx: { poolKey: "shared", cwd: dataDir },
      });
    } finally {
      unregister();
    }
    return { events };
  }

  function askUserEcho(outcome: RunOutcome): string | undefined {
    return outcome.events
      .find((e) => e.message?.startsWith("askUser-result:"))
      ?.message;
  }

  describe("D3：reverse-router host/askUser 槽现读（构造期固化已消除）", () => {
    it("EngineClient 构造后登记应答端 → 反向请求路由到该 handler（构造期不固化值的情形）", async () => {
      // 构造时槽为空——旧行为（构造期固化 uiRequestHandler）会把 undefined 固化进
      // reverseRouterDeps，本 run 将收 {unsupported:true}；现读语义下应正常应答。
      const client = new EngineClient({
        engineId: "fake",
        command: process.execPath,
        args: [
          FAKE_ENGINE,
          "--run-actions",
          JSON.stringify([{ op: "askUser", request: { method: "select", id: "q1" } }]),
        ],
        hostKind: "test",
        dataDir,
        envPrefixes: [],
      });
      try {
        const seen: string[] = [];
        setHostUiRequestEndpoint(async (req) => {
          seen.push(req.id);
          return { value: "late-registered" };
        });
        const outcome = await runAskUser(client, "run-1", { method: "select", id: "q1" });
        expect(seen).toEqual(["q1"]);
        expect(askUserEcho(outcome)).toContain('"value":"late-registered"');
      } finally {
        await client.dispose();
      }
    });

    it("同一 EngineClient 存活期换槽（adoption 形态）→ 后续反向请求路由到新 handler", async () => {
      const client = new EngineClient({
        engineId: "fake",
        command: process.execPath,
        args: [
          FAKE_ENGINE,
          "--run-actions",
          // fake-engine 串行播放且 askUser 等应答才继续——两个 askUser 之间隔着一次
          // 真实 IO 往返，宿主在第一应答前换槽零竞态
          JSON.stringify([
            { op: "askUser", request: { method: "select", id: "q-old" } },
            { op: "askUser", request: { method: "confirm", id: "q-new" } },
          ]),
        ],
        hostKind: "test",
        dataDir,
        envPrefixes: [],
      });
      try {
        const answeredBy: Array<{ id: string; handler: string }> = [];
        // 旧 handler（模拟 reload 前的 ctx 应答端）：应答第一次请求，并在应答内换槽
        // ——等价生产 adoption 只更新槽、不重建 EngineClient 的形态
        setHostUiRequestEndpoint(async (req) => {
          answeredBy.push({ id: req.id, handler: "old" });
          setHostUiRequestEndpoint(async (req2) => {
            answeredBy.push({ id: req2.id, handler: "new" });
            return { value: "answer-after-adoption" };
          });
          return { value: "answer-before-reload" };
        });
        const events: Array<{ type: string; message?: string }> = [];
        const unregister = client.registerRunRoute("run-1", {
          onEvent: (e) => {
            events.push(e as { type: string; message?: string });
          },
        });
        try {
          await client.ensureConnected();
          await client.request("run", {
            runId: "run-1",
            task: { prompt: "p" },
            ctx: { poolKey: "shared", cwd: dataDir },
          });
        } finally {
          unregister();
        }
        expect(answeredBy).toEqual([
          { id: "q-old", handler: "old" },
          { id: "q-new", handler: "new" }, // 槽更新对已构造单例可见 = 现读语义
        ]);
        const echoes = events
          .filter((e) => e.message?.startsWith("askUser-result:"))
          .map((e) => e.message);
        expect(echoes[0]).toContain('"value":"answer-before-reload"');
        expect(echoes[1]).toContain('"value":"answer-after-adoption"');
      } finally {
        await client.dispose();
      }
    });

    it("窗口内旧 handler 抛 assertActive（reload 间隙形态）→ 降级 {cancelled:true}，不崩不误报 unsupported", async () => {
      // 设计 §5 单测清单项（D3 检查点补全）：reload 窗口内（invalidate → adoption 完成）
      // 槽上仍是旧 ctx 的 handler，其应答链触碰旧 pi 命中 assertActive——结构性 catch
      // 须把该形态降级为 {cancelled:true}（dialog-queue 应答链同款语义）：引擎侧收到
      // cancelled 后子进程可继续推进（非死锁、非崩溃），warn 留痕供归因。
      const client = new EngineClient({
        engineId: "fake",
        command: process.execPath,
        args: [
          FAKE_ENGINE,
          "--run-actions",
          JSON.stringify([{ op: "askUser", request: { method: "select", id: "q-stale" } }]),
        ],
        hostKind: "test",
        dataDir,
        envPrefixes: [],
      });
      try {
        setHostUiRequestEndpoint(async () => {
          throw new Error("session context is no longer active (assertActive)");
        });
        const outcome = await runAskUser(client, "run-1", { method: "select", id: "q-stale" });
        // 引擎 echo 的应答形态必须是 cancelled（unsupported = 槽空形态；崩 = 无 echo）
        expect(askUserEcho(outcome)).toContain('"cancelled":true');
      } finally {
        await client.dispose();
      }
    });
  });
});

// ── 来源区块：host-askuser-endpoint.test.ts ────────────────────────────────────────────────
describe("host-askuser-endpoint", () => {
  const FAKE_ENGINE = fileURLToPath(
    new URL("./__fixtures__/fake-engine.mjs", import.meta.url),
  );

  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "w6-host-askuser-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    _resetHostUiRequestEndpointForTest();
  });

  describe("host/askUser 壳侧应答端（W6 R3 MF-A 集成断言）", () => {
    it("fake 引擎经 host/askUser 反向请求 → 壳侧登记 handler 应答（ack 先行 + 结果异步补帧②）", async () => {
      // ① 壳侧登记（生产 = SubagentService init/initSession.uiRequestHandler 写点同步登记）
      const seenRequests: Array<{ method: string; id: string }> = [];
      setHostUiRequestEndpoint(async (req) => {
        seenRequests.push({ method: req.method, id: req.id });
        return { value: "host-answer" };
      });

      // ② EngineClient 构造（无应答端传参——[D3] reverse-router 消费时经槽现读）
      const client = new EngineClient({
        engineId: "fake",
        command: process.execPath,
        args: [
          FAKE_ENGINE,
          "--run-actions",
          JSON.stringify([
            { op: "askUser", request: { method: "select", id: "q1", title: "pick" } },
          ]),
        ],
        hostKind: "test",
        hostVersion: "test-host-1.0",
        dataDir,
        envPrefixes: [],
      });

      const events: Array<{ type: string; message?: string }> = [];
      const unregister = client.registerRunRoute("run-1", {
        onEvent: (e) => {
          events.push(e as { type: string; message?: string });
        },
      });
      try {
        await client.ensureConnected();
        await client.request("run", {
          runId: "run-1",
          task: { prompt: "p" },
          ctx: { poolKey: "shared", cwd: dataDir },
        });
      } finally {
        unregister();
        await client.dispose();
      }

      // ③ 壳侧收到请求（形状 = dialog-queue UiRequest）
      expect(seenRequests).toEqual([{ method: "select", id: "q1" }]);
      // ④ 引擎收到应答（fake-engine 把 host/askUser 应答 echo 成 event；ack 先行语义
      //    由 client/__tests__/engine-client.test.ts 的 ack 两阶段用例锁定）
      const echo = events.find((e) => e.message?.startsWith("askUser-result:"));
      expect(echo?.message).toContain('"value":"host-answer"');
    });

    it("登记处为空（未注入 handler）→ 引擎收 {unsupported:true} 自行降级（不炸链路）", async () => {
      const client = new EngineClient({
        engineId: "fake",
        command: process.execPath,
        args: [
          FAKE_ENGINE,
          "--run-actions",
          JSON.stringify([{ op: "askUser", request: { method: "confirm", id: "q2" } }]),
        ],
        hostKind: "test",
        dataDir,
        envPrefixes: [],
      });
      const events: Array<{ type: string; message?: string }> = [];
      const unregister = client.registerRunRoute("run-1", {
        onEvent: (e) => {
          events.push(e as { type: string; message?: string });
        },
      });
      try {
        await client.ensureConnected();
        await client.request("run", {
          runId: "run-1",
          task: { prompt: "p" },
          ctx: { poolKey: "shared", cwd: dataDir },
        });
      } finally {
        unregister();
        await client.dispose();
      }
      const echo = events.find((e) => e.message?.startsWith("askUser-result:"));
      expect(echo?.message).toContain('"unsupported":true');
    });
  });
});
