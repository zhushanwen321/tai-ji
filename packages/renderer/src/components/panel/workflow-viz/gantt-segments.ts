/**
 * gantt-segments.ts —— Gantt 分段派生纯函数族（workflow-visualization 设计 §3.1-2
 * 语义规则①-④ + §3.3-D9 渲染层状态派生）。
 *
 * 数据源 = 事件流拉取结果（session.getWorkflowRunEvents → WorkflowRunEventEntry[]），
 * 不经 getWorkflows、不消费 phases 折叠（规则④：fold 对同名 phase 是 last-wins 单行
 * 快照——多轮丢旧轮、resume 重放可产逆序区间）。输出 = u2 冻结的分段视图模型
 * （WorkflowGanttSegments，shared/workflow.ts——派生函数与 u4 展示组件共用契约）。
 *
 * 帧序级口径以实装采集的 fixture 为准（u0 采集的 rebuild/resume 样本，
 * __tests__/fixtures/），本文件不断言样本之外的帧序形态。
 *
 * 纯函数零 IO：输入坏行/缺帧一律降级输出（started 缺行 → 该 call 不分段不判损坏，
 * 对齐 D5 自愈口径），不 throw。
 */
import type {
  WorkflowAgentCall,
  WorkflowGanttAttemptSegment,
  WorkflowGanttPhaseBand,
  WorkflowGanttPhaseCard,
  WorkflowGanttSegmentState,
  WorkflowGanttSegments,
  WorkflowRunEventEntry,
  WorkflowRunOutcome,
  WorkflowRunStatus,
} from '@taiji/shared'

// ── agent-settled outcome → 段收束态映射 ─────────────────────────────────────
// agent-settled.outcome 协议值域 = done/failed/cancelled（time_limited 为 run 级、
// shared/workflow.ts 注释明示）；time_limited 分支是值域外防御兜底，落失败色系——
// 不猜新语义，注释声明兜底性质。
function outcomeToSegmentState(outcome: WorkflowRunOutcome): WorkflowGanttSegmentState {
  switch (outcome) {
    case 'done':
      return 'done'
    case 'failed':
    case 'time_limited':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default: {
      const exhaustive: never = outcome
      throw new Error(`unreachable outcome: ${String(exhaustive)}`)
    }
  }
}

/** run 级转移帧（attempt 段未收束终点的锚集合；phase 级转移另含 phase-started/settled）。 */
function isRunTransitionFrame(e: WorkflowRunEventEntry): boolean {
  return e.type === 'run-interrupted' || e.type === 'run-settled'
}

/** phase 级或 run 级转移帧（phase 色带无 settled 帧时的收束锚集合，规则②）。 */
function isPhaseOrRunTransitionFrame(e: WorkflowRunEventEntry): boolean {
  return (
    e.type === 'phase-started' ||
    e.type === 'phase-settled' ||
    e.type === 'run-interrupted' ||
    e.type === 'run-settled'
  )
}

/** agent 执行事实帧（agent-started/retrying/settled——携带 taskIndex/phase 载荷）。 */
function isAgentEventFrame(e: WorkflowRunEventEntry): boolean {
  return e.type === 'agent-started' || e.type === 'agent-retrying' || e.type === 'agent-settled'
}

/** agent 帧的 taskIndex（三类 agent 帧全携带；类型收窄辅助）。 */
function agentTaskIndex(e: WorkflowRunEventEntry): number | undefined {
  return e.type === 'agent-started' || e.type === 'agent-retrying' || e.type === 'agent-settled'
    ? e.taskIndex
    : undefined
}

/**
 * agent 帧的 phase 归属。协议载荷只有 agent-started 携带 phase 字段（retrying/settled
 * 均无）——phase 级归属判据（空段判据/纯脚本判定）锚 started 帧：每 call 至少一帧
 * started（缺行 call 已在 attempt 分段降级），started 是派发事实的最小完备归属锚。
 */
function agentEventPhase(e: WorkflowRunEventEntry): string | undefined {
  return e.type === 'agent-started' ? e.phase : undefined
}

// ── 规则①：call 级 attempt 分段（含执行代际划分）───────────────────────────

interface CallFrameGroup { // oe-exempt:20261002:framework:workflow-viz 分段派生纯函数的内部数据形状（代际分组的帧集合载体，非抽象接口）
  /** 该 taskIndex 的 agent-started 帧下标（事件流序；帧数 = 执行代际数）。 */
  startedIdx: number[]
  /** 该 taskIndex 的 agent-retrying 帧下标。 */
  retryingIdx: number[]
  /** 该 taskIndex 的 agent-settled 帧下标（协议每 call 恰一终局帧）。 */
  settledIdx: number[]
}

/**
 * 按事件流序扫描，把 agent 帧按 taskIndex 载荷分组到 call（配对不依赖帧序位置，
 * 规则①；组内代际划分与起止反推用事件流位置序）。
 */
function groupCallFrames(events: readonly WorkflowRunEventEntry[]): Map<number, CallFrameGroup> {
  const groups = new Map<number, CallFrameGroup>()
  for (let i = 0; i < events.length; i++) {
    const taskIndex = agentTaskIndex(events[i])
    if (taskIndex === undefined) continue
    let group = groups.get(taskIndex)
    if (!group) {
      group = { startedIdx: [], retryingIdx: [], settledIdx: [] }
      groups.set(taskIndex, group)
    }
    const kind = events[i].type
    if (kind === 'agent-started') group.startedIdx.push(i)
    else if (kind === 'agent-retrying') group.retryingIdx.push(i)
    else group.settledIdx.push(i)
  }
  return groups
}

/**
 * 帧的区间归属判定键：区间内（含边界帧）全部帧携带 seq（新格式）时用 seq 严格序
 * （同 ts 帧的归属不含糊——phase-settled 与 agent-settled 常同 ts）；任一帧缺 seq
 * 即整体降级 epoch ms 半开区间 [startTs, endTs)。混合形态（部分行缺 seq = W1 前
 * 旧格式）按缺 seq 处理——判定扫描区间内全部帧，防中部缺 seq 帧在 seq 模式下被
 * frameInInterval 判在区间外（本段误判重放空段）。
 */
interface IntervalKey { // oe-exempt:20261002:framework:workflow-viz 分段视图模型/派生契约类型——类型契约先行、单实现常态
  useSeq: boolean
  startSeq: number
  endSeq: number
  startTs: number
  endTs: number
}

function makeIntervalKey(events: readonly WorkflowRunEventEntry[], startIdx: number, endIdx: number): IntervalKey {
  const start = events[startIdx]
  // endIdx === events.length = 开放式哨兵（无收束锚的运行中段——区间上界开放，见
  // derivePhaseBands；此时 end 帧不存在，seq 检查只扫到事件流末帧）
  const end = endIdx < events.length ? events[endIdx] : undefined
  let useSeq = true
  for (let i = startIdx; i <= endIdx && i < events.length; i++) {
    if (events[i].seq === undefined) {
      useSeq = false
      break
    }
  }
  return {
    useSeq,
    startSeq: start.seq ?? 0,
    endSeq: end?.seq ?? Number.POSITIVE_INFINITY,
    startTs: start.ts,
    endTs: end?.ts ?? Number.POSITIVE_INFINITY,
  }
}

function frameInInterval(e: WorkflowRunEventEntry, key: IntervalKey): boolean {
  if (key.useSeq) {
    return e.seq !== undefined && e.seq > key.startSeq && e.seq < key.endSeq
  }
  return e.ts >= key.startTs && e.ts < key.endTs
}

/**
 * 规则①主派生：attempt 分段（同 taskIndex 多帧 agent-started = 多执行代际；代际间
 * 独立分段不相连——中断/崩溃空隙可见）。started 帧缺失的 call 零产出（降级不分段、
 * 不判损坏）。
 *
 * 代际内拆段口径（§4 retrying 变体对账后定稿）：「attempt N 失败终点 = retrying_N.ts
 * − backoffMs、attempt N+1 起点 = retrying_N.ts」的反推拆段只在后续有执行事实（settled
 * 或后续 retrying）时成立——退避等待中崩溃/中断时 attempt N+1 无执行事实，不开悬空段，
 * 该代际恒单段。因此：
 * - 代际收束（窗口内有 settled）：按「started → retrying 链 → settled」逐帧拆段，失败
 *   段终点 = retrying.ts − backoffMs（红段）、终局段终点 = settled.ts；
 * - 代际未收束（无 settled）：恒单段 [started.ts, 锚点]，段 state 恒 'running'（停止
 *   着色归消费方按 run 级 status/outcome 派生，D9 单点）。锚点顺序：
 *   1. 代际窗口（本代际 started → 下一代际 started）内的 run 级转移帧最早一帧 ts
 *      （中断 = run-interrupted.ts；终局 = run-settled.ts；时间序统一两情形）；
 *   2. 窗口内无转移帧（worker 崩溃 rebuild 形态）= 该代际最后一个该 taskIndex 自有的
 *      agent-* 执行事实帧 ts（并行 rebuild 场景不锚到其他 call 的帧；重落的
 *      phase-started 非 agent-* 帧不参与锚定；末帧为 agent-retrying 帧的变体段终点 =
 *      retrying.ts）。
 */
function deriveAttemptSegments(events: readonly WorkflowRunEventEntry[]): WorkflowGanttAttemptSegment[] {
  const groups = groupCallFrames(events)
  const segments: WorkflowGanttAttemptSegment[] = []

  const runTransitionIdx: number[] = []
  for (let i = 0; i < events.length; i++) {
    if (isRunTransitionFrame(events[i])) runTransitionIdx.push(i)
  }

  const sortedTaskIndexes = [...groups.keys()].sort((a, b) => a - b)
  for (const taskIndex of sortedTaskIndexes) {
    const group = groups.get(taskIndex)
    if (!group || group.startedIdx.length === 0) continue // started 缺行 → 降级不分段

    for (let gen = 0; gen < group.startedIdx.length; gen++) {
      const startIdx = group.startedIdx[gen]
      const startFrame = events[startIdx] as Extract<WorkflowRunEventEntry, { type: 'agent-started' }>
      const windowEnd = gen + 1 < group.startedIdx.length ? group.startedIdx[gen + 1] : events.length

      // 本代际自有的 retrying / settled 帧（窗口内）
      const genSettledIdx = group.settledIdx.find((i) => i > startIdx && i < windowEnd)
      const genRetryIdx = group.retryingIdx.filter(
        (i) => i > startIdx && i < windowEnd && (genSettledIdx === undefined || i < genSettledIdx),
      )

      const pushSegment = (generation: number, attempt: number, startTs: number, endTs: number, state: WorkflowGanttSegmentState): void => {
        // 墙钟倒挂防御：反推终点早于段起点（retrying.ts − backoffMs 越 start）时钳到
        // 段起点，不产出逆序段（不虚构精度——钳位是显示下界，不是时间修正）
        segments.push({
          taskIndex,
          generation,
          attempt,
          startTs,
          endTs: Math.max(endTs, startTs),
          state,
        })
      }

      if (genSettledIdx !== undefined) {
        // 收束代际：started → retrying 链 → settled 逐帧拆段
        const settled = events[genSettledIdx] as Extract<WorkflowRunEventEntry, { type: 'agent-settled' }>
        const boundaries: Array<{ idx: number; ts: number; attempt: number }> = [
          { idx: startIdx, ts: startFrame.ts, attempt: startFrame.attempt },
          ...genRetryIdx.map((i) => {
            const retry = events[i] as Extract<WorkflowRunEventEntry, { type: 'agent-retrying' }>
            return { idx: i, ts: retry.ts, attempt: retry.attempt + 1 }
          }),
        ]
        for (let b = 0; b < boundaries.length; b++) {
          const cur = boundaries[b]
          const next = boundaries[b + 1]
          if (next !== undefined) {
            const retry = events[next.idx] as Extract<WorkflowRunEventEntry, { type: 'agent-retrying' }>
            pushSegment(gen + 1, cur.attempt, cur.ts, retry.ts - retry.backoffMs, 'failed')
          } else {
            pushSegment(gen + 1, cur.attempt, cur.ts, settled.ts, outcomeToSegmentState(settled.outcome))
          }
        }
        continue
      }

      // 未收束代际：恒单段，锚点 = 窗口内最早 run 级转移帧，否则最后自有 agent-* 帧
      const windowTransition = runTransitionIdx.find((i) => i > startIdx && i < windowEnd)
      const anchorTs =
        windowTransition !== undefined
          ? events[windowTransition].ts
          : genRetryIdx.length > 0
            ? events[genRetryIdx[genRetryIdx.length - 1]].ts
            : startFrame.ts
      pushSegment(gen + 1, startFrame.attempt, startFrame.ts, anchorTs, 'running')
    }
  }
  return segments
}

// ── 规则②：phase 级色带分段 ──────────────────────────────────────────────────

/**
 * 规则②主派生：phase 色带段（每帧 phase-started 各开一段、各段独立绘制不相连）。
 *
 * 段终点：本段 phase-settled.ts；无 settled 帧 = 本段之后第一个 phase 级或 run 级
 * 转移帧 ts（含重落 phase-started / run-interrupted / run-settled）；两者皆无 =
 * 事件流最后已知帧 ts、state 'running'（run 未终局如实进行中）。
 *
 * 空段判据（两级，锚 phase 级历史属性不依赖帧序）：该 phase 名下事件流历史存在
 * agent 事件 ∧ 本段区间零 agent 事件 = 重放空段（emptyReplay=true，消费方不绘制、
 * 不计轮次）。纯脚本 phase（全历史零 agent 事件）不受空段规则约束——emptyReplay
 * 恒 false，全部段为脚本执行段（斜纹绘制）。
 */
function derivePhaseBands(events: readonly WorkflowRunEventEntry[]): {
  bands: WorkflowGanttPhaseBand[]
  agentPhasesWithEvents: Set<string>
} {
  // phase 级 agent 事件历史（有 call 的 phase 判据——锚历史属性，不依赖帧序）
  const agentPhasesWithEvents = new Set<string>()
  for (const e of events) {
    if (!isAgentEventFrame(e)) continue
    const phase = agentEventPhase(e)
    if (phase !== undefined) agentPhasesWithEvents.add(phase)
  }

  // agent 帧列表（区间归属判定数据源）
  const agentFrames = events.filter(isAgentEventFrame)

  const bands: WorkflowGanttPhaseBand[] = []
  const startedIdx: number[] = []
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === 'phase-started') startedIdx.push(i)
  }

  for (const startIdx of startedIdx) {
    const frame = events[startIdx] as Extract<WorkflowRunEventEntry, { type: 'phase-started' }>
    const phase = frame.phase
    const { endIdx, state } = resolveBandEnd(events, startIdx)

    // 本段区间零 agent 事件判定（seq 严格序优先，同 ts 帧归属不含糊；缺 seq 降级 ts 半开区间）
    const key = makeIntervalKey(events, startIdx, endIdx)
    const hasAgentInInterval = agentFrames.some(
      (e) => agentEventPhase(e) === phase && frameInInterval(e, key),
    )
    const phaseHasAgentHistory = agentPhasesWithEvents.has(phase)
    const emptyReplay = phaseHasAgentHistory && !hasAgentInInterval

    const displayEndTs = endIdx < events.length ? events[endIdx].ts : events[events.length - 1].ts
    bands.push({ phase, startTs: frame.ts, endTs: displayEndTs, emptyReplay, state })
  }

  return { bands, agentPhasesWithEvents }
}

/**
 * 单段收束（endIdx + state）锚定（单遍扫描、转移帧先到者胜）：
 * 本段之后第一个 phase 级或 run 级转移帧 → settled（含同 phase 的
 * phase-settled = 本轮正常收束；重落 phase-started / run-interrupted /
 * run-settled = 换段/中断/终局截断）；无转移帧：run 未终局如实进行中。
 * 区间上界 = 开放哨兵（events.length，见 makeIntervalKey——区间内唯一
 * agent 帧恰为事件流末帧时不被边界排除）；显示终点 = 最后已知帧 ts
 * （首帧自身兜底空流形态）→ running。
 *
 * 同名 phase-settled 的搜索不越过转移帧（先到者胜，规则②「本轮 settled」口径）：
 * 中断+resume 形态第一段本轮无 settled，若越过 run-interrupted 采重放轮的
 * settled，会吞掉中断空隙并与重放段完全重叠（各段独立绘制不相连）。
 */
function resolveBandEnd(
  events: readonly WorkflowRunEventEntry[],
  startIdx: number,
): { endIdx: number; state: WorkflowGanttPhaseBand['state'] } {
  for (let i = startIdx + 1; i < events.length; i++) {
    if (isPhaseOrRunTransitionFrame(events[i])) {
      return { endIdx: i, state: 'settled' }
    }
  }
  return { endIdx: events.length, state: 'running' }
}

// ── 规则③：phase tab 头卡 ────────────────────────────────────────────────────

/**
 * 规则③派生：phase 头卡（跨轮聚合区间 + 轮次计数 + 状态）。轮次计数 = 非空段段数
 * （phase-started 帧数 ≠ 轮次数；纯脚本 phase 段数即轮数）；状态 = 最新非空段收束态
 * （未收束 = 'running'、收束 = 'settled'，不另设推导）。聚合区间取非空段首尾——
 * 全部为空段（极端形态）时回落全部段首尾、turnCount = 0。
 */
function derivePhaseCards(
  bands: readonly WorkflowGanttPhaseBand[],
  agentPhasesWithEvents: ReadonlySet<string>,
): WorkflowGanttPhaseCard[] {
  const byPhase = new Map<string, WorkflowGanttPhaseBand[]>()
  for (const band of bands) {
    const list = byPhase.get(band.phase) ?? []
    list.push(band)
    byPhase.set(band.phase, list)
  }

  const cards: WorkflowGanttPhaseCard[] = []
  for (const [phase, phaseBands] of byPhase) {
    const nonEmpty = phaseBands.filter((b) => !b.emptyReplay)
    const source = nonEmpty.length > 0 ? nonEmpty : phaseBands
    const first = source[0]
    const last = source[source.length - 1]
    cards.push({
      phase,
      startTs: first.startTs,
      endTs: last.endTs,
      turnCount: nonEmpty.length,
      state: last.state,
      scriptOnly: !agentPhasesWithEvents.has(phase),
    })
  }
  return cards
}

/**
 * Gantt 分段派生主入口（§3.1-2 规则①②③；规则④ = 本函数不消费 phases 折叠——
 * 输入仅事件流）。输入为空事件流时输出全空容器（合法输出，非错误）。
 */
export function deriveWorkflowGanttSegments(events: readonly WorkflowRunEventEntry[]): WorkflowGanttSegments {
  const attemptSegments = deriveAttemptSegments(events)
  const { bands, agentPhasesWithEvents } = derivePhaseBands(events)
  const phaseCards = derivePhaseCards(bands, agentPhasesWithEvents)
  return { attemptSegments, phaseBands: bands, phaseCards }
}

// ── §3.3-D9：节点/行状态派生（trace 表与 DAG 共用同一函数——S2 构造性一致）────

/**
 * call 级渲染态词表（D9：投影四值 + retrying 派生态；skipped 是节点级派生态、
 * 不在 call 行出现）。
 */
export type WorkflowCallDerivedStatus = 'pending' | 'running' | 'done' | 'failed' | 'retrying'

export interface WorkflowCallDerivedView { // oe-exempt:20261002:framework:workflow-viz 分段视图模型/派生契约类型——类型契约先行、单实现常态
  status: WorkflowCallDerivedStatus
  /**
   * run 已停止（status !== 'running'：interrupted 暂停态或 terminal 终局）且该 call
   * 在途（无 settled 帧）→ true。消费方按此叠加停止着色、不显示 running 蓝脉冲；
   * 着色映射随 run 终局 outcome（cancelled → 取消色、failed/time_limited → 失败色系）。
   *
   * 「在途」= 已派发未收束（投影 running）；pending（零派发）不属在途——其终局后
   * 语义由 DAG skipped 态承载（D9：skipped 仅 run 终局后判定），不叠加停止着色。
   */
  stoppedInFlight: boolean
}

/**
 * D9 call 级派生：retrying = 该 call 存在 agent-retrying 事件且尚无终局 settled。
 * 判定数据源 = U3 投影透出的 per-call attempts 计数（fold 行语义：失败尝试累计，
 * 无重试 undefined——fold attempts 仅由 agent-retrying 帧写入，attempts !== undefined
 * ⟺ 已落 retrying 帧；值 = 帧载荷 attempt，首败 = 1）。attempts 有值 ∧ 投影 running
 * 与「存在 retrying 帧 ∧ 无 settled」逐字等价（终局帧落盘时投影 status 已翻
 * done/failed，终局态优先；首败重试窗口——retrying 帧已落、settled 未落、投影
 * running、attempts = 1——由此判据覆盖，这是 (attempts ?? 1) >= 2 下界判据系统性
 * 漏掉的窗口）。注意不得用 (attempts ?? 1) >= 1——会把无重试 running 误判 retrying。
 * 重试窗口内 retrying 态随重试边沿信号触发的重新拉取到达（U3 diff 维度），非仅事后可见。
 * attempts 为全历史累计（fold 不分代际——agent-started 重派帧只推进进度边沿不清
 * 计数）：resume 重派同 taskIndex 后新代际正常执行期间，旧代际 retrying 帧仍使
 * attempts 有值 → 该窗口显示 retrying 属预期（设计 D9 判据不限定代际，历史重试
 * 提示语义，非新代际异常）。
 */
export function deriveCallView(
  call: Pick<WorkflowAgentCall, 'status' | 'attempts'>,
  runStatus: WorkflowRunStatus,
): WorkflowCallDerivedView {
  const hasRetryHistory = call.attempts !== undefined
  let status: WorkflowCallDerivedStatus
  switch (call.status) {
    case 'running':
      status = hasRetryHistory ? 'retrying' : 'running'
      break
    case 'pending':
    case 'done':
    case 'failed':
      status = call.status
      break
    default: {
      const exhaustive: never = call.status
      throw new Error(`unreachable call status: ${String(exhaustive)}`)
    }
  }
  return {
    status,
    stoppedInFlight: runStatus !== 'running' && call.status === 'running',
  }
}

/** DAG 节点级渲染态词表（D9 六态；retrying/skipped 为渲染层派生、不进协议）。 */
export type WorkflowNodeDerivedStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'retrying'
  | 'skipped'

export interface WorkflowNodeDerivedInput { // oe-exempt:20261002:framework:workflow-viz 分段视图模型/派生契约类型——类型契约先行、单实现常态
  /** run 投影状态（running/interrupted/done——done 即终局）。 */
  runStatus: WorkflowRunStatus
  /** 挂接到该节点的实例（D2 匹配结果；零实例 = 零实例挂接节点）。 */
  calls: ReadonlyArray<Pick<WorkflowAgentCall, 'status' | 'attempts'>>
}

/**
 * D9 节点级派生：
 * - skipped = 仅在 run 终局后判定（status === 'done'）的零实例挂接节点——含条件
 *   phase 整段未执行；run 运行中/中断（暂停态）零实例节点一律 pending，防循环重入
 *   场景「phase 第一轮收束、第二轮未到」时下轮才执行的调用点被误判 skipped 而震荡。
 * - 有实例：按实例渲染态聚合，优先级 retrying > running > failed > done > pending
 *   （failed > done：含失败实例的节点显示失败——对齐 WorkflowTab aggregatePhaseStatus
 *   「含 failed 即 failed」先例；retrying/running 优先表达进行中故障与活动）。
 */
export function deriveNodeStatus(input: WorkflowNodeDerivedInput): WorkflowNodeDerivedStatus {
  if (input.calls.length === 0) {
    return input.runStatus === 'done' ? 'skipped' : 'pending'
  }
  const views = input.calls.map((c) => deriveCallView(c, input.runStatus))
  if (views.some((v) => v.status === 'retrying')) return 'retrying'
  if (views.some((v) => v.status === 'running')) return 'running'
  if (views.some((v) => v.status === 'failed')) return 'failed'
  if (views.every((v) => v.status === 'done')) return 'done'
  return 'pending'
}
