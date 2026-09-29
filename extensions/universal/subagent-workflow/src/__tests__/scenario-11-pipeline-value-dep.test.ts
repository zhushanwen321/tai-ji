// src/__tests__/scenario-11-pipeline-value-dep.test.ts
//
// 场景 11（修订设计 §4，F-03）：pipeline 值依赖。stage2 拼 stage1 result，
// stage1 完成后崩溃 → resume。
//
// 通过标准（原文）：stage1 回放（历史结果）→ stage2 输入一致 → 正常完成。
import { describe, expect, it } from "vitest";

import {
  makeFauxRunner,
  makeScenarioDeps,
  mkScenarioEnv,
  PIPELINE_VALUE_SCRIPT,
  resumeScenarioRun,
  seedCrashedRun,
  waitForScenarioSettled,
} from "./record-mode/scenario-kit.ts";

const RUN_ID = "wf-s11-pipeline";
const STAGE1_CONTENT = "stage-1 canonical output #42";

describe("场景 11：pipeline 值依赖——回放的历史结果真实进入下游输入", () => {
  it("stage1 回放后 stage2 的派发输入含 stage1 历史 result 全文（输入一致），run completed", async () => {
    const env = mkScenarioEnv("11");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: PIPELINE_VALUE_SCRIPT,
        settled: [{ agent: "stage1", result: { content: STAGE1_CONTENT } }],
        inflight: [{ agent: "stage2" }],
      });

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, RUN_ID);
      const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
      expect(summary.reason).toBe("completed");

      // stage1 零派发（回放）；stage2 恰一次，且 prompt 拼的是回放的 stage1 历史结果
      expect(sd.faux.dispatches).toHaveLength(1);
      expect(sd.faux.dispatches[0]!.opts["agent"]).toBe("stage2");
      expect(String(sd.faux.dispatches[0]!.opts["prompt"])).toContain(STAGE1_CONTENT);
    } finally {
      env.cleanup();
    }
  });
});
