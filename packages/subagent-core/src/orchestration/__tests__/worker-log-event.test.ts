// src/orchestration/__tests__/worker-log-event.test.ts
//
// [§2.1 errorLogs 持久化 / ADR-0094] 诊断帧（worker-log）的两条契约：
//   ① 不进生命周期状态机——fold 跳过它并推进 seq 水位；夹在转移之间或落在终局之后
//      都不改变状态、也不判成坏帧（若走 transition，终局吸收态会让它 fail-fast）。
//   ② 重建面 errorLogsFromEvents 与活体写入同语义：按事件序 + 尾部上限裁剪。
import { describe, expect, it, vi } from "vitest";

import {
  errorLogsFromEvents,
  foldRunEventCheckpoint,
  INITIAL_RUN_EVENT_FOLD,
  type WorkflowRunEvent,
} from "../../index.ts";
import { MAX_ERROR_LOGS } from "../worker-message-pump-constants.ts";

function ev<T extends WorkflowRunEvent["type"]>(
  type: T,
  payload: Record<string, unknown>,
  seq: number,
): WorkflowRunEvent {
  return { type, ts: 1_700_000_000_000 + seq, seq, ...payload } as WorkflowRunEvent;
}

const runCreated = ev("run-created", { runId: "wf-1", workflowName: "demo", argsSummary: "{}" }, 1);
const workerLog = (message: string, seq: number, level: "log" | "warn" | "error" | "info" = "error") =>
  ev("worker-log", { entry: { level, message } }, seq);
const runSettled = ev("run-settled", { outcome: "done", reason: "completed" }, 3);

describe("worker-log 不进生命周期状态机（ADR-0094）", () => {
  it("夹在转移之间：状态照常推进，诊断帧被跳过", () => {
    const cp = foldRunEventCheckpoint([runCreated, workerLog("mid", 2), runSettled], () => {
      throw new Error("不应有坏帧");
    });
    expect(cp.state.lifecycle).toBe("terminal");
    expect(cp.runSettled?.outcome).toBe("done");
  });

  it("落在终局之后：不判坏帧、不改状态（终态吸收只约束转移事件）", () => {
    const onBroken = vi.fn();
    const cp = foldRunEventCheckpoint([runCreated, runSettled, workerLog("late", 4)], onBroken);
    expect(onBroken).not.toHaveBeenCalled();
    expect(cp.state.lifecycle).toBe("terminal");
  });

  it("水位仍推进（tail 消费方不重读同一批诊断行）", () => {
    const cp = foldRunEventCheckpoint([runCreated, workerLog("a", 2), workerLog("b", 3)], () => {
      throw new Error("不应有坏帧");
    });
    expect(cp.lastSeq).toBe(3);
    // 以该 checkpoint 增量续读：同批诊断行按水位跳过，不重复应用
    const again = foldRunEventCheckpoint([workerLog("b", 3)], () => {
      throw new Error("不应有坏帧");
    }, cp);
    expect(again.lastSeq).toBe(3);
  });

  it("对照组：真正表外的转移事件仍判坏帧（跳过规则只对诊断帧生效）", () => {
    const onBroken = vi.fn();
    foldRunEventCheckpoint([runCreated, ev("agent-started", { taskIndex: 0, agent: "a", attempt: 1 }, 2), ev("run-resumed", { host: "h" }, 3)], onBroken);
    // agent-started 合法自环；run-resumed 在 running 态非法 → 坏帧
    expect(onBroken).toHaveBeenCalledTimes(1);
  });
});

describe("errorLogsFromEvents（重建面）", () => {
  it("按事件序收集，非诊断帧被忽略", () => {
    const logs = errorLogsFromEvents([runCreated, workerLog("first", 2), workerLog("second", 3, "warn"), runSettled]);
    expect(logs).toEqual([
      { level: "error", message: "first" },
      { level: "warn", message: "second" },
    ]);
  });

  it("无诊断帧 → 空数组（旧 journal 形态）", () => {
    expect(errorLogsFromEvents([runCreated, runSettled])).toEqual([]);
  });

  it("超上限只留尾部 MAX_ERROR_LOGS 条（与活体 slice(-MAX) 同语义）", () => {
    const events = [runCreated];
    for (let i = 0; i < MAX_ERROR_LOGS + 5; i += 1) events.push(workerLog(`m-${i}`, i + 2));
    const logs = errorLogsFromEvents(events);
    expect(logs).toHaveLength(MAX_ERROR_LOGS);
    expect(logs[0]).toEqual({ level: "error", message: "m-5" });
    expect(logs.at(-1)).toEqual({ level: "error", message: `m-${MAX_ERROR_LOGS + 4}` });
  });

  it("与 INITIAL_RUN_EVENT_FOLD 无关：重建只读事件流", () => {
    expect(INITIAL_RUN_EVENT_FOLD.lastSeq).toBe(0);
    expect(errorLogsFromEvents([])).toEqual([]);
  });
});
