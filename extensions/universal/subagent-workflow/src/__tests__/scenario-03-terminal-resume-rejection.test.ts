// src/__tests__/scenario-03-terminal-resume-rejection.test.ts
//
// 场景 3（机制文档 §4 场景 3，经修订设计 §4 继承行）：非 interrupted 终局拒绝
// （D2 条件行）。对正常 completed 的 run 与用户 abort（cancelled）的 run 发
// resume。
//
// 通过标准（原文）：两次均被拒绝；错误消息指明 run 的当前终局与「仅 interrupted
// 可续跑」；两 run 的终局与历史不变（record 无 run-resumed）。
import { describe, expect, it } from "vitest";

import { appendEvents, askDispatched, askSettled, mkRecordEnv, runCreated, runSettled } from "./record-mode/helpers.ts";
import { ResumeRejectionError } from "@zhushanwen/subagent-core/orchestration/resume-run.ts";
import {
  makeFauxRunner,
  makeScenarioDeps,
  resumeScenarioRun,
  scanScenarioEvents,
} from "./record-mode/scenario-kit.ts";

/** 终局 run 的最小 record 流（created + 1 settled + run-settled）。 */
async function seedTerminalRun(
  env: ReturnType<typeof mkRecordEnv>,
  runId: string,
  outcome: string,
): Promise<void> {
  await appendEvents(env, runId, [
    runCreated({ ts: 1_759_000_000_000, runId, scriptSource: "await agent('x');" }),
    askDispatched({ ts: 1_759_000_000_100, taskIndex: 0, agentName: "x" }),
    askSettled({ ts: 1_759_000_000_200, taskIndex: 0, outcome: "done", result: { content: "ok" } }),
    runSettled({ ts: 1_759_000_000_300, outcome }),
  ]);
}

describe("场景 3：非 interrupted 终局拒绝", () => {
  it.each([
    { desc: "正常 completed 终局", runId: "wf-s3-completed", outcome: "done" },
    { desc: "用户 abort（cancelled）终局", runId: "wf-s3-cancelled", outcome: "cancelled" },
  ])("$desc → 拒绝 + 「仅 interrupted 可续跑」+ record 无 run-resumed", async ({ runId, outcome }) => {
    const env = mkRecordEnv("scenario-03");
    try {
      await seedTerminalRun(env, runId, outcome);
      const sd = makeScenarioDeps(env, makeFauxRunner());

      await expect(resumeScenarioRun(env, sd, runId)).rejects.toMatchObject({
        name: "ResumeRejectionError",
        message: expect.stringMatching(/already settled|only interrupted runs can be resumed/),
      } satisfies Partial<ResumeRejectionError>);

      // 终局与历史不变：无 run-resumed、无新派发
      const events = await scanScenarioEvents(env, runId);
      expect(events.some((e) => e.type === "run-resumed")).toBe(false);
      expect(sd.faux.dispatches).toHaveLength(0);
    } finally {
      env.cleanup();
    }
  });
});
