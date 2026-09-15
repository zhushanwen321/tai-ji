/**
 * subagent-engine-history 薄调用冒烟测试（dual-track-convergence D1）。
 *
 * 读取链本体（三级降级编排 + journal 重放 + 投影 + registry 分发）的守护测试在
 * core 侧 session-view-service.test.ts（降级链三分支 / 投影 parity / registry 分发 /
 * message_end error 记账）。本文件只断言 runtime 薄层的路由段契约：
 * - pi record → []（A1 守护：pi 历史走调用方 JSONL 直读链）
 * - 非 pi record 缺 handle → core 编排层防御式降级③级（结构兼容 shared Message）
 * - extractRecordEngine 路由判定（缺省 pi / 非空透传）
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SUBAGENT_ENGINE,
  extractRecordEngine,
  readEngineSubagentHistory,
} from '../services/session/subagent-engine-history.js'
import type { SubagentRecord } from '@taiji/shared'

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: 'sub-1',
    sessionFile: null,
    agent: 'general-purpose',
    slug: '',
    task: 'do the thing',
    status: 'running',
    startedAt: 1_000,
    ...overrides,
  } as SubagentRecord
}

describe('extractRecordEngine（record 路由段）', () => {
  it('engine 缺失 / 非 string / 空串 → 缺省 pi（存量 record 零迁移）', () => {
    expect(extractRecordEngine(makeRecord())).toBe(DEFAULT_SUBAGENT_ENGINE)
    expect(extractRecordEngine(makeRecord({ engine: '' } as Partial<SubagentRecord>))).toBe('pi')
    expect(
      extractRecordEngine(makeRecord({ engine: 1 } as unknown as Partial<SubagentRecord>)),
    ).toBe('pi')
  })

  it('非空 string 透传', () => {
    expect(extractRecordEngine(makeRecord({ engine: 'zcode' } as Partial<SubagentRecord>))).toBe(
      'zcode',
    )
  })
})

describe('readEngineSubagentHistory（薄调用 core 单一实现）', () => {
  it('pi record → []（pi 历史不走本链，调用方走 JSONL 直读）', async () => {
    expect(await readEngineSubagentHistory(makeRecord(), '/tmp')).toEqual([])
  })

  it('zcode record 缺 engineHandle → ③级 outcome-only（永不空数组，结构兼容 Message）', async () => {
    const messages = await readEngineSubagentHistory(
      makeRecord({
        engine: 'zcode',
        result: 'final answer',
        endedAt: 2_000,
      } as Partial<SubagentRecord>),
      '/tmp',
    )
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'do the thing',
      status: 'complete',
      timestamp: 1_000,
    })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'final answer',
      status: 'complete',
      timestamp: 2_000,
    })
  })

  it('未来引擎（无 reader 注册）→ ③级保底，不抛崩溃', async () => {
    const messages = await readEngineSubagentHistory(
      makeRecord({ engine: 'kimi', error: 'boom' } as Partial<SubagentRecord>),
      '/tmp',
    )
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({ content: 'boom', status: 'error', error: 'boom' })
  })
})
