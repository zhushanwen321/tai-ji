// scenario-merged.test.ts —— subagent-workflow C09 簇合并产物（round5-G）。
// 共同被测业务模块：`core:@zhushanwen/subagent-core/orchestration/run-events.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/scenario-12-session-switch-keepalive.test.ts（1 用例，skip 0）
//   - src/__tests__/scenario-23-phase-statemachine.test.ts（1 用例，skip 0）

import { describe, expect, it } from 'vitest'
import { terminateRunningRuns } from '@zhushanwen/subagent-core/orchestration/lifecycle.ts'
import { foldRunEventFrames, foldRunEventCheckpoint } from '@zhushanwen/subagent-core/orchestration/run-events.ts'
import { makeFauxRunner, makeScenarioDeps, mkScenarioEnv, resumeScenarioRun, scanScenarioEvents, seedCrashedRun, THREE_CALL_SERIAL_SCRIPT, waitForScenarioSettled, PHASE_CROSS_SCRIPT } from './record-mode/scenario-kit.ts'
import { appendEvents, runCreated } from './record-mode/helpers.ts'

// ======== 来源：scenario-12-session-switch-keepalive.test.ts ========
describe("scenario-12-session-switch-keepalive", () => {
  const RUN_ID = "wf-s12-keepalive";

  describe("场景 12：session 切换保活（terminate 分叉 → interrupted 可再续）", () => {
    it("resume 接管中切 session：run-interrupted(terminated) 而非 failed 终局；二次 resume 续跑完成", async () => {
      const env = mkScenarioEnv("12");
      try {
        await seedCrashedRun(env, RUN_ID, {
          scriptSource: THREE_CALL_SERIAL_SCRIPT,
          settled: [{ agent: "A" }, { agent: "B" }],
          inflight: [{ agent: "C" }],
        });

        const sd = makeScenarioDeps(env, makeFauxRunner());
        sd.faux.steps.push({ kind: "hang" }); // C 派发阶段（terminate 落点）
        await resumeScenarioRun(env, sd, RUN_ID);
        const deadline = Date.now() + 10_000;
        while (sd.faux.dispatches.length < 1 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5));
        }
        expect(sd.faux.dispatches).toHaveLength(1);

        // 切 session（terminate 链——[D11] 统一中断）
        await terminateRunningRuns(sd.deps, "session switched by user");

        // run 为 interrupted 态（非 failed）：转移帧在场、无 failed 终局帧、fold interrupted
        const events = await scanScenarioEvents(env, RUN_ID);
        const interruptedFrames = events.filter((e) => e.type === "run-interrupted");
        expect(interruptedFrames).toHaveLength(2); // 崩溃收编 + terminate 中断
        expect(interruptedFrames[1]).toMatchObject({ errorCode: "terminated" });
        expect(events.some((e) => e.type === "run-settled")).toBe(false);
        expect(foldRunEventFrames(events, () => {}).lifecycle).toBe("interrupted");

        // 回原 session 再 resume：成功续跑（同进程——活体注册表连贯）
        await resumeScenarioRun(env, sd, RUN_ID);
        const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
        expect(summary.reason).toBe("completed");

        // C 重派恰一次成功（terminate 时在途派发被丢弃）
        expect(sd.faux.dispatches).toHaveLength(2);
        expect(sd.faux.dispatches[1]!.opts["agent"]).toBe("C");
      } finally {
        env.cleanup();
      }
    });
  });
});

// ======== 来源：scenario-23-phase-statemachine.test.ts ========
describe("scenario-23-phase-statemachine", () => {
  const RUN_ID = "wf-s23-phase";

  const T0 = 1_759_000_000_000;

  /** 崩溃流：p1 完整（started+settled+phase-settled）+ p2 started（in-flight 续聊）。 */
  async function seedPhaseCrashed(env: ReturnType<typeof mkScenarioEnv>): Promise<void> {
    await appendEvents(env, RUN_ID, [
      runCreated({ ts: T0, runId: RUN_ID, scriptSource: PHASE_CROSS_SCRIPT }),
      { type: "phase-started", phase: "p1", ts: T0 + 100 },
      { type: "agent-started", taskIndex: 0, agentName: "shared", attempt: 1, phase: "p1", memberRecordId: "rec-shared-1", ts: T0 + 200 },
      { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 100, result: { content: "p1-content", sessionFile: "/abs/sessions/shared.jsonl" }, ts: T0 + 300 },
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

        // p1 调用回放（零派发）；p2 同名 agent 续聊重派恰一次（绑定保留的编排侧：
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
});
