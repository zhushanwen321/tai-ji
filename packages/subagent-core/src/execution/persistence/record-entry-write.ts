/**
 * v2 条目构造族 + v2 定界扫描 + 收编组装（纯函数族，自 record-store-terminal 拆出）。
 *
 * 变化轴 = 「v2 条目与事件载荷的构造规则」（契约演化集中于此）——终局写点
 * （markSettled/archive/收编）的载荷构造单源。字段集契约单源 = record-entry.ts
 * （u0）；事件词表与 fold 单源 = record-events.ts（u0）。
 */
import { SUBAGENT_RECORD_CUSTOM_TYPE, SUBAGENT_RECORD_ENTRY_VERSION, classifySubagentRecordEntryData } from "./record-entry.ts";
import type {
  SubagentRecordRegisteredEntryData,
  SubagentRecordSettledEntryData,
} from "./record-entry.ts";
import type { StopReason } from "../domain/record-types.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import type { ManifestRecord } from "./manifest-store.ts";
import type { RecordEventFoldState, RecordEventInput } from "./record-events.ts";
import type { SubagentRecord } from "../assembly/types.ts";
import { resolveEngineRouteId } from "../engine/common/session-view-service.ts";

// ============================================================
// [W1 / U2a] v2 条目构造族 + v2 定界扫描 + 收编组装（纯函数族）
// ============================================================
//
// 变化轴 = 「v2 条目与事件载荷的构造规则」（契约演化集中于此）——终局写点
// （markSettled/archive/收编）的载荷构造单源。字段集契约单源 = record-entry.ts
// （u0）；事件词表与 fold 单源 = record-events.ts（u0）。

/** v2 注册条目 data（register 写点；undefined 身份域归一：origin → "tool"、rootSessionId → ""）。 */
export function toRegisteredEntryData(
  record: { id: string; agent: string; task: string; slug: string; origin?: string; parentRunId?: string; stepIndex?: number; rootSessionId?: string; parentRecordId?: string; depth: number; startedAt: number },
): SubagentRecordRegisteredEntryData {
  return {
    v: SUBAGENT_RECORD_ENTRY_VERSION,
    kind: "registered",
    id: record.id,
    agent: record.agent,
    task: record.task,
    slug: record.slug,
    origin: record.origin === "workflow" ? "workflow" : "tool",
    ...(record.parentRunId !== undefined ? { parentRunId: record.parentRunId } : {}),
    ...(record.stepIndex !== undefined ? { stepIndex: record.stepIndex } : {}),
    rootSessionId: record.rootSessionId ?? "",
    ...(record.parentRecordId !== undefined ? { parentRecordId: record.parentRecordId } : {}),
    depth: record.depth,
    startedAt: record.startedAt,
  };
}

/** v2 终态条目构造载荷（终局写点共用输入面——ExecutionRecord 的统计/终局域字段子集）。 */
export interface SettledEntrySource { // oe-exempt:20261001:framework:v2 终态条目构造载荷契约——自 record-store-terminal 原样搬迁（拆文件非新抽象），读侧消费 = record-store-rounds
  id: string;
  status: string;
  stopReason?: StopReason;
  outcome?: SubagentRecord["outcome"];
  error?: string;
  turnCount: number;
  totalTokens: number;
  model: string | undefined;
  thinkingLevel: string | undefined;
  engine?: string;
  engineHandle?: SubagentRecord["engineHandle"];
  sessionFile?: string;
  result?: string;
}

/**
 * ExecutionRecord → SettledEntrySource 映射（终局写点共用：容器终局写点与
 * face 缺省分支同款消费——条目面独立于事件面工作时载荷构造单源）。
 */
export function settledEntrySourceOf(record: ExecutionRecord): SettledEntrySource {
  return {
    id: record.id,
    status: record.status,
    stopReason: record.stopReason,
    outcome: record.outcome,
    error: record.error !== undefined && record.error.length > 0 ? record.error : undefined,
    turnCount: record.turnCount,
    totalTokens: record.totalTokens,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    engine: record.engine,
    engineHandle: record.engineHandle,
    sessionFile: record.sessionFile,
    result: record.result,
  };
}

/** v2 终态条目 data（终局写点共用：archive 真终局 / markSettled / 收编幂等补写）。 */
export function toSettledEntryData(source: SettledEntrySource, endedAt: number): SubagentRecordSettledEntryData {
  return {
    v: SUBAGENT_RECORD_ENTRY_VERSION,
    kind: "settled",
    id: source.id,
    status: "idle",
    stopReason: source.stopReason ?? "interrupted-by-restart",
    ...(source.outcome !== undefined ? { outcome: source.outcome } : {}),
    ...(source.error !== undefined ? { error: source.error } : {}),
    endedAt,
    turns: source.turnCount,
    totalTokens: source.totalTokens,
    model: source.model,
    thinkingLevel: source.thinkingLevel,
    ...(source.engine !== undefined ? { engine: source.engine } : {}),
    ...(source.engineHandle !== undefined ? { engineHandle: source.engineHandle } : {}),
    ...(source.sessionFile !== undefined ? { sessionFile: source.sessionFile } : {}),
    ...(source.result !== undefined ? { result: source.result } : {}),
  };
}

/** record-settled 帧的 result 摘要锚长度（截断摘要——全文只在 v2 终态条目一次性写）。 */
const SETTLED_RESULT_SUMMARY_MAX_CHARS = 200;

export function summarizeResultForJournal(result: string | undefined): string | undefined {
  if (result === undefined || result.length === 0) return undefined;
  return result.length <= SETTLED_RESULT_SUMMARY_MAX_CHARS
    ? result
    : `${result.slice(0, SETTLED_RESULT_SUMMARY_MAX_CHARS)}…`;
}

/** v2 条目定界状态（registered 定界 + settled 幂等证据）。 */
export interface V2EntryState { // oe-exempt:20261001:framework:v2 条目定界扫描产物契约——自 record-store-terminal 原样搬迁（拆文件非新抽象），消费方 = record-store / record-store-rounds
  registered: boolean;
  settled: boolean;
  /** 末条 settled 条目的停因（D4 双面证据第二条的判别输入——interrupted 族条目
   * 不构成「非 interrupted 终态」跳过证据，收编须放行修复 journal）。 */
  settledStopReason: StopReason | undefined;
  rootSessionId: string | undefined;
}

/**
 * 主 session 内容 → 每 id 的 v2 条目定界状态（收编双面证据第二条，D4）。
 * 判定单源 = classifySubagentRecordEntryData（登记 §3.3 后 v2-only，旧形态已删）。
 * 快过滤与 collectV2EntryPairs 同款（customType 子串）。
 */
export function collectV2EntryState(content: string): Map<string, V2EntryState> {
  const out = new Map<string, V2EntryState>();
  for (const line of content.split("\n")) {
    if (!line.includes(SUBAGENT_RECORD_CUSTOM_TYPE)) continue; // 快过滤（绝大多数行不是本类型）
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 截断/异构行跳过（主文件末行可能正被写入）
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.type !== "custom" || obj.customType !== SUBAGENT_RECORD_CUSTOM_TYPE) continue;
    const verdict = classifySubagentRecordEntryData(obj.data);
    if (verdict.ok) {
      const entry = verdict.entry;
      const prev =
        out.get(entry.id) ?? { registered: false, settled: false, settledStopReason: undefined, rootSessionId: undefined };
      if (entry.kind === "registered") {
        prev.registered = true;
        prev.rootSessionId = entry.rootSessionId;
      } else {
        prev.settled = true;
        prev.settledStopReason = entry.stopReason;
      }
      out.set(entry.id, prev);
    }
  }
  return out;
}

/**
 * interrupted 族停因（StopReason 的中断子族——重启收编语义；与 runtime
 * workflow-step-merge 的状态映射常量同词表，消费形态不同不共享实体）。
 */
const INTERRUPTED_FAMILY_STOP_REASONS: readonly string[] = [
  "interrupted",
  "interrupted-by-restart",
  "interrupted-by-parent",
];

/**
 * D4 双面证据第二条的判别（「终态条目已存在且非 interrupted」）：settled 条目
 * 在场且停因非 interrupted 族才构成跳过证据——interrupted 族条目是「条目面先行
 * 写、journal 帧缺失」的不对称窗口残留（appendEvent fire-and-forget 失败 /
 * 局部损坏），不构成跳过证据，收编须放行以追加 settled 帧修复 journal；停因
 * 缺失（契约外残缺形态）保守计为真终态（宁保留不重复）。
 */
export function isNonInterruptedSettledEvidence(st: V2EntryState | undefined): boolean {
  if (st?.settled !== true) return false;
  if (st.settledStopReason === undefined) return true;
  return !INTERRUPTED_FAMILY_STOP_REASONS.includes(st.settledStopReason);
}

/** 收编产物的 v2 终态条目（fold + 收编停因组装——model/thinkingLevel 收编形态 undefined 诚实缺省：journal 无此数据源）。 */
export function buildAdoptedSettledEntry(
  fold: RecordEventFoldState,
  id: string,
  stopReason: StopReason,
  now: number,
): SubagentRecordSettledEntryData {
  const bound = fold.bound;
  return {
    v: SUBAGENT_RECORD_ENTRY_VERSION,
    kind: "settled",
    id,
    status: "idle",
    stopReason,
    endedAt: now,
    turns: fold.roundIdle?.turns ?? 0,
    totalTokens: fold.roundIdle?.totalTokens ?? 0,
    model: undefined,
    thinkingLevel: undefined,
    ...(bound !== undefined ? { engine: bound.engine } : {}),
    ...(bound !== undefined ? { engineHandle: bound.engineHandle } : {}),
    ...(bound !== undefined && bound.sessionFile !== "" ? { sessionFile: bound.sessionFile } : {}),
  };
}

/**
 * entry-only 孤儿纠偏产物（登记 §3.3）：主 session 有 v2 注册条目、无子 session 文件、
 * 无事件文件（spawn 窗口期死亡）时的终态条目。事件面缺席 → 统计诚实 0，停因缺省
 * interrupted-by-restart；身份域无载荷可补（注册条目已在场）。
 */
export function buildEntryOnlyOrphanSettledEntry(
  id: string,
  stopReason: StopReason,
  now: number,
): SubagentRecordSettledEntryData {
  return {
    v: SUBAGENT_RECORD_ENTRY_VERSION,
    kind: "settled",
    id,
    status: "idle",
    stopReason,
    endedAt: now,
    turns: 0,
    totalTokens: 0,
    model: undefined,
    thinkingLevel: undefined,
  };
}

/** 收编产物的 record-settled 帧（统计终值取 fold 轮终快照、缺帧诚实 0——判定半边在容器）。 */
export function buildAdoptedSettledEvent(
  fold: RecordEventFoldState,
  id: string,
  stopReason: StopReason,
  now: number,
): RecordEventInput {
  return {
    type: "record-settled",
    ts: now,
    stopReason,
    endedAt: now,
    turns: fold.roundIdle?.turns ?? 0,
    totalTokens: fold.roundIdle?.totalTokens ?? 0,
  };
}

/** 收编产物的 manifest 投影（derivedManifestRecord 同族形态——身份域取 created 帧、引擎域取 bound 帧、终局域取收编停因）。 */
export function buildAdoptedManifestProjection(
  fold: RecordEventFoldState,
  id: string,
  stopReason: StopReason,
  now: number,
): ManifestRecord | undefined {
  const identity = fold.identity;
  if (identity === undefined) return undefined; // 坏链守卫在容器侧先行（skippedNoIdentity）
  const bound = fold.bound;
  return {
    id,
    rootSessionId: identity.rootSessionId || "",
    agentName: identity.agent,
    status: "running", // legacy 三态投影：无 closedReason → running（executionStatus 承载两态权威词）
    executionStatus: "idle",
    // [W4 收敛] 收编停因上投影：sweep 判据第三级（findAdoptedStopReasonSync）经它把
    // 收编 record 判 terminal，注销条目 reason 落 interrupted 族（mapReasonToStatus
    // → aborted），不再误走 missing 分支的 expired。
    stopReason,
    createdAt: identity.startedAt,
    completedAt: now,
    ...(bound !== undefined && bound.sessionFile !== "" ? { sessionFile: bound.sessionFile } : {}),
    task: identity.task,
    slug: identity.slug,
    ...(bound !== undefined ? { engine: bound.engine } : {}),
    ...(bound !== undefined ? { engineHandle: bound.engineHandle } : {}),
    // [H2 W1 / D3 缺陷五] 来源身份与覆盖记账随收编投影下行（identity created 帧承载
    // 身份、fold 承载覆盖——收编的 workflow 成员对 run 级查询保持可见）。
    ...(identity.origin === "workflow" ? { origin: "workflow" as const } : {}),
    ...(identity.parentRunId !== undefined ? { parentRunId: identity.parentRunId } : {}),
    ...(identity.stepIndex !== undefined ? { stepIndex: identity.stepIndex } : {}),
    ...(fold.modelOverride !== undefined
      ? {
          modelOverride: {
            ref: fold.modelOverride.ref,
            ...(fold.modelOverride.thinkingLevel !== undefined
              ? { thinkingLevel: fold.modelOverride.thinkingLevel }
              : {}),
            setAt: fold.modelOverride.setAt,
          },
        }
      : {}),
  };
}

// ── [W1 / D3] 事件帧载荷构造与引擎域签名（record-created/bound/settled——容器写
// ── 点的载荷构造半边；幂等判定与 append 编排留在容器）──────────────

/** record-created 帧载荷（register 写点——D3 表行 1 身份域全量）。 */
export function buildCreatedEventPayload(
  record: ExecutionRecord,
): RecordEventInput {
  return {
    type: "record-created",
    ts: record.startedAt,
    id: record.id,
    agent: record.agent,
    task: record.task,
    slug: record.slug,
    origin: record.origin === "workflow" ? "workflow" : "tool",
    ...(record.parentRunId !== undefined ? { parentRunId: record.parentRunId } : {}),
    ...(record.stepIndex !== undefined ? { stepIndex: record.stepIndex } : {}),
    rootSessionId: record.rootSessionId ?? "",
    ...(record.parentRecordId !== undefined ? { parentRecordId: record.parentRecordId } : {}),
    depth: record.depth,
    mode: record.mode,
    startedAt: record.startedAt,
    // 事件流自承载绑定侧的独有字段（.record-binding 退场的前置）：模型/档位/worktree
    // 在创建期已知，写入本事件；缺省不落键（undefined = 未指定语义）。
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.thinkingLevel !== undefined ? { thinkingLevel: record.thinkingLevel } : {}),
    ...(record.hadWorktree === true ? { worktree: true } : {}),
  };
}

/**
 * 引擎域签名对比（reportRecordTransition 写点——D3 表行 2）。归一形态：pi record
 * 的 engineHandle 缺省 = 空 sessionRef 桶（落账与对比共用同一归一，避免「record
 * 缺省 undefined vs 落账归一值」的伪差异把每次过程 transition 都误判为引擎域变化，
 * 事件面随高频调用放大）。签名三元组 = sessionFile/engine/engineHandle；**epoch
 * 不参与签名**——epoch 递增由 record-reopened 帧单点承载（D3 表行 6），reopen 后
 * 的 transition 再落 bound 帧会重复表达同一迁移。
 */
export function isBoundSignatureUnchanged(
  bound: { sessionFile: string; engine: string; engineHandle: { sessionRef: Record<string, string>; eventsPath?: string; poolKey: string } } | undefined,
  sessionFile: string | undefined,
  engine: string | undefined,
  engineHandle: ExecutionRecord["engineHandle"],
): boolean {
  if (bound === undefined) return false;
  const normEngine = engine ?? "pi";
  const normHandle = engineHandle ?? { sessionRef: {}, poolKey: "shared" };
  return (
    bound.sessionFile === (sessionFile ?? "") &&
    bound.engine === normEngine &&
    JSON.stringify(bound.engineHandle) === JSON.stringify(normHandle)
  );
}

/** record-bound 帧载荷（spawn 回填——引擎域归一形态同签名对比）。 */
export function buildBoundEventPayload(
  record: ExecutionRecord,
): RecordEventInput {
  return {
    type: "record-bound",
    ts: Date.now(),
    sessionFile: record.sessionFile ?? "",
    // 写侧同源裁决：损坏 record（有锚无 engine）不得被写成 engine='pi'——那是把
    // 读数损坏固化成合法投影；正常 pi record 仍按缺省写 pi。
    engine: resolveEngineRouteId(record, record.id),
    engineHandle: record.engineHandle ?? { sessionRef: {}, poolKey: "shared" },
    epoch: record.epoch ?? 0,
  };
}

/** record-settled 帧载荷（终局写点——stopReason 缺省 interrupted 保守兜底）。 */
export function buildSettledEventPayload(
  record: ExecutionRecord,
  endedAt: number,
): RecordEventInput {
  return {
    type: "record-settled",
    ts: endedAt,
    stopReason: record.stopReason ?? "interrupted",
    ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
    ...(record.error !== undefined && record.error.length > 0 ? { error: record.error } : {}),
    endedAt,
    turns: record.turnCount,
    totalTokens: record.totalTokens,
    ...(summarizeResultForJournal(record.result) !== undefined
      ? { resultSummary: summarizeResultForJournal(record.result) }
      : {}),
  };
}
