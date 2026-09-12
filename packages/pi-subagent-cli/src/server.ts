// src/server.ts
//
// 引擎协议服务器（W7，照 W5 zcode-subagent-cli/server.ts 形态；帧型/方法/错误码
// 权威源 = SDK protocol 模块——设计 §3.3）。与 core 侧 W2 EngineClient 互为协议
// 两端：
//
//   core EngineClient（spawn+握手+请求关联+反向路由） ←NDJSON stdio→ 本服务器
//
// 9 正向方法逐个映射到 EnginePort（本地 port-types 镜像）成员；run 期间事件经
// `event` 通知（runId + 单调 seq）外发，onPoolResolved/onHandleReady/onChildSpawned/
// stream 经 host/* 反向请求上抛。
//
// pi 专有通道（本单元实装客户端）：
//   - host/askUser：run 分发前把 server 的反向请求等待体绑定进引擎
//     （PiEngine.bindAskUser → ui-request-queue 两阶段等待体；ack 后等待不计
//     in-flight 自灭计时——R9-2）；
//   - host/childSpawned / host/childStateChanged：spawn-runner 镜像回调 → 协议帧。
//
// [H1 U5] chat 会话反向通道面（bindHostChannels：轮次相位帧/active 心跳/
// recordId 键 streamDelta/会话级 askUser）已随 chat-session.ts 删除——chat 轮 =
// run 派发形态（每轮一进程），askUser 与镜像帧同走 per-run 绑定（run ctx 还原面）。
//
// 反向请求客户端：帧④ {id:"rev-N", method:"host/*", params} 必须应答；每个请求
// 登记进 ReverseRequestClock（armEngineSelfDestruct 的辅助判据面）。

import {
  ENGINE_PROTOCOL_VERSION,
  EngineSdkError,
  assertChatConversationSupported,
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
  type UiRequest,
  type UiResponse,
} from "@zhushanwen/subagent-engine-sdk";

import { PI_ADAPTER_VERSION } from "./constants.ts";
import { PiEngine } from "./pi-engine.ts";
import { parseCtxModel, type EnginePort, type EngineStream, type EngineCtxModel, type RunContext } from "./port-types.ts";
import { toErrorMessage } from "./error-message.ts";

/** 出站帧写入面（main.ts 注入 process.stdout；测试注入内存缓冲）。 */
export type FrameWriter = (frame: unknown) => void;

/** 入站帧来源（readline 已拆行的请求帧 + 反向请求应答帧混流）。 */
export interface EngineProtocolServerOptions {
  /** stdout 写入面（每帧一行 JSON）。 */
  write: FrameWriter;
  /** 引擎实例（缺省 createDefaultPiEngine——测试注入 fake/DI 实例）。 */
  engine?: EnginePort & {
    bindAskUser?(handler: ((req: UiRequest) => Promise<UiResponse>) | undefined): void;
  };
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

/** 构造缺省 pi 引擎（main.ts 的 server 构造缺省值；测试注入 fake）。 */
export function createDefaultPiEngine(): PiEngine {
  return new PiEngine();
}

/**
 * 引擎协议服务器。生命周期 = 进程生命周期（单引擎实例，无重建面——崩溃重建归
 * core EngineClient：杀进程再 spawn）。dispose 方法释放引擎常驻资源但进程不退出。
 */
export class EngineProtocolServer {
  private readonly write: FrameWriter;
  private readonly engine: NonNullable<EngineProtocolServerOptions["engine"]>;
  private readonly reverseClock: ReverseRequestClock | undefined;
  private readonly reverseTimeoutMs: number;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly reversePending = new Map<string, ReversePending>();
  /** 9 正向方法 → EnginePort 装配表（构造期冻结；表驱动分发）。 */
  private readonly dispatchTable: Record<string, (params: unknown) => unknown>;
  private revSeq = 0;
  private initialized = false;

  constructor(opts: EngineProtocolServerOptions) {
    this.write = opts.write;
    this.engine = opts.engine ?? createDefaultPiEngine();
    this.reverseClock = opts.reverseClock;
    this.reverseTimeoutMs = opts.reverseTimeoutMs ?? REVERSE_TIMEOUT_DEFAULT_MS;
    this.dispatchTable = this.buildDispatchTable();
  }

  /** 入站帧消费（请求帧 + 反向请求应答帧；main.ts 的行解析器拆行后喂入）。 */
  handleFrame(frame: unknown): void {
    if (isResponseFrame(frame)) {
      this.settleReverse(frame.id, frame);
      return;
    }
    if (isReverseRequestFrame(frame)) {
      // 引擎侧不接收反向请求（本进程是引擎）——坏帧 warn 不断流。
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

  /** 9 正向方法 → EnginePort 装配表（协议载荷 cast 收敛在各方法适配行）。 */
  private buildDispatchTable(): Record<string, (params: unknown) => unknown> {
    return {
      initialize: (params) => this.initialize(params as InitializeParams),
      probe: (params) =>
        this.engine.probe(typeof params === "object" && params !== null ? (params as { force?: boolean }) : undefined) as Promise<ProbeReport>,
      run: (params) => this.run(params as RunParams),
      cancel: (params) => this.cancel(params as { runId: string; reason: string }),
      read: (params) => this.read(params as ReadParams),
      listModels: () => ({ models: this.engine.listModels?.() ?? null }),
      validateModel: (params) => this.validateModel(params as { modelRef?: string }),
      dispose: async () => {
        await this.engine.dispose?.();
        return { ok: true };
      },
      ping: () => ({ pong: true }),
    };
  }

  /** 9 正向方法分发（表驱动；未知方法 → engine_protocol_unknown_method）。 */
  private async dispatch(id: number, method: string, params: unknown): Promise<unknown> {
    const handler = this.dispatchTable[method];
    if (handler === undefined) {
      throw new EngineSdkError(
        "engine_protocol_unknown_method",
        `unknown protocol method: ${method} (request id ${id})`,
        "The engine speaks protocol v1; check the installed engine package version vs the host.",
      );
    }
    return handler(params);
  }

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
      engineVersion: PI_ADAPTER_VERSION,
      adapterVersion: PI_ADAPTER_VERSION,
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
    if (params.resume !== undefined) this.assertResumeRunFrame(params.resume);
    const { runId, task, ctx } = params;
    const controller = new AbortController();
    this.activeRuns.set(runId, { controller, seq: 0 });

    // pi 专有：host/askUser 两阶段等待体绑定进引擎（ui-request-queue 消费；
    // ack 后等待不计 in-flight 自灭计时——R9-2；run 结束解绑防跨 run 串扰）。
    // [H1 U3] chat 轮 = run 派发形态（每轮一进程，agent_settled 收敛即收割），
    // 同走 per-run 绑定；「会话跨 run 存活、askUser 固定绑定」的 chat 特判随
    // ChatSessionRegistry 退役（bindHostChannels 面已随 U5 删除）。
    this.engine.bindAskUser?.((request: UiRequest) =>
      this.reverseRequestInternal("host/askUser", { runId, request }) as Promise<UiResponse>,
    );

    // task 子集 + ctx 还原 = 本地全量 AgentCallOpts（RemoteEngine.toSdkTaskSubset 镜像）
    const fullTask: AgentCallOpts = { ...task, ...(ctx.model !== undefined ? { model: ctx.model } : {}) };

    try {
      const r = await this.engine.run(
        fullTask,
        this.buildRunContext(params, controller, params.resume?.recordId),
      );
      return { handle: r.handle.data, outcome: r.outcome };
    } finally {
      this.activeRuns.delete(runId);
      this.engine.bindAskUser?.(undefined);
    }
  }

  /** run.resume 帧校验 + conversation 能力位 gate（A6 方向防御）：recordId 非空 +
   *  conversation 位 unsupported 同步拒——判据单源 = SDK assertChatConversationSupported
   *  （与 core capability-gate 同一能力位，防两侧判据漂移；[H1 D5] 位语义已收窄为
   *  resume 能力位，判据与消费方不变）。本引擎 manifest 声明 native，此处仅防御
   *  manifest/实装漂移。[H1 U6] 协议键已切 `resume`（唯一会话形态键）。 */
  private assertResumeRunFrame(resumeParams: { recordId: unknown }): void {
    if (typeof resumeParams.recordId !== "string" || resumeParams.recordId === "") {
      throw new EngineSdkError(
        "engine_protocol_bad_frame",
        `run.resume requires a non-empty recordId (got: ${JSON.stringify(resumeParams.recordId)})`,
        "The host must mint a record id before dispatching a session-form run; it keys the record-anchored handle and child mirror frames.",
      );
    }
    assertChatConversationSupported(this.engine.id, this.engine.capabilities());
  }

  /** RunContext 装配（协议 ctx 还原 + host/* 反向通道接线；事件 seq 由 emitEvent 计数）。 */
  private buildRunContext(
    params: RunParams,
    controller: AbortController,
    chatRecordId: string | undefined,
  ): RunContext {
    const { runId, ctx } = params;
    const ctxModel: EngineCtxModel | undefined = parseCtxModel(ctx.ctxModel);
    const stream: EngineStream | undefined = ctx.streamMode === "stream"
      ? { onDelta: (delta) => { void this.reverseRequestInternal("host/streamDelta", { runId, delta }); } }
      : undefined;

    return {
      taskId: runId,
      poolKey: ctx.poolKey,
      signal: controller.signal,
      onEvent: (event: AgentEvent) => this.emitEvent(runId, event),
      ...(ctxModel !== undefined ? { ctxModel } : {}),
      ...(stream !== undefined ? { stream } : {}),
      ...(ctx.schemaEnv !== undefined ? { schemaEnv: ctx.schemaEnv } : {}),
      ...(ctx.engineFallback !== undefined ? { engineFallback: ctx.engineFallback } : {}),
      // [F6] 根 session id 还原（relay 归属键 SESSION_ID 权威源；undefined 不挂键）
      ...(ctx.sessionRootId !== undefined ? { sessionRootId: ctx.sessionRootId } : {}),
      // [Option C 协议化] 权威 subagent session 目录还原（宿主 getSubagentSessionDir
      // 推导值透传引擎消费——undefined 不挂键，引擎走 [LEGACY] fallback）
      ...(ctx.sessionDir !== undefined ? { sessionDir: ctx.sessionDir } : {}),
      ...(params.resume !== undefined ? { resume: params.resume } : {}),
      onPoolResolved: (poolKey) => {
        void this.reverseRequestInternal("host/poolResolved", { runId, poolKey });
      },
      onHandleReady: (partial) => {
        void this.reverseRequestInternal("host/handleReady", { runId, sessionRef: partial.sessionRef, poolKey: partial.poolKey });
      },
      onChildSpawned: (child) => {
        if (child.pid === undefined) return;
        void this.reverseRequestInternal("host/childSpawned", { pid: child.pid, recordId: chatRecordId ?? runId });
      },
      // [SR-4 接线] 子进程退出态上报（宿主镜像据此取消该 pid 的挂起 dialog）。
      // 只报 exited——running 由上方 childSpawned 帧覆盖，不重复上报。
      onChildStateChanged: (p) => {
        if (p.state !== "exited") return;
        void this.reverseRequestInternal("host/childStateChanged", {
          pid: p.pid,
          recordId: chatRecordId ?? runId,
          state: p.state,
          killed: p.killed,
          ...(p.exitCode !== undefined ? { exitCode: p.exitCode } : {}),
          ...(p.signal !== undefined ? { signal: p.signal } : {}),
        });
      },
    };
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

  /** 反向请求应答落位。
   *
   * ack 两阶段（R9-2）：人机交互通道（host/askUser / host/permission）宿主先回
   * `{ack:true}`——只 ack 计时面（移出 in-flight 自灭计时），**不终结等待**；最终
   * 结果帧才 settle。数据面通道宿主直接回终态（{ok:true} 等），ack 即 settle。 */
  private settleReverse(id: number | string, frame: { result?: unknown; error?: unknown }): void {
    const pending = this.reversePending.get(String(id));
    if (pending === undefined) return;
    this.reverseClock?.acked(String(id));
    if (
      frame.error === undefined &&
      typeof frame.result === "object" && frame.result !== null &&
      "ack" in frame.result && (frame.result as { ack: unknown }).ack === true
    ) {
      // 两阶段第一段：等待继续（timer 已在 reverseRequestInternal 兜底，不重复武装）
      return;
    }
    this.reversePending.delete(String(id));
    clearTimeout(pending.timer);
    this.reverseClock?.settled(String(id));
    if (frame.error !== undefined) pending.reject(new Error(`reverse request ${String(id)} rejected: ${toErrorMessage(frame.error)}`));
    else pending.resolve(frame.result as ReverseResponseResult);
  }
}

/** unknown → 协议错误帧载荷（可操作恢复指引，规则 16）。 */
function toProtocolError(err: unknown): { code: string; message: string; recovery: string } {
  if (err instanceof EngineSdkError) return err.toStructured();
  return {
    code: "engine_run_failed",
    message: toErrorMessage(err),
    recovery: "Check the engine process logs (host/log stream + stderr) and rerun; if persistent, reinstall or upgrade the engine package.",
  };
}
