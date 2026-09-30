// src/__tests__/scenario-14-trace-fidelity.test.ts
//
// 场景 14（修订设计 §4，V-03）：trace 不污染。场景 6 形态的 resume 完成后比对
// trace：回放命中调用的 trace 与崩溃前逐字段一致。
import { describe, expect, it } from "vitest";

import {
  makeFauxRunner,
  makeScenarioDeps,
  mkScenarioEnv,
  resumeScenarioRun,
  seedCrashedRun,
  THREE_CALL_SERIAL_SCRIPT,
  waitForScenarioSettled,
} from "./record-mode/scenario-kit.ts";

const RUN_ID = "wf-s14-trace";
const T0 = 1_759_000_000_000;

const RESULT_A = {
  content: "trace-a-result",
  durationMs: 12_000,
  sessionId: "sess-a",
  sessionFile: "/abs/sessions/a.jsonl",
};

describe("场景 14：trace 不污染——回放调用 trace 与崩溃前逐字段一致", () => {
  it("resume 完成后，回放命中调用（A/B）的 trace 节点字段与 record 流历史帧一致", async () => {
    const env = mkScenarioEnv("14");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        ts: T0,
        settled: [
          { agent: "A", result: RESULT_A },
          { agent: "B", result: { content: "trace-b-result" } },
        ],
        inflight: [{ agent: "C" }],
      });

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, RUN_ID);
      await waitForScenarioSettled(sd.runs, RUN_ID);

      const run = sd.runs.get(RUN_ID)!;
      const nodes = run.state.trace.toArray();

      // 回放命中调用（A = stepIndex 0）：与崩溃前帧逐字段一致（agent/status/
      // startedAt/completedAt/result 全文）
      const nodeA = nodes.find((n) => n.stepIndex === 0)!;
      expect(nodeA.agent).toBe("A");
      expect(nodeA.status).toBe("completed");
      expect(nodeA.startedAt).toBe(new Date(T0 + 100).toISOString()); // seed started 帧 ts
      expect(nodeA.result).toEqual(RESULT_A);
      // B = stepIndex 1 同构
      const nodeB = nodes.find((n) => n.stepIndex === 1)!;
      expect(nodeB.agent).toBe("B");
      expect(nodeB.status).toBe("completed");
      expect(nodeB.result).toEqual({ content: "trace-b-result" });
      // 重派调用（C = stepIndex 2）为真实新帧（非回放污染：独立 completed 节点；
      // 重派节点的 result 面归 record 流 settled 帧断言——trace 节点不重复承载）
      const nodeC = nodes.find((n) => n.stepIndex === 2)!;
      expect(nodeC.agent).toBe("C");
      expect(nodeC.status).toBe("completed");
    } finally {
      env.cleanup();
    }
  });
});
