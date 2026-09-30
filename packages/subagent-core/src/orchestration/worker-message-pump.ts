/**
 * Workflow Extension — worker-message-pump（原 error-recovery，D5-① 更名）
 *
 * Worker 消息泵 + 失败恢复 free functions（D-12）。[D15]（workflow-run-resume-revision）
 * 后本文件薄化为「消息路由 + 重试矩阵」两职责：
 * 1. 消息路由：handleWorkerMessage 分发 agent-call / return / error / log / phase
 * 2. IPC 序列化防御：postMessage 的 DataCloneError 拦截 + fallback 回发（W2）
 * 3. retry/重建：worker/script 错误的指数退避重试 + rebuildRuntime（G3-001）
 *
 * 原 run 事件投递域（dispatchRunTrigger 单写者链 + 事件派发包装）与终态化域
 * （finalizeRun 五步 coda）已迁入 terminal-actions.ts（[D15] 终局编排单一入口，
 * 五路收敛——pump → terminal-actions 单向依赖，终态路径经彼处 coda 收敛）。
 *
 * 重试矩阵：
 * - worker error/exit（非零）→ 3 次重试 + 指数退避 1s/2s/4s；超限 failed
 * - script error → 3 次重试 + 指数退避；超限 failed
 * - 重试前 rebuildRuntime（G3-001：整个 RunRuntime 重建：worker+controller）
 * - [OR-2] 重建动作本身失败（workerHost.start 抛错）回灌本矩阵：计入
 *   workerErrorCount，未超限再走退避+重建，超限收敛 done,failed（见
 *   scheduleRebuild / handleRebuildStartFailure）——恢复机制不得在它自己的
 *   恢复路径上开口
 *
 * 关键不变式：
 * - 重试前必须 rebuildRuntime（worker+controller 整体重建，避免孤儿资源）。
 * - 重试计数载体是 run.meta.workerErrorCount/scriptErrorCount（跨 runtime 存活，
 * retry replaceRuntime 后计数不丢）。
 * - handleWorkerExit 检查 handle.isCurrent（G-025：stale exit 事件丢弃）。
 *
 * 层归属：Engine。依赖 ports + WorkflowRun + executeAgentCall + terminal-actions。
 */

import { getLogger } from "../core/logger.ts";

import { canonicalJsonHash } from "./canonical-json.ts";

import { resolveAgentOpts } from "./agent-opts-resolver.ts";
import { executeAgentCall } from "./execute-agent-call.ts";
import { AgentCall } from "./models/agent-call.ts";
import type { AgentRunner, LifecycleDeps, WorkerHandlers } from "./models/ports.ts";
// [D15] 投递域与终态编排自 terminal-actions 消费（单向依赖——pump 不再承载
// journal 单写者链与 finalizeRun，消息面终态路径全部经彼处 coda）。
import {
  dispatchAgentRetrying,
  dispatchAgentSettled,
  dispatchAgentSettledFailed,
  dispatchAgentStarted,
  dispatchPhaseSettled,
  dispatchPhaseStarted,
  isRunSettled,
  memberReusePoolIo,
  notePhaseDispatched,
  settlePhaseLedger,
} from "./terminal-actions.ts";
import { finalizeRun } from "./terminal-actions.ts";
import { RunRuntime } from "./models/run-runtime.ts";
import type { WorkerLogEntry } from "./models/types.ts";
import type {
  AgentCallOpts,
  AgentResult,
} from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";
import type { WorkerHandle } from "./worker-handle.ts";
import { toErrorMessage } from "../core/error-message.ts";

const logger = getLogger("subagents");

import {
  EXPONENTIAL_BACKOFF_BASE,
  MALFORMED_MSG_LOG_PREVIEW_CHARS,
  MAX_ERROR_LOGS,
  MAX_WORKER_RETRIES,
  REBUILD_FAILURE_INJECT_ENV,
  RETRY_BACKOFF_BASE_ENV,
  RETRY_BACKOFF_BASE_MS,
  WORKER_EXITED_WITHOUT_RESULT_MSG,
} from "./worker-message-pump-constants.ts";

// ── Worker 消息类型（与 worker-script-builder.ts WorkerInMsg 对齐） ──

interface AgentCallMsg {
  type: "agent-call";
  callId: number;
  opts: {
    prompt: string;
    schema?: unknown;
    model?: string;
    scene?: string;
    description?: string;
    agent?: string;
    skill?: string;
    timeoutMs?: number;
    cwd?: string; // ADR-029 决策 1：per-call cwd（worktree 隔离）
  };
  phase?: string;
}

interface ReturnMsg {
  type: "return";
  result: unknown;
  workerLogs?: WorkerLogEntry[];
}

interface ErrorMsg {
  type: "error";
  error: string;
  workerLogs?: WorkerLogEntry[];
}

/** 脚本 log() 全局发出的独立诊断消息（协议见 worker-script-builder 头注释，OR-6）。 */
interface LogMsg {
  type: "log";
  phase?: string;
  message: string;
}

/** [D3] 脚本 phase() 切换消息（模板事件化——壳侧承接经 dispatchPhaseStarted 落 record）。 */
interface PhaseMsg {
  type: "phase";
  phase: string;
}

type WorkerMsg = AgentCallMsg | ReturnMsg | ErrorMsg | LogMsg | PhaseMsg;

// ── 内部 helper ──────────────────────────────────────────────

/**
 * 计算第 n 次重试前的退避时间（ms）：1s, 2s, 4s 指数（基数可经测试通道
 * RETRY_BACKOFF_BASE_ENV 覆盖，生产默认不变）。
 */
function backoffDelay(retryIndex: number): number {
  return resolveRetryBackoffBaseMs() * Math.pow(EXPONENTIAL_BACKOFF_BASE, retryIndex - 1);
}

/**
 * 孤儿 call 判定：dispatch 时捕获的 call 实例是否已不是 calls Map 中该 callId
 * 的当前条目。
 *
 * 为何需要实例级比对（而非只查 run 状态）：rebuildRuntime 不改 status（全程
 * running），既有的终态 stale 守卫拦不住旧 runtime 代际的迟到 completion。只有
 * discardInFlightCalls（delete 条目）与新一代 dispatch（set 新实例）会改变
 * 「callId → 实例」映射，故实例不等 ⟺ 本 completion 属于被丢弃/被替换的旧代际
 * （S7-second 竞态：旧失败结果经 postAgentResult 投给新 worker 的同 callId
 * pending，劫持重跑调用为假失败/空串假成功）。
 *
 * 运行期 calls Map 写点仅 discard 的 delete 与 dispatchAgentCall 的 set 两族
 * （jsonl-run-store 的 set 在离线重水合路径，无在飞 promise），正常（非孤儿）
 * 路径下实例恒等，无误判。
 */
function isOrphanedCall(run: WorkflowRun, callId: number, call: AgentCall): boolean {
  return run.state.calls.get(callId) !== call;
}

// ── [D3] phase 收束判定（phase-settled 的壳侧裁决面）─────────────
// 账本状态与记账原语（notePhaseDispatched / settlePhaseLedger / forgetPhaseSettlement
// / resetPhaseSettlementTrackerForTest）在 terminal-actions 投递域宿主侧——本侧
// 只保留消息路由消费（派发记账 + 收束判定落帧），见下方消费点。

// ── rebuildRuntime（G3-001 整重建） ─────────────────────────

/** [P-SD] rebuildRuntime 进程级调用计数（注入阈值「第 N 次」的判定基准）。 */
let rebuildRuntimeInvocationCount = 0;
/** [P-SD] 钩子激活/非法值 warn 是否已发（多轮 rebuild 只留痕一次，防刷屏）。 */
let rebuildFailureHookWarned = false;

/**
 * [P-SD/S-D] 读取重建失败注入阈值：env TAIJI_SUBAGENT_TEST_INJECT_REBUILD_FAILURE=<N>
 * 使 rebuildRuntime 第 N 次及以后的每次调用抛错（配合脚本内 process.exit 制造
 * 「worker 崩溃后重建失败」的 S-D 验收场景）。
 *
 * 安全约束（设计 §7.3 P-SD，对齐 T7① 可见性原则）：
 * - 仅显式设置时激活；未设置/空串 = 钩子完全不激活（零行为差）；
 * - 首次读取到该 env（无论合法非法）即 logger.warn 留痕一次，杜绝静默生效；
 * - 非法值（非正整数）不激活且 warn 指明原值，杜绝「以为注入了、实际没有」的
 *   静默失效（LC-7 同族教训）。
 *
 * 语义取「第 N 次及以后每次」而非「仅第 N 次」：S-D 验收要求 run 收敛 done,failed——
 * 仅注入一次会在重试预算（MAX_WORKER_RETRIES）耗尽前放行后续重建，run 可能正常完成，
 * 验收不可证伪。连续注入让重试矩阵确定性走完：耗尽后经 handleRebuildStartFailure
 * 收敛 done,failed。
 *
 * @returns 注入阈值（调用序数 >= 阈值的 rebuild 抛错）；undefined = 未激活
 */
function resolveRebuildFailureInjectionThreshold(): number | undefined {
  const raw = process.env[REBUILD_FAILURE_INJECT_ENV];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    if (!rebuildFailureHookWarned) {
      rebuildFailureHookWarned = true;
      logger.warn(
        `[workflow] ${REBUILD_FAILURE_INJECT_ENV}="${raw}" is not a positive integer — ` +
          "test hook INACTIVE, no rebuild failure will be injected",
      );
    }
    return undefined;
  }
  if (!rebuildFailureHookWarned) {
    rebuildFailureHookWarned = true;
    logger.warn(
      `[workflow] ${REBUILD_FAILURE_INJECT_ENV}=${raw} ACTIVE — rebuildRuntime invocations ` +
        `#${parsed} and later will throw (S-D test hook; NEVER set in production)`,
    );
  }
  return parsed;
}

/** 测试辅助：重置注入计数与 warn 状态（仅 __tests__ 导入，生产勿用）。 */
export function resetRebuildFailureInjectionForTest(): void {
  rebuildRuntimeInvocationCount = 0;
  rebuildFailureHookWarned = false;
}

/** [测试通道] 退避基数覆盖 warn 是否已发（对齐 rebuildFailureHookWarned 的防刷屏）。 */
let retryBackoffHookWarned = false;

/**
 * [测试通道] 读取退避基数：env 未设/空串 = 生产默认 RETRY_BACKOFF_BASE_MS（零行为
 * 差）；正整数 = 覆盖。非法值不激活且 warn 指明原值（杜绝「以为注入了、实际没有」，
 * 对齐 resolveRebuildFailureInjectionThreshold 的安全约束）。
 */
function resolveRetryBackoffBaseMs(): number {
  const raw = process.env[RETRY_BACKOFF_BASE_ENV];
  if (raw === undefined || raw === "") return RETRY_BACKOFF_BASE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    if (!retryBackoffHookWarned) {
      retryBackoffHookWarned = true;
      logger.warn(
        `[workflow] ${RETRY_BACKOFF_BASE_ENV}="${raw}" is not a positive integer — ` +
          "test hook INACTIVE, production backoff base retained",
      );
    }
    return RETRY_BACKOFF_BASE_MS;
  }
  if (!retryBackoffHookWarned) {
    retryBackoffHookWarned = true;
    logger.warn(
      `[workflow] ${RETRY_BACKOFF_BASE_ENV}=${raw} ACTIVE — retry backoff base ` +
        `overridden to ${parsed}ms (test hook; NEVER set in production)`,
    );
  }
  return parsed;
}

/**
 * 移除 run 中未真正完成的在飞 call（status !== "done"）及其 trace 节点。
 *
 * 仅 rebuildRuntime 调用——清理被旧 runtime abort 的在飞 call，避免重跑时
 * cached replay 把 abort 产生的 failed 结果当作已完成结果回放（原 MUST_FIX
 * round-4 #1，自 pause 路径移入崩溃重建路径）。genuinely-done 的 call（成功或
 * 失败均 "done"）保留，重跑时按原语义 replay（不重复耗 token）。
 *
 * 返回被丢弃的 callId 数组（升序——Map 迭代按插入序，排序保证返回值与
 * rebuildRuntime 的 L3 日志 payload 形态稳定），供调用方记日志。
 */
function discardInFlightCalls(run: WorkflowRun): number[] {
  const inFlight: number[] = [];
  for (const [callId, call] of run.state.calls) {
    if (call.status !== "done") inFlight.push(callId);
  }
  for (const callId of inFlight) {
    run.state.calls.delete(callId);
    run.state.trace.removeByStepIndex(callId);
  }
  return inFlight.sort((a, b) => a - b);
}

// ── [U2] canonical JSON 工具（场景 13：schema 哈希稳定）─────────

// 实装与设计说明已抽至 ./canonical-json.ts（第二消费方 terminal-actions 的
// agent-started 入参落账出现后，工具留在本文件会形成 pump ↔ terminal-actions
// 反向 import 成环）。此处 re-export 维持既有 import 路径（测试与下游消费方
// 不变），语义与落位理由见该模块头注。
export { canonicalJsonStringify, canonicalJsonHash } from "./canonical-json.ts";

// ── [D10] resume 时间预算账本（活跃段算式的执行期消费面）────────

/**
 * [D10] resume 复活 run 的预算账本（runId → 累计活跃段已耗 + 本段复活时刻）。
 *
 * 剩余预算折算 = budget −（累计已耗 +（now − 复活时刻））——搁置天数不计入
 * （跨天 resume 不秒死，场景 16），重试路径同算式（场景 21：startedAt 墙钟会在
 * 跨天形态误判耗尽）。record 流是权威源（再次 resume 按 run-resumed/run-interrupted
 * 事件重算覆盖——resume-run.computeActiveElapsedMs），本账本是执行期消费缓存；
 * 驻留有界性：每 runId 至多一条，随 evictDoneRunsBeyondCap 淘汰回收
 * （forgetRunResumedBudget），进程退出全清（ADR-0081 同款论证）。
 */
const resumedBudgetLedger = new Map<string, { activeElapsedMs: number; resumedAtMs: number }>();

/** [D10] resume 编排（resume-run.ts）复活成功时写入账本。 */
export function noteRunResumedBudget(runId: string, activeElapsedMs: number, resumedAtMs: number): void {
  resumedBudgetLedger.set(runId, { activeElapsedMs, resumedAtMs });
}

/** [D10] 终局/内存淘汰回收（evictDoneRunsBeyondCap 淘汰点调用）。 */
export function forgetRunResumedBudget(runId: string): void {
  resumedBudgetLedger.delete(runId);
}

/**
 * 计算 run 的剩余时间预算（ms）[race-F3 → D10 活跃段算式]。
 *
 * 账本消费现状（已登记缺陷，docs/todo/subagent-workflow-issues.md §1.1）：当前
 * resume 重建 spec（resume-run.ts rebuildRunFromRecord）不含 budgetTimeMs，本函数
 * 首行的预算缺失提前返回发生在查 [D10] resume 账本之前——账本消费在该形态下
 * 不可达（若可达，按 activeElapsedMs + 复活后墙钟折算，搁置时间不计）。无账目
 * 回落 startedAt 墙钟现状算法（非 resume 来源 run——重试不重置预算的既有语义
 * 保持）。未配置预算（budgetTimeMs 未设或 <=0，默认不限）返回 undefined。
 */
function remainingTimeBudgetMs(run: WorkflowRun): number | undefined {
  const budget = run.spec.budgetTimeMs;
  if (!budget || budget <= 0) return undefined;
  const resumed = resumedBudgetLedger.get(run.runId);
  if (resumed !== undefined) {
    const elapsed = resumed.activeElapsedMs + Math.max(0, Date.now() - resumed.resumedAtMs);
    return Math.max(0, budget - elapsed);
  }
  const startedMs = Date.parse(run.meta.startedAt);
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
  return Math.max(0, budget - elapsed);
}

/**
 * 重试前发现时间预算已耗尽的收尾：不 rebuild，直接 done,time_limited 终态。
 *
 * 副作用与 handleWorkerError 超限路径对齐：transition + 持久化 + 注销
 * pending-notification + onRunDone（[D15] 收敛为 terminal-actions.finalizeRun 单写点）。
 */
async function finalizeTimeBudgetExhausted(run: WorkflowRun, deps: LifecycleDeps): Promise<void> {
  deps.log?.("debug", "workflow:worker-message-pump", "time budget exhausted on rebuild, transition done", {
    runId: run.runId,
    budgetTimeMs: run.spec.budgetTimeMs,
  });
  run.state.error = run.state.error ?? `Time budget exhausted (${run.spec.budgetTimeMs} ms wall clock) before retry rebuild`;
  await finalizeRun(run, deps, "time_limited", { context: "time budget exhausted on rebuild" });
}

/**
 * 重建整个 RunRuntime：新 controller + 新 worker。
 *
 * 调 run.replaceRuntime(newRt)（G5-001）：原子释放旧 runtime（worker.terminate +
 * abort）+ 绑定新 runtime，全程 status==="running" 不变（不变式 I1 不违反）。
 *
 * handlers 由调用方（lifecycle makeHandlers）构造——它们路由 onMessage/onError/
 * onExit 回本文件的 handle* 函数。handlers 捕获 run + deps 闭包，runtime 重建后
 * 仍有效（run 实例不变，deps 不变）。
 *
 * 前置：run.state.status === "running"（replaceRuntime 要求，G6-001）。
 *
 * [race-F3] 时间预算重排按剩余墙钟折算（remainingTimeBudgetMs），不再用满额——
 * 否则每次错误重试都重置预算，最坏 6 次重试放大 ~6×。耗尽时的终态转移不在本函数
 * （唯一生产调用方 scheduleRebuild 已前置拦截，见其注释）。
 *
 * @throws status !== "running"（由 replaceRuntime 抛）
 */
export function rebuildRuntime(
  run: WorkflowRun,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): void {
  // [P-SD] 测试钩子注入点：先于任何副作用（模拟 workerHost.start 抛错）。抛错由
  // scheduleRebuild 的 catch 接住回灌重试矩阵（[OR-2]），不再裸抛。
  rebuildRuntimeInvocationCount += 1;
  const injectThreshold = resolveRebuildFailureInjectionThreshold();
  if (injectThreshold !== undefined && rebuildRuntimeInvocationCount >= injectThreshold) {
    throw new Error(
      `[S-D test hook] injected rebuildRuntime failure ` +
        `(invocation #${rebuildRuntimeInvocationCount}, ${REBUILD_FAILURE_INJECT_ENV}>=${injectThreshold})`,
    );
  }
  // OB3（可观察性）：rebuild 关键节点 debug 日志——此前函数体 0 处 deps.log，
  // 崩溃自愈只能靠行为证据诊断（L1 入口 / L2 重排 / L3 discard / L4 完成）。
  deps.log?.("debug", "workflow:worker-message-pump", "runtime rebuild start", {
    runId: run.runId,
    budgetTimeMs: run.spec.budgetTimeMs,
  });
  const controller = new AbortController();
  const worker = deps.workerHost.start(run.spec, run.spec.args, handlers);
  // D-12 regression fix (round-2 #2)：重新调度 run 级墙钟预算计时器。
  // replaceRuntime 释放旧 runtime 时 clearTimeout 了旧计时器（run-runtime.release），
  // 新 runtime 必须重排，否则带 budgetTimeMs 的 run 命中一次 worker/script 错误重试后
  // 时间预算静默失效（直到 rebuildRuntime 才重排——本函数即唯一重排点）。
  // [race-F3] 重排值改为剩余墙钟（remainingTimeBudgetMs）而非满额——重试不重置预算；
  // remaining <= 0 时不挂 timer（防御直调，宁可不挂也不能挂出 0ms 立即触发）。
  let timeBudgetTimer: ReturnType<typeof setTimeout> | undefined;
  const remainingBudgetMs = remainingTimeBudgetMs(run);
  if (remainingBudgetMs !== undefined && remainingBudgetMs > 0 && deps.scheduleTimeBudget) {
    timeBudgetTimer = deps.scheduleTimeBudget(run.runId, remainingBudgetMs);
    deps.log?.("debug", "workflow:worker-message-pump", "time budget rescheduled", {
      runId: run.runId,
      budgetTimeMs: remainingBudgetMs,
    });
  }
  run.replaceRuntime(new RunRuntime(worker, controller, timeBudgetTimer));
  // 清除被旧 runtime abort 的在飞 call——必须在 replaceRuntime 之后同步执行（无
  // await 间隔）：replaceRuntime 同步 abort 旧 controller + terminate 旧 worker，
  // 在飞 executeAgentCall 的 finalize 发生在 `await runner.run` resolve 后的
  // microtask，此刻在飞 call 仍为 "running"/"pending"（status !== "done"）可精确
  // 清理；genuinely-done 的 call 保留（重跑 replay）。放 delay 退避之前会误删退避
  // 期间自然完成的真结果（重跑重复耗 token）；放任何 await 之后，假失败已 finalize
  // 为 "done" 挡不住——重跑 replay 会把 abort 错误当真结果回放，静默污染输出。
  // 旧代际迟到的 postAgentResult 投递由 dispatchAgentCall 的孤儿守卫（isOrphanedCall）
  // 拦截，trace.update 的瞬时污染由 executeAgentCall 的 isOrphaned 谓词（OB2）拦截。
  const discardedCallIds = discardInFlightCalls(run);
  deps.log?.("debug", "workflow:worker-message-pump", "in-flight calls discarded", {
    runId: run.runId,
    callIds: discardedCallIds,
    count: discardedCallIds.length,
  });
  deps.log?.("debug", "workflow:worker-message-pump", "runtime rebuild complete", {
    runId: run.runId,
  });
}

// ── handleWorkerMessage（消息路由） ──────────────────────────

/**
 * 路由 worker → main 的业务消息。
 *
 * agent-call → 派发 executeAgentCall（异步，不 await——立即返回让 worker 继续发消息）
 * return → finalizeRun done,completed（脚本正常返回；[D15] 经 terminal-actions coda）
 * error → handleScriptError（脚本主动抛错）
 * log → 计入 run.state.errorLogs + debug 留痕（[OR-6/T7④]）
 * phase → [D3] dispatchPhaseStarted 落 record（phase 状态机转移事件）
 * default → warn 留痕后丢弃（[OR-6/T7④] 协议漂移防线）
 *
 * 终态（done）下的 stale 消息丢弃（P0-1）。
 */
/** [handleWorkerMessage 拆分] 终态 stale 消息留痕丢弃（P0-1；type 自 raw 安全提取）。 */
function dropStaleWorkerMessage(run: WorkflowRun, raw: unknown): void {
  const type = typeof raw === "object" && raw !== null
    ? (raw as { type?: unknown }).type
    : null;
  logger.debug(
    `[workflow] stale worker message dropped on terminal run (runId=${run.runId}, type=${JSON.stringify(type)})`,
  );
}

/** [handleWorkerMessage 拆分] [F1] 标记本 runtime 代际已收到终态消息：WorkerHandle.isCurrent
 * 守卫保证消息必来自当前代际 worker。handleWorkerExit 的 exit(0) 无终态判定据此区分——
 * 「已交付但 run 仍 running」（script-error 重试退避窗口）不得误判 failed。 */
function markTerminalMessageDelivered(run: WorkflowRun): void {
  if (run.runtime) run.runtime.receivedTerminalMessage = true;
}

/** [handleWorkerMessage 拆分] [OR-6/T7④] 协议漂移防线：未知消息类型 warn 留痕后丢弃。
 * 畸形消息（M7 形状校验之上、已知类型之外的 type）此前静默穿过 switch——协议注释
 * 新增消息类型而主线程未接线时，这里提供可观测信号（而非零痕迹丢弃）。 */
function logUnknownWorkerMessageType(run: WorkflowRun, msg: WorkerMsg, deps: LifecycleDeps): void {
  logger.warn(
    `[workflow] unknown worker message type dropped (runId=${run.runId}): ` +
      `${JSON.stringify((msg as { type?: unknown }).type)}`,
  );
  deps.log?.("warn", "workflow:worker-message-pump", "unknown worker message type", {
    runId: run.runId,
    type: (msg as { type?: unknown }).type,
  });
}

export async function handleWorkerMessage(
  run: WorkflowRun,
  raw: unknown,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
  // 终态（done）丢弃 stale 消息（P0-1）——[加固] debug 留痕（原静默 return）。
  if (isRunSettled(run)) {
    dropStaleWorkerMessage(run, raw);
    return;
  }

  // M7: 形状校验——防畸形 IPC 消息（worker 崩溃/发非对象）导致下游 TypeError
  if (typeof raw !== "object" || raw === null) return;
  const msg = raw as WorkerMsg;
  switch (msg.type) {
    case "agent-call":
      dispatchAgentCall(run, msg, deps);
      return;
    case "return":
      markTerminalMessageDelivered(run);
      await handleReturn(run, msg, deps);
      return;
    case "error":
      // M1: 传 handlers（rebuildRuntime 需要）
      markTerminalMessageDelivered(run);
      await handleScriptError(
        run,
        msg.error,
        msg.workerLogs ?? [],
        deps,
        handlers,
      );
      return;
    case "log":
      handleWorkerLog(run, msg, deps);
      return;
    case "phase":
      // [D3] phase() 切换消息：模板 postMessage 通道 → phase-started 转移事件落
      // record。postMessage 异步丢失窗口（worker 死于消息送达前）由 fold 自愈规则
      // 承接（agent-started 载荷的 phase 字段驱动 pending → running——转移事件缺失
      // 不判损坏）。
      if (typeof msg.phase === "string" && msg.phase !== "") {
        dispatchPhaseStarted(run, msg.phase);
      }
      return;
    default:
      logUnknownWorkerMessageType(run, msg, deps);
      return;
  }
}

/**
 * 消费 worker 的独立 log 消息（[OR-6/T7④] 主线程半边）。
 *
 * 计入 run.state.errorLogs（与 workerLogs 通路的 L9 追加/上限语义一致）+ deps.log
 * debug 留痕。终态守卫（isRunSettled）已由 handleWorkerMessage 前置——此处只管写入。
 */
function handleWorkerLog(run: WorkflowRun, msg: LogMsg, deps: LifecycleDeps): void {
  const message = typeof msg.message === "string" ? msg.message : String(msg.message);
  run.state.errorLogs.push({ level: "log", message });
  if (run.state.errorLogs.length > MAX_ERROR_LOGS) {
    run.state.errorLogs = run.state.errorLogs.slice(-MAX_ERROR_LOGS);
  }
  deps.log?.("debug", "workflow:worker-message-pump", "worker log", {
    runId: run.runId,
    phase: msg.phase,
    message,
  });
}

/**
 * 派发 agent 调用：构建 AgentCall + trace 节点，异步触发 executeAgentCall。
 *
 * 异步触发（不 await）——立即返回，让 worker 能继续发后续 agent-call（parallel 场景）。
 * executeAgentCall 内部完成 markDone + trace.update。
 *
 * **C-3 修复**：executeAgentCall 经 dispatchCall 异步触发——原 gate.withSlot 包装已随
 * 并发门闩 gate 抽象删除（no-op），并发调度归 SubagentService ConcurrencyPool。
 *
 * **C-2 修复**：call 完成后检查 `budget.isExceeded` → abortRun(budget_limited)，
 * 终止整个 run。
 *
 * **stale 完成守卫（两层）**：completion 到达时——
 * 1. isRunSettled recheck：run 终止（abort/terminate）后到达的 call 完成不写
 *    run.state.calls / 不 postAgentResult（终态快照不被迟到结果污染）；
 * 2. 孤儿 call 实例比对（isOrphanedCall）：rebuildRuntime 后旧代际 dispatch 的
 *    completion 不投递。
 */
/**
 * M4: agent-call 消息 IPC 字段校验谓词——畸形（opts 非对象/缺失、callId 非数字、
 * prompt 缺失）= true。提取为谓词保持 dispatchAgentCall 主流程可读（圈复杂度门禁）。
 */
function isMalformedAgentCallMsg(msg: AgentCallMsg): boolean {
  return typeof msg.callId !== "number" || !Number.isFinite(msg.callId) ||
    typeof msg.opts !== "object" || msg.opts === null ||
    typeof msg.opts.prompt !== "string";
}

/**
 * [U2 校验增强] cached replay 命中的输入一致性判定（机制文档 D3 的可比形态收窄）：
 * 历史 call.opts 与本次消息 opts 经同一 resolveAgentOpts 管道规范化后做 canonical
 * JSON 哈希比对（管道对称消除 skill→skillPath / schema→appendSystemPrompt 的转换
 * 差异，canonical 键序消除 IPC/重建往返的形态漂移——场景 13 零误报）。
 *
 * 跳过比对（返回 false）的三形态——比对即假 mismatch：
 * 1. 占位 opts（resume/重水合重建的 call 无可比数据面时：旧格式 record 流的
 *    agent-started 帧不携带入参全文（input 载荷为 [U13] 补齐，写侧随本设计
 *    落地）——新帧有 input 的重建走 opts 恢复，比对正常执行）；
 * 2. 失败历史（cached.result.error 在场——失败也是真实历史结果，重跑不保证更对
 *    且机制文档 D5 裁决「含失败的 done 保留回放」）；
 * 3. 本次 resolve 失败（skill 丢失等——错误结果回放路径，非漂移信号）。
 */
function detectReplayInputMismatch(cached: AgentCall, currentRaw: AgentCallMsg["opts"]): boolean {
  // opts 缺省容错（mock/残缺形态）：无可比数据面即跳过比对
  if (cached.opts === undefined || cached.opts === null) return false;
  const recorded = cached.opts as unknown as Record<string, unknown>;
  const recordedKeys = Object.keys(recorded).filter((k) => recorded[k] !== undefined);
  if (cached.opts.prompt === "" && recordedKeys.length <= 1) return false; // 占位形态
  if (cached.result?.error !== undefined) return false; // 失败历史照放
  const current = resolveAgentOpts({
    ...currentRaw,
    schema:
      typeof currentRaw.schema === "object" && currentRaw.schema !== null
        ? (currentRaw.schema as Record<string, unknown>)
        : undefined,
  });
  if (current.error) return false; // 本次 resolve 失败——错误结果回放路径
  return canonicalJsonHash(cached.opts) !== canonicalJsonHash(current.opts);
}

/** [dispatchAgentCall 拆分] M4 畸形 agent-call 消息拒绝（不写 trace / 不建 call）。
 * [加固] callId 合法（worker 侧有对应 pending）时回发可克隆 error result 让 worker
 * 内 agent() pending 收敛（原仅日志 return = pending 永挂）；callId 非法无法定向
 * 回发，仅日志。 */
function rejectMalformedAgentCall(run: WorkflowRun, msg: AgentCallMsg): void {
  logger.error(`[workflow] malformed agent-call message: callId=${JSON.stringify(msg.callId)}, opts=${JSON.stringify(msg.opts)?.slice(0, MALFORMED_MSG_LOG_PREVIEW_CHARS)}`);
  if (typeof msg.callId === "number" && Number.isFinite(msg.callId)) {
    const dropped = "malformed message dropped: agent-call IPC fields invalid (worker/main module mismatch suspected)";
    postAgentResult(run, msg.callId, { content: "", error: dropped }, false);
  }
}

/**
 * [dispatchAgentCall 拆分] 已缓存调用（done 终态）的 replay 半边。返回 true =
 * 已处理（replay 回话或 mismatch 终局），调用方直接 return；false = 无 done
 * 缓存，走正常派发。
 *
 * [U2 校验增强] 可比形态下做 canonical JSON 输入一致性比对（机制文档 D3）：
 * 历史入参与本次调用入参哈希不一致 = 脚本非确定性漂移（Date.now()/外部 IO 进了
 * prompt）——静默命中错误结果继续跑违背「错了明说」，转 failed 终局（诊断含
 * callId 与恢复指引）。不可比形态（占位 opts / 失败历史 / resolve 失败）跳过
 * 比对——详见 detectReplayInputMismatch 注释（场景 13 的「零误报」约束）。
 */
function tryReplayCachedCall(run: WorkflowRun, msg: AgentCallMsg, deps: LifecycleDeps): boolean {
  const cached = run.state.calls.get(msg.callId);
  if (!cached || cached.status !== "done") return false;
  if (detectReplayInputMismatch(cached, msg.opts)) {
    const mismatch = `Resume replay input mismatch at call #${msg.callId}: the script produced a ` +
      `different input than the recorded call (nondeterministic source detected, e.g. Date.now()/` +
      `Math.random()/external IO in prompt construction). Recovery: make the script deterministic ` +
      `up to the resume point, then start a new run — the replayed prefix cost zero tokens.`;
    logger.error(`[workflow] ${mismatch} (runId=${run.runId})`);
    run.state.error = run.state.error ?? mismatch;
    // 终局处置：[D2] 状态机无 running → interrupted 的人工回退转移（机制文档
    // 「run 保持 interrupted」写于 terminal[interrupted] 旧形态）——按可行性形态
    // 收敛 failed 终局（不回话错误结果——worker pending 由 finalizeRun 内
    // releaseRuntime 的 terminate 收敛）。
    void finalizeRun(run, deps, "failed", { context: "replay input mismatch (resume)" }).catch(
      (err: unknown) => {
        logger.error(`[workflow] replay mismatch finalize failed: ${toErrorMessage(err)}`);
      },
    );
    return true;
  }
  postAgentResult(run, msg.callId, cached.result!, true);
  return true;
}

function dispatchAgentCall(
  run: WorkflowRun,
  msg: AgentCallMsg,
  deps: LifecycleDeps,
): void {
  // M4: IPC 字段校验——畸形 agent-call 消息不写 trace / 不建 call（worker/main 模块
  // 不匹配疑号）。
  if (isMalformedAgentCallMsg(msg)) {
    rejectMalformedAgentCall(run, msg);
    return;
  }

  // 已缓存的调用直接 replay（跨 rebuild / 跨 resume——崩溃重建或 resume 重跑脚本后，
  // 已完成调用按 callId 命中缓存零 token 回话）。
  if (tryReplayCachedCall(run, msg, deps)) return;

  // 构建 trace 节点（[H2 W3] trace.live 退役——实时进度改由 views 经 store 订阅）。
  const agentName = msg.opts.description ?? msg.opts.agent ?? "unknown";
  const now = new Date().toISOString();
  // 未显式指定 model 的展示口径。
  const model = msg.opts.model ?? "default";
  const node = {
    stepIndex: msg.callId,
    agent: agentName,
    task: msg.opts.prompt,
    model,
    status: "running" as const,
    phase: msg.phase,
    startedAt: now,
  };
  run.state.trace.append(node);

  // [D3] phase 收束账本记账（phase-settled 判定的派发半边；无 phase 归属的 call
  // 不入账——phase-settled 只对显式 phase 落账，空值守卫在 notePhaseDispatched 内）。
  notePhaseDispatched(run.runId, msg.phase);

  // 构建 AgentCall（opts 形状对齐 AgentCallOpts；schema: unknown → Record）
  // 跨进程 IPC 边界的 schema 为 unknown，窄化前加 typeof guard 兜底。
  const rawSchema = msg.opts.schema;
  const opts: AgentCallOpts = {
    ...msg.opts,
    schema:
      typeof rawSchema === "object" && rawSchema !== null
        ? (rawSchema as Record<string, unknown>)
        : undefined,
  };

  // BL-1：解析 skill/schema → skillPath / appendSystemPrompt。
  // 解析失败（skill 未找到）走 error 路径，不发 slot、不 spawn。
  const resolved = resolveAgentOpts(opts);
  if (resolved.error) {
    const call = new AgentCall(msg.callId, opts, node);
    call.markRunning();
    const errorResult: AgentResult = { content: "", error: resolved.error };
    call.markDone(errorResult);
    run.state.calls.set(msg.callId, call);
    run.state.trace.update(msg.callId, {
      status: "failed",
      result: errorResult,
      completedAt: new Date().toISOString(),
    });
    // [P1b-1] agent-settled(failed) 落账（派发前置失败形态：attempt 恒 1）。result
    // 随帧携带（errorResult 同源——record 恢复读面拒绝缺 result 的 settled 帧）。
    dispatchAgentSettledFailed(run, msg.callId, errorResult);
    postAgentResult(run, msg.callId, errorResult, false);
    deps.store.save(run).catch((e: unknown) => {
      logger.error(`[workflow] store.save failed (resolveAgentOpts): ${toErrorMessage(e)}`);
    });
    return;
  }

  const call = new AgentCall(msg.callId, resolved.opts, node);
  run.state.calls.set(msg.callId, call);
  // [P1b-1] agent-started 落账（编排层事件源，D5 载荷表；taskIndex = callId 单源）。
  // phase 透传（[D3] call 归属快照）；memberRecordId 透传（[D6] 绑定字段化——
  // 续写帧携带既有成员 record id，首派缺省；绑定登记的真相面在 workflow-dispatch，
  // 此处从复用池活体缓存取值随帧落账，跨崩溃重建由 fold 消费本字段）；opts 落
  // 入参全文（设计 §3.1 载荷表 agent-started 行「入参」——canonical 序列化，
  // resume 重建回放集 call 的 opts 恢复源，detectReplayInputMismatch 比对由此可比）。
  const boundRecordId = lookupBoundRecordIdSync(run.runId, agentName);
  dispatchAgentStarted(run, msg.callId, agentName, msg.phase, boundRecordId, resolved.opts);

  // [GUI 步骤实时可见 2026-09-14] 启动即持久化（[D1] 后 save 为壳侧 no-op 契约，
  // 调用保留 = RunStore port 契约面）。火后模式与下方 .catch 同款。
  deps.store.save(run).catch((e: unknown) => {
    logger.error(`[workflow] store.save failed (dispatch trace stamp): ${toErrorMessage(e)}`);
  });

  // C-3：agent call 执行入口。executeAgentCall 管 retry/budget/stale-context；
  // runner（runner.run）管 spawn pi 子进程。
  const runtime = run.runtime!;
  const signal = runtime.controller.signal;
  // [H2 W3] 执行 port 切换（设计 §3.5 终态数据流）。未注入时（旧测试 deps）回退
  // deps.runner——生产装配恒注入 dispatch（extension index.ts makeDeps），回退分支
  // 生产不可达。
  const dispatch = deps.workflowAgentDispatch;
  // [W0 / D1] stepIndex = msg.callId（taskIndex 单源，与 agent-started 落账同源）。
  const innerRunner: AgentRunner = dispatch
    ? { run: (rOpts, rSignal) => dispatch(rOpts, run.runId, rSignal, msg.callId) }
    : deps.runner;
  // [P1b-1 agent-retrying 落账] 重试轨迹观测点（投递点裁决见 dispatchAgentRetrying
  // 注释）：包装 runner 记录最近一次失败 result；包装层的第 2..N 次调用 = 重试尝试
  // 开始。非重试终局路径构造性零假帧。
  let lastFailedResult: AgentResult | undefined;
  let lastFailedAt = 0;
  const runner: AgentRunner = {
    run: (rOpts, rSignal) => {
      if (lastFailedResult !== undefined) {
        dispatchAgentRetrying(
          run,
          msg.callId,
          call.attempts - 1,
          Date.now() - lastFailedAt,
          summarizeRetryReason(lastFailedResult),
        );
      }
      return innerRunner.run(rOpts, rSignal).then((result) => {
        if (result.error !== undefined) {
          lastFailedResult = result;
          lastFailedAt = Date.now();
        }
        return result;
      });
    },
  };
  // 原 gate.withSlot(fn, signal) 语义内联：pre-aborted 时 reject AbortError。
  const dispatchCall = async (): Promise<void> => {
    if (signal.aborted) {
      const abortErr = new Error("Operation aborted before start");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    // OB2（S7 残留）：isOrphaned 谓词注入——旧代际 finalize 在 trace.update 前被
    // 拦截。onEvent/stream 两实参显式 undefined 占位（[H2 W3] 位置参数不得前移）。
    await executeAgentCall(call, runner, run.state.budget, signal, run.state.trace, undefined, undefined, () => isOrphanedCall(run, msg.callId, call));
  };
  void dispatchCall()
    .then(() => {
      // run 终止（终态）后到达的 stale completion 不写 state。
      // [W2/V1] 终局判据换源 isRunSettled。
      if (isRunSettled(run)) return;
      // 孤儿 call 守卫（S7-second 竞态）：rebuild 的 discardInFlightCalls 已移除本
      // call、或重跑 dispatch 已用新实例替换同 callId 条目时，本 completion 属于旧
      // runtime 代际——跳过投递 / budget 同步 / 持久化，仅留日志。
      if (isOrphanedCall(run, msg.callId, call)) {
        deps.log?.("debug", "workflow:worker-message-pump", "orphan agent call completion dropped", { runId: run.runId, callId: msg.callId });
        return;
      }
      if (call.result) postAgentResult(run, msg.callId, call.result, false);
      // [P1b-1] agent-settled 落账（引擎终态应答，D5 载荷表；置于 budget 终局检查
      // 之前——record 序 = agent-settled 先、budget 的 run-settled 后）。signal abort
      // = agent 粒度 cancelled。落账后进行 [D3] phase 收束判定（账本 settled 计数
      // 追平 dispatched 即落 phase-settled——先于 run-settled 帧，phase 收束语义
      // 先于 run 终局）。
      dispatchAgentSettled(run, call, signal.aborted);
      settlePhaseIfComplete(run, msg.phase);
      // D-12 regression fix (round-2 #1)：executeAgentCall 内 consume/incrementCallCount
      // 后同步 worker $BUDGET（否则 $BUDGET.spent()/remaining() 恒为 0）
      postBudgetUpdate(run);
      deps.store.save(run).catch((e: unknown) => {
        const m = toErrorMessage(e);
        logger.error(`[workflow] store.save failed (agent call ${msg.callId}): ${m}`);
      });

      // C-2：budget 超限 → 终止整个 run（避免继续 spawn 烧预算）
      // 内联 terminate（不调 lifecycle.abortRun 避免 engine 内循环依赖）：
      // finalizeRun 内含终局让位守卫。
      if (run.state.budget.isExceeded()) {
        run.state.error = run.state.error ?? "Budget exceeded";
        deps.log?.("debug", "workflow:worker-message-pump", "budget exceeded, transition done", { runId: run.runId });
        void finalizeRun(run, deps, "budget_limited", { context: "agent call budget done" });
      }
    })
    .catch((err: unknown) => {
      // pre-abort 检查（原 gate.withSlot 语义）在 dispatchCall 入口 reject AbortError——预期，不记错。
      if (err instanceof Error && err.name === "AbortError") return;
      const message = toErrorMessage(err);
      logger.error(`[workflow] agent call ${msg.callId} failed: ${message}`);
      // 兜底回发：executeAgentCall 抛非 Abort 异常时构造 failed AgentResult
      // postAgentResult 回 worker，让 pending Promise resolve（结果为 error），脚本
      // 可继续或失败退出。孤儿 call 守卫（与 .then 对称）：rebuild 后本 call 已被
      // discard 移除/替换——全部跳过。
      if (isOrphanedCall(run, msg.callId, call)) {
        deps.log?.("debug", "workflow:worker-message-pump", "orphan agent call failure dropped", { runId: run.runId, callId: msg.callId });
        return;
      }
      const errorResult: AgentResult = { content: "", error: message };
      // call 已 done（executeAgentCall 内 finalizeCall 已 markDone）时跳过，避免重复 markDone。
      if (call.status !== "done") {
        if (call.status === "pending") call.markRunning();
        call.markDone(errorResult);
      }
      // state 一致性三件套（与 resolveAgentOpts 失败 / .then 路径对等）：
      // trace 标 failed + 持久化（catch 恰是最需留证的场景）。
      run.state.trace.update(msg.callId, {
        status: "failed",
        result: errorResult,
        completedAt: new Date().toISOString(),
      });
      // [P1b-1] agent-settled(failed) 落账（executeAgentCall 兜底异常路径——非 Abort
      // 异常，aborted=false；终局尝试序号 = call.attempts）。
      dispatchAgentSettled(run, call, false);
      settlePhaseIfComplete(run, msg.phase);
      postAgentResult(run, msg.callId, errorResult, false);
      // S2: 与 .then 对称——catch 路径也同步 worker $BUDGET（幂等）
      postBudgetUpdate(run);
      deps.store.save(run).catch((e: unknown) => {
        logger.error(`[workflow] store.save failed (catch fallback): ${toErrorMessage(e)}`);
      });
    });
}

/**
 * [D6] 绑定字段读取（agent-started 载荷的 memberRecordId 供源）：同名 agent 的
 * 绑定真相面在 workflow-dispatch 登记链（registerMemberRecord），本读取经复用池
 * 活体缓存同步取值（首派/降级形态返回 undefined——字段缺省即首派语义）。同步形态
 * 限制：dispatchAgentCall 主链无 await 点，活体缓存命中即取、miss 不阻塞派发
 * （首派帧本就无绑定可携；降级空池的续写帧缺绑定字段由 fold 侧按「无绑定」消费，
 * 与 member-reuse-pool 的降级语义一致）。
 */
function lookupBoundRecordIdSync(runId: string, name: string): string | undefined {
  return peekMemberRecordId(runId, name, memberReusePoolIo);
}

/**
 * [D3] phase 收束判定与落账：该 phase 账本 settled 计数追平 dispatched 时落
 * phase-settled 帧并清账（账本与记账原语在 terminal-actions——settlePhaseLedger
 * 含空串守卫与无条目 false，语义同前：仅显式 phase 参与、无 phase 归属的 call
 * 落定不影响任何账本）。竞态说明：账本是过程内派发/落定序的镜像（同 runId 内
 * dispatchAgentCall 与其完成链天然按事件循环序推进），终局/中断路径不经此判定
 * （phase-settled 只在 running/settling 自环行合法——落账于 run-settled 之前的
 * 调用序构造性满足表内转移；让位形态（IllegalTransitionError）由 reportDispatchFailure
 * 的 debug 分支吸收）。
 */
function settlePhaseIfComplete(run: WorkflowRun, phase: string | undefined): void {
  if (phase === undefined || phase === "") return;
  if (settlePhaseLedger(run.runId, phase)) dispatchPhaseSettled(run, phase);
}

/**
 * postMessage 序列化失败时回发的 fallback result（必可克隆），让 worker pending resolve。
 *
 * prefix 参数由调用方传入（当前唯一消费方 postAgentResult 用 "Result serialization
 * failed" 前缀）；返回 shape `{content:"", error:"<prefix>: <errMsg>"}` 恒定。
 *
 * W2 防御关键纯函数——export 供独立单测（worker-message-pump-serialize-failed-result.test.ts）验证
 * 返回 shape。
 */
export function makeSerializeFailedResult(
  prefix: string,
  errMsg: string,
): { content: string; error: string } {
  return { content: "", error: `${prefix}: ${errMsg}` };
}

/**
 * 回发 agent-result 给 worker（worker 内 pending Promise 据此 resolve）。
 *
 * W2 主线程防御：result 是 agent 返回值，含不可克隆成员（function/Symbol/循环引用）时
 * postMessage 同步抛 DataCloneError。若冒泡到 dispatchAgentCall 的 .then 回调，会中断
 * 后续 postBudgetUpdate/store.save/budget 检查，run 卡在 running。故内部 try/catch：
 * 失败时记录诊断 + 回发纯字符串 fallback result（必可克隆），让 worker pending resolve。
 */
function postAgentResult(
  run: WorkflowRun,
  callId: number,
  result: AgentResult,
  cached: boolean,
): void {
  try {
    run.runtime?.worker.postMessage({ type: "agent-result", callId, result, cached });
  } catch (err) {
    const msg = toErrorMessage(err);
    logger.error(`[workflow] postAgentResult failed (callId=${callId}): ${msg}. Result likely contains non-cloneable value.`);
    // 回发纯字符串 fallback result（必可克隆），让 worker pending resolve（避免永久挂起）
    try {
      run.runtime?.worker.postMessage({
        type: "agent-result",
        callId,
        result: makeSerializeFailedResult("Result serialization failed", msg),
        // 原 result 不可克隆时 cached 透传原值含义失真（fallback result 非缓存命中）→ 固定 false
        cached: false,
      });
    } catch {
      // fallback 也失败——worker 此 callId 的 pending 只能靠 timeout/exit 兜底
      logger.error(`[workflow] postAgentResult fallback also failed (callId=${callId}): worker pending will hang until timeout`);
    }
  }
}

/**
 * 回发 budget-update 给 worker（$BUDGET 据 worker-script-builder 的 budget-update 分支
 * 更新 spent()/remaining()）。每次 agent 调用消费 usage 后发送，保持 worker 内 $BUDGET
 * 与主线程 Budget 值对象同步。
 */
export function postBudgetUpdate(run: WorkflowRun): void {
  try {
    run.runtime?.worker.postMessage({
      type: "budget-update",
      budget: {
        usedTokens: run.state.budget.usedTokens,
        usedCost: run.state.budget.usedCost,
      },
    });
  } catch (err) {
    const msg = toErrorMessage(err);
    // budget 是纯 number 不太可能失败，但防御性兜底——budget 同步非关键（worker 仍可
    // 基于 $BUDGET.spent() 自行累计），失败仅记日志，不中断调用方流程。
    logger.error(`[workflow] postBudgetUpdate failed: ${msg}. Budget sync to worker skipped (non-critical).`);
  }
}

/**
 * 处理脚本的 return 消息：finalizeRun done,completed + 持久化。
 */
async function handleReturn(
  run: WorkflowRun,
  msg: ReturnMsg,
  deps: LifecycleDeps,
): Promise<void> {
  deps.log?.("debug", "workflow:worker-message-pump", "handleReturn", { runId: run.runId, status: run.state.status });
  // 捕获 worker 诊断日志（P2-2）
  // L9: 追加而非覆盖——保留重试历史的诊断日志（各 worker 实例的 console 输出）
  if (msg.workerLogs && msg.workerLogs.length > 0) {
    run.state.errorLogs.push(...msg.workerLogs);
    if (run.state.errorLogs.length > MAX_ERROR_LOGS) {
      run.state.errorLogs = run.state.errorLogs.slice(-MAX_ERROR_LOGS);
    }
  }
  run.state.scriptResult = msg.result;
  // C-4: run 到达 done 终态 → 注销 pending-notification + 通知 Interface 层
  // （[D15] coda 收敛为 terminal-actions.finalizeRun 单写点，含 SW-DATA-3 save 兜底）
  await finalizeRun(run, deps, "completed", { context: "handleReturn (done,completed)" });
}

// ── handleWorkerError ────────────────────────────────────────

/**
 * 处理 worker 线程 uncaught error。
 *
 * 重试矩阵：
 * - run.meta.workerErrorCount（C.5，跨 runtime 存活）< MAX → 退避 + rebuildRuntime
 * - >= MAX → finalizeRun done,failed
 *
 * [R4-F1] 同代际幂等：复用 receivedTerminalMessage 代际标志（见函数体注释）——
 * worker 崩溃时 error + exit(1) 双事件只处理一次（第二个事件直接跳过）。
 *
 * @throws 不抛错——所有失败路径转 transition 或日志
 */
export async function handleWorkerError(
  run: WorkflowRun,
  err: Error,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
  // 与 handleWorkerMessage 对称——终态（done）丢弃 stale error（否则 workerErrorCount
  // 被污染）。[加固] debug 留痕（原静默 return）。
  if (isRunSettled(run)) {
    logger.debug(
      `[workflow] stale worker error dropped on terminal run (runId=${run.runId}, event=worker-error, message=${JSON.stringify(err.message)})`,
    );
    return;
  }

  // [R4-F1] 同代际幂等守卫：worker 崩溃时 error + exit(1) 双事件各派发一次
  // handleWorkerError（onError 先到，exit 非 0 经 handleWorkerExit 委托二次到达）——
  // 旧实现单次崩溃 workerErrorCount +2、两个 scheduleRebuild 并行交错。复用 R4 的
  // receivedTerminalMessage 代际标志：进入处理前置 true 标记「本代际已有 error/terminal
  // 处理」，第二个事件命中标志直接跳过。
  if (run.runtime?.receivedTerminalMessage) return;
  if (run.runtime) run.runtime.receivedTerminalMessage = true;

  const count = (run.meta.workerErrorCount ?? 0) + 1;
  run.meta.workerErrorCount = count;

  if (count <= MAX_WORKER_RETRIES) {
    await scheduleRebuild(run, deps, handlers);
    return;
  }

  // 超限 → failed
  run.state.error = err.message;
  deps.log?.("debug", "workflow:worker-message-pump", "handleWorkerError retries exceeded, transition done", { runId: run.runId, count });
  await finalizeRun(run, deps, "failed", { context: "handleWorkerError (done,failed)" });
}

// ── handleWorkerExit ─────────────────────────────────────────

/**
 * 处理 worker 线程 exit。
 *
 * code === 0：
 * - 本代际已收到终态消息（return/error）→ no-op（正常收尾退出，或 script-error 重试
 *   退避窗口——rebuild 即将发生，不得干扰）
 * - 本代际未收到任何终态消息 → [F1] 转 done,failed（WORKER_EXITED_WITHOUT_RESULT_MSG）。
 * code !== 0 → 委托 handleWorkerError（非零 exit 视为崩溃，既有重试矩阵；重试耗尽仍会
 *   转 done,failed，无悬挂面）
 *
 * **G-025 竞态防护**：检查 handle.isCurrent——stale exit 事件（已 terminate 的旧
 * worker 的 exit）直接丢弃，不影响当前 runtime 的新 worker。
 */
export async function handleWorkerExit(
  run: WorkflowRun,
  code: number,
  handle: WorkerHandle,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
  // G-025: stale exit 事件丢弃（handle 已不是当前 runtime 的 worker）——[加固] debug
  // 留痕（原静默 return，丢弃不可观测）。
  if (!handle.isCurrent) {
    logger.debug(
      `[workflow] stale worker exit dropped (runId=${run.runId}, event=worker-exit, code=${code}, handle not current generation)`,
    );
    return;
  }
  if (isRunSettled(run)) {
    logger.debug(
      `[workflow] stale worker exit dropped on terminal run (runId=${run.runId}, event=worker-exit, code=${code})`,
    );
    return;
  }

  if (code === 0) {
    // 本代际已交付终态消息 → 正常收尾 / 重试退避窗口，no-op（rebuild 负责后续）
    if (run.runtime?.receivedTerminalMessage) return;

    // [F1] 无终态消息的 exit(0) = worker 静默退出（不可克隆 return 被吞 / 脚本直调
    // process.exit(0) 等）。置 failed 保证 run 必有终态。不重试：rebuild 重跑
    // 脚本对确定性根因（不可克隆 return）无意义，且 belt 路径优先给用户明确归因。
    deps.log?.("debug", "workflow:worker-message-pump", "worker exited without terminal message, transition done", { runId: run.runId });
    run.state.error = WORKER_EXITED_WITHOUT_RESULT_MSG;
    await finalizeRun(run, deps, "failed", { context: "handleWorkerExit (done,failed, no terminal message)" });
    return;
  }

  // 非零 exit → 委托 handleWorkerError（C.3: onExit 传 handle 用于竞态防护）
  await handleWorkerError(
    run,
    new Error(`Worker exited with code ${code}`),
    deps,
    handlers,
  );
}

// ── handleScriptError ────────────────────────────────────────

/**
 * 处理脚本主动抛出的 error（type:"error" from worker）。
 *
 * 重试矩阵：
 * - run.meta.scriptErrorCount（C.5）< MAX → 退避 + rebuildRuntime（N2: 补全重建）
 * - >= MAX → finalizeRun done,failed
 *
 * @param workerLogs worker console.* 捕获（P2-2，存 run.state.errorLogs 供 TUI 展示）
 */
export async function handleScriptError(
  run: WorkflowRun,
  errorMsg: string,
  workerLogs: WorkerLogEntry[],
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
  // 与 handleWorkerMessage/handleWorkerError 对称——终态守卫前置。
  if (isRunSettled(run)) return;

  // P2-2: 捕获 worker 诊断日志
  // L9: 追加而非覆盖
  if (workerLogs.length > 0) {
    run.state.errorLogs.push(...workerLogs);
    if (run.state.errorLogs.length > MAX_ERROR_LOGS) {
      run.state.errorLogs = run.state.errorLogs.slice(-MAX_ERROR_LOGS);
    }
  }

  const count = (run.meta.scriptErrorCount ?? 0) + 1;
  run.meta.scriptErrorCount = count;

  if (count <= MAX_WORKER_RETRIES) {
    await scheduleRebuild(run, deps, handlers);
    return;
  }

  // 超限 → failed
  run.state.error = `Workflow failed after ${MAX_WORKER_RETRIES} retries: ${errorMsg}`;
  deps.log?.("debug", "workflow:worker-message-pump", "handleScriptError retries exceeded, transition done", { runId: run.runId, count });
  await finalizeRun(run, deps, "failed", { context: "handleScriptError (done,failed)" });
}

// ── scheduleRebuild（退避 + 重建） ──────────────────────────

/**
 * 退避后重建 RunRuntime（G3-001 整重建）。
 *
 * 退避期间 run 可能被 abort（转终态 done）——rebuildRuntime 前重检状态，终态时
 * 跳过重建（避免给已终止的 run 启新 worker）。
 *
 * [OR-2] rebuildRuntime 抛错（workerHost.start 失败：线程/内存耗尽、eval 编译失败等）
 * 不再裸抛——本函数 catch 后回灌重试矩阵（handleRebuildStartFailure）。
 */
async function scheduleRebuild(
  run: WorkflowRun,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
  // 用当前重试计数算退避（workerErrorCount 或 scriptErrorCount 已递增）
  const retryIndex = Math.max(
    run.meta.workerErrorCount ?? 0,
    run.meta.scriptErrorCount ?? 0,
  );
  await delay(backoffDelay(retryIndex));

  // 退避期间状态可能变化——重检
  if (isRunSettled(run)) return;

  // [race-F3] 时间预算折算后已耗尽 → 不再 rebuild 重试，直接 time_limited 终态。
  // 必须在退避 delay 之后、rebuildRuntime 之前检查：检查前移会在「退避期间耗尽」的
  // 窗口漏判（rebuild 挂不出 timer，run 预算静默失效）；检查点与 rebuildRuntime 的
  // 计时器挂载之间无 await，remaining > 0 判定不会失效。
  const remainingMs = remainingTimeBudgetMs(run);
  if (remainingMs !== undefined && remainingMs <= 0) {
    await finalizeTimeBudgetExhausted(run, deps);
    return;
  }

  try {
    rebuildRuntime(run, deps, handlers);
  } catch (err) {
    await handleRebuildStartFailure(run, err, deps, handlers);
  }
}

/**
 * [OR-2] rebuildRuntime 抛错回灌重试矩阵。
 *
 * 重建动作本身失败按 worker 家族计数（重建的就是 worker）——计入 run.meta.workerErrorCount
 * （跨 runtime 存活的重试计数载体），与既有 handleWorkerError 共用同一上限
 * MAX_WORKER_RETRIES 与退避序列。
 */
async function handleRebuildStartFailure(
  run: WorkflowRun,
  err: unknown,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
  if (isRunSettled(run)) return;
  const message = toErrorMessage(err);
  const count = (run.meta.workerErrorCount ?? 0) + 1;
  run.meta.workerErrorCount = count;
  logger.error(
    `[workflow] rebuildRuntime failed (runId=${run.runId}, attempt ${count}/${MAX_WORKER_RETRIES}): ${message}`,
  );

  if (count <= MAX_WORKER_RETRIES) {
    await scheduleRebuild(run, deps, handlers);
    return;
  }

  // 耗尽 → 收敛 done,failed（不卡 running）
  run.state.error = `Runtime rebuild failed after ${MAX_WORKER_RETRIES} retries: ${message}`;
  deps.log?.("debug", "workflow:worker-message-pump", "rebuild retries exhausted, transition done", { runId: run.runId, count });
  await finalizeRun(run, deps, "failed", { context: "handleRebuildStartFailure (done,failed)" });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

// ── agent-retrying reason 摘要（D5「诊断引用落账」的摘要面）──

/** agent-retrying 的 reason 摘要：失败分类标签优先，自由错误文本截断兜底。 */
function summarizeRetryReason(result: AgentResult): string {
  if (result.failureKind !== undefined) return result.failureKind;
  const text = result.error ?? "unknown error";
  return text.length > ASK_RETRY_REASON_MAX_CHARS
    ? `${text.slice(0, ASK_RETRY_REASON_MAX_CHARS)}…`
    : text;
}

/** agent-retrying reason 的摘要截断上限（事件行要小——engine 崩溃错误文本含 stderr 尾，
 *  全文不进 record，诊断全文在 trace/agent-settled.stderrTeePath 取证链）。 */
const ASK_RETRY_REASON_MAX_CHARS = 160;

// ── [D6] 复用池活体缓存的同步读取面 ─────────────────────────

import { peekMemberRecordId } from "./member-reuse-pool.ts";
