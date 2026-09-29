// src/__tests__/scenario-21-retry-budget.test.ts
//
// 场景 21（修订设计 §4，L-02 扩展 / D10）：重试路径预算。场景 16 续跑后注入
// 一次 worker 错误重试 → 重试不被 startedAt 墙钟误判耗尽；按累计活跃段折算。
//
// 判别构造：40min 活跃 + 2 天搁置 + 50min 预算——若重试路径误用 startedAt 墙钟
// （2 天 > 50min），重试即触发 time_limited 终局；按 D10 账本折算（剩余 ≈10min）
// 则正常完成。
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("场景 21：重试路径预算（按累计活跃段折算，非 startedAt 墙钟）", () => {
  it("跨天 resume 续跑中一次派发错误触发重试：重试不被判预算耗尽，run 正常 completed", async () => {
    // 压缩 agent 重试退避（1s → 10ms）：测试不付真实退避等待（生产默认不变）
    vi.stubEnv("TAIJI_SUBAGENT_TEST_AGENT_RETRY_BACKOFF_BASE_MS", "10");

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
      // 第一次派发错误（worker 错误注入夹具）→ 调用级重试；重试成功
      sd.faux.steps.push({ kind: "error", message: "injected transient failure" });

      const twoDaysLater = T0 + 2 * 24 * 60 * MIN;
      await resumeScenarioRun(env, sd, RUN_ID, {
        now: () => twoDaysLater,
        budgetTimeMs: 50 * MIN,
      });

      const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
      // 重试不被 startedAt 墙钟误判耗尽：正常终局而非 time_limited
      expect(summary.reason).toBe("completed");
      expect(summary.reason).not.toBe("time_limited");

      // B 经一次错误重试后成功（恰 2 次派发）+ C 派发一次
      const names = sd.faux.dispatches.map((d) => d.opts["agent"]);
      expect(names).toEqual(["B", "B", "C"]);

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
