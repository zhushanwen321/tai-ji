/**
 * [F1] 端到端回归：execute() 返回不可克隆值 → run 收敛到 done,failed（非永久 running 悬挂）。
 *
 * 完整链路（真实 Worker 线程 + 真实 WorkerHostImpl，无 mock worker）：
 *   脚本 return { fn: () => 1 } → postMessage DataCloneError → worker 侧 _safePost 记录 +
 *   F1 fallback 回发可克隆 error 消息 → 主线程 handleScriptError（既有 script-error 重试
 *   矩阵：3 次 rebuild + 指数退避 1s/2s/4s）→ 第 4 次 error 超限 → run done,failed。
 *
 * 修复前：return 消息被静默吞掉 → worker exit(0) → handleWorkerExit(0) no-op → run 永久
 * running、runAndWait 无限挂起（本测试会超时红）。
 *
 * 主线程 belt（exit(0) 无终态消息 → 立即 failed）由 worker-exit-without-result.test.ts
 * handler 级单测覆盖；两条防线共同保证「run 必达终态」不变式。
 *
 * 退避经 TAIJI_SUBAGENT_TEST_RETRY_BACKOFF_BASE_MS=1 压缩到 ms 级（生产默认
 * 1+2+4s 不变）；4 次 worker 启动仍真实发生——per-test timeout 保留 30s headroom。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWorkflow } from "../lifecycle.ts";
import type { LifecycleDeps, RunStore } from "../models/ports.ts";
import type { RunSpec } from "../models/run-spec.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";
import { WorkerHostImpl } from "../worker-host.ts";

/** 轮询直到 run 到达 done 终态或超时（挂起 → 超时红，即「非悬挂」断言本身）。 */
async function waitForTerminal(
  runs: Map<string, WorkflowRun>,
  runId: string,
  timeoutMs: number,
): Promise<WorkflowRun> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = runs.get(runId);
    if (run && run.state.status === "done") return run;
    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} did not reach a terminal state within ${timeoutMs}ms ` +
          `(status=${run?.state.status ?? "unknown"}) — hang regression`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("[F1] 不可克隆 return → run failed（非悬挂）— e2e", () => {
  // 压缩重试矩阵退避（1+2+4s → 1+2+4ms；backoffDelay 调用时读 env，无需在模块
  // 加载前设置）。生产默认不变，见 worker-message-pump RETRY_BACKOFF_BASE_ENV 测试通道。
  beforeEach(() => {
    vi.stubEnv("TAIJI_SUBAGENT_TEST_RETRY_BACKOFF_BASE_MS", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "return { fn: () => 1 } → 经 script-error 重试矩阵收敛到 done,failed，归因含 structured-clone failed",
    async () => {
      const runs = new Map<string, WorkflowRun>();
      const store: RunStore = {
        save: vi.fn(async () => {}),
        loadAll: async () => [],
        stateFilePath: (id: string) => `/tmp/f1-e2e/${id}.jsonl`,
      };
      const deps = {
        store,
        workerHost: new WorkerHostImpl(),
        runner: { run: vi.fn(async () => ({})) },
        runs,
        eventBus: { emit: vi.fn() },
        appendEntry: vi.fn(),
        onRunDone: vi.fn(),
        log: vi.fn(),
      } as unknown as LifecycleDeps & {
        appendEntry: ReturnType<typeof vi.fn>;
        onRunDone: ReturnType<typeof vi.fn>;
      };

      const spec: RunSpec = {
        scriptSource: "return { ok: true, fn: () => 1 };",
        args: {},
        scriptName: "f1-non-cloneable",
        scriptPath: "f1-non-cloneable.js",
        slug: "f1-non-cloneable",
      };

      const runId = await runWorkflow(spec, deps);
      expect(runs.get(runId)?.state.status).toBe("running");

      // 挂起 → 此处超时 throw（修复前行为）；收敛 → done
      const run = await waitForTerminal(runs, runId, 30_000);

      expect(run.state.reason).toBe("failed");
      // worker 侧 fallback 消息经 handleScriptError 超限路径写入归因
      expect(run.state.error).toContain("structured-clone failed");
      // 终态副作用齐全（对比 SW-DATA-3/F1 前的幽灵悬挂：无 unregister / 无 onRunDone）
      expect(deps.appendEntry).toHaveBeenCalledWith(
        "pending:unregister",
        expect.objectContaining({ id: runId, reason: "failed", status: "failed" }),
      );
      expect(deps.onRunDone).toHaveBeenCalledTimes(1);
      // 终态已落盘（F1 不变式的持久化半边：非但收敛，且状态被记录可恢复）
      expect(store.save).toHaveBeenCalled();
      // workerLogs（DataCloneError 详情）随 error 消息落入 errorLogs，诊断不丢
      expect(run.state.errorLogs.length).toBeGreaterThan(0);
    },
    35_000,
  );
});
