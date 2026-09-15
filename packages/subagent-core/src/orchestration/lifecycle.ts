/**
 * Workflow Extension — lifecycle
 *
 * Workflow run 生命周期 free functions（D-12）。
 *
 * 5 个导出函数：
 * - runWorkflow(spec, deps, signal?) → Promise<runId>
 * - abortRun(runId, deps, reason?, doneReason?) → Promise<void>（done no-op）
 * - terminateRunningRuns(deps, reason) → Promise<void>（session 切换/关闭终止）
 * - evictDoneRunsBeyondCap(runs, keepDone) → number（done run 内存淘汰）
 * - scheduleTimeBudget(runId, deps, budgetTimeMs) → timer（C.7 时间预算）
 *
 * 第 6 个导出：recoverCrashedRuns(store, runs, reason, hooks?) —— 崩溃恢复四步
 * 装配（loadAll→failed→save→evict，D8/B1），宿主专属事件经 hooks 外置。
 *
 * 私有 makeHandlers(run, deps) → WorkerHandlers：
 * - onMessage → handleWorkerMessage(run, raw, deps, handlers)
 * - onError → handleWorkerError(run, err, deps, handlers) + workerErrorCount++
 * - onExit(code, handle) → handleWorkerExit(run, code, handle, deps, handlers)
 * （G-025：handle.isCurrent 检查内化在 handleWorkerExit 内）
 *
 * **A4 原子性**：abort/terminate 内部 transition 先 releaseRuntime（cleanup before
 * mutate），失败时 status 不变。transition("done") 在 WorkflowRun.transition 内已实现
 * 「releaseRuntime → 改 status」原子顺序。
 *
 * **G3-001**（run 一次性生命周期）：AbortController 一次性无法复用，runtime 释放后
 * 只有两类重建——rebuildRuntime（worker-message-pump，崩溃重试路径，run 保持 running、
 * replaceRuntime 原子换新）与 abort/terminate 的终态释放（transition("done") 内
 * releaseRuntime，run 不再恢复）。
 * （旧并发门闩 gate 抽象已删——no-op 无生产语义，实际并发由 SubagentService
 * ConcurrencyPool 管理；原 D-13 maxConcurrency=4 无消费方。）
 *
 * 层归属：Engine。依赖 LifecycleDeps + WorkerHost via port +
 * WorkflowRun + handleWorker* 函数。
 *
 * 参考：domain-models.md §1（聚合根状态机）。
 */

import { getLogger } from "../core/logger.ts";

import { assertSafeTimerDelay } from "../shared/timer-delay.ts";
import { validateRunArgs } from "./args-validator.ts";
import {
  closeOutInFlightCalls,
  finalizeRun,
  handleWorkerError,
  handleWorkerExit,
  handleWorkerMessage,
} from "./worker-message-pump.ts";
import { Budget } from "./models/budget.ts";
import type { LifecycleDeps, RunStore, WorkerHandlers } from "./models/ports.ts";
import { RunRuntime } from "./models/run-runtime.ts";
import type { RunSpec } from "./models/run-spec.ts";
import { Trace } from "./models/trace.ts";
import type { DoneReason } from "./models/types.ts";
import { WorkflowRun } from "./models/workflow-run.ts";
import type { WorkerHandle } from "./worker-handle.ts";
import { toErrorMessage } from "../core/error-message.ts";

const logger = getLogger("subagents");

// ── 常量 ─────────────────────────────────────────────────────

/** runId 生成：wf-<timestamp>-<base36 random 6 chars>。 */
const RUNID_RADIX = 36;
const RUNID_SLICE_START = 2;
const RUNID_SLICE_END = 8;

/**
 * done run 内存保留窗口（K=20）。
 *
 * 本淘汰是 done run 内存有界性的唯一来源：calls.result 不裁、单聚合大小不随 wave1
 * 裁剪缩小，故内存上限 = K × 实际聚合大小。同时定义 actionStatus 可查刚完成 run
 * 的窗口（超出窗口的 done run 不再出现在列表中——已接受的用户可见变化）。
 */
export const MAX_RETAINED_DONE_RUNS = 20;

function generateRunId(): string {
  return `wf-${Date.now()}-${Math.random().toString(RUNID_RADIX).slice(RUNID_SLICE_START, RUNID_SLICE_END)}`;
}

// ── OR-7：signal abort listener 终态移除 ─────────────────────

/**
 * run → signal abort listener 收口句柄注册表。
 *
 * [OR-7] 旧实现 `{ once: true }` 只在 abort 触发时自清——run 经 return / error /
 * abortRun / terminate 等任何终态路径收敛后，listener 仍挂在（可能长生命周期的）
 * 外部 signal 上，同 signal 连续跑多 run 时每次泄漏一个（超 11 个触发
 * MaxListeners 告警；tool-workflow 的 run action 传的是 pi 会话级 signal，泄漏
 * 真实可达）。对齐 launcher.ts L-2 修复形态：命名 handler + run 终态
 * removeEventListener。
 *
 * WeakMap：run 被 GC 时条目随之消亡——即使未来新增终态路径漏调 dispose，
 * 注册表本身也不成为新的无界泄漏面。
 */
const signalAbortDisposers = new WeakMap<WorkflowRun, () => void>();

/** 移除 run 关联的 signal abort listener（幂等；未注册 run 为 no-op）。 */
function disposeSignalAbortListener(run: WorkflowRun): void {
  const dispose = signalAbortDisposers.get(run);
  if (!dispose) return;
  signalAbortDisposers.delete(run);
  dispose();
}

/**
 * [OR-3] 向 worker 广播 {type:"abort"}——终止 run 时先于 transition（= releaseRuntime
 * → worker.terminate）通知 worker 优雅解阻：worker 侧 pending Map 全部 reject
 * （WorkflowAbortedError，worker-script-builder 既有 abort 分支），脚本 catch 后自然
 * 收尾退出，不再依赖 terminate 硬杀。
 *
 * P-T3 语义：广播与 worker 自然退出交错不产 unhandledRejection——postMessage 同步抛错
 * （worker 已退出/通道关闭）只 debug 留痕不中断 abort 主流程（pendings 随 worker 死亡
 * 清理；WorkerHandle.postMessage 对已 terminate handle 本身 no-op）；transition 必须继续。
 */
function broadcastAbortToWorker(run: WorkflowRun, reason: string): void {
  try {
    run.runtime?.worker.postMessage({ type: "abort", reason });
  } catch (err) {
    const msg = toErrorMessage(err);
    logger.debug(
      `[workflow] abort broadcast to worker failed (runId=${run.runId}, worker likely already exited): ${msg}`,
    );
  }
}

// ── makeHandlers（路由 worker 事件到 worker-message-pump handle* 函数） ──────

/**
 * 构造 WorkerHandlers——将 worker 的 onMessage/onError/onExit 事件路由到
 * worker-message-pump 的 handleWorker* 函数。
 *
 * 闭包捕获 run + deps。runtime 重建（replaceRuntime）后 run 实例不变、deps 不变，
 * 故 handlers 对新 worker 仍有效（lifecycle 与 worker-message-pump 共用 handlers）。
 *
 * **onExit G-025**：handleWorkerExit 内部检查 handle.isCurrent（stale exit 丢弃）。
 * 本函数不在 onExit 里重复检查——worker-message-pump.handleWorkerExit 是单一守卫点。
 *
 * **workerErrorCount**：onError 触发时递增（C.5 跨 runtime 存活的重试计数载体）。
 * 注意 handleWorkerError 内部也会递增——这里 onError 递增是 worker 事件层面的
 * 「error 事件到达」计数，handleWorkerError 内的是「错误处理决策」计数。
 * 实际 handleWorkerError 会做最终计数（含重试上限判断），onError 不重复递增。
 */
function makeHandlers(run: WorkflowRun, deps: LifecycleDeps): WorkerHandlers {
  // [OR-7] per-run deps 视图：包装 onRunDone，把「run 终态」转译为「移除 signal abort
  // listener」。worker-message-pump 全部终态路径（handleReturn / handleWorkerError /
  // handleScriptError / handleWorkerExit / 预算终止 / time_limited / [OR-2] rebuild
  // 失败收敛——均经 finalizeRun）都经 handlers 调用链消费本视图——消息面终态在此
  // 统一收口；abortRun / terminateRunningRuns 两个 lifecycle 自有终态路径另行显式 dispose。
  const depsWithTerminalCleanup: LifecycleDeps = {
    ...deps,
    onRunDone: (doneRun: WorkflowRun): void => {
      disposeSignalAbortListener(run);
      deps.onRunDone?.(doneRun);
    },
  };
  // 自引用——worker-message-pump rebuildRuntime 需要 handlers 参数（handlers 引用自身）
  const handlers: WorkerHandlers = {
    async onMessage(raw: unknown): Promise<void> {
      await handleWorkerMessage(run, raw, depsWithTerminalCleanup, handlers);
    },
    async onError(err: Error): Promise<void> {
      await handleWorkerError(run, err, depsWithTerminalCleanup, handlers);
    },
    async onExit(code: number, handle: WorkerHandle): Promise<void> {
      // H-2：用 worker-host 传入的 handle（即真正触发 exit 的那个 handle），而非
      // run.runtime?.worker——重试竞态下 runtime.worker 可能已被 replaceRuntime 替换
      // 为新 handle，导致 handleWorkerExit 内的 isCurrent 检查误判（漏判 stale exit 或
      // 误杀新 worker）。G-025 检查仍在 handleWorkerExit 内（handle.isCurrent）。
      await handleWorkerExit(run, code, handle, depsWithTerminalCleanup, handlers);
    },
  };
  return handlers;
}

// ── scheduleTimeBudget（C.7 Run 级时间预算调度） ──────────

/**
 * 启动 run 级墙钟时间预算计时器：到期后 abortRun(doneReason="time_limited")。
 *
 * 恢复旧 orchestrator-budget.ts 的 scheduleTimeBudgetCheck 语义——runWorkflow 启动
 * 一个 setTimeout(maxTimeMs)，到期若 run 仍未终态则转 done,time_limited。
 * 计时器存入 RunRuntime.timeBudgetTimer，release（abort/replaceRuntime）时
 * 自动清理，避免孤儿触发。worker/script 错误重试经 rebuildRuntime 重排新计时器。
 *
 * @returns 计时器句柄（未设预算时 undefined）
 * @throws budgetTimeMs 超出 Node setTimeout 上限（2^31-1）——溢出值会被 Node 置 1ms
 *   立即触发（「不限时预算」变「立即超时」），fail-fast 不静默 clamp（U1）。
 */
export function scheduleTimeBudget(
  runId: string,
  deps: LifecycleDeps,
  budgetTimeMs: number,
): ReturnType<typeof setTimeout> {
  // [U1] arm 入口：值流入 setTimeout 前校验安全域（>2^31-1 会变 1ms 立即触发）。
  assertSafeTimerDelay(budgetTimeMs, "budgetTimeMs");
  const timer = setTimeout(() => {
    void abortRun(runId, deps, "Time budget exceeded", "time_limited").catch(
      (err: unknown) => {
        const msg = toErrorMessage(err);
        logger.error(`[workflow] time budget abort failed: ${msg}`);
      },
    );
  }, budgetTimeMs);
  // unref：不阻止 Node 退出（workflow 是后台任务，不应因计时器持有事件循环）。
  timer.unref();
  return timer;
}

// ── runWorkflow ──────────────────────────────────────────────

/**
 * rfl 仪表（tier-1 §7.1）：向 spec.args 原地注入稳定 _runId。runAndWait 与
 * executeNestedWorkflow 两个 args 入口都经 runWorkflow 这一 choke point；
 * rebuildRuntime 复用 run.spec.args 同一对象（worker-message-pump.ts），worker rebuild
 * 后脚本侧 $ARGS._runId 不漂移——修复「rebuild 回退 run-<Date.now()> 导致同一
 * 逻辑 run 碎裂到多个 state 目录」。注入在 validateRunArgs 之后，不参与脚本
 * 参数 schema 校验（引擎内部字段）。
 */
function injectRunId(spec: RunSpec, runId: string): void {
  if (spec.args && typeof spec.args === "object") {
    spec.args._runId = runId;
  }
}

/** P1-2: pre-aborted signal → fail fast（run 创建前抛，zero side effects）。 */
function assertSignalNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Workflow run aborted before start");
  }
}

/** 创建 running 态 WorkflowRun（budget 共享引用优先，否则按 spec 上限新建）。 */
function createRunningRun(runId: string, spec: RunSpec): WorkflowRun {
  return new WorkflowRun(
    runId,
    spec,
    {
      status: "running",
      budget: spec.budgetRef ?? new Budget({
        maxTokens: spec.budgetTokens,
        maxTimeMs: spec.budgetTimeMs,
      }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
}

/**
 * C.7：run 级时间预算计时器（spec.budgetTimeMs > 0 时启用，到期 abortRun
 * time_limited）。OR-1 顺序修复（unbounded-wait-audit §4.1）：调度先于
 * workerHost.start——budgetTimeMs 越界（>2^31-1）的 fail-fast throw
 * （assertSafeTimerDelay）发生在任何副作用（worker 启动、runs 注册）之前，
 * 杜绝「worker 已跑、run 永不可达」的孤儿窗口（此前 runs.set 在最末，
 * fail-fast 后连 abortRun 都抛 not found）。
 */
function armTimeBudgetTimer(
  runId: string,
  deps: LifecycleDeps,
  spec: RunSpec,
): ReturnType<typeof setTimeout> | undefined {
  return spec.budgetTimeMs && spec.budgetTimeMs > 0
    ? scheduleTimeBudget(runId, deps, spec.budgetTimeMs)
    : undefined;
}

/**
 * 启动 worker；失败时清理已挂的 timeBudget timer——前移的代价：start 抛错时
 * 已挂的 timer 会残留，到期对从未注册的 runId 触发 abortRun（必抛 not found）
 * ——该路径 runs.set 未到，须就地清理。
 */
function startWorkerGuarded(
  spec: RunSpec,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
  timeBudgetTimer: ReturnType<typeof setTimeout> | undefined,
): WorkerHandle {
  try {
    return deps.workerHost.start(spec, spec.args, handlers);
  } catch (err) {
    if (timeBudgetTimer) clearTimeout(timeBudgetTimer);
    throw err;
  }
}

/**
 * signal abort → abortRun（[OR-7] 命名 listener + run 终态移除，注册表
 * signalAbortDisposers；触发时自移除 = 显式 once 语义）。
 * [B-2] 注册点后移到全部 fail-fast throw（assertSafeTimerDelay / workerHost.start）
 * 成功之后——旧实现先注册 listener，scheduleTimeBudget/start 两条 throw 路径 run
 * 永不到终态，disposeSignalAbortListener 永不被调，同 signal 重试每次泄漏一个
 * listener（MaxListeners 告警面）。移后 throw 路径天然未注册，零泄漏；首个真正
 * 副作用前完成校验的语义保持（addEventListener 本身也是设计意义上的副作用）。
 * 注册点到 store.save 之间无 await（同步段），signal 在此窗口 abort 不可能丢失。
 */
function registerSignalAbortListener(
  run: WorkflowRun,
  runId: string,
  deps: LifecycleDeps,
  signal: AbortSignal | undefined,
): void {
  if (!signal) return;
  const onAbort = (): void => {
    disposeSignalAbortListener(run);
    void abortRun(runId, deps, "External signal aborted").catch((err: unknown) => {
      const msg = toErrorMessage(err);
      logger.error(`[workflow] abortRun on signal failed: ${msg}`);
    });
  };
  signal.addEventListener("abort", onAbort);
  signalAbortDisposers.set(run, () => signal.removeEventListener("abort", onAbort));
}

/** pending-notifications: run 启动 → 注册（所有 workflow 启动路径的单一汇聚点）。 */
function emitPendingRegister(runId: string, deps: LifecycleDeps, spec: RunSpec): void {
  deps.eventBus?.emit("pending:register", {
    id: runId,
    type: "workflow",
    name: spec.slug || spec.scriptName || runId,
  });
}

/**
 * 启动一个 workflow run。
 *
 * 流程：创建 WorkflowRun（running，I1 构造期跳过）+ makeHandlers + 构建 RunRuntime
 * （worker+gate+controller）+ assignRuntime（注入 runtime，恢复 I1）+ 注册到
 * deps.runs + store.save。
 *
 * @param spec RunSpec（scriptSource 只读；args 会被原地注入 _runId——rfl C2 契约，
 * worker 启动与崩溃重建共用同一 args 对象）
 * @param deps LifecycleDeps（store/workerHost/runner/runs）
 * @param signal 外部 abort signal（可选；abort 时调 abortRun）
 * @returns runId（wf-<timestamp>-<random>）
 * @throws signal 已 abort（pre-abort fail fast）
 */
export async function runWorkflow(
  spec: RunSpec,
  deps: LifecycleDeps,
  signal?: AbortSignal,
): Promise<string> {
  // m3 E9：参数校验单一 chokepoint，钉在所有副作用前（generateRunId/log/signal
  // listener/runs.set/workerHost.start/store.save/pending:register）。校验失败时
  // zero side effects。coerceTypes 原地规范化 spec.args——worker 启动与崩溃重建
  // 共用同一对象（run.spec === spec），恢复路径参数一致。
  validateRunArgs(spec);

  const runId = generateRunId();
  injectRunId(spec, runId);
  deps.log?.("debug", "workflow:lifecycle", "runWorkflow start", { runId, scriptName: spec.scriptName });

  // P1-2: pre-aborted signal → fail fast
  assertSignalNotAborted(signal);

  const run = createRunningRun(runId, spec);

  // 构造 handlers + runtime（worker + controller）
  const handlers = makeHandlers(run, deps);
  const controller = new AbortController();
  const timeBudgetTimer = armTimeBudgetTimer(runId, deps, spec);
  const worker = startWorkerGuarded(spec, deps, handlers, timeBudgetTimer);
  const runtime = new RunRuntime(worker, controller, timeBudgetTimer);

  // assignRuntime（注入 runtime，恢复 I1：running ⟺ runtime!==undefined）
  run.assignRuntime(runtime);

  // 注册到 deps.runs（assignRuntime 之后——构造到 assignRuntime 之间 run 处于
  // I1 跳过窗口（running 而 runtime undefined），后移保证窗口对外不可见；
  // scheduleTimeBudget/worker.start 抛错时 run 未注册，无孤儿 run 残留）
  deps.runs.set(runId, run);

  registerSignalAbortListener(run, runId, deps, signal);

  await deps.store.save(run);
  deps.log?.("debug", "workflow:lifecycle", "run saved", { runId, status: run.state.status });

  // pending-notifications: run 启动 → 注册（runAndWait / actionRun / 未来入口全覆盖）
  deps.log?.("debug", "workflow:lifecycle", "emit pending:register", { runId });
  emitPendingRegister(runId, deps, spec);
  deps.log?.("debug", "workflow:lifecycle", "emit pending:register done", { runId });

  return runId;
}

// ── abortRun ─────────────────────────────────────────────────

/**
 * 中止 workflow（running）。
 *
 * **done 状态 no-op**：已终态的 run 不重复 abort。
 * **A4 原子性**：transition("done", doneReason) 内部先 releaseRuntime。
 *
 * @param runId
 * @param deps
 * @param reason 可选中止原因（存 run.state.error）
 * @param doneReason 终态原因（默认 "aborted"；超时场景传 "time_limited"，C.7）
 * @throws runId 不存在
 */
export async function abortRun(
  runId: string,
  deps: LifecycleDeps,
  reason?: string,
  doneReason: DoneReason = "aborted",
): Promise<void> {
  const run = deps.runs.get(runId);
  if (!run) {
    throw new Error(`Workflow '${runId}' not found`);
  }

  deps.log?.("debug", "workflow:lifecycle", "abortRun", { runId, status: run.state.status, reason, doneReason });

  // done 状态 no-op
  if (run.state.status === "done") {
    deps.log?.("debug", "workflow:lifecycle", "abortRun no-op: already done", { runId });
    return;
  }

  // 记录中止原因
  if (reason) {
    run.state.error = reason;
  }
  // [OR-3] 先广播 abort 再 transition（transition 内 releaseRuntime→terminate，
  // terminate 之后广播发不进去）——worker 侧 pending 优雅解阻
  broadcastAbortToWorker(run, reason ?? `Workflow aborted (${doneReason})`);
  // [OR-7] run 终态：移除 signal abort listener（幂等；abort 由 signal 触发时
  // listener 已在 onAbort 内自移除，此处为其余 abort 入口的收口；即使 finalizeRun
  // 因并发终态化让位，WeakMap 条目也应清除，不依赖 transition 成败）
  disposeSignalAbortListener(run);
  // A4 + C-4: transition 内部 releaseRuntime（cleanup before mutate）；到达 done 终态
  // → 注销 pending-notification + 通知 Interface 层（D5-② 终态 coda 收敛为
  // worker-message-pump 的 finalizeRun 单写点——OR-8 in-flight 收口 + save best-effort
  // （SW-DATA-3）不再向上抛，内存态已终态，调用方无需因落盘失败收到 abort 异常；
  // OR-4/B-4 unregister 与 onRunDone 各自独立围栏）
  await finalizeRun(run, deps, doneReason, { context: `abortRun (${doneReason})` });
}

// ── terminateRunningRuns（session 切换/关闭：终止全部 running run） ────────

/**
 * 终止 deps.runs 中全部 running run（session 切换 / session 关闭时调用）。
 *
 * 一次性生命周期（D-2）：session 离开当刻，running run 的 token 投入作废，转
 * done,failed 持久化落盘——重启后 kill-9 恢复不误判，也不再存在「挂起待恢复」
 * 的中间态。
 *
 * per-run 行为：`state.error = reason` → `finalizeRun(run, deps, "failed",
 * {notifyDone:false})`（transition("done","failed") 内部先 releaseRuntime，A4 →
 * save best-effort → `eventBus.emit("pending:unregister", {reason:"failed"})`）。
 *
 * **不调 deps.onRunDone**（经 finalizeRun 的 notifyDone:false 承载，D5-②）：
 * 对齐 session_start 恢复先例（index.ts kill-9 恢复只发
 * unregister、不发 onRunDone）——session 切换/关闭语境下主 agent 已离开本 session，
 * 注入完成通知只会把消息发给已离开的 session。
 *
 * **不调 discardInFlightCalls**：run 已转终态不再 replay（无恢复路径），在飞 call
 * 缓存清不清都不影响结果；该清理仅 rebuildRuntime 需要（崩溃重试会重放脚本，
 * 假失败结果会污染重跑输出）。
 *
 * 单 run 失败（try/catch + log 带 runId/reason）不中断其余 run——终止是批量收尾，
 * 一个 run 落盘失败不应放走其余 run 的 failed 状态。
 *
 * @param deps LifecycleDeps（runs/store/eventBus/log）
 * @param reason 终止原因（写入 run.state.error，如 "Session switched: run terminated"）
 */
export async function terminateRunningRuns(
  deps: LifecycleDeps,
  reason: string,
): Promise<void> {
  for (const run of deps.runs.values()) {
    if (run.state.status !== "running") continue;
    try {
      deps.log?.("debug", "workflow:lifecycle", "terminateRunningRuns", { runId: run.runId, reason });
      run.state.error = reason;
      // [OR-3] 同 abortRun：先广播 abort 再 transition（worker 侧 pending 优雅解阻）
      broadcastAbortToWorker(run, reason);
      // [OR-7] run 终态：移除 signal abort listener（terminateRunningRuns 不走
      // onRunDone——本路径显式收口，不依赖 finalizeRun 的 notifyDone 分支）
      disposeSignalAbortListener(run);
      // A4 + C-4: transition 内部 releaseRuntime（cleanup before mutate）；done 终态 →
      // 注销 pending-notification（D5-② 终态 coda 收敛为 finalizeRun 单写点）。
      // notifyDone: false——**不调 deps.onRunDone**（真差异经参数承载）：对齐
      // session_start 恢复先例（index.ts kill-9 恢复只发 unregister、不发
      // onRunDone）——session 切换/关闭语境下主 agent 已离开本 session，注入完成
      // 通知只会把消息发给已离开的 session。OR-8 in-flight 收口由 finalizeRun 承载。
      await finalizeRun(run, deps, "failed", {
        context: "terminateRunningRuns",
        notifyDone: false,
      });
      deps.log?.("debug", "workflow:lifecycle", "run terminated", { runId: run.runId, reason: run.state.reason });
    } catch (err) {
      const msg = toErrorMessage(err);
      logger.error(
        `[workflow] terminateRunningRuns failed for run ${run.runId}: ${msg} (reason: ${reason})`,
      );
    }
  }
}

// ── evictDoneRunsBeyondCap（done run 内存淘汰，原地裁剪函数） ────────

/**
 * 淘汰 runs Map 中超出保留窗口的 done run，返回本次淘汰数量。
 *
 * 规则（契约 W3C1）：
 * 1. **状态白名单**：仅 `state.status === "done"` 可淘汰（RunStatus 封闭两态，
 *    显式白名单而非「非 running」——未来新增状态不落淘汰端）。running
 *    （活跃执行，isScriptRunning 遍历依赖）永不淘汰，即使 completedAt 缺失也
 *    绝不参与排序淘汰。
 * 2. **排序**：done 项按 `meta.completedAt` ISO 字符串字典序升序（toISOString 恒
 *    UTC 毫秒格式，字典序=时间序）。completedAt 缺失（防御旧格式/异常快照）fallback
 *    排序键为空串——字典序最小=最旧，先被淘汰。
 * 3. **tie 稳定排序**：比较器三态返回（相等返回 0），Array#sort 稳定性（Node≥12）
 *    保持元素原序——原序 = Map 插入序 = 创建序，tie 组内先创建者视为更旧先被淘汰
 *    （kill-9 批量恢复同 ms completedAt 场景的确定性保证）。
 * 4. **淘汰执行**：超限数 excess = doneCount - keepDone（<=0 时 no-op 返回 0），
 *    对升序前 excess 项逐个 `runs.delete(runId)`。
 * 5. **边界不变式**：禁止按 Map 插入序直接淘汰——嵌套 workflow 父 run 创建最早、
 *    完成最晚，插入序淘汰会在其自身 onRunDone 同步裁剪中淘汰它，runAndWait 轮询
 *    窗口内 get 不到 → 误返 "Run not found"。
 * 6. **副作用边界**：只清内存 runs Map，不动磁盘 state 文件、不删
 *    workflow-state-link 指针条目、不发任何事件。
 *
 * @param runs per-session 的 run 注册表（原地裁剪）
 * @param keepDone done run 保留数（生产传 MAX_RETAINED_DONE_RUNS）
 * @returns 本次淘汰的 run 数量
 */
export function evictDoneRunsBeyondCap(
  runs: Map<string, WorkflowRun>,
  keepDone: number,
): number {
  // 显式白名单：仅 done 参与淘汰（running 误删即功能破坏）
  const done = Array.from(runs.values()).filter((r) => r.state.status === "done");
  const excess = done.length - keepDone;
  if (excess <= 0) return 0;
  // ISO 字典序=时间序；缺失 fallback 空串（ISO 串恒以 '2' 开头非空，空串严格最小=最旧）
  const keyOf = (r: WorkflowRun): string => r.meta.completedAt ?? "";
  // 三态比较器 + sort 稳定性：tie 保持 Array.from 的 Map 插入序（=创建序）——
  // 先插入者更旧先淘汰，禁止按插入序直接 slice 淘汰（边界不变式 5）
  done.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  for (const r of done.slice(0, excess)) {
    runs.delete(r.runId);
  }
  return excess;
}

// ── recoverCrashedRuns（kill-9/崩溃恢复四步装配，D8/B1） ────────────────

/**
 * 崩溃恢复循环的宿主事件外置 hooks（core 平台中立，宿主注入专属行为）。
 *
 * pi 宿主在 onRunRecovered 中发射 `pending:unregister` 事件（pending-notifications
 * 扩展的注销信号灯）；zsw/第三宿主可接自己的通知通道。不注入 = 无宿主事件，
 * 恢复语义（failed 转换 + 落盘 + 淘汰）不受影响。
 */
export interface RecoverCrashedRunsHooks {
  /**
   * 每个 running → done,failed 转换的 run 恰好调用一次。
   *
   * payload 形状对齐 pi `pending:unregister` 事件：`{ id: runId, reason: "failed" }`
   * ——宿主可直接把 payload 转发到自己的事件总线。
   *
   * 错误围栏：回调同步 throw 经 core logger facade warn 留痕后被吞掉，恢复循环
   * 继续其余 run（转换/落盘不受影响）——与 save 步骤「单 run 失败不中断其余」
   * 容错口径对称。
   */
  onRunRecovered?: (payload: { id: string; reason: string }) => void;
}

/**
 * recoverCrashedRuns 的计数结果（宿主启动日志/健康面用）。
 *
 * `recovered` 只计 running 遗留被转换为 done,failed 的条数；`loaded` 是 loadAll
 * 重水合的全量数（含 done 历史快照）——两者分开口径，避免宿主把「重水合 N 条」
 * 误报为「恢复 N 条」。
 */
export interface RecoverCrashedRunsResult {
  /** loadAll 重水合的 run 总数（含 done 历史快照）。 */
  loaded: number;
  /** running 遗留被转换为 done,failed 的条数（0 = 无崩溃遗留）。 */
  recovered: number;
}

/**
 * 崩溃恢复四步装配（设计 D8/B1）：loadAll → failed → save → evict。
 *
 * 平移自 pi 壳 session_start 恢复循环（subagent-workflow index.ts:578-627）与
 * zsw orchestration-host recoverOrphans（逐行同构，pending:unregister 为唯一
 * 宿主差异点——经 {@link RecoverCrashedRunsHooks} 外置）。
 *
 * 步骤语义：
 * 1. **loadAll**：从 store 全量重水合。失败向上抛——fail-fast 策略（pi 的
 *    storeHealthy=false 停初始化）是宿主职责，调用方 catch 后自行决定；
 * 2. **failed**：残留 running run（进程被杀，worker 必死）逐个
 *    `state.error = reason` → `transition("done","failed")`（A4：transition 内部
 *    先 releaseRuntime），并发宿主事件（hooks）；done run 原样保留；
 * 3. **save**：转换后的 run 落盘（恢复终态必须持久化，不 save 则下次启动重水合
 *    仍见 running，侧栏永久卡 running）。单 run save 失败仅记日志不中断其余
 *    run——恢复天然幂等，下次启动重开重试；
 * 4. **evict**：全量重水合后立即 `evictDoneRunsBeyondCap(runs,
 *    MAX_RETAINED_DONE_RUNS)`（K=20）——done run 内存有界性；只 delete 内存
 *    Map 条目，磁盘 state 文件不动（对齐 pi，历史审计保留）。
 *
 * 所有 loaded run（含 done）都注册进 runs Map（runId → WorkflowRun）——与 pi
 * 一致，done run 也入 Map 供列表/查询消费。
 *
 * @param store RunStore port（loadAll/save）
 * @param runs per-session 的 run 注册表（原地写入 + 淘汰）
 * @param reason 恢复原因（写入 running run 的 state.error，如
 *   "Process killed (kill-9 or crash recovery)"）
 * @param hooks 宿主事件外置（可选）
 * @returns 计数 `{ loaded, recovered }`——recovered 只计 running→failed 转换条数
 * @throws store.loadAll 失败时原样抛出（步骤 1）
 */
export async function recoverCrashedRuns(
  store: RunStore,
  runs: Map<string, WorkflowRun>,
  reason: string,
  hooks?: RecoverCrashedRunsHooks,
): Promise<RecoverCrashedRunsResult> {
  // 步骤 1：loadAll（失败上抛，宿主决定 fail-fast 策略）
  const loaded = await store.loadAll();
  let recovered = 0;

  for (const run of loaded) {
    if (run.state.status === "running") {
      // 步骤 2：running → done,failed（顺序对齐 pi：set error → transition → 宿主事件）
      run.state.error = reason;
      run.transition("done", "failed");
      // [OR-8] 重水合 running 快照可携带 in-flight call（崩溃瞬间的 running 节点）——
      // 终态收口为 cancelled，先收口再落盘
      closeOutInFlightCalls(run);
      recovered += 1;
      // 宿主事件外置点：pi 发 pending:unregister，位置在 transition 后、save 前
      // （对齐 pi emit 位置——先解除挂起通知再落盘，事件观察者不依赖落盘完成）。
      // 错误围栏：宿主回调同步 throw 只 warn 不中断循环——与步骤 3 save 的
      // 「单 run 失败不中断其余」容错口径对称（通知通道故障不等价于恢复失败；
      // 恢复天然幂等，未送达的通知随下次启动重试，见步骤 3 注释）。
      try {
        hooks?.onRunRecovered?.({ id: run.runId, reason: "failed" });
      } catch (err) {
        const msg = toErrorMessage(err);
        logger.warn(
          `[workflow] recoverCrashedRuns onRunRecovered hook failed for run ${run.runId} (recovery continues): ${msg}`,
        );
      }
      // 步骤 3：恢复终态落盘（单 run 失败不中断其余 run——幂等恢复，下次重试）
      try {
        await store.save(run);
      } catch (err) {
        const msg = toErrorMessage(err);
        logger.error(
          `[workflow] recoverCrashedRuns store.save failed for run ${run.runId}: ${msg} (reason: ${reason})`,
        );
      }
    }
    runs.set(run.runId, run);
  }

  // 步骤 4：done run 内存有界性（K=20）。kill-9 恢复转换出的 failed run
  // completedAt 为 transition 时刻（全局最新）必在保留端；多条恢复 run 同 ms
  // completedAt → tie 稳定排序（evictDoneRunsBeyondCap 契约）。
  const evicted = evictDoneRunsBeyondCap(runs, MAX_RETAINED_DONE_RUNS);
  if (evicted > 0) {
    logger.debug(
      `[workflow] recoverCrashedRuns evicted ${evicted} done runs beyond cap (keep=${MAX_RETAINED_DONE_RUNS})`,
    );
  }
  return { loaded: loaded.length, recovered };
}
