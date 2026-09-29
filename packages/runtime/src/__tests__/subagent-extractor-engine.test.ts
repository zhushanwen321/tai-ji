/**
 * subagent-extractor engine 字段投影（v2 条目对：engine/engineHandle 只在终态条目上）。
 *
 * 背景（v1 全量快照条目兼容层已随「项目未上线、无 v1 数据」删除）：scanSubagentEntries
 * 只认 v2 条目对——每个 id = 一条 registered（身份）+ 可选一条 settled（终局）。
 * engine / engineHandle 是终态条目的字段（v2 schema 见 core record-entry.ts），投影层
 * 逐字透传（不做形状/值守卫）；engineFallback 无 v2 载体（v1 专有字段），投影恒不产出。
 * 缺省=pi 由读侧 extractRecordEngine 映射，投影层不填默认值。
 *
 * 锁定：
 * - 终态条目 engine/engineHandle 逐项投影（sessionRef 键不枚举整体透传）
 * - engineHandle 无 journalPath → 该键缺席（可选字段）
 * - 仅注册条目（未终态）→ engine/engineHandle 均 undefined，status=running
 * - 投影产物喂读侧 extractRecordEngine：缺省/空串 → 'pi'，非空透传（读写两侧对齐）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/subagent-extractor-engine.test.ts
 */
import { describe, it, expect } from 'vitest'
import { scanSubagentEntries } from '../services/session/subagent-extractor'
import { extractRecordEngine } from '../services/session/subagent-engine-history'

/** v2 注册条目（身份；engine 系字段不在此条目上——v2 schema 归属终态条目）。 */
function registeredEntry(id: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `e-${id}-reg`,
    parentId: null,
    timestamp: '2026-08-25T00:00:00Z',
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
      ...data,
    },
  }
}

/** v2 终态条目（终局 + 摘要 + 引擎绑定；engine/engineHandle 的唯一载体）。 */
function settledEntry(id: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `e-${id}-set`,
    parentId: null,
    timestamp: '2026-08-25T00:01:00Z',
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

describe('scanSubagentEntries · engine/engineHandle 投影（v2：终态条目承载）', () => {
  it('终态条目完整形态 → engine/engineHandle 逐项投影（sessionRef 键不枚举整体透传）', () => {
    const records = scanSubagentEntries([
      registeredEntry('sa-1'),
      settledEntry('sa-1', {
        engine: 'zcode',
        engineHandle: {
          sessionRef: { sessionId: 's-1', dbPath: 'pool/zcode.db' },
          journalPath: '/abs/engines/zcode/p1/journal.jsonl',
          poolKey: 'p1',
        },
      }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0].engine).toBe('zcode')
    expect(records[0].engineHandle).toEqual({
      sessionRef: { sessionId: 's-1', dbPath: 'pool/zcode.db' },
      journalPath: '/abs/engines/zcode/p1/journal.jsonl',
      poolKey: 'p1',
    })
  })

  it('终态条目 engineHandle 无 journalPath → 投影省略该键（可选字段）', () => {
    const records = scanSubagentEntries([
      registeredEntry('sa-2'),
      settledEntry('sa-2', {
        engine: 'zcode',
        engineHandle: { sessionRef: { sessionId: 's-2' }, poolKey: 'p2' },
      }),
    ])
    expect(records[0].engineHandle).toEqual({ sessionRef: { sessionId: 's-2' }, poolKey: 'p2' })
    expect(records[0].engineHandle?.journalPath).toBeUndefined()
  })

  it('仅注册条目（未终态）→ engine/engineHandle 均 undefined（绑定只随终态条目落盘）', () => {
    const records = scanSubagentEntries([registeredEntry('sa-3')])
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('running')
    expect(records[0].engine).toBeUndefined()
    expect(records[0].engineHandle).toBeUndefined()
  })

  it('终态条目无 engine 系字段 → engine/engineHandle 均 undefined（投影层不填默认值）', () => {
    const records = scanSubagentEntries([registeredEntry('sa-4'), settledEntry('sa-4')])
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('idle')
    expect(records[0].engine).toBeUndefined()
    expect(records[0].engineHandle).toBeUndefined()
  })
})

describe('投影产物 ↔ 读侧 extractRecordEngine 对齐（subagent-engine-history 兼容）', () => {
  it('无终态条目（无 engine）投影 → 读侧缺省映射 pi', () => {
    const [record] = scanSubagentEntries([registeredEntry('sa-20')])
    expect(extractRecordEngine(record)).toBe('pi')
  })

  it('终态条目 engine 空串（投影逐字透传）→ 读侧归一 pi（缺省判定在读侧）', () => {
    const [record] = scanSubagentEntries([
      registeredEntry('sa-21'),
      settledEntry('sa-21', { engine: '' }),
    ])
    expect(record.engine).toBe('')
    expect(extractRecordEngine(record)).toBe('pi')
  })

  it('非空 engine 投影 → 读侧透传（zcode 路由可达）', () => {
    const [record] = scanSubagentEntries([
      registeredEntry('sa-22'),
      settledEntry('sa-22', { engine: 'zcode' }),
    ])
    expect(extractRecordEngine(record)).toBe('zcode')
  })
})
