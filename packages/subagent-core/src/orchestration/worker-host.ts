/**
 * Workflow Extension — Worker Host
 *
 * WorkerHost port 的 Infra 实现。
 *
 * 职责：启动一个 Worker thread 运行 workflow 脚本，返回 WorkerHandle，
 * 并把 worker 的 message/error/exit 事件绑定到调用方注入的 WorkerHandlers。
 *
 * 层归属：Infra（D-12）。implements Engine 层的 WorkerHost port。
 *
 * 设计：
 * - WorkerHostImpl implements WorkerHost（而非散落的 free function）。
 * - 返回 WorkerHandle（封装），而非裸 Worker——onExit 传 handle 给
 * handlers.onExit(code, handle)，调用方用 handle.isCurrent 做竞态防护（C.3 + G-025）。
 * - eval:true + 内联 buildWorkerScript 源码字符串（C.2：不用不存在的 bootstrap 文件）。
 * - workerData: { scriptPath, args, workspace, meta }（不含 callCache/budget——
 * 这些是 RunState 字段，由 lifecycle 在调用 start 前注入到 args 或独立处理）。
 * - temp file 清理逻辑移到 Engine lifecycle，本处不管。
 */

import { Worker } from "node:worker_threads";

import type { WorkerHandlers, WorkerHost } from "./models/ports.ts";
import type { RunSpec } from "./models/run-spec.ts";
import { WorkerHandle } from "./worker-handle.ts";
import { buildWorkerScript } from "./worker-script-builder.ts";

// ── WorkerHostImpl ───────────────────────────────────────────

export class WorkerHostImpl implements WorkerHost {
  /**
 * 启动一个 Worker thread 运行 workflow 脚本。
 *
 * 1. 用 buildWorkerScript(spec.scriptSource) 包装用户脚本（注入 agent/parallel/
 * pipeline/$ARGS/$BUDGET 等全局，AC-4 格式契约由 buildWorkerScript 保证）
 * 2. new Worker(code, { eval: true, workerData })（C.2 修复：eval 内联源码，
 * 不 require bootstrap 文件）
 * 3. 包装为 WorkerHandle，绑定 onMessage/onError/onExit 回调到 handlers
 * 4. onExit 传 handle 给 handlers.onExit(code, handle)（C.3 修复——调用方用
 * handle.isCurrent 做竞态防护，G-025）
 *
 * 返回的 WorkerHandle 由调用方（lifecycle）保存到 RunRuntime.worker。
 * 终止/崩溃重建（rebuild）时由 RunRuntime.release 接管。
 */
  start(
    spec: RunSpec,
    args: Record<string, unknown>,
    handlers: WorkerHandlers,
  ): WorkerHandle {
    const workerCode = buildWorkerScript(spec.scriptSource);

    const worker = new Worker(workerCode, {
      eval: true,
      workerData: {
        scriptPath: spec.scriptPath,
        args,
        workspace: process.cwd(),
        meta: {
          name: spec.scriptName,
          description: spec.description,
        },
        // D-12 regression fix (round-2 #1)：注入 budget，否则 worker 内 $BUDGET.total 恒为 0。
        // 旧 agent-call-handler.ts 删除时同时丢失了 budget 注入和 budget-update 发送方，
        // 导致依赖 $BUDGET 做动态预算分支的脚本静默得到全 0。
        budget: {
          maxTokens: spec.budgetTokens,
          usedTokens: 0,
          usedCost: 0,
        },
        // Option B symmetric single-path: model/thinkingLevel flow through
        // workerData → $MODEL/$THINKING_LEVEL worker globals (injected by
        // worker-script-builder) → agent() fallback. Not merged into args.
        model: spec.model,
        thinkingLevel: spec.thinkingLevel,
      },
    });

    const handle = new WorkerHandle(worker);

    // 绑定事件——WorkerHandle 内部用 isCurrent 守卫，terminate 后回调 no-op（G-025）。
    // handlers 的 onMessage/onError/onExit 都是 async，这里 void 掉 promise（worker 事件
    // 不能 await，且 handler 内部错误由 lifecycle 统一捕获）。
    handle.onMessage((raw) => {
      void handlers.onMessage(raw);
    });
    handle.onError((err) => {
      void handlers.onError(err);
    });
    handle.onExit((code) => {
      // C.3 修复：传 handle 给 onExit，调用方用 handle.isCurrent 做竞态防护。
      // 注意：此时 handle.isCurrent 仍为 true（onExit 回调仅在 isCurrent 时触发，
      // WorkerHandle 的内部守卫已过滤掉 terminate 后的 stale exit）。
      void handlers.onExit(code, handle);
    });

    return handle;
  }
}
