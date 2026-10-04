// src/__tests__/scenario-01-main-chain-resume.test.ts
//
// 场景 1（机制文档 §4 场景 1，经修订设计 §4「1-5 继承」行）：主链路——三调用
// 串行 run 崩溃后续跑。
//
// 通过标准（原文）：faux 替身的派发捕获里没有 A、B 的新派发（零 token 回放）；
// C 被真实重派；run 最终 completed；record 里存在 run-resumed 事件行且位于
// interrupted 终态行之后；同一实体从 interrupted 走到 completed。
//
// 夹具形态：崩溃前置态 record 流经生产 journal 写入器构造（写侧载荷前置缺口
// 见 scenario-kit 头注）；resume/worker 重放/派发/终局全部真实代码。
import { describe, expect, it } from "vitest";

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

const RUN_ID = "wf-s1-main";

describe("场景 1：主链路——三调用串行 run 崩溃后续跑", () => {
  it("A/B 零派发回放，C 真实重派，run completed；run-resumed 位于 run-interrupted 之后；同 runId 单实体", async () => {
    const env = mkScenarioEnv("01");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });

      const sd = makeScenarioDeps(env, makeFauxRunner());
      const returnedId = await resumeScenarioRun(env, sd, RUN_ID);
      expect(returnedId).toBe(RUN_ID); // 同 runId 复活（机制文档方案 A——观测面单实体）

      const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
      expect(summary.status).toBe("done");
      expect(summary.reason).toBe("completed");

      // 零 token 断言：A、B 无新派发（回放命中 cached，不经 runner）；恰 C 一次真实派发
      expect(sd.faux.dispatches).toHaveLength(1);
      expect(sd.faux.dispatches[0]!.opts["agent"]).toBe("C");

      // record 形态：run-resumed 在场且位于 run-interrupted 之后
      const events = await scanScenarioEvents(env, RUN_ID);
      const types = events.map((e) => e.type);
      const idxInterrupted = types.indexOf("run-interrupted");
      const idxResumed = types.indexOf("run-resumed");
      expect(idxInterrupted).toBeGreaterThanOrEqual(0);
      expect(idxResumed).toBeGreaterThan(idxInterrupted);

      // 「每个 callId 的成功结果最多写入一次」：settled 帧每 taskIndex 恰一条
      const settledCount = new Map<number, number>();
      for (const e of events) {
        if (e.type === "agent-settled") {
          settledCount.set(e.taskIndex, (settledCount.get(e.taskIndex) ?? 0) + 1);
        }
      }
      expect(settledCount.get(0)).toBe(1);
      expect(settledCount.get(1)).toBe(1);
      expect(settledCount.get(2)).toBe(1);
      expect(settledCount.size).toBe(3);
    } finally {
      env.cleanup();
    }
  });
});
