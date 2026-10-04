// src/__tests__/scenario-23-phase-statemachine.test.ts
//
// 场景 23（修订设计 §4，D3）：phase 状态机跨续聊。phase1 的同名 agent 在 phase2
// 续聊 → 崩溃 → resume。
//
// 通过标准（原文）：phase1 settled 与 phase2 running 状态折叠正确；续聊绑定保留。
import { describe, expect, it } from "vitest";

import { appendEvents, runCreated } from "./record-mode/helpers.ts";
import { foldRunEventCheckpoint } from "@zhushanwen/subagent-core/orchestration/run-events.ts";

import {
  makeFauxRunner,
  mkScenarioEnv,
  makeScenarioDeps,
  resumeScenarioRun,
  scanScenarioEvents,
  PHASE_CROSS_SCRIPT,
  waitForScenarioSettled,
} from "./record-mode/scenario-kit.ts";

const RUN_ID = "wf-s23-phase";
const T0 = 1_759_000_000_000;

/** 崩溃流：p1 完整（started+settled+phase-settled）+ p2 started（in-flight 续聊）。 */
async function seedPhaseCrashed(env: ReturnType<typeof mkScenarioEnv>): Promise<void> {
  await appendEvents(env, RUN_ID, [
    runCreated({ ts: T0, runId: RUN_ID, scriptSource: PHASE_CROSS_SCRIPT }),
    { type: "phase-started", phase: "p1", ts: T0 + 100 },
    { type: "agent-started", taskIndex: 0, agentName: "shared", attempt: 1, phase: "p1", memberRecordId: "rec-shared-1", ts: T0 + 200 },
    { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 100, result: { content: "p1-result", sessionFile: "/abs/sessions/shared.jsonl" }, ts: T0 + 300 },
    { type: "phase-settled", phase: "p1", ts: T0 + 400 },
    { type: "phase-started", phase: "p2", ts: T0 + 500 },
    { type: "agent-started", taskIndex: 1, agentName: "shared", attempt: 1, phase: "p2", memberRecordId: "rec-shared-1", ts: T0 + 600 },
    { type: "run-interrupted", errorCode: "crashed", reason: "kill in phase2", ts: T0 + 700 },
  ]);
}

describe("场景 23：phase 状态机跨续聊", () => {
  it("崩溃折叠：phase1 settled / phase2 running；resume 后 p2 同名 agent 重派（绑定保留），run completed", async () => {
    const env = mkScenarioEnv("23");
    try {
      await seedPhaseCrashed(env);

      // 崩溃态折叠断言（场景表「状态折叠正确」的时点 = resume 判读时）
      const before = await scanScenarioEvents(env, RUN_ID);
      const foldBefore = foldRunEventCheckpoint(before, () => {});
      const p1 = foldBefore.phases.get("p1")!;
      const p2 = foldBefore.phases.get("p2")!;
      expect(p1.settledAt).toBeDefined(); // phase1 settled
      expect(p2.settledAt).toBeUndefined(); // phase2 running（started 在场、无 settled）
      expect(p2.startedAt).toBeDefined();

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, RUN_ID);
      const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
      expect(summary.reason).toBe("completed");

      // p1 调用回放（零派发）；p2 同名 agent 续聊重派恰一次（绑定保留的编排面：
      // 同名 agent() 绑定同一子代理身份——重派按同名路由）
      expect(sd.faux.dispatches).toHaveLength(1);
      expect(sd.faux.dispatches[0]!.opts["agent"]).toBe("shared");

      // resume 完成后终态折叠：p2 随末 call 落定收束 settled
      const after = await scanScenarioEvents(env, RUN_ID);
      const foldAfter = foldRunEventCheckpoint(after, () => {});
      expect(foldAfter.phases.get("p2")!.settledAt).toBeDefined();
      // 历史绑定帧数据保真（[D6] 绑定字段化承载——崩溃前的 memberRecordId 帧可从流提取）
      const startedFrames = after.filter((e) => e.type === "agent-started");
      expect(startedFrames.some((e) => e.memberRecordId === "rec-shared-1")).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});
