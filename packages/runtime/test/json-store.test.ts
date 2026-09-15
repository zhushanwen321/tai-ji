import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { JsonStore, WriteBackCache } from '../src/utils/json-store.js'
import { atomicWrite } from '../src/utils/fs-utils.js'

const mkdtempP = promisify(mkdtemp)
const rmP = promisify(rm)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtempP(join(tmpdir(), 'json-store-test-'))
})

afterEach(async () => {
  await rmP(tmpDir, { recursive: true, force: true })
})

/** 读回某分区文件，断言文件存在并返回解析结果。 */
function readPart(dir: string, k: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'parts', `${k}.json`), 'utf-8')) as Record<string, unknown>
}

/** 真实临时目录的 backing：每分区一个 JSON 文件。 */
function makeBacking(dir: string) {
  mkdirSync(join(dir, 'parts'), { recursive: true })
  return {
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

    it('serves cached value within TTL', () => {
      const path = join(tmpDir, 'ttl.json')
      writeFileSync(path, JSON.stringify({ v: 1 }), 'utf-8')
      const store = new JsonStore<{ v: number }>(path, { v: 0 }, { ttlMs: 10_000 })
      expect(store.read()).toEqual({ v: 1 })
      writeFileSync(path, JSON.stringify({ v: 2 }), 'utf-8')
      expect(store.read()).toEqual({ v: 1 })
    })

    it('re-reads disk after TTL expires', async () => {
      const path = join(tmpDir, 'ttl-expire.json')
      writeFileSync(path, JSON.stringify({ v: 1 }), 'utf-8')
      const store = new JsonStore<{ v: number }>(path, { v: 0 }, { ttlMs: 20 })
      expect(store.read()).toEqual({ v: 1 })
      writeFileSync(path, JSON.stringify({ v: 2 }), 'utf-8')
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(store.read()).toEqual({ v: 2 })
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

    it('after write, cache blocks external changes', () => {
      const path = join(tmpDir, 'write-cache.json')
      const store = new JsonStore<{ n: number }>(path, { n: 0 }, { ttlMs: 60_000 })
      store.write({ n: 9 })
      writeFileSync(path, JSON.stringify({ n: 99 }), 'utf-8')
      expect(store.read()).toEqual({ n: 9 })
    })
  })

  describe('invalidate', () => {
    it('forces next read to hit disk', () => {
      const path = join(tmpDir, 'inv.json')
      writeFileSync(path, JSON.stringify({ v: 1 }), 'utf-8')
      const store = new JsonStore<{ v: number }>(path, { v: 0 }, { ttlMs: 60_000 })
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
