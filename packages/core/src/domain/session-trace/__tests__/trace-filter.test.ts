/**
 * A23 影子化过滤 + 「仅当前 context」toggle + kind chips 分组过滤单测。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { filterTraceRows, TRACE_KIND_GROUPS } from '../trace-filter'
import { mapSessionTraceRows } from '../trace-rows'
import { parseSessionTraceJsonl } from '../parse-jsonl'
import type { TraceRowKind } from '../types'

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
