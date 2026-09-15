/**
 * Workflow Extension — Worker Handle
 *
 * node:worker_threads.Worker 的线程句柄封装。技术资源，Infra 层具体类（D-12）。
 * RunRuntime 直接持有，不经 interface（§domain-models 9）。
 *
 * 核心职责：竞态防护（G-025）。
 *
 * 背景：一个 run 可经历多个 WorkerHandle（终止/重试各换一个）。
 * 需防止「terminate(old) → start(new) → old exit fires」竞态——
 * WorkerHandle 把守卫内化：terminate 后 isCurrent=false，
 * 已终止 handle 的 onMessage/onError/onExit 回调自动 no-op（无需调用方比对引用）。
 *
 * 层归属：Infra（D-12）。仅依赖 node:worker_threads（Node 原生）。
 */

import { type Worker } from "node:worker_threads";

// ── Handler signatures ───────────────────────────────────────

/** Worker → Main 业务消息回调。 */
export type WorkerMessageHandler = (raw: unknown) => void;
/** Worker 线程 uncaught error 回调。 */
export type WorkerErrorHandler = (err: Error) => void;
/** Worker 线程 exit 回调（code=0 正常退出，非 0 崩溃）。 */
export type WorkerExitHandler = (code: number) => void;

// ── WorkerHandle ──────────────────────────────────────────────

export class WorkerHandle {
  private readonly worker: Worker;
  /**
 * 竞态守卫。true = 此 handle 仍是当前活动 handle；false = 已 terminate，
 * 后续事件（已终止 worker 延迟触发的 message/error/exit）必须忽略。
 *
 * 终止后置 false 并永不回升（幂等语义）。新 handle 由调用方（WorkerHost）
 * 重新创建，已终止 handle 留在内存里直到 GC，但其回调全部 no-op。
 */
  private current = true;

  constructor(worker: Worker) {
    this.worker = worker;
  }

  /** 此 handle 是否仍是当前活动 handle（terminate 后 false，G-025）。 */
  get isCurrent(): boolean {
    return this.current;
  }

  /** 底层 Worker（WorkerHost/RunRuntime 偶尔需要直接访问，如 ref/href）。 */
  get raw(): Worker {
    return this.worker;
  }

  /**
 * 向 worker 发送消息。terminate 后 no-op（已终止 handle 的 postMessage 无意义）。
 */
  postMessage(msg: unknown): void {
    if (!this.current) return;
    this.worker.postMessage(msg);
  }

  /**
 * 终止 worker 线程。幂等——重复调用安全，第二次起 no-op。
 * 置 isCurrent=false 后再 await worker.terminate，确保并发 exit 事件
 * 在 terminate resolve 之前到达时也被守卫拦下。
 */
  async terminate(): Promise<void> {
    if (!this.current) return;
    this.current = false;
    try {
      await this.worker.terminate();
    } catch (err) {
      // terminate 失败不阻断（worker 可能已退出）。current 已 false，安全。
      // 不向上抛——调用方（RunRuntime.release）不应被底层线程错误打断。
      void err;
    }
  }

  /**
 * 绑定 message 回调。仅当 isCurrent 时触发——已终止 handle 的事件被吞掉。
 * 返回 this 便于链式 onMessage(...).onError(...).onExit(...)。
 */
  onMessage(handler: WorkerMessageHandler): this {
    this.worker.on("message", (raw: unknown) => {
      if (!this.current) return;
      handler(raw);
    });
    return this;
  }

  /**
 * 绑定 error 回调。仅当 isCurrent 时触发。
 */
  onError(handler: WorkerErrorHandler): this {
    this.worker.on("error", (err: Error) => {
      if (!this.current) return;
      handler(err);
    });
    return this;
  }

  /**
 * 绑定 exit 回调。仅当 isCurrent 时触发——这是 G-025 的关键守卫：
 * terminate(old) → startWorker(new) → old exit 触发时，old handle.current
 * 已为 false，回调 no-op，不会误删 new worker。
 */
  onExit(handler: WorkerExitHandler): this {
    this.worker.on("exit", (code: number) => {
      if (!this.current) return;
      handler(code);
    });
    return this;
  }
}
