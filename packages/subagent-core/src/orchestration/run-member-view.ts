// src/orchestration/run-member-view.ts
//
// run 成员视图纯函数（subagent-tool-interface-refactor 设计 §3.1.3 / §3.3.3 / §3.4）。
//
// 权威源声明（§3.3.3）：record 事件流是唯一事实源；trace 是主线程 fold 出的派生视图
// （本函数消费 run.state.trace 作 record 缺席时的兜底行来源）。本函数与 runSummary
// 同性质：零 IO、时钟显式传入（now 参数）、可单测；不 import execution/assembly 域
// ——records 由调用方注入最小 record 视图（RunMemberRecordView，字段名与
// execution/assembly/types.ts 的 SubagentRecord 实装逐字段对齐），GUI 派生视图零改动。
//
// 合并总规则（§3.1.3）：record 优先，record 不可用时 trace 兜底；未知一律缺省，
// 不写 0。合并后每 stepIndex 至多一行。

import { TRACE_RESULT_MAX_CHARS } from "./models/trace.ts";
import type { ExecutionTraceNode } from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";

// ── 类型契约 ──────────────────────────────────────────────────

/**
 * 成员四态词表（设计 §3.1.3；不设 unknown——run 正常终局前 closeOutInFlightCalls
 * 把在途 call 写成 failed + 取消文案，resume 同 stepIndex 重复 record 由去重规则取
 * 当前尝试，旧尝试不会以终局形态冒充新尝试）。
 */
export type MemberState = "running" | "completed" | "failed" | "cancelled";

/**
 * eventLog 条目的最小消费视图（本函数不 import execution/assembly 域——设计 §3.3.3）。
 * 结构对齐 execution/assembly/types.ts 的 AgentEventLogEntry（type 收窄为 string：
 * 本函数只判 `type === "error"`，多余字面量约束不属消费面）。
 */
export interface RunMemberEventView { // oe-exempt:20261022:framework:设计 §3.4 注入视图契约（本文件不 import execution/assembly 域的结构边界），eventLog 条目最小消费视图
  readonly type: string;
  readonly label: string;
}

/**
 * 成员 record 的最小消费视图（调用方注入；字段名与 execution/assembly/types.ts 的
 * SubagentRecord 实装逐字段对齐——SubagentRecord 结构性满足本接口，工具层把
 * collectRecordsByParentRunId 的返回值直接传入即可）。
 */
export interface RunMemberRecordView { // oe-exempt:20261022:framework:设计 §3.4 注入视图契约（本文件不 import execution/assembly 域的结构边界），SubagentRecord 结构性满足
  /** run 内步骤索引；undefined（存量 record / tool 来源）不参与 run 视图关联，不成行。 */
  readonly stepIndex?: number;
  /** record 状态机两态（"running" | "idle"）；终局语义由 outcome 承载。 */
  readonly status: "running" | "idle";
  /** 终局三态对外语义；undefined = 从未收尾 / 存量数据。 */
  readonly outcome?: "completed" | "failed" | "cancelled";
  /** 墙钟毫秒（Date.now() 口径，与 SubagentRecord.startedAt 同源）。 */
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly agent: string;
  /** 用户显式指定的模型；undefined = 未指定（引擎自身缺省解析）。 */
  readonly model?: string;
  readonly turns?: number;
  readonly error?: string;
  readonly eventLog?: readonly RunMemberEventView[];
  readonly currentActivity?: { readonly type: "tool" | "text" | "thinking"; readonly label: string };
}

/** 单成员行（8 字段，设计 §3.1.3 的 RunMemberView）。 */
export interface RunMemberView { // oe-exempt:20261022:framework:设计 §3.1.3 对外契约类型（A 级决策 §3.3.3），工具层跨包消费，接口先立单实现常态
  /** 批量 = tasks 下标；脚本 = agent() 调用序。 */
  stepIndex: number;
  state: MemberState;
  /** 执行者短名：record.agent 优先；缺省回落 trace 标签（fan-out-<i>）。 */
  agent: string;
  /**
   * 用户显式指定的模型（record.model）；未指定时为请求缺省标记 "default"（trace）。
   * 注意：这不是引擎实际解析的生效模型（frontmatter/缺省解析结果不在任一字段里）。
   */
  model: string;
  /** 终局 = 结束-开始（record 时间字段优先，兜底 trace startedAt/completedAt）；运行中 = now-startedAt。 */
  durationMs?: number;
  /** 终局：record.error ?? trace.result.error ?? trace.error；运行中：eventLog 最后一条 type:"error" 的 label。 */
  lastError?: string;
  /** record.turns ?? trace.result.usage?.turns（trace 的 result 无 turns 字段、usage 无 total——禁止引用）。 */
  turns?: number;
  /** 仅运行中：record 派生（如 "tool: bash"）。 */
  currentActivity?: string;
}

// ── 单行派生 ──────────────────────────────────────────────────

/**
 * eventLog 中最后一条 type:"error" 的 label（设计 §3.4 的单行派生，运行中行
 * lastError 的唯一来源）；无 error 条目 / eventLog 缺席 = undefined（缺省不写词）。
 */
export function lastErrorOf(eventLog: readonly RunMemberEventView[] | undefined): string | undefined {
  if (eventLog === undefined) return undefined;
  for (let i = eventLog.length - 1; i >= 0; i--) {
    const entry = eventLog[i];
    if (entry !== undefined && entry.type === "error") return entry.label;
  }
  return undefined;
}

// ── 主函数 ────────────────────────────────────────────────────

/**
 * WorkflowRun → 成员表（每 stepIndex 一行，按 stepIndex 升序——渲染输入序，设计 §3.1.3）。
 *
 * @param run 聚合根（活体或重建均可；只读 run.state.trace 作兜底行来源）
 * @param options.records 工具层注入的 record 列表（collectRecordsByParentRunId 返回值
 *   结构性满足）；undefined = record 查询不可用（service 缺席、跨进程读失败）——
 *   全部成员行走 trace 兜底折行，不抛错、不隐藏成员行（§3.1.3 trace 兜底）
 * @param options.now 当前墙钟毫秒（运行中行耗时 = now - startedAt；显式传入，测试可控）
 */
export function runMemberViews(
  run: WorkflowRun,
  options: { records?: readonly RunMemberRecordView[]; now: number },
): RunMemberView[] {
  const traceNodes = traceNodeByIndex(run);
  const recordRows = currentAttemptByStepIndex(options.records);

  const rows = new Map<number, RunMemberView>();
  // record 行优先：同 stepIndex 的 trace 兜底行被覆盖（合并后每 stepIndex 至多一行）。
  for (const [stepIndex, record] of recordRows) {
    rows.set(stepIndex, memberViewFromRecord(stepIndex, record, traceNodes.get(stepIndex), options.now));
  }
  for (const [stepIndex, node] of traceNodes) {
    if (rows.has(stepIndex)) continue;
    rows.set(stepIndex, memberViewFromTraceNode(node, options.now));
  }
  return [...rows.values()].sort((a, b) => a.stepIndex - b.stepIndex);
}

// ── 拆分 helper ───────────────────────────────────────────────

/**
 * trace 节点按 stepIndex 倒排（遍历顺序 last-wins——与 Trace.byIndex 的重复
 * stepIndex 语义一致；resume 重派后 trace 出现同 stepIndex 重复节点时取最后写入）。
 */
function traceNodeByIndex(run: WorkflowRun): Map<number, ExecutionTraceNode> {
  const byIndex = new Map<number, ExecutionTraceNode>();
  for (const node of run.state.trace.toArray()) {
    byIndex.set(node.stepIndex, node);
  }
  return byIndex;
}

/**
 * record 同 stepIndex 去重取「当前尝试」（resume 重派形态，设计 §3.1.3 去重规则）：
 * 优先 status === "running" 的 record；无 running 时取 startedAt 最新的一条
 * （终局比较以该条的结束时间为准）。无 stepIndex 的 record 不成行（SubagentRecord
 * 读侧语义：无 stepIndex 的 record 不参与 run 视图关联）。
 */
function currentAttemptByStepIndex(
  records: readonly RunMemberRecordView[] | undefined,
): Map<number, RunMemberRecordView> {
  const byIndex = new Map<number, RunMemberRecordView>();
  if (records === undefined) return byIndex;
  for (const record of records) {
    if (record.stepIndex === undefined) continue;
    const current = byIndex.get(record.stepIndex);
    if (current === undefined || preferCurrentAttempt(record, current)) {
      byIndex.set(record.stepIndex, record);
    }
  }
  return byIndex;
}

/** 去重比较：running 优先；同侧取 startedAt 最新。 */
function preferCurrentAttempt(candidate: RunMemberRecordView, current: RunMemberRecordView): boolean {
  if ((candidate.status === "running") !== (current.status === "running")) {
    return candidate.status === "running";
  }
  return candidate.startedAt > current.startedAt;
}

/** record 行的 state 判定（设计 §3.1.3 状态表：status === "running" → running；outcome 存在 → 映射）。 */
function recordStateOf(record: RunMemberRecordView, node: ExecutionTraceNode | undefined): MemberState {
  if (record.status === "running") return "running";
  if (record.outcome !== undefined) return record.outcome;
  // 存量 record（status=idle 且无 outcome 字段——outcome 落地前的旧数据）设计表未
  // 定义：回落 trace 节点状态映射，再回落 record 自身事实（error → failed、
  // endedAt → completed），缺省 running（不虚构终局——假成功比持续 running 更危险）。
  if (node !== undefined) {
    if (node.status === "completed") return "completed";
    if (node.status === "failed") return "failed";
  }
  if (record.error !== undefined) return "failed";
  if (record.endedAt !== undefined) return "completed";
  return "running";
}

/** record 行组装（record 优先，逐字段回落同 stepIndex 的 trace 节点）。 */
function memberViewFromRecord(
  stepIndex: number,
  record: RunMemberRecordView,
  node: ExecutionTraceNode | undefined,
  now: number,
): RunMemberView {
  const state = recordStateOf(record, node);
  const view: RunMemberView = {
    stepIndex,
    state,
    agent: agentOf(record, node),
    model: firstNonEmpty(record.model, node?.model) ?? "default",
  };
  if (state === "running") applyRunningFields(view, record, now);
  else applyFinalFields(view, record, node);
  const turns = record.turns ?? node?.result?.usage?.turns;
  if (turns !== undefined) view.turns = turns;
  return view;
}

/** 执行者短名（record.agent 优先；空串回落 trace 标签，无 trace = 空串缺省）。 */
function agentOf(record: RunMemberRecordView, node: ExecutionTraceNode | undefined): string {
  return record.agent !== "" ? record.agent : (node?.agent ?? "");
}

/** 运行中行字段（设计 §3.1.3）：耗时 = now-startedAt；lastError 取 eventLog 最后一条 error。 */
function applyRunningFields(view: RunMemberView, record: RunMemberRecordView, now: number): void {
  view.durationMs = now - record.startedAt;
  view.lastError = lastErrorOf(record.eventLog);
  if (record.currentActivity !== undefined) {
    view.currentActivity = formatActivity(record.currentActivity);
  }
}

/** 终局行字段：耗时 = 结束-开始（endedAt 优先，回落 trace completedAt）；lastError 三级回落。 */
function applyFinalFields(
  view: RunMemberView,
  record: RunMemberRecordView,
  node: ExecutionTraceNode | undefined,
): void {
  const endMs = record.endedAt ?? parseIsoMs(node?.completedAt);
  if (endMs !== undefined) view.durationMs = endMs - record.startedAt;
  view.lastError = firstDefined(record.error, node?.result?.error, node?.error);
}

/**
 * trace 兜底行组装（record 查询不可用或该 stepIndex 无 record 时）。粒度差异（设计
 * §3.1.3 诚实注记）：abort 场景下 record 行显示 cancelled，兜底行只能显示 failed
 * （trace 节点无 cancelled 状态，取消语义由错误文案承载）——兜底是降级形态。
 */
function memberViewFromTraceNode(node: ExecutionTraceNode, now: number): RunMemberView {
  // 节点 completed → completed；failed → failed；pending/running → running
  // （设计 §3.1.3 状态表「record 缺失，trace 节点兜底」行）。
  const state: MemberState =
    node.status === "completed" ? "completed" : node.status === "failed" ? "failed" : "running";
  const startedMs = parseIsoMs(node.startedAt);
  const view: RunMemberView = {
    stepIndex: node.stepIndex,
    state,
    agent: node.agent,
    model: node.model !== "" ? node.model : "default",
  };
  if (state === "running") {
    if (startedMs !== undefined) view.durationMs = now - startedMs;
    // 运行中兜底行无 eventLog 来源（trace 节点不携带）——lastError/currentActivity/turns 缺省。
  } else {
    const endMs = parseIsoMs(node.completedAt);
    if (startedMs !== undefined && endMs !== undefined) view.durationMs = endMs - startedMs;
    view.lastError = firstDefined(node.result?.error, node.error);
    const turns = node.result?.usage?.turns;
    if (turns !== undefined) view.turns = turns;
  }
  return view;
}

// ── 渲染预算（设计 §3.1.3「输出体积与截断」）──────────────────

/** 成员表总字符预算（与 core 既有 TRACE_RESULT_MAX_CHARS 同值——设计 §3.1.3）。 */
export const MEMBER_VIEWS_MAX_CHARS = TRACE_RESULT_MAX_CHARS;

/** 截断结果（工具层 details 的 truncated/total 与省略行文案的数据源）。 */
export interface MemberViewsBudget { // oe-exempt:20261022:framework:设计 §3.1.3 截断契约数据源（工具层 details 的 truncated/total/omitted）
  /** 保留行（stepIndex 升序——截断只做行选择，不改变渲染序）。 */
  members: RunMemberView[];
  /** 是否发生截断。 */
  truncated: boolean;
  /** 截断前总行数。 */
  total: number;
  /** 被省略行数（total - members.length）。 */
  omitted: number;
}

/**
 * 单成员行 → 单行渲染文本（成员表文本渲染与截断预算的同一度量单位——两侧同源
 * 防漂移）。列式对齐设计 §3.1.3 示例：`[0] running    writer  <model>  6.0s  turns: 4 · tool: bash`；
 * 终局行带 error 时缀 `error: <lastError>`（failed / cancelled 的取消文案均走此位）。
 */
export function memberViewLine(view: RunMemberView): string {
  const parts: string[] = [
    `[${view.stepIndex}]`,
    view.state.padEnd(11),
    view.agent.padEnd(16),
    view.model.padEnd(30),
  ];
  if (view.durationMs !== undefined) parts.push(`${(view.durationMs / 1000).toFixed(1)}s`);
  if (view.state === "running") {
    if (view.turns !== undefined) parts.push(`turns: ${view.turns}`);
    if (view.currentActivity !== undefined) parts.push(`· ${view.currentActivity}`);
  } else if (view.lastError !== undefined) {
    parts.push(`error: ${view.lastError}`);
  }
  return parts.join(" ").trimEnd();
}

/**
 * 成员行截断（纯函数）：总字符（行 + 换行的渲染口径）未超预算时原样全保留；超预算
 * 时 failed/cancelled 行优先保留，其余按 stepIndex 填充至预算用尽（设计 §3.1.3——
 * 填充序在遇到首个放不下的行即停，不做装箱回填）。输出保持 stepIndex 升序；省略行
 * 文案（`… N more members omitted (failed rows kept)`）由消费方按 omitted 拼装。
 */
export function truncateRunMemberViews(
  members: readonly RunMemberView[],
  maxChars: number = MEMBER_VIEWS_MAX_CHARS,
): MemberViewsBudget {
  const total = members.length;
  if (total === 0) return { members: [], truncated: false, total: 0, omitted: 0 };

  const lines = members.map(memberViewLine);
  const costOf = (i: number): number => lines[i]!.length + 1; // +1 = 换行
  const totalChars = lines.reduce((sum, _, i) => sum + costOf(i), 0);
  if (totalChars <= maxChars) {
    return { members: [...members], truncated: false, total, omitted: 0 };
  }

  const priorityOrder: number[] = [];
  const restOrder: number[] = [];
  for (let i = 0; i < total; i++) {
    const state = members[i]!.state;
    (state === "failed" || state === "cancelled" ? priorityOrder : restOrder).push(i);
  }
  const keptIndexes: number[] = [];
  let used = 0;
  for (const i of [...priorityOrder, ...restOrder]) {
    const cost = costOf(i);
    if (used + cost > maxChars) break;
    keptIndexes.push(i);
    used += cost;
  }
  keptIndexes.sort((a, b) => a - b);
  return {
    members: keptIndexes.map((i) => members[i]!),
    truncated: true,
    total,
    omitted: total - keptIndexes.length,
  };
}

// ── 小原语 ────────────────────────────────────────────────────

/** 首个非空串值（全空 = undefined——调用方决定回落标记）。 */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** 首个已定义值。 */
function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

/** ISO 时间戳 → 墙钟毫秒（trace 节点时间字段口径；缺失/不可解析 = undefined，缺省不写 0）。 */
function parseIsoMs(iso: string | undefined): number | undefined {
  if (iso === undefined || iso === "") return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** currentActivity → 展示文本（tool 型带类型前缀，对齐设计示例 "tool: bash"；text/thinking 直取 label）。 */
function formatActivity(activity: { type: "tool" | "text" | "thinking"; label: string }): string {
  return activity.type === "tool" ? `tool: ${activity.label}` : activity.label;
}
