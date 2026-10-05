/**
 * 事件投影直测（W1 [D6] runtime 读侧换源）：双源单点合并仲裁（事件源胜出 /
 * 窗外条目兜底 / v1 冻结定界）+ 会话文件流式扫描（冷启动 entry 源）+ 有状态投影
 * （tail 目录 watcher 冷启动/增量/dispose）。
 *
 * fixture 全部落 mkdtemp 临时目录（mkdtempSync 自建自删，rmSync 全参数）；
 * record 事件文件/run journal 形态对齐 u0 契约（record-events.ts 六类词表 +
 * 首行头行 / run-events.ts 七类词表）。测试框架：vitest + fake timers（tailer
 * 周期复查注入短值驱动确定性增量）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/events-projection.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  mergeEventProjection,
  initialEventProjectionSources,
  parseWorkflowRunEventFileLine,
  projectV2Subagent,
  scanV2RecordEntries,
  SessionEventProjection,
} from '../events-projection.js'
import { projectV2Workflow } from '../workflow-record-projection.js'
import { scanRecordFamilyEntriesFromSessionFile } from '../session-file-extraction.js'
import type { SubagentJournalEvent } from '@zhushanwen/extension-protocol'
import {
  foldRunEventCheckpoint,
  INITIAL_RUN_EVENT_FOLD,
} from '@zhushanwen/subagent-core'
import type {
  RecordCreatedEvent,
  RecordEvent,
  RecordSettledEvent,
  WorkflowRunEvent,
} from '@zhushanwen/subagent-core'
import type { SubagentRecord } from '@taiji/shared'

// ── fixture 构造（u0 契约形态）────────────────────────────────

function recordEventLine(event: RecordEvent): string {
  return JSON.stringify(event)
}

function recordJournalLines(id: string, events: RecordEvent[]): string[] {
  return [JSON.stringify({ type: 'record-events', id }), ...events.map(recordEventLine)]
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

/** 带 seq 信封的事件（W1 起新格式 事件行形态——seq 守卫/重放去重用例的载体）。 */
function runSeqEvent(seq: number, over: Record<string, unknown>): WorkflowRunEvent {
  return { ts: 1000 + seq * 100, seq, ...(over as object) } as unknown as WorkflowRunEvent
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
      recordPath: '/tmp/wf-state/wf-1.events.jsonl',
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
      outcome: 'done',
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
    const ok = parseWorkflowRunEventFileLine(JSON.stringify({ type: 'agent-started', ts: 1, taskIndex: 0, agentName: 'w', attempt: 1 }))
    expect(ok).toMatchObject({ type: 'agent-started', taskIndex: 0 })
    expect(parseWorkflowRunEventFileLine('')).toBeUndefined()
    expect(parseWorkflowRunEventFileLine('not-json')).toBeUndefined()
    expect(parseWorkflowRunEventFileLine(JSON.stringify({ type: 'unknown-type', ts: 1 }))).toBeUndefined()
    expect(parseWorkflowRunEventFileLine(JSON.stringify({ type: 'armed', ts: 'not-number' }))).toBeUndefined()
    expect(
      parseWorkflowRunEventFileLine(JSON.stringify({ type: 'run-settled', ts: 1, outcome: 'bogus' })),
    ).toBeUndefined()
  })

  it('[W2 D2] 删值成员 ask-executing 的历史 事件行 → undefined（tailer 跳过计日志链路的 parse 面）；保留成员 armed 照常放行', () => {
    // 词表缩窄前落账的历史行（完整载荷形态）——解析层返回 undefined 交 tailer
    // 计数 warn，不卡游标、不炸投影
    expect(
      parseWorkflowRunEventFileLine(
        JSON.stringify({ type: 'ask-executing', ts: 1, taskIndex: 0, agentName: 'w', attempt: 1 }),
      ),
    ).toBeUndefined()
    // [D5]/[D6] armed / member-pool 历史行（词表成员删除）→ 词表外坏行 undefined
    expect(
      parseWorkflowRunEventFileLine(
        JSON.stringify({ type: 'member-pool', ts: 1, action: 'clear' }),
      ),
    ).toBeUndefined()
    expect(
      parseWorkflowRunEventFileLine(JSON.stringify({ type: 'armed', ts: 1, frame: {} })),
    ).toBeUndefined()
    // [D2] run-interrupted / run-resumed 新成员照常放行
    expect(
      parseWorkflowRunEventFileLine(JSON.stringify({ type: 'run-interrupted', ts: 1, errorCode: 'crashed' })),
    ).toMatchObject({ type: 'run-interrupted', errorCode: 'crashed' })
  })

  it('[W1 seq 契约] 携带 seq 的行按正安全整数校验：字符串/0/-1/1.5 → undefined；合法 seq 与无 seq 旧行放行（对齐 core isWorkflowRunEventLine）', () => {
    const seqLine = (seq: unknown): string =>
      JSON.stringify({ type: 'agent-started', ts: 1, taskIndex: 0, agentName: 'w', attempt: 1, seq })
    // 坏值：非 number（字符串 "5"）/ 非正整数（0 / -1）/ 非整数（1.5）——坏行交 tailer 计数
    expect(parseWorkflowRunEventFileLine(seqLine('5'))).toBeUndefined()
    expect(parseWorkflowRunEventFileLine(seqLine(0))).toBeUndefined()
    expect(parseWorkflowRunEventFileLine(seqLine(-1))).toBeUndefined()
    expect(parseWorkflowRunEventFileLine(seqLine(1.5))).toBeUndefined()
    // 合法 seq（1 起正安全整数）透传
    expect(parseWorkflowRunEventFileLine(seqLine(1))).toMatchObject({ type: 'agent-started', seq: 1 })
    expect(parseWorkflowRunEventFileLine(seqLine(Number.MAX_SAFE_INTEGER))).toMatchObject({
      seq: Number.MAX_SAFE_INTEGER,
    })
    // W1 前存量 事件行无 seq 字段（D7 惰性兼容读）——放行
    expect(
      parseWorkflowRunEventFileLine(JSON.stringify({ type: 'agent-started', ts: 1, taskIndex: 0, agentName: 'w', attempt: 1 })),
    ).toMatchObject({ type: 'agent-started' })
  })
})

describe('run 域 journal fold（[W2 D7] 单源 core foldRunEventCheckpoint——runtime 投影消费骨架半边）', () => {
  const noop = (): void => {}

  /** 合法序列（写入序）：created → 两 ask 派发 → ask-0 终局 → run 终局。 */
  const legalEvents: WorkflowRunEvent[] = [
    runSeqEvent(1, { type: 'run-created', runId: 'wf-1', workflowName: 'flow', argsSummary: '' }),
    runSeqEvent(2, { type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1 }),
    runSeqEvent(3, { type: 'agent-started', taskIndex: 1, agentName: 'w2', attempt: 1 }),
    runSeqEvent(4, { type: 'agent-settled', taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 800 }),
    runSeqEvent(5, { type: 'run-settled', outcome: 'done', artifactsDir: '/tmp/a' }),
  ]

  it('骨架投影：created 定首帧、dispatched 成骨架行、settled 定步骤终局、run-settled 定 run 终局', () => {
    const fold = foldRunEventCheckpoint(legalEvents, noop)
    // created 载荷含 argsSummary（[可视化 U1] 扩 fold 骨架字段——写侧恒写的行内小摘要透传）
    expect(fold.created).toEqual({ runId: 'wf-1', workflowName: 'flow', argsSummary: '', ts: 1100 })
    expect(fold.asks.get(0)).toMatchObject({ agentName: 'w1', startedAt: 1200, settled: { outcome: 'done' } })
    expect(fold.asks.get(1)?.settled).toBeUndefined()
    expect(fold.runSettled).toMatchObject({ outcome: 'done', ts: 1500 })
    // 状态半边同源于一次 fold：终帧 terminal + seq 水位 = 末帧
    expect(fold.state).toEqual({ lifecycle: 'terminal', outcome: 'done' })
    expect(fold.lastSeq).toBe(5)
  })

  it('[live≡reload 等价族] 增量批次接续 fold ≡ 一次性全量 fold（checkpoint 逐字段相等）', () => {
    const incremental = foldRunEventCheckpoint(
      legalEvents.slice(3),
      noop,
      foldRunEventCheckpoint(legalEvents.slice(0, 3), noop),
    )
    const full = foldRunEventCheckpoint(legalEvents, noop)
    expect(incremental).toEqual(full)
  })

  it('[live≡reload 等价族] seq 重放幂等：已 fold checkpoint 重放全量流不重复推进（tail 截断重建形态）', () => {
    const once = foldRunEventCheckpoint(legalEvents, noop)
    const replayed = foldRunEventCheckpoint(legalEvents, noop, once)
    expect(replayed).toEqual(once)
  })

  it('[D6] member-pool 历史行进 fold 停帧（词表成员删除后表外转移——骨架停在最近一致态）；[D3] phase 骨架随转移事件产出', () => {
    // member-pool 历史行（[D6] 删除成员）：fold 在该帧撞表外转移 → 保守停帧
    const stopped = foldRunEventCheckpoint(
      [
        runSeqEvent(1, { type: 'run-created', runId: 'wf-mp', workflowName: 'flow', argsSummary: '' }),
        runSeqEvent(2, { type: 'member-pool', action: 'register', name: 'w1', recordId: 'sa-1' }),
      ],
      noop,
    )
    expect(stopped.created).toMatchObject({ runId: 'wf-mp' })
    expect(stopped.lastSeq).toBe(1) // member-pool 帧未应用（水位停在 run-created）
    // [D3] phase 状态机骨架：phase-started/phase-settled 落投影半边
    const folded = foldRunEventCheckpoint(
      [
        runSeqEvent(1, { type: 'run-created', runId: 'wf-ph', workflowName: 'flow', argsSummary: '' }),
        runSeqEvent(2, { type: 'phase-started', phase: 'impl' }),
        runSeqEvent(3, { type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, phase: 'impl' }),
        runSeqEvent(4, { type: 'phase-settled', phase: 'impl' }),
        runSeqEvent(5, { type: 'run-settled', outcome: 'done', artifactsDir: '/tmp/a' }),
      ],
      noop,
    )
    expect(folded.phases.get('impl')).toMatchObject({ phase: 'impl' })
    expect(folded.phases.get('impl')?.settledAt).toBeDefined()
    expect(folded.runSettled).toMatchObject({ outcome: 'done' })
  })

  it('被动终局帧透传：收编/回收路径 run-settled（interrupted + errorCode 细分）落骨架与投影', () => {
    // 历史回收帧（场景 3 事件帧口径）：outcome=interrupted + errorCode=idle-evicted
    // ——历史写入方 = 已退役的 30 天内存回收机制（见 ADR），词表成员为存量帧解析保留
    const evicted = foldRunEventCheckpoint(
      [
        runSeqEvent(1, { type: 'run-created', runId: 'wf-idle', workflowName: 'flow', argsSummary: '' }),
        runSeqEvent(2, { type: 'run-settled', outcome: 'interrupted', errorCode: 'idle-evicted', artifactsDir: '/tmp/a' }),
      ],
      noop,
    )
    expect(evicted.runSettled).toMatchObject({ outcome: 'interrupted', errorCode: 'idle-evicted' })
    expect(evicted.state).toEqual({ lifecycle: 'terminal', outcome: 'interrupted' })

    // 投影合成：注册条目在场 + 事件收编帧 → WorkflowRunRecord 透传 outcome/errorCode
    const registered = {
      v: 2 as const,
      kind: 'registered' as const,
      runId: 'wf-idle',
      workflowName: 'flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      recordPath: '/tmp/ws/wf-idle.events.jsonl',
    }
    const record = projectV2Workflow(registered, undefined, evicted)!
    expect(record.status).toBe('done')
    expect(record.outcome).toBe('interrupted')
    expect(record.errorCode).toBe('idle-evicted')
  })

  it('收编双帧先到帧为准：terminal 吸收后到 run-settled，骨架 runSettled 停先到帧（TOCTOU 残余口径）', () => {
    const dual = foldRunEventCheckpoint(
      [
        runSeqEvent(1, { type: 'run-created', runId: 'wf-dual', workflowName: 'flow', argsSummary: '' }),
        runSeqEvent(2, { type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1 }),
        runSeqEvent(3, { type: 'run-settled', outcome: 'interrupted', errorCode: 'idle-evicted', artifactsDir: '/tmp/a' }),
        runSeqEvent(4, { type: 'run-settled', outcome: 'failed', artifactsDir: '/tmp/a' }),
      ],
      noop, // onBrokenFrame 出声归消费方注入（applyRunEvents 接 warn）
    )
    expect(dual.runSettled).toMatchObject({ outcome: 'interrupted', errorCode: 'idle-evicted' })
    expect(dual.state).toEqual({ lifecycle: 'terminal', outcome: 'interrupted' })
  })

  it('占位行兜底：合法转移下跨 taskIndex 错位的 agent-settled（agent-started 缺席）成占位行不丢终局', () => {
    // 转移表不校验 taskIndex 归属：running 态下 settled 的 taskIndex 无 agent-started
    // 行 = 残形态——骨架兜底 '(unknown)' 占位行，终局不丢（record overlay 会覆盖）
    const fold = foldRunEventCheckpoint(
      [
        runSeqEvent(1, { type: 'run-created', runId: 'wf-mis', workflowName: 'flow', argsSummary: '' }),
        runSeqEvent(2, { type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1 }),
        runSeqEvent(3, { type: 'agent-settled', taskIndex: 7, attempt: 1, outcome: 'failed', errorCode: 'unknown', durationMs: 5 }),
      ],
      noop,
    )
    expect(fold.asks.get(7)).toMatchObject({ agentName: '(unknown)', settled: { outcome: 'failed' } })
    expect(fold.asks.get(0)?.settled).toBeUndefined()
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

describe('projectV2Subagent（事件源胜出 / 窗外兜底）', () => {
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

  it('事件 fold 在场：状态/统计由 fold 裁决（胜出），条目补 model/result 全文', () => {
    // 事件源：created + bound + settled(completed)；条目：settled(interrupted)——冲突下 事件源胜出
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
      reopened: undefined,
      lastSeq: 3,
      lastEvent: undefined,
    }
    const record = projectV2Subagent(registered, settledEntry, fold)!
    expect(record.status).toBe('idle')
    expect(record.stopReason).toBe('completed') // 事件源胜出（条目是 interrupted）
    expect(record.turns).toBe(2)
    expect(record.totalTokens).toBe(500)
    expect(record.model).toBe('p/m') // 条目独有字段仍填充
    expect(record.result).toBe('full result text')
    expect(record.sessionFile).toBe('/sub/sa-1.jsonl') // bound 事件
    expect(record.engineHandle?.poolKey).toBe('shared')
  })

  it('事件 fold 缺席（窗外终态实体）：终态条目兜底成投影', () => {
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

  // [F1-38 轮终形态] v1 语义：轮终翻边写 idle（写侧 markRoundIdle 落 idle + v1
  // 权威词同源）——v2 投影须延续（轮终等待续聊的 record 不得显示 running，否则
  // running + stopReason 矛盾组合且可能被用户误 cancel）。
  it('轮终形态：round-idle 在场、settled 缺席 → idle + roundIdle 统计透传', () => {
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 1,
      epoch: 0,
      roundIdle: {
        type: 'record-round-idle' as const,
        round: 1,
        seq: 3,
        ts: 2500,
        stopReason: 'completed' as const,
        turns: 2,
        totalTokens: 500,
      },
      settled: undefined,
      reopened: undefined,
      lastSeq: 3,
      lastEvent: {
        type: 'record-round-idle' as const,
        round: 1,
        seq: 3,
        ts: 2500,
        stopReason: 'completed' as const,
        turns: 2,
        totalTokens: 500,
      },
    }
    const record = projectV2Subagent(registered, undefined, fold)!
    expect(record.status).toBe('idle')
    expect(record.stopReason).toBe('completed')
    expect(record.turns).toBe(2)
    expect(record.totalTokens).toBe(500)
  })

  it('续跑第二轮：round-started 在 round-idle 后 → running（roundIdle 在场不作 idle 判据）', () => {
    const roundIdle = {
      type: 'record-round-idle' as const,
      round: 2,
      seq: 3,
      ts: 2500,
      stopReason: 'completed' as const,
      turns: 2,
      totalTokens: 500,
    }
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 2,
      epoch: 0,
      roundIdle,
      settled: undefined,
      reopened: undefined,
      lastSeq: 4,
      lastEvent: { type: 'record-round-started' as const, seq: 4, ts: 3000, round: 2, epoch: 0 },
    }
    const record = projectV2Subagent(registered, undefined, fold)!
    expect(record.status).toBe('running')
    // [F2-1] 轮始清点：上轮停因不透传（v1 markRoundStartedImpl 清点对齐——running +
    // 「completed」停因矛盾组合不得出现）
    expect(record.stopReason).toBeUndefined()
  })

  it('在飞 + 旧 v2 终态条目在场：stopReason 不透传条目停因（事件源胜出——窗外兜底仅限无 fold）', () => {
    // 场景：已终态（v2 终态条目已写）→ reopened → round-started——在飞期 roundIdle
    // 与条目停因都不得泄漏（v1 轮始清点后 stopReason=undefined）
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 1,
      epoch: 1,
      roundIdle: {
        type: 'record-round-idle' as const,
        round: 1,
        seq: 3,
        ts: 2500,
        stopReason: 'completed' as const,
        turns: 2,
        totalTokens: 500,
      },
      settled: undefined,
      reopened: undefined,
      lastSeq: 5,
      lastEvent: { type: 'record-round-started' as const, seq: 5, ts: 3500, round: 1, epoch: 1 },
    }
    const record = projectV2Subagent(registered, settledEntry, fold)!
    expect(record.status).toBe('running')
    expect(record.stopReason).toBeUndefined()
  })

  it('reopened 窗口（重开完成、新轮未始）→ idle（markReopened CAS 只接受 idle、不翻 running）', () => {
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 0,
      epoch: 1,
      roundIdle: {
        type: 'record-round-idle' as const,
        round: 1,
        seq: 3,
        ts: 2500,
        stopReason: 'completed' as const,
        turns: 2,
        totalTokens: 500,
      },
      settled: undefined,
      reopened: { type: 'record-reopened' as const, seq: 4, ts: 3000, epoch: 1, round: 0 },
      lastSeq: 4,
      lastEvent: { type: 'record-reopened' as const, seq: 4, ts: 3000, epoch: 1, round: 0 },
    }
    const record = projectV2Subagent(registered, undefined, fold)!
    expect(record.status).toBe('idle')
    // [F2-1] v1 markReopenedImpl 写 stopReason='reopened'——投影同词映射，
    // 不透传更旧轮的轮终停因
    expect(record.stopReason).toBe('reopened')
  })

  // [W1 / F1-46 轮终 result] record-round-idle 携带 result 摘要锚（D3 词表裁决①）：
  // 轮终粒度的 result 断供修复——承接 v1 U8b 轮终 result 显示信号（「轮终等待续聊」
  // 的展示面），终局全文仍只在 v2 终态条目一次性写（D1）。
  it('轮终摘要透传：round-idle.resultSummary 在场（无终态条目）→ result 取轮终摘要', () => {
    const roundIdle = {
      type: 'record-round-idle' as const,
      round: 1,
      seq: 3,
      ts: 2500,
      stopReason: 'completed' as const,
      turns: 2,
      totalTokens: 500,
      resultSummary: '本轮正文摘要',
    }
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 1,
      epoch: 0,
      roundIdle,
      settled: undefined,
      reopened: undefined,
      lastSeq: 3,
      lastEvent: roundIdle,
    }
    const record = projectV2Subagent(registered, undefined, fold)!
    expect(record.result).toBe('本轮正文摘要')
  })

  it('reopened 续跑后的新轮终摘要胜过旧终局条目全文（fresh round-idle 胜出）', () => {
    const roundIdle = {
      type: 'record-round-idle' as const,
      round: 2,
      seq: 6,
      ts: 6000,
      stopReason: 'completed' as const,
      turns: 4,
      totalTokens: 900,
      resultSummary: 'new round summary',
    }
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 2,
      epoch: 1,
      roundIdle,
      settled: undefined, // reopened / round-started 已清除 settled
      reopened: undefined,
      lastSeq: 6,
      lastEvent: roundIdle,
    }
    const record = projectV2Subagent(registered, settledEntry, fold)!
    expect(record.result).toBe('new round summary')
  })

  it('终局面优先：settled 在场（晚于 round-idle）→ 条目全文 / 终局摘要锚', () => {
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 1,
      epoch: 0,
      roundIdle: {
        type: 'record-round-idle' as const,
        round: 1,
        seq: 2,
        ts: 2500,
        stopReason: 'completed' as const,
        turns: 2,
        totalTokens: 500,
        resultSummary: 'stale round summary',
      },
      settled: settledRecordEvent({ seq: 3, resultSummary: 'settled summary' }),
      reopened: undefined,
      lastSeq: 3,
      lastEvent: undefined,
    }
    // 无条目：终局摘要锚
    expect(projectV2Subagent(registered, undefined, fold)!.result).toBe('settled summary')
    // 条目全文在场：全文优先（D1 唯一全文落点）
    expect(projectV2Subagent(registered, settledEntry, fold)!.result).toBe('full result text')
  })

  // [W1 / F2-2 轮终 error] record-round-idle.error 失败原因原文供源（词表裁决）：
  // 供源分流与 stopReason 同构——settled 终局优先 → 最新轮终失败收条 → 条目面兜底；
  // round-started 后旧失败原文随轮始清点语义不透传（对齐 v1 markRoundStartedImpl
  // 清残留死因，F2-1 同族红线）。
  it('轮终失败：round-idle.error 在场（无终局）→ error 取失败原因原文', () => {
    const roundIdle = {
      type: 'record-round-idle' as const,
      round: 1,
      seq: 4,
      ts: 3000,
      stopReason: 'failed' as const,
      turns: 2,
      totalTokens: 600,
      resultSummary: 'round did not complete: engine crashed',
      error: 'engine crashed',
    }
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 1,
      epoch: 0,
      roundIdle,
      settled: undefined,
      reopened: undefined,
      lastSeq: 4,
      lastEvent: roundIdle,
    }
    expect(projectV2Subagent(registered, undefined, fold)!.error).toBe('engine crashed')
  })

  it('第二轮在飞：round-started 在 round-idle 后 → 上轮失败原文不透传（轮始清点语义）', () => {
    const roundIdle = {
      type: 'record-round-idle' as const,
      round: 2,
      seq: 4,
      ts: 3000,
      stopReason: 'failed' as const,
      turns: 2,
      totalTokens: 600,
      error: 'engine crashed',
    }
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 2,
      epoch: 0,
      roundIdle,
      settled: undefined,
      reopened: undefined,
      lastSeq: 5,
      lastEvent: { type: 'record-round-started' as const, seq: 5, ts: 4000, round: 2, epoch: 0 },
    }
    expect(projectV2Subagent(registered, undefined, fold)!.error).toBeUndefined()
  })

  it('终局优先：settled 在场 → error 取终局原文（晚于轮终收条时不受 roundIdle 影响）', () => {
    const roundIdle = {
      type: 'record-round-idle' as const,
      round: 1,
      seq: 2,
      ts: 2500,
      stopReason: 'failed' as const,
      turns: 2,
      totalTokens: 500,
      error: 'round-level failure',
    }
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined,
     round: 1,
      epoch: 0,
      roundIdle,
      settled: settledRecordEvent({ seq: 3, resultSummary: 'settled summary', error: 'settled failure' }),
      reopened: undefined,
      lastSeq: 3,
      lastEvent: undefined,
    }
    expect(projectV2Subagent(registered, undefined, fold)!.error).toBe('settled failure')
  })
})

describe('projectV2Workflow（run 域定界 + 事件 fold 骨架）', () => {
  it('注册条目缺席（其他会话的 run）→ null（定界）', () => {
    expect(projectV2Workflow(undefined, undefined, INITIAL_RUN_EVENT_FOLD)).toBeNull()
  })

  /** registered 条目 fixture（v2 run 注册；scriptPath 可选——旧条目形态缺省）。 */
  function registeredEntry(runId: string, scriptPath?: string) {
    return {
      v: 2 as const,
      kind: 'registered' as const,
      runId,
      workflowName: 'flow',
      scriptName: 'test-flow',
      slug: 'tf',
      ...(scriptPath !== undefined ? { scriptPath } : {}),
      startedAt: 1000,
      recordPath: `/tmp/ws/${runId}.events.jsonl`,
    }
  }

  /** created + settled 两事件 fold（scriptPath 透传用例的最小事件面）。 */
  function createdSettledFold(runId: string) {
    return foldRunEventCheckpoint(
      [
        runEvent({ type: 'run-created', runId, workflowName: 'flow', argsSummary: '', ts: 1000 }),
        runEvent({ type: 'run-settled', outcome: 'done', artifactsDir: '/tmp/a', ts: 3000 }),
      ],
      () => {},
    )
  }

  it('注册条目 scriptPath 透传进 WorkflowRunRecord（GUI 详情层全路径源）', () => {
    const scriptPath = '/Users/x/project/.pi/workflows/test-flow.js'
    const record = projectV2Workflow(registeredEntry('wf-sp', scriptPath), undefined, createdSettledFold('wf-sp'))!
    expect(record.scriptPath).toBe(scriptPath)
  })

  it('旧注册条目（无 scriptPath）→ record.scriptPath 缺省（不回落猜路径）', () => {
    const record = projectV2Workflow(registeredEntry('wf-legacy'), undefined, createdSettledFold('wf-legacy'))!
    // 缺省空串（WorkflowRunRecord.scriptPath 可选；UI 回落 scriptName 短名）
    expect(record.scriptPath).toBe('')
  })

  it('事件 fold 骨架 + 条目摘要合并成 WorkflowRunRecord', () => {
    const registered = {
      v: 2 as const,
      kind: 'registered' as const,
      runId: 'wf-1',
      workflowName: 'flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      recordPath: '/tmp/ws/wf-1.events.jsonl',
    }
    const settledEntry = {
      v: 2 as const,
      kind: 'settled' as const,
      runId: 'wf-1',
      status: 'done' as const,
      reason: 'completed' as const,
      outcome: 'done' as const,
      settledAt: 3000,
      callCount: 2,
      usedTokens: 800,
    }
    const fold = foldRunEventCheckpoint(
      [
        runEvent({ type: 'run-created', runId: 'wf-1', workflowName: 'flow', argsSummary: '', ts: 1000 }),
        runEvent({ type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100 }),
        runEvent({ type: 'agent-started', taskIndex: 1, agentName: 'w2', attempt: 1, ts: 1200 }),
        runEvent({ type: 'agent-settled', taskIndex: 1, attempt: 1, outcome: 'failed', errorCode: 'engine_crashed', durationMs: 300, ts: 1500 }),
        runEvent({ type: 'run-settled', outcome: 'done', artifactsDir: '/tmp/a', ts: 3000 }),
      ],
      () => {},
    )
    const record = projectV2Workflow(registered, settledEntry, fold)!
    expect(record.status).toBe('done')
    expect(record.reason).toBe('completed')
    expect(record.scriptName).toBe('test-flow')
    expect(record.stateFilePath).toBe('/tmp/ws/wf-1.events.jsonl')
    expect(record.usedTokens).toBe(800)
    expect(record.agentCalls.map((c) => [c.id, c.status])).toEqual([[0, 'running'], [1, 'failed']])
    expect(record.agentCalls[1]!.error).toBe('engine_crashed')
    expect(record.outcome).toBe('done')
  })

  it('agent-started 带 phase → fold 骨架与投影 call.phase 透传；无 phase 行 undefined（W1 D6 分组供源）', () => {
    const fold = foldRunEventCheckpoint(
      [
        runEvent({ type: 'run-created', runId: 'wf-phase', workflowName: 'flow', argsSummary: '', ts: 1000 }),
        runEvent({ type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, phase: 'Dev-w0(W1)', ts: 1100 }),
        // 无 phase 帧 = 停写期 事件行 / 未标注剧本——fold 不造键
        runEvent({ type: 'agent-started', taskIndex: 1, agentName: 'w2', attempt: 1, ts: 1200 }),
      ],
      () => {},
    )
    expect(fold.asks.get(0)?.phase).toBe('Dev-w0(W1)')
    expect('phase' in fold.asks.get(1)!).toBe(false)

    const registered = {
      v: 2 as const,
      kind: 'registered' as const,
      runId: 'wf-phase',
      workflowName: 'flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      recordPath: '/tmp/ws/wf-phase.events.jsonl',
    }
    const record = projectV2Workflow(registered, undefined, fold)!
    // renderer hasExplicitPhases（phase !== undefined）的供源：带 phase 步骤进分组，旧行保持平铺
    expect(record.agentCalls[0]!.phase).toBe('Dev-w0(W1)')
    expect(record.agentCalls[1]!.phase).toBeUndefined()
  })

  it('中断形态条目（status=interrupted）在 fold 缺席兜底层 → interrupted（entry-only 降级投影不回落 running）', () => {
    const registered = {
      v: 2 as const,
      kind: 'registered' as const,
      runId: 'wf-intr',
      workflowName: 'flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      recordPath: '/tmp/ws/wf-intr.record.jsonl',
    }
    const interruptedEntry = {
      v: 2 as const,
      kind: 'settled' as const,
      runId: 'wf-intr',
      status: 'interrupted' as const,
      errorCode: 'crashed' as const,
      settledAt: 3000,
      callCount: 1,
      usedTokens: 0,
    }
    // fold 缺席（runJournalDir 缺席的 entry-only 降级投影 / record 流被外部清理）
    const record = projectV2Workflow(registered, interruptedEntry, undefined)!
    expect(record.status).toBe('interrupted')
    // 主链路不受影响：record 流在场时 fold 判据仍权威
    const folded = foldRunEventCheckpoint(
      [
        runEvent({ type: 'run-created', runId: 'wf-intr', workflowName: 'flow', argsSummary: '', ts: 1000 }),
        runEvent({ type: 'run-interrupted', errorCode: 'crashed', ts: 2500 }),
      ],
      () => {},
    )
    const record2 = projectV2Workflow(registered, interruptedEntry, folded)!
    expect(record2.status).toBe('interrupted')
    // F2-1：resume 复活窗口——run-resumed 已被 fold（lifecycle 回 running），中断
    // 形态条目留存不被覆盖（resume 只补写 registered 条目，appendResumeRegisteredEntry）。
    // 条目陈旧值不得劫持 fold 权威态：复活 run 整个执行期显示 running 而非「已中断」
    const resumedFold = foldRunEventCheckpoint(
      [
        runEvent({ type: 'run-created', runId: 'wf-intr', workflowName: 'flow', argsSummary: '', ts: 1000 }),
        runEvent({ type: 'run-interrupted', errorCode: 'crashed', ts: 2500 }),
        runEvent({ type: 'run-resumed', ts: 4000 }),
      ],
      () => {},
    )
    expect(resumedFold.state.lifecycle).toBe('running')
    const record3 = projectV2Workflow(registered, interruptedEntry, resumedFold)!
    expect(record3.status).toBe('running')
  })
})

describe('mergeEventProjection（单点合并）', () => {
  it('[§3.3 仲裁反转] 事件 fold 是实体唯一来源：注册条目缺席时按 fold 投影（无 v1 遮蔽通道）', () => {
    const sources = initialEventProjectionSources()
    const fold = {
      identity: createdEvent('sa-1'),
      bound: undefined, round: undefined, epoch: undefined, roundIdle: undefined,
      settled: undefined, reopened: undefined, lastSeq: 1, lastEvent: undefined,
    }
    sources.recordFolds.set('sa-1', fold)
    const merged = mergeEventProjection(sources, 's1')
    // fold 的 record-created 身份（agent=worker）直接进投影——v1 冻结层删除后不存在
    // 「同 id 快照遮蔽事件流」的方向性缺陷。
    expect(merged.subagents.get('sa-1')?.agent).toBe('worker')
  })

  it('rootSessionId 非本会话的 record fold 被排除（records 目录按 cwd 共享）', () => {
    const sources = initialEventProjectionSources()
    const foreign = createdEvent('sa-foreign')
    foreign.rootSessionId = 's-other'
    sources.recordFolds.set('sa-foreign', {
      identity: foreign, bound: undefined, round: undefined, epoch: undefined,
      roundIdle: undefined, settled: undefined, reopened: undefined, lastSeq: 1, lastEvent: undefined,
    })
    const merged = mergeEventProjection(sources, 's1')
    expect(merged.subagents.has('sa-foreign')).toBe(false)
  })

  it('步骤视图合并（W0 输入换源）：record 投影按 (parentRunId, stepIndex) 覆盖 run 骨架行状态', () => {
    const sources = initialEventProjectionSources()
    const registered = {
      v: 2 as const, kind: 'registered' as const, runId: 'wf-1', workflowName: 'f',
      scriptName: 'f', slug: 'f', startedAt: 1000, recordPath: '/tmp/j',
    }
    sources.v2WorkflowRegistered.set('wf-1', registered)
    sources.runFolds.set(
      'wf-1',
      foldRunEventCheckpoint(
        [
          runEvent({ type: 'run-created', runId: 'wf-1', workflowName: 'f', argsSummary: '', ts: 1000 }),
          runEvent({ type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100 }),
        ],
        () => {},
      ),
    )
    sources.recordFolds.set('sa-1', {
      identity: createdEvent('sa-1'),
      bound: undefined, round: undefined, epoch: undefined, roundIdle: undefined,
      settled: settledRecordEvent(),
      reopened: undefined,
      lastSeq: 3, lastEvent: undefined,
    })
    const merged = mergeEventProjection(sources, 's1')
    // run 骨架行 running 被 record 终态 overlay 为 completed（mergeWorkflowStepRecords 同一纯函数）
    expect(merged.workflows.get('wf-1')?.agentCalls[0]).toMatchObject({ status: 'done', sessionId: 'sa-1' })
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

// ── 有状态投影（推送喂入 + 冷读集成）─────────────────────────

/** journal 推送报告构造（event-push-channel 契约形态；emittedAt 诊断面固定值）。 */
function journalReport(
  domain: 'run' | 'record',
  fileKey: string,
  events: ReadonlyArray<RecordCreatedEvent | RecordEvent | RecordSettledEvent | Record<string, unknown>>,
): { domain: 'run' | 'record'; fileKey: string; events: SubagentJournalEvent[]; sessionId: string; emittedAt: number } {
  return { domain, fileKey, events: events as SubagentJournalEvent[], sessionId: 's1', emittedAt: 42 }
}

describe('SessionEventProjection（冷启动 + 推送增量 + dispose）', () => {
  let dir: string
  let recordsDir: string
  let runDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp-proj-'))
    recordsDir = join(dir, 'records')
    runDir = join(dir, 'workflow-state')
    mkdirSync(recordsDir, { recursive: true })
    mkdirSync(runDir, { recursive: true })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })


  it('冷启动：attach 全量读两域事件流 → 合并快照（entry 批先行喂 v2 条目）', () => {
    writeFileSync(join(recordsDir, 'sa-1.events'), recordJournalLines('sa-1', [createdEvent('sa-1')]).join('\n') + '\n')
    writeFileSync(
      join(runDir, 'wf-1.record.jsonl'),
      [
        JSON.stringify({ type: 'run-created', runId: 'wf-1', workflowName: 'f', argsSummary: '', ts: 1000 }),
        JSON.stringify({ type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100 }),
      ].join('\n') + '\n',
    )
    const projection = new SessionEventProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: () => {},
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

  it('run journal 推送增量：applyJournalReport 喂入追加帧 → [W2 D7] 单源 fold 推进 → run 投影到终局', async () => {
    writeFileSync(
      join(runDir, 'wf-1.record.jsonl'),
      [
        JSON.stringify({ type: 'run-created', runId: 'wf-1', workflowName: 'f', argsSummary: '', ts: 1000, seq: 1 }),
        JSON.stringify({ type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100, seq: 2 }),
      ].join('\n') + '\n',
    )
    const projection = new SessionEventProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: () => {},
    })
    try {
      projection.applyEntryBatch([workflowRegisteredEntry('wf-1')])
      projection.attach()
      expect(projection.workflows.get('wf-1')).toMatchObject({ runId: 'wf-1', status: 'running' })

      // 写侧落盘追加 + 推送报告喂入（event-push-channel 实时路径：报告只带事件本体，
      // seq 水位连续 → 直接 fold，经 core fold 接续）
      const settledFrame = { type: 'agent-settled', taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 700, ts: 1900, seq: 3 }
      const runSettledFrame = { type: 'run-settled', outcome: 'done', artifactsDir: '/tmp/a', ts: 2000, seq: 4 }
      appendFileSync(
        join(runDir, 'wf-1.record.jsonl'),
        [JSON.stringify(settledFrame), JSON.stringify(runSettledFrame)].join('\n') + '\n',
      )
      expect(projection.applyJournalReport(journalReport('run', 'wf-1', [settledFrame, runSettledFrame]))).toBe(true)
      const record = projection.workflows.get('wf-1')!
      expect(record.status).toBe('done')
      expect(record.outcome).toBe('done')
      expect(record.agentCalls[0]).toMatchObject({ status: 'done', durationMs: 700 })
    } finally {
      projection.dispose()
    }
  })

  it('推送增量：applyJournalReport 喂入追加事件 → fold 推进 → onChange 驱动（投影变更即信号源）', async () => {
    writeFileSync(join(recordsDir, 'sa-1.events'), recordJournalLines('sa-1', [createdEvent('sa-1')]).join('\n') + '\n')
    const onChange = vi.fn()
    const projection = new SessionEventProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: onChange,
    })
    try {
      projection.applyEntryBatch([subagentRegisteredEntry('sa-1')])
      projection.attach()
      expect(projection.subagents.get('sa-1')?.status).toBe('running')
      onChange.mockClear()

      // 写侧落盘追加终态事件 + 推送报告喂入
      appendFileSync(join(recordsDir, 'sa-1.events'), `${recordEventLine(settledRecordEvent())}\n`)
      expect(projection.applyJournalReport(journalReport('record', 'sa-1', [settledRecordEvent()]))).toBe(true)
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
    const projection = new SessionEventProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: () => {},
    })
    try {
      projection.attach()
      expect(projection.subagents.get('sa-1')).toBeDefined() // 坏行跳过不炸投影
      // 重放同 seq 事件（重复投递形态）：状态不回退
      appendFileSync(join(recordsDir, 'sa-1.events'), `${recordEventLine(createdEvent('sa-1'))}\n`)
      expect(projection.applyJournalReport(journalReport('record', 'sa-1', [createdEvent('sa-1')]))).toBe(true)
      const record = projection.subagents.get('sa-1')!
      expect(record.status).toBe('running')
      expect(record.subagentId).toBe('sa-1')
    } finally {
      projection.dispose()
    }
  })

  it('dispose 后停增量（推送喂入不复活投影）', async () => {
    writeFileSync(join(recordsDir, 'sa-1.events'), recordJournalLines('sa-1', [createdEvent('sa-1')]).join('\n') + '\n')
    const projection = new SessionEventProjection({
      sessionId: 's1',
      recordsDir,
      runJournalDir: runDir,
      onProjectionChange: () => {},
    })
    projection.attach()
    projection.dispose()
    appendFileSync(join(recordsDir, 'sa-1.events'), `${recordEventLine(settledRecordEvent())}\n`)
    expect(projection.applyJournalReport(journalReport('record', 'sa-1', [settledRecordEvent()]))).toBe(false)
    expect(projection.subagents.get('sa-1')?.status).toBe('running')
  })
})
