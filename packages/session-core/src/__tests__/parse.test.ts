import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseSessionContent, parseSessionFile } from '../parse.js'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'session-core-parse-'))
}

describe('parseSessionContent', () => {
  it('解析合法 JSONL：message/custom/session 各 type 产出 canonical Entry', () => {
    const content = [
      JSON.stringify({ type: 'session', id: 'sess-1', cwd: '/tmp/proj', timestamp: '2026-09-20T12:00:00.000Z' }),
      JSON.stringify({
        type: 'message',
        id: '00000001',
        parentId: null,
        timestamp: '2026-09-20T12:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      }),
      JSON.stringify({
        type: 'message',
        id: '00000002',
        parentId: '00000001',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }], toolName: 'bash', toolCallId: 'tc-1' },
      }),
      JSON.stringify({ type: 'custom', id: '00000003', parentId: '00000002', customType: 'subagent-record', data: { id: 'sa-1' } }),
      JSON.stringify({ type: 'compaction', id: '00000004', parentId: '00000003', summary: { firstKeptEntryId: '00000001' } }),
    ].join('\n')

    const result = parseSessionContent(content)

    expect(result.entries).toHaveLength(5)
    expect(result.skippedLines).toBe(0)
    expect(result.lastLinePartial).toBe(false)
    expect(result.totalBytes).toBe(Buffer.byteLength(content, 'utf8'))

    expect(result.entries[0]).toMatchObject({ type: 'session', id: 'sess-1', cwd: '/tmp/proj' })
    expect(result.entries[1]?.message).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] })
    expect(result.entries[2]?.message).toMatchObject({ role: 'toolResult', toolName: 'bash', toolCallId: 'tc-1' })
    expect(result.entries[3]).toMatchObject({ type: 'custom', customType: 'subagent-record', data: { id: 'sa-1' } })
    expect(result.entries[4]).toMatchObject({ type: 'compaction' })
  })

  it('缺 type 或 id 的行、非法 JSON 行计 skippedLines 丢弃不占位', () => {
    const content = [
      JSON.stringify({ type: 'message', id: 'a', message: { role: 'user', content: 'x' } }),
      '{broken json',
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'no id' } }),
      JSON.stringify({ id: 'no type' }),
      JSON.stringify({ type: 'message', id: 'b', message: { role: 'user', content: 'y' } }),
    ].join('\n')

    const result = parseSessionContent(content)

    expect(result.entries.map((e) => e.id)).toEqual(['a', 'b'])
    expect(result.skippedLines).toBe(3)
  })

  it('非法 message role 计坏行（role 收窄失败 → 缺 message 但 id 合法时 entry 保留）', () => {
    const result = parseSessionContent(
      JSON.stringify({ type: 'message', id: 'a', message: { role: 'system', content: 'x' } }),
    )
    // role 非法 → message 字段丢弃，entry 本身（type/id 合法）保留
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.message).toBeUndefined()
    expect(result.skippedLines).toBe(0)
  })

  it('末行半行记 lastLinePartial，区别于中间坏行', () => {
    const partial = `${JSON.stringify({ type: 'message', id: 'a', parentId: null })}\n{"type":"mess`
    const result = parseSessionContent(partial)

    expect(result.entries).toHaveLength(1)
    expect(result.skippedLines).toBe(1)
    expect(result.lastLinePartial).toBe(true)

    const midBroken = `{"type":"mess\n${JSON.stringify({ type: 'message', id: 'a', parentId: null })}\n`
    const result2 = parseSessionContent(midBroken)

    expect(result2.entries).toHaveLength(1)
    expect(result2.skippedLines).toBe(1)
    expect(result2.lastLinePartial).toBe(false)
  })

  it('trailing newline 与中间空行不计 skipped 不计 partial', () => {
    const content = [
      JSON.stringify({ type: 'message', id: 'a', parentId: null }),
      '',
      JSON.stringify({ type: 'message', id: 'b', parentId: 'a' }),
      '',
      '',
    ].join('\n')

    const result = parseSessionContent(content)

    expect(result.entries).toHaveLength(2)
    expect(result.skippedLines).toBe(0)
    expect(result.lastLinePartial).toBe(false)
  })

  it('空文本产出空 ParseResult', () => {
    expect(parseSessionContent('')).toEqual({ entries: [], skippedLines: 0, totalBytes: 0, lastLinePartial: false })
  })
})

describe('parseSessionFile', () => {
  it('读取磁盘 fixture 与 parseSessionContent 结果一致；文件不存在抛原生 ENOENT', async () => {
    const dir = makeTmpDir()
    try {
      const file = join(dir, '2026-09-20T12-00-00-000Z_sess-abc.jsonl')
      const line = { type: 'session', id: 'sess-abc', cwd: '/tmp/proj', timestamp: '2026-09-20T12:00:00.000Z' }
      writeFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')

      const result = await parseSessionFile(file)

      expect(result.entries).toEqual([expect.objectContaining({ type: 'session', id: 'sess-abc' })])
      expect(result.skippedLines).toBe(0)

      await expect(parseSessionFile(join(dir, 'missing.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
