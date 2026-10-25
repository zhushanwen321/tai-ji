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
import { partialMembersFromScriptResult } from "./run-member-settlement.ts";
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
  /**
   * [subagent-observability §3.3.6 成员行对齐] 轮收条事实快照（最小消费视图——
   * SubagentRecord.lastRound 结构性满足；本行只消费失败分类维）。undefined =
   * 尚无已完成的轮 / 存量。
   */
  readonly lastRound?: {
    readonly failure?: { readonly class: string; readonly kind: string };
  };
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
  /**
   * [subagent-observability §3.3.6 成员行对齐] 失败分类（点拼 `"<class>.<kind>"`——
   * 终局事件 cause 同款序列化形态，§3.3.8；record.lastRound.failure 派生）。
   * undefined = 无失败事实。
   */
  failure?: string;
  /**
   * [§3.3.6/§3.3.9 budget 分轴显式] 四轴预算结构（null = 该轴生效上界无界）。
   * 事实源（runMemberViews 派生——本类型不单独产词）：maxTurns/timeoutMs = 同
   * stepIndex call 的 AgentCallOpts 显式传参（callId = stepIndex 单源，
   * dispatchAgentCall 落 AgentCall.opts；calls miss 回落重建侧恢复的声明值
   * meta.recoveredCallOpts）；budgetTokens/budgetTimeMs = run 级声明轴
   * （run.state.budget.maxTokens/maxTimeMs——fresh run 从 spec 构造、重建 run 从
   * run-created 帧恢复，两形态同源，resume-run-rebuild.ts 同款注释锚）。
   * 生产输出恒在场（runMemberViews 逐行附加）；类型保持 optional 仅为兼容既有
   * 测试/消费方的字面量构造形态。
   */
  budget?: {
    maxTurns: number | null;
    timeoutMs: number | null;
    budgetTokens: number | null;
    budgetTimeMs: number | null;
  };
  /**
   * [subagent-observability §3.3.6/§3.3.10 成员行对齐] 交付校验缺口事实（部分交付
   * 成员的未满足 deliverable 清单）。事实源 = run.state.scriptResult.partialMembers
   * 按 stepIndex 对齐（worker 脚本交付校验的宿主落点，与 run-settled 帧
   * partialMembers 同源同解析）；undefined = 无交付校验缺口事实（未声明
   * deliverables / 全满足 / 全不满足〔全缺走失败成员语义，不落本字段〕/ 脚本未返回）。
   */
  missingDeliverables?: string[];
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
  // [§3.3.6/§3.3.9 budget 分轴显式] 四轴预算逐行附加（record 行与 trace 兜底行同域
  // ——预算是 run/call 的声明事实，不随行来源变化）。
  const missingByStepIndex = missingDeliverablesByStepIndex(run);
  for (const view of rows.values()) {
    view.budget = budgetViewOf(run, view.stepIndex);
    // [§3.3.6/§3.3.10 成员行对齐] 交付校验缺口逐行附加（脚本层交付校验事实，
    // 与 run-settled 帧 partialMembers 同源）。
    const missing = missingByStepIndex.get(view.stepIndex);
    if (missing !== undefined) view.missingDeliverables = missing;
  }
  return [...rows.values()].sort((a, b) => a.stepIndex - b.stepIndex);
}

/**
 * 脚本层交付校验缺口按 stepIndex 倒排（run.state.scriptResult.partialMembers →
 * Map<taskIndex, missing[]>；解析复用结算模块单点——畸形条目 warn 留痕后丢弃，
 * 缺席/全畸形 = 空 Map）。
 */
function missingDeliverablesByStepIndex(run: WorkflowRun): Map<number, string[]> {
  const reports = partialMembersFromScriptResult(run.state.scriptResult);
  const byIndex = new Map<number, string[]>();
  if (reports === undefined) return byIndex;
  for (const report of reports) {
    byIndex.set(report.taskIndex, report.missing);
  }
  return byIndex;
}

/**
 * 单成员行 budget 四轴派生（[§3.3.6/§3.3.9] 分轴显式——§3.3.9 执法点（引擎进程内
 * limiter）的声明值镜像）：
 * - maxTurns/timeoutMs：同 stepIndex call 的 AgentCallOpts 显式传参（callId =
 *   stepIndex 单源）；calls miss 时回落重建侧恢复的 agent-started 声明值
 *   （meta.recoveredCallOpts——重派集成员 replay 重派前的窗口，resume-run-rebuild
 *   从 input 载荷恢复）；两源皆无 = 未声明 = null；
 * - budgetTokens/budgetTimeMs：run 级声明轴（run.state.budget.maxTokens/maxTimeMs，
 *   fresh run 从 spec 构造 / 重建 run 从 run-created 帧恢复——两形态同源）。
 * 值语义与执法点一致：未传 / <=0 = 不限（AgentCallOpts 预算语义对齐注释），
 * 映射为 null（显式无界）。
 */
function budgetViewOf(run: WorkflowRun, stepIndex: number): NonNullable<RunMemberView["budget"]> {
  const call = run.state.calls.get(stepIndex);
  // calls 条目（AgentCall.opts 必有）优先；miss 才回落重建侧恢复表——worker 重派后
  // dispatchAgentCall 落真值条目，陈旧恢复表自然失效。
  const opts = call?.opts ?? run.meta.recoveredCallOpts?.get(stepIndex);
  const positiveOr = (v: number | undefined): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  return {
    maxTurns: positiveOr(opts?.maxTurns),
    timeoutMs: positiveOr(opts?.timeoutMs),
    budgetTokens: positiveOr(run.state.budget.maxTokens),
    budgetTimeMs: positiveOr(run.state.budget.maxTimeMs),
  };
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
  // [subagent-observability §3.3.6 成员行对齐] 失败分类随轮收条事实（点拼序列化，
  // 与终局事件 cause 同形——record 事实优先，trace 兜底节点无分类维）。
  const failure = record.lastRound?.failure;
  if (failure !== undefined) view.failure = `${failure.class}.${failure.kind}`;
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
 * 终局行带失败事实时先缀失败分类（`failure: <class>.<kind>`——§3.3.6 成员行对齐，
 * 与终局事件 cause 同形）、原文 error 尾缀（`error: <lastError>`——failed / cancelled
 * 的取消文案均走此位）；声明了生效上界的 budget 轴以 `budget: <axis>=<N> …` 段渲染
 * （null 轴 = 显式无界不入行）；部分交付成员缀 `deliverables: N missing`（§3.3.10
 * 交付校验结果，明细清单在 details 载荷 missingDeliverables）。
 */
/** 成员表列宽（padEnd 预算，列式对齐设计 §3.1.3——state/agent/model 三列定宽）。 */
const STATE_COL = 11;
const AGENT_COL = 16;
const MODEL_COL = 30;
/** 毫秒 → 秒（成员行时长列的显示单位换算）。 */
const MS_PER_SECOND = 1000;

export function memberViewLine(view: RunMemberView): string {
  // 终端成员表列宽（`[idx] state agent model …` 对齐，与 tool 端 README 示例同形态）
  const STATE_COL = 11;
  const AGENT_COL = 16;
  const MODEL_COL = 30;
  const MS_PER_SECOND = 1000;
  const parts: string[] = [
    `[${view.stepIndex}]`,
    view.state.padEnd(STATE_COL),
    view.agent.padEnd(AGENT_COL),
    view.model.padEnd(MODEL_COL),
  ];
  if (view.durationMs !== undefined) parts.push(`${(view.durationMs / MS_PER_SECOND).toFixed(1)}s`);
  const boundedBudget = budgetLineSegment(view.budget);
  if (boundedBudget !== undefined) parts.push(`budget: ${boundedBudget}`);
  if (view.missingDeliverables !== undefined) {
    parts.push(`deliverables: ${view.missingDeliverables.length} missing`);
  }
  if (view.state === "running") {
    if (view.turns !== undefined) parts.push(`turns: ${view.turns}`);
    if (view.currentActivity !== undefined) parts.push(`· ${view.currentActivity}`);
  } else {
    if (view.failure !== undefined) parts.push(`failure: ${view.failure}`);
    if (view.lastError !== undefined) parts.push(`error: ${view.lastError}`);
  }
  return parts.join(" ").trimEnd();
}

/** budget 四轴的行内段（仅声明了生效上界的轴；全无界 = undefined 不入行——
 *  「null = 显式无界」的完整四轴结构在 details 载荷，行内只呈现生效约束）。 */
function budgetLineSegment(budget: RunMemberView["budget"]): string | undefined {
  if (budget === undefined) return undefined;
  const axes: string[] = [];
  if (budget.maxTurns !== null) axes.push(`maxTurns=${budget.maxTurns}`);
  if (budget.timeoutMs !== null) axes.push(`timeoutMs=${budget.timeoutMs}`);
  if (budget.budgetTokens !== null) axes.push(`budgetTokens=${budget.budgetTokens}`);
  if (budget.budgetTimeMs !== null) axes.push(`budgetTimeMs=${budget.budgetTimeMs}`);
  return axes.length > 0 ? axes.join(" ") : undefined;
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
