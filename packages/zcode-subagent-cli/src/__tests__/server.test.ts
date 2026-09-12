// server.test.ts —— EngineProtocolServer 直测（dispatch 表驱动重构后的方法分发
// 单测面；protocol-e2e 走 bin 子进程不计入本包 v8 覆盖率，server.ts 曾整文件 0 覆盖）。
//
// engine = EnginePort 内存 fake（无子进程 / 无真实数据目录——本文件零 fs 触碰），
// stdout 写入面注入内存 sink。覆盖：
//   ① 帧分类路由：请求帧分发 / 反向应答落位 / 入站反向请求 bad_frame / 坏帧静默；
//   ② 10 正向方法表驱动路由（逐方法 → EnginePort 成员）+ 未知方法
//      engine_protocol_unknown_method（错误原文含方法名与 request id）；
//   ③ run 协议载荷还原：ctx.model 合回 task / ctxModel canonical 词形解析 /
//      streamMode onDelta → host/streamDelta / 事件通知 seq 单调 / cancel abort；
//   ④ 反向请求客户端：rev-N 帧形状 / result+error 应答落位 / 超时兜底（fake timers）。

import { describe, expect, it, vi, type Mock } from "vitest";

import {
  ENGINE_PROTOCOL_VERSION,
  type AgentEvent,
  type EngineCapabilities,
  type EngineHandleData,
  type InitializeParams,
  type ProbeReport,
  type SessionView,
} from "@zhushanwen/subagent-engine-sdk";

import { EngineProtocolServer } from "../server.ts";
import { ZCODE_ADAPTER_VERSION } from "../constants.ts";
import type { AgentCallOpts, EnginePort, EngineRunResult, RunContext } from "../port-types.ts";

// ── fixture（合成的引擎数据形态；dbPath 等路径只是内存字符串，无 fs 语义）──

const CAPABILITIES: EngineCapabilities = {
  schemaEnforcement: "emulated",
  steer: "unsupported",
  conversation: "unsupported",
  personaInjection: "prompt",
  eventGranularity: "stream",
  sandbox: "none",
  sessionRead: "full",
  resume: "cold",
  interrupt: "kill-only",
  permissionMode: "native",
  maxTurns: false,
};

const HANDLE: EngineHandleData = {
  v: 1,
  engineId: "zcode",
  sessionRef: { sessionId: "sess_server_test_1", dbPath: "/tmp/fake-zcode-db.sqlite" },
  poolKey: "shared",
  adapterVersion: ZCODE_ADAPTER_VERSION,
};

const PROBE_REPORT: ProbeReport = {
  ok: true,
  engineVersion: "9.9.9-fake",
  checks: [{ name: "binary", ok: true }],
};

const SESSION_VIEW: SessionView = { engineId: "zcode", turns: [], source: "native" };

const INIT_PARAMS: InitializeParams = {
  protocolVersion: ENGINE_PROTOCOL_VERSION,
  hostInfo: { name: "vitest-server-test", version: "0.0.0", dataRoot: "/tmp/fake-host-root" },
  engineConfig: {},
};

const FAKE_OUTCOME = { content: "你好", exitCode: 0, engineId: "zcode", sessionId: HANDLE.sessionRef.sessionId };

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

/** EnginePort 内存 fake：逐成员 vi.fn，overrides 直替换（undefined = 未实现分支）。 */
function makeEngine(overrides: Partial<EnginePort> = {}): EnginePort {
  const base: EnginePort = {
    id: "zcode",
    capabilities: vi.fn((): EngineCapabilities => ({ ...CAPABILITIES })),
    probe: vi.fn(async (): Promise<ProbeReport> => ({ ...PROBE_REPORT })),
    run: vi.fn(async (_task: AgentCallOpts, _ctx: RunContext): Promise<EngineRunResult> => {
      return { handle: { data: { ...HANDLE } }, outcome: { ...FAKE_OUTCOME } };
    }),
    read: vi.fn(async (): Promise<SessionView> => ({ ...SESSION_VIEW })),
    listModels: vi.fn((): Array<{ id: string; name?: string }> => [{ id: "prov/m1", name: "M1" }]),
    validateModel: vi.fn((modelRef: string | undefined) => ({ canonicalRef: modelRef ?? "" })),
    dispose: vi.fn(async (): Promise<void> => undefined),
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

  it("未知方法 → engine_protocol_unknown_method（错误原文含方法名与 request id）", async () => {
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

describe("methodHandlers 表驱动路由（逐方法 → EnginePort 成员）", () => {
  it("initialize：版本协商 + 能力/模型目录应答（models 投影仅 id）", async () => {
    const engine = makeEngine();
    const { server, sink } = makeServer(engine);
    const resp = await request(server, sink, 1, "initialize", INIT_PARAMS);
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      engineId: "zcode",
      engineVersion: ZCODE_ADAPTER_VERSION,
      adapterVersion: ZCODE_ADAPTER_VERSION,
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

  it("probe：对象 params 透传（force 面）；缺省/非对象 params → undefined（probeParamsOf）", async () => {
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
    // [H1 U5] interact dispatch 已随协议方法退役删除（zcode 桩同步移除）
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
          schemaEnv: "SCHEMA_ENV=1",
          engineFallback: { from: "pi", reason: "manifest" },
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
    expect(captured?.ctx.schemaEnv).toBe("SCHEMA_ENV=1");
    expect(captured?.ctx.engineFallback).toEqual({ from: "pi", reason: "manifest" });
    expect(captured?.ctx.stream).toBeDefined();
    expect(captured?.ctx.signal).toBeInstanceOf(AbortSignal);

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

  it("error 应答 → reject（文案含 rejected 前缀与结构化 error 帧）", async () => {
    const { server, sink } = makeServer();
    const p = server.reverseRequest("host/askUser", { request: { kind: "select" } });
    await sink.waitFor((f) => f.id === "rev-1", "rev-1");
    server.handleFrame({ id: "rev-1", error: { code: "host_unavailable", message: "no ui", recovery: "retry" } });
    // A8 修复落地（round1 business-logic S1）：toErrorMessage(非 Error object) 改
    // JSON.stringify——结构化 error 帧（含原始 code/message/recovery）直进 reject 文案，
    // 不再退化为 "[object Object]"（观察登记 server.ts settleReverse，与 pi 包同批修复）
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
