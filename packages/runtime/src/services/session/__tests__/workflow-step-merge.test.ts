/**
 * workflow 步骤视图合并投影测试（W0 / 设计 workflow-step-visibility-data-source
 * D2 R1-R3 / D4 / D5）。
 *
 * 五类覆盖（验收对齐设计 §4 与 U2 单测清单）：
 * 1. 合并矩阵全形态：trace 独有 / record 独有 / 双有 / 一键多 record 收敛（双 running
 *    tiebreak + 僵尸 running × 新 attempt 终态，设计检查点③）/ 无 stepIndex 守卫 /
 *    旧 session 回落 trace-only；
 * 2. R1 两态→四态映射矩阵 13 值域逐行（StopReason 全枚举，含中断族三值与兜底行）；
 * 3. V3 fixture 重放：冷热同代码——同一 fixture 全量重放 ≡ 分波增量合并；
 * 4. 水位终态计数变化触发信号 + V10 信号量上界（4-agent run 信号条数 ≤ 迁移波次数）；
 * 5. V9 重试三段序列（设计 §4.1 V9）：同一 (parentRunId, stepIndex) 键下 attempt1
 *    failed → attempt2 running（计时换新）→ completed；全失败取最后 attempt 错误；
 *    终态计数随序列翻转（0→1→0→1）各触发一条水位信号。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/services/session/__tests__/workflow-step-merge.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanSubagentEntries } from '../subagent-extractor.js'
import { scanWorkflowEntries, scanWorkflowEntriesWithSteps, extractWorkflowsFromSessionFile } from '../workflow-extractor.js'
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

/** 自描述 subagent-record entry（data 字段对齐 extension 写点 W16 v1）。 */
function subagentRecordEntry(overrides: Record<string, unknown> & { id: string }): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `entry-${overrides.id}`,
    parentId: null,
    timestamp: '2026-09-25T00:00:00Z',
    data: {
      v: 1,
      agent: 'reviewer',
      task: 'do review',
      slug: 'rev',
      status: 'running',
      ...overrides,
    },
  }
}

/** 自描述 workflow-record entry（data = {v:1, snapshot, updatedAt}）。 */
function workflowRecordEntry(
  overrides: {
    runId?: string
    trace?: Array<Record<string, unknown>>
    status?: 'running' | 'done'
  } = {},
): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'workflow-record',
    id: `entry-wf-${overrides.runId ?? 'run-1'}`,
    parentId: null,
    timestamp: '2026-09-25T00:00:00Z',
    data: {
      v: 1,
      updatedAt: '2026-09-25T00:00:01Z',
      snapshot: {
        v: 'wf-run-v2',
        runId: overrides.runId ?? 'run-1',
        spec: { scriptName: 'test-flow' },
        state: {
          status: overrides.status ?? 'running',
          budget: { usedTokens: 1, usedCost: 0 },
          calls: [],
          trace: overrides.trace ?? [],
        },
        meta: { startedAt: '2026-09-25T00:00:00Z' },
      },
    },
  }
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

  it('旧 session 回落 trace-only：无 stepIndex 的 record 全员不参与，视图 ≡ 纯 trace 扫描（V5）', () => {
    const trace = [
      { stepIndex: 0, agent: 'dev', status: 'done', phase: 'D1' },
      { stepIndex: 1, agent: 'rev', status: 'done', phase: 'R1' },
    ]
    const entries = [
      workflowRecordEntry({ runId: 'run-legacy', trace, status: 'done' }),
      subagentRecordEntry({ id: 'sa-legacy-1', origin: 'workflow', status: 'idle', stopReason: 'completed' }),
    ]
    const merged = scanWorkflowEntriesWithSteps(entries)
    const traceOnly = scanWorkflowEntries(entries)
    expect(merged).toEqual(traceOnly)
    expect(merged[0]!.agentCalls.map((c) => c.id)).toEqual([0, 1])
    expect(merged[0]!.status).toBe('done')
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

// ── 3. V3 fixture 重放：冷热同代码（D5）───────────────────────────────────

describe('V3 fixture 重放：冷热同代码（全量重放 ≡ 分波增量合并）', () => {
  /**
   * 4-agent run 完整 entry 序列（真实时序形态）：
   * 波1 run 创建（trace 空，① 首写 steps=0）
   * 波2 4 条 record spawn（② 迁移即写；① 60s 节流吞 dispatch save——trace 仍空）
   * 波3 agent-1 完成（② 先落；① 同边沿 flush trace 4 节点）
   * 波4 其余 3 agent 完成（② 逐条；① 终态快照）
   */
  function buildWaves(): unknown[][] {
    const wave1 = [workflowRecordEntry({ runId: 'run-v3', trace: [] })]
    const wave2 = [1, 2, 3, 4].map((n) =>
      subagentRecordEntry({
        id: `sa-v3-${n}`,
        origin: 'workflow',
        parentRunId: 'run-v3',
        stepIndex: n - 1,
        status: 'running',
        startedAt: 1000 + n,
      }),
    )
    const wave3 = [
      subagentRecordEntry({
        id: 'sa-v3-1', origin: 'workflow', parentRunId: 'run-v3', stepIndex: 0,
        status: 'idle', stopReason: 'completed', startedAt: 1001, endedAt: 61001,
        elapsedSeconds: 60, turns: 8, totalTokens: 12300,
      }),
      workflowRecordEntry({
        runId: 'run-v3',
        trace: [1, 2, 3, 4].map((n) => ({
          stepIndex: n - 1,
          agent: 'reviewer',
          phase: 'Review',
          status: n === 1 ? 'completed' : 'running',
          startedAt: new Date(1000 + n).toISOString(),
        })),
      }),
    ]
    const wave4 = [
      [2, 3, 4].map((n) =>
        subagentRecordEntry({
          id: `sa-v3-${n}`, origin: 'workflow', parentRunId: 'run-v3', stepIndex: n - 1,
          status: 'idle', stopReason: n === 3 ? 'failed' : 'completed', startedAt: 1000 + n,
          endedAt: 62000 + n, elapsedSeconds: 61, turns: 7, totalTokens: 9000,
          ...(n === 3 ? { error: 'engine crashed' } : {}),
        }),
      ),
      workflowRecordEntry({
        runId: 'run-v3',
        status: 'done',
        trace: [1, 2, 3, 4].map((n) => ({
          stepIndex: n - 1,
          agent: 'reviewer',
          phase: 'Review',
          status: n === 3 ? 'failed' : 'completed',
        })),
      }),
    ].flat()
    return [wave1, wave2, wave3, wave4]
  }

  it('同一 fixture：一次全量重放 ≡ 四波增量（缓存 merge + 重合并），最终 agentCalls 逐字段相等', () => {
    const waves = buildWaves()
    const allEntries = waves.flat()

    // 冷：全量一次（extractWorkflowsFromSessionFile 同款组合扫描）
    const cold = scanWorkflowEntriesWithSteps(allEntries)

    // 热：分波增量（W1 换源后实时路径 = journal-projection.recompute 内跑
    // mergeWorkflowStepRecords——本对拍直测该纯函数，缓存重建语义等价）
    const wfCache = new Map<string, WorkflowRunRecord>()
    const subCache = new Map<string, SubagentRecord>()
    for (const wave of waves) {
      for (const r of scanSubagentEntries(wave)) subCache.set(r.subagentId, r)
      for (const r of scanWorkflowEntries(wave)) wfCache.set(r.runId, r)
      for (const r of mergeWorkflowStepRecords(Array.from(wfCache.values()), Array.from(subCache.values()))) {
        wfCache.set(r.runId, r)
      }
    }
    const hot = Array.from(wfCache.values())

    expect(hot).toEqual(cold)
    // 终态语义抽查（非只比形状）：4 行、1 failed（error 透传）、3 completed、sessionId = record id
    expect(cold[0]!.agentCalls).toHaveLength(4)
    expect(cold[0]!.agentCalls.map((c) => c.status)).toEqual(['done', 'done', 'failed', 'done'])
    expect(cold[0]!.agentCalls[2]!.error).toBe('engine crashed')
    expect(cold[0]!.agentCalls[0]!.sessionId).toBe('sa-v3-1')
    expect(cold[0]!.agentCalls.every((c) => c.phase === 'Review')) // trace 归组后 phase 不丢
  })

  it('D5 禁双读盘：冷路径磁盘提取单次 readFileSync + 两遍内存扫描（组合 scan 内无文件读取）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-step-merge-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, buildWaves().flat().map((e) => JSON.stringify(e)).join('\n'))
    try {
      const fs = await import('node:fs')
      const readSpy = vi.spyOn(fs, 'readFileSync')
      const { records, oversize } = extractWorkflowsFromSessionFile(filePath)
      expect(oversize).toBe(false)
      expect(records).toHaveLength(1)
      // 单次读盘：一次 statSync 预检 + 一次 readFileSync；合并扫描全部在内存 entries 上
      expect(readSpy).toHaveBeenCalledTimes(1)
      expect(records[0]!.agentCalls).toHaveLength(4)
      readSpy.mockRestore()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

// ── 4. 提取器投影透出（P2：entry data 已有，投影透出）─────────────────────

describe('subagent-extractor 投影透出 workflow 身份域', () => {
  it('subagent-record entry 的 parentRunId / stepIndex 投影进 SubagentRecord', () => {
    const entries = [
      subagentRecordEntry({
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

  it('旧 entry（无字段）投影归一 undefined（零迁移读侧容忍）', () => {
    const records = scanSubagentEntries([subagentRecordEntry({ id: 'sa-old', status: 'idle', stopReason: 'completed' })])
    expect(records[0]!.parentRunId).toBeUndefined()
    expect(records[0]!.stepIndex).toBeUndefined()
  })
})

// ── 5. 水位终态计数 + V10 信号量上界（D4，SessionRecords 直测）──────────────

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

describe('水位终态计数维度（D4）与 V10 信号量上界', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('record-only 成行使 steps 变化触发信号；转态使终态计数变化触发信号（steps 不变）', async () => {
    const h = await makeSessionRecordsHarness()
    h.fire('s1')
    // 波1：run 创建（trace 空，steps=0）→ 1 条信号（新 run）
    await h.invalidate('s1', [workflowRecordEntry({ runId: 'run-d4' })], 'e1')
    expect(h.workflowUpdates()).toHaveLength(1)

    // 波2：1 条 record spawn（record-only 成行，steps 0→1）→ 信号
    await h.invalidate('s1', [
      subagentRecordEntry({ id: 'sa-d4-1', origin: 'workflow', parentRunId: 'run-d4', stepIndex: 0, status: 'running', startedAt: 1000 }),
    ], 'e2')
    expect(h.workflowUpdates()).toHaveLength(2)

    // 波3：同一 record 转态 running → idle+completed（steps 不变 1，settledSteps 0→1）→ 信号
    //（D4 核心断言：仅比 steps 会静默吞掉转态信号——现状缺陷根因形态）
    await h.invalidate('s1', [
      subagentRecordEntry({ id: 'sa-d4-1', origin: 'workflow', parentRunId: 'run-d4', stepIndex: 0, status: 'idle', stopReason: 'completed', startedAt: 1000, endedAt: 2000 }),
    ], 'e3')
    expect(h.workflowUpdates()).toHaveLength(3)

    // 波4：同值重放（无任何维度变化）→ 无新信号（水位去重）
    await h.invalidate('s1', [
      subagentRecordEntry({ id: 'sa-d4-1', origin: 'workflow', parentRunId: 'run-d4', stepIndex: 0, status: 'idle', stopReason: 'completed', startedAt: 1000, endedAt: 2000 }),
    ], 'e4')
    expect(h.workflowUpdates()).toHaveLength(3)
  })

  it('结构补全（① trace 落盘、record-only 行归位）不发信号——steps 与终态计数均不变（已知取舍 2）', async () => {
    const h = await makeSessionRecordsHarness()
    h.fire('s1')
    await h.invalidate('s1', [workflowRecordEntry({ runId: 'run-s2' })], 'e1')
    await h.invalidate('s1', [
      subagentRecordEntry({ id: 'sa-s2-0', origin: 'workflow', parentRunId: 'run-s2', stepIndex: 0, status: 'idle', stopReason: 'completed', startedAt: 1000, endedAt: 2000 }),
    ], 'e2')
    const before = h.workflowUpdates().length
    expect(before).toBe(2)

    // ① 边沿 flush：trace 节点落盘（completed，与 record 状态一致）——record-only 行归位
    // trace 位，phase 补全但行数与终态计数不变 → 无信号（分组 header 搭下一次终态信号）
    await h.invalidate('s1', [
      workflowRecordEntry({
        runId: 'run-s2',
        trace: [{ stepIndex: 0, agent: 'reviewer', phase: 'Review', status: 'done' }],
      }),
    ], 'e3')
    expect(h.workflowUpdates()).toHaveLength(before)
  })

  it('V10 信号量上界：4-agent run 全迁移序列的 workflowUpdate 信号条数 ≤ 迁移波次数（无风暴退化）', async () => {
    const h = await makeSessionRecordsHarness()
    h.fire('s1')
    const waves: unknown[][] = [
      [workflowRecordEntry({ runId: 'run-v10' })],
      ...[1, 2, 3, 4].map((n) => [
        subagentRecordEntry({
          id: `sa-v10-${n}`, origin: 'workflow', parentRunId: 'run-v10', stepIndex: n - 1,
          status: 'running', startedAt: 1000 + n,
        }),
      ]),
      ...[1, 2, 3, 4].map((n) => [
        subagentRecordEntry({
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

  it('水位信号：三段序列翻转终态计数（failed +1 / 重试回 running -1 / completed +1）各恰好一条信号，重放去重', async () => {
    const h = await makeSessionRecordsHarness()
    h.fire('s1')

    // 波0 run 创建（trace 空，steps=0）
    await h.invalidate('s1', [workflowRecordEntry({ runId: 'run-v9' })], 'e0')
    expect(h.workflowUpdates()).toHaveLength(1)

    // 波1 attempt1 派发（record-only 成行，steps 0→1，settledSteps=0）
    await h.invalidate('s1', [
      subagentRecordEntry({ id: 'sa-v9-att1', origin: 'workflow', parentRunId: 'run-v9', stepIndex: 0, status: 'running', startedAt: 1000 }),
    ], 'e1')
    expect(h.workflowUpdates()).toHaveLength(2)

    // 段① attempt1 结算 failed（steps 不变，settledSteps 0→1）——退避窗口内 GUI 收到
    // 转态信号才能看到 failed（D4：仅比 steps 会静默吞掉这次转态）
    await h.invalidate('s1', [
      subagentRecordEntry({
        id: 'sa-v9-att1', origin: 'workflow', parentRunId: 'run-v9', stepIndex: 0,
        status: 'idle', stopReason: 'failed', error: 'attempt-1 crash', startedAt: 1000, endedAt: 2000,
      }),
    ], 'e2')
    expect(h.workflowUpdates()).toHaveLength(3)

    // 段② attempt2 派发 running（同键第二 record，steps 不变，settledSteps 1→0）
    await h.invalidate('s1', [
      subagentRecordEntry({ id: 'sa-v9-att2', origin: 'workflow', parentRunId: 'run-v9', stepIndex: 0, status: 'running', startedAt: 3000 }),
    ], 'e3')
    expect(h.workflowUpdates()).toHaveLength(4)

    // 段③ attempt2 结算 completed（settledSteps 0→1）
    await h.invalidate('s1', [
      subagentRecordEntry({
        id: 'sa-v9-att2', origin: 'workflow', parentRunId: 'run-v9', stepIndex: 0,
        status: 'idle', stopReason: 'completed', startedAt: 3000, endedAt: 8000,
      }),
    ], 'e4')
    expect(h.workflowUpdates()).toHaveLength(5)

    // 同值重放（水位无变化）→ 无新信号（去重）
    await h.invalidate('s1', [
      subagentRecordEntry({
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
