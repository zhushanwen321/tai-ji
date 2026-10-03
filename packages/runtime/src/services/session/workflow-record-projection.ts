/**
 * workflow record 投影族（自 events-projection 拆出——subagent 域与 workflow 域
 * 是两个变化原因，投影判定各自独立演进；合并仲裁与 sources 持有态留主文件）。
 */
import type {
  RunAskStepFold,
  RunEventFoldCheckpoint,
  WorkflowRecordRegisteredEntryData,
  WorkflowRecordSettledEntryData,
} from "@zhushanwen/subagent-core";
import type { WorkflowRunRecord, WorkflowAgentCall } from "@taiji/shared";

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

/** 单个 ask 骨架行映射（phase 供源透传（W1 D6）——renderer hasExplicitPhases 判据 `phase !== undefined` 由此成立；fold 缺 phase（旧行）不造键保持平铺）。 */
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
  }
}

/**
 * [projectV2Workflow 拆分] fold 骨架兜底链（created 元数据半边）：scriptName/startedAt
 * 取注册条目，缺省回落 fold.created（run journal 重建的 run 名与起始时间），再缺省恒
 * ('(unknown)' / epoch 0)。独立小函数：`?.`/`??` 长链是圈复杂度计数大户，主归并函数保持平铺。
 */
function resolveWorkflowOrigin(
  registered: WorkflowRecordRegisteredEntryData | undefined,
  fold: RunEventFoldCheckpoint | undefined,
): Pick<WorkflowRunRecord, 'scriptName' | 'startedAt'> {
  return {
    scriptName: registered?.scriptName ?? fold?.created?.workflowName ?? '(unknown)',
    startedAt: toIso(registered?.startedAt ?? fold?.created?.ts ?? 0),
  }
}

/**
 * [projectV2Workflow 拆分] 身份半边归并：runId/scriptName/slug/scriptPath/startedAt 的
 * 注册条目 → fold 骨架兜底链（stateFilePath = 注册条目 recordPath 承载，v2 无
 * state 文件锚；v1 快照路径恒 '' 由 workflow-extractor 对空串隐藏）。
 * scriptPath：注册条目带 scriptPath（新 run）；旧条目/ v1 缺省 ''（消费侧按缺省
 * 处理，不回落猜路径）。
 */
function resolveWorkflowIdentity(
  registered: WorkflowRecordRegisteredEntryData | undefined,
  settledEntry: WorkflowRecordSettledEntryData,
  fold: RunEventFoldCheckpoint | undefined,
): Pick<WorkflowRunRecord, 'runId' | 'scriptName' | 'slug' | 'scriptPath' | 'startedAt' | 'stateFilePath'> {
  const origin = resolveWorkflowOrigin(registered, fold)
  return {
    runId: registered?.runId ?? settledEntry.runId,
    scriptName: origin.scriptName,
    slug: registered?.slug,
    scriptPath: registered?.scriptPath ?? '',
    startedAt: origin.startedAt,
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
  }
}
