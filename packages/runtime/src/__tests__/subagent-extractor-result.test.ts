/**
 * subagent-extractor 终局 result 投影（v2 条目对）。
 *
 * 锁定：result 是 v2 终态条目（settled）的字段——终局结果全文一次性写（事件文件只存
 * 摘要锚，本条目是全文唯一落点），投影层逐字透传（subagent-core record-entry.ts
 * SubagentRecordSettledEntryData.result）。终态条目在场即 status 归一 idle（两态词表：
 * 终局收敛 idle + stopReason 表达「为什么停」）；无 result 字段 → undefined
 * （settled 条目未携带 / 未终态）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/subagent-extractor-result.test.ts
 */
import { describe, it, expect } from 'vitest'
import { scanSubagentEntries } from '../services/session/subagent-extractor'

/** v2 注册条目（身份）。 */
function registeredEntry(id: string): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `e-${id}-reg`,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      id,
      agent: 'worker',
      task: 'Do work',
      slug: 'work',
      origin: 'tool',
      rootSessionId: 'root-1',
      depth: 0,
      startedAt: 1000,
    },
  }
}

/** v2 终态条目（result 的唯一载体；同 id 多次补写时后到覆盖）。 */
function settledEntry(id: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `e-${id}-set`,
    parentId: null,
    timestamp: '2026-08-19T00:00:01Z',
    data: {
      v: 2,
      kind: 'settled',
      id,
      status: 'idle',
      stopReason: 'completed',
      endedAt: 2000,
      turns: 1,
      totalTokens: 10,
      model: 'test-model',
      thinkingLevel: 'low',
      ...data,
    },
  }
}

describe('scanSubagentEntries · 终局 result 投影（v2 终态条目）', () => {
  it('终态条目 result 有值 → SubagentRecord.result 投影（status 归一 idle）', () => {
    const records = scanSubagentEntries([
      registeredEntry('bg-1'),
      settledEntry('bg-1', { result: '本轮产出正文' }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('idle')
    expect(records[0].result).toBe('本轮产出正文')
  })

  it('同 id 后到的终态条目覆盖先到的：result 以最后一条为准（收编幂等补写语义）', () => {
    const records = scanSubagentEntries([
      registeredEntry('bg-1'),
      settledEntry('bg-1', { result: '(no output this round)' }),
      settledEntry('bg-1', { result: '补写的终局正文' }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0].result).toBe('补写的终局正文')
  })

  it('无 result 字段 → undefined（未终态 / 终态条目未携带全文）', () => {
    const records = scanSubagentEntries([
      registeredEntry('bg-2'),
      registeredEntry('bg-3'),
      settledEntry('bg-3'),
    ])
    expect(records).toHaveLength(2)
    expect(records.find((r) => r.subagentId === 'bg-2')?.result).toBeUndefined()
    expect(records.find((r) => r.subagentId === 'bg-3')?.result).toBeUndefined()
  })
})
