/**
 * SessionData Local Cache + Flush — TDD tests for BG2 Task 4 (P0-1 C6 重写)
 *
 * 经 SessionDataStore 的公共 KV API（get/set/delete/keys/flush）验证：
 *   - 容量上限（per-session，默认 10MB）
 *   - flush 语义（dirty → 持久化 → 可重载）
 *   - 定时 flush（5s interval）
 *   - clearSession 清理
 * 内部 dirty/cache/size 由 WriteBackCache 封装，测试不再直接触碰内部 Map。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { registerSessionDataRpcHandlers } from '../src/services/plugin-service/api/session-data-api.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import { PluginRpcErrorCodes } from '../src/services/plugin-service/plugin-types.js'
import type { RpcResponse } from '../src/services/plugin-service/plugin-types.js'
import { SessionDataStore } from '../src/services/plugin-service/session-data-store.js'

const mkdtempP = promisify(mkdtemp)
const rmP = promisify(rm)

const MAX_TEST_SIZE = 200 // Small limit for capacity test

/** Build a mock RPC port that captures dispatched responses */
function createCapturingPort() {
  const sent: unknown[] = []
  return {
    port: { postMessage: (msg: unknown) => sent.push(msg) },
    sent,
  }
}

// ══════════════════════════════════════════════════════════════════
// SessionData RPC Handlers — cache, capacity, keys
// ══════════════════════════════════════════════════════════════════

describe('SessionData RPC Handlers (Cache + Capacity)', () => {
  let rpcServer: PluginRpcServer
  let store: SessionDataStore
  let capturingPort: ReturnType<typeof createCapturingPort>
  let nextId = 1

  beforeEach(() => {
    rpcServer = new PluginRpcServer()
    store = new SessionDataStore('', MAX_TEST_SIZE)
    capturingPort = createCapturingPort()
    rpcServer.registerWorker('worker-1', capturingPort.port)
    nextId = 1

    registerSessionDataRpcHandlers(rpcServer, {
      get: (sid, key) => store.get(sid, key),
      set: (sid, key, val) => store.set(sid, key, val),
      delete: (sid, key) => store.delete(sid, key),
      keys: (sid) => store.keys(sid),
    })
  })

  /** Dispatch an RPC request and return the response */
  async function dispatch(
    method: string,
    params: Record<string, unknown>,
  ): Promise<RpcResponse> {
    capturingPort.sent.length = 0
    const id = nextId++
    await rpcServer.dispatch('worker-1', {
      jsonrpc: '2.0',
      id,
      method,
      params: { pluginId: 'test-plugin', ...params },
    })
    const msg = capturingPort.sent[0] as { response: RpcResponse }
    return msg.response
  }

  // ── TC-4-01: Cache write + read ──────────────────────────────
  it('cache write + read', async () => {
    const setResp = await dispatch('plugin.sessionData.set', {
      sessionId: 's1', key: 'k1', value: 'hello',
    })
    expect((setResp as { result?: unknown }).result).toBeUndefined()

    const getResp = await dispatch('plugin.sessionData.get', {
      sessionId: 's1', key: 'k1',
    })
    expect((getResp as { result: unknown }).result).toBe('hello')

    const missResp = await dispatch('plugin.sessionData.get', {
      sessionId: 's1', key: 'nope',
    })
    expect((missResp as { result?: unknown }).result).toBeUndefined()
  })

  // ── TC-4-03: Cache works without bridge ─────────────────────
  it('cache works without bridge (no flush needed for read)', async () => {
    await dispatch('plugin.sessionData.set', {
      sessionId: 's1', key: 'k1', value: 'v1',
    })
    expect(store.get('s1', 'k1')).toBe('v1')
  })

  // ── TC-4-04: Capacity limit ──────────────────────────────────
  it('capacity limit: over maxSize → STORAGE_FULL error', async () => {
    const okResp = await dispatch('plugin.sessionData.set', {
      sessionId: 's1', key: 'k1', value: 'a'.repeat(50),
    })
    expect((okResp as { result: unknown }).result).toBeUndefined()

    const overResp = await dispatch('plugin.sessionData.set', {
      sessionId: 's1', key: 'k2', value: 'b'.repeat(MAX_TEST_SIZE),
    })
    expect((overResp as { error?: { code: number } }).error).toBeDefined()
    expect((overResp as { error?: { code: number } }).error!.code).toBe(PluginRpcErrorCodes.STORAGE_FULL)
  })

  // ── TC-4-07: keys returns correct list ────────────────────────
  it('keys returns correct list', async () => {
    await dispatch('plugin.sessionData.set', { sessionId: 's1', key: 'k1', value: 'v1' })
    await dispatch('plugin.sessionData.set', { sessionId: 's1', key: 'k2', value: 'v2' })

    const resp = await dispatch('plugin.sessionData.keys', { sessionId: 's1' })
    const keys = (resp as { result?: string[] }).result as string[]
    expect(keys.sort()).toEqual(['k1', 'k2'])
  })
})

// ══════════════════════════════════════════════════════════════════
// SessionData Flush + Lifecycle — SessionDataStore direct
// ══════════════════════════════════════════════════════════════════

describe('SessionDataStore Flush + Lifecycle', () => {
  let tmpDir: string
  let store: SessionDataStore

  beforeEach(async () => {
    tmpDir = await mkdtempP(join(tmpdir(), 'session-data-store-test-'))
    store = new SessionDataStore(tmpDir)
  })

  afterEach(async () => {
    store.dispose()
    await rmP(tmpDir, { recursive: true, force: true })
  })

  // ── flush persists dirty data to disk ────────────────────────
  it('flush persists dirty data to disk', () => {
    store.set('s1', 'k1', 'v1')
    store.flushSession('s1')
    const filePath = join(tmpDir, 'session-data', 's1.json')
    expect(existsSync(filePath)).toBe(true)
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(raw).toEqual({ k1: 'v1' })
  })

  // ── flush clears dirty (idempotent re-flush) ─────────────────
  it('flush is idempotent (re-flush of clean session is no-op)', () => {
    store.set('s1', 'k1', 'v1')
    store.flushSession('s1')
    // 第二次 flush 不应报错
    expect(() => store.flushSession('s1')).not.toThrow()
  })

  // ── delete removes key ───────────────────────────────────────
  it('delete removes key from cache', () => {
    store.set('s1', 'k1', 'v1')
    store.delete('s1', 'k1')
    expect(store.get('s1', 'k1')).toBeUndefined()
  })

  // ── flushAll persists all dirty sessions ─────────────────────
  it('flushAll persists all dirty sessions', () => {
    store.set('s1', 'k1', 'v1')
    store.set('s2', 'k2', 'v2')
    store.flushAll()
    expect(existsSync(join(tmpDir, 'session-data', 's1.json'))).toBe(true)
    expect(existsSync(join(tmpDir, 'session-data', 's2.json'))).toBe(true)
  })

  // ── persisted data reloadable via new store ──────────────────
  it('persisted data is reloadable via restoreFromDisk', () => {
    store.set('s1', 'persistent', 'val-99')
    store.flushSession('s1')
    const store2 = new SessionDataStore(tmpDir)
    store2.restoreFromDisk()
    expect(store2.get('s1', 'persistent')).toBe('val-99')
  })

  // ── clearSession removes cache + disk ────────────────────────
  it('clearSession removes cache and disk file', async () => {
    const trashCalls: string[] = []
    store = new SessionDataStore(tmpDir, undefined, undefined, async (p) => {
      trashCalls.push(p)
      rmSync(p, { force: true })
    })
    store.set('s1', 'k1', 'v1')
    store.flushSession('s1')
    expect(existsSync(join(tmpDir, 'session-data', 's1.json'))).toBe(true)
    // B5：clearSession 已 async（磁盘删除走 ITrash port 软删除，mock 同步移除文件）
    await store.clearSession('s1')
    expect(store.get('s1', 'k1')).toBeUndefined()
    expect(existsSync(join(tmpDir, 'session-data', 's1.json'))).toBe(false)
    expect(trashCalls).toEqual([join(tmpDir, 'session-data', 's1.json')])
  })

  // ── debounce flush 落盘 ────────────────────────────────────
  it('per-write debounce flush persists within 500ms', async () => {
    vi.useFakeTimers()
    // sid 唯一化：上一用例 clearSession 的 tombstone 是模块级共享态，复用 's1' 会被
    // B5 迟到写守卫丢弃（恰是该机制的正向证明，但与本用例目标无关）
    store.set('s1-debounce', 'k1', 'v1')
    // debounce flush at 500ms
    await vi.advanceTimersByTimeAsync(600)
    expect(existsSync(join(tmpDir, 'session-data', 's1-debounce.json'))).toBe(true)
    vi.useRealTimers()
  })

  // ── data not flushed immediately (debounce window) ──────────
  it('data not flushed immediately after set (within debounce window)', async () => {
    vi.useFakeTimers()
    store.set('s1', 'k1', 'v1')
    await vi.advanceTimersByTimeAsync(100) // well within 500ms debounce
    expect(existsSync(join(tmpDir, 'session-data', 's1.json'))).toBe(false)
    vi.useRealTimers()
  })

  // ── dispose clears pending debounce without flush ───────────
  it('dispose stops debounce timer: pending write never lands', async () => {
    vi.useFakeTimers()
    store.set('s1', 'k1', 'v1')
    store.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(existsSync(join(tmpDir, 'session-data', 's1.json'))).toBe(false)
    vi.useRealTimers()
  })
})
