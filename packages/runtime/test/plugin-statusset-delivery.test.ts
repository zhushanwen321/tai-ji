/**
 * pi1-disposition-chat-flow U4⑥：statusSetUpdate 挂点迁移 + 断链修复回归（D7②）。
 *
 * before 基线（runlog U4.md 代码级断链记录）：旧链 server.handleStatusSetUpdate →
 * BridgeHandler.handleStatusSetUpdate → pluginService.handleBridgeEvent('plugin:statusSetUpdate', …)
 * ——PI_HOOK_EVENT_MAP 无该条目 → 分发键取原始事件名 → hookRegistry.get('plugin:statusSetUpdate')
 * 恒空（注册侧 hook-api 以 'onPiEvent' 为键写入）→ statusline 从未收到事件（断链）。
 *
 * after（本文件断言）：server.handleStatusSetUpdate → pluginService.notifyPiEvent →
 * executeHooks('onPiEvent', { event: 'plugin:statusSetUpdate', ...payload })——分发键 =
 * 泛型 'onPiEvent'（与 hook-api 注册面对齐），载荷平铺形状（事件名在 event 字段），
 * hook-api 适配层解出 (eventName, payload) 后 statusline 消费形态 = { sessionId, key, text }。
 */
import { describe, it, expect, vi } from 'vitest'
import { RuntimeServer } from '../src/transport/server.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { createHookApi } from '../src/services/plugin-service/hook-api.js'
import { executeHookRequest } from '../src/services/plugin-service/hook-api.js'
import type { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'
import type { IMessageBroker } from '../src/interfaces.js'

/** PluginRpcClient 最小 mock（同 plugin-api-hooks/plugin-api-extended 的文件内形态）：
 * 捕获 request 调用供注册断言。 */
function createMockRpcClient(): MockRpcClient & PluginRpcClient {
  const requestCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  return {
    requestCalls,
    request: (method: string, params: Record<string, unknown>) => {
      requestCalls.push({ method, params })
      return Promise.resolve(undefined)
    },
    onNotification: () => () => {},
    notify: () => {},
  } as unknown as MockRpcClient & PluginRpcClient
}

interface MockRpcClient { // oe-exempt:20261004:test:测试 mock 声明（单文件局部，非架构契约）
  requestCalls: Array<{ method: string; params: Record<string, unknown> }>
}

describe('statusSetUpdate delivery: server → pluginService.notifyPiEvent (D7② 新挂点)', () => {
  it('server.handleStatusSetUpdate 直投 pluginService.notifyPiEvent（BridgeHandler 中转已删）', () => {
    const server = new RuntimeServer(0, '/tmp/test-project')
    const notifyPiEvent = vi.fn()
    // 结构类型注入（server.pluginService 是可选私有字段，经 as 注入测试替身）
    ;(server as unknown as { pluginService: unknown }).pluginService = { notifyPiEvent }

    server.handleStatusSetUpdate({ sessionId: 's1', key: 'todo', text: '2/5', textRaw: '2/5' })

    expect(notifyPiEvent).toHaveBeenCalledTimes(1) // 恰一次
    expect(notifyPiEvent).toHaveBeenCalledWith('plugin:statusSetUpdate', { sessionId: 's1', key: 'todo', text: '2/5', textRaw: '2/5' }, 's1')
  })

  it('pluginService 未注入时不抛（可选依赖守卫）', () => {
    const server = new RuntimeServer(0, '/tmp/test-project')
    expect(() => server.handleStatusSetUpdate({ sessionId: 's1', key: 'k', text: 'v' })).not.toThrow()
  })
})

describe('statusSetUpdate delivery: notifyPiEvent dispatch key/shape (断链修复落点)', () => {
  /** 最小 PluginService 环境：拦截 executeHooks 观察派发键与载荷形状 */
  function setup() {
    const broker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() } as unknown as IMessageBroker
    const service = new PluginService({} as never, broker)
    const hookCalls: Array<{ hookType: string; context: Record<string, unknown> }> = []
    ;(service as unknown as { executeHooks: unknown }).executeHooks = async (hookType: string, context: Record<string, unknown>) => {
      hookCalls.push({ hookType, context })
      return { blocked: false }
    }
    return { service, hookCalls }
  }

  it('分发键 = 泛型 onPiEvent；载荷平铺形状 { event, ...payload }（事件名在 event 字段）', async () => {
    const { service, hookCalls } = setup()

    service.notifyPiEvent('plugin:statusSetUpdate', { sessionId: 's1', key: 'goal', text: 'running' }, 's1')
    await new Promise((r) => setTimeout(r, 0))

    expect(hookCalls).toHaveLength(1)
    expect(hookCalls[0]!.hookType).toBe('onPiEvent')
    // 平铺形态（与 event-interpreter 既有调用同构）：业务字段直接在 context 顶层，无框架包装
    expect(hookCalls[0]!.context).toEqual({ event: 'plugin:statusSetUpdate', sessionId: 's1', key: 'goal', text: 'running' })
  })

  it('notifyPiEvent 是 IPluginService 契约成员（挂点迁移后的唯一投递入口）', () => {
    const { service } = setup()
    expect(typeof service.notifyPiEvent).toBe('function')
  })
})

describe('statusSetUpdate delivery: end-to-end hook-api 适配 → statusline 消费形态', () => {
  /**
   * 复刻 statusline 插件的注册面与解包适配（resources/plugins/statusline/index.ts）：
   * api.hooks.onPiEvent 注册（泛型键）→ handler 收 (eventName, payload)——
   * notifyPiEvent 的平铺 context 经 hook-api 适配层「event-interpreter 平铺」分支解包，
   * handler 第二参 = 剥离 event 元字段后的业务载荷 { sessionId, key, text }（键值直出）。
   */
  it('泛型 onPiEvent 注册 + notifyPiEvent 平铺 context → handler 收到 (事件名, 平铺业务载荷)', async () => {
    const mockClient = createMockRpcClient() as MockRpcClient & PluginRpcClient
    const hookApi = createHookApi(mockClient, 'statusline-plugin')

    const collected: Array<{ eventName: string; data: unknown }> = []
    const disposable = await hookApi.onPiEvent('plugin:statusSetUpdate', async (eventName, data) => {
      collected.push({ eventName, data })
    })

    // 注册请求携带泛型 'onPiEvent' 键（与 notifyPiEvent 的分发键对齐——断链修复的核心断言：
    // 旧分发键 = 原始事件名 'plugin:statusSetUpdate'，查注册表恒空）
    const registerCall = mockClient.requestCalls.find((c) => c.method === 'plugin.hooks.register')!
    expect(registerCall).toBeTruthy()
    expect(registerCall.params.hookType).toBe('onPiEvent')
    const handlerId = registerCall.params.handlerId as string

    // 模拟主线程 notifyPiEvent 派发到达 Worker：context = { event, ...payload } 平铺形状
    await executeHookRequest({
      handlerId,
      context: { event: 'plugin:statusSetUpdate', sessionId: 's1', key: 'todo', text: '2/5' },
    })

    expect(collected).toHaveLength(1) // 恰一次
    expect(collected[0]!.eventName).toBe('plugin:statusSetUpdate')
    // statusline 解包适配后的消费形态：平铺业务载荷（键值直出，无 bridge 包装层）
    expect(collected[0]!.data).toEqual({ sessionId: 's1', key: 'todo', text: '2/5' })

    disposable.dispose()
  })
})
