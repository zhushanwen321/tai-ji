// src/__tests__/scenario-16-cross-day-budget.test.ts
//
// 场景 16（修订设计 §4，L-02 / D10）：跨天时间预算。跑 40min 后 kill，推进系统
// 时间 2 天，再 resume。
//
// 通过标准（原文）：不被秒拒；已耗 ≈40min；继续跑到终局。
//
// 时间注入：record 帧 ts 构造 40min 活跃段（T0 → T0+40min）；resume 的 now
// 注入 = T0 + 2 天（搁置期不计）；budgetTimeMs = 50min。若误用 startedAt 墙钟
// （2 天 > 50min 预算）resume 会被秒拒——本场景的判别点。
import { describe, expect, it } from "vitest";

import { appendEvents, askDispatched, askSettled, runCreated } from "./record-mode/helpers.ts";
import {
  makeFauxRunner,
  mkScenarioEnv,
  makeScenarioDeps,
  resumeScenarioRun,
  THREE_CALL_SERIAL_SCRIPT,
  waitForScenarioSettled,
} from "./record-mode/scenario-kit.ts";

const RUN_ID = "wf-s16-crossday";
const T0 = 1_759_000_000_000;
const MIN = 60_000;
const ACTIVE_40MIN = 40 * MIN;

describe("场景 16：跨天时间预算（搁置不计，活跃已耗不退）", () => {
  it("40min 活跃后中断、推进 2 天再 resume：不秒拒，剩余预算按 50min−40min 折算，跑完终局", async () => {
    const env = mkScenarioEnv("16");
    try {
      // 手写 40min 活跃段的崩溃流（seedCrashedRun 的 ts 是紧凑递增，这里需要真实跨度）
      await appendEvents(env, RUN_ID, [
        runCreated({ ts: T0, runId: RUN_ID, scriptSource: THREE_CALL_SERIAL_SCRIPT }),
        askDispatched({ ts: T0 + 1000, taskIndex: 0, agentName: "A" }),
        askSettled({ ts: T0 + ACTIVE_40MIN, taskIndex: 0, outcome: "done", durationMs: ACTIVE_40MIN, result: { content: "a" } }),
        askDispatched({ ts: T0 + ACTIVE_40MIN + 100, taskIndex: 1, agentName: "B" }),
        { type: "run-interrupted", errorCode: "crashed", reason: "kill after 40min", ts: T0 + ACTIVE_40MIN + 200 },
      ]);

      const sd = makeScenarioDeps(env, makeFauxRunner());
      const twoDaysLater = T0 + 2 * 24 * 60 * MIN;
      // 不被秒拒（startedAt 墙钟误算 = 2 天 > 50min 预算必拒——D10 活跃段算式的判别点）
      await resumeScenarioRun(env, sd, RUN_ID, {
        now: () => twoDaysLater,
        budgetTimeMs: 50 * MIN,
      });

      // 已耗 ≈40min：剩余预算 = 50min − 40min 活跃 −（resume 段内已跑 ≈0）
      expect(sd.budgetSchedules).toHaveLength(1);
      const scheduledMs = sd.budgetSchedules[0]!.ms;
      expect(scheduledMs).toBeGreaterThan(9 * MIN);
      expect(scheduledMs).toBeLessThanOrEqual(10 * MIN);

      // 继续跑到终局
      const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
      expect(summary.reason).toBe("completed");
      // A 回放零 token；B/C 真实派发
      expect(sd.faux.dispatches.map((d) => d.opts["agent"])).toEqual(["B", "C"]);
    } finally {
      env.cleanup();
    }
  });
});
