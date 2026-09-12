// src/execution/engine/client/remote-engine.ts
//
// RemoteEngine：cli 形态 EnginePort 适配（W2，impl-plan §2.2「RemoteEngine 同步成员
// 形态映射」必写死；[H1 U6] 交互控制面与 recordId 键路由面已随 chat 域退役删除）。
// 把 core EnginePort 的成员映射到 EngineClient 协议请求；
// 同步成员（capabilities / listModels / validateModel）**只读 manifest 注册期快照**
// ——单源化原则（设计 §3.3「同步成员清单」v6 减法）：无握手缓存、无失效时机，
// initialize 应答仅诊断（warn 由 EngineClient 留痕）。
//
// 直接 implements EnginePort：SDK 契约类型与 core 中立类型是结构等价闭包，
// implements 即编译期结构互证（字段漂移在 typecheck 期报错，与 protocol-closure
// 双向可赋值断言同向）。
//
// W3 消费契约：routing/registry 的 cli 形态 EnginePort 实例 = 本类（先写后读）。

import { homedir } from "node:os";
import { join } from "node:path";

import {
  CANCEL_SETTLE_GRACE_MS,
  EngineSdkError,
  type AgentCallOpts as SdkAgentCallOpts,
  type AgentOutcome as SdkAgentOutcome,
  type EngineHandleData as SdkEngineHandleData,
  type ModelCatalogEntry,
  type ProbeReport as SdkProbeReport,
  type SessionView as SdkSessionView,
} from "@zhushanwen/subagent-engine-sdk";

import type { AgentCallOpts } from "../../../orchestration/models/types.ts";
import { getSubagentSessionDir } from "../../path-encoding.ts";
import { assertGateCapabilitiesMatched } from "../common/capability-gate.ts";
import type {
  EngineCapabilities,
  EngineHandle,
  EngineHandleData,
  ProbeReport,
  SessionView,
} from "../types.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../port.ts";
import type { EngineClient, RunRoute } from "./engine-client.ts";

/** manifest 注册期快照（发现器/注册表读取，构造时注入——同步成员唯一源）。 */
export interface RemoteEngineManifestSnapshot {
  /** manifest `capabilities`（同步能力位权威，注册期读，无缓存）。 */
  capabilities: EngineCapabilities;
  /**
   * manifest `modelCatalog` 三态（§2.4：缺省 = 不注入保持 undefined；null 合法等价
   * 省略；`models: []` 仅作者显式声明）。解析器**不得**把省略填成 `[]`——否则
   * 「无枚举面」语义不可达（恒走 buildEmptyModelsHint 与事实不符）。
   */
  modelCatalog?: { dynamic: boolean; models: ModelCatalogEntry[] } | null;
}

export interface RemoteEngineOptions {
  engineId: string;
  client: EngineClient;
  manifest: RemoteEngineManifestSnapshot;
  /** 引擎数据根（协议 read.dataDir 必填：存量池时代相对 dbPath 定位需要它）。 */
  dataDir: string;
  hostKind: string;
  hostVersion?: string;
  /** L3 显式配置 engines.<id>.config（initialize.engineConfig 透传；EngineClient 消费）。 */
  engineConfig?: Record<string, string>;
}

/** manifest 目录条目命中：id / canonicalRef / 任一 alias 与 ref 全等。 */
function matchCatalogEntry(
  entries: ModelCatalogEntry[],
  ref: string,
): ModelCatalogEntry | undefined {
  return entries.find(
    (entry) =>
      entry.id === ref || entry.canonicalRef === ref || entry.aliases?.includes(ref) === true,
  );
}

/**
 * cli 形态 EnginePort。构造同步、不 throw（缺包/坏包不在构造期报——descriptor
 * 首次使用才解析，设计 §3.5.3 代理形态）；真正的失败发生在首次协议调用。
 */
export class RemoteEngine implements EnginePort {
  readonly id: string;

  private readonly opts: RemoteEngineOptions;

  constructor(opts: RemoteEngineOptions) {
    this.opts = opts;
    this.id = opts.engineId;
    if (opts.manifest.modelCatalog === undefined || opts.manifest.modelCatalog === null) {
      // 同步成员形态映射（必写死）：manifest 省略 modelCatalog → validateModel 成员
      // **不实现**（消费方 model-validation.ts:62 `typeof validateModel !== "function"`
      // → 跳过校验恒放行）。实例 own property 置 undefined 遮蔽原型方法——
      // typeof engine.validateModel === "undefined"。
      (this as unknown as { validateModel?: unknown }).validateModel = undefined;
    }
  }

  /** 直读 manifest 注册期快照（无缓存——每次调用同值，快照不可变）。 */
  capabilities(): EngineCapabilities {
    return this.opts.manifest.capabilities;
  }

  /**
   * listModels 三态映射（必写死）：
   *   省略 modelCatalog / models null → 返回 null（buildCoreAlignedHint 语义）；
   *   显式 `models: []` → 返回 []（buildEmptyModelsHint）；
   *   数组 → 原样返回。
   */
  listModels(): Array<{ id: string; name?: string }> | null {
    const catalog = this.opts.manifest.modelCatalog;
    if (catalog === undefined || catalog === null) return null;
    return catalog.models;
  }

  /**
   * validateModel 同源 manifest 判定（成员在 catalog 省略时已被构造器摘除）：
   *   命中（id/canonicalRef/alias 全等）→ {canonicalRef: entry.canonicalRef ?? entry.id}；
   *   未命中且 dynamic:false → throw engine_model_unknown（同步拒，record 不创建）；
   *   未命中且 dynamic:true → 放行，返回原样 ref（运行期以引擎为权威
   *   engine_model_mismatch；无斜杠 ref 的 core 侧拆分 = 契约变更④，归 W3）。
   * modelRef undefined（查引擎缺省）对静态目录恒属未命中：dynamic:true 放行回空串
   * （缺省模型无静态 canonical 形态，运行期自证）；dynamic:false 同步拒。
   */
  validateModel(modelRef: string | undefined): { canonicalRef: string } {
    const catalog = this.opts.manifest.modelCatalog;
    if (!catalog || modelRef === undefined || modelRef.trim() === "") {
      if (catalog?.dynamic === false) {
        throw new EngineSdkError(
          "engine_model_unknown",
          `engine '${this.id}' declares a static model catalog (dynamic:false) and has no engine-default entry; `
            + "an explicit `model` ref from the catalog is required.",
          "Retry with an exact model id from the engine's model list (engine listModels), or declare "
            + "the engine-default entry in the manifest modelCatalog.",
        );
      }
      return { canonicalRef: modelRef ?? "" };
    }
    const entry = matchCatalogEntry(catalog.models, modelRef);
    if (entry !== undefined) {
      return { canonicalRef: entry.canonicalRef ?? entry.id };
    }
    if (catalog.dynamic === false) {
      throw new EngineSdkError(
        "engine_model_unknown",
        `model '${modelRef}' is not in engine '${this.id}' static model catalog (dynamic:false)`,
        "Retry with an exact model id from the engine's model list (engine listModels), "
          + "or fix the manifest modelCatalog / upgrade the engine package.",
      );
    }
    return { canonicalRef: modelRef };
  }

  async probe(probeOpts?: { force?: boolean }): Promise<ProbeReport> {
    await this.opts.client.ensureConnected();
    const report = (await this.opts.client.request("probe", {
      force: probeOpts?.force ?? false,
    })) as SdkProbeReport;
    return report;
  }

  /**
   * 协议 run 映射。task 收窄为引擎面子集（model/schemaEnv/cwd/engineFallback 改挂
   * run.params.ctx，协议层单列——SDK AgentCallOpts 注释的字段裁决）；事件经 run 作用域
   * 路由分发（event 通知 / streamDelta / poolResolved / handleReady）；abort → cancel
   * 帧 + 3s 收敛窗口（超时杀链）。运行中失败不 reject——合成 error outcome + 正常
   * handle 返回（EnginePort 契约：record 必须收尾）；run 帧发出前的失败（连接/握手）
   * reject。childSpawned/childStateChanged 镜像归 EngineClient（协议形态无
   * ChildProcess 实例，ctx.onChildSpawned 不调用——W6 起生命周期谓词读镜像）。
   */
  async run(task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> {
    await this.opts.client.ensureConnected();

    // [W3 契约⑤ run 期接线] gate 位方向判定②：同步面 assertTaskShapeSupported 读
    // manifest 拦「少声明」；「多声明」（manifest 声明可用、引擎实态不符）gate 同步面
    // 读不到，由握手应答发现——manifest 快照 vs initialize 应答 capabilities 逐 gate
    // 位对照（common/capability-gate），命中抛 engine_capability_mismatch：本处位于
    // run 帧发出前 → prepare 期失败 reject、不产生 handle，上层 executeViaEngine 经
    // finalizeFailed → Step 3b cleanupWorktreeIfBound 清理 run 前已建的前置副作用。
    // 每次 run 都对照（纯内存比较，幂等）：崩溃重建重新握手后应答变化也能在下一 run
    // 发现。非 gate 位不一致不进此判定（诊断面 warnOnManifestDiagnostics 已留痕）。
    const answeredCaps = this.opts.client.getInitializeDiagnostics()?.capabilities;
    if (answeredCaps !== undefined) {
      assertGateCapabilitiesMatched(this.id, this.opts.manifest.capabilities, answeredCaps);
    }

    const runId = ctx.taskId;
    const runParams = buildRunParams(task, ctx, runId);

    const unregister = this.opts.client.registerRunRoute(runId, buildRunRouteHandlers(ctx));

    // abort 分级：cancel 帧 → 等 CANCEL_SETTLE_GRACE_MS 收敛 → 杀链兜底。
    const abort = wireAbortSignal(this.opts.client, runId, ctx);

    try {
      // wire 载荷收窄（帧 result unknown → 协议 RunResult 形态）；SDK → core 结构
      // 兼容由 implements EnginePort 在 typecheck 期互证。
      const result = (await this.opts.client.request("run", runParams)) as {
        handle: SdkEngineHandleData;
        outcome: SdkAgentOutcome;
      };
      return { handle: { data: result.handle }, outcome: result.outcome };
    } catch (err) {
      if (abort.isCancelSent()) {
        // cancel 后未收敛（杀链已杀）或引擎在 abort 期间报错：合成 abort 终态，不 reject
        // （exitCode null = 被信号杀死，杀链判据）。
        //
        // [时序窗登记] 本合成 outcome 携 error + exitCode null——若它先于 cancel 域的
        // CAS 终态化到达消费方，record 会先以 error 载体落 failed 形态而非 cancelled。
        // 防护依据 = cancel 链 CAS 先行：cancelBackground 在 controller.abort() 后的
        // **同一同步执行栈**内完成 tryTransition(cancelled) 抢锁终态化
        // （subagent-service.ts cancelBackground），而本合成 outcome 的返回必须经异步
        // 链（cancelRun RPC 往返 / 杀链 grace 后 run 请求 reject），时序上 CAS 恒先行，
        // 窗极窄（仅存于 CAS 抢锁失败 = detached 已 finalize 的交错形态，该形态下
        // 对方已终态化，本 outcome 无接管面）。不改本逻辑——改动会碰 run 域 cancel
        // 语义（超修复范围），窗口登记于此供后续接管判据收敛时统一评估。
        return {
          handle: { data: this.synthesizeHandle(ctx.poolKey) },
          outcome: abortedRunOutcome(this.id, runId, err),
        };
      }
      if (isTransientRunFailure(err)) {
        // 运行中失败（引擎崩溃 / 数据面故障杀链）：合成 error outcome + 正常 handle。
        return {
          handle: { data: this.synthesizeHandle(ctx.poolKey) },
          outcome: transientRunOutcome(this.id, err),
        };
      }
      throw err; // prepare 期失败（连接/握手/model 拒）——进程创建前 reject，不产生 handle
    } finally {
      abort.dispose();
      unregister();
    }
  }

  /** 协议 read（dataDir 必填——引擎数据根，构造注入）。 */
  async read(handle: EngineHandle): Promise<SessionView> {
    await this.opts.client.ensureConnected();
    const view = (await this.opts.client.request("read", {
      handle: handle.data,
      dataDir: this.opts.dataDir,
    })) as SdkSessionView;
    return view;
  }

  /** 协议 dispose（幂等）→ EngineClient 停机清理（镜像置死 + pidfile + 组杀兜底）。 */
  async dispose(): Promise<void> {
    await this.opts.client.dispose();
  }

  /** 运行中失败的合成 handle：handleReady 回填优先，缺省回退请求期 ctx。 */
  private synthesizeHandle(poolKey: string): EngineHandleData {
    const partial = this.opts.client.getPartialHandle();
    const diag = this.opts.client.getInitializeDiagnostics();
    return {
      v: 1,
      engineId: this.id,
      sessionRef: partial?.sessionRef ?? {},
      poolKey: partial?.poolKey ?? poolKey,
      engineVersion: diag?.engineVersion,
      adapterVersion: diag?.adapterVersion ?? `remote-engine/${this.id}`,
    };
  }
}

/**
 * 运行中失败（合成 outcome）vs prepare 期失败（reject）的分界：EngineSdkError 的
 * engine_crashed / engine_request_timeout / engine_handshake_timeout 三类由「run 帧
 * 已受理后进程死亡/链路故障」产生；其余（engine_protocol_mismatch、engine_model_*、
 * 未知错误）按 prepare 期失败上抛（调用方分诊）。进程组杀引发的 stdin 写失败同属
 * engine_crashed（engine-client.request 统一包装）。
 */
function isTransientRunFailure(err: unknown): boolean {
  if (!(err instanceof EngineSdkError)) return false;
  return (
    err.code === "engine_crashed" ||
    err.code === "engine_request_timeout" ||
    err.code === "engine_handshake_timeout"
  );
}

/** run 帧 wire 载荷（EngineClient.request("run") 入参形态）。 */
interface WireRunParams {
  runId: string;
  task: SdkAgentCallOpts;
  ctx: {
    poolKey: string;
    cwd: string;
    model: string | undefined;
    schemaEnv: string | undefined;
    ctxModel: string | undefined;
    engineFallback: RunContext["engineFallback"];
    streamMode: "stream" | undefined;
    sessionRootId?: string;
    /** [Option C] 恒有值（宿主注入 ?? 同源 env 推导）——与 sessionRootId 的
     * "undefined 不上 wire" 不同，本字段派生恒产出字符串。 */
    sessionDir: string;
  };
  resume?: NonNullable<RunContext["resume"]>;
}

// pi 壳宿主进程内贯穿的两条 env（与 subagent-service / workflow-state-root 同源推导）：
//   - PI_CODING_AGENT_DIR：pi SDK getAgentDir 的 env 覆盖通道——xyz-agent 生产链路由
//     runtime spawn pi 时显式注入（rpc-client buildPiOutboundEnv，经
//     buildOutboundChildEnv 共享构建器出站）；缺省 ~/.pi/agent 与 pi
//     实装版 dist config.js getAgentDir 逐字同构（锚定先例 workflow-state-root.ts）。
//   - PI_SUBAGENT_ROOT_CWD：真 ROOT 的 cwd（MF-3 贯穿）——嵌套 subagent 场景宿主
//     spawn 子进程时注入，与 subagent-service 构造处的 rootCwd 同 env 同值。
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const PI_ROOT_CWD_ENV = "PI_SUBAGENT_ROOT_CWD";

/**
 * [Option C 协议化] 宿主权威 subagent session 目录（Gate B S6 修复）：宿主进程内
 * 同源 env 推导 agentDir/rootCwd 后调 getSubagentSessionDir（宿主单一权威推导，
 * path-encoding.ts——引擎本地推导与宿主布局三处不等价，已降级 [LEGACY] fallback）。
 * 每次调用重新解析（env 读取零成本，不缓存防测试/宿主切换读旧值，对齐
 * common/data-dir.ts getEngineDataDir 惯例）。rootCwd 缺省 process.cwd()：pi 壳
 * ctx.cwd = pi 进程启动 cwd（session-lifecycle 侧同用进程 cwd 的既有锚定）。
 */
function deriveHostSubagentSessionDir(): string {
  const agentDir = process.env[PI_AGENT_DIR_ENV];
  const resolvedAgentDir =
    agentDir !== undefined && agentDir !== "" ? agentDir : join(homedir(), ".pi", "agent");
  const rootCwd = process.env[PI_ROOT_CWD_ENV];
  const resolvedRootCwd = rootCwd !== undefined && rootCwd !== "" ? rootCwd : process.cwd();
  return getSubagentSessionDir(resolvedAgentDir, resolvedRootCwd);
}

/**
 * run 帧 wire 载荷构建。协议 ctx 承载（RunContext 字段映射表）：cwd 取任务声明值
 * （缺省进程 cwd）；ctxModel 投影 canonical 词形（provider/id，ModelInfo 字段裁决）。
 * [H1 U6] 会话形态参数直传（RunContext.resume → run.params.resume；结构由
 * RunContext.resume 注释与 SDK RunResumeParams 的 implements 互证承载）。一次性轮
 * ctx.resume === undefined → wire 上不出现该键（协议 additive 语义）。
 */
function buildRunParams(task: AgentCallOpts, ctx: RunContext, runId: string): WireRunParams {
  const ctxModelRef = ctx.ctxModel ? `${ctx.ctxModel.provider}/${ctx.ctxModel.id}` : undefined;
  return {
    runId,
    task: toSdkTaskSubset(task),
    ctx: {
      poolKey: ctx.poolKey,
      cwd: task.cwd ?? process.cwd(),
      model: task.model,
      schemaEnv: ctx.schemaEnv ?? task.schemaEnv,
      ctxModel: ctxModelRef,
      engineFallback: ctx.engineFallback,
      streamMode: ctx.stream !== undefined ? ("stream" as const) : undefined,
      // [F6] 根 session id（relay 归属键 SESSION_ID 权威源）——undefined 不上 wire
      //（additive 语义，与顶层 chat 参数同写法）。
      ...(ctx.sessionRootId !== undefined ? { sessionRootId: ctx.sessionRootId } : {}),
      // [Option C 协议化] 权威 subagent session 目录（Gate B S6）：宿主注入值优先，
      // 缺省同源 env 推导（deriveHostSubagentSessionDir）——恒有值恒上 wire，引擎
      // 据此组装 --session-dir 不自推导（引擎本地推导降级 [LEGACY] fallback）。
      sessionDir: ctx.sessionDir ?? deriveHostSubagentSessionDir(),
    },
    ...(ctx.resume !== undefined ? { resume: ctx.resume } : {}),
  };
}

/** run 作用域事件路由（event / streamDelta / poolResolved / handleReady）。 */
function buildRunRouteHandlers(ctx: RunContext): RunRoute {
  return {
    onEvent: (event) => ctx.onEvent?.(event as Parameters<NonNullable<RunContext["onEvent"]>>[0]),
    onStreamDelta: (delta) => ctx.stream?.onDelta(delta),
    onPoolResolved: (poolKey) => ctx.onPoolResolved?.(poolKey),
    onHandleReady: (partial) => ctx.onHandleReady?.(partial),
  };
}

/** abort 接线的运行态句柄（isCancelSent 供 run catch 分支分诊；dispose 归 finally）。 */
interface AbortWiring {
  isCancelSent(): boolean;
  dispose(): void;
}

/**
 * abort 分级接线：cancel 帧 → 等 CANCEL_SETTLE_GRACE_MS 收敛 → 杀链兜底。signal 已
 * aborted 则立即进入收敛窗口；dispose 在 run 终态（finally）标记 settled 并清理
 * timer / listener。
 */
function wireAbortSignal(client: EngineClient, runId: string, ctx: RunContext): AbortWiring {
  let cancelSent = false;
  let settled = false;
  let settleTimer: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    if (cancelSent || settled) return;
    cancelSent = true;
    void client.cancelRun(runId, "abort").catch(() => {
      // 受理失败由收敛窗口兜底（进程死 → run 请求 reject → 合成终态）。
    });
    settleTimer = setTimeout(() => {
      if (!settled) {
        void client.killAll(`cancel did not settle within grace for run ${runId}`);
      }
    }, CANCEL_SETTLE_GRACE_MS);
  };
  if (ctx.signal !== undefined) {
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    isCancelSent: () => cancelSent,
    dispose: () => {
      settled = true;
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      if (ctx.signal !== undefined) ctx.signal.removeEventListener("abort", onAbort);
    },
  };
}

/** abort 期合成 outcome（exitCode null = 被信号杀死，杀链判据）。 */
function abortedRunOutcome(engineId: string, runId: string, err: unknown): SdkAgentOutcome {
  return {
    content: "",
    error: `engine_run_failed: run ${runId} aborted before terminal answer${
      err instanceof Error ? ` (${err.message})` : ""
    }`,
    exitCode: null,
    engineId,
  };
}

/** 运行中失败合成 outcome（引擎崩溃 / 数据面故障杀链）。 */
function transientRunOutcome(engineId: string, err: unknown): SdkAgentOutcome {
  return {
    content: "",
    error: err instanceof Error ? err.message : String(err),
    exitCode: null,
    engineId,
  };
}

/** core AgentCallOpts → SDK 引擎面子集（宿主自持字段不透传，SDK 契约类型注释裁决）。 */
function toSdkTaskSubset(task: AgentCallOpts): SdkAgentCallOpts {
  return {
    prompt: task.prompt,
    schema: task.schema,
    thinkingLevel: task.thinkingLevel,
    scene: task.scene,
    maxTurns: task.maxTurns,
    graceTurns: task.graceTurns,
    skill: task.skill,
    skillPath: task.skillPath,
    description: task.description,
    agent: task.agent,
    appendSystemPrompt: task.appendSystemPrompt,
    fork: task.fork,
    // fork-from 源（fork-from 轮次 --fork 的协议载体，W3 断链修复）：host-task-spec
    // 已把 ExecuteOptions.forkFromSessionFile 改名为 task.forkSource，此处同名透传。
    // 缺省 undefined 不落 wire（JSON 序列化丢弃，与相邻可选字段同语义）。
    forkSource: task.forkSource,
    worktree: task.worktree,
    conversation: task.conversation,
    idleTimeoutMs: task.idleTimeoutMs,
    denyTools: task.denyTools,
    permissionMode: task.permissionMode,
  };
}
