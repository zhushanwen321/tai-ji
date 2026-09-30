// src/__tests__/scenario-13-schema-hash-stability.test.ts
//
// 场景 13（修订设计 §4，I-07）：schema 哈希稳定。schema 模式调用的 run 崩溃 →
// resume → 回放全命中，零误报 mismatch（canonical JSON 往返稳定）。
//
// 断言依据（worker-message-pump detectReplayInputMismatch 的「零误报」约束——
// 场景 13 命名约束点）：resume 重建的回放命中不产生 input mismatch failed 终局。
import { describe, expect, it } from "vitest";

import {
  makeFauxRunner,
  makeScenarioDeps,
  mkScenarioEnv,
  resumeScenarioRun,
  SCHEMA_CALL_SCRIPT,
  seedCrashedRun,
  waitForScenarioSettled,
} from "./record-mode/scenario-kit.ts";

const RUN_ID = "wf-s13-schema";

describe("场景 13：schema 模式回放全命中（零误报 mismatch）", () => {
  it("schema 调用崩溃后 resume：回放命中不触发 input mismatch，后续调用正常派发，run completed", async () => {
    const env = mkScenarioEnv("13");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: SCHEMA_CALL_SCRIPT,
        settled: [
          { agent: "schemad", result: { content: '{"n":7}', parsedOutput: { n: 7 }, durationMs: 10 } },
        ],
        inflight: [{ agent: "plain" }],
      });

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, RUN_ID);
      const summary = await waitForScenarioSettled(sd.runs, RUN_ID);

      // 零误报 mismatch：无 mismatch failed 终局、错误面无 mismatch 文案
      expect(summary.reason).toBe("completed");
      expect(summary.error ?? "").not.toMatch(/mismatch/i);

      // schema 调用回放（零派发），plain 真实派发
      expect(sd.faux.dispatches).toHaveLength(1);
      expect(sd.faux.dispatches[0]!.opts["agent"]).toBe("plain");
      // 回放结果进入脚本（schema 调用值 = parsedOutput ?? content——脚本正常消费）
      const run = sd.runs.get(RUN_ID)!;
      expect(run.state.scriptResult).toBeDefined();
    } finally {
      env.cleanup();
    }
  });
});
