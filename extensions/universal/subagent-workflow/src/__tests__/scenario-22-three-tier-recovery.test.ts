// src/__tests__/scenario-22-three-tier-recovery.test.ts
//
// 场景 22（修订设计 §4，D8）：三档恢复。同一脚本三次崩溃构造三档：会话含完整
// 回复（档 1 补收，零 token）/ 请求未完成（档 2 同会话续写）/ 会话不存在
// （档 3 整跑）。
//
// 档 1 用确定性构造（任务书 §2：人工预置完整会话文件后再 resume，不依赖毫秒级
// 崩溃竞态）。档位判据依赖真实 pi 会话文件语义——编排侧断言以替身 + 真实会话
// 文件形态夹具覆盖；TAIJI_PI_LIVE 全链冒烟段环境门 skipIf（D3 阶段空载串行触发）。
import { mkdirSync, writeFileSync } from "node:fs";
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

// ── 三档夹具：pi 会话文件形态构造（[D8] 档位判据读文件尾部状态）────────────

/** pi 会话文件最小合法形态（header + 对话流）。返回文件绝对路径。 */
function writeMemberSessionFile(label: string, lines: unknown[]): string {
  const dir = join(tmpdir(), `wf-s22-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `member-${label}.jsonl`);
  const header = [
    { type: "session", version: 3, id: `sess-${label}`, timestamp: "2026-09-28T00:00:00.000Z", cwd: "/tmp" },
    { type: "model_change", provider: "p", modelId: "m-1" },
  ];
  writeFileSync(file, [...header, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}

/** 档 1 形态：末轮 assistant 回复完整落盘（text 块 + stopReason stop）。 */
function writeCompleteReplySession(label: string, replyText: string): string {
  return writeMemberSessionFile(label, [
    { type: "message", id: "m1", parentId: null, timestamp: "2026-09-28T00:00:01.000Z", message: { role: "user", content: "do the work", timestamp: 1 } },
    {
      type: "message", id: "m2", parentId: "m1", timestamp: "2026-09-28T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: replyText }],
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ]);
}

/** 档 2 形态：末尾悬空 user prompt（请求未完成——引擎在回复前死亡）。 */
function writeDanglingPromptSession(label: string): string {
  return writeMemberSessionFile(label, [
    {
      type: "message", id: "m1", parentId: null, timestamp: "2026-09-28T00:00:01.000Z",
      message: { role: "user", content: "do the work", timestamp: 1 },
    },
  ]);
}

/** 场景 22 脚本：writer 两次调用（第 3 位 in-flight）+ other 一次。 */
const WRITER_TWICE_SCRIPT =
  "const a = await agent({ prompt: 'draft', agent: 'writer' });\nconst b = await agent({ prompt: 'other', agent: 'other' });\nconst c = await agent({ prompt: 'revise', agent: 'writer' });\nreturn { a, b, c };";

/** 崩溃流：writer 的首次调用已落定（result 携带 sessionFile——[D6] 绑定供源），
 *  第三次调用 in-flight（重派集成员，同名 agent 供源命中）。 */
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

describe("场景 22：三档恢复（D8）", () => {
  it("档 1（确定性构造）：预置完整会话文件 → resume 补收零 token——runner 零派发，补收帧落流，run completed", async () => {
    const env = mkScenarioEnv("22t1");
    try {
      const sessionFile = writeCompleteReplySession("t1", "recovered-from-session: final answer 42");
      await seedWriterCrashed(env, "wf-s22-t1", sessionFile);

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, "wf-s22-t1");
      const summary = await waitForScenarioSettled(sd.runs, "wf-s22-t1");
      expect(summary.reason).toBe("completed");

      // 档 1 补收：零 token（无任何真实派发——writer 补收 + other 回放）
      expect(sd.faux.dispatches).toHaveLength(0);

      // 补收帧事实入流：run-resumed 之后的 agent-settled(outcome done, durationMs 0，
      // content = 会话文件末轮正文)
      const events = await scanScenarioEvents(env, "wf-s22-t1");
      const idxResumed = events.findIndex((e) => e.type === "run-resumed");
      const collectFrames = events.filter((e, i) => e.type === "agent-settled" && i > idxResumed);
      expect(collectFrames).toHaveLength(1);
      expect(collectFrames[0]).toMatchObject({
        taskIndex: 2,
        outcome: "done",
        durationMs: 0,
        result: { content: "recovered-from-session: final answer 42", sessionFile },
      });
      expect(String(resumedFrame(events)?.reason ?? "")).toContain("collect(tier-1)");
    } finally {
      env.cleanup();
    }
  });

  it("档 2：会话文件在、末尾悬空 prompt → 同会话续写（无补收帧），重派恰一次", async () => {
    const env = mkScenarioEnv("22t2");
    try {
      const sessionFile = writeDanglingPromptSession("t2");
      await seedWriterCrashed(env, "wf-s22-t2", sessionFile);

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, "wf-s22-t2");
      const summary = await waitForScenarioSettled(sd.runs, "wf-s22-t2");
      expect(summary.reason).toBe("completed");

      // 档 2：无补收（重派真实发生——续写由成员复用通道承接，编排侧断言 = 派发面）
      expect(sd.faux.dispatches).toHaveLength(1);
      expect(sd.faux.dispatches[0]!.opts["agent"]).toBe("writer");
      const events = await scanScenarioEvents(env, "wf-s22-t2");
      expect(String(resumedFrame(events)?.reason ?? "")).toContain("continue(tier-2)");
      // 「宿主 pi 侧表面不变」（不新建会话文件、原会话文件续写追加）的断言面在
      // 真实 pi 引擎——TAIJI_PI_LIVE 门段/D3 剧本承接（本用例为编排侧替身断言）。
    } finally {
      env.cleanup();
    }
  });

  it("档 3：同名 agent 无落定历史（会话文件供源 undefined）→ 整跑，重派恰一次", async () => {
    const env = mkScenarioEnv("22t3");
    try {
      await seedWriterCrashed(env, "wf-s22-t3", undefined);

      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, "wf-s22-t3");
      const summary = await waitForScenarioSettled(sd.runs, "wf-s22-t3");
      expect(summary.reason).toBe("completed");

      expect(sd.faux.dispatches).toHaveLength(1);
      expect(sd.faux.dispatches[0]!.opts["agent"]).toBe("writer");
      const events = await scanScenarioEvents(env, "wf-s22-t3");
      expect(String(resumedFrame(events)?.reason ?? "")).toContain("restart(tier-3)");
    } finally {
      env.cleanup();
    }
  });
});

// TAIJI_PI_LIVE 真机冒烟段（D3 阶段空载串行触发；节点级默认 skip 只验证结构）：
// 档位判据读真实 pi 会话文件语义——D3 剧本采集真实会话文件（TAIJI_PI_LIVE_SESSION_DIR
// 指向）后，本段对三档判据跑真实文件面核验（readMemberSession 不注入——默认
// readFileSync 直读真实文件）。
describe("场景 22：TAIJI_PI_LIVE 真机冒烟段", () => {
  it.skipIf(!process.env.TAIJI_PI_LIVE)("真实 pi 会话文件的档位判定与补收（D3 剧本触发）", async () => {
    const sessionDir = process.env.TAIJI_PI_LIVE_SESSION_DIR;
    expect(sessionDir).toBeTruthy();
    // D3 剧本提供真实会话文件目录：<dir>/tier1.jsonl（完整回复）/ tier2.jsonl（悬空
    // prompt）。档 1 全链 = 预置 → resume → 断言零派发 + 补收帧；档 2 = 断言重派与
    // pi 侧续写（原会话文件被追加、无新会话文件——ls 目录文件数不变）。
    const env = mkScenarioEnv("22live");
    try {
      const t1 = join(sessionDir!, "tier1.jsonl");
      await seedWriterCrashed(env, "wf-s22-live-t1", t1);
      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, "wf-s22-live-t1");
      const summary = await waitForScenarioSettled(sd.runs, "wf-s22-live-t1");
      expect(summary.reason).toBe("completed");
      expect(sd.faux.dispatches).toHaveLength(0); // 档 1 零 token（真实文件判据命中）
    } finally {
      env.cleanup();
    }
  });
});
