/**
 * Session 残留清扫精确判定测试（code-harden RT-3#10）。
 *
 * 审计推断（修复前 fixture 验证过）：tmp 家族用 `name.includes(marker)` 子串判定，
 * 中段含标记的真实会话文件（如 `a.tmp-migrate-b.jsonl`，session id 本身含标记串）
 * 既被 scanner 排除（isScannableSessionFile）又被启动清扫删除（超 1h 龄后）——
 * 数据丢失。修复 = 统一为「`.tmp-(migrate|import)-<纯数字ts>.jsonl$」后缀形态精确判定，
 * 候选侧（isScannableSessionFile）/ 清扫侧（removeResiduesInDir）/ 导入拒绝侧
 * （import-source-external-file）三消费点同一谓词。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/session-residue-cleanup.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupTmpMigrateResidue,
  cleanupMigrateResidues,
  isTmpResidueFileName,
  TMP_RESIDUE_MARKERS,
} from '../session-residue-cleanup.js'
import { isScannableSessionFile } from '../session-file-utils.js'

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
