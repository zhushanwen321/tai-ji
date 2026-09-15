// src/kill-chain.ts
//
// 超时杀链与 abort 两级中断（引擎侧原语，自 core execution/engine/common/kill-chain.ts
// 迁入 @zhushanwen/subagent-engine-sdk，实现体逐字等价）。迁移处置（impl-plan §2.1
// kill-chain 行，逐项落地）：
//   - 契约类型随 SDK 下沉：AgentCallOpts（引擎面子集）/ AgentOutcome 改自
//     src/protocol/contract-types.ts（结构等价，零 core import）；
//   - DEFAULT_ENGINE_ID 改参数注入：synthesizeTimeoutOutcome 的 engineId 必填，
//     不再携带 core registry 缺省值（调用方显式传自己的引擎 id）；
//   - logger 走 SDK facade（src/logger.ts）；
//   - engineTimeoutDetail / STDOUT_TAIL_ECHO_CHARS 自持（src/protocol/error-codes.ts，
//     文案与 core errors.ts 逐字等价）；toErrorMessage 改用 SDK 单源
//     src/error-message.ts（round1-reuse R11 收编原内联副本）。
//
// 设计权威源：docs/architecture/subagent-engine-abstraction.md D1（abort 分级：引擎原生
// 中断 → 公共杀链兜底；CLI-only 引擎直接杀链，杀死后宿主合成终态）+ §3.3.3
// engine_timeout / engine_run_failed 行 + 附录 A「CLI 超时」行。

import { getLogger } from "./logger.ts";
import { toErrorMessage } from "./error-message.ts";
import { engineTimeoutDetail, STDOUT_TAIL_ECHO_CHARS } from "./protocol/error-codes.ts";
import type { AgentCallOpts, AgentOutcome } from "./protocol/contract-types.ts";

const logger = getLogger("subagents");

/** STDOUT_TAIL_ECHO_CHARS re-export（core 版同款导出面，调用方免跨模块 import）。 */
export { STDOUT_TAIL_ECHO_CHARS };

// ============================================================
// 杀链（SIGTERM → grace → SIGKILL）
// ============================================================

/**
 * 可杀子进程的结构形状（Node ChildProcess 的结构子集）。
 * 用结构接口而非 ChildProcess 类型：测试可注入 fake（ChildProcess 全字段构造过重），
 * 且未来 driver host 的常驻进程句柄只要满足此形状即可复用杀链。
 */
export interface KillableChild {
  /** 非 null = 进程已退出（自然退出码）。 */
  readonly exitCode: number | null;
  /** 非 null = 进程被信号杀死。exitCode/signalCode 任一非 null 即已退出。 */
  readonly signalCode: string | null;
  /** 发信号。返回 false = 进程已不存在（kill no-op）。 */
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

// 毫秒→秒换算（SIGKILL 升级 warn 日志的秒数显示）。文件内私有定义：工程内 MS_PER_SECOND
// 惯例是各使用文件私有常量（execution-record / lifecycle-manager / session-file-gc /
// session-runner 四处先例），无共享导出源可 import，保持同惯例不另立导出点。
const MS_PER_SECOND = 1_000;

/** SIGTERM 优雅窗口默认值（ms）。实测校准点：设计 §5 待验证检查点⑤（zcode 对 SIGTERM 的响应时序）。 */
export const DEFAULT_KILL_GRACE_MS = 5_000;

/** SIGKILL 发出后的收尸等待上限（ms）——SIGKILL 后进程必死（D 状态罕见），有界等待防挂死。 */
const SIGKILL_REAP_TIMEOUT_MS = 10_000;

/**
 * 宿主超时 abort 的 signal.reason 标记（对齐点④）。mergeTimeoutSignal（SAR 侧超时
 * 合并链）产出；引擎 abort 合成终态时判别「超时 vs 用户 cancel」——超时统一走
 * synthesizeTimeoutOutcome（engine_timeout），cancel 维持中止标记（engine_run_failed）。
 */
export const HOST_TIMEOUT_ABORT_REASON = "agent-call-timeout";

/** killChain 的参数形状。 */
export interface KillChainOptions {
  /**
   * SIGTERM 优雅窗口（ms）。grace 窗口按引擎参数化（D3-① 杀链合一）：pi 传 30s
   * （[race-F4] 现状值）、zcode 传 5s（ZCODE_KILL_GRACE_MS）——两引擎现状逐字节保持。
   */
  graceMs: number;
  /**
   * [D3-①] 内部 timer unref。pi 路径现状 = 升级 timer unref（不阻止主进程退出，dispose
   * killAll 兜底）；zcode 现状 = ref'd（timer 挂起时进程等待收尸）——各引擎按现状传。
   */
  unrefTimers?: boolean;
  /**
   * SIGKILL 升级时的 warn 留痕载体（如 `child sa-xxx (source: spawn watchdog)`）。
   * 不传则升级静默（zcode 现状）——pi 侧现状有 warn，由调用方组装完整语境。
   */
  escalationNote?: string;
}

/**
 * 杀链：SIGTERM → 等待 graceMs → 仍存活则 SIGKILL。
 *
 * @returns 'terminated' = SIGTERM 优雅退出（或进程已自行退出）；'killed' = 走了 SIGKILL。
 */
export async function killChain(
  child: KillableChild,
  opts: KillChainOptions,
): Promise<"terminated" | "killed"> {
  // 已退出（自然/已被杀）→ 无需发信号，按优雅终止口径返回
  if (child.exitCode !== null || child.signalCode !== null) return "terminated";

  const exited = waitForExit(child);
  safeKill(child, "SIGTERM");

  const graceful = await raceTimeout(exited, opts.graceMs, opts.unrefTimers === true);
  if (graceful === "settled") return "terminated";
  // grace 超时后进程可能恰好在检查前一刻退出——复核退出态，避免误杀已死进程
  if (child.exitCode !== null || child.signalCode !== null) return "terminated";

  if (opts.escalationNote !== undefined) {
    logger.warn(
      `[kill-chain] ${opts.escalationNote} still alive ${opts.graceMs / MS_PER_SECOND}s after SIGTERM, escalating to SIGKILL`,
    );
  }
  safeKill(child, "SIGKILL");
  // 有界收尸：无论等到与否都返回 'killed'（信号已发出，返回值表达「走了 SIGKILL」）
  await raceTimeout(exited, SIGKILL_REAP_TIMEOUT_MS, opts.unrefTimers === true);
  return "killed";
}

/**
 * 发信号兜底包裹：进程恰在退出态检查与 kill 之间自退时，ChildProcess.kill 可能抛
 * （zsub 实测经验）——幂等吞掉并 debug 留痕，不阻断杀链语义（对已退进程信号本就是
 * no-op）。收口自 zcode launcher 的内联实现（对齐点②：单一权威）。
 */
function safeKill(child: KillableChild, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (err) {
    logger.debug(
      `[kill-chain] ${signal} on exited process: ${toErrorMessage(err)}`,
    );
  }
}

// ============================================================
// 超时终态合成
// ============================================================

/**
 * 合成 engine_timeout 终态（宿主超时杀链走完后的 AgentOutcome）。
 * 含 stdout 尾部 2000 字 + 恢复指引（§3.3.3 第 6 行）；exitCode: null = 被信号杀死
 * （AgentOutcome 的杀链判据，§3.3.5）。
 *
 * engineId 参数注入（原 core 版缺省 DEFAULT_ENGINE_ID——SDK 不感知宿主路由缺省值，
 * 调用方必须显式传实际引擎 id）。
 */
export function synthesizeTimeoutOutcome(
  task: AgentCallOpts,
  stdoutTail: string,
  engineId: string,
): AgentOutcome {
  return {
    content: "",
    // slug 进错误信息：单看 outcome（record 之外）也能定位是哪个任务超时
    error: `engine_timeout: [slug=${task.description ?? "unknown"}] ${engineTimeoutDetail(stdoutTail)}`,
    // 被信号杀死：退出码语义为 null（§3.3.5 AgentOutcome.exitCode 注释）
    exitCode: null,
    engineId,
  };
}

// ============================================================
// abort 两级编排
// ============================================================

/** 原生中断后的宽限窗口默认值（ms）：中断指令送达 → 引擎自行收尾的等待上限。 */
export const DEFAULT_NATIVE_INTERRUPT_GRACE_MS = 3_000;

/**
 * abort 两级编排 helper（D1 abort 分级的公共实现）：
 * signal abort 时 ①先调引擎原生中断（tryNativeInterrupt，若有）并给宽限窗口，
 * 窗口内未停（或无原生中断——CLI-only 引擎）则 ②走杀链兜底。
 *
 * 进程自然退出时以 'terminated' settle（挂在 exit 事件上，杀链对已退进程是 no-op），
 * 调用方可安全 await；signal 永不 abort 且进程已退时也会 settle，不悬挂。
 */
export function abortWithFallback(
  child: KillableChild,
  signal: AbortSignal,
  tryNativeInterrupt?: () => Promise<void>,
  opts?: { graceMs?: number; nativeGraceMs?: number },
): Promise<"terminated" | "killed"> {
  const graceMs = opts?.graceMs ?? DEFAULT_KILL_GRACE_MS;
  const nativeGraceMs = opts?.nativeGraceMs ?? DEFAULT_NATIVE_INTERRUPT_GRACE_MS;

  return new Promise<"terminated" | "killed">((resolve) => {
    let settled = false;
    // 三个 handler 互相引用（finish 移除 onAbort / onAbort 触发 runChain / runChain
    // 兜底 finish），用函数声明 + 提升消解声明环，避免 use-before-define。
    function finish(result: "terminated" | "killed"): void {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    }

    function onExit(): void {
      finish("terminated");
    }

    function runChain(): void {
      void (async () => {
        if (tryNativeInterrupt) {
          try {
            await tryNativeInterrupt();
          } catch (err) {
            // 原生中断失败（协议错/管道断）→ 直接落杀链，中断失败不阻断兜底。
            // debug 级留诊断线索：这不是错误终态，只是该引擎优雅中断不可用
            logger.debug(
              `[kill-chain] native interrupt failed, falling back to kill chain: ${
                toErrorMessage(err)
              }`,
            );
          }
          const stopped = await raceTimeout(waitForExit(child), nativeGraceMs);
          if (stopped === "settled" || settled) return; // 原生中断生效，进程已停
        }
        finish(await killChain(child, { graceMs }));
      })();
    }

    function onAbort(): void {
      runChain();
    }

    // 进程自然退出（含原生中断生效）→ 优雅终止口径。
    // once listener 不显式移除：触发时 finish 已幂等，单 child 单 listener 无堆积。
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish("terminated");
      return;
    }

    if (signal.aborted) runChain();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ── 内部工具 ────────────────────────────────────────────────────

/** 等 child 退出（已退出立即 settle；否则挂一次性 exit listener）。 */
function waitForExit(child: KillableChild): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
}

/** promise vs 超时：超时先到返回 'timeout'（promise 继续但被放弃等待）。unref 见 KillChainOptions。 */
function raceTimeout(p: Promise<void>, ms: number, unref = false): Promise<"settled" | "timeout"> {
  return new Promise<"settled" | "timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    if (unref) timer.unref();
    p.then(
      () => {
        clearTimeout(timer);
        resolve("settled");
      },
      () => {
        // 被 await 的 exit promise 不会 reject；防御分支保持语义完整（超时口径胜出前出错按 settled 处理）
        clearTimeout(timer);
        resolve("settled");
      },
    );
  });
}
