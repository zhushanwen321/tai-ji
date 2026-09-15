/**
 * W1 红灯测试：jsonl.ts 尾读工具（readTail / readTailEntries）。
 *
 * 对应 FR-tail-read 的基础设施层（AC-tail-1/4/5）：
 * - readTailEntries：用 openSync+readSync 从 offset=max(0,size-NKB) 读尾部，
 *   丢首行残行（offset≠0 时），返回解析出的 entry 数组。
 *
 * [红灯说明] readTail / readTailEntries / READ_TAIL_BYTES 尚未实现 → import 失败 → 红灯。
 * 实现后（W1 dev）应转绿。
 *
 * 运行：cd packages/runtime && npx vitest run test/jsonl-tail.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// 以下 import 在 W1 实现前会失败（符号不存在）→ 红灯
import { readTailEntries, READ_TAIL_BYTES } from '../src/utils/jsonl.js'

describe('W1 jsonl readTailEntries', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-tail-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 造一个 JSONL 文件，entries 为对象数组，逐行 JSON.stringify + \n 连接 */
  function makeFile(entries: object[]): string {
    const path = join(tmpDir, `test-${Math.random().toString(36).slice(2)}.jsonl`)
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
    return path
  }

  it('AC-tail-1: 尾窗内的 entry 被正确解析返回', () => {
    // 文件远小于 READ_TAIL_BYTES（32KB），offset=0 读全文件
    const entries = [
      { type: 'session', id: 's1' },
      { type: 'message', role: 'user' },
      { type: 'session_info', name: '尾部名字' },
    ]
    const path = makeFile(entries)
    const result = readTailEntries(path)
    if (!result) throw new Error('readTailEntries returned null')
    // offset=0 时无残行丢弃，全部 entry 返回
    expect(result).toHaveLength(3)
    expect(result[2]).toEqual({ type: 'session_info', name: '尾部名字' })
  })

  it('AC-tail-4: offset≠0 时首行残行被丢弃（含多字节 UTF-8 切断）', () => {
    // 构造文件 > READ_TAIL_BYTES，使 offset 落在中间某行
    // 用一个超长首行撑过 32KB，尾部放目标 entry
    const longLine = { type: 'padding', data: 'x'.repeat(READ_TAIL_BYTES + 1000) }
    const tailEntry = { type: 'session_end', outcome: 'done' as const }
    const path = makeFile([longLine, tailEntry])
    const result = readTailEntries(path)
    if (!result) throw new Error('readTailEntries returned null')
    // 首行残行（padding 被切断的部分）必须被丢弃，不参与 parse
    // 只返回完整的 session_end（残行要么 parse 失败被跳，要么即使侥幸 parse 成功也不应出现）
    const outcomes = result.filter((e) => (e as { type?: string }).type === 'session_end')
    expect(outcomes).toHaveLength(1)
    // 残行不应产生 padding 类型的假 entry
    const paddings = result.filter((e) => (e as { type?: string }).type === 'padding')
    expect(paddings).toHaveLength(0)
  })

  it('AC-tail-4: 多字节 UTF-8 字符在 offset 处切断不产生乱码抛错', () => {
    // emoji 占 4 字节，CJK 占 3 字节。构造内容使 offset 切在多字节字符中间
    const emoji = '🌐' // U+1F310, 4 bytes in UTF-8
    const cjk = '中文测试' // 每字 3 bytes
    // 首行大量 emoji 撑过 32KB，offset 大概率切在某个 emoji 中间
    const paddingLine = { type: 'pad', text: emoji.repeat(READ_TAIL_BYTES / 2) }
    const target = { type: 'session_info', name: cjk + '结束' }
    const path = makeFile([paddingLine, target])
    // 不应抛错（残行被丢弃，不因乱码崩溃）
    expect(() => readTailEntries(path)).not.toThrow()
    const result = readTailEntries(path)
    if (!result) throw new Error('readTailEntries returned null')
    const found = result.find((e) => (e as { type?: string }).type === 'session_info')
    expect(found).toEqual(target)
  })

  it('AC-tail-5: 文件不存在返回 null 不抛', () => {
    const path = join(tmpDir, 'nonexistent.jsonl')
    expect(() => readTailEntries(path)).not.toThrow()
    expect(readTailEntries(path)).toBeNull()
  })

  it('AC-tail-5: 文件小于 READ_TAIL_BYTES 退化为读全文件', () => {
    const entries = [
      { type: 'session', id: 'x' },
      { type: 'session_info', name: '小文件' },
    ]
    const path = makeFile(entries)
    const result = readTailEntries(path)
    // size < NKB → offset=0 → 无残行 → 全部返回
    expect(result).toHaveLength(2)
  })

  it('空文件返回空数组', () => {
    const path = join(tmpDir, 'empty.jsonl')
    writeFileSync(path, '', 'utf-8')
    const result = readTailEntries(path)
    expect(result).toEqual([])
  })
})
