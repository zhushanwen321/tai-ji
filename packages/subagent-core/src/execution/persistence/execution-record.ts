// src/core/execution-record.ts
//
// 唯一执行状态对象 + 唯一创建/更新/完成/投影入口。
//
// 收口设计（2026-06-22 重构）：
//   一次执行的完整内容（text/thinking/toolCalls/usage）按 turn 收口在 record.turns[]。
//   eventLog / currentActivity / result 文本均从 turns[] 派生（getEventLog /
//   getCurrentActivity / getFullText），不再独立存储切片或缓冲。
//
//   createRecord    唯一创建入口（model 允许 undefined = 用户未指定，R4/D6-①——
//                   旧「创建时必填」不变量随模型可选化显式反转：poll 路径丢 model
//                   的原始缺陷已由「identity 字段创建时一次确定」的收口本身消解，
//                   undefined 是合法缺席语义而非丢失）
//   updateFromEvent 唯一事件更新入口（累积进 turns[]，消灭闭包旁路累积器）
//   completeLegacyClosed 唯一 legacy 终态冻结入口（D7 例外族 / 监督器放弃，W4 sunset）
//   project/snapshot 唯一投影入口（两路径字段一致）
//
// Core 层叶子原语：依赖 types.ts + 引擎 SDK 契约（§3.1.4 后事件 reducer 单源在 SDK，
// updateFromEvent 为委托）。零 Pi / Runtime / TUI 依赖。

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
  RecordOrigin,
  RecordSnapshot,
  StopReason,
  SubagentToolDetails,
  ToolCall,
  Turn,
} from "../assembly/types.ts";
// [§3.1.4 reducer 单源] 事件 reducer 的唯一实现体在 SDK（重放与活体共用），本文件
// 只做委托——core 侧副本（8 个 apply* 处理器 + running toolCall 索引）已删。
import { updateFromEvent as sdkUpdateFromEvent } from "@zhushanwen/subagent-engine-sdk";

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
 * 导出单源：活态 record 与磁盘重建（session-reconstructor）共用，副本已删。
 */
export function addUsage(prev: AgentUsage | undefined, next: AgentUsage): AgentUsage {
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

/** 创建一个空 turn（text/thinking 空，无 toolCalls，未闭合）。
 *  导出单源：活态创建与磁盘重建（session-reconstructor）共用，副本已删。 */
export function emptyTurn(): Turn {
  return { text: "", thinking: "", toolCalls: [], usageDelta: undefined, closed: false };
}

/**
 * 唯一创建入口。identity 字段（agent/model/thinkingLevel/mode/task）一次确定不可变。
 *
 * [R4/D6-① 反转] model 允许 undefined：原「创建时必填——poll 路径 model 丢失的架构
 * 修复」不变量，其防丢失价值由「identity 创建时一次确定」收口本身承载（poll 不再
 * 缺字段）；undefined 现是合法缺席语义 = 用户未指定模型（引擎走自身缺省解析，
 * 如 zcode 的 defaultModelSelection），record.model 留空如实投影。禁空串哨兵。
 */
export function createRecord(
  id: string,
  identity: {
    agent: string;
    /** [R4/D6-①] 缺席 = 用户未指定模型（条件盖章的调用方不产本键）。 */
    model?: string | undefined;
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
    /** [modeless 波1] chatMode 停写删除——「模式」不再是 record 状态（万物可续）。
     *  空闲超时毫秒数（idle GC 回收节奏，覆盖默认 5min）。 */
    idleTimeoutMs?: number;
    /** 实际执行引擎 id（P4 路由留痕，D9①）。缺省 = pi 投影（存量零迁移）。 */
    engine?: string;
    /** 引擎 fallback 留痕（probe 失败路由回默认引擎）。GUI 警告条数据源。 */
    engineFallback?: { from: string; reason: string };
    /** [A3/S3 修复] 来源身份冷复活透传——origin/parentRunId 与 engine 同属 identity
     *  域经 createRecord 重建：冷查链漏传会让 workflow 批成员复活后 origin=undefined，
     *  绕过 messageHandler 的 one-shot 批成员守卫。tool 来源两字段恒 undefined。 */
    origin?: RecordOrigin;
    /** origin="workflow" 时所属 workflow run 的 id（W2 写入）。 */
    parentRunId?: string;
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
    idleTimeoutMs: identity.idleTimeoutMs,
    engine: identity.engine,
    engineFallback: identity.engineFallback,
    // [A3/S3 修复] 冷复活透传——origin 属 identity 域（见 identity 签名注释）
    origin: identity.origin,
    parentRunId: identity.parentRunId,

    // 状态（实时更新）
    status: "running",
    // turns[] 初始化为 [空 turn]——第一个 turn 从创建即存在，
    // updateFromEvent 直接往 turns[last] 累积，无需「无 turn」分支判断。
    turns: [emptyTurn()],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
    // 对话轮次计数（首轮 = 0，每完成一轮 finalizeRoundToIdle +1）。modeless 波1 起
    // 全 record 自增（万物可续）。
    round: 0,

    // 完成（completeLegacyClosed 唯一写点）
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

// [§3.1.4 reducer 单源] 本文件此前自持一份 updateFromEvent 实现（currentTurn /
// findRunningToolCall / runningToolIndex / 8 个 apply* 处理器），与 SDK 的
// journal-replay.ts 逐字同形——两处各改一处即漂移，且既有 conformance C5 用例只跑
// SDK 路径，从不调用本实现（防漂移断言名不副实）。现收敛为委托 SDK 单源：SDK 那份
// 是超集（多 running toolCall 的 O(1) 倒序索引），重放与活体共用同一 reducer 的设计
// 决策因此真正成立（SDK ReplayRecordView 注释已声明「core ExecutionRecord 满足本视图」）。

/**
 * 从 AgentEvent 更新 record（累积进 record.turns[]）——委托 SDK reducer 单源。
 *
 * 语义（实现体在 @zhushanwen/subagent-engine-sdk 的 journal-replay.ts）：
 *   - text/thinking：流式累积进当前 turn（完整内容，非切片）
 *   - tool_start/end：push 进 currentTurn().toolCalls（含完整 result）；tool_end 索引
 *     O(1) 命中，miss 回退跨 turn 倒序全扫（兜底滞后事件 / 历史 running toolCall）
 *   - turn_end：闭合当前 turn，记 closedTs，turnCount++，清 lastError
 *   - message_end：usage 增量累加进末 turn.usageDelta + totalTokens 累加；error 记 lastError
 *   - error：存 record.lastError（getEventLog 派生 error 条目用）
 *   - compaction/activity/armed：no-op（活性与协议回执不进 record 投影）
 *
 * 唯一写点——session-runner 闭包不再旁路累积，collectResult 从 record 读。
 * 穷尽性由 SDK 侧 switch 的 `never` 断言保证（新增 AgentEvent variant 时编译期报错）。
 */
export function updateFromEvent(record: ExecutionRecord, event: AgentEvent): void {
  sdkUpdateFromEvent(record, event);
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
  return deriveEventLog(record.turns, record.lastError, record.startedAt);
}

/**
 * eventLog 派生本体（单源）——活态路径（getEventLog）与磁盘重建路径
 * （session-reconstructor 的 ReconstructedRecord）共用同一实现，此前两处各持
 * 副本、靠注释互指「镜像」（漂移面已删）。
 *
 * 形参取最小结构（turns + lastError + startedAt）而非 ExecutionRecord：重建路径
 * 产出的不是 ExecutionRecord，放宽形参即可直接复用（与 getDisplayItems 同款手法）。
 */
export function deriveEventLog(
  turns: readonly Turn[],
  lastError: string | undefined,
  startedAt: number,
): AgentEventLogEntry[] {
  const log: AgentEventLogEntry[] = [];
  for (const turn of turns) {
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
      log.push({ type: "turn_end", label: summary, ts: turn.closedTs ?? startedAt });
    }
  }
  if (lastError) {
    log.push({ type: "error", label: lastError, ts: Date.now() });
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
  return joinTurnText(record.turns);
}

/**
 * turn 正文拼接（单源）——空文本 turn 过滤后按空行连接。活态路径（getFullText）与
 * 磁盘重建路径（session-reconstructor 的 result 派生）共用，重建侧的内联 join 已删。
 * 形参取最小结构（turns）以便重建产物直接复用。
 */
export function joinTurnText(turns: readonly Turn[]): string {
  return turns
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
 * cost 来自 SDK 事件的 message.usage.cost.total（message_end 时透传到 usageDelta）。
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
// 意图原语（record 两态机内存面：CAS 收口 / 冻结 / 回边）
// ============================================================

/**
 * 意图原语：legacy closed 终态收口的 CAS 抢锁（settle 方向：running → idle）。
 * 仅当 `record.status === "running"` 时收口并返回 true，否则返回 false。**status
 * 状态机本身就是互斥锁**——check-then-set 在 JS 单线程事件循环里天然原子。
 *
 * [W2/V3 说谎签名退役] 前身函数的 target 参数被 void 丢弃（说谎签名），本原语是
 * 同一行为的诚实命名——无目标参数：收口
 * 目标恒为 legacy closed 形态（idle + closedReason/stopReason 双写，桥接不变量
 * 「closed ⟺ idle ∧ closedReason≠undefined」的写侧半边）。
 *
 * 写侧生产者仅剩两处（types.ts ExecutionStatus 头注登记）：workflow D7 例外族
 * （settleWorkflowRecord 收口单点）与监督器放弃产出（service-binding giveUp）；
 * 读侧对偶 = isLegacyClosedSettled 单一谓词。轮收口（非终态）走 store.markSettled
 * （不写 closedReason），与本原语语义分界清晰。
 *
 * @param closedReason 旧终态 L2 原因（同时镜像进 stopReason 展示位）。
 *   缺省 "gc"（通用完成/失败）。
 */
export function trySettleLegacyClosed(
  record: ExecutionRecord,
  closedReason?: ClosedReason,
): boolean {
  if (record.status !== "running") return false;
  record.status = "idle";
  record.closedReason = closedReason ?? "gc";
  record.stopReason = record.closedReason;
  return true;
}

/**
 * status 状态机的 CAS 互斥锁（wake 方向：idle → running，U2 新增）。仅当
 * `record.status === "idle"` 时翻回 running 并返回 true；running（一轮已在飞）/
 * 其他形态一律拒绝。与 trySettleLegacyClosed（settle 方向）共同构成两态状态机的
 * running↔idle 迁移面，非法迁移（对 running 重复 settle / 对 running 重复 wake）
 * 由 CAS 前置判据拒绝。
 *
 * 用途：message 链对 idle record 的接管（U4 准入单点接线）；不清收口位——
 * stopReason/closedReason 的清除归接管编排（对齐 resurrectClosed 桥接语义），
 * 本原语只做占用位翻转。
 */
export function tryEnterRunning(record: ExecutionRecord): boolean {
  if (record.status !== "idle") return false;
  record.status = "running";
  return true;
}

/**
 * [v8.5 D → U2 桥接] 已收口 record 的接管回边：idle → running，清除收口语义位。
 *
 * 旧语义（closed → running 透明重生）随终态概念删除而迁移：磁盘重建/内存中的
 * 「已收口」形态在两态下即 idle（桥接不变量，closedReason 有值为旧终态遗留），
 * message 链接管时经本函数翻回 running。running 入态防御性 no-op：接管是已收口
 * record 的专属回边，不是万能改写器。U4 准入判据单点重写（reviveOrThrow 合并）
 * 后本函数由新接管原语承接。
 */
export function resurrectClosed(
  record: {
    status: ExecutionStatus;
    closedReason?: ClosedReason;
    stopReason?: StopReason;
    endedAt?: number;
  },
): boolean {
  if (record.status !== "idle") return false;
  record.status = "running";
  record.closedReason = undefined;
  record.stopReason = undefined;
  record.endedAt = undefined;
  return true;
}

/**
 * 重建专用收口：跳过 CAS 直接赋值 status。
 *
 * 仅用于 session-reconstructor 从 session.jsonl 重建终态 record 时——
 * 重建的 record 没有 running 状态需要保护，直接赋值即可。
 * 禁止在正常执行流程中使用此函数（应使用 trySettleLegacyClosed）。
 */
export function markReconstructedStatus(
  record: { status: ExecutionStatus },
  status: ExecutionStatus,
): void {
  record.status = status;
}

/**
 * 意图原语：legacy closed 终态冻结（D7 例外族 / 监督器放弃的终态写点）。
 * 冻结状态（写 endedAt/agentResult/result/error/outcome）。
 * 不修改 turns/totalTokens——已由 updateFromEvent 累积，本函数只读不重置。
 *
 * ⚠ 前置条件：调用方必须先通过 trySettleLegacyClosed 抢到锁（status 已被 CAS 置 idle）。
 *
 * [W2/V3 说谎签名退役] 前身函数的 status 参数被 void 丢弃（说谎签名），本原语是
 * 同一行为的诚实命名——无目标
 * 参数：冻结目标恒为 legacy closed 形态（idle + closedReason/stopReason 双写，
 * 与 trySettleLegacyClosed 同构）。唯一 outcome 写入点（U3 C-outcome）。
 *
 * @param closedReason 旧终态 L2 关闭原因（同时镜像进 stopReason 展示位）。
 */
export function completeLegacyClosed(
  record: ExecutionRecord,
  result: AgentResult,
  closedReason?: ClosedReason,
): void {
  record.status = "idle";
  record.closedReason = closedReason ?? "gc";
  record.stopReason = record.closedReason;
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
 * 唯一写点 completeLegacyClosed 调用本函数冻结 record.outcome；通知 payload（notifier 投影
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
 * 旧「closed 终态」读判定的单一谓词（[W2/V3 D5] 桥接判据收敛——历史 6 文件 9 处
 * 手抄 `status === "idle" && closedReason !== undefined` 的唯一权威实现，判定语义
 * 一字不变；新增读点禁止手抄，一律 import 本函数）。
 *
 * 桥接不变量（两态迁移，U2 起）：旧 closed 终态读形态 ⟺ idle ∧ closedReason 有值。
 * markSettled/markRoundIdle 产出的轮间 idle 不携带 closedReason（新侧语义——settle
 * 不是终态），不命中本谓词；旧终态遗留（D7 例外族终态、监督器放弃、v1 数据、manifest
 * 读侧）命中。
 *
 * [W2 D5 兼容位] closedReason 是读侧兼容位（设计 D5：随 W4 sunset 退役），本谓词是
 * 其唯一读点——兼容位收缩时只改此处。
 *
 * @param record 结构子集（ExecutionRecord / SubagentRecord / entry 快照均满足）——
 *   谓词只消费两态状态位与 closedReason 遗留位，不要求完整 record。
 */
export function isLegacyClosedSettled(record: {
  status: ExecutionStatus;
  closedReason?: ClosedReason;
}): boolean {
  return record.status === "idle" && record.closedReason !== undefined;
}

/**
 * 投影层 outcome 唯一出口：running / 轮间 idle → undefined（outcome 语义只适用
 * 旧终态遗留形态）；旧终态（isLegacyClosedSettled 命中）→ 一等 outcome
 * 字段直读优先，字段缺失（存量/磁盘重建 record——outcome 持久化不在 U3 领地内）
 * 时回退 deriveOutcome(closedReason, error) 兜底——单一权威函数，消费方零手写推导。
 * 返回值联合含 "closed-legacy" 预留态，消费方必须处理。
 */
export function projectOutcome(record: {
  status: ExecutionStatus;
  outcome?: ExecutionOutcome;
  closedReason?: ClosedReason;
  error?: string;
}): ProjectedOutcome | undefined {
  // [W2/V3 D5] 桥接判据收敛：旧「closed」读形态 ⟺ isLegacyClosedSettled（markSettled
  // 的轮间 idle 无 closedReason，不投影 outcome——非终态语义）。
  if (!isLegacyClosedSettled(record)) return undefined;
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
    turns: record.turnCount,
    totalTokens: record.totalTokens,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    result: record.result,
    error: record.error,
    sessionFile: record.sessionFile,
  };
}
