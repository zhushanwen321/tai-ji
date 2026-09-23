// src/spawn.ts
//
// 引擎子进程 spawn 原语 + 引擎侧自灭（W12，impl-plan §2.12 / §2.2 R9-4② / §7.2 R9-2）。
//
// spawnEngineChild 是全部引擎 CLI 任务子进程的唯一 spawn 入口（W10 静态断言目标符号）：
// - 硬编码 POSIX/Windows detached:false（+ windowsHide:true），不暴露 detached 选项
//   ——引擎一代子进程不脱离进程组，宿主杀组即连带收割；
// - 不把引擎自身的 stdin fd 传给后代：子进程 stdin 恒为自有 pipe（'pipe'），
//   禁止 'inherit'/fd 形态——否则宿主死后代仍持写端、EOF 永不到达，自灭主判据失效
//   （R9-4②）。
//
// armEngineSelfDestruct 是引擎 CLI 的宿主死亡自灭守卫：主判据 stdio EOF，
// 辅助判据 in-flight 反向请求计时超时（已 ack 的人机交互 / 两阶段长运行请求除外）。

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { getLogger } from "./logger.ts";
import { killChain, safeKill } from "./kill-chain.ts";
import type { buildEngineChildEnv } from "./env.ts";

const logger = getLogger("engine-sdk/spawn");

/** spawnEngineChild 的 env 必须来自 buildEngineChildEnv（三层契约终态）。 */
export type EngineChildEnv = ReturnType<typeof buildEngineChildEnv>;

/** 引擎子进程 spawn 选项（刻意不暴露 detached / stdio / stdin——形态硬编码，见文件头）。 */
export interface SpawnEngineChildOptions {
  command: string;
  args: readonly string[];
  /** 须由 buildEngineChildEnv 构建（类型即契约：三层 env 终态） */
  env: EngineChildEnv;
  cwd?: string;
  /** 子进程 stdout/stderr 形态；缺省 'pipe'（协议帧走 stdout，stderr 走日志/轮转） */
  stdout?: "pipe" | "ignore" | "inherit";
  stderr?: "pipe" | "ignore" | "inherit";
  /**
   * AbortSignal 触发即杀子（缺省无）。杀链 = SIGCONT 前置 + SIGTERM →
   * ENGINE_ABORT_KILL_GRACE_MS grace → SIGKILL 完整阶梯（killChain 单源）——
   * 裸 SIGTERM 单发对忽略/冻结/卡死的子进程永不收敛，run 悬挂至宿主回收层兜底。
   */
  signal?: AbortSignal;
}

/**
 * abort 杀链的 SIGTERM 优雅窗口（ms）。量级对齐 pi 引擎 PI_KILL_GRACE_MS 现状
 * 校准值 30s（pi 子进程 trap SIGTERM 后 graceful shutdown 的实测量级，race-F4）；
 * zcode abort 路径由「裸 SIGTERM 单发、永不升级」升级为同窗有界兜底（任务级正常
 * 路径不加墙钟、回收层统一有界兜底口径）。
 */
export const ENGINE_ABORT_KILL_GRACE_MS = 30_000;

/** 这些键出现即拒绝：spawn 形态是本原语的契约面，不允许调用方绕过硬编码值。 */
const FORBIDDEN_OPTION_KEYS = ["detached", "stdio", "stdin", "windowsHide"] as const;

/**
 * 引擎任务子进程唯一 spawn 入口。
 *
 * 形态硬编码：detached:false、windowsHide:true、子进程 stdin 恒 'pipe'（自有 pipe，
 * 绝不继承引擎自身 stdin fd）。传入被禁止的形态键（detached/stdio/stdin/windowsHide）
 * 直接抛错——契约破坏应在配置期出声，不静默降级。
 */
export function spawnEngineChild(opts: SpawnEngineChildOptions): ChildProcess {
  for (const key of FORBIDDEN_OPTION_KEYS) {
    if (key in opts) {
      throw new Error(
        `spawnEngineChild: option "${key}" is hardcoded by the engine spawn contract `
          + `(detached:false / windowsHide:true / child stdin is always its own pipe); `
          + `remove it from the call site`,
      );
    }
  }

  const child = spawn(opts.command, [...opts.args], {
    cwd: opts.cwd,
    env: opts.env,
    detached: false,
    windowsHide: true,
    stdio: ["pipe", opts.stdout ?? "pipe", opts.stderr ?? "pipe"],
  });

  if (opts.signal !== undefined) {
    opts.signal.addEventListener(
      "abort",
      () => {
        // [SIGCONT 前置] 唤醒潜在 SIGSTOP 冻结形态——冻结进程对 SIGTERM 只排队不
        // 处理，不先 SIGCONT 则 grace 窗内永远等不到退出（与 pi-rpc killPiProcess
        // 同源的防御）；对未冻结进程是 no-op，对已退进程由 safeKill 幂等吞掉。
        safeKill(child, "SIGCONT");
        void killChain(child, {
          graceMs: ENGINE_ABORT_KILL_GRACE_MS,
          unrefTimers: true,
          escalationNote: `engine child (pid ${child.pid ?? "unknown"}) abort`,
        });
      },
      { once: true },
    );
  }
  return child;
}

// ─────────────────────────────────────────────────────────────────────────────
// 引擎侧自灭（宿主死亡检测）
// ─────────────────────────────────────────────────────────────────────────────

/** in-flight 未 ack 反向请求的计时超时缺省值（辅助判据，30s）。 */
export const DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS = 30_000;

/** 计时超时覆盖 env 名（引擎 CLI 启动时读；非法值 warn + 回落缺省）。 */
export const ENGINE_HOST_REQUEST_TIMEOUT_ENV = "TAIJI_ENGINE_HOST_REQUEST_TIMEOUT_MS";

/** 计时巡检周期（ms）。仅为辅助判据的采样粒度，不构成行为契约。 */
const SWEEP_INTERVAL_MS = 1_000;

/** 反向请求计时面操作接口（消费方 = 引擎 CLI 的反向通道分发层）。 */
export interface ReverseRequestClock {
  /** 反向请求已发出（未 ack）——进入计时面。 */
  started(id: string): void;
  /**
   * 收到 ack（两阶段第一阶段：已 ack 的 host/askUser、HostBridge.executeAndAwait
   * 的 ack）——移出计时面但不终结（R9-2：已 ack 的等待不计入 in-flight 超时，
   * ADR-0047 静默 ≠ 卡死）。
   */
  acked(id: string): void;
  /** 请求终结（应答完成/失败/取消）——彻底移出。 */
  settled(id: string): void;
  /** 卸载守卫（引擎正常 shutdown 路径；自灭后幂等）。 */
  dispose(): void;
}

export interface EngineSelfDestructOptions {
  /** 主判据数据源：宿主→引擎的协议 stdin（EOF = 宿主死亡 → 立即自灭）。 */
  stdin: NodeJS.ReadableStream;
  /** 辅助判据超时（缺省 30s；显式传值优先于 env TAIJI_ENGINE_HOST_REQUEST_TIMEOUT_MS）。 */
  hostRequestTimeoutMs?: number;
  /** 计时超时的 env 覆盖源（缺省读 process.env；测试注入用）。 */
  timeoutEnv?: Record<string, string | undefined>;
  /** 自灭执行器（缺省 = 杀自己进程组再杀自己；测试注入用）。 */
  killSelf?: () => void;
}

/** 解析计时超时：显式 opt > env > 缺省；env 非法（非正整数）warn + 回落缺省。 */
function resolveHostRequestTimeoutMs(opts: EngineSelfDestructOptions): number {
  if (opts.hostRequestTimeoutMs !== undefined) return opts.hostRequestTimeoutMs;
  const raw = (opts.timeoutEnv ?? process.env)[ENGINE_HOST_REQUEST_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn(
      `invalid ${ENGINE_HOST_REQUEST_TIMEOUT_ENV}=${JSON.stringify(raw)}, falling back to `
        + `${DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS}ms`,
    );
    return DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS;
  }
  return parsed;
}

/** 缺省自灭：先杀自己进程组（-pid，收割引擎 spawn 的任务子进程），失败回落杀自己。 */
function killOwnProcessGroup(): void {
  const pid = process.pid;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (err) {
    // 进程组杀失败（非组长 / Windows 形态差异）——回落单进程杀，任务子进程由
    // 各自的 stdio EOF / 宿主回收层兜底。
    logger.warn(`process-group kill failed (${String(err)}), falling back to self kill`);
    process.kill(pid, "SIGKILL");
  }
}

/**
 * 武装引擎侧自灭守卫。返回 ReverseRequestClock 给反向通道分发层登记请求生命周期。
 *
 * 判据：
 * - 主判据 stdio EOF：stdin 'end'（数据面读尽）或 'close'（fd 关闭）→ 立即自灭
 *   （宿主死后无人再写协议帧，引擎继续跑只烧 token）；
 * - 辅助判据 in-flight 反向请求计时：未 ack 的反向请求超过 hostRequestTimeoutMs
 *   仍无 ack → 宿主大概率已死（EOF 未达或正在关闭）→ 自灭。**排除面**：已 ack 的
 *   host/askUser 与两阶段 ack 的长运行 HostBridge.executeAndAwait（ack 后等待任意
 *   时长合法，漏此项即「>30s pi 任务被自灭」turnTimeoutMs 同型事故）。
 *
 * 自灭执行 = 引擎自杀并杀自己进程组（spawnEngineChild 硬编码 detached:false，
 * 任务子进程同组连带收割）。
 */
export function armEngineSelfDestruct(opts: EngineSelfDestructOptions): ReverseRequestClock {
  const timeoutMs = resolveHostRequestTimeoutMs(opts);
  const killSelf = opts.killSelf ?? killOwnProcessGroup;

  // pending = 已发出未 ack（计时面）；settled/acked 请求不在面内。
  const pending = new Map<string, number>();
  let disposed = false;

  const destroy = (reason: string): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    opts.stdin.removeAllListeners?.("end");
    opts.stdin.removeAllListeners?.("close");
    logger.warn(`engine self-destruct: ${reason}`);
    killSelf();
  };

  // 主判据：stdio EOF（'end' 与 'close' 双挂——pipe 半关闭与 fd 销毁都算宿主死亡）
  opts.stdin.once("end", () => destroy("host stdin EOF (end)"));
  opts.stdin.once("close", () => destroy("host stdin closed"));

  // 辅助判据：未 ack 反向请求计时巡检（timer 声明于 destroy 之后——destroy 仅经
  // 事件/回调异步触发，调用时已初始化）
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, startedAt] of pending) {
      if (now - startedAt > timeoutMs) {
        destroy(`unacked reverse request ${id} exceeded ${timeoutMs}ms without host ack`);
        return;
      }
    }
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();

  return {
    started(id) {
      if (!disposed) pending.set(id, Date.now());
    },
    acked(id) {
      pending.delete(id);
    },
    settled(id) {
      pending.delete(id);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      opts.stdin.removeAllListeners?.("end");
      opts.stdin.removeAllListeners?.("close");
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NDJSON 行泵（子进程 stdout 拆行）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 流式 NDJSON 行泵：utf8 解码 + 缓冲累积 + "\n" 拆行循环（S4 簇 5b 收编：pi
 * spawn-run-pump 与 zcode connection 的逐字同构段单源化，实现以 pi 版为基线）。
 * 末行无换行符时滞留缓冲（NDJSON 语义：行以 \n 定界）；不监听 end/close/error——
 * 生命周期接线（close 收尾/error 兜底）由调用方自行挂接。stream 为 null/undefined
 * （无 stdio）时无操作，与原调用点 `child.stdout?.` 可选链语义等价。
 */
export function pumpNdjsonLines(
  stream: NodeJS.ReadableStream | null | undefined,
  onLine: (line: string) => void,
): void {
  if (stream === null || stream === undefined) return;
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      onLine(line);
      nl = buffer.indexOf("\n");
    }
  });
}
