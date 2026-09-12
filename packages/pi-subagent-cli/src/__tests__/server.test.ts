// server.test.ts —— EngineProtocolServer 直测（照 zcode-subagent-cli/src/__tests__/
// server.test.ts 形态，两包同构代码测试面对齐——review round1 MF-2）。
//
// engine = EnginePort 内存 fake（无子进程 / 无真实数据目录——本文件零 fs 触碰），
// stdout 写入面注入内存 sink。覆盖：
//   ① 帧分类路由：请求帧分发 / 反向应答落位 / 入站反向请求 bad_frame / 坏帧静默；
//   ② 9 正向方法表驱动路由（逐方法 → EnginePort 成员；[H1 U5] interact 已退役）+
//      未知方法 engine_protocol_unknown_method（错误原文含方法名与 request id）；
//   ③ run 协议载荷还原：ctx.model 合回 task / ctxModel canonical 词形解析 /
//      streamMode onDelta → host/streamDelta / 事件通知 seq 单调 / cancel abort /
//      onChildSpawned 记录键锚定（非 chat = runId，chat = recordId）；
//   ④ pi 专有通道：bindAskUser 两阶段绑定体（run 前绑定 + run 结束解绑；[H1 U3]
//      会话形态轮 = run 派发形态同走 per-run 绑定）、run.resume recordId 前置校验 +
//      conversation 能力位 gate（[H1 U5] bindHostChannels 构造期三分通道面已随
//      chat-session.ts 删除）；
//   ⑤ 反向请求客户端：rev-N 帧形状 / {ack:true} 两阶段第一段只 ack 不终结等待
//      （R9-2，zcode 姊妹包无此语义）/ result+error 应答落位 / 超时兜底（fake timers）。

import { describe, expect, it, vi, type Mock } from "vitest";

import {
  ENGINE_PROTOCOL_VERSION,
  type AgentEvent,
  type EngineCapabilities,
  type EngineHandleData,
  type InitializeParams,
  type ProbeReport,
  type SessionView,
  type UiRequest,
  type UiResponse,
} from "@zhushanwen/subagent-engine-sdk";

import { EngineProtocolServer } from "../server.ts";
import { PI_ADAPTER_VERSION } from "../constants.ts";
import type { AgentCallOpts, EnginePort, EngineRunResult, RunContext } from "../port-types.ts";

// ── fixture（合成的引擎数据形态；sessionFile 等路径只是内存字符串，无 fs 语义）──

const CAPABILITIES: EngineCapabilities = {
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

const HANDLE: EngineHandleData = {
  v: 1,
  engineId: "pi",
  sessionRef: { recordId: "rec_server_test_1", sessionFile: "/tmp/fake-pi-session.jsonl" },
  poolKey: "shared",
  adapterVersion: PI_ADAPTER_VERSION,
};

const PROBE_REPORT: ProbeReport = {
  ok: true,
  engineVersion: "9.9.9-fake",
  checks: [{ name: "binary", ok: true }],
};

const SESSION_VIEW: SessionView = { engineId: "pi", turns: [], source: "native" };

const INIT_PARAMS: InitializeParams = {
  protocolVersion: ENGINE_PROTOCOL_VERSION,
  hostInfo: { name: "vitest-server-test", version: "0.0.0", dataRoot: "/tmp/fake-host-root" },
  engineConfig: {},
};

const FAKE_OUTCOME = { content: "你好", exitCode: 0, engineId: "pi", sessionId: HANDLE.sessionRef.recordId };

interface OutFrame {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: string; message: string; recovery: string };
}

// ── 测试基建 ──

/** 内存帧 sink：收集全部出站帧 + 轮询等待目标帧（dispatch 应答在微任务后写回）。 */
function makeSink() {
  const frames: OutFrame[] = [];
  return {
    frames,
    write: (frame: unknown): void => {
      frames.push(frame as OutFrame);
    },
    async waitFor(pred: (f: OutFrame) => boolean, what: string, timeoutMs = 2_000): Promise<OutFrame> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = frames.find(pred);
        if (hit !== undefined) return hit;
        if (Date.now() > deadline) {
          throw new Error(`frame not observed within ${timeoutMs}ms: ${what}; frames=${JSON.stringify(frames)}`);
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    },
  };
}

/** EnginePort 内存 fake（含 pi 专有 bindAskUser 绑定面）：
 * 逐成员 vi.fn，overrides 直替换（undefined = 未实现分支）。 */
type FakeEngine = EnginePort & {
  bindAskUser(handler: ((req: UiRequest) => Promise<UiResponse>) | undefined): void;
};

function makeEngine(overrides: Partial<FakeEngine> = {}): FakeEngine {
  const base: FakeEngine = {
    id: "pi",
    capabilities: vi.fn((): EngineCapabilities => ({ ...CAPABILITIES })),
    probe: vi.fn(async (): Promise<ProbeReport> => ({ ...PROBE_REPORT })),
    run: vi.fn(async (_task: AgentCallOpts, _ctx: RunContext): Promise<EngineRunResult> => {
      return { handle: { data: { ...HANDLE } }, outcome: { ...FAKE_OUTCOME } };
    }),
    read: vi.fn(async (): Promise<SessionView> => ({ ...SESSION_VIEW })),
    listModels: vi.fn((): Array<{ id: string; name?: string }> => [{ id: "prov/m1", name: "M1" }]),
    validateModel: vi.fn((modelRef: string | undefined) => ({ canonicalRef: modelRef ?? "" })),
    dispose: vi.fn(async (): Promise<void> => undefined),
    bindAskUser: vi.fn((_handler: ((req: UiRequest) => Promise<UiResponse>) | undefined): void => undefined),
  };
  return { ...base, ...overrides };
}

/** 组合一个 server（缺省 clock 记录面 + 内存 sink），返回全部观测点。 */
function makeServer(engine = makeEngine(), reverseTimeoutMs?: number) {
  const sink = makeSink();
  const clockCalls: Array<{ op: string; id: string }> = [];
  const server = new EngineProtocolServer({
    write: sink.write,
    engine,
    reverseClock: {
      started: (id: string) => clockCalls.push({ op: "started", id }),
      acked: (id: string) => clockCalls.push({ op: "acked", id }),
      settled: (id: string) => clockCalls.push({ op: "settled", id }),
      dispose: () => clockCalls.push({ op: "dispose", id: "-" }),
    },
    ...(reverseTimeoutMs !== undefined ? { reverseTimeoutMs } : {}),
  });
  return { server, sink, engine, clockCalls };
}

/** 发一帧请求并等对应 id 的应答帧（result/error 二选一）。 */
async function request(
  server: EngineProtocolServer,
  sink: ReturnType<typeof makeSink>,
  id: number,
  method: string,
  params?: unknown,
): Promise<OutFrame> {
  server.handleFrame(params === undefined ? { id, method } : { id, method, params });
  return sink.waitFor(
    (f) => f.id === id && (f.result !== undefined || f.error !== undefined),
    `response#${id} ${method}`,
  );
}

// ── 帧分类路由 ──

describe("handleFrame 帧分类路由", () => {
  it("请求帧（数字 id）→ 分发到 handler 并写回 {id, result}", async () => {
    const { server, sink } = makeServer();
    const resp = await request(server, sink, 1, "ping", {});
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ pong: true });
  });

  it("未知方法 → engine_protocol_unknown_method（错误原文含方法名与 request id 回显）", async () => {
    const { server, sink } = makeServer();
    const resp = await request(server, sink, 42, "host/greet", {});
    expect(resp.error?.code).toBe("engine_protocol_unknown_method");
    expect(resp.error?.message).toContain("unknown protocol method: host/greet");
    expect(resp.error?.message).toContain("request id 42");
    expect(resp.error?.recovery).toContain("protocol v1");
  });

  it("handler 抛普通 Error → engine_run_failed + 恢复指引（非结构化错误兜底）", async () => {
    const engine = makeEngine({ probe: vi.fn(async (): Promise<ProbeReport> => { throw new Error("boom"); }) });
    const { server, sink } = makeServer(engine);
    const resp = await request(server, sink, 5, "probe", {});
    expect(resp.error?.code).toBe("engine_run_failed");
    expect(resp.error?.message).toBe("boom");
    expect(resp.error?.recovery).toContain("logs");
  });

  it("入站反向请求帧 → engine_protocol_bad_frame（id 0）且不断流", async () => {
    const { server, sink } = makeServer();
    server.handleFrame({ id: "h-9", method: "host/askUser", params: {} });
    const bad = await sink.waitFor((f) => f.id === 0, "bad_frame");
    expect(bad.error?.code).toBe("engine_protocol_bad_frame");
    expect(bad.error?.message).toContain("host/askUser");
    const ping = await request(server, sink, 1, "ping", {});
    expect(ping.result).toEqual({ pong: true });
  });

  it("无法归类的帧静默忽略（stdout 协议通道独占，不回显坏帧）", () => {
    const { server, sink } = makeServer();
    server.handleFrame({});
    server.handleFrame("raw string");
    server.handleFrame({ id: 3, method: 42 });
    server.handleFrame({ id: "x" });
    expect(sink.frames).toHaveLength(0);
  });

  it("应答帧 id 无在途反向请求 → 静默忽略不抛", () => {
    const { server, sink } = makeServer();
    expect(() => server.handleFrame({ id: "rev-ghost", result: { ok: true } })).not.toThrow();
    expect(sink.frames).toHaveLength(0);
  });
});

// ── 10 正向方法分发表 ──

describe("dispatchTable 表驱动路由（逐方法 → EnginePort 成员）", () => {
  it("initialize：版本协商 + 能力/模型目录应答（models 投影仅 id）", async () => {
    const engine = makeEngine();
    const { server, sink } = makeServer(engine);
    const resp = await request(server, sink, 1, "initialize", INIT_PARAMS);
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      engineId: "pi",
      engineVersion: PI_ADAPTER_VERSION,
      adapterVersion: PI_ADAPTER_VERSION,
      capabilities: CAPABILITIES,
      models: [{ id: "prov/m1" }],
    });
  });

  it("initialize：引擎无 listModels → 应答不含 models 键（null 与省略语义区分）", async () => {
    const { server, sink } = makeServer(makeEngine({ listModels: undefined }));
    const resp = await request(server, sink, 1, "initialize", INIT_PARAMS);
    expect(resp.error).toBeUndefined();
    expect(Object.keys(resp.result as object)).not.toContain("models");
  });

  it("initialize 版本越界 → engine_protocol_mismatch（含双方版本与升级指引）", async () => {
    const { server, sink } = makeServer();
    const resp = await request(server, sink, 1, "initialize", { ...INIT_PARAMS, protocolVersion: 99 });
    expect(resp.error?.code).toBe("engine_protocol_mismatch");
    expect(resp.error?.message).toContain("99");
    expect(resp.error?.message).toContain(`v${ENGINE_PROTOCOL_VERSION}`);
  });

  it("probe：对象 params 透传（force 面）；缺省/非对象 params → undefined", async () => {
    const engine = makeEngine();
    const { server, sink } = makeServer(engine);
    const r1 = await request(server, sink, 1, "probe", { force: true });
    expect(r1.result).toEqual(PROBE_REPORT);
    expect(vi.mocked(engine.probe)).toHaveBeenLastCalledWith({ force: true });

    await request(server, sink, 2, "probe");
    expect(vi.mocked(engine.probe)).toHaveBeenLastCalledWith(undefined);

    await request(server, sink, 3, "probe", "not-an-object");
    expect(vi.mocked(engine.probe)).toHaveBeenLastCalledWith(undefined);
  });

  it("run 先于 initialize → engine_protocol_not_initialized（握手前置门）", async () => {
    const { server, sink } = makeServer();
    const resp = await request(server, sink, 1, "run", {
      runId: "r-early",
      task: { prompt: "p" },
      ctx: { poolKey: "shared", cwd: "/w" },
    });
    expect(resp.error?.code).toBe("engine_protocol_not_initialized");
  });

  it("listModels：引擎有枚举面 → {models}；未实现 → {models:null}", async () => {
    const engine = makeEngine();
    const { server, sink } = makeServer(engine);
    const r1 = await request(server, sink, 1, "listModels", {});
    expect(r1.result).toEqual({ models: [{ id: "prov/m1", name: "M1" }] });

    const second = makeServer(makeEngine({ listModels: undefined }));
    const r2 = await request(second.server, second.sink, 1, "listModels", {});
    expect(r2.result).toEqual({ models: null });
  });

  it("validateModel：透传 modelRef；引擎未实现 → engine_capability_unsupported", async () => {
    const engine = makeEngine();
    const { server, sink } = makeServer(engine);
    const r1 = await request(server, sink, 1, "validateModel", { modelRef: "prov/m1" });
    expect(r1.result).toEqual({ canonicalRef: "prov/m1" });
    expect(vi.mocked(engine.validateModel!)).toHaveBeenLastCalledWith("prov/m1");

    const second = makeServer(makeEngine({ validateModel: undefined }));
    const r2 = await request(second.server, second.sink, 1, "validateModel", {});
    expect(r2.error?.code).toBe("engine_capability_unsupported");
  });

  it("read：handle 以 {data} 包装传给引擎（协议面裸 handle）", async () => {
    const engine = makeEngine();
    const { server, sink } = makeServer(engine);
    const r2 = await request(server, sink, 2, "read", { handle: HANDLE, dataDir: "/d" });
    expect(r2.result).toEqual(SESSION_VIEW);
    expect(vi.mocked(engine.read)).toHaveBeenLastCalledWith({ data: HANDLE });
  });

  it("dispose：引擎释放被调用且返回 {ok:true}；引擎未实现 dispose 仍 ok（幂等）", async () => {
    const engine = makeEngine();
    const { server, sink } = makeServer(engine);
    const r1 = await request(server, sink, 1, "dispose", {});
    expect(r1.result).toEqual({ ok: true });
    expect(vi.mocked(engine.dispose!)).toHaveBeenCalledTimes(1);

    const second = makeServer(makeEngine({ dispose: undefined }));
    const r2 = await request(second.server, second.sink, 1, "dispose", {});
    expect(r2.result).toEqual({ ok: true });
  });
});

// ── run 协议载荷还原 + 事件/反向通道 ──

describe("run：协议载荷 → 本地 AgentCallOpts/RunContext", () => {
  it("全字段还原：ctx.model 合回 task、ctxModel 解析、streamMode、反向通道、事件 seq 单调、终态拆包", async () => {
    let captured: { task: AgentCallOpts; ctx: RunContext } | undefined;
    const engine = makeEngine({
      run: vi.fn(async (task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> => {
        captured = { task, ctx };
        ctx.onPoolResolved?.("shared");
        ctx.onHandleReady?.({ sessionRef: HANDLE.sessionRef, poolKey: HANDLE.poolKey });
        ctx.onEvent?.({ type: "text_delta", delta: "你好" } satisfies AgentEvent);
        ctx.onEvent?.({ type: "message_end", usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 } });
        ctx.stream?.onDelta("你好");
        return { handle: { data: { ...HANDLE } }, outcome: { ...FAKE_OUTCOME } };
      }),
    });
    const { server, sink } = makeServer(engine);
    const init = await request(server, sink, 1, "initialize", INIT_PARAMS);
    expect(init.error).toBeUndefined();

    server.handleFrame({
      id: 2,
      method: "run",
      params: {
        runId: "run-1",
        task: { prompt: "做点什么", denyTools: ["bash"] },
        ctx: {
          poolKey: "shared",
          cwd: "/w",
          model: "prov/m1",
          ctxModel: "prov/ctx-model",
          streamMode: "stream",
          schemaEnv: "PI_WORKFLOW_SCHEMA=1",
          engineFallback: { from: "zcode", reason: "manifest" },
          sessionRootId: "root-sess-9",
          sessionDir: "/host/agent-dir/subagents/--Users-x-proj--/sessions",
        },
      },
    });

    // host/poolResolved 先于首个事件（journal 归属契约），载荷 runId 关联
    const pool = await sink.waitFor((f) => f.method === "host/poolResolved", "poolResolved");
    server.handleFrame({ id: pool.id, result: { ok: true } });
    expect(pool.params).toEqual({ runId: "run-1", poolKey: "shared" });

    const ready = await sink.waitFor((f) => f.method === "host/handleReady", "handleReady");
    server.handleFrame({ id: ready.id, result: { ok: true } });
    expect(ready.params).toEqual({ runId: "run-1", sessionRef: HANDLE.sessionRef, poolKey: "shared" });

    const delta = await sink.waitFor((f) => f.method === "host/streamDelta", "streamDelta");
    server.handleFrame({ id: delta.id, result: { ok: true } });
    expect(delta.params).toEqual({ runId: "run-1", delta: "你好" });

    // 事件通知：runId 关联 + seq 单调递增
    const ev1 = await sink.waitFor((f) => f.method === "event", "event#1");
    const ev2 = await sink.waitFor((f) => f.method === "event" && f !== ev1, "event#2");
    const p1 = ev1.params as { runId: string; seq: number; event: AgentEvent };
    const p2 = ev2.params as { runId: string; seq: number; event: AgentEvent };
    expect(p1).toMatchObject({ runId: "run-1", seq: 1, event: { type: "text_delta", delta: "你好" } });
    expect(p2).toMatchObject({ runId: "run-1", seq: 2, event: { type: "message_end" } });

    // 本地全量 task 还原（ctx.model 合回；task 其余字段透传）+ RunContext 断言
    expect(captured?.task).toEqual({ prompt: "做点什么", denyTools: ["bash"], model: "prov/m1" });
    expect(captured?.ctx.taskId).toBe("run-1");
    expect(captured?.ctx.poolKey).toBe("shared");
    expect(captured?.ctx.ctxModel).toEqual({ provider: "prov", id: "ctx-model" });
    expect(captured?.ctx.schemaEnv).toBe("PI_WORKFLOW_SCHEMA=1");
    expect(captured?.ctx.engineFallback).toEqual({ from: "zcode", reason: "manifest" });
    expect(captured?.ctx.sessionRootId).toBe("root-sess-9");
    // [Option C 协议化] ctx.sessionDir 还原透传（宿主权威值，引擎不自推导）
    expect(captured?.ctx.sessionDir).toBe("/host/agent-dir/subagents/--Users-x-proj--/sessions");
    expect(captured?.ctx.stream).toBeDefined();
    expect(captured?.ctx.signal).toBeInstanceOf(AbortSignal);
    expect(captured?.ctx.resume).toBeUndefined();

    // 一次性 run：onChildSpawned 以 runId 锚定；pid 缺省不发包
    captured?.ctx.onChildSpawned?.({ pid: 4242, killed: false });
    const spawned = await sink.waitFor((f) => f.method === "host/childSpawned", "childSpawned");
    expect(spawned.params).toEqual({ pid: 4242, recordId: "run-1" });
    const spawnedCount = sink.frames.filter((f) => f.method === "host/childSpawned").length;
    captured?.ctx.onChildSpawned?.({ pid: undefined, killed: false });
    expect(sink.frames.filter((f) => f.method === "host/childSpawned")).toHaveLength(spawnedCount);

    // [SR-4] onChildStateChanged：只有 exited 发帧（宿主镜像据此取消该 pid 的挂起 dialog）；
    // running 由 childSpawned 覆盖，不发重复帧
    const stateChangedCount = sink.frames.filter((f) => f.method === "host/childStateChanged").length;
    captured?.ctx.onChildStateChanged?.({ pid: 4242, recordId: "run-1", state: "running", killed: false });
    expect(sink.frames.filter((f) => f.method === "host/childStateChanged")).toHaveLength(stateChangedCount);

    captured?.ctx.onChildStateChanged?.({
      pid: 4242, recordId: "run-1", state: "exited", killed: true, exitCode: 1,
    });
    const exitedFrame = await sink.waitFor((f) => f.method === "host/childStateChanged", "childStateChanged");
    expect(exitedFrame.params).toEqual({
      pid: 4242, recordId: "run-1", state: "exited", killed: true, exitCode: 1,
    });

    // 反向请求必须先于事件到达（journal 归属契约的帧序证据）
    expect(sink.frames.indexOf(pool)).toBeLessThan(sink.frames.indexOf(ev1));

    // 终态应答：进程内 {data} 包装拆掉（协议 RunResult.handle = EngineHandleData 本体）
    const resp = await sink.waitFor(
      (f) => f.id === 2 && (f.result !== undefined || f.error !== undefined),
      "run response",
    );
    expect(resp.result).toEqual({ handle: HANDLE, outcome: FAKE_OUTCOME });
  });

  it("ctxModel 归一：空串/空白/无斜杠/前导斜杠/尾斜杠 → undefined（parseCtxModel 边界）", async () => {
    const engine = makeEngine();
    const { server, sink } = makeServer(engine);
    await request(server, sink, 0, "initialize", INIT_PARAMS);

    const malformed = ["", "   ", "noprovider", "/leading", "prov/"] as const;
    for (const [i, ref] of malformed.entries()) {
      server.handleFrame({
        id: 10 + i,
        method: "run",
        params: { runId: `r-${i}`, task: { prompt: "p" }, ctx: { poolKey: "shared", cwd: "/w", ctxModel: ref } },
      });
      const resp = await sink.waitFor(
        (f) => f.id === 10 + i && (f.result !== undefined || f.error !== undefined),
        `run#${i}`,
      );
      expect(resp.error, `ctxModel=${JSON.stringify(ref)} 不应报错`).toBeUndefined();
      const ctx = (engine.run as Mock).mock.calls[i]?.[1] as RunContext;
      expect(ctx.ctxModel, `ctxModel=${JSON.stringify(ref)} 应归一为 undefined`).toBeUndefined();
    }
  });

  it("[F6] ctx.sessionRootId 缺省 → 还原后的 RunContext 无该键（additive 语义，relay 权威源缺省不注入）", async () => {
    const engine = makeEngine();
    const { server, sink } = makeServer(engine);
    await request(server, sink, 0, "initialize", INIT_PARAMS);
    await request(server, sink, 20, "run", {
      runId: "run-f6",
      task: { prompt: "p" },
      ctx: { poolKey: "shared", cwd: "/w" },
    });
    const ctx = (engine.run as Mock).mock.calls[0]?.[1] as RunContext;
    expect(ctx).not.toHaveProperty("sessionRootId");
  });

  it("cancel：活跃 run 的 signal 被 abort（reason 透传）；收尾后 cancel 幂等 ok；迟到事件 seq 回落 0", async () => {
    let capturedCtx: RunContext | undefined;
    let release!: (value: EngineRunResult) => void;
    const engine = makeEngine({
      run: vi.fn((_task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> => {
        capturedCtx = ctx;
        return new Promise<EngineRunResult>((resolve) => {
          release = resolve;
        });
      }),
    });
    const { server, sink } = makeServer(engine);
    await request(server, sink, 1, "initialize", INIT_PARAMS);

    server.handleFrame({
      id: 2,
      method: "run",
      params: { runId: "run-c", task: { prompt: "p" }, ctx: { poolKey: "shared", cwd: "/w" } },
    });
    await vi.waitFor(() => expect(capturedCtx).toBeDefined());

    const cancelResp = await request(server, sink, 3, "cancel", { runId: "run-c", reason: "host timeout" });
    expect(cancelResp.result).toEqual({ ok: true });
    expect(capturedCtx?.signal?.aborted).toBe(true);
    expect((capturedCtx?.signal?.reason as Error).message).toContain("cancelled by host: host timeout");

    // 释放 run（activeRuns 清理路径）→ 终态应答照常写回
    release({ handle: { data: { ...HANDLE } }, outcome: { ...FAKE_OUTCOME } });
    const resp = await sink.waitFor((f) => f.id === 2 && f.result !== undefined, "run response");
    expect(resp.error).toBeUndefined();

    // 已收尾 runId 再 cancel → 无活跃登记，仍受理 ok
    const lateCancel = await request(server, sink, 4, "cancel", { runId: "run-c", reason: "late" });
    expect(lateCancel.result).toEqual({ ok: true });

    // 引擎迟到事件：无活跃登记 → seq 回落 0（通知照发，不丢事件）
    capturedCtx?.onEvent?.({ type: "turn_end" });
    const late = await sink.waitFor((f) => f.method === "event", "late event");
    expect(late.params).toMatchObject({ runId: "run-c", seq: 0 });
  });
});

// ── pi 专有：askUser 绑定面 + run.resume 帧校验 ──

describe("bindAskUser 两阶段绑定体（pi 专有）", () => {
  it("非 chat run：run 前绑定 askUser 等待体（host/askUser 载荷 {runId, request}），run 结束解绑", async () => {
    let release!: (value: EngineRunResult) => void;
    const engine = makeEngine({
      run: vi.fn((_task: AgentCallOpts, _ctx: RunContext): Promise<EngineRunResult> =>
        new Promise<EngineRunResult>((resolve) => {
          release = resolve;
        })),
    });
    const { server, sink } = makeServer(engine);
    await request(server, sink, 1, "initialize", INIT_PARAMS);

    server.handleFrame({
      id: 2,
      method: "run",
      params: { runId: "run-ask", task: { prompt: "p" }, ctx: { poolKey: "shared", cwd: "/w" } },
    });
    await vi.waitFor(() => expect(vi.mocked(engine.bindAskUser)).toHaveBeenCalledTimes(1));
    const handler = vi.mocked(engine.bindAskUser).mock.calls[0]![0]!;
    expect(handler).toBeTypeOf("function");

    // run 期间经等待体发 askUser → host/askUser 反向帧（runId 关联）
    const req: UiRequest = { method: "select", id: "ui-1", title: "选一个" };
    const answerP = handler(req);
    const ask = await sink.waitFor((f) => f.method === "host/askUser", "askUser frame");
    expect(ask.params).toEqual({ runId: "run-ask", request: req });
    server.handleFrame({ id: ask.id, result: { value: "A" } });
    await expect(answerP).resolves.toEqual({ value: "A" });

    // run 结束（finally）：bindAskUser(undefined) 解绑，防跨 run 串扰
    release({ handle: { data: { ...HANDLE } }, outcome: { ...FAKE_OUTCOME } });
    await sink.waitFor((f) => f.id === 2 && f.result !== undefined, "run response");
    expect(vi.mocked(engine.bindAskUser)).toHaveBeenLastCalledWith(undefined);
  });

  it("chat run：同走 per-run 绑定（[H1 U3] 每轮一进程，run 结束解绑）；recordId 锚定镜像帧", async () => {
    let release!: (value: EngineRunResult) => void;
    const engine = makeEngine({
      run: vi.fn((_task: AgentCallOpts, _ctx: RunContext): Promise<EngineRunResult> =>
        new Promise<EngineRunResult>((resolve) => {
          release = resolve;
        })),
    });
    const { server, sink } = makeServer(engine);
    await request(server, sink, 1, "initialize", INIT_PARAMS);

    server.handleFrame({
      id: 2,
      method: "run",
      params: {
        runId: "run-chat",
        task: { prompt: "hi", conversation: true },
        ctx: { poolKey: "shared", cwd: "/w" },
        resume: { recordId: "rec-chat-9" },
      },
    });
    await vi.waitFor(() => expect(vi.mocked(engine.bindAskUser)).toHaveBeenCalledTimes(1));
    const handler = vi.mocked(engine.bindAskUser).mock.calls[0]![0]!;
    expect(handler).toBeTypeOf("function");

    // 会话形态轮 ctx.resume 透传（引擎读端锚定 recordId）
    const ctx = (engine.run as Mock).mock.calls[0]![1] as RunContext;
    expect(ctx.resume).toEqual({ recordId: "rec-chat-9" });

    // run 期间 askUser 等待体可用（per-run 绑定与 one-shot 同构——chat 轮短命 run）
    const req: UiRequest = { method: "select", id: "ui-2", title: "选一个" };
    const answerP = handler(req);
    const ask = await sink.waitFor((f) => f.method === "host/askUser", "chat askUser frame");
    expect(ask.params).toEqual({ runId: "run-chat", request: req });
    server.handleFrame({ id: ask.id, result: { value: "B" } });
    await expect(answerP).resolves.toEqual({ value: "B" });

    // 会话形态轮 run：onChildSpawned 以 recordId 锚定（区别于一次性 run 的 runId 锚定）
    ctx.onChildSpawned?.({ pid: 777, killed: false });
    const spawned = await sink.waitFor((f) => f.method === "host/childSpawned", "childSpawned");
    expect(spawned.params).toEqual({ pid: 777, recordId: "rec-chat-9" });

    // [SR-4] 会话形态同键锚定：childStateChanged 用 recordId（非 runId）
    ctx.onChildStateChanged?.({ pid: 777, recordId: "rec-chat-9", state: "exited", killed: true });
    const exitedChat = await sink.waitFor((f) => f.method === "host/childStateChanged", "childStateChanged");
    expect(exitedChat.params).toEqual({
      pid: 777, recordId: "rec-chat-9", state: "exited", killed: true,
    });

    // run 结束（finally）：bindAskUser(undefined) 解绑，防跨 run 串扰
    release({ handle: { data: { ...HANDLE } }, outcome: { ...FAKE_OUTCOME } });
    await sink.waitFor((f) => f.id === 2 && f.result !== undefined, "run response");
    expect(vi.mocked(engine.bindAskUser)).toHaveBeenLastCalledWith(undefined);
  });

  it("run.resume 空 recordId → engine_protocol_bad_frame（前置校验，run 不进引擎）", async () => {
    const engine = makeEngine();
    const { server, sink } = makeServer(engine);
    await request(server, sink, 1, "initialize", INIT_PARAMS);
    const resp = await request(server, sink, 2, "run", {
      runId: "run-bad",
      task: { prompt: "p" },
      ctx: { poolKey: "shared", cwd: "/w" },
      resume: { recordId: "" },
    });
    expect(resp.error?.code).toBe("engine_protocol_bad_frame");
    expect(resp.error?.message).toContain("recordId");
    expect(vi.mocked(engine.run)).not.toHaveBeenCalled();
  });

  it("run.resume conversation 位 unsupported 引擎 → engine_capability_unsupported（能力位 gate）", async () => {
    const engine = makeEngine({
      capabilities: vi.fn((): EngineCapabilities => ({ ...CAPABILITIES, conversation: "unsupported" })),
    });
    const { server, sink } = makeServer(engine);
    await request(server, sink, 1, "initialize", INIT_PARAMS);
    const resp = await request(server, sink, 2, "run", {
      runId: "run-gate",
      task: { prompt: "hi", conversation: true },
      ctx: { poolKey: "shared", cwd: "/w" },
      resume: { recordId: "rec-gate" },
    });
    expect(resp.error?.code).toBe("engine_capability_unsupported");
    expect(vi.mocked(engine.run)).not.toHaveBeenCalled();
  });
});

// [H1 U5] bindHostChannels 构造期三分通道接线（streamDelta/轮次相位/会话级
// askUser）已随 chat-session.ts 删除——askUser/runId 键 streamDelta/childStateChanged
// 的 run 域形态断言保留在上方「run：协议载荷还原」与「bindAskUser」用例中。

// ── 反向请求客户端 ──

describe("reverseRequest 客户端", () => {
  it("帧形状（rev-N 单调 id + method/params）+ result 应答落位 + clock started/acked/settled", async () => {
    const { server, sink, clockCalls } = makeServer();
    const p1 = server.reverseRequest("host/log", { message: "hello" });
    const f1 = await sink.waitFor((f) => f.id === "rev-1" && f.method === "host/log", "rev-1");
    expect(f1.params).toEqual({ message: "hello" });
    expect(clockCalls).toEqual([{ op: "started", id: "rev-1" }]);

    server.handleFrame({ id: "rev-1", result: { ok: true } });
    await expect(p1).resolves.toEqual({ ok: true });
    expect(clockCalls).toEqual([
      { op: "started", id: "rev-1" },
      { op: "acked", id: "rev-1" },
      { op: "settled", id: "rev-1" },
    ]);

    // id 单调递增
    const p2 = server.reverseRequest("host/log", {});
    await sink.waitFor((f) => f.id === "rev-2", "rev-2");
    server.handleFrame({ id: "rev-2", result: { ok: true } });
    await expect(p2).resolves.toEqual({ ok: true });
  });

  it("ack 两阶段（R9-2）：{ack:true} 只 ack 计时面不终结等待，最终帧才 settle", async () => {
    const { server, sink, clockCalls } = makeServer();
    const p = server.reverseRequest("host/askUser", { runId: "r", request: { method: "select", id: "1" } });
    await sink.waitFor((f) => f.id === "rev-1", "rev-1");
    expect(clockCalls).toEqual([{ op: "started", id: "rev-1" }]);

    // 第一段：ack 帧 → 仅 acked（移出 in-flight 自灭计时），p 仍 pending
    server.handleFrame({ id: "rev-1", result: { ack: true } });
    expect(clockCalls).toEqual([
      { op: "started", id: "rev-1" },
      { op: "acked", id: "rev-1" },
    ]);
    let settledOrRejected = false;
    void p.then(
      () => { settledOrRejected = true; },
      () => { settledOrRejected = true; },
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(settledOrRejected).toBe(false);

    // 第二段：最终结果帧 → settle + clock.settled。现状断言：settleReverse 对任何
    // 带在途登记的应答帧先调 acked（含终结帧本身）→ 终结帧产生第二次 acked
    // （幂等无害，登记 settleReverse 双 acked 现状，见任务汇报）
    server.handleFrame({ id: "rev-1", result: { value: "picked" } });
    await expect(p).resolves.toEqual({ value: "picked" });
    expect(clockCalls).toEqual([
      { op: "started", id: "rev-1" },
      { op: "acked", id: "rev-1" },
      { op: "acked", id: "rev-1" },
      { op: "settled", id: "rev-1" },
    ]);
  });

  it("error 应答 → reject（文案含 rejected 前缀与结构化 error 帧）", async () => {
    const { server, sink } = makeServer();
    const p = server.reverseRequest("host/askUser", { request: { kind: "select" } });
    await sink.waitFor((f) => f.id === "rev-1", "rev-1");
    server.handleFrame({ id: "rev-1", error: { code: "host_unavailable", message: "no ui", recovery: "retry" } });
    // A8 修复落地（round1 business-logic S1）：toErrorMessage(非 Error object) 改
    // JSON.stringify——结构化 error 帧（含原始 code/message/recovery）直进 reject 文案，
    // 不再退化为 "[object Object]"（与 zcode 包 settleReverse 同批修复）
    await expect(p).rejects.toThrow(
      'reverse request rev-1 rejected: {"code":"host_unavailable","message":"no ui","recovery":"retry"}',
    );
  });

  it("缺省 60s 超时兜底：reject + clock.settled + 迟到应答不再落位（fake timers）", async () => {
    vi.useFakeTimers();
    try {
      const { server, sink, clockCalls } = makeServer();
      const p = server.reverseRequest("host/log", {});
      expect(sink.frames).toHaveLength(1);
      const assertion = expect(p).rejects.toThrow(/host\/log \(rev-1\) timed out after 60000ms/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      expect(clockCalls).toContainEqual({ op: "started", id: "rev-1" });
      expect(clockCalls).toContainEqual({ op: "settled", id: "rev-1" });
      // 迟到应答：pending 已清理 → 无副作用
      const before = sink.frames.length;
      server.handleFrame({ id: "rev-1", result: { ok: true } });
      expect(sink.frames).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
