// run-failure-worktree-cleanup.test.ts —— [W3 契约变更⑤] run 期失败清理前置副作用的
// 链路锚定单测。
//
// 设计权威源：docs/design/subagent-engine-protocolization.md §3.3 能力位段（manifest
// 多声明 → initialize 发现 → engine_capability_mismatch 该 run 失败 + record 标 failed
// + **清理 run 前已建的前置副作用**）；impl-plan §2.3 契约变更⑤。
//
// 链路事实（2026-09-09 grep/read 实测，W3 以测试锚定防后续单元破坏）：
//   executeViaEngine（worktree 创建，record.worktreeHandle 绑定）
//     → kickOffEngineRun → runEngineTask catch（engine.run prepare 期 reject，含协议
//       握手 engine_capability_mismatch 形态）
//     → finalizeFailed（CAS tryTransition closed/gc 抢到锁）
//     → finalizeRecord → doFinalizeRecord Step 3b cleanupWorktreeIfBound
//     → worktreeManager.cleanup(record.worktreeHandle)。
//   前置副作用唯一实体 = worktree（并发池槽在 kickOffEngineRun finally 自回收；journal
//   是宿主②级数据源不清理）。本文件直接锚定执行体 doFinalizeRecord 的 worktree 清理
//   行为——subagent-service.finalizeFailed 的 JSDoc 为链路登记处。

import { describe, expect, it, vi } from "vitest";

import { doFinalizeRecord, type FinalizeDeps } from "../../finalize-record.ts";
import type { AgentResult, ExecutionRecord, WorktreeHandle } from "../../types.ts";

/** 最小 record（worktree 绑定可注入；status running 供终态迁移）。 */
function makeRecord(worktreeHandle?: WorktreeHandle): ExecutionRecord {
  return {
    id: "sa-w3-cleanup",
    agent: "tester",
    model: "prov/model",
    task: "t",
    status: "running",
    mode: "background",
    startedAt: Date.now(),
    turnCount: 0,
    chatMode: false,
    ...(worktreeHandle !== undefined ? { worktreeHandle } : {}),
  } as unknown as ExecutionRecord;
}

function makeDeps(cleanup: ReturnType<typeof vi.fn>): FinalizeDeps {
  return {
    worktreeManager: { cleanup } as unknown as FinalizeDeps["worktreeManager"],
    store: { archive: vi.fn() } as unknown as FinalizeDeps["store"],
    modelService: { getAgentDir: () => "/tmp/w3-test-agentdir" } as unknown as FinalizeDeps["modelService"],
    pi: null,
    emitUnregister: vi.fn(),
  };
}

describe("契约⑤：run 期失败路径清理前置副作用（worktree）", () => {
  it("record.worktreeHandle 绑定：doFinalizeRecord（finalizeFailed 执行体）调用 worktreeManager.cleanup 且传入原 handle", async () => {
    const handle: WorktreeHandle = Object.freeze({
      path: "/tmp/w3-test-worktree",
      branch: "pi-sub-sa-w3-cleanup",
      baseCommit: "deadbeef",
      mainCwd: "/tmp/w3-test-repo",
    });
    const cleanup = vi.fn(async () => undefined);
    const record = makeRecord(handle);
    await doFinalizeRecord(makeDeps(cleanup), record, { success: false } as AgentResult, "closed", "gc");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(handle);
  });

  it("无 worktree 绑定：cleanup 不被调（幂等守卫——非 worktree 任务零清理副作用）", async () => {
    const cleanup = vi.fn(async () => undefined);
    const record = makeRecord(undefined);
    await doFinalizeRecord(makeDeps(cleanup), record, { success: false } as AgentResult, "closed", "gc");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("cleanup 抛错不阻断收尾链（best-effort：manifest/emitUnregister 仍执行）", async () => {
    const handle: WorktreeHandle = Object.freeze({
      path: "/tmp/w3-test-worktree",
      branch: "pi-sub-sa-w3-cleanup",
      baseCommit: "deadbeef",
      mainCwd: "/tmp/w3-test-repo",
    });
    const emitUnregister = vi.fn();
    const cleanup = vi.fn(async () => {
      throw new Error("git worktree remove failed (simulated)");
    });
    const record = makeRecord(handle);
    await doFinalizeRecord(
      { ...makeDeps(cleanup), emitUnregister },
      record,
      { success: false } as AgentResult,
      "closed",
      "gc",
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(emitUnregister).toHaveBeenCalledWith("sa-w3-cleanup", "closed");
  });
});
