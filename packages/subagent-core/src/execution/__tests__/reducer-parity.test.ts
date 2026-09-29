// src/execution/__tests__/reducer-parity.test.ts
//
// [§3.1.4 差分对拍] 事件 reducer 双实现等价性——core（execution-record.updateFromEvent，
// 活体累积路径）vs SDK（journal-replay.updateFromEvent，journal 重放路径）。
//
// 为什么需要本文件：设计决策是「重放与 live 共用同一 reducer」，实现上却是两份逐字
// 同形的副本（core 与 SDK 各一份），而既有 conformance C5 用例只跑 SDK 路径、从不调用
// core 那份——「共用」停留在用例标题，真出现漂移无人发现。两条路各自演进时（新增
// AgentEvent variant / 改 usage 归一 / 改 toolCall 配对兜底），唯一能抓住差异的就是
// 本文件：同一事件序列分喂两侧，逐字段比对。
//
// 覆盖口径：文本/思考增量、toolCall 配对（含 tool_end 无 start 的幽灵兜底）、isError
// 状态位、turn_end 闭合与计数、message_end 的 usage 归一与 totalTokens、error 记录与
// 轮终清除、no-op 事件（compaction/activity/armed）。
import { describe, expect, it } from "vitest";

import { updateFromEvent as sdkUpdateFromEvent } from "@zhushanwen/subagent-engine-sdk";
import type { ReplayRecordView } from "@zhushanwen/subagent-engine-sdk";

import type { AgentEvent, AgentUsage, ExecutionRecord } from "../assembly/types.ts";
import { createRecord, updateFromEvent } from "../persistence/execution-record.ts";

function makeCore(): ExecutionRecord {
  return createRecord("sa-parity", {
    agent: "reviewer",
    mode: "background",
    slug: "parity",
    task: "parity check",
    startedAt: 1000,
  });
}

function makeSdkView(): ReplayRecordView {
  return { turns: [], turnCount: 0, totalTokens: 0, lastError: undefined };
}

/** 双跑同一事件序列，返回两侧实例供逐字段比对。 */
function runBoth(events: readonly AgentEvent[]): { core: ExecutionRecord; sdk: ReplayRecordView } {
  const core = makeCore();
  const sdk = makeSdkView();
  for (const event of events) {
    updateFromEvent(core, event);
    sdkUpdateFromEvent(sdk, event);
  }
  return { core, sdk };
}

/** 断言两侧 reducer 的状态面等价（turns 全文 + 计数 + usage + 末次错误）。 */
function expectParity(core: ExecutionRecord, sdk: ReplayRecordView): void {
  expect(sdk.turns).toEqual(core.turns);
  expect(sdk.turnCount).toBe(core.turnCount);
  expect(sdk.totalTokens).toBe(core.totalTokens);
  expect(sdk.lastError).toBe(core.lastError);
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

describe("reducer parity（core 活体 vs SDK 重放）", () => {
  it("完整事件序列两侧逐字段等价", () => {
    const { core, sdk } = runBoth(FULL_SEQUENCE);
    expectParity(core, sdk);
  });

  it("分段断言：文本与思考增量累积等价", () => {
    const { core, sdk } = runBoth([
      { type: "text_delta", delta: "a" },
      { type: "thinking_delta", delta: "t" },
      { type: "text_delta", delta: "b" },
    ]);
    expectParity(core, sdk);
    expect(core.turns[0]?.text).toBe("ab");
    expect(sdk.turns[0]?.text).toBe("ab");
  });

  it("分段断言：toolCall 配对与幽灵兜底等价（tool_end 无 start / 跨轮滞后 tool_end）", () => {
    const { core, sdk } = runBoth([
      { type: "tool_start", toolName: "grep", args: { pattern: "x" } },
      // 无配对的 tool_end（外部注入工具 / 丢帧）→ 两侧都应 push 已完成项
      { type: "tool_end", toolName: "orphan", args: { q: 1 }, result: { details: "r" } },
      { type: "turn_end" },
      // turn_end 之后的滞后 tool_end → 跨轮倒序配对兜底
      { type: "tool_end", toolName: "grep", args: { pattern: "x" }, result: { details: "hit" } },
    ]);
    expectParity(core, sdk);
  });

  it("分段断言：usage 归一与 totalTokens 等价（含缺省字段）", () => {
    // 协议类型要求四字段齐全，但引擎实际可能只报部分字段——刻意以缺省形态喂入，
    // 覆盖两侧「缺省字段按 0 归一」的分支（同 budget.test.ts 的 as 用法）。
    const partialUsage = { input: 1, output: 2 } as AgentUsage;
    const { core, sdk } = runBoth([
      { type: "message_end", usage: partialUsage },
      { type: "message_end", usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 } },
    ]);
    expectParity(core, sdk);
    expect(sdk.totalTokens).toBe(core.totalTokens);
  });

  it("分段断言：error 记录与轮终清除等价", () => {
    const { core, sdk } = runBoth([{ type: "error", message: "boom" }, { type: "turn_end" }]);
    expectParity(core, sdk);
    expect(sdk.lastError).toBeUndefined();
    expect(core.lastError).toBeUndefined();
  });

  it("分段断言：turnCount 随 turn_end 单调推进等价", () => {
    const { core, sdk } = runBoth([
      { type: "turn_end" },
      { type: "message_end" },
      { type: "turn_end" },
    ]);
    expectParity(core, sdk);
    expect(sdk.turnCount).toBe(2);
  });
});
