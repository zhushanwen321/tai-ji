/**
 * workflow record 投影族（自 events-projection 拆出——subagent 域与 workflow 域
 * 是两个变化原因，投影判定各自独立演进；合并仲裁与 sources 持有态留主文件）。
 */
import type {
  RunAskStepFold,
  RunEventFoldCheckpoint,
  RunJournalFold,
  WorkflowRecordRegisteredEntryData,
  WorkflowRecordSettledEntryData,
} from "@zhushanwen/subagent-core";
import type {
  SubagentModelOverrideStatus,
  SubagentRecord,
  WorkflowRunRecord,
  WorkflowAgentCall,
  WorkflowRunPhaseFoldEntry,
} from "@taiji/shared";

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

/**
 * [projectV2Workflow 拆分] 三态投影（事件源胜出仲裁的判据面）。
 *
 * [D2] fold 在场 = 事件流 已接线，三态全由 fold 定，条目 status 不参与——条目是
 * append-only last-wins 快照，resume 复活只补写 registered 条目、留存的中断形态
 * 条目不被覆盖，条目值在 fold 在场时会陈旧；resume 后 fold 已回 running，此时按
 * 留存中断条目判 interrupted 会把复活 run 误显示「已中断（可续跑）」直到终局：
 * - fold 在场：runSettled 终帧 → done；状态机停 interrupted 暂停态
 *   （run-interrupted 帧在盘、无终局）→ interrupted（GUI 显示「已中断
 *   （可续跑）」）；其余 → running；
 * - fold 缺席（entry-only 降级投影：runJournalDir 缺席或 record 流被外部
 *   清理，条目是唯一来源）：settledEntry 三态自描述（schema 契约见 core
 *   workflow-record-entry），中断 run 不得回落显示「运行中」。
 */
function resolveWorkflowStatus(
  fold: RunEventFoldCheckpoint | undefined,
  runSettled: RunEventFoldCheckpoint['runSettled'],
  settledEntry: WorkflowRecordSettledEntryData | undefined,
): WorkflowRunRecord['status'] {
  if (fold === undefined) {
    if (settledEntry?.status === 'done') return 'done'
    if (settledEntry?.status === 'interrupted') return 'interrupted'
    return 'running'
  }
  if (runSettled !== undefined) return 'done'
  if (fold.state.lifecycle === 'interrupted') return 'interrupted'
  return 'running'
}

/** [projectV2Workflow 拆分] ask 步骤行 → agentCalls（骨架映射，taskIndex 升序）。 */
function projectAskStepsToAgentCalls(fold: RunEventFoldCheckpoint): WorkflowAgentCall[] {
  const agentCalls: WorkflowAgentCall[] = []
  const indexes = Array.from(fold.asks.keys()).sort((a, b) => a - b)
  for (const taskIndex of indexes) {
    const ask = fold.asks.get(taskIndex)!
    agentCalls.push(projectAskStepToAgentCall(ask))
  }
  return agentCalls
}

/**
 * [projectV2Workflow 拆分] 单个 ask 骨架行 → agentCalls 行（骨架映射，taskIndex 升序）。
 *
 * [可视化 U3，设计 §3.1-4] fold 新字段透出（W2 D7 单源——只读骨架行，不自建第二套 fold）：
 * - attempts/lastRetry（agent-retrying 帧驱动）：供 retrying 派生态与 trace attempt 列；
 * - usage 分项 → inputTokens/outputTokens/turns（settled 帧 result.usage 透传——core
 *   AgentUsage = SDK AgentOutcomeUsage 别名，含 turns；contextTokens/cacheRead/
 *   cacheWrite/cost 无 shared 消费位不透出）；attempts/lastRetry 缺省 = 无重试记录不造键。
 */
function projectAskStepToAgentCall(ask: RunAskStepFold): WorkflowAgentCall {
  const stepStatus: WorkflowAgentCall['status'] =
    ask.settled === undefined
      ? 'running'
      : ask.settled.outcome === 'done'
        ? 'done'
        : 'failed'
  return {
    id: ask.taskIndex,
    agent: ask.agentName,
    ...(ask.phase !== undefined ? { phase: ask.phase } : {}),
    status: stepStatus,
    startedAt: toIso(ask.startedAt),
    ...(ask.settled !== undefined ? { completedAt: toIso(ask.settled.ts) } : {}),
    ...(ask.settled?.durationMs !== undefined ? { durationMs: ask.settled.durationMs } : {}),
    ...(ask.settled?.errorCode !== undefined ? { error: ask.settled.errorCode } : {}),
    lastProgressAt: ask.lastProgressAt,
    ...(ask.attempts !== undefined ? { attempts: ask.attempts } : {}),
    ...(ask.lastRetry !== undefined ? { lastRetry: ask.lastRetry } : {}),
    ...(ask.usage !== undefined
      ? { inputTokens: ask.usage.input, outputTokens: ask.usage.output, turns: ask.usage.turns }
      : {}),
  }
}

/**
 * [可视化 U3] phase 折叠行映射（last-wins 单行快照透传；settledBy 是 fold 内部
 * 翻回裁决标记，协议不透出——shared WorkflowRunPhaseFoldEntry u2 冻结注释）。
 * 展示消费位 = 对话流 block chips（Gantt 色带/头卡经事件流 RPC 按轮分段，禁消费本字段）。
 */
function projectPhaseFolds(phases: RunJournalFold['phases']): WorkflowRunPhaseFoldEntry[] {
  const entries: WorkflowRunPhaseFoldEntry[] = []
  for (const row of phases.values()) {
    entries.push({
      phase: row.phase,
      startedAt: row.startedAt,
      ...(row.settledAt !== undefined ? { settledAt: row.settledAt } : {}),
    })
  }
  return entries
}

/**
 * [projectV2Workflow 拆分] 身份半边归并：runId/scriptName/slug/startedAt 的
 * 注册条目 → fold 骨架兜底链（stateFilePath = 注册条目 recordPath 承载，v2 无
 * state 文件锚；v1 快照路径恒 '' 由 workflow-extractor 对空串隐藏）。
 */
function resolveWorkflowIdentity(
  registered: WorkflowRecordRegisteredEntryData | undefined,
  settledEntry: WorkflowRecordSettledEntryData,
  fold: RunEventFoldCheckpoint | undefined,
): Pick<WorkflowRunRecord, 'runId' | 'scriptName' | 'slug' | 'startedAt' | 'stateFilePath'> {
  return {
    runId: registered?.runId ?? settledEntry.runId,
    scriptName: registered?.scriptName ?? fold?.created?.workflowName ?? '(unknown)',
    slug: registered?.slug,
    startedAt: toIso(registered?.startedAt ?? fold?.created?.ts ?? 0),
    stateFilePath: registered?.recordPath ?? '',
  }
}

/**
 * [projectV2Workflow 拆分] 终局半边归并：统计摘要（条目独有）+ outcome/errorCode
 * （事件终帧优先、条目兜底）；条件展开保持「键缺席」语义（与原组装逐字节同构）。
 */
function resolveWorkflowSettlement(
  settledEntry: WorkflowRecordSettledEntryData | undefined,
  runSettled: RunEventFoldCheckpoint['runSettled'],
): Partial<Pick<WorkflowRunRecord, 'completedAt' | 'usedTokens' | 'totalCallCount' | 'outcome' | 'errorCode'>> {
  const outcome: WorkflowRunRecord['outcome'] | undefined =
    runSettled?.outcome ?? settledEntry?.outcome
  const errorCode: string | undefined = runSettled?.errorCode ?? settledEntry?.errorCode
  return {
    ...(settledEntry !== undefined ? { completedAt: toIso(settledEntry.settledAt) } : {}),
    ...(settledEntry !== undefined ? { usedTokens: settledEntry.usedTokens } : {}),
    ...(settledEntry !== undefined ? { totalCallCount: settledEntry.callCount } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
  }
}

/**
 * v2 workflow 实体的合并投影：事件 fold 供骨架（ask 步骤行）与终局，注册/
 * 终态条目供 scriptName/slug/reason 词表与统计摘要。
 *
 * 定界（run 域的 session 归属）：注册或终态条目缺席 = 该 run 非本会话实体
 * （workflow-state 目录按 cwd 共享，其他会话的 run 只存在于 run journal——不进投影）。
 */
export function projectV2Workflow(
  registered: WorkflowRecordRegisteredEntryData | undefined,
  settledEntry: WorkflowRecordSettledEntryData | undefined,
  fold: RunEventFoldCheckpoint | undefined,
): WorkflowRunRecord | null {
  if (registered === undefined && settledEntry === undefined) return null
  const runSettled = fold?.runSettled
  const status = resolveWorkflowStatus(fold, runSettled, settledEntry)
  // reason 词表收窄：core DoneReason ⊃ shared WorkflowDoneReason（core 另含
  // invalid_args 等扩展值，shared 信号面不认——词表外按缺省归一，不硬透传）
  const reason =
    settledEntry?.reason !== undefined && isWorkflowDoneReason(settledEntry.reason)
      ? settledEntry.reason
      : undefined
  const identity = resolveWorkflowIdentity(registered, settledEntry!, fold)
  const settlement = resolveWorkflowSettlement(settledEntry, runSettled)
  return {
    ...identity,
    status,
    reason,
    agentCalls: fold !== undefined ? projectAskStepsToAgentCalls(fold) : [],
    ...settlement,
    // [可视化 U3，设计 §3.1-4] phases 折叠透出（last-wins 单行快照，消费位 = block
    // chips）+ run args 摘要（fold created 行透传）。fold 缺席（entry-only 降级投影）
    // 或无 phases 行不造键——缺省语义 = 旧投影无此字段。
    ...(fold !== undefined && fold.phases.size > 0 ? { phases: projectPhaseFolds(fold.phases) } : {}),
    ...(fold?.created?.argsSummary !== undefined ? { argsSummary: fold.created.argsSummary } : {}),
  }
}

/**
 * run 详情载荷的模型字段增强（subagent-model-switch §9 transport 行，U1 详情载荷
 * 透传——run 详情侧按成员标识逐成员携带、聚合面不取单一值）：
 * - **覆盖状态**：run 级覆盖（query.getRunOverride）分发到该 run 全部 agentCall 条目
 *   （run 级全切是 run 作用域意图，各成员条目携带同值；无覆盖不造键）；
 * - **最近生效值**：成员 SubagentRecord 的增强产物（调用方先经 enhanceSubagentDetails
 *   派生——含 pi session model_change 尾条目读取与「仅 pi 成员」判定）按
 *   (parentRunId, stepIndex) 圈定后透传到对应 agentCall。同族替换可只发生在部分成员，
 *   聚合面不取单一值；一键多 attempt 的权威成员取与 workflow-step-merge.pickAuthoritativeRecord
 *   同判据（running 优先、startedAt 最新——显示权威一致）。
 *
 * 纯函数（无 IO）；输入 runs/subagents 均为已合并投影产物，无增强项时返回原引用
 * （零拷贝快路径，调用方 getWorkflows 每次读 RPC 消费）。sessionId 是覆盖查询的
 * 定位锚首参（query 实装按 session cwd 分片定位记录域文件——无全局 id 索引）。
 */
export function projectSubagentModelDetailIntoRuns(
  sessionId: string,
  runs: WorkflowRunRecord[],
  subagents: SubagentRecord[],
  query:
    | {
        getRecordOverride(sessionId: string, recordId: string): SubagentModelOverrideStatus | undefined
        getRunOverride(sessionId: string, runId: string): SubagentModelOverrideStatus | undefined
      }
    | undefined,
): WorkflowRunRecord[] {
  if (runs.length === 0) return runs
  // 成员圈定索引：(parentRunId, stepIndex) → 权威 record（同判据 pickAuthoritativeRecord：
  // running 优先，次取 startedAt 最新）。
  const byRun = new Map<string, Map<number, SubagentRecord>>()
  for (const record of subagents) {
    const runId = record.parentRunId
    const stepIndex = record.stepIndex
    if (runId === undefined || stepIndex === undefined) continue
    let byStep = byRun.get(runId)
    if (byStep === undefined) {
      byStep = new Map<number, SubagentRecord>()
      byRun.set(runId, byStep)
    }
    const incumbent = byStep.get(stepIndex)
    if (incumbent === undefined || pickAuthoritativeMember(record, incumbent)) byStep.set(stepIndex, record)
  }
  let result: WorkflowRunRecord[] | null = null
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!
    const byStep = byRun.get(run.runId)
    const runOverride = query?.getRunOverride(sessionId, run.runId)
    if (byStep === undefined && runOverride === undefined) continue
    let changed = false
    const agentCalls = run.agentCalls.map((call) => {
      const member = byStep?.get(call.id)
      const override = runOverride ?? member?.modelOverride
      const recent = member?.recentEffectiveModel
      if (override === undefined && recent === undefined) return call
      // 引用相等短路（返回值直进 RPC reply 不缓存，无跨轮幂等消费位；形状级比较
      // 不必——成员增强产物每次读 RPC 重派生）。
      if (call.modelOverride === override && call.recentEffectiveModel === recent) return call
      changed = true
      return {
        ...call,
        ...(override !== undefined ? { modelOverride: override } : {}),
        ...(recent !== undefined ? { recentEffectiveModel: recent } : {}),
      }
    })
    if (!changed) continue
    if (result === null) result = runs.slice(0, i)
    result.push({ ...run, agentCalls })
  }
  return result ?? runs
}

/**
 * 成员权威判据（与 workflow-step-merge.pickAuthoritativeRecord 同判据的二元形式）：
 * running 优先；同态取 startedAt 最新（缺失视为最早）。成员模型字段透传的显示权威
 * 与步骤行权威一致，避免同一 call 两处取不同 attempt 的字段。
 */
function pickAuthoritativeMember(candidate: SubagentRecord, incumbent: SubagentRecord): boolean {
  const candidateRunning = candidate.status === 'running'
  const incumbentRunning = incumbent.status === 'running'
  if (candidateRunning !== incumbentRunning) return candidateRunning
  return (candidate.startedAt ?? Number.NEGATIVE_INFINITY) >= (incumbent.startedAt ?? Number.NEGATIVE_INFINITY)
}
