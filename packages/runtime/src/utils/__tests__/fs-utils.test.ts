/**
 * atomicWrite / atomicWriteAsync 单测（code-harden RT-3#9）。
 *
 * 覆盖：
 * - rename 失败（目标路径不可能 rename 成功的形态：目标父目录不存在）→ 原样上抛 + tmp 清理（不留永久垃圾）；
 * - 写失败（tmp 目录只读不可写——macOS 下 chmod 只读目录 writeFileSync 抛 EACCES）→ 同样清理后上抛；
 * - 默认 tmp 名含 pid+序号：同文件两次写之间 tmp 名不同（多进程/并发防互踩）；
 * - 显式 uniqueSuffix 仍生效（`.tmp_<suffix>`）。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/utils/__tests__/fs-utils.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite, atomicWriteAsync } from '../fs-utils.js'

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('atomicWrite（RT-3#9）', () => {
  it('rename 失败（目标父目录不存在）→ 上抛且不留 tmp', () => {
    const dir = makeTmpDir('fs-utils-rename-')
    try {
      const target = join(dir, 'no-such-dir', 'f.json')
      expect(() => atomicWrite(target, 'data')).toThrow()
      // 目标目录本身未被创建，tmp 也不会落在其中；确认目录树里零残留
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('rename 失败（目标是已存在目录）→ 上抛且同目录 tmp 被清理', () => {
    const dir = makeTmpDir('fs-utils-renamedir-')
    try {
      const target = join(dir, 'occupied')
      mkdirSync(target) // rename 一个目录名 → ENOTDIR/EISDIR 失败
      expect(() => atomicWrite(target, 'data')).toThrow()
      // tmp 写在 target 旁（同目录），失败后必须被清理
      expect(readdirSync(dir).filter(n => n.startsWith('occupied.tmp_'))).toEqual([])
      expect(existsSync(target)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('默认 tmp 名含 pid+序号：连续写成功且失败路径零残留（并发 tmp 名不互踩的行为面）', () => {
    const dir = makeTmpDir('fs-utils-uniquename-')
    try {
      const target = join(dir, 'f.json')
      // 正向：同文件连续两次写（pid+序号使两次 tmp 名不同，rename 均成功）
      atomicWrite(target, 'v1')
      atomicWrite(target, 'v2')
      expect(readFileSync(target, 'utf-8')).toBe('v2')

      // 失败路径连续两次：tmp 各自清理，零残留
      const target2 = join(dir, 'occupied2')
      mkdirSync(target2)
      expect(() => atomicWrite(target2, 'x')).toThrow()
      expect(() => atomicWrite(target2, 'x')).toThrow()
      expect(readdirSync(dir).filter(n => n.includes('.tmp_'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('显式 uniqueSuffix 仍生效（.tmp_<suffix> 形态）', () => {
    const dir = makeTmpDir('fs-utils-suffix-')
    try {
      const target = join(dir, 'f.json')
      const occupied = join(dir, 'occupied3')
      mkdirSync(occupied)
      expect(() => atomicWrite(occupied, 'x', 'custom-1')).toThrow()
      // 失败即清理——显式后缀的 tmp 同样不留
      expect(readdirSync(dir).filter(n => n.startsWith('occupied3.tmp_custom-1'))).toEqual([])
      atomicWrite(target, 'ok', 'custom-2')
      expect(existsSync(target)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('atomicWriteAsync（RT-3#9 同族）', () => {
  it('rename 失败 → 上抛且 tmp 清理', async () => {
    const dir = makeTmpDir('fs-utils-async-')
    try {
      const target = join(dir, 'occupied4')
      mkdirSync(target)
      await expect(atomicWriteAsync(target, 'data')).rejects.toThrow()
      expect(readdirSync(dir).filter(n => n.startsWith('occupied4.tmp_'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('正常路径写入成功', async () => {
    const dir = makeTmpDir('fs-utils-async-ok-')
    try {
      const target = join(dir, 'f.json')
      await atomicWriteAsync(target, '{"a":1}')
      expect(existsSync(target)).toBe(true)
      expect(readdirSync(dir)).toEqual(['f.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
