/**
 * workflow 步骤视图合并投影测试（W0 / 设计 workflow-step-visibility-data-source
 * D2 R1-R3 / D4 / D5）。
 *
 * 覆盖（验收对齐设计 §4 与 U2 单测清单；entry 契约 = v2 registered/settled 两条小条目
 * ——v2 条目不承载 trace/agentCalls，其供源在 run journal fold，故 entry 载 trace 的
 * 冷热 fixture 对拍随 v1 快照兼容层删除，对应项改由 journal 投影面承载）：
 * 1. 合并矩阵全形态：trace 独有 / record 独有 / 双有 / 一键多 record 收敛（双 running
 *    tiebreak + 僵尸 running × 新 attempt 终态，设计检查点③）/ 无 stepIndex 守卫 /
 *    跨 run 桶隔离 / 幂等；
 * 2. R1 两态→四态映射矩阵 13 值域逐行（StopReason 全枚举，含中断族三值与兜底行）；
 * 3. subagent-record v2 条目 → SubagentRecord 身份域投影（parentRunId/stepIndex/origin）；
 * 4. 水位信号：steps / 步骤状态序列变化触发信号、同值重放去重 + V10 信号量上界
 *    （4-agent run 信号条数 ≤ 迁移波次数）；
 * 5. V9 重试三段序列（设计 §4.1 V9）：同一 (parentRunId, stepIndex) 键下 attempt1
 *    failed → attempt2 running（计时换新）→ completed；全失败取最后 attempt 错误；
 *    步骤状态随序列翻转（running→failed→running→done）各触发一条水位信号。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/services/session/__tests__/workflow-step-merge.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { scanSubagentEntries } from '../subagent-extractor.js'
import {
  mergeWorkflowStepRecords,
  mapStepStatusFromRecord,
} from '../workflow-step-merge.js'
import { SessionRecords } from '../session-records.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../replicated-states.config.js'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import type { SubagentRecord, WorkflowAgentCall, WorkflowRunRecord } from '@taiji/shared'

// ── fixture 构造（手造 entry / 投影对象，U1 透传链无关——parentRunId 已在现行 entry）──

/** SubagentRecord 直构（合并函数单元输入；必填字段最小化 + overrides）。 */
function rec(overrides: Partial<SubagentRecord> & Pick<SubagentRecord, 'subagentId'>): SubagentRecord {
  return {
    sessionFile: null,
    agent: 'reviewer',
    slug: 'rev',
    task: 'do review',
    status: 'running',
    ...overrides,
  }
}

/** WorkflowRunRecord 直构（trace 骨架输入）。 */
function wf(agentCalls: WorkflowAgentCall[], runId = 'run-1'): WorkflowRunRecord {
  return {
    runId,
    scriptName: 'test-flow',
    status: 'running',
    startedAt: '2026-09-25T00:00:00Z',
    agentCalls,
    stateFilePath: '',
  }
}

/** trace 骨架行直构。 */
function traceCall(id: number, overrides: Partial<WorkflowAgentCall> = {}): WorkflowAgentCall {
  return {
    id,
    agent: 'reviewer',
    status: 'pending',
    ...overrides,
  }
}

/**
 * 自描述 subagent-record v2 entry 族（registered 恒有 + settled 仅终态形态，即
 * status !== 'running' 时合成）——data schema 见 core record-entry.ts。
 *
 * 返回 ARRAY（append-only 两条小条目形态），call site 用 spread 展开：
 * `[...subagentRecordEntry({ ... })]`。
 *
 * 身份字段缺省值：agent/slug/task 造数据；rootSessionId 缺省 's1' = SessionRecords
 * harness 的会话 id（journal 投影按 rootSessionId === sessionId 过滤注册条目）；
 * origin 缺省 'tool'；depth 0；startedAt 缺省 0。overrides 里未识别的键（parentRunId/
 * stepIndex/origin/rootSessionId/agent/slug/task/parentRecordId/depth/startedAt）进
 * 注册条目；终态键（stopReason/outcome/error/endedAt/turns/totalTokens/model/
 * thinkingLevel/sessionFile/result）只进 settled 条目。
 */
function subagentRecordEntry(
  overrides: Record<string, unknown> & { id: string },
): Array<Record<string, unknown>> {
  const {
    status = 'running',
    stopReason,
    outcome,
    error,
    endedAt,
    turns,
    totalTokens,
    model,
    thinkingLevel,
    sessionFile,
    result,
    startedAt = 0,
    ...identity
  } = overrides
  const entries: Array<Record<string, unknown>> = [
    {
      type: 'custom',
      customType: 'subagent-record',
      id: `entry-${overrides.id}-registered`,
      parentId: null,
      timestamp: '2026-09-25T00:00:00Z',
      data: {
        v: 2,
        kind: 'registered',
        agent: 'reviewer',
        task: 'do review',
        slug: 'rev',
        origin: 'tool',
        rootSessionId: 's1',
        depth: 0,
        ...identity,
        startedAt,
      },
    },
  ]
  if (status !== 'running') {
    entries.push({
      type: 'custom',
      customType: 'subagent-record',
      id: `entry-${overrides.id}-settled`,
      parentId: null,
      timestamp: '2026-09-25T00:00:01Z',
      data: {
        v: 2,
        kind: 'settled',
        id: overrides.id,
        status: 'idle',
        stopReason,
        ...(outcome !== undefined ? { outcome } : {}),
        ...(error !== undefined ? { error } : {}),
        endedAt,
        turns,
        totalTokens,
        model,
        thinkingLevel,
        ...(sessionFile !== undefined ? { sessionFile } : {}),
        ...(result !== undefined ? { result } : {}),
      },
    })
  }
  return entries
}

/**
 * 自描述 workflow-record v2 entry 族（registered 恒有 + settled 仅 status === 'done'）。
 * v2 条目不承载 trace/agentCalls（供源 = run journal fold），故 overrides 只有身份
 * （runId）与收敛形态（status）。返回 ARRAY，call site 用 spread 展开：
 * `[...workflowRecordEntry({ ... })]`。
 */
function workflowRecordEntry(
  overrides: { runId?: string; status?: 'running' | 'done' } = {},
): Array<Record<string, unknown>> {
  const runId = overrides.runId ?? 'run-1'
  const entries: Array<Record<string, unknown>> = [
    {
      type: 'custom',
      customType: 'workflow-record',
      id: `entry-wf-${runId}-registered`,
      parentId: null,
      timestamp: '2026-09-25T00:00:00Z',
      data: {
        v: 2,
        kind: 'registered',
        runId,
        workflowName: 'test-flow',
        scriptName: 'test-flow',
        slug: 'test-flow',
        startedAt: Date.parse('2026-09-25T00:00:00Z'),
        recordPath: `workflow-state/${runId}.record.jsonl`,
      },
    },
  ]
  if (overrides.status === 'done') {
    entries.push({
      type: 'custom',
      customType: 'workflow-record',
      id: `entry-wf-${runId}-settled`,
      parentId: null,
      timestamp: '2026-09-25T00:00:02Z',
      data: {
        v: 2,
        kind: 'settled',
        runId,
        status: 'done',
        reason: 'completed',
        outcome: 'done',
        settledAt: Date.parse('2026-09-25T00:00:02Z'),
        callCount: 0,
        usedTokens: 1,
      },
    })
  }
  return entries
}

// ── 1. 合并矩阵全形态 ─────────────────────────────────────────────────────

describe('合并矩阵全形态（D2 R2/R3）', () => {
  it('trace 独有（无有效候选——候选集空 / 同 run 候选全被守卫排除）：骨架行维持原样，record 原对象引用保持', () => {
    const record = wf([traceCall(0, { status: 'done', phase: 'R1' })])
    // 形态一：候选集空（派发前置失败早退路径——无 record 产生）
    expect(mergeWorkflowStepRecords([record], [])[0]).toBe(record)
    // 形态二：候选存在但全部无 stepIndex（守卫排除后 run 无有效候选）——trace-only 视图
    const guarded = [rec({ subagentId: 'sa-legacy', parentRunId: 'run-1', stepIndex: undefined, status: 'idle', stopReason: 'completed' })]
    const merged = mergeWorkflowStepRecords([record], guarded)
    expect(merged[0]).toBe(record)
    expect(merged[0]!.agentCalls).toHaveLength(1)
    expect(merged[0]!.agentCalls[0]).toEqual(traceCall(0, { status: 'done', phase: 'R1' }))
  })

  it('record 独有（trace 无该 stepIndex）：成行 + phase undefined + sessionId=subagentId + 顺序按 stepIndex 升序追加', () => {
    const record = wf([traceCall(0, { status: 'running', phase: 'R1' })])
    const candidates = [
      rec({ subagentId: 'sa-b', parentRunId: 'run-1', stepIndex: 3, status: 'running', startedAt: 2000 }),
      rec({ subagentId: 'sa-a', parentRunId: 'run-1', stepIndex: 1, status: 'running', startedAt: 1000, agent: '/agents/dep-review.md' }),
    ]
    const merged = mergeWorkflowStepRecords([record], candidates)[0]!
    expect(merged.agentCalls.map((c) => c.id)).toEqual([0, 1, 3])
    const row = merged.agentCalls[1]!
    expect(row.phase).toBeUndefined() // 不出「Other」分组头（已知取舍 2）
    expect(row.status).toBe('running')
    expect(row.sessionId).toBe('sa-a') // sessionId = record id（点击对话流契约）
    expect(row.agent).toBe('dep-review') // agent ref 路径短名化（与 trace 短名形态一致）
    expect(row.startedAt).toBe(new Date(1000).toISOString())
  })

  it('双有：trace 行被 record 覆盖——状态/时间/错误/sessionId 取 record，phase/model/token 拆分保留 trace', () => {
    const record = wf([
      traceCall(0, {
        status: 'running',
        phase: 'R1',
        model: 'm1',
        inputTokens: 10,
        outputTokens: 5,
        lastProgressAt: 900,
      }),
    ])
    const candidates = [
      rec({
        subagentId: 'sa-1',
        parentRunId: 'run-1',
        stepIndex: 0,
        status: 'idle',
        stopReason: 'completed',
        startedAt: 1000,
        endedAt: 61000,
        elapsedSeconds: 60,
        turns: 8,
      }),
    ]
    const merged = mergeWorkflowStepRecords([record], candidates)[0]!
    const row = merged.agentCalls[0]!
    expect(row.status).toBe('done')
    expect(row.phase).toBe('R1') // 编排结构来自 trace（P7）
    expect(row.model).toBe('m1')
    expect(row.sessionId).toBe('sa-1')
    expect(row.startedAt).toBe(new Date(1000).toISOString())
    expect(row.completedAt).toBe(new Date(61000).toISOString())
    expect(row.durationMs).toBe(60_000)
    expect(row.turns).toBe(8)
    expect(row.inputTokens).toBe(10) // record 只有 totalTokens 总量，input/output 拆分保留 trace
    expect(row.outputTokens).toBe(5)
    expect(row.lastProgressAt).toBe(900) // calls[] 投影保留 trace
  })

  it('一键多 record 收敛——多条 running 取 startedAt 最新（rebuildRuntime 瞬态 tiebreak）', () => {
    const record = wf([traceCall(0)])
    const candidates = [
      rec({ subagentId: 'sa-old', parentRunId: 'run-1', stepIndex: 0, status: 'running', startedAt: 1000 }),
      rec({ subagentId: 'sa-new', parentRunId: 'run-1', stepIndex: 0, status: 'running', startedAt: 5000 }),
    ]
    const merged = mergeWorkflowStepRecords([record], candidates)[0]!
    expect(merged.agentCalls[0]!.sessionId).toBe('sa-new')
  })

  it('一键多 record 收敛——全终态取 startedAt 最新（最后 attempt 的最终结果语义）', () => {
    const record = wf([traceCall(0)])
    const candidates = [
      rec({
        subagentId: 'sa-att1', parentRunId: 'run-1', stepIndex: 0, status: 'idle',
        stopReason: 'failed', error: 'attempt-1 boom', startedAt: 1000, endedAt: 2000,
      }),
      rec({
        subagentId: 'sa-att2', parentRunId: 'run-1', stepIndex: 0, status: 'idle',
        stopReason: 'completed', startedAt: 5000, endedAt: 6000,
      }),
    ]
    const merged = mergeWorkflowStepRecords([record], candidates)[0]!
    expect(merged.agentCalls[0]!.status).toBe('done')
    expect(merged.agentCalls[0]!.sessionId).toBe('sa-att2')
  })

  it('一键多 record 收敛——僵尸 running × 新 attempt 终态：running 胜出（自愈链兜底前的瞬态显示，检查点③）', () => {
    const record = wf([traceCall(0)])
    const candidates = [
      // 僵尸：崩溃残留未 settle（startedAt 更早但 running）
      rec({ subagentId: 'sa-zombie', parentRunId: 'run-1', stepIndex: 0, status: 'running', startedAt: 1000 }),
      // 新 attempt 已落终态
      rec({
        subagentId: 'sa-att2', parentRunId: 'run-1', stepIndex: 0, status: 'idle',
        stopReason: 'completed', startedAt: 5000, endedAt: 6000,
      }),
    ]
    const merged = mergeWorkflowStepRecords([record], candidates)[0]!
    expect(merged.agentCalls[0]!.status).toBe('running')
    expect(merged.agentCalls[0]!.sessionId).toBe('sa-zombie')
  })

  it('无 stepIndex 守卫：record 有 parentRunId 但无 stepIndex（旧 session entry）不成行', () => {
    const record = wf([])
    const candidates = [
      rec({
        subagentId: 'sa-legacy', parentRunId: 'run-1', stepIndex: undefined,
        status: 'idle', stopReason: 'completed',
      }),
      // 无 parentRunId 的 tool 来源 record 同样不成行
      rec({ subagentId: 'sa-tool', stepIndex: 0, status: 'running' }),
    ]
    const merged = mergeWorkflowStepRecords([record], candidates)[0]!
    expect(merged.agentCalls).toHaveLength(0)
  })

  it('跨 run 不串场：parentRunId 桶隔离，run-2 的候选不进 run-1', () => {
    const run1 = wf([traceCall(0)], 'run-1')
    const run2 = wf([], 'run-2')
    const candidates = [rec({ subagentId: 'sa-2', parentRunId: 'run-2', stepIndex: 0, status: 'running' })]
    const merged = mergeWorkflowStepRecords([run1, run2], candidates)
    expect(merged[0]!.agentCalls).toHaveLength(1) // run-1 trace 独有维持
    expect(merged[1]!.agentCalls).toHaveLength(1) // run-2 record-only 成行
    expect(merged[1]!.agentCalls[0]!.sessionId).toBe('sa-2')
  })

  it('幂等：对已合并产物重跑同一合并结果不变（实时增量路径反复重合并的正确性前提）', () => {
    const record = wf([traceCall(0, { phase: 'R1' })])
    const candidates = [
      rec({ subagentId: 'sa-1', parentRunId: 'run-1', stepIndex: 0, status: 'running', startedAt: 1000 }),
      rec({ subagentId: 'sa-2', parentRunId: 'run-1', stepIndex: 5, status: 'idle', stopReason: 'completed', startedAt: 2000, endedAt: 3000 }),
    ]
    const once = mergeWorkflowStepRecords([record], candidates)
    const twice = mergeWorkflowStepRecords(once, candidates)
    expect(twice[0]!.agentCalls).toEqual(once[0]!.agentCalls) // record-only 行不重复 append
    expect(twice[0]!.agentCalls.map((c) => c.id)).toEqual([0, 5])
  })
})

// ── 2. R1 映射矩阵 13 值域逐行 ────────────────────────────────────────────

describe('R1 两态→四态映射矩阵（D2 R1，StopReason 13 值域逐行）', () => {
  it('running（无论 stopReason 残留）→ running，error 清空', () => {
    expect(mapStepStatusFromRecord({ status: 'running' })).toEqual({ status: 'running', error: undefined })
    // 防御：running + stopReason 脏残留（轮始清点前的瞬态）同样 running
    expect(mapStepStatusFromRecord({ status: 'running', stopReason: 'failed', error: 'x' }).status).toBe('running')
  })

  // 13 值逐行（gc 双语义拆两行）：completed/failed 显式行；gc 按 error 分叉（写侧
  // D7 例外族——workflow origin 成功/失败 settle 均写 gc，error 区分）；cancelled
  // 文案填充；中断族三值原文填充；legacy 家族剩余四值 + disconnected + reopened
  // 走通用文案兜底。第四列 = 注入 record.error（其余行 undefined = 不注入）。
  it.each([
    ['completed', 'done', undefined, undefined],
    ['failed', 'failed', undefined, undefined],
    ['gc', 'done', undefined, undefined],
    ['gc', 'failed', 'engine crashed', 'engine crashed'],
    ['cancelled', 'failed', 'cancelled by run abort', undefined],
    ['interrupted', 'failed', 'interrupted', undefined],
    ['interrupted-by-restart', 'failed', 'interrupted-by-restart', undefined],
    ['interrupted-by-parent', 'failed', 'interrupted-by-parent', undefined],
    ['parent-shutdown', 'failed', 'stopped unexpectedly (stopReason: parent-shutdown)', undefined],
    ['parent-fork', 'failed', 'stopped unexpectedly (stopReason: parent-fork)', undefined],
    ['parent-new', 'failed', 'stopped unexpectedly (stopReason: parent-new)', undefined],
    ['user-close', 'failed', 'stopped unexpectedly (stopReason: user-close)', undefined],
    ['disconnected', 'failed', 'stopped unexpectedly (stopReason: disconnected)', undefined],
    ['reopened', 'failed', 'stopped unexpectedly (stopReason: reopened)', undefined],
  ] as const)('idle + stopReason=%s → %s（error：%s）', (stopReason, expectedStatus, expectedError, recordError) => {
    expect(mapStepStatusFromRecord({ status: 'idle', stopReason, error: recordError })).toEqual({
      status: expectedStatus,
      error: expectedError,
    })
  })

  it('idle + stopReason 缺失（真异常形态）→ failed + 通用文案（缺省显示成功会让异常静默隐形）', () => {
    expect(mapStepStatusFromRecord({ status: 'idle' })).toEqual({
      status: 'failed',
      error: 'stopped unexpectedly (no stop reason)',
    })
  })

  it('record.error 恒优先于文案填充（真实错误文本不被覆盖）', () => {
    expect(mapStepStatusFromRecord({ status: 'idle', stopReason: 'failed', error: 'engine crashed' }))
      .toEqual({ status: 'failed', error: 'engine crashed' })
    // cancelled / 中断族 error 非空同样透传
    expect(mapStepStatusFromRecord({ status: 'idle', stopReason: 'cancelled', error: 'user aborted' }).error)
      .toBe('user aborted')
    expect(mapStepStatusFromRecord({ status: 'idle', stopReason: 'interrupted-by-restart', error: 'host restarted' }).error)
      .toBe('host restarted')
  })
})

// ── 3. 提取器投影透出（P2：v2 条目 data 已有，投影透出）───────────────────

describe('subagent-extractor 投影透出 workflow 身份域', () => {
  it('subagent-record v2 注册条目的 parentRunId / stepIndex / origin 投影进 SubagentRecord', () => {
    const entries = [
      ...subagentRecordEntry({
        id: 'sa-wf-1', origin: 'workflow', parentRunId: 'run-x', stepIndex: 2,
        status: 'running', startedAt: 1000,
      }),
    ]
    const records = scanSubagentEntries(entries)
    expect(records).toHaveLength(1)
    expect(records[0]!.parentRunId).toBe('run-x')
    expect(records[0]!.stepIndex).toBe(2)
    expect(records[0]!.origin).toBe('workflow')
  })

  it('无 workflow 身份域字段（tool 来源）投影归一 undefined（零迁移读侧容忍）', () => {
    const records = scanSubagentEntries([...subagentRecordEntry({ id: 'sa-old', status: 'idle', stopReason: 'completed' })])
    expect(records[0]!.parentRunId).toBeUndefined()
    expect(records[0]!.stepIndex).toBeUndefined()
  })
})

// ── 5. 水位信号（steps / 步骤状态序列）+ V10 信号量上界（D4，SessionRecords 直测）──

/** SessionRecords 直测装置（形态对齐 session-records.test.ts 的 makeRecords——deps mock 断言同款）。 */
async function makeSessionRecordsHarness() {
  const publish = vi.fn()
  const client = {
    getEntries: vi.fn(async (_since?: string) => ({ data: { entries: [] as unknown[], leafId: null as string | null } })),
    prompt: vi.fn(async (_text: string) => undefined),
  }
  const records = new SessionRecords({
    pm: { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager,
    sessionStore: { scanSessions: vi.fn(() => [] as Array<{ id: string; filePath: string }>) } as unknown as ISessionStore,
    hasSession: vi.fn(() => true),
    getMessageBus: () => ({ publish } as unknown as IMessageBus),
  })
  const handlers: Array<(sessionId: string) => void> = []
  records.subscribe({ onSessionRegistered: (h) => { handlers.push(h) } })
  return {
    records, publish, client,
    fire: (sid: string) => { for (const h of handlers) h(sid) },
    invalidate: async (sid: string, entries: unknown[], leafId: string) => {
      client.getEntries.mockResolvedValue({ data: { entries, leafId } })
      records.invalidateRecordEntries(sid, 'subagent-record')
      await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
    },
    workflowUpdates: () => publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.workflowUpdate'),
  }
}

describe('水位信号（steps / 步骤状态序列）与 V10 信号量上界', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('record-only 成行使 steps 变化触发信号；转态使步骤状态序列变化触发信号（steps 不变）', async () => {
    const h = await makeSessionRecordsHarness()
    h.fire('s1')
    // 波1：run 创建（v2 注册条目，无步骤行 steps=0）→ 1 条信号（新 run）
    await h.invalidate('s1', [...workflowRecordEntry({ runId: 'run-d4' })], 'e1')
    expect(h.workflowUpdates()).toHaveLength(1)

    // 波2：1 条 record spawn（record-only 成行，steps 0→1）→ 信号
    await h.invalidate('s1', [
      ...subagentRecordEntry({ id: 'sa-d4-1', origin: 'workflow', parentRunId: 'run-d4', stepIndex: 0, status: 'running', startedAt: 1000 }),
    ], 'e2')
    expect(h.workflowUpdates()).toHaveLength(2)

    // 波3：同一 record 转态 running → idle+completed（steps 不变 1，步骤状态序列
    // running→done）→ 信号（[W1/D6] 核心断言：仅比 steps 会静默吞掉转态信号——现状缺陷根因形态）
    await h.invalidate('s1', [
      ...subagentRecordEntry({ id: 'sa-d4-1', origin: 'workflow', parentRunId: 'run-d4', stepIndex: 0, status: 'idle', stopReason: 'completed', startedAt: 1000, endedAt: 2000 }),
    ], 'e3')
    expect(h.workflowUpdates()).toHaveLength(3)

    // 波4：同值重放（无任何维度变化）→ 无新信号（水位去重）
    await h.invalidate('s1', [
      ...subagentRecordEntry({ id: 'sa-d4-1', origin: 'workflow', parentRunId: 'run-d4', stepIndex: 0, status: 'idle', stopReason: 'completed', startedAt: 1000, endedAt: 2000 }),
    ], 'e4')
    expect(h.workflowUpdates()).toHaveLength(3)
  })

  it('V10 信号量上界：4-agent run 全迁移序列的 workflowUpdate 信号条数 ≤ 迁移波次数（无风暴退化）', async () => {
    const h = await makeSessionRecordsHarness()
    h.fire('s1')
    const waves: unknown[][] = [
      [...workflowRecordEntry({ runId: 'run-v10' })],
      ...[1, 2, 3, 4].map((n) => [
        ...subagentRecordEntry({
          id: `sa-v10-${n}`, origin: 'workflow', parentRunId: 'run-v10', stepIndex: n - 1,
          status: 'running', startedAt: 1000 + n,
        }),
      ]),
      ...[1, 2, 3, 4].map((n) => [
        ...subagentRecordEntry({
          id: `sa-v10-${n}`, origin: 'workflow', parentRunId: 'run-v10', stepIndex: n - 1,
          status: 'idle', stopReason: 'completed', startedAt: 1000 + n, endedAt: 61000 + n,
        }),
      ]),
    ]
    for (let i = 0; i < waves.length; i++) {
      await h.invalidate('s1', waves[i]!, `e-${i}`)
    }
    // 9 波（1 run 创建 + 4 spawn + 4 完成）→ 信号 ≤ 9；每轮至多一条 per-run 信号
    expect(h.workflowUpdates().length).toBeLessThanOrEqual(waves.length)
    // 全程只有 run-v10 一个 run 的信号
    const runIds = new Set(h.workflowUpdates().map(([, m]) => (m as { payload: { update: { runId: string } } }).payload.update.runId))
    expect(runIds).toEqual(new Set(['run-v10']))
  })
})

// ── 6. V9 重试三段序列（设计 §4.1 V9：D2-R2 收敛的时序形态）─────────────────

describe('V9 重试三段序列', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('重试成功：退避窗口内显示 failed → 重试派发回 running（计时换新 attempt）→ 最终 completed', () => {
    const record = wf([traceCall(0, { status: 'running', phase: 'R1' })])
    const att1Settled = rec({
      subagentId: 'sa-v9-att1', parentRunId: 'run-1', stepIndex: 0,
      status: 'idle', stopReason: 'failed', error: 'attempt-1 crash',
      startedAt: 1000, endedAt: 2000, elapsedSeconds: 1,
    })

    // 段① attempt1 失败结算后、退避窗口内（1s/2s，execute-agent-call BACKOFF_BASE_MS=1000
    // 指数 2）——重试未派发，候选集只有 attempt1 终态：真实状态 = 上次尝试已失败
    const row1 = mergeWorkflowStepRecords([record], [att1Settled])[0]!.agentCalls[0]!
    expect(row1.status).toBe('failed')
    expect(row1.error).toBe('attempt-1 crash')
    expect(row1.sessionId).toBe('sa-v9-att1')
    expect(row1.startedAt).toBe(new Date(1000).toISOString())
    expect(row1.completedAt).toBe(new Date(2000).toISOString())
    expect(row1.durationMs).toBe(1000)

    // 段② 退避结束（2000 + 1000ms）重试派发：attempt2 running 进候选集——
    // R2 running 优先于终态，计时字段整体换新 attempt（起点重算、终态残留清空）
    const att2Running = rec({
      subagentId: 'sa-v9-att2', parentRunId: 'run-1', stepIndex: 0,
      status: 'running', startedAt: 3000,
    })
    const row2 = mergeWorkflowStepRecords([record], [att1Settled, att2Running])[0]!.agentCalls[0]!
    expect(row2.status).toBe('running')
    expect(row2.sessionId).toBe('sa-v9-att2') // 点击对话流指向新 attempt
    expect(row2.startedAt).toBe(new Date(3000).toISOString()) // 计时重算
    expect(row2.completedAt).toBeUndefined()
    expect(row2.durationMs).toBeUndefined()
    expect(row2.error).toBeUndefined() // attempt1 的失败摘要不残留

    // 段③ attempt2 结算 completed：全终态取 startedAt 最新（最后 attempt 的最终结果）
    const att2Done = rec({
      subagentId: 'sa-v9-att2', parentRunId: 'run-1', stepIndex: 0,
      status: 'idle', stopReason: 'completed',
      startedAt: 3000, endedAt: 8000, elapsedSeconds: 5,
    })
    const row3 = mergeWorkflowStepRecords([record], [att1Settled, att2Done])[0]!.agentCalls[0]!
    expect(row3.status).toBe('done')
    expect(row3.sessionId).toBe('sa-v9-att2')
    expect(row3.startedAt).toBe(new Date(3000).toISOString())
    expect(row3.completedAt).toBe(new Date(8000).toISOString())
    expect(row3.durationMs).toBe(5000)
    expect(row3.error).toBeUndefined()
  })

  it('全失败变体：最后 attempt 的 idle+failed 为权威——错误摘要取最后 attempt 的 error', () => {
    const record = wf([traceCall(0, { status: 'running', phase: 'R1' })])
    const candidates = [
      rec({
        subagentId: 'sa-v9-att1', parentRunId: 'run-1', stepIndex: 0,
        status: 'idle', stopReason: 'failed', error: 'attempt-1 crash',
        startedAt: 1000, endedAt: 2000, elapsedSeconds: 1,
      }),
      rec({
        subagentId: 'sa-v9-att2', parentRunId: 'run-1', stepIndex: 0,
        status: 'idle', stopReason: 'failed', error: 'attempt-2 crash',
        startedAt: 3000, endedAt: 6500, elapsedSeconds: 3,
      }),
    ]
    const row = mergeWorkflowStepRecords([record], candidates)[0]!.agentCalls[0]!
    // 全终态 → R2 取 startedAt 最新 = 最后 attempt：failed 判定与错误摘要都归它
    expect(row.status).toBe('failed')
    expect(row.error).toBe('attempt-2 crash')
    expect(row.sessionId).toBe('sa-v9-att2')
    expect(row.completedAt).toBe(new Date(6500).toISOString())
  })

  it('水位信号：三段序列翻转步骤状态（running→failed→running→done）各恰好一条信号，重放去重', async () => {
    const h = await makeSessionRecordsHarness()
    h.fire('s1')

    // 波0 run 创建（v2 注册条目，无步骤行 steps=0）
    await h.invalidate('s1', [...workflowRecordEntry({ runId: 'run-v9' })], 'e0')
    expect(h.workflowUpdates()).toHaveLength(1)

    // 波1 attempt1 派发（record-only 成行，steps 0→1，步骤状态 running）
    await h.invalidate('s1', [
      ...subagentRecordEntry({ id: 'sa-v9-att1', origin: 'workflow', parentRunId: 'run-v9', stepIndex: 0, status: 'running', startedAt: 1000 }),
    ], 'e1')
    expect(h.workflowUpdates()).toHaveLength(2)

    // 段① attempt1 结算 failed（steps 不变，步骤状态 running→failed）——退避窗口内 GUI 收到
    // 转态信号才能看到 failed（仅比 steps 会静默吞掉这次转态）
    await h.invalidate('s1', [
      ...subagentRecordEntry({
        id: 'sa-v9-att1', origin: 'workflow', parentRunId: 'run-v9', stepIndex: 0,
        status: 'idle', stopReason: 'failed', error: 'attempt-1 crash', startedAt: 1000, endedAt: 2000,
      }),
    ], 'e2')
    expect(h.workflowUpdates()).toHaveLength(3)

    // 段② attempt2 派发 running（同键第二 record，steps 不变，步骤状态 failed→running）
    await h.invalidate('s1', [
      ...subagentRecordEntry({ id: 'sa-v9-att2', origin: 'workflow', parentRunId: 'run-v9', stepIndex: 0, status: 'running', startedAt: 3000 }),
    ], 'e3')
    expect(h.workflowUpdates()).toHaveLength(4)

    // 段③ attempt2 结算 completed（步骤状态 running→done）
    await h.invalidate('s1', [
      ...subagentRecordEntry({
        id: 'sa-v9-att2', origin: 'workflow', parentRunId: 'run-v9', stepIndex: 0,
        status: 'idle', stopReason: 'completed', startedAt: 3000, endedAt: 8000,
      }),
    ], 'e4')
    expect(h.workflowUpdates()).toHaveLength(5)

    // 同值重放（水位无变化）→ 无新信号（去重）
    await h.invalidate('s1', [
      ...subagentRecordEntry({
        id: 'sa-v9-att2', origin: 'workflow', parentRunId: 'run-v9', stepIndex: 0,
        status: 'idle', stopReason: 'completed', startedAt: 3000, endedAt: 8000,
      }),
    ], 'e5')
    expect(h.workflowUpdates()).toHaveLength(5)

    // 全程只有 run-v9 一个 run 的信号
    const runIds = new Set(h.workflowUpdates().map(([, m]) => (m as { payload: { update: { runId: string } } }).payload.update.runId))
    expect(runIds).toEqual(new Set(['run-v9']))
  })
})
