// src/__tests__/spawn-event-translator.test.ts
//
// [U-A6] tool_execution_update → 工具执行期活性信号（设计 §3.3 决策 9 误杀面②）。
//
// 背景：pi 内置 bash 无默认超时，执行期以 100ms 节流推 tool_execution_update；该事件原被
// 翻译 switch 的 default 丢弃 → 长工具调用（>30min 构建/测试）期间 workflow/chat 两域的
// 无进展守护「刷新两路同时失明」→ 合法任务被判无进展取消。
//
// 本文件覆盖：
//   - 到达形态核实：实装 pi rpc 形态的 tool_execution_update 行经 parseSpawnLine
//     归 kind="event" 的 SdkEvent（不是别的包装）；字段形状含 partialResult；
//   - 活性信号：onEvent 收到（core 刷新面消费）、onDelta 不收（硬约束① 不污染正文槽）；
//   - 不污染聊天记录：record 不因活性信号多出正文/思考/工具条目（载体零写入）；
//   - 节流：1s 内连续 update 只发一条，跨 1s 再发；
//   - 硬约束②：静默工具（tool_start + 执行入口那条空 content 刷新，此后零 update）
//     不持续产活性信号——楔死工具不会因本信号被续命（实装 pi bash.js:287 在 execute
//     入口无条件发一条空 content update，故「静默」= 启动后零 update，非零 update）；
//   - 既有翻译面零变化：tool_start / text_delta / turn_end 语义不受影响。

import { describe, expect, it, vi } from "vitest";

import { createReplayRecord, type AgentEvent } from "@zhushanwen/subagent-engine-sdk";

import { parseSpawnLine, type SdkEvent } from "../spawn-event-adapter.ts";
import { createSdkEventTranslator, type SdkTranslatorOpts } from "../spawn-event-translator.ts";

/**
 * 实装 pi 0.84.4 rpc 形态的原始 stdout 行（agent-loop emit → agent-session _emit →
 * rpc-mode output(toJsonEvent(event)) → JSON 行；字段与 dist 逐字对齐）。
 */
function toolUpdateLine(partialText = "partial build output line 1"): string {
  return JSON.stringify({
    type: "tool_execution_update",
    toolCallId: "call_bash_1",
    toolName: "bash",
    args: { command: "npm run build" },
    partialResult: { content: [{ type: "text", text: partialText }], details: null },
  });
}

/** 走真实「stdout 行 → parseSpawnLine → SdkEvent」链（到达形态不在本文件另设包装）。 */
function parseEventLine(line: string): SdkEvent {
  const parsed = parseSpawnLine(line);
  if (parsed === null || parsed.kind !== "event") {
    throw new Error(`expected kind=event, got: ${JSON.stringify(parsed)}`);
  }
  return parsed.event;
}

interface Harness {
  record: ReturnType<typeof createReplayRecord>;
  events: AgentEvent[];
  deltas: string[];
  feed: (line: string) => void;
}

function makeHarness(overrides: Partial<SdkTranslatorOpts> = {}): Harness {
  const record = createReplayRecord();
  const events: AgentEvent[] = [];
  const deltas: string[] = [];
  const translator = createSdkEventTranslator(record, {
    onEvent: (e) => events.push(e),
    onDelta: (d) => deltas.push(d),
    abort: () => {},
    ...overrides,
  });
  return { record, events, deltas, feed: (line) => translator(parseEventLine(line)) };
}

/** 活性信号 = 第一类 activity 变体（纯活性信号，见 spawn-event-translator 载体注释）。 */
const ACTIVITY_EVENT: AgentEvent = { type: "activity" };

describe("[U-A6] tool_execution_update 到达形态与活性信号", () => {
  it("到达形态核实：rpc 行经 parseSpawnLine 归 SdkEvent（kind=event），字段形状与 pi dist 对齐", () => {
    const parsed = parseSpawnLine(toolUpdateLine());

    expect(parsed?.kind).toBe("event");
    if (parsed?.kind !== "event") throw new Error("unreachable");
    expect(parsed.event.type).toBe("tool_execution_update");
    expect(parsed.event.toolCallId).toBe("call_bash_1");
    expect(parsed.event.toolName).toBe("bash");
    // partialResult 是 pi 的增量快照（bash 为累积输出，非切片）——本修复不消费其内容
    expect(parsed.event.partialResult).toMatchObject({
      content: [{ type: "text", text: "partial build output line 1" }],
    });
  });

  it("活性信号：onEvent 收到（core 刷新面消费）；onDelta 不收（硬约束① 不污染正文槽）", () => {
    const h = makeHarness();
    h.feed(toolUpdateLine());

    expect(h.events).toEqual([ACTIVITY_EVENT]);
    expect(h.deltas).toEqual([]); // 工具输出绝不进 text_delta/onDelta 通道
  });

  it("不污染聊天记录：活性信号对 record 零写入（无正文/思考/工具条目/错误）", () => {
    const h = makeHarness();
    h.feed(JSON.stringify({ type: "tool_execution_start", toolCallId: "call_bash_1", toolName: "bash" }));
    h.feed(toolUpdateLine());

    // tool_start 是唯一写记录的来源；活性信号不得追加任何字段
    expect(h.record.turns).toHaveLength(1);
    expect(h.record.turns[0]).toMatchObject({ text: "", thinking: "", toolCalls: [{ toolName: "bash" }] });
    expect(h.record.lastError).toBeUndefined();
    expect(h.record.totalTokens).toBe(0);
    expect(h.record.turnCount).toBe(0);
    // 工具输出文本不出现在 record 的任何字段（取证：整条 record 序列化后不含输出）
    expect(JSON.stringify(h.record)).not.toContain("partial build output");
  });

  it("节流：1s 内的连续 update 只发一条活性信号，跨 1s 后再发（journal/wire 体量控制）", () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.feed(toolUpdateLine());
      h.feed(toolUpdateLine("第二条输出"));
      h.feed(toolUpdateLine("第三条输出"));
      expect(h.events).toEqual([ACTIVITY_EVENT]); // 同一 1s 窗内只发一次

      vi.advanceTimersByTime(1_500);
      h.feed(toolUpdateLine("跨窗输出"));
      expect(h.events).toEqual([ACTIVITY_EVENT, ACTIVITY_EVENT]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("硬约束②：静默工具（tool_start + 启动瞬间一条空 content update，此后零 update）不持续产活性信号——楔死工具不被续命", () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.feed(JSON.stringify({ type: "tool_execution_start", toolCallId: "call_bash_1", toolName: "bash" }));
      // 实装 pi bash.js:287：execute 入口**无条件**发一条空 content update——「静默工具」
      // 的实装形态是启动瞬间恰一条刷新，而非零 update。此后该工具零产出（finishOutput 前
      // 无任何 handleData），不再有 update。
      h.feed(
        JSON.stringify({
          type: "tool_execution_update",
          toolCallId: "call_bash_1",
          toolName: "bash",
          partialResult: { content: [], details: undefined },
        }),
      );
      // 工具静默楔死：1 小时内零 update（真实守护窗 30min 远小于该时间）
      vi.advanceTimersByTime(3_600_000);

      // 启动那条至多把守卫多等一次窗口；1h 静默期内活性信号不增殖 → 守卫照常回收
      expect(h.events).toEqual([
        { type: "tool_start", toolName: "bash", args: undefined },
        ACTIVITY_EVENT,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("既有翻译面零变化：tool_start / text_delta / turn_end 语义不受新分支影响", () => {
    const h = makeHarness();
    h.feed(JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a" } }));
    h.feed(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }));
    h.feed(JSON.stringify({ type: "turn_end" }));

    expect(h.events).toEqual([
      { type: "tool_start", toolName: "read", args: { path: "a" } },
      { type: "text_delta", delta: "hi" },
      { type: "turn_end" },
    ]);
    expect(h.deltas).toEqual(["hi"]);
    expect(h.record.turns[0]?.text).toBe("hi");
  });
});
