// src/__tests__/journal-replay.test.ts
//
// journal-replay reducer 边界契约（primitives.test.ts 已覆盖主链路，本文件只补缺口：
// usage 累加、索引外/孤儿 tool_end、同名多实例 LIFO 配对、message_end error、
// compaction no-op、投影 strip、sessionIdFromHandle 运行时 guard）。
// 全部走导出 API；直接往 record.turns[] 构造 running toolCall 是 ReplayRecordView
// 的公开契约面（源码注释明示「重建 record 的历史 running toolCall（索引未覆盖）」
// 为支持场景，journal 重建产物无 tool_start 索引）。

import { describe, expect, it } from "vitest";

import {
  createReplayRecord,
  eventsToSessionView,
  sessionIdFromHandle,
  updateFromEvent,
} from "../journal-replay.ts";
import type {
  AgentEvent,
  AgentUsage,
  EngineHandleData,
  InternalToolCall,
} from "../protocol/contract-types.ts";

/** 事件序列驱动 reducer 后返回 record（各用例共用入口）。 */
function replayRecord(events: AgentEvent[]) {
  const record = createReplayRecord();
  for (const ev of events) updateFromEvent(record, ev);
  return record;
}

describe("journal-replay reducer 边界契约", () => {
  it("同 turn 多次 message_end：usage 按 field-wise 累加（非覆盖），cost 缺省视为 0 参与求和", () => {
    const firstUsage: AgentUsage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    const secondUsage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 1.5 };
    const record = replayRecord([
      { type: "text_delta", delta: "answer" },
      { type: "message_end", usage: firstUsage },
      { type: "message_end", usage: secondUsage },
      { type: "turn_end" },
    ]);
    const expectedDelta = {
      input: firstUsage.input + secondUsage.input,
      output: firstUsage.output + secondUsage.output,
      cacheRead: firstUsage.cacheRead + secondUsage.cacheRead,
      cacheWrite: firstUsage.cacheWrite + secondUsage.cacheWrite,
      cost: (firstUsage.cost ?? 0) + (secondUsage.cost ?? 0),
    };
    expect(record.turns[0]?.usageDelta).toEqual(expectedDelta);
    // totalTokens = 逐条 usage 四项之和的累计
    expect(record.totalTokens).toBe(
      expectedDelta.input + expectedDelta.output
        + expectedDelta.cacheRead + expectedDelta.cacheWrite,
    );
  });

  it("重建 record 的 running toolCall（无 tool_start 索引）：滞后 tool_end 跨 turn 全扫配对，不 push 幽灵项", () => {
    const record = createReplayRecord();
    const running: InternalToolCall = {
      toolName: "bash",
      args: { cmd: "ls" },
      result: undefined,
      isError: false,
      _status: "running",
      startedTs: 1_000,
    };
    record.turns[0]!.toolCalls.push(running);
    updateFromEvent(record, { type: "turn_end" });
    // toolCall 已落在闭合 turn 内，tool_end 仍应跨 turn 扫描配对
    updateFromEvent(record, {
      type: "tool_end",
      toolName: "bash",
      result: { content: [] },
      isError: false,
    });

    expect(record.turns[0]!.toolCalls).toHaveLength(1);
    expect(record.turns[0]!.toolCalls[0]).toMatchObject({
      toolName: "bash",
      args: { cmd: "ls" },
      result: { content: [] },
      _status: "done",
    });
  });

  it("同名多实例：tool_end 按弹尾（LIFO）配对到最后 push 的 running 项", () => {
    const record = replayRecord([
      { type: "tool_start", toolName: "bash", args: { id: "first" } },
      { type: "tool_start", toolName: "bash", args: { id: "second" } },
      { type: "tool_end", toolName: "bash", result: { content: ["r2"] }, isError: false },
      { type: "tool_end", toolName: "bash", result: { content: ["r1"] }, isError: false },
    ]);
    const [first, second] = record.turns[0]!.toolCalls;
    expect(first).toMatchObject({ args: { id: "first" }, result: { content: ["r1"] }, _status: "done" });
    expect(second).toMatchObject({ args: { id: "second" }, result: { content: ["r2"] }, _status: "done" });
  });

  it("孤儿 tool_end（无任何同名 running）：push 已完成项，不丢数据", () => {
    const record = replayRecord([
      { type: "text_delta", delta: "t" },
      { type: "tool_end", toolName: "ghost", result: { content: [] }, isError: false },
    ]);
    expect(record.turns[0]!.toolCalls).toHaveLength(1);
    expect(record.turns[0]!.toolCalls[0]).toMatchObject({
      toolName: "ghost",
      result: { content: [] },
      isError: false,
      _status: "done",
    });
  });

  it("message_end 携带 error → lastError 写回；compaction 事件 no-op（不产生 turn/计数）", () => {
    const record = replayRecord([
      { type: "message_end", error: "message-level boom" },
      { type: "compaction" },
    ]);
    expect(record.lastError).toBe("message-level boom");
    expect(record.turns).toHaveLength(1);
    expect(record.turnCount).toBe(0);
  });

  it("activity 事件 no-op：不开 turn、不计数、不写 lastError（纯活性信号，reducer 双侧 no-op 契约）", () => {
    const record = replayRecord([
      { type: "text_delta", delta: "t" },
      { type: "activity" },
      { type: "activity" },
    ]);
    expect(record.lastError).toBeUndefined();
    expect(record.turns).toHaveLength(1);
    expect(record.turnCount).toBe(0);
    expect(record.totalTokens).toBe(0);
    expect(record.turns[0]).toMatchObject({ text: "t", thinking: "", toolCalls: [] });
  });
});

describe("eventsToSessionView 投影与 sessionIdFromHandle", () => {
  it("ReplayedTurn.toolCalls 导出纯净形状（无 _status/startedTs 内部态）；无 usage → undefined；未传 sessionId → 键缺省", () => {
    const view = eventsToSessionView(
      [
        { type: "tool_start", toolName: "bash", args: { cmd: "ls" } },
        { type: "tool_end", toolName: "bash", result: { content: [] }, isError: true },
      ],
      "zcode",
    );
    expect(view.turns[0]!.toolCalls).toEqual([
      { toolName: "bash", args: { cmd: "ls" }, result: { content: [] }, isError: true },
    ]);
    expect(view.usage).toBeUndefined();
    expect("sessionId" in view).toBe(false);
  });

  it("sessionIdFromHandle：字符串透传；运行时非字符串 → undefined（引擎自定义键 guard）", () => {
    const handle: EngineHandleData = {
      v: 1,
      engineId: "zcode",
      sessionRef: { sessionId: "s-1" },
      poolKey: "shared",
      adapterVersion: "1",
    };
    expect(sessionIdFromHandle(handle)).toBe("s-1");
    // sessionRef 是引擎自定义键空间，运行时值不受类型约束（guard 的存在理由）
    const malformed = {
      ...handle,
      sessionRef: { sessionId: 42 },
    } as unknown as EngineHandleData;
    expect(sessionIdFromHandle(malformed)).toBeUndefined();
  });
});
