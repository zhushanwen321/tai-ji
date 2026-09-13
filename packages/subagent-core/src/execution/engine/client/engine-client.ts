// src/execution/engine/client/engine-client.ts
//
// EngineClient：协议客户端（W2，impl-plan §2.2；与 zcode AppServerConnection 同型
// 但引擎无关）。职责 = spawn 引擎 CLI / NDJSON 帧编解码 / 请求-应答 id 关联 /
// 反向请求路由（见 reverse-router.ts）/ 崩溃重建（≤3 次指数退避 1s/2s/4s）/
// dispose / killAll / stdout 行解析 + stderr 常驻排空（仅内存环缓冲尾 400 字符）。
//
// spawn 平台参数（impl-plan §2.2 必写死）：POSIX 引擎 CLI 以独立进程组 spawn
// （detached:true，进程组收割前提）；Windows detached:false + windowsHide:true，
// 收割走 taskkill /PID <pid> /T /F。spawn 点区分：SDK spawnEngineChild 是引擎包内
// 「任务子进程」原语（硬编码 detached:false 且禁 detached 键，impl-plan §2.12）；
// 本类 spawn 的是引擎 CLI 进程本身（impl-plan §2.2 detached:true），二者是协议两侧
// 的两个 spawn 点，故此处直接用 node:child_process。env 仍必经 SDK
// buildEngineChildEnv（三层契约，DAG 边 W12→W2）。
//
// 引擎自灭 core 侧配套：spawn 不覆写引擎 stdin（stdio[0] = 'pipe' 独占管道，core
// 是唯一写端）——引擎侧 stdio EOF 主判据（SDK armEngineSelfDestruct）的前提。
// 超时域划分（R9-2 / R9-2b）的实现与注释在 reverse-router.ts（反向面）与本文件
// 正向请求段；run 不设墙钟（任务级默认无超时，AGENTS.md 规则 19 / ADR-0047）。

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import {
  buildEngineChildEnv,
  CANCEL_SETTLE_GRACE_MS,
  CRASH_REBUILD_BACKOFF_MS,
  CRASH_REBUILD_MAX_ATTEMPTS,
  ENGINE_PROTOCOL_VERSION,
  EngineSdkError,
  HANDSHAKE_TIMEOUT_MS,
  getLogger,
  isProtocolVersionCompatible,
  isResponseFrame,
  isNotificationFrame,
  isReverseRequestFrame,
  STDERR_TAIL_CHARS,
  engineProtocolMismatchError,
  hostKindOf,
  resolveEngineNodeLaunch,
  type EngineHandleData,
  type InitializeResult,
  type RequestFrame,
} from "@zhushanwen/subagent-engine-sdk";

import { SpawnedChildrenMirror, type MirrorChangeEvent } from "./mirror.ts";
import {
  removePidfile,
  registerEnginePidfile,
  sweepEnginePidfiles,
} from "./pid-file.ts";
import { routeReverseRequest, type ReverseRouterDeps } from "./reverse-router.ts";
import {
  defaultEngineCmdlineMatcher,
  warnOnManifestDiagnostics,
  type EngineClientOptions,
} from "./client-options.ts";
import { killProcessTree, waitForChildExit } from "./reaper.ts";
// [u7a 生产补挂] 反向通道镜像 → core 侧镜像桥接：in-flight 计数与生命周期谓词读 core
// 全局镜像（recordId 键），而引擎侧子进程上报只落 EngineClient 镜像——本桥接实现
// spawned-children.ts 头注「数据源①：反向通道上报落本镜像」的既登记契约（W3 协议化
// 后 ctx.onChildSpawned 不被调用，该数据面悬空致计数恒 0），见 crash-forensics §7 v7。
import { coreSpawnedChildrenMirror } from "../host/spawned-children.ts";
import { notifyInFlightChanged } from "../inflight-snapshot.ts";

const logger = getLogger("subagents");

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

/** dispose 帧等待上界（设计 §3.6：dispose 上界 3s，超时即杀）。 */
const DISPOSE_GRACE_MS = 3_000;
/** SIGKILL 后收尸等待上限（kill-chain 同型有界兜底，reaper.waitForChildExit 消费）。 */
const SIGKILL_REAP_TIMEOUT_MS = 10_000;
/** 协议帧违规日志的回显截断长度（非 NDJSON 行 / 未知帧的诊断留痕）。 */
const FRAME_ECHO_MAX_CHARS = 200;

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

/** spawn 引擎 CLI 平台形态（impl-plan §2.2 必写死的两行）。 */
interface EngineSpawnPlatformOptions {
  detached: boolean;
  windowsHide: boolean;
}

function engineSpawnPlatformOptions(): EngineSpawnPlatformOptions {
  if (process.platform === "win32") {
    return { detached: false, windowsHide: true };
  }
  return { detached: true, windowsHide: false };
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
  private child: ChildProcess | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly runRoutes = new Map<string, RunRoute>();
  private stderrTail = "";
  private unavailableReason: EngineSdkError | undefined;
  private connectInFlight: Promise<void> | undefined;
  private pidfileWritten: string | undefined;
  private pidfileSwept = false;
  private intentionalKill = false;
  /** run 期 host/handleReady 的最近回填（崩溃时在途 run 的合成 handle 数据源）。 */
  private lastPartialHandle: { sessionRef: Record<string, string> } | undefined;
  private initializeDiagnostics: InitializeResult | undefined;
  private stdoutBuffer = "";

  constructor(opts: EngineClientOptions) {
    this.opts = opts;
    this.engineId = opts.engineId;
    this.reverseRouterDeps = {
      engineId: opts.engineId,
      uiRequestHandler: opts.uiRequestHandler,
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

  /** 引擎 CLI 进程 pid（未连接 = undefined）。 */
  get enginePid(): number | undefined {
    return this.child?.pid;
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
   * 确保引擎 CLI 已连接（spawn + initialize 握手）。幂等；崩溃后按重建状态机重试：
   * 初建失败 → 退避 1s/2s/4s 各重建一次（共 1 + CRASH_REBUILD_MAX_ATTEMPTS 次
   * spawn 尝试），全败标记不可用直到宿主重启（unavailable 恒 throw）。
   * 版本协商越界 → engine_protocol_mismatch + 直接标记不可用（不重试）。
   */
  async ensureConnected(): Promise<void> {
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
    if (this.state === "ready") return;
    if (this.connectInFlight) return this.connectInFlight;

    this.connectInFlight = this.connectWithRebuild();
    try {
      await this.connectInFlight;
    } finally {
      this.connectInFlight = undefined;
    }
  }

  private async connectWithRebuild(): Promise<void> {
    this.state = "connecting";
    // 启动期清扫（每实例一次）：宿主崩溃残留的同 id 引擎孤儿 + 陈旧 pidfile。
    if (!this.pidfileSwept) {
      this.pidfileSwept = true;
      const sweep = sweepEnginePidfiles({
        engineDataDir: this.opts.dataDir,
        engineId: this.engineId,
        currentHostPid: process.pid,
        matchesEngineCmdline: this.opts.engineCmdlineMatcher
          ?? defaultEngineCmdlineMatcher(this.opts.command),
      });
      if (sweep.killed.length > 0) {
        logger.warn(
          `[engine-client:${this.engineId}] startup sweep killed stale orphan engine pids: ${sweep.killed.join(",")}`,
        );
      }
      for (const removed of sweep.removed) {
        logger.debug(`[engine-client:${this.engineId}] swept stale pidfile ${removed.file}: ${removed.reason}`);
      }
    }

    let attempt = 0;
    // 序列：attempt 0 = 初建；1..CRASH_REBUILD_MAX_ATTEMPTS = 重建（退避 1s/2s/4s）。
    while (attempt <= CRASH_REBUILD_MAX_ATTEMPTS) {
      if (attempt > 0) {
        const backoff = CRASH_REBUILD_BACKOFF_MS[attempt - 1];
        logger.warn(
          `[engine-client:${this.engineId}] rebuild attempt ${attempt}/${CRASH_REBUILD_MAX_ATTEMPTS} after ${backoff}ms backoff`,
        );
        await delay(backoff);
        if (this.disposed) return;
      }
      try {
        await this.spawnAndInitialize();
        this.state = "ready";
        return;
      } catch (err) {
        this.teardownProcess("handshake failed");
        if (err instanceof EngineSdkError && err.code === "engine_protocol_mismatch") {
          // 版本越界：重建无意义（每次都会越界）→ 直接标记不可用。
          this.markUnavailable(err);
          throw err;
        }
        attempt += 1;
        if (attempt > CRASH_REBUILD_MAX_ATTEMPTS) {
          const failure =
            err instanceof Error ? err : new Error(String(err));
          const unavailable = new EngineSdkError(
            "engine_crashed",
            `engine "${this.engineId}" failed to start after `
              + `${1 + CRASH_REBUILD_MAX_ATTEMPTS} attempts (initial + ${CRASH_REBUILD_MAX_ATTEMPTS} rebuilds): ${failure.message}`,
            "Fix or reinstall the engine package, then restart the host. The engine stays "
              + "unavailable until the next host start.",
          );
          this.markUnavailable(unavailable);
          throw unavailable;
        }
      }
    }
  }

  private markUnavailable(reason: EngineSdkError): void {
    this.state = "unavailable";
    this.unavailableReason = reason;
    logger.error(`[engine-client:${this.engineId}] marked unavailable: ${reason.message}`);
  }

  /** spawn 引擎 CLI + initialize 握手 + 版本协商 + 诊断留痕。 */
  private async spawnAndInitialize(): Promise<void> {
    this.intentionalKill = false;
    const platformOpts = engineSpawnPlatformOptions();
    // [W9] 启动解析（宿主 × 平台二维矩阵，impl-plan §2.9）：spawn argv 先经 SDK
    // resolveEngineNodeLaunch 解析——打包态 pi 宿主必须用注入执行器
    // XYZ_AGENT_ENGINE_NODE（pi binary 不是 node 执行器）、runtime sidecar 用
    // process.execPath、standalone 用 PATH node（缺 node / 探针失败 → engine_not_found）。
    // Windows .cmd 入口在此改写为显式 cmd.exe /c + 参数数组（禁 shell:true）。
    const baseEnv = this.opts.baseEnv ?? { ...process.env };
    const launch = await resolveEngineNodeLaunch({
      entryPath: this.opts.command,
      args: this.opts.args,
      hostKind: hostKindOf(this.opts.hostKind, baseEnv),
      env: baseEnv,
    });
    const env = buildEngineChildEnv(baseEnv, {
      dataDir: this.opts.dataDir,
      engineNode: this.opts.engineNode ?? launch.command,
      electronRunAsNode: this.opts.electronRunAsNode ?? launch.electronRunAsNode,
      relay: this.opts.relay,
      identityEnv: this.opts.identityEnv,
      envPrefixes: this.opts.envPrefixes,
      processEnv: this.opts.processEnv,
    });

    // stdin 恒 'pipe' 且独占（引擎自灭主判据 stdio EOF 的前提；不覆写、不继承）。
    this.child = spawn(launch.command, launch.args, {
      cwd: this.opts.cwd,
      env,
      ...platformOpts,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const child = this.child;
    child.on("error", (err) => {
      // spawn 本身失败（ENOENT 等）：让 initialize 超时/写失败路径统一收口。
      logger.warn(`[engine-client:${this.engineId}] spawn error: ${err.message}`);
      this.appendStderrTail(`spawn error: ${err.message}\n`);
    });
    // 管道死亡竞态（coverage-gate 满载 flaky 根因，2026-09）：引擎死后在途帧写入的
    // EPIPE 以「异步 error 事件」投递——writeFrame 的同步 try/catch 接不到；stdin 无
    // error 监听时 Node 对无监听 error 事件直接抛 uncaughtException（测试进程整轮
    // 崩红、用例全绿）。挂监听吃掉预期内的管道死亡留 debug 痕迹；在途请求失败的
    // 语义由 exit 事件 → teardownProcess 统一承担，不经管道错误路径。
    for (const pipe of ["stdin", "stdout", "stderr"] as const) {
      child[pipe]?.on("error", (err: Error) => {
        logger.debug(`[engine-client:${this.engineId}] ${pipe} pipe error (engine died concurrently = expected): ${err.message}`);
      });
    }
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => this.onStdoutData(chunk));
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => this.appendStderrTail(chunk));
    child.on("exit", (code, signal) => this.onEngineExit(code, signal));

    if (child.pid !== undefined) {
      this.pidfileWritten = registerEnginePidfile({
        engineDataDir: this.opts.dataDir,
        engineId: this.engineId,
        hostKind: this.opts.hostKind,
        hostPid: process.pid,
        enginePid: child.pid,
      });
    }
    this.attachFrameReader();

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
  // stdout 行解析与帧路由
  // ─────────────────────────────────────────────────────────────────────────

  private attachFrameReader(): void {
    this.stdoutBuffer = "";
  }

  private onStdoutData(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) this.handleLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
    // 帧间残片留 buffer（OS 管道背压语义：不做无界缓存——残片即半行，有界）。
  }

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
      if (this.runRoutes.get(runId) === route) this.runRoutes.delete(runId);
    };
  }

  /** 健康检查（ADR-0047：静默 ≠ 卡死，不据此杀任务）。 */
  async ping(): Promise<void> {
    await this.ensureConnected();
    await this.request("ping", {});
  }

  /** cancel 受理窗口 = CANCEL_SETTLE_GRACE_MS；终态收敛由调用方（RemoteEngine）等 run 应答。 */
  async cancelRun(runId: string, reason: string): Promise<void> {
    await this.request("cancel", { runId, reason }, { timeoutMs: CANCEL_SETTLE_GRACE_MS });
  }

  // ── 收割 / 停机 ──────────────────────────────────────────────────────────

  /**
   * 宿主收割入口（D8 killAllSpawnedChildren 落点）：组杀引擎 CLI（POSIX 负 pid 组杀 /
   * Windows taskkill /T /F）+ 镜像整体置死 + pidfile 清理。在途请求以 engine_crashed
   * 失败。「零残留」断言范围 = 一代子进程 + 组内后代（引擎自身 detached 后代不覆盖，
   * impl-plan §7.2 R9-1 / 设计 §3.9 已接受代价）。
   */
  async killAll(reason: string): Promise<void> {
    this.intentionalKill = true;
    const child = this.child;
    if (child !== undefined && child.pid !== undefined && child.exitCode === null) {
      killProcessTree(child.pid, reason, { engineId: this.engineId });
      await waitForChildExit(child, SIGKILL_REAP_TIMEOUT_MS);
    }
    this.teardownProcess(reason);
  }

  /**
   * 协议 dispose：dispose 帧（3s 上界）→ 组杀兜底 → 清理。幂等。
   * dispose 后首个 run 的重建由新的连接状态机承担（EnginePort.dispose 契约）。
   */
  async dispose(): Promise<void> {
    if (this.state === "disposed") return;
    if (this.state === "ready" && this.child !== undefined && this.child.exitCode === null) {
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

  /** 引擎进程 exit：镜像整体置死 + pidfile 清理 + 在途请求失败 + 状态回落。 */
  private onEngineExit(code: number | null, signal: NodeJS.Signals | null): void {
    const detail = signal !== null ? `signal ${signal}` : `exit code ${code}`;
    // intentionalKill 消费点：主动杀（killAll/dispose）后的 exit 是预期收敛（debug）；
    // 非主动杀 = 意外崩溃（warn 出声，供排障区分「引擎自己挂了」与「宿主收割」）。
    if (this.intentionalKill) {
      logger.debug(`[engine-client:${this.engineId}] engine exited after intentional kill (${detail}) — expected`);
    } else {
      logger.warn(`[engine-client:${this.engineId}] engine process exited unexpectedly (${detail})`);
    }
    this.teardownProcess(detail);
    this.state = "exited";
  }

  /**
   * 进程死亡 / 失败后的统一清理（收割/组杀分支各成子函数，此处只做顺序编排）：
   * 孤儿收割（镜像置死前）→ 镜像置死（失效语义 2+3）→ pidfile 删 → 在途请求
   * engine_crashed（附 stderr 尾）→ run 路由清空 → 活引擎组杀兜底。
   */
  private teardownProcess(detail: string): void {
    this.reapOrphansAfterUnexpectedDeath(detail);
    this.mirror.killAll();
    if (this.pidfileWritten !== undefined) {
      removePidfile(this.pidfileWritten);
      this.pidfileWritten = undefined;
    }
    const err = engineCrashedError(detail, this.stderrTail);
    for (const [, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.runRoutes.clear();
    this.lastPartialHandle = undefined;
    this.killLeakedAliveChild(detail);
    if (this.state !== "unavailable" && this.state !== "disposed") {
      this.state = "exited";
    }
  }

  /**
   * [H1 U2 / 红线①收割链] 非主动死亡且引擎已死的路径，在镜像置死**之前**补发收割
   * 信号：孤儿真因 = 引擎意外死时宿主未发收割信号（原先 alreadyDead 分支直接跳过
   * killProcessTree），任务子进程留在无主进程组继续写 session 文件。插入点约束：
   *   - 位置 = mirror.killAll() 置死清空之前——Windows 通道依赖镜像快照过滤活孤儿
   *     （置死后全量项 killed=true 不可过滤）；
   *   - 条件 = !intentionalKill && alreadyDead——主动 dispose 链已有两层杀（引擎
   *     killAllActiveChildren SIGTERM+30s + 宿主 killAll 组杀 5s 升级），跳过即不叠加、
   *     优雅窗零压缩、pi trap-flush 零截断；进程仍活的路径（握手失败重建）由
   *     killLeakedAliveChild 组杀兜底承接。
   */
  private reapOrphansAfterUnexpectedDeath(detail: string): void {
    if (!this.intentionalKill && this.child !== undefined) {
      const dying = this.child;
      const alreadyDead = dying.exitCode !== null || dying.signalCode !== null;
      if (alreadyDead && dying.pid !== undefined) {
        if (process.platform === "win32") {
          // Windows：killProcessTree 的 taskkill 以引擎 pid 为树根，树根已死 → not
          // found → 空操作（不可复用）——镜像通道收割（置死前快照，见下）。
          this.reapOrphansViaMirrorSnapshot(detail);
        } else {
          // POSIX：复用 killProcessTree 负 pid 组杀（SIGTERM → 5s grace → SIGKILL
          // 升级链内建，fire-and-forget 不阻塞同步 teardown）。组长死后进程组存活到
          // 最后一员退出，组杀可达任务子进程（引擎 detached:true spawn = 组长，任务
          // 子进程 detached:false 同组，组杀目标 -child.pid 不依赖镜像）。
          // 无外层逐 pid 兜底（SIGTERM 同步返回后 5s 窗内孤儿必然仍活，同步校验恒
          // 命中、立即兜底 = 优雅窗归零截断 trap-flush——升级链已覆盖残余职责）。
          killProcessTree(
            dying.pid,
            `reap orphaned children after unexpected engine death (${detail})`,
            { engineId: this.engineId },
          );
        }
      }
    }
  }

  /**
   * 握手失败路径（版本越界/握手超时/启动僵死）引擎进程仍活着：必须组杀，否则
   * crash 重建循环每次 spawn 泄漏一个常驻孤儿（测试机实测积累 370+）。主动杀
   * （intentionalKill=true）与进程已死（exitCode/signalCode 非空）跳过重复发信号。
   */
  private killLeakedAliveChild(detail: string): void {
    if (this.child !== undefined) {
      const child = this.child;
      this.child = undefined;
      const alreadyDead = child.exitCode !== null || child.signalCode !== null;
      if (!alreadyDead && !this.intentionalKill && child.pid !== undefined) {
        killProcessTree(child.pid, detail, { engineId: this.engineId });
      }
      child.removeAllListeners();
    }
  }

  /**
   * [H1 U2 / 红线①Windows 通道] 镜像快照收割活孤儿：镜像快照同步抓清单（置死前，
   * 全量项含引擎一生历史死 pid——镜像对已退出子进程只改 state 不删项、唯一清空点 =
   * killAll）→ 过滤活孤儿（state === "running" && !killed，活孤儿 ≤ 并发数）→ 逐 pid
   * **异步 spawn** taskkill /T /F fire-and-forget（树根 = 活着的任务子进程自身，树杀
   * 有效；快照同步抓、杀动作异步发——与 POSIX fire-and-forget 对称；禁 spawnSync：
   * 逐个同步 N×10s 上界会冻结 onEngineExit 同步回调、推迟 pending reject（Continuation
   * 失败通知链源头）与宿主事件循环）。
   */
  private reapOrphansViaMirrorSnapshot(detail: string): void {
    const liveOrphans = this.mirror.snapshot().filter((e) => e.state === "running" && !e.killed);
    if (liveOrphans.length === 0) return;
    logger.warn(
      `[engine-client:${this.engineId}] reaping ${liveOrphans.length} orphaned task child(ren) via mirror snapshot after unexpected engine death (${detail})`,
    );
    for (const entry of liveOrphans) {
      const killer = spawn("taskkill", ["/PID", String(entry.pid), "/T", "/F"], { stdio: "ignore" });
      killer.unref();
      killer.on("error", (err: Error) => {
        // spawn 失败（taskkill 缺失等）留 debug 痕迹——残余孤儿由红线③登记承接
        //（下一轮派发前兜底 / 宿主重启窗口）。
        logger.debug(
          `[engine-client:${this.engineId}] taskkill spawn failed for orphan pid ${entry.pid} (${err.message})`,
        );
      });
    }
  }

  // ── pidfile ──────────────────────────────────────────────────────────────

  // ── 帧写出口 ────────────────────────────────────────────────────────────

  private writeFrame(frame: unknown): boolean {
    const stdin = this.child?.stdin;
    if (stdin === undefined || stdin === null || this.child === undefined || this.child.exitCode !== null) {
      return false;
    }
    try {
      stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch (err) {
      // 写失败 = 进程已死（EPIPE）——调用方按 false 走 engine_crashed 收口，debug 留痕。
      logger.debug(
        `[engine-client:${this.engineId}] stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private sendResponse(id: string, result: unknown): boolean {
    return this.writeFrame({ id, result });
  }

  private appendStderrTail(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  }
}

// ── 内部工具 ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}


