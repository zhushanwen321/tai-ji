// src/orchestration/__tests__/run-fold-cache.test.ts
//
// [D6(b) 内活性状态收敛] run 事件流 fold 检查点缓存单测——进程内活体判定的
// fold 收敛到唯一读口（terminal-actions 检查点缓存）后的行为锁定。
//
// 锁定语义：
// a. 增量等价对拍：dispatch 链逐帧 transition 推进的缓存终态 === 同一事件序列
//    一次性全量 foldRunEventCheckpoint 终态（同一 runId 对拍，行为级等价证明）。
// b. 写入后缓存推进：appendTransition 落盘后共享读口（foldRunEventsToLifecycleState）
//    立见新态；命中路径不重读盘面（盘面注入表外坏帧不影响缓存命中的合法投递）。
// c. 单调守卫：盘面旧快照（水位低于内存）不回退内存权威态。
// d. 失效三联动：terminal 删除（终局后迟到事件重新冷读让位）、
//    setRunEventJournalDirForTest 换目录清空（旧 run 缓存不串目录）。
//
// 测试红线：mkdtemp 自建自删、journal 全在 tmp、时钟显式打点（无 fake timers）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  foldRunEventCheckpoint,
  IllegalTransitionError,
  type RunEventFoldCheckpoint,
  type WorkflowRunEventInput,
} from "../run-events.ts";
import {
  dispatchRunTrigger,
  foldRunEventsToLifecycleState,
  scanRunEvents,
  setRunEventJournalDirForTest,
} from "../terminal-actions.ts";
import { RUN_EVENTS_SUFFIX } from "../../shared/run-vocabulary.ts";

// ── harness ──────────────────────────────────────────────────

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-fold-cache-"));
  setRunEventJournalDirForTest(dir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 固定时钟（逐帧递增 ts，避免同 ts 歧义）。 */
let tick = 1000;
const nextTs = (): number => (tick += 1);

function runCreatedInput(runId: string): WorkflowRunEventInput {
  return {
    type: "run-created",
    runId,
    workflowName: "wf-cache",
    scriptSource: "export {}",
    args: {},
    argsSummary: "{}",
    ts: nextTs(),
  };
}

function agentStartedInput(taskIndex: number): WorkflowRunEventInput {
  return { type: "agent-started", taskIndex, agentName: "agent-a", attempt: 1, ts: nextTs() };
}

function agentSettledInput(taskIndex: number): WorkflowRunEventInput {
  return {
    type: "agent-settled",
    taskIndex,
    attempt: 1,
    outcome: "done",
    result: { content: "ok" },
    durationMs: 5,
    ts: nextTs(),
  };
}

function runSettledInput(): WorkflowRunEventInput {
  return { type: "run-settled", outcome: "done", artifactsDir: dir, ts: nextTs() };
}

const dispatch = (runId: string, input: WorkflowRunEventInput) =>
  dispatchRunTrigger({ runId }, input);

/** 盘面全量 fold（对拍基准——与缓存路径无关的独立重放）。 */
async function foldFromDisk(runId: string): Promise<RunEventFoldCheckpoint> {
  return foldRunEventCheckpoint(await scanRunEvents(runId), () => {});
}

// ── a. 增量等价对拍 ─────────────────────────────────────────

describe("run fold checkpoint cache: incremental equivalence", () => {
  it("dispatch 链逐帧推进的缓存终态 === 同一事件序列全量 fold 终态", async () => {
    const runId = "wf-equiv-1";
    const inputs = [
      runCreatedInput(runId),
      agentStartedInput(0),
      agentSettledInput(0),
      agentStartedInput(1),
      agentSettledInput(1),
    ];

    let lastState = (await dispatch(runId, inputs[0]!)).state;
    for (const input of inputs.slice(1)) {
      lastState = (await dispatch(runId, input)).state;
    }

    const replayed = await foldFromDisk(runId);
    expect(lastState).toEqual(replayed.state);
    expect(lastState.lifecycle).toBe("running");
  });

  it("共享读口全量重折与缓存推进态一致（水位对齐后守卫放行重折）", async () => {
    const runId = "wf-equiv-2";
    const inputs = [runCreatedInput(runId), agentStartedInput(0), agentSettledInput(0)];
    let lastState = (await dispatch(runId, inputs[0]!)).state;
    for (const input of inputs.slice(1)) {
      lastState = (await dispatch(runId, input)).state;
    }
    // 缓存水位已推进到盘面末帧：读口重折结果必须与缓存推进态值级一致
    const events = await scanRunEvents(runId);
    expect(foldRunEventsToLifecycleState(runId, events)).toEqual(lastState);
  });
});

// ── b. 写入后缓存推进 ────────────────────────────────────────

describe("run fold checkpoint cache: advance on append", () => {
  it("命中路径不重读盘面：盘面注入表外坏帧不影响缓存命中的合法投递", async () => {
    const runId = "wf-advance-1";
    await dispatch(runId, runCreatedInput(runId));
    await dispatch(runId, agentStartedInput(0));

    // 向盘面注入一帧「行合法、转移表外」的坏帧（running × run-created）：若
    // 投递命中缓存（不重读盘面），后续合法帧照常推进；若实现退化为每次冷读，
    // 坏帧让 fold 停在 created，agent-settled 表外 fail-fast——本测试失败。
    const recordPath = path.join(dir, `${runId}${RUN_EVENTS_SUFFIX}`);
    const probe = `${JSON.stringify({ type: "run-created", runId, workflowName: "probe", ts: nextTs(), seq: 99 })}\n`;
    fs.appendFileSync(recordPath, probe, "utf8");

    const result = await dispatch(runId, agentSettledInput(0));
    expect(result.state.lifecycle).toBe("running");
  });

  it("落盘后共享读口立见新态（首次冷读建立缓存并写回）", async () => {
    const runId = "wf-advance-2";
    await dispatch(runId, runCreatedInput(runId));
    // 无缓存条目时读口冷读盘面折出并写缓存；随后喂同盘面事件集，读口与盘面一致
    const events = await scanRunEvents(runId);
    const state = foldRunEventsToLifecycleState(runId, events);
    expect(state.lifecycle).toBe("running");
    // 缓存建立后，喂旧前缀（守卫面）走单调守卫——间接证明条目已入缓存（见守卫组）
  });
});

// ── c. 单调守卫 ─────────────────────────────────────────────

describe("run fold checkpoint cache: monotonic guard", () => {
  it("盘面旧快照（水位低于内存）不回退内存权威态", async () => {
    const runId = "wf-guard-1";
    await dispatch(runId, runCreatedInput(runId));
    await dispatch(runId, agentStartedInput(0));
    // 内存缓存已推进（created+started，水位 2）；喂只含首帧的旧快照（水位 1）
    const staleEvents = (await scanRunEvents(runId)).slice(0, 1);
    expect(staleEvents).toHaveLength(1);
    const guarded = foldRunEventsToLifecycleState(runId, staleEvents);
    expect(guarded.lifecycle).toBe("running");

    // 缓存未被旧快照覆写：后续合法投递照常（若覆写回 created 态，
    // created × agent-settled 表外 fail-fast——本断言失败）
    const result = await dispatch(runId, agentSettledInput(0));
    expect(result.state.lifecycle).toBe("running");
  });
});

// ── d. 失效三联动 ───────────────────────────────────────────

describe("run fold checkpoint cache: invalidation", () => {
  it("terminal 删除：终局后缓存条目删除，迟到事件重新冷读折出 terminal 让位", async () => {
    const runId = "wf-inval-1";
    await dispatch(runId, runCreatedInput(runId));
    await dispatch(runId, agentSettledInput(0));
    await dispatch(runId, runSettledInput());

    // 终局后迟到事件：缓存已删 → 冷读盘面折出 terminal → 表外 fail-fast 让位
    await expect(dispatch(runId, agentStartedInput(9))).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    // 共享读口对终局 run 返回 terminal（重折结果），且缓存不持有条目
    // （下一次同 run 冷读行为不变——再喂一次结果仍 terminal）
    const events = await scanRunEvents(runId);
    expect(foldRunEventsToLifecycleState(runId, events).lifecycle).toBe("terminal");
    expect(foldRunEventsToLifecycleState(runId, events).lifecycle).toBe("terminal");
  });

  it("setRunEventJournalDirForTest 换目录清空：旧 run 缓存不跨目录串扰", async () => {
    const runId = "wf-inval-2";
    await dispatch(runId, runCreatedInput(runId));
    await dispatch(runId, agentStartedInput(0));
    // 目录 A 内该 run 缓存停在 running

    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "run-fold-cache-b-"));
    try {
      setRunEventJournalDirForTest(dirB);
      // 缓存若未清：running × run-created 表外 fail-fast；已清 → 冷读 dirB
      //（该 run 在 dirB 无文件 → INITIAL created 基线）→ run-created 合法转移
      const result = await dispatch(runId, runCreatedInput(runId));
      expect(result.state.lifecycle).toBe("running");
    } finally {
      fs.rmSync(dirB, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
