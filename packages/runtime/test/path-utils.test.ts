import { describe, it, expect } from 'vitest'
import { isStrictlyUnder, isUnderOrEqual, canonicalizePath } from '../src/utils/path-utils.js'
import { resolve } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'

describe('path-utils', () => {
  const parent = '/a/b'

  describe('isStrictlyUnder', () => {
    it('returns false when child equals parent', () => {
      expect(isStrictlyUnder(parent, parent)).toBe(false)
    })

    it('returns true when child is under parent', () => {
      expect(isStrictlyUnder(parent, '/a/b/c')).toBe(true)
    })

    it('returns false when child is outside parent', () => {
      expect(isStrictlyUnder(parent, '/a/other')).toBe(false)
    })

    it('returns false when child is a sibling prefix', () => {
      expect(isStrictlyUnder('/a/b', '/a/bc')).toBe(false)
    })

    it('handles trailing slash on parent', () => {
      expect(isStrictlyUnder('/a/b/', '/a/b/c')).toBe(true)
    })

    it('handles trailing slash on child', () => {
      expect(isStrictlyUnder('/a/b', '/a/b/c/')).toBe(true)
    })

    it('handles trailing slashes on both', () => {
      expect(isStrictlyUnder('/a/b/', '/a/b/c/')).toBe(true)
    })

    it('returns false when parent is deeper than child', () => {
      expect(isStrictlyUnder('/a/b/c', '/a/b')).toBe(false)
    })

    it('normalizes relative segments in child', () => {
      expect(isStrictlyUnder('/a/b', '/a/b/c/../d')).toBe(true)
    })

    it('returns false for relative child escaping parent', () => {
      expect(isStrictlyUnder('/a/b', '/a/b/c/../../other')).toBe(false)
    })
  })

  describe('isUnderOrEqual', () => {
    it('returns true when child equals parent', () => {
      expect(isUnderOrEqual(parent, parent)).toBe(true)
    })

    it('returns true when child is under parent', () => {
      expect(isUnderOrEqual(parent, '/a/b/c')).toBe(true)
    })

    it('returns false when child is outside parent', () => {
      expect(isUnderOrEqual(parent, '/a/other')).toBe(false)
    })

    it('returns true when child equals parent with trailing slashes', () => {
      expect(isUnderOrEqual('/a/b/', '/a/b/')).toBe(true)
    })

    it('handles mixed trailing slashes (equal paths)', () => {
      expect(isUnderOrEqual('/a/b/', '/a/b')).toBe(true)
    })

    it('returns false when child is a sibling prefix', () => {
      expect(isUnderOrEqual('/a/b', '/a/bc')).toBe(false)
    })

    it('returns false for deeply nested child escaping parent', () => {
      expect(isUnderOrEqual('/a/b', '/a/b/c/../../other')).toBe(false)
    })
  })

  describe('canonicalizePath', () => {
    it('returns realpath for an existing file', () => {
      const tmp = mkdtempSync(resolve(tmpdir(), 'canon-'))
      try {
        const filePath = resolve(tmp, 'real.txt')
        writeFileSync(filePath, 'x')
        // 存在的文件：realpathSync 返回解析后的绝对路径，不抛异常，且与多次调用一致
        const result = canonicalizePath(filePath)
        expect(() => canonicalizePath(filePath)).not.toThrow()
        expect(canonicalizePath(filePath)).toBe(result)
        // realpath 应与 tmp 的 realpath 同根（macOS 下 /tmp → /private/tmp）
        expect(result.endsWith('real.txt')).toBe(true)
      } finally {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it('returns original path when file does not exist (no throw)', () => {
      const nonexistent = '/nonexistent/path/should-not-exist-12345.txt'
      // 不抛异常，返回原值
      expect(() => canonicalizePath(nonexistent)).not.toThrow()
      expect(canonicalizePath(nonexistent)).toBe(nonexistent)
    })

    it('resolves symlink to its real target', () => {
      const tmp = mkdtempSync(resolve(tmpdir(), 'canon-link-'))
      try {
        const realFile = resolve(tmp, 'real-target.ts')
        writeFileSync(realFile, 'x')
        const linkPath = resolve(tmp, 'link.ts')
        symlinkSync(realFile, linkPath)
        // symlink 的 realpath 应解析为 real-target.ts，与直接访问 realFile 的 realpath 一致
        // 注意：macOS 下 /var → /private/var，realFile 本身未经 realpath，故用 canonicalizePath(realFile) 对比
        expect(canonicalizePath(linkPath)).toBe(canonicalizePath(realFile))
        // 两者 realpath 后都应以 real-target.ts 结尾
        expect(canonicalizePath(linkPath).endsWith('real-target.ts')).toBe(true)
      } finally {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })
})
