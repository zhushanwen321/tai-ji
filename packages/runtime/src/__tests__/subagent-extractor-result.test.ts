/**
 * subagent-extractor 轮终 result 投影（review findings-confirmation #8）。
 *
 * 锁定：自描述 subagent-record entry（W16 v1）的 data.result 字段被投影到
 * SubagentRecord.result——它是 running-resumable 的轮终信号（v4 轮终迁移写点
 * reportRecordTransition 携带，轮终恒写非空），renderer hasRunning 据此排除
 * 「已轮终仍 running」的 record（不算 working）。缺失/类型异常时 undefined
 * （legacy W16 前旧 session entry 无此字段，running 仍按真在跑判定）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/subagent-extractor-result.test.ts
 */
import { describe, it, expect } from 'vitest'
import { scanSubagentEntries } from '../services/session/subagent-extractor'

/** 自描述 subagent-record entry（W16 v1，对齐 extensions record-entry.ts schema）。 */
function recordEntry(id: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `e-${id}`,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 1,
      id,
      agent: 'worker',
      task: 'Do work',
      slug: 'work',
      status: 'running',
      startedAt: 1000,
      ...data,
    },
  }
}

describe('scanSubagentEntries · 轮终 result 投影（running-resumable 轮终信号）', () => {
  it('entry data.result 有值 → SubagentRecord.result 投影（轮终回写 running 的信号随行）', () => {
    const records = scanSubagentEntries([
      recordEntry('bg-1', { status: 'running', result: '本轮产出正文' }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('running')
    expect(records[0].result).toBe('本轮产出正文')
  })

  it('同 id 后到覆盖：轮终迁移 entry（running + result）覆盖启动期 entry（running 无 result）', () => {
    const records = scanSubagentEntries([
      recordEntry('bg-1', { result: undefined }),
      // 轮终迁移写点：同 id 后到，携带本轮 result（含占位形态）
      recordEntry('bg-1', { result: '(no output this round)' }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0].result).toBe('(no output this round)')
  })

  it('entry 无 result 字段 / 类型异常 → undefined（首轮在跑 / legacy 语义：running 仍算真在跑）', () => {
    const records = scanSubagentEntries([
      recordEntry('bg-2', {}),
      recordEntry('bg-3', { result: 123 }),
    ])
    expect(records).toHaveLength(2)
    expect(records.find((r) => r.subagentId === 'bg-2')?.result).toBeUndefined()
    expect(records.find((r) => r.subagentId === 'bg-3')?.result).toBeUndefined()
  })
})
