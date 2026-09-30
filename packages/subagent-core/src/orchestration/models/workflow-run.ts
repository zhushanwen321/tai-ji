/**
 * Workflow Extension — WorkflowRun
 *
 * 单次 workflow run 的聚合根。封装状态机 + runtime 生命周期 + 不变式守卫。
 * 架构核心——所有字段变更通过方法（transition/assignRuntime/releaseRuntime/
 * replaceRuntime），engine 模块不直接打洞（AC-3）。
 *
 * 层归属：Engine。依赖 RunRuntime（具体类，D-12 允许）+ RunSpec/RunExecutionSnapshot + 类型。
 *
 * 关键不变式（必须全测）：
 * I1: state.status === "running" ⟺ runtime !== undefined
 * （原 I2「终局 ⟹ reason 非空」随 [D6(a) 第 1 步] 终局判定换源退役：终局判定不再
 * 读聚合状态字段，reason 完整性由 transition 的 done 入参校验与重建 fold 的构造
 * 唯一保证——详见 validateInvariants 注释。）
 *
 * 状态机（一次性生命周期，2 态）：
 * 构造（status="running"，I1 构造期跳过——runtime 由 assignRuntime 注入）
 * running ──transition("done", reason)──→ done (releaseRuntime + completedAt)
 * done ──(no out edges, zombie)
 *
 * 「创建即 running」与 I1 的协调（F4）：构造瞬间 running 而 runtime 尚未注入，
 * I1 在构造期跳过；完整校验由 assignRuntime/transition/replaceRuntime 末尾的
 * validateInvariants 维持；构造到 assignRuntime 的 I1 窗口由调用方
 * （lifecycle.runWorkflow 在 assignRuntime 之后才 runs.set）保证对外不可见。
 *
 * worker-error-retry（G5-001 + G6-001）：
 * - replaceRuntime(newRt): 前置 status==="running"（G6-001），原子释放前一个 runtime
 * + 绑定新 runtime，全程保持不变式 I1（中间不经过 runtime===undefined 的可见状态）。
 */

import { RunRuntime } from "./run-runtime.ts";
import type { RunSpec } from "./run-spec.ts";
import type { RunExecutionSnapshot } from "./run-state.ts";
import type { DoneReason, RunStatus } from "./types.ts";
import { canRunTransition } from "./types.ts";

// ── WorkflowRunMeta ──────────────────────────────────────────

/**
 * 聚合根级 meta（非 RunExecutionSnapshot 的一部分，不随 trace 持久化到 worker JSONL）。
 *
 * workerErrorCount/scriptErrorCount 跨 runtime 存活（C.5：worker-message-pump 重试计数载体），
 * 因为 retry 会 replaceRuntime，但计数是 run 级而非 runtime 级。
 */
export interface WorkflowRunMeta {
 /** ISO 时间戳，run 创建/启动时刻。 */
  startedAt: string;
 /** ISO 时间戳，transition("done") 时设置。 */
  completedAt?: string;
 /**
  * ISO 时间戳，最近一次中断（run-interrupted 转移事件）时刻；run-resumed 复活
  * 时清除（[D2] interrupted 是 lifecycle 暂停态——聚合 status 词表保持两态
  * running|done，中断态经本标记在投影面表达：runSummary 据此投影 'interrupted'，
  * CLI/TUI 展示不再把重水合中断 run 显示为僵尸「运行中」）。写点 = 壳侧
  * foldRecordStreamToRun（loadAll 重建）与 recoverCrashedRuns（收编链就地写入）。
  */
  interruptedAt?: string;
 /** Worker 线程错误计数（C.5：跨 runtime 存活，重试计数载体）。 */
  workerErrorCount?: number;
 /** 脚本错误计数（C.5：跨 runtime 存活）。 */
  scriptErrorCount?: number;
}

// ── WorkflowRun ──────────────────────────────────────────────

export class WorkflowRun {
  readonly runId: string;
  readonly spec: RunSpec;
  state: RunExecutionSnapshot;
  runtime?: RunRuntime;
  meta: WorkflowRunMeta;

  /**
 * 创建聚合根。初始状态 "running"（一次性生命周期：run 从创建起即在执行，
 * runtime 由紧随其后的 assignRuntime 注入）。也可传入 done 状态用于重水合
 * 已完成的 run（loadAll 后的只读聚合）。
 *
 * 不变式 I1 构造期跳过——「创建即 running」要求构造瞬间 runtime===undefined
 * 合法（runtime 必须由 assignRuntime 注入，构造函数无从持有）；重水合的
 * running 快照同样无 worker。I1 的运行时校验在 assignRuntime/transition/
 * replaceRuntime 末尾的 validateInvariants 处生效。
 */
  constructor(
    runId: string,
    spec: RunSpec,
    state: RunExecutionSnapshot,
    meta: WorkflowRunMeta,
  ) {
    this.runId = runId;
    this.spec = spec;
    this.state = state;
    this.meta = meta;
    // runtime 在构造时始终为 undefined——run 创建时无活 worker，loadAll 重水合
    // 时也不恢复 runtime（worker 必须由 lifecycle 重新 start）。
    this.runtime = undefined;
  }

  /**
 * 从持久化快照重水合聚合根。与构造函数同语义（构造期跳过 I1——持久化的
 * running 状态没有 worker，进程被杀后 worker 不可能还活着）。保留独立工厂
 * 标注重水合意图；调用方（D-4 kill-9 恢复）负责在 session_start 时把残留
 * running 转 done,failed，恢复 I1。
 */
  static reconstruct(runId: string, spec: RunSpec, state: RunExecutionSnapshot, meta: WorkflowRunMeta): WorkflowRun {
    return new WorkflowRun(runId, spec, state, meta);
  }

  // ── 不变式校验 ─────────────────────────────────────────────

  /**
 * 校验不变式 I1。违反抛错（聚合根自我保护，fail-fast）。
 * 在每个 mutation 方法末尾调用（防御式编程 + 测试可断言）。
 *
 * 原 I2（终局 ⟹ reason 非空）已随 [D6(a) 第 1 步] 终局判定换源退役：终局判定不再
 * 读聚合状态字段，reason 完整性由 transition 的 done 入参校验与重建 fold（恒携带
 * runSettledOutcomeToDoneReason 产物）唯一保证，聚合侧不再重复判定。
 */
  private validateInvariants(): void {
    // I1: status==="running" ⟺ runtime!==undefined
    if (this.state.status === "running" && this.runtime === undefined) {
      throw new Error(
        `WorkflowRun invariant I1 violated: status==="running" but runtime is undefined (runId=${this.runId})`,
      );
    }
    if (this.state.status !== "running" && this.runtime !== undefined) {
      throw new Error(
        `WorkflowRun invariant I1 violated: status!=="running" but runtime is defined (runId=${this.runId})`,
      );
    }
  }

  // ── 状态机转换 ─────────────────────────────────────────────

  /**
 * 状态机转换。合法转换：running→done。
 *
 * running 的进入不走 transition——构造即 running，replaceRuntime 保持 running。
 * 调用 transition("running") 抛错，防止绕过 runtime 注入直接改状态。
 *
 * 副作用：
 * - →done: releaseRuntime + 设 state.reason + meta.completedAt
 *
 * @param target 目标状态（不允许 "running"——runtime 注入只走 assignRuntime/replaceRuntime）
 * @param reason →done 时必填（终局 ⟹ reason 非空；原 I2 的写侧单点保证）
 * @throws 非法转换 / done 缺 reason / target==="running"
 */
  transition(target: RunStatus, reason?: DoneReason): void {
    // "running" 必须经 assignRuntime（需 runtime 参数，transition 无法提供）
    if (target === "running") {
      throw new Error(
        `WorkflowRun.transition: cannot transition to "running" directly — use assignRuntime() (runId=${this.runId})`,
      );
    }

    if (!canRunTransition(this.state.status, target)) {
      throw new Error(
        `WorkflowRun.transition: illegal transition ${this.state.status} → ${target} (runId=${this.runId})`,
      );
    }

    // →done 需 reason（原 I2 的写侧单点保证）
    if (target === "done" && reason === undefined) {
      throw new Error(
        `WorkflowRun.transition: transition to "done" requires a reason (runId=${this.runId})`,
      );
    }

    // 副作用：先清理 runtime（releaseRuntime 守不变式 I1），再改 status
    // （canRunTransition 已排除 target==="running"，此处 target 恒为 "done"）
    this.releaseRuntime();
    this.state.status = target;
    this.state.reason = reason;
    this.meta.completedAt = new Date().toISOString();

    this.validateInvariants();
  }

  // ── Runtime 生命周期 ───────────────────────────────────────

  /**
 * 绑定 runtime（run 创建后注入执行资源）。
 *
 * 前置：status==="running" && runtime===undefined（runWorkflow 创建路径——
 * 构造即 running 但 runtime 延迟到此处注入）。
 * 原子地：设 runtime 后末尾 validateInvariants，恢复构造期跳过的 I1
 * （running ⟺ runtime!==undefined）。
 *
 * @throws runtime 已定义 / status 不是 "running"（done 僵尸不可复活）
 */
  assignRuntime(rt: RunRuntime): void {
    if (this.runtime !== undefined) {
      throw new Error(
        `WorkflowRun.assignRuntime: runtime already defined (runId=${this.runId})`,
      );
    }
    if (this.state.status !== "running") {
      throw new Error(
        `WorkflowRun.assignRuntime: requires status==="running" (current: ${this.state.status}, runId=${this.runId})`,
      );
    }
    // 原子绑定：构造期 I1 处于跳过窗口（running 而 runtime undefined），设 runtime
    // 后末尾 validateInvariants 恢复 I1。调用方在 assignRuntime 后才对外注册
    // （lifecycle.runWorkflow 的 runs.set 后移），窗口外部不可见。
    this.runtime = rt;
    this.validateInvariants();
  }

  /**
 * 解绑 runtime（done 时由 transition 调用，也可独立调用）。
 *
 * 前置：无（runtime===undefined 时 no-op，幂等）。
 * 副作用：调 runtime.release("terminal") 释放 worker/controller，置 runtime=undefined。
 */
  releaseRuntime(): void {
    if (this.runtime === undefined) return;
    this.runtime.release("terminal");
    this.runtime = undefined;
    // 不改 status——调用方（transition）负责。独立调用时调用方需自行确保
    // status 一致（如 worker-error-retry 用 replaceRuntime 而非 release+assign）。
  }

  /**
 * 原地替换 runtime（G5-001：worker-error-retry）。
 *
 * 前置：status==="running"（G6-001：终态 run 拒绝重建）。
 * 原子地：释放旧 runtime（worker.terminate + abort）+ 绑定新 runtime，
 * 全程 status 保持 "running"，不变式 I1 不违反（中间无 runtime===undefined 可见态）。
 *
 * 与 release+assign 的区别：replaceRuntime 不改 status，中间同步完成，
 * 外部观察不到违反不变式的瞬间。
 *
 * @throws status!=="running"
 */
  replaceRuntime(rt: RunRuntime): void {
    if (this.state.status !== "running") {
      throw new Error(
        `WorkflowRun.replaceRuntime: requires status==="running" (current: ${this.state.status}, runId=${this.runId})`,
      );
    }
    // 原子替换：旧 runtime 释放（terminate+abort），新 runtime 绑定。
    // status 保持 "running"，runtime 全程 !== undefined，I1 不违反。
    if (this.runtime !== undefined) {
      this.runtime.release("terminal");
    }
    this.runtime = rt;
    this.validateInvariants();
  }
}
