/**
 * statusline 真实现经真实 RPC 路径单测（plugin.ui.updateStatusBarItem 全链）。
 *
 * 存在动机（测试舰队审查登记缺口）：plugin-rpc-setup.ts 的 updateStatusBarItem handler
 * （statusline 数据权威）此前零覆盖——唯一覆盖它的 statusline-plugin-service.test.ts 是打在
 * 本地 mock 上的假测试（断言手抄实现，已被清理）。本文件走生产装配全链：
 * 真实 PluginService（registerRpcMethods → registerAllRpcMethods → registerUiRpcHandlers）
 * + 真实 JSON-RPC 往返桥（PluginRpcClient ↔ PluginRpcServer.dispatch，与 PluginHost 转发同构）
 * + Worker 侧 createUiApi（插件实际调用面），断言真实 registry 状态与 broker 广播 payload。
 *
 * 锁的行为契约（plugin-rpc-setup.ts updateStatusBarItem + status-bar-registry.ts）：
 * - itemKey = `${pluginId}:${id}` 复合键；text 非空写入（options 缺省 priority=100/scope='global'）
 * - options（tooltip/commandId/priority/scope/sessionId）逐字段透传
 * - 空 text = 移除该 item（更新与删除后都广播）
 * - 同 id 重复更新 = 覆盖（Map set 语义，不产生第二条目）
 * - 坏条目在该入口被拒（超长 text / 非法 id），错误经真实 RPC 回包到达 Worker 侧，
 *   registry 不受影响（D4 毒化隔离：拒绝该条，其余插件条目不受影响）
 * - 多插件共享同一 host：p1 与 p2 条目按复合键隔离共存（trusted Worker 多插件共享形态）
 * - 广播 `plugin:statusBarUpdate`（ADR-0015 契约）携带全量 items 快照
 *   （STATUSBAR_COALESCE_MS 合并窗口，trailing-edge debounce）
 *
 * 运行：cd packages/runtime && env -u XYZ_AGENT_DATA_DIR npx vitest run test/plugin-statusline-rpc.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PLUGIN_NOTIFY_LIMITS } from '@xyz-agent/shared'

import { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'
import type { ClientPort } from '../src/services/plugin-service/plugin-rpc-client.js'
import { createUiApi } from '../src/services/plugin-service/api/ui-api.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { RpcRequest, RpcResponse, RpcNotification } from '../src/services/plugin-service/plugin-types.js'

/** 合并窗口取 shared SSOT 值（100ms）；coalesce = 0 的立即广播路径由 registry 自己的测试覆盖 */
const COALESCE_MS = PLUGIN_NOTIFY_LIMITS.STATUSBAR_COALESCE_MS
/** text 上限（4KB）：毒化用例的超长 text 以此构造 */
const TEXT_MAX_BYTES = PLUGIN_NOTIFY_LIMITS.STATUSBAR_TEXT_MAX_BYTES

interface TestHarness {
  service: PluginService
  client: PluginRpcClient
  broadcasts: Array<{ type: string; payload: Record<string, unknown> }>
}

/**
 * 真实 PluginService（生产 registerRpcMethods 装配）+ 真实 JSON-RPC 往返桥。
 * host→Worker 回包 / Worker→host dispatch 双向桥与 plugin-ui-timeout-authority.test.ts
 * 的 D2 全链回归同构。api 由用例按需 createUiApi(client, pluginId) 构造（多插件用例
 * 在同一桥上为不同 pluginId 各建一个 api，即 trusted Worker 多插件共享形态）。
 */
function createWiredService(): TestHarness {
  const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = []
  const broker = {
    send: vi.fn(),
    sendError: vi.fn(),
    broadcast: vi.fn((msg: { type: string; payload: unknown }) => {
      broadcasts.push({ type: msg.type, payload: msg.payload as Record<string, unknown> })
    }),
  }
  const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
  const service = new PluginService(registry, broker as unknown as IMessageBroker, {
    broadcastFn: (type, payload) => broker.broadcast({ type, payload }),
  })
  // 生产装配链：registerRpcMethods → registerAllRpcMethods → registerUiRpcHandlers
  ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()

  const rpcServer = (
    service as unknown as { rpcServer: import('../src/services/plugin-service/plugin-rpc-server.js').PluginRpcServer }
  ).rpcServer

  // host→Worker 桥：response/notification 回 client
  const client = new PluginRpcClient()
  rpcServer.registerWorker('w1', {
    postMessage(msg: unknown) {
      const m = msg as { type: string; response?: RpcResponse; notification?: RpcNotification }
      if (m.type === 'rpc' && m.response) client.handleResponse(m.response)
      else if (m.type === 'rpc' && m.notification) client.handleNotification(m.notification)
    },
  })
  // Worker→host 桥：request/notification → rpcServer.dispatch（PluginHost 转发同构）
  client.attach({
    postMessage(msg: unknown) {
      void rpcServer.dispatch('w1', msg as RpcRequest)
    },
  } satisfies ClientPort)

  return { service, client, broadcasts }
}

/** 过滤出 statusbar 广播帧的 items */
function statusBarFrames(broadcasts: TestHarness['broadcasts']): Array<Array<Record<string, unknown>>> {
  return broadcasts
    .filter((m) => m.type === 'plugin:statusBarUpdate')
    .map((m) => (m.payload as { items: Array<Record<string, unknown>> }).items)
}

describe('statusline 真实 RPC 路径（plugin.ui.updateStatusBarItem 全链）', () => {
  beforeEach(() => {
    // 合并窗口（100ms debounce）需要 fake timers 推进；async 推进在 timer 间 flush microtask
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('text 非空（options 缺省）：复合键 p1:sb1 写入，priority=100 / scope=global 默认；coalesce 后广播全量', async () => {
    const { service, client, broadcasts } = createWiredService()
    const api = createUiApi(client, 'p1')

    await api.updateStatusBarItem('sb1', 'main | 12s')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)

    // registry 状态：复合键 + 缺省值
    const item = service.statusBarRegistry.items.get('p1:sb1')
    expect(item).toMatchObject({
      id: 'sb1',
      pluginId: 'p1',
      text: 'main | 12s',
      priority: 100, // DEFAULT_STATUS_BAR_PRIORITY
      scope: 'global',
    })

    // 广播契约（ADR-0015）：type + 全量 items 快照
    const frames = statusBarFrames(broadcasts)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual([expect.objectContaining({ id: 'sb1', pluginId: 'p1' })])
  })

  it('options 透传：tooltip / commandId / priority / scope / sessionId 逐字段落 registry', async () => {
    const { service, client } = createWiredService()
    const api = createUiApi(client, 'p1')

    await api.updateStatusBarItem('sb2', 'ctx 42%', {
      tooltip: 'context usage',
      commandId: 'ctx.open',
      priority: 10,
      scope: 'per-session',
      sessionId: 'sess-1',
    })
    await vi.advanceTimersByTimeAsync(COALESCE_MS)

    expect(service.statusBarRegistry.items.get('p1:sb2')).toEqual({
      id: 'sb2',
      pluginId: 'p1',
      text: 'ctx 42%',
      tooltip: 'context usage',
      commandId: 'ctx.open',
      priority: 10,
      scope: 'per-session',
      sessionId: 'sess-1',
    })
  })

  it('空 text = 移除：条目从 registry 删除，广播反映移除后的空全量', async () => {
    const { service, client, broadcasts } = createWiredService()
    const api = createUiApi(client, 'p1')

    await api.updateStatusBarItem('sb1', 'v1')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(service.statusBarRegistry.items.get('p1:sb1')).toBeDefined()

    await api.updateStatusBarItem('sb1', '')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(service.statusBarRegistry.items.has('p1:sb1')).toBe(false)

    // 更新与删除各产生一次广播；末帧 items 为空（全量快照语义）
    const frames = statusBarFrames(broadcasts)
    expect(frames).toHaveLength(2)
    expect(frames[1]).toEqual([])
  })

  it('同 id 重复更新覆盖：复合键 set 语义，不产生第二条目', async () => {
    const { service, client } = createWiredService()
    const api = createUiApi(client, 'p1')

    await api.updateStatusBarItem('sb1', 'v1')
    await api.updateStatusBarItem('sb1', 'v2')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)

    expect(service.statusBarRegistry.items.size).toBe(1)
    expect(service.statusBarRegistry.items.get('p1:sb1')?.text).toBe('v2')
  })

  it('毒化隔离：超长 text（>4KB）在该入口被拒——错误经真实 RPC 回包到达 Worker 侧，registry 不受影响', async () => {
    const { service, client } = createWiredService()
    const api = createUiApi(client, 'p1')
    // 先落一条合法条目，锁「拒绝该条而非整包」的既有数据不受影响
    await api.updateStatusBarItem('sb1', 'good')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)

    const oversized = 'x'.repeat(TEXT_MAX_BYTES + 1)
    await expect(api.updateStatusBarItem('sb2', oversized)).rejects.toThrow(/Invalid text/)

    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(service.statusBarRegistry.items.has('p1:sb2')).toBe(false) // 坏条目未写入
    expect(service.statusBarRegistry.items.get('p1:sb1')?.text).toBe('good') // 既有条目不受影响
  })

  it('非法 id（复合键注入字符 ":"）被拒：asSafeKey 白名单拦截，registry 零写入零广播', async () => {
    const { service, client, broadcasts } = createWiredService()
    const api = createUiApi(client, 'p1')

    // id 含 ':' 会拼出歧义复合键（statusBarItems 键 `${pluginId}:${id}`）——白名单排除
    await expect(api.updateStatusBarItem('a:b', 'evil')).rejects.toThrow(/Invalid id/)
    await vi.advanceTimersByTimeAsync(COALESCE_MS)

    expect(service.statusBarRegistry.items.size).toBe(0)
    expect(statusBarFrames(broadcasts)).toHaveLength(0)
  })

  it('多插件共享同一 host：p1 与 p2 条目按复合键隔离共存，互不覆盖', async () => {
    const { service, client } = createWiredService()
    // 同一桥（trusted Worker 多插件共享形态）上为两个插件各建 api
    const apiP1 = createUiApi(client, 'p1')
    const apiP2 = createUiApi(client, 'p2')

    await apiP1.updateStatusBarItem('shared-id', 'from p1')
    await apiP2.updateStatusBarItem('shared-id', 'from p2')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)

    expect(service.statusBarRegistry.items.get('p1:shared-id')?.text).toBe('from p1')
    expect(service.statusBarRegistry.items.get('p2:shared-id')?.text).toBe('from p2')
    expect(service.statusBarRegistry.items.size).toBe(2)
  })
})
