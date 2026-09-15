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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { READ_TAIL_BYTES } from '../src/utils/jsonl.js'
import { extractSessionName, extractSessionOutcome } from '../src/infra/pi/session-file-utils.js'

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
