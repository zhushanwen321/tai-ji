/**
 * 归一化残留清理单测（restore-fork-attach-fix 差距复审 suggestion 6）。
 *
 * 被测机制：
 * - normalizeSessionFileInPlace rename 失败回滚：renameSync 抛错时删除刚写的
 *   `.tmp-migrate-*.jsonl` 临时文件再 rethrow——原文件未被触碰仍完整，不留孤儿。
 * - cleanupMigrateResidues：按「basename 前缀精确匹配 + .jsonl 后缀」清扫该 session
 *   文件的崩溃/失败残留（best-effort，不碰其他 session 的文件）。
 *
 * 文件系统操作全部真实执行于 mkdtemp tmp 目录（不 mock fs）。
 * rename 失败的真实触发：目标路径是已存在的非空目录（renameSync 报 ENOTEMPTY/EISDIR，
 * 同目录可写故回滚 unlink 可执行）。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-file-utils-migrate-cleanup.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeSessionFileInPlace, cleanupMigrateResidues } from '../src/infra/pi/session-file-utils.js'

function tmpMigrateNames(dir: string): string[] {
  return readdirSync(dir).filter(n => n.includes('.tmp-migrate-'))
}

describe('normalizeSessionFileInPlace rename 失败回滚（suggestion 6）', () => {
  it('rename 目标是已存在的非空目录 → 抛错且不留 .tmp-migrate- 残留，原目标未动', () => {
    const dir = mkdtempSync(join(tmpdir(), 's6-rollback-'))
    try {
      // 目标路径做成已存在的非空目录 → renameSync(file → dir) 真实抛错
      const target = join(dir, '2026-08-19T00-00-00-000Z_sess-x.jsonl')
      mkdirSync(target)
      writeFileSync(join(target, 'occupant.txt'), 'x')

      expect(() => normalizeSessionFileInPlace(target, 'line\n')).toThrow()
      // 回滚：刚写的临时文件已删，目录零 .tmp-migrate- 残留
      expect(tmpMigrateNames(dir)).toEqual([])
      // 原目标（目录）未被触碰
      expect(existsSync(join(target, 'occupant.txt'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('rename 成功路径行为不变：临时文件被消费，产物落原路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 's6-ok-'))
    try {
      const target = join(dir, '2026-08-19T00-00-00-000Z_sess-y.jsonl')
      writeFileSync(target, 'old\n')
      normalizeSessionFileInPlace(target, 'new-content\n')
      expect(readFileSync(target, 'utf-8')).toBe('new-content\n')
      expect(tmpMigrateNames(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('cleanupMigrateResidues（suggestion 6）', () => {
  it('只删同 basename 前缀 + .jsonl 后缀的残留，不碰其他文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 's6-sweep-'))
    try {
      const base = '2026-08-19T00-00-00-000Z_sess-a.jsonl'
      const main = join(dir, base)
      writeFileSync(main, 'main\n')
      // 命中：同 basename 前缀残留 ×2
      writeFileSync(join(dir, `${base}.tmp-migrate-111.jsonl`), 'r1\n')
      writeFileSync(join(dir, `${base}.tmp-migrate-222.jsonl`), 'r2\n')
      // 不命中：其他 session 的残留 / 前缀匹配但非 .jsonl 后缀 / 无关文件
      const other = '2026-08-19T00-00-00-000Z_sess-b.jsonl.tmp-migrate-333.jsonl'
      writeFileSync(join(dir, other), 'other-session-residue\n')
      writeFileSync(join(dir, `${base}.tmp-migrate-444.txt`), 'wrong-suffix\n')
      writeFileSync(join(dir, 'unrelated.jsonl'), 'keep\n')

      cleanupMigrateResidues(main)

      const names = readdirSync(dir)
      expect(names).toContain(base)
      expect(names).toContain(other)
      expect(names).toContain(`${base}.tmp-migrate-444.txt`)
      expect(names).toContain('unrelated.jsonl')
      expect(names).not.toContain(`${base}.tmp-migrate-111.jsonl`)
      expect(names).not.toContain(`${base}.tmp-migrate-222.jsonl`)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('无残留时 no-op；目录不存在时不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 's6-noop-'))
    try {
      const main = join(dir, 'x.jsonl')
      writeFileSync(main, 'm\n')
      expect(() => cleanupMigrateResidues(main)).not.toThrow()
      expect(readdirSync(dir)).toEqual(['x.jsonl'])
      expect(() => cleanupMigrateResidues(join(dir, 'no-such-dir', 'x.jsonl'))).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
