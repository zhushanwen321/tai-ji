import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { computeTraceContextBoundary } from '../context-boundary'
import { parseSessionTraceJsonl } from '../parse-jsonl'
import { filterTraceRows } from '../trace-filter'
import { mapSessionTraceRows } from '../trace-rows'

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
