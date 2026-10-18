// src/execution/engine/client/engine-client.ts
//
// EngineClient：协议客户端（W2，impl-plan §2.2；与 zcode AppServerConnection 同型
// 但引擎无关）。职责 = NDJSON 帧编解码 / 请求-应答 id 关联 / 反向请求路由（见
// reverse-router.ts）/ 崩溃重建（≤3 次指数退避 1s/2s/4s）/ dispose / killAll /
// stdout 行解析后的帧路由（非 NDJSON 丢弃留痕）+ stderr 常驻排空（仅内存环缓冲尾
// 400 字符）。
//
// [M3] 进程面所有权已迁入 transport（设计 relay-spawn-transport §3.3 D5）：
// spawn 引擎 CLI / stdio 接线 / pidfile / 进程组收割归 LocalEngineTransport
// （transport/local.ts），control socket 通道归 RuntimeEngineTransport
// （transport/runtime.ts），本类经 EngineTransport 契约消费；协议面（握手/请求关联/
// 反向路由/崩溃重建）留守。transport 选择谓词（单源 = transport-selection.ts，底层
// SDK isControlEnvActive）：
// TAIJI_SUBAGENT_CONTROL_SOCKET 非空 → runtime transport（连接失败/hello 被拒 → 对应
// transport 错误码，不静默 local）；空串/缺失 → local。pidfile/reaper 仅 local 模式注册
// （impl-plan 验收③）：进程面收割段按 localTransport 实例有无编排。
//
// 引擎自灭 core 侧配套：spawn 不覆写引擎 stdin（stdio[0] = 'pipe' 独占管道，core
// 是唯一写端）——引擎侧 stdio EOF 主判据（SDK armEngineSelfDestruct）的前提（职责
// 在 transport 的 spawn 段，约束随实现走）。
//
// [D9 逃生舱] TAIJI_SUBAGENT_TRANSPORT=local → 强制 local transport（优先于 control
// env 激活判定）；运行期严重故障的快速回退通道，一个发布周期后删除（设计 D9）。
// 超时域划分（R9-2 / R9-2b）的实现与注释在 reverse-router.ts（反向面）与本文件
// 正向请求段；run 不设墙钟（任务级默认无超时，AGENTS.md 规则 19 / ADR-0047）。

import {
  CANCEL_SETTLE_GRACE_MS,
  ENGINE_PROTOCOL_VERSION,
  ENGINE_TRANSPORT_ERROR_CODES,
  EngineSdkError,
  HANDSHAKE_TIMEOUT_MS,
  getLogger,
  isProtocolVersionCompatible,
  isResponseFrame,
  isNotificationFrame,
  isReverseRequestFrame,
  SET_MODEL_REQUEST_TIMEOUT_MS,
  STDERR_TAIL_CHARS,
  engineProtocolMismatchError,
  type EngineHandleData,
  type InitializeResult,
  type RequestFrame,
  type SetModelParams,
  type SetModelResult,
} from "@zhushanwen/subagent-engine-sdk";

import { SpawnedChildrenMirror, type MirrorChangeEvent } from "./mirror.ts";
import { routeReverseRequest, type ReverseRouterDeps } from "./reverse-router.ts";
import {
  defaultEngineCmdlineMatcher,
  warnOnManifestDiagnostics,
  type EngineClientOptions,
} from "./client-options.ts";
import { LocalEngineTransport } from "./transport/local.ts";
import { RuntimeEngineTransport } from "./transport/runtime.ts";
import {
  SUBAGENT_TRANSPORT_ENV,
  isForcedLocalTransport,
  usesRuntimeTransport,
} from "./transport-selection.ts";
import type {
  EngineTransport,
  EngineTransportExitInfo,
} from "./transport/types.ts";
// [u7a 生产补挂] 反向通道镜像 → core 侧镜像桥接：in-flight 计数与生命周期谓词读 core
// 全局镜像（recordId 键），而引擎侧子进程上报只落 EngineClient 镜像——本桥接实现
// spawned-children.ts 头注「数据源①：反向通道上报落本镜像」的既登记契约（W3 协议化
// 后 ctx.onChildSpawned 不被调用，该数据面悬空致计数恒 0），见 crash-forensics §7 v7。
import { coreSpawnedChildrenMirror } from "../host/spawned-children.ts";
import { notifyInFlightChanged } from "../inflight-snapshot.ts";

const logger = getLogger("subagents");

/**
 * [D9 逃生舱] transport 强制覆盖键（定义在 transport-selection.ts，与 stream-sink
 * 的 widget 抑制判据单源；此处 re-export 保持既有导入面）。
 */
export { SUBAGENT_TRANSPORT_ENV };

/**
 * 单条镜像事件 → core 镜像投影 + 在途推送（u7a 数据面桥接）：置死**或已退出** →
 * markKilled，running → register（同 recordId 重 spawn 覆盖，与引擎侧 Map 同语义）。
 * 判据必须是 `state === "exited" || entry.killed` 而非只看 killed：pi 子进程自行
 * 退出/崩溃时引擎侧上报 `state:"exited", killed:false`（child.killed 只在我方 kill
 * 过才为 true），且引擎侧镜像对已退出子进程只改 state 不删项——只看 killed 会把
 * 已死子进程重新 register 为活句柄（countInFlight 虚高 → 幻影在途拖住滚动重启
 * 判据；hasLiveProcessHandle 恒真 → isResumable 失真）。exited 即死，killed 只是
 * 其子集。投影后必推送——镜像事件本身就是在途迁移点（子进程注册/移除），首轮无
 * 任何 arm/disarm 推送，不在此推则首轮在途窗口对 D5 不可见；notify 同步
 * fire-and-forget，异常不外溢。killedAll 空表单发（无 pid）与迟到事件（条目已清）
 * 为 no-op。
 */
function bridgeMirrorEventToCoreMirror(event: MirrorChangeEvent, mirror: SpawnedChildrenMirror): void {
  if (event.recordId === undefined || event.pid === undefined) return;
  const entry = mirror.getEntry(event.pid);
  if (entry === undefined) return;
  const core = coreSpawnedChildrenMirror();
  if (entry.state === "exited" || entry.killed) {
    core.markKilled(event.recordId);
  } else {
    core.register(event.recordId, { pid: entry.pid, killed: false });
  }
  notifyInFlightChanged();
}

/**
 * dispose 帧等待上界（设计 §3.6：dispose 上界 3s，超时即杀）。
 */
const DISPOSE_GRACE_MS = 3_000;
/** 协议帧违规日志的回显截断长度（非 NDJSON 行 / 未知帧的诊断留痕）。 */
const FRAME_ECHO_MAX_CHARS = 200;

/**
 * connectOnce 错误码 preserve 白名单：这些 code 原样上抛 + 标记不可用，不包装成
 * engine_crashed（「错误即语义」的宿主侧处置面 vs 进程意外死亡的分界）。协议版本
 * 越界为既有成员；transport 五码为 M3 control 通道成员（runtime transport 生效——
 * local 分支的失败码面不变：engine_not_found 等启动解析错误维持既有
 * engine_crashed 包装，见 impl-plan u-m3-local「connectOnce preserve 白名单」）。
 */
const PRESERVED_CONNECT_ERROR_CODES: ReadonlySet<string> = new Set([
  "engine_protocol_mismatch",
  ...ENGINE_TRANSPORT_ERROR_CODES,
]);

function isPreservedConnectErrorCode(code: string): boolean {
  return PRESERVED_CONNECT_ERROR_CODES.has(code);
}

/**
 * [R2A-N3③] runtime 启动裁决失败（invalid_launch / spawn_failed，mapControlError 已
 * 收敛为 engine_crashed）的保留判定：`data.controlCode` 是 mapControlError 写入的
 * 机器标记。保留整个 EngineSdkError 而不是重包，使 runtime 帧的专用 recovery
 *（如「Resolve the engine entry from the engine descriptor」）在真实 open 路径可见；
 * 宿主侧兜底包装产生的 engine_crashed 没有该标记，仍按原有通用文案处理。
 */
function isPreservedControlCrash(err: EngineSdkError): boolean {
  return err.code === "engine_crashed" && typeof err.data?.controlCode === "string";
}

/** 客户端连接状态。 */
export type EngineClientState =
  | "idle"
  | "connecting"
  | "ready"
  | "exited"
  | "unavailable"
  | "disposed";

/**
 * run 作用域反向通知路由（RemoteEngine.run 注册，终态后注销）。
 * 回调允许返回 Promise（数据面 10s 应答守卫的计时对象；同步回调不受守卫影响）。
 * [H1 U6] 轮次相位消费口（旧第 9 反向通道）已随 chat 域相位机退役删除。
 */
export interface RunRoute {
  onEvent?: (event: unknown) => void | Promise<void>;
  onStreamDelta?: (delta: string) => void | Promise<void>;
  onHandleReady?: (
    partial: Pick<EngineHandleData, "sessionRef">,
  ) => void | Promise<void>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

/** 引擎进程意外退出 / 被杀时在途请求的统一错误（附 stderr 尾）。 */
function engineCrashedError(detail: string, stderrTail: string): EngineSdkError {
  const tail = stderrTail.length > 0 ? ` stderr tail: ${stderrTail}` : "";
  return new EngineSdkError(
    "engine_crashed",
    `engine process exited unexpectedly: ${detail}.${tail}`,
    "The engine will be rebuilt (up to 3 attempts with exponential backoff) on the next run. "
      + "If it keeps crashing, inspect the engine package installation and its stderr diagnostics.",
    { stderrTail },
  );
}

/**
 * 引擎协议客户端（per engine id 一份；同宿主进程内不共享——两宿主各自 spawn）。
 */
export class EngineClient {
  readonly engineId: string;
  /** spawnedChildren 状态镜像（host/childSpawned / childStateChanged 的落地面）。 */
  readonly mirror = new SpawnedChildrenMirror();

  private readonly opts: EngineClientOptions;
  private readonly reverseRouterDeps: ReverseRouterDeps;
  private state: EngineClientState = "idle";
  /** 引擎通道（每代引擎连接一份实例；open/close 生命周期 = 单通道，u-m3-local）。 */
  private transport: EngineTransport | undefined;
  /**
   * 本次连接绑定的根 session id（run 路径 = RunContext.sessionRootId 权威值；
   * 未注入 = undefined，由 runtime transport 以 control env 回落）。启动期连接前
   * 由 ensureConnected(rootSessionId) 写入，engine_open 据此携带归属键。
   */
  private requestedRootSessionId: string | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly runRoutes = new Map<string, RunRoute>();
  private stderrTail = "";
  private unavailableReason: EngineSdkError | undefined;
  /**
   * 通道级 transport error 标记（onTransportError 置位、connectOnce 复位）。
   * 通道级错误（error 帧 / 帧超限 / 队列溢出）的不可用是「通道死、control 连接仍活」
   * 的中间态——随后的 engine_closed 只是通道终局回执，onTransportExit 据此回落 exited
   * （下一次 run 可在同一连接上重新 engine_open；D5/D8，与 unknown_channel 同语义）。
   * connect/握手失败的不可用（connectOnce catch）不置位：那是 [ADR-0122] 终局失败
   * （unavailable 恒 throw），teardownProcess 关闭链迟到的 engine_closed 不得把状态
   * 复活为 exited——否则下一次 run 会把终局错误（协议不匹配/握手超时）当作可重试、
   * 重新 spawn 引擎。
   */
  private channelErrorUnavailable = false;
  /**
   * 「连接/根换绑」单飞槽（R2A-N2）：ensureConnected 的统一入口。成立前探针→run
   * 并发调用会让两个调用方同时通过 ready 检查、双起 connectOnce（一个 run 握到
   * 另一个的通道，engine_open 被误拆）。所有连接/换绑必须经本槽串行化；finally
   * 以 promise 身份比对清位（旧代 finally 不得清掉后来者新设的代）。
   */
  private connectOrRebindInFlight: Promise<void> | undefined;
  private pidfileSwept = false;
  /**
   * 主动杀标记（日志分级消费点）：killAll/dispose 置位、connectOnce 复位——exit
   * 投影据此区分「主动杀后的预期收敛（debug）」与「意外崩溃（warn 出声）」。进程面
   * 的同名门在 transport 内部（收割跳过/去重），两侧在同一点位同步置位。
   */
  private intentionalKill = false;
  /** run 期 host/handleReady 的最近回填（崩溃时在途 run 的合成 handle 数据源）。 */
  private lastPartialHandle: { sessionRef: Record<string, string> } | undefined;
  private initializeDiagnostics: InitializeResult | undefined;

  constructor(opts: EngineClientOptions) {
    this.opts = opts;
    this.engineId = opts.engineId;
    this.reverseRouterDeps = {
      engineId: opts.engineId,
      runRoutes: this.runRoutes,
      mirror: this.mirror,
      setPartialHandle: (partial) => {
        this.lastPartialHandle = partial;
      },
      sendResponse: (id, result) => this.sendResponse(id, result),
      failEngine: (reason) => this.killAll(reason),
      isDisposed: () => this.disposed,
    };
    this.mirror.onChange((event) => {
      // [u7a 生产补挂] 反向通道镜像事件同步投影进 core 侧镜像 + 推送在途计数
      //（数据面桥接，见 bridgeMirrorEventToCoreMirror 与文件头 u7a 注释）。
      bridgeMirrorEventToCoreMirror(event, this.mirror);
    });
  }

  get currentState(): EngineClientState {
    return this.state;
  }

  /** disposed 判定（getter 形态——TS 不对跨 await 的字段窄化保持，字段直比会在长方法内误窄化）。 */
  private get disposed(): boolean {
    return this.state === "disposed";
  }

  /**
   * local transport 投影（pidfile/reaper 仅 local 模式注册的编排门，impl-plan
   * 验收③）：runtime transport 模式下为 undefined，进程面收割段全部缺席。
   */
  private get localTransport(): LocalEngineTransport | undefined {
    return this.transport instanceof LocalEngineTransport ? this.transport : undefined;
  }

  /**
   * transport 选择（D5 谓词，单源 = transport-selection.ts：isForcedLocalTransport /
   * usesRuntimeTransport，底层 isControlEnvActive）：control env 非空 →
   * RuntimeEngineTransport（control socket 通道；connect/hello 失败 →
   * engine_transport_unavailable，不静默回退 local）；空串/缺失 → LocalEngineTransport
   * （standalone）。每代引擎连接一份 transport 实例（open/close 生命周期 = 单通道）。
   * protected = 测试 seam（错误码 preserve 白名单单测注入假 transport）。
   */
  protected resolveTransport(): EngineTransport {
    const baseEnv = this.opts.baseEnv ?? process.env;
    // [D9 逃生舱] 优先于 control env 激活判定：值 local → 强制 local（排障回退）。
    if (isForcedLocalTransport(baseEnv)) {
      logger.warn(
        `[engine-client:${this.engineId}] ${SUBAGENT_TRANSPORT_ENV}=local → forcing local transport (D9 escape hatch)`,
      );
      return this.createLocalTransport();
    }
    if (usesRuntimeTransport(baseEnv)) {
      logger.debug(`[engine-client:${this.engineId}] transport selected: runtime control channel`);
      return new RuntimeEngineTransport({
        engineId: this.opts.engineId,
        hostKind: this.opts.hostKind,
        baseEnv: this.opts.baseEnv,
        onStderr: (chunk) => this.appendStderrTail(chunk),
      });
    }
    // 设计 D5：「空串/缺失 → local（warn）」。生产日志默认不落 debug，回落原因必须
    // 在 warn 级可见（排障面：standalone vs 托管态 control env 未注入）。
    logger.warn(`[engine-client:${this.engineId}] transport selected: local (no control env)`);
    return this.createLocalTransport();
  }

  /** local transport 装配（正常谓词与 D9 逃生舱共用，避免两处漂移）。 */
  private createLocalTransport(): LocalEngineTransport {
    return new LocalEngineTransport({
      engineId: this.opts.engineId,
      dataDir: this.opts.dataDir,
      hostKind: this.opts.hostKind,
      baseEnv: this.opts.baseEnv,
      engineNode: this.opts.engineNode,
      electronRunAsNode: this.opts.electronRunAsNode,
      identityEnv: this.opts.identityEnv,
      processEnv: this.opts.processEnv,
      engineCmdlineMatcher:
        this.opts.engineCmdlineMatcher ?? defaultEngineCmdlineMatcher(this.opts.command),
      onStderr: (chunk) => this.appendStderrTail(chunk),
      listLiveOrphanPids: () =>
        this.mirror
          .snapshot()
          .filter((e) => e.state === "running" && !e.killed)
          .map((e) => e.pid),
    });
  }

  /**
   * [B-U-1] 连接级根会话换绑：runtime 通道的 engine_open 归属键在 open 时固定，
   * 后续同连接再 open 会被 runtime 以 `engine_open_failed session` 拒绝。因此当
   * run ctx 提供权威根且与在通道实际绑定值不同（探针先以 control env 的 spawn 期
   * 初值建连的场景）时，换代重连：关旧通道（runtime 杀组回收）→ 协议面清理 →
   * 由调用方继续走 connectOnce 用新根 open。
   *
   * [R2A-N2] 调用方持单飞槽（connectOrRebindInFlight），因此本方法内部无并发第二
   * 调用方；但 `await close` 期间仍可能发生直接 request / run 路由注册（不保证都经
   * ensureConnected），且 transport 也可能被外部终局链替换——await 后必须复检，
   * 否则会拆掉新 transport 或打断刚起的 run（TOCTOU）。
   *
   * 有在途请求/run 路由时不动连接（跑着的 run 不得被根换绑打断），warn 留痕；
   * 单 pi 进程生命周期内根会话不应变化，命中该分支即宿主误用信号。
   * 返回 true = 已换绑（调用方需重连）；false = 无需换绑或保持现状。
   */
  private async rebindRootSessionIfNeeded(): Promise<boolean> {
    const requested = this.requestedRootSessionId;
    const transport = this.transport;
    if (requested === undefined || !(transport instanceof RuntimeEngineTransport)) return false;
    if (transport.rootSessionId === requested) return false;
    if (this.pending.size > 0 || this.runRoutes.size > 0) {
      logger.warn(
        `[engine-client:${this.engineId}] root session "${requested}" differs from the open channel `
          + `("${transport.rootSessionId ?? "unknown"}") but requests/runs are in flight — keeping the current channel`,
      );
      return false;
    }
    logger.debug(
      `[engine-client:${this.engineId}] rebinding engine channel root session `
        + `"${transport.rootSessionId ?? "unknown"}" -> "${requested}"`,
    );
    await transport.close("root session rebind");
    // [R2A-N2] await 后复检（单飞锁外的旁路）：
    // ① 有人重建了通道（transport 换代）——绝不能用旧观察拆掉新 transport；
    // ② 有在途请求/run 路由出现——换绑已不再安全，保持现状（旧通道仍可用）。
    if (this.transport !== transport) {
      logger.warn(
        `[engine-client:${this.engineId}] engine channel changed while rebinding the root session — `
          + "not tearing down the replacement transport",
      );
      return false;
    }
    if (this.pending.size > 0 || this.runRoutes.size > 0) {
      logger.warn(
        `[engine-client:${this.engineId}] requests/runs appeared while rebinding the root session — `
          + "keeping the current channel",
      );
      return false;
    }
    if (this.disposed || this.state === "unavailable") return false;
    this.teardownProcess("root session rebind");
    this.state = "idle";
    return true;
  }

  /** 引擎 CLI 进程 pid（未连接 / 已终局清理 = undefined）。 */
  get enginePid(): number | undefined {
    return this.localTransport?.pid;
  }

  /** stderr 环形缓冲尾（engine_crashed 现场 / 诊断）。 */
  get stderrTailText(): string {
    return this.stderrTail;
  }

  /** 最近一次 host/handleReady 回填（RemoteEngine 崩溃合成 handle 用）。 */
  getPartialHandle(): { sessionRef: Record<string, string> } | undefined {
    return this.lastPartialHandle;
  }

  /** initialize 应答（诊断面；RemoteEngine 诊断留痕用）。 */
  getInitializeDiagnostics(): InitializeResult | undefined {
    return this.initializeDiagnostics;
  }

  /**
   * 确保引擎 CLI 已连接（spawn + initialize 握手）。幂等；[ADR-0122] 失败显式上报：
   * 初建失败一次即标记不可用（unavailable 恒 throw，错误附恢复指引），修复由用户
   * 排查后重启宿主承接。[HISTORICAL] 原退避 1s/2s/4s × 3 次自动重建已删。
   * 版本协商越界 → engine_protocol_mismatch + 直接标记不可用。
   *
   * [B-U-1 根会话权威] rootSessionId 可选：run 路径传 RunContext.sessionRootId
   * （engine_open 归属键权威源）。连接已按 env 回落的旧根打开（如探针先于 run）
   * 且当前无在途 run 时，换代重连让新的权威根生效；有在途 run 时保持旧连接并 warn
   * （根会话在单 pi 进程生命周期内不变，跨根切换只可能来自宿主误用）。
   *
   * [R2A-N2 单飞] 连接与根换绑是同一个串行状态迁移：所有调用方在这里统一排队到
   * 一个 connectOrRebind promise（不区分「首连/换代」）。这样探针后并行两个 run
   * 不会双双通过 ready 检查后各起一代 connectOnce（旧实现会双连接并误拆新
   * transport）。排队返回后按最新权威根再判一次：根是在等待期间才到的（探针先到）
   * 就在本调用里补一次换代，而不是把旧根交给 run。
   */
  async ensureConnected(rootSessionId?: string): Promise<void> {
    if (rootSessionId !== undefined && rootSessionId.length > 0) {
      this.requestedRootSessionId = rootSessionId;
    }
    for (;;) {
      this.assertConnectable();
      const inFlight = this.connectOrRebindInFlight;
      if (inFlight === undefined) break;
      // 等当前代落地（成功/失败都由发起者与本调用共享终态）；落地后再看本调用
      // 记录的权威根是否已被满足，未满足则进入下一轮（再取/再起一代）。
      await inFlight;
    }
    this.assertConnectable();
    if (this.state === "ready" && !this.needsRootRebind()) return;

    const op = this.connectOrRebind();
    this.connectOrRebindInFlight = op;
    try {
      await op;
    } finally {
      // 代数守卫：只清自己的槽（旧代 finally 不得清掉后来者新设的 promise）。
      if (this.connectOrRebindInFlight === op) this.connectOrRebindInFlight = undefined;
    }
  }

  /** 终结态检查（单点，保证排队前后一致地 fail-fast）。 */
  private assertConnectable(): void {
    if (this.disposed) {
      throw new EngineSdkError(
        "engine_crashed",
        `engine client for "${this.engineId}" is disposed`,
        "Create a new engine client / RemoteEngine instance.",
      );
    }
    if (this.state === "unavailable") {
      throw this.unavailableReason ?? new Error(`engine "${this.engineId}" is unavailable`);
    }
  }

  /** 权威根是否需要换代（只读判定；副作用在 rebindRootSessionIfNeeded）。 */
  private needsRootRebind(): boolean {
    const requested = this.requestedRootSessionId;
    const transport = this.transport;
    if (requested === undefined || !(transport instanceof RuntimeEngineTransport)) return false;
    return transport.rootSessionId !== requested;
  }

  /** 单飞段：要么换代重连（ready + 根不一致），要么首连。 */
  private async connectOrRebind(): Promise<void> {
    if (this.state === "ready") {
      const rebound = await this.rebindRootSessionIfNeeded();
      if (!rebound) return;
    }
    await this.connectOnce();
  }

  private async connectOnce(): Promise<void> {
    this.state = "connecting";
    this.intentionalKill = false;
    this.channelErrorUnavailable = false;
    try {
      // transport 选择（D5 谓词，见 resolveTransport；谓词失败 = engine_transport_unavailable
      // 显式失败，经下方同一条 catch 标记不可用——不静默 local）+ 帧面订阅（open 后即可到达）。
      const transport = this.resolveTransport();
      this.transport = transport;
      transport.onFrame((line) => this.handleLine(line));
      transport.onExit((info) => this.onTransportExit(info));
      // [M3] 传输面错误订阅（runtime 实现提供）：连接死亡 / 通道级 error 帧以具体码
      // 收口在途请求（D5/D8，不包装 engine_crashed）。local 实现缺席。
      transport.onTransportError?.((err) => this.onTransportError(err));
      // 启动期清扫（每实例一次；仅 local transport——runtime 模式无 pidfile/reaper，
      // 验收③）：宿主崩溃残留的同 id 引擎孤儿 + 陈旧 pidfile。
      if (!this.pidfileSwept) {
        this.pidfileSwept = true;
        const local = this.localTransport;
        if (local !== undefined) {
          const sweep = local.sweepStalePidfiles();
          if (sweep.killed.length > 0) {
            logger.warn(
              `[engine-client:${this.engineId}] startup sweep killed stale orphan engine pids: ${sweep.killed.join(",")}`,
            );
          }
          for (const removed of sweep.removed) {
            logger.debug(`[engine-client:${this.engineId}] swept stale pidfile ${removed.file}: ${removed.reason}`);
          }
        }
      }

      await this.spawnAndInitialize(transport);
      this.state = "ready";
    } catch (err) {
      this.teardownProcess("handshake failed");
      // [ADR-0122] 单次失败即显式上报 + 标记不可用（无自动重建）。
      // transport 错误码白名单原样 preserve（不包装成 engine_crashed）：runtime
      // 通道的 transport_unavailable/lost/open_timeout/frame_too_large/backpressure_overflow
      // 与协议版本越界同属「错误即语义」面（impl-plan u-m3-local 验收②）；其余
      // （含 engine_not_found 等启动解析错误）维持既有 engine_crashed 包装。
      const failure = err instanceof Error ? err : new Error(String(err));
      const unavailable =
        err instanceof EngineSdkError && (isPreservedConnectErrorCode(err.code) || isPreservedControlCrash(err))
          ? err
          : new EngineSdkError(
            "engine_crashed",
            `engine "${this.engineId}" failed to start: ${failure.message}`,
            "Fix or reinstall the engine package, then restart the host. The engine stays "
              + "unavailable until the next host start.",
          );
      this.markUnavailable(unavailable);
      throw unavailable;
    }
  }

  private markUnavailable(reason: EngineSdkError): void {
    this.state = "unavailable";
    this.unavailableReason = reason;
    logger.error(`[engine-client:${this.engineId}] marked unavailable: ${reason.message}`);
  }

  /** spawn 引擎通道（transport 层）+ initialize 握手 + 版本协商 + 诊断留痕。 */
  private async spawnAndInitialize(transport: EngineTransport): Promise<void> {
    // transport.open = spawn 引擎 CLI（stdio 接线 + env 三层契约 buildEngineChildEnv
    // + 平台 spawn 形态 + pidfile 注册，local 实现）；initialize 握手留在本层
    // （协议面——types.ts 契约边界：请求 id 关联/超时/版本协商不进 transport）。
    await transport.open({
      engineId: this.opts.engineId,
      entryPath: this.opts.command,
      args: [...this.opts.args],
      cwd: this.opts.cwd ?? process.cwd(),
      envPrefixes: [...(this.opts.envPrefixes ?? [])],
      // runtime 归属键：run 路径传 RunContext.sessionRootId（权威源）；未注入
      // （探针 / standalone）传空串占位，由 runtime transport 以 control env 回落。
      // local 实现忽略（types.ts rootSessionId 注）。
      rootSessionId: this.requestedRootSessionId ?? "",
    });

    // initialize 握手（HANDSHAKE_TIMEOUT_MS；版本越界 → mismatch + 不可用）。
    const initParams = {
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      hostInfo: {
        name: this.opts.hostKind,
        version: this.opts.hostVersion ?? process.version,
        dataRoot: this.opts.dataDir,
      },
      engineConfig: this.opts.engineConfig ?? {},
    };
    let result: InitializeResult;
    try {
      result = (await this.request("initialize", initParams, {
        timeoutMs: HANDSHAKE_TIMEOUT_MS,
      })) as InitializeResult;
    } catch (err) {
      if (err instanceof EngineSdkError && err.code === "engine_handshake_timeout") {
        throw new EngineSdkError(
          "engine_handshake_timeout",
          `engine "${this.engineId}" did not answer initialize within ${HANDSHAKE_TIMEOUT_MS}ms`,
          "Check that the engine package is executable and speaks engine-protocol v1. "
            + "The engine is marked unavailable until it answers a handshake.",
        );
      }
      throw err;
    }

    if (!isProtocolVersionCompatible(result.protocolVersion)) {
      throw engineProtocolMismatchError(result.protocolVersion);
    }

    this.initializeDiagnostics = result;
    warnOnManifestDiagnostics(this.engineId, this.opts.manifestDiagnostics, result);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 帧路由（stdout 行切分与残片上限在 transport 层；此处收已切好的行）
  // ─────────────────────────────────────────────────────────────────────────

  private handleLine(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      logger.warn(
        `[engine-client:${this.engineId}] dropped non-NDJSON stdout line (protocol contract: stdout is NDJSON-only): ${truncate(line, FRAME_ECHO_MAX_CHARS)}`,
      );
      return;
    }
    if (isResponseFrame(frame)) {
      this.onResponseFrame(frame);
      return;
    }
    if (isNotificationFrame(frame)) {
      this.onEventNotification(frame.params.runId, frame.params.event);
      return;
    }
    if (isReverseRequestFrame(frame)) {
      this.onReverseRequest(frame);
      return;
    }
    logger.warn(
      `[engine-client:${this.engineId}] dropped unrecognized frame: ${truncate(line, FRAME_ECHO_MAX_CHARS)}`,
    );
  }

  private onResponseFrame(frame: { id: number | string; result?: unknown; error?: unknown }): void {
    if (typeof frame.id !== "number") return; // 反向请求的应答由 core 发出，不走本表
    const pending = this.pending.get(frame.id);
    if (!pending) return; // 迟到应答（已超时被拒）——丢弃
    this.pending.delete(frame.id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    const error = frame.error as { code?: string; message?: string; recovery?: string } | undefined;
    if (error !== undefined && typeof error === "object") {
      pending.reject(
        new EngineSdkError(
          typeof error.code === "string" ? error.code : "engine_unknown",
          typeof error.message === "string" ? error.message : JSON.stringify(error),
          typeof error.recovery === "string" ? error.recovery : "Inspect the engine error and retry.",
        ),
      );
      return;
    }
    pending.resolve(frame.result);
  }

  private onEventNotification(runId: string, event: unknown): void {
    this.runRoutes.get(runId)?.onEvent?.(event);
  }

  /** 帧④入口（路由实现见 reverse-router.ts——超时域二分的 core 侧语义所在）。 */
  private onReverseRequest(frame: { id: string; method: string; params: unknown }): void {
    routeReverseRequest(this.reverseRouterDeps, frame);
  }

  // ── 正向请求 ────────────────────────────────────────────────────────────

  /**
   * 发帧①并等帧②。opts.timeoutMs = 数据面超时域（initialize 等）；不传 = 任务级
   * 默认无超时（run，AGENTS.md 规则 19 / ADR-0047）。
   */
  request(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
    if (this.state === "disposed" || this.state === "unavailable") {
      return Promise.reject(
        this.unavailableReason
          ?? new EngineSdkError(
            "engine_crashed",
            `engine client for "${this.engineId}" is ${this.state}`,
            "Rebuild the connection via ensureConnected or recreate the client.",
          ),
      );
    }
    const id = this.nextRequestId++;
    const frame: RequestFrame = { id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, timer: undefined };
      if (opts?.timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new EngineSdkError(
              method === "initialize" ? "engine_handshake_timeout" : "engine_request_timeout",
              `engine "${this.engineId}" did not answer ${method} (id=${id}) within ${opts.timeoutMs}ms`,
              "Retry the operation; if it persists the engine process is faulted and will be rebuilt.",
            ),
          );
        }, opts.timeoutMs);
      }
      this.pending.set(id, pending);
      if (!this.writeFrame(frame)) {
        this.pending.delete(id);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        reject(
          engineCrashedError(
            `stdin write failed while sending ${method}`,
            this.stderrTail,
          ),
        );
      }
    });
  }

  /** 注册 run 作用域反向通知路由；返回注销函数。 */
  registerRunRoute(runId: string, route: RunRoute): () => void {
    this.runRoutes.set(runId, route);
    return () => {
      if (this.runRoutes.get(runId) === route) {
        this.runRoutes.delete(runId);
      }
    };
  }

  /** cancel 受理窗口 = CANCEL_SETTLE_GRACE_MS；终态收敛由调用方（RemoteEngine）等 run 应答。 */
  async cancelRun(runId: string, reason: string): Promise<void> {
    await this.request("cancel", { runId, reason }, { timeoutMs: CANCEL_SETTLE_GRACE_MS });
  }

  /**
   * [subagent-model-switch §7.3] setModel 类型化调用面（cancelRun 同族）：控制面单
   * 请求，上界 SET_MODEL_REQUEST_TIMEOUT_MS（10s——≥ 引擎侧两阶段窗 2×3s + 协议
   * 余量；控制面单请求必须秒级有界，宿主不悬挂）。错误经 error 帧 reject 为
   * EngineSdkError（code 原样保留——三型失败分型 + engine_run_not_active 无活进程
   * 形态，宿主编排按 §7.2 处置表分派）。
   */
  async setModel(params: SetModelParams): Promise<SetModelResult> {
    const result = await this.request("setModel", params, {
      timeoutMs: SET_MODEL_REQUEST_TIMEOUT_MS,
    });
    return result as SetModelResult;
  }

  // ── 收割 / 停机 ──────────────────────────────────────────────────────────

  /**
   * 宿主收割入口（D8 markAllSpawnedChildrenDead 落点）：组杀引擎 CLI（transport
   * close = POSIX 负 pid 组杀 / Windows taskkill /T /F + 有界收尸）+ 镜像整体置死
   * + pidfile 清理。在途请求以 engine_crashed 失败。「零残留」断言范围 = 一代子进程
   * + 组内后代（引擎自身 detached 后代不覆盖，impl-plan §7.2 R9-1 / 设计 §3.9 已
   * 接受代价）。
   */
  async killAll(reason: string): Promise<void> {
    this.intentionalKill = true;
    await this.transport?.close(reason);
    this.teardownProcess(reason);
  }

  /**
   * 协议 dispose：dispose 帧（3s 上界）→ 组杀兜底 → 清理。幂等。
   * dispose 后首个 run 的重建由新的连接状态机承担（EnginePort.dispose 契约）。
   */
  async dispose(): Promise<void> {
    if (this.state === "disposed") return;
    // local：进程存活才发 dispose 帧（死进程由 killAll 收割）；runtime：无 local 进程
    // 句柄，通道存活由 request/writeFrame 回执表达（缺省继续，失败经 catch 兜底）。
    if (this.state === "ready" && (this.localTransport?.isProcessAlive() ?? true)) {
      try {
        await this.request("dispose", {}, { timeoutMs: DISPOSE_GRACE_MS });
      } catch (err) {
        // dispose 帧失败（超时/进程已死）→ 直接走杀链兜底，debug 留痕。
        logger.debug(
          `[engine-client:${this.engineId}] dispose frame failed, falling back to kill chain: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    await this.killAll("dispose");
    this.state = "disposed";
  }

  /**
   * 引擎通道终局（transport exit 投影消费）：日志分级 + 协议面终局清理 + 状态回落。
   * 进程面终局（孤儿收割/pidfile 删/句柄清理）已由 transport 内部在派发前完成。
   * reason 是 runtime engine_closed 帧的归因值（local 缺席）——进诊断 detail。
   */
  private onTransportExit(info: EngineTransportExitInfo): void {
    const reason = info.reason !== undefined ? `, reason ${info.reason}` : "";
    const detail = info.signal !== null ? `signal ${info.signal}${reason}` : `exit code ${info.code}${reason}`;
    // intentionalKill 消费点：主动杀（killAll/dispose）后的 exit 是预期收敛（debug）；
    // 非主动杀 = 意外崩溃（warn 出声，供排障区分「引擎自己挂了」与「宿主收割」）。
    if (this.intentionalKill) {
      logger.debug(`[engine-client:${this.engineId}] engine exited after intentional kill (${detail}) — expected`);
    } else {
      logger.warn(`[engine-client:${this.engineId}] engine process exited unexpectedly (${detail})`);
    }
    this.teardownProcess(detail);
    // [ADR-0122] 状态回落复用 teardownProcess 的守卫（state !== unavailable /
    // disposed），不再无条件重置：connect/握手失败标记的不可用是终局，teardownProcess
    // 关闭链迟到的 engine_closed 不得把它复活为 exited。唯一例外 = 通道级 transport
    // error 触发的不可用（channelErrorUnavailable）——通道死、control 连接仍活，本回执
    // 即通道终局回执，回落 exited 让下一次 run 在同一连接上重建（D5/D8）。
    if (this.state === "unavailable" && this.channelErrorUnavailable) {
      this.state = "exited";
    }
    this.channelErrorUnavailable = false;
  }

  /**
   * 传输面错误（D5/D8：control 连接死亡 / 通道级 error 帧）：以具体码 reject 全部
   * in-flight 请求（不包装 engine_crashed）。连接死亡保持 unavailable（不重试）；
   * 通道级错误随后续 engine_closed 回落 exited（下次 run 可重建，与引擎崩溃同语义）。
   * 顺序契约：先于该通道 engine_closed 的 onExit 清理——pending 已空，迟到的
   * onExit 不会覆盖具体错误码。
   */
  private onTransportError(err: EngineSdkError): void {
    if (this.disposed) return;
    logger.warn(`[engine-client:${this.engineId}] transport error: ${err.message}`);
    for (const [, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.runRoutes.clear();
    this.lastPartialHandle = undefined;
    this.mirror.killAll();
    if (err.code === "unknown_channel") {
      // [m-core-3] unknown_channel 是通道终局、control 连接仍活（runtime 该路径只发
      // error 帧、不跟 engine_closed）：无条件 markUnavailable 会让状态永久停在
      // unavailable（下一次 ensureConnected 直接抛旧错误）。回落 exited，让下一次
      // run 在活连接上重新 engine_open（与 engine_closed 的收敛语义一致）。
      if (this.state !== "unavailable" && this.state !== "disposed") this.state = "exited";
    } else if (this.state !== "unavailable") {
      // 通道级错误：不可用只是中间态（fail-fast 收口在途请求），随后的 engine_closed
      // 由 onTransportExit 回落 exited（channelErrorUnavailable 消费点）——通道死、
      // control 连接仍活，下一次 run 可在同一连接上重建。
      this.channelErrorUnavailable = true;
      this.markUnavailable(err);
    }
    // 通道/连接已裁决终局：让 transport 收敛（连接死亡时通道已清 → 立即 resolve；
    // 通道级 error 时加入 engine_close 宽限/engine_closed 回收链）——fire-and-forget。
    void this.transport?.close(`transport error: ${err.code}`);
  }

  /**
   * 进程死亡 / 失败后的统一清理（进程面段委托 transport、协议面段留守，此处只做
   * 顺序编排）：孤儿收割（镜像置死前，transport 幂等）→ 镜像置死（失效语义 2+3）→
   * pidfile 删 → 在途请求 engine_crashed（附 stderr 尾）→ run 路由清空 → 活引擎
   * 组杀兜底。runtime transport 无 local 进程面（引擎归 runtime）——发 engine_close
   * 让 runtime 杀组回收（fire-and-forget：同步终局段不阻塞在途 reject 链）。
   */
  private teardownProcess(detail: string): void {
    const local = this.localTransport;
    local?.reapOrphansAfterUnexpectedDeath(detail);
    this.mirror.killAll();
    local?.removePidfile();
    const err = engineCrashedError(detail, this.stderrTail);
    for (const [, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.runRoutes.clear();
    this.lastPartialHandle = undefined;
    local?.killLeakedChild(detail);
    if (local === undefined) {
      void this.transport?.close(detail);
    }
    if (this.state !== "unavailable" && this.state !== "disposed") {
      this.state = "exited";
    }
  }

  // ── 帧写出口（transport 委托）──────────────────────────────────────────────

  private writeFrame(frame: unknown): boolean {
    return this.transport?.writeFrame(JSON.stringify(frame)) ?? false;
  }

  private sendResponse(id: string, result: unknown): boolean {
    return this.writeFrame({ id, result });
  }

  private appendStderrTail(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  }
}

// ── 内部工具 ─────────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}


