// src/__tests__/record-mode/rebuild-fidelity.test.ts
//
// 场景 6：record 重建保真（[D1] record 单源存储收敛，设计 workflow-run-resume-revision
// §4 场景 6 的单测层承接——验收计划表 A2「L1 增量单测：盘上 record 事件流直接断言」）。
//
// 回溯目标 = 设计目标 1「数据不丢」：record 事件流（含全文载荷）fold 重建后，与
// 产生这些事件的内存投影**逐字段等价**——收编（追加 run-interrupted / 旧词表形态
// run-settled(interrupted)）不销毁任何已完成调用的结果全文与脚本体，resume 的
// 缓存回放数据面构造性成立。
//
// 场景原型：三调用 run 第 2 调用完成后崩溃 → 重启收编 → 直接检查盘上 record 事件流
// 与 fold 重建产物。单测层形态：事件链经 core journal 实装写入（生产落盘形态），
// 崩溃形态 = 流停在 running（无 run-settled 帧）；收编形态 = 追加
// run-settled(interrupted)（现行词表的收编帧——u1a 词表批改为 run-interrupted
// 转移事件后本场景断言随批更新）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRunEventJournal } from "@zhushanwen/subagent-core";
import { JsonlRunStore } from "../../jsonl-run-store.ts";
import {
  appendEvents,
  askDispatched,
  askSettled,
  mkCtxWith,
  mkRecordEnv,
  registeredEntry,
  runCreated,
  runSettled,
  type RecordFixtureEnv,
} from "./helpers.ts";

/** 场景原型 runId（三调用 run）。 */
const RUN_ID = "wf-fidelity-3call";

/** 第 2 调用的 result 全文（逐字段保真断言的锚定载荷）。 */
const RESULT_CALL_1 = {
  content: "stage-1 output: 42 items processed",
  durationMs: 41_000,
  usage: { input: 1200, output: 340, totalTokens: 1540 },
  sessionId: "sess-call-1",
  sessionFile: "/abs/.pi/agent/subagents/enc/sessions/2026-09-28T_sess-call-1.jsonl",
} as const;

const RESULT_CALL_2 = {
  content: "stage-2 output: review complete, 2 findings",
  durationMs: 12_500,
  sessionId: "sess-call-2",
  sessionFile: "/abs/.pi/agent/subagents/enc/sessions/2026-09-28T_sess-call-2.jsonl",
} as const;

const SCRIPT_SOURCE = "const a = await agent('stage-1');\nconst b = await agent('stage-2');\nconst c = await agent('stage-3');\nreturn { a, b, c };";

const T0 = 1_759_000_000_000;

/** 写入崩溃瞬间的事件链：run-created + 3×dispatched + 2×settled（全文），无 run-settled。 */
async function seedCrashedRun(env: RecordFixtureEnv): Promise<void> {
  await appendEvents(env, RUN_ID, [
    runCreated({ ts: T0, runId: RUN_ID, scriptSource: SCRIPT_SOURCE }),
    askDispatched({ ts: T0 + 10, taskIndex: 0, agentName: "stage-1", phase: "build" }),
    askDispatched({ ts: T0 + 20, taskIndex: 1, agentName: "stage-2", phase: "build" }),
    askDispatched({ ts: T0 + 30, taskIndex: 2, agentName: "stage-3", phase: "report" }),
    askSettled({ ts: T0 + 41_000, taskIndex: 0, outcome: "done", durationMs: 41_000, result: RESULT_CALL_1 }),
    askSettled({ ts: T0 + 53_500, taskIndex: 1, outcome: "done", durationMs: 12_500, result: RESULT_CALL_2 }),
  ]);
}

describe("场景 6：record 重建保真（[D1]——盘上 record 流 fold 后与内存投影逐字段等价）", () => {
  let env: RecordFixtureEnv;

  beforeEach(() => {
    env = mkRecordEnv("fidelity");
  });

  afterEach(() => {
    env.cleanup();
  });

  it("盘上 record 流形态：run-created 含 scriptSource 全文；settled 帧含 result 全文；在途调用无 settled 帧（崩溃形态）", async () => {
    await seedCrashedRun(env);
    // 直接检查盘上事件流（场景 6 通过标准的盘面半边——不经 store，验证写入器产物）
    const raw = (await import("node:fs")).readFileSync(env.recordPath(RUN_ID), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    const created = lines.find((l) => l["type"] === "run-created");
    expect(created?.["scriptSource"]).toBe(SCRIPT_SOURCE);
    const settled = lines.filter((l) => l["type"] === "agent-settled");
    expect(settled).toHaveLength(2);
    expect(settled[0]?.["result"]).toEqual(RESULT_CALL_1);
    expect(settled[1]?.["result"]).toEqual(RESULT_CALL_2);
    // 在途调用（stage-3）无 settled 帧
    expect(settled.find((l) => l["taskIndex"] === 2)).toBeUndefined();
  });

  it("崩溃形态 fold 重建：scriptSource / 已完成 calls（result 全文逐字段）/ 在途 calls（running）逐字段等价", async () => {
    await seedCrashedRun(env);
    const entries = [registeredEntry(RUN_ID, env.recordPath(RUN_ID))];
    const store = new JsonlRunStore({ sessionDir: env.sessionDir, ctx: mkCtxWith(entries) as never });

    const [run] = await store.loadAll();

    // run 级：身份 + 脚本体 + 崩溃形态状态
    expect(run!.runId).toBe(RUN_ID);
    expect(run!.spec.scriptSource).toBe(SCRIPT_SOURCE);
    expect(run!.spec.scriptName).toBe("fidelity-script");
    expect(run!.state.status).toBe("running"); // 无 run-settled 帧 = 交恢复链收编

    // call 级：已完成调用全文保真（resume 缓存回放的数据面）
    const call0 = run!.state.calls.get(0)!;
    expect(call0.status).toBe("done");
    expect(call0.result).toEqual(RESULT_CALL_1);
    expect(call0.sessionId).toBe(RESULT_CALL_1.sessionId);
    expect(call0.sessionFile).toBe(RESULT_CALL_1.sessionFile);
    expect(call0.traceNode.agent).toBe("stage-1");
    expect(call0.traceNode.phase).toBe("build");
    expect(call0.traceNode.status).toBe("completed");

    const call1 = run!.state.calls.get(1)!;
    expect(call1.result).toEqual(RESULT_CALL_2);
    expect(call1.traceNode.status).toBe("completed");

    // 在途调用：running、无 result
    const call2 = run!.state.calls.get(2)!;
    expect(call2.status).toBe("running");
    expect(call2.result).toBeUndefined();
    expect(call2.traceNode.agent).toBe("stage-3");
    expect(call2.traceNode.phase).toBe("report");
  });

  it("收编后重建（[D2] run-interrupted 转移帧）：追加不覆盖既有事实——result 全文与 scriptSource 保真（收编只是追加一条转移事件，非终局帧）", async () => {
    await seedCrashedRun(env);
    // 收编写入（[D15] interruptRun 追加的中断转移帧——经生产 journal 实装；[D2]
    // 中断非终局：errorCode 承载来源 crashed，reason 承载 kill 文本）
    const journal = createRunEventJournal(env.stateDir);
    await journal.append(RUN_ID, { type: "run-interrupted", seq: 99, ts: T0 + 100_000, errorCode: "crashed", reason: "Process killed (kill-9 or crash recovery)" });

    const entries = [registeredEntry(RUN_ID, env.recordPath(RUN_ID))];
    const store = new JsonlRunStore({ sessionDir: env.sessionDir, ctx: mkCtxWith(entries) as never });
    const [run] = await store.loadAll();

    // [D2] 中断非终局：重建产物维持 running（终局判据归 fold；无 done/reason 收敛）
    expect(run!.state.status).toBe("running");
    expect(run!.state.reason).toBeUndefined();
    // 中断标记投影（U10）：流含 run-interrupted、无 run-settled → meta.interruptedAt
    // 置位（= 帧 ts ISO）——runSummary/displayStatusOf 投影 'interrupted'，CLI/TUI
    // 不显示僵尸「运行中」；resume 复活流清该标记（lastInterruptedAt 尾向遇
    // run-resumed 返回 undefined）
    expect(run!.meta.interruptedAt).toBe(new Date(T0 + 100_000).toISOString());
    // 收编后数据不丢（设计目标 1 的断言面）：全文载荷原样保真
    expect(run!.spec.scriptSource).toBe(SCRIPT_SOURCE);
    expect(run!.state.calls.get(0)!.result).toEqual(RESULT_CALL_1);
    expect(run!.state.calls.get(1)!.result).toEqual(RESULT_CALL_2);
    expect(run!.state.calls.get(2)!.status).toBe("running"); // 在途仍可辨识（三档恢复的输入）
    // 中断非终局：settledRecordOf 无终局记录（通知链不触发——中断 run 不发 workflow-result）
    expect(store.settledRecordOf(RUN_ID)).toBeUndefined();
  });

  it("正常终局重建：run-settled(completed) → done/completed + completedAt 取帧 ts", async () => {
    await appendEvents(env, RUN_ID, [
      runCreated({ ts: T0, runId: RUN_ID, scriptSource: SCRIPT_SOURCE }),
      askDispatched({ ts: T0 + 10, taskIndex: 0, agentName: "stage-1" }),
      askSettled({ ts: T0 + 1000, taskIndex: 0, outcome: "done", durationMs: 990, result: { content: "ok" } }),
      runSettled({ ts: T0 + 2000, outcome: "done" }),
    ]);
    const entries = [registeredEntry(RUN_ID, env.recordPath(RUN_ID))];
    const store = new JsonlRunStore({ sessionDir: env.sessionDir, ctx: mkCtxWith(entries) as never });
    const [run] = await store.loadAll();
    expect(run!.state.status).toBe("done");
    expect(run!.state.reason).toBe("completed");
    expect(run!.meta.startedAt).toBe(new Date(T0).toISOString());
    expect(run!.meta.completedAt).toBe(new Date(T0 + 2000).toISOString());
  });
});
