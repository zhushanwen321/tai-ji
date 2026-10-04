/**
 * 事件投影（W1 [D6]：runtime 读侧换源——每会话内存投影，读请求唯一数据源）。
 *
 * 双源单点合并（设计 w1-run-record-journal-authority §3.1 环节 B / §3.3 D6）：
 * - entry 源：主 session 条目（v2 注册/终态两条小条目）——
 *   活跃会话经既有 get_entries 游标通道喂入（applyEntryBatch），冷会话经
 *   scanRecordFamilyEntriesFromSessionFile 流式扫描喂入（同一入口）；
 * - 事件源：record 事件文件（`<recordsDir>/<sa-id>.events`）与 run journal
 *   （`<sessionDir>/workflow-state/<runId>.record.jsonl`，后缀常量
 *   RUN_EVENTS_SUFFIX 单源）——经 u0 event-tail
 *   目录 tailer（watch + offset 续读 + 周期复查）增量 fold。run 域 fold 自
 *   [W2 D7] 起单源 core run-events foldRunEventCheckpoint（状态机检查点 + 投影
 *   骨架 created/asks/runSettled 一体产出），runtime 不再自建 fold。
 *
 * 仲裁规则（事件源胜出 / 窗外条目兜底）：同实体两源都有数据时 事件流 事件
 * 胜出（事实源）；事件源被保留通道清理（窗外终态实体）后 entry 终态条目是
 * 唯一来源。v1 全量快照兼容层已随「项目未上线、无 v1 数据」整体删除（登记 §3.3，
 * 2026-09-30）——投影只认 v2 条目 + 事件 fold，不再有「v1 冻结定界优先」的实体级
 * 拦截（那正是「投影遮蔽事件流」的方向性缺陷本体）。
 *
 * 与 W0 的衔接（水位/合并喂入退役）：步骤视图合并（mergeWorkflowStepRecords
 * 纯函数保留）的输入从「entry 通道派生缓存」换成本投影的合并快照——冷热两路
 * 在本模块单点收敛，session-records 不再各自喂入。
 *
 * 流式读上界（32MB 预检退役为旧格式兼容路径专属的对应面）：新路径的会话文件
 * 流式扫描（session-file-extraction.ts 的 scanRecordFamilyEntriesFromSessionFile，
 * 按块读 + 行预过滤，扫描字节上界 = READ_PRECHECK_MAX_BYTES）；事件文件按
 * tail 原语只读完整行边界。
 */

import type { SubagentRecord, WorkflowRunRecord } from '@taiji/shared'
import {
  ALL_RUN_OUTCOMES,
  foldRunEventCheckpoint,
  INITIAL_RUN_EVENT_FOLD,
  RUN_EVENTS_SUFFIX,
  RUN_EVENT_TYPES,
  SUBAGENT_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_CUSTOM_TYPE,
  classifySubagentRecordEntryData,
  classifyWorkflowRecordEntryData,
  createEventDirectoryTailer,
  foldRecordEvents,
  INITIAL_RECORD_EVENT_FOLD_STATE,
  parseRecordEventFileLine,
  RECORD_EVENTS_SUFFIX,
  type EventDirectoryTailer,
  type RecordCreatedEvent,
  type RecordEvent,
  type RecordEventFoldState,
  type RunEventFoldCheckpoint,
  type SubagentRecordRegisteredEntryData,
  type SubagentRecordSettledEntryData,
  type WorkflowRecordRegisteredEntryData,
  type WorkflowRecordSettledEntryData,
  type WorkflowRunEvent,
} from '@zhushanwen/subagent-core'

import { mergeWorkflowStepRecords } from './workflow-step-merge.js'
import { projectV2Workflow } from "./workflow-record-projection.js"
import { logger } from '../../infra/logger.js'

// ── run journal 行解析（域无关 tail 原语的 run 域注入）─────────

/**
 * run 事件 type 词表集合（词表 SSOT = core run-events RUN_EVENT_TYPES，经 barrel
 * 消费——判定面与 core isWorkflowRunEventLine 同词表单源）。编译期穷尽守卫双向：
 * Set 构造泛型校验「词表 ⊆ WorkflowRunEvent['type'] 判别联合」，下方编译锁校验
 * 反向「union 成员 ⊆ 词表」——core 词表增删成员时漂移在编译期显形，运行时零漂移面。
 * 词表外历史行（ask-executing / member-pool 等删值成员）经词表外判定返回
 * undefined，由 tailer 跳过计日志。
 */
const RUN_EVENT_TYPE_SET: ReadonlySet<string> = new Set<WorkflowRunEvent['type']>(RUN_EVENT_TYPES)

// 编译锁（纯类型，零运行时）：union 成员缺席词表 → Exclude 非 never → 三元求值
// never，赋值处编译红（先例：subagent-engine-sdk wire-field-locks 的
// _assertNoDoubleWrite 同款形态）
const _assertRunEventTypeWordlist: Exclude<
  WorkflowRunEvent['type'],
  (typeof RUN_EVENT_TYPES)[number]
> extends never ? true : never = true

/**
 * run journal 文件行解析器（event-tail parseLine 注入面，run 域）。
 *
 * 守卫对齐 core run-events isWorkflowRunEventLine 的最宽共同判定面：JSON 对象 +
 * type 落词表 + ts 有限数值 + seq（携带时）正安全整数 + outcome（agent-settled /
 * run-settled 携带时）落词表。seq 缺失放行——W1 前存量 事件行无该字段（D7
 * 惰性兼容读，旧行为不变）。坏行返回 undefined 交 tailer 计数（宽容跳过，不卡游标）。
 */
export function parseWorkflowRunEventFileLine(line: string): WorkflowRunEvent | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const rec = parsed as { type?: unknown; ts?: unknown; seq?: unknown; outcome?: unknown }
  if (typeof rec.type !== 'string' || !RUN_EVENT_TYPE_SET.has(rec.type)) return undefined
  if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts)) return undefined
  if (
    rec.seq !== undefined &&
    (typeof rec.seq !== 'number' || !Number.isSafeInteger(rec.seq) || rec.seq < 1)
  ) {
    return undefined
  }
  if (
    rec.outcome !== undefined &&
    !(ALL_RUN_OUTCOMES as readonly string[]).includes(rec.outcome as string)
  ) {
    return undefined
  }
  return parsed as WorkflowRunEvent
}

// ── run journal fold（[W2 D7] 单源删除）───────────────────────
//
// run 域 journal fold 收敛到 core 原语：core run-events foldRunEventCheckpoint
// 的产出（RunEventFoldCheckpoint = 状态机检查点 state/lastSeq + 投影骨架
// created/asks/runSettled）即本投影的 run 骨架数据源——runtime 不再自建第二套
// fold（词表/骨架语义随 core 单源演进，双实现漂移病因消灭）。tailer 增量批次
// 经 checkpoint 传参接续（见 applyRunEvents），投影合成读骨架半边
// （projectV2Workflow）。

// ── v2 条目载荷守卫（classify 只判 v/kind，字段形状归本层）─────
//
// kind 判别联合的成员访问已由 classify 的 entry 载荷窄化承载；此处仅补 classify
// 不校验的最小运行时键守卫（id/runId/recordPath 的 typeof 检查——防御截断半写
// 形态），不再重复形状校验。

/** v2 条目族扫描结果（entry 源的 v2 半边）。 */
export interface V2EntryScan { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  subagentRegistered: Map<string, SubagentRecordRegisteredEntryData>
  subagentSettled: Map<string, SubagentRecordSettledEntryData>
  workflowRegistered: Map<string, WorkflowRecordRegisteredEntryData>
  workflowSettled: Map<string, WorkflowRecordSettledEntryData>
}

/** [scanV2RecordEntries 拆分] subagent 域 v2 条目收编（classify 单源判 v/kind，id 键守卫归本层）。 */
function scanSubagentV2Entry(data: unknown, result: V2EntryScan): void {
  const classification = classifySubagentRecordEntryData(data)
  if (!classification.ok) return
  const v2 = classification.entry
  if (v2.kind === 'registered' && typeof v2.id === 'string') {
    result.subagentRegistered.set(v2.id, v2)
  } else if (v2.kind === 'settled' && typeof v2.id === 'string') {
    result.subagentSettled.set(v2.id, v2)
  }
}

/** [scanV2RecordEntries 拆分] workflow 域 v2 条目收编（runId/recordPath 键守卫归本层）。 */
function scanWorkflowV2Entry(data: unknown, result: V2EntryScan): void {
  const classification = classifyWorkflowRecordEntryData(data)
  if (classification.ok || classification.reason !== 'v2') return
  const v2 = classification.entry
  if (
    v2.kind === 'registered' &&
    typeof v2.runId === 'string' &&
    typeof v2.recordPath === 'string'
  ) {
    result.workflowRegistered.set(v2.runId, v2)
  } else if (v2.kind === 'settled' && typeof v2.runId === 'string') {
    result.workflowSettled.set(v2.runId, v2)
  }
}

/**
 * entry 批 → v2 注册/终态条目（classify 单源判 v/kind，字段守卫归本层）。
 *
 * 同 id 后到覆盖（append-only 语义：注册条目恰一条、终态条目收编补写同形态）。
 * 词表外形态（future-v / unknown-kind）静默跳过——坏行宽容，不炸投影。
 */
export function scanV2RecordEntries(entries: readonly unknown[]): V2EntryScan {
  const result: V2EntryScan = {
    subagentRegistered: new Map(),
    subagentSettled: new Map(),
    workflowRegistered: new Map(),
    workflowSettled: new Map(),
  }
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as { type?: unknown; customType?: unknown; data?: unknown }
    if (e.type !== 'custom') continue
    if (e.customType === SUBAGENT_RECORD_CUSTOM_TYPE) {
      scanSubagentV2Entry(e.data, result)
    } else if (e.customType === WORKFLOW_RECORD_CUSTOM_TYPE) {
      scanWorkflowV2Entry(e.data, result)
    }
  }
  return result
}

// ── 合并仲裁纯函数（事件源胜出 / 窗外条目兜底）─────


/** 秒→ms 换算常数（elapsedSeconds 秒契约 ← startedAt/endedAt ms 差值）。 */
const MS_PER_SECOND = 1000

function deriveElapsedSeconds(
  startedAt: number | undefined,
  endedAt: number | undefined,
): number | undefined {
  return startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
    ? Math.round((endedAt - startedAt) / MS_PER_SECOND)
    : undefined
}

/**
 * [projectV2Subagent 拆分] status 两态判据（事件源胜出仲裁的字段级子函数）。
 *
 * status 是两态判据不是终局吸收位判据：轮终收条（record-round-idle，v1 权威词
 * idle 同源）与 reopened（CAS 只接受 idle、不翻 running）都映射 idle；不能用
 * roundIdle 在场判 idle（round-started 不清 roundIdle），以 lastEvent.type 判。
 * fold 在场（含事件文件）时由 fold 定态；窗外无 fold 时终态条目兜底。
 */
function resolveSubagentStatus(
  fold: RecordEventFoldState | undefined,
  settledEntry: SubagentRecordSettledEntryData | undefined,
): SubagentRecord['status'] {
  if (fold === undefined) {
    return settledEntry !== undefined ? 'idle' : 'running'
  }
  const lastType = fold.lastEvent?.type
  if (fold.settled !== undefined || lastType === 'record-round-idle' || lastType === 'record-reopened') {
    return 'idle'
  }
  return 'running'
}

/**
 * [projectV2Subagent 拆分] 停因供源（随 status 判据同构分流，v1 写侧语义延续）：
 * settled 终局停因 → 轮终收条停因（lastEvent 为 round-idle 时 roundIdle 即最新收条）
 * → reopened 窗口展示词（事件词表 record-reopened 无停因载荷，由 lastEvent.type 映射
 * ——对齐 v1 markReopenedImpl 写 stopReason='reopened'）；在飞（round-started /
 * created / bound）轮始清点无停因——roundIdle/settledEntry 的旧值不得透传（v1
 * markRoundStartedImpl 上轮停因随轮始清点 + isOccupied 的 stopReason 子句依赖；
 * F2-1：第二轮 running + 「completed」矛盾组合即旧值透传所致）。
 */
function resolveSubagentStopReason(
  fold: RecordEventFoldState | undefined,
  settled: RecordEventFoldState['settled'],
  roundIdle: RecordEventFoldState['roundIdle'],
  settledEntry: SubagentRecordSettledEntryData | undefined,
): string | undefined {
  if (fold === undefined) return settledEntry?.stopReason
  if (settled !== undefined) return settled.stopReason
  const lastType = fold.lastEvent?.type
  if (lastType === 'record-round-idle') return roundIdle?.stopReason
  if (lastType === 'record-reopened') return 'reopened'
  return undefined
}

/**
 * [projectV2Subagent 拆分] error 供源（与 stopReason 分流同构，W1 终态同步 F2-2
 * 裁决）：settled 终局原文 → 轮终失败收条（round-started 后 lastEvent 非
 * round-idle，上轮失败原文随轮始清点语义不透传——对齐 v1 markRoundStartedImpl
 * 清残留死因）→ 条目面兜底（fold 缺席 = 事件流未接线的旧实体）。
 */
function resolveSubagentError(
  fold: RecordEventFoldState | undefined,
  settled: RecordEventFoldState['settled'],
  roundIdle: RecordEventFoldState['roundIdle'],
  settledEntry: SubagentRecordSettledEntryData | undefined,
): string | undefined {
  if (fold === undefined) return settledEntry?.error
  if (settled !== undefined) return settled.error
  if (fold.lastEvent?.type === 'record-round-idle') return roundIdle?.error
  return undefined
}

/**
 * [projectV2Subagent 拆分] result 供源（W1 轮终粒度裁决：record-round-idle 携带
 * result 摘要锚，承接 v1 U8b 轮终 result 显示信号）：轮终收条晚于终局面（settled
 * 已被 reopened / round-started 清除，或 roundIdle.seq 更新）时轮终摘要胜出——
 * 否则终局面优先（v2 终态条目全文是 D1 唯一全文落点，摘要锚兜底）。
 */
function resolveSubagentResult(
  settled: RecordEventFoldState['settled'],
  roundIdle: RecordEventFoldState['roundIdle'],
  settledEntry: SubagentRecordSettledEntryData | undefined,
): string | undefined {
  if (roundIdle !== undefined && (settled === undefined || roundIdle.seq > settled.seq)) {
    return roundIdle.resultSummary ?? settledEntry?.result ?? settled?.resultSummary
  }
  return settledEntry?.result ?? settled?.resultSummary
}

/**
 * [projectV2Subagent 拆分] 统计字段归并：settled 终局 → 轮终收条（roundIdle）→
 * 条目面兜底（事件 fold 缺席 = 事件流未接线的旧实体）。
 */
function resolveSubagentStats(
  settled: RecordEventFoldState['settled'],
  roundIdle: RecordEventFoldState['roundIdle'],
  settledEntry: SubagentRecordSettledEntryData | undefined,
): { turns: number | undefined; totalTokens: number | undefined } {
  return {
    turns: settled?.turns ?? roundIdle?.turns ?? settledEntry?.turns,
    totalTokens:
      settled?.totalTokens ?? roundIdle?.totalTokens ?? settledEntry?.totalTokens,
  }
}

/**
 * [projectV2Subagent 拆分] 绑定半边归并：engine 绑定（record-bound 事件）优先，
 * 条目面兜底；sessionFile 同构（bound 携带则胜出，null 为契约缺省）。engineHandle
 * 两侧形态不同（bound = 结构化 sessionRef 整体透传，entry = 同形字符串）——返回
 * 类型按原组装表达式自然推导（union），不在此窄化。
 */
function resolveSubagentBinding(
  bound: RecordEventFoldState['bound'],
  settledEntry: SubagentRecordSettledEntryData | undefined,
) {
  return {
    sessionFile: bound?.sessionFile ?? settledEntry?.sessionFile ?? null,
    engine: bound?.engine ?? settledEntry?.engine,
    engineHandle: bound?.engineHandle ?? settledEntry?.engineHandle,
  }
}

/**
 * v2 subagent 实体的合并投影（事件源胜出仲裁的核心）。
 *
 * - 身份域：事件 fold 的 record-created（事实源）优先，注册条目兜底（事件源
 *   被清理的窗外实体）；两者皆缺（无身份锚点）返回 null——正常流注册条目先于
 *   终态条目落盘，终态单独在场属半写残形态。
 * - 运行态（status/stopReason/统计/engine 绑定）：事件 fold 优先；事件 fold 缺席
 *   （窗外）时终态条目兜底。
 * - 仅条目有的字段（model/thinkingLevel/result 全文）：条目填充——事件文件只存
 *   result 摘要锚（D3），全文唯一落点是 v2 终态条目。
 */
export function projectV2Subagent(
  registered: SubagentRecordRegisteredEntryData | undefined,
  settledEntry: SubagentRecordSettledEntryData | undefined,
  fold: RecordEventFoldState | undefined,
): SubagentRecord | null {
  const identity: RecordCreatedEvent | SubagentRecordRegisteredEntryData | undefined =
    fold?.identity ?? registered
  if (identity === undefined) return null
  const settled = fold?.settled
  const roundIdle = fold?.roundIdle
  const startedAt = identity.startedAt
  const endedAt = settled?.endedAt ?? settledEntry?.endedAt
  const stats = resolveSubagentStats(settled, roundIdle, settledEntry)
  const binding = resolveSubagentBinding(fold?.bound, settledEntry)
  return {
    subagentId: identity.id,
    sessionFile: binding.sessionFile,
    agent: identity.agent,
    slug: identity.slug,
    task: identity.task,
    status: resolveSubagentStatus(fold, settledEntry),
    stopReason: resolveSubagentStopReason(fold, settled, roundIdle, settledEntry),
    turns: stats.turns,
    totalTokens: stats.totalTokens,
    model: settledEntry?.model,
    thinkingLevel: settledEntry?.thinkingLevel,
    startedAt,
    endedAt,
    elapsedSeconds: deriveElapsedSeconds(startedAt, endedAt),
    error: resolveSubagentError(fold, settled, roundIdle, settledEntry),
    origin: identity.origin,
    parentRunId: identity.parentRunId,
    stepIndex: identity.stepIndex,
    engine: binding.engine,
    engineHandle: binding.engineHandle,
    result: resolveSubagentResult(settled, roundIdle, settledEntry),
  }
}


/** 投影双源持有态（entry 源 + 事件源两域；v1 全量快照兼容层已删，登记 §3.3）。 */
export interface EventProjectionSources { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  v2SubagentRegistered: Map<string, SubagentRecordRegisteredEntryData>
  v2SubagentSettled: Map<string, SubagentRecordSettledEntryData>
  v2WorkflowRegistered: Map<string, WorkflowRecordRegisteredEntryData>
  v2WorkflowSettled: Map<string, WorkflowRecordSettledEntryData>
  /** record 事件文件 fold（sa-id → 当前态）。 */
  recordFolds: Map<string, RecordEventFoldState>
  /** run journal fold（runId → core fold 检查点：状态半边 + 投影骨架半边，[W2 D7] 单源）。 */
  runFolds: Map<string, RunEventFoldCheckpoint>
}

export function initialEventProjectionSources(): EventProjectionSources {
  return {
    v2SubagentRegistered: new Map(),
    v2SubagentSettled: new Map(),
    v2WorkflowRegistered: new Map(),
    v2WorkflowSettled: new Map(),
    recordFolds: new Map(),
    runFolds: new Map(),
  }
}

/**
 * 双源单点合并（纯函数）：sources → 合并快照。
 *
 * - v2 subagent：事件 fold 的 record-created.rootSessionId === sessionId 才进
 *   投影（records 目录按 cwd 共享跨会话，rootSessionId 是 record 域 session 归属
 *   权威）；v2 注册条目在 applyEntryBatch 摄入侧按 rootSessionId 过滤；终态条目
 *   与 事件 fold 的会话归属分别信任 append-only 文件同源性（注册先行）与
 *   record-created.rootSessionId 合并侧过滤（终态条目不携 rootSessionId）；
 * - v2 workflow：注册/终态条目在场（run 域定界）即投影，事件 fold 按同 runId
 *   合并（事件源胜出）；
 * - 步骤视图合并（W0 输入换源）：合并快照上跑 mergeWorkflowStepRecords 纯函数。
 */
export function mergeEventProjection(
  sources: EventProjectionSources,
  sessionId: string,
): { subagents: Map<string, SubagentRecord>; workflows: Map<string, WorkflowRunRecord> } {
  const subagents = mergeSubagentHalf(sources, sessionId)
  const workflows = mergeWorkflowHalf(sources)

  // W0 输入换源：合并快照上做步骤视图合并（① run 骨架 × ② record 状态）
  const mergedWorkflows = mergeWorkflowStepRecords(
    Array.from(workflows.values()),
    Array.from(subagents.values()),
  )
  for (const record of mergedWorkflows) {
    workflows.set(record.runId, record)
  }
  return { subagents, workflows }
}

/** [mergeEventProjection 拆分] subagent 半边：v2 三源 id 并集投影（v1 冻结层已删）。 */
function mergeSubagentHalf(
  sources: EventProjectionSources,
  sessionId: string,
): Map<string, SubagentRecord> {
  const subagents = new Map<string, SubagentRecord>()
  const v2Ids = new Set<string>()
  for (const id of sources.v2SubagentRegistered.keys()) v2Ids.add(id)
  for (const id of sources.v2SubagentSettled.keys()) v2Ids.add(id)
  sources.recordFolds.forEach((fold, id) => { if (fold.identity !== undefined) v2Ids.add(id) })
  for (const id of v2Ids) {
    const fold = sources.recordFolds.get(id)
    // 事件源的 session 归属过滤：fold 有身份但 rootSessionId 非本会话 → 排除
    if (fold?.identity !== undefined && fold.identity.rootSessionId !== sessionId) {
      continue
    }
    const record = projectV2Subagent(
      sources.v2SubagentRegistered.get(id),
      sources.v2SubagentSettled.get(id),
      fold,
    )
    if (record !== null) subagents.set(id, record)
  }
  return subagents
}

/** [mergeEventProjection 拆分] workflow 半边：v2 条目定界 × 事件 fold 合并（v1 冻结层已删）。 */
function mergeWorkflowHalf(sources: EventProjectionSources): Map<string, WorkflowRunRecord> {
  const workflows = new Map<string, WorkflowRunRecord>()
  const v2RunIds = new Set<string>()
  for (const runId of sources.v2WorkflowRegistered.keys()) v2RunIds.add(runId)
  for (const runId of sources.v2WorkflowSettled.keys()) v2RunIds.add(runId)
  for (const runId of v2RunIds) {
    const record = projectV2Workflow(
      sources.v2WorkflowRegistered.get(runId),
      sources.v2WorkflowSettled.get(runId),
      sources.runFolds.get(runId),
    )
    if (record !== null) workflows.set(runId, record)
  }
  return workflows
}

// ── 有状态投影（tailer 接线 + 单点合并）────────────────────────

function recordIdOfFilename(filename: string): string {
  return filename.endsWith(RECORD_EVENTS_SUFFIX)
    ? filename.slice(0, -RECORD_EVENTS_SUFFIX.length)
    : filename
}

function runIdOfFilename(filename: string): string {
  return filename.endsWith(RUN_EVENTS_SUFFIX)
    ? filename.slice(0, -RUN_EVENTS_SUFFIX.length)
    : filename
}

export interface SessionEventProjectionOptions { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** 本会话 id（record 域 rootSessionId 过滤的归属键）。 */
  sessionId: string
  /** record 事件文件目录（`<agentDir>/subagents/<enc(cwd)>/records`）；undefined = 无 事件源（entry-only 降级形态）。 */
  recordsDir: string | undefined
  /** run journal 目录（`<sessionDir>/workflow-state`）；undefined = 无 事件源。 */
  runJournalDir: string | undefined
  /** 投影变更回调（事件源驱动的发布腿；entry 批路径由调用方统一发布，本回调被抑制）。 */
  onProjectionChange: () => void
  /** tailer 周期复查间隔（测试注入短值；缺省 30s）。 */
  recheckIntervalMs?: number
}

/**
 * 每会话 事件投影：entry 源（applyEntryBatch）与 事件源（tail 目录
 * watcher）双源喂入，单点合并成 subagents/workflows 快照。
 *
 * 冷启动协议：构造后调用方先 applyEntryBatch（会话文件流式扫描或 get_entries
 * 全量）再 attach()（tailer rescan 从文件头全量读）——两源幂等，次序不敏感。
 * 事件源目录缺席（会话 meta 不可得，如 pi 延迟写入窗口）→ 无 tailer 的
 * entry-only 降级投影，行为退化为 entry 通道单源。
 */
export class SessionEventProjection {
  readonly sources: EventProjectionSources = initialEventProjectionSources()
  /** 合并快照（每次重算整体替换；读请求唯一数据源）。 */
  subagents: Map<string, SubagentRecord> = new Map()
  workflows: Map<string, WorkflowRunRecord> = new Map()

  private readonly sessionId: string
  private recordTailer: EventDirectoryTailer | undefined
  private runTailer: EventDirectoryTailer | undefined
  private readonly onProjectionChange: () => void
  /** 构造时注入的 tailer 周期复查间隔（attachEventSources 升级补建的 tailer 同值）。 */
  private readonly recheckIntervalMs: number | undefined
  private disposed = false
  /** entry 批应用期间的回调抑制（发布归调用方统一执行）。 */
  private applyingEntryBatch = false

  constructor(opts: SessionEventProjectionOptions) {
    this.sessionId = opts.sessionId
    this.onProjectionChange = opts.onProjectionChange
    // undefined 直传 = tailer 缺省值（30s，周期复查兜底上界）
    this.recheckIntervalMs = opts.recheckIntervalMs
    if (opts.recordsDir !== undefined) {
      this.recordTailer = this.createRecordTailer(opts.recordsDir)
    }
    if (opts.runJournalDir !== undefined) {
      this.runTailer = this.createRunTailer(opts.runJournalDir)
    }
  }

  private createRecordTailer(dir: string): EventDirectoryTailer {
    return createEventDirectoryTailer({
      dir,
      filter: (name) => name.endsWith(RECORD_EVENTS_SUFFIX),
      parseLine: parseRecordEventFileLine,
      onEvents: (filename, events) => this.applyRecordEvents(filename, events),
      onSkippedLines: (filename, count) =>
        console.warn(`[events-projection] record events skipped ${count} bad lines: ${filename}`),
      onReset: (filename) => {
        this.sources.recordFolds.delete(recordIdOfFilename(filename))
      },
      recheckIntervalMs: this.recheckIntervalMs,
    })
  }

  private createRunTailer(dir: string): EventDirectoryTailer {
    return createEventDirectoryTailer({
      dir,
      filter: (name) => name.endsWith(RUN_EVENTS_SUFFIX),
      parseLine: parseWorkflowRunEventFileLine,
      onEvents: (filename, events) => this.applyRunEvents(filename, events),
      onSkippedLines: (filename, count) =>
        console.warn(`[events-projection] run journal skipped ${count} bad lines: ${filename}`),
      onReset: (filename) => {
        this.sources.runFolds.delete(runIdOfFilename(filename))
      },
      recheckIntervalMs: this.recheckIntervalMs,
    })
  }

  /**
   * [降级闩死修复 2026-10-02] 事件源目录是否尚有缺席（任一 tailer 未建）。创建时
   * meta 不可得（pi flush 前窗口 / 扫描竞态）会建出 entry-only 降级投影——调用方
   * （session-records.ensureProjection）据本面驱动 attachEventSources 升级，降级
   * 形态不再终身闩死。
   */
  needsEventSources(): boolean {
    return this.recordTailer === undefined || this.runTailer === undefined
  }

  /**
   * [降级闩死修复 2026-10-02] 补建缺席的事件源 tailer（幂等：已接线的源 no-op；
   * disposed no-op）。补建的 tailer 立即 rescan 冷读全量（与 attach 同一冷启动语义：
   * offset 从文件头读，双源幂等）——fold 结果经 recompute + fireChange 走既有发布腿。
   */
  attachEventSources(opts: { recordsDir?: string; runJournalDir?: string }): void {
    if (this.disposed) return
    if (opts.recordsDir !== undefined && this.recordTailer === undefined) {
      this.recordTailer = this.createRecordTailer(opts.recordsDir)
      this.recordTailer.rescan()
    }
    if (opts.runJournalDir !== undefined && this.runTailer === undefined) {
      this.runTailer = this.createRunTailer(opts.runJournalDir)
      this.runTailer.rescan()
    }
  }

  /**
   * entry 批应用（v2 条目分类 → 源持有态；fullRebuild = 游标全量重拉，entry 源
   * 整体重置为新基线，事件源不动——事件流 是事实源，不随 entry 游标自愈重置）。
   *
   * v2 注册条目按 rootSessionId 定界摄入（records 目录按 cwd 共享，注册条目是
   * 本会话实体登记簿）；终态条目/快照不携 rootSessionId，信任 append-only 文件
   * 归属（同文件内注册先行）。
   */
  applyEntryBatch(entries: readonly unknown[], opts?: { fullRebuild?: boolean }): void {
    if (this.disposed) return
    const fullRebuild = opts?.fullRebuild === true
    this.applyingEntryBatch = true
    try {
      if (fullRebuild) {
        this.sources.v2SubagentRegistered.clear()
        this.sources.v2SubagentSettled.clear()
        this.sources.v2WorkflowRegistered.clear()
        this.sources.v2WorkflowSettled.clear()
      }
      const v2 = scanV2RecordEntries(entries)
      v2.subagentRegistered.forEach((reg, id) => {
        if (reg.rootSessionId === this.sessionId) this.sources.v2SubagentRegistered.set(id, reg)
      })
      v2.subagentSettled.forEach((s, id) => this.sources.v2SubagentSettled.set(id, s))
      v2.workflowRegistered.forEach((reg, runId) => this.sources.v2WorkflowRegistered.set(runId, reg))
      v2.workflowSettled.forEach((s, runId) => this.sources.v2WorkflowSettled.set(runId, s))
      this.recompute()
    } finally {
      this.applyingEntryBatch = false
    }
  }

  /** 事件源冷启动 / 手动复查入口（幂等）。 */
  attach(): void {
    this.recordTailer?.rescan()
    this.runTailer?.rescan()
  }

  /**
   * 变更回调抑制窗口（entry 批编排专用，session-records.applyRecordEntries 经
   * ensureProjection 的 suppressUpgradeChange 选项调用）：窗口内 fireChange 抑制，
   * 发布归调用方在窗口结束后统一执行（publishRecordChanges 水位 diff 单点，与本投影
   * 发布腿共用同一发布门与送达水位，抑制不丢数据）。覆盖降级投影升级腿：attachEventSources
   * 的 rescan 全同步、fold 后即时 fireChange——若发生在 entry 批应用前，消费方会收到
   * 一帧「只有 fold、缺本批 entry」的中间态 + 随后纠正帧。与 applyingEntryBatch 共用
   * 同一门（嵌套窗口安全：恢复到前值）。
   */
  withChangeSuppressed<T>(fn: () => T): T {
    const previous = this.applyingEntryBatch
    this.applyingEntryBatch = true
    try {
      return fn()
    } finally {
      this.applyingEntryBatch = previous
    }
  }

  dispose(): void {
    this.disposed = true
    this.recordTailer?.dispose()
    this.runTailer?.dispose()
  }

  private applyRecordEvents(filename: string, events: readonly RecordEvent[]): void {
    if (this.disposed || events.length === 0) return
    const id = recordIdOfFilename(filename)
    const current = this.sources.recordFolds.get(id) ?? INITIAL_RECORD_EVENT_FOLD_STATE
    this.sources.recordFolds.set(id, foldRecordEvents([...events], current))
    this.recompute()
    this.fireChange()
  }

  private applyRunEvents(filename: string, events: readonly WorkflowRunEvent[]): void {
    if (this.disposed || events.length === 0) return
    const runId = runIdOfFilename(filename)
    // [W2 D7] fold 单源：core foldRunEventCheckpoint 增量接续（既有 checkpoint 为
    // 初值；seq 守卫去重 + 坏帧保守停帧归 core 单点）。坏帧出声（warn 归消费方
    // 注入——停帧后骨架停在最近一致态，截断重建走 onReset 清 fold 全量重放）。
    const current = this.sources.runFolds.get(runId) ?? INITIAL_RUN_EVENT_FOLD
    const checkpoint = foldRunEventCheckpoint(events, (err, lastType) => {
      console.warn(
        `[events-projection] run journal fold stopped at a broken frame (file=${filename}, ` +
          `lastType=${lastType}): ${err instanceof Error ? err.message : String(err)}`,
      )
    }, current)
    this.sources.runFolds.set(runId, checkpoint)
    // [可观测性 2026-10-02] tail 读活动显形（workflow 详情空窗事故的第一定位锚）：
    // journal 已写盘而本日志缺席 = tailer 没读到（watch 静默丢事件 + recheck 未生效）；
    // 日志在场而 GUI 仍无步骤 = 故障在发布/GUI 腿——与发布归因行（trigger=
    // event-projection）配套，两行即可二分。journal 只在 agent/phase 边界追加，
    // 量级 = 每 agent 两行以内，info 档无噪声顾虑。
    logger.info('[events-projection] run journal events applied', {
      runId,
      events: events.length,
      lastSeq: checkpoint.lastSeq,
      lifecycle: checkpoint.state.lifecycle,
      asks: checkpoint.asks.size,
    })
    this.recompute()
    this.fireChange()
  }

  /** 单点合并重算（合并快照整体替换）。 */
  private recompute(): void {
    const merged = mergeEventProjection(this.sources, this.sessionId)
    this.subagents = merged.subagents
    this.workflows = merged.workflows
  }

  private fireChange(): void {
    if (this.applyingEntryBatch || this.disposed) return
    this.onProjectionChange()
  }
}
