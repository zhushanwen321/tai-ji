// src/orchestration/__tests__/helpers/replay-call-assert.ts
//
// resume 域测试共享断言：回放集 AgentCall 条目语义（resume-orchestration.test.ts /
// resume-run-rebuild.test.ts 两文件公共形态的收敛单点）。
//
// 语义锚（workflow-run-resume 重建规则）：回放集（resume 重放已完成成员）的 calls
// 条目 = done + result 全文；重派集（中断点后的成员，worker 重跑到断点处重新派发）
// 不建条目。

import { expect } from "vitest";

import type { WorkflowRun } from "../../models/workflow-run.ts";

/** 回放集/重派集 call 条目共享断言：replayedIndex（缺省 0）= done + result 全文；
 *  reDispatchIndex（缺省 1）不建条目。 */
export function expectReplayedCallEntry(
  calls: WorkflowRun["state"]["calls"],
  opts: { replayedIndex?: number; result?: string; reDispatchIndex?: number } = {},
): void {
  const replayed = calls.get(opts.replayedIndex ?? 0);
  expect(replayed?.status).toBe("done");
  expect(replayed?.result?.content).toBe(opts.result ?? "result-0");
  expect(calls.has(opts.reDispatchIndex ?? 1)).toBe(false);
}
