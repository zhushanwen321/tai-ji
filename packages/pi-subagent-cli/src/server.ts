// src/server.ts
//
// 引擎协议服务器（W7，照 W5 zcode-subagent-cli/server.ts 形态；帧型/方法/错误码
// 权威源 = SDK protocol 模块——设计 §3.3）。与 core 侧 W2 EngineClient 互为协议
// 两端：
//
//   core EngineClient（spawn+握手+请求关联+反向路由） ←NDJSON stdio→ 本服务器
//
// 9 正向方法逐个映射到 EnginePort（本地 port-types 镜像）成员；run 期间事件经
// `event` 通知（runId + 单调 seq）外发，onHandleReady/onChildSpawned/stream 经
// host/* 反向请求上抛（[池抽象降级] host/poolResolved 通道已随 poolKey 协议面退役删除）。
// 查询面两方法（listModels/validateModel）不映射 EnginePort——PiEngine 未实装该
// 可选面，分发位直接路由 engine-query（读 pi 数据目录 json，pi-workflow-run-resource-model
// §3.3 决策 11 方案 B）。
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
  assembleFullTask,
  handleInboundFrame,
  initializeEngine,
  notInitializedError,
  sendReverseRequest,
  unknownMethodError,
  writeRunEvent,
  type FrameLoopContext,
  REVERSE_TIMEOUT_DEFAULT_MS,
  toProtocolError as toProtocolErrorShared,
  type ActiveRun,
  type FrameWriter,
  type ProtocolErrorPayload,
  type ReversePending,
} from "@zhushanwen/subagent-engine-sdk/server";
import {
  EngineSdkError,
  assertChatConversationSupported,
  getLogger,
  isUiResponse,
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
import { listPiModels, resolvePiAgentDir, validatePiModel } from "./engine-query.ts";
import { PiEngine } from "./pi-engine.ts";
import { parseCtxModel, type EnginePort, type EngineStream, type EngineCtxModel, type RunContext } from "./port-types.ts";
import { toErrorMessage } from "./error-message.ts";

const logger = getLogger("pi-engine-cli");

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
  /**
   * pi agent 目录（引擎查询面 listModels/validateModel 的数据目录；缺省 =
   * resolvePiAgentDir()——env PI_CODING_AGENT_DIR 优先、缺省系统 pi 目录）。
   * 测试注入 tmp fixture 目录隔离真实数据。
   */
  piAgentDir?: string;
}

// [§2.11] ReversePending / REVERSE_TIMEOUT_DEFAULT_MS / ActiveRun / FrameWriter 共用
// SDK `./server` 子入口的声明单源（pi 侧 method 字段为扩展位，SDK 类型已含）。

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
  /** 引擎查询面数据目录（listModels/validateModel 应答源；见 opts.piAgentDir）。 */
  private readonly queryAgentDir: string;
  private readonly frameLoop: FrameLoopContext;
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
    this.queryAgentDir = opts.piAgentDir ?? resolvePiAgentDir();
    this.dispatchTable = this.buildDispatchTable();
    this.frameLoop = {
      write: this.write,
      settleReverse: (id, frame) => this.settleReverse(id, frame),
      dispatch: (id, method, params) => this.dispatch(id, method, params),
      toError: (err) => toProtocolError(err),
    };
  }

  /** 入站帧消费（请求帧 + 反向请求应答帧；main.ts 的行解析器拆行后喂入）。 */
  handleFrame(frame: unknown): void {
    handleInboundFrame(frame, this.frameLoop);
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
      // 查询面两方法路由 engine-query（pi-workflow-run-resource-model §3.3 决策 11
      // 方案 B：读 pi 数据目录 json，不经 engine 实例——PiEngine 本就未实装该可选面）
      listModels: () => ({ models: listPiModels(this.queryAgentDir) }),
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
    if (handler === undefined) throw unknownMethodError(id, method);
    return handler(params);
  }

  // ── initialize：版本协商（越界 → engine_protocol_mismatch）+ 能力应答 ──

  private initialize(params: InitializeParams): InitializeResult {
    const result = initializeEngine(params, {
      engineId: this.engine.id,
      adapterVersion: PI_ADAPTER_VERSION,
      capabilities: this.engine.capabilities(),
      listModels: () => listPiModels(this.queryAgentDir),
    });
    this.initialized = true;
    return result;
  }

  // ── run：协议载荷 → 本地 AgentCallOpts/RunContext；事件 → 通知/host 通道 ──

  private async run(params: RunParams): Promise<{ handle: EngineHandleData; outcome: unknown }> {
    if (!this.initialized) throw notInitializedError();
    if (params.resume !== undefined) this.assertResumeRunFrame(params.resume);
    const { runId, task, ctx } = params;
    const controller = new AbortController();
    this.activeRuns.set(runId, { controller, seq: 0 });

    // pi 专有：host/askUser 两阶段等待体绑定进引擎（ui-request-queue 消费；
    // ack 后等待不计 in-flight 自灭计时——R9-2；run 结束解绑防跨 run 串扰）。
    // [H1 U3] chat 轮 = run 派发形态（每轮一进程，agent_settled 收敛即收割），
    // 同走 per-run 绑定；「会话跨 run 存活、askUser 固定绑定」的 chat 特判随
    // ChatSessionRegistry 退役（bindHostChannels 面已随 U5 删除）。
    // [S7] 应答形态守卫在 settleReverse（host/askUser 通道 isUiResponse 判定，不合法
    // 走 engine_protocol_bad_frame reject）——此处的 cast 是守卫后窄化，非无守卫裸 cast。
    this.engine.bindAskUser?.((request: UiRequest) =>
      this.reverseRequestInternal("host/askUser", { runId, request }) as Promise<UiResponse>,
    );

    // task 子集 + ctx 还原 = 本地全量 AgentCallOpts（RemoteEngine.toSdkTaskSubset 镜像）。
    // cwd 有值才还原（wire additive 语义）——worktree 隔离路径的子进程 spawn cwd 载体。
    const fullTask = assembleFullTask(task, ctx);

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
      ? {
        onDelta: (delta) => {
          void this.reverseRequestInternal("host/streamDelta", { runId, delta })
            .catch(this.warnReverseFailure("host/streamDelta", `run ${runId}`));
        },
      }
      : undefined;

    return {
      taskId: runId,
      signal: controller.signal,
      onEvent: (event: AgentEvent) => this.emitEvent(runId, event),
      ...(ctxModel !== undefined ? { ctxModel } : {}),
      ...(stream !== undefined ? { stream } : {}),
      // [F6] 根 session id 还原（relay 归属键 SESSION_ID 权威源；undefined 不挂键）
      ...(ctx.sessionRootId !== undefined ? { sessionRootId: ctx.sessionRootId } : {}),
      // [Option C 协议化] 权威 subagent session 目录还原（宿主 getSubagentSessionDir
      // 推导值透传引擎消费——undefined 不挂键，引擎走 [LEGACY] fallback）
      ...(ctx.sessionDir !== undefined ? { sessionDir: ctx.sessionDir } : {}),
      // [D2 扩展加载显式化] 孙进程扩展路径集还原（undefined 不挂键 = 不拼
      // --extension，协议 additive 语义）
      ...(ctx.extensionPaths !== undefined ? { extensionPaths: ctx.extensionPaths } : {}),
      // [D4] record 身份信封还原（引擎把它整封写进任务子进程身份 env；undefined 不挂键）
      ...(ctx.identity !== undefined ? { identity: ctx.identity } : {}),
      ...(params.resume !== undefined ? { resume: params.resume } : {}),
      onHandleReady: (partial) => {
        void this.reverseRequestInternal("host/handleReady", { runId, sessionRef: partial.sessionRef })
          .catch(this.warnReverseFailure("host/handleReady", `run ${runId}`));
      },
      onChildSpawned: (child) => {
        if (child.pid === undefined) return;
        void this.reverseRequestInternal("host/childSpawned", { pid: child.pid, recordId: chatRecordId ?? runId })
          .catch(this.warnReverseFailure("host/childSpawned", `run ${runId}`));
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
        }).catch(this.warnReverseFailure("host/childStateChanged", `run ${runId}`));
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

  /** 查询面裁决（engine-query.validatePiModel：缺席查 settings.json 缺省模型，
   * 未命中回 engine_model_unknown 结构化错误——诊断面如实裁决不抛断链）。 */
  private validateModel(params: { modelRef?: string }): { canonicalRef: string } {
    return validatePiModel(params.modelRef, this.queryAgentDir);
  }

  // ── 出站：事件通知 + 反向请求客户端 ──

  private emitEvent(runId: string, event: AgentEvent): void {
    writeRunEvent(this.write, this.activeRuns, runId, event);
  }

  /**
   * fire-and-forget 反向请求（`void this.reverseRequestInternal(...)` 形态）的
   * rejection 兜底：60s 超时（reverseRequestInternal 计时器）或宿主 error 帧
   * （settleReverse）都会 reject——无 handler 即 unhandled rejection（Node ≥15
   * 默认崩引擎进程）。失败只降级该次通道上报，warn 留痕不断流。
   */
  private warnReverseFailure(method: string, context: string): (err: unknown) => void {
    return (err: unknown) => {
      logger.warn(`[protocol] ${method} reverse request failed (${context}); continuing without it`, {
        detail: toErrorMessage(err),
      });
    };
  }

  /** 反向请求发送（公开面：main.ts 的 host/log 桥接消费；内部 run 通道同路）。 */
  reverseRequest(method: string, params: unknown): Promise<unknown> {
    return this.reverseRequestInternal(method, params);
  }

  private reverseRequestInternal(method: string, params: unknown): Promise<unknown> {
    return sendReverseRequest(
      {
        write: this.write,
        pending: this.reversePending,
        timeoutMs: this.reverseTimeoutMs,
        ...(this.reverseClock !== undefined ? { clock: this.reverseClock } : {}),
        nextId: () => `rev-${++this.revSeq}`,
        pendingExtras: (method) => ({ method }),
      },
      method,
      params,
    );
  }

  /** 反向请求应答落位。
   *
   * ack 两阶段（R9-2）：人机交互通道（host/askUser）宿主先回
   * `{ack:true}`——只 ack 计时面（移出 in-flight 自灭计时），**不终结等待**；最终
   * 结果帧才 settle。数据面通道宿主直接回终态（{ok:true} 等），ack 即 settle。 */
  private settleReverse(id: number | string, frame: { result?: unknown; error?: unknown }): void {
    const pending = this.reversePending.get(String(id));
    if (pending === undefined) {
      // 迟到/未知应答帧（超时已判死清理、或重复应答）：debug 留痕后丢弃，不落位。
      logger.debug(`[protocol] response frame for unknown reverse request ${String(id)} dropped (already settled or unknown id)`);
      return;
    }
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
    if (frame.error !== undefined) {
      pending.reject(new Error(`reverse request ${String(id)} rejected: ${toErrorMessage(frame.error)}`));
      return;
    }
    // [S7] askUser 应答面守卫（A6 方向防御同族——宿主→引擎方向已有 assertResumeRunFrame
    // 先例）：畸形 UiResponse 不落 resolve（否则静默流入 ui-request-queue），复用
    // engine_protocol_bad_frame 语义走 reject。
    if (pending.method === "host/askUser" && !isUiResponse(frame.result)) {
      pending.reject(
        new EngineSdkError(
          "engine_protocol_bad_frame",
          `host/askUser response is not a valid UiResponse (got: ${JSON.stringify(frame.result)})`,
          "The host must answer host/askUser with a UiResponse shape ({value}|{confirmed}|{cancelled}|{ack}).",
        ),
      );
      return;
    }
    pending.resolve(frame.result as ReverseResponseResult);
  }
}

/** unknown → 协议错误帧载荷（可操作恢复指引，规则 16）。 */
const RUN_FAILURE_RECOVERY =
  "Check the engine process logs (host/log stream + stderr) and rerun; if persistent, reinstall or upgrade the engine package.";

/** [§2.11] 错误帧构造共用 SDK 纯函数；本引擎只提供自己的恢复指引文案。 */
function toProtocolError(err: unknown): ProtocolErrorPayload {
  return toProtocolErrorShared(err, RUN_FAILURE_RECOVERY);
}
