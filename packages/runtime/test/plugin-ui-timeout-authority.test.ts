/**
 * UI 弹窗超时权威源（timeout-plugin-service D2）增量测试
 *
 * 覆盖：
 * - resolveUiRequestTimeoutMs 取值链全分支（合法正数优先 / 非法回落默认 / clamp 上界）
 * - Worker 侧单一计时权威：effective 直传 rpcClient.request 第三参（无余量）、
 *   requestId 在 Worker 侧生成并随 params 传递
 * - 到期取消语义：RPC_TIMEOUT → UI_TIMEOUT 转译 + warn + plugin.ui.uiRequestExpired notify
 * - queue 尊重来方 requestId + 重复 id warn 丢弃后到者
 * - cancelRequest 幂等（miss-safe）/ 活跃放行 / 排队项删除
 * - 兜底 min 边界（effective=MAX 时不超 timer 域、与语义同刻双路径清理幂等）
 * - V4b 排队全程语义：B（短 timeout）排队中先于 A 到期被 cancel，A 不受影响，
 *   无「传输层先炸」形态（前端撤窗 miss 幂等属 renderer 消费侧 U8，此处断言广播形状）
 * - 生产装配全链回归：真实 PluginService（registerAllRpcMethods 生产装配）+ 真实
 *   RPC 往返——meta 透传（Worker requestId 达 queue）+ 到期 cancel notification 经
 *   dispatch → onUiRequestExpired → queue.cancelRequest 的完整链路
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'
import type { ClientPort } from '../src/services/plugin-service/plugin-rpc-client.js'
import { createUiApi, resolveUiRequestTimeoutMs, DEFAULT_UI_REQUEST_TIMEOUT_MS, MAX_TIMER_DELAY_MS } from '../src/services/plugin-service/api/ui-api.js'
import type { UiDialogOptions } from '../src/services/plugin-service/api/ui-api.js'
import { UiRequestQueue, resolveFallbackDelayMs } from '../src/services/plugin-service/ui-request-queue.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { IMessageBroker, ISessionService } from '../src/interfaces.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { RpcRequest, RpcResponse, RpcNotification } from '../src/services/plugin-service/plugin-types.js'

// ══════════════════════════════════════════════════════════════════
// 取值链（resolveUiRequestTimeoutMs）
// ══════════════════════════════════════════════════════════════════

describe('resolveUiRequestTimeoutMs 取值链', () => {
  it('合法正数优先', () => {
    expect(resolveUiRequestTimeoutMs(5_000)).toBe(5_000)
    expect(resolveUiRequestTimeoutMs(1)).toBe(1)
  })

  it('非法值回落默认 30min（undefined / 0 / 负数 / NaN / ±Infinity）', () => {
    expect(resolveUiRequestTimeoutMs(undefined)).toBe(DEFAULT_UI_REQUEST_TIMEOUT_MS)
    expect(resolveUiRequestTimeoutMs(0)).toBe(DEFAULT_UI_REQUEST_TIMEOUT_MS)
    expect(resolveUiRequestTimeoutMs(-1)).toBe(DEFAULT_UI_REQUEST_TIMEOUT_MS)
    expect(resolveUiRequestTimeoutMs(Number.NaN)).toBe(DEFAULT_UI_REQUEST_TIMEOUT_MS)
    expect(resolveUiRequestTimeoutMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_UI_REQUEST_TIMEOUT_MS)
    expect(resolveUiRequestTimeoutMs(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_UI_REQUEST_TIMEOUT_MS)
  })

  it('超域合法值 clamp 到 MAX_TIMER_DELAY_MS（防 Node timer 塌缩 1ms）', () => {
    expect(resolveUiRequestTimeoutMs(MAX_TIMER_DELAY_MS + 1)).toBe(MAX_TIMER_DELAY_MS)
    expect(resolveUiRequestTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_DELAY_MS)
  })

  it('兜底延迟 min(effective + 60s, MAX)：常规值不加余量即超域时收敛，MAX 时不超域', () => {
    expect(resolveFallbackDelayMs(DEFAULT_UI_REQUEST_TIMEOUT_MS)).toBe(DEFAULT_UI_REQUEST_TIMEOUT_MS + 60_000)
    // effective = MAX：+60s 若不加 min 会超出 Node setTimeout 域塌缩 1ms 反客为主提前触发
    expect(resolveFallbackDelayMs(MAX_TIMER_DELAY_MS)).toBe(MAX_TIMER_DELAY_MS)
  })
})

// ══════════════════════════════════════════════════════════════════
// Worker 侧（createUiApi）：单一计时权威 + UI_TIMEOUT 转译
// ══════════════════════════════════════════════════════════════════

function createMockPort(): ClientPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

function createWorkerApi() {
  const client = new PluginRpcClient()
  const port = createMockPort()
  client.attach(port)
  const api = createUiApi(client, 'p1')
  return { client, port, api }
}

/** 从 postMessage 的 rpc request 帧提取 params（Worker→host 方向） */
function sentRequestParams(port: ReturnType<typeof createMockPort>, method: string): Record<string, unknown> {
  const frame = port.messages.find(m =>
    (m as { type?: string; method?: string }).type === 'rpc'
    && (m as { method?: string }).method === method,
  ) as { params: Record<string, unknown> } | undefined
  expect(frame).toBeDefined()
  return frame!.params
}

describe('createUiApi（Worker 侧单一计时权威）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('dialog 三方法直传 effective（无余量）且 requestId/timeoutMs 随 params 传递', () => {
    const { client, port, api } = createWorkerApi()
    const requestSpy = vi.spyOn(client, 'request')

    const opts: UiDialogOptions = { timeout: 5_000 }
    void api.showConfirm('T', 'M', opts)
    void api.showSelect('T', ['A'], opts)
    void api.showInput('T', undefined, opts)

    for (const method of ['plugin.ui.showConfirm', 'plugin.ui.showSelect', 'plugin.ui.showInput']) {
      expect(requestSpy).toHaveBeenCalledWith(method, expect.objectContaining({
        pluginId: 'p1',
        requestId: expect.stringMatching(/^p1_\d+_/),
        timeoutMs: 5_000,
      }), 5_000)
      const params = sentRequestParams(port, method)
      expect(typeof params.requestId).toBe('string')
      expect(params.timeoutMs).toBe(5_000)
    }

    // requestId 全局唯一（同插件连续请求不碰撞）
    const id1 = sentRequestParams(port, 'plugin.ui.showConfirm').requestId
    const id2 = sentRequestParams(port, 'plugin.ui.showSelect').requestId
    expect(id1).not.toBe(id2)
  })

  it('未传 opts 时默认 effective 30min 直传', async () => {
    const { client, api } = createWorkerApi()
    const requestSpy = vi.spyOn(client, 'request')

    void api.showConfirm('T', 'M')

    expect(requestSpy).toHaveBeenCalledWith('plugin.ui.showConfirm', expect.objectContaining({
      timeoutMs: DEFAULT_UI_REQUEST_TIMEOUT_MS,
    }), DEFAULT_UI_REQUEST_TIMEOUT_MS)
  })

  it('notify / updateStatusBarItem 纯展示类不传第三参（维持 client 默认 30s）', () => {
    const { client, api } = createWorkerApi()
    const requestSpy = vi.spyOn(client, 'request')

    void api.notify('info', 'hello')
    void api.updateStatusBarItem('sb1', 'text')

    expect(requestSpy).toHaveBeenNthCalledWith(1, 'plugin.ui.notify', expect.objectContaining({ pluginId: 'p1' }))
    expect(requestSpy).toHaveBeenNthCalledWith(2, 'plugin.ui.updateStatusBarItem', expect.anything())
    // 第三参缺省（client 默认 30s），且 params 无 requestId/timeoutMs（不参与语义计时）
    expect((requestSpy.mock.calls[0] as unknown[]).length).toBe(2)
    expect((requestSpy.mock.calls[1] as unknown[]).length).toBe(2)
  })

  it('到期转译：RPC_TIMEOUT → UI_TIMEOUT reject + warn + uiRequestExpired notify', async () => {
    const { client, api } = createWorkerApi()
    const notifySpy = vi.spyOn(client, 'notify')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const p = api.showConfirm('T', 'M', { timeout: 1_000 })
      const assertion = expect(p).rejects.toMatchObject({ code: 'UI_TIMEOUT' })

      vi.advanceTimersByTime(1_000)
      await assertion

      // warn 含等待时长与恢复指引（传 opts.timeout 延长，全程含排队）
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const warnText = String(warnSpy.mock.calls[0][0])
      expect(warnText).toContain('1000ms')
      expect(warnText).toContain('opts.timeout')

      // cancel 通知复用 Worker→host 无 id notification 通路
      expect(notifySpy).toHaveBeenCalledWith('plugin.ui.uiRequestExpired', {
        requestId: expect.stringMatching(/^p1_\d+_/),
        pluginId: 'p1',
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('非超时错误（dispose）原样传播，不误判 UI_TIMEOUT、不发 cancel 通知', async () => {
    const { client, api } = createWorkerApi()
    const notifySpy = vi.spyOn(client, 'notify')

    const p = api.showConfirm('T', 'M', { timeout: 1_000 })
    const assertion = expect(p).rejects.toMatchObject({ message: 'RPC client disposed' })
    client.dispose()
    await assertion

    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('V4b 排队全程语义（Worker 侧）：B 短 timeout 排队中先于 A 到期，无传输层先炸', async () => {
    const { api } = createWorkerApi()

    const pA = api.showConfirm('A', 'keep waiting') // 默认 30min 全程
    const pB = api.showConfirm('B', 'queued', { timeout: 60_000 }) // 全程含排队 60s

    let settledA = false
    void pA.then(() => { settledA = true }, () => { settledA = true })

    // T+60s：B 语义到期（其计时从发起起算、含排队）——传输层不得先于语义报错
    vi.advanceTimersByTime(60_000)
    await Promise.resolve()
    await Promise.resolve()
    await expect(pB).rejects.toMatchObject({ code: 'UI_TIMEOUT' })
    // flush B 的 reject 微任务后，A 仍不受影响继续等待
    await Promise.resolve()
    expect(settledA).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════
// queue 侧：尊重来方 requestId / cancelRequest 幂等 / 兜底边界
// ══════════════════════════════════════════════════════════════════

interface TestHarness {
  queue: UiRequestQueue
  broadcasts: Array<{ type: string; payload: Record<string, unknown> }>
}

function createQueueHarness(): TestHarness {
  const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = []
  const queue = new UiRequestQueue((type, payload) => {
    broadcasts.push({ type, payload: payload as Record<string, unknown> })
  })
  return { queue, broadcasts }
}

describe('UiRequestQueue（D2 队列侧）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('尊重来方 requestId：广播与 cancel 匹配使用 Worker 生成的 id', async () => {
    const { queue, broadcasts } = createQueueHarness()
    void queue.handleRequest('confirm', { requestId: 'p1_123_abc', timeoutMs: 5_000 }, 'p1')

    const uiRequest = broadcasts.find(m => m.type === 'plugin:uiRequest')
    expect(uiRequest!.payload.requestId).toBe('p1_123_abc')

    queue.cancelRequest('p1_123_abc')
    const expired = broadcasts.find(m => m.type === 'plugin:uiRequestExpired')
    expect(expired!.payload).toMatchObject({ requestId: 'p1_123_abc', pluginId: 'p1' })
  })

  it('重复 id：warn + 丢弃后到者（reject，不产生第二个 pending）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { queue } = createQueueHarness()
      const p1 = queue.handleRequest('confirm', { requestId: 'dup_1', timeoutMs: 5_000 }, 'p1')
      const p2 = queue.handleRequest('confirm', { requestId: 'dup_1', timeoutMs: 5_000 }, 'p1')

      await expect(p2).rejects.toThrow(/duplicate ui request id/)
      expect(queue.uiRequestQueue.length).toBe(0)
      expect(warnSpy.mock.calls.some(call => String(call[0]).includes('duplicate ui requestId'))).toBe(true)
      // 先到者不受影响（仍 pending，可被正常响应）
      queue.handleResponse('dup_1', false)
      await expect(p1).resolves.toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('cancelRequest 活跃请求：删项 + 无条件撤窗广播 + 放行排队项', async () => {
    const { queue, broadcasts } = createQueueHarness()

    const pA = queue.handleRequest('confirm', { requestId: 'A', timeoutMs: 1_800_000 }, 'p1')
    const pB = queue.handleRequest('input', { requestId: 'B', timeoutMs: 1_800_000 }, 'p1')
    expect(queue.uiRequestQueue.length).toBe(1)

    queue.cancelRequest('A')

    await expect(pA).resolves.toBeUndefined()
    expect(broadcasts.filter(m => m.type === 'plugin:uiRequestExpired')).toHaveLength(1)
    // 活跃放行：B 出队 dispatch（广播第二条 plugin:uiRequest）
    expect(queue.activeUiRequest).toBe('B')
    expect(broadcasts.filter(m => m.type === 'plugin:uiRequest')).toHaveLength(2)

    // B 正常完成不受影响
    queue.handleResponse('B', 'typed')
    await expect(pB).resolves.toBe('typed')
    expect(broadcasts.filter(m => m.type === 'plugin:uiRequestExpired')).toHaveLength(1)
  })

  it('cancelRequest 排队中请求：删排队项 + 广播（从未展示也发），A 不受影响', async () => {
    const { queue, broadcasts } = createQueueHarness()

    const pA = queue.handleRequest('confirm', { requestId: 'A', timeoutMs: 1_800_000 }, 'p1')
    const pB = queue.handleRequest('confirm', { requestId: 'B', timeoutMs: 60_000 }, 'p1')

    queue.cancelRequest('B')

    await expect(pB).resolves.toBeUndefined()
    expect(queue.uiRequestQueue.length).toBe(0)
    const expired = broadcasts.filter(m => m.type === 'plugin:uiRequestExpired')
    expect(expired).toHaveLength(1)
    expect(expired[0].payload.requestId).toBe('B')

    // A 不受影响继续等待
    let settledA = false
    void pA.then(() => { settledA = true }, () => { settledA = true })
    vi.advanceTimersByTime(0)
    await Promise.resolve()
    expect(settledA).toBe(false)

    queue.handleResponse('A', true)
    await expect(pA).resolves.toBe(true)
  })

  it('cancelRequest 对已 settle 请求 miss-safe：不二次广播、不抛', async () => {
    const { queue, broadcasts } = createQueueHarness()

    const p = queue.handleRequest('confirm', { requestId: 'X', timeoutMs: 5_000 }, 'p1')
    queue.handleResponse('X', true)
    await expect(p).resolves.toBe(true)

    expect(() => queue.cancelRequest('X')).not.toThrow()
    expect(broadcasts.filter(m => m.type === 'plugin:uiRequestExpired')).toHaveLength(0)

    // 未知 id 同样 miss-safe
    expect(() => queue.cancelRequest('never-existed')).not.toThrow()
  })

  it('兜底到期（cancel 丢失形态）：清理 + 撤窗广播 + 放行 + resolve undefined', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { queue, broadcasts } = createQueueHarness()

      const pA = queue.handleRequest('confirm', { requestId: 'A', timeoutMs: 60_000 }, 'p1')
      const pB = queue.handleRequest('input', { requestId: 'B', timeoutMs: 60_000 }, 'p1')

      // 兜底 = effective + 60s；cancel 通知永不到达（模拟丢失）
      vi.advanceTimersByTime(120_000)

      await expect(pA).resolves.toBeUndefined()
      await expect(pB).resolves.toBeUndefined()
      expect(broadcasts.filter(m => m.type === 'plugin:uiRequestExpired')).toHaveLength(2)
      expect(queue.activeUiRequest).toBeNull()
      expect(warnSpy.mock.calls.some(call => String(call[0]).includes('fallback cleanup'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('effective = MAX_TIMER_DELAY_MS：兜底不超 timer 域，与语义同刻到期后双路径清理幂等', async () => {
    const { queue, broadcasts } = createQueueHarness()

    // 恰被 clamp 到上界：语义 timer（Worker 侧）与兜底同在 MAX 时刻到期
    const p = queue.handleRequest('confirm', { requestId: 'MAX_1', timeoutMs: MAX_TIMER_DELAY_MS }, 'p1')
    expect(resolveFallbackDelayMs(MAX_TIMER_DELAY_MS)).toBe(MAX_TIMER_DELAY_MS)

    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS)
    await expect(p).resolves.toBeUndefined()
    expect(broadcasts.filter(m => m.type === 'plugin:uiRequestExpired')).toHaveLength(1)

    // 语义路径的 cancel 通知同刻后到：幂等收尾，不二次广播
    expect(() => queue.cancelRequest('MAX_1')).not.toThrow()
    expect(broadcasts.filter(m => m.type === 'plugin:uiRequestExpired')).toHaveLength(1)
  })

  it('兜底被 cancel 正常解除：正常路径（cancel 通知到达）下兜底不触发', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { queue, broadcasts } = createQueueHarness()

      void queue.handleRequest('confirm', { requestId: 'OK', timeoutMs: 60_000 }, 'p1')
      // T+60s：Worker 语义到期，cancel 通知到达（正常路径）
      vi.advanceTimersByTime(60_000)
      queue.cancelRequest('OK')

      // T+120s：兜底已被 clearTimeout 解除，不得触发
      vi.advanceTimersByTime(60_000)
      expect(broadcasts.filter(m => m.type === 'plugin:uiRequestExpired')).toHaveLength(1)
      expect(warnSpy.mock.calls.some(call => String(call[0]).includes('fallback cleanup'))).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ══════════════════════════════════════════════════════════════════
// 生产装配全链（D2 接线回归）
// ══════════════════════════════════════════════════════════════════

describe('生产装配全链（D2 接线回归）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 真实 PluginService（生产 registerAllRpcMethods 装配）+ 真实 JSON-RPC 往返桥 */
  function createWiredService(): { service: PluginService; broadcasts: Array<{ type: string; payload: Record<string, unknown> }> } {
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
    return { service, broadcasts }
  }

  it('meta 透传 + 到期 cancel notification 全链：Worker requestId 达 queue 并驱动真实撤窗', async () => {
    const { service, broadcasts } = createWiredService()
    const rpcServer = (service as unknown as { rpcServer: import('../src/services/plugin-service/plugin-rpc-server.js').PluginRpcServer }).rpcServer

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

    const api = createUiApi(client, 'p1')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const p = api.showConfirm('T', 'M', { timeout: 1_000 })
      const assertion = expect(p).rejects.toMatchObject({ code: 'UI_TIMEOUT' })

      // T+1s：Worker 语义到期。advanceTimersByTimeAsync 在 timer 间 flush microtask——
      // cancel notification（reject → catch → notify → dispatch → onUiRequestExpired →
      // queue.cancelRequest）整链物理耗时毫秒级，远早于 60s 后的兜底；同步 advance 会把
      // 该间隙压扁成兜底抢跑的竞速失真，故必须异步推进。
      await vi.advanceTimersByTimeAsync(1_000)
      await assertion

      // meta 透传生效的直接证据：广播 payload 的 requestId 来自 Worker 侧（queue 尊重来方值）
      const uiRequests = broadcasts.filter(m => m.type === 'plugin:uiRequest')
      expect(uiRequests).toHaveLength(1)
      const requestId = uiRequests[0].payload.requestId as string
      expect(requestId).toMatch(/^p1_\d+_/)

      // 撤窗广播由真实 queue 经 cancel 路径发出（恰 1 条，非兜底——兜底 warn 不得出现）
      const expired = broadcasts.filter(m => m.type === 'plugin:uiRequestExpired')
      expect(expired).toHaveLength(1)
      expect(expired[0].payload.requestId).toBe(requestId)
      expect(expired[0].payload.pluginId).toBe('p1')
      expect(warnSpy.mock.calls.some(call => String(call[0]).includes('fallback cleanup'))).toBe(false)

      // 串行队列已放行（cancelRequest 活跃路径 processNext）
      const queue = (service as unknown as { uiRequestQueue: UiRequestQueue }).uiRequestQueue
      expect(queue.activeUiRequest).toBeNull()

      // T+61s：兜底已被 cancel 解除，不得二次触发
      await vi.advanceTimersByTimeAsync(60_000)
      expect(broadcasts.filter(m => m.type === 'plugin:uiRequestExpired')).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ══════════════════════════════════════════════════════════════════
// expired 撤窗广播分流（R1-1 回归：bus 装配 + sid 存在直发 global 通道）
// ══════════════════════════════════════════════════════════════════

describe('expired 撤窗广播分流（R1-1）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 真实 PluginService + mock messageBus + 活跃 session（生产常态三要素齐备） */
  function createWiredServiceWithBus(): {
    service: PluginService
    broadcasts: Array<{ type: string; payload: Record<string, unknown> }>
    busPublish: ReturnType<typeof vi.fn>
  } {
    const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = []
    const broker = {
      send: vi.fn(),
      sendError: vi.fn(),
      broadcast: vi.fn((msg: { type: string; payload: unknown }) => {
        broadcasts.push({ type: msg.type, payload: msg.payload as Record<string, unknown> })
      }),
    }
    const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
    // 活跃 session 存在 → 广播回调 resolve 出 sid（生产常态的 sid 分支）
    const sessionService = {
      listPersistedSessions: () => [{ sessions: [{ id: 'sess-1', status: 'active' }] }],
      getSummary: (id: string) => ({ id, status: 'active' }),
    }
    const service = new PluginService(registry, broker as unknown as IMessageBroker, {
      broadcastFn: (type, payload) => broker.broadcast({ type, payload }),
      sessionService: sessionService as unknown as ISessionService,
    })
    // mock messageBus 装配（生产 setMessageBus wire 同点）
    const busPublish = vi.fn()
    service.setMessageBus({ publish: busPublish } as unknown as IMessageBus)
    ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()
    return { service, broadcasts, busPublish }
  }

  it('生产常态（sid 存在 + bus 装配）：expired 不进 bus.publish 直发 broadcastOrBroker；uiRequest 展示帧仍走 bus 带 sid', async () => {
    const { service, broadcasts, busPublish } = createWiredServiceWithBus()
    const rpcServer = (service as unknown as { rpcServer: import('../src/services/plugin-service/plugin-rpc-server.js').PluginRpcServer }).rpcServer

    // host→Worker / Worker→host 桥（与 D2 全链回归同构）
    const client = new PluginRpcClient()
    rpcServer.registerWorker('w1', {
      postMessage(msg: unknown) {
        const m = msg as { type: string; response?: RpcResponse; notification?: RpcNotification }
        if (m.type === 'rpc' && m.response) client.handleResponse(m.response)
        else if (m.type === 'rpc' && m.notification) client.handleNotification(m.notification)
      },
    })
    client.attach({
      postMessage(msg: unknown) {
        void rpcServer.dispatch('w1', msg as RpcRequest)
      },
    } satisfies ClientPort)

    const api = createUiApi(client, 'p1')
    const p = api.showConfirm('T', 'M', { timeout: 1_000 })
    const assertion = expect(p).rejects.toMatchObject({ code: 'UI_TIMEOUT' })

    await vi.advanceTimersByTimeAsync(1_000)
    await assertion

    // 展示帧：走 bus session 级定向（带 sid），session 关联展示语义不变
    expect(busPublish).toHaveBeenCalledTimes(1)
    expect(busPublish.mock.calls[0][0]).toBe('sess-1')
    const uiRequestFrame = busPublish.mock.calls[0][1] as { type: string; payload: { requestId: string } }
    expect(uiRequestFrame.type).toBe('plugin:uiRequest')
    const requestId = uiRequestFrame.payload.requestId
    expect(requestId).toMatch(/^p1_\d+_/)

    // 撤窗帧：不进 bus.publish（session 级帧 onGlobal 不可达），直发 broadcastOrBroker
    const expiredViaBus = busPublish.mock.calls.filter(
      ([, m]) => (m as { type: string }).type === 'plugin:uiRequestExpired',
    )
    expect(expiredViaBus).toHaveLength(0)
    const expired = broadcasts.filter(m => m.type === 'plugin:uiRequestExpired')
    expect(expired).toHaveLength(1)
    expect(expired[0].payload.requestId).toBe(requestId)
    // expired payload 携带活跃 sid（75a97ba3c 契约修订，MF-4）：renderer 重启后 requestId
    // 反查 Map 为空时以 payload sid 定位分区撤窗（dialog-request-queue dequeueByRequestId）
    expect(expired[0].payload.sessionId).toBe('sess-1')
  })
})

// ══════════════════════════════════════════════════════════════════
// MF-2/MF-3 sessionId 注入回归（自 plugin-ui-dialog.test.ts 归并）
// 无 sid 的 uiRequest 会被前端 C2 守卫丢弃 → plugin dialog 永不弹出。
// ══════════════════════════════════════════════════════════════════

describe('UI Dialog sessionId 注入（MF-2/MF-3 R2 回归）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 活跃 session 桩：listPersistedSessions 返回 status==='active' 的 session（ActiveSessionResolver 全盘扫描依据）。 */
  function createActiveSessionStub(sessionId: string): ISessionService {
    return {
      listPersistedSessions: () => [{
        cwd: '/tmp',
        sessions: [{ id: sessionId, label: sessionId, cwd: '/tmp', status: 'active', lastActiveAt: 1, modelId: 'test-model' }],
      }],
    } as unknown as ISessionService
  }

  function createDialogService(depsOverrides?: Partial<{ sessionService: ISessionService }>): {
    service: PluginService
    broadcasts: Array<{ type: string; payload: Record<string, unknown> }>
  } {
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
      sessionService: depsOverrides?.sessionService,
    })
    ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()
    return { service, broadcasts }
  }

  it('MF-3：无活跃 session（deps.sessionService 未注入）→ broadcast payload sessionId 为 undefined', async () => {
    const { service, broadcasts } = createDialogService()
    const methods = (service as unknown as {
      rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>> }
    }).rpcServer.methods
    const confirmPromise = methods.get('plugin.ui.showConfirm')!({
      pluginId: 'test-plugin',
      title: 'Confirm?',
      message: 'Are you sure?',
    })

    const call = broadcasts.find(m => m.type === 'plugin:uiRequest')
    expect(call).toBeDefined()
    // 注入缺失回归：无 sid 的 uiRequest 会被前端 C2 守卫按 sessionId 分区丢弃
    expect(call!.payload.sessionId).toBeUndefined()

    service.handleUiResponse(call!.payload.requestId as string, true)
    await expect(confirmPromise).resolves.toBe(true)
  })

  it('MF-2：活跃 session 注入 → broadcast payload 携带 active sessionId', async () => {
    const { service, broadcasts } = createDialogService({ sessionService: createActiveSessionStub('s1') })
    const methods = (service as unknown as {
      rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>> }
    }).rpcServer.methods
    const confirmPromise = methods.get('plugin.ui.showConfirm')!({
      pluginId: 'test-plugin',
      title: 'Confirm?',
      message: 'Are you sure?',
    })

    const call = broadcasts.find(m => m.type === 'plugin:uiRequest')
    expect(call).toBeDefined()
    // 核心注入断言——resolve 时点注入 broadcast payload（与 views.update 同源）
    expect(call!.payload.sessionId).toBe('s1')

    service.handleUiResponse(call!.payload.requestId as string, true)
    await expect(confirmPromise).resolves.toBe(true)
  })
})
