import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdtempSync, rm, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { cleanupAgedBackupResidue, JsonStore, WriteBackCache } from '../src/utils/json-store.js'
import { atomicWrite } from '../src/utils/fs-utils.js'

const mkdtempP = promisify(mkdtemp)
const rmP = promisify(rm)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtempP(join(tmpdir(), 'json-store-test-'))
})

afterEach(async () => {
  await rmP(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 读回某分区文件，断言文件存在并返回解析结果。 */
function readPart(dir: string, k: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'parts', `${k}.json`), 'utf-8')) as Record<string, unknown>
}

/** 真实临时目录的 backing：每分区一个 JSON 文件。 */
function makeBacking(dir: string) {
  mkdirSync(join(dir, 'parts'), { recursive: true })
  const partitionPath = (k: string): string => join(dir, 'parts', `${k}.json`)
  return {
    partitionPath,
    loadPartition(k: string): Map<string, unknown> {
      try {
        const raw = readFileSync(join(dir, 'parts', `${k}.json`), 'utf-8')
        return new Map(Object.entries(JSON.parse(raw) as Record<string, unknown>))
      } catch {
        return new Map()
      }
    },
    persistPartition(k: string, data: Map<string, unknown>): void {
      const obj: Record<string, unknown> = Object.fromEntries(data)
      atomicWrite(join(dir, 'parts', `${k}.json`), JSON.stringify(obj))
    },
  }
}

// ── JsonStore ──────────────────────────────────────────────────────────

describe('JsonStore', () => {
  describe('read', () => {
    it('returns defaultValue when file does not exist (ENOENT)', () => {
      const store = new JsonStore(join(tmpDir, 'missing.json'), { count: 0 })
      expect(store.read()).toEqual({ count: 0 })
    })

    it('reads and parses existing file', () => {
      const path = join(tmpDir, 'data.json')
      writeFileSync(path, JSON.stringify({ count: 42 }), 'utf-8')
      const store = new JsonStore<{ count: number }>(path, { count: 0 })
      expect(store.read()).toEqual({ count: 42 })
    })

    it('returns defaultValue on corrupt JSON', () => {
      // D1c 后损坏文件走 error 级隔离日志，mock 掉避免测试输出噪音
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const path = join(tmpDir, 'corrupt.json')
      writeFileSync(path, '{ not valid json', 'utf-8')
      const store = new JsonStore<{ count: number }>(path, { count: 0 })
      expect(store.read()).toEqual({ count: 0 })
      errorSpy.mockRestore()
    })

    it('serves cached value without reloading disk while fingerprint matches', () => {
      const path = join(tmpDir, 'hit.json')
      writeFileSync(path, JSON.stringify({ v: 1 }), 'utf-8')
      const store = new JsonStore<{ v: number }>(path, { v: 0 })
      expect(store.read()).toEqual({ v: 1 })
      const loadSpy = vi.spyOn(store as unknown as { readFromDisk: () => unknown }, 'readFromDisk')
      expect(store.read()).toEqual({ v: 1 })
      // 指纹一致：零盘读，热路径成本 = 一次 stat syscall
      expect(loadSpy).not.toHaveBeenCalled()
    })

    it('re-reads disk when external write changes mtime with identical size', () => {
      const path = join(tmpDir, 'mtime.json')
      const before = JSON.stringify({ v: 1 })
      const after = JSON.stringify({ v: 2 })
      expect(Buffer.byteLength(before)).toBe(Buffer.byteLength(after)) // size 恒定 → 失配必来自 mtime 族
      writeFileSync(path, before, 'utf-8')
      const store = new JsonStore<{ v: number }>(path, { v: 0 })
      expect(store.read()).toEqual({ v: 1 })
      writeFileSync(path, after, 'utf-8') // 外部原地改写：size 不变、mtime 变
      expect(store.read()).toEqual({ v: 2 })
    })

    it('re-reads disk when file size changes', () => {
      const path = join(tmpDir, 'size.json')
      writeFileSync(path, JSON.stringify({ v: 1 }), 'utf-8')
      const store = new JsonStore<{ v: number }>(path, { v: 0 })
      expect(store.read()).toEqual({ v: 1 })
      writeFileSync(path, JSON.stringify({ v: 22222 }), 'utf-8') // 外部改写：size 变
      expect(store.read()).toEqual({ v: 22222 })
    })

    it('serves defaultValue after external file deletion, stably on repeated reads', () => {
      const path = join(tmpDir, 'gone.json')
      writeFileSync(path, JSON.stringify({ v: 1 }), 'utf-8')
      const store = new JsonStore<{ v: number }>(path, { v: 0 })
      expect(store.read()).toEqual({ v: 1 })
      unlinkSync(path)
      // stat ENOENT → 丢缓存 → 读盘 ENOENT 容错 → 默认值（文件被外部删 = 外部写的一种）
      expect(store.read()).toEqual({ v: 0 })
      // 文件持续缺失：默认值缓存（revision undefined）稳定命中，不反复触盘读
      expect(store.read()).toEqual({ v: 0 })
    })

    it('returns cached value with warn when stat probe fails (non-ENOENT)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const blocker = join(tmpDir, 'blocker')
      const path = join(blocker, 'f.json')
      mkdirSync(blocker, { recursive: true })
      writeFileSync(path, JSON.stringify({ v: 1 }), 'utf-8')
      const store = new JsonStore<{ v: number }>(path, { v: 0 })
      expect(store.read()).toEqual({ v: 1 })

      // blocker 目录替换为同名普通文件 → stat(f.json) 抛 ENOTDIR（非 ENOENT，真实 fs 异常）
      rmSync(blocker, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      writeFileSync(blocker, 'x', 'utf-8')

      const loadSpy = vi.spyOn(store as unknown as { readFromDisk: () => unknown }, 'readFromDisk')
      expect(store.read()).toEqual({ v: 1 }) // 探针失败 ≠ 文件变更，不否定缓存
      expect(loadSpy).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const warnMsg = String(warnSpy.mock.calls[0]!.join(' '))
      expect(warnMsg).toContain('stat 探针失败')
      expect(warnMsg).toContain(path)
      expect(warnMsg).toContain('权限')
      warnSpy.mockRestore()
    })

    it('deserialize hook shapes raw value', () => {
      const path = join(tmpDir, 'shape.json')
      writeFileSync(path, JSON.stringify({ providers: { a: {} } }), 'utf-8')
      const store = new JsonStore(path, { providers: {} }, {
        deserialize: (raw) => {
          const r = raw as { providers?: Record<string, unknown> }
          return { providers: r.providers ?? {} }
        },
      })
      expect(store.read()).toEqual({ providers: { a: {} } })
    })
  })

  // ── D1c 损坏隔离：parse 失败 / 读失败(非 ENOENT) → rename .corrupt-<ts> + error 日志 + 默认值 ──
  describe('corrupt quarantine (D1c)', () => {
    const FROZEN_ISO = '2026-01-01T00:00:00.000Z'
    let errorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(FROZEN_ISO))
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      errorSpy.mockRestore()
      vi.useRealTimers()
    })

    /** fake timers 下的确定性强副本路径（ISO 压缩格式：去冒号/点号）。 */
    function expectedCorruptPath(path: string): string {
      return `${path}.corrupt-${FROZEN_ISO.replace(/[:.]/g, '')}`
    }

    it('半截 JSON → 返回默认值，原文隔离至 .corrupt-<ts> 副本且内容不变，原文件移走', () => {
      const path = join(tmpDir, 'half.json')
      const halfJson = '{"providers": {"a": {"ap' // 模拟写盘半途崩溃的磁盘残留
      writeFileSync(path, halfJson, 'utf-8')

      const store = new JsonStore(path, { providers: {} })
      expect(store.read()).toEqual({ providers: {} }) // 返回默认值

      const corruptPath = expectedCorruptPath(path)
      expect(existsSync(corruptPath)).toBe(true) // 副本存在
      expect(readFileSync(corruptPath, 'utf-8')).toBe(halfJson) // 内容 = 原文（取证现场）
      expect(existsSync(path)).toBe(false) // 原文件已移走（不会被默认值写回合法化）

      // error 日志含路径与恢复指引
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const logMsg = String(errorSpy.mock.calls[0]!.join(' '))
      expect(logMsg).toContain('parse failed')
      expect(logMsg).toContain(path)
      expect(logMsg).toContain(corruptPath)
      expect(logMsg).toContain('恢复指引')
    })

    it('隔离后 write 写全新合法文件，.corrupt 副本保留（失败模式 A 断链）', () => {
      const path = join(tmpDir, 'recover.json')
      writeFileSync(path, '{ broken', 'utf-8')
      const store = new JsonStore<Record<string, unknown>>(path, {})

      expect(store.read()).toEqual({}) // 损坏 → 默认值
      store.write({ fresh: true }) // 后续写不应被半截文件污染

      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ fresh: true }) // 新文件合法
      expect(readFileSync(expectedCorruptPath(path), 'utf-8')).toBe('{ broken') // 现场仍在
    })

    it('读错误(非 ENOENT，path 是目录 → EISDIR)同样隔离现场后降级', () => {
      const path = join(tmpDir, 'as-dir.json')
      mkdirSync(path) // readFileSync 对目录抛 EISDIR（非 ENOENT → 走隔离分支）

      const store = new JsonStore(path, { n: 0 })
      expect(store.read()).toEqual({ n: 0 })

      expect(existsSync(path)).toBe(false) // 被移走
      expect(existsSync(expectedCorruptPath(path))).toBe(true)
      expect(String(errorSpy.mock.calls[0]!.join(' '))).toContain('read failed')
    })

    it('rename 失败 → 原文件保留原位、仍返回默认值、日志升级提示人工介入', () => {
      const path = join(tmpDir, 'locked.json')
      writeFileSync(path, '{ broken', 'utf-8')
      // 预占 .corrupt 目标为目录 → renameSync(file, dir) 必然抛错（隔离失败模拟：目录只读等）
      mkdirSync(expectedCorruptPath(path))

      const store = new JsonStore(path, { n: 0 })
      expect(store.read()).toEqual({ n: 0 })

      expect(readFileSync(path, 'utf-8')).toBe('{ broken') // 现场保留原位
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const logMsg = String(errorSpy.mock.calls[0]!.join(' '))
      expect(logMsg).toContain('损坏隔离失败')
      expect(logMsg).toContain('人工检查')
    })
  })

  describe('write', () => {
    it('writes value to disk and refreshes cache', () => {
      const path = join(tmpDir, 'write.json')
      const store = new JsonStore<{ n: number }>(path, { n: 0 })
      store.write({ n: 5 })
      expect(store.read()).toEqual({ n: 5 })
      expect(readFileSync(path, 'utf-8')).toBe(JSON.stringify({ n: 5 }, null, 2))
    })

    it('respects indent option', () => {
      const path = join(tmpDir, 'indent.json')
      const store = new JsonStore<{ n: number }>(path, { n: 0 }, { indent: 4 })
      store.write({ n: 1 })
      expect(readFileSync(path, 'utf-8')).toBe(JSON.stringify({ n: 1 }, null, 4))
    })

    it('external changes after write are visible on next read (fingerprint mismatch)', () => {
      const path = join(tmpDir, 'write-cache.json')
      const store = new JsonStore<{ n: number }>(path, { n: 0 })
      store.write({ n: 9 })
      writeFileSync(path, JSON.stringify({ n: 99 }), 'utf-8')
      expect(store.read()).toEqual({ n: 99 })
    })
  })

  describe('invalidate', () => {
    it('forces next read to hit disk', () => {
      const path = join(tmpDir, 'inv.json')
      writeFileSync(path, JSON.stringify({ v: 1 }), 'utf-8')
      const store = new JsonStore<{ v: number }>(path, { v: 0 })
      expect(store.read()).toEqual({ v: 1 })
      writeFileSync(path, JSON.stringify({ v: 2 }), 'utf-8')
      store.invalidate()
      expect(store.read()).toEqual({ v: 2 })
    })
  })

  describe('shouldDeleteWhen', () => {
    it('removes file when predicate returns true', () => {
      const path = join(tmpDir, 'empty-del.json')
      const store = new JsonStore<{ items: string[] }>(path, { items: [] }, {
        shouldDeleteWhen: (v) => v.items.length === 0,
      })
      store.write({ items: ['x'] })
      expect(existsSync(path)).toBe(true)
      store.write({ items: [] })
      expect(existsSync(path)).toBe(false)
    })

    it('keeps file with empty object by default (no predicate)', () => {
      const path = join(tmpDir, 'empty-keep.json')
      const store = new JsonStore<Record<string, never>>(path, {})
      store.write({})
      expect(readFileSync(path, 'utf-8')).toBe('{}')
    })
  })
})

// ── WriteBackCache ─────────────────────────────────────────────────────

describe('WriteBackCache', () => {
  describe('get / set / delete / keys / has', () => {
    it('set then get returns value (in-memory)', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      expect(cache.get('p1', 'a')).toBe(1)
    })

    it('get on missing key returns undefined', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      expect(cache.get('p1', 'nope')).toBe(undefined)
    })

    it('delete removes value', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 'hello')
      cache.delete('p1', 'a')
      expect(cache.get('p1', 'a')).toBe(undefined)
    })

    it('keys returns all keys in partition', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      cache.set('p1', 'b', 2)
      cache.set('p1', 'c', 3)
      expect(cache.keys('p1').sort()).toEqual(['a', 'b', 'c'])
    })

    it('partitions are isolated by partition key', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      cache.set('p2', 'a', 2)
      expect(cache.get('p1', 'a')).toBe(1)
      expect(cache.get('p2', 'a')).toBe(2)
    })

    it('has reports membership', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      expect(cache.has('p1', 'a')).toBe(true)
      expect(cache.has('p1', 'b')).toBe(false)
    })

    it('partitionKeys enumerates loaded partitions', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      cache.set('p2', 'a', 2)
      expect(cache.partitionKeys().sort()).toEqual(['p1', 'p2'])
    })

    it('overwriting a key updates partition size', () => {
      const calls: number[] = []
      const cache = new WriteBackCache(
        makeBacking(tmpDir),
        {},
        (_k, _ik, _v, partitionSize) => calls.push(partitionSize),
      )
      cache.set('p1', 'a', 'short')
      cache.set('p1', 'a', 'a much longer value than before')
      // 第二次 partitionSize 不应叠加第一次（覆盖而非新增）
      expect(calls[1]).toBeLessThan(calls[0]! + 1000)
    })
  })

  describe('flush', () => {
    it('flush persists dirty partition to disk', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      cache.flush('p1')
      expect(readPart(tmpDir, 'p1')).toEqual({ a: 1 })
    })

    it('flush is a no-op when partition is clean', () => {
      const backing = makeBacking(tmpDir)
      backing.persistPartition('p1', new Map([['a', 1]]))
      const cache = new WriteBackCache(backing)
      cache.get('p1', 'a')
      cache.flush('p1')
      expect(cache.get('p1', 'a')).toBe(1)
    })

    it('flushAll persists all dirty partitions', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      cache.set('p2', 'b', 2)
      cache.flushAll()
      expect(readPart(tmpDir, 'p1')).toEqual({ a: 1 })
      expect(readPart(tmpDir, 'p2')).toEqual({ b: 2 })
    })

    it('persisted data is reloadable via new cache instance', () => {
      const cache1 = new WriteBackCache(makeBacking(tmpDir))
      cache1.set('p1', 'persistent', 'val-99')
      cache1.flush('p1')
      const cache2 = new WriteBackCache(makeBacking(tmpDir))
      expect(cache2.get('p1', 'persistent')).toBe('val-99')
    })

    it('delete then flush removes key from disk', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      cache.set('p1', 'b', 2)
      cache.flush('p1')
      cache.delete('p1', 'a')
      cache.flush('p1')
      expect(readPart(tmpDir, 'p1')).toEqual({ b: 2 })
    })

    // W0: flush 持久化失败时不抛异常、记日志、保留 dirty（下次 flush 重试）
    it('flush 失败时不抛异常且记 console.error（W0 异常隔离）', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // persistPartition 抛错模拟盘满/权限不足
      const backing = makeBacking(tmpDir)
      backing.persistPartition = vi.fn(() => { throw new Error('disk full') })
      const cache = new WriteBackCache(backing, { flushMs: 500 })

      cache.set('p1', 'a', 1)

      // flush 不抛（修复前会抛 → setTimeout 回调内变 uncaughtException → crash）
      expect(() => cache.flush('p1')).not.toThrow()

      // 记录了错误日志
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const logMsg = String(errorSpy.mock.calls[0]!.join(' '))
      expect(logMsg).toContain('flush failed')
      expect(logMsg).toContain('disk full')

      // persistPartition 被调用（flush 尝试了持久化）
      expect(backing.persistPartition).toHaveBeenCalledTimes(1)

      errorSpy.mockRestore()
    })

    it('flush 失败后保留 dirty，下次 flush 重试 persistPartition（W0）', () => {
      vi.useFakeTimers()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const backing = makeBacking(tmpDir)
      const realPersist = backing.persistPartition.bind(backing)
      let failCount = 0
      backing.persistPartition = vi.fn((k: string, data: Map<string, unknown>) => {
        failCount++
        if (failCount <= 1) throw new Error('transient error')
        realPersist(k, data) // 第二次成功，执行真实落盘
      })
      const cache = new WriteBackCache(backing, { flushMs: 500 })

      cache.set('p1', 'a', 1)

      // 第一次 flush 失败
      cache.flush('p1')
      expect(backing.persistPartition).toHaveBeenCalledTimes(1)

      // flush 内 scheduleFlush(500) 安排了重试 → advance 触发第二次 flush
      vi.advanceTimersByTime(500)
      // 第二次 flush 重试成功（failCount=2 不再抛，真实落盘）
      expect(backing.persistPartition).toHaveBeenCalledTimes(2)
      expect(readPart(tmpDir, 'p1')).toEqual({ a: 1 })

      errorSpy.mockRestore()
      vi.useRealTimers()
    })

    it('flush 成功路径不重试 persistPartition（W0 回归）', () => {
      vi.useFakeTimers()
      const backing = makeBacking(tmpDir)
      backing.persistPartition = vi.fn(backing.persistPartition)
      const cache = new WriteBackCache(backing, { flushMs: 500 })

      cache.set('p1', 'a', 1)
      cache.flush('p1')

      expect(backing.persistPartition).toHaveBeenCalledTimes(1)
      // advance 不会触发额外 flush（dirty 已清，scheduleFlush 不会再调 persistPartition）
      vi.advanceTimersByTime(1000)
      expect(backing.persistPartition).toHaveBeenCalledTimes(1)

      vi.useRealTimers()
    })
  })

  describe('onSet (capacity check)', () => {
    it('invokes onSet before write with sizes', () => {
      const calls: Array<{ ik: string; valueSize: number; partitionSize: number }> = []
      const cache = new WriteBackCache(
        makeBacking(tmpDir),
        {},
        (_k, ik, _v, partitionSize, valueSize) => {
          calls.push({ ik, valueSize, partitionSize })
        },
      )
      cache.set('p1', 'a', 'hello')
      cache.set('p1', 'b', 'world')
      expect(calls).toHaveLength(2)
      expect(calls[0]!.ik).toBe('a')
      expect(calls[1]!.partitionSize).toBeGreaterThan(calls[0]!.partitionSize)
    })

    it('rejects write when onSet throws', () => {
      const cache = new WriteBackCache(
        makeBacking(tmpDir),
        {},
        (_k, _ik, _v, partitionSize) => {
          if (partitionSize > 100) throw Object.assign(new Error('too big'), { code: -32040 })
        },
      )
      cache.set('p1', 'a', 'x'.repeat(50))
      expect(() => cache.set('p1', 'b', 'x'.repeat(60))).toThrow()
      expect(cache.get('p1', 'a')).toBeDefined()
      expect(cache.get('p1', 'b')).toBeUndefined()
    })
  })

  describe('onExternalChange', () => {
    it('drops specified partition so next access reloads', () => {
      const backing = makeBacking(tmpDir)
      const cache = new WriteBackCache(backing)
      cache.set('p1', 'a', 1)
      cache.flush('p1')
      backing.persistPartition('p1', new Map([['a', 999], ['c', 3]]))
      cache.onExternalChange('p1')
      expect(cache.get('p1', 'a')).toBe(999)
      expect(cache.get('p1', 'c')).toBe(3)
    })

    it('drops all partitions when called without arg', () => {
      const backing = makeBacking(tmpDir)
      const cache = new WriteBackCache(backing)
      cache.set('p1', 'a', 1)
      cache.set('p2', 'b', 2)
      cache.flushAll()
      backing.persistPartition('p1', new Map([['a', 111]]))
      cache.onExternalChange()
      expect(cache.get('p1', 'a')).toBe(111)
    })
  })

  // ── stat 校验与冲突备份（cache-governance §3.2.4：读侧外部优先、写侧内存优先 + 备份出声）──
  describe('stat 校验与冲突备份', () => {
    const FROZEN_ISO = '2026-01-01T00:00:00.000Z'

    it('非 dirty 分区外部改动在下一次读生效（指纹失配 → drop + 重载）', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      expect(cache.get('p1', 'a')).toBe(undefined) // 触发 lazy load（文件尚不存在）
      writeFileSync(join(tmpDir, 'parts', 'p1.json'), JSON.stringify({ a: 'external', b: 'new' }), 'utf-8')
      expect(cache.get('p1', 'a')).toBe('external')
      expect(cache.get('p1', 'b')).toBe('new')
    })

    it('外部删除返空重载（stat ENOENT → drop → loadPartition ENOENT 容错返空 Map）', () => {
      const backing = makeBacking(tmpDir)
      backing.persistPartition('p1', new Map([['a', 1]]))
      const cache = new WriteBackCache(backing)
      expect(cache.get('p1', 'a')).toBe(1)
      unlinkSync(join(tmpDir, 'parts', 'p1.json'))
      expect(cache.get('p1', 'a')).toBe(undefined)
      // 文件持续缺失：undefined 指纹与加载时相等，稳定命中不抖动重载
      expect(cache.get('p1', 'a')).toBe(undefined)
    })

    it('dirty 分区跳过读侧校验（外部改动 dirty 窗口内不可见，不 drop 连带丢写）', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 'memory') // 分区转 dirty
      // dirty 窗口内外部改盘；若未跳过校验，get 会 drop 重载返回外部值
      writeFileSync(join(tmpDir, 'parts', 'p1.json'), JSON.stringify({ a: 'external' }), 'utf-8')
      expect(cache.get('p1', 'a')).toBe('memory')
    })

    it('flush 撞外部改动：先备份 .conflict-<ts> 再覆写，warn 含双路径与恢复指引', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(FROZEN_ISO))
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const backing = makeBacking(tmpDir)
      backing.persistPartition('p1', new Map([['a', 'initial']]))
      const path = join(tmpDir, 'parts', 'p1.json')
      const cache = new WriteBackCache(backing)
      expect(cache.get('p1', 'a')).toBe('initial') // 加载：loadRevision = 当前指纹
      cache.set('p1', 'a', 'memory') // dirty
      writeFileSync(path, JSON.stringify({ a: 'external' }), 'utf-8') // dirty 窗口内外部改
      cache.flush('p1')

      // 照常覆写：盘 = 内存值（内存优先）
      expect(readPart(tmpDir, 'p1')).toEqual({ a: 'memory' })
      // 备份存在且内容 = 覆写前磁盘态（外部改动可从 .conflict 找回）
      const backupPath = `${path}.conflict-${FROZEN_ISO.replace(/[:.]/g, '')}`
      expect(existsSync(backupPath)).toBe(true)
      expect(readFileSync(backupPath, 'utf-8')).toBe(JSON.stringify({ a: 'external' }))
      // warn 含原文件与备份双路径 + 恢复指引
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const msg = String(warnSpy.mock.calls[0]!.join(' '))
      expect(msg).toContain(path)
      expect(msg).toContain(backupPath)
      expect(msg).toContain('.conflict')
      warnSpy.mockRestore()
      vi.useRealTimers()
    })

    it('flush 无冲突不产生备份文件、不出 warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const cache = new WriteBackCache(makeBacking(tmpDir))
      expect(cache.get('p1', 'a')).toBe(undefined)
      cache.set('p1', 'a', 1)
      cache.flush('p1')
      expect(readPart(tmpDir, 'p1')).toEqual({ a: 1 })
      const conflictFiles = readdirSync(join(tmpDir, 'parts')).filter((f) => f.includes('.conflict-'))
      expect(conflictFiles).toEqual([])
      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('persistPartition 失败保留 dirty，重试成功落盘（W0 现状在冲突检测路径下不回归）', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const backing = makeBacking(tmpDir)
      const realPersist = backing.persistPartition.bind(backing)
      let failCount = 0
      backing.persistPartition = vi.fn((k: string, data: Map<string, unknown>) => {
        failCount++
        if (failCount <= 1) throw new Error('disk full')
        realPersist(k, data)
      })
      const cache = new WriteBackCache(backing)
      cache.set('p1', 'a', 1)

      expect(() => cache.flush('p1')).not.toThrow()
      expect(existsSync(join(tmpDir, 'parts', 'p1.json'))).toBe(false)

      cache.flush('p1') // dirty 保留 → 重试成功落盘
      expect(readPart(tmpDir, 'p1')).toEqual({ a: 1 })
      expect(errorSpy).toHaveBeenCalledTimes(1)
      errorSpy.mockRestore()
    })

    it('flush 后刷新指纹：再次外部改动在下一次读生效（flush 不固化旧指纹）', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 'v1')
      cache.flush('p1')
      writeFileSync(join(tmpDir, 'parts', 'p1.json'), JSON.stringify({ a: 'external' }), 'utf-8')
      expect(cache.get('p1', 'a')).toBe('external')
    })
  })

  describe('dispose', () => {
    it('clears pending timers without flushing', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir), { flushMs: 10_000 })
      cache.set('p1', 'a', 1)
      cache.dispose()
      expect(existsSync(join(tmpDir, 'parts', 'p1.json'))).toBe(false)
    })
  })

  describe('debounce', () => {
    it('schedules flush after flushMs', async () => {
      const cache = new WriteBackCache(makeBacking(tmpDir), { flushMs: 30 })
      cache.set('p1', 'a', 1)
      expect(existsSync(join(tmpDir, 'parts', 'p1.json'))).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(readPart(tmpDir, 'p1')).toEqual({ a: 1 })
    })

    it('debounces rapid writes into one flush', async () => {
      const cache = new WriteBackCache(makeBacking(tmpDir), { flushMs: 40 })
      cache.set('p1', 'a', 1)
      await new Promise(resolve => setTimeout(resolve, 20))
      cache.set('p1', 'b', 2)
      await new Promise(resolve => setTimeout(resolve, 80))
      // 两次写合并成一次 flush
      expect(readPart(tmpDir, 'p1')).toEqual({ a: 1, b: 2 })
    })
  })
})

describe('cleanupAgedBackupResidue（备份残留按龄回收）', () => {
  const OLD_ISO = '2020-01-01T000000000Z'
  const RECENT_ISO = new Date().toISOString().replace(/[:.]/g, '')

  function makeScanRoot(): string {
    return mkdtempSync(join(tmpdir(), 'aged-backup-'))
  }

  it('超龄 ISO 后缀备份删除；龄内保留；非 ISO 后缀不动；一层子目录展开命中（plugins/<id>/ 形态）', () => {
    const root = makeScanRoot()
    try {
      const pluginDir = join(root, 'plugins', 'my-plugin')
      mkdirSync(pluginDir, { recursive: true })
      // ① 子目录层超龄副本（plugin-storage quarantine 落点形态）
      writeFileSync(join(pluginDir, `globalState.json.corrupt-${OLD_ISO}`), 'corrupt old')
      // ② 根层龄内副本（取证窗口内保留）
      writeFileSync(join(root, `settings.json.conflict-${RECENT_ISO}`), 'conflict recent')
      // ③ 非 ISO 后缀（用户文件误撞前缀）
      writeFileSync(join(root, 'notes.corrupt-anything'), 'user file')
      // ④ 根层超龄副本
      writeFileSync(join(root, `models.json.conflict-${OLD_ISO}`), 'conflict old')

      const removed = cleanupAgedBackupResidue([root, join(root, 'plugins')])

      expect(removed).toBe(2)
      expect(existsSync(join(pluginDir, `globalState.json.corrupt-${OLD_ISO}`))).toBe(false)
      expect(existsSync(join(root, `models.json.conflict-${OLD_ISO}`))).toBe(false)
      expect(existsSync(join(root, `settings.json.conflict-${RECENT_ISO}`))).toBe(true)
      expect(existsSync(join(root, 'notes.corrupt-anything'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('目录不存在 no-op（返回 0 不抛）', () => {
    expect(cleanupAgedBackupResidue([join(tmpdir(), 'no-such-aged-backup-dir')])).toBe(0)
  })
})
