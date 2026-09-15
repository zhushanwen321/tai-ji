/**
 * W3 残留清理测试——cleanupTmpMigrateResidue 四态 + scanPiSessions 全链路不收录残留。
 *
 * 背景（验收基线 w3-acceptance.md 问题 2）：normalizeSessionFileInPlace 在写临时名与
 * rename 之间崩溃会残留 `<原名>.tmp-migrate-<ts>.jsonl`。isScannableSessionFile 已在
 * 扫描层排除（不错位附着），但残留永久积累；本测试族锁定启动期目录级清理的行为契约：
 * - 四态：过期残留删除 / 新鲜残留保留（防并发误删）/ 目录不存在 no-op / 非匹配文件零触碰
 * - 端到端：同 id 正式文件 + 残留共存时 scanPiSessions 只收录正式文件；清理后目录只剩正式文件
 *
 * 运行：cd packages/runtime && pnpm exec vitest run src/__tests__/session-file-utils-tmp-migrate.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  cleanupTmpMigrateResidue,
  scanPiSessions,
  invalidateScanDirCache,
} from '../infra/pi/session-file-utils.js'

/** 写一个合法 session JSONL（首行 session header），返回文件绝对路径。 */
function writeSessionFile(dir: string, name: string, id: string, cwd: string): string {
  const filePath = join(dir, name)
  writeFileSync(
    filePath,
    JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-08-19T00:00:00Z' }) + '\n',
    'utf-8',
  )
  return filePath
}

/** 把文件 mtime 回拨到 ageMs 之前（构造过期残留；atime 同步设置，utimesSync 必填）。 */
function ageFile(filePath: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs)
  utimesSync(filePath, t, t)
}

describe('cleanupTmpMigrateResidue（W3 残留清理）', () => {
  let dataDir: string
  let sessionsDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'w3-tmp-migrate-'))
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    invalidateScanDirCache()
    sessionsDir = join(dataDir, 'agent', 'sessions')
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    invalidateScanDirCache()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('过期残留删除（根目录 + cwd 分组子目录两层都清）', () => {
    const subDir = join(sessionsDir, 'proj-a')
    mkdirSync(subDir, { recursive: true })
    const residueRoot = writeSessionFile(sessionsDir, 'sess-1.jsonl.tmp-migrate-1700000000000.jsonl', 'x', '/w')
    const residueSub = writeSessionFile(subDir, 'sess-2.jsonl.tmp-migrate-1700000000001.jsonl', 'x', '/w')
    ageFile(residueRoot, 2 * 3_600_000)
    ageFile(residueSub, 2 * 3_600_000)

    const removed = cleanupTmpMigrateResidue(sessionsDir, 3_600_000)

    expect(removed).toBe(2)
    expect(existsSync(residueRoot)).toBe(false)
    expect(existsSync(residueSub)).toBe(false)
  })

  it('新鲜残留保留（mtime 晚于 now-maxAgeMs 不删，防并发误删进行中的归一化临时文件）', () => {
    mkdirSync(sessionsDir, { recursive: true })
    const fresh = writeSessionFile(sessionsDir, 'sess-1.jsonl.tmp-migrate-9999999999999.jsonl', 'x', '/w')

    const removed = cleanupTmpMigrateResidue(sessionsDir, 3_600_000)

    expect(removed).toBe(0)
    expect(existsSync(fresh)).toBe(true)
  })

  it('目录不存在 no-op 安全（返回 0，不上抛）', () => {
    expect(cleanupTmpMigrateResidue(join(dataDir, 'no-such-dir'), 3_600_000)).toBe(0)
  })

  it('非匹配文件零触碰（正常 session / sidecar / 非 tmp-migrate 命名的 jsonl 均保留）', () => {
    mkdirSync(sessionsDir, { recursive: true })
    const normal = writeSessionFile(sessionsDir, 'sess-1.jsonl', 'sess-1', '/w')
    const sidecar = join(sessionsDir, 'sess-1.jsonl.meta.json')
    writeFileSync(sidecar, '{}', 'utf-8')
    const otherJsonl = writeSessionFile(sessionsDir, 'notes.jsonl', 'x', '/w')
    ageFile(normal, 2 * 3_600_000)
    ageFile(sidecar, 2 * 3_600_000)
    ageFile(otherJsonl, 2 * 3_600_000)

    const removed = cleanupTmpMigrateResidue(sessionsDir, 3_600_000)

    expect(removed).toBe(0)
    expect(existsSync(normal)).toBe(true)
    expect(existsSync(sidecar)).toBe(true)
    expect(existsSync(otherJsonl)).toBe(true)
  })

  it('端到端：同 id 正式文件 + 残留共存 → scanPiSessions 只收录正式文件；清理后目录只剩正式文件', () => {
    const subDir = join(sessionsDir, 'proj-a')
    mkdirSync(subDir, { recursive: true })
    const official = writeSessionFile(subDir, 'sess-1.jsonl', 'sess-1', '/work/a')
    // 残留与正式文件同 id（内容是合法 session——正是 isScannableSessionFile 按名排除的动机）
    const residue = writeSessionFile(subDir, 'sess-1.jsonl.tmp-migrate-1700000000000.jsonl', 'sess-1', '/work/a')
    ageFile(residue, 2 * 3_600_000)

    // 全链路：scanPiSessions（目录 TTL 缓存 + 文件名过滤 + header 解析）不收录残留
    const scanned = scanPiSessions()
    expect(scanned).toHaveLength(1)
    expect(scanned[0].id).toBe('sess-1')
    expect(scanned[0].filePath).toBe(official)

    // 清理后：目录只剩正式文件（残留被删、正式文件未动）
    const removed = cleanupTmpMigrateResidue(sessionsDir, 3_600_000)
    expect(removed).toBe(1)
    expect(existsSync(residue)).toBe(false)
    expect(existsSync(official)).toBe(true)
    // 清理后再扫仍一致（清理未破坏扫描视图）
    invalidateScanDirCache()
    expect(scanPiSessions()).toHaveLength(1)
  })
})
