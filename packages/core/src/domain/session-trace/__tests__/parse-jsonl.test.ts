// parse-jsonl.test.ts —— core C16 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/session-trace/parse-jsonl.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/session-trace/__tests__/context-boundary.test.ts（20 用例，skip 0）
//   - src/domain/session-trace/__tests__/trace-filter.test.ts（11 用例，skip 0）
//   - src/domain/session-trace/__tests__/trace-root-smoke.test.ts（1 用例，skip 0）
//   - src/domain/session-trace/__tests__/trace-rows.test.ts（10 用例，skip 0）

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildContextEntries, parseSessionEntries, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent'
import { buildTraceSessionPath, computeTraceContextBoundary, convertsToContextMessages } from '../context-boundary'
import { parseSessionTraceJsonl, type ParsedSessionTraceLine } from '../parse-jsonl'
import { type TraceSessionEntry, type TraceRowKind, type TraceFileEntry } from '../types'
import { filterTraceRows, TRACE_KIND_GROUPS } from '../trace-filter'
import { mapSessionTraceRows, resolveTraceRowKind, SYSTEM_PROMPT_CUSTOM_TYPE } from '../trace-rows'

// ======== 来源：context-boundary.test.ts ========
describe("context-boundary", () => {
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
});

// ======== 来源：trace-filter.test.ts ========
describe("trace-filter", () => {
  const FIXTURES = new URL('../__fixtures__/', import.meta.url)

  function rowsOf(name: string, opts: { sessionEnd?: boolean; leafId?: string } = {}) {
    const text = readFileSync(new URL(name, FIXTURES), 'utf8')
    const sessionEnd = opts.sessionEnd
      ? (JSON.parse(readFileSync(new URL(`${name}.meta.json`, FIXTURES), 'utf8')) as {
          type: 'session_end'
          outcome: 'done' | 'error' | 'stopped'
          reason?: string
          timestamp?: string
        })
      : undefined
    return mapSessionTraceRows({ lines: parseSessionTraceJsonl(text), sessionEnd, leafId: opts.leafId })
  }

  describe('A23 影子化标记与过滤（仅当前 context toggle + kind chips 分组）', () => {
    it('TRACE_KIND_GROUPS SSOT：5 组并集恰为 12 种 kind，无重叠，MALFORMED 不属任何组', () => {
      const all = Object.values(TRACE_KIND_GROUPS).flat()
      expect(new Set(all).size).toBe(all.length) // 无重叠
      expect([...new Set(all)].sort()).toEqual(
        ([
          'ASSISTANT', 'BASH', 'BOUNDARY', 'BRANCH', 'COMPACTED', 'DATA',
          'LIFECYCLE', 'NOTICE', 'SESSION', 'SYSTEM', 'TOOL', 'USER',
        ] as TraceRowKind[]).sort(),
      )
      expect(all).not.toContain('MALFORMED')
      // 分组定义（§3.4 末段映射）
      expect(TRACE_KIND_GROUPS.messages).toEqual(['USER', 'ASSISTANT'])
      expect(TRACE_KIND_GROUPS.tools).toEqual(['TOOL', 'BASH'])
      expect(TRACE_KIND_GROUPS.system).toEqual(['SYSTEM', 'NOTICE', 'COMPACTED', 'BRANCH'])
      expect(TRACE_KIND_GROUPS.lifecycle).toEqual(['LIFECYCLE'])
      expect(TRACE_KIND_GROUPS.boundaries).toEqual(['SESSION', 'DATA', 'BOUNDARY'])
    })

    it('默认态（无过滤）：全量行返回，包括 MALFORMED 与 sidecar 行', () => {
      const rows = rowsOf('synthetic-full-kinds.jsonl', { sessionEnd: true, leafId: 'u4' })
      const filtered = filterTraceRows(rows, {})
      expect(filtered).toHaveLength(rows.length)
      expect(filtered.some((r) => r.kind === 'MALFORMED')).toBe(false) // 该 fixture 无坏行
      const bad = rowsOf('real-lifecycle-small.bad-lines.jsonl')
      expect(filterTraceRows(bad).some((r) => r.kind === 'MALFORMED')).toBe(true)
    })

    it('contextOnly：只剩当前 context 成员（影子化 + 不进 context 的 kind 全隐藏）', () => {
      const rows = rowsOf('synthetic-full-kinds.jsonl', { sessionEnd: true, leafId: 'u4' })
      const filtered = filterTraceRows(rows, { contextOnly: true })
      // leafId=u4 时 context = {c1, u2, bs1, u3, u4}
      expect(filtered.map((r) => r.key).sort()).toEqual(['bs1', 'c1', 'u2', 'u3', 'u4'])
      expect(filtered.every((r) => r.inContext)).toBe(true)
      // SYSTEM/LIFECYCLE/DATA/SESSION/BOUNDARY（含 sidecar）与影子化消息全部隐藏
      expect(filtered.some((r) => r.kind === 'SESSION' || r.kind === 'SYSTEM' || r.kind === 'LIFECYCLE' || r.kind === 'DATA')).toBe(false)
      expect(filtered.some((r) => r.source === 'sidecar')).toBe(false)
    })

    it('contextOnly：无压缩 session（真实数据）= 全部可进类型的行', () => {
      const rows = rowsOf('real-mixed-kinds.jsonl')
      const filtered = filterTraceRows(rows, { contextOnly: true })
      // 无压缩：message/custom_message 进 context（65+2=67），lifecycle/custom/header 不进
      expect(filtered).toHaveLength(67)
      expect(filtered.every((r) => ['USER', 'ASSISTANT', 'TOOL', 'NOTICE'].includes(r.kind))).toBe(true)
    })

    it('kind chips 单组：messages → 仅 USER/ASSISTANT', () => {
      const rows = rowsOf('synthetic-full-kinds.jsonl', { leafId: 'u4' })
      const filtered = filterTraceRows(rows, { activeGroups: ['messages'] })
      expect(new Set(filtered.map((r) => r.kind))).toEqual(new Set(['USER', 'ASSISTANT']))
      expect(filtered).toHaveLength(5) // u1 a1 u2 u3 u4
    })

    it('kind chips 单组：system → SYSTEM/NOTICE/COMPACTED/BRANCH；lifecycle → LIFECYCLE；boundaries → SESSION/DATA/BOUNDARY', () => {
      const rows = rowsOf('synthetic-full-kinds.jsonl', { sessionEnd: true, leafId: 'u4' })
      expect(new Set(filterTraceRows(rows, { activeGroups: ['system'] }).map((r) => r.kind))).toEqual(
        new Set(['SYSTEM', 'NOTICE', 'COMPACTED', 'BRANCH']),
      )
      expect(new Set(filterTraceRows(rows, { activeGroups: ['lifecycle'] }).map((r) => r.kind))).toEqual(
        new Set(['LIFECYCLE']),
      )
      expect(new Set(filterTraceRows(rows, { activeGroups: ['boundaries'] }).map((r) => r.kind))).toEqual(
        new Set(['SESSION', 'DATA', 'BOUNDARY']),
      )
    })

    it('kind chips 多组并集：messages + tools + boundaries', () => {
      const rows = rowsOf('synthetic-full-kinds.jsonl', { sessionEnd: true, leafId: 'u4' })
      const filtered = filterTraceRows(rows, { activeGroups: ['messages', 'tools', 'boundaries'] })
      const kinds = new Set(filtered.map((r) => r.kind))
      expect(kinds).toEqual(new Set(['USER', 'ASSISTANT', 'TOOL', 'BASH', 'SESSION', 'DATA', 'BOUNDARY']))
    })

    it('chips 激活时 MALFORMED 隐藏（白名单语义）；空 chips = 全部（损坏行不静默丢失）', () => {
      const rows = rowsOf('real-lifecycle-small.bad-lines.jsonl')
      expect(filterTraceRows(rows, { activeGroups: ['messages'] }).some((r) => r.kind === 'MALFORMED')).toBe(false)
      expect(filterTraceRows(rows).some((r) => r.kind === 'MALFORMED')).toBe(true)
    })

    it('组合：contextOnly + chips → 交集过滤（「当前 context 里的消息」）', () => {
      const rows = rowsOf('synthetic-compaction-single.jsonl')
      // 默认 leaf（a3）：context = {c1, a2, u3, u4, a3}（保留区 firstKept=mc2 含之后的 a2/u3）
      const filtered = filterTraceRows(rows, { contextOnly: true, activeGroups: ['messages'] })
      expect(filtered.map((r) => r.key).sort()).toEqual(['a2', 'a3', 'u3', 'u4'])
      // system 组 ∩ contextOnly = 仅 COMPACTED（c1）
      const sysFiltered = filterTraceRows(rows, { contextOnly: true, activeGroups: ['system'] })
      expect(sysFiltered.map((r) => r.key)).toEqual(['c1'])
    })

    it('过滤不改输入（纯函数）：原数组保持全量', () => {
      const rows = rowsOf('synthetic-compaction-single.jsonl')
      const before = rows.length
      filterTraceRows(rows, { contextOnly: true, activeGroups: ['messages'] })
      expect(rows).toHaveLength(before)
    })

    it('两次压缩场景：contextOnly 只剩最后一次压缩决定的成员', () => {
      const rows = rowsOf('synthetic-compaction-double.jsonl')
      const filtered = filterTraceRows(rows, { contextOnly: true })
      // context = {c2, c1, u2, a2, u3, a3}；影子化 u0/a0/u1/a1 隐藏
      expect(filtered.map((r) => r.key).sort()).toEqual(['a2', 'a3', 'c1', 'c2', 'u2', 'u3'])
    })
  })
});

// ======== 来源：trace-root-smoke.test.ts ========
describe("trace-root-smoke", () => {
  const FIXTURES = new URL('../__fixtures__/', import.meta.url)

  /**
 * session-trace 跨模块烟雾：parse → row 映射 → 边界计算 → 过滤在真实 fixture 上走通（深度覆盖归 A 系列）。
 */
  describe('session-trace root smoke', () => {
    it('parse→rows→boundary→filter 全链在真实 fixture 上走通', () => {
      const text = readFileSync(new URL('real-mixed-kinds.jsonl', FIXTURES), 'utf-8')
      const lines = parseSessionTraceJsonl(text)
      const entries = lines.flatMap((l) => (l.ok ? [l.entry] : []))
      expect(entries.length).toBeGreaterThan(50)
      const rows = mapSessionTraceRows({ lines })
      expect(rows.length).toBeGreaterThan(0)
      const boundary = computeTraceContextBoundary(entries as unknown as Parameters<typeof computeTraceContextBoundary>[0])
      expect(boundary.contextEntryIds.size + boundary.shadowedEntryIds.size).toBeGreaterThan(0)
      const visible = filterTraceRows(rows, { contextOnly: true })
      expect(visible.length).toBeGreaterThan(0)
      for (const r of visible) {
        // TraceRow.entry 联合含 session_end meta（无 id）——收窄后取 id
        const id = r.entry && 'id' in r.entry ? r.entry.id : undefined
        if (id) expect(boundary.shadowedEntryIds.has(id)).toBe(false)
      }
    })

  })
});

// ======== 来源：trace-rows.test.ts ========
describe("trace-rows", () => {
  const FIXTURES = new URL('../__fixtures__/', import.meta.url)

  function loadRows(name: string, opts: { sessionEnd?: boolean; leafId?: string } = {}) {
    const text = readFileSync(new URL(name, FIXTURES), 'utf8')
    const sessionEnd = opts.sessionEnd
      ? (JSON.parse(readFileSync(new URL(`${name}.meta.json`, FIXTURES), 'utf8')) as {
          type: 'session_end'
          outcome: 'done' | 'error' | 'stopped'
          reason?: string
          timestamp?: string
        })
      : undefined
    return mapSessionTraceRows({ lines: parseSessionTraceJsonl(text), sessionEnd, leafId: opts.leafId })
  }

  function rowBySeq(rows: ReturnType<typeof loadRows>, seq: number) {
    return rows.find((r) => r.seq === seq)
  }

  describe('A21 entry→TraceRow kind 映射（12 kind 全覆盖 + 损坏行占位）', () => {
    it('synthetic-full-kinds：12 种 kind 全出现且逐行映射正确（含 leafId 下的 inContext/shadowed）', () => {
      const rows = loadRows('synthetic-full-kinds.jsonl', { sessionEnd: true, leafId: 'u4' })

      const kindSeq = rows.map((r) => `${r.seq}:${r.kind}`).join(' ')
      // 19 行 JSONL（含 handoff_marker 尾行）+ 1 行 sidecar = 20 行条目清单
      expect(rows).toHaveLength(20)
      expect(kindSeq).toBe(
        [
          '1:SESSION', '2:SYSTEM', '3:LIFECYCLE', '4:LIFECYCLE', '5:USER', '6:ASSISTANT',
          '7:TOOL', '8:BASH', '9:NOTICE', '10:NOTICE', '11:USER', '12:COMPACTED', '13:BRANCH',
          '14:USER', '15:LIFECYCLE', '16:LIFECYCLE', '17:DATA', '18:USER', '19:BOUNDARY', '20:BOUNDARY',
        ].join(' '),
      )

      // 12 kind 全出现（sidecar 行补齐 BOUNDARY）
      const kinds = new Set(rows.map((r) => r.kind))
      for (const kind of [
        'SESSION', 'SYSTEM', 'USER', 'ASSISTANT', 'TOOL', 'BASH',
        'NOTICE', 'COMPACTED', 'BRANCH', 'LIFECYCLE', 'DATA', 'BOUNDARY',
      ] as const) {
        expect(kinds.has(kind), `kind ${kind} 应出现`).toBe(true)
      }

      // context 边界标注：leafId=u4，压缩点 c1 firstKept=u2
      // inContext = {c1, u2, bs1, u3, u4}；shadowed = 可进类型且在压缩区 {u1, a1, tr1, b1, cm1, mcx1}
      const inContextKeys = rows.filter((r) => r.inContext).map((r) => r.key).sort()
      expect(inContextKeys).toEqual(['bs1', 'c1', 'u2', 'u3', 'u4'])
      const shadowedKeys = rows.filter((r) => r.shadowed).map((r) => r.key).sort()
      expect(shadowedKeys).toEqual(['a1', 'b1', 'cm1', 'mcx1', 'tr1', 'u1'])
      // 不可进类型（SYSTEM/DATA/LIFECYCLE/SESSION）不影子化
      expect(rowBySeq(rows, 2)?.shadowed).toBe(false) // SYSTEM
      expect(rowBySeq(rows, 17)?.shadowed).toBe(false) // DATA
    })

    it('synthetic-full-kinds：行摘要数据提取（headline/meta 关键字段）', () => {
      const rows = loadRows('synthetic-full-kinds.jsonl', { leafId: 'u4' })
      expect(rowBySeq(rows, 1)?.meta.parentSession).toBe('/Users/dev/work/demo/older-session.jsonl')
      expect(rowBySeq(rows, 1)?.meta.forkEntryId).toBe('a-old')
      expect(rowBySeq(rows, 2)?.headline).toBe('system prompt v2')
      expect(rowBySeq(rows, 2)?.meta.reason).toBe('resume')
      expect(rowBySeq(rows, 6)?.meta.model).toBe('demo-model')
      expect(rowBySeq(rows, 6)?.meta.toolCalls).toBe(1)
      expect(rowBySeq(rows, 6)?.meta.thinkingBlocks).toBe(1)
      // usage 标量（fixture 该行 usage 只有 input/output；缺省字段不进 meta）
      expect(rowBySeq(rows, 6)?.meta.inputTokens).toBe(100)
      expect(rowBySeq(rows, 6)?.meta.outputTokens).toBe(50)
      expect(rowBySeq(rows, 6)?.meta.cacheReadTokens).toBeUndefined()
      expect(rowBySeq(rows, 7)?.meta.toolName).toBe('read')
      expect(rowBySeq(rows, 7)?.meta.isError).toBe(false)
      expect(rowBySeq(rows, 8)?.headline).toBe('npm test')
      expect(rowBySeq(rows, 8)?.meta.exitCode).toBe(0)
      expect(rowBySeq(rows, 12)?.meta.tokensBefore).toBe(99999)
      expect(rowBySeq(rows, 12)?.meta.firstKeptEntryId).toBe('u2')
      expect(rowBySeq(rows, 15)?.meta.name).toBe('demo-session')
      expect(rowBySeq(rows, 16)?.meta.label).toBe('检查点')
    })

    it('custom_message 与 message(role=custom) 两种 NOTICE 形态均可渲染（display 保留在 meta）', () => {
      const rows = loadRows('synthetic-full-kinds.jsonl', { leafId: 'u4' })
      const noticeRows = rows.filter((r) => r.kind === 'NOTICE')
      expect(noticeRows.map((r) => r.key)).toEqual(['cm1', 'mcx1'])
      expect(rowBySeq(rows, 9)?.meta.display).toBe(true)
      expect(rowBySeq(rows, 10)?.meta.customType).toBe('demo:msg-role')
    })

    it('损坏行：占位可见、行号与原文保留、seq 连续、其余行不受影响', () => {
      const rows = loadRows('real-lifecycle-small.bad-lines.jsonl')
      // 源 10 行 + 注入 2 行 = 12 行条目清单，seq 连续
      expect(rows).toHaveLength(12)
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))

      const malformed = rows.filter((r) => r.kind === 'MALFORMED')
      expect(malformed.map((r) => r.lineNumber)).toEqual([3, 8])
      expect(malformed[0]?.raw).toBe('{"type": "message", "id": "broken-truncat')
      expect(malformed[1]?.raw).toBe('not a json line at all')
      expect(malformed.every((r) => r.entry === undefined && r.inContext === false && r.shadowed === false)).toBe(true)
      // 损坏行不吞掉邻居：第 4 行仍是正常 entry
      expect(rowBySeq(rows, 4)?.kind).not.toBe('MALFORMED')
    })

    it('sidecar session_end：追加尾部 BOUNDARY 行（source=sidecar，outcome/reason 进 meta）', () => {
      const rows = loadRows('synthetic-full-kinds.jsonl', { sessionEnd: true, leafId: 'u4' })
      const last = rows[rows.length - 1]
      expect(last.kind).toBe('BOUNDARY')
      expect(last.source).toBe('sidecar')
      expect(last.key).toBe('sidecar:session_end')
      expect(last.meta.outcome).toBe('done')
      expect(last.lineNumber).toBeUndefined()
    })

    it('handoff_marker（JSONL 行，无 id）：BOUNDARY 行可见，handedOffTo 进 meta', () => {
      const rows = loadRows('synthetic-full-kinds.jsonl', { leafId: 'u4' })
      const handoff = rows.find((r) => r.kind === 'BOUNDARY' && r.source === 'jsonl')
      expect(handoff?.key).toBe('line:19')
      expect(handoff?.meta.handedOffTo).toBe('s-next-session')
      expect(handoff?.inContext).toBe(false)
    })

    it('real-mixed-kinds（真实脱敏数据）：kind 分布与源文件 entry 类型分布一致', () => {
      const rows = loadRows('real-mixed-kinds.jsonl')
      const count = (kind: string) => rows.filter((r) => r.kind === kind).length
      // 源分布：session 1 / message:user 3 / assistant 28 / toolResult 34 / custom 44 /
      // custom_message 2 / model_change 2 / thinking_level_change 2 / session_info 8
      expect(count('SESSION')).toBe(1)
      expect(count('USER')).toBe(3)
      expect(count('ASSISTANT')).toBe(28)
      expect(count('TOOL')).toBe(34)
      expect(count('DATA')).toBe(44)
      expect(count('NOTICE')).toBe(2)
      expect(count('LIFECYCLE')).toBe(12) // model_change 2 + thinking_level_change 2 + session_info 8
      expect(rows).toHaveLength(124)
    })

    it('real-fork-header：SESSION 行 parentSession（sessionId fallback 形态）与 forkEntryId 可见', () => {
      const rows = loadRows('real-fork-header.jsonl')
      expect(rows[0]?.kind).toBe('SESSION')
      expect(rows[0]?.meta.parentSession).toBe('s-fork-src')
      expect(rows[0]?.meta.forkEntryId).toBe('a1')
    })

    it('real-mixed-kinds：完整 usage（cacheRead + cost.total）标量进 meta + 输入侧合计', () => {
      const rows = loadRows('real-mixed-kinds.jsonl')
      const row = rows.find((r) => r.key === 'cd0cdf60')
      expect(row?.kind).toBe('ASSISTANT')
      expect(row?.meta.inputTokens).toBe(43549)
      expect(row?.meta.outputTokens).toBe(70)
      expect(row?.meta.cacheReadTokens).toBe(512)
      expect(row?.meta.cacheWriteTokens).toBe(0)
      // 互斥桶合计（pi-ai 归一化语义）：43549 + 512 + 0
      expect(row?.meta.inputTotal).toBe(44061)
      expect(row?.meta.reasoningTokens).toBe(9)
      expect(row?.meta.costTotal).toBe(0)
    })

    it('resolveTraceRowKind 单点映射（含未知类型兜底不丢失）', () => {
      expect(resolveTraceRowKind({ type: 'session', version: 3 } as TraceFileEntry)).toBe('SESSION')
      expect(
        resolveTraceRowKind({ type: 'custom', id: 'x', parentId: null, timestamp: 't', customType: SYSTEM_PROMPT_CUSTOM_TYPE }),
      ).toBe('SYSTEM')
      expect(resolveTraceRowKind({ type: 'custom', id: 'x', parentId: null, timestamp: 't', customType: 'other' })).toBe('DATA')
      expect(
        resolveTraceRowKind({ type: 'message', id: 'x', parentId: null, timestamp: 't', message: { role: 'bashExecution' } }),
      ).toBe('BASH')
      // pi 未来新增 entry 类型：DATA 兜底（G1 不丢失）
      expect(resolveTraceRowKind({ type: 'future_entry', id: 'x', parentId: null, timestamp: 't' })).toBe('DATA')
    })
  })
});
