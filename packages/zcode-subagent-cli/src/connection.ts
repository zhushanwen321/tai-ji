// src/execution/engine/engines/zcode/connection.ts
//
// ZcodeEngine app-server 常驻连接层（R2）。设计权威源：
// docs/architecture/zcode-engine-appserver-resident.md §3.2 方案 A（单常驻进程 + per-session
// model）/ §3.3 D1（惰性启动、进程退出即失效下次使用重建、probe 用独立短命连接）/
// D9（反向请求常量表应答 + 未知一律回空 result）/ 附录 A.1（传输与帧型——协议权威）/
// A.3（错误码表）。旧实现参照：zsw 仓 84b63a0^ lib/runner-appserver.js 的
// AppServerConnection + createFrameDispatcher（协议断言逐字级保留，TS 重写）。
//
// 协议事实（A.1，全部来自旧实现实测 + 本机 0.16.5 二进制验证）：
//   - stdio NDJSON（每行一个 JSON），非标准 JSON-RPC：**不带 jsonrpc 字段**，
//     我们发出的帧必须精确键集（对面 zod strict 拒未知键）；入站帧宽容解析
//     （未知键不拒收——strict 校验是对面的职责，我们是客户端）。
//   - 四帧型：客户端请求 {id, method, params} / 应答 {id, result} 或
//     {id, error:{code,message,data}} / 服务端推送 {method, params}（无 id）/
//     服务端反向请求 {id, method, params}（必须应答，不答 15s 超时断连，旧实测 -32022）。
//   - 首帧可能是 {protocol:{name,version}} 自报（或 {method:'protocol'} 推送形态），
//     记入 protocolInfo 后忽略，不抛。
//
// 与 R4 的接线边界（本模块刻意保持的解耦）：
//   - 启动参数矩阵（D10 的 --stdio/--surface）不在此层——D10 已定案：基线 argv 恒
//     `node <cliPath> app-server --cwd <dir>`，不带 --stdio/--surface（三态矩阵补验
//     留跨仓真机段）；
//   - env 全量从构造参数注入（buildAppServerEnv 是沿用 launcher 惯例的便捷组装器，
//     R4 也可复用 launcher 的 buildZcodeEnv 自行组装后传入——本模块不 import launcher）；
//   - stderr tee 路径参数化（引擎数据目录由 R4 注入；测试用 tmp 目录）；
//   - dispose 完整编排（close 全部会话 → 杀链）归 R4 引擎层——本模块只提供连接自身
//     的关闭原语（close 同步 SIGTERM 面 / shutdown 完整杀链面，均幂等；close 后调
//     shutdown 等待同一杀链完成再 resolve——resolve 于进程退出的契约不因入口顺序而破）。
//
// 重建语义（D1 + §3.4 不变量 4）：进程死亡（崩溃 / 我方 shutdown / spawn 失败）→
// 当前代全部 pending reject（错误附 stderr 尾 400 字符）→ child 置空 → 下次
// request() 走同一 ensureStarted 路径重起新代。「崩溃重建」「dispose 后重建」
// 「惰性启动」三条路径在实现上同一条代码路径。

import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  buildEngineChildEnv,
  buildNestedSpawnEnv,
  getLogger,
  killChain,
  pumpNdjsonLines,
  spawnEngineChild,
} from "@zhushanwen/subagent-engine-sdk";
import {
  ZCODE_APPSERVER_REQUEST_TIMEOUT_MS,
  ZCODE_APPSERVER_STDERR_TAIL_BUFFER_CHARS,
  ZCODE_APPSERVER_STDERR_TAIL_CHARS,
  ZCODE_KILL_GRACE_MS,
} from "./constants.ts";
import { toErrorMessage } from "./error-message.ts";
import {
  cleanupSiblingStderrLogs,
  rotateStderrLogIfNeeded,
  stderrRotationParams,
} from "./logs/stderr-rotation.ts";

const logger = getLogger("subagents");

/** 坏帧/长帧进日志的截断长度（够诊断、不刷屏——ZCODE_ERROR_TAIL_CHARS 同精神）。 */
const RAW_FRAME_LOG_CHARS = 200;

// ============================================================
// D9 常量表应答
// ============================================================

/**
 * session/requestRuntimePreferences 的应答：逐字段来自旧实现实测（zsw 仓
 * runner-appserver.js RUNTIME_PREFERENCES，2026-08-23 真机抓包），改动前先有新实测依据。
 */
export const RUNTIME_PREFERENCES = Object.freeze({
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: "preflight-v1",
});

/**
 * 连接级反向请求 handler 表（D9）：本表之外的反向请求（permission/elicitation 等）
 * 一律回空 result 并 warn 留痕——不答会 15s 超时断连（旧实测 -32022），拖死共享
 * 连接上的全部会话。
 */
const DEFAULT_REVERSE_HANDLERS: Readonly<Record<string, (params: unknown) => unknown>> = {
  "session/requestRuntimePreferences": () => RUNTIME_PREFERENCES,
};

// ============================================================
// 帧类型（宽容解析：入站未知键不拒收，出站精确键集）
// ============================================================

/**
 * app-server RPC 错误（应答帧 error 形态挂到 reject Error 上）。code 语义见设计
 * 附录 A.3：-32601/-32602 漂移类、-32004/-32010 会话类、-32603 内部错误（含
 * "Model config is missing"）。R5 降级链按 code 归类。
 */
export interface AppServerRpcError extends Error {
  code?: number;
  data?: unknown;
}

/** 运行时判别（消费方 R3/R5 归类错误用，避免裸 as 断言）。 */
export function isAppServerRpcError(err: unknown): err is AppServerRpcError {
  return err instanceof Error && typeof (err as AppServerRpcError).code === "number";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 帧 id 的合法形态（客户端请求 id 恒数字；服务端反向请求 id 实测字符串）。 */
function frameIdOf(frame: Record<string, unknown>): string | number | undefined {
  const id = frame.id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

/** 错误/日志出声用的 message 提取（非 Error 值不抛二次异常）。 */
function errMessage(err: unknown): string {
  return toErrorMessage(err);
}

// ============================================================
// env 组装（沿用 launcher 惯例；完整 env 也可由调用方自行构造注入）
// ============================================================

/**
 * 组装 app-server 子进程 env：嵌套防护经公共 nesting-guard（注入统一
 * XYZ_AGENT_SUBAGENT=1 + 剥离引擎原生嵌套标记），遥测关闭（旧实现实证）。
 * 2026-09 起共享宿主 HOME——不再覆写 HOME：db/plugins/MCP 继承宿主 ~/.zcode/，
 * HOME 依赖副作用（如 pnpm store 路径翻转）随之消失。会话库是唯一例外（2026-09
 * 会话库隔离）：引擎会话落隔离库（调用方 zcode-engine.ensureAppServerRuntime 在本
 * 函数产物上覆盖式追加 ZCODE_SESSION_DB_PATH），不再与 GUI 共写宿主 SQLite。凭据
 * 不在此层注入：CLI 形态 app-server 只从
 * ~/.zcode/cli/config.json 读 provider（GUI 登录态在 v2/config.json），由
 * launcherScript 指向的 fs 拦截 wrapper 把该读取重定向为「真实文件 + v2
 * provider 注入」内存合并（同 id 时 v2 整条优先——见 appserver-launcher.ts）。
 */
export function buildAppServerEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...buildNestedSpawnEnv(baseEnv),
    ZCODE_MODEL_TELEMETRY_ENABLED: "false",
  };
}

// ============================================================
// 连接
// ============================================================

/** AppServerConnection 构造参数（依赖全量注入：cliPath 到 env 全部来自调用方）。 */
export interface AppServerConnectionOptions {
  /** zcode CLI 路径（node 脚本，如 zcode.cjs）。 */
  cliPath: string;
  /** app-server 进程 --cwd 参数值（CLI flag，不是 OS 级 spawn cwd——与旧实现一致）。 */
  cwd: string;
  /** 完整子进程 env（buildAppServerEnv 产物或调用方自行组装）。 */
  env: NodeJS.ProcessEnv;
  /**
   * fs 拦截 wrapper 脚本路径（appserver-launcher.ts 落盘产物）。设置时 spawn 的
   * script 换为本路径（cliPath 经 env ZCODE_ENG_CLI_PATH 传给 wrapper）——共享宿主
   * HOME 形态的凭据供数机制；缺省 undefined = 直接 spawn cliPath（测试 fake 直连）。
   */
  launcherScript?: string;
  /**
   * 引擎数据根（W5 迁移新增）：spawn env 必经 buildEngineChildEnv 的 L0 注入参数
   * （XYZ_AGENT_DATA_DIR）。app-server 的 ZCODE_* 专属键（隔离库路径 / launcher 键）
   * 由 env 基座承载（调用方已写入），ZCODE_ 前缀经 manifest envPrefixes 放行。
   */
  dataDir?: string;
  /**
   * stderr tee 落盘路径（append；引擎数据目录由 R4 注入，测试用 tmp 目录）。
   * 懒打开：首条 stderr 才建文件，无 stderr 的短命连接零文件；写失败静默降级
   * （取证面不能拖垮主通道）。
   */
  stderrLogPath: string;
  /**
   * [W11] 实例维度路径解析器：传入当前代 app-server pid，返回该代的 tee 路径。
   * 生产接线 = logs/stderr-rotation.ts 的 stderrLogPathFor（文件名带 pid——同
   * engineDataDir 双实例并发 append/轮转互不干扰，设计 §3.9）；缺省回落
   * stderrLogPath（测试注入固定路径的既有形态）。
   */
  stderrLogPathResolver?: (pid: number | undefined) => string;
  /** node 二进制（缺省 'node' 走 PATH）。 */
  nodeBin?: string;
  /** 控制面请求默认超时（缺省 ZCODE_APPSERVER_REQUEST_TIMEOUT_MS）。 */
  requestTimeoutMs?: number;
  /** 反向请求 handler 表（缺省 D9 常量表；测试注入故障 handler 用）。 */
  reverseHandlers?: Readonly<Record<string, (params: unknown) => unknown>>;
  /**
   * [R4] 每代进程 spawn 成功后的同步回调。pidfile 机制删除后引擎侧不再传——现为
   * 测试专有的代级观测面（采集 spawn 时序 / 子进程句柄）。与 RunContext.onChildSpawned
   * 无关：常驻进程不进宿主 spawnedChildren（D6——其生命周期归引擎 dispose）。
   * 不抛保证：回调异常吞掉记 warn，不影响帧泵。
   */
  onSpawned?: (child: ChildProcess) => void;
}

/** request() 的单次可选项。 */
export interface AppServerRequestOptions {
  /** 本请求超时预算（缺省用连接级默认值）。 */
  timeoutMs?: number;
}

/** 在途请求登记项。 */
interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/**
 * 长驻 app-server 连接：NDJSON 帧分发 + 请求 id 关联 + 反向请求应答 + 崩溃收割。
 *
 * 生命周期：构造零成本（不 spawn）；首个 request() 惰性启动；进程死亡收割当前代
 * （全部 pending reject）后下次使用自动重建。推送事件经 onNotification(method)
 * 按 method 订阅（R3 会话层消费 session/event 与 v4/telemetry/event）。
 */
export class AppServerConnection {
  private readonly cliPath: string;
  private readonly dataDir: string | undefined;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly stderrLogPath: string;
  private readonly stderrLogPathResolver: (pid: number | undefined) => string;
  /** 当前代 tee 流实际写入的路径（append/轮转/cleanup 共用）。 */
  private activeStderrLogPath: string | null = null;
  private readonly nodeBin: string;
  private readonly requestTimeoutMs: number;
  private readonly reverseHandlers: Readonly<Record<string, (params: unknown) => unknown>>;
  private readonly onSpawned: ((child: ChildProcess) => void) | undefined;
  private readonly launcherScript: string | undefined;

  /** 当前代子进程；null = 无活进程（未启动或已死，下次使用重建）。 */
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingEntry>();
  /** 请求 id 自增序（每代重置——新进程无历史 pending，id 空间互不冲突）。 */
  private reqSeq = 0;
  /** stderr 滚动缓冲（代级：崩溃诊断用）。 */
  private stderrTail = "";
  /**
   * stderr tee 落盘流（D6-⑦；merge 裁决：旋转走 logs/stderr-rotation 的路径式
   * rotateStderrLogIfNeeded——W5 边界禁 import subagent-core 的 SizeRotatedAppendStream，
   * 常驻流改裸 WriteStream + 按次轮转检查，帽语义等价）。
   */
  private stderrStream: fs.WriteStream | null = null;
  private stderrStreamFailed = false;
  /**
   * 本代我方杀链 promise（close/shutdown 共用）。入口顺序不破「shutdown resolve 于
   * 进程退出」契约：close 先行发起时 shutdown await 同一 promise 而非直接 return。
   * killChain 永不 reject（内部 raceTimeout 吞 reject）——close 的 fire-and-forget
   * 无 unhandled rejection 面。
   */
  private killChainPromise: Promise<"terminated" | "killed"> | undefined;
  private generation = 0;
  private readonly pushHandlers = new Map<string, Set<(params: unknown) => void>>();
  /** [R4] 连接级崩溃通知面（onClose 订阅者集合；与 pushHandlers 同构的 refCount 形态）。 */
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private capturedProtocolInfo: Readonly<Record<string, unknown>> | null = null;

  constructor(opts: AppServerConnectionOptions) {
    this.cliPath = opts.cliPath;
    this.launcherScript = opts.launcherScript;
    this.dataDir = opts.dataDir;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.stderrLogPath = opts.stderrLogPath;
    this.stderrLogPathResolver = opts.stderrLogPathResolver ?? (() => this.stderrLogPath);
    this.nodeBin = opts.nodeBin ?? "node";
    this.requestTimeoutMs = opts.requestTimeoutMs ?? ZCODE_APPSERVER_REQUEST_TIMEOUT_MS;
    this.reverseHandlers = opts.reverseHandlers ?? DEFAULT_REVERSE_HANDLERS;
    this.onSpawned = opts.onSpawned;
  }

  /** 当前代进程 pid（未启动/已死为 undefined）。 */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** 当前代是否有活进程（关闭原语与重建测试的观测面）。 */
  get alive(): boolean {
    return this.child !== null;
  }

  /** 协议自报信息（A.1 首帧 {protocol:{...}} 或 {method:'protocol'} 推送形态；未收到为 null）。 */
  get protocolInfo(): Readonly<Record<string, unknown>> | null {
    return this.capturedProtocolInfo;
  }

  /**
   * 订阅服务端推送（按 method）。handler 异常由本模块吞掉并 warn（不拖死帧泵）。
   *
   * @returns 退订函数
   */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let set = this.pushHandlers.get(method);
    if (!set) {
      set = new Set();
      this.pushHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set && set.size === 0) this.pushHandlers.delete(method);
    };
  }

  /**
   * [R4] 订阅连接崩溃/关闭通知：当前代进程退出（崩溃、spawn 失败、我方杀链收尾）时
   * 回调一次（reason 含 stderr 尾部——失败路径 2 的错误素材）。时序保证：在途
   * pending 全部 reject **之后**触发（订阅方可安全假定「在途请求已死」）。仅在
   * 「有进程死亡」时触发——从未启动过的连接不通知。
   *
   * @returns 退订函数
   */
  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  /**
   * [R4] 发一个客户端请求帧但不等待应答（fire-and-forget）。dispose 编排用：
   * 停机时 session/close 帧「发出即算」不阻塞在应答上（对面进程可能正被并发收割，
   * 等应答会让 dispose 挂到请求超时）。不登记 pending——迟到应答按无匹配 id 忽略。
   */
  post(method: string, params?: unknown): boolean {
    this.ensureStarted();
    return this.writeFrame({ id: ++this.reqSeq, method, params });
  }

  /**
   * 发一个客户端请求并等应答。惰性启动（首次调用 spawn）；error 应答帧转 reject
   * （code/data 挂到 Error 上，-32602 的 zod 诊断随 data 带出便于逆向 schema）。
   * 出站帧精确键集 {id, method, params}——无 jsonrpc 字段（A.1）。
   */
  request<T = unknown>(method: string, params?: unknown, opts?: AppServerRequestOptions): Promise<T> {
    this.ensureStarted();
    if (this.child === null) {
      return Promise.reject(new Error("app-server 连接不可用（进程未启动或已退出）"));
    }
    const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
    const id = ++this.reqSeq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        // 泛型 T 是调用方对线上 unknown 结果的视图声明，连接层不做运行时校验
        // （协议层保持透明，结构校验归会话层/消费方）。
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      });
      if (!this.writeFrame({ id, method, params })) {
        // 同步写失败（进程将死）：立即失败该请求，不等超时兜底
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`请求 ${method} 写入失败（app-server 进程不可写）`));
      }
    });
  }

  /**
   * 同步关闭面（R4 dispose 编排的原语）：立即发 SIGTERM（同步系统调用，返回前信号
   * 已发出），grace→SIGKILL 升级由杀链 promise 跟进（fire-and-forget）。幂等；对未启动
   * 连接是零成本 no-op。close 之后调 shutdown 会 await 同一杀链再 resolve（见
   * killChainPromise 字段注释）。
   */
  close(): void {
    const child = this.child;
    if (child === null || this.killChainPromise !== undefined) return;
    this.killChainPromise = killChain(child, { graceMs: ZCODE_KILL_GRACE_MS });
  }

  /**
   * 异步完整关闭面：SIGTERM → grace → SIGKILL 杀链走完（含收尸），resolve 于进程
   * 退出。幂等：与 close 共享同一杀链 promise——close 先行时 await 它再 resolve，
   * 不另起杀链（graceMs 取首次发起值）。之后首个 request() 自动重建（与崩溃重建
   * 同路径，§3.4 不变量 4）。
   */
  async shutdown(opts?: { graceMs?: number }): Promise<void> {
    if (this.killChainPromise === undefined) {
      const child = this.child;
      if (child === null) return;
      this.killChainPromise = killChain(child, { graceMs: opts?.graceMs ?? ZCODE_KILL_GRACE_MS });
    }
    await this.killChainPromise;
  }

  // ============================================================
  // 进程生命周期（代管理）
  // ============================================================

  private ensureStarted(): void {
    if (this.child !== null) return;
    this.spawnGeneration();
  }

  private spawnGeneration(): void {
    // 每代全量重置（崩溃/关闭/spawn 失败后的重建同走本方法）
    this.pending = new Map();
    this.reqSeq = 0;
    this.stderrTail = "";
    this.killChainPromise = undefined;
    this.generation += 1;
    const gen = this.generation;

    const script = this.launcherScript ?? this.cliPath;
    // W5 迁移契约：引擎任务子进程 spawn 必经 SDK spawnEngineChild（detached:false /
    // windowsHide / 子进程 stdin 自有 pipe 硬编码——宿主杀组即连带收割，且不把引擎
    // 自身 stdin fd 传给后代），env 必经 buildEngineChildEnv（L1 deny 剥除 + L0
    // XYZ_AGENT_DATA_DIR 注入；基座 this.env 已含 ZCODE_* 全量键）。
    const child = spawnEngineChild({
      command: this.nodeBin,
      args: [script, "app-server", "--cwd", this.cwd],
      env: buildEngineChildEnv(this.env, {
        // L0 XYZ_AGENT_DATA_DIR 缺省链：显式传参 > 宿主注入 env > tmpdir 占位
        //（app-server 不消费该键，占位仅满足 L0 必注入契约；生产调用方
        // zcode-engine.ensureAppServerRuntime 恒传 engineDataDir）。
        dataDir: this.dataDir ?? process.env["XYZ_AGENT_DATA_DIR"] ?? tmpdir(),
        envPrefixes: ["ZCODE_"],
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    this.child = child;
    if (this.onSpawned !== undefined) {
      try {
        this.onSpawned(child);
      } catch (err) {
        logger.warn(`onSpawned 回调异常（忽略）: ${errMessage(err)}`);
      }
    }

    let finalized = false;
    // 收割当前代：关闭 tee 流、child 置空（触发下次重建）、全部 pending reject。
    // 双守卫：finalized 防同代 close/error 双触发；generation 比对防迟到的上一代
    // 事件误杀新代（正常时序不可达，防御性保留）。
    const finalize = (reason: string): void => {
      if (finalized || this.generation !== gen) return;
      finalized = true;
      this.closeStderrStream();
      this.child = null;
      const err = new Error(`app-server ${reason}`);
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      this.pending.clear();
      // pending 全部 reject 后才通知崩溃订阅方（onClose 契约：触发时在途已死）
      for (const fn of [...this.closeHandlers]) {
        try {
          fn(reason);
        } catch (err) {
          logger.warn(`close handler 异常: ${errMessage(err)}`);
        }
      }
    };

    pumpNdjsonLines(child.stdout, (line) => this.handleLine(line));

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-ZCODE_APPSERVER_STDERR_TAIL_BUFFER_CHARS);
      this.appendStderrLog(chunk);
    });

    // 子进程死后的残留写会以 EPIPE 冒泡到 stdin 流，不吞会让宿主进程崩
    child.stdin?.on("error", () => {});

    child.once("close", (code, signal) => {
      finalize(
        `进程退出（code=${code} signal=${signal ?? "none"}）stderr 尾部: ${this.stderrTail.slice(-ZCODE_APPSERVER_STDERR_TAIL_CHARS)}`,
      );
    });
    child.once("error", (err) => finalize(`spawn 失败: ${err.message}`));
  }

  // ============================================================
  // 帧分发（A.1 四帧型；宽容解析，坏行跳过不断流）
  // ============================================================

  private handleLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      logger.warn(`无法解析的协议行（忽略）: ${text.slice(0, RAW_FRAME_LOG_CHARS)}`);
      return;
    }
    this.handleFrame(frame, text);
  }

  private handleFrame(frame: unknown, rawText: string): void {
    if (!isRecord(frame)) {
      logger.warn(`非对象协议帧（忽略）: ${rawText.slice(0, RAW_FRAME_LOG_CHARS)}`);
      return;
    }
    if (isRecord(frame.protocol)) this.capturedProtocolInfo = frame.protocol;

    // 反向请求 / 推送（有 method）
    if (typeof frame.method === "string") {
      const reverseId = frameIdOf(frame);
      if (reverseId !== undefined) {
        this.answerReverse(reverseId, frame.method, frame.params);
      } else {
        this.dispatchPush(frame.method, frame.params);
      }
      return;
    }

    // 应答（有 id 无 method）
    if (frame.id !== undefined && frame.id !== null) {
      if (typeof frame.id !== "number") {
        logger.warn(`应答 id 非数字（忽略）: ${rawText.slice(0, RAW_FRAME_LOG_CHARS)}`);
        return;
      }
      this.settlePending(frame.id, frame);
      return;
    }

    // protocol 自报首帧（无 id 无 method）：已消费，不是坏帧
    if (isRecord(frame.protocol)) return;
    logger.warn(`无法归类的协议帧（忽略）: ${rawText.slice(0, RAW_FRAME_LOG_CHARS)}`);
  }

  private settlePending(id: number, frame: Record<string, unknown>): void {
    const entry = this.pending.get(id);
    if (!entry) {
      logger.warn(`响应无匹配请求 id=${id}（忽略）`);
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (frame.error !== undefined) {
      const e = isRecord(frame.error) ? frame.error : {};
      const code = typeof e.code === "number" ? e.code : undefined;
      const message = typeof e.message === "string" ? e.message : JSON.stringify(e.message ?? e);
      const dataSlice =
        e.data === undefined ? "" : `；data: ${JSON.stringify(e.data).slice(0, ZCODE_APPSERVER_STDERR_TAIL_CHARS)}`;
      const err = new Error(`${entry.method} 失败: [${code ?? "?"}] ${message}${dataSlice}`) as AppServerRpcError;
      err.code = code;
      err.data = e.data;
      entry.reject(err);
      return;
    }
    entry.resolve(frame.result);
  }

  private dispatchPush(method: string, params: unknown): void {
    // 协议自报的推送形态（{method:'protocol', params:{...}}）与首帧形态收敛到同一字段
    if (method === "protocol") this.capturedProtocolInfo = isRecord(params) ? params : null;
    const set = this.pushHandlers.get(method);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(params);
      } catch (err) {
        logger.warn(`push handler 异常（${method}）: ${errMessage(err)}`);
      }
    }
  }

  // ============================================================
  // 反向请求应答（D9）
  // ============================================================

  private answerReverse(id: string | number, method: string, params: unknown): void {
    const handler = this.reverseHandlers[method];
    if (!handler) {
      logger.warn(`未知反向请求 ${method}（id=${id}）：回空 result（不答会 15s 超时断连，旧实测 -32022）`);
      this.writeFrame({ id, result: {} });
      return;
    }
    // fire-and-forget：handler 失败回 error 帧，绝不拖死连接
    Promise.resolve()
      .then(() => handler(params))
      .then((result) => this.writeFrame({ id, result: result ?? {} }))
      .catch((err: unknown) => {
        logger.warn(`反向请求 ${method} handler 异常: ${errMessage(err)}`);
        this.writeFrame({ id, error: { code: -32000, message: errMessage(err) } });
      });
  }

  // ============================================================
  // 写帧 / stderr tee
  // ============================================================

  /** 写一帧（JSON + 换行）。返回 false = 进程不可写（调用方决定如何失败）。 */
  private writeFrame(frame: unknown): boolean {
    const child = this.child;
    if (child === null || child.stdin === null) return false;
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch (err) {
      logger.warn(`写入 app-server 失败: ${errMessage(err)}`);
      return false;
    }
  }

  /** stderr 实时 append 落盘（懒打开 + 尺寸轮转 + 过期清理；失败静默——取证面不
   * 能拖垮主通道）。 */
  private appendStderrLog(chunk: string): void {
    if (this.stderrStreamFailed) return;
    if (this.stderrStream === null) {
      const target = this.stderrLogPathResolver(this.child?.pid);
      try {
        fs.mkdirSync(dirname(target), { recursive: true });
        this.activeStderrLogPath = target;
        this.stderrStream = fs.createWriteStream(target, { flags: "a" });
        this.stderrStream.on("error", () => {
          this.stderrStreamFailed = true;
        });
        // 过期清理（三判据：同前缀 + pid 已死 + mtime 过期；每代流打开时机一次）
        cleanupSiblingStderrLogs(target, process.env);
      } catch {
        this.stderrStreamFailed = true;
        return;
      }
    }
    this.stderrStream.write(chunk);
    // 尺寸轮转：超阈值 rename 副本，本流关闭、下次写入懒重开新文件
    if (this.activeStderrLogPath !== null) {
      const params = stderrRotationParams(process.env);
      if (rotateStderrLogIfNeeded(this.activeStderrLogPath, params)) {
        this.closeStderrStream();
      }
    }
  }

  /** 代收尾时关闭 tee 流（下一代懒重开；W11 起路径按新一代 pid 解析）。 */
  private closeStderrStream(): void {
    if (this.stderrStream !== null) {
      const stream = this.stderrStream;
      this.stderrStream = null;
      this.activeStderrLogPath = null;
      stream.end();
    }
  }
}
