/**
 * scanPiSessions 降级显形测试（code-harden RT-3#2）。
 *
 * 覆盖：非 session 首行 / 坏 header / 子目录列举失败 → 轮末汇总 warn（计数 + 样例路径），
 * 正常会话不受影响仍收录。此前单文件/单目录读失败与非 session 首行一律静默 continue，
 * 会话从列表永久消失零痕迹。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/__tests__/session-scan-degraded.test.ts
 */
import { describe, it, expect, vi, type MockInstance, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPiSessions, invalidateScanDirCache, _resetSessionMetaCacheForTest } from '../infra/pi/session-file-utils.js'

let dir: string
let warnSpy: MockInstance<typeof console.warn>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scan-degraded-rt3-2-'))
  process.env.TAIJI_AGENT_DATA_DIR = dir
  _resetSessionMetaCacheForTest()
  invalidateScanDirCache()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  delete process.env.TAIJI_AGENT_DATA_DIR
  _resetSessionMetaCacheForTest()
  invalidateScanDirCache()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** sessions 目录（getSessionsDir = <dataDir>/agent/sessions）。 */
function sessionsDir(): string {
  return join(dir, 'agent', 'sessions')
}

function writeSession(name: string, id: string): string {
  const p = join(sessionsDir(), name)
  writeFileSync(p, `{"type":"session","version":3,"id":"${id}","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n`, 'utf-8')
  return p
}

describe('scanPiSessions · 降级计数 + 轮末汇总（RT-3#2）', () => {
  it('非 session 首行的 .jsonl → 不收录 + 汇总 warn 含 noHeader 计数与样例路径', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    const bad = join(sessionsDir(), 'not-a-session.jsonl')
    writeFileSync(bad, '{"type":"label","label":"x"}\n', 'utf-8')

    const results = scanPiSessions({ force: true })

    expect(results).toHaveLength(0)
    const summary = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('scanPiSessions degraded'))
    expect(summary).toBeDefined()
    expect(summary).toContain('noHeader=1')
    expect(summary).toContain(bad)
  })

  it('坏 header（type=session 缺 cwd）→ badHeader 计入汇总；正常会话仍收录', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    writeSession('good.jsonl', 'good-id')
    const badHeader = join(sessionsDir(), 'bad-header.jsonl')
    writeFileSync(badHeader, '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z"}\n', 'utf-8')

    const results = scanPiSessions({ force: true })

    expect(results.map(r => r.id)).toEqual(['good-id'])
    const summary = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('scanPiSessions degraded'))
    expect(summary).toBeDefined()
    expect(summary).toContain('badHeader=1')
    expect(summary).toContain(badHeader)
  })

  it('cwd 子目录不可读（EACCES）→ dirFail 计入汇总', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    writeSession('root-level.jsonl', 'root-id')
    const sub = join(sessionsDir(), 'group-a')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'inner.jsonl'), '{"type":"session","version":3,"id":"inner-id","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n', 'utf-8')
    chmodSync(sub, 0o000)

    try {
      const results = scanPiSessions({ force: true })
      // 子目录整体未收录（只有根层正常条目）
      expect(results.map(r => r.id)).toEqual(['root-id'])
      const summary = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('scanPiSessions degraded'))
      expect(summary).toBeDefined()
      expect(summary).toContain('dirFail=1')
      expect(summary).toContain(sub)
    } finally {
      chmodSync(sub, 0o755)
    }
  })

  it('零降级 → 无汇总 warn（正常态安静）', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    writeSession('only.jsonl', 'only-id')
    const results = scanPiSessions({ force: true })
    expect(results).toHaveLength(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
