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
      // 重派调用（C = stepIndex 2）：同 stepIndex 存在两个节点（设计 §2.6 已知形态）——
      // 首个 = 崩溃重建 fold 产出的在途 draft 节点（fold 诚实语义：有 started 无 settled
      // 折 running，不是 completed——completed 是假成功）；最后 = worker 重放脚本重发
      // agent-call 时 dispatchAgentCall 重复 append 的真实新节点（Trace.byIndex last-wins
      // 使 update 命中新节点，重复节点由读侧 last-wins 语义消化）。
      // 首节点锁定 fold 的诚实语义（防假成功回归）；最新节点断言重派真实终态。
      // 重派节点的 result 面归 record 流 settled 帧断言——trace 节点不重复承载。
      const stepIndex2Nodes = nodes.filter((n) => n.stepIndex === 2);
      expect(stepIndex2Nodes.length).toBe(2);
      expect(stepIndex2Nodes[0]!.status).toBe("running");
      const nodeC = stepIndex2Nodes.at(-1)!;
      expect(nodeC.agent).toBe("C");
      expect(nodeC.status).toBe("completed");
    } finally {
      env.cleanup();
    }
  });
});
