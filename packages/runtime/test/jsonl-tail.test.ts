/**
 * JSONL 尾读（readTailEntries / extractSessionName / extractSessionOutcome）合并测试。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - jsonl-tail.test.ts
 * - extract-tail-read.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run test/jsonl-tail.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractSessionName, extractSessionOutcome } from '../src/infra/pi/session-file-utils.js'
import { readTailEntries, READ_TAIL_BYTES } from '../src/utils/jsonl.js'

describe('jsonl-tail', () => {
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
// 以下 import 在 W1 实现前会失败（符号不存在）→ 红灯
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
})

describe('extract-tail-read', () => {
/**
 * W2 红灯测试：extractSessionName / extractSessionOutcome 尾读改造 + fallback。
 *
 * 对应 FR-tail-read（AC-tail-1/2/3）+ INVAR-tail-2 fallback 全量（SR1 核心修复）。
 *
 * 核心防的 bug：
 * - SR1：session_info 在文件头部（早期命名 + 长对话追加），尾窗找不到 → 若返回 null 则丢名字。
 *   修复：尾读未命中 → fallback 全量读。
 * - 回归：无 session_info/session_end 的文件返回 null（与现状一致）。
 *
 * [红灯说明] 当前 extractSessionName/extractSessionOutcome 仍是全量读（W1 readTail 工具已实现但
 * extract 尚未改用）。本测试断言"fallback 触发"和"尾读命中"——实现前部分会 fail（无法观测 fallback）。
 * W2 实现后（extract 改用 readTailEntries + fallback）应转绿。
 *
 * 运行：cd packages/runtime && npx vitest run test/extract-tail-read.test.ts
 */
describe('W2 extractSessionName 尾读 + fallback', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'extract-name-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function makeFile(lines: string[]): string {
    const path = join(tmpDir, `s-${Math.random().toString(36).slice(2)}.jsonl`)
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8')
    return path
  }

  it('AC-tail-1: session_info 在尾窗内 → 返回正确 name', () => {
    const path = makeFile([
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
      JSON.stringify({ type: 'session_info', name: '我的名字' }),
    ])
    expect(extractSessionName(path)).toBe('我的名字')
  })

  it('AC-tail-1: 多条 session_info 取最后一条', () => {
    const path = makeFile([
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
      JSON.stringify({ type: 'session_info', name: '旧名字' }),
      JSON.stringify({ type: 'session_info', name: '新名字' }),
    ])
    expect(extractSessionName(path)).toBe('新名字')
  })

  /**
   * SR1 核心防回归：session_info 在文件头部（早期命名 + 长对话）。
   * 尾读找不到 → 必须 fallback 全量读 → 返回正确名字，不能返回 null。
   */
  it('AC-tail-2: session_info 在文件头部（>32KB）→ fallback 全量返回正确 name（非 null）', () => {
    // session_info 在第 2 行，之后追加大量 message 撑过 32KB 尾窗
    const lines = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
      JSON.stringify({ type: 'session_info', name: '早期命名的名字' }),
    ]
    // 追加大量 message 把 session_info 推出尾窗
    for (let i = 0; i < 500; i++) {
      lines.push(JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'x'.repeat(200) } }))
    }
    const path = makeFile(lines)
    // 文件大小 >> 32KB，session_info 在头部，尾窗全是 message
    const name = extractSessionName(path)
    // 核心：不能因尾读找不到就返回 null（丢名字）。必须 fallback 全量读到 '早期命名的名字'
    expect(name).toBe('早期命名的名字')
  })

  it('AC-tail-3: 文件无 session_info → 返回 null', () => {
    const path = makeFile([
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
    ])
    expect(extractSessionName(path)).toBeNull()
  })

  it('文件不存在 → 返回 null 不抛', () => {
    const path = join(tmpDir, 'nope.jsonl')
    expect(() => extractSessionName(path)).not.toThrow()
    expect(extractSessionName(path)).toBeNull()
  })
})

describe('W2 extractSessionOutcome 尾读 + fallback', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'extract-outcome-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function makeFile(lines: string[]): string {
    const path = join(tmpDir, `s-${Math.random().toString(36).slice(2)}.jsonl`)
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8')
    return path
  }

  it('AC-tail-1: session_end 在尾部 → 返回正确 outcome', () => {
    const path = makeFile([
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
      JSON.stringify({ type: 'session_end', outcome: 'done', timestamp: 't2' }),
    ])
    expect(extractSessionOutcome(path)).toBe('done')
  })

  it('AC-tail-1: session_end outcome=error/stopped 各正确', () => {
    for (const outcome of ['error', 'stopped'] as const) {
      const path = makeFile([
        JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
        JSON.stringify({ type: 'session_end', outcome, timestamp: 't2' }),
      ])
      expect(extractSessionOutcome(path)).toBe(outcome)
    }
  })

  it('AC-tail-2: session_end 被大量 message 推出尾窗 → fallback 全量返回正确 outcome', () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
      JSON.stringify({ type: 'session_end', outcome: 'stopped', timestamp: 't2' }),
    ]
    for (let i = 0; i < 500; i++) {
      lines.push(JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'y'.repeat(200) } }))
    }
    const path = makeFile(lines)
    expect(extractSessionOutcome(path)).toBe('stopped')
  })

  it('AC-tail-3: 文件无 session_end → 返回 null', () => {
    const path = makeFile([
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
    ])
    expect(extractSessionOutcome(path)).toBeNull()
  })

  it('文件不存在 → 返回 null 不抛', () => {
    const path = join(tmpDir, 'nope.jsonl')
    expect(() => extractSessionOutcome(path)).not.toThrow()
    expect(extractSessionOutcome(path)).toBeNull()
  })
})
})
