// shared SubagentRecord 契约面测试（U8 / 永久会话模型 §3.2.8；[U6] 两态收窄重写）：
//   - SUBAGENT_STATUS_ALL 全集 = 两态（B3 编译锁的运行时镜像——编译锁拦「联合扩值
//     漏改元组」，本测试拦「元组值域与联合语义漂移」的回归方向）；
//   - projectSubagentExecutionStatus 两态直投恒等（legacy 六值的兼容投影已上移至
//     runtime normalizeSubagentStatus 解析边界归一，U6/D5——renderer 永不见 legacy 值）；
//   - deriveClosedDisplay 既有三分色不回归（U6 起消费方迁至 runtime 归一层，作为
//     closed → stopReason 派生映射的推导器）；
//   - [W1 / D1] subagent-record v2 条目契约镜像（注册/终态两条小条目）：shared 侧
//     形状断言 + JSON round-trip——core 侧权威定义（record-entry.ts）与 shared 镜像
//     的同构漂移由本测试 + core record-entry-collect.test.ts 双侧互证把守。

import { describe, expect, it } from 'vitest'

import {
  SUBAGENT_RECORD_ENTRY_KINDS,
  SUBAGENT_STATUS_ALL,
  deriveClosedDisplay,
  projectSubagentExecutionStatus,
  type SubagentRecordEntryV2,
  type SubagentRecordRegisteredEntry,
  type SubagentRecordSettledEntry,
  type SubagentStatus,
} from '../subagent'

describe('SUBAGENT_STATUS_ALL 全集（B3 运行时镜像）', () => {
  it('两态收窄终态：全集恰为 running + idle（legacy 值已从类型面删除，U6）', () => {
    expect(SUBAGENT_STATUS_ALL).toEqual(['running', 'idle'])
  })

  it('全集无重复', () => {
    expect(new Set(SUBAGENT_STATUS_ALL).size).toBe(SUBAGENT_STATUS_ALL.length)
  })
})

describe('projectSubagentExecutionStatus（[U6] 两态直投恒等）', () => {
  it('running → running（唯一「正在跑」形态）', () => {
    expect(projectSubagentExecutionStatus('running')).toBe('running')
  })

  it('idle → idle（不复活 spinner / 活跃计数）', () => {
    expect(projectSubagentExecutionStatus('idle')).toBe('idle')
  })

  it('全集覆盖矩阵：SUBAGENT_STATUS_ALL 每值映射后必为两态之一', () => {
    for (const status of SUBAGENT_STATUS_ALL) {
      const mapped = projectSubagentExecutionStatus(status)
      expect(mapped === 'running' || mapped === 'idle', status).toBe(true)
    }
  })

  it('类型面：SubagentStatus 两态词表外无成员（编译期收窄的运行时镜像断言）', () => {
    const all: readonly SubagentStatus[] = ['running', 'idle']
    expect(all).toEqual([...SUBAGENT_STATUS_ALL])
  })
})

describe('deriveClosedDisplay（legacy 终态三分色，扩值不回归）', () => {
  it('cancelled 优先 / gc+error → failed / 其余 → done', () => {
    expect(deriveClosedDisplay({ closedReason: 'cancelled', error: 'boom' })).toBe('cancelled')
    expect(deriveClosedDisplay({ closedReason: 'gc', error: 'boom' })).toBe('failed')
    expect(deriveClosedDisplay({ closedReason: 'gc' })).toBe('done')
    expect(deriveClosedDisplay({})).toBe('done')
  })
})

describe('[W1 / D1] subagent-record v2 条目契约镜像（注册/终态两条小条目）', () => {
  it('kind 词表恰为 registered/settled（每实体两条——v1 全量快照为兼容读面）', () => {
    expect([...SUBAGENT_RECORD_ENTRY_KINDS]).toEqual(['registered', 'settled'])
  })

  it('注册条目：v=2 + kind 判别 + 身份域字段（JSON round-trip 可选字段自然缺省）', () => {
    const entry: SubagentRecordRegisteredEntry = {
      v: 2,
      kind: 'registered',
      id: 'sa-1',
      agent: 'worker',
      task: 'fix the flaky test',
      slug: 'worker',
      origin: 'workflow',
      parentRunId: 'wf-1',
      stepIndex: 0,
      rootSessionId: 'root-A',
      depth: 1,
      startedAt: 1780000000000,
    }
    const revived = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>
    expect(revived).toMatchObject({ v: 2, kind: 'registered', id: 'sa-1', origin: 'workflow' })
    expect('parentRecordId' in revived).toBe(false)
  })

  it('终态条目：status 恒 idle + stopReason + 统计终值 + engineHandle 锚链载荷 + result 全文', () => {
    const entry: SubagentRecordSettledEntry = {
      v: 2,
      kind: 'settled',
      id: 'sa-1',
      status: 'idle',
      stopReason: 'completed',
      outcome: 'completed',
      endedAt: 1780000123000,
      turns: 3,
      totalTokens: 4500,
      model: 'prov/m1',
      engine: 'zcode',
      engineHandle: { sessionRef: { sessionId: 's-1', dbPath: '/tmp/db.sqlite' }, poolKey: 'shared' },
      sessionFile: '/tmp/sessions/sa-1.jsonl',
      result: 'done: 3 tests fixed',
    }
    const revived = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>
    expect(revived.status).toBe('idle')
    expect(revived.stopReason).toBe('completed')
    expect(revived.result).toBe('done: 3 tests fixed')
    expect(revived.engineHandle).toEqual({
      sessionRef: { sessionId: 's-1', dbPath: '/tmp/db.sqlite' },
      poolKey: 'shared',
    })
  })

  it('判别联合窄化面：kind 收窄后两分支字段各自可达（消费方解码路径形态锚）', () => {
    const entries: SubagentRecordEntryV2[] = [
      { v: 2, kind: 'registered', id: 'sa-1', agent: 'a', task: 't', slug: 's', origin: 'tool', rootSessionId: 'r', depth: 0, startedAt: 1 },
      { v: 2, kind: 'settled', id: 'sa-1', status: 'idle', stopReason: 'completed', endedAt: 2, turns: 0, totalTokens: 0 },
    ]
    const kinds = entries.map((e) => (e.kind === 'registered' ? e.origin : e.stopReason))
    expect(kinds).toEqual(['tool', 'completed'])
  })
})
