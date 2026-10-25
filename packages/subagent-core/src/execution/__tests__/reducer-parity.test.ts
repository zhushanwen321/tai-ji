// src/execution/__tests__/reducer-parity.test.ts
//
// [subagent-observability §3.3.5] reducer 合一后的等价断言：「record 事件流 fold ≡
// 内存单源」。前身是双实现对拍（core execution-record.updateFromEvent vs SDK
// journal-replay.updateFromEvent 两份逐字副本互为基准）——合一后 updateFromEvent 的
// 唯一实现在 SDK journal-replay.ts（core 薄委托），「两实现漂移」这一失效模式已构造性
// 消除，对拍对象随之转为两条调用路径的等价性：
//
//   ① live 路径   = createRecord（core 活体容器）+ updateFromEvent 逐事件累积
//   ② fold 路径   = createReplayRecord（SDK 重放容器）+ SDK updateFromEvent 逐事件 fold
//   ③ 端到端投影  = eventsToSessionView（journal 重放出口）≡ live record 经
//                   toReplayedTurn / aggregateUsage 的同一投影
//
// ①② 逐字段等价锁「容器形状无关」（ExecutionRecord ⊇ ReplayRecordView 可互换）；
// ③ 锁 journal 重放出口与内存单源的派生一致（rebuild/冷读链的行为前提）。
//
// 覆盖口径：文本/思考增量、toolCall 配对（含 tool_end 无 start 的幽灵兜底）、isError
// 状态位、turn_end 结束与计数、message_end 的 usage 归一与 totalTokens、error 只追加
// 入账与 lastError 派生（§3.3.5 新语义：turn_end 不再清除）、no-op 事件
// （compaction/activity/armed）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aggregateUsage,
  createReplayRecord,
  eventsToSessionView,
  toReplayedTurn,
  updateFromEvent as sdkUpdateFromEvent,
} from "@zhushanwen/subagent-engine-sdk";
import type { ReplayRecordView } from "@zhushanwen/subagent-engine-sdk";

import type { ExecutionRecord } from "../domain/record-model.ts";
import type { AgentEvent, AgentUsage } from "../assembly/types.ts";
import { createRecord, updateFromEvent } from "../persistence/execution-record.ts";

// 两侧 reducer 都以 Date.now() 给 toolCall / ErrorFact 打墙钟戳（事件载荷不带 ts）——
// 真实时钟下同一事件喂两侧跨毫秒边界时戳差 1ms，toEqual 断言假红（负载下偶发）。
// fake timers 固定时钟：两侧采点恒同值，等价性判定回到 reducer 语义本身（时钟不是
// 被测语义）。
beforeEach(() => {
  vi.useFakeTimers({ now: 1_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

function makeCore(): ExecutionRecord {
  return createRecord("sa-parity", {
    agent: "reviewer",
    mode: "background",
    slug: "parity",
    task: "parity check",
    startedAt: 1000,
  });
}

function makeFoldView(): ReplayRecordView {
  return createReplayRecord();
}

/** 双跑同一事件序列（live 容器 × fold 容器），返回两侧实例供逐字段比对。 */
function runBoth(events: readonly AgentEvent[]): { core: ExecutionRecord; fold: ReplayRecordView } {
  const core = makeCore();
  const fold = makeFoldView();
  for (const event of events) {
    updateFromEvent(core, event);
    sdkUpdateFromEvent(fold, event);
  }
  return { core, fold };
}

/** 断言 live 与 fold 的状态侧等价（turns 全文 + 计数 + usage + 失败事实族）。 */
function expectSameState(core: ExecutionRecord, fold: ReplayRecordView): void {
  expect(fold.turns).toEqual(core.turns);
  expect(fold.turnCount).toBe(core.turnCount);
  expect(fold.totalTokens).toBe(core.totalTokens);
  expect(fold.lastError).toBe(core.lastError);
  expect(fold.errors).toEqual(core.errors);
}

/** 端到端：eventsToSessionView（journal fold 出口）≡ live record 的同一投影。 */
function expectFoldProjectionParity(events: readonly AgentEvent[], core: ExecutionRecord): void {
  const view = eventsToSessionView(events, "pi", "sess-parity");
  expect(view.source).toBe("journal");
  expect(view.turns).toEqual(core.turns.map(toReplayedTurn));
  expect(view.usage).toEqual(aggregateUsage(core.turns));
}

const FULL_SEQUENCE: AgentEvent[] = [
  { type: "text_delta", delta: "hel" },
  { type: "text_delta", delta: "lo" },
  { type: "thinking_delta", delta: "plan" },
  { type: "tool_start", toolName: "read", args: { path: "/a/b/foo.ts" } },
  { type: "tool_end", toolName: "read", args: { path: "/a/b/foo.ts" }, result: { details: { ok: true } } },
  { type: "tool_start", toolName: "bash", args: { command: "ls" } },
  { type: "tool_end", toolName: "bash", args: { command: "ls" }, isError: true },
  { type: "message_end", usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 3 } },
  { type: "turn_end", summary: "first" },
  { type: "error", message: "transient" },
  { type: "compaction" },
  { type: "activity" },
  { type: "armed", schemaEnvVar: "PI_WORKFLOW_SCHEMA", extensionPkg: "@zhushanwen/pi-subagent-workflow" },
  { type: "turn_end" },
];

describe("reducer 合一等价（事件流 fold ≡ 内存单源）", () => {
  it("完整事件序列 live 与 fold 逐字段等价 + journal 投影等价", () => {
    const { core, fold } = runBoth(FULL_SEQUENCE);
    expectSameState(core, fold);
    expectFoldProjectionParity(FULL_SEQUENCE, core);
  });

  it("分段断言：文本与思考增量累积等价", () => {
    const { core, fold } = runBoth([
      { type: "text_delta", delta: "a" },
      { type: "thinking_delta", delta: "t" },
      { type: "text_delta", delta: "b" },
    ]);
    expectSameState(core, fold);
    expect(core.turns[0]?.text).toBe("ab");
    expect(fold.turns[0]?.text).toBe("ab");
  });

  it("分段断言：toolCall 配对与幽灵兜底等价（tool_end 无 start / 跨轮滞后 tool_end）", () => {
    const events: AgentEvent[] = [
      { type: "tool_start", toolName: "grep", args: { pattern: "x" } },
      // 无配对的 tool_end（外部注入工具 / 丢帧）→ 两侧都应 push 已完成项
      { type: "tool_end", toolName: "orphan", args: { q: 1 }, result: { details: "r" } },
      { type: "turn_end" },
      // turn_end 之后的滞后 tool_end → 跨轮倒序配对兜底
      { type: "tool_end", toolName: "grep", args: { pattern: "x" }, result: { details: "hit" } },
    ];
    const { core, fold } = runBoth(events);
    expectSameState(core, fold);
  });

  it("分段断言：usage 归一与 totalTokens 等价（含缺省字段）", () => {
    // 协议类型要求四字段齐全，但引擎实际可能只报部分字段——刻意以缺省形态喂入，
    // 覆盖两侧「缺省字段按 0 归一」的分支（同 budget.test.ts 的 as 用法）。
    const partialUsage = { input: 1, output: 2 } as AgentUsage;
    const events: AgentEvent[] = [
      { type: "message_end", usage: partialUsage },
      { type: "message_end", usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 } },
    ];
    const { core, fold } = runBoth(events);
    expectSameState(core, fold);
    expect(fold.totalTokens).toBe(core.totalTokens);
  });

  it("分段断言：error → turn_end 后 lastError 仍可读（§3.3.5 第 0 波②——不再被轮终清洗）", () => {
    const { core, fold } = runBoth([{ type: "error", message: "boom" }, { type: "turn_end" }]);
    expectSameState(core, fold);
    // 验收条款②：error → turn_end 序后 lastError 仍可读
    expect(core.lastError).toBe("boom");
    expect(fold.lastError).toBe("boom");
    // 失败事实只追加：单条 ErrorFact、时间戳为 fake 时钟值
    expect(core.errors).toEqual([{ message: "boom", at: 1000 }]);
    expect(fold.errors).toEqual([{ message: "boom", at: 1000 }]);
  });

  it("分段断言：error 跨轮只追加（复活/续聊后旧失败轮仍可见），lastError = 最后一个非空", () => {
    const events: AgentEvent[] = [
      { type: "error", message: "round-1 failure" },
      { type: "turn_end" },
      { type: "text_delta", delta: "retry" },
      { type: "message_end", error: "round-2 failure" },
      { type: "turn_end" },
    ];
    const { core, fold } = runBoth(events);
    expectSameState(core, fold);
    expect(core.errors).toEqual([
      { message: "round-1 failure", at: 1000 },
      { message: "round-2 failure", at: 1000 },
    ]);
    expect(core.lastError).toBe("round-2 failure");
  });

  it("分段断言：空串 error 不入账（无信息失败事实不占位，也不构成派生值）", () => {
    const { core, fold } = runBoth([
      { type: "error", message: "" },
      { type: "message_end", error: "" },
      { type: "turn_end" },
    ]);
    expectSameState(core, fold);
    expect(core.errors).toEqual([]);
    expect(core.lastError).toBeUndefined();
  });

  it("分段断言：turnCount 随 turn_end 单调推进等价", () => {
    const events: AgentEvent[] = [
      { type: "turn_end" },
      { type: "message_end" },
      { type: "turn_end" },
    ];
    const { core, fold } = runBoth(events);
    expectSameState(core, fold);
    expect(fold.turnCount).toBe(2);
  });
});
