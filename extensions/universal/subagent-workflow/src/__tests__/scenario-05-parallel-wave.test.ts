// src/__tests__/scenario-05-parallel-wave.test.ts
//
// 场景 5（机制文档 §4 场景 5，经修订设计 §4 继承行）：并行波次负面验证（D5）。
// parallel() 发 4 个并行调用，2 个完成、2 个在途时崩溃 → 收编 → resume。
//
// 通过标准（原文）：完成的 2 个零派发回放；在途的 2 个各被重派恰一次（不多不少
// ——验证丢弃重派不重不漏）；run completed；重放阶段无「同一 callId 的成功结果
// 被重复写入记录」。
import { describe, expect, it } from "vitest";

import {
  makeFauxRunner,
  makeScenarioDeps,
  mkScenarioEnv,
  PARALLEL_FOUR_SCRIPT,
  resumeScenarioRun,
  scanScenarioEvents,
  seedCrashedRun,
  waitForScenarioSettled,
} from "./record-mode/scenario-kit.ts";

const RUN_ID = "wf-s5-parallel";

describe("场景 5：并行波次——在途丢弃重派不重不漏", () => {
  it("完成的 2 个零派发回放；在途 2 个各重派恰一次；run completed；无重复成功写入", async () => {
    const env = mkScenarioEnv("05");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: PARALLEL_FOUR_SCRIPT,
        settled: [
          { agent: "P1", result: { content: "p1-out" } },
          { agent: "P2", result: { content: "p2-out" } },
        ],
        inflight: [{ agent: "P3" }, { agent: "P4" }],
      });

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, RUN_ID);
      const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
      expect(summary.status).toBe("done");
      expect(summary.reason).toBe("completed");

      // P1/P2 零派发；P3/P4 各恰一次（并行波次按 callId 各自 miss → 各派发一次）
      expect(sd.faux.dispatches).toHaveLength(2);
      const dispatched = sd.faux.dispatches.map((d) => d.opts["agent"]).sort();
      expect(dispatched).toEqual(["P3", "P4"]);

      // 同一 callId 的成功结果不被重复写入：settled 帧每 taskIndex 恰一条
      const events = await scanScenarioEvents(env, RUN_ID);
      const settledCount = new Map<number, number>();
      for (const e of events) {
        if (e.type === "agent-settled") settledCount.set(e.taskIndex, (settledCount.get(e.taskIndex) ?? 0) + 1);
      }
      expect(settledCount.size).toBe(4);
      expect([...settledCount.values()].every((n) => n === 1)).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});
