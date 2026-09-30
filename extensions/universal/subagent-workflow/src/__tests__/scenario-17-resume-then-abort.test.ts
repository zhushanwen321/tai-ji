// src/__tests__/scenario-17-resume-then-abort.test.ts
//
// 场景 17（修订设计 §4，L-03）：resume 后 abort。resume 进行中 abort →
// cancelled 终局正常写入；对 cancelled 再 resume 明确拒绝。
import { describe, expect, it } from "vitest";

import { abortRun } from "@zhushanwen/subagent-core/orchestration/lifecycle.ts";
import { ResumeRejectionError } from "@zhushanwen/subagent-core/orchestration/resume-run.ts";

import {
  makeFauxRunner,
  makeScenarioDeps,
  mkScenarioEnv,
  resumeScenarioRun,
  scanScenarioEvents,
  seedCrashedRun,
  THREE_CALL_SERIAL_SCRIPT,
  waitForScenarioSettled,
} from "./record-mode/scenario-kit.ts";

const RUN_ID = "wf-s17-abort";

describe("场景 17：resume 后 abort（cancelled 终局 + 再 resume 拒绝）", () => {
  it("resume 进行中 abort → cancelled 终局正常写入；对 cancelled 再 resume 明确拒绝", async () => {
    const env = mkScenarioEnv("17");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });

      const sd = makeScenarioDeps(env, makeFauxRunner());
      sd.faux.steps.push({ kind: "hang" }); // resume 进行中（C 派发挂起）
      await resumeScenarioRun(env, sd, RUN_ID);
      const deadline = Date.now() + 10_000;
      while (sd.faux.dispatches.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }

      // abort（用户主动终局）
      await abortRun(RUN_ID, sd.deps, "user abort", "aborted");
      const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
      expect(summary.status).toBe("done");

      // cancelled 终局正常写入 record（run-settled outcome=cancelled）
      const events = await scanScenarioEvents(env, RUN_ID);
      const settledFrames = events.filter((e) => e.type === "run-settled");
      expect(settledFrames).toHaveLength(1);
      expect(settledFrames[0]).toMatchObject({ outcome: "cancelled" });

      // 对 cancelled 再 resume：明确拒绝（正常终局一次性）
      await expect(resumeScenarioRun(env, sd, RUN_ID)).rejects.toMatchObject({
        name: "ResumeRejectionError",
        message: expect.stringContaining("only interrupted runs can be resumed"),
      } satisfies Partial<ResumeRejectionError>);
      expect(events.filter((e) => e.type === "run-resumed")).toHaveLength(1); // 无第二条
    } finally {
      env.cleanup();
    }
  });
});
