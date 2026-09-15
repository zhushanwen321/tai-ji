/**
 * A22 context 边界计算单测（探针 P4：与 pi buildContextEntries 双边核算）。
 *
 * 双边核算方式：对每个 fixture 用同一 JSONL 文本，经 pi 0.84.1 dist 的
 * parseSessionEntries + getEntries 语义（排除 header）+ buildContextEntries +
 * sessionEntryToContextMessages 得出期望 context 成员集，与 computeTraceContextBoundary
 * 输出逐 id diff 必须为空——这是设计 §探针清单 P4 的机器化形态（同一 JSONL 双边核算，
 * 覆盖无压缩 / 单次 / 多次压缩 / branch_summary 四场景）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildContextEntries,
  parseSessionEntries,
  sessionEntryToContextMessages,
} from '@earendil-works/pi-coding-agent'
import {
  buildTraceSessionPath,
  computeTraceContextBoundary,
  convertsToContextMessages,
} from '../context-boundary'
import { parseSessionTraceJsonl, type ParsedSessionTraceLine } from '../parse-jsonl'
import type { TraceSessionEntry } from '../types'

const FIXTURES = new URL('../__fixtures__/', import.meta.url)

function loadFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8')
}

/** 从 JSONL 文本取「pi getEntries 语义」的 entry 数组（解析成功、排除 header）。 */
function traceEntriesFromText(text: string): TraceSessionEntry[] {
  return parseSessionTraceJsonl(text)
    .filter((l): l is Extract<ParsedSessionTraceLine, { ok: true }> => l.ok && l.entry.type !== 'session')
    .map((l) => l.entry as TraceSessionEntry)
}

/** pi 侧期望：buildContextEntries 输出 ∩ sessionEntryToContextMessages 转换非空 → id 集。 */
function piExpectedContextIds(text: string, leafId?: string): Set<string> {
  const fileEntries = parseSessionEntries(text)
  const entries = fileEntries.filter((e) => e.type !== 'session')
  const ids = new Set<string>()
  for (const entry of buildContextEntries(
    entries as never,
    leafId as never,
  )) {
    if (sessionEntryToContextMessages(entry as never).length > 0 && typeof entry.id === 'string') {
      ids.add(entry.id)
    }
  }
  return ids
}

describe('A22 context 边界计算（buildContextEntries 语义一致，探针 P4 双边核算）', () => {
  const fixtures = [
    'real-mixed-kinds.jsonl', // 无压缩 + 侧支/无 id entry（真实数据）
    'real-lifecycle-small.jsonl', // 无压缩（真实数据）
    'real-fork-header.jsonl', // fork header（真实数据）
    'synthetic-compaction-single.jsonl', // 单次压缩（构造）
    'synthetic-compaction-double.jsonl', // 多次压缩（构造）
    'synthetic-branch-side.jsonl', // branch_summary + 树形侧支（构造）
    'synthetic-full-kinds.jsonl', // 压缩 + 全类型混合（构造）
  ]

  it.each(fixtures)('P4 双边核算（默认 leaf）：%s context 集合与 pi 输出逐 id 一致', (name) => {
    const text = loadFixture(name)
    const entries = traceEntriesFromText(text)
    const mine = computeTraceContextBoundary(entries)
    const expected = piExpectedContextIds(text)
    expect([...mine.contextEntryIds].sort()).toEqual([...expected].sort())
  })

  it.each([
    ['synthetic-full-kinds.jsonl', 'u4'], // leaf 指向链中部（活跃 session 形态）
    ['synthetic-compaction-single.jsonl', 'a2'], // leaf 在 compaction 之前：该 compaction 不在 path
    ['synthetic-branch-side.jsonl', 'a1'], // leaf 在侧支分叉点之前：侧支不在 path
  ])('P4 双边核算（指定 leafId=%s）：%s context 集合与 pi 一致', (name, leafId) => {
    const text = loadFixture(name)
    const entries = traceEntriesFromText(text)
    const mine = computeTraceContextBoundary(entries, leafId)
    const expected = piExpectedContextIds(text, leafId)
    expect([...mine.contextEntryIds].sort()).toEqual([...expected].sort())
  })

  it('单次压缩：context = compaction 自身 + 保留区（firstKept 含）至压缩前 + 压缩后全部', () => {
    // fixture 结构：mc1 u1 a1 u2 mc2 a2 u3 c1(firstKept=mc2) u4 a3
    // 保留区 = [mc2, a2, u3]（firstKept 匹配处起全部保留，含可进与不可进类型）
    const boundary = computeTraceContextBoundary(traceEntriesFromText(loadFixture('synthetic-compaction-single.jsonl')))
    expect([...boundary.contextEntryIds].sort()).toEqual(['a2', 'a3', 'c1', 'u3', 'u4'])
    // 保留区含 lifecycle（mc2 在保留区但不可进 context）
    expect(boundary.contextEntryIds.has('mc2')).toBe(false)
    // lastCompaction 定位
    expect(boundary.lastCompaction).toEqual({ id: 'c1', firstKeptEntryId: 'mc2', indexInPath: 7 })
  })

  it('单次压缩：影子化 = 被压缩的可进类型（lifecycle 不影子化）', () => {
    const boundary = computeTraceContextBoundary(traceEntriesFromText(loadFixture('synthetic-compaction-single.jsonl')))
    expect([...boundary.shadowedEntryIds].sort()).toEqual(['a1', 'u1', 'u2'])
    expect(boundary.shadowedEntryIds.has('mc1')).toBe(false) // model_change 本来就不进
    expect(boundary.shadowedEntryIds.has('a2')).toBe(false) // a2 在保留区（firstKept=mc2 之后）
  })

  it('多次压缩：只有最后一次生效；firstKept 指向旧 compaction 时旧 compaction 进 context', () => {
    // fixture 结构：u0 a0 u1 a1 c1(firstKept=u1) u2 a2 c2(firstKept=c1) u3 a3
    const boundary = computeTraceContextBoundary(traceEntriesFromText(loadFixture('synthetic-compaction-double.jsonl')))
    expect([...boundary.contextEntryIds].sort()).toEqual(['a2', 'a3', 'c1', 'c2', 'u2', 'u3'])
    // u1 曾是 c1 的保留头，二次压缩后（c2.firstKept=c1）影子化
    expect([...boundary.shadowedEntryIds].sort()).toEqual(['a0', 'a1', 'u0', 'u1'])
    expect(boundary.lastCompaction?.id).toBe('c2')
  })

  it('无压缩：全部可进类型进 context，无影子化（真实数据含无 id 侧支 entry）', () => {
    const boundary = computeTraceContextBoundary(traceEntriesFromText(loadFixture('real-mixed-kinds.jsonl')))
    expect(boundary.lastCompaction).toBeNull()
    expect(boundary.shadowedEntryIds.size).toBe(0)
    // 可进类型（message/custom_message）全部进 context；lifecycle/custom 不进
    for (const entry of boundary.path) {
      const capable = convertsToContextMessages(entry)
      if (entry.id !== undefined) {
        expect(boundary.contextEntryIds.has(entry.id)).toBe(capable)
      }
    }
  })

  it('branch_summary 在 leaf 路径上则进 context；树形侧支（不在 path）不进也不影子化', () => {
    const boundary = computeTraceContextBoundary(traceEntriesFromText(loadFixture('synthetic-branch-side.jsonl')))
    expect([...boundary.contextEntryIds].sort()).toEqual(['a1', 'a2', 'bs2', 'u1', 'u2'])
    expect([...boundary.shadowedEntryIds]).toEqual([])
    // 侧支 s1/s2/bs1（挂 a1 下）与 label 不在 path
    const pathIds = boundary.path.map((e) => e.id)
    expect(pathIds).toEqual(['u1', 'a1', 'u2', 'a2', 'bs2'])
  })

  it('leafId=null → 空 path / 空 context（pi 显式空路径语义）', () => {
    const boundary = computeTraceContextBoundary(traceEntriesFromText(loadFixture('synthetic-full-kinds.jsonl')), null)
    expect(boundary.path).toEqual([])
    expect(boundary.contextEntryIds.size).toBe(0)
  })

  it('leafId 未命中 → 尾部 entry fallback（pi 行为）；尾部为 handoff_marker 时 path 仅它自身', () => {
    // full-kinds 尾行是 handoff_marker（无 id/parentId）——pi fallback leaf=entries[last] 的忠实复刻
    const boundary = computeTraceContextBoundary(traceEntriesFromText(loadFixture('synthetic-full-kinds.jsonl')))
    expect(boundary.path.map((e) => e.type)).toEqual(['handoff_marker'])
    expect(boundary.contextEntryIds.size).toBe(0)
    expect(boundary.shadowedEntryIds.size).toBe(0)

    // leafId 指向不存在的 id：同样 fallback 尾部
    const boundaryMiss = computeTraceContextBoundary(traceEntriesFromText(loadFixture('synthetic-full-kinds.jsonl')), 'no-such-id')
    expect(boundaryMiss.path.map((e) => e.type)).toEqual(['handoff_marker'])
  })

  it('firstKeptEntryId 不在 path 中 → context = [compaction] + 压缩后全部（pi 语义）', () => {
    const entries: TraceSessionEntry[] = [
      { type: 'message', id: 'u1', parentId: null, timestamp: 't1', message: { role: 'user', content: 'q' } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: 't2', message: { role: 'assistant', content: [] } },
      {
        type: 'compaction', id: 'c1', parentId: 'a1', timestamp: 't3',
        summary: 's', firstKeptEntryId: 'missing-id', tokensBefore: 1,
      },
      { type: 'message', id: 'u2', parentId: 'c1', timestamp: 't4', message: { role: 'user', content: 'q2' } },
    ]
    const boundary = computeTraceContextBoundary(entries)
    expect([...boundary.contextEntryIds].sort()).toEqual(['c1', 'u2'])
    expect([...boundary.shadowedEntryIds].sort()).toEqual(['a1', 'u1'])
  })

  it('convertsToContextMessages：message/custom_message/compaction 恒进；branch_summary 空 summary 不进；lifecycle 恒不进', () => {
    expect(convertsToContextMessages({ type: 'message', id: 'm', parentId: null, timestamp: 't', message: { role: 'user', content: null } })).toBe(true)
    expect(convertsToContextMessages({ type: 'custom_message', id: 'cm', parentId: null, timestamp: 't', customType: 'x', content: '', display: true })).toBe(true)
    expect(convertsToContextMessages({ type: 'compaction', id: 'c', parentId: null, timestamp: 't', summary: 's', firstKeptEntryId: 'f', tokensBefore: 1 })).toBe(true)
    expect(convertsToContextMessages({ type: 'branch_summary', id: 'b', parentId: null, timestamp: 't', fromId: 'x', summary: '' })).toBe(false)
    expect(convertsToContextMessages({ type: 'branch_summary', id: 'b2', parentId: null, timestamp: 't', fromId: 'x', summary: '有内容' })).toBe(true)
    expect(convertsToContextMessages({ type: 'model_change', id: 'mc', parentId: null, timestamp: 't', provider: 'p', modelId: 'm' })).toBe(false)
    expect(convertsToContextMessages({ type: 'custom', id: 'cd', parentId: null, timestamp: 't', customType: 'demo:data' })).toBe(false)
  })

  it('buildTraceSessionPath：回溯止于首个 falsy parentId；path 为 root→leaf 序', () => {
    const entries = traceEntriesFromText(loadFixture('synthetic-compaction-single.jsonl'))
    expect(buildTraceSessionPath(entries).map((e) => e.id)).toEqual(['mc1', 'u1', 'a1', 'u2', 'mc2', 'a2', 'u3', 'c1', 'u4', 'a3'])
    expect(buildTraceSessionPath(entries, 'u3').map((e) => e.id)).toEqual(['mc1', 'u1', 'a1', 'u2', 'mc2', 'a2', 'u3'])
    expect(buildTraceSessionPath([], undefined)).toEqual([])
  })
})
