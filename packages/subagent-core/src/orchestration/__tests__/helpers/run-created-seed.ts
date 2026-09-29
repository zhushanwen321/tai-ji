// src/orchestration/__tests__/helpers/run-created-seed.ts
//
// [W2/V1] 测试侧六态机引导 helper：journal 首帧（run-created）落账。
//
// 背景：两态机活体写点退役后（W2/V1 D1），活体终局入口（finalizeRun / abortRun /
// budget coda 等）的终局裁决唯一经六态机 dispatch 链——run-settled 对 created 态
// 是表外转移 fail-fast。生产链路中 runWorkflow 必先 dispatchRunCreated（journal
// 首帧 + liveRunStates seed），终局投递经 per-run 队列天然排在其后；直测终局入口
// 的用例须经本 helper 补齐同一引导（vitest 无注入防线 = NoopRunEventJournal，
// append 零写但 liveRunStates 推进正常——状态机裁决与 journal 写面解耦）。

import type { WorkflowRun } from "../../models/workflow-run.ts";
import { dispatchRunCreated } from "../../terminal-actions.ts";

/** 引导 run 的六态机到 dispatched（run-created 首帧落账；await 确保队列任务
 *  已执行——后续 finalizeRun 的终局投递在 liveRunStates 命中非 terminal 态）。 */
export async function seedRunCreated(run: WorkflowRun): Promise<void> {
  await dispatchRunCreated(run);
}
