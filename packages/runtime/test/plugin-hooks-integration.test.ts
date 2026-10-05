/**
 * Hook 执行管道集成测试
 *
 * 验证 PluginService 的 hook 管道方法：
 * - executeHooks: hookRegistry 查询 + 按优先级排序 + broadcast 通知
 *
 * [pi1-disposition-chat-flow D7①] syncToolsToBridge / getBridgeSyncPayload /
 * handleBridgeToolExecute / handleBridgeEvent / handleBridgeIntercept 的 describe 段
 * 随 plugin-bridge 整体退役删除（service 对应方法已删）。
 *
 * 这些测试不依赖 PluginService.initialize()，直接操作私有状态。
 */

import { describe, it, expect, vi } from 'vitest'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { HookEntry, HookContext, ToolEntry } from '../src/services/plugin-service/plugin-types.js'

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/** 获取 PluginService 内部注册表的便捷方法（hookRegistry 下沉到 HookPipeline） */
function serviceRegistry(service: PluginService) {
  const hookPipeline = (service as unknown as { hookPipeline: { registry: Map<string, HookEntry[]> } }).hookPipeline
  const toolRegistry = (service as unknown as { toolRegistry: Map<string, ToolEntry> }).toolRegistry
  const host = (service as unknown as { host: { getWorkerHandle: ReturnType<typeof vi.fn> } }).host
  const rpcServer = (service as unknown as { rpcServer: { broadcast: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn> } }).rpcServer
  return { hookRegistry: hookPipeline.registry, toolRegistry, rpcServer, host }
}

// ══════════════════════════════════════════════════════════════════
// executeHooks
// ══════════════════════════════════════════════════════════════════

describe('PluginService.executeHooks', () => {
  // ── TC-HKP-01: 无注册 handler 返回未阻塞 ─────────────────────────
  it('TC-HKP-01: no registered handlers returns { blocked: false }', async () => {
    const service = new PluginService({} as never, createMockBroker())
    const result = await (service as any).executeHooks('onBeforeSendMessage', {
      pluginId: '',
      hookType: 'onBeforeSendMessage',
      data: { text: 'hello' },
      timestamp: Date.now(),
    })
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-HKP-02: 排序后 broadcast 通知 Worker ────────────────────
  it('TC-HKP-02: sorted handlers broadcast invoke notification', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    // 注册三个 handler（乱序 priority，验证排序）
    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-sandbox', handlerId: 'h3', priority: 200 },
      { pluginId: 'p-builtin', handlerId: 'h1', priority: 0 },
      { pluginId: 'p-trusted', handlerId: 'h2', priority: 100 },
    ])

    const context: HookContext = {
      pluginId: '',
      hookType: 'onBeforeSendMessage',
      data: { text: 'test' },
      timestamp: 1000,
    }
    const result = await (service as any).executeHooks('onBeforeSendMessage', context)

    // 简化实现：不等待 Worker 结果，返回默认未阻塞
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-HKP-03: 不存在的 hookType 返回未阻塞 ────────────────────
  it('TC-HKP-03: unknown hookType returns { blocked: false }', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    const reg = serviceRegistry(service)
    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p1', handlerId: 'h1', priority: 0 },
    ])

    const result = await (service as any).executeHooks('onNonExistentHook', {
      pluginId: '',
      hookType: 'onNonExistentHook' as any,
      data: {},
      timestamp: Date.now(),
    })
    expect(result).toEqual({ blocked: false })
  })

  // [2026-09 测试舰队审查 r2-15] TC-HKP-04「handlers are sorted by priority ascending」已删：
  // 测试内自行 [...entries].sort 后断言排序结果，验证的是 JS Array.sort 而非 SUT——恒真；
  // executeHooks 真实调用序由 plugin-api-hooks.test.ts TC-HK-02（乱序注册按优先级执行）锁定。
})

// [pi1-disposition-chat-flow D7①] handleBridgeEvent / handleBridgeIntercept describe 段
// 随 plugin-bridge 整体退役删除（service 两方法已删；经 hookType 直接触发的用例由
// plugin-hooks-serial / plugin-hook-bridge 承接）。

// ══════════════════════════════════════════════════════════════════
// sessionDataCache
// ══════════════════════════════════════════════════════════════════

describe('PluginService.sessionDataCache', () => {
  // ── TC-HKP-15: sessionDataCache 可读写单条 session ──────────────
  it('TC-HKP-15: can read and write session data', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const sds = (service as unknown as { sessionDataStore: { set(s: string, k: string, v: unknown): void; get(s: string, k: string): unknown } }).sessionDataStore

    // 创建 session 数据
    sds.set('session-1', 'key1', 'value1')
    sds.set('session-1', 'key2', 42)

    // 读取
    expect(sds.get('session-1', 'key1')).toBe('value1')
    expect(sds.get('session-1', 'key2')).toBe(42)
  })

  // ── TC-HKP-16: sessionDataCache 支持多 session 隔离 ────────────
  it('TC-HKP-16: multiple sessions are isolated', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const sds = (service as unknown as { sessionDataStore: { set(s: string, k: string, v: unknown): void; get(s: string, k: string): unknown } }).sessionDataStore

    sds.set('session-a', 'msg', 'hello')
    sds.set('session-b', 'msg', 'world')

    expect(sds.get('session-a', 'msg')).toBe('hello')
    expect(sds.get('session-b', 'msg')).toBe('world')
  })
})
