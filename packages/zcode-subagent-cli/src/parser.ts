// src/execution/engine/engines/zcode/parser.ts
//
// ZcodeEngine usage 映射与 coarse 事件件（2026-09 收缩）：CLI stdout 有界收集/
// 终 JSON 解析/buildRunFailedMessage 随 spawn 链删除（app-server 路径的终态来自
// session-channel 的 read 兜底帧，不经 stdout 解析）。保留件：
//   - ZcodeRawUsage / mapZcodeUsage / mapZcodeOutcomeUsage：原生 usage 形状 →
//     事件层（execution）与终态层（orchestration）AgentUsage（spawn 时代实测形状，
//     app-server 收尾帧 usage 同形——session-channel 消费）；
//   - ZcodeTerminalPayload：app-server 轮成功态的载荷形态（turnResultToPayload 组装）；
//   - synthesizeCoarseEvents：终态合成最小事件序列（不变量：turn_end 最后、其前
//     至少一个 message_end）。
//
// 事件产出不变量（设计 §3.3.7，coarse 口径）：turn_end 前至少一个 message_end；
// message_end.usage 出现时为完整 AgentUsage 形状（缺数据给显式 0，不给残缺对象）。

import type {
  AgentEvent,
  AgentUsage as ExecutionAgentUsage,
  AgentOutcomeUsage as OutcomeAgentUsage,
} from "@zhushanwen/subagent-engine-sdk";

// ============================================================
// usage 映射（含运行时 guard——禁 any）
// ============================================================

/** 原生 usage 形状（2026-08-25 实测 0.16.5，字段名带 Tokens 后缀；app-server 收尾帧同形）。 */
export interface ZcodeRawUsage {
  source?: unknown;
  modelRequestCount?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  reasoningTokens?: unknown;
}

function finiteOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 原生 usage → 事件层 AgentUsage（execution 版：四项 token；cost 无来源缺省）。 */
export function mapZcodeUsage(raw: unknown): ExecutionAgentUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as ZcodeRawUsage;
  if (r.inputTokens === undefined && r.outputTokens === undefined) return undefined;
  return {
    input: finiteOr(r.inputTokens, 0),
    output: finiteOr(r.outputTokens, 0),
    cacheRead: finiteOr(r.cacheReadTokens, 0),
    cacheWrite: finiteOr(r.cacheWriteTokens, 0),
  };
}

/**
 * 原生 usage + projection → 终态层 AgentUsage（orchestration 版：cost/contextTokens/
 * turns 为必填）。zcode 不回传 cost（调研附录 A「cost 回传 ❌」）——显式 0（消费方按
 * 「显示降级」处理，不给残缺）；contextTokens 取 projection.contextUsed（当前上下文
 * 占用），turns 取 projection.turnCount。
 */
export function mapZcodeOutcomeUsage(rawUsage: unknown, projection: unknown): OutcomeAgentUsage | undefined {
  const base = mapZcodeUsage(rawUsage);
  if (base === undefined) return undefined;
  const p =
    typeof projection === "object" && projection !== null ? (projection as Record<string, unknown>) : {};
  const r = typeof rawUsage === "object" && rawUsage !== null ? (rawUsage as ZcodeRawUsage) : {};
  const contextTokens = firstFinite(p["contextUsed"], r.totalTokens, 0);
  const turns = firstFinite(p["turnCount"], 1);
  return { ...base, cost: 0, contextTokens, turns };
}

function firstFinite(...vals: unknown[]): number {
  for (const v of vals) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** 轮成功态的载荷形态（app-server 路径由 turnResultToPayload 组装：response 必 string）。 */
export interface ZcodeTerminalPayload {
  sessionId?: string;
  response: string;
  /** 事件层 usage（execution 版 AgentUsage——message_end 合成用）。 */
  usage?: ExecutionAgentUsage;
  /** 终态层 usage（orchestration 版 AgentUsage——AgentOutcome.usage 用）。 */
  outcomeUsage?: OutcomeAgentUsage;
  /** projection.turnCount（gui/record 的轮数参考；解析不出则缺省）。 */
  turnCount?: number;
}

// ============================================================
// coarse 事件合成（不变量：turn_end 最后、其前至少一个 message_end）
// ============================================================

/** 终态成功时合成的最小事件序列（coarse 引擎只有终态级信息——设计 D3 eventGranularity）。 */
export function synthesizeCoarseEvents(response: string, usage?: ExecutionAgentUsage): AgentEvent[] {
  return [
    // usage 给不出完整形状时显式缺省整个字段，不给残缺对象（不变量 2）
    { type: "message_end", ...(usage !== undefined ? { usage } : {}) },
    { type: "turn_end" },
  ] as AgentEvent[];
}
