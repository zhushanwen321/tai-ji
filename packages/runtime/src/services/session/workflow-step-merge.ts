/**
 * workflow 步骤视图合并投影（W0 / 设计 workflow-step-visibility-data-source D2；
 * W1 换源后输入改喂 journal 投影，纯函数本体保留）。
 *
 * 职责：以 workflow 投影的 trace 节点为骨架（stepIndex/phase/agent/task），subagent
 * 投影按 (parentRunId, stepIndex) 圈定候选集后合并——「① 供编排结构，② 供运行时
 * 状态」。phase 供源两代（W1 D6）：v1 快照 trace 节点自带 phase（停写，兼容读）；
 * v2 = journal ask-dispatched 载荷 phase（现役——journal-projection fold 恢复 +
 * projectV2Workflow 透传）。
 *
 * 三条规则（设计 D2）：
 * - R1 状态映射：record 两态（running|idle）× stopReason → 步骤四态
 *   （pending|running|completed|failed），词表显式转换禁止直拷（两态进四态消费面，
 *   renderer 聚合 switch 落 default 的确定性事故）。13 值域逐行见 mapStepStatusFromRecord。
 * - R2 一键多 record 收敛：候选集有 running 取之（多条 running 取 startedAt 最新——
 *   rebuildRuntime 瞬态窗口 tiebreak）；全终态取 startedAt 最新（终态取最后 attempt）。
 * - R3 record-only 成行与守卫：候选有而 trace 无（① 节流窗口 + P4 竞态）→ record 自身
 *   字段成行（phase 保持 undefined，不出「Other」分组头）；record 无 stepIndex（旧
 *   session entry / 版本 skew）→ 不成行（否则已完成旧 run 产出重复行，V5 回落矛盾）；
 *   trace 有而候选无（派发前置失败早退，无 record）→ 维持 ① 原样。
 *
 * 纯函数模块：冷启动（extractWorkflowsFromSessionFile 组合扫描）与实时增量
 * （journal-projection.recompute → mergeJournalProjection 内单点跑本函数的
 * mergeWorkflowStepRecords，W1 D6 换源——session-records 缓存是投影合并快照的镜像）
 * 共用本函数（D5 冷热同代码）；合并消费内存中的已解析投影数组，不触碰文件系统
 * （D5 禁双读盘约束）。
 */

import { displayAgentName } from '@zhushanwen/subagent-core'

import type { SubagentRecord, WorkflowAgentCall, WorkflowRunRecord } from '@taiji/shared'

/** 步骤行四态（对齐 shared WorkflowAgentCall.status；pending 只来自 trace 骨架）。 */
type StepStatus = WorkflowAgentCall['status']

/** [R1] cancelled 的 error 空缺填充文案（run abort 连带，不新增第五态）。 */
const CANCELLED_FILL_TEXT = 'cancelled by run abort'

/** 秒→ms 换算常数（record.elapsedSeconds 秒 → 步骤行 durationMs ms）。 */
const MS_PER_SECOND = 1000

/** [R1] 中断族三值（record-lifecycle disposeAllRecords 编排性关闭 / record-store 重启重建兜底产出）。 */
const INTERRUPTED_STOP_REASONS: readonly string[] = ['interrupted', 'interrupted-by-restart', 'interrupted-by-parent']

/**
 * [R1] 兜底通用异常文案（stopReason ∈ legacy ClosedReason 家族 / reopened / 缺失——
 * 现行写侧 invariant 下 settle 必带 stopReason，缺失是真异常形态）。缺省显示成功会让
 * 异常静默隐形；文案携带 stopReason 原文供排障归因。
 */
function genericStopText(stopReason: string | undefined): string {
  return stopReason !== undefined
    ? `stopped unexpectedly (stopReason: ${stopReason})`
    : 'stopped unexpectedly (no stop reason)'
}

/**
 * [R1] 状态映射矩阵：record (status, stopReason) → 步骤行 (status, error)。
 * 13 值域逐行（StopReason 全枚举 = CLOSED_REASONS 六值 + disconnected + 中断族三值 +
 * reopened + completed + failed，见 subagent-core assembly/types.ts）：
 *
 * | record status | stopReason                                          | 步骤行           |
 * |--------------|-----------------------------------------------------|------------------|
 * | running      | （无论 stopReason）                                  | running          |
 * | idle         | completed                                           | completed        |
 * | idle         | failed                                              | failed           |
 * | idle         | gc（error 空）                                       | completed        |
 * | idle         | gc（error 非空）                                     | failed + error 透传 |
 * | idle         | cancelled                                           | failed + 文案填充 |
 * | idle         | interrupted / interrupted-by-restart / -by-parent    | failed + 原文填充 |
 * | idle         | 其余任意值（legacy 家族剩余 + reopened）               | failed + 通用文案 |
 * | idle         | 缺失（真异常形态）                                    | failed + 通用文案 |
 *
 * gc 是双语义值按 error 分叉：写侧 D7 例外族（subagent-core run-orchestration.ts
 * settleOneShotOutcome / record-lifecycle.ts finalizeFailed）workflow origin 成功与失败
 * settle 均写 closed/"gc"，成败由 error 区分（成功 result.error 空、失败恒带错误文本）；
 * 与 outcome 权威派生 deriveOutcome 的 error-truthy 判定同构（监督器放弃等其余 gc 写入
 * 点恒带非空 error，落 failed 分支不受影响）。
 *
 * 中断族必须可见不可静默隐形（run 进行中宿主崩溃/重启是 ① 的设计目标场景）；error 非空时
 * record.error 恒优先（真实错误文本），填充仅兜 error 空。
 * 注意：消费的是提取器投影后的形态（legacy closedReason 已由 derivedStopReason 归一层
 * 先行折叠），矩阵仍按全集兜底。
 */
export function mapStepStatusFromRecord(record: Pick<SubagentRecord, 'status' | 'stopReason' | 'error'>): {
  status: StepStatus
  error: string | undefined
} {
  if (record.status === 'running') return { status: 'running', error: undefined }
  // idle（终态概念在 stopReason）
  const reason = record.stopReason
  if (reason === 'completed') return { status: 'done', error: record.error }
  if (reason === 'failed') return { status: 'failed', error: record.error }
  if (reason === 'gc') {
    // 双语义值按 error 分叉（写侧依据 = D7 例外族，subagent-core run-orchestration.ts
    // settleOneShotOutcome：workflow origin 成功/失败 settle 均写 closed/"gc"，error
    // 区分——成功 result.error 空、失败恒带错误文本）。truthy 判定与写侧 outcome 权威
    // 派生 deriveOutcome 同构（空串不构成失败）；error 空判 completed，否则 failed。
    if (record.error) return { status: 'failed', error: record.error }
    return { status: 'done', error: undefined }
  }
  if (reason === 'cancelled') {
    return { status: 'failed', error: record.error ?? CANCELLED_FILL_TEXT }
  }
  if (INTERRUPTED_STOP_REASONS.includes(reason ?? '')) {
    return { status: 'failed', error: record.error ?? reason }
  }
  return { status: 'failed', error: record.error ?? genericStopText(reason) }
}

/**
 * [R2] 一键多 record 收敛：候选集内存在 running 态条目则取之（僵尸 running × 新 attempt
 * 终态形态下显示 running——自愈链 recoverEntryOnlyOrphans 兜底前的瞬态显示，设计检查点③
 * 钉住）；多条 running 取 startedAt 最新。全终态取 startedAt 最新（最后 attempt 的最终
 * 结果语义）。startedAt 缺失视为最早；等值取数组序靠后者（更晚到达的快照）。
 */
function pickAuthoritativeRecord(bucket: SubagentRecord[]): SubagentRecord {
  let best = bucket[0]!
  for (const candidate of bucket.slice(1)) {
    const candidateRunning = candidate.status === 'running'
    const bestRunning = best.status === 'running'
    if (candidateRunning !== bestRunning) {
      if (candidateRunning) best = candidate
      continue
    }
    if (startRank(candidate) >= startRank(best)) best = candidate
  }
  return best
}

/** startedAt 排序键（缺失 = 最早，不参与「最新」竞争除非全员缺失）。 */
function startRank(record: SubagentRecord): number {
  return record.startedAt ?? Number.NEGATIVE_INFINITY
}

/** epoch ms → ISO 字符串（WorkflowAgentCall 的 startedAt/completedAt 契约是 ISO）。 */
function toIsoTimestamp(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * [R1/R2] 权威 record 覆盖 trace 骨架行：状态/时间/错误/sessionId 取 record（运行状态
 * 权威），编排结构（phase/agent/id）与 ① 独有投影（model/lastProgressAt/token 拆分——
 * record 只有 totalTokens 总量，无法无损映射 input/output 二元组，保留 trace 值）维持
 * trace。sessionId = record.subagentId（trace.sessionId 语义即 record id，
 * getAgentCallHistory 按它查找——record-only 行与覆盖行都必带，否则步骤点击 no-op）。
 */
function overlayTraceCall(call: WorkflowAgentCall, record: SubagentRecord): WorkflowAgentCall {
  const mapped = mapStepStatusFromRecord(record)
  return {
    ...call,
    status: mapped.status,
    error: mapped.error,
    sessionId: record.subagentId,
    startedAt: record.startedAt !== undefined ? toIsoTimestamp(record.startedAt) : call.startedAt,
    completedAt: record.endedAt !== undefined ? toIsoTimestamp(record.endedAt) : undefined,
    durationMs: record.elapsedSeconds !== undefined ? record.elapsedSeconds * MS_PER_SECOND : undefined,
    turns: record.turns,
  }
}

/**
 * [R3] record-only 成行：trace 暂无对应节点（① 60s 节流窗口 / P4 竞态）时用 record 自身
 * 字段成行。phase 保持 undefined（不出「Other」分组头——renderer hasExplicitPhases 判
 * `phase !== undefined`，已知取舍 2「先平铺秒见、后归组」）。agent 短名化（basename 去
 * .md，复用 subagent-core displayAgentName 单源）：record.agent 是完整 agent ref 路径，
 * 与 trace 骨架行的脚本侧短名形态对齐（同 run 混排两种形态曾致归组显示不一致）。
 */
function recordOnlyCall(record: SubagentRecord): WorkflowAgentCall {
  const mapped = mapStepStatusFromRecord(record)
  return {
    id: record.stepIndex!,
    agent: displayAgentName(record.agent),
    phase: undefined,
    status: mapped.status,
    model: record.model,
    sessionId: record.subagentId,
    startedAt: record.startedAt !== undefined ? toIsoTimestamp(record.startedAt) : undefined,
    completedAt: record.endedAt !== undefined ? toIsoTimestamp(record.endedAt) : undefined,
    durationMs: record.elapsedSeconds !== undefined ? record.elapsedSeconds * MS_PER_SECOND : undefined,
    turns: record.turns,
    error: mapped.error,
  }
}

/**
 * 候选集圈定与分桶：runId → stepIndex → 该键全部 record（多 attempt）。
 * [R3 守卫] parentRunId / stepIndex 任一缺失（存量 entry / tool 来源）不进候选——
 * 无 stepIndex 的 record 不成行，旧 session 回落 trace-only 视图（V5）。
 */
function bucketWorkflowCandidates(
  subagents: SubagentRecord[],
): Map<string, Map<number, SubagentRecord[]>> {
  const byRun = new Map<string, Map<number, SubagentRecord[]>>()
  for (const record of subagents) {
    const runId = record.parentRunId
    const stepIndex = record.stepIndex
    if (runId === undefined || stepIndex === undefined) continue
    let byStep = byRun.get(runId)
    if (byStep === undefined) {
      byStep = new Map<number, SubagentRecord[]>()
      byRun.set(runId, byStep)
    }
    const bucket = byStep.get(stepIndex)
    if (bucket === undefined) byStep.set(stepIndex, [record])
    else bucket.push(record)
  }
  return byRun
}

/**
 * 合并投影主入口（纯函数）：workflow 投影（trace 骨架）× subagent 投影（候选集）→
 * 合并后 WorkflowRunRecord[]。冷启动与实时增量共用（D5）。
 *
 * 幂等性：对已合并过的 record 重跑同一函数结果不变（trace 位覆盖合并读候选重算；
 * record-only 行携 id=stepIndex，重跑时落 trace 位覆盖而非重复 append）——实时增量
 * 路径对缓存反复重合并的正确性前提。
 */
export function mergeWorkflowStepRecords(
  records: WorkflowRunRecord[],
  subagents: SubagentRecord[],
): WorkflowRunRecord[] {
  if (records.length === 0 || subagents.length === 0) return records
  const candidates = bucketWorkflowCandidates(subagents)
  if (candidates.size === 0) return records
  return records.map((record) => mergeSingleRun(record, candidates.get(record.runId)))
}

/**
 * 单 run 合并：trace 位按 id（stepIndex）关联候选（无候选维持原样，R3 trace 独有）；
 * 候选有而 trace 无的 stepIndex 在骨架行之后按 stepIndex 升序成行（R3 record-only，
 * 步骤顺序 = trace 骨架序不回归 + record-only 追加尾部的稳定序）。
 */
function mergeSingleRun(
  record: WorkflowRunRecord,
  byStep: Map<number, SubagentRecord[]> | undefined,
): WorkflowRunRecord {
  if (byStep === undefined || byStep.size === 0) return record
  const merged = record.agentCalls.map((call) => {
    const bucket = byStep.get(call.id)
    if (bucket === undefined) return call
    return overlayTraceCall(call, pickAuthoritativeRecord(bucket))
  })
  const knownSteps = new Set(record.agentCalls.map((call) => call.id))
  const recordOnlySteps = Array.from(byStep.keys())
    .filter((stepIndex) => !knownSteps.has(stepIndex))
    .sort((a, b) => a - b)
  const appended = recordOnlySteps.map((stepIndex) =>
    recordOnlyCall(pickAuthoritativeRecord(byStep.get(stepIndex)!)),
  )
  if (appended.length === 0 && merged.every((call, i) => call === record.agentCalls[i])) {
    return record // 无任何变化：保持原引用（缓存水位 diff 的快速等价路径）
  }
  return { ...record, agentCalls: [...merged, ...appended] }
}
