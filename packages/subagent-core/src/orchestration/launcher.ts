/**
 * Workflow Extension — launcher
 *
 * runAndWait free function（D-12）。跨扩展编程入口（pi.__workflowRun）——
 * 阻塞至 run 到达 done 终态。
 *
 * **D-8 签名**：返回 WorkflowRunResult（{status:"done", reason, ...}）——
 * status 恒为 "done"，具体原因由 reason 区分
 * （completed/failed/aborted/budget_limited/time_limited）。
 *
 * **C.7**：timeout → transition done,time_limited（仅返回 timeout 标记但不转终态
 * 会让 workflow 仍 running，资源泄漏）。
 *
 * 流程：
 * 1. registry.get(name) → WorkflowScript（未找到返回 failed）
 * 2. script.validate（lint 检查）→ 失败抛错（不进 runWorkflow）
 * 3. script.toExecutable → 可执行源
 * 4. 构建 RunSpec + runWorkflow(spec, deps, signal)
 * 5. 轮询至 done（间隔 STATUS_POLL_INTERVAL_MS）
 * 6. 显式 timeoutMs 到期 → abortRun + transition done,time_limited（未传不限时）
 * 7. signal.aborted → abortRun + reason=aborted
 *
 * 层归属：Engine。依赖 registry + runWorkflow/abortRun + LifecycleDeps。
 *
 * 参考：domain-models.md §D-8（WorkflowRunResult 签名）、clarification.md C.7。
 */

import { ArgsValidationError } from "./args-validator.ts";
import { abortRun, runWorkflow } from "./lifecycle.ts";
import type { LifecycleDeps } from "./models/ports.ts";
import type { RunSpec } from "./models/run-spec.ts";
import type { DoneReason } from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";
import type { WorkflowScript } from "./models/workflow-script.ts";
import type { WorkflowScriptRegistry } from "./models/workflow-script-registry.ts";
import type { LintResult } from "./script-lint.ts";
import { assertSafeTimerDelay } from "../shared/timer-delay.ts";

// ── 常量 ─────────────────────────────────────────────────────

/** 轮询间隔（500ms）。 */
const STATUS_POLL_INTERVAL_MS = 500;

/**
 * [U7] TAIJI_SUBAGENT_RUN_WATCHDOG_MS：无显式限时 run 的轮询绝对时限兜底 env。
 *
 * 与 session-runner 的 TAIJI_SUBAGENT_SPAWN_WATCHDOG_MS（spawn watchdog：maxTurns 无
 * 估算依据时的 hang 兜底）对称：未设置 = 无兜底（不限，watchdog 默认关的用户裁决不变）；
 * 设置 = pollRunToResult 的 wall-clock 绝对时限——无显式限时的 run（顶层 runAndWait
 * 未传 timeoutMs / 嵌套父 run 未设 budgetTimeMs）若 workflow worker hang 将永不回收，
 * 本 env 提供显式 opt-in 的兜底回收。非法值（非有限数/<=0）视为未设。
 * 前缀用 TAIJI_SUBAGENT_*：同 SPAWN_WATCHDOG_ENV 的桌面 safe-env 白名单原因
 * （ENV_WHITELIST_PREFIXES 只放行 TAIJI_ 等，PI_ 前缀被静默丢弃）。
 */
export const RUN_WATCHDOG_ENV = "TAIJI_SUBAGENT_RUN_WATCHDOG_MS";

/** 解析 run watchdog 毫秒数；env 未设/非法返回 undefined（无兜底，不限）。 */
function getEnvRunWatchdogMs(): number | undefined {
  const raw = process.env[RUN_WATCHDOG_ENV];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

// ── 类型 ─────────────────────────────────────────────────────

/**
 * runAndWait 的返回（D-8 签名）。
 *
 * status 恒为 "done"（runAndWait 阻塞至 done 才返回）；具体原因由 reason 区分
 * （completed/failed/aborted/budget_limited/time_limited）。
 */
export interface WorkflowRunResult {
 /** 恒为 "done"（runAndWait 阻塞至 done）。 */
  status: "done";
 /** 终态原因（completed/failed/aborted/budget_limited/time_limited）。 */
  reason: DoneReason;
 /** 脚本返回值（reason==="completed" 时有）。 */
  scriptResult?: unknown;
 /** 错误信息（reason!=="completed" 时可有）。 */
  error?: string;
 /** run 标识。 */
  runId: string;
}

/**
 * Launcher 依赖：LifecycleDeps + registry（脚本发现）。
 *
 * registry 是「发现依赖」（文件系统扫描），与 LifecycleDeps 的 3 个 port
 * （执行依赖：子进程/线程/持久化）性质不同——故单独扩展，不进 LifecycleDeps。
 */
export interface LauncherDeps extends LifecycleDeps {
 /** workflow 脚本仓库。 */
  registry: WorkflowScriptRegistry;
}

// ── 内部 helper ──────────────────────────────────────────────

/** 轮询间隔 Promise。 */
function pollInterval(): Promise<void> {
  // IF10(#16)：unref 使轮询等待 tick 不钉住事件循环（对齐 subagent-service
  // gcTimer.unref?.() 先例的防御 duck-type 写法）。resolve 语义不变——unref
  // 只影响进程退出判定，已注册 timer 仍按 500ms 触发。
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, STATUS_POLL_INTERVAL_MS);
    timer.unref?.();
  });
}

/** lint findings 摘要串（runAndWait / executeNestedWorkflow 共用同一错误文案格式）。 */
function formatLintErrorSummary(lintResult: LintResult): string {
  return lintResult.findings
    .filter((f) => f.severity === "error")
    .map((f) => `L${f.line}: ${f.message}`)
    .join("; ");
}

/**
 * 从 WorkflowRun 构建 WorkflowRunResult（D-8）。
 *
 * reason 取 run.state.reason（done 时必有，WorkflowRun 不变式 I2 保证），
 * 防御性 fallback "failed"（理论不可达——I2 保证 done 时 reason 已设）。
 */
function toResult(run: WorkflowRun): WorkflowRunResult {
  return {
    status: "done",
    reason: run.state.reason ?? "failed",
    scriptResult: run.state.scriptResult,
    error: run.state.error,
    runId: run.runId,
  };
}

// ── pollRunToResult（runAndWait + executeNestedWorkflow 共用轮询） ────

/**
 * 轮询 run 至 done 终态并返回 WorkflowRunResult。
 *
 * runAndWait 与 executeNestedWorkflow 共用的轮询逻辑（D-12 后去重）：
 * - signal.aborted → 先查 run 是否已 done（避免二次 safeAbort 写不同 error 造成
 *   非确定性），否则 safeAbort(aborted) + 返回 aborted 结果
 * - run 丢失 → failed 结果
 * - run done → toResult
 * - deadline 到 → 先查 done，否则 safeAbort(time_limited) + 返回 timeout 结果
 *
 * @param abortReason signal abort 时写入 run.state.error 的原因串。runAndWait 传
 * "Aborted by signal"；executeNestedWorkflow 传 "Aborted by parent signal"。
 */
async function pollRunToResult(
  runId: string,
  deps: LauncherDeps,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  abortReason: string,
): Promise<WorkflowRunResult> {
  // [预算语义对齐 + U2] timeoutMs undefined 或 <=0 → 无 wall-clock deadline（不限）：
  // 与 lifecycle.runWorkflow 的 budgetTimeMs 判定（>0 才挂 scheduleTimeBudget）同语义。
  // 旧实现 0 → deadline=now 立即超时（"timed out after 0ms"）、负数 → "timed out
  // after -5000ms" 类错误串；非正值与 undefined 统一为不限。
  // [U7] 显式不限时由 TAIJI_SUBAGENT_RUN_WATCHDOG_MS 提供绝对时限兜底（未设 = 不限）。
  // env 值与显式值同域：越界（>2^31-1）fail-fast——虽 deadline 是算术比较不经
  // setTimeout、无 1ms 陷阱，但如此量级的配置几乎必然是手误，与 spawn watchdog env
  // 的 fail-fast 策略对称。
  const explicitTimeoutMs =
    timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : getEnvRunWatchdogMs();
  if (explicitTimeoutMs !== undefined) {
    assertSafeTimerDelay(explicitTimeoutMs, `timeoutMs / ${RUN_WATCHDOG_ENV}`);
  }
  // Infinity 哨兵统一 while 条件，避免循环内双重判空；Infinity 永不小于自身，循环只在
  // 有限 deadline 到期时退出。
  const deadline =
    explicitTimeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + explicitTimeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      const runBeforeAbort = deps.runs.get(runId);
      if (runBeforeAbort?.state.status === "done") return toResult(runBeforeAbort);
      await safeAbort(runId, deps, abortReason, "aborted");
      const run = deps.runs.get(runId);
      return run
        ? toResult(run)
        : { status: "done", reason: "aborted", error: abortReason, runId };
    }
    const run = deps.runs.get(runId);
    if (!run) return { status: "done", reason: "failed", error: "Run not found", runId };
    if (run.state.status === "done") return toResult(run);
    await pollInterval();
  }
  const runBeforeTimeout = deps.runs.get(runId);
  if (runBeforeTimeout?.state.status === "done") return toResult(runBeforeTimeout);
  // 循环退出 ⇒ deadline 有限 ⇒ explicitTimeoutMs 必已定义（undefined/<=0 走 Infinity 不进此分支）
  await safeAbort(runId, deps, `Workflow timed out after ${explicitTimeoutMs}ms`, "time_limited");
  const finalRun = deps.runs.get(runId);
  return finalRun
    ? toResult(finalRun)
    : {
      status: "done",
      reason: "time_limited",
      error: `Workflow timed out after ${explicitTimeoutMs}ms`,
      runId,
    };
}

// ── runAndWait ───────────────────────────────────────────────

/**
 * 同步运行 workflow 至终态（跨扩展编程入口）。
 *
 * 阻塞至 run 到达 done，返回 WorkflowRunResult。用于 pi.__workflowRun 等
 * 编程式调用——非交互场景（交互用 run + lifecycle tools）。
 *
 * **超时处理（C.7）**：timeout → abortRun + 返回 reason=time_limited。
 * 旧代码返回 status:"timeout" 但 workflow 可能仍 running（资源泄漏）；
 * 本实现确保 timeout 转 done,time_limited 终态。
 *
 * **signal abort**：signal.aborted → abortRun + 返回 reason=aborted。
 *
 * **脚本未找到**：返回 reason=failed（不抛错——编程调用方据 reason 判断）。
 *
 * @param name workflow 脚本名（registry.get 查找）
 * @param args 调用参数（worker 内 $ARGS 访问）
 * @param deps LauncherDeps（LifecycleDeps + registry）
 * @param signal 外部 abort signal（可选）
 * @param timeoutMs 超时上限（可选）。[预算语义对齐 + U2] 未传或 <=0 = 不限（轮询至 done /
 *  abort 为止，不限时由 TAIJI_SUBAGENT_RUN_WATCHDOG_MS 兜底）——旧实现默认 10 分钟会误杀长任务，
 *  且 0/负值会落成立即超时；仅显式正数才限时。
 * @param model Run 级 model override（可选）。[host-surface] 经 spec.model → workerData →
 *  $MODEL → agent() fallback（RunSpec Option B 同一路径）。缺省不覆盖——宿主未显式指定
 *  model 时维持脚本内 agent() 显式参数 / agent .md / 引擎默认的既有解析序。此前该入口
 *  无 model 通道，消费方（zsw CLI --model）只能丢弃该参数——行为劈叉于走 buildSpec 的
 *  异步入口。
 * @returns WorkflowRunResult（status 恒 "done"）
 */
export async function runAndWait(
  name: string,
  args: Record<string, unknown>,
  deps: LauncherDeps,
  signal?: AbortSignal,
  timeoutMs?: number,
  model?: string,
): Promise<WorkflowRunResult> {
  // 1. registry 查找脚本（workflowRef = 绝对路径，S2 路径统一）
  const script = await deps.registry.getPath(name);
  if (!script) {
    return {
      status: "done",
      reason: "failed",
      error: `Workflow '${name}' not found`,
      runId: "",
    };
  }

  // 2. lint 校验（失败抛错——脚本本身有问题，不应静默吞）
  const lintResult = script.validate();
  if (!lintResult.valid) {
    throw new Error(
      `Workflow script '${name}' has lint errors: ${formatLintErrorSummary(lintResult)}`,
    );
  }

  // 3. 构建 RunSpec
  // 不设 budgetTimeMs：runAndWait 自身用轮询 deadline（pollRunToResult 内 while + safeAbort）
  // 实施 timeout，并产出「Workflow timed out after Xms」的具体错误信息。spec 级
  // 时间预算（lifecycle.scheduleTimeBudget）服务于 fire-and-forget 的交互式 run
  // （tool-workflow actionRun），若在此也设会与轮询 deadline 同时触发产生竞态。
  // model 是例外：时间预算必须二选一（竞态），model 只有单通道（spec Option B），
  // 调用方显式传入即透传，不与任何轮询面竞争。
  const spec: RunSpec = {
    scriptSource: script.toExecutable(),
    args,
    budgetTokens: undefined,
    model,
    scriptName: script.name,
    scriptPath: script.path,
    description: script.meta.description,
    parameters: script.meta.parameters,
  };

  // 4. 启动 workflow + 5. 轮询至 done（含 6. timeout → abortRun，C.7）
  // pending-notification 的 register/unregister 由 runWorkflow（启动注册）+
  // transition("done") 路径（完成注销）统一处理，runAndWait 不再重复 emit。
  // m3：chokepoint 校验失败（ArgsValidationError）→ 返回 invalid_args 结果（run 从未
  // 创建，runId 恒 ''），非 ArgsValidationError 保持传播。
  let runId: string;
  try {
    runId = await runWorkflow(spec, deps, signal);
  } catch (err) {
    if (err instanceof ArgsValidationError) {
      // 注：WorkflowRunResult.reason 是 pi.__workflowRun 的跨扩展公开类型——新增
      // 'invalid_args' 成员是对外部消费方的契约变更（m3 exec-review m5）；该 reason
      // 永不进 run.state.reason（run 从未创建），仅存在于本合成返回值。
      return {
        status: "done",
        reason: "invalid_args",
        runId: "",
        error: err.message,
      };
    }
    throw err;
  }
  return pollRunToResult(runId, deps, signal, timeoutMs, "Aborted by signal");
}

/**
 * 安全 abort——run 可能已终态（abortRun 对 done no-op，但防御兜底）。
 */
async function safeAbort(
  runId: string,
  deps: LauncherDeps,
  reason: string,
  doneReason: DoneReason,
): Promise<void> {
  try {
    await abortRun(runId, deps, reason, doneReason);
  } catch (err) {
    // run 可能已终态或不存在——忽略，调用方据 toResult 判断
    void err;
  }
}

// ── executeNestedWorkflow（workflow() 嵌套调用实现） ────────

/** 父 run 的循环检测链：[...parentChain, parentScriptName]（顶层 run 无 chain 时前段为空）。 */
function buildParentChain(parentRun: WorkflowRun): string[] {
  return [...(parentRun.spec.parentWorkflowChain ?? []), parentRun.spec.scriptName];
}

/** Step 2 的 signal 继承产物（childController + 父 signal/回调——finally 移除 listener 用）。 */
interface InheritedSignal {
  childController: AbortController;
  parentSignal: AbortSignal | undefined;
  onParentAbort: () => void;
}

/**
 * Step 2: signal 继承——子 run 响应父 run abort（parentController → childController）。
 *
 * [L-2] onParentAbort 提取为命名函数以便 finally removeEventListener，防子 run 完成后
 * parentSignal 上残留 listener（多次嵌套调用会累积）。
 */
function inheritParentSignal(parentRun: WorkflowRun): InheritedSignal {
  const childController = new AbortController();
  const parentSignal = parentRun.runtime?.controller.signal;
  const onParentAbort = (): void => childController.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      childController.abort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  return { childController, parentSignal, onParentAbort };
}

/**
 * Step 4: 构建 RunSpec（共享父 Budget + 循环链）。
 *
 * budget 共享（F-7 方案 B）：子 run 直接复用父 Budget 引用（budgetRef），consume 实时
 * 累加到父 Budget，消除并行嵌套下的超支窗口，无需 sync-back。
 */
function buildNestedSpec(
  args: Record<string, unknown>,
  parentRun: WorkflowRun,
  script: WorkflowScript,
  chain: string[],
): RunSpec {
  return {
    scriptSource: script.toExecutable(),
    args,
    budgetRef: parentRun.state.budget,
    // Run-level override 传播（与父 run 对齐）：子 run 继承父 run 的 model/thinkingLevel，
    // 否则嵌套 workflow 丢失父 run 的模型指定，回落主 agent 模型。
    model: parentRun.spec.model,
    thinkingLevel: parentRun.spec.thinkingLevel,
    scriptName: script.name,
    scriptPath: script.path,
    description: script.meta.description,
    parameters: script.meta.parameters,
    parentWorkflowChain: chain,
  };
}

/**
 * 嵌套 workflow timeout 从父 run 完整传导：父 spec.budgetTimeMs 显式设定时原样作为子 run
 * 轮询 deadline（不 min(DEFAULT) 封顶——旧实现把父 time:2h 截断到 10min，违背「显式传参
 * 完整生效」语义）；父未设 → undefined，无 deadline（不限）。
 * [U2] 预算语义统一：父 budgetTimeMs <=0（含 0/负）与 undefined 同义 = 不限——与
 * lifecycle.runWorkflow 的 budgetTimeMs 判定（>0 才挂 scheduleTimeBudget）对齐。
 */
function resolveNestedTimeoutMs(parentRun: WorkflowRun): number | undefined {
  const raw = parentRun.spec.budgetTimeMs;
  return raw !== undefined && raw > 0 ? raw : undefined;
}

/**
 * Step 6: 结果转换（budget 已通过共享 budgetRef 实时同步，无需 sync-back）。
 * completed → content = 字符串原样 / 其余 JSON.stringify；非 completed → error result。
 */
function toNestedCallResult(
  name: string,
  result: WorkflowRunResult,
): { content: string; parsedOutput?: unknown; error?: string } {
  if (result.reason === "completed") {
    const scriptResult = result.scriptResult;
    return {
      content:
        typeof scriptResult === "string"
          ? scriptResult
          : JSON.stringify(scriptResult ?? ""),
      parsedOutput:
        typeof scriptResult === "object" && scriptResult !== null
          ? scriptResult
          : undefined,
    };
  }
  return {
    content: "",
    error: result.error ?? `Workflow '${name}' ended: ${result.reason}`,
  };
}

/**
 * workflow() 嵌套调用的 Engine 实现。
 *
 * Worker 脚本内调 workflow(name, args) 时，worker-message-pump.dispatchWorkflowCall 路由
 * 到 deps.onWorkflowCall，后者（Interface 层 makeDeps 注入）委托本函数。
 *
 * 流程（6 步，Step 2-6 的机制细节见各 helper）：
 * 1. 循环检测——name 已在 parentWorkflowChain 中则拒绝（防 A→B→A 死循环）
 * 2. signal 继承——子 run 响应父 run abort（inheritParentSignal）
 * 3. registry.get + lint——失败返回 error result（不抛错，让脚本 soft-fail）
 * 4. 构建 RunSpec（共享父 Budget 引用 + parentWorkflowChain 延长）+ runWorkflow
 * 5. pollRunToResult 轮询至 done（复用 runAndWait 的轮询逻辑）
 * 6. 结果转换（toNestedCallResult）
 *
 * 不走 runAndWait：runAndWait 内部构建 RunSpec 不支持 parentWorkflowChain 与 budget
 * 共享引用，故直接构建 spec + runWorkflow + pollRunToResult。
 *
 * @param name 子 workflow 脚本名（registry.get 查找）
 * @param args 调用参数（子 worker 内 $ARGS 访问）
 * @param parentRun 发起嵌套调用的父 WorkflowRun（budget 共享 + 循环链源）
 * @param deps LauncherDeps（与 runAndWait 同一组依赖 + registry）
 * @returns { content, parsedOutput?, error? }——dispatchWorkflowCall 原样 postMessage 回 worker
 */
export async function executeNestedWorkflow(
  name: string,
  args: Record<string, unknown>,
  parentRun: WorkflowRun,
  deps: LauncherDeps,
): Promise<{ content: string; parsedOutput?: unknown; error?: string }> {
  // Step 1: 循环检测——parentWorkflowChain 不存在时为 []（顶层 run）
  const chain = buildParentChain(parentRun);
  if (chain.includes(name)) {
    return {
      content: "",
      error: `Circular workflow call detected: ${[...chain, name].join(" → ")}`,
    };
  }

  // Step 2: signal 继承——子 run 响应父 run abort
  const { childController, parentSignal, onParentAbort } = inheritParentSignal(parentRun);

  // Step 3+：registry 查找 + lint + RunSpec + runWorkflow + poll 全程 try（m3 E8——
  // try 起点在 Step 2 的 listener 注册之后，覆盖 Step 3-6。runWorkflow throw
  // （含 chokepoint ArgsValidationError）与 not found/lint 早返回均走 finally 移除
  // parentSignal listener——修复原 try 外 runWorkflow 的泄漏路径）。
  try {
    // Step 3: registry 查找 + lint（失败返回 error result，不抛错）
    const script = await deps.registry.getPath(name);
    if (!script) {
      return { content: "", error: `Workflow '${name}' not found` };
    }
    const lintResult = script.validate();
    if (!lintResult.valid) {
      return {
        content: "",
        error: `Workflow script '${name}' has lint errors: ${formatLintErrorSummary(lintResult)}`,
      };
    }

    // Step 4: 构建 RunSpec + 启动子 workflow
    // budgetRef（共享 Budget）已在 spec 透传给子 run 处理 token/cost 预算，
    // resolveNestedTimeoutMs 的 budgetTimeMs 只服务 pollRunToResult 的轮询 deadline
    // （wall-clock 兜底）。
    const spec = buildNestedSpec(args, parentRun, script, chain);
    const runId = await runWorkflow(spec, deps, childController.signal);

    // Step 5: 轮询至 done（复用 runAndWait 的轮询逻辑）
    const result = await pollRunToResult(
      runId,
      deps,
      childController.signal,
      resolveNestedTimeoutMs(parentRun),
      "Aborted by parent signal",
    );

    // Step 6: 结果转换
    return toNestedCallResult(name, result);
  } catch (err) {
    // m3：chokepoint 校验失败 → {error}（§5.3 指引文案），非 ArgsValidationError 保持传播
    // （dispatchWorkflowCall 的 .catch 兜底转 postResult，worker 不崩）。
    if (err instanceof ArgsValidationError) {
      return { content: "", error: err.message };
    }
    throw err;
  } finally {
    // [L-2] 子 run done 后移除 parentSignal listener，避免累积（{ once: true } 在
    //  正常完成路径下不会自动触发，listener 残留；多次嵌套调用会泄漏到 parentSignal）。
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
