// src/core/session-reconstructor.ts
//
// 从 subagent 的 session.jsonl 重建完整的 SubagentRecord 数据。
//
// 背景：subagent 执行时 SDK 把完整对话（assistant text/thinking/toolCall + usage +
// toolResult）实时 flush 进 session.jsonl。终态后内存 record 被立即淘汰（archive），
// collectRecords 读时用本模块从 session.jsonl 重建 turns[]，恢复 eventLog/result/error
// 等富数据——session.jsonl 是唯一 source of truth（history.jsonl 已废弃）。
//
// 身份恢复：session.jsonl 的 header 不含 ExecutionRecord.id / agent / mode，故
// session-runner 在创建 session 后立即写一条 custom entry（customType:"subagent-identity"）
// 携带 {id, agent, mode, task, startedAt}。本模块读这条 entry 恢复身份。
//
// 纯函数 + 防御性 I/O：任何文件缺失/损坏/格式漂移/缺 identity entry 均返回 undefined
// （不抛），消费方降级跳过该 record 而非崩溃。与 execution-record.ts 同层（Core 纯数据变换）。
//
// 直接读文件 + 逐行 JSON.parse（session.jsonl = newline-delimited JSON），不依赖 SDK
// SessionManager 类——避免 tsconfig paths fallback 把 class 降级为 interface 的坑。

import * as fs from "node:fs";

import type {
  AgentEventLogEntry,
  AgentUsage,
  ExecutionMode,
  ExecutionStatus,
  InternalToolCall,
  RecordOrigin,
  Turn,
} from "./types.ts";
import { extractLabelFromArgs } from "./execution-record.ts";

// ============================================================
// 类型（SDK jsonl 结构的最小子集——窄化为重建所需字段）
// ============================================================

/** assistant message 的 usage（pi-ai Usage 的最小消费字段）。 */
interface JsonlUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/** assistant content block 联合（text/thinking/toolCall——重建只消费这三类）。 */
interface TextBlock { type: "text"; text: string; }
interface ThinkingBlock { type: "thinking"; thinking: string; }
interface ToolCallBlock { type: "toolCall"; id: string; name: string; arguments?: unknown; }
type AssistantContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

/** assistant message（pi-ai AssistantMessage 的最小消费字段）。 */
interface JsonlAssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  usage?: JsonlUsage;
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
}

/** toolResult message（pi-ai ToolResultMessage 的最小消费字段）。 */
interface JsonlToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content?: unknown[];
  details?: unknown;
  isError?: boolean;
  timestamp: number;
}

/** user message（重建 turns[] 时跳过，仅用于类型穷尽）。 */
interface JsonlUserMessage {
  role: "user";
  content: unknown;
  timestamp: number;
}

type JsonlMessage = JsonlUserMessage | JsonlAssistantMessage | JsonlToolResultMessage;

/** custom entry 的 data（session-runner 写入的 subagent-identity）。 */
export interface SubagentIdentityData {
  id: string;
  agent: string;
  mode: ExecutionMode;
  task: string;
  /**
   * 短标签（≤20 字符）。旧文件缺失→读取兜底空串（见 reconstructFromFile）。
   * 写入时（session-runner）必填；读取时可选以兼容旧文件。
   */
  slug?: string;
  startedAt: number;
  /** 根 Pi session ID（session 隔离过滤用）。旧文件可能缺失。 */
  rootSessionId?: string;
  /** 直接父 subagent record ID。旧文件缺失 → undefined（顶层）。 */
  parentRecordId?: string;
  /** subagent 递归深度。旧文件缺失 → 0（顶层）。 */
  depth?: number;
  /** [MF#4] 本 session 的 fork 深度（session-runner 写入 parentForkDepth+1）。旧文件可能缺失。 */
  forkDepth?: number;
  /**
   * 对话模式标志（可持续对话 subagent）。旧文件缺失 → undefined（按一次性模式处理）。
   * session-runner 写入；reconstructFromFile 经 ...identity 展开自动透传到 ReconstructedRecord。
   */
  chatMode?: boolean;
  /**
   * [review round2] worktree 隔离标志（该 subagent 创建时 worktree:true）。旧文件缺失 →
   * undefined。仅供跨重启重建路径判定「worktree 绑定已丢失」——WorktreeHandle 本身不可
   * 序列化，跨重启后无法 reattach，续聊须拒绝（防 resume cwd 静默回落主 repo 破坏隔离）。
   */
  worktree?: boolean;
  /** @deprecated 兼容旧文件：旧 identity entry 写的是 parentSessionId，读取时 fallback 到 rootSessionId。 */
  parentSessionId?: string;
  /**
   * 来源身份（H2 S3 修复）。旧文件缺失 → undefined（= "tool" 语义，缺省零迁移）。
   * standalone 形态（identity entry 链）的 workflow record 经本字段在重建面保留
   * origin 过滤语义；读取侧经 normalizeReconOrigin 守卫归一（非法值 → undefined）。
   */
  origin?: RecordOrigin;
  /** origin="workflow" 时所属 workflow run id。旧文件缺失 → undefined。 */
  parentRunId?: string;
}

/** SDK jsonl entry（getEntries() 返回，header 已排除）。 */
interface JsonlEntry {
  type: string;
  message?: JsonlMessage;
  customType?: string;
  data?: unknown;
  /** model_change entry 的字段。 */
  provider?: string;
  modelId?: string;
  /** thinking_level_change entry 的字段。 */
  thinkingLevel?: string;
  /** entry 级别的时间戳（ISO 字符串，SDK 逐行写入）。供 endedAt 推导。 */
  timestamp?: string;
}

// ============================================================
// 公开类型
// ============================================================

/** custom entry 的 customType 标识（session-runner 写 / reconstructor 读，约定常量）。 */
export const IDENTITY_CUSTOM_TYPE = "subagent-identity";

/** 重建产出的完整 SubagentRecord 数据（身份 + 可变状态 + 派生 eventLog）。 */
export interface ReconstructedRecord {
  // ── 身份（来自 custom entry）──
  id: string;
  agent: string;
  mode: ExecutionMode;
  task: string;
  /** 短标签（≤20 字符）。旧文件缺失→兜底空串。 */
  slug: string;
  startedAt: number;
  /** 根 Pi session ID（session 隔离过滤用）。旧文件可能缺失。 */
  rootSessionId: string | undefined;
  /** 直接父 subagent record ID。旧文件缺失 → undefined（顶层）。 */
  parentRecordId: string | undefined;
  /** subagent 递归深度。旧文件缺失 → 0（顶层）。 */
  depth: number;
  /** [MF#4] 本 session 的 fork 深度（来自 identity custom entry；旧文件为 undefined）。 */
  forkDepth: number | undefined;
  /** 对话模式标志（来自 identity custom entry；旧文件为 undefined）。 */
  chatMode?: boolean;
  /** [review round2] worktree 隔离标志（见 SubagentIdentityData.worktree）。 */
  worktree?: boolean;
  /**
   * 来源身份（H2 S3 修复，来自 identity custom entry 经守卫归一；旧文件 undefined =
   * "tool" 语义）。漏本字段则全量重建面（getFullRecord → reconstructFromFile）丢
   * origin，workflow record 逃过 D1 投影过滤。
   */
  origin: RecordOrigin | undefined;
  /** origin="workflow" 时所属 workflow run id（守卫归一后；缺省 undefined）。 */
  parentRunId: string | undefined;
  /**
   * 对话轮次计数（非 identity entry 字段，reconstructFromFile 不填）。
   * V2 idle record 的 round 只在内存维护（doFinalizeRoundToIdle 递增），磁盘重建不恢复。
   */
  round?: number;
  sessionFile: string;
  // ── 可变状态（来自 message entries）──
  status: ExecutionStatus;
  /** L2 关闭原因子枚举（仅 status="closed" 时有意义）。SP-1 新增。
   *  从 stopReason 推导：error/aborted → gc；其余 → gc。 */
  closedReason?: import("./types.ts").ClosedReason;
  turns: Turn[];
  turnCount: number;
  totalTokens: number;
  lastError: string | undefined;
  model: string;
  thinkingLevel: string | undefined;
  /** 最后一条 entry 的时间戳（ms）。供 finalize/crashed 重建填 endedAt，避免耗时无限增长。 */
  endedAt: number | undefined;
  /** 各 turn text 拼接的完整正文（镜像 getFullText）。 */
  result: string | undefined;
  /** 来自最后一条 error/aborted assistant message（无则 undefined）。 */
  error: string | undefined;
  /** 从 turns[] 派生的离散语义事件序列（与活态 record 同形）。 */
  eventLog: AgentEventLogEntry[];
}

// ============================================================
// 内部 helper
// ============================================================

/** turn_end 摘要截断长度（镜像 execution-record.ts TURN_SUMMARY_MAX）。 */
const TURN_SUMMARY_MAX = 80;

/** 从 turns[] 派生 eventLog（镜像 execution-record.ts getEventLog，但接受最小结构）。 */
function deriveEventLog(
  turns: Turn[],
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

/** 空 turn（镜像 execution-record.ts 的 emptyTurn，但本模块独立——避免循环依赖）。 */
function emptyTurn(): Turn {
  return { text: "", thinking: "", toolCalls: [], usageDelta: undefined, closed: false };
}

/** JsonlUsage → AgentUsage（cost 取 cost.total，与 session-runner 扁平化一致）。 */
function toAgentUsage(u: JsonlUsage): AgentUsage {
  return {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    cost: u.cost?.total,
  };
}

/** 累加 AgentUsage（field-wise，镜像 execution-record.ts addUsage）。 */
function addUsage(prev: AgentUsage | undefined, next: AgentUsage): AgentUsage {
  if (prev === undefined) return { ...next };
  return {
    input: prev.input + next.input,
    output: prev.output + next.output,
    cacheRead: prev.cacheRead + next.cacheRead,
    cacheWrite: prev.cacheWrite + next.cacheWrite,
    cost: (prev.cost ?? 0) + (next.cost ?? 0),
  };
}

/** 校验 custom entry data 是否为合法 SubagentIdentityData。 */
function isIdentityData(data: unknown): data is SubagentIdentityData {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.agent === "string" &&
    (d.mode === "sync" || d.mode === "background") &&
    typeof d.task === "string" &&
    typeof d.startedAt === "number"
  );
}

/**
 * 来源域守卫归一（H2 S3 修复）：origin 非法值/缺省 → undefined（= "tool" 语义）。
 * 字面量守卫与 record-store.readEntryOriginFields（主 entry 重建侧）逐字对齐——
 * identity entry 的 data 经 JSON.parse 后 origin 运行时值不可信，TS 类型只是断言，
 * 消费投影点必须守卫。
 */
function normalizeReconOrigin(v: unknown): RecordOrigin | undefined {
  return v === "workflow" || v === "tool" ? v : undefined;
}

/** parentRunId 安全读取（非 string → undefined），与 normalizeReconOrigin 同消费点。 */
function normalizeReconParentRunId(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}/**
 * 待匹配的 toolCall（assistant 发起，等 toolResult 回填）。
 * 记录在 assistant Turn 上，toolResult 到达时按 toolCallId 找到并填充。
 */
interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** 所属 Turn（toolResult 回填时推进这个 Turn 的 toolCalls）。 */
  turn: Turn;
  /** assistant message timestamp（作为 InternalToolCall.startedTs）。 */
  startedTs: number;
}

// ============================================================
// 全量重建内部 helper（按处理阶段拆分：读文件 → 扫身份 → 重建 turns → 组装）
// ============================================================

/**
 * 读文件 + 逐行 JSON.parse（session.jsonl = newline-delimited JSON）。
 * 第 1 行是 session header（type:"session"，跳过）；后续每行一个 entry。
 * 损坏行静默跳过（与 SDK parseSessionEntries 行为一致）。
 * @returns 文件缺失/读失败 → undefined；否则 entry 数组（可能为空）。
 */
function readJsonlEntries(sessionFile: string): JsonlEntry[] | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return undefined; // 文件缺失 → 降级。
  }

  const entries: JsonlEntry[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    if (i === 0) {
      // 第 1 行是 session header（type:"session"），跳过。
      try {
        const head = JSON.parse(line) as JsonlEntry;
        if (head.type === "session") continue;
      } catch (_e) {
        void _e; // 首行损坏 → 跳过，继续解析后续。
        continue;
      }
    }
    try {
      const parsed = JSON.parse(line) as JsonlEntry;
      if (parsed && typeof parsed.type === "string") {
        entries.push(parsed);
      }
    } catch (_e) {
      void _e; // 损坏行跳过（不阻断后续行）。
    }
  }
  return entries;
}

/** 身份/模型扫描产出（identity custom entry + 途经的 model/thinking_level change）。 */
interface IdentityScan {
  identity: SubagentIdentityData | undefined;
  model: string;
  thinkingLevel: string | undefined;
}

/** 扫 identity custom entry（必须存在，否则无法构造 record）+ 途经 model/thinking_level。 */
function scanIdentityAndModel(entries: JsonlEntry[]): IdentityScan {
  let identity: SubagentIdentityData | undefined;
  let model = "";
  let thinkingLevel: string | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === IDENTITY_CUSTOM_TYPE) {
      if (isIdentityData(entry.data)) identity = entry.data;
    } else if (entry.type === "model_change") {
      // model_change: {provider, modelId} → "provider/modelId"（与 record.model 同形）。
      if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
        model = `${entry.provider}/${entry.modelId}`;
      }
    } else if (entry.type === "thinking_level_change") {
      if (typeof entry.thinkingLevel === "string") thinkingLevel = entry.thinkingLevel;
    }
  }
  return { identity, model, thinkingLevel };
}

/** message entries 重建产出（turns + 跨 entry 累积状态）。 */
interface RebuiltTurns {
  turns: Turn[];
  lastError: string | undefined;
  totalTokens: number;
  /** 最后一条 entry 的时间戳（ms），推导 endedAt（避免重建 record 耗时随墙钟无限增长）。 */
  lastEntryTsMs: number | undefined;
}

/**
 * assistant message → 填充调用方已创建的空 Turn：text/thinking 累积；toolCall block 进
 * 待匹配队列；usage → usageDelta（token 总量增量返回给调用方累加）。
 *
 * stopReason 语义（与 updateFromEvent 一致）：error/aborted → 设 lastError；
 * stop（正常结束）→ 清 lastError（镜像 turn_end 的清除语义，即前序 turn 的瞬态
 * error 在后续成功 turn 后恢复，不误判 success=false）；其余 stopReason → 保持
 * prevLastError 原值。 [v4 B-1] status 恒 closed 后 lastStopReason 不再参与推导，死变量已删。
 *
 * content 非数组 → 跳过 usage/stopReason 处理（镜像原实现的 continue）：turn 仍存在
 * （由调用方 push），lastError 透传 prevLastError、token 增量为 0。
 */
function applyAssistantMessage(
  msg: JsonlAssistantMessage,
  turn: Turn,
  pending: PendingToolCall[],
  prevLastError: string | undefined,
): { lastError: string | undefined; totalTokensDelta: number } {
  if (!Array.isArray(msg.content)) {
    return { lastError: prevLastError, totalTokensDelta: 0 };
  }
  for (const block of msg.content) {
    if (block.type === "text") {
      turn.text += block.text;
    } else if (block.type === "thinking") {
      turn.thinking += block.thinking;
    } else if (block.type === "toolCall") {
      pending.push({
        toolCallId: block.id,
        toolName: block.name,
        args: block.arguments,
        turn,
        startedTs: msg.timestamp,
      });
    }
  }

  let totalTokensDelta = 0;
  if (msg.usage) {
    const u = toAgentUsage(msg.usage);
    turn.usageDelta = addUsage(turn.usageDelta, u);
    totalTokensDelta = u.input + u.output + u.cacheRead + u.cacheWrite;
  }

  let lastError = prevLastError;
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    lastError = msg.errorMessage ?? msg.stopReason;
  } else if (msg.stopReason === "stop") {
    lastError = undefined;
  }
  return { lastError, totalTokensDelta };
}

/** toolResult message → 按 toolCallId 配对回填 InternalToolCall；未配对（孤儿）→ 丢弃。 */
function applyToolResultMessage(msg: JsonlToolResultMessage, pending: PendingToolCall[]): void {
  const idx = pending.findIndex((p) => p.toolCallId === msg.toolCallId);
  if (idx >= 0) {
    const p = pending[idx];
    pending.splice(idx, 1);
    const tc: InternalToolCall = {
      toolName: p.toolName,
      args: p.args,
      result: { content: msg.content, details: msg.details },
      isError: msg.isError ?? false,
      _status: msg.isError ? "failed" : "done",
      startedTs: p.startedTs,
    };
    p.turn.toolCalls.push(tc);
  }
}

/** 顺序遍历 entries 重建 turns[]（assistant 开 turn / toolResult 配对回填；user 跳过）。 */
function rebuildTurns(entries: JsonlEntry[]): RebuiltTurns {
  const turns: Turn[] = [];
  const pending: PendingToolCall[] = [];
  let lastError: string | undefined;
  let totalTokens = 0;
  let lastEntryTsMs: number | undefined;

  for (const entry of entries) {
    // entry 级别 timestamp（ISO）→ ms。优先用 entry 级别（每条都有），message.timestamp 作兼底。
    if (typeof entry.timestamp === "string") {
      const ms = Date.parse(entry.timestamp);
      if (!Number.isNaN(ms)) lastEntryTsMs = ms;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;
    if (typeof msg.timestamp === "number") {
      lastEntryTsMs = msg.timestamp;
    }

    if (msg.role === "assistant") {
      const turn = emptyTurn();
      turns.push(turn);
      const applied = applyAssistantMessage(msg, turn, pending, lastError);
      totalTokens += applied.totalTokensDelta;
      lastError = applied.lastError;
    } else if (msg.role === "toolResult") {
      applyToolResultMessage(msg, pending);
    }
    // role:"user" → 跳过（task 来自 identity custom entry）。
  }
  return { turns, lastError, totalTokens, lastEntryTsMs };
}

/** 组装 ReconstructedRecord（终态投影：status 恒 closed/gc + 身份字段归一化 + 派生数据）。 */
function buildReconstructedRecord(
  sessionFile: string,
  identity: SubagentIdentityData,
  rebuilt: RebuiltTurns,
  eventLog: AgentEventLogEntry[],
  model: string,
  thinkingLevel: string | undefined,
): ReconstructedRecord {
  // 终态 status：最后一条 assistant message 的 stopReason 推导（与 finalizeRecord 的判定一致）。
  // SP-1：done/failed 合并为 closed，cancelled 由 tombstone override（record-store 层），本函数不感知。
  const status: ExecutionStatus = "closed";
  // closedReason 统 gc（通用完成/失败）。error/aborted 的区分由 error 字段保留。
  const closedReason: import("./types.ts").ClosedReason = "gc";

  const turnCount = rebuilt.turns.length;
  const resultText = rebuilt.turns
    .map((t) => t.text)
    .filter((t) => t.length > 0)
    .join("\n\n");

  // rootSessionId 归一化：新文件读 rootSessionId，旧文件 fallback parentSessionId。
  const rootSessionId = identity.rootSessionId ?? identity.parentSessionId;
  // slug 兜底：旧 identity entry 无 slug 字段 → 空串（与 SubagentRecord.slug: string 契约一致）。
  const slug = identity.slug ?? "";
  // 来源域归一（H2 S3）：非法值/缺省 → undefined = "tool" 语义（守卫见 normalizeReconOrigin）。
  const origin = normalizeReconOrigin(identity.origin);
  const parentRunId = normalizeReconParentRunId(identity.parentRunId);
  return {
    ...identity,
    slug,
    rootSessionId,
    parentRecordId: identity.parentRecordId,
    depth: identity.depth ?? 0,
    forkDepth: identity.forkDepth,
    origin,
    parentRunId,
    sessionFile,
    status,
    closedReason,
    turns: rebuilt.turns,
    turnCount,
    totalTokens: rebuilt.totalTokens,
    lastError: rebuilt.lastError,
    model,
    thinkingLevel,
    endedAt: rebuilt.lastEntryTsMs,
    result: resultText.length > 0 ? resultText : undefined,
    error: rebuilt.lastError,
    eventLog,
  };
}

// ============================================================
// 公开函数
// ============================================================

/**
 * 从 session.jsonl 重建完整 SubagentRecord 数据。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
 *   ║  1. readFileSync(sessionFile) + 逐行 JSON.parse（跳 header）       ║
 *   ║     （损坏行静默跳过；失败 → undefined）                           ║
 *   ║  2. 扫 custom entry（customType:"subagent-identity"）→ 身份        ║
 *   ║     缺 identity → undefined（无法构造 record）                     ║
 *   ║  3. 顺序遍历 message entries：                                    ║
 *   ║     - role:"assistant" → 开新 Turn                                ║
 *   ║       text/thinking 累积；usage → usageDelta                      ║
 *   ║       toolCall block → 待匹配队列；stopReason error → lastError  ║
 *   ║     - role:"toolResult" → 配对 toolCallId                         ║
 *   ║       产 InternalToolCall(done/failed)推进请求 Turn              ║
 *   ║  4. 闭合所有 turn；算 turnCount/totalTokens/result/eventLog       ║
 *   ╚══════════════════════════════════════════════════════════════════╝
 *
 * 返回 undefined：文件缺失/空/损坏/缺 identity entry/无 assistant message。
 * 不抛——消费方（collectRecords）降级跳过该 record。
 *
 * status 由最后一条 assistant message 的 stopReason 推导（error/aborted → failed，
 * 其余 → done）。cancelled 由 tombstone override（record-store 层），本函数不感知。
 *
 * [perf] 本函数是重路径（全文读 + 全 entry 解析）。列表扫描用 readIdentityHeader
 * （只读头部 identity），详情才走本函数（RecordStore.getFullRecord 懒加载）。
 */
export function reconstructFromFile(sessionFile: string): ReconstructedRecord | undefined {
  // 1. 读文件 + 逐行 JSON.parse（readJsonlEntries：损坏行静默跳过；文件缺失 → undefined）。
  const entries = readJsonlEntries(sessionFile);
  if (!entries || entries.length === 0) return undefined;

  // 2. 扫身份 custom entry（scanIdentityAndModel：identity 缺失 → 无法构造 record）。
  const { identity, model, thinkingLevel } = scanIdentityAndModel(entries);
  if (!identity) return undefined; // 缺身份 → 无法构造 record。

  // 3. 重建 turns[]（rebuildTurns：assistant 开 turn / toolResult 配对回填）。
  const rebuilt = rebuildTurns(entries);
  if (rebuilt.turns.length === 0) return undefined; // 无 assistant message → 空壳，降级。

  // 4. 闭合所有 turn（重建的是历史，全是已完成 turn）。
  for (const turn of rebuilt.turns) {
    turn.closed = true;
  }

  // eventLog 从 turns[] 派生（与活态 record 的 getEventLog 同形，消费方无感知差异）。
  // 必须在闭合 turn 之后派生（deriveEventLog 读 turn.closed）。
  const eventLog = deriveEventLog(rebuilt.turns, rebuilt.lastError, identity.startedAt);

  return buildReconstructedRecord(sessionFile, identity, rebuilt, eventLog, model, thinkingLevel);
}

// ============================================================
// 轻量头部读取（列表扫描用）
// ============================================================

/** 头部读取字节数。首轮会话 identity 在第 2-3 行；但续聊（resume）场景 session_start
 *  再次触发，identity append 到文件尾部附近（实测真实目录 1186/1744 文件的 identity
 *  不在头 64KB）。头部 miss 时由 RecordStore.scanFile 调 readIdentityAnywhere 全文 fallback。 */
export const IDENTITY_HEAD_BYTES = 65536;

/** 轻量重建产出：仅身份字段 + 头部可见的 model/thinkingLevel（详情字段一律缺省）。 */
export interface IdentityHeaderRecon {
  id: string;
  agent: string;
  mode: ExecutionMode;
  task: string;
  slug: string;
  startedAt: number;
  rootSessionId: string | undefined;
  parentRecordId: string | undefined;
  depth: number;
  forkDepth: number | undefined;
  chatMode?: boolean;
  /** [review round2] worktree 隔离标志（见 SubagentIdentityData.worktree）。 */
  worktree?: boolean;
  /** 来源身份（H2 S3 修复，守卫归一后；缺省 undefined = "tool" 语义）。light 列表投影用。 */
  origin: RecordOrigin | undefined;
  /** origin="workflow" 时所属 workflow run id（守卫归一后；缺省 undefined）。 */
  parentRunId: string | undefined;
  model: string;
  thinkingLevel: string | undefined;
  sessionFile: string;
}

/**
 * 只读文件头部，解析 identity custom entry（+途经的 model/thinking_level change）。
 *
 * 列表扫描专用：单次 readSync 读头部 IDENTITY_HEAD_BYTES 字节，逐行解析到 identity
 * 即停。不解析 message entries（turns/eventLog/result 等重数据由
 * RecordStore.getFullRecord 懒加载 reconstructFromFile 补齐）。
 *
 * 与 reconstructFromFile 的行为差异（有意）：本函数只要头部有 identity 就返回，
 * 不要求存在 assistant message——pi 延迟写入策略下无 assistant 的文件几乎不存在，
 * 若存在（崩溃前 flush）也按分支 4 running 呈现（v4 B-1 可续聊语义），
 * 而非静默不可见。
 *
 * 返回 undefined：文件缺失/读失败/头部无 identity。不抛。
 * 头部无 identity ≠ 文件无 identity（续聊场景 identity 在尾部附近）——需要覆盖全文件
 * 时用 readIdentityAnywhere。
 */
export function readIdentityHeader(sessionFile: string): IdentityHeaderRecon | undefined {
  let text: string;
  try {
    const fd = fs.openSync(sessionFile, "r");
    try {
      const buf = Buffer.alloc(IDENTITY_HEAD_BYTES);
      let total = 0;
      while (total < buf.length) {
        const n = fs.readSync(fd, buf, total, buf.length - total, total);
        if (n <= 0) break;
        total += n;
      }
      text = buf.toString("utf-8", 0, total);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined; // 文件缺失/不可读 → 降级跳过
  }
  return parseIdentityFromText(text, sessionFile);
}

/**
 * 全文件找 identity：头部/尾部都 miss 后的最后 fallback（真实数据仅 ~0.2% 走到）。
 *
 * 全量 readFileSync + indexOf 预筛（只有含特征串的行才 JSON.parse），从后往前找
 * （续聊轮次的 identity 靠尾部，最后一次的 identity 最新鲜）。读全文是成本主体
 * （预筛/parse 可忽略）——调用方（RecordStore）应缓存结果避免重复读。
 */
export function readIdentityAnywhere(sessionFile: string): IdentityHeaderRecon | undefined {
  let text: string;
  try {
    text = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i];
    if (!s.includes(IDENTITY_CUSTOM_TYPE)) continue; // 预筛：identity 行必含特征串
    const recon = parseIdentityFromText(s, sessionFile);
    if (recon) return recon;
  }
  return undefined;
}

/**
 * 只读文件尾部找 identity（续聊场景主力命中点：最后一轮 session_start 追加的
 * identity 离文件尾近，实测真实目录 65% 文件 identity 在尾 64KB）。
 *
 * 尾部块首行可能残缺（从行中间开始）——JSON.parse 失败自然跳过，不影响后续行。
 * model/thinking_level 在尾部块中拿不到 identity 之前的途经 entry，返回空/undefined
 * （best-effort，详情场景由全量重建补齐）。
 */
export function readIdentityTail(sessionFile: string): IdentityHeaderRecon | undefined {
  let text: string;
  try {
    const { size } = fs.statSync(sessionFile);
    const start = Math.max(0, size - IDENTITY_HEAD_BYTES);
    const fd = fs.openSync(sessionFile, "r");
    try {
      const buf = Buffer.alloc(size - start);
      let total = 0;
      while (total < buf.length) {
        const n = fs.readSync(fd, buf, total, buf.length - total, start + total);
        if (n <= 0) break;
        total += n;
      }
      text = buf.toString("utf-8", 0, total);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i];
    if (!s.includes(IDENTITY_CUSTOM_TYPE)) continue;
    const recon = parseIdentityFromText(s, sessionFile);
    if (recon) return recon;
  }
  return undefined;
}

// ============================================================
// 轻量 identity 扫描内部 helper（parseIdentityFromText 按阶段分发）
// ============================================================

/**
 * 预筛（[S-4] 同款值匹配）：只有含三种目标 entry 值串的行才值得 JSON.parse——
 * head 64KB 内大 toolResult 行（数十 KB/行）占多数，全量 parse 是冷扫描 CPU 大头。
 * 值字符串在任意序列化格式下连续出现，不耦合 pi 的空格习惯。
 */
function lineMayCarryScannableEntry(s: string): boolean {
  return (
    s.includes(IDENTITY_CUSTOM_TYPE) ||
    s.includes('"model_change"') ||
    s.includes('"thinking_level_change"')
  );
}

/** 轻量扫描的可变累积态（identity + 途经 model/thinkingLevel）。 */
interface LightIdentityScan {
  identity: SubagentIdentityData | undefined;
  model: string;
  thinkingLevel: string | undefined;
}

/**
 * 单条 entry 并入扫描态。identity 命中（custom + customType 匹配 + data 合法）返回
 * true 供调用方 break（找到即停，后续行不再解析）；其余恒 false。三个目标 type 互斥，
 * 与原 if/else-if 链语义一致；custom 但 data 非法 → 不并入、不中断扫描。
 */
function absorbScannedEntry(state: LightIdentityScan, entry: JsonlEntry): boolean {
  if (entry.type === "custom" && entry.customType === IDENTITY_CUSTOM_TYPE) {
    if (isIdentityData(entry.data)) {
      state.identity = entry.data;
      return true;
    }
    return false;
  }
  if (entry.type === "model_change") {
    // model_change: {provider, modelId} → "provider/modelId"（与 record.model 同形）。
    if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
      state.model = `${entry.provider}/${entry.modelId}`;
    }
    return false;
  }
  if (entry.type === "thinking_level_change") {
    if (typeof entry.thinkingLevel === "string") state.thinkingLevel = entry.thinkingLevel;
  }
  return false;
}

/** 扫描态 → IdentityHeaderRecon（归一化与全量 recon 同源：rootSessionId fallback 旧字段、slug 兜底空串、origin/parentRunId 守卫归一）。 */
function toIdentityRecon(
  state: LightIdentityScan,
  identity: SubagentIdentityData,
  sessionFile: string,
): IdentityHeaderRecon {
  const rootSessionId = identity.rootSessionId ?? identity.parentSessionId;
  return {
    id: identity.id,
    agent: identity.agent,
    mode: identity.mode,
    task: identity.task,
    slug: identity.slug ?? "",
    startedAt: identity.startedAt,
    rootSessionId,
    parentRecordId: identity.parentRecordId,
    depth: identity.depth ?? 0,
    forkDepth: identity.forkDepth,
    chatMode: identity.chatMode,
    worktree: identity.worktree,
    origin: normalizeReconOrigin(identity.origin),
    parentRunId: normalizeReconParentRunId(identity.parentRunId),
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    sessionFile,
  };
}

/** 从文本片段解析 identity（头部/全文两入口共享）。解析到 identity 即停（返回）；
 *  找不到返回 undefined。model/thinking_level 仅在 identity 之前的途经 entry 中
 *  best-effort 提取，详情场景由全量重建补齐。 */
function parseIdentityFromText(text: string, sessionFile: string): IdentityHeaderRecon | undefined {
  const state: LightIdentityScan = { identity: undefined, model: "", thinkingLevel: undefined };
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    if (!lineMayCarryScannableEntry(s)) continue;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(s) as JsonlEntry;
    } catch {
      continue; // 损坏行/截断行（头部读取边界）跳过
    }
    if (absorbScannedEntry(state, entry)) break; // 找到即停（后续行不再解析）
  }
  if (!state.identity) return undefined;
  return toIdentityRecon(state, state.identity, sessionFile);
}
