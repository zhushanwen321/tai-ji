// src/__tests__/scenario-04-resume-reentrancy.test.ts
//
// 场景 4（机制文档 §4 场景 4，经修订设计 §4 继承行 + 「kill 落点两个分支都要跑
// （重放阶段不落 record 事件）」补强）：resume 可重入。
//
// 通过标准（原文）：第二次 resume 后 A、B 仍零派发；C 被派发一次（第一次 resume
// 里 C 的那次在途派发被丢弃，不重复计为成功）；run 最终 completed；全程每个
// callId 的成功结果最多写入记录一次。修订补强：二次 resume 后 record 无交错事件。
//
// kill 落点分支：
// - 分支 a（重放阶段——不落 record 事件）：resume 返回后立即进程级死亡（worker
//   首个消息未达，record 除 run-resumed 外无新帧）；
// - 分支 b（C 派发中）：runner 挂起（C 已派发、started 帧已落）再进程级死亡。
import { describe, expect, it } from "vitest";

import {
  adoptCrashedRun,
  makeFauxRunner,
  makeScenarioDeps,
  mkScenarioEnv,
  resumeScenarioRun,
  scanScenarioEvents,
  seedCrashedRun,
  simulateProcessDeath,
  THREE_CALL_SERIAL_SCRIPT,
  waitForScenarioSettled,
} from "./record-mode/scenario-kit.ts";

describe("场景 4：resume 可重入（kill 落点两分支）", () => {
  it("分支 a：kill 落在重放阶段（record 无重放期新帧）→ 再收编 → 二次 resume → A/B 零派发、C 恰一次成功，record 无交错", async () => {
    const env = mkScenarioEnv("04a");
    try {
      await seedCrashedRun(env, "wf-s4a", {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });
      const sd = makeScenarioDeps(env, makeFauxRunner());

      // 第一次 resume：返回即死亡（worker 首个 agent-call 未达——重放不落 record 帧）
      await resumeScenarioRun(env, sd, "wf-s4a");
      simulateProcessDeath(env, sd.deps, "wf-s4a");

      // 分支 a 判据：死亡时 record 相比 seed 仅多 run-resumed（重放阶段零事件写入
      // ——A/B 回话不经 runner 不落帧；C 的重派 started 帧未及落盘）
      const afterKill = await scanScenarioEvents(env, "wf-s4a");
      const startedFrames = afterKill.filter((e) => e.type === "agent-started");
      expect(startedFrames).toHaveLength(3); // A/B/C 各一条（seed 帧），无重派帧
      expect(afterKill.filter((e) => e.type === "run-resumed")).toHaveLength(1);

      // 重启收编（真 recoverCrashedRuns 链：fold running → 第二条 run-interrupted）
      const adopted = await adoptCrashedRun(env, "wf-s4a");
      expect(adopted.recovered).toBe(1);

      // 二次 resume → 完成
      const sd2 = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd2, "wf-s4a");
      const summary = await waitForScenarioSettled(sd2.runs, "wf-s4a");
      expect(summary.reason).toBe("completed");

      // A/B 零派发；C 恰一次成功（第一次 resume 未及派发任何调用）
      expect(sd2.faux.dispatches.map((d) => d.opts["agent"])).toEqual(["C"]);
      expect(sd.faux.dispatches).toHaveLength(0);

      // record 无交错事件：seq 连续由 resume 严格读取构造性保证（二次 resume 成功
      // 即证）；显式断言 run-resumed 恰 2 条 + 每 taskIndex settled 恰 1 条
      const events = await scanScenarioEvents(env, "wf-s4a");
      expect(events.filter((e) => e.type === "run-resumed")).toHaveLength(2);
      const settledCount = new Map<number, number>();
      for (const e of events) {
        if (e.type === "agent-settled") settledCount.set(e.taskIndex, (settledCount.get(e.taskIndex) ?? 0) + 1);
      }
      expect([...settledCount.values()].every((n) => n === 1)).toBe(true);
      expect(settledCount.size).toBe(3);
    } finally {
      env.cleanup();
    }
  });

  it("分支 b：kill 落在 C 派发中（在途派发被丢弃）→ 再收编 → 二次 resume → C 重派恰一次成功", async () => {
    const env = mkScenarioEnv("04b");
    try {
      await seedCrashedRun(env, "wf-s4b", {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });
      const sd = makeScenarioDeps(env, makeFauxRunner());
      sd.faux.steps.push({ kind: "hang" }); // C 派发后挂起（在途）

      await resumeScenarioRun(env, sd, "wf-s4b");
      // 等 C 真实派发达成（agent-started 重派帧已落 record）
      const deadline = Date.now() + 10_000;
      while (sd.faux.dispatches.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(sd.faux.dispatches).toHaveLength(1);

      simulateProcessDeath(env, sd.deps, "wf-s4b"); // 在途派发悬空（结果无人收取）
      const adopted = await adoptCrashedRun(env, "wf-s4b");
      expect(adopted.recovered).toBe(1);

      // 二次 resume：C 重派恰一次（在途丢弃不重不漏）
      const sd2 = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd2, "wf-s4b");
      const summary = await waitForScenarioSettled(sd2.runs, "wf-s4b");
      expect(summary.reason).toBe("completed");
      expect(sd2.faux.dispatches).toHaveLength(1);
      expect(sd2.faux.dispatches[0]!.opts["agent"]).toBe("C");

      const events = await scanScenarioEvents(env, "wf-s4b");
      const settledCount = new Map<number, number>();
      for (const e of events) {
        if (e.type === "agent-settled") settledCount.set(e.taskIndex, (settledCount.get(e.taskIndex) ?? 0) + 1);
      }
      expect(settledCount.get(2)).toBe(1); // C 成功结果恰写一次
      expect(events.filter((e) => e.type === "run-resumed")).toHaveLength(2);
    } finally {
      env.cleanup();
    }
  });
});
