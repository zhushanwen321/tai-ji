import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionContent, parseSessionFile, type Entry } from '@zhushanwen/session-core'

/** 构造单行 JSONL entry 字符串 */
function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
}

describe('parseSessionContent', () => {
  it('正常多类型 entry 全解析，字段完整保留', () => {
    const content = [
      line({ type: 'session', id: 's1', parentId: null, timestamp: 't0', cwd: '/x', parentSession: '/p.jsonl', version: 3 }),
      line({ type: 'message', id: 'm1', parentId: 's1', timestamp: 't1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [{ name: 'bash', args: {} }] } }),
      line({ type: 'compaction', id: 'c1', parentId: 'm2', timestamp: 't3', summary: { kept: 5 }, firstKeptEntryId: 'm1' }),
      line({ type: 'custom', id: 'u1', parentId: 'c1', timestamp: 't4', customType: 'subagent-identity', data: { slug: 'fix' } }),
    ].join('\n')

    const result = parseSessionContent(content)

    expect(result.skippedLines).toBe(0)
    expect(result.lastLinePartial).toBe(false)
    expect(result.entries).toHaveLength(5)

    const [s, u, a, c, custom] = result.entries

    // session header：cwd/parentSession 保留；接口未列的 version 不暴露
    expect(s.type).toBe('session')
    expect(s.id).toBe('s1')
    expect(s.parentId).toBeNull()
    expect(s.cwd).toBe('/x')
    expect(s.parentSession).toBe('/p.jsonl')
    expect((s as Entry).version).toBeUndefined()

    // user message
    expect(u.type).toBe('message')
    expect(u.id).toBe('m1')
    expect(u.parentId).toBe('s1')
    expect(u.message?.role).toBe('user')
    expect(u.message?.content).toEqual([{ type: 'text', text: 'hi' }])

    // assistant message + toolCalls
    expect(a.message?.role).toBe('assistant')
    expect(a.message?.toolCalls).toEqual([{ name: 'bash', args: {} }])

    // compaction summary
    expect(c.type).toBe('compaction')
    expect(c.summary).toEqual({ kept: 5 })

    // custom
    expect(custom.type).toBe('custom')
    expect(custom.customType).toBe('subagent-identity')
    expect(custom.data).toEqual({ slug: 'fix' })
  })

  it('中间夹坏行：skippedLines 正确，坏行前后 entry 保留', () => {
    const content = [
      line({ type: 'message', id: 'a', parentId: null }),
      'THIS IS NOT JSON {{{',
      line({ type: 'message', id: 'b', parentId: 'a' }),
    ].join('\n')

    const result = parseSessionContent(content)

    expect(result.entries).toHaveLength(2)
    expect(result.entries[0].id).toBe('a')
    expect(result.entries[1].id).toBe('b')
    expect(result.skippedLines).toBe(1)
    // 最后一行解析成功 → 非 partial
    expect(result.lastLinePartial).toBe(false)
  })

  it('空字符串：entries 为空，skippedLines=0，非 partial', () => {
    const result = parseSessionContent('')

    expect(result.entries).toEqual([])
    expect(result.skippedLines).toBe(0)
    expect(result.lastLinePartial).toBe(false)
    expect(result.totalBytes).toBe(0)
  })

  it('末尾换行不产生幽灵行（不计 skipped/partial）', () => {
    const content = line({ type: 'message', id: 'a', parentId: null }) + '\n'
    const result = parseSessionContent(content)

    expect(result.entries).toHaveLength(1)
    expect(result.skippedLines).toBe(0)
    expect(result.lastLinePartial).toBe(false)
  })

  it('最后一行是半 JSON：lastLinePartial=true，仍计入 skippedLines', () => {
    const content =
      line({ type: 'message', id: 'a', parentId: null }) + '\n' + '{"type":"message","id":"x"'
    const result = parseSessionContent(content)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].id).toBe('a')
    expect(result.skippedLines).toBe(1)
    expect(result.lastLinePartial).toBe(true)
  })

  it('JSON 合法但缺必填结构字段（type/id）视为坏行', () => {
    const content = [
      line({ type: 'message', id: 'ok', parentId: null }),
      line({ foo: 'bar' }), // 缺 type/id
      '{"id":"no_type"}', // 缺 type
    ].join('\n')

    const result = parseSessionContent(content)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].id).toBe('ok')
    expect(result.skippedLines).toBe(2)
    // 最后那条坏行也是最后一行 → partial
    expect(result.lastLinePartial).toBe(true)
  })

  it('custom entry 无顶层 id → 坏行跳过（W4：data.id fallback 死分支已删，pi appendCustomEntry 恒写顶层 id）', () => {
    // pi appendCustomEntry 恒写顶层 id（session-manager.js:820-828）；data.id 是扩展
    // 业务字段而非 entry id。无顶层 id 的行按坏行跳过（skippedLines++）。
    const content = [
      line({ type: 'custom', customType: 'ok-entry', id: 'top-level-id', data: {} }),
      line({
        type: 'custom',
        customType: 'subagent-identity',
        data: { id: 'sa-abc123', rootSessionId: 'sess-1', slug: 'fix' },
      }),
    ].join('\n')
    const result = parseSessionContent(content)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].id).toBe('top-level-id')
    expect(result.skippedLines).toBe(1)
  })

  it('session header 无 parentId → 归一化为 null（root 判定）', () => {
    const content = '{"type":"session","id":"root","timestamp":"t"}'
    const result = parseSessionContent(content)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].parentId).toBeNull()
  })

  it('message 缺/非法 role → 丢弃 message 字段但保留 entry', () => {
    const content = [
      line({ type: 'message', id: 'm1', parentId: null, message: { role: 'system', content: 'x' } }),
      line({ type: 'message', id: 'm2', parentId: null, message: { content: 'x' } }),
    ].join('\n')

    const result = parseSessionContent(content)

    expect(result.entries).toHaveLength(2)
    expect(result.entries[0].message).toBeUndefined()
    expect(result.entries[1].message).toBeUndefined()
  })
})

describe('parseSessionFile', () => {
  it('磁盘文件全量解析：entries 数 = 行数 / 0 skipped / 非 partial / totalBytes 与内容一致', async () => {
    // mkdtemp 自建自删的 fixture 文件（不读本机真实数据目录）：session header +
    // 10 条链式 message 的最小行集，验证「文件读取 → 逐行解析」回路的完整性与计数字段
    const dir = await mkdtemp(join(tmpdir(), 'parser-file-'))
    try {
      const lines = [
        line({ type: 'session', id: 's1', parentId: null, cwd: '/x' }),
        ...Array.from({ length: 10 }, (_, i) =>
          line({
            type: 'message',
            id: `m${i}`,
            parentId: i === 0 ? 's1' : `m${i - 1}`,
            message: {
              role: i % 2 === 0 ? 'user' : 'assistant',
              content: [{ type: 'text', text: `text ${i}` }],
            },
          }),
        ),
      ]
      const content = lines.join('\n') + '\n'
      const path = join(dir, 'fixture-session.jsonl')
      await writeFile(path, content)

      const result = await parseSessionFile(path)

      expect(result.entries).toHaveLength(11)
      expect(result.skippedLines).toBe(0)
      expect(result.lastLinePartial).toBe(false)
      expect(result.totalBytes).toBe(Buffer.byteLength(content, 'utf8'))
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
