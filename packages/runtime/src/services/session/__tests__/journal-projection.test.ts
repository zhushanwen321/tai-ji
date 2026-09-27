/**
 * journal 投影直测（W1 [D6] runtime 读侧换源）：双源单点合并仲裁（journal 胜出 /
 * 窗外条目兜底 / v1 冻结定界）+ 会话文件流式扫描（冷启动 entry 源）+ 有状态投影
 * （tail 目录 watcher 冷启动/增量/dispose）。
 *
 * fixture 全部落 mkdtemp 临时目录（mkdtempSync 自建自删，rmSync 全参数）；
 * record 事件文件/run journal 形态对齐 u0 契约（record-events.ts 六类词表 +
 * 首行头行 / run-events.ts 七类词表）。测试框架：vitest + fake timers（tailer
 * 周期复查注入短值驱动确定性增量）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/journal-projection.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  foldRunJournalEvents,
  initialRunJournalFold,
  mergeJournalProjection,
  initialJournalProjectionSources,
  parseWorkflowRunEventFileLine,
  projectV2Subagent,
  projectV2Workflow,
  scanV2RecordEntries,
  SessionJournalProjection,
} from '../journal-projection.js'
import { scanRecordFamilyEntriesFromSessionFile } from '../session-file-extraction.js'
import type {
  RecordCreatedEvent,
  RecordJournalEvent,
  RecordSettledEvent,
  WorkflowRunEvent,
} from '@zhushanwen/subagent-core'
import type { SubagentRecord } from '@taiji/shared'

// ── fixture 构造（u0 契约形态）────────────────────────────────

function recordEventLine(event: RecordJournalEvent): string {
  return JSON.stringify(event)
}

function recordJournalLines(id: string, events: RecordJournalEvent[]): string[] {
  return [JSON.stringify({ type: 'record-journal', id }), ...events.map(recordEventLine)]
}

function createdEvent(id: string, seq = 1, over: Partial<RecordCreatedEvent> = {}): RecordCreatedEvent {
  return {
    type: 'record-created',
    seq,
    ts: 1000 + seq,
    id,
    agent: 'worker',
    task: 'Do work',
    slug: 'work',
    origin: 'workflow',
    parentRunId: 'wf-1',
    stepIndex: 0,
    rootSessionId: 's1',
    depth: 0,
    mode: 'background',
    startedAt: 1000,
    ...over,
  }
}

function settledRecordEvent(over: Partial<RecordSettledEvent> = {}): RecordSettledEvent {
  return {
    type: 'record-settled',
    seq: 3,
    ts: 3000,
    stopReason: 'completed',
    endedAt: 3000,
    turns: 2,
    totalTokens: 500,
    ...over,
  }
}

function runEvent(over: Record<string, unknown>): WorkflowRunEvent {
  return { ts: 1000, ...(over as object) } as unknown as WorkflowRunEvent
}

/** v2 subagent 注册条目 entry（W1 D1 契约形态）。 */
function subagentRegisteredEntry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: 'e-1',
    parentId: null,
    timestamp: '2026-09-26T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      id,
      agent: 'worker',
      task: 'Do work',
      slug: 'work',
      origin: 'workflow',
      parentRunId: 'wf-1',
      stepIndex: 0,
      rootSessionId: 's1',
      depth: 0,
      startedAt: 1000,
      ...over,
    },
  }
}

/** v2 subagent 终态条目 entry。 */
function subagentSettledEntry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: 'e-2',
    parentId: null,
    timestamp: '2026-09-26T00:00:01Z',
    data: {
      v: 2,
      kind: 'settled',
      id,
      status: 'idle',
      stopReason: 'interrupted',
      endedAt: 3000,
      turns: 9,
      totalTokens: 999,
      model: 'p/m',
      thinkingLevel: 'low',
      result: 'full result text',
      ...over,
    },
  }
}

/** v2 workflow 注册条目 entry。 */
function workflowRegisteredEntry(runId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'workflow-record',
    id: 'e-3',
    parentId: null,
    timestamp: '2026-09-26T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      runId,
      workflowName: 'test-flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      journalPath: '/tmp/wf-state/wf-1.events.jsonl',
      ...over,
    },
  }
}

/** v2 workflow 终态条目 entry。 */
function workflowSettledEntry(runId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'workflow-record',
    id: 'e-4',
    parentId: null,
    timestamp: '2026-09-26T00:00:02Z',
    data: {
      v: 2,
      kind: 'settled',
      runId,
      status: 'done',
      reason: 'completed',
      outcome: 'completed',
      settledAt: 3000,
      callCount: 2,
      usedTokens: 800,
      ...over,
    },
  }
}

// ── run journal 行解析与 fold ─────────────────────────────────

describe('parseWorkflowRunEventFileLine（run 域 tail 行解析器）', () => {
  it('词表内事件解析透传；空行/坏 JSON/词表外 type/坏信封 → undefined', () => {
    const ok = parseWorkflowRunEventFileLine(JSON.stringify({ type: 'ask-dispatched', ts: 1, taskIndex: 0, agentName: 'w', attempt: 1 }))
    expect(ok).toMatchObject({ type: 'ask-dispatched', taskIndex: 0 })
    expect(parseWorkflowRunEventFileLine('')).toBeUndefined()
    expect(parseWorkflowRunEventFileLine('not-json')).toBeUndefined()
    expect(parseWorkflowRunEventFileLine(JSON.stringify({ type: 'unknown-type', ts: 1 }))).toBeUndefined()
    expect(parseWorkflowRunEventFileLine(JSON.stringify({ type: 'armed', ts: 'not-number' }))).toBeUndefined()
    expect(
      parseWorkflowRunEventFileLine(JSON.stringify({ type: 'run-settled', ts: 1, outcome: 'bogus' })),
    ).toBeUndefined()
  })
})

describe('foldRunJournalEvents（run 骨架 fold）', () => {
  it('dispatched 成骨架行、settled 定步骤终局、run-settled 定 run 终局；重放幂等', () => {
    const events = [
      runEvent({ type: 'run-created', runId: 'wf-1', workflowName: 'flow', argsSummary: '', ts: 1000 }),
      runEvent({ type: 'ask-dispatched', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100 }),
      runEvent({ type: 'ask-dispatched', taskIndex: 1, agentName: 'w2', attempt: 1, ts: 1200 }),
      runEvent({ type: 'ask-settled', taskIndex: 0, attempt: 1, outcome: 'completed', durationMs: 800, ts: 1900 }),
      runEvent({ type: 'run-settled', outcome: 'completed', artifactsDir: '/tmp/a', ts: 2000 }),
    ]
    let fold = initialRunJournalFold()
    fold = foldRunJournalEvents(fold, events)
    expect(fold.created).toEqual({ runId: 'wf-1', workflowName: 'flow', ts: 1000 })
    expect(fold.asks.get(0)).toMatchObject({ agentName: 'w1', startedAt: 1100, settled: { outcome: 'completed' } })
    expect(fold.asks.get(1)?.settled).toBeUndefined()
    expect(fold.runSettled?.outcome).toBe('completed')

    // 重放同一序列：状态不变（幂等）
    const replayed = foldRunJournalEvents(fold, events)
    expect(replayed.asks.get(0)?.settled?.ts).toBe(1900)
    expect(replayed.runSettled?.ts).toBe(2000)
    expect(replayed.asks.size).toBe(2)
  })
})

// ── v2 条目扫描 ───────────────────────────────────────────────

describe('scanV2RecordEntries', () => {
  it('两族 registered/settled 分类收集；v1 与 future-v 跳过', () => {
    const scan = scanV2RecordEntries([
      subagentRegisteredEntry('sa-1'),
      subagentSettledEntry('sa-1'),
      workflowRegisteredEntry('wf-1'),
      workflowSettledEntry('wf-1'),
      { type: 'custom', customType: 'subagent-record', data: { v: 1, id: 'x', status: 'running' } },
      { type: 'custom', customType: 'subagent-record', data: { v: 9, kind: 'registered', id: 'y' } },
    ])
    expect([...scan.subagentRegistered.keys()]).toEqual(['sa-1'])
    expect([...scan.subagentSettled.keys()]).toEqual(['sa-1'])
    expect([...scan.workflowRegistered.keys()]).toEqual(['wf-1'])
    expect([...scan.workflowSettled.keys()]).toEqual(['wf-1'])
  })
})

// ── 合并仲裁纯函数 ────────────────────────────────────────────

describe('projectV2Subagent（journal 胜出 / 窗外兜底）', () => {
  const registered = {
    v: 2 as const,
    kind: 'registered' as const,
    id: 'sa-1',
    agent: 'worker',
    task: 'Do work',
    slug: 'work',
    origin: 'workflow' as const,
    parentRunId: 'wf-1',
    stepIndex: 0,
    rootSessionId: 's1',
    depth: 0,
    startedAt: 1000,
  }
  const settledEntry = {
    v: 2 as const,
    kind: 'settled' as const,
    id: 'sa-1',
    status: 'idle' as const,
    stopReason: 'interrupted' as const,
    endedAt: 3000,
    turns: 9,
    totalTokens: 999,
    model: 'p/m',
    thinkingLevel: undefined,
    engine: undefined,
    engineHandle: undefined,
    sessionFile: undefined,
    result: 'full result text',
  }

  it('journal fold 在场：状态/统计由 fold 裁决（胜出），条目补 model/result 全文', () => {
    // journal：created + bound + settled(completed)；条目：settled(interrupted)——冲突下 journal 胜出
    const fold = {
      identity: createdEvent('sa-1'),
      bound: {
        type: 'record-bound' as const,
        seq: 2,
        ts: 1500,
        sessionFile: '/sub/sa-1.jsonl',
        engine: 'pi',
        engineHandle: { sessionRef: {}, poolKey: 'shared' },
        epoch: 0,
      },
      round: undefined,
      epoch: 0,
      roundIdle: undefined,
      settled: settledRecordEvent(),
      lastSeq: 3,
      lastEvent: undefined,
    }
    const record = projectV2Subagent(registered, settledEntry, fold)!
    expect(record.status).toBe('idle')
    expect(record.stopReason).toBe('completed') // journal 胜出（条目是 interrupted）
    expect(record.turns).toBe(2)
    expect(record.totalTokens).toBe(500)
    expect(record.model).toBe('p/m') // 条目独有字段仍填充
    expect(record.result).toBe('full result text')
    expect(record.sessionFile).toBe('/sub/sa-1.jsonl') // bound 事件
    expect(record.engineHandle?.poolKey).toBe('shared')
  })

  it('journal 缺席（窗外终态实体）：终态条目兜底成投影', () => {
    const record = projectV2Subagent(registered, settledEntry, undefined)!
    expect(record.status).toBe('idle')
    expect(record.stopReason).toBe('interrupted')
    expect(record.turns).toBe(9)
    expect(record.sessionFile).toBeNull()
  })

  it('仅有注册条目：running 投影（身份域齐备）', () => {
    const record = projectV2Subagent(registered, undefined, undefined)!
    expect(record.status).toBe('running')
    expect(record.agent).toBe('worker')
    expect(record.parentRunId).toBe('wf-1')
    expect(record.stepIndex).toBe(0)
  })

  it('两源皆缺 → null', () => {
    expect(projectV2Subagent(undefined, undefined, undefined)).toBeNull()
  })
})

describe('projectV2Workflow（run 域定界 + journal 骨架）', () => {
  it('注册条目缺席（其他会话的 run）→ null（定界）', () => {
    const fold = initialRunJournalFold()
    expect(projectV2Workflow(undefined, undefined, fold)).toBeNull()
  })

  it('journal 骨架 + 条目摘要合并成 WorkflowRunRecord', () => {
    const registered = {
      v: 2 as const,
      kind: 'registered' as const,
      runId: 'wf-1',
      workflowName: 'flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      journalPath: '/tmp/ws/wf-1.events.jsonl',
    }
    const settledEntry = {
      v: 2 as const,
      kind: 'settled' as const,
      runId: 'wf-1',
      status: 'done' as const,
      reason: 'completed' as const,
      outcome: 'completed' as const,
      settledAt: 3000,
      callCount: 2,
      usedTokens: 800,
    }
    const fold = foldRunJournalEvents(
      initialRunJournalFold(),
      [
        runEvent({ type: 'run-created', runId: 'wf-1', workflowName: 'flow', argsSummary: '', ts: 1000 }),
        runEvent({ type: 'ask-dispatched', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100 }),
        runEvent({ type: 'ask-dispatched', taskIndex: 1, agentName: 'w2', attempt: 1, ts: 1200 }),
        runEvent({ type: 'ask-settled', taskIndex: 1, attempt: 1, outcome: 'failed', errorCode: 'engine_crashed', durationMs: 300, ts: 1500 }),
        runEvent({ type: 'run-settled', outcome: 'completed', artifactsDir: '/tmp/a', ts: 3000 }),
      ],
    )
    const record = projectV2Workflow(registered, settledEntry, fold)!
    expect(record.status).toBe('done')
    expect(record.reason).toBe('completed')
    expect(record.scriptName).toBe('test-flow')
    expect(record.stateFilePath).toBe('/tmp/ws/wf-1.events.jsonl')
    expect(record.usedTokens).toBe(800)
    expect(record.agentCalls.map((c) => [c.id, c.status])).toEqual([[0, 'running'], [1, 'failed']])
    expect(record.agentCalls[1]!.error).toBe('engine_crashed')
    expect(record.outcome).toBe('completed')
  })
})

describe('mergeJournalProjection（单点合并）', () => {
  it('v1 冻结定界：v1 快照实体不被 journal/entry v2 覆盖', () => {
    const sources = initialJournalProjectionSources()
    sources.v1Subagents.set('sa-1', {
      subagentId: 'sa-1', sessionFile: null, agent: 'v1-agent', slug: '', task: '',
      status: 'running',
    })
    // 同 id 的 journal fold（身份 agent=worker）不得覆盖 v1 冻结数据
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined, round: undefined, epoch: undefined, roundIdle: undefined,
      settled: undefined, lastSeq: 1, lastEvent: undefined,
    }
    sources.recordFolds.set('sa-1', fold)
    const merged = mergeJournalProjection(sources, 's1')
    expect(merged.subagents.get('sa-1')?.agent).toBe('v1-agent')
  })

  it('rootSessionId 非本会话的 record fold 被排除（records 目录按 cwd 共享）', () => {
    const sources = initialJournalProjectionSources()
    const foreign = createdEvent('sa-foreign')
    foreign.rootSessionId = 's-other'
    sources.recordFolds.set('sa-foreign', {
      identity: foreign, bound: undefined, round: undefined, epoch: undefined,
      roundIdle: undefined, settled: undefined, lastSeq: 1, lastEvent: undefined,
    })
    const merged = mergeJournalProjection(sources, 's1')
    expect(merged.subagents.has('sa-foreign')).toBe(false)
  })

  it('步骤视图合并（W0 输入换源）：record 投影按 (parentRunId, stepIndex) 覆盖 run 骨架行状态', () => {
    const sources = initialJournalProjectionSources()
    const registered = {
      v: 2 as const, kind: 'registered' as const, runId: 'wf-1', workflowName: 'f',
      scriptName: 'f', slug: 'f', startedAt: 1000, journalPath: '/tmp/j',
    }
    sources.v2WorkflowRegistered.set('wf-1', registered)
    sources.runFolds.set(
      'wf-1',
      foldRunJournalEvents(initialRunJournalFold(), [
        runEvent({ type: 'run-created', runId: 'wf-1', workflowName: 'f', argsSummary: '', ts: 1000 }),
        runEvent({ type: 'ask-dispatched', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100 }),
      ]),
    )
    sources.recordFolds.set('sa-1', {
      identity: createdEvent('sa-1'),
      bound: undefined, round: undefined, epoch: undefined, roundIdle: undefined,
      settled: settledRecordEvent(),
      lastSeq: 3, lastEvent: undefined,
    })
    const merged = mergeJournalProjection(sources, 's1')
    // run 骨架行 running 被 record 终态 overlay 为 completed（mergeWorkflowStepRecords 同一纯函数）
    expect(merged.workflows.get('wf-1')?.agentCalls[0]).toMatchObject({ status: 'completed', sessionId: 'sa-1' })
  })
})

// ── 会话文件流式扫描 ─────────────────────────────────────────

describe('scanRecordFamilyEntriesFromSessionFile（冷启动流式 entry 源）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jp-scan-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })

  it('对话行不进结果；v1/v2/legacy/session 行命中收集；跨块长行完整拼接', async () => {
    const { truncateSync, statSync } = await import('node:fs')
    const filePath = join(dir, 'session.jsonl')
    const filler = 'x'.repeat(300 * 1024) // 跨块的填充行（预过滤排除，不进结果）
    const lines = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj' }),
      JSON.stringify({ type: 'message', id: 'm0', message: { role: 'user', content: '聊天内容' } }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: filler } }),
      JSON.stringify(subagentRegisteredEntry('sa-1')),
      JSON.stringify(subagentSettledEntry('sa-1')),
      JSON.stringify(workflowRegisteredEntry('wf-1')),
      JSON.stringify({ type: 'message', id: 'm2', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'subagent', arguments: { action: 'start', startParam: { task: 't', slug: 's' } } }] } }),
    ]
    writeFileSync(filePath, lines.join('\n') + '\n')
    const entries = scanRecordFamilyEntriesFromSessionFile(filePath)!
    const types = entries.map((e) => (e as { type?: string }).type)
    // 4 条命中：session + 3 个 record 族条目（对话行 m0 不含线索被排除；m1 填充行同）
    expect(types.filter((t) => t === 'message')).toHaveLength(1)
    expect(types.filter((t) => t === 'session')).toHaveLength(1)
    expect(types.filter((t) => t === 'custom')).toHaveLength(3)
    expect(statSync(filePath).size).toBeGreaterThan(300 * 1024) // 填充确实跨块

    void truncateSync
  })

  it('文件缺失 → 空数组（延迟写入合法窗口）；超 32MB → null（回落兼容路径）', async () => {
    expect(scanRecordFamilyEntriesFromSessionFile(join(dir, 'missing.jsonl'))).toEqual([])
    const { truncateSync } = await import('node:fs')
    const big = join(dir, 'big.jsonl')
    writeFileSync(big, '\n')
    truncateSync(big, 33 * 1024 * 1024)
    expect(scanRecordFamilyEntriesFromSessionFile(big)).toBeNull()
  })
})

// ── 有状态投影（tailer 接线集成）─────────────────────────────

describe('SessionJournalProjection（冷启动 + 增量 + dispose）', () => {
  let dir: string
  let recordsDir: string
  let runDir: string
  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'jp-proj-'))
    recordsDir = join(dir, 'records')
    runDir = join(dir, 'workflow-state')
    mkdirSync(recordsDir, { recursive: true })
    mkdirSync(runDir, { recursive: true })
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('冷启动：attach 全量读两域 journal → 合并快照（entry 批先行喂 v2 条目）', () => {
    writeFileSync(join(recordsDir, 'sa-1.events'), recordJournalLines('sa-1', [createdEvent('sa-1')]).join('\n') + '\n')
    writeFileSync(
      join(runDir, 'wf-1.events.jsonl'),
      [
        JSON.stringify({ type: 'run-created', runId: 'wf-1', workflowName: 'f', argsSummary: '', ts: 1000 }),
        JSON.stringify({ type: 'ask-dispatched', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100 }),
      ].join('\n') + '\n',
    )
    const projection = new SessionJournalProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: () => {},
      recheckIntervalMs: 50,
    })
    try {
      projection.applyEntryBatch([subagentRegisteredEntry('sa-1'), workflowRegisteredEntry('wf-1')])
      projection.attach()
      expect(projection.subagents.get('sa-1')).toMatchObject({ subagentId: 'sa-1', status: 'running' })
      expect(projection.workflows.get('wf-1')).toMatchObject({ runId: 'wf-1', status: 'running' })
      expect(projection.workflows.get('wf-1')?.agentCalls).toHaveLength(1)
    } finally {
      projection.dispose()
    }
  })

  it('增量：周期复查拾取追加事件 → fold 推进 → onChange 驱动（投影变更即信号源）', async () => {
    writeFileSync(join(recordsDir, 'sa-1.events'), recordJournalLines('sa-1', [createdEvent('sa-1')]).join('\n') + '\n')
    const onChange = vi.fn()
    const projection = new SessionJournalProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: onChange,
      recheckIntervalMs: 50,
    })
    try {
      projection.applyEntryBatch([subagentRegisteredEntry('sa-1')])
      projection.attach()
      expect(projection.subagents.get('sa-1')?.status).toBe('running')
      onChange.mockClear()

      // journal 追加终态事件（offset 续读增量）
      appendFileSync(join(recordsDir, 'sa-1.events'), `${recordEventLine(settledRecordEvent())}\n`)
      await vi.advanceTimersByTimeAsync(120)
      expect(projection.subagents.get('sa-1')?.status).toBe('idle')
      expect(projection.subagents.get('sa-1')?.stopReason).toBe('completed')
      expect(onChange).toHaveBeenCalled()
    } finally {
      projection.dispose()
    }
  })

  it('坏行宽容 + v2 事件重放幂等（seq 守卫）', async () => {
    writeFileSync(
      join(recordsDir, 'sa-1.events'),
      [...recordJournalLines('sa-1', [createdEvent('sa-1')]), '{broken-line', ''].join('\n') + '\n',
    )
    const projection = new SessionJournalProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: () => {},
      recheckIntervalMs: 50,
    })
    try {
      projection.attach()
      expect(projection.subagents.get('sa-1')).toBeDefined() // 坏行跳过不炸投影
      // 重放同 seq 事件（截断重读形态）：状态不回退
      appendFileSync(join(recordsDir, 'sa-1.events'), `${recordEventLine(createdEvent('sa-1'))}\n`)
      await vi.advanceTimersByTimeAsync(120)
      const record = projection.subagents.get('sa-1')!
      expect(record.status).toBe('running')
      expect(record.subagentId).toBe('sa-1')
    } finally {
      projection.dispose()
    }
  })

  it('dispose 后停增量（周期复查不复活投影）', async () => {
    writeFileSync(join(recordsDir, 'sa-1.events'), recordJournalLines('sa-1', [createdEvent('sa-1')]).join('\n') + '\n')
    const projection = new SessionJournalProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: () => {},
      recheckIntervalMs: 50,
    })
    projection.attach()
    projection.dispose()
    appendFileSync(join(recordsDir, 'sa-1.events'), `${recordEventLine(settledRecordEvent())}\n`)
    await vi.advanceTimersByTimeAsync(200)
    expect(projection.subagents.get('sa-1')?.status).toBe('running')
  })
})
