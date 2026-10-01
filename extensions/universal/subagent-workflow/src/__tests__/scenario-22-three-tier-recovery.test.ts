// src/__tests__/scenario-22-three-tier-recovery.test.ts
//
// 场景 22（修订设计 §4 D8 → [ADR-0092] 修订）：恢复只复用已提交结果。
// 未完成调用一律重派——有成员绑定则续写同一成员会话、无则新建；恢复链不读取
// 子代理会话文件、不合成补收帧。
//
// 文件名保留历史名（原「三档判据」已随 ADR-0092 删除）；本文件锁编排侧语义：
// 已提交调用零 token 回放 + 未完成调用真实重派 + 记录里不存在恢复合成的结果。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  makeFauxRunner,
  makeScenarioDeps,
  mkScenarioEnv,
  resumeScenarioRun,
  scanScenarioEvents,
  seedCrashedRun,
  waitForScenarioSettled,
} from "./record-mode/scenario-kit.ts";

/** 场景 22 脚本：writer 两次调用（第 3 位 in-flight）+ other 一次。 */
const WRITER_TWICE_SCRIPT =
  "const a = await agent({ prompt: 'draft', agent: 'writer' });\nconst b = await agent({ prompt: 'other', agent: 'other' });\nconst c = await agent({ prompt: 'revise', agent: 'writer' });\nreturn { a, b, c };";

/** 崩溃流：writer 的首次调用已落定（result 可带 sessionFile）、第三次调用 in-flight。 */
async function seedWriterCrashed(env: ReturnType<typeof mkScenarioEnv>, runId: string, sessionFile: string | undefined): Promise<void> {
  await seedCrashedRun(env, runId, {
    scriptSource: WRITER_TWICE_SCRIPT,
    settled: [
      { agent: "writer", result: { content: "first call done", ...(sessionFile !== undefined ? { sessionFile } : {}) } },
      { agent: "other" },
    ],
    inflight: [{ agent: "writer" }],
  });
}

function resumedFrame(events: readonly { type: string; reason?: unknown }[]): { reason?: unknown } | undefined {
  return events.find((e) => e.type === "run-resumed");
}

describe("场景 22：恢复只复用已提交结果（[ADR-0092]）", () => {
  it("已提交调用零 token 回放、未完成调用真实重派，恢复不合成任何结果", async () => {
    const env = mkScenarioEnv("22t1");
    const sessionDir = join(tmpdir(), `wf-s22-member-${Date.now()}`);
    try {
      // 对抗性构造：记录里带会话文件路径，且该文件末尾是「完整回复」——
      // 旧实装据此判档 1 并零 token 补收；[ADR-0092] 后此文件与恢复无关。
      mkdirSync(sessionDir, { recursive: true });
      const sessionFile = join(sessionDir, "member-t1.jsonl");
      writeFileSync(
        sessionFile,
        [
          { type: "session", version: 3, id: "sess-t1", timestamp: "2026-09-28T00:00:00.000Z", cwd: "/tmp" },
          { type: "message", id: "m1", parentId: null, message: { role: "user", content: "do the work", timestamp: 1 } },
          { type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [{ type: "text", text: "recovered-from-session: final answer 42" }], stopReason: "stop", timestamp: 2 } },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
        "utf8",
      );
      await seedWriterCrashed(env, "wf-s22-t1", sessionFile);

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, "wf-s22-t1");
      const summary = await waitForScenarioSettled(sd.runs, "wf-s22-t1");
      expect(summary.reason).toBe("completed");

      // 未完成调用真实重派恰一次（旧实装此处置零派发——补收不发派发）
      expect(sd.faux.dispatches).toHaveLength(1);
      expect(sd.faux.dispatches[0]!.opts["agent"]).toBe("writer");

      const events = await scanScenarioEvents(env, "wf-s22-t1");
      const idxResumed = events.findIndex((e) => e.type === "run-resumed");
      // 恢复之后只应出现「重跑那一次的正常落定」（durationMs=5、content 来自 runner），
      // 不应出现「补收形态」（durationMs=0、content 取自会话文件）
      const settledAfterResume = events.filter((e, i) => e.type === "agent-settled" && i > idxResumed) as Array<{
        taskIndex: number;
        durationMs: number;
        result: { content: string; sessionFile?: string };
      }>;
      expect(settledAfterResume).toHaveLength(1);
      expect(settledAfterResume[0]!.taskIndex).toBe(2);
      expect(settledAfterResume[0]!.durationMs).toBe(5);
      expect(settledAfterResume[0]!.result.content).not.toContain("recovered-from-session");
      expect(settledAfterResume[0]!.result.sessionFile).toBeUndefined();
      // 计划计数留痕：已提交 2 条回放、未完成 1 条重派
      expect(String(resumedFrame(events)?.reason ?? "")).toBe("resume plan: replay=2 redispatch=1");
    } finally {
      env.cleanup();
      rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("记录里没有会话文件路径时行为完全相同（恢复不再依赖它）", async () => {
    const env = mkScenarioEnv("22t2");
    try {
      await seedWriterCrashed(env, "wf-s22-t2", undefined);

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, "wf-s22-t2");
      const summary = await waitForScenarioSettled(sd.runs, "wf-s22-t2");
      expect(summary.reason).toBe("completed");

      expect(sd.faux.dispatches).toHaveLength(1);
      expect(sd.faux.dispatches[0]!.opts["agent"]).toBe("writer");
      const events = await scanScenarioEvents(env, "wf-s22-t2");
      expect(String(resumedFrame(events)?.reason ?? "")).toBe("resume plan: replay=2 redispatch=1");
    } finally {
      env.cleanup();
    }
  });
});
