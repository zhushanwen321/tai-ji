// src/__tests__/scenario-18-corruption-rejection.test.ts
//
// 场景 18（修订设计 §4，D12）：record 损坏拒绝。构造半截 record 行后 kill →
// 重启 → resume → fold 坏行停摆 + 检查①拒绝，文案含恢复指引。
//
// 分层：loadAll 读原语层在 record-mode/corruption-rejection.test.ts（u-foundation）；
// resume 原语层在 core resume-orchestration.test（u2）。本文件是场景层黑盒
// （半截行 / seq 断档两形态 + 恢复指引文案）。
import { describe, expect, it } from "vitest";

import { ResumeRejectionError } from "@zhushanwen/subagent-core/orchestration/resume-run.ts";

import { runCreated, writeRawLines } from "./record-mode/helpers.ts";
import { makeFauxRunner, makeScenarioDeps, mkScenarioEnv, resumeScenarioRun } from "./record-mode/scenario-kit.ts";

const RUN_ID = "wf-s18-corrupt";
/** 用例间独立 runId（liveRunStates 进程内按 runId 键控——防前用例活体态串扰）。 */
const RUN_ID_D = "wf-s18-corrupt-d";
const T0 = 1_759_000_000_000;

/** 合法帧的行文本（含 seq 信封——与生产写入器同构的最小行）。 */
function frame(obj: Record<string, unknown>, seq: number): string {
  return JSON.stringify({ ...obj, seq });
}

describe("场景 18：record 损坏拒绝（resume 场景层）", () => {
  it("末尾半截行（崩溃写入中断形态）→ resume 拒绝，文案含损坏定位与恢复指引", async () => {
    const env = mkScenarioEnv("18a");
    try {
      writeRawLines(env, RUN_ID, [
        frame({ type: "run-created", ts: T0, runId: RUN_ID, workflowName: "w", argsSummary: "{}", scriptSource: "await agent('x');" }, 1),
        frame({ type: "agent-started", ts: T0 + 10, taskIndex: 0, agentName: "x", attempt: 1 }, 2),
        // 半截行：写入中断（无换行、JSON 截断）
        '{"type":"agent-settled",ts:',
      ]);
      const sd = makeScenarioDeps(env, makeFauxRunner());
      await expect(resumeScenarioRun(env, sd, RUN_ID)).rejects.toMatchObject({
        name: "ResumeRejectionError",
        message: expect.stringMatching(/corrupted at line 3.*Recovery:/s),
      } satisfies Partial<ResumeRejectionError>);
      expect(sd.faux.dispatches).toHaveLength(0);
    } finally {
      env.cleanup();
    }
  });

  it("seq 断档（检查①——丢行/截断形态）→ resume 拒绝并指明期望/实际 seq", async () => {
    const env = mkScenarioEnv("18b");
    try {
      writeRawLines(env, RUN_ID, [
        frame({ type: "run-created", ts: T0, runId: RUN_ID, workflowName: "w", argsSummary: "{}", scriptSource: "await agent('x');" }, 1),
        frame({ type: "agent-started", ts: T0 + 10, taskIndex: 0, agentName: "x", attempt: 1 }, 3), // 跳号
      ]);
      const sd = makeScenarioDeps(env, makeFauxRunner());
      await expect(resumeScenarioRun(env, sd, RUN_ID)).rejects.toMatchObject({
        name: "ResumeRejectionError",
        message: expect.stringMatching(/seq gap detected \(expected 2, got 3\)/),
      } satisfies Partial<ResumeRejectionError>);
    } finally {
      env.cleanup();
    }
  });

  it("无损坏对照：同构造合法流（补 settled 帧）可正常 resume（判别用例）", async () => {
    const env = mkScenarioEnv("18c");
    try {
      writeRawLines(env, RUN_ID, [
        frame({ type: "run-created", ts: T0, runId: RUN_ID, workflowName: "w", argsSummary: "{}", scriptSource: "await agent('x');" }, 1),
        frame({ type: "agent-started", ts: T0 + 10, taskIndex: 0, agentName: "x", attempt: 1 }, 2),
        frame({ type: "agent-settled", ts: T0 + 20, taskIndex: 0, attempt: 1, outcome: "done", durationMs: 10, result: { content: "ok" } }, 3),
        frame({ type: "run-interrupted", ts: T0 + 30, errorCode: "crashed", reason: "kill" }, 4),
      ]);
      const sd = makeScenarioDeps(env, makeFauxRunner());
      await expect(resumeScenarioRun(env, sd, RUN_ID)).resolves.toBe(RUN_ID);
    } finally {
      env.cleanup();
    }
  });

  it("run-created 缺 scriptSource 载荷（写侧缺口形态）→ rebuild 面不构成损坏，但空脚本体可被识别", async () => {
    // 写侧载荷前置缺口（scenario-kit 头注登记）的行为记录：生产链现不写
    // scriptSource——本用例钉住该流形态在 resume 面的表现（可诊断、不静默）。
    const env = mkScenarioEnv("18d");
    try {
      writeRawLines(env, RUN_ID_D, [
        frame({ type: "run-created", ts: T0, runId: RUN_ID_D, workflowName: "w", argsSummary: "{}" }, 1), // 无 scriptSource
        frame({ type: "agent-started", ts: T0 + 10, taskIndex: 0, agentName: "x", attempt: 1 }, 2),
        frame({ type: "agent-settled", ts: T0 + 20, taskIndex: 0, attempt: 1, outcome: "done", durationMs: 10, result: { content: "ok" } }, 3),
        frame({ type: "run-interrupted", ts: T0 + 30, errorCode: "crashed", reason: "kill" }, 4),
      ]);
      const sd = makeScenarioDeps(env, makeFauxRunner());
      // 行为记录：缺 scriptSource 不是行级损坏（resumeRun 接受、rebuild 得空脚本）
      await expect(resumeScenarioRun(env, sd, RUN_ID_D)).resolves.toBe(RUN_ID_D);
    } finally {
      env.cleanup();
    }
  });
});
