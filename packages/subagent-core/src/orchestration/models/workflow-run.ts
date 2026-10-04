/**
 * Workflow Extension — WorkflowRun
 *
 * 单次 workflow run 的聚合根。封装 runtime 生命周期，engine 模块不直接打洞（AC-3）。
 *
 * 层归属：Engine。依赖 RunRuntime（具体类，D-12 允许）+ RunSpec/RunExecutionSnapshot + 类型。
 *
 * 生命周期判定归属（[D6(a)] 终态）：聚合**不承载生命周期状态**——终局判定唯一走
 * 六态机 dispatchRunTrigger 链与进程内终局记录注册表（terminal-actions 的
 * isRunSettled / settledRecordOf），展示投影走 runSummary（三态投影词表）。
 * 本类只管 runtime 资源的绑定/替换/释放（assignRuntime/replaceRuntime/
 * releaseRuntime）。
 *
 * 「终局 run 不可复活」的守卫面 = 调用方（聚合不设防）：
 * - runWorkflow：绑定对象是本函数内新建的聚合，结构性不可已终局；
 * - rebuildRuntime（worker 错误重试）：scheduleRebuild 在退避后、重建前同步重检
 *   isRunSettled（与 replaceRuntime 之间无 await，无竞窗）；
 * - resume 接管（adoptResumedRun）：资格门按 record 流 fold 拒绝已终局 run
 *   （resume-run 的 already-settled / 非 interrupted 拒绝项）。
 *
 * worker-error-retry（G5-001 + G6-001）：
 * - replaceRuntime(newRt): 原子释放前一个 runtime + 绑定新 runtime（终态 run 的
 *   重建拒绝由上述调用方 isRunSettled 前置承载，G6-001）。
 */

import { RunRuntime } from "./run-runtime.ts";
import type { RunSpec } from "./run-spec.ts";
import type { RunExecutionSnapshot } from "./run-state.ts";

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
  /**
   * ISO 时间戳，终局时刻（legacy 兼容读：活体终局的权威时序 = 终局记录注册表的
   * run-settled 帧时序（[W2/V1 D1] 后生产无写入方），本字段仅由旧持久化快照
   * 重水合携带，作 runSummary 注册表 miss 时的回落读）。
   */
  completedAt?: string;
  /**
   * ISO 时间戳，最近一次中断（run-interrupted 转移事件）时刻；run-resumed 复活
   * 时清除（[D2] interrupted 是 lifecycle 暂停态——聚合不持生命周期轴，中断态经
   * 本标记在投影面表达：runSummary 据此投影 'interrupted'，CLI/TUI 展示不再把
   * 重水合中断 run 显示为僵尸「运行中」）。写点 = 壳侧 foldRecordStreamToRun
   * （loadAll 重建）与 recoverCrashedRuns（收编链就地写入）。
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
   * 创建聚合根。runtime 由调用方经 assignRuntime 注入（构造时恒 undefined——
   * run 创建时无活 worker，重水合的 run 同样不恢复 runtime，worker 必须由
   * lifecycle 重新 start）。
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
   * 从持久化快照重水合聚合根。与构造函数同语义。保留独立工厂标注重水合意图；
   * 调用方（D-4 kill-9 恢复）负责残留 running 形态的中断收编（recoverCrashedRuns）。
   */
  static reconstruct(runId: string, spec: RunSpec, state: RunExecutionSnapshot, meta: WorkflowRunMeta): WorkflowRun {
    return new WorkflowRun(runId, spec, state, meta);
  }

  // ── Runtime 生命周期 ───────────────────────────────────────

  /**
   * 绑定 runtime（run 创建/复活后注入执行资源）。
   *
   * 前置：runtime===undefined（重复绑定抛错）。「终局 run 不可复活」由调用方
   * 前置承载（见类注释守卫面——本类不持生命周期状态，无法自判）。
   */
  assignRuntime(rt: RunRuntime): void {
    if (this.runtime !== undefined) {
      throw new Error(
        `WorkflowRun.assignRuntime: runtime already defined (runId=${this.runId})`,
      );
    }
    this.runtime = rt;
  }

  /**
   * 解绑 runtime（终局 coda finalizeRun 显式调用，也可独立调用）。
   *
   * 前置：无（runtime===undefined 时 no-op，幂等）。
   * 副作用：调 runtime.release("terminal") 释放 worker/controller，置 runtime=undefined。
   */
  releaseRuntime(): void {
    if (this.runtime === undefined) return;
    this.runtime.release("terminal");
    this.runtime = undefined;
    // 不改 status——聚合 status 是过渡期兼容载体，终局判定经终局记录注册表
    // （terminal-actions）；独立调用时调用方需自行确保 status 一致
    // （如 worker-error-retry 用 replaceRuntime 而非 release+assign）。
  }

  /**
   * 原地替换 runtime（G5-001：worker-error-retry）。
   *
   * 原子地：释放旧 runtime（worker.terminate + abort）+ 绑定新 runtime。
   * 终态 run 的重建拒绝（G6-001）由调用方前置承载——唯一生产调用链
   * scheduleRebuild → rebuildRuntime 在本调用前同步重检 isRunSettled（无 await
   * 竞窗，见类注释守卫面）。
   */
  replaceRuntime(rt: RunRuntime): void {
    // 原子替换：旧 runtime 释放（terminate+abort），新 runtime 绑定。
    if (this.runtime !== undefined) {
      this.runtime.release("terminal");
    }
    this.runtime = rt;
  }
}
