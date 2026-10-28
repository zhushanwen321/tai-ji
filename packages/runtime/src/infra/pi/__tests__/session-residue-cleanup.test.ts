import { getSessionsDir } from '../pi-paths.js';
import { isScannableSessionFile, scanPiSessions } from '../session-file-utils.js';
import { TMP_RESIDUE_MARKERS, cleanupMigrateResidues, cleanupTmpMigrateResidue, isTmpResidueFileName } from '../session-residue-cleanup.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


function makeSessionsDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const sessionsDir = join(dir, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  return sessionsDir
}


/** 把文件 mtime 拨回到指定年龄前（清扫按龄闸判定 stale）。 */
function ageFile(filePath: string, ageMs: number): void {
  const atime = new Date(Date.now() - ageMs)
  utimesSync(filePath, atime, atime)
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-residue-cleanup', () => {
describe('isTmpResidueFileName（精确后缀形态判定）', () => {
  it('真残留（归一化/导入崩溃中间态）命中', () => {
    expect(isTmpResidueFileName('s-abc.jsonl.tmp-migrate-1770000000000.jsonl')).toBe(true)
    expect(isTmpResidueFileName('s-abc.jsonl.tmp-import-1770000000000.jsonl')).toBe(true)
  })

  it('中段含标记的真实会话文件名不命中（RT-3#10 核心断言）', () => {
    expect(isTmpResidueFileName('a.tmp-migrate-b.jsonl')).toBe(false)
    expect(isTmpResidueFileName('a.tmp-import-b.jsonl')).toBe(false)
  })

  it('标记后非纯数字（伪装/手改）不命中', () => {
    expect(isTmpResidueFileName('x.jsonl.tmp-migrate-notatimestamp.jsonl')).toBe(false)
    expect(isTmpResidueFileName('x.jsonl.tmp-migrate-.jsonl')).toBe(false)
  })

  it('标记家族常量与谓词同源（无第三份判定漂移）', () => {
    // TMP_RESIDUE_MARKERS 仍导出（import-service 拒绝校验等消费方），但本模块判定
    // 不再走 includes 子串——用常量拼出真残留名必须命中谓词，防常量与正则漂移。
    for (const marker of TMP_RESIDUE_MARKERS) {
      expect(isTmpResidueFileName(`f.jsonl${marker}1770000000000.jsonl`)).toBe(true)
    }
  })
})
describe('cleanupTmpMigrateResidue · 精确判定 + 按龄闸', () => {
  it('中段含标记的真实会话文件：不被收录（isScannableSessionFile）也绝不被删除', () => {
    const sessionsDir = makeSessionsDir('rt3-10-real-')
    try {
      const realFile = join(sessionsDir, 'a.tmp-migrate-b.jsonl')
      writeFileSync(realFile, '{"type":"session","id":"a.tmp-migrate-b","cwd":"/tmp","timestamp":"2026-01-01"}\n', 'utf-8')
      ageFile(realFile, 2 * 3_600_000) // 2h：超过 1h 按龄闸，旧判定下必被删

      // 候选侧：中段含标记的真实文件必须可被 scanner 收录（不再被子串判定排除）
      expect(isScannableSessionFile('a.tmp-migrate-b.jsonl')).toBe(true)
      // 真残留仍被排除
      expect(isScannableSessionFile('s.jsonl.tmp-migrate-1770000000000.jsonl')).toBe(false)

      const removed = cleanupTmpMigrateResidue(sessionsDir)
      expect(removed).toBe(0)
      expect(existsSync(realFile)).toBe(true)
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('真残留（后缀形态）超龄被删、新鲜保留', () => {
    const sessionsDir = makeSessionsDir('rt3-10-residue-')
    try {
      const stale = join(sessionsDir, 's1.jsonl.tmp-migrate-1770000000000.jsonl')
      const fresh = join(sessionsDir, 's2.jsonl.tmp-import-1770000000001.jsonl')
      writeFileSync(stale, 'x', 'utf-8')
      writeFileSync(fresh, 'x', 'utf-8')
      ageFile(stale, 2 * 3_600_000)
      ageFile(fresh, 1_000) // 1s：阈值内

      const removed = cleanupTmpMigrateResidue(sessionsDir)
      expect(removed).toBe(1)
      expect(existsSync(stale)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('U9 sidecar 家族（.jsonl.model.json）年龄无关全删（既有语义不回退）', () => {
    const sessionsDir = makeSessionsDir('rt3-10-sidecar-')
    try {
      const freshSidecar = join(sessionsDir, 's.jsonl.model.json')
      writeFileSync(freshSidecar, '{}', 'utf-8')
      const removed = cleanupTmpMigrateResidue(sessionsDir)
      expect(removed).toBe(1)
      expect(existsSync(freshSidecar)).toBe(false)
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
describe('cleanupMigrateResidues · session 级（前缀精确，既有语义）', () => {
  it('只删本 basename 前缀精确匹配的残留，不碰其他文件', () => {
    const sessionsDir = makeSessionsDir('rt3-10-slevel-')
    try {
      const own = join(sessionsDir, 'me.jsonl.tmp-migrate-1770000000000.jsonl')
      const other = join(sessionsDir, 'other.jsonl.tmp-migrate-1770000000000.jsonl')
      const real = join(sessionsDir, 'me.jsonl')
      writeFileSync(own, 'x', 'utf-8')
      writeFileSync(other, 'x', 'utf-8')
      writeFileSync(real, '{"type":"session"}\n', 'utf-8')

      cleanupMigrateResidues(real)
      expect(existsSync(own)).toBe(false)
      expect(existsSync(other)).toBe(true)
      expect(existsSync(real)).toBe(true)
      expect(readdirSync(sessionsDir).sort()).toEqual(['me.jsonl', 'other.jsonl.tmp-migrate-1770000000000.jsonl'])
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
});

// ======================================================================
// ← session-scan-degraded-tolerance.test.ts
// ======================================================================

let prevDataDir: string | undefined

let dir: string

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-scan-degraded-tolerance', () => {
beforeEach(() => {
  prevDataDir = process.env.TAIJI_AGENT_DATA_DIR
  dir = mkdtempSync(join(tmpdir(), 'taiji-scan-degraded-'))
  process.env.TAIJI_AGENT_DATA_DIR = dir
  mkdirSync(getSessionsDir(), { recursive: true })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  // 权限恢复先于自删（chmod 000 目录 rm 枚举会 EACCES）；已删/已恢复则吞掉。
  try { chmodSync(getSessionsDir(), 0o755) } catch { /* noop */ }
  if (prevDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = prevDataDir
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  vi.restoreAllMocks()
})
describe('scanPiSessions 降级容错（读取故障不炸进程，降级留痕）', () => {
  it('健康轮 → []；顶层 readdir EACCES → 降级 [] 不抛 + console.error 留痕；恢复后正常', () => {
    expect(scanPiSessions({ force: true })).toEqual([])
    expect(console.error).not.toHaveBeenCalled()

    chmodSync(getSessionsDir(), 0o000)
    expect(scanPiSessions({ force: true })).toEqual([]) // 降级空与权威空返回值同形，不抛 EACCES
    expect(console.error).toHaveBeenCalled()

    chmodSync(getSessionsDir(), 0o755)
    expect(scanPiSessions({ force: true })).toEqual([])
  })

  it('cwd 分组子目录列举失败（dirFail，整组缺失）→ 降级为缺失该组，不抛异常', () => {
    const cwdDir = join(getSessionsDir(), 'proj-a')
    mkdirSync(cwdDir, { recursive: true })
    chmodSync(cwdDir, 0o000)

    expect(scanPiSessions({ force: true })).toEqual([])

    chmodSync(cwdDir, 0o755)
    expect(scanPiSessions({ force: true })).toEqual([])
  })
})
});
