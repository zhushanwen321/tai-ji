/**
 * Workflow Extension — Run Runtime
 *
 * 聚合内运行时资源（仅 status==="running" 时存在）。技术资源聚合，
 * Engine 层类型，持 WorkerHandle 具体类（D-12 不造 interface）。
 *
 * 职责：封装一次 running-segment 的所有技术资源（worker 线程 +
 * abort controller），统一 release 入口（AC-2：单 release 替代多 boolean flag）。
 * （旧并发门闩 gate 抽象已删——no-op，实际并发由 SubagentService ConcurrencyPool 管理；
 * 原 withSlot 的 pre-abort 检查内联到 worker-message-pump dispatchAgentCall。）
 *
 * 一次性生命周期（G3-001）：runtime 释放后不再复用——AbortController 一次性
 * 语义决定 controller 无法跨释放复用，所以整个 RunRuntime 重建。唯一注入路径：
 * assignRuntime（runWorkflow 创建）与 replaceRuntime（worker-message-pump 崩溃重试）。
 *
 * 参考：domain-models.md §10、clarification.md G3-001。
 */

import { WorkerHandle } from "../worker-handle.ts";

/**
 * release mode 枚举——调用方表达意图。
 *
 * 一次性生命周期后唯一语义：terminal（终局释放，worker + controller 全释放，
 * runtime 即被调用方丢弃）。原 "pause" 值已随 pause/resume 生命周期删除（F8）
 * ——release 后不存在「保留待恢复」的中间形态。
 */
export type ReleaseMode = "terminal";

// ── RunRuntime ───────────────────────────────────────────────

export class RunRuntime {
  /** Worker 线程句柄。 */
  readonly worker: WorkerHandle;
  /** per-running-segment AbortController（一次性，无法复用——G3-001）。 */
  readonly controller: AbortController;
  /** Run 级墙钟时间预算计时器（spec.budgetTimeMs > 0 时由 lifecycle 调度，
   * 到期 abortRun time_limited）。release 时清理，避免 abort/replaceRuntime
   * 后孤儿计时器仍触发（rebuildRuntime 会重排一个全新的计时器，旧的不应残留）。 */
  readonly timeBudgetTimer?: ReturnType<typeof setTimeout>;
  /**
 * 本 runtime 代际是否已收到 worker 的终态消息（return / error）。
 *
 * [F1] worker exit(0) 且本标记为 false = worker 静默退出、未交付任何终态——最常见根因
 * 是 execute() 返回值不可克隆，worker 侧 _safePost 吞掉 DataCloneError 后 return 消息
 * 根本没发出。旧实现 handleWorkerExit 对 code===0 no-op → run 永久 running、runAndWait
 * 悬挂。handleWorkerExit 据此判定转 done,failed。
 *
 * 按代际归零：字段挂在 RunRuntime（每代际 new 一个实例）而非 run.meta——script-error
 * 重试退避窗口内（error 消息已收到、run 仍 running、旧 worker exit(0)）必须 no-op 等
 * rebuild；若挂 meta 则 rebuild 后新 worker 再静默退出时会被旧标记误放行，重新悬挂。
 *
 * 写点：① handleWorkerMessage 的 return/error 分支（WorkerHandle.isCurrent 守卫保证
 * 消息必来自当前代际）；② handleWorkerError 进入处理前（[R4-F1] 同代际幂等守卫——
 * worker 崩溃时 error + exit(1) 双事件各派发一次 handleWorkerError，第一个事件标记
 * 本代际已处理，第二个事件命中标志跳过，消除单次崩溃计数 +2 / 双 rebuild 交错）。
 * rebuildRuntime 构造新 RunRuntime 自然重置。
 */
  receivedTerminalMessage = false;
  /** 防止 release 重复执行（幂等）。 */
  private released = false;

  constructor(
    worker: WorkerHandle,
    controller: AbortController,
    timeBudgetTimer?: ReturnType<typeof setTimeout>,
  ) {
    this.worker = worker;
    this.controller = controller;
    this.timeBudgetTimer = timeBudgetTimer;
  }

  /**
 * 释放所有资源：terminate worker + abort controller。
 *
 * 幂等——重复调用安全（第二次起 no-op，released flag 守卫）。
 * 调用后此 RunRuntime 应被调用方丢弃（WorkflowRun.runtime = undefined），
 * 崩溃重试时由 replaceRuntime 注入新实例（G3-001）。
 *
 * worker.terminate 本身幂等，controller.abort 本身幂等
 * （重复 abort 无副作用），但 released flag 让本方法语义更明确：
 * 「释放过一次的 runtime 不再释放第二次」。
 *
 * @param mode terminal —— 终局释放（唯一值，保留参数为调用方语义显式化）
 */
  release(_mode: ReleaseMode): void {
    if (this.released) return;
    this.released = true;
    // 清理 run 级时间预算计时器——abort/terminate/replaceRuntime 后它不应再触发
    // （rebuildRuntime 会重排全新计时器；孤儿触发会把已终态的 run 误转 done）。
    if (this.timeBudgetTimer) clearTimeout(this.timeBudgetTimer);
    // worker.terminate 异步但幂等——不 await（release 是同步签名，调用方
    // 不应被底层线程关闭阻塞；worker 收到 terminate 后自行清理）。
    void this.worker.terminate();
    // controller.abort 触发 listener（kill agent subprocess、中止在飞调用）。
    // 一次性语义——已 aborted 的 controller 重复 abort 无副作用。
    this.controller.abort();
  }

  /** 是否已 release（测试 + 诊断用）。 */
  get isReleased(): boolean {
    return this.released;
  }
}
