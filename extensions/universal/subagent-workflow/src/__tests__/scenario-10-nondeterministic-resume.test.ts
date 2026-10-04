// src/__tests__/scenario-10-nondeterministic-resume.test.ts
//
// 场景 10（修订设计 §4，I-04）：断点后非确定性可续跑。第 3 起含 Date.now() 的
// 脚本（非确定性来源在脚本逻辑层，不进 agent prompt）第 2 调用后崩溃 → resume。
//
// 通过标准（原文）：前 2 回放零 token，第 3+ 真实派发，run completed。
// 档位真实性随场景 22 真机冒烟覆盖；本场景编排/缓存断言用替身（任务书 §2）。
import { describe, expect, it } from "vitest";

import {
  makeFauxRunner,
  makeScenarioDeps,
  mkScenarioEnv,
  NONDET_LOGIC_SCRIPT,
  resumeScenarioRun,
  seedCrashedRun,
  waitForScenarioSettled,
} from "./record-mode/scenario-kit.ts";

const RUN_ID = "wf-s10-nondet";

describe("场景 10：断点后非确定性可续跑（Date.now 在脚本逻辑层）", () => {
  it("前 2 回放零 token，第 3 真实派发，run completed", async () => {
    const env = mkScenarioEnv("10");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: NONDET_LOGIC_SCRIPT,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, RUN_ID);
      const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
      expect(summary.status).toBe("done");
      expect(summary.reason).toBe("completed");

      // 前 2 回放零 token（无新派发）；第 3 真实派发恰一次
      expect(sd.faux.dispatches).toHaveLength(1);
      expect(sd.faux.dispatches[0]!.opts["agent"]).toBe("C");
    } finally {
      env.cleanup();
    }
  });
});
