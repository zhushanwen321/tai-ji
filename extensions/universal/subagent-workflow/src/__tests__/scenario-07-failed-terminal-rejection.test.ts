// src/__tests__/scenario-07-failed-terminal-rejection.test.ts
//
// 场景 7（修订设计 §4，E-05）：failed 终局拒绝。对正常 failed 终局的 run 发
// resume → 拒绝 + 「仅中断可续跑」；record 无 run-resumed。
import { describe, expect, it } from "vitest";

import { ResumeRejectionError } from "@zhushanwen/subagent-core/orchestration/resume-run.ts";

import { appendEvents, askDispatched, askSettled, mkRecordEnv, runCreated, runSettled } from "./record-mode/helpers.ts";
import { makeFauxRunner, makeScenarioDeps, resumeScenarioRun, scanScenarioEvents } from "./record-mode/scenario-kit.ts";

const RUN_ID = "wf-s7-failed";

describe("场景 7：failed 终局拒绝", () => {
  it("对 failed 终局 run 发 resume → 明确拒绝（仅中断可续跑），record 无 run-resumed、无新派发", async () => {
    const env = mkRecordEnv("scenario-07");
    try {
      await appendEvents(env, RUN_ID, [
        runCreated({ ts: 1_759_000_000_000, runId: RUN_ID, scriptSource: "await agent('x');" }),
        askDispatched({ ts: 1_759_000_000_100, taskIndex: 0, agentName: "x" }),
        askSettled({ ts: 1_759_000_000_200, taskIndex: 0, outcome: "failed", errorCode: "unknown", result: { content: "", error: "boom" } }),
        runSettled({ ts: 1_759_000_000_300, outcome: "failed", reason: "boom" }),
      ]);

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await expect(resumeScenarioRun(env, sd, RUN_ID)).rejects.toMatchObject({
        name: "ResumeRejectionError",
        message: expect.stringContaining("only interrupted runs can be resumed"),
      } satisfies Partial<ResumeRejectionError>);

      const events = await scanScenarioEvents(env, RUN_ID);
      expect(events.some((e) => e.type === "run-resumed")).toBe(false);
      expect(sd.faux.dispatches).toHaveLength(0);
    } finally {
      env.cleanup();
    }
  });
});
