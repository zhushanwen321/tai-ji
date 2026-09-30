// src/__tests__/scenario-12-session-switch-keepalive.test.ts
//
// 场景 12（修订设计 §4，D11）：session 切换保活。resume 接管后在派发阶段切
// session（terminate）→ 回原 session 再 resume。
//
// 通过标准（原文）：run 为 interrupted 态（非 failed）；二次 resume 成功续跑。
import { describe, expect, it } from "vitest";

import { terminateRunningRuns } from "@zhushanwen/subagent-core/orchestration/lifecycle.ts";
import { foldRunEventFrames } from "@zhushanwen/subagent-core/orchestration/run-events.ts";

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

const RUN_ID = "wf-s12-keepalive";

describe("场景 12：session 切换保活（terminate 分叉 → interrupted 可再续）", () => {
  it("resume 接管中切 session：run-interrupted(terminated) 而非 failed 终局；二次 resume 续跑完成", async () => {
    const env = mkScenarioEnv("12");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });

      const sd = makeScenarioDeps(env, makeFauxRunner());
      sd.faux.steps.push({ kind: "hang" }); // C 派发阶段（terminate 落点）
      await resumeScenarioRun(env, sd, RUN_ID);
      const deadline = Date.now() + 10_000;
      while (sd.faux.dispatches.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(sd.faux.dispatches).toHaveLength(1);

      // 切 session（terminate 链——[D11] 统一中断）
      await terminateRunningRuns(sd.deps, "session switched by user");

      // run 为 interrupted 态（非 failed）：转移帧在场、无 failed 终局帧、fold interrupted
      const events = await scanScenarioEvents(env, RUN_ID);
      const interruptedFrames = events.filter((e) => e.type === "run-interrupted");
      expect(interruptedFrames).toHaveLength(2); // 崩溃收编 + terminate 中断
      expect(interruptedFrames[1]).toMatchObject({ errorCode: "terminated" });
      expect(events.some((e) => e.type === "run-settled")).toBe(false);
      expect(foldRunEventFrames(events, () => {}).lifecycle).toBe("interrupted");

      // 回原 session 再 resume：成功续跑（同进程——活体注册表连贯）
      await resumeScenarioRun(env, sd, RUN_ID);
      const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
      expect(summary.reason).toBe("completed");

      // C 重派恰一次成功（terminate 时在途派发被丢弃）
      expect(sd.faux.dispatches).toHaveLength(2);
      expect(sd.faux.dispatches[1]!.opts["agent"]).toBe("C");
    } finally {
      env.cleanup();
    }
  });
});
