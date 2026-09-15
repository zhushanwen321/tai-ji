/**
 * subagent-extractor engine 三字段投影（U1：engine/engineFallback/engineHandle
 * 从 extension entry 贯通到 shared SubagentRecord）。
 *
 * 锁定：
 * - 完整形态逐字段投影正确（sessionRef 键不枚举整体透传）
 * - 旧 entry（W16 v1 无 engine 系字段）→ 三字段均 undefined（存量零回归；
 *   缺省=pi 由读侧 extractRecordEngine 映射，投影层不填默认值）
 * - engineHandle 坏形状三例（poolKey 缺失 / sessionRef 含非 string 值 / 非 plain
 *   object）→ 该字段不投影且不抛
 * - engineFallback 坏形状（非 plain object / from 非 string）→ 该字段不投影
 * - engine 空串不投影（读侧缺省判定语义在 extractRecordEngine）
 * - 投影产物喂读侧 extractRecordEngine：缺省 → 'pi'，非空透传（读写两侧对齐）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/subagent-extractor-engine.test.ts
 */
import { describe, it, expect } from 'vitest'
import { scanSubagentEntries } from '../services/session/subagent-extractor'
import { extractRecordEngine } from '../services/session/subagent-engine-history'

/** 自描述 subagent-record entry（W16 v1，对齐 extensions record-entry.ts schema）。 */
function recordEntry(id: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `e-${id}`,
    parentId: null,
    timestamp: '2026-08-25T00:00:00Z',
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

describe('scanSubagentEntries · engine 三字段投影（U1）', () => {
  it('完整形态 → 三字段逐项投影（sessionRef 键不枚举整体透传）', () => {
    const records = scanSubagentEntries([
      recordEntry('sa-1', {
        engine: 'zcode',
        engineFallback: { from: 'zcode', reason: 'engine_probe_failed' },
        engineHandle: {
          sessionRef: { sessionId: 's-1', dbPath: 'pool/zcode.db' },
          journalPath: '/abs/engines/zcode/p1/journal.jsonl',
          poolKey: 'p1',
        },
      }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0].engine).toBe('zcode')
    expect(records[0].engineFallback).toEqual({ from: 'zcode', reason: 'engine_probe_failed' })
    expect(records[0].engineHandle).toEqual({
      sessionRef: { sessionId: 's-1', dbPath: 'pool/zcode.db' },
      journalPath: '/abs/engines/zcode/p1/journal.jsonl',
      poolKey: 'p1',
    })
  })

  it('engineHandle 无 journalPath → 投影省略该键（可选字段）', () => {
    const records = scanSubagentEntries([
      recordEntry('sa-2', {
        engine: 'zcode',
        engineHandle: { sessionRef: { sessionId: 's-2' }, poolKey: 'p2' },
      }),
    ])
    expect(records[0].engineHandle).toEqual({ sessionRef: { sessionId: 's-2' }, poolKey: 'p2' })
    expect(records[0].engineHandle?.journalPath).toBeUndefined()
  })

  it('旧 entry 无 engine 系字段 → 三字段均 undefined（存量零回归，投影层不填默认值）', () => {
    const records = scanSubagentEntries([recordEntry('sa-3', {})])
    expect(records).toHaveLength(1)
    expect(records[0].engine).toBeUndefined()
    expect(records[0].engineFallback).toBeUndefined()
    expect(records[0].engineHandle).toBeUndefined()
  })

  it('engine 空串 / 非 string → 不投影（缺省判定在读侧 extractRecordEngine）', () => {
    const records = scanSubagentEntries([
      recordEntry('sa-4', { engine: '' }),
      recordEntry('sa-5', { engine: 42 }),
    ])
    expect(records[0].engine).toBeUndefined()
    expect(records[1].engine).toBeUndefined()
  })

  it('engineFallback 坏形状 → 该字段不投影且不抛', () => {
    const records = scanSubagentEntries([
      recordEntry('sa-6', { engineFallback: 'oops' }),
      recordEntry('sa-7', { engineFallback: { from: 'zcode', reason: 1 } }),
      recordEntry('sa-8', { engineFallback: [1, 2] }),
    ])
    for (const r of records) expect(r.engineFallback).toBeUndefined()
  })

  it('engineHandle poolKey 缺失/空串 → 整个字段不投影且不抛', () => {
    const records = scanSubagentEntries([
      recordEntry('sa-9', { engineHandle: { sessionRef: { sessionId: 's' } } }),
      recordEntry('sa-10', { engineHandle: { sessionRef: {}, poolKey: '' } }),
      recordEntry('sa-11', { engineHandle: { sessionRef: {}, poolKey: 7 } }),
    ])
    for (const r of records) expect(r.engineHandle).toBeUndefined()
  })

  it('engineHandle sessionRef 含非 string 值 → 整个字段不投影且不抛', () => {
    const records = scanSubagentEntries([
      recordEntry('sa-12', {
        engineHandle: { sessionRef: { sessionId: 's', dbPath: 3 }, poolKey: 'p' },
      }),
    ])
    expect(records[0].engineHandle).toBeUndefined()
  })

  it('engineHandle 非 plain object（string/array/null）→ 字段不投影且不抛', () => {
    const records = scanSubagentEntries([
      recordEntry('sa-13', { engineHandle: 'nope' }),
      recordEntry('sa-14', { engineHandle: [] }),
      recordEntry('sa-15', { engineHandle: null }),
    ])
    for (const r of records) expect(r.engineHandle).toBeUndefined()
  })
})

describe('投影产物 ↔ 读侧 extractRecordEngine 对齐（subagent-engine-history 兼容）', () => {
  it('旧 entry（无 engine）投影 → 读侧缺省映射 pi（存量零迁移）', () => {
    const [record] = scanSubagentEntries([recordEntry('sa-20', {})])
    expect(extractRecordEngine(record)).toBe('pi')
  })

  it('空串 engine 不投影 → 读侧同样映射 pi（读写守卫语义对齐）', () => {
    const [record] = scanSubagentEntries([recordEntry('sa-21', { engine: '' })])
    expect(extractRecordEngine(record)).toBe('pi')
  })

  it('非空 engine 投影 → 读侧透传（zcode 路由可达）', () => {
    const [record] = scanSubagentEntries([recordEntry('sa-22', { engine: 'zcode' })])
    expect(extractRecordEngine(record)).toBe('zcode')
  })
})
