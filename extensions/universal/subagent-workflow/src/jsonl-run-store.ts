/**
 * Workflow Extension — Run Record Store
 *
 * RunStore port 的 Infra 实现。
 *
 * 职责：WorkflowRun 聚合根的 record 流权威重建（跨 session 重水合）。
 *
 * 层归属：Infra（D-12）。implements Engine 层的 RunStore port。
 * 依赖 @earendil-works/pi-coding-agent 的 ExtensionAPI/ExtensionContext（Infra 允许 Pi SDK）。
 *
 * 介质形态（[D1] record 单源存储收敛，设计 workflow-run-resume-revision §3.3 D1）：
 * - **唯一事实源 = record 事件流**（`<sessionDir>/workflow-state/<runId>.record.jsonl`，
 *   append-only，core worker-message-pump 单写者 + 收编入口追加）：`run-created`
 *   携带 scriptSource 全文、`agent-settled` 携带 result 全文；lifecycle/终局/calls
 *   全部是 fold 内存投影，重启即从 record 重建。
 * - **state 快照文件已删**：旧形态的 `<runId>.jsonl` 整文件覆盖写投影不再存在——
 *   判终局 = record fold 终态唯一判法，无第二份可分叉的投影文件（设计目标 2）。
 *   本类名沿用历史文件名（jsonl-run-store.ts / JsonlRunStore——消费面与测试脚本
 *   的改名波及大于语义收益），语义已收敛为 record store 单模式。
 * - **旧格式两件套（旧 journal `.events.jsonl` + state 快照 `<runId>.jsonl`）不读、
 *   不写、不主动删**（用户裁决 2026-09-28：不做存量迁移）：全部读取路径只认
 *   record 后缀；注册条目的 journalPath 锚点后缀天然区分新旧实体——旧后缀锚点
 *   = 历史 run，跳过不重建（从壳侧读取面消失即 D1 历史数据处置的预期行为）。
 * - **loadAll = record 流折叠重建**：v2 注册条目定界（本会话有哪些实体）→
 *   record 流全量读 → fold 重建（终局 ⟸ run-settled 帧）；「有注册、无终局帧」
 *   的实体保持 running 交恢复链收编；终局实体幂等补写 v2 终态条目。
 *   **坏行停摆语义**：解析失败（半截行/非法 JSON/缺信封）与载荷完整性缺失
 *   （settled 帧缺 result 全文）即抛错拒绝，不静默跳过——record 流是唯一事实
 *   源，读不出 = 拒绝（场景 18），静默跳过会把数据损坏伪装成「无 run 历史」。
 * - **主 session 每 run 两条 v2 小条目**（投影锚，非第二事实源）：注册条目
 *   （core lifecycle.runWorkflow 写，身份 + record 流路径锚点）与终态条目（core
 *   finalizeRun 终局 coda 写；本 store 的 loadAll 在「record 已终局而终态条目
 *   缺失」时幂等补写）。条目可随时从 record 完整重建，判读只信 record fold。
 * - **save = 显式 no-op**：run 域状态变化的持久化 = 事件追加（core 单写者链），
 *   壳侧无投影可写。方法保留 = RunStore port 契约（core 调用点不改）。
 *
 * 磁盘足迹（[S3 查证结论沿用] pi 不扫描/清理 `<sessionDir>/workflow-state/`，
 * 保留策略由本包自担）：保留维护轮的触发点与判据单源在 core
 * （runRetentionMaintenanceRound，session_start 兜底触发点见 session-lifecycle.ts）。
 * 本 store 不再触发维护轮——旧触发点（state 快照首写）随快照删除而消失；
 * abandon 终局化接线（abandonElapsedInterruptedRuns）随 D9 拆除，interrupted 的
 * 进入方收敛为崩溃收编与 terminate（core 侧）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
// 全部经 core barrel 消费（生产消费纪律：extensions 源码不深路径 import core）。
import {
  AgentCall,
  RUN_EVENTS_SUFFIX,
  STATE_DIR_NAME,
  Trace,
  WORKFLOW_RECORD_CUSTOM_TYPE,
  buildWorkflowRecordSettledEntryData,
  classifyWorkflowRecordEntryData,
  getLogger,
  // [§3.2] 单行坏行判定规则单源在 core（requireSeq:false = 兼容档，存量无 seq 行放行）；
  // 壳侧只保留自己的错误文案与 ENOENT 分流。本地词表投影（RUN_EVENT_TYPE_SET /
  // hasEventEnvelope）与 outcome 判据副本已删。
  parseRecordStreamLine,
  parseLegacyArgsSummary as parseLegacyArgsSummaryCore,
  runSettledOutcomeToDoneReason,
  // [D6(a) 第 1 步] 恢复路径重建的终局事实注入（fold 出 run-settled 帧 → 终局记录
  // 注册表），与 core isRunSettled / runSummary 的判据同源。
  noteRebuiltSettlement,
  settlementRecordOfRunSettledFrame,
  type AgentResult,
  type ExecutionTraceNode,
  type RunEventLineIssue,
  type RunOutcome,
  type RunStore,
  type WorkflowRecordRegisteredEntryData,
  type WorkflowRecordSettledEntryData,
  type WorkflowRunEvent,
} from "@zhushanwen/subagent-core";
import { WorkflowRun } from "@zhushanwen/subagent-core";
import { errorLogsFromEvents, rebuildBudget, runAccountingFromEvents } from "@zhushanwen/subagent-core";
import { guardStaleCtx, isEnoentError, toErrorMessage } from "@zhushanwen/pi-ext-guards";

// ── [W1 / D1] v2 条目读面（注册定界 + 终态条目抑制）────────────────

/** loadAll 的 entry 扫描产物。 */
interface EntrySources {
  /** v2 注册条目（runId → 注册载荷；record 重建的定界源 + journalPath 锚点）。 */
  registered: Map<string, WorkflowRecordRegisteredEntryData>;
  /**
   * 已有 v2 终态条目的 run（runId → 终态载荷，后写覆盖 = last-wins）。唯一用途 =
   * 终态条目幂等补写的抑制判定（条目已在则不重写）。**不参与终局判读**——
   * 判终局 = record fold 唯一判法（D1：条目是投影锚，可随时从 record 重建）。
   */
  settledEntries: Map<string, WorkflowRecordSettledEntryData>;
}

/**
 * v2 条目 → 注册定界 / 终态条目抑制。载荷按 kind 分流；载荷形状损坏（缺 runId
 * 等半写形态）warn 留证后跳过（[SO-DATA-2] per-entry 隔离口径：残缺 entry 不得
 * 让 loadAll 返回空）。
 */
function collectV2RecordEntry(entry: CustomEntry, entryIndex: number, sources: EntrySources): void {
  if (entry.customType !== WORKFLOW_RECORD_CUSTOM_TYPE) return;
  const classification = classifyWorkflowRecordEntryData(entry.data);
  if (classification.ok || classification.reason !== "v2") return;
  const v2 = classification.entry;
  if (v2.kind === "registered") {
    if (typeof v2.runId !== "string" || v2.runId === "" || typeof v2.journalPath !== "string") {
      logger.warn(
        `[subagent-workflow] workflow-record v2 registered entry #${entryIndex} malformed (runId/journalPath missing), skipped`,
      );
      return;
    }
    sources.registered.set(v2.runId, v2);
    return;
  }
  // settled
  if (typeof v2.runId !== "string" || v2.runId === "") {
    logger.warn(
      `[subagent-workflow] workflow-record v2 settled entry #${entryIndex} malformed (runId missing), skipped`,
    );
    return;
  }
  sources.settledEntries.set(v2.runId, v2);
}

/** loadAll 的 entry 扫描：主 session entries → v2 注册定界 + 终态条目抑制（唯一发现
 *  通道）。历史形态 entry（v1 全量快照 / 旧 workflow-state-link 指针）静默忽略——
 *  历史数据仍在盘上，不再重建；未知 entry 的容忍面不受影响。 */
function collectEntrySources(entries: SessionEntry[]): EntrySources {
  const sources: EntrySources = {
    registered: new Map<string, WorkflowRecordRegisteredEntryData>(),
    settledEntries: new Map<string, WorkflowRecordSettledEntryData>(),
  };
  // 索引循环：损坏留证的 warn 需要 entry 索引（SO-DATA-2）
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type !== "custom") continue;
    collectV2RecordEntry(entry, i, sources);
  }
  return sources;
}

// ── run-settled 帧判读（DoneReason 映射 + 终局记录投影）────────────

// DoneReason 联合判别单点 = core terminal-actions.runSettledOutcomeToDoneReason
// （值表与语义注释见 core 侧定义）——壳内消费方（foldRecordStreamToRun /
// appendSettledEntryFallback）经顶部 import 取用；re-export 维持
// workflow-notify 等壳内文件的既有本地导入路径。
/** run-settled 帧形状（从 record 事件词表提取——errorCode 类型同源，免第二定义点）。 */
type RunSettledFrame = Extract<WorkflowRunEvent, { type: "run-settled" }>;

export { runSettledOutcomeToDoneReason } from "@zhushanwen/subagent-core";

/**
 * 终局记录（record run-settled 帧载荷的进程内投影——与 core 侧
 * RunSettlementRecord 同构）。reason/errorCode 直取帧载荷；DoneReason 由
 * runSettledOutcomeToDoneReason 联合派生（不在本形状内预计算）。
 */
export interface RunSettlementRecord {
  outcome: RunOutcome;
  errorCode?: RunSettledFrame["errorCode"];
  reason?: string;
  settledAt: number;
}

// ── record 流读原语（严格解析 + 完整性拒绝）────────────────────

/**
 * record 流损坏（读失败拒绝，场景 18）。
 *
 * 语义：record 流是 run 域唯一事实源（D1），解析失败或载荷完整性缺失 = 流被
 * 截断/篡改/写入器缺陷——拒绝静默跳过（跳过会把损坏伪装成「无 run 历史」，
 * 恢复链收编会在残缺事实上追加收编帧）。错误消息含恢复指引（错误 → 权威源 →
 * 处置闭环）。
 */
export class RecordStreamCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordStreamCorruptionError";
  }
}

/**
 * record 流全量读（严格解析）：合法事件行按写入序返回；坏行（JSON 解析失败 /
 * 非对象 / 缺 type/ts 信封 / 词表外 type 或 outcome / agent-settled 帧缺 result 全文）
 * 抛 {@link RecordStreamCorruptionError}——不静默跳过（场景 18 坏行停摆语义，
 * 与 core journal scan 活体投影的宽容跳过语义刻意分层：活体 fold 不能因单帧
 * 全停，恢复读面不能对损坏装瞎）。
 *
 * [§3.2] 判据经 core 单源原语 parseRecordStreamLine（requireSeq=false——本读面
 * 兼容 W1 前无 seq 的存量行）消费；core 恢复读面用同一原语的严格档。两侧真差异只剩
 * 错误文案与 ENOENT 分流。
 *
 * 文件不存在（ENOENT）原样上抛交调用方分流（新形态实体早期崩溃 vs 历史实体）。
 */
function readRecordStream(recordPath: string): WorkflowRunEvent[] {
  const content = fs.readFileSync(recordPath, "utf8");
  const events: WorkflowRunEvent[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const corruption = (reason: string): RecordStreamCorruptionError =>
      new RecordStreamCorruptionError(
        `record 流损坏，拒绝静默跳过（文件=${recordPath} 行=${i + 1}）：${reason}。` +
          "record 流是 run 域唯一事实源（D1），坏行意味着截断/篡改/写入器缺陷。恢复：检查该文件是否被外部编辑" +
          "或写入器版本与载荷契约不符（dispatchRunCreated/dispatchAskSettled）；无法修复时接受该 run 不可续跑，勿手工删行。",
      );
    const result = parseRecordStreamLine(line, { requireSeq: false });
    if (!result.ok) throw corruption(describeRecordStreamIssue(result.issue));
    events.push(result.event);
  }
  return events;
}

/** 单行问题 → 壳 strict 读面的中文文案（core 恢复读面同问题出英文文案——本函数不共享）。 */
function describeRecordStreamIssue(issue: RunEventLineIssue): string {
  switch (issue.kind) {
    case "invalid-json":
      return "非法 JSON（半截行/截断写入）";
    case "not-object":
      return "非对象行（JSON 顶层不是对象）";
    case "type-envelope":
      return "缺事件信封（type 非字符串或为空）";
    case "type-outside-vocabulary":
      return `词表外事件 type=${JSON.stringify(issue.value)}（旧词表历史行——[D1] 不读旧两件）`;
    case "ts-envelope":
      return "缺事件信封 ts（非有限数值）";
    case "seq-envelope":
      // 兼容档（requireSeq=false）不校验 seq——本分支仅防御性保留（规则档位改动时文案已在）。
      return `seq 信封非法 seq=${JSON.stringify(issue.value)}`;
    case "outcome-outside-vocabulary":
      return `词表外 outcome=${JSON.stringify(issue.value)}（[D2] 词表重构后的历史形态——interrupted 已入 lifecycle）`;
    case "agent-settled-missing-result":
      return "agent-settled 帧缺 result 全文（record 单源后为非法形态——流被篡改或写入器未携带全文，场景 18）";
  }
}

/** 事件流尾向扫描取最后一帧 run-settled（单终局不变量下的防御性读取）。 */
function lastRunSettledEvent(
  events: readonly WorkflowRunEvent[],
): RunSettledFrame | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === "run-settled") return ev;
  }
  return undefined;
}

/**
 * 尾向扫描「末次 run-interrupted 后无 run-resumed」的中断时刻（ISO；无中断或
 * 已复活 → undefined）。[D2] interrupted 暂停态的 fold 投影依据——loadAll 重建
 * 的中断 run 由 meta.interruptedAt 承载（聚合 status 保持两态）。
 */
function lastInterruptedAt(events: readonly WorkflowRunEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === "run-resumed") return undefined; // 已复活——中断标记清除
    if (ev?.type === "run-interrupted") return new Date(ev.ts).toISOString();
  }
  return undefined;
}

// ── record 流 fold 重建（事件流 → WorkflowRun）──────────────────

/**
 * 单个 call 的重建中间形态（fold 循环产出；AgentCall 构造延迟到 Trace 建立后
 * ——traceNode 需与 Trace 共享同一节点副本，D-10 引用共享）。
 */
interface CallDraft {
  taskIndex: number;
  agentName: string;
  phase?: string;
  startedAtIso: string;
  attempts: number;
  /** 有 settled 帧 = done；无 = 在途（running）。 */
  result?: AgentResult;
  settledOutcome?: RunOutcome;
  settledTs?: number;
}

/**
 * record 事件流 → WorkflowRun 聚合重建（纯函数，零 IO）。
 *
 * fold 语义（词表 = run-events.ts [D4] 对齐后 9 事件）：
 * - `run-created`：spec.scriptSource（全文，[D1]）+ args（全文，设计 §3.1 载荷表；
 *   旧格式帧回落 argsSummary 尽力恢复——parseLegacyArgsSummary）+ startedAt 锚点
 *   （帧 ts 优先，回落注册条目 startedAt）；
 * - `agent-started`：按 taskIndex 建 call（agentName/phase/startedAt）；
 *   重复 started 不重建（同 record fold 语义）；
 * - `agent-retrying`：无实体字段可回填（attempts 终值由 settled 帧承载）——跳过；
 * - `agent-settled`：result 全文回填 + done 终态（settled 先于 started 的残
 *   形态建占位行——同 journal fold 兜底）；sessionFile/sessionId 从 result 透传
 *   （对齐 finalizeCall 的 call 字段填充纪律）；
 * - `run-settled`：终局（status=done + reason 映射 + completedAt=帧 ts）；无帧 =
 *   running（交恢复链收编）。
 *
 * record 流不承载的字段（budget 计数/errorLogs/trace 完整面）按恢复语义最小形态
 * 缺省——步骤级详情的恢复读面 = record 流直读（session-reader 家族链），不经本聚合。
 */

/**
 * argsSummary → args 尽力恢复（旧格式帧回落通道，core resume-run.parseArgsSummary
 * 同款语义）：现行写入面 run-created 帧携带 args 全文（上方优先消费）；本函数只
 * 服务旧格式帧——未截断摘要可完整恢复，截断/不可解析回落 {}（旧格式流的 $ARGS
 * 语义限制，回落处置对齐 core 侧「尽力恢复」——core 同款分支 warn 留证，非静默）。
 */
function parseLegacyArgsSummary(argsSummary: string | undefined): Record<string, unknown> {
  // [§3.2] 恢复规则单源（core parseLegacyArgsSummary，与 resume-run 的旧格式回落同一实现）；
  // 本包装只补壳侧日志文案——截断分支此前壳侧静默、core 侧 warn，现两侧同留证。
  const { args, issue } = parseLegacyArgsSummaryCore(argsSummary);
  if (issue === "truncated-summary") {
    logger.warn(
      "[subagent-workflow] legacy run-created argsSummary is truncated — $ARGS restored as {} " +
        "(legacy record stream predates the full-args payload; rerun with a fresh run if the script needs exact args)",
    );
  } else if (issue === "not-parseable") {
    logger.warn("[subagent-workflow] legacy run-created argsSummary is not parseable JSON — $ARGS restored as {}");
  } else if (issue === "not-object") {
    logger.warn("[subagent-workflow] legacy run-created argsSummary is not a JSON object — $ARGS restored as {}");
  }
  return args;
}

/** [foldRecordStreamToRun 拆分] 事件流 → call 重建中间形态（per taskIndex 聚合
 * started/settled 两帧；settled 先于 started 的残形态占位行兜底——同 journal fold，
 * 保投影不丢终局）。 */
function collectRunCallDrafts(events: readonly WorkflowRunEvent[]): Map<number, CallDraft> {
  const drafts = new Map<number, CallDraft>();
  for (const event of events) {
    if (event.type === "agent-started") {
      if (drafts.has(event.taskIndex)) continue;
      drafts.set(event.taskIndex, {
        taskIndex: event.taskIndex,
        agentName: event.agentName,
        ...(event.phase !== undefined ? { phase: event.phase } : {}),
        startedAtIso: new Date(event.ts).toISOString(),
        attempts: event.attempt,
      });
    } else if (event.type === "agent-settled") {
      applySettledToRunDraft(drafts, event);
    }
  }
  return drafts;
}

/** [collectRunCallDrafts 拆分] agent-settled 归并（无 started 行时占位兜底成行）。 */
function applySettledToRunDraft(
  drafts: Map<number, CallDraft>,
  event: Extract<WorkflowRunEvent, { type: "agent-settled" }>,
): void {
  const existing = drafts.get(event.taskIndex);
  if (existing === undefined) {
    // settled 先于 dispatched 的残形态：占位行兜底（同 journal fold——
    // 保投影不丢终局）
    drafts.set(event.taskIndex, {
      taskIndex: event.taskIndex,
      agentName: "(unknown)",
      startedAtIso: new Date(event.ts).toISOString(),
      attempts: event.attempt,
      result: event.result,
      settledOutcome: event.outcome,
      settledTs: event.ts,
    });
    return;
  }
  existing.attempts = event.attempt;
  existing.result = event.result;
  existing.settledOutcome = event.outcome;
  existing.settledTs = event.ts;
}

/** [foldRecordStreamToRun 拆分] 中间形态 → trace 节点（Trace 先重建——call 的
 * traceNode 回链到 Trace 副本，D-10 引用共享；匹配不到退化为独立浅拷贝，仅保构造不炸）。 */
function draftsToExecutionTraceNodes(drafts: Map<number, CallDraft>): ExecutionTraceNode[] {
  return [...drafts.values()].map((d) => ({
    stepIndex: d.taskIndex,
    agent: d.agentName,
    task: "",
    model: "",
    status: d.settledOutcome === undefined ? "running" : d.settledOutcome === "done" ? "completed" : "failed",
    ...(d.phase !== undefined ? { phase: d.phase } : {}),
    startedAt: d.startedAtIso,
    // settled 终局保真：result 全文随节点（D-10 节点持 result 引用的原语义）+
    // completedAt（节点时间锚）+ error 诊断面
    ...(d.result !== undefined ? { result: d.result } : {}),
    ...(d.result?.error !== undefined ? { error: d.result.error } : {}),
    ...(d.settledTs !== undefined ? { completedAt: new Date(d.settledTs).toISOString() } : {}),
  }));
}

/** [foldRecordStreamToRun 拆分] 中间形态 → AgentCall（直接构造 done/running 终态，
 * bypass markRunning/markDone 状态机守卫——重建已知良好持久态的既定先例；opts 最小
 * 形态：record 流现行载荷不携带入参全文，重建聚合的 opts 仅满足 AgentCallOpts
 * 契约形状，prompt 占位空串）。 */
function draftsToAgentCalls(
  drafts: Map<number, CallDraft>,
  sharedNodes: Map<number, ExecutionTraceNode>,
  nodes: ExecutionTraceNode[],
): Map<number, AgentCall> {
  const calls = new Map<number, AgentCall>();
  for (const d of drafts.values()) {
    const linked = sharedNodes.get(d.taskIndex) ?? nodes.find((n) => n.stepIndex === d.taskIndex)!;
    const call = new AgentCall(d.taskIndex, { prompt: "" }, linked);
    call.attempts = d.attempts;
    call.status = d.settledOutcome === undefined ? "running" : "done";
    if (d.result !== undefined) {
      call.result = d.result;
      // sessionFile/sessionId 对齐 finalizeCall 的 call 字段填充纪律
      if (d.result.sessionFile !== undefined) call.sessionFile = d.result.sessionFile;
      if (d.result.sessionId !== undefined) call.sessionId = d.result.sessionId;
    }
    calls.set(d.taskIndex, call);
  }
  return calls;
}


/**
 * spec 重建预算的读取面三档回落（与 core resume-run.assertResumeEligibility 等价，
 * 少 options 档——resume 的显式覆盖已由 core 写进 run-resumed 帧，本折叠只表达
 * record 事实）：最近一条 run-resumed 的生效值 > run-created 的创建预算；两者
 * 皆无/<=0 = 不限时。取流尾最近一条 run-resumed 而非「最近一条带字段」——更晚的
 * 「不限时复活」（0/负值不落字段）须回落 created，而非错误地沿用更早的覆盖值。
 * `findLast` 属 ES2023 lib（本包 target ES2022）——从尾向头手写。
 */
function resolveSpecBudgetMs(
  created: Extract<WorkflowRunEvent, { type: "run-created" }> | undefined,
  events: readonly WorkflowRunEvent[],
): number | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === "run-resumed") return event.budgetTimeMs ?? created?.budgetTimeMs;
  }
  return created?.budgetTimeMs;
}

/** [foldRecordStreamToRun 拆分] run spec 重建（run-created 帧优先，注册条目兜底）：
 * args 全文优先（设计 §3.1 载荷表 run-created 行「args」）；旧格式帧回落
 * argsSummary 尽力恢复（未截断可完整恢复，截断回落 {}——core parseArgsSummary
 * 同款语义；两侧行为等价由 record-mode 测试锁定）；scriptPath 锚定恢复（core
 * rebuildRunFromRecord 同款）：worker 沙箱 eval 模式无 __dirname，模板脚本靠
 * scriptPath 定位 _shared 族共享件；旧格式帧缺失回落空串。budgetTimeMs 恢复（core
 * 同款三档回落的 record 侧：最近一条 run-resumed 的生效值 > run-created 的创建
 * 预算，仅 > 0 落 spec）：引擎/展示投影按 run 生效预算读（缺字段 = 旧格式/未设
 * 预算 = 不限时）。 */
function rebuildRunSpecFromEntries(
  created: Extract<WorkflowRunEvent, { type: "run-created" }> | undefined,
  reg: WorkflowRecordRegisteredEntryData,
  budgetTimeMs: number | undefined,
) {
  return {
    scriptSource: created?.scriptSource ?? "",
    args: created?.args ?? parseLegacyArgsSummary(created?.argsSummary),
    scriptName: reg.scriptName,
    scriptPath: created?.scriptPath ?? "",
    // 条件式与 core rebuildRunFromRecord 等价（> 0 才落字段）——旧格式帧/0/负值
    // 一律不限时，两侧折叠结果同形
    ...(budgetTimeMs !== undefined && budgetTimeMs > 0 ? { budgetTimeMs } : {}),
    ...(reg.slug !== undefined ? { slug: reg.slug } : {}),
  };
}

function foldRecordStreamToRun(
  runId: string,
  reg: WorkflowRecordRegisteredEntryData,
  events: readonly WorkflowRunEvent[],
  settled?: WorkflowRecordSettledEntryData,
): WorkflowRun {
  const created = events.find(
    (e): e is Extract<WorkflowRunEvent, { type: "run-created" }> => e.type === "run-created",
  );
  const startedAtMs =
    created?.ts ?? (Number.isFinite(reg.startedAt) ? reg.startedAt : Date.now());
  const startedAtIso = new Date(startedAtMs).toISOString();
  const spec = rebuildRunSpecFromEntries(created, reg, resolveSpecBudgetMs(created, events));
  // [§2.1b] 会计重建：v2 终态条目带活体口径 usedTokens/callCount → 真值优先；条目缺席
  // 回落 agent-settled.result.usage 的同一加权口径（下界近似，含 usedCost）。
  const budget = rebuildBudget(settled, events);
  // [§2.1 errorLogs 持久化 / ADR-0093] 诊断日志重建：worker-log 帧 → errorLogs（与活体
  // 写入同语义：按序 + 尾部上限裁剪）。此前无持久面、重启即空。
  const errorLogs = errorLogsFromEvents(events);

  const drafts = collectRunCallDrafts(events);

  // Trace 先重建：call 的 traceNode 回链到 Trace 副本（D-10 引用共享；匹配不到
  // 退化为独立浅拷贝，仅保构造不炸）。
  const nodes = draftsToExecutionTraceNodes(drafts);
  const trace = Trace.fromArray(nodes);
  const sharedNodes = new Map(trace.toArray().map((n) => [n.stepIndex, n]));

  const calls = draftsToAgentCalls(drafts, sharedNodes, nodes);

  const settledEvent = lastRunSettledEvent(events);
  if (settledEvent === undefined) {
    const interruptedAt = lastInterruptedAt(events);
    return WorkflowRun.reconstruct(
      runId,
      spec,
      {
        budget,
        calls,
        trace,
        errorLogs,
      },
      {
        startedAt: startedAtIso,
        // 中断标记（[D2] 中断态经 meta 投影表达）：末次 run-interrupted 后无
        // run-resumed 复活 → meta.interruptedAt 置位，runSummary 投影 'interrupted'
        //（CLI/TUI 不显示僵尸「运行中」；resume 资格判据在 core fold lifecycle，
        // 不受本投影影响）。
        ...(interruptedAt !== undefined ? { interruptedAt } : {}),
      },
    );
  }
  const reason = runSettledOutcomeToDoneReason(settledEvent.outcome, settledEvent.errorCode);
  return WorkflowRun.reconstruct(
    runId,
    spec,
    {
      reason,
      budget,
      calls,
      trace,
      errorLogs,
      // 成功终局无 error；失败终局带帧 reason 文本（不落 generic 恢复文案）
      ...(reason !== "completed" && settledEvent.reason !== undefined ? { error: settledEvent.reason } : {}),
    },
    {
      startedAt: startedAtIso,
      completedAt: new Date(settledEvent.ts).toISOString(),
    },
  );
}

// ── JsonlRunStore ────────────────────────────────────────────

const logger = getLogger("subagents");

interface JsonlRunStoreOptions {
  /** Session directory root (record streams live under <sessionDir>/workflow-state/). */
  sessionDir: string;
  /** Pi ExtensionAPI for v2 终态条目补写（loadAll 收编面；optional for testing）。 */
  pi?: ExtensionAPI;
  /** Pi ExtensionContext for sessionManager.getEntries (optional for testing). */
  ctx?: ExtensionContext;
}

/**
 * RunStore port 的 pi 宿主 Inf 实现（session 锚定：唯一事实源 = record 事件流，
 * [D1] 单模式）。port 契约类型经 core barrel（RunStore 三方法 save / loadAll /
 * stateFilePath，models/ports.ts）。
 *
 * 本类的四个 interface 面（方法分组索引）：
 * 1. **port 面**（RunStore 契约）：save（no-op）/ loadAll（record 折叠重建）/
 *    stateFilePath（record 流路径）——组合根装配 LifecycleDeps.store 的注入面；
 * 2. **adoption 面**（skill-reload 接管）：rebind——post-reload session_start
 *    就地重绑 appendEntry 源（v2 终态条目补写面的消费源）；
 * 3. **终局记录查询面**：settledRecordOf——通知载荷链的帧直取源；
 * 4. **生命周期面**：dispose + flushPendingSaves——幂等收尾（无投影物化面后
 *    为纯契约保留）。
 */
export class JsonlRunStore implements RunStore {
  private readonly sessionDir: string;
  /**
   * v2 终态条目补写的 appendEntry 源（loadAll 收编面）。类型收窄为该面——
   * [skill-reload D3] rebind 时换入 stale-guarded 包装，构造时为裸 pi 原引用。
   */
  private pi?: Pick<ExtensionAPI, "appendEntry">;
  private ctx?: ExtensionContext;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(opts: JsonlRunStoreOptions) {
    this.sessionDir = opts.sessionDir;
    this.pi = opts.pi;
    this.ctx = opts.ctx;
  }

  /** State directory: <sessionDir>/workflow-state/（目录分量经 core barrel STATE_DIR_NAME 单源） */
  private get stateDir(): string {
    return path.join(this.sessionDir, STATE_DIR_NAME);
  }

  /** record 流路径 for a given runId（唯一持久件）。 */
  private recordPathFor(runId: string): string {
    return path.join(this.stateDir, `${runId}${RUN_EVENTS_SUFFIX}`);
  }

  /**
   * Public accessor: run 唯一持久件（record 事件流）的绝对路径（RunStore port
   * 实现）。[D1] 快照文件删除后，该指针语义从「state 快照」收敛为 record 流
   * 路径（消费方 = 壳侧 interface 的 stateFile 展示字段）。
   */
  stateFilePath(runId: string): string {
    return this.recordPathFor(runId);
  }

  /**
   * [D1] 显式 no-op：record 单源后 run 域状态变化的持久化 = 事件追加（core
   * worker-message-pump 单写者链落 record 流），壳侧无投影可写。方法保留 =
   * RunStore port 契约（core runWorkflow/recoverCrashedRuns 调用点不改）；恒
   * resolve，零 IO。disposed 前后行为一致（no-op 本身就是收尾安全形态）。
   */
  async save(run: WorkflowRun): Promise<void> {
    logger.debug(
      `[subagent-workflow] record store save: no-op (record stream is the sole persistence, runId=${run.runId})`,
    );
  }

  /**
   * 终局记录查询（record run-settled 帧投影）：生产消费方 = 通知载荷链
   * （runSettledEffects——载荷源帧直取）。miss = 无终局帧（未终局，或流读失败
   * 降级——调用方按「不可判定」处置：通知跳过 + error 留痕，不回退兜底）。
   * 流损坏（RecordStreamCorruptionError）与 IO 错误同走 miss + warn（通知链
   * 不是恢复面，保守 miss 可诊断；恢复面的拒绝语义在 loadAll）。
   */
  settledRecordOf(runId: string): RunSettlementRecord | undefined {
    let events: readonly WorkflowRunEvent[];
    try {
      events = readRecordStream(this.recordPathFor(runId));
    } catch (err) {
      if (!isEnoentError(err)) {
        logger.warn(
          `[subagent-workflow] record stream read failed, settlement record unavailable (runId=${runId}): ${toErrorMessage(err)}`,
        );
      }
      return undefined;
    }
    const settled = lastRunSettledEvent(events);
    if (settled === undefined) return undefined;
    return {
      outcome: settled.outcome,
      ...(settled.errorCode !== undefined ? { errorCode: settled.errorCode } : {}),
      ...(settled.reason !== undefined ? { reason: settled.reason } : {}),
      settledAt: settled.ts,
    };
  }

  /**
   * Reconstruct all runs（[D1] record 流权威重建）。
   *
   * **v2 注册条目定界**：注册条目给出本会话的实体集与 record 流路径锚点 →
   * 逐实体 record 全量读（严格解析）→ fold 重建（终局 ⟸ run-settled 帧；非终局
   * 保持 running 交恢复链收编）；已终局且终态条目缺失 → 幂等补写（条目投影锚
   * 的收编半边；经 rebind 后的 appendEntry 面，stale guard 内置）。
   *
   * **历史实体分流（D1 历史数据处置）**：注册条目 journalPath 锚点后缀非
   * record 后缀 = 旧形态实体（旧 journal 锚点）→ 跳过不重建（历史 run 从壳侧
   * 读取面消失 = 预期行为，不读旧两件套）。
   *
   * **拒绝语义**：record 流存在但读失败（损坏/IO 非 ENOENT）→ 抛错穿透（宿主
   * storeHealthy=false fail-fast，workflow 域停初始化）——静默跳过会把数据损坏
   * 伪装成「无 run 历史」。流缺失（ENOENT）的新形态实体 = 注册后首帧前崩溃 →
   * degraded running 聚合交恢复链收编（静默丢弃会让该实体对恢复链不可见）。
   *
   * [已知限制·登记]（沿用）恢复域 = 本 session 的 entry 集及其锚点：崩溃后用户
   * 不再 resume 原 session 时，原 session 的遗留 run 对新 session 的 loadAll/
   * 恢复链不可见——跨 session 收编需要跨 session 写入语义，与 W17 session 锚定
   * 设计相悖，登记不改；跨进程维度的收编归 runtime 启动扫描（startupSweep）。
   *
   * 需要 ctx（构造时注入）——无 ctx 时返回空（测试或非 Pi 环境下）。
   */
  async loadAll(): Promise<WorkflowRun[]> {
    if (!this.ctx) return [];
    let entries: SessionEntry[];
    try {
      entries = this.ctx.sessionManager.getEntries();
    } catch (err) {
      // getEntries failed — 返回空集（降级语义保持），但必须 error 留痕：静默
      // 空集会把 session 文件读故障伪装成「无 run 历史」，恢复无从下手。
      logger.error(
        `[subagent-workflow] loadAll: getEntries failed, returning empty run set (degraded). Recovery: check session file readability: ${toErrorMessage(err)}`,
      );
      return [];
    }
    // rebuild 的损坏错误（RecordStreamCorruptionError / IO）直接上抛——恢复面
    // 拒绝语义（宿主 storeHealthy=false），不被 getEntries 的降级 catch 吞掉。
    const { registered, settledEntries } = collectEntrySources(entries);
    return this.rebuildRunsFromRecordStreams(registered, settledEntries);
  }

  // ── [D1] record 流权威重建 ────────────────────────────────────

  /**
   * 逐注册条目重建 run：record 流全量读（严格解析）→ fold 重建 → 终局判定
   * （fold 唯一判法）。条目面的唯一参与 = 终态条目幂等补写抑制
   * （settledEntries）——条目不再作为终局证据（旧「journal 无帧而条目在 → 按条
   * 目重建」的双面证据分支随 D1 判读单一裁决删除：条目是投影锚，不是第二判据）。
   */
  private rebuildRunsFromRecordStreams(
    registered: Map<string, WorkflowRecordRegisteredEntryData>,
    settledEntries: Map<string, WorkflowRecordSettledEntryData>,
  ): WorkflowRun[] {
    const runs: WorkflowRun[] = [];
    for (const [runId, reg] of registered) {
      const recordPath = reg.journalPath;
      if (!recordPath.endsWith(RUN_EVENTS_SUFFIX)) {
        // 旧形态锚点（旧 journal .events.jsonl）= 历史 run：不读旧两件套
        //（D1 历史数据处置——历史 run 从壳侧读取面消失，resume 一律拒绝）。
        logger.debug(
          `[subagent-workflow] record store: legacy journal anchor skipped, run not rebuilt (runId=${runId}, anchor=${recordPath})`,
        );
        continue;
      }
      let events: readonly WorkflowRunEvent[];
      try {
        events = readRecordStream(recordPath);
      } catch (err) {
        if (isEnoentError(err)) {
          if (settledEntries.has(runId)) {
            // 流缺失而终态条目在：实体的呈现面归条目读者（runtime 投影 /
            // session-reader），壳侧不重建——不交恢复链（对不在场的流伪造收编
            // 事实）。判读单一不受影响：壳侧不产生任何 done 聚合（条目不是判据，
            // 只是「流已被清理/缺失、无需收编」的存续分流信号）。
            logger.warn(
              `[subagent-workflow] record store: record stream missing but settled entry present, run skipped (runId=${runId}, path=${recordPath})`,
            );
            continue;
          }
          // 新形态实体的 record 流缺失（无终态条目）= 注册后首帧前崩溃：degraded
          // running 基线交恢复链按中断收编（静默跳过会让该实体对恢复链/扫描全部
          // 不可见）。
          logger.warn(
            `[subagent-workflow] record store: record stream missing, degraded rebuild for interruption adoption (runId=${runId}, path=${recordPath})`,
          );
          runs.push(foldRecordStreamToRun(runId, reg, [], settledEntries.get(runId)));
          continue;
        }
        // 损坏 / 真实 IO 错误：拒绝（穿透 → 宿主 fail-fast），不静默降级。
        throw err;
      }
      const settledEvent = lastRunSettledEvent(events);
      if (settledEvent === undefined && settledEntries.has(runId)) {
        // 条目已判终局而 record 流无终局帧（空流/残流）：与流缺失同款存续分流——
        // 实体呈现面归条目读者，壳侧不重建不交恢复链。warn 留证条目与流的分叉
        //（流被外部清空/篡改的信号面；恢复面的拒绝语义只在坏行，空流不拒）。
        logger.warn(
          `[subagent-workflow] record store: settled entry present but record stream has no run-settled frame, run skipped (runId=${runId})`,
        );
        continue;
      }
      const run = foldRecordStreamToRun(runId, reg, events, settledEntries.get(runId));
      runs.push(run);
      // [D6(a) 第 1 步] 终局事实随重建产物带到消费面：fold 判定出「该 run 的 record
      // 流里有 run-settled 帧」后，把帧载荷登记进 core 终局记录注册表——重启后
      // runSummary 投影（展示仍为 done）与 isRunSettled / evictDoneRunsBeyondCap
      // （done run 内存淘汰白名单）据此判定，不再绕道聚合 status 字段读回。
      if (settledEvent !== undefined) {
        noteRebuiltSettlement(runId, settlementRecordOfRunSettledFrame(settledEvent));
      }
      // 终态条目幂等补写：record 已终局而主 session 终态条目缺失（终局 coda 的
      // 条目半边写失败 / 旧版本写点形态）→ 补写；条目已在 → 跳过（双重启不重复
      // 追加的构造性保证）。无 pi（测试/非 Pi 环境）跳过。
      if (settledEvent !== undefined && !settledEntries.has(runId)) {
        this.appendSettledEntryFallback(runId, settledEvent, events);
      }
    }
    return runs;
  }

  /**
   * 终态条目幂等补写（v2 收编面）：载荷经 core barrel 的
   * buildWorkflowRecordSettledEntryData 构造器单源复用（防字段集手抄漂移——壳写
   * 点与 core finalizeRun 写点同一构造；字段源 = record run-settled 帧 + ask
   * 计数投影）。best-effort：appendEntry 失败留痕不阻断 loadAll（条目是投影锚，
   * 下次 loadAll 幂等重试）。
   */
  private appendSettledEntryFallback(
    runId: string,
    settledEvent: RunSettledFrame,
    events: readonly WorkflowRunEvent[],
  ): void {
    if (!this.pi) return;
    const data = buildWorkflowRecordSettledEntryData({
      runId,
      reason: runSettledOutcomeToDoneReason(settledEvent.outcome, settledEvent.errorCode),
      outcome: settledEvent.outcome,
      ...(settledEvent.errorCode !== undefined ? { errorCode: settledEvent.errorCode } : {}),
      settledAt: settledEvent.ts,
      callCount: events.filter((e) => e.type === "agent-settled").length,
      // [§2.1b] 由 agent-settled.result.usage 推导（core 单源加权口径；此前硬编码 0，
      // 展示层把补写条目显示成零消耗）
      usedTokens: runAccountingFromEvents(events).usedTokens,
    });
    try {
      this.pi.appendEntry(WORKFLOW_RECORD_CUSTOM_TYPE, data);
    } catch (err) {
      logger.warn(
        `[subagent-workflow] v2 settled entry backfill failed (runId=${runId}): ${toErrorMessage(err)}`,
      );
    }
  }

  // ── 生命周期面（无投影物化面后的契约保留）────────────────────

  /**
   * [D1] 无 pending 批（无投影物化面）——立即返回。方法保留 = 生命周期面契约
   *（dispose / 排查调用点不改）。
   */
  async flushPendingSaves(): Promise<void> {}

  /**
   * 收尾：幂等（缓存自身 Promise——首次未完成时并发交叠进入的后续调用返回同一
   * Promise）。[D1] 无物化面可冲刷（无批/timer/watcher），置位 disposed 后返回。
   *
   * 本方法不能是 async 函数（async 总是创建新 Promise 破坏同一引用保证）。
   */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = Promise.resolve();
    return this.disposePromise;
  }

  /**
   * [skill-reload D3] adoption 就地重绑：post-reload session_start 接管（adoption）
   * 时原地改写 appendEntry 源与 ctx——store 实例跨 reload 存活（D2 槽）。
   * [W1] 换入的 appendEntry 源的消费方 = loadAll 的 v2 终态条目幂等补写（收编/
   * 调和面）；stale guard 语义不变（窗口内 appendEntry 统一 debug 丢弃——条目是
   * 投影锚，缺失由下次 loadAll 幂等补写自愈）。
   */
  rebind(pi: ExtensionAPI, ctx: ExtensionContext): void {
    this.pi = {
      appendEntry: (customType: string, data?: unknown) => {
        guardStaleCtx(() => pi.appendEntry(customType, data), {
          label: "subagent-workflow:jsonl-run-store.appendEntry",
          // 「统一 stale → debug 丢弃」：窗口内丢弃是设计内降级，debug 留痕可归因
          onStale: (error) =>
            logger.debug(
              "[subagent-workflow] workflow-record entry append skipped (stale ctx)",
              { reason: toErrorMessage(error) },
            ),
        });
      },
    };
    this.ctx = ctx;
  }
}
