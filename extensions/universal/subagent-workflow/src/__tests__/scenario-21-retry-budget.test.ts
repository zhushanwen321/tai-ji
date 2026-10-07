// src/__tests__/scenario-21-retry-budget.test.ts
//
// 场景 21（修订设计 §4，L-02 扩展 / D10）：跨天 resume 后剩余预算按累计活跃段
// 折算（非 startedAt 墙钟）。场景 16 续跑后注入一次派发错误（[ADR-0122] 单次
// 终态显式上报，无自动重试）→ run 仍按账本折算的剩余预算正常推进。
//
// 判别构造：40min 活跃 + 2 天搁置 + 50min 预算——若预算折算误用 startedAt 墙钟
// （2 天 > 50min），resume 即被 D10 预检拒绝 / 复活即 time_limited 终局；按 D10
// 账本折算（剩余 ≈10min）则 resume 放行且正常完成。
import { describe, expect, it } from "vitest";

import { appendEvents, askDispatched, askSettled, mkRecordEnv, runCreated } from "./record-mode/helpers.ts";
import {
  makeFauxRunner,
  makeScenarioDeps,
  resumeScenarioRun,
  THREE_CALL_SERIAL_SCRIPT,
  waitForScenarioSettled,
} from "./record-mode/scenario-kit.ts";

const RUN_ID = "wf-s21-retry";
const T0 = 1_759_000_000_000;
const MIN = 60_000;
const ACTIVE_40MIN = 40 * MIN;

describe("场景 21：跨天 resume 预算按累计活跃段折算（非 startedAt 墙钟）", () => {
  it("跨天 resume 续跑中一次派发错误单次终态（无重试）：预算按账本折算，run 正常 completed", async () => {
    const env = mkRecordEnv("scenario-21");
    try {
      await appendEvents(env, RUN_ID, [
        runCreated({ ts: T0, runId: RUN_ID, scriptSource: THREE_CALL_SERIAL_SCRIPT }),
        askDispatched({ ts: T0 + 1000, taskIndex: 0, agentName: "A" }),
        askSettled({ ts: T0 + ACTIVE_40MIN, taskIndex: 0, outcome: "done", durationMs: ACTIVE_40MIN, result: { content: "a" } }),
        askDispatched({ ts: T0 + ACTIVE_40MIN + 100, taskIndex: 1, agentName: "B" }),
        { type: "run-interrupted", errorCode: "crashed", reason: "kill after 40min", ts: T0 + ACTIVE_40MIN + 200 },
      ]);

      const sd = makeScenarioDeps(env, makeFauxRunner());
      // 派发错误注入（result.error 在场）→ [ADR-0122] 单次 finalizeCall failed 显式
      // 上报，无自动重试；脚本侧 agent() 失败 resolve 回退，run 继续推进 C
      sd.faux.steps.push({ kind: "error", message: "injected transient failure" });

      const twoDaysLater = T0 + 2 * 24 * 60 * MIN;
      await resumeScenarioRun(env, sd, RUN_ID, {
        now: () => twoDaysLater,
        budgetTimeMs: 50 * MIN,
      });

      const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
      // 账本折算不被 startedAt 墙钟误判耗尽：正常终局而非 time_limited
      expect(summary.reason).toBe("completed");
      expect(summary.reason).not.toBe("time_limited");

      // B 失败恰 1 次派发（无重试轨迹）+ C 派发一次
      const names = sd.faux.dispatches.map((d) => d.opts["agent"]);
      expect(names).toEqual(["B", "C"]);

      // 预算重排按活跃段账本折算（首次 ≈10min 剩余；无 0/negative 误排）
      expect(sd.budgetSchedules.length).toBeGreaterThanOrEqual(1);
      for (const { ms } of sd.budgetSchedules) {
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(10 * MIN + 1_000);
      }
    } finally {
      env.cleanup();
    }
  });
});
