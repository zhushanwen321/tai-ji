/**
 * 备份残留按龄回收分流测试（code-harden RT-3 附带项，M8）。
 *
 * 锁定：
 * - 普通副本（settings.json.corrupt- 等）超 7 天回收，删除时落一条 warn 记总数；
 * - 含明文 apiKey 的 models.json.corrupt- 副本：窗口延长到 30 天，回收前升 error 日志；
 * - 窗口内（7d/30d 各自）保留不删；不含 apiKey 的 models.json 副本按普通 7 天处置。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/utils/__tests__/json-store-backup-retention.test.ts
 */
import { describe, it, expect, vi, type MockInstance, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupAgedBackupResidue } from '../json-store.js'

let dir: string
let warnSpy: MockInstance<typeof console.warn>
let errorSpy: MockInstance<typeof console.error>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-retention-rt3-'))
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  errorSpy.mockRestore()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** quarantineCorruptFile 同款压缩 ISO 时间戳（去冒号/点号）。 */
function compactIso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().replace(/[:.]/g, '')
}

const DAY = 24 * 60 * 60 * 1000

describe('cleanupAgedBackupResidue · 凭据副本分流（RT-3 附带项）', () => {
  it('普通副本超 7 天回收 + warn 记总数；凭据副本超 7 天但在 30 天内保留', () => {
    const regular = join(dir, `settings.json.corrupt-${compactIso(8 * DAY)}`)
    writeFileSync(regular, '{}', 'utf-8')
    const credKept = join(dir, `models.json.corrupt-${compactIso(10 * DAY)}`)
    writeFileSync(credKept, JSON.stringify({ providers: { x: { apiKey: 'sk-plain' } } }), 'utf-8')

    const removed = cleanupAgedBackupResidue([dir])

    expect(removed).toBe(1)
    expect(existsSync(regular)).toBe(false)
    expect(existsSync(credKept)).toBe(true)
    // 普通副本删除：一条 warn 记总数
    const warnMsg = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('aged backup copy'))
    expect(warnMsg).toBeDefined()
    expect(warnMsg).toContain('removed 1 aged backup copy')
    // 凭据副本保留期内：无 error
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('含 apiKey 的 models.json 副本超 30 天回收前升 error（含路径与不可恢复提示）', () => {
    const credExpired = join(dir, `models.json.corrupt-${compactIso(40 * DAY)}`)
    writeFileSync(credExpired, JSON.stringify({ providers: { x: { apiKey: 'sk-plain' } } }), 'utf-8')

    const removed = cleanupAgedBackupResidue([dir])

    expect(removed).toBe(1)
    expect(existsSync(credExpired)).toBe(false)
    const errMsg = errorSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('credential-bearing backup'))
    expect(errMsg).toBeDefined()
    expect(errMsg).toContain(credExpired)
    expect(errMsg).toContain('不可恢复')
    // 凭据副本不计入普通 warn 总数（removed=1 但 regularRemoved=0 → 无 warn）
    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('aged backup copy'))).toHaveLength(0)
  })

  it('不含 apiKey 的 models.json 副本按普通 7 天窗口处置（嗅探不误伤）', () => {
    const noKey = join(dir, `models.json.corrupt-${compactIso(8 * DAY)}`)
    writeFileSync(noKey, JSON.stringify({ providers: { x: { name: 'x' } } }), 'utf-8')

    const removed = cleanupAgedBackupResidue([dir])

    expect(removed).toBe(1)
    expect(existsSync(noKey)).toBe(false)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('7 天内的普通副本保留（取证窗口）', () => {
    const fresh = join(dir, `settings.json.corrupt-${compactIso(2 * DAY)}`)
    writeFileSync(fresh, '{}', 'utf-8')

    const removed = cleanupAgedBackupResidue([dir])

    expect(removed).toBe(0)
    expect(existsSync(fresh)).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
