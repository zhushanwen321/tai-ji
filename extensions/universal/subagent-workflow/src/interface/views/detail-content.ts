/**
 * L2 详情内容构建 + 滚动按键处理（纯函数）。
 *
 * 从 WorkflowsView.ts 抽出，目的：
 *   1. 把 WorkflowsView.ts 控制在 1000 行以内（行数检查 hook）
 *   2. buildDetailContent / detailContentLength / processDetailKey 为导出纯函数，
 *      无 Pi runtime 依赖，可直接单测（对齐 subagents list-view 的 processKey 模式）
 *
 * 单一数据源：renderLevel2 渲染与 detailContentLength 算行数都走 buildDetailContent，
 * 避免两者发散（对齐 subagents buildDetailContent / detailContentLength）。
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";

import { computeElapsedSeconds } from "@zhushanwen/subagent-core";
import type { AgentEventLogEntry } from "@zhushanwen/subagent-core";
import type { SubagentRecord } from "@zhushanwen/subagent-core";
import type { ExecutionTraceNode } from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import {
  ELLIPSIS,
  formatActivityLine,
  formatElapsed,
  formatElapsedSeconds,
  formatTokenStat,
  formatTraceEventLine,
  statusDotStr,
  type ThemeLike,
} from "../format.ts";
import { PAGE_SCROLL_DEFAULT } from "../tui-kit.ts";
import {
  BOX_BORDER_CHARS,
  BUDGET_TOKENS_DIVISOR,
  MAX_TOOL_CALLS_DISPLAY,
  OUTPUT_TRUNCATE_BYTES,
  PROMPT_FOLD_LINES,
} from "./view-constants.ts";

// ── 共享常量（BOX_BORDER_CHARS / BUDGET_TOKENS_DIVISOR / MAX_TOOL_CALLS_DISPLAY 等）
//    落位 ./view-constants.ts（post-convergence C4：views 专属常量自 format.ts 沉回 views/）──

/** 探测宽度：足够大避免截断折行影响行数统计（对齐 subagents DETAIL_LEN_PROBE_WIDTH）。 */
const DETAIL_LEN_PROBE_WIDTH = 9999;

// ── [H2 W3] store record 的 live 进度投影（设计 D2：进度源从 node.live 切 store）──

/**
 * running record 的实时进度投影——消费面七字段口径与旧 projectLiveProgress(node.live)
 * 逐字段对齐（totalTokens / 工具计数 / elapsedSeconds / turns / eventLog /
 * currentActivity / lastError）。
 */
export interface LiveProgressView {
  totalTokens: number;
  toolCallCount: number;
  elapsedSeconds: number;
  turns: number;
  eventLog: AgentEventLogEntry[];
  currentActivity?: { type: "tool" | "text" | "thinking"; label: string };
  lastError?: string;
}

/**
 * SubagentRecord（store 查询投影）→ LiveProgressView。与旧路径
 * projectLiveProgress(node.live) 的字段等价性（构造性论证，S1 等价表依据）：
 *   - totalTokens / turns：recordToSubagent 直读 record.totalTokens / turnCount，同源；
 *   - toolCallCount：eventLog 里 tool_start 计数——getEventLog 对每个 toolCall 恰产
 *     一条 tool_start，与 getAllToolCalls(record).length 恒等；
 *   - elapsedSeconds：computeElapsedSeconds 同一函数（startedAt/endedAt 同字段）；
 *   - eventLog / currentActivity：recordToSubagent 内部即调 getEventLog /
 *     getCurrentActivity（同源 API，仅内存 running record 有 currentActivity）；
 *   - lastError：eventLog 末条 type==="error" 的 label——getEventLog 仅当
 *     record.lastError 非空时追加该条且必在末尾，存在性 ⟺ 非空，label 即原文。
 */
export function projectRecordProgress(rec: SubagentRecord): LiveProgressView {
  const eventLog = rec.eventLog;
  const last = eventLog[eventLog.length - 1];
  return {
    totalTokens: rec.totalTokens,
    toolCallCount: eventLog.filter((e) => e.type === "tool_start").length,
    elapsedSeconds: computeElapsedSeconds(rec),
    turns: rec.turns,
    eventLog,
    currentActivity: rec.currentActivity,
    lastError: last !== undefined && last.type === "error" ? last.label : undefined,
  };
}

/** status → 语义色标签（L2 detail 头用）。 */
export function statusLabel(status: string, theme: ThemeLike): string {
  switch (status) {
    case "completed": return theme.fg("success", status);
    case "running": return theme.fg("warning", status);
    case "failed": return theme.fg("error", status);
    default: return theme.fg("muted", status);
  }
}

// ── L2 详情内容构建（单一数据源）──────────────────────────────────

/**
 * 构建 L2 右侧详情的完整内容行。
 *
 * 纯函数：无 Pi runtime、无副作用，可单测。入参 promptExpanded 用结构化类型，
 * 不依赖完整 ViewState（便于测试构造）。liveView = 该节点配对的 running record 投影
 * （[H2 W3] 从 trace.live 切 store 订阅，经 WorkflowsView.collectNodeLiveProgress
 * 配对注入；缺省走终态 result 路径）。
 */
export function buildDetailContent(
  node: ExecutionTraceNode,
  state: { promptExpanded: boolean },
  run: WorkflowRun,
  theme: ThemeLike,
  mainWidth: number,
  now: number,
  liveView?: LiveProgressView,
): string[] {
  const rightLines: string[] = [];
  const elapsed = formatElapsed(
    node.startedAt,
    node.completedAt ? new Date(node.completedAt).getTime() : now,
  );
  rightLines.push(theme.fg("muted", "Detail"));
  rightLines.push("─".repeat(mainWidth));
  rightLines.push(`${statusDotStr(node.status, theme)} ${statusLabel(node.status, theme)} · ${node.model}`);
  // Live 路径优先：运行中用 store record 投影的实时 usage/toolCalls/elapsed；否则用终态 result。
  if (liveView) {
    const tokK = liveView.totalTokens > 0 ? `${Math.round(liveView.totalTokens / BUDGET_TOKENS_DIVISOR)}k tok` : "0 tok";
    rightLines.push(theme.fg("dim", `${tokK} · ${liveView.toolCallCount} tool calls · ${formatElapsedSeconds(liveView.elapsedSeconds)}`));
  } else {
    rightLines.push(theme.fg("dim", formatTokenStat(node.result?.usage, node.result?.toolCalls, elapsed)));
  }
  rightLines.push("");
  renderWorkerLogSection(rightLines, run, mainWidth, theme);
  renderPromptSection(rightLines, node, state, theme);
  renderActivitySection(rightLines, node, liveView, mainWidth, theme);
  renderOutcomeSection(rightLines, node, liveView, mainWidth, theme);
  renderSessionSection(rightLines, node, mainWidth, theme);
  return rightLines;
}

/** L2 详情内容总行数（供 processDetailKey 算 max，不重复生成内容）。 */
export function detailContentLength(
  node: ExecutionTraceNode,
  state: { promptExpanded: boolean },
  run: WorkflowRun,
  theme: ThemeLike,
  live?: LiveProgressView,
): number {
  return buildDetailContent(node, state, run, theme, DETAIL_LEN_PROBE_WIDTH, Date.now(), live).length;
}

// ── L2 详情滚动按键（纯函数，对齐 subagents processKey）─────────

/** 详情翻屏上下文：视口高 + 内容总行数 + 是否 running（驱动 followTail）。 */
export interface DetailScrollContext {
  /** 右侧 detail 可见行数（render 的 viewH，单一数据源）。 */
  viewportHeight: number;
  /** buildDetailContent 总行数。 */
  contentLines: number;
  /** node.status === "running"（决定 followTail 语义）。 */
  isRunning: boolean;
}

/** 滚动按键处理结果（纯数据，调用方回写 state）。 */
export interface DetailKeyResult {
  /** 新的滚动 offset（已 clamp 到 [0, max]）。 */
  scrollOffset: number;
  /** 是否继续"钉底部"（running 态自动跟随最新输出）。 */
  followTail: boolean;
  /** 是否命中滚动键（false → 调用方回退到 up/down/enter 等现有逻辑）。 */
  handled: boolean;
}

/**
 * 处理 L2 详情滚动按键（PgUp/PgDn/Home/End）。
 *
 *   - PgUp  → offset -= viewportHeight，followTail=false（用户主动上滚，停止跟随）
 *   - PgDn  → offset += viewportHeight；到底则 followTail=true
 *   - Home  → offset=0，followTail=false
 *   - End   → offset=max，followTail=true
 *   - 其他  → handled=false（交回 handleInput 现有逻辑）
 *
 * max = max(0, contentLines - viewportHeight)。纯函数：入参 data + state + ctx，
 * 无副作用、无 Pi 依赖，可直接单测（对齐 subagents processKey）。
 */
export function processDetailKey(
  data: string,
  state: { scrollOffset: number; followTail: boolean },
  ctx: DetailScrollContext,
): DetailKeyResult {
  const viewH = Math.max(1, ctx.viewportHeight);
  const max = Math.max(0, ctx.contentLines - viewH);
  const off = state.scrollOffset;

  if (matchesKey(data, Key.pageUp)) {
    const step = ctx.viewportHeight > 0 ? ctx.viewportHeight : PAGE_SCROLL_DEFAULT;
    return { scrollOffset: Math.max(0, off - step), followTail: false, handled: true };
  }
  if (matchesKey(data, Key.pageDown)) {
    const step = ctx.viewportHeight > 0 ? ctx.viewportHeight : PAGE_SCROLL_DEFAULT;
    const next = Math.min(max, off + step);
    // 到底恢复跟随（用户 PgDn 翻到底 = 想看最新）
    return { scrollOffset: next, followTail: next >= max, handled: true };
  }
  if (matchesKey(data, Key.home)) {
    return { scrollOffset: 0, followTail: false, handled: true };
  }
  if (matchesKey(data, Key.end)) {
    return { scrollOffset: max, followTail: true, handled: true };
  }
  return { scrollOffset: off, followTail: state.followTail, handled: false };
}

// ── L2 详情区段渲染（buildDetailContent 调用）─────────────────────

function renderWorkerLogSection(
  rightLines: string[],
  run: WorkflowRun,
  mainWidth: number,
  theme: ThemeLike,
): void {
  const logs = run.state.errorLogs;
  if (!logs || logs.length === 0) return;
  const total = logs.length;
  const WORKER_LOG_SHOW = 20;
  const showCount = Math.min(total, WORKER_LOG_SHOW);
  const label = total > showCount
    ? `Worker diagnostics · last ${showCount} of ${total}`
    : `Worker diagnostics · ${total} entr${total !== 1 ? "ies" : "y"}`;
  rightLines.push(theme.fg("warning", label));
  const start = total - showCount;
  for (let i = start; i < total; i++) {
    const entry = logs[i];
    const levelToken = entry.level === "error" ? "error" : entry.level === "warn" ? "warning" : "muted";
    const prefix = `[${entry.level}]`;
    const line = `  ${prefix} ${entry.message}`.slice(0, mainWidth - BOX_BORDER_CHARS);
    rightLines.push(theme.fg(levelToken, line));
  }
  rightLines.push("");
}

function renderPromptSection(
  rightLines: string[],
  node: ExecutionTraceNode,
  state: { promptExpanded: boolean },
  theme: ThemeLike,
): void {
  const taskLines = node.task.split("\n");
  const lineCount = taskLines.length;
  rightLines.push(theme.fg("muted", `Prompt · ${lineCount} lines · ⏎ ${state.promptExpanded ? "collapse" : "expand"}`));
  if (state.promptExpanded || lineCount <= PROMPT_FOLD_LINES) {
    rightLines.push(...taskLines.map((l) => `  ${l}`));
  } else {
    rightLines.push(...taskLines.slice(0, PROMPT_FOLD_LINES).map((l) => `  ${l}`));
    rightLines.push(theme.fg("dim", `  ${ELLIPSIS} ${lineCount - PROMPT_FOLD_LINES} more lines`));
  }
  rightLines.push("");
}

function renderActivitySection(
  rightLines: string[],
  node: ExecutionTraceNode,
  liveView: LiveProgressView | undefined,
  mainWidth: number,
  theme: ThemeLike,
): void {
  // Live 路径：agent 运行中，从 store record 投影派生实时 eventLog + currentActivity。
  // 与 subagents TUI 一致：当前活动行 + 最近 N 条离散事件（tool/turn_end/error）。
  if (liveView) {
    const eventLog = liveView.eventLog.filter((e) => e.type !== "turn_end");
    const totalCount = liveView.toolCallCount;
    const label = `Activity · ${totalCount} tool call${totalCount !== 1 ? "s" : ""} · ${liveView.turns} turn${liveView.turns !== 1 ? "s" : ""}`;
    rightLines.push(theme.fg("muted", label));
    // 当前活动行（running tool / thinking / text）
    if (liveView.currentActivity) {
      rightLines.push(theme.fg("accent", `  ⎿ ${liveView.currentActivity.type}: ${liveView.currentActivity.label}`.slice(0, mainWidth - BOX_BORDER_CHARS)));
    }
    // 最近 N 条事件
    const showCount = Math.min(MAX_TOOL_CALLS_DISPLAY, eventLog.length);
    const start = eventLog.length - showCount;
    for (let i = start; i < eventLog.length; i++) {
      const entry = eventLog[i] as AgentEventLogEntry;
      rightLines.push(theme.fg("dim", `  ${formatTraceEventLine(entry, theme)}`.slice(0, mainWidth - BOX_BORDER_CHARS)));
    }
    if (totalCount === 0 && !liveView.currentActivity) {
      rightLines.push(theme.fg("dim", "  (starting...)"));
    }
    rightLines.push("");
    return;
  }

  // 终态路径：从 node.result.toolCalls 读（原有逻辑）
  const toolCalls = node.result?.toolCalls ?? [];
  const totalCount = toolCalls.length;
  if (totalCount > 0) {
    const showCount = Math.min(MAX_TOOL_CALLS_DISPLAY, totalCount);
    const isTruncated = totalCount > MAX_TOOL_CALLS_DISPLAY;
    const label = isTruncated
      ? `Activity · last ${showCount} of ${totalCount} tool calls`
      : `Activity · ${totalCount} tool call${totalCount !== 1 ? "s" : ""}`;
    rightLines.push(theme.fg("muted", label));
    const start = totalCount - showCount;
    for (let i = start; i < totalCount; i++) {
      rightLines.push(`  ${formatActivityLine(toolCalls[i], mainWidth - BOX_BORDER_CHARS)}`);
    }
  } else {
    rightLines.push(theme.fg("muted", "Activity"));
    rightLines.push(theme.fg("dim", `  ${node.status === "running" ? "(no tool calls yet)" : "(no activity recorded)"}`));
  }
  rightLines.push("");
}

function renderOutcomeSection(
  rightLines: string[],
  node: ExecutionTraceNode,
  liveView: LiveProgressView | undefined,
  mainWidth: number,
  theme: ThemeLike,
): void {
  rightLines.push(theme.fg("muted", "Outcome"));
  if (node.status === "running" && liveView) {
    // 运行中：显示实时指标（elapsed/tokens/turns）替代空荡的 "Still running..."
    const tokK = liveView.totalTokens > 0 ? `${Math.round(liveView.totalTokens / BUDGET_TOKENS_DIVISOR)}k tok` : "0 tok";
    rightLines.push(theme.fg("dim", `  Running · ${formatElapsedSeconds(liveView.elapsedSeconds)} · ${tokK} · ${liveView.turns} turn${liveView.turns !== 1 ? "s" : ""}`));
    if (liveView.lastError) {
      rightLines.push(theme.fg("warning", `  ⚠ ${liveView.lastError.slice(0, mainWidth - BOX_BORDER_CHARS)}`));
    }
  } else if (node.status === "running") {
    rightLines.push(theme.fg("dim", "  Still running..."));
  } else if (node.result?.error) {
    rightLines.push(theme.fg("error", `  ${node.result.error.slice(0, mainWidth - BOX_BORDER_CHARS)}`));
  } else if (node.result?.content) {
    const raw = node.result.content;
    const OUTCOME_TAIL_LINES = 5;
    if (Buffer.byteLength(raw, "utf8") > OUTPUT_TRUNCATE_BYTES) {
      const truncated = Buffer.from(raw, "utf8").slice(0, OUTPUT_TRUNCATE_BYTES).toString("utf8");
      const allLines = truncated.split("\n");
      const tail = allLines.slice(-OUTCOME_TAIL_LINES);
      rightLines.push(...tail.map((l) => `  ${l.slice(0, mainWidth - BOX_BORDER_CHARS)}`));
      rightLines.push(theme.fg("dim", "  (truncated)"));
    } else {
      const allLines = raw.split("\n");
      const tail = allLines.slice(-OUTCOME_TAIL_LINES);
      rightLines.push(...tail.map((l) => `  ${l.slice(0, mainWidth - BOX_BORDER_CHARS)}`));
    }
  }
}

/**
 * 渲染 session jsonl 路径行（agent 级）。
 *
 * 对齐 subagents list-component 的 `session:` 行渲染（dim 色 + 截断）。
 * sessionFile 是绝对路径，可能很长——截断到 mainWidth 防溢出。
 * 窗口期（session 尚未创建）sessionFile 为 undefined，整段不渲染。
 */
function renderSessionSection(
  rightLines: string[],
  node: ExecutionTraceNode,
  mainWidth: number,
  theme: ThemeLike,
): void {
  if (!node.sessionFile) return;
  rightLines.push("");
  const line = `session: ${node.sessionFile}`.slice(0, mainWidth - BOX_BORDER_CHARS);
  rightLines.push(theme.fg("dim", `  ${line}`));
}
