import { describe, expect, it } from 'vitest'

import { parseSessionContent } from '../parse.js'
import { serializeSession } from '../serialize.js'
import type { Entry } from '../types.js'

describe('serializeSession', () => {
  it('字节契约：每行 JSON.stringify(entry) + \\n，键序 type,id,parentId,timestamp,message（pi 同构）', () => {
    const entry: Entry = {
      type: 'message',
      id: '0000000a',
      parentId: '00000009',
      timestamp: '2026-09-20T12:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '分析完成' }] },
    }

    // pi appendMessage 构造顺序 {type,id,parentId,timestamp,message} → stringify 逐字节一致
    const out = serializeSession([entry])
    expect(out).toBe(`${JSON.stringify(entry)}\n`)
    expect(out.indexOf('"type"')).toBeLessThan(out.indexOf('"message"'))
  })

  it('多 entry 每行以 \\n 结尾且整串以 \\n 收尾', () => {
    const entries: Entry[] = [
      { type: 'message', id: 'a', parentId: null },
      { type: 'message', id: 'b', parentId: 'a' },
    ]

    const out = serializeSession(entries)

    expect(out.endsWith('\n')).toBe(true)
    expect(out.split('\n')).toHaveLength(3) // 2 行 + 尾换行后的空串
  })

  it('parentId: null 落盘（root 语义）；undefined 可选字段不落盘', () => {
    const entry: Entry = { type: 'message', id: 'a', parentId: null }

    const out = serializeSession([entry])

    expect(out).toContain('"parentId":null')
    expect(out).not.toContain('"timestamp":')
    expect(out).not.toContain('"message":')
  })

  it('roundtrip：parseSessionContent(serializeSession(entries)) 恢复等价 entries', () => {
    const entries: Entry[] = [
      {
        type: 'session',
        id: 'sess-1',
        parentId: null,
        timestamp: '2026-09-20T12:00:00.000Z',
        cwd: '/tmp/proj',
        parentSession: 'sess-0',
      },
      {
        type: 'message',
        id: '00000001',
        parentId: null,
        timestamp: '2026-09-20T12:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      { type: 'custom', id: '00000002', parentId: '00000001', customType: 'zcode-import:compaction', data: { count: 1 } },
    ]

    const parsed = parseSessionContent(serializeSession(entries))

    expect(parsed.entries).toEqual(entries)
    expect(parsed.skippedLines).toBe(0)
    expect(parsed.lastLinePartial).toBe(false)
  })
})
