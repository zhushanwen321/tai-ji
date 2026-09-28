// src/__tests__/scenario-20-nested-false-positive.test.ts
//
// 场景 20（修订设计 §4，D13）：嵌套误报拒绝。脚本注释含 `workflow(` 字样 →
// resume → 拒绝 + Recovery 指引，不崩不挂（保守方向：误报即拒绝）。
import { describe, expect, it } from "vitest";

import { ResumeRejectionError } from "@zhushanwen/subagent-core/orchestration/resume-run.ts";

import { makeFauxRunner, makeScenarioDeps, mkScenarioEnv, resumeScenarioRun, scanScenarioEvents, seedCrashedRun } from "./record-mode/scenario-kit.ts";

const RUN_ID = "wf-s20-nested";

const SCRIPT_WITH_COMMENTED_WORKFLOW =
  "// legacy: this used to call workflow('child-flow') before flattening\nconst a = await agent('A');\nreturn a;";

describe("场景 20：嵌套误报拒绝（词法命中即保守拒绝）", () => {
  it("脚本注释含 workflow( 字样 → resume 拒绝 + Recovery 指引；record 无 run-resumed、无派发、无异常逃逸", async () => {
    const env = mkScenarioEnv("20");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: SCRIPT_WITH_COMMENTED_WORKFLOW,
        settled: [{ agent: "A" }],
        inflight: [{ agent: "B" }],
      });

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await expect(resumeScenarioRun(env, sd, RUN_ID)).rejects.toMatchObject({
        name: "ResumeRejectionError",
        message: expect.stringMatching(/nested 'workflow\(' call.*Recovery:/s),
      } satisfies Partial<ResumeRejectionError>);

      const events = await scanScenarioEvents(env, RUN_ID);
      expect(events.some((e) => e.type === "run-resumed")).toBe(false);
      expect(sd.faux.dispatches).toHaveLength(0);
    } finally {
      env.cleanup();
    }
  });
});
