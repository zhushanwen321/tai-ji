// src/core/execution-record.ts
//
// 唯一执行状态对象 + 唯一创建/更新/完成/投影入口。
//
// 收口设计（2026-06-22 重构）：
//   一次执行的完整内容（text/thinking/toolCalls/usage）按 turn 收口在 record.turns[]。
//   eventLog / currentActivity / result 文本均从 turns[] 派生（getEventLog /
//   getCurrentActivity / getFullText），不再独立存储切片或缓冲。
//
//   createRecord    唯一创建入口（model 创建时必填，消灭 poll 路径 model 丢失）
//   updateFromEvent 唯一事件更新入口（累积进 turns[]，消灭闭包旁路累积器）
//   completeRecord  唯一完成入口（冻结状态）
//   project/snapshot 唯一投影入口（两路径字段一致）
//
// Core 层叶子原语：仅依赖 types.ts。零 Pi / Runtime / TUI 依赖。

import type {
  AgentEvent,
  AgentEventLogEntry,
  AgentResult,
  AgentUsage,
  AgentUsageTotal,
  ClosedReason,
  DisplayItem,
  ExecutionMode,
  ExecutionOutcome,
  ExecutionRecord,
  ExecutionStatus,
  InternalToolCall,
  ProjectedOutcome,
  RecordSnapshot,
  SubagentToolDetails,
  ToolCall,
  ToolCallResult,
  Turn,
} from "./types.ts";

// ============================================================
// 常量
// ============================================================

/** currentActivity label 的前缀截断长度（与旧 ACTIVITY_LABEL_MAX 对齐）。 */
const ACTIVITY_LABEL_MAX = 60;
/** turn_end 派生条目 label 的最大长度（取本 turn 文本开头）。 */
const TURN_SUMMARY_MAX = 80;
/** tool label 的最大长度（command/query/url/basename 截断，保持 TUI 列宽稳定）。 */
const TOOL_LABEL_MAX = 100;
/** ms → s 换算。elapsedSeconds 唯一计算点用。 */
const MS_PER_SECOND = 1000;

// ============================================================
// Label 提取（eventLog 派生的伴生逻辑，co-locate 于 Core）
// ============================================================

/**
 * 从 toolName + args 提取 eventLog label（人类可读）。
 *
 *   read/edit/write → "{tool} {basename}"（取 path 参数）
 *   bash            → "{tool} {command 首行}"（截断）
 *   web_search      → "{tool} {query}"
 *   web_fetch       → "{tool} {url}"
 *   其他 / 无 args   → 裸 toolName
 *
 * 纯函数（零依赖），由 getEventLog 派生 tool 条目时调用。
 * 所有取自参数的字符串都经 truncateLabel 截断到 TOOL_LABEL_MAX——
 * 保持 TUI 列宽稳定（避免一条 10KB bash 命令撑爆 compact view）。
 */
export function extractLabelFromArgs(toolName: string, args: unknown): string {
  if (typeof args !== "object" || args === null) return toolName;
  const a = args as Record<string, unknown>;

  // 读/写/编辑类：取路径 basename（~/.pi/.../foo.ts → foo.ts）
  //   兼容 Pi tool 的多种路径参数名：path / file_path / filePath
  const pathLike = (a.path ?? a.file_path ?? a.filePath) as unknown;
  if (typeof pathLike === "string" && pathLike.length > 0) {
    const base = pathLike.split(/[\\/]/).pop() ?? pathLike;
    return `${toolName} ${truncateLabel(base)}`;
  }

  // bash：command 首行（截断）
  const cmd = a.command as unknown;
  if (typeof cmd === "string" && cmd.length > 0) {
    const firstLine = cmd.split("\n", 1)[0].trim();
    return `${toolName} ${truncateLabel(firstLine)}`;
  }

  // web_search：query
  const query = a.query as unknown;
  if (typeof query === "string" && query.length > 0) {
    return `${toolName} ${truncateLabel(query)}`;
  }

  // web_fetch：url
  const url = a.url as unknown;
  if (typeof url === "string" && url.length > 0) {
    return `${toolName} ${truncateLabel(url)}`;
  }

  return toolName;
}

/** 截断 label 到 maxLen（非省略号——保持列宽稳定，避免长命令/路径撑爆 TUI 列宽）。 */
function truncateLabel(label: string): string {
  return label.length > TOOL_LABEL_MAX ? label.slice(0, TOOL_LABEL_MAX) : label;
}

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
// 创建（唯一入口）
// ============================================================

/** 创建一个空 turn（text/thinking 空，无 toolCalls，未闭合）。 */
function emptyTurn(): Turn {
  return { text: "", thinking: "", toolCalls: [], usageDelta: undefined, closed: false };
}

/**
 * 唯一创建入口。identity 字段（agent/model/thinkingLevel/mode/task）一次确定不可变。
 *
 * model 创建时必填——这是 poll 路径 model 丢失的架构修复
 * （旧实现 background record 运行时丢 model，poll 返回缺字段）。
 */
export function createRecord(
  id: string,
  identity: {
    agent: string;
    model: string;
    thinkingLevel?: string;
    mode: ExecutionMode;
    task: string;
    /** 短标签（≤20 字符），必填。持久化兜底空串。 */
    slug: string;
    startedAt: number;
    /** 根 Pi session ID（session 隔离过滤用）。递归链上所有层同值。 */
    rootSessionId?: string;
    /** 直接父 subagent record ID。顶层为 undefined。 */
    parentRecordId?: string;
    /** subagent 递归深度。顶层=0。 */
    depth?: number;
    /** 对话模式标志（true = 可持续对话，轮次完成进 idle）。默认 undefined/false = 一次性。 */
    chatMode?: boolean;
    /** 空闲超时毫秒数（仅 chatMode 有意义）。覆盖默认 5min。 */
    idleTimeoutMs?: number;
    /** 实际执行引擎 id（P4 路由留痕，D9①）。缺省 = pi 投影（存量零迁移）。 */
    engine?: string;
    /** 引擎 fallback 留痕（probe 失败路由回默认引擎）。GUI 警告条数据源。 */
    engineFallback?: { from: string; reason: string };
    /**
     * 同步收集模式标记（subagent-sync-collect U1 foundation）。undefined = async
     * （缺省语义，旧记录零迁移）。U2 接线点：service.createRecordForMode 从
     * ExecuteOptions.collect 读入（opts.collect === "sync" ? "sync" : undefined）。
     */
    collectMode?: "sync";
    controller?: AbortController;
  },
): ExecutionRecord {
  return {
    id,
    agent: identity.agent,
    model: identity.model,
    thinkingLevel: identity.thinkingLevel,
    mode: identity.mode,
    task: identity.task,
    slug: identity.slug,
    startedAt: identity.startedAt,
    rootSessionId: identity.rootSessionId,
    parentRecordId: identity.parentRecordId,
    depth: identity.depth ?? 0,
    chatMode: identity.chatMode,
    idleTimeoutMs: identity.idleTimeoutMs,
    engine: identity.engine,
    engineFallback: identity.engineFallback,
    collectMode: identity.collectMode,

    // 状态（实时更新）
    status: "running",
    // turns[] 初始化为 [空 turn]——第一个 turn 从创建即存在，
    // updateFromEvent 直接往 turns[last] 累积，无需「无 turn」分支判断。
    turns: [emptyTurn()],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
    // 对话轮次计数（首轮 = 0，每完成一轮 finalizeRoundToIdle +1）。非 chatMode 不自增。
    round: 0,

    // 完成（completeRecord 唯一写点）
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,

    // 控制（仅 background 持有 controller；sync 为 undefined）
    controller: identity.controller,
  };
}

// ============================================================
// 事件更新（唯一更新点）
// ============================================================

/**
 * 取当前正在进行（未 closed）的 turn；若全部 closed 则开新 turn。
 * 保证调用后返回的 turn 一定 closed===false，可安全累积内容。
 */
function currentTurn(record: ExecutionRecord): Turn {
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
  record: ExecutionRecord,
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
const runningToolIndex = new WeakMap<ExecutionRecord, Map<string, Array<{ turn: Turn; idx: number }>>>();

function indexToolStart(record: ExecutionRecord, turn: Turn, toolName: string): void {
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
  record: ExecutionRecord,
  event: Extract<AgentEvent, { type: "text_delta" }>,
): void {
  currentTurn(record).text += event.delta;
}

/** thinking_delta：流式累积进当前 turn 的 thinking（完整内容）。 */
function applyThinkingDelta(
  record: ExecutionRecord,
  event: Extract<AgentEvent, { type: "thinking_delta" }>,
): void {
  currentTurn(record).thinking += event.delta;
}

/** tool_start：push 一个 running 的 InternalToolCall（带 startedTs）+ 弹尾索引入册。 */
function applyToolStart(
  record: ExecutionRecord,
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
  record: ExecutionRecord,
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
  record: ExecutionRecord,
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
function applyTurnEnd(record: ExecutionRecord): void {
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
  record: ExecutionRecord,
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
  record: ExecutionRecord,
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
 * 唯一写点——session-runner 闭包不再旁路累积，collectResult 从 record 读。
 *
 * 穷尽性：switch 覆盖 AgentEvent 全部 variant；default 的 `never` 断言保证
 * 新增 variant 时编译期报错（而非静默 no-op）。
 */
export function updateFromEvent(record: ExecutionRecord, event: AgentEvent): void {
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

    // ── activity：纯活性信号，reducer no-op（协议语义见 SDK contract-types）──
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
// 派生视图（从 turns[] 推导，不存储）
// ============================================================

/**
 * 从 turns[] 派生有序事件序列（eventLog）。
 *
 * 每个 turn 产出：tool_start/tool_end 对（按 toolCalls 顺序）+ turn_end。
 * 若有 lastError，末尾追加 error 条目。
 *
 *   [turn1{toolCalls:[A,B]}, turn2{toolCalls:[C]}] + lastError
 *     → [tool_start A, tool_end A, tool_start B, tool_end B, turn_end,
 *        tool_start C, tool_end C, turn_end, error]
 *
 * ts 为真实墙钟时间戳：tool 条目用 tc.startedTs，turn_end 用 turn.closedTs。
 * （旧实现派生时 ts += 1 是合成值，无法表达真实时序——现已改为存真实时间戳。）
 *
 * 纯函数：每次调用重新生成，不缓存。消费方按需调（投影时用）。
 */
export function getEventLog(record: ExecutionRecord): AgentEventLogEntry[] {
  const log: AgentEventLogEntry[] = [];
  for (const turn of record.turns) {
    for (const tc of turn.toolCalls) {
      const label = extractLabelFromArgs(tc.toolName, tc.args);
      const ts = tc.startedTs;
      log.push({ type: "tool_start", label, ts, status: "running" });
      if (tc._status !== "running") {
        log.push({ type: "tool_end", label, ts, status: tc._status });
      }
    }
    if (turn.closed) {
      const summary = turn.text.length > 0
        ? (turn.text.length > TURN_SUMMARY_MAX ? turn.text.slice(0, TURN_SUMMARY_MAX) : turn.text)
        : "turn";
      log.push({ type: "turn_end", label: summary, ts: turn.closedTs ?? record.startedAt });
    }
  }
  if (record.lastError) {
    log.push({ type: "error", label: record.lastError, ts: Date.now() });
  }
  return log;
}

/**
 * [STEP3] 从 turns[] 派生 displayItems（对齐 nicobailon getDisplayItems）。
 *
 * 与 getEventLog 的区别：产出可渲染单元（toolCall 含完整 name+args，text 含正文），
 * 而非离散事件。renderResult compact 用此数据 + formatToolCall 生成与 nicobailon
 * 一致的 `→ formatToolCall` 行格式。
 *
 * 派生规则（与 nicobailon getDisplayItems(messages) 等价）：
 *   - 遍历 turns[]，每个 turn：先 text（如果有），再 toolCalls
 *   - toolCall：{ type:"toolCall", name, args, status }
 *   - text：{ type:"text", text }（取首行，避免撑爆 compact）
 *   - 跳过 thinking（与 nicobailon 一致，不在 compact 展示推理）
 *
 * 参数类型放宽为 `{ turns: readonly Turn[] }` 结构子集——ExecutionRecord 和
 * ReconstructedRecord 都满足，磁盘重建路径（record-store）可复用此函数派生
 * displayItems，而非给空数组（否则终态 record 详情看不到 text）。
 */
export function getDisplayItems(record: { turns: readonly Turn[] }): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const turn of record.turns) {
    // assistant 正文（与 nicobailon 顺序一致：先 text 后 toolCall）
    if (turn.text.length > 0) {
      items.push({ type: "text", text: turn.text });
    }
    for (const tc of turn.toolCalls) {
      items.push({
        type: "toolCall",
        name: tc.toolName,
        args: (tc.args ?? {}) as Record<string, unknown>,
        status: tc._status,
      });
    }
  }
  return items;
}

/**
 * 从 turns[] 末尾推导当前活动行（running 时）。
 *
 *   优先级：最后一个未闭合 turn 的末尾 running toolCall → thinking → text → undefined
 *
 * 仅 status==="running" 时返回；terminal 态返回 undefined。
 *
 * 注意：返回的 type 联合（"tool"|"text"|"thinking"）是手写的，未通过类型守卫从
 * AgentEvent 派生——它映射的是累积的 turn 状态（InternalToolCall._status + turn.thinking/text），
 * 而非单个事件。若未来新增 turn 内容模式（如 reasoning_summary），须同步扩展本函数，
 * 否则会静默返回 undefined（活动行运行中途消失）。updateFromEvent 的 switch 有 never 穷尽
 * 检查，但本函数没有，依赖人工同步。
 */
export function getCurrentActivity(
  record: ExecutionRecord,
): { type: "tool" | "text" | "thinking"; label: string } | undefined {
  if (record.status !== "running") return undefined;
  const turn = record.turns[record.turns.length - 1];
  if (turn === undefined || turn.closed) return undefined;

  // 1. 倒序找最后一个 running 的 toolCall
  for (let i = turn.toolCalls.length - 1; i >= 0; i--) {
    const tc = turn.toolCalls[i];
    if (tc?._status === "running") {
      return { type: "tool", label: extractLabelFromArgs(tc.toolName, tc.args) };
    }
  }
  // 2. 正在 thinking
  if (turn.thinking) {
    return { type: "thinking", label: turn.thinking.slice(0, ACTIVITY_LABEL_MAX) };
  }
  // 3. 正在输出 text
  if (turn.text) {
    return { type: "text", label: turn.text.slice(0, ACTIVITY_LABEL_MAX) };
  }
  return undefined;
}

/**
 * 聚合所有 turn 的 text 为完整文本（替代旧 collectResponseText）。
 *
 * 单一数据源：不再读 session.messages，text 完全来自 record.turns[] 的流式累积。
 * 多 turn 用空行分隔（每个 turn 是一段独立的 assistant 输出）。
 *
 * 语义对齐旧 collectResponseText：后者只取最后一条 assistant message 的 text。
 * turns[] 收口后，每条 assistant message 对应一个 turn，故 join 所有非空 turn 文本
 * 与「拼接所有 assistant message」语义一致。单 turn 场景两者完全等价。
 */
export function getFullText(record: ExecutionRecord): string {
  return record.turns
    .map((t) => t.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

// [H1 U6 / D7 ③] getFullTextFrom / nextRoundBaseTurnIndex（增量通知 base 死记账族）
// 已退役删除：唯一调用点 onRoundSettled（inproc 时代）消亡后生产零调用，写点
// settleChatRoundFromResponse 随载体删除；「notify 失败 base 不推进」防丢文本语义由
// record.result 恒写承接（D7 ③ 退役不迁移）。getFullText 本体与既有调用方零改动。

/**
 * 聚合所有 turn 的 toolCalls（扁平化），并 strip InternalToolCall 的内部字段。
 * 供 collectResult / schema enforcement 读，替代旧闭包 toolCalls 旁路。
 *
 * 返回 ToolCall[]（不含 _status / startedTs）——跨边界导出形状清洁，
 * 避免内部状态机字段泄漏到 AgentResult.toolCalls / 持久化层。
 */
export function getAllToolCalls(record: ExecutionRecord): ToolCall[] {
  return record.turns.flatMap((t) => t.toolCalls.map(stripInternal));
}

/**
 * 聚合所有 turn 的 toolCalls 总数（免克隆计数）。
 *
 * getAllToolCalls 会 flatMap + strip 克隆出完整数组——只需计数的调用方（渲染签名
 * 每 200ms tick 调用一次）用它是纯浪费；本函数 reduce 累加各 turn 的 length，零分配。
 * 与 getAllToolCalls(...).length 恒等（同一 turns 源）。
 */
export function countAllToolCalls(record: ExecutionRecord): number {
  return record.turns.reduce((sum, t) => sum + t.toolCalls.length, 0);
}

/** 把 InternalToolCall 映射回纯净的 ToolCall（丢弃 _status / startedTs）。 */
function stripInternal(tc: InternalToolCall): ToolCall {
  return {
    toolName: tc.toolName,
    args: tc.args,
    result: tc.result,
    isError: tc.isError,
  };
}

/**
 * 聚合所有 turn 的 usageDelta 为完整 usage（含 total + cost）。
 * 全零则返回 undefined（与旧 toUsageTotal 语义一致）。
 *
 * cost 来自 SdkEvent.message.usage.cost.total（message_end 时透传到 usageDelta）。
 * 旧 toUsageTotal/session-runner 累积 cost；本重构保留该行为。
 */
export function getTotalUsage(record: ExecutionRecord): AgentUsageTotal | undefined {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
  for (const turn of record.turns) {
    const u = turn.usageDelta;
    if (u) {
      input += u.input ?? 0;
      output += u.output ?? 0;
      cacheRead += u.cacheRead ?? 0;
      cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost ?? 0;
    }
  }
  const total = input + output + cacheRead + cacheWrite;
  if (total === 0) return undefined;
  return { input, output, cacheRead, cacheWrite, total, cost };
}

// ============================================================
// 完成（唯一入口）
// ============================================================

/**
 * status 状态机的 CAS 互斥锁。仅当 `record.status === "running"` 时改为 target
 * 并返回 true，否则返回 false。**status 状态机本身就是互斥锁**——终态
 * （closed/cancelled）不可逆，check-then-set 在 JS 单线程事件循环里天然原子。
 *
 * 用途：executor 的收尾竞争。cancelBackground 与 background detached 完成回调
 * 都调 tryTransition 抢锁：抢到负责完整收尾，没抢到闭嘴不做事。
 *
 * target 仅限正常执行流的两终态（closed + cancelled）。
 * closed 携带 closedReason（L2 原因子枚举），由重建路径或正常执行流写入。
 * 重建路径也可用 markReconstructedStatus 直接赋值（跳过 CAS）。
 *
 * @param closedReason closed 终态的 L2 关闭原因。仅 target="closed" 时有意义；
 *   target="cancelled" 时忽略。缺省 "gc"（通用完成/失败）。
 */
export function tryTransition(
  record: ExecutionRecord,
  target: "closed",
  closedReason?: ClosedReason,
): boolean {
  if (record.status !== "running") return false;
  record.status = target;
  record.closedReason = closedReason ?? "gc";
  return true;
}

/**
 * [v8.5 D] 透明重生唯一回边：closed → running，清除终态语义位。
 *
 * 与 tryTransition 单向语义的关系：tryTransition 只负责 running→closed 终化且不可逆；
 * 本函数是刻意豁免的逆向特例——仅服务 message action 对可重连记录（finalizedReason
 * ∈ RECONNECTABLE_FINAL_REASONS）的同 id 重生。调用方必须先通过四守卫（sessionFile
 * 存在 / 非 tombstone / 可重连 reason / worktree+alive 探针），禁止在正常执行流程中
 * 使用。running 入态防御性 no-op：重生是 closed 的专属回边，不是万能改写器。
 */
export function resurrectClosed(
  record: { status: ExecutionStatus; closedReason?: ClosedReason; endedAt?: number },
): boolean {
  if (record.status !== "closed") return false;
  record.status = "running";
  record.closedReason = undefined;
  record.endedAt = undefined;
  return true;
}

/**
 * 重建专用收口：跳过 CAS 直接赋值 status。
 *
 * 仅用于 session-reconstructor 从 session.jsonl 重建终态 record 时——
 * 重建的 record 没有 running 状态需要保护，直接赋值即可。
 * 禁止在正常执行流程中使用此函数（应使用 tryTransition）。
 */
export function markReconstructedStatus(
  record: { status: ExecutionStatus },
  status: ExecutionStatus,
): void {
  record.status = status;
}

/**
 * 唯一完成入口。冻结状态（写 endedAt/agentResult/result/error/outcome）。
 * 不修改 turns/totalTokens——已由 updateFromEvent 累积，completeRecord 只读不重置。
 *
 * ⚠ 前置条件：调用方必须先通过 tryTransition 抢到锁（status 已被 CAS 设为 target）。
 *
 * @param closedReason closed 终态的 L2 关闭原因。仅 status="closed" 时写入；
 *   "cancelled" 时忽略。
 */
export function completeRecord(
  record: ExecutionRecord,
  result: AgentResult,
  status: "closed",
  closedReason?: ClosedReason,
): void {
  record.status = status;
  record.closedReason = closedReason ?? "gc";
  // U3 C-outcome：outcome 唯一写入点——终态语义在此一次定形（D6），下游消费方
  // （project/list/notify 文案/渲染器）只读 record.outcome，不再各自推导。
  record.outcome = deriveOutcome(record.closedReason, result.error);
  record.endedAt = Date.now();
  record.agentResult = result;
  record.result = result.text;
  record.error = result.error;
}

// ============================================================
// 终态 outcome（U3 C-outcome：单一权威派生）
// ============================================================

/**
 * closed 终态 → 三态 outcome 的唯一权威派生（D6 收敛：原 notifier/bg-notify-render/
 * shared deriveClosedDisplay 三处手写同构 switch 的单一实现）。
 *
 * 判定顺序（顺序敏感，勿回退成「error 有值即 failed」的无视取消规则）：
 *   1. closedReason === "cancelled" → "cancelled"（取消优先，不参与 error——abort 合成
 *      result 可能携带 error，但用户取消语义优先）
 *   2. error 非空（truthy，与旧三处同构的 `record.error &&` 判定逐字对齐——空串 error
 *      不构成失败）→ "failed"
 *   3. 其余 → "completed"
 *
 * [D6 待核项保真] 「failed 优先于 patchFile 提示」：失败轮也会写 patchFile
 * （doFinalizeRecord Step 0 对 worktreeHandle 无条件 collectPatch），消费方必须先按
 * outcome 分流再渲染 patch 提示——failed 分支不展示 patch/result。历史 bug：notifier
 * 的 patchFile 分支曾遮蔽 gc+error 判定，失败终态被 LLM 告知 completed（M1 修复存档）。
 *
 * [D6 显式取舍] parent-shutdown/parent-fork/parent-new 合成关闭（subagent-service
 * disposeAllRecords 合成 result 恒写 error:"closed due to ${reason}"）在本映射下落
 * "failed"——语义为「父进程关闭时子 agent 未完成即失败」，选定行为而非疏漏，
 * 勿当 bug 改回 cancelled 造成派生矛盾。
 *
 * 唯一写点 completeRecord 调用本函数冻结 record.outcome；通知 payload（notifier 投影
 * 边界）与无 outcome 字段的存量/重建 record 由 projectOutcome 兜底复用本函数。
 */
export function deriveOutcome(
  closedReason: ClosedReason | undefined,
  error: string | undefined | null,
): ExecutionOutcome {
  if (closedReason === "cancelled") return "cancelled";
  if (error) return "failed";
  return "completed";
}

/**
 * 投影层 outcome 唯一出口：running → undefined（终态语义不适用活跃态）；closed →
 * 一等 outcome 字段直读优先，字段缺失（存量/磁盘重建 record——outcome 持久化不在
 * U3 领地内）时回退 deriveOutcome(closedReason, error) 兜底——单一权威函数，
 * 消费方零手写推导。返回值联合含 "closed-legacy" 预留态，消费方必须处理。
 */
export function projectOutcome(record: {
  status: ExecutionStatus;
  outcome?: ExecutionOutcome;
  closedReason?: ClosedReason;
  error?: string;
}): ProjectedOutcome | undefined {
  if (record.status !== "closed") return undefined;
  return record.outcome ?? deriveOutcome(record.closedReason, record.error);
}

// ============================================================
// 投影（唯一 → Details / Snapshot / Persisted）
// ============================================================

/** elapsedSeconds 唯一计算点（共享 helper，消除三处发散）。endedAt 缺失用 Date.now()。 */
export function computeElapsedSeconds(record: { startedAt: number; endedAt?: number }): number {
  const end = record.endedAt ?? Date.now();
  return Math.floor((end - record.startedAt) / MS_PER_SECOND);
}

/**
 * 投影到 SubagentToolDetails。elapsedSeconds/currentActivity/eventLog 均现算派生。
 */
export function project(record: ExecutionRecord): SubagentToolDetails {
  return {
    status: record.status,
    outcome: projectOutcome(record),
    mode: record.mode,
    agent: record.agent,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    slug: record.slug,
    turns: record.turnCount,
    totalTokens: record.totalTokens,
    elapsedSeconds: computeElapsedSeconds(record),
    eventLog: getEventLog(record),
    displayItems: getDisplayItems(record),
    result: record.result,
    error: record.error,
    currentActivity: getCurrentActivity(record),
    parsedOutput: record.agentResult?.parsedOutput,
    sessionFile: record.sessionFile,
    patchFile: record.patchFile,
  };
}

/**
 * 投影到 live 进度快照。elapsedSeconds/currentActivity/eventLog 均现算派生。
 * 供 WorkflowsView 在 agent 运行期间读取实时进度。
 */
export function projectLiveProgress(record: ExecutionRecord): {
  status: ExecutionRecord["status"];
  turns: number;
  totalTokens: number;
  elapsedSeconds: number;
  eventLog: AgentEventLogEntry[];
  currentActivity: ReturnType<typeof getCurrentActivity>;
  lastError: string | undefined;
} {
  return {
    status: record.status,
    turns: record.turnCount,
    totalTokens: record.totalTokens,
    elapsedSeconds: computeElapsedSeconds(record),
    eventLog: getEventLog(record),
    currentActivity: getCurrentActivity(record),
    lastError: record.lastError,
  };
}

/**
 * 投影到只读快照（TUI list / poll 消费）。
 * 浅拷贝 turns[]，字段标 readonly 阻止 TUI 回写。
 */
export function snapshot(record: ExecutionRecord): RecordSnapshot {
  return {
    id: record.id,
    agent: record.agent,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    mode: record.mode,
    task: record.task,
    slug: record.slug,
    status: record.status,
    chatMode: record.chatMode,
    turns: record.turnCount,
    totalTokens: record.totalTokens,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    result: record.result,
    error: record.error,
    sessionFile: record.sessionFile,
  };
}

// ============================================================
// JSONL → AgentEvent 翻译（从 live/jsonl-to-agent-event 迁入）
// ============================================================

/** subprocess JSONL 事件（JSON.parse 结果）。duck-typed，对应 SDK SdkEvent。 */
type JsonlEvent = Record<string, unknown>;

// ── 各 case 翻译器（jsonlToAgentEvent 按 case 分发，每个翻译器单一职责）──

/** tool_execution_start → tool_start。toolName 非字符串归一空串（与原实现一致）。 */
function translateToolExecutionStart(raw: JsonlEvent): AgentEvent[] {
  const toolName = typeof raw.toolName === "string" ? raw.toolName : "";
  return [{ type: "tool_start", toolName, args: raw.args }];
}

/** tool_execution_end → tool_end。isError 仅在 === true 时成立；result 原样透传。 */
function translateToolExecutionEnd(raw: JsonlEvent): AgentEvent[] {
  const toolName = typeof raw.toolName === "string" ? raw.toolName : "";
  const isError = raw.isError === true;
  return [{
    type: "tool_end",
    toolName,
    args: raw.args,
    result: raw.result as ToolCallResult | undefined,
    isError,
  }];
}

/**
 * message_update → thinking_delta / text_delta。
 *   ame.type === "thinking_delta"（delta 非字符串归一空串）
 *   其余 ame（delta 有值）→ text_delta（delta 非字符串 String() 归一）
 *   ame 缺失 / delta 缺失 → 不产出。
 */
function translateMessageUpdate(raw: JsonlEvent): AgentEvent[] {
  const ame = raw.assistantMessageEvent as Record<string, unknown> | undefined;
  if (ame?.type === "thinking_delta") {
    const delta = typeof ame.delta === "string" ? ame.delta : "";
    return [{ type: "thinking_delta", delta }];
  }
  if (ame !== undefined && ame.delta !== undefined) {
    const delta = typeof ame.delta === "string" ? ame.delta : String(ame.delta);
    return [{ type: "text_delta", delta }];
  }
  return [];
}

/**
 * 把一条 JSONL 事件翻译成 AgentEvent。
 *
 * 返回 undefined 表示该事件不映射到任何 AgentEvent（如 session header、message_start），
 * 调用方应跳过。
 *
 * 一个 JSONL 事件可能产出**多条** AgentEvent（message_end 的 usage + error 各一条），
 * 故返回数组。绝大多数情况长度为 0 或 1；message_end 最多 2 条。
 */
export function jsonlToAgentEvent(raw: JsonlEvent): AgentEvent[] {
  const type = raw.type;

  switch (type) {
    case "session":
    case "message_start":
    case "turn_start":
      return [];

    // 工具执行期活性信号（与 pi 侧 spawn-event-translator 的 TOOL_ACTIVITY_EVENT 同
    // 语义）：不产数据，只驱动宿主无进展守护刷新。
    case "tool_execution_update":
      return [{ type: "activity" }];

    case "tool_execution_start":
      return translateToolExecutionStart(raw);

    case "tool_execution_end":
      return translateToolExecutionEnd(raw);

    case "message_update":
      return translateMessageUpdate(raw);

    case "turn_end": {
      return [{ type: "turn_end" }];
    }

    case "message_end": {
      return accumulateMessageEndForRecord(raw);
    }

    case "compaction_start": {
      return [{ type: "compaction" }];
    }

    default:
      return [];
  }
}

/** message_end 翻译：usage 拍平 + stopReason=error/aborted 额外产 error 事件。 */
function accumulateMessageEndForRecord(raw: JsonlEvent): AgentEvent[] {
  const events: AgentEvent[] = [];
  const msg = raw.message as Record<string, unknown> | undefined;
  const usageRaw = (typeof msg?.usage === "object" && msg.usage !== null) 
    ? msg.usage as Record<string, unknown> 
    : undefined;

  if (usageRaw) {
    const costObj = (typeof usageRaw.cost === "object" && usageRaw.cost !== null)
      ? usageRaw.cost as Record<string, unknown>
      : undefined;
    // MF-3 fix: 显式提取字段 + Number.isFinite 守卫，不使用 spread + as 断言
    const numOrZero = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    const usage: AgentUsage = {
      input: numOrZero(usageRaw.input),
      output: numOrZero(usageRaw.output),
      cacheRead: numOrZero(usageRaw.cacheRead),
      cacheWrite: numOrZero(usageRaw.cacheWrite),
      cost: typeof costObj?.total === "number" ? costObj.total : undefined,
    };
    events.push({ type: "message_end", usage });
  }

  const stopReason = msg?.stopReason;
  if (stopReason === "error" || stopReason === "aborted") {
    const errorMessage = typeof msg?.errorMessage === "string"
      ? msg.errorMessage
      : (typeof raw.reason === "string" ? raw.reason : String(stopReason));
    events.push({ type: "error", message: errorMessage });
  }

  return events;
}
