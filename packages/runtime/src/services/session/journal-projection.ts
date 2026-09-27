/**
 * journal 投影（W1 [D6]：runtime 读侧换源——每会话内存投影，读请求唯一数据源）。
 *
 * 双源单点合并（设计 w1-run-record-journal-authority §3.1 环节 B / §3.3 D6）：
 * - entry 源：主 session 条目（v1 全量快照兼容读 + v2 注册/终态两条小条目）——
 *   活跃会话经既有 get_entries 游标通道喂入（applyEntryBatch），冷会话经
 *   scanRecordFamilyEntriesFromSessionFile 流式扫描喂入（同一入口）；
 * - journal 源：record 事件文件（`<recordsDir>/<sa-id>.events`）与 run journal
 *   （`<sessionDir>/workflow-state/<runId>.events.jsonl`）——经 u0 journal-tail
 *   目录 tailer（watch + offset 续读 + 周期复查）增量 fold。
 *
 * 仲裁规则（journal 胜出 / 窗外条目兜底）：同实体两源都有数据时 journal 事件
 * 胜出（事实源）；journal 被保留通道清理（窗外终态实体）后 entry 终态条目是
 * 唯一来源。v1 快照条目实体走冻结兼容路径不与 journal 合并（读侧定界，对齐
 * 设计 D4 收编定界按注册条目形态分流）。
 *
 * 与 W0 的衔接（水位/合并喂入退役）：步骤视图合并（mergeWorkflowStepRecords
 * 纯函数保留）的输入从「entry 通道派生缓存」换成本投影的合并快照——冷热两路
 * 在本模块单点收敛，session-records 不再各自喂入。
 *
 * 流式读上界（32MB 预检退役为旧格式兼容路径专属的对应面）：新路径的会话文件
 * 流式扫描（session-file-extraction.ts 的 scanRecordFamilyEntriesFromSessionFile，
 * 按块读 + 行预过滤，扫描字节上界 = READ_PRECHECK_MAX_BYTES）；journal 文件按
 * tail 原语只读完整行边界。
 */

import type { SubagentRecord, WorkflowRunRecord, WorkflowAgentCall } from '@taiji/shared'
import {
  ALL_RUN_OUTCOMES,
  RUN_EVENT_JOURNAL_SUFFIX,
  SUBAGENT_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_CUSTOM_TYPE,
  classifySubagentRecordEntryData,
  classifyWorkflowRecordEntryData,
  createJournalDirectoryTailer,
  foldRecordJournalEvents,
  INITIAL_RECORD_JOURNAL_FOLD_STATE,
  parseRecordEventFileLine,
  RECORD_EVENTS_SUFFIX,
  type JournalDirectoryTailer,
  type RecordCreatedEvent,
  type RecordJournalEvent,
  type RecordJournalFoldState,
  type RunOutcome,
  type SubagentRecordRegisteredEntryData,
  type SubagentRecordSettledEntryData,
  type WorkflowRecordRegisteredEntryData,
  type WorkflowRecordSettledEntryData,
  type WorkflowRunEvent,
} from '@zhushanwen/subagent-core'

import { scanSubagentEntries } from './subagent-extractor.js'
import { scanWorkflowEntries } from './workflow-extractor.js'
import { mergeWorkflowStepRecords } from './workflow-step-merge.js'

// ── run journal 行解析（域无关 tail 原语的 run 域注入）─────────

/**
 * run 事件 type 词表的运行时镜像（barrel 未导出 RUN_EVENT_TYPES 常量数组）。
 * Record 键型 = WorkflowRunEvent['type'] 的全联合——core 词表增删成员时本处的
 * 记录字面量缺键/多键即编译红（编译期穷尽守卫，替代运行时漂移）。
 */
const RUN_EVENT_TYPE_PROBE: Record<WorkflowRunEvent['type'], true> = {
  'run-created': true,
  'ask-dispatched': true,
  'ask-executing': true,
  'ask-retrying': true,
  'ask-settled': true,
  armed: true,
  'run-settled': true,
}

const RUN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(Object.keys(RUN_EVENT_TYPE_PROBE))

/**
 * run journal 文件行解析器（journal-tail parseLine 注入面，run 域）。
 *
 * 守卫对齐 core run-events isWorkflowRunEventLine 的最宽共同判定面：JSON 对象 +
 * type 落词表 + ts 有限数值 + outcome（ask-settled / run-settled 携带时）落词表。
 * 坏行返回 undefined 交 tailer 计数（宽容跳过，不卡游标）。
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
  const rec = parsed as { type?: unknown; ts?: unknown; outcome?: unknown }
  if (typeof rec.type !== 'string' || !RUN_EVENT_TYPE_SET.has(rec.type)) return undefined
  if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts)) return undefined
  if (
    rec.outcome !== undefined &&
    !(ALL_RUN_OUTCOMES as readonly string[]).includes(rec.outcome as string)
  ) {
    return undefined
  }
  return parsed as WorkflowRunEvent
}

// ── run journal fold（事件流 → run 骨架投影）───────────────────

/** 单个 ask（步骤）的 journal fold 投影：骨架行 + 终局。 */
export interface RunAskStepFold {
  taskIndex: number
  agentName: string
  /** 剧本 phase 归属（W1 D6 分组供源；ask-dispatched 携带，旧 journal 行缺省 undefined）。 */
  phase?: string
  /** 首个 dispatched ts（步骤起点）。 */
  startedAt: number
  /** 最近一次该 ask 事件 ts（进度边沿）。 */
  lastProgressAt: number
  /** 终局（ask-settled；未终态 undefined）。 */
  settled?: { outcome: RunOutcome; durationMs?: number; errorCode?: string; ts: number }
}

/** 单个 run journal 的 fold 状态（增量 append fold，重放幂等）。 */
export interface RunJournalFold {
  /** run-created 帧（journal 首帧；undefined = 残文件/首帧未达）。 */
  created: { runId: string; workflowName: string; ts: number } | undefined
  /** ask 投影（taskIndex → 步骤行）。 */
  asks: Map<number, RunAskStepFold>
  /** run-settled 终局（未终态 undefined）。 */
  runSettled: { outcome: RunOutcome; errorCode?: string; reason?: string; ts: number } | undefined
}

/** run fold 初始态。 */
export function initialRunJournalFold(): RunJournalFold {
  return { created: undefined, asks: new Map(), runSettled: undefined }
}

/**
 * run journal 增量 fold（幂等：ask 终局/进度边沿按「后到覆盖」语义，重复事件
 * 重放只推进同值字段）。run 域事件自 W1 起携带 seq 信封（run-events
 * EventEnvelope 单调分配）；本 fold 不以 seq 去重，截断重读由 onReset 清 fold
 * 后从初始态重放保证幂等。
 */
export function foldRunJournalEvents(
  fold: RunJournalFold,
  events: readonly WorkflowRunEvent[],
): RunJournalFold {
  for (const event of events) {
    switch (event.type) {
      case 'run-created':
        fold.created = { runId: event.runId, workflowName: event.workflowName, ts: event.ts }
        break
      case 'ask-dispatched': {
        const existing = fold.asks.get(event.taskIndex)
        if (existing === undefined) {
          fold.asks.set(event.taskIndex, {
            taskIndex: event.taskIndex,
            agentName: event.agentName,
            // 剧本归属随帧落投影（W1 D6）；无 phase 帧不造键（旧 journal 行兼容）
            ...(event.phase !== undefined ? { phase: event.phase } : {}),
            startedAt: event.ts,
            lastProgressAt: event.ts,
          })
        } else {
          existing.lastProgressAt = Math.max(existing.lastProgressAt, event.ts)
        }
        break
      }
      case 'ask-executing': {
        const existing = fold.asks.get(event.taskIndex)
        if (existing === undefined) {
          fold.asks.set(event.taskIndex, {
            taskIndex: event.taskIndex,
            agentName: event.agentName,
            startedAt: event.ts,
            lastProgressAt: event.ts,
          })
        } else {
          existing.lastProgressAt = Math.max(existing.lastProgressAt, event.ts)
        }
        break
      }
      case 'ask-retrying': {
        const existing = fold.asks.get(event.taskIndex)
        if (existing !== undefined) {
          existing.lastProgressAt = Math.max(existing.lastProgressAt, event.ts)
        }
        break
      }
      case 'ask-settled': {
        const existing = fold.asks.get(event.taskIndex)
        const settled = {
          outcome: event.outcome,
          durationMs: event.durationMs,
          errorCode: event.errorCode,
          ts: event.ts,
        }
        if (existing === undefined) {
          // settled 先于 dispatched 到达（截断重读分段 / 半写形态）：骨架行缺
          // agentName，用占位名成行（状态位仍可投影；record overlay 会覆盖该行）
          fold.asks.set(event.taskIndex, {
            taskIndex: event.taskIndex,
            agentName: '(unknown)',
            startedAt: event.ts,
            lastProgressAt: event.ts,
            settled,
          })
        } else {
          existing.lastProgressAt = Math.max(existing.lastProgressAt, event.ts)
          existing.settled = settled
        }
        break
      }
      case 'armed':
        break
      case 'run-settled':
        fold.runSettled = {
          outcome: event.outcome,
          errorCode: event.errorCode,
          reason: event.reason,
          ts: event.ts,
        }
        break
    }
  }
  return fold
}

// ── v2 条目载荷守卫（classify 只判 v/kind，字段形状归本层）─────
//
// kind 判别联合的成员访问已由 classify 的 entry 载荷窄化承载；此处仅补 classify
// 不校验的最小运行时键守卫（id/runId/journalPath 的 typeof 检查——防御截断半写
// 形态），不再重复形状校验。

/** v2 条目族扫描结果（entry 源的 v2 半边）。 */
export interface V2EntryScan {
  subagentRegistered: Map<string, SubagentRecordRegisteredEntryData>
  subagentSettled: Map<string, SubagentRecordSettledEntryData>
  workflowRegistered: Map<string, WorkflowRecordRegisteredEntryData>
  workflowSettled: Map<string, WorkflowRecordSettledEntryData>
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
      const classification = classifySubagentRecordEntryData(e.data)
      if (classification.ok || classification.reason !== 'v2') continue
      const v2 = classification.entry
      if (v2.kind === 'registered' && typeof v2.id === 'string') {
        result.subagentRegistered.set(v2.id, v2)
      } else if (v2.kind === 'settled' && typeof v2.id === 'string') {
        result.subagentSettled.set(v2.id, v2)
      }
    } else if (e.customType === WORKFLOW_RECORD_CUSTOM_TYPE) {
      const classification = classifyWorkflowRecordEntryData(e.data)
      if (classification.ok || classification.reason !== 'v2') continue
      const v2 = classification.entry
      if (
        v2.kind === 'registered' &&
        typeof v2.runId === 'string' &&
        typeof v2.journalPath === 'string'
      ) {
        result.workflowRegistered.set(v2.runId, v2)
      } else if (v2.kind === 'settled' && typeof v2.runId === 'string') {
        result.workflowSettled.set(v2.runId, v2)
      }
    }
  }
  return result
}

// ── 合并仲裁纯函数（journal 胜出 / 窗外条目兜底 / v1 冻结）─────

/** ms → ISO（WorkflowAgentCall/WorkflowRunRecord 时间契约是 ISO 字符串）。 */
function toIso(ms: number): string {
  return new Date(ms).toISOString()
}

/** shared WorkflowDoneReason 词表集合（core DoneReason 收窄用，值级守卫）。 */
const WORKFLOW_DONE_REASON_SET: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'aborted',
  'budget_limited',
  'time_limited',
])

/** 值级守卫（Set.has 无类型窄化能力——显式谓词窄化到 shared 信号面词表）。 */
function isWorkflowDoneReason(value: string): value is NonNullable<WorkflowRunRecord['reason']> {
  return WORKFLOW_DONE_REASON_SET.has(value)
}

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
 * v2 subagent 实体的合并投影（journal 胜出仲裁的核心）。
 *
 * - 身份域：journal fold 的 record-created（事实源）优先，注册条目兜底（journal
 *   被清理的窗外实体）；两者皆缺（无身份锚点）返回 null——正常流注册条目先于
 *   终态条目落盘，终态单独在场属半写残形态。
 * - 运行态（status/stopReason/统计/engine 绑定）：journal fold 优先；journal 缺席
 *   （窗外）时终态条目兜底。
 * - 仅条目有的字段（model/thinkingLevel/result 全文）：条目填充——事件文件只存
 *   result 摘要锚（D3），全文唯一落点是 v2 终态条目。
 */
export function projectV2Subagent(
  registered: SubagentRecordRegisteredEntryData | undefined,
  settledEntry: SubagentRecordSettledEntryData | undefined,
  fold: RecordJournalFoldState | undefined,
): SubagentRecord | null {
  const identity: RecordCreatedEvent | SubagentRecordRegisteredEntryData | undefined =
    fold?.identity ?? registered
  if (identity === undefined) return null
  const settled = fold?.settled
  const roundIdle = fold?.roundIdle
  const bound = fold?.bound
  const startedAt = identity.startedAt
  const endedAt = settled?.endedAt ?? settledEntry?.endedAt
  return {
    subagentId: identity.id,
    sessionFile: bound?.sessionFile ?? settledEntry?.sessionFile ?? null,
    agent: identity.agent,
    slug: identity.slug,
    task: identity.task,
    // journal 胜出：fold 在场（含事件文件）时由 fold 定态；窗外无 fold 时终态条目兜底。
    // status 是两态判据不是终局吸收位判据：轮终收条（record-round-idle，v1 权威词
    // idle 同源）与 reopened（CAS 只接受 idle、不翻 running）都映射 idle；不能用
    // roundIdle 在场判 idle（round-started 不清 roundIdle），以 lastEvent.type 判。
    status:
      fold !== undefined
        ? fold.settled !== undefined ||
          fold.lastEvent?.type === 'record-round-idle' ||
          fold.lastEvent?.type === 'record-reopened'
          ? 'idle'
          : 'running'
        : settledEntry !== undefined
          ? 'idle'
          : 'running',
    // 停因供源随 status 判据同构分流（v1 写侧语义延续）：settled 终局停因 → 轮终
    // 收条停因（lastEvent 为 round-idle 时 roundIdle 即最新收条）→ reopened 窗口
    // 展示词（事件词表 record-reopened 无停因载荷，由 lastEvent.type 映射——对齐 v1
    // markReopenedImpl 写 stopReason='reopened'）；在飞（round-started / created /
    // bound）轮始清点无停因——roundIdle/settledEntry 的旧值不得透传（v1
    // markRoundStartedImpl 上轮停因随轮始清点 + isOccupied 的 stopReason 子句依赖；
    // F2-1：第二轮 running + 「completed」矛盾组合即旧值透传所致）。
    stopReason:
      fold !== undefined
        ? settled !== undefined
          ? settled.stopReason
          : fold.lastEvent?.type === 'record-round-idle'
            ? roundIdle?.stopReason
            : fold.lastEvent?.type === 'record-reopened'
              ? 'reopened'
              : undefined
        : settledEntry?.stopReason,
    turns: settled?.turns ?? roundIdle?.turns ?? settledEntry?.turns,
    totalTokens:
      settled?.totalTokens ?? roundIdle?.totalTokens ?? settledEntry?.totalTokens,
    model: settledEntry?.model,
    thinkingLevel: settledEntry?.thinkingLevel,
    startedAt,
    endedAt,
    elapsedSeconds: deriveElapsedSeconds(startedAt, endedAt),
    // error 供源与 stopReason 分流同构（W1 终态同步 F2-2 裁决）：settled 终局
    // 原文 → 轮终失败收条（round-started 后 lastEvent 非 round-idle，上轮失败
    // 原文随轮始清点语义不透传——对齐 v1 markRoundStartedImpl 清残留死因）→
    // 条目面兜底（fold 缺席 = journal 未接线的旧实体）。
    error:
      fold !== undefined
        ? settled !== undefined
          ? settled.error
          : fold.lastEvent?.type === 'record-round-idle'
            ? roundIdle?.error
            : undefined
        : settledEntry?.error,
    origin: identity.origin,
    parentRunId: identity.parentRunId,
    stepIndex: identity.stepIndex,
    engine: bound?.engine ?? settledEntry?.engine,
    engineHandle: bound?.engineHandle ?? settledEntry?.engineHandle,
    // result 供源（W1 轮终粒度裁决：record-round-idle 携带 result 摘要锚，承接 v1
    // U8b 轮终 result 显示信号）：轮终收条晚于终局面（settled 已被 reopened /
    // round-started 清除，或 roundIdle.seq 更新）时轮终摘要胜出——否则终局面优先
    // （v2 终态条目全文是 D1 唯一全文落点，摘要锚兜底）。
    result:
      roundIdle !== undefined && (settled === undefined || roundIdle.seq > settled.seq)
        ? roundIdle.resultSummary ?? settledEntry?.result ?? settled?.resultSummary
        : settledEntry?.result ?? settled?.resultSummary,
  }
}

/**
 * v2 workflow 实体的合并投影：journal fold 供骨架（ask 步骤行）与终局，注册/
 * 终态条目供 scriptName/slug/reason 词表与统计摘要。
 *
 * 定界（run 域的 session 归属）：注册或终态条目缺席 = 该 run 非本会话实体
 * （workflow-state 目录按 cwd 共享，其他会话的 run 只存在于 journal——不进投影）。
 */
export function projectV2Workflow(
  registered: WorkflowRecordRegisteredEntryData | undefined,
  settledEntry: WorkflowRecordSettledEntryData | undefined,
  fold: RunJournalFold | undefined,
): WorkflowRunRecord | null {
  if (registered === undefined && settledEntry === undefined) return null
  const runSettled = fold?.runSettled
  const status: WorkflowRunRecord['status'] =
    runSettled !== undefined || settledEntry !== undefined ? 'done' : 'running'
  // reason 词表收窄：core DoneReason ⊃ shared WorkflowDoneReason（core 另含
  // invalid_args 等扩展值，shared 信号面不认——词表外按缺省归一，不硬透传）
  const reason =
    settledEntry?.reason !== undefined && isWorkflowDoneReason(settledEntry.reason)
      ? settledEntry.reason
      : undefined
  const agentCalls: WorkflowAgentCall[] = []
  if (fold !== undefined) {
    const indexes = Array.from(fold.asks.keys()).sort((a, b) => a - b)
    for (const taskIndex of indexes) {
      const ask = fold.asks.get(taskIndex)!
      const stepStatus: WorkflowAgentCall['status'] =
        ask.settled === undefined
          ? 'running'
          : ask.settled.outcome === 'completed'
            ? 'completed'
            : 'failed'
      agentCalls.push({
        id: ask.taskIndex,
        agent: ask.agentName,
        // phase 分组供源透传（W1 D6）——renderer hasExplicitPhases 判据
        // `phase !== undefined` 由此成立；fold 缺 phase（旧行）不造键保持平铺
        ...(ask.phase !== undefined ? { phase: ask.phase } : {}),
        status: stepStatus,
        startedAt: toIso(ask.startedAt),
        ...(ask.settled !== undefined ? { completedAt: toIso(ask.settled.ts) } : {}),
        ...(ask.settled?.durationMs !== undefined ? { durationMs: ask.settled.durationMs } : {}),
        ...(ask.settled?.errorCode !== undefined ? { error: ask.settled.errorCode } : {}),
        lastProgressAt: ask.lastProgressAt,
      })
    }
  }
  const outcome: WorkflowRunRecord['outcome'] | undefined =
    runSettled?.outcome ?? settledEntry?.outcome
  const errorCode: string | undefined = runSettled?.errorCode ?? settledEntry?.errorCode
  return {
    runId: registered?.runId ?? settledEntry!.runId,
    scriptName: registered?.scriptName ?? fold?.created?.workflowName ?? '(unknown)',
    slug: registered?.slug,
    status,
    reason,
    startedAt: toIso(registered?.startedAt ?? fold?.created?.ts ?? 0),
    ...(settledEntry !== undefined ? { completedAt: toIso(settledEntry.settledAt) } : {}),
    ...(settledEntry !== undefined ? { usedTokens: settledEntry.usedTokens } : {}),
    ...(settledEntry !== undefined ? { totalCallCount: settledEntry.callCount } : {}),
    agentCalls,
    // v2 无 state 文件锚：stateFilePath 承载注册条目 journalPath（详情面板「run 关联
    // 持久化文件」展示位）；v1 快照路径恒 ''（workflow-extractor 对空串隐藏）。
    stateFilePath: registered?.journalPath ?? '',
    ...(outcome !== undefined ? { outcome } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
  }
}

/** 投影双源持有态（entry 源两代 + journal 源两域）。 */
export interface JournalProjectionSources {
  /** v1 全量快照实体（兼容层冻结数据——journal 不参与合并）。 */
  v1Subagents: Map<string, SubagentRecord>
  v1Workflows: Map<string, WorkflowRunRecord>
  v2SubagentRegistered: Map<string, SubagentRecordRegisteredEntryData>
  v2SubagentSettled: Map<string, SubagentRecordSettledEntryData>
  v2WorkflowRegistered: Map<string, WorkflowRecordRegisteredEntryData>
  v2WorkflowSettled: Map<string, WorkflowRecordSettledEntryData>
  /** record 事件文件 fold（sa-id → 当前态）。 */
  recordFolds: Map<string, RecordJournalFoldState>
  /** run journal fold（runId → 骨架投影）。 */
  runFolds: Map<string, RunJournalFold>
}

export function initialJournalProjectionSources(): JournalProjectionSources {
  return {
    v1Subagents: new Map(),
    v1Workflows: new Map(),
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
 * - v1 实体冻结透传（定界：v1 快照在场的实体不经 journal 仲裁——旧会话行为
 *   完全不变）；
 * - v2 subagent：journal fold 的 record-created.rootSessionId === sessionId 才进
 *   投影（records 目录按 cwd 共享跨会话，rootSessionId 是 record 域 session 归属
 *   权威）；v2 注册条目在 applyEntryBatch 摄入侧按 rootSessionId 过滤；终态条目
 *   与 journal fold 的会话归属分别信任 append-only 文件同源性（注册先行）与
 *   record-created.rootSessionId 合并侧过滤（终态条目不携 rootSessionId）；
 * - v2 workflow：注册/终态条目在场（run 域定界）即投影，journal fold 按同 runId
 *   合并（journal 胜出）；
 * - 步骤视图合并（W0 输入换源）：合并快照上跑 mergeWorkflowStepRecords 纯函数。
 */
export function mergeJournalProjection(
  sources: JournalProjectionSources,
  sessionId: string,
): { subagents: Map<string, SubagentRecord>; workflows: Map<string, WorkflowRunRecord> } {
  const subagents = new Map<string, SubagentRecord>()
  for (const [id, record] of sources.v1Subagents) {
    subagents.set(id, record)
  }
  const v2Ids = new Set<string>()
  for (const id of sources.v2SubagentRegistered.keys()) v2Ids.add(id)
  for (const id of sources.v2SubagentSettled.keys()) v2Ids.add(id)
  sources.recordFolds.forEach((fold, id) => { if (fold.identity !== undefined) v2Ids.add(id) })
  for (const id of v2Ids) {
    if (subagents.has(id)) continue // v1 冻结定界优先
    const fold = sources.recordFolds.get(id)
    // journal 源的 session 归属过滤：fold 有身份但 rootSessionId 非本会话 → 排除
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

  const workflows = new Map<string, WorkflowRunRecord>()
  for (const [runId, record] of sources.v1Workflows) {
    workflows.set(runId, record)
  }
  const v2RunIds = new Set<string>()
  for (const runId of sources.v2WorkflowRegistered.keys()) v2RunIds.add(runId)
  for (const runId of sources.v2WorkflowSettled.keys()) v2RunIds.add(runId)
  for (const runId of v2RunIds) {
    if (workflows.has(runId)) continue // v1 冻结定界优先
    const record = projectV2Workflow(
      sources.v2WorkflowRegistered.get(runId),
      sources.v2WorkflowSettled.get(runId),
      sources.runFolds.get(runId),
    )
    if (record !== null) workflows.set(runId, record)
  }

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

// ── 有状态投影（tailer 接线 + 单点合并）────────────────────────

function recordIdOfFilename(filename: string): string {
  return filename.endsWith(RECORD_EVENTS_SUFFIX)
    ? filename.slice(0, -RECORD_EVENTS_SUFFIX.length)
    : filename
}

function runIdOfFilename(filename: string): string {
  return filename.endsWith(RUN_EVENT_JOURNAL_SUFFIX)
    ? filename.slice(0, -RUN_EVENT_JOURNAL_SUFFIX.length)
    : filename
}

export interface SessionJournalProjectionOptions {
  /** 本会话 id（record 域 rootSessionId 过滤的归属键）。 */
  sessionId: string
  /** record 事件文件目录（`<agentDir>/subagents/<enc(cwd)>/records`）；undefined = 无 journal 源（entry-only 降级形态）。 */
  recordsDir: string | undefined
  /** run journal 目录（`<sessionDir>/workflow-state`）；undefined = 无 journal 源。 */
  runJournalDir: string | undefined
  /** 投影变更回调（journal 源驱动的发布腿；entry 批路径由调用方统一发布，本回调被抑制）。 */
  onProjectionChange: () => void
  /** tailer 周期复查间隔（测试注入短值；缺省 30s）。 */
  recheckIntervalMs?: number
}

/**
 * 每会话 journal 投影：entry 源（applyEntryBatch）与 journal 源（tail 目录
 * watcher）双源喂入，单点合并成 subagents/workflows 快照。
 *
 * 冷启动协议：构造后调用方先 applyEntryBatch（会话文件流式扫描或 get_entries
 * 全量）再 attach()（tailer rescan 从文件头全量读）——两源幂等，次序不敏感。
 * journal 源目录缺席（会话 meta 不可得，如 pi 延迟写入窗口）→ 无 tailer 的
 * entry-only 降级投影，行为退化为 entry 通道单源。
 */
export class SessionJournalProjection {
  readonly sources: JournalProjectionSources = initialJournalProjectionSources()
  /** 合并快照（每次重算整体替换；读请求唯一数据源）。 */
  subagents: Map<string, SubagentRecord> = new Map()
  workflows: Map<string, WorkflowRunRecord> = new Map()

  private readonly sessionId: string
  private readonly recordTailer: JournalDirectoryTailer | undefined
  private readonly runTailer: JournalDirectoryTailer | undefined
  private readonly onProjectionChange: () => void
  private disposed = false
  /** entry 批应用期间的回调抑制（发布归调用方统一执行）。 */
  private applyingEntryBatch = false

  constructor(opts: SessionJournalProjectionOptions) {
    this.sessionId = opts.sessionId
    this.onProjectionChange = opts.onProjectionChange
    // undefined 直传 = tailer 缺省值（30s，周期复查兜底上界）
    const recheck: number | undefined = opts.recheckIntervalMs
    if (opts.recordsDir !== undefined) {
      this.recordTailer = createJournalDirectoryTailer({
        dir: opts.recordsDir,
        filter: (name) => name.endsWith(RECORD_EVENTS_SUFFIX),
        parseLine: parseRecordEventFileLine,
        onEvents: (filename, events) => this.applyRecordEvents(filename, events),
        onSkippedLines: (filename, count) =>
          console.warn(`[journal-projection] record events skipped ${count} bad lines: ${filename}`),
        onReset: (filename) => {
          this.sources.recordFolds.delete(recordIdOfFilename(filename))
        },
        recheckIntervalMs: recheck,
      })
    }
    if (opts.runJournalDir !== undefined) {
      this.runTailer = createJournalDirectoryTailer({
        dir: opts.runJournalDir,
        filter: (name) => name.endsWith(RUN_EVENT_JOURNAL_SUFFIX),
        parseLine: parseWorkflowRunEventFileLine,
        onEvents: (filename, events) => this.applyRunEvents(filename, events),
        onSkippedLines: (filename, count) =>
          console.warn(`[journal-projection] run journal skipped ${count} bad lines: ${filename}`),
        onReset: (filename) => {
          this.sources.runFolds.delete(runIdOfFilename(filename))
        },
        recheckIntervalMs: recheck,
      })
    }
  }

  /**
   * entry 批应用（v1 快照扫描 + v2 条目分类 → 源持有态；fullRebuild = 游标全量
   * 重拉，entry 源两代整体重置为新基线，journal 源不动——journal 是事实源，
   * 不随 entry 游标自愈重置）。
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
        this.sources.v1Subagents.clear()
        this.sources.v1Workflows.clear()
        this.sources.v2SubagentRegistered.clear()
        this.sources.v2SubagentSettled.clear()
        this.sources.v2WorkflowRegistered.clear()
        this.sources.v2WorkflowSettled.clear()
      }
      for (const r of scanSubagentEntries([...entries])) this.sources.v1Subagents.set(r.subagentId, r)
      for (const r of scanWorkflowEntries([...entries])) this.sources.v1Workflows.set(r.runId, r)
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

  /** journal 源冷启动 / 手动复查入口（幂等）。 */
  attach(): void {
    this.recordTailer?.rescan()
    this.runTailer?.rescan()
  }

  dispose(): void {
    this.disposed = true
    this.recordTailer?.dispose()
    this.runTailer?.dispose()
  }

  private applyRecordEvents(filename: string, events: readonly RecordJournalEvent[]): void {
    if (this.disposed || events.length === 0) return
    const id = recordIdOfFilename(filename)
    const current = this.sources.recordFolds.get(id) ?? INITIAL_RECORD_JOURNAL_FOLD_STATE
    this.sources.recordFolds.set(id, foldRecordJournalEvents([...events], current))
    this.recompute()
    this.fireChange()
  }

  private applyRunEvents(filename: string, events: readonly WorkflowRunEvent[]): void {
    if (this.disposed || events.length === 0) return
    const runId = runIdOfFilename(filename)
    const current = this.sources.runFolds.get(runId) ?? initialRunJournalFold()
    this.sources.runFolds.set(runId, foldRunJournalEvents(current, [...events]))
    this.recompute()
    this.fireChange()
  }

  /** 单点合并重算（合并快照整体替换）。 */
  private recompute(): void {
    const merged = mergeJournalProjection(this.sources, this.sessionId)
    this.subagents = merged.subagents
    this.workflows = merged.workflows
  }

  private fireChange(): void {
    if (this.applyingEntryBatch || this.disposed) return
    this.onProjectionChange()
  }
}
