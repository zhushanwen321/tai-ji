/**
 * workflow-extractor [P3/D6] 投影消费测试——快照 additive 字段（calls[] 合并、
 * run 级 health/outcome/errorCode）+ additive 读缺省渲染路径。
 *
 * 锁定的语义：
 * - 新写侧快照（含新字段）：scanWorkflowEntries 消费 calls[].lastProgressAt（按 id
 *   合并进 agentCalls）、state.health / state.outcome / state.errorCode（值级守卫后透传）；
 * - 旧快照（无新字段，存量 v2 形态）：缺省渲染不炸——lastProgressAt/health/outcome/
 *   errorCode 全 undefined，record 主体字段照常投影（历史 run 不消失）；
 * - 字段漂移守卫：health 非对象 / lastProgressAt 非有限数 / outcome 词表外 /
 *   calls 条目坏形 → 该字段缺省或该项跳过，run 投影不炸（坏项隔离到项级）；
 * - 三态直读不受影响：trace 节点 status 原样透传（不做词表转换）。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/services/session/__tests__/workflow-extractor-projection.test.ts
 */
import { describe, it, expect } from 'vitest'

import { scanWorkflowEntries } from '../workflow-extractor.js'
import type { WorkflowRunRecord } from '@taiji/shared'

/** 最小 v2 快照（存量形态：无任何新字段——旧快照缺省渲染的基线样本）。 */
function legacySnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 'wf-run-v2',
    runId: 'wf-proj-1',
    spec: { scriptName: 'test-flow', slug: 'tf' },
    state: {
      status: 'running',
      budget: { usedTokens: 10, usedCost: 0.1 },
      calls: [],
      trace: [
        { stepIndex: 0, agent: 'dev', status: 'running', startedAt: '2026-09-21T00:00:00Z' },
        { stepIndex: 1, agent: 'reviewer', status: 'completed', completedAt: '2026-09-21T00:01:00Z' },
      ],
    },
    meta: { startedAt: '2026-09-21T00:00:00Z' },
    ...overrides,
  }
}

/** 自描述 workflow-record entry（W17 v1：{v:1, snapshot, updatedAt}）。 */
function recordEntry(snapshot: unknown): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'workflow-record',
    id: 'entry-1',
    parentId: null,
    timestamp: '2026-09-21T00:00:02Z',
    data: { v: 1, snapshot, updatedAt: '2026-09-21T00:00:02Z' },
  }
}

function scanSingle(snapshot: unknown): WorkflowRunRecord {
  const records = scanWorkflowEntries([recordEntry(snapshot)])
  expect(records).toHaveLength(1)
  return records[0]!
}

describe('workflow-extractor [P3/D6] additive 投影消费', () => {
  it('新快照：calls[].lastProgressAt 按 id 合并进 agentCalls，health/outcome/errorCode 透传', () => {
    const snapshot = legacySnapshot({
      state: {
        status: 'running',
        budget: { usedTokens: 10, usedCost: 0.1 },
        calls: [
          { id: 0, status: 'running', attempts: 1, startedAt: 1000, lastProgressAt: 5000 },
          { id: 1, status: 'done', attempts: 2, startedAt: 1000, lastProgressAt: 4000 },
          { junk: true },
        ],
        health: { lastProgressAt: 5000 },
        trace: [
          { stepIndex: 0, agent: 'dev', status: 'running', startedAt: '2026-09-21T00:00:00Z' },
          { stepIndex: 1, agent: 'reviewer', status: 'completed', completedAt: '2026-09-21T00:01:00Z' },
        ],
      },
    })
    const record = scanSingle(snapshot)

    expect(record.agentCalls[0]!.lastProgressAt).toBe(5000)
    expect(record.agentCalls[1]!.lastProgressAt).toBe(4000)
    // calls 条目与 trace 节点按 id（stepIndex）关联——id 错位的坏项只丢进度字段
    expect(record.health).toEqual({ lastProgressAt: 5000 })
    // 三态直读：trace status 原样透传
    expect(record.agentCalls.map((c) => c.status)).toEqual(['running', 'completed'])
  })

  it('终局投影：outcome/errorCode（failed + engine_crashed）进入 record', () => {
    const snapshot = legacySnapshot({
      state: {
        status: 'done',
        reason: 'failed',
        budget: { usedTokens: 10, usedCost: 0.1 },
        calls: [{ id: 0, status: 'done', attempts: 1, lastProgressAt: 9000 }],
        health: { lastProgressAt: 9000 },
        outcome: 'failed',
        errorCode: 'engine_crashed',
        trace: [{ stepIndex: 0, agent: 'dev', status: 'failed', error: 'boom' }],
      },
    })
    const record = scanSingle(snapshot)
    expect(record.outcome).toBe('failed')
    expect(record.errorCode).toBe('engine_crashed')
    expect(record.health).toEqual({ lastProgressAt: 9000 })
  })

  it('旧快照（无新字段）：缺省渲染不炸，record 主体照常投影（历史 run 不消失）', () => {
    const record = scanSingle(legacySnapshot())
    expect(record.runId).toBe('wf-proj-1')
    expect(record.scriptName).toBe('test-flow')
    expect(record.status).toBe('running')
    expect(record.agentCalls).toHaveLength(2)
    expect(record.agentCalls[0]!.lastProgressAt).toBeUndefined()
    expect(record.health).toBeUndefined()
    expect(record.outcome).toBeUndefined()
    expect(record.errorCode).toBeUndefined()
  })

  it('字段漂移守卫：health 坏形 / lastProgressAt 非数 / outcome 词表外 → 缺省不炸', () => {
    const record = scanSingle(legacySnapshot({
      state: {
        status: 'running',
        budget: { usedTokens: 10, usedCost: 0.1 },
        calls: [{ id: 0, lastProgressAt: 'not-a-number' }],
        health: { nope: true },
        outcome: 'exploded',
        errorCode: 42,
        trace: [{ stepIndex: 0, agent: 'dev', status: 'running' }],
      },
    }))
    expect(record.health).toBeUndefined()
    expect(record.outcome).toBeUndefined()
    expect(record.errorCode).toBeUndefined()
    expect(record.agentCalls[0]!.lastProgressAt).toBeUndefined()
    expect(record.agentCalls[0]!.agent).toBe('dev')
  })

  it('calls 整体坏形（非数组）→ 全体缺省，run 投影不炸', () => {
    const record = scanSingle(legacySnapshot({
      state: {
        status: 'running',
        budget: { usedTokens: 10, usedCost: 0.1 },
        calls: 'garbage',
        trace: [{ stepIndex: 0, agent: 'dev', status: 'running' }],
      },
    }))
    expect(record.agentCalls[0]!.lastProgressAt).toBeUndefined()
    expect(record.runId).toBe('wf-proj-1')
  })
})
