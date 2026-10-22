// src/execution/engine/client/transport/local.ts
//
// [M3] LocalEngineTransport：EngineTransport 契约的 local 实现（设计
// relay-spawn-transport §3.3 D5、§3.4.3；u-m3-local）。进程面所有权自 EngineClient
// 迁入（spawn/stdio/pidfile/收割原行为逐段等价迁移）：直接 spawn 引擎 CLI 进程
// （stdio 接线、env 经 SDK buildEngineChildEnv 三层契约、POSIX detached:true /
// Windows detached:false + windowsHide:true），writeFrame/onFrame 帧交换，
// onExit = child exit 投影（code/signal；reason 缺席——reason 是 runtime
// engine_closed 帧的值域，local 无此事实源），close = killProcessTree 收割。
//
// 协议面（NDJSON 帧解析 / 请求 id 关联 / 反向路由 / initialize 握手 / 崩溃重建）
// 留在 EngineClient（types.ts 契约边界）；本类只负责帧搬运与通道生死。
//
// spawn 平台参数（impl-plan §2.2 必写死）：POSIX 引擎 CLI 以独立进程组 spawn
// （detached:true，进程组收割前提）；Windows detached:false + windowsHide:true，
// 收割走 taskkill /PID <pid> /T /F。spawn 点区分：SDK spawnEngineChild 是引擎包内
// 「任务子进程」原语（硬编码 detached:false 且禁 detached 键，impl-plan §2.12）；
// 本类 spawn 的是引擎 CLI 进程本身（impl-plan §2.2 detached:true），二者是协议两侧
// 的两个 spawn 点，故此处直接用 node:child_process。
//
// pidfile/reaper 仅 local 模式注册（impl-plan u-m3-local 验收③）：runtime transport
// 模式下引擎进程归 runtime 所有，extension 侧无 pidfile、无进程组收割——EngineClient
// 按 localTransport 实例有无编排本类专属段（reapOrphansAfterUnexpectedDeath /
// removePidfile / killLeakedChild / sweepStalePidfiles）。

import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import {
  buildEngineChildEnv,
  getLogger,
  hostKindOf,
  resolveEngineNodeLaunch,
} from "@zhushanwen/subagent-engine-sdk";

import {
  registerEnginePidfile,
  removePidfile as removePidfileAtPath,
  sweepEnginePidfiles,
  type PidfileSweepResult,
} from "../pid-file.ts";
import { killProcessTree, waitForChildExit } from "../reaper.ts";
import type {
  EngineLaunchSpec,
  EngineTransport,
  EngineTransportExitInfo,
  EngineTransportOpenResult,
} from "./types.ts";

const logger = getLogger("subagents");

/** SIGKILL 后收尸等待上限（kill-chain 同型有界兜底，reaper.waitForChildExit 消费）。 */
const SIGKILL_REAP_TIMEOUT_MS = 10_000;

/**
 * stdout 半行残片上限（1 MiB 量级；按 UTF-16 code unit 计——NDJSON 载荷以 ASCII
 * 为主，与字节数同阶）。引擎持续输出不含换行的数据时残片本会无界增长：超限丢头
 * 留尾 + warn 一次（每引擎进程一代）；被截断的行在换行到达后必无法 JSON.parse，
 * 由宿主 handleLine 的非 NDJSON 分支丢弃留痕（上限约束的是内存驻留，不是协议合法性）。
 */
const MAX_LINE_BYTES = 1_048_576;

function engineSpawnPlatformOptions(): { detached: boolean; windowsHide: boolean } {
  if (process.platform === "win32") {
    return { detached: false, windowsHide: true };
  }
  return { detached: true, windowsHide: false };
}

/** LocalEngineTransport 构造参数（spawn 上下文 + 进程面收割的宿主侧协作点）。 */
export interface LocalEngineTransportOptions { // oe-exempt:20261018:framework:spawn 上下文载荷形态接口（构造参数载体，非行为契约），单实现常态
  /** 引擎 id（日志 / pidfile 维度；= EngineClient.engineId）。 */
  readonly engineId: string;
  /** 引擎数据根（pidfile 目录根 + buildEngineChildEnv dataDir）。 */
  readonly dataDir: string;
  /** 宿主种类（pidfile 实例维度命名段原文 + resolveEngineNodeLaunch hostKind 判定基座）。 */
  readonly hostKind: string;
  /** buildEngineChildEnv baseEnv（缺省 = {...process.env}）。 */
  readonly baseEnv?: Record<string, string | undefined>;
  // ── buildEngineChildEnv 的 L0/L2 余项（EngineClientOptions 透传）──
  readonly engineNode?: string;
  readonly electronRunAsNode?: boolean;
  readonly identityEnv?: Record<string, string | undefined>;
  readonly processEnv?: Record<string, string | undefined>;
  /** pidfile 三条件清扫 cmdline 身份谓词（EngineClient 已解析缺省词形）。 */
  readonly engineCmdlineMatcher: (cmdline: string) => boolean;
  /**
   * stderr chunk 出口（宿主环形缓冲跨代累计——engine_crashed 现场诊断面；缺省丢弃）。
   * stderr tail 是协议面错误文案的组成（EngineClient.stderrTailText），由宿主持有。
   */
  readonly onStderr?: (chunk: string) => void;
  /**
   * 活孤儿任务子进程 pid 提供者（Windows 镜像快照收割通道）：协议面镜像对「哪些任务
   * 子进程还活着」有知识，进程面收割需要这份知识——依赖倒置点，transport 不感知镜像。
   * 调用时点 = 镜像置死之前（宿主编排保证）；缺省空表（POSIX 组杀不受影响）。
   */
  readonly listLiveOrphanPids?: () => number[];
  /**
   * 子进程 spawn 注入点（缺省 node:child_process spawn；单测注入进程端点桩——
   * stdio 行切分 / 半行残片上限 / 终局投影等帧面逻辑可在无真进程下确定性验证，
   * 见 docs/todo/test-single-layer-cleanup.md「确定性同步化」）。注入桩必须实现
   * wireChild / close / waitForChildExit 消费的 ChildProcess 面（on/removeAllListeners /
   * pid / exitCode / signalCode / stdin/stdout/stderr 流）；pid 应取不可达高位
   * （killProcessTree 对其 ESRCH no-op，不触碰真实进程表）。
   */
  readonly spawnChildProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

/**
 * local 引擎进程传输通道（EngineTransport 的 standalone 实现）。
 * 生命周期：open（spawn）→ writeFrame/onFrame 帧交换 → close（收割）或 onExit 终局。
 * 每代引擎连接一个实例（EngineClient 每次 connectOnce 新建；同实例二次 open 未支持）。
 */
export class LocalEngineTransport implements EngineTransport {
  private child: ChildProcess | undefined;
  /** 主动杀标记（close 置位 / open 复位）：孤儿收割跳过 + 泄漏组杀去重的门。 */
  private intentionalKill = false;
  /** 孤儿收割单代一次标记（exit 投影与宿主 teardown 编排双入口的幂等闸）。 */
  private orphanReapDone = false;
  /** onExit 单次派发闸（多终局只回调一次，契约要求由本实现保证）。 */
  private exitNotified = false;
  private pidfileWritten: string | undefined;
  private readonly frameHandlers: Array<(line: string) => void> = [];
  private readonly exitHandlers: Array<(info: EngineTransportExitInfo) => void> = [];
  private stdoutBuffer = "";
  /** 半行残片截断告警已发标记（每引擎进程一代一次，onStdoutData 复位）。 */
  private stdoutOverflowWarned = false;

  constructor(private readonly opts: LocalEngineTransportOptions) {}

  /** 引擎 CLI 进程 pid（未 spawn / 已终局清理 = undefined；EngineClient.enginePid 投影源）。 */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** 引擎进程句柄在且存活（dispose 帧守卫基座；exit 投影清理后为 false）。 */
  isProcessAlive(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  /**
   * 启动期陈旧 pidfile 清扫（每宿主实例一次，EngineClient.connectOnce 编排；
   * local 模式专属——runtime 模式无 pidfile 面）。三条件保守清扫语义见 pid-file.ts。
   */
  sweepStalePidfiles(): PidfileSweepResult {
    return sweepEnginePidfiles({
      engineDataDir: this.opts.dataDir,
      engineId: this.opts.engineId,
      currentHostPid: process.pid,
      matchesEngineCmdline: this.opts.engineCmdlineMatcher,
    });
  }

  /**
   * 打开引擎通道：spawn 引擎 CLI 进程（stdio 接线，不等待 initialize——握手留在
   * EngineClient 协议层）。spec 的 rootSessionId/parentRecordId/depth 是 runtime
   * 归属概念，local 实现忽略；entryPath/args/cwd/envPrefixes 进 spawn 与 env 构建。
   */
  async open(spec: EngineLaunchSpec): Promise<EngineTransportOpenResult> {
    this.intentionalKill = false;
    this.orphanReapDone = false;
    this.exitNotified = false;
    this.stdoutBuffer = "";
    this.stdoutOverflowWarned = false;
    // [W9] 启动解析（宿主 × 平台二维矩阵，impl-plan §2.9）：spawn argv 先经 SDK
    // resolveEngineNodeLaunch 解析——打包态 pi 宿主必须用注入执行器
    // TAIJI_AGENT_ENGINE_NODE（pi binary 不是 node 执行器）、runtime sidecar 用
    // process.execPath、standalone 用 PATH node（缺 node / 探针失败 → engine_not_found）。
    // Windows .cmd 入口在此改写为显式 cmd.exe /c + 参数数组（禁 shell:true）。
    const baseEnv = this.opts.baseEnv ?? { ...process.env };
    const launch = await resolveEngineNodeLaunch({
      entryPath: spec.entryPath,
      args: spec.args,
      hostKind: hostKindOf(this.opts.hostKind, baseEnv),
      env: baseEnv,
    });
    const env = buildEngineChildEnv(baseEnv, {
      dataDir: this.opts.dataDir,
      engineNode: this.opts.engineNode ?? launch.command,
      electronRunAsNode: this.opts.electronRunAsNode ?? launch.electronRunAsNode,
      identityEnv: this.opts.identityEnv,
      envPrefixes: spec.envPrefixes,
      processEnv: this.opts.processEnv,
    });

    // stdin 恒 'pipe' 且独占（引擎自灭主判据 stdio EOF 的前提；不覆写、不继承）。
    // spawnChildProcess 注入点见 LocalEngineTransportOptions（单测进程端点桩）。
    const spawnChildProcess = this.opts.spawnChildProcess ?? spawn;
    const child = spawnChildProcess(launch.command, launch.args, {
      cwd: spec.cwd,
      env,
      ...engineSpawnPlatformOptions(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.wireChild(child);
    if (child.pid !== undefined) {
      this.pidfileWritten = registerEnginePidfile({
        engineDataDir: this.opts.dataDir,
        engineId: this.opts.engineId,
        hostKind: this.opts.hostKind,
        hostPid: process.pid,
        enginePid: child.pid,
      });
    }
    return { pid: child.pid };
  }

  /** 写一行 engine-protocol 帧到引擎 stdin（宿主侧已 JSON.stringify，本类补换行）。 */
  writeFrame(line: string): boolean {
    const child = this.child;
    const stdin = child?.stdin;
    if (stdin === undefined || stdin === null || child === undefined || child.exitCode !== null) {
      return false;
    }
    try {
      stdin.write(`${line}\n`);
      return true;
    } catch (err) {
      // 写失败 = 进程已死（EPIPE）——调用方按 false 走 engine_crashed 收口，debug 留痕。
      logger.debug(
        `[engine-client:${this.opts.engineId}] stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** 订阅引擎 stdout 行（行切分 + 残片上限之后；一行一调）。 */
  onFrame(handler: (line: string) => void): void {
    this.frameHandlers.push(handler);
  }

  /** 订阅通道终局（幂等注册；多次终局只回调一次由 exitNotified 闸保证）。 */
  onExit(handler: (info: EngineTransportExitInfo) => void): void {
    this.exitHandlers.push(handler);
  }

  /**
   * 优雅关闭本通道（契约 close；local = 既有 teardown/kill 链的进程段）：置
   * intentionalKill（孤儿收割跳过 + 泄漏组杀去重）→ 引擎仍活则 killProcessTree
   * 组杀 + 有界收尸等待。pidfile 删与 onExit 派发由收尸窗口内的 exit 投影承担；
   * 进程已死 / 从未 open 的调用形态幂等直接返回。reason 可选（EngineClient.killAll
   * 透传排障 reason；契约面无参调用缺省）。
   */
  async close(reason = "engine channel close"): Promise<void> {
    this.intentionalKill = true;
    const child = this.child;
    if (child !== undefined && child.pid !== undefined && child.exitCode === null) {
      killProcessTree(child.pid, reason, { engineId: this.opts.engineId });
      await waitForChildExit(child, SIGKILL_REAP_TIMEOUT_MS);
    }
  }

  // ── 进程面终局编排段（EngineClient.teardownProcess 按 localTransport 有无调用；
  //    runtime transport 模式下全部缺席 = 无 pidfile / 无进程组收割，验收③）──────

  /**
   * [H1 U2 / 红线①收割链] 非主动死亡且引擎已死的路径，在宿主镜像置死**之前**补发收割
   * 信号（exit 投影内部 + EngineClient.teardownProcess 编排双入口，orphanReapDone
   * 单代一次）：孤儿真因 = 引擎意外死时宿主未发收割信号，任务子进程留在无主进程组
   * 继续写 session 文件。插入点约束：
   *   - 位置 = 宿主 mirror.killAll() 置死清空之前——Windows 通道依赖镜像快照过滤
   *     活孤儿（置死后全量项 killed=true 不可过滤）；
   *   - 条件 = !intentionalKill && alreadyDead——主动 dispose 链已有两层杀（引擎
   *     killAllActiveChildren SIGTERM+30s + 宿主组杀 5s 升级），跳过即不叠加、优雅窗
   *     零压缩、pi trap-flush 零截断；进程仍活的路径（握手失败重建）由 killLeakedChild
   *     组杀兜底承接。
   */
  reapOrphansAfterUnexpectedDeath(detail: string): void {
    if (this.orphanReapDone || this.intentionalKill) return;
    const child = this.child;
    if (child === undefined || child.pid === undefined) return;
    const alreadyDead = child.exitCode !== null || child.signalCode !== null;
    if (!alreadyDead) return;
    this.orphanReapDone = true;
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
        child.pid,
        `reap orphaned children after unexpected engine death (${detail})`,
        { engineId: this.opts.engineId },
      );
    }
  }

  /** pidfile 清理（exit 投影 + 宿主 teardown 编排双入口；幂等）。 */
  removePidfile(): void {
    if (this.pidfileWritten !== undefined) {
      removePidfileAtPath(this.pidfileWritten);
      this.pidfileWritten = undefined;
    }
  }

  /**
   * 泄漏组杀兜底（宿主 teardown 编排尾段；幂等）：握手失败路径（版本越界/握手超时/
   * 启动僵死）引擎进程仍活着——必须组杀，否则 crash 重建循环每次 spawn 泄漏一个常驻
   * 孤儿（测试机实测积累 370+）。主动杀（close 已置 intentionalKill）与进程已死跳过
   * 重复发信号；句柄清理（child 置空 + 摘除全部监听）无条件执行——摘监听后 exit 投影
   * 不再触发，协议面终局由调用方的同步 teardown 段承担（与既有 killLeakedAliveChild
   * 语义一致）。
   */
  killLeakedChild(detail: string): void {
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
    const alreadyDead = child.exitCode !== null || child.signalCode !== null;
    if (!alreadyDead && !this.intentionalKill && child.pid !== undefined) {
      killProcessTree(child.pid, detail, { engineId: this.opts.engineId });
    }
    child.removeAllListeners();
  }

  // ── 内部：stdio 接线与终局投影 ─────────────────────────────────────────────

  /** stdio 接线：spawn error / 管道死亡消音 / stdout 行读取 / stderr 出口 / exit 投影。 */
  private wireChild(child: ChildProcess): void {
    child.on("error", (err) => {
      // spawn 本身失败（ENOENT 等）：让 initialize 超时/写失败路径统一收口。
      logger.warn(`[engine-client:${this.opts.engineId}] spawn error: ${err.message}`);
      this.opts.onStderr?.(`spawn error: ${err.message}\n`);
    });
    // 管道死亡竞态（coverage-gate 满载 flaky 根因，2026-09）：引擎死后在途帧写入的
    // EPIPE 以「异步 error 事件」投递——writeFrame 的同步 try/catch 接不到；stdin 无
    // error 监听时 Node 对无监听 error 事件直接抛 uncaughtException（测试进程整轮
    // 崩红、用例全绿）。挂监听吃掉预期内的管道死亡留 debug 痕迹；在途请求失败的
    // 语义由 exit 事件 → exit 投影 → 宿主 teardown 统一承担，不经管道错误路径。
    for (const pipe of ["stdin", "stdout", "stderr"] as const) {
      child[pipe]?.on("error", (err: Error) => {
        logger.debug(`[engine-client:${this.opts.engineId}] ${pipe} pipe error (engine died concurrently = expected): ${err.message}`);
      });
    }
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => this.onStdoutData(chunk));
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => this.opts.onStderr?.(chunk));
    child.on("exit", (code, signal) => this.handleChildExit(child, code, signal));
  }

  private onStdoutData(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) this.dispatchFrame(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
    // 帧间残片留 buffer（OS 管道背压语义）。残片有上限：引擎持续输出不含换行的
    // 数据时残片本会无界增长——超限丢头留尾，首截断 warn 一次、后续静默截断；
    // 被截断的行在换行到达后由宿主 handleLine 按 non-NDJSON 丢弃（协议契约 stdout
    // 只允许 NDJSON，无换行输出本身就是引擎侧违规，不构成需要保真的数据）。
    if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
      this.stdoutBuffer = this.stdoutBuffer.slice(this.stdoutBuffer.length - MAX_LINE_BYTES);
      if (!this.stdoutOverflowWarned) {
        this.stdoutOverflowWarned = true;
        logger.warn(
          `[engine-client:${this.opts.engineId}] stdout partial line exceeded ${MAX_LINE_BYTES} chars `
            + `— dropping head and keeping tail (engine emitting non-newline output without completing a line?)`,
        );
      }
    }
  }

  private dispatchFrame(line: string): void {
    for (const handler of this.frameHandlers) handler(line);
  }

  /**
   * child exit 投影（transport 内部监听，先于 onExit 派发）：进程面终局段——孤儿收割
   * （须在宿主镜像置死之前：Windows 通道快照活孤儿判据 + POSIX 组杀需死亡引擎 pid，
   * 此刻 child 仍在）→ pidfile 删 → 句柄清理 → onExit 派发（exitNotified 单次闸）。
   * 宿主 onExit 消费方承接协议面终局（日志分级 / 镜像置死 / 在途请求失败 / 状态回落）。
   */
  private handleChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return; // 迟到的旧一代 exit（已换代/已清理）——忽略
    this.reapOrphansAfterUnexpectedDeath(signal !== null ? `signal ${signal}` : `exit code ${code}`);
    this.removePidfile();
    this.child = undefined;
    child.removeAllListeners();
    if (this.exitNotified) return;
    this.exitNotified = true;
    const info: EngineTransportExitInfo = { code, signal };
    for (const handler of this.exitHandlers) handler(info);
  }

  /**
   * [H1 U2 / 红线①Windows 通道] 镜像快照收割活孤儿：活孤儿清单经 listLiveOrphanPids
   * 提供者同步抓取（置死前——宿主镜像全量项含引擎一生历史死 pid，镜像对已退出子进程
   * 只改 state 不删项、唯一清空点 = killAll，提供者内部过滤活项）→ 逐 pid **异步
   * spawn** taskkill /T /F fire-and-forget（树根 = 活着的任务子进程自身，树杀有效；
   * 快照同步抓、杀动作异步发——与 POSIX fire-and-forget 对称；禁 spawnSync：逐个
   * 同步 N×10s 上界会冻结 exit 投影同步回调、推迟 pending reject（Continuation
   * 失败通知链源头）与宿主事件循环）。
   */
  private reapOrphansViaMirrorSnapshot(detail: string): void {
    const liveOrphanPids = this.opts.listLiveOrphanPids?.() ?? [];
    if (liveOrphanPids.length === 0) return;
    logger.warn(
      `[engine-client:${this.opts.engineId}] reaping ${liveOrphanPids.length} orphaned task child(ren) via mirror snapshot after unexpected engine death (${detail})`,
    );
    for (const pid of liveOrphanPids) {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      killer.unref();
      killer.on("error", (err: Error) => {
        // spawn 失败（taskkill 缺失等）留 debug 痕迹——残余孤儿由红线③登记承接
        //（下一轮派发前兜底 / 宿主重启窗口）。
        logger.debug(
          `[engine-client:${this.opts.engineId}] taskkill spawn failed for orphan pid ${pid} (${err.message})`,
        );
      });
    }
  }
}
