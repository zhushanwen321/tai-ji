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

// [codemode u5 / D4] 嵌套工具调用事件过滤（live ≡ reload 对齐）。
//
// 判据来源（pi 1.0.0 dist 实证；非 codemode 专属逻辑——本注释防止未来被误判为
// codemode 专属而错误放行）：工具经 ctx.executeTool() 发起的嵌套调用，其
// tool_execution_start / tool_execution_update / tool_execution_end 事件一律携带
// parentToolCallId（pi dist/core/nested-tool-calls.js 三处 emit 点，嵌套 id 形态
// `${parentToolCallId}/${n}`），且嵌套调用不落 transcript（pi dist/core/extensions/
// types.d.ts executeTool 契约「It does not appear in the transcript」）。过滤语义 =
// 与 transcript 投影对齐：reload 后嵌套调用只有外层一个工具块，live 期放行 start/end
// 会经本翻译层各产独立 tool_start/tool_end → 投影不一致（AGENTS.md 关键规则 9 /
// codemode 设计 §3.3 D4）。
//
// start 与 end 必须同判同滤：仅滤 start 会让嵌套 end 对未注册 toolCallId 发出孤儿
// tool_end。tool_execution_update 豁免（判据不含 update）：嵌套 update 是 U-A6
// 无进展守护的活性信号载体（嵌套执行窗口内唯一在途刷新源），照常映射。
describe("[codemode u5 / D4] 嵌套工具调用事件过滤（表驱动）", () => {
  const OUTER_ID = "call_outer_1";
  const NESTED_ID = `${OUTER_ID}/1`;

  /** 行 = 单条 stdout 行 + 期望 onEvent 收到的事件数组（filtered 行期望空数组）。 */
  const ROWS: Array<{ name: string; raw: Record<string, unknown>; expected: AgentEvent[] }> = [
    {
      name: "嵌套 start → 过滤（不产独立 tool_start）",
      raw: { type: "tool_execution_start", toolCallId: NESTED_ID, toolName: "read", args: { path: "a" }, parentToolCallId: OUTER_ID },
      expected: [],
    },
    {
      name: "嵌套 end → 过滤（不对未注册 toolCallId 发孤儿 tool_end）",
      raw: { type: "tool_execution_end", toolCallId: NESTED_ID, toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false, parentToolCallId: OUTER_ID },
      expected: [],
    },
    {
      name: "嵌套 update → 豁免（U-A6 活性信号照发，嵌套窗口内唯一在途刷新源）",
      raw: { type: "tool_execution_update", toolCallId: NESTED_ID, toolName: "read", partialResult: { content: [{ type: "text", text: "partial" }] }, parentToolCallId: OUTER_ID },
      expected: [ACTIVITY_EVENT],
    },
    {
      name: "非嵌套 start → 零影响（tool_start 照常）",
      raw: { type: "tool_execution_start", toolCallId: "call_top", toolName: "read", args: { path: "a" } },
      expected: [{ type: "tool_start", toolName: "read", args: { path: "a" } }],
    },
    {
      name: "非嵌套 end → 零影响（tool_end 照常；无 start 时 args 缺省回退）",
      raw: { type: "tool_execution_end", toolCallId: "call_top", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false },
      expected: [{ type: "tool_end", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false }],
    },
    {
      name: "非嵌套 update → 零影响（活性信号照常）",
      raw: { type: "tool_execution_update", toolCallId: "call_top", toolName: "bash", partialResult: { content: [{ type: "text", text: "partial" }] } },
      expected: [ACTIVITY_EVENT],
    },
    {
      name: "边界：parentToolCallId 空串按非嵌套放行（畸形值宁放行不误丢顶层块）",
      raw: { type: "tool_execution_start", toolCallId: NESTED_ID, toolName: "read", args: { path: "a" }, parentToolCallId: "" },
      expected: [{ type: "tool_start", toolName: "read", args: { path: "a" } }],
    },
  ];

  for (const row of ROWS) {
    it(row.name, () => {
      const h = makeHarness();
      h.feed(JSON.stringify(row.raw));

      expect(h.events).toEqual(row.expected);
      // 过滤行对 record 零写入（无工具条目——live 工具块计数 ≡ reload 的 record 侧锚点）
      if (row.expected.length === 0) {
        expect(JSON.stringify(h.record)).not.toContain(row.raw.toolCallId as string);
      }
    });
  }

  it("同判复合场景：外层 start/end 之间夹嵌套 start+update+end——恰产外层一对 tool_start/tool_end，无孤儿 tool_end", () => {
    const h = makeHarness();
    h.feed(JSON.stringify({ type: "tool_execution_start", toolCallId: OUTER_ID, toolName: "codemode", args: { code: "await tools.read({path:'a'})" } }));
    h.feed(JSON.stringify({ type: "tool_execution_start", toolCallId: NESTED_ID, toolName: "read", args: { path: "a" }, parentToolCallId: OUTER_ID }));
    h.feed(JSON.stringify({ type: "tool_execution_update", toolCallId: NESTED_ID, toolName: "read", partialResult: { content: [{ type: "text", text: "partial" }] }, parentToolCallId: OUTER_ID }));
    h.feed(JSON.stringify({ type: "tool_execution_end", toolCallId: NESTED_ID, toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false, parentToolCallId: OUTER_ID }));
    h.feed(JSON.stringify({ type: "tool_execution_end", toolCallId: OUTER_ID, toolName: "codemode", result: { content: [{ type: "text", text: "script done" }] }, isError: false }));

    expect(h.events).toEqual([
      { type: "tool_start", toolName: "codemode", args: { code: "await tools.read({path:'a'})" } },
      ACTIVITY_EVENT, // 嵌套 update 豁免——嵌套窗口内活性信号照发
      { type: "tool_end", toolName: "codemode", args: { code: "await tools.read({path:'a'})" }, result: { content: [{ type: "text", text: "script done" }] }, isError: false },
    ]);
    // record 只有外层一个工具条目（嵌套不写 record）——live 工具块计数 ≡ reload
    expect(h.record.turns[0]?.toolCalls).toHaveLength(1);
    expect(h.record.turns[0]?.toolCalls[0]?.toolName).toBe("codemode");
  });
});
