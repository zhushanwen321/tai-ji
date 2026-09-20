/**
 * assertPiSessionFile 跳过分支显形测试（code-harden RT-3#7）。
 *
 * 覆盖：
 * - 三跳过分支（无 getState / 无 sessionFile / 回报路径不在磁盘）→ 各自计数 +1，
 *   首次触发 error 级上报（I1 数据丢失级防线失效必须显著可见），同类不重复输出；
 * - 显式测试豁免（setAttachAssertExemptionForTest(true)）→ 照常跳过返回，零 error；
 * - mismatch 主路径不受影响（仍 throw，正向对照——真防线）。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/session-attach-assert.test.ts
 */
import { describe, it, expect, vi, type MockInstance, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertPiSessionFile,
  attachAssertSkipStats,
  setAttachAssertExemptionForTest,
  _resetAttachAssertSkipStatsForTest,
  type SessionFileAssertClient,
} from '../session-attach-assert.js'

let dir: string
let errorSpy: MockInstance<typeof console.error>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'attach-assert-rt3-7-'))
  _resetAttachAssertSkipStatsForTest()
  setAttachAssertExemptionForTest(false)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  setAttachAssertExemptionForTest(false)
  _resetAttachAssertSkipStatsForTest()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function stateClient(sessionFile: string | undefined): SessionFileAssertClient {
  return { getState: async () => (sessionFile === undefined ? {} : { sessionFile }) }
}

describe('assertPiSessionFile · 跳过分支显形（RT-3#7）', () => {
  it('分支1 无 getState → 计数 noGetState + 首次 error，同类二次不重复输出', async () => {
    const noState = {} as SessionFileAssertClient

    await assertPiSessionFile(noState, join(dir, 'x.jsonl'), 'ctx-1')
    expect(attachAssertSkipStats.noGetState).toBe(1)
    const errs = errorSpy.mock.calls.map(c => String(c[0]))
    expect(errs.some(m => m.includes('client lacks getState') && m.includes('I1'))).toBe(true)

    await assertPiSessionFile(noState, join(dir, 'x.jsonl'), 'ctx-1b')
    expect(attachAssertSkipStats.noGetState).toBe(2)
    expect(errorSpy.mock.calls.filter(c => String(c[0]).includes('client lacks getState'))).toHaveLength(1)
  })

  it('分支2 get_state 无 sessionFile → 计数 noSessionFile + error', async () => {
    await assertPiSessionFile(stateClient(undefined), join(dir, 'x.jsonl'), 'ctx-2')
    expect(attachAssertSkipStats.noSessionFile).toBe(1)
    expect(errorSpy.mock.calls.some(c => String(c[0]).includes('no comparable sessionFile'))).toBe(true)
  })

  it('分支3 回报路径不在磁盘 → 计数 fileMissing + error', async () => {
    await assertPiSessionFile(stateClient(join(dir, 'ghost.jsonl')), join(dir, 'x.jsonl'), 'ctx-3')
    expect(attachAssertSkipStats.fileMissing).toBe(1)
    expect(errorSpy.mock.calls.some(c => String(c[0]).includes('does not exist on disk'))).toBe(true)
  })

  it('显式测试豁免 → 跳过返回、计数仍走、零 error（豁免意图显式声明而非形状探测）', async () => {
    setAttachAssertExemptionForTest(true)
    const noState = {} as SessionFileAssertClient

    await assertPiSessionFile(noState, join(dir, 'x.jsonl'), 'ctx-4')
    expect(attachAssertSkipStats.noGetState).toBe(1)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('正向对照：路径一致 → 通过，零 error；mismatch → 仍 throw（主防线不变）', async () => {
    const real = join(dir, 'real.jsonl')
    writeFileSync(real, '{"type":"session"}\n', 'utf-8')
    const other = join(dir, 'other.jsonl')
    writeFileSync(other, '{"type":"session"}\n', 'utf-8')

    await assertPiSessionFile(stateClient(real), real, 'ctx-ok')
    expect(errorSpy).not.toHaveBeenCalled()

    await expect(assertPiSessionFile(stateClient(real), other, 'ctx-mismatch')).rejects.toThrow('[attach-mismatch]')
  })
})
