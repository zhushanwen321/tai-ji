// src/server.ts
//
// 引擎协议服务器（W5，impl-plan §2.5「cli 入口」；帧型/方法/错误码权威源 =
// SDK protocol 模块——设计 §3.3）。与 core 侧 W2 EngineClient 互为协议两端：
//
//   core EngineClient（spawn+握手+请求关联+反向路由） ←NDJSON stdio→ 本服务器
//
// 9 正向方法逐个映射到 EnginePort（本地 port-types 镜像）成员；run 期间事件经
// `event` 通知（runId + 单调 seq）外发，onPoolResolved/onHandleReady/stream 经
// host/* 反向请求上抛。run.params.task 是 SDK AgentCallOpts 引擎面子集——model/
// cwd/schemaEnv/engineFallback 从 run.params.ctx 还原进本地 AgentCallOpts/RunContext
// （与 core RemoteEngine.toSdkTaskSubset 的映射互为镜像）。
//
// 反向请求客户端：帧④ {id:"rev-N", method:"host/*", params} 必须应答；每个请求
// 登记进 ReverseRequestClock（armEngineSelfDestruct 的辅助判据面——ack 后等待不计
// in-flight 超时）。数据面应答 {ok:true} / 人机交互两阶段 {ack:true} 的分类按 SDK
// REVERSE_CHANNEL_TIMEOUT_CLASS。
//
// 本单元验收口径（任务书）：协议服务器以「能被 W2 EngineClient 驱动完成
// initialize→run→终态应答往返」为目标；conformance 全套（方法 + 反向通道 +
// 错误帧）归 W10。

import {
  ENGINE_PROTOCOL_VERSION,
  EngineSdkError,
  isResponseFrame,
  isReverseRequestFrame,
  type AgentCallOpts,
  type AgentEvent,
  type EngineHandleData,
  type InitializeParams,
  type InitializeResult,
  type ProbeReport,
  type ReadParams,
  type ReverseRequestClock,
  type ReverseResponseResult,
  type RunParams,
  type SessionView,
} from "@zhushanwen/subagent-engine-sdk";

import { ZCODE_ADAPTER_VERSION } from "./constants.ts";
import { createDefaultZcodeEngine } from "./registration.ts";
import { parseCtxModel, type EnginePort, type EngineStream, type EngineCtxModel, type RunContext } from "./port-types.ts";
import { toErrorMessage } from "./error-message.ts";

/** 出站帧写入面（main.ts 注入 process.stdout；测试注入内存缓冲）。 */
export type FrameWriter = (frame: unknown) => void;

/** 入站帧来源（ readline 已拆行的请求帧 + 反向请求应答帧混流）。 */
export interface EngineProtocolServerOptions {
  /** stdout 写入面（每帧一行 JSON）。 */
  write: FrameWriter;
  /** 引擎实例（缺省 createDefaultZcodeEngine——测试注入 fake/DI 实例）。 */
  engine?: EnginePort;
  /** 反向请求计时面（armEngineSelfDestruct 产物；缺省不计时——测试用）。 */
  reverseClock?: ReverseRequestClock;
  /** 应答等待缺省超时（反向请求两阶段等待上限兜底；默认 REVERSE_TIMEOUT_DEFAULT_MS）。 */
  reverseTimeoutMs?: number;
}

interface ReversePending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** 反向请求应答等待缺省上限（ms）——数据面分类 core 侧 10s，两阶段等待放宽一档兜底。 */
const REVERSE_TIMEOUT_DEFAULT_MS = 60_000;

/** 单个 run 的在途登记（cancel 帧路由 + 事件 seq 计数）。 */
interface ActiveRun {
  controller: AbortController;
  seq: number;
}

/**
 * 引擎协议服务器。生命周期 = 进程生命周期（单引擎实例，无重建面——崩溃重建归
 * core EngineClient：杀进程再 spawn）。dispose 方法释放引擎常驻资源但进程不退出
 * （后续请求仍可服务——引擎进程退出归宿主 / 自灭守卫）。
 */
export class EngineProtocolServer {
  private readonly write: FrameWriter;
  private readonly engine: EnginePort;
  private readonly reverseClock: ReverseRequestClock | undefined;
  private readonly reverseTimeoutMs: number;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly reversePending = new Map<string, ReversePending>();
  private revSeq = 0;
  private initialized = false;

  constructor(opts: EngineProtocolServerOptions) {
    this.write = opts.write;
    this.engine = opts.engine ?? createDefaultZcodeEngine();
    this.reverseClock = opts.reverseClock;
    this.reverseTimeoutMs = opts.reverseTimeoutMs ?? REVERSE_TIMEOUT_DEFAULT_MS;
  }

  /** 入站帧消费（请求帧 + 反向请求应答帧；main.ts 的行解析器拆行后喂入）。 */
  handleFrame(frame: unknown): void {
    if (isResponseFrame(frame)) {
      this.settleReverse(frame.id, frame);
      return;
    }
    if (isReverseRequestFrame(frame)) {
      // 引擎侧不接收反向请求（本进程是引擎，不发 host/* 给对面以外的角色）——协议
      // 面唯一合法入站 = ①请求 + 反向应答；坏帧 warn 不断流（对端 EngineClient 同款纪律）。
      this.write({
        id: 0,
        error: {
          code: "engine_protocol_bad_frame",
          message: `unexpected reverse request frame from host: ${String(frame.method)}`,
          recovery: "The engine protocol v1 only carries host/* requests engine→host.",
        },
      });
      return;
    }
    if (
      typeof frame === "object" && frame !== null && "id" in frame && "method" in frame &&
      typeof (frame as { method: unknown }).method === "string"
    ) {
      const { id, method, params } = frame as { id: unknown; method: string; params?: unknown };
      if (typeof id === "number") {
        void this.dispatch(id, method, params).then(
          (result) => this.write({ id, result }),
          (err) => this.write({ id, error: toProtocolError(err) }),
        );
        return;
      }
    }
    // 无法归类的帧：静默忽略（stdout 是独占协议通道，不回显坏帧防对端解析器混乱）。
  }

  /** 9 正向方法分发（表驱动：method → 处理器；未知方法 → engine_protocol_unknown_method）。 */
  private async dispatch(id: number, method: string, params: unknown): Promise<unknown> {
    const handler = this.methodHandlers[method];
    if (handler === undefined) {
      throw new EngineSdkError(
        "engine_protocol_unknown_method",
        `unknown protocol method: ${method} (request id ${id})`,
        "The engine speaks protocol v1; check the installed engine package version vs the host.",
      );
    }
    return handler(params);
  }

  /**
   * 9 正向方法 → 处理器映射（每个处理器消费原始 params 并自行收敛类型——
   * 与原 switch case 表达式一一对应）。
   */
  private readonly methodHandlers: Record<string, (params: unknown) => unknown> = {
    initialize: (p) => this.initialize(p as InitializeParams),
    probe: (p) => this.engine.probe(probeParamsOf(p)) as Promise<ProbeReport>,
    run: (p) => this.run(p as RunParams),
    cancel: (p) => this.cancel(p as { runId: string; reason: string }),
    read: (p) => this.read(p as ReadParams),
    listModels: () => ({ models: this.engine.listModels?.() ?? null }),
    validateModel: (p) => this.validateModel(p as { modelRef?: string }),
    dispose: async () => {
      await this.engine.dispose?.();
      return { ok: true };
    },
    ping: () => ({ pong: true }),
  };

  // ── initialize：版本协商（越界 → engine_protocol_mismatch）+ 能力应答 ──

  private initialize(params: InitializeParams): InitializeResult {
    if (params?.protocolVersion !== ENGINE_PROTOCOL_VERSION) {
      throw new EngineSdkError(
        "engine_protocol_mismatch",
        `host protocol version ${String(params?.protocolVersion)} is not compatible with engine protocol v${ENGINE_PROTOCOL_VERSION}`,
        `Upgrade the engine package or the host so both speak protocol v${ENGINE_PROTOCOL_VERSION}.`,
      );
    }
    this.initialized = true;
    const models = this.engine.listModels?.() ?? null;
    return {
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      engineId: this.engine.id,
      engineVersion: ZCODE_ADAPTER_VERSION,
      adapterVersion: ZCODE_ADAPTER_VERSION,
      capabilities: this.engine.capabilities(),
      ...(models !== null ? { models: models.map((m) => ({ id: m.id })) } : {}),
    };
  }

  // ── run：协议载荷 → 本地 AgentCallOpts/RunContext；事件 → 通知/host 通道 ──

  private async run(params: RunParams): Promise<{ handle: EngineHandleData; outcome: unknown }> {
    if (!this.initialized) {
      throw new EngineSdkError(
        "engine_protocol_not_initialized",
        "run before initialize is a protocol violation",
        "The host must complete the initialize handshake before dispatching runs.",
      );
    }
    const { runId, task, ctx } = params;
    const controller = new AbortController();
    const active: ActiveRun = { controller, seq: 0 };
    this.activeRuns.set(runId, active);

    // task 子集 + ctx 还原 = 本地全量 AgentCallOpts（RemoteEngine.toSdkTaskSubset 镜像）
    const fullTask: AgentCallOpts = { ...task, ...(ctx.model !== undefined ? { model: ctx.model } : {}) };
    const ctxModel: EngineCtxModel | undefined = parseCtxModel(ctx.ctxModel);
    const stream: EngineStream | undefined = ctx.streamMode === "stream" ? { onDelta: (delta) => { void this.reverseRequestInternal("host/streamDelta", { runId, delta }); } } : undefined;

    const runCtx: RunContext = {
      taskId: runId,
      poolKey: ctx.poolKey,
      signal: controller.signal,
      onEvent: (event: AgentEvent) => this.emitEvent(runId, event),
      ...(ctxModel !== undefined ? { ctxModel } : {}),
      ...(stream !== undefined ? { stream } : {}),
      ...(ctx.schemaEnv !== undefined ? { schemaEnv: ctx.schemaEnv } : {}),
      ...(ctx.engineFallback !== undefined ? { engineFallback: ctx.engineFallback } : {}),
      onPoolResolved: (poolKey) => {
        void this.reverseRequestInternal("host/poolResolved", { runId, poolKey });
      },
      onHandleReady: (partial) => {
        void this.reverseRequestInternal("host/handleReady", { runId, sessionRef: partial.sessionRef, poolKey: partial.poolKey });
      },
    };

    try {
      const r = await this.engine.run(fullTask, runCtx);
      // 协议 RunResult.handle = EngineHandleData 本体（进程内 {data} 包装拆掉——
      // 对端 RemoteEngine `handle: { data: result.handle }` 互证）
      return { handle: r.handle.data, outcome: r.outcome };
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  private cancel(params: { runId: string; reason: string }): { ok: true } {
    const active = this.activeRuns.get(params.runId);
    if (active !== undefined) active.controller.abort(new Error(`cancelled by host: ${params.reason}`));
    return { ok: true };
  }

  private read(params: ReadParams): Promise<SessionView> {
    return this.engine.read({ data: params.handle });
  }

  private validateModel(params: { modelRef?: string }): { canonicalRef: string } {
    if (this.engine.validateModel === undefined) {
      throw new EngineSdkError(
        "engine_capability_unsupported",
        "engine does not implement validateModel",
        "Manifest omits modelCatalog; model validation falls back to run-time engine checks.",
      );
    }
    return this.engine.validateModel(params.modelRef);
  }

  // ── 出站：事件通知 + 反向请求客户端 ──

  private emitEvent(runId: string, event: AgentEvent): void {
    const active = this.activeRuns.get(runId);
    const seq = active !== undefined ? ++active.seq : 0;
    this.write({ method: "event", params: { runId, seq, event } });
  }

  /**
   * 发反向请求并等应答（帧④必须应答）。计时面登记：发出 → clock.started；收到
   * ack 形态应答 → clock.acked（两阶段第一段，等待不计超时）；终结 → clock.settled。
   * 应答超时兜底 reject——数据面通道（host/log 等）core 10s 应答，reject 由调用方
   * 吞掉留痕（数据面丢失不拖死主链路）。
   */
  /** 反向请求发送（公开面：main.ts 的 host/log 桥接消费；内部 run 通道同路）。 */
  reverseRequest(method: string, params: unknown): Promise<unknown> {
    return this.reverseRequestInternal(method, params);
  }

  private reverseRequestInternal(method: string, params: unknown): Promise<unknown> {
    const id = `rev-${++this.revSeq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reversePending.delete(id);
        this.reverseClock?.settled(id);
        reject(new Error(`reverse request ${method} (${id}) timed out after ${this.reverseTimeoutMs}ms`));
      }, this.reverseTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.reversePending.set(id, { resolve, reject, timer });
      this.reverseClock?.started(id);
      this.write({ id, method, params });
    });
  }

  /** 反向请求应答落位（ack 两阶段：{ack:true}/{unsupported:true}/{ok:true} 均先 ack 计时面）。 */
  private settleReverse(id: number | string, frame: { result?: unknown; error?: unknown }): void {
    const pending = this.reversePending.get(String(id));
    if (pending === undefined) return;
    this.reversePending.delete(String(id));
    clearTimeout(pending.timer);
    this.reverseClock?.acked(String(id));
    this.reverseClock?.settled(String(id));
    if (frame.error !== undefined) pending.reject(new Error(`reverse request ${String(id)} rejected: ${toErrorMessage(frame.error)}`));
    else pending.resolve(frame.result as ReverseResponseResult);
  }
}

/** probe params 归一：对象形态透传（force 面），缺省/非对象 → undefined。 */
function probeParamsOf(params: unknown): { force?: boolean } | undefined {
  return typeof params === "object" && params !== null
    ? (params as { force?: boolean })
    : undefined;
}

/** unknown → 协议错误帧载荷（可操作恢复指引，规则 16）。 */
function toProtocolError(err: unknown): { code: string; message: string; recovery: string } {
  if (err instanceof EngineSdkError) return err.toStructured();
  return {
    code: "engine_run_failed",
    message: toErrorMessage(err),
    recovery: "Check the engine process logs (engineDataDir/logs/) and rerun; if persistent, reinstall or upgrade the engine package.",
  };
}
