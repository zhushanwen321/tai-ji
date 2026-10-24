// src/__tests__/spawn-event-translator.test.ts
//
// SdkEvent → AgentEvent 翻译器测试（createSdkEventTranslator 全分派面的单测锚）。
// 覆盖面：
//   - [U-A6] tool_execution_update → 工具执行期活性信号（设计 §3.3 决策 9 误杀面②）：
//     到达形态核实（实装 pi rpc 行经 parseSpawnLine 归 SdkEvent）、onEvent 收 /
//     onDelta 不收、record 零写入、1s 节流、静默工具不续命（pi 内置 bash 无默认超时，
//     该事件被 default 丢弃曾致长工具调用期间无进展守护误杀——背景详见
//     spawn-event-translator.ts handleToolExecutionUpdate 证据链注释）；
//   - [codemode u5/D4] 嵌套工具调用事件过滤：parentToolCallId 同判同滤（live ≡ reload，
//     嵌套 update 豁免——活性信号载体）；
//   - tool_execution_end result.content 形状透传：text/image 逐块保留（派生视图提取源）；
//   - [subagent-observability §3.3.1] 收尾边沿停因事实优先：error/aborted →
//     onErroredEnd（结构化输入随事实携带）、重试恢复清除未消费 error 事实、aborted
//     三源判别（host-cancel > turn-budget > engine）、干净停因 onAgentEnd + settled
//     快照停因与 P5 计账；
//   - [§3.3.9/UC-10] 预算显式化：maxTurns 管道生效 + {used, limit} 耗尽事实随收尾
//     边沿带出（非 turn-budget 支无该事实）；
//   - [§3.3.1 P3/P5] 队列事实边沿门控：queue_update 刷新、中间边沿不判终、auto_retry
//     journal 帧（边界事实入 journal，record 零写入）。

import { describe, expect, it, vi } from "vitest";

import { createReplayRecord, type AgentEvent } from "@zhushanwen/subagent-engine-sdk";

import { parseSpawnLine, type SdkEvent } from "../spawn-event-adapter.ts";
import { createSdkEventTranslator, type SdkTranslatorOpts } from "../spawn-event-translator.ts";
import { classificationMatchInputs } from "../retry-rules-classification.ts";
import type { TurnBudgetExhaustion } from "../turn-limiter.ts";

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

      // 启动那条至多把检查多等一次窗口；1h 静默期内活性信号不增殖 → 检查照常回收
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
// 与 transcript 派生视图对齐：reload 后嵌套调用只有外层一个工具块，live 期放行 start/end
// 会经本翻译层各产独立 tool_start/tool_end → 派生视图不一致（AGENTS.md 关键规则 9 /
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

// [subagent 派生视图丢失修复] tool_execution_end result 的 content 块形状透传（表驱动）。
//
// 丢失形态锚定：subagent 会话图片可见性依赖 tool_end.result.content 里的 image 块
// 原样透传（下游 = journal 重放 + GUI 派生视图的提取源）。本层为逐字透传层——result
// 不压缩不改写，任何形状（纯文本 / 纯 image / 混合交错）逐块保留；此处表驱动锁定
// 三种形状，防未来「翻译层顺手归一」回归（归一 = image 块丢失）。
describe("[subagent 派生视图丢失修复] tool_execution_end result content 形状透传（表驱动）", () => {
  const IMG = { type: "image", data: "aGVsbG8taW1hZ2U=", mimeType: "image/png" };

  const ROWS: Array<{ name: string; content: unknown[]; details?: unknown }> = [
    {
      name: "纯文本 content",
      content: [{ type: "text", text: "Script completed" }],
    },
    {
      name: "纯 image content",
      content: [IMG],
    },
    {
      name: "混合 content（text + image 交错，codemode 真机形状）",
      content: [{ type: "text", text: "Script completed" }, IMG, { type: "text", text: "done: 1x1 PNG" }],
      details: { calls: [{ id: "n1", name: "read", status: "done" }] },
    },
  ];

  for (const row of ROWS) {
    it(`result.content ${row.name} → tool_end 逐块透传 + record 保留`, () => {
      const h = makeHarness();
      h.feed(
        JSON.stringify({
          type: "tool_execution_end",
          toolCallId: "call_img_1",
          toolName: "codemode",
          args: { code: "img()" },
          result: { content: row.content, ...(row.details !== undefined ? { details: row.details } : {}) },
          isError: false,
        }),
      );

      const toolEnd = h.events.find((e) => e.type === "tool_end") as
        | { result?: { content?: unknown[]; details?: unknown } }
        | undefined;
      expect(toolEnd?.result?.content).toEqual(row.content);
      if (row.details !== undefined) {
        expect(toolEnd?.result?.details).toEqual(row.details);
      }
      // record（journal 重放路径）同样保留 image 块——GUI reload 路径的提取源
      const rec = h.record.turns[0]?.toolCalls[0];
      expect(rec?.result?.content).toEqual(row.content);
    });
  }
});

// [subagent-observability §3.3.1] 收尾边沿停因事实优先（判定事实化）。
//
// 判据（设计定稿）：最后一条 assistant 消息停因 ∈ {error, aborted} 或存在未消费的
// 引擎 error 事件 → onErroredEnd（失败收口）→ endedCleanly=false → 退出码非 0 →
// 轮失败；settled 只是 run 结束事实，不再是任何置 0 依据。aborted 三源判别在同一
// 收尾边沿裁决：宿主取消 > turn-limiter 耗尽（didAbort 事实位）> 引擎异常兜底；
// 禁止把 aborted 一律记失败。结构化输入（rawStopReason/diagnostics）随事实携带
//（§3.3.2 停止丢弃）。P5 计账：失败尝试识别锚 = auto_retry_start 边界，turns 排除
// 失败尝试、usage 切片基与 retryAttempts 计数随 settled 快照传出。
describe("[subagent-observability §3.3.1] 收尾边沿停因事实优先（表驱动）", () => {
  /** 标准错误 message_end 行（openai 兼容层 "<status>: <body>" 机读主通道形态）。 */
  const errorLine = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      type: "message_end",
      message: { stopReason: "error", errorMessage: "429: rate limited", ...overrides },
    });

  it("停因=error → onErroredEnd（停因 + errorMessage + 结构化输入三汇合），onAgentEnd 不触发", () => {
    let errored: import("../spawn-event-translator.ts").EngineRoundErrorFact | undefined;
    let agentEndSeen = false;
    const h = makeHarness({
      onAgentEnd: () => { agentEndSeen = true; },
      onErroredEnd: (fact) => { errored = fact; },
    });
    h.feed(errorLine());
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: false, reason: "error" }));

    expect(agentEndSeen).toBe(false); // 成功默认口径不再适用
    expect(errored).toMatchObject({ stopReason: "error", errorMessage: "429: rate limited", abortSource: "engine" });
  });

  it("结构化输入停止丢弃：rawStopReason / diagnostics 随收尾边沿事实携带（§3.3.2）", () => {
    let errored: import("../spawn-event-translator.ts").EngineRoundErrorFact | undefined;
    const h = makeHarness({
      onErroredEnd: (fact) => { errored = fact; },
    });
    h.feed(errorLine({ rawStopReason: "throttled", diagnostics: [{ type: "bedrock_response_failure", timestamp: 1 }] }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: false }));

    expect(errored?.rawStopReason).toBe("throttled");
    expect(errored?.diagnostics).toEqual([{ type: "bedrock_response_failure", timestamp: 1 }]);
  });

  it("重试后再失败：结构化输入与最终失败帧同帧绑定，不携带先前尝试的 diagnostics（§3.3.2 死因错标防线）", () => {
    let errored: import("../spawn-event-translator.ts").EngineRoundErrorFact | undefined;
    const h = makeHarness({
      onErroredEnd: (fact) => { errored = fact; },
    });
    // 尝试 1：error 停因带 diagnostics A（结构化码表可命中的 error.code 形态）
    h.feed(errorLine({
      rawStopReason: "error",
      diagnostics: [{ type: "response_failure", error: { name: "APIError", message: "1311: insufficient balance", code: "1311" } }],
    }));
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: true, reason: "retryable" }));
    h.feed(JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "1311" }));
    // 尝试 2：最终失败帧不带 diagnostics（最终死因文本与尝试 1 不同）
    h.feed(errorLine({ errorMessage: "1211: permission denied" }));
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: false, reason: "error" }));

    // 收尾边沿结构化事实属「最后一条停因帧」：旧尝试 diagnostics 不再留存
    expect(errored?.diagnostics).toBeUndefined();
    expect(errored?.rawStopReason).toBeUndefined();
    expect(errored?.errorMessage).toBe("1211: permission denied");
    // 分类输入不再合成 A 帧结构化文本（码表不按旧尝试死因分类）
    const inputs = classificationMatchInputs(errored!);
    expect(inputs).toEqual(["1211: permission denied"]);
    expect(JSON.stringify(inputs)).not.toContain("1311");
  });

  it("重试恢复：失败尝试（willRetry=true）不判终；成功响应清除未消费 error 事实 → 干净收尾", () => {
    let errored: import("../spawn-event-translator.ts").EngineRoundErrorFact | undefined;
    let agentEndSeen = false;
    const h = makeHarness({
      onAgentEnd: () => { agentEndSeen = true; },
      onErroredEnd: (fact) => { errored = fact; },
    });
    // 失败尝试（真实事件序 error → turn_end → agent_end willRetry=true）
    h.feed(errorLine());
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: true, reason: "retryable" }));
    expect(errored).toBeUndefined(); // 重试在途——非轮终
    h.feed(JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "429" }));
    // 最终尝试成功（非 error 停因到达 = 未消费 error 事实清除）
    h.feed(JSON.stringify({ type: "message_end", message: { usage: { input: 1 }, stopReason: "stop" } }));
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: false, reason: "end_turn" }));

    expect(agentEndSeen).toBe(true);
    expect(errored).toBeUndefined();
  });

  it("aborted 三源判别（表驱动）：宿主取消 > limiter 耗尽 > 引擎异常兜底", () => {
    const rows: Array<{
      name: string;
      hostAborted: boolean;
      limiterAbort: boolean;
      expected: "host-cancel" | "turn-budget" | "engine";
    }> = [
      { name: "宿主取消信号置位 → host-cancel（中止非失败）", hostAborted: true, limiterAbort: false, expected: "host-cancel" },
      { name: "宿主取消 + limiter 同时置位 → 宿主取消优先", hostAborted: true, limiterAbort: true, expected: "host-cancel" },
      { name: "limiter didAbort（宽限轮耗尽）→ turn-budget", hostAborted: false, limiterAbort: true, expected: "turn-budget" },
      { name: "无前两者的 aborted → 引擎异常兜底", hostAborted: false, limiterAbort: false, expected: "engine" },
    ];
    for (const row of rows) {
      let errored: import("../spawn-event-translator.ts").EngineRoundErrorFact | undefined;
      const h = makeHarness({
        isHostAbortRequested: () => row.hostAborted,
        onErroredEnd: (fact) => { errored = fact; },
        ...(row.limiterAbort
          ? // limiter 耗尽形态：同一 translator 闭包内制造 didAbort 事实位
            //（maxTurns=1 + graceTurns=0 下两个 turn_end 触发 abort——abort 经
            // opts.abort 注入，didAbort 翻真后停因事实才到达）
            { maxTurns: 1, graceTurns: 0 }
          : {}),
      });
      if (row.limiterAbort) {
        h.feed(JSON.stringify({ type: "turn_end" }));
        h.feed(JSON.stringify({ type: "turn_end" })); // steered 后 grace 耗尽 → abort
      }
      h.feed(JSON.stringify({ type: "message_end", message: { stopReason: "aborted", errorMessage: "aborted by user" } }));
      h.feed(JSON.stringify({ type: "agent_end", willRetry: false, reason: "aborted" }));

      expect(errored?.stopReason).toBe("aborted");
      expect(errored?.abortSource).toBe(row.expected);
    }
  });

  it("干净停因（stop）→ onAgentEnd（成功口径维持）；settled 快照停因记 stop", () => {
    let agentEndSeen = false;
    let erroredSeen = false;
    let snapshot: import("../spawn-event-translator.ts").SettledRoundSnapshot | undefined;
    const h = makeHarness({
      onAgentEnd: () => { agentEndSeen = true; },
      onErroredEnd: () => { erroredSeen = true; },
      onAgentSettled: (s) => { snapshot = s; },
    });
    h.feed(JSON.stringify({ type: "message_end", message: { usage: { input: 3 }, stopReason: "stop" } }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: false, reason: "end_turn" }));
    h.feed(JSON.stringify({ type: "agent_settled" }));

    expect(agentEndSeen).toBe(true);
    expect(erroredSeen).toBe(false);
    expect(snapshot).toMatchObject({ turnsAtSettle: 0, finalAttemptTurnBase: 0, retryAttempts: 0, stopReason: "stop" });
  });

  it("P5 计账：auto_retry_start 边界后的 turns 才计入（失败尝试排除）+ retryAttempts 计数", () => {
    let snapshot: import("../spawn-event-translator.ts").SettledRoundSnapshot | undefined;
    const h = makeHarness({
      onAgentSettled: (s) => { snapshot = s; },
    });
    // 失败尝试：1 个 turn
    h.feed(errorLine());
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: true }));
    h.feed(JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "429" }));
    // 最终尝试：1 个 turn
    h.feed(JSON.stringify({ type: "message_end", message: { usage: { input: 1 }, stopReason: "stop" } }));
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: false }));
    h.feed(JSON.stringify({ type: "agent_settled" }));

    // record.turnCount 原始累计 2（reducer 语义不动）；快照排除失败尝试 → 1
    expect(h.record.turnCount).toBe(0); // settled 后按轮清零（SP-9）
    expect(snapshot?.turnsAtSettle).toBe(1);
    expect(snapshot?.finalAttemptTurnBase).toBe(1);
    expect(snapshot?.retryAttempts).toBe(1);
    expect(snapshot?.stopReason).toBe("stop");
  });
});

describe("[subagent-observability §3.3.9/UC-10] 预算显式化：limiter 管道生效 + 耗尽事实随收尾边沿带出", () => {
  /** aborted 停因行（limiter 耗尽与 aborted 停因并存的防御性同判形态）。 */
  const abortedLine = (): string =>
    JSON.stringify({ type: "message_end", message: { stopReason: "aborted", errorMessage: "aborted by user" } });

  it("maxTurns 显式传参：宽限轮耗尽 → opts.abort 收到 {used, limit}（UC-9 缺省不传 = 管道禁用零 abort）", () => {
    const abortCalls: TurnBudgetExhaustion[] = [];
    const h = makeHarness({ maxTurns: 1, abort: (info) => abortCalls.push(info) });
    h.feed(JSON.stringify({ type: "turn_end" })); // steer（到达 maxTurns）
    h.feed(JSON.stringify({ type: "turn_end" })); // grace 0（显式缺省 2 未到）——不 abort
    expect(abortCalls).toEqual([]); // 缺省宽限轮 2：steer 后两轮内不杀
    h.feed(JSON.stringify({ type: "turn_end" })); // 缺省宽限第 2 轮耗尽 → abort
    expect(abortCalls).toEqual([{ used: 3, limit: 1 }]);
    // unbounded 对照：maxTurns 缺省（不传）下同规模轮数零 abort（UC-9 默认行为不变）
    const abortUnbounded: TurnBudgetExhaustion[] = [];
    const hu = makeHarness({ abort: (info) => abortUnbounded.push(info) });
    for (let i = 0; i < 10; i++) hu.feed(JSON.stringify({ type: "turn_end" }));
    expect(abortUnbounded).toEqual([]);
  });

  it("limiter 耗尽 + aborted 停因并存 → EngineRoundErrorFact 带 turnBudget {used, limit}（abortSource=turn-budget）", () => {
    let errored: import("../spawn-event-translator.ts").EngineRoundErrorFact | undefined;
    const abortCalls: TurnBudgetExhaustion[] = [];
    const h = makeHarness({
      maxTurns: 1,
      abort: (info) => abortCalls.push(info),
      onErroredEnd: (fact) => { errored = fact; },
    });
    h.feed(JSON.stringify({ type: "turn_end" })); // steer
    h.feed(JSON.stringify({ type: "turn_end" })); // 缺省宽限轮 1 —— 不 abort
    expect(abortCalls).toEqual([]);
    h.feed(JSON.stringify({ type: "turn_end" })); // 缺省宽限轮 2 耗尽 → abort({used:3,limit:1})
    expect(abortCalls).toEqual([{ used: 3, limit: 1 }]);
    h.feed(abortedLine());
    h.feed(JSON.stringify({ type: "agent_end", willRetry: false, reason: "aborted" }));

    expect(errored?.stopReason).toBe("aborted");
    expect(errored?.abortSource).toBe("turn-budget");
    expect(errored?.turnBudget).toEqual({ used: 3, limit: 1 });
  });

  it("非 turn-budget 支无 turnBudget 事实（host-cancel / engine，无耗尽发生）", () => {
    const rows: Array<{ name: string; hostAborted: boolean; expected: "host-cancel" | "engine" }> = [
      { name: "宿主取消", hostAborted: true, expected: "host-cancel" },
      { name: "引擎异常兜底", hostAborted: false, expected: "engine" },
    ];
    for (const row of rows) {
      let errored: import("../spawn-event-translator.ts").EngineRoundErrorFact | undefined;
      const h = makeHarness({
        isHostAbortRequested: () => row.hostAborted,
        onErroredEnd: (fact) => { errored = fact; },
      });
      h.feed(abortedLine());
      h.feed(JSON.stringify({ type: "agent_end", willRetry: false, reason: "aborted" }));
      expect(errored?.abortSource).toBe(row.expected);
      expect(errored?.turnBudget).toBeUndefined();
    }
  });
});

// [subagent-observability §3.3.1 P3 队列事实 + P5 journal 帧]
//
// P3：pi 1.0.0 _runAgentPrompt 循环（agent-session.js:1354-1368）——follow-up/steer
// 队列非空时 agent_end 后 run 继续（agent.continue()），此刻 agent_end 是中间边沿；
// 队列事实取自 queue_update 事件（_emitQueueUpdate 入队/出队逐帧刷新）。中间边沿不
// 判终（onAgentEnd/onErroredEnd 都不发），轮终判定留给队列排空后的末边沿。
// F1-32：auto_retry_start/end 边界帧翻译进 journal（{type:"auto_retry", phase, ...}），
// 失败尝试轨迹不静默；帧为观测面，record 派生视图零写入（reducer no-op）。
describe("[subagent-observability §3.3.1] P3 队列事实边沿门控 + auto_retry journal 帧", () => {
  const queueLine = (steering: string[], followUp: string[] = []): string =>
    JSON.stringify({ type: "queue_update", steering, followUp });
  const stopLine = (): string =>
    JSON.stringify({ type: "message_end", message: { usage: { input: 1 }, stopReason: "stop" } });
  const errorLine = (): string =>
    JSON.stringify({ type: "message_end", message: { stopReason: "error", errorMessage: "429: rate limited" } });

  it("P3：队列非空的 agent_end = 中间边沿不判终；队列排空后的 agent_end 才触发 onAgentEnd", () => {
    let agentEndSeen = 0;
    let erroredSeen = false;
    const h = makeHarness({
      onAgentEnd: () => { agentEndSeen += 1; },
      onErroredEnd: () => { erroredSeen = true; },
    });
    // steer 注入（workflow-hook deliverAs=steer 形态）→ 中间 run 完成
    h.feed(queueLine(["follow-up task"]));
    h.feed(stopLine());
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: false, reason: "end_turn" }));
    expect(agentEndSeen).toBe(0); // 中间边沿：不置 clean、不判终
    expect(erroredSeen).toBe(false);

    // 队列排空（出队帧）→ 续 run 完成 → 末边沿判终
    h.feed(queueLine([], []));
    h.feed(stopLine());
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: false, reason: "end_turn" }));
    expect(agentEndSeen).toBe(1);
  });

  it("P3 × 错误停因：中间边沿不产 onErroredEnd；续 run 恢复后末边沿干净收尾（旧失败不翻终局）", () => {
    let errored: import("../spawn-event-translator.ts").EngineRoundErrorFact | undefined;
    let agentEndSeen = 0;
    const h = makeHarness({
      onAgentEnd: () => { agentEndSeen += 1; },
      onErroredEnd: (fact) => { errored = fact; },
    });
    // steer 在途 + 第一段 run 非重试错误结束（队列非空 → pi 会 continue）
    h.feed(queueLine(["next step"]));
    h.feed(errorLine());
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: false, reason: "error" }));
    expect(errored).toBeUndefined(); // 中间边沿不判终（失败事实已由 error 事件入 journal）
    expect(agentEndSeen).toBe(0);

    // 续 run 成功（非 error 停因清除未消费 error 事实）→ 末边沿干净收尾
    h.feed(queueLine([], []));
    h.feed(stopLine());
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: false, reason: "end_turn" }));
    expect(agentEndSeen).toBe(1);
    expect(errored).toBeUndefined();
  });

  it("P3：末边沿错误停因仍照常判终（队列排空后的 error → onErroredEnd 通路不受门控影响）", () => {
    let errored: import("../spawn-event-translator.ts").EngineRoundErrorFact | undefined;
    const h = makeHarness({
      onErroredEnd: (fact) => { errored = fact; },
    });
    h.feed(queueLine(["x"]));
    h.feed(queueLine([], [])); // 入队即出队（续 run 消费后队列已空）
    h.feed(errorLine());
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: false, reason: "error" }));
    expect(errored).toMatchObject({ stopReason: "error", errorMessage: "429: rate limited" });
  });

  it("F1-32：auto_retry_start/end 翻译为 auto_retry journal 帧（边界事实字段原样承载）", () => {
    const h = makeHarness();
    h.feed(errorLine());
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: true, reason: "retryable" }));
    h.feed(JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "429: rate limited" }));
    h.feed(stopLine());
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: false, reason: "end_turn" }));
    h.feed(JSON.stringify({ type: "auto_retry_end", success: true, attempt: 1 }));

    expect(h.events).toContainEqual({
      type: "auto_retry",
      phase: "start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      errorMessage: "429: rate limited",
    });
    expect(h.events).toContainEqual({ type: "auto_retry", phase: "end", attempt: 1, success: true });
  });

  it("F1-32：auto_retry 帧对 record 零写入（观测面——失败尝试不混进 turns 聚合）", () => {
    const h = makeHarness();
    h.feed(errorLine());
    h.feed(JSON.stringify({ type: "turn_end" }));
    h.feed(JSON.stringify({ type: "agent_end", willRetry: true }));
    h.feed(JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 5, errorMessage: "boom" }));
    h.feed(JSON.stringify({ type: "auto_retry_end", success: false, attempt: 1, finalError: "boom" }));

    // 帧本身不产生 turn / usage / toolCall（P5 计账锚在引擎收尾快照，不依赖宿主消费）
    expect(h.events.filter((e) => e.type === "auto_retry")).toHaveLength(2);
    expect(h.record.turns).toHaveLength(1); // 仅失败尝试的 message_end 产出的 turn
    expect(JSON.stringify(h.record)).not.toContain("auto_retry");
  });
});
