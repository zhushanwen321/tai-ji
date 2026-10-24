// src/spawn-event-translator.ts
//
// SdkEvent → AgentEvent 翻译器（spawn-runner.ts 行为等价提取）——翻译 + reducer
// 累积的闭包工厂（core createSpawnEventHandlers 的协议化提取）。分派面按事件族
// 拆语义 handler（tool / message-update / agent 终态 / message_end），switch 只做
// 事件类型路由。

import {
  createReplayRecord,
  updateFromEvent as updateRecordFromEvent,
  type AgentEvent,
} from "@zhushanwen/subagent-engine-sdk";

import { mapAssistantMessageDelta, resolveToolEndArgs } from "./spawn-args.ts";
import type { SdkEvent } from "./spawn-event-adapter.ts";
import { createTurnLimiter, type TurnBudgetExhaustion } from "./turn-limiter.ts";

/** [U-A6] 工具执行期活性信号的最小发射间隔（ms）；量级依据见 handleToolExecutionUpdate。 */
const TOOL_ACTIVITY_MIN_INTERVAL_MS = 1_000;

/**
 * [U-A6] 工具执行期活性信号载体（`tool_execution_update` → onEvent 通道，不产数据）。
 *
 * 第一类 `activity` 变体已落地（F2 登记项标记完成）：协议封闭联合的专用纯活性信号——双侧
 * reducer no-op、core event-journal-wiring 豁免 append（不进持久/重放路径），语义见 SDK
 * contract-types AgentEvent 注释。历史借用形态（usage/error 双缺省的零写入
 * message_end）见 git 历史。
 */
const TOOL_ACTIVITY_EVENT: AgentEvent = { type: "activity" };

/** tool_call_id → 工具名/args 的 transient 寄存器（tool_end 缺 args 时回填）。 */
type PendingToolRegistry = Map<string, { toolName: string; args?: unknown }>;

/** agentEvent 统一出口签名（reducer + limiter + 协议通知）。 */
type AgentEventSink = (event: AgentEvent) => void;

/**
 * [subagent-observability §3.3.1] 收尾边沿结构化轮终事实（停因 + errorMessage + aborted
 * 三源判别三汇合）。由 handleAgentEnd 在最终 agent_end（willRetry !== true）一次产出，
 * 供 spawn-runner 落 runEnd → collectOutcome 一次分类 FailureCause（§3.3.2）。
 *
 * abortSource 三源判别（同一收尾边沿裁决，禁止把 aborted 一律记失败）：
 *   host-cancel  — 用户/run 取消（宿主 abort 信号置位——isHostAbortRequested 注入谓词）
 *                  → FailureCause user.cancelled（中止，非失败）；
 *   turn-budget  — turn-limiter 宽限轮耗尽（limiter.didAbort 事实位）→ harness.turn_budget_exhausted；
 *   engine       — 无前两者的 aborted 兜底 → engine.engine_aborted。
 */
export interface EngineRoundErrorFact {
  stopReason: "error" | "aborted";
  errorMessage: string;
  /** pi AssistantMessage.rawStopReason 原值（provider 原生 finish reason，结构化输入）。 */
  rawStopReason?: string;
  /** pi AssistantMessage.diagnostics 原样（结构化诊断，消费侧运行时窄化）。 */
  diagnostics?: unknown;
  abortSource: "host-cancel" | "turn-budget" | "engine";
  /**
   * [subagent-observability §3.3.9/UC-10] turn 预算耗尽事实（limiter abort 边沿一次
   * 产出，abortSource="turn-budget" 支随停因事实带出）：cause
   * harness.turn_budget_exhausted 的 budget 字段结构化承载（{used, limit} 可查询）。
   */
  turnBudget?: TurnBudgetExhaustion;
}

/**
 * [subagent-observability §3.3.1 P5 计账] agent_settled 轮终快照。
 *   turnsAtSettle        — 失败尝试排除后的轮数（P5：turns 计数排除失败尝试）；
 *   finalAttemptTurnBase — 最终尝试的 turns 切片基（record.turns 下标——auto_retry_start
 *                          边界处的 turnCount 快照）；收集侧据此对 usage 聚合切片，
 *                          轮收条 usage 记最终尝试值（失败尝试 usage 不静默计入）；
 *   retryAttempts        — auto_retry_start 帧计数（重试波次数，随 outcome 上报）；
 *   stopReason           — 最后一条 assistant 消息停因（成功轮 = 非 error/aborted 停因；
 *                          引擎停因词表展示口径 stop/error/aborted——非 error/aborted 的
 *                          正常停因（toolUse/length/deferred）统一记 stop）。
 */
export interface SettledRoundSnapshot {
  turnsAtSettle: number;
  finalAttemptTurnBase: number;
  retryAttempts: number;
  stopReason: string | undefined;
}

/**
 * [codemode u5 / D4] 嵌套工具调用判定（live ≡ reload 对齐，非 codemode 专属逻辑）。
 *
 * 判据来源（pi 1.0.0 dist 实证）：工具经 ctx.executeTool() 发起的嵌套调用，其
 * tool_execution_start / tool_execution_update / tool_execution_end 事件一律携带
 * parentToolCallId（dist/core/nested-tool-calls.js 三处 emit 点），且嵌套调用不落
 * transcript（dist/core/extensions/types.d.ts executeTool 契约「It does not appear in
 * the transcript」）。过滤语义 = 与 transcript 派生视图对齐：reload 后嵌套调用只有外层一个
 * 工具块，live 期放行 start/end 会经下方翻译各产独立 tool_start/tool_end → 派生视图不一致。
 * 未来任何 ctx.executeTool 调用源自动被本过滤覆盖（现役唯一发射源为 codemode 脚本）。
 *
 * start 与 end 必须同判同滤（两 handler 入口同一谓词）：仅滤 start 会让嵌套 end 对未注册
 * toolCallId 发出孤儿 tool_end 块。空串按非嵌套放行（'' 属畸形值，pi 实发恒为真实父 id；
 * 误滤顶层块是数据损失，误放行至多多一个重复块）。
 *
 * tool_execution_update 豁免（判据不含 update，switch 分支不动）：嵌套 update 不产工具块、
 * 不落 transcript，且经 handleToolExecutionUpdate 映射为活性信号（U-A6 无进展守护刷新通道，
 * 嵌套执行窗口内唯一在途刷新源），丢弃会复发守护误杀。
 */
function isNestedToolExecution(raw: SdkEvent): boolean {
  const parentToolCallId = raw.parentToolCallId;
  return typeof parentToolCallId === "string" && parentToolCallId !== "";
}

/** createSdkEventTranslator 的装配参数。 */
export interface SdkTranslatorOpts {
  maxTurns?: number;
  graceTurns?: number;
  onEvent: (e: AgentEvent) => void;
  onDelta?: (d: string) => void;
  /**
   * limiter 耗尽执行（kill 子进程）。[subagent-observability §3.3.9/UC-10] 签名携带
   * TurnBudgetExhaustion 事实（{used, limit}，abort 边沿一次产出）——宿主装配按需
   * 捕获（少参闭包类型兼容，不消费事实的装配零改动）。
   */
  abort: (info: TurnBudgetExhaustion) => void;
  /** agent_end（非 willRetry）到达：turn 已终态、轮收敛（不 kill，收割等 agent_settled）。 */
  onAgentEnd?: () => void;
  /**
   * [subagent-observability §3.3.1 停因事实优先] 最终 agent_end 携带错误停因事实
   * （最后一条 assistant 停因 ∈ {error, aborted} 或存在未消费的引擎 error 事件）：
   * 收尾边沿按失败事实收口（→ endedCleanly=false → 退出码非 0 → 轮失败），
   * onAgentEnd/onAgentSettled 的「默认成功」口径不再适用。
   */
  onErroredEnd?: (fact: EngineRoundErrorFact) => void;
  /**
   * [subagent-observability §3.3.1 aborted 三源判别] 宿主 abort 信号谓词注入
   * （spawn-runner 传 `params.signal?.aborted === true`）：收尾边沿判别 abortSource
   * 用。缺省 = 恒 false（无宿主取消通道的装配/测试形态）。
   */
  isHostAbortRequested?: () => boolean;
  /**
   * agent_settled（真空闲）到达：run resolve 点 + 轮收割边界。入参 = 轮终快照
   * （失败尝试排除后的轮数 + usage 切片基 + retryAttempts + 停因）——收集侧
   * （collectOutcome）在 resolve 后的微任务延续中读快照，快照先行传出，防止下方
   * 「按轮清零」把成功 run 的 outcome 计数腐化成 0。
   */
  onAgentSettled?: (snapshot: SettledRoundSnapshot) => void;
}

/** tool_execution_start → tool_start（toolCallId 在册时寄存 args 供 end 回填）。 */
function handleToolExecutionStart(
  raw: SdkEvent,
  pendingTools: PendingToolRegistry,
  agentEvent: AgentEventSink,
): void {
  // [codemode u5 / D4] 嵌套调用不产独立 tool_start、不进寄存器（判据见 isNestedToolExecution）
  if (isNestedToolExecution(raw)) return;
  const toolName = raw.toolName ?? "";
  if (raw.toolCallId) {
    pendingTools.set(raw.toolCallId, { toolName, args: raw.args });
  }
  agentEvent({ type: "tool_start", toolName, args: raw.args });
}

/** tool_execution_end → tool_end（args 缺失时按 toolCallId 回填）。 */
function handleToolExecutionEnd(
  raw: SdkEvent,
  pendingTools: PendingToolRegistry,
  agentEvent: AgentEventSink,
): void {
  // [codemode u5 / D4] 与 start 同判早退——防对未注册 toolCallId 发孤儿 tool_end
  if (isNestedToolExecution(raw)) return;
  agentEvent({
    type: "tool_end",
    toolName: raw.toolName ?? "",
    args: resolveToolEndArgs(raw, pendingTools),
    result: raw.result,
    isError: raw.isError,
  });
}

/** message_update → assistant delta 翻译（text/thinking delta；不可映射则丢弃）。 */
function handleAssistantMessageUpdate(raw: SdkEvent, agentEvent: AgentEventSink): void {
  const mapped = mapAssistantMessageDelta(raw.assistantMessageEvent ?? {});
  if (mapped) agentEvent(mapped);
}

/**
 * [U-A6] tool_execution_update → 工具执行期活性信号（进 onEvent，不进 onDelta）。
 *
 * 证据链（实装 pi 0.84.4 dist 逐行核对，2026-09-10）：
 *   - 内置 bash 无默认超时：`dist/core/tools/bash.js` schema 描述「Timeout in seconds
 *     (optional, no default timeout)」+ `resolveTimeoutMs(undefined) → undefined`；
 *   - 执行期以 100ms 节流推 tool_execution_update（bash.js `BASH_UPDATE_THROTTLE_MS=100`
 *     + emitOutputUpdate 仅在 updateDirty 时发）；除节流刷新外还有两条固定刷新：执行入口
 *     **无条件**发一条空 content（bash.js:287 `onUpdate({content: [], details: undefined})`），
 *     finishOutput 收尾再发一条（同文件 :299；updateDirty 为假即无产出时不重发）。故实装
 *     「静默工具」的形态是**启动瞬间恰一条、此后零 update**，不是零 update。事件对象
 *     `{type,toolCallId,toolName,args,partialResult}` 由 pi-agent-core agent-loop 逐次产出，
 *     agent-session `_emit` 原样转发，rpc-mode `session.subscribe` → `output(toJsonEvent(event))`
 *     逐行写 stdout（json-event.js 对非 message_update 原样透传）→ parseSpawnLine 归
 *     kind="event" 的 SdkEvent。
 *   - 该事件此前落在本 switch 的 default 丢弃 → 长工具调用（长构建/测试/安装，可达
 *     >30min）期间 workflow/chat 两域的无进展守护「刷新两路同时失明」→ 合法任务被判
 *     无进展取消并重试（设计 §3.3 决策 9 误杀面②）。
 *
 * 把「工具持续产出」计为活性信号：opts.onEvent → 宿主 RunContext.onEvent →
 * 两域刷新面（workflow = SAR 的 journal.onEvent 包装；chat = ctx.onEvent →
 * refreshFromProtocolEvent）。两条硬约束：
 *   ① 不把 partialResult 文本推给 onDelta——正文槽（text_delta 专用，见 agentEvent），
 *      工具输出混进 assistant 正文不可接受；
 *   ② 只在工具真产出时才发（纯信号，无心跳）——静默楔死工具**启动后零 update**（启动
 *      瞬间那条固定刷新至多让检查多等一次窗口），照常被 30min 无进展守护回收，不因本信号
 *      永续命。
 *
 * 节流：pi 已按 100ms 节流，这里再按 1s 收敛（对 30min 窗仍是密刷新；把合成事件的
 * journal/wire 体量压到 1/10——30min 长构建从约 18k 条降到约 1.8k 条）。
 */
function handleToolExecutionUpdate(
  agentEvent: AgentEventSink,
  clock: { lastEmittedAtMs: number },
): void {
  const nowMs = Date.now();
  if (nowMs - clock.lastEmittedAtMs < TOOL_ACTIVITY_MIN_INTERVAL_MS) return;
  clock.lastEmittedAtMs = nowMs;
  agentEvent(TOOL_ACTIVITY_EVENT);
}

/**
 * [subagent-observability §3.3.1] 收尾边沿状态（闭包内 per-run 累积，handleAgentEnd
 * 一次消费）。字段语义：
 *   lastStopReason / lastErrorMessage — 最后一条 assistant 消息停因事实（message_end）；
 *   pendingErrorFact — 未消费的引擎 error 事实：stopReason=error/aborted 置位，后续
 *                      非 error 停因（重试恢复后的成功响应）清除——判据不依赖 record
 *                      lastError（reducer turn_end 会清空它，u2 归属）；
 *   rawStopReason / lastDiagnostics — 结构化输入停止丢弃（§3.3.2 分类机读通道）；
 *   queueNonEmpty — [§3.3.1 P3] follow-up/steer 队列事实（pi queue_update 事件逐帧
 *                   刷新）：true = agent_end 后 run 将继续（_runAgentPrompt 循环
 *                   agent.continue()），当前 agent_end 是中间边沿非轮终边沿。
 */
interface ClosingEdgeState {
  lastStopReason: string | undefined;
  lastErrorMessage: string | undefined;
  pendingErrorFact: string | undefined;
  rawStopReason: string | undefined;
  lastDiagnostics: unknown;
  /** [P5 计账] auto_retry_start 帧计数（重试波次）。 */
  retryAttempts: number;
  /** [P5 计账] 最近一次 auto_retry_start 边界处的 turnCount（失败尝试 turns 切片基）。 */
  failedAttemptTurnBase: number;
  /** [P3 队列事实] 最近一条 queue_update 的「队列非空」事实（缺省 false = 空队列）。 */
  queueNonEmpty: boolean;
}

/** pi queue_update 事件的队列事实判读（数组字段运行时 guard；缺字段按空队列）。 */
function queueUpdateHasItems(raw: SdkEvent): boolean {
  const steering = raw.steering;
  const followUp = raw.followUp;
  return (Array.isArray(steering) && steering.length > 0) || (Array.isArray(followUp) && followUp.length > 0);
}

/** auto_retry_start → journal 边界帧（[P5] 失败尝试轨迹可观测——不静默）。
 *  pi 事件不携带失败尝试的 usage 切片（usage 只随 message_end 逐轮产出），故边界帧
 *  只承载边界事实；失败尝试 usage 经 journal 内两边界帧之间的 message_end 帧可查。 */
function emitAutoRetryFrame(raw: SdkEvent, phase: "start" | "end", agentEvent: AgentEventSink): void {
  const attempt = typeof raw.attempt === "number" ? raw.attempt : 0;
  agentEvent({
    type: "auto_retry",
    phase,
    attempt,
    ...(phase === "start"
      ? {
        ...(typeof raw.maxAttempts === "number" ? { maxAttempts: raw.maxAttempts } : {}),
        ...(typeof raw.delayMs === "number" ? { delayMs: raw.delayMs } : {}),
        ...(typeof raw.errorMessage === "string" ? { errorMessage: raw.errorMessage } : {}),
      }
      : {
        ...(typeof raw.success === "boolean" ? { success: raw.success } : {}),
        ...(typeof raw.finalError === "string" ? { finalError: raw.finalError } : {}),
      }),
  });
}

/** agent_end → 轮收敛分派（[§3.3.1] 停因事实优先：willRetry 只裁「是否最终 agent_end」，
 * 成败判定锚停因事实，不再默认成功）。 */
function handleAgentEnd(
  raw: SdkEvent,
  edge: ClosingEdgeState,
  limiter: ReturnType<typeof createTurnLimiter>,
  opts: SdkTranslatorOpts,
): void {
  // [F1.2 从根源修复，Gate B 2026-09-09] pi rpc 模式 turn 完成后进程常驻不退出；
  // 旧 core runSpawn 的 routeAgentEnd（agent_end → 非 willRetry → 终结子进程 → close →
  // runSpawn resolve）在 W7 协议化提取时丢失，导致 run 永不终态（事件流出齐全、
  // outcome 悬挂）。此处承载轮终收敛语义：message_end/turn_end 已先于 agent_end
  // 到达并累积进 record，run 的 resolve 挂 agent_settled（真空闲），收割在其后
  // （[modeless 波2] 唯一语义，无分支）。
  // 旧实现的 pending 后代 keep-alive 分支（session 文件 pending:register 差集
  // 判活 + no-progress timer + notifier steer 唤醒）未随迁移——本执行器口径是
  // 每 run 一进程，后台后代保活编排登记为协议化偏差。
  if (raw.willRetry === true) return;
  // [subagent-observability §3.3.1 P3 队列事实] pi 1.0.0 _runAgentPrompt 循环
  // （agent-session.js:1354-1368）：follow-up/steer 队列非空时 agent_end 后 run 继续
  //（agent.continue()）——此刻的 agent_end 是中间边沿，不是轮终边沿。队列事实取自
  // pi queue_update 事件（_emitQueueUpdate 在入队/出队两侧逐帧刷新，agent_end 时刻
  // 的队列状态即在流上）。中间边沿不判终（onAgentEnd/onErroredEnd 都不发——终局
  // 判定留给队列排空后的末边沿，以最新停因事实裁决；失败尝试已经 message_end 的
  // error 事件入 journal，不静默）。
  if (edge.queueNonEmpty) return;
  // [subagent-observability §3.3.1] 停因事实优先：错误停因（error/aborted）或存在
  // 未消费的引擎 error 事实 → onErroredEnd（失败收口），settled 门控在 spawn-runner
  // 同点覆盖（settled 不再是任何置 0 依据）。
  const stopReasonIsErrorFact =
    edge.lastStopReason === "error" || edge.lastStopReason === "aborted";
  if (stopReasonIsErrorFact || edge.pendingErrorFact !== undefined) {
    const stopReason: "error" | "aborted" = edge.lastStopReason === "aborted" ? "aborted" : "error";
    // [§3.3.1 aborted 三源判别] 同一收尾边沿裁决：宿主取消 > limiter 耗尽 > 引擎异常。
    const abortSource = adjudicateAbortSource(opts, limiter);
    opts.onErroredEnd?.({
      stopReason,
      errorMessage:
        edge.lastErrorMessage ?? edge.pendingErrorFact ?? "engine reported error without message text",
      ...(edge.rawStopReason !== undefined ? { rawStopReason: edge.rawStopReason } : {}),
      ...(edge.lastDiagnostics !== undefined ? { diagnostics: edge.lastDiagnostics } : {}),
      abortSource,
      // [§3.3.9/UC-10] limiter 耗尽支随停因事实带出 {used, limit}（abort 边沿一次
      // 产出的耗尽事实快照；宿主取消/引擎异常支无该事实）。
      ...(abortSource === "turn-budget" && limiter.turnBudgetExhaustion !== undefined
        ? { turnBudget: limiter.turnBudgetExhaustion }
        : {}),
    });
    return;
  }
  opts.onAgentEnd?.();
}

/** [§3.3.1 三源判别] aborted 停因的来源裁决（严格序）：宿主取消 → limiter 耗尽 → 引擎异常。 */
function adjudicateAbortSource(
  opts: SdkTranslatorOpts,
  limiter: ReturnType<typeof createTurnLimiter>,
): EngineRoundErrorFact["abortSource"] {
  if (opts.isHostAbortRequested?.() === true) return "host-cancel";
  if (limiter.didAbort) return "turn-budget";
  return "engine";
}

/**
 * agent_settled → 轮计数与 limiter 标志按轮重置 + run resolve 点回调。
 * [subagent-observability P5 计账] 快照含失败尝试排除后的轮数与 usage 切片基——
 * 失败尝试（auto_retry_start 边界之前累积的 turns）不再静默计入轮收条计数。
 */
function handleAgentSettled(
  record: ReturnType<typeof createReplayRecord>,
  edge: ClosingEdgeState,
  limiter: ReturnType<typeof createTurnLimiter>,
  opts: SdkTranslatorOpts,
): void {
  // 真空闲边界（agent_end 之后、post-run 完成后才 emit——pi agent-session
  // _runAgentPrompt finally 块）= run 的 resolve 与收割点：turn 计数与 limiter
  // 标志按轮重置（SP-9 对齐：续聊轮独立预算，maxTurns 不跨轮累计）。
  // 轮数快照必须先于清零传出（opts.onAgentSettled 内部 settle exitPromise），
  // 否则收集侧读到的成功 run 轮数恒为 0。
  if (opts.onAgentSettled !== undefined) {
    const turnsAtSettle = Math.max(0, record.turnCount - edge.failedAttemptTurnBase);
    opts.onAgentSettled({
      turnsAtSettle,
      finalAttemptTurnBase: Math.min(edge.failedAttemptTurnBase, record.turns.length),
      retryAttempts: edge.retryAttempts,
      // 引擎停因词表展示口径（stop/error/aborted）：非 error/aborted 的正常停因
      // （toolUse/length/deferred）统一记 stop——成功收尾事实。
      stopReason:
        edge.lastStopReason === "error" || edge.lastStopReason === "aborted"
          ? edge.lastStopReason
          : edge.lastStopReason !== undefined
            ? "stop"
            : undefined,
    });
    record.turnCount = 0;
    limiter.reset();
  }
}

/**
 * message_end 累积（usage 折算 + 停因事实累积 + stopReason error/aborted → error 事件）。
 * [subagent-observability §3.3.1/§3.3.2] 停因事实与结构化输入（rawStopReason/diagnostics）
 * 在闭包累积供收尾边沿消费；error 事实的消费语义 = 后续非 error 停因（重试恢复）清除。
 */
function accumulateMessageEnd(
  raw: SdkEvent,
  edge: ClosingEdgeState,
  agentEvent: AgentEventSink,
): void {
  const msg = raw.message;
  if (msg?.usage) {
    const { cost: costObj } = msg.usage;
    const usage = {
      input: msg.usage.input ?? 0,
      output: msg.usage.output ?? 0,
      cacheRead: msg.usage.cacheRead ?? 0,
      cacheWrite: msg.usage.cacheWrite ?? 0,
      ...(costObj?.total !== undefined ? { cost: costObj.total } : {}),
    };
    agentEvent({ type: "message_end", usage });
  }
  const stopReason = msg?.stopReason;
  if (stopReason !== undefined) {
    edge.lastStopReason = stopReason;
    edge.lastErrorMessage = msg?.errorMessage;
    // [§3.3.2 结构化输入停止丢弃] rawStopReason/diagnostics 原样留存（分类兜底通道）。
    if (msg?.rawStopReason !== undefined) edge.rawStopReason = msg.rawStopReason;
    if (msg?.diagnostics !== undefined) edge.lastDiagnostics = msg.diagnostics;
  }
  if (stopReason === "error" || stopReason === "aborted") {
    const errMsg = msg?.errorMessage ?? raw.reason ?? stopReason;
    edge.pendingErrorFact = errMsg;
    agentEvent({ type: "error", message: errMsg });
  } else if (stopReason !== undefined) {
    // 非 error 停因到达 = 此前的失败尝试已被重试恢复（P5：auto_retry 重跑成功）——
    // 未消费 error 事实清除，收尾边沿不再据旧失败判终。
    edge.pendingErrorFact = undefined;
  }
}

/**
 * SdkEvent → AgentEvent 翻译 + reducer 累积的闭包工厂（core
 * createSpawnEventHandlers 的协议化提取）。
 */
export function createSdkEventTranslator(
  record: ReturnType<typeof createReplayRecord>,
  opts: SdkTranslatorOpts,
): (raw: SdkEvent) => void {
  // a. transient 寄存器（tool_end 缺 args 时回填）
  const pendingTools: PendingToolRegistry = new Map();

  // a2. [U-A6] 工具执行期活性信号的节流时钟（per-translator，即 per-run）
  const activityClock = { lastEmittedAtMs: 0 };

  // a3. [subagent-observability §3.3.1] 收尾边沿事实累积（per-run 闭包）
  const edge: ClosingEdgeState = {
    lastStopReason: undefined,
    lastErrorMessage: undefined,
    pendingErrorFact: undefined,
    rawStopReason: undefined,
    lastDiagnostics: undefined,
    retryAttempts: 0,
    failedAttemptTurnBase: 0,
    queueNonEmpty: false,
  };

  // b. turnLimiter（spawn 版：abort = kill 子进程；steer 未接通，靠 WRAP_UP_HINT 补偿）
  // [subagent-observability §3.3.9 预算显式化] maxTurns 显式传参时管道生效：WRAP_UP
  // 提示（spawn-runner 启动注入）→ 宽限轮（缺省 DEFAULT_GRACE_TURNS，limiter 内
  // 单点缺省）→ abort（携带 {used, limit} 耗尽事实——快照在 limiter
  // turnBudgetExhaustion 事实位，收尾边沿 turn-budget 支读取）。maxTurns 缺省 0 =
  // unbounded（limiter 禁用，不 steer 不 abort——UC-9 默认行为不变）。
  const limiter = createTurnLimiter({
    maxTurns: opts.maxTurns ?? 0,
    ...(opts.graceTurns !== undefined ? { graceTurns: opts.graceTurns } : {}),
    steer: () => {
      // no-op：rpc stdin steer 通道未接通；启动时已注入 WRAP_UP_HINT 让 agent 主动收尾。
    },
    abort: opts.abort,
  });

  // agentEvent 统一出口：reducer + limiter + 协议通知
  const agentEvent: AgentEventSink = (event: AgentEvent): void => {
    updateRecordFromEvent(record, event);
    if (event.type === "turn_end") limiter.onTurnEnd(record.turnCount);
    if (event.type === "text_delta") opts.onDelta?.(event.delta);
    opts.onEvent(event);
  };

  // 事件分派：switch 只做类型路由，翻译语义在各 handle* / accumulateMessageEnd
  return (raw: SdkEvent): void => {
    switch (raw.type) {
      case "tool_execution_start":
        handleToolExecutionStart(raw, pendingTools, agentEvent);
        return;
      case "tool_execution_update":
        // [U-A6] 工具执行期活性信号（不产数据、不进正文槽；原先被 default 丢弃）
        handleToolExecutionUpdate(agentEvent, activityClock);
        return;
      case "tool_execution_end":
        handleToolExecutionEnd(raw, pendingTools, agentEvent);
        return;
      case "message_update":
        handleAssistantMessageUpdate(raw, agentEvent);
        return;
      case "turn_end":
        agentEvent({ type: "turn_end" });
        return;
      case "agent_end":
        handleAgentEnd(raw, edge, limiter, opts);
        return;
      case "agent_settled":
        handleAgentSettled(record, edge, limiter, opts);
        return;
      case "message_end":
        accumulateMessageEnd(raw, edge, agentEvent);
        return;
      case "auto_retry_start":
        // [subagent-observability §3.3.1 P5 计账] 失败尝试识别锚 = auto_retry 事件边界：
        // start 帧 = 刚结束的整个 run 是失败尝试、即将整体重跑——此刻已累计的 turns
        // 全属失败尝试，记为切片基（最终尝试 usage/turns 从此界起算）；retryAttempts
        // 计数随轮终快照上报（重试波次可见，失败尝试不再静默）。
        edge.retryAttempts += 1;
        edge.failedAttemptTurnBase = record.turnCount;
        // [P5 journal 帧] 重试边界发帧入 journal（F1-32：失败尝试轨迹不静默——
        // 事件经宿主 event journal 落盘，重试 usage 切片可经两边界帧之间查）。
        emitAutoRetryFrame(raw, "start", agentEvent);
        return;
      case "auto_retry_end":
        // end 帧的成败事实已由 message_end（stopReason/errorMessage）承载——本边界
        // 无独立计账义务（retryAttempts 锚在 start 帧，finalError 即 lastErrorMessage）。
        emitAutoRetryFrame(raw, "end", agentEvent);
        return;
      case "queue_update":
        // [§3.3.1 P3 队列事实] pi queue_update（steer/followUp 入队与出队逐帧刷新）
        // ——agent_end 的「中间边沿 vs 轮终边沿」判据事实源（pi 1.0.0 实装：
        // agent-session.js _emitQueueUpdate 事件形状 {steering, followUp}）。
        // 本地事实位，不翻译上协议（协议无 steer 通道，队列簿记不属 AgentEvent 词表）。
        edge.queueNonEmpty = queueUpdateHasItems(raw);
        return;
      case "compaction_start":
        agentEvent({ type: "compaction" });
        return;
      default:
        return;
    }
  };
}
