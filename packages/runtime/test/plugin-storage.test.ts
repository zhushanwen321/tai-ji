import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PluginStorage } from '../src/services/plugin-service/plugin-storage.js'

let tmpDir: string
let storage: PluginStorage

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-storage-test-'))
  storage = new PluginStorage()
  storage.init(tmpDir, '/test/project')
})

afterAll(async () => {
  storage.flushAll()
  storage.dispose()
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('PluginStorage', () => {
  // ── TC-5-01: get/set basic KV operations ──────────────────────
  it('TC-5-01: get/set basic KV operations', () => {
    const pluginId = 'test-getset'

    // get 对不存在的 key 返回 undefined
    const missing = storage.get(pluginId, 'nonexistent')
    expect(missing).toBe(undefined)

    // set → get
    storage.set(pluginId, 'name', 'hello')
    const val = storage.get(pluginId, 'name')
    expect(val).toBe('hello')

    // 覆盖写入
    storage.set(pluginId, 'name', 'world')
    const updated = storage.get(pluginId, 'name')
    expect(updated).toBe('world')
  })

  // ── TC-5-02: delete key ───────────────────────────────────────
  it('TC-5-02: delete key', () => {
    const pluginId = 'test-delete'

    storage.set(pluginId, 'toDelete', 42)
    const before = storage.get(pluginId, 'toDelete')
    expect(before).toBe(42)

    storage.delete(pluginId, 'toDelete')
    const after = storage.get(pluginId, 'toDelete')
    expect(after).toBe(undefined)
  })

  // ── TC-5-03: keys() returns all keys ──────────────────────────
  it('TC-5-03: keys() returns all keys', () => {
    const pluginId = 'test-keys'

    storage.set(pluginId, 'a', 1)
    storage.set(pluginId, 'b', 2)
    storage.set(pluginId, 'c', 3)

    const allKeys = storage.keys(pluginId)
    allKeys.sort()
    expect(allKeys).toEqual(['a', 'b', 'c'])
  })

  // ── TC-5-04: flush persists to disk, readable after restart ───
  it('TC-5-04: flush persists to disk, readable after restart', async () => {
    const pluginId = 'test-persist'

    storage.set(pluginId, 'persistent', 'value-123')
    storage.flush(pluginId)

    // 验证文件已写入
    const filePath = join(tmpDir, 'plugins', pluginId, 'globalState.json')
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, string>
    expect(parsed.persistent).toBe('value-123')

    // 新实例读取应能恢复数据
    const storage2 = new PluginStorage()
    storage2.init(tmpDir, '/test/project')
    const restored = storage2.get(pluginId, 'persistent')
    expect(restored).toBe('value-123')
  })

  // ── TC-5-05: rejects writes exceeding limit ───────────────────
  it('TC-5-05: rejects writes exceeding value size limit (1MB)', () => {
    const pluginId = 'test-limit'
    // JSON.stringify 会给字符串加引号，所以实际 > 1MB
    const bigValue = 'x'.repeat(1024 * 1024 + 2)

    try {
      storage.set(pluginId, 'big', bigValue)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as unknown as { code: number }).code).toBe(-32021)
    }
  })

  // ── D1c 对齐（P2#4）：损坏文件加载 → quarantine 隔离（非静默空 Map 覆写） ──
  it('corrupt JSON on load → quarantined to .corrupt-<ts> copy, then set/flush rebuilds clean file', async () => {
    const pluginId = 'test-corrupt-quarantine'
    const filePath = join(tmpDir, 'plugins', pluginId, 'globalState.json')
    await mkdir(join(tmpDir, 'plugins', pluginId), { recursive: true })
    const corruptContent = '{"broken": tru' // 半截 JSON（模拟崩溃窗口）
    await (await import('node:fs/promises')).writeFile(filePath, corruptContent, 'utf-8')

    const storageQ = new PluginStorage()
    storageQ.init(tmpDir, '/test/project')
    try {
      // 触发 lazy loadPartition：损坏 → quarantine rename + 空 Map 降级（get 返回 undefined）
      expect(storageQ.get(pluginId, 'anyKey')).toBe(undefined)

      // 原路径文件已被隔离移走；.corrupt-<ts> 副本保留损坏内容供人工恢复
      const dirEntries = await (await import('node:fs/promises')).readdir(join(tmpDir, 'plugins', pluginId))
      expect(dirEntries).not.toContain('globalState.json')
      const quarantineCopy = dirEntries.find((n) => /^globalState\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{9}Z$/.test(n))
      expect(quarantineCopy).toBeDefined()
      const quarantined = await readFile(join(tmpDir, 'plugins', pluginId, quarantineCopy!), 'utf-8')
      expect(quarantined).toBe(corruptContent)

      // set + flush：原路径重建干净文件（无冲突备份噪音——quarantine 后 stat ENOENT 放行重建）
      storageQ.set(pluginId, 'fresh', 'value')
      storageQ.flush(pluginId)
      const rebuilt = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, string>
      expect(rebuilt.fresh).toBe('value')
    } finally {
      storageQ.dispose()
    }
  })
})
