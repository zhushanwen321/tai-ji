/**
 * SEC-A5 插件路径注入防御测试
 *
 * 背景：sessionData 与 PluginStorage 的持久化路径此前由插件 RPC 传入的
 * sessionId / pluginId 直接 join 拼出（`${sessionId}.json`、`plugins/<pluginId>/…`），
 * API 入口 `params.sessionId as string` 零校验，`../../` 可越出数据目录
 * 读/写/删任意 .json。
 *
 * 本文件两层验证（均用真实临时目录验证文件系统副作用，不 mock fs）：
 *   1. RPC 入口层：session-data-api / storage-api 的全部方法拒绝遍历/非字符串
 *      标识符，返回 INVALID_SESSION_ID / INVALID_KEY / INVALID_PLUGIN_ID
 *      结构化错误（message 含白名单 regex 指导），且数据目录外零文件副作用。
 *   2. store 深度防御层：绕过 RPC 入口直接调 SessionDataStore / PluginStorage，
 *      path.resolve 防御同样拒绝越出数据目录的路径拼接。
 */

import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerSessionDataRpcHandlers } from '../src/services/plugin-service/api/session-data-api.js'
import { registerStorageRpcHandlers, storageHandlersFrom } from '../src/services/plugin-service/api/storage-api.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { RpcResponse } from '../src/services/plugin-service/plugin-types.js'
import { PluginStorage } from '../src/services/plugin-service/plugin-storage.js'
import { SessionDataStore } from '../src/services/plugin-service/session-data-store.js'

/** 白名单 regex（与 validation.ts / store 层错误 message 中的字面量一致） */
const SAFE_KEY_REGEX_LITERAL = '/^[A-Za-z0-9._-]{1,128}$/'

/** 捕获 dispatched RPC response 的 mock Worker port */
function createCapturingPort() {
  const sent: unknown[] = []
  return { port: { postMessage: (msg: unknown) => sent.push(msg) }, sent }
}

/** 建一个隔离的真实临时目录：root/config 作为数据目录（configDir），攻击目标即 root 本层 */
function makeTempRoot(): { root: string; configDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'plugin-injection-guard-'))
  const configDir = join(root, 'config')
  mkdirSync(configDir, { recursive: true })
  return {
    root,
    configDir,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  }
}

/** 构造 RPC 测试台：rpcServer + capturing port，返回 dispatch helper */
function makeRpcHarness() {
  const rpcServer = new PluginRpcServer()
  const capturing = createCapturingPort()
  rpcServer.registerWorker('worker-1', capturing.port)
  let nextId = 1
  const dispatch = async (method: string, params: Record<string, unknown>): Promise<RpcResponse> => {
    capturing.sent.length = 0
    await rpcServer.dispatch('worker-1', { jsonrpc: '2.0', id: nextId++, method, params })
    return (capturing.sent[0] as { response: RpcResponse }).response
  }
  return { rpcServer, dispatch }
}

function errorOf(resp: RpcResponse): { code?: unknown; message?: string } {
  expect(resp).toHaveProperty('error')
  return (resp as { error: { code?: unknown; message?: string } }).error
}

// ══════════════════════════════════════════════════════════════════
// 1. RPC 入口层 — sessionData
// ══════════════════════════════════════════════════════════════════

describe('SEC-A5 sessionData RPC entry validation', () => {
  it('SEC-A5: sessionData.set with sessionId "../../evil" returns INVALID_SESSION_ID with regex guidance and writes nothing outside the data dir', async () => {
    const { root, configDir, cleanup } = makeTempRoot()
    const store = new SessionDataStore(configDir)
    const { rpcServer, dispatch } = makeRpcHarness()
    registerSessionDataRpcHandlers(rpcServer, {
      get: (sid, key) => store.get(sid, key),
      set: (sid, key, val) => store.set(sid, key, val),
      delete: (sid, key) => store.delete(sid, key),
      keys: (sid) => store.keys(sid),
    })

    // '../../evil' → <configDir>/session-data/../../evil.json → resolve → <root>/evil.json
    const resp = await dispatch('plugin.sessionData.set', {
      sessionId: '../../evil', key: 'k', value: 'v',
    })
    const err = errorOf(resp)
    expect(err.code).toBe('INVALID_SESSION_ID')
    expect(err.message).toContain('sessionId')
    expect(err.message).toContain(SAFE_KEY_REGEX_LITERAL)

    // 文件系统副作用：数据目录外无新文件，session-data 目录根本未创建
    expect(existsSync(join(root, 'evil.json'))).toBe(false)
    expect(existsSync(join(root, 'config', 'session-data'))).toBe(false)

    store.dispose()
    cleanup()
  })

  it('SEC-A5: all four sessionData RPC methods reject traversal sessionId', async () => {
    const store = new SessionDataStore('')
    const { rpcServer, dispatch } = makeRpcHarness()
    registerSessionDataRpcHandlers(rpcServer, {
      get: (sid, key) => store.get(sid, key),
      set: (sid, key, val) => store.set(sid, key, val),
      delete: (sid, key) => store.delete(sid, key),
      keys: (sid) => store.keys(sid),
    })

    const cases: Array<[string, Record<string, unknown>]> = [
      ['plugin.sessionData.get', { sessionId: '../..', key: 'k' }],
      ['plugin.sessionData.set', { sessionId: '../..', key: 'k', value: 'v' }],
      ['plugin.sessionData.delete', { sessionId: '../..', key: 'k' }],
      ['plugin.sessionData.keys', { sessionId: '../..' }],
    ]
    for (const [method, params] of cases) {
      const err = errorOf(await dispatch(method, params))
      expect(err.code, `${method} should reject with INVALID_SESSION_ID`).toBe('INVALID_SESSION_ID')
      expect(err.message).toContain(SAFE_KEY_REGEX_LITERAL)
    }
    store.dispose()
  })

  it('SEC-A5: sessionData rejects traversal key "../../evil" with INVALID_KEY', async () => {
    const store = new SessionDataStore('')
    const { rpcServer, dispatch } = makeRpcHarness()
    registerSessionDataRpcHandlers(rpcServer, {
      get: (sid, key) => store.get(sid, key),
      set: (sid, key, val) => store.set(sid, key, val),
      delete: (sid, key) => store.delete(sid, key),
      keys: (sid) => store.keys(sid),
    })

    const resp = await dispatch('plugin.sessionData.set', {
      sessionId: 's1', key: '../../evil', value: 'v',
    })
    const err = errorOf(resp)
    expect(err.code).toBe('INVALID_KEY')
    expect(err.message).toContain('key')
    expect(err.message).toContain(SAFE_KEY_REGEX_LITERAL)
    store.dispose()
  })

  it('SEC-A5: sessionData rejects non-string sessionId (number) with INVALID_SESSION_ID', async () => {
    const store = new SessionDataStore('')
    const { rpcServer, dispatch } = makeRpcHarness()
    registerSessionDataRpcHandlers(rpcServer, {
      get: (sid, key) => store.get(sid, key),
      set: (sid, key, val) => store.set(sid, key, val),
      delete: (sid, key) => store.delete(sid, key),
      keys: (sid) => store.keys(sid),
    })

    const resp = await dispatch('plugin.sessionData.keys', { sessionId: 12345 })
    const err = errorOf(resp)
    expect(err.code).toBe('INVALID_SESSION_ID')
    expect(err.message).toContain('sessionId')
    store.dispose()
  })
})

// ══════════════════════════════════════════════════════════════════
// 2. RPC 入口层 — storage（pluginId 注入）
// ══════════════════════════════════════════════════════════════════

describe('SEC-A5 storage RPC entry validation', () => {
  it('SEC-A5: plugin.storage.global.set with pluginId "../.." returns INVALID_PLUGIN_ID and writes nothing outside the plugins dir', async () => {
    const { root, configDir, cleanup } = makeTempRoot()
    const storage = new PluginStorage()
    storage.init(configDir, '/test/project')
    const { rpcServer, dispatch } = makeRpcHarness()
    registerStorageRpcHandlers(rpcServer, storageHandlersFrom(storage))

    // '../..' → <configDir>/plugins/../.. → resolve → <root>；无防御时 globalState.json 会写到 <root>/
    const resp = await dispatch('plugin.storage.global.set', {
      pluginId: '../..', key: 'k', value: 'v',
    })
    const err = errorOf(resp)
    expect(err.code).toBe('INVALID_PLUGIN_ID')
    expect(err.message).toContain('pluginId')
    expect(err.message).toContain(SAFE_KEY_REGEX_LITERAL)

    // 文件系统副作用：<root> 下无逃逸文件；plugins 目录由 init() 合法创建，
    // 但内部应无任何落盘（攻击请求未建立分区）
    expect(existsSync(join(root, 'globalState.json'))).toBe(false)
    expect(readdirSync(join(root, 'config', 'plugins'))).toEqual([])

    storage.dispose()
    cleanup()
  })

  it('SEC-A5: all eight storage RPC methods reject traversal pluginId', async () => {
    const { configDir, cleanup } = makeTempRoot()
    const storage = new PluginStorage()
    storage.init(configDir, '/test/project')
    const { rpcServer, dispatch } = makeRpcHarness()
    registerStorageRpcHandlers(rpcServer, storageHandlersFrom(storage))

    for (const scope of ['global', 'workspace'] as const) {
      const cases: Array<[string, Record<string, unknown>]> = [
        [`plugin.storage.${scope}.get`, { pluginId: '../../evil' }],
        [`plugin.storage.${scope}.set`, { pluginId: '../../evil', key: 'k', value: 'v' }],
        [`plugin.storage.${scope}.delete`, { pluginId: '../../evil', key: 'k' }],
        [`plugin.storage.${scope}.keys`, { pluginId: '../../evil' }],
      ]
      for (const [method, params] of cases) {
        const err = errorOf(await dispatch(method, params))
        expect(err.code, `${method} should reject with INVALID_PLUGIN_ID`).toBe('INVALID_PLUGIN_ID')
        expect(err.message).toContain(SAFE_KEY_REGEX_LITERAL)
      }
    }
    storage.dispose()
    cleanup()
  })
})

// ══════════════════════════════════════════════════════════════════
// 3. 合法标识符全通过（白名单不误伤）
// ══════════════════════════════════════════════════════════════════

describe('SEC-A5 legal identifiers pass end-to-end', () => {
  it('SEC-A5: legal keys containing ".", "_", "-" roundtrip through sessionData RPC', async () => {
    const { configDir, cleanup } = makeTempRoot()
    const store = new SessionDataStore(configDir)
    const { rpcServer, dispatch } = makeRpcHarness()
    registerSessionDataRpcHandlers(rpcServer, {
      get: (sid, key) => store.get(sid, key),
      set: (sid, key, val) => store.set(sid, key, val),
      delete: (sid, key) => store.delete(sid, key),
      keys: (sid) => store.keys(sid),
    })

    const sessionId = 's-1.a_b'
    const key = 'k.2-x_y'
    const setResp = await dispatch('plugin.sessionData.set', { sessionId, key, value: 'v' })
    expect((setResp as { error?: unknown }).error).toBeUndefined()

    const getResp = await dispatch('plugin.sessionData.get', { sessionId, key })
    expect((getResp as { result?: unknown }).result).toBe('v')

    const keysResp = await dispatch('plugin.sessionData.keys', { sessionId })
    expect((keysResp as { result?: string[] }).result).toEqual([key])

    // 合法 sessionId 正常落盘（在 session-data 目录内）
    store.flushSession(sessionId)
    expect(existsSync(join(configDir, 'session-data', `${sessionId}.json`))).toBe(true)

    store.dispose()
    cleanup()
  })

  it('SEC-A5: legal pluginId containing ".", "_", "-" roundtrips through storage RPC (global + workspace)', async () => {
    const { configDir, cleanup } = makeTempRoot()
    const storage = new PluginStorage()
    storage.init(configDir, '/test/project')
    const { rpcServer, dispatch } = makeRpcHarness()
    registerStorageRpcHandlers(rpcServer, storageHandlersFrom(storage))

    const pluginId = 'test-plugin_1.0'
    const setResp = await dispatch('plugin.storage.global.set', { pluginId, key: 'name', value: 'hello' })
    expect((setResp as { error?: unknown }).error).toBeUndefined()

    const getResp = await dispatch('plugin.storage.global.get', { pluginId, key: 'name' })
    expect((getResp as { result?: unknown }).result).toBe('hello')

    const wsResp = await dispatch('plugin.storage.workspace.set', { pluginId, key: 'w', value: 1 })
    expect((wsResp as { error?: unknown }).error).toBeUndefined()

    storage.flushAll()
    const pluginDir = join(configDir, 'plugins', pluginId)
    expect(existsSync(join(pluginDir, 'globalState.json'))).toBe(true)
    const files = readdirSync(pluginDir)
    expect(files.some(f => f.startsWith('workspace-') && f.endsWith('.json'))).toBe(true)

    storage.dispose()
    cleanup()
  })
})

// ══════════════════════════════════════════════════════════════════
// 4. store 层 resolve 深度防御（绕过 RPC 入口直接调用）
// ══════════════════════════════════════════════════════════════════

describe('SEC-A5 store-layer resolve defense (bypassing entry layer)', () => {
  it('SEC-A5: SessionDataStore directly rejects traversal sessionId on get/set/keys/clearSession', async () => {
    const { root, configDir, cleanup } = makeTempRoot()
    const store = new SessionDataStore(configDir)

    // load 路径（get/keys/首次 set 都经 loadPartitionSync）：
    // resolve 防御抛 INVALID_SESSION_ID，且不被 loadPartitionSync 的 ENOENT catch 吞掉
    for (const fn of [
      () => store.get('../../evil', 'k'),
      () => store.set('../../evil', 'k', 'v'),
      () => store.keys('../../evil'),
    ]) {
      try {
        fn()
        expect.unreachable('should have thrown')
      } catch (err) {
        expect((err as { code?: unknown }).code).toBe('INVALID_SESSION_ID')
        expect((err as Error).message).toContain(SAFE_KEY_REGEX_LITERAL)
      }
    }
    // clearSession 已 async（B5 trash 软删除）——防御拒绝转为 rejection（仍先于任何状态变更）
    await expect(store.clearSession('../../evil')).rejects.toMatchObject({ code: 'INVALID_SESSION_ID' })

    // persist 路径与 load 共用 resolveSessionFilePath；即使构造出 dirty 分区
    // （正常途径不可能——set 先被 load 拦截），flush 也无法把文件写到目录外。
    // 此处断言：所有尝试后数据目录外零文件、session-data 目录未创建。
    store.flushAll()
    expect(existsSync(join(root, 'evil.json'))).toBe(false)
    expect(existsSync(join(configDir, 'session-data'))).toBe(false)

    store.dispose()
    cleanup()
  })

  it('SEC-A5: PluginStorage directly rejects traversal pluginId on get/set', () => {
    const { root, configDir, cleanup } = makeTempRoot()
    const storage = new PluginStorage()
    storage.init(configDir, '/test/project')

    // load 路径（get 触发 lazy load；set 首次访问分区同样触发）：
    // getFilePath 的 resolve 防御抛 INVALID_PLUGIN_ID
    for (const fn of [
      () => storage.get('../../evil', 'k'),
      () => storage.set('../../evil', 'k', 'v'),
      () => storage.keys('../../evil'),
    ]) {
      try {
        fn()
        expect.unreachable('should have thrown')
      } catch (err) {
        expect((err as { code?: unknown }).code).toBe('INVALID_PLUGIN_ID')
        expect((err as Error).message).toContain(SAFE_KEY_REGEX_LITERAL)
      }
    }

    // persist 路径与 load 共用 getFilePath；尝试任何路径后无逃逸文件
    storage.flushAll()
    expect(existsSync(join(root, 'globalState.json'))).toBe(false)

    storage.dispose()
    cleanup()
  })
})
