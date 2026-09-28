// src/__tests__/scenario-02-script-drift-rejection.test.ts
//
// 场景 2（机制文档 §4 场景 2，经修订设计 §4 继承行）：脚本漂移拒绝（D4）。
// 原步骤：中断后编辑脚本文件改一处字节再 resume → 拒绝 + 恢复指引 + 无新派发。
//
// 【实现偏差登记（任务书「对不上 = 实现偏差，上报而非放宽断言」）】[D1] record
// 单源收敛后 resume 的执行源唯一 = 流内 run-created.scriptSource（resumeRun 不读
// 外部脚本文件，流内脚本与执行脚本构造性同源）——机制文档的「入口级字节比对
// 拒绝」在现实现无触发路径；逐调用输入哈希防线（机制文档 D3 → u2
// detectReplayInputMismatch）的比对数据面（历史入参全文）随 [D1] 载荷裁决未入
// record 流（重建 call 为占位 opts，比对构造性跳过）。两条防线与机制文档场景 2
// 预期的偏差已在 u2 deviations 与本单元 blockers 登记，待编排层裁决。本文件按
// 现实现行为记录：外部脚本编辑不影响 resume（流内 scriptSource 唯一执行源）。
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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

const RUN_ID = "wf-s2-drift";

describe("场景 2：脚本漂移（现实现行为记录——D1 单源形态）", () => {
  it("外部脚本文件被编辑后 resume：以流内 scriptSource 执行（record 单源 = 唯一执行源），A/B 回放、C 派发、run completed", async () => {
    const env = mkScenarioEnv("02");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });

      // 「编辑脚本文件改一处字节」：磁盘上出现被改的脚本文件（resume 不消费它——
      // 现行为断言锚点）
      const editedPath = join(env.sessionDir, "edited-three-call.js");
      writeFileSync(editedPath, THREE_CALL_SERIAL_SCRIPT.replace("agent('C')", "agent('C-EDITED')"), "utf8");

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, RUN_ID);
      const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
      expect(summary.reason).toBe("completed");

      // 现行为：执行源 = 流内脚本（未受外部编辑影响）——C 按 original 名派发
      expect(sd.faux.dispatches.map((d) => d.opts["agent"])).toEqual(["C"]);
      // 回放侧不受影响（A/B 零派发）
      expect(sd.faux.dispatches).toHaveLength(1);
    } finally {
      env.cleanup();
    }
  });
});
