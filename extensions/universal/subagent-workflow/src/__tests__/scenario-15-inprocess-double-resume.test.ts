// src/__tests__/scenario-15-inprocess-double-resume.test.ts
//
// 场景 15（修订设计 §4，E-09）：同进程双 resume。同进程快速连发两条 resume。
//
// 通过标准（原文）：恰一次生效，第二次明确拒绝；record 只有一套 run-resumed。
import { describe, expect, it, vi } from "vitest";

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

const RUN_ID = "wf-s15-double";

describe("场景 15：同进程双 resume——恰一次生效", () => {
  it("并发连发两条：恰一 fulfilled 一 rejected；record 只有一套 run-resumed", async () => {
    const env = mkScenarioEnv("15");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });

      const sd = makeScenarioDeps(env, makeFauxRunner());
      sd.faux.steps.push({ kind: "hang" }); // 拉长第一条的活跃窗口

      // 快速连发两条（同进程并发——D7 锁同进程二次 lock 同路径同样 ELOCKED，
      // 或锁释放后串行到达由资格校验拒绝——两形态都是「第二次明确拒绝」）
      const [first, second] = await Promise.allSettled([
        resumeScenarioRun(env, sd, RUN_ID),
        resumeScenarioRun(env, sd, RUN_ID),
      ]);
      const outcomes = [first.status, second.status].sort();
      expect(outcomes).toEqual(["fulfilled", "rejected"]);
      const rejected = first.status === "rejected" ? first : second;
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({
        name: "ResumeRejectionError",
      });

      // record 只有一套 run-resumed
      const events = await scanScenarioEvents(env, RUN_ID);
      expect(events.filter((e) => e.type === "run-resumed")).toHaveLength(1);

      // 生效侧可继续跑完（释放挂起）。release 前必须等重派集 C 真实派发落地：
      // 第二条 resume 的锁拒绝是立即返回（[ADR-0112] retries=0，无旧重试退避窗），
      // allSettled 返回时生效侧 worker 的重派可能尚未走到 faux runner——此刻
      // release(1) 会 miss 挂起门（gates 未注册），hang 永不释放，run 永不终局
      await vi.waitFor(() => {
        expect(sd.faux.dispatches).toHaveLength(1);
      });
      sd.faux.release(1, "c-done");
      const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
      expect(summary.reason).toBe("completed");
      expect(sd.faux.dispatches).toHaveLength(1);
    } finally {
      env.cleanup();
    }
  });
});
