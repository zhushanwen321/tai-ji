import { describe, it, expect } from 'vitest'
import { segmentTurns } from '../core/turns.js'
import type { Entry } from '../core/parser.js'
import { parseSessionFile } from '../core/parser.js'
import { buildTreeView } from '../core/tree.js'
import { REAL_SESSION, HAS_REAL_SESSION } from './real-data.js'

// ---- Entry 构造助手（turns.ts 只消费 type/id/parentId/message.role） ----

function msg(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant' | 'toolResult',
): Entry {
  return { type: 'message', id, parentId, message: { role, content: '' } }
}

function entry(id: string, parentId: string | null, type: string): Entry {
  return { type, id, parentId }
}

describe('segmentTurns', () => {
  it('1. user 开 turn，后续 assistant/toolResult 并入同一 turn', () => {
    const entries = [msg('U', null, 'user'), msg('A', 'U', 'assistant'), msg('T', 'A', 'toolResult')]
    const turns = segmentTurns(entries, new Set(['U', 'A', 'T']))

    expect(turns).toHaveLength(1)
    expect(turns[0].index).toBe(0)
    expect(turns[0].isCompaction).toBe(false)
    expect(turns[0].userEntry?.id).toBe('U')
    expect(turns[0].entries.map((e) => e.id)).toEqual(['U', 'A', 'T'])
  })

  it('2. compaction 开新 turn（isCompaction=true，无 userEntry），后续 user 又开一个 turn', () => {
    const entries = [
      msg('U', null, 'user'),
      msg('A', 'U', 'assistant'),
      entry('C', 'A', 'compaction'),
      msg('U2', 'C', 'user'),
    ]
    const turns = segmentTurns(entries, new Set(['U', 'A', 'C', 'U2']))

    expect(turns).toHaveLength(3)
    // turn 0：user + assistant
    expect(turns[0].userEntry?.id).toBe('U')
    expect(turns[0].isCompaction).toBe(false)
    expect(turns[0].entries.map((e) => e.id)).toEqual(['U', 'A'])
    // turn 1：compaction 独立成 turn
    expect(turns[1].isCompaction).toBe(true)
    expect(turns[1].userEntry).toBeUndefined()
    expect(turns[1].entries.map((e) => e.id)).toEqual(['C'])
    // turn 2：新 user
    expect(turns[2].userEntry?.id).toBe('U2')
    expect(turns[2].isCompaction).toBe(false)
  })

  it('3. model_change / thinking_level_change / custom 并入当前 turn', () => {
    const entries = [
      msg('U', null, 'user'),
      entry('M', 'U', 'model_change'),
      entry('T', 'M', 'thinking_level_change'),
      entry('X', 'T', 'custom'),
    ]
    const turns = segmentTurns(entries, new Set(['U', 'M', 'T', 'X']))

    expect(turns).toHaveLength(1)
    expect(turns[0].userEntry?.id).toBe('U')
    expect(turns[0].entries.map((e) => e.id)).toEqual(['U', 'M', 'T', 'X'])
  })

  it('4. branch entry（不在 leafSet）不计入', () => {
    const entries = [
      msg('U', null, 'user'),
      msg('A', 'U', 'assistant'),
      msg('B1', 'U', 'assistant'), // 旁支：不在 leafSet
      msg('B2', 'B1', 'toolResult'), // 旁支子节点
    ]
    const turns = segmentTurns(entries, new Set(['U', 'A']))

    expect(turns).toHaveLength(1)
    expect(turns[0].entries.map((e) => e.id)).toEqual(['U', 'A'])
  })

  it('5. 孤儿 assistant（首个 entry 是 assistant 无前置 user）→ 并入 turn 0（preface）', () => {
    const entries = [msg('O', null, 'assistant'), msg('U', 'O', 'user')]
    const turns = segmentTurns(entries, new Set(['O', 'U']))

    expect(turns).toHaveLength(2)
    // turn 0：preface（孤儿 assistant），无 userEntry，非 compaction
    expect(turns[0].isCompaction).toBe(false)
    expect(turns[0].userEntry).toBeUndefined()
    expect(turns[0].entries.map((e) => e.id)).toEqual(['O'])
    // turn 1：首个 user
    expect(turns[1].userEntry?.id).toBe('U')
    expect(turns[1].index).toBe(1)
  })

  it('6. session header 被忽略（即使在 leafSet 中也不计 turn）', () => {
    const entries = [
      entry('S', null, 'session'),
      msg('U', 'S', 'user'),
      msg('A', 'U', 'assistant'),
    ]
    // S 也在 leafSet，验证规则 1 优先于规则 5
    const turns = segmentTurns(entries, new Set(['S', 'U', 'A']))

    expect(turns).toHaveLength(1)
    expect(turns[0].entries.map((e) => e.id)).toEqual(['U', 'A'])
  })

  it('7. 空 entries → []', () => {
    expect(segmentTurns([], new Set())).toEqual([])
  })

  it('startTime 取 turn 首条 entry 的 timestamp', () => {
    const entries = [
      { ...msg('U', null, 'user'), timestamp: '2026-05-28T03:17:12.844Z' },
      msg('A', 'U', 'assistant'),
    ]
    const turns = segmentTurns(entries, new Set(['U', 'A']))
    expect(turns[0].startTime).toBe('2026-05-28T03:17:12.844Z')
  })

  it.skipIf(!HAS_REAL_SESSION)('真实 019e6c96：leaf 视图分段（26 user + 5 compaction + 1 前置 = 32 turn）', async () => {
    // 注：design P-outline / plan T1.3 基线为 26（仅数 user 的旧定义）。
    // 本实现按冻结接口 Turn.isCompaction + design §3.5 算法 3 规则 2（compaction 独立成 turn）
    // + 规则 4（首 user 前的 model_change/thinking_level_change 成 preface turn），
    // 真实数据为 32 turn。26 基线早于 compaction-split 细化，详见交接说明。
    const parsed = await parseSessionFile(REAL_SESSION)
    const tree = buildTreeView(parsed.entries)
    const turns = segmentTurns(parsed.entries, new Set(tree.leafPath))

    expect(turns.length).toBe(32)
    // 首个 turn 是 preface（model_change/thinking_level_change），无 userEntry
    expect(turns[0].userEntry).toBeUndefined()
    expect(turns[0].isCompaction).toBe(false)
    // 其中有 5 个 compaction turn
    expect(turns.filter((t) => t.isCompaction).length).toBe(5)
    // 其中有 26 个 user turn
    expect(turns.filter((t) => t.userEntry !== undefined).length).toBe(26)
    // 5.6MB 全量解析在并发/高负载下可能超 vitest 默认 5s，显式放宽
  }, 60000)
})
