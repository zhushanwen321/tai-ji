// src/journal-replay.ts
//
// journal → SessionView 的纯投影（引擎侧原语，自 core
// execution/engine/common/journal-replay.ts + execution-record.ts reducer 核心 +
// common/session-view-projection.ts 迁入 @zhushanwen/subagent-engine-sdk）。
// 迁移处置（impl-plan §2.1 journal-replay 行）：**纯投影部分（entry → record 的
// reducer）下沉 SDK，journal I/O 与②级降级链留 core**——
//   - SDK 版 = eventsToSessionView（事件流 → SessionView，live/replay 共用 reducer
//     语义）+ reducer 本体（updateFromEvent 及其私有 handler）+ Turn → ReplayedTurn
//     投影 / usage 聚合（原 core session-view-projection.ts 同名函数逐字等价，
//     R6 收口后本模块为唯一实现，双活副本已删）；
//   - 留 core = replayJournal（journal 文件 I/O）+ replayJournalToSessionView（read
//     第②级降级编排）——core 侧引用切换已完成（core 依赖 SDK 方向合法）。
//
// record 形态：SDK 侧 reducer 操作 ReplayRecordView（turns/turnCount/totalTokens/
// lastError 四字段视图）——core ExecutionRecord 留 core（类型闭包表裁决），其结构
// 满足本视图（W2 双向可赋值断言验证）。重放场景不需要 identity 字段（agent/model/
// task 等只服务投影与持久化，reducer 不触碰），不搬 createRecord 全量 identity。
//
// 设计权威源：docs/architecture/subagent-engine-abstraction.md D6 + §3.3.6「重放等价性」
// ——journal 重放与 live 通路共用同一 reducer（updateFromEvent 范式），不引入第二套
// 解析器；conformance C5 断言重放 turns 与 live 一致。
//
// CJS 多 entry 内联副本的实例分裂影响 = runningToolIndex WeakMap（按 record 实例
// 隔离）各自为政，无跨实例语义。

import type {
  AgentEvent,
  AgentUsage,
  AgentUsageTotal,
  InternalToolCall,
  ReplayedTurn,
  SessionView,
  ToolCall,
  Turn,
  EngineHandleData,
} from "./protocol/contract-types.ts";

/**
 * reducer 的 record 视图（core ExecutionRecord 的结构子集：reducer 只触碰这四个字段）。
 * core ExecutionRecord 满足本视图（W2 断言挂靠点）；SDK 内自持 createReplayRecord 产出。
 */
export interface ReplayRecordView {
  turns: Turn[];
  turnCount: number;
  totalTokens: number;
  lastError: string | undefined;
}

// ============================================================
// usage 累积（core execution-record.ts 私有 helper 逐字等价）
// ============================================================

/** usage 单字段求和（undefined 视为 0——与旧 `(a ?? 0) + (b ?? 0)` 内联式逐字等价）。 */
function sumUsageField(a: number | undefined, b: number | undefined): number {
  return (a ?? 0) + (b ?? 0);
}

/** prev 为空时 next 的规范化拷贝（cost 保留原值，可能 undefined——与旧首条分支逐字等价）。 */
function usageFromNext(next: AgentUsage): AgentUsage {
  return {
    input: next.input ?? 0,
    output: next.output ?? 0,
    cacheRead: next.cacheRead ?? 0,
    cacheWrite: next.cacheWrite ?? 0,
    cost: next.cost,
  };
}

/**
 * 累加两个 AgentUsage（field-wise）。prev 为空时返回 next 的拷贝。
 * 供 message_end 把 usage 增量并入 turn.usageDelta。
 */
function addUsage(prev: AgentUsage | undefined, next: AgentUsage): AgentUsage {
  if (prev === undefined) return usageFromNext(next);
  return {
    input: sumUsageField(prev.input, next.input),
    output: sumUsageField(prev.output, next.output),
    cacheRead: sumUsageField(prev.cacheRead, next.cacheRead),
    cacheWrite: sumUsageField(prev.cacheWrite, next.cacheWrite),
    cost: sumUsageField(prev.cost, next.cost),
  };
}

// ============================================================
// 创建（重放场景的 record 构造）
// ============================================================

/** 创建一个空 turn（text/thinking 空，无 toolCalls，未闭合）。 */
function emptyTurn(): Turn {
  return { text: "", thinking: "", toolCalls: [], usageDelta: undefined, closed: false };
}

/** 重放场景的 record 构造（对齐 core eventsToSessionView 内 createRecord 后的 reducer 视图）。 */
export function createReplayRecord(): ReplayRecordView {
  return {
    // turns[] 初始化为 [空 turn]——第一个 turn 从创建即存在，
    // updateFromEvent 直接往 turns[last] 累积，无需「无 turn」分支判断。
    turns: [emptyTurn()],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
  };
}

// ============================================================
// 事件更新（唯一更新点；core updateFromEvent 私有结构逐字等价）
// ============================================================

/**
 * 取当前正在进行（未 closed）的 turn；若全部 closed 则开新 turn。
 * 保证调用后返回的 turn 一定 closed===false，可安全累积内容。
 */
function currentTurn(record: ReplayRecordView): Turn {
  const last = record.turns[record.turns.length - 1];
  if (last !== undefined && !last.closed) return last;
  const fresh = emptyTurn();
  record.turns.push(fresh);
  return fresh;
}

/**
 * 在 record.turns[] 范围内倒序找最后一个同名且仍 running 的 toolCall。
 *
 * 扫描所有 turn（非仅当前 turn）——SDK 在 turn_end 后仍可能补发滞后的 tool_end，
 * 仅扫当前 turn 会漏配对、误 push 幽灵 ToolCall。跨 turn 扫描兜底滞后事件。
 *
 * 返回 [turn, index]；未找到返回 undefined。
 */
function findRunningToolCall(
  record: ReplayRecordView,
  toolName: string,
): readonly [Turn, number] | undefined {
  for (let t = record.turns.length - 1; t >= 0; t--) {
    const turn = record.turns[t];
    if (turn === undefined) continue;
    for (let i = turn.toolCalls.length - 1; i >= 0; i--) {
      const tc = turn.toolCalls[i];
      if (tc?._status === "running" && tc.toolName === toolName) {
        return [turn, i] as const;
      }
    }
  }
  return undefined;
}

/**
 * [perf] running toolCall 倒序索引：tool_start push 位置入索引，tool_end 弹尾定位
 *（尾部 = 最后 push 的同名项，与 findRunningToolCall 倒序全扫的语义等价），把每次
 * tool_end 的 O(所有 turns × toolCalls) 扫描降为 O(1)。WeakMap 按 record 实例隔离
 *（createRecord 新实例从空索引开始，不影响旧实例）。
 * 索引 miss（重建 record 的历史 running toolCall / 外部注入工具无 tool_start）
 * 回退 findRunningToolCall 全扫兜底——正确性不依赖索引完整性。
 */
const runningToolIndex = new WeakMap<ReplayRecordView, Map<string, Array<{ turn: Turn; idx: number }>>>();

function indexToolStart(record: ReplayRecordView, turn: Turn, toolName: string): void {
  let byName = runningToolIndex.get(record);
  if (byName === undefined) {
    byName = new Map();
    runningToolIndex.set(record, byName);
  }
  const arr = byName.get(toolName);
  if (arr === undefined) {
    byName.set(toolName, [{ turn, idx: turn.toolCalls.length - 1 }]);
  } else {
    arr.push({ turn, idx: turn.toolCalls.length - 1 });
  }
}

// ── 各事件处理器（updateFromEvent 按 case 分发，每个处理器单一职责）──

/** text_delta：流式累积进当前 turn 的 text（完整内容，非切片）。 */
function applyTextDelta(
  record: ReplayRecordView,
  event: Extract<AgentEvent, { type: "text_delta" }>,
): void {
  currentTurn(record).text += event.delta;
}

/** thinking_delta：流式累积进当前 turn 的 thinking（完整内容）。 */
function applyThinkingDelta(
  record: ReplayRecordView,
  event: Extract<AgentEvent, { type: "thinking_delta" }>,
): void {
  currentTurn(record).thinking += event.delta;
}

/** tool_start：push 一个 running 的 InternalToolCall（带 startedTs）+ 弹尾索引入册。 */
function applyToolStart(
  record: ReplayRecordView,
  event: Extract<AgentEvent, { type: "tool_start" }>,
): void {
  const tc: InternalToolCall = {
    toolName: event.toolName,
    args: event.args,
    result: undefined,
    isError: false,
    _status: "running",
    startedTs: Date.now(),
  };
  const turn = currentTurn(record);
  turn.toolCalls.push(tc);
  indexToolStart(record, turn, event.toolName);
}

/**
 * tool_end 定位：索引弹尾 O(1) 命中 running 同名 toolCall；索引 miss（无记录 / 槽位
 * 已非 running）回退 findRunningToolCall 跨 turn 倒序全扫兜底。
 * 返回 [turn, index]；两路都 miss 返回 undefined。
 */
function matchRunningToolCall(
  record: ReplayRecordView,
  toolName: string,
): readonly [Turn, number] | undefined {
  const byName = runningToolIndex.get(record);
  const arr = byName?.get(toolName);
  if (arr !== undefined && arr.length > 0) {
    const item = arr[arr.length - 1];
    arr.pop();
    const tc = item.turn.toolCalls[item.idx];
    if (tc !== undefined && tc._status === "running") {
      return [item.turn, item.idx] as const;
    }
  }
  // 兜底：重建 record 的历史 running toolCall（索引未覆盖）、索引项被外部路径
  // 置非 running 等场景——保持与旧实现一致的跨 turn 倒序全扫。
  return findRunningToolCall(record, toolName);
}

/**
 * tool_end：命中则回填 result/isError/_status；未命中（SDK 发了 tool_end 但无对应
 * tool_start，如外部注入的工具）直接 push 一个已完成的 InternalToolCall，避免数据丢失。
 */
function applyToolEnd(
  record: ReplayRecordView,
  event: Extract<AgentEvent, { type: "tool_end" }>,
): void {
  const matched = matchRunningToolCall(record, event.toolName);
  if (matched !== undefined) {
    const [turn, i] = matched;
    const tc = turn.toolCalls[i]!;
    tc.args = event.args ?? tc.args;
    tc.result = event.result;
    tc.isError = event.isError ?? false;
    tc._status = event.isError ? "failed" : "done";
    return;
  }
  currentTurn(record).toolCalls.push({
    toolName: event.toolName,
    args: event.args,
    result: event.result,
    isError: event.isError ?? false,
    _status: event.isError ? "failed" : "done",
    startedTs: Date.now(),
  });
}

/**
 * turn_end：闭合当前 turn，记 closedTs（真实墙钟），turnCount++，清 lastError。
 * 正常闭合清 lastError：瞬态 error 恢复后不应误判 success=false
 * （若 turn_end 后 message_end 报 error，会在 message_end 处理器重新写回）。
 */
function applyTurnEnd(record: ReplayRecordView): void {
  const turn = currentTurn(record);
  turn.closed = true;
  turn.closedTs = Date.now();
  record.turnCount += 1;
  record.lastError = undefined;
}

/**
 * message_end：usage 增量存进末 turn.usageDelta（直接写末 turn，不开新 turn）；
 * totalTokens 累加；error（stopReason=error）记进 lastError。
 *
 * usageDelta 按 message_end **累加**（非覆盖）——同一 turn 内若多次 message_end
 * 到达（或 turn_end 后的滞后 message_end 落到 currentTurn 开的新 turn），
 * 累加保证不丢 usage。getTotalUsage 扁平求和所有 turn，归属 turn 的精确性
 * 不影响最终 total（无消费方读单 turn usage）。
 */
function applyMessageEnd(
  record: ReplayRecordView,
  event: Extract<AgentEvent, { type: "message_end" }>,
): void {
  if (event.usage) {
    const turn = currentTurn(record);
    turn.usageDelta = addUsage(turn.usageDelta, event.usage);
    // totalTokens 累加四项之和（保留旧语义，投影直接读）
    record.totalTokens +=
      (event.usage.input ?? 0) + (event.usage.output ?? 0) +
      (event.usage.cacheRead ?? 0) + (event.usage.cacheWrite ?? 0);
  }
  if (event.error) {
    record.lastError = event.error;
  }
}

/** error：存 record.lastError（getEventLog 派生 error 条目用）。 */
function applyErrorEvent(
  record: ReplayRecordView,
  event: Extract<AgentEvent, { type: "error" }>,
): void {
  record.lastError = event.message;
}

/**
 * 从 AgentEvent 更新 record。所有数据收口进 record.turns[]。
 *   - text/thinking：流式累积进 currentTurn()（完整内容，非切片）
 *   - tool_start/end：push 进 currentTurn().toolCalls（含完整 result）
 *     tool_end 跨 turn 扫描找 running 同名 toolCall（兜底滞后事件）
 *   - turn_end：闭合当前 turn，记 closedTs（真实墙钟，供 getEventLog）；
 *     正常闭合清 lastError（瞬态 error 恢复后不应误判 success=false）
 *   - message_end：usage 增量存进末 turn.usageDelta（直接写末 turn，不开新 turn）；
 *     totalTokens 累加
 *   - error：存 record.lastError（getEventLog 派生 error 条目用）
 *
 * 唯一写点——replay 与 live 共用（重放等价性的实现体）。
 *
 * 穷尽性：switch 覆盖 AgentEvent 全部 variant；default 的 `never` 断言保证
 * 新增 variant 时编译期报错（而非静默 no-op）。
 */
export function updateFromEvent(record: ReplayRecordView, event: AgentEvent): void {
  switch (event.type) {
    // ── text / thinking：流式累积进当前 turn ──
    case "text_delta":
      return applyTextDelta(record, event);
    case "thinking_delta":
      return applyThinkingDelta(record, event);

    // ── tool_start/end：push 进 currentTurn().toolCalls（含完整 result）──
    case "tool_start":
      return applyToolStart(record, event);
    case "tool_end":
      return applyToolEnd(record, event);

    // ── turn_end：闭合当前 turn ──
    case "turn_end":
      return applyTurnEnd(record);

    // ── message_end：usage 增量累加 + totalTokens 累加 ──
    case "message_end":
      return applyMessageEnd(record, event);

    // ── error：存 record.lastError ──
    case "error":
      return applyErrorEvent(record, event);

    // ── compaction：不产生数据（不变）──
    case "compaction":
      return;

    // ── activity：纯活性信号，reducer no-op（协议语义见 contract-types）──
    case "activity":
      return;

    default: {
      // 穷尽性检查：新增 AgentEvent variant 时编译期报错
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

// ============================================================
// Turn → ReplayedTurn 投影 + usage 聚合
// （原 core session-view-projection.ts 逐字等价，R6 收口后本模块为唯一实现：
//   投影语义唯一——strip 内部态 + closed 恒 true + usageDelta 聚合，实现也唯一）
// ============================================================

/** InternalToolCall → ToolCall（导出纯净形状，不泄漏 running/done/failed 内部状态机）。 */
function toExportedToolCall(tc: InternalToolCall): ToolCall {
  return {
    toolName: tc.toolName,
    ...(tc.args !== undefined ? { args: tc.args } : {}),
    ...(tc.result !== undefined ? { result: tc.result } : {}),
    ...(tc.isError !== undefined ? { isError: tc.isError } : {}),
  };
}

/** Turn → ReplayedTurn：剥离内部态（closed 恒 true——重放物无进行时语义，§3.3.6）。 */
export function toReplayedTurn(turn: Turn): ReplayedTurn {
  return {
    text: turn.text,
    thinking: turn.thinking,
    toolCalls: turn.toolCalls.map(toExportedToolCall),
    closed: true,
  };
}

/** 各 turn usageDelta 聚合为 AgentUsageTotal（无任何 usage 数据时 undefined）。 */
export function aggregateUsage(turns: readonly Turn[]): AgentUsageTotal | undefined {
  let acc: AgentUsageTotal | undefined;
  for (const turn of turns) {
    const d = turn.usageDelta;
    if (!d) continue;
    if (!acc) acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, total: 0 };
    acc.input += d.input;
    acc.output += d.output;
    acc.cacheRead += d.cacheRead;
    acc.cacheWrite += d.cacheWrite;
    acc.cost += d.cost ?? 0;
  }
  if (acc) acc.total = acc.input + acc.output + acc.cacheRead + acc.cacheWrite;
  return acc;
}

// ============================================================
// 事件流 → SessionView（纯投影出口）
// ============================================================

/**
 * 事件流 → SessionView（live reducer 累积 turns——重放等价性的实现体）。
 * journal I/O（replayJournal）不在此层——read 第②级降级编排（core 版
 * replayJournalToSessionView）留 core，引擎侧按需自读 journal 后调本函数。
 */
export function eventsToSessionView(
  events: readonly AgentEvent[],
  engineId: string,
  sessionId?: string,
): SessionView {
  const record = createReplayRecord();
  for (const ev of events) updateFromEvent(record, ev);
  return {
    engineId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    turns: record.turns.map(toReplayedTurn),
    usage: aggregateUsage(record.turns),
    source: "journal",
  };
}

/** handle.sessionRef 的 sessionId 提取（引擎自定义键，运行时 guard）。 */
export function sessionIdFromHandle(handle: EngineHandleData): string | undefined {
  const v = handle.sessionRef["sessionId"];
  return typeof v === "string" ? v : undefined;
}
