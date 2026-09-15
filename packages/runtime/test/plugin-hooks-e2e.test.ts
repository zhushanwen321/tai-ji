/**
 * Hook 执行链路端到端测试（D2-6，消灭 mock 盲区）
 *
 * 与既有单测的本质区别——串起完整真实链路，不 mock 传输层任何一环：
 *
 *   [主线程]                                [Worker 侧（同进程内存对）]
 *   PluginService.executeHooks
 *     → HookPipeline.execute / notifyObservers
 *       → PluginRpcServer.invoke / notify        （真实 RPC server，pending/超时全套）
 *         ── portB.postMessage ──→ MessageChannel ──→ portA
 *                                            handleMessage                （真实 bootstrap 消息循环）
 *                                              → handleIncomingRequest / notification 分支
 *                                                → executeHookRequest      （真实 hook-api 胶水）
 *                                                  → 插件 handler
 *                                                ← postRpcResponse / fire-and-forget
 *         ←── rpcServer.handleResponse ←── portB ←──────────────── portA
 *     → HookResult（D2-3 映射层）
 *
 * 传输宿主用 node:worker_threads 的 MessageChannel 内存端口对（不 spawn 真实线程）：
 * plugin-bootstrap 的 Worker 装载在 vitest 环境不可行（Node Worker 无法加载 .ts 源文件，
 * 且测试环境无 tsup bundle 产物），退路为「真实 handleMessage 函数 + MessageChannel 端口」
 * ——W02 任务书允许的降级形态：hook 路由/协议/执行逻辑 100% 真实，仅线程边界换为内存端口。
 *
 * 双宿主覆盖（01 文档 §5 待验证检查点）：
 * - Worker 宿主：直接驱动 plugin-bootstrap 的 handleMessage（模拟 parentPort.on('message')），
 *   post 通道经 setPostMessage 注入 portA，workerRpcClient attach 到 portA
 * - fork 子进程宿主：动态 import plugin-bootstrap-process.ts（触发其真实顶层 wiring：
 *   setPostMessage(process.send) + workerRpcClient.attach(process.send 包装) +
 *   process.on('message')），mock process.send 指向端口、portC 消息经 process.emit('message')
 *   转投——传输缝真实（process.send / process.on('message')），处理函数与 Worker 宿主
 *   单一真相（同一 handleMessage）
 *
 * 三语义断言：block 生效 / transform 生效 / observe 通知不产生响应。
 * 与 plugin-demo-e2e TC-D06（mock context.api.hooks 直调 handler）显式区分：本文件传输层零 mock。
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { registerHookRpcHandlers, disposePluginHooks } from '../src/services/plugin-service/hook-api.js'
import { dispatchHostRpcMessage } from '../src/services/plugin-service/plugin-host.js'
import {
  handleMessage,
  setPostMessage,
  createAgentAPI,
  workerRpcClient,
} from '../src/services/plugin-service/plugin-bootstrap.js'
import type {
  HostToWorkerMessage,
  HookEntry,
  PluginDescriptor,
} from '../src/services/plugin-service/plugin-types.js'
import type { IMessageBroker } from '../src/interfaces.js'

// ── Helpers ────────────────────────────────────────────────────

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/**
 * e2e 装置：一个宿主实例的完整接线。
 *
 * Worker 侧（内存端口对 A 端）：post 通道 + 入站消息泵（驱动真实 handleMessage）+
 * workerRpcClient attach（插件 hook 注册走真实 RPC client）。
 * 主线程侧（B 端）：真实 PluginRpcServer（registerWorker + invoke/notify/handleResponse）+
 * registerHookRpcHandlers + PluginService（executeHooks 分流：observe 快捷路径 / execute）。
 */
interface E2eHarness {
  service: PluginService
  hookRegistry: Map<string, HookEntry[]>
  /** 主线程侧收到的全部消息（observe「不产生响应」断言用） */
  hostReceived: Array<Record<string, unknown>>
  makeAgentApi(pluginId: string): ReturnType<typeof createAgentAPI>
  pluginId: string
}

/**
 * 主线程消息泵：等价 PluginHost 的 worker.on('message') rpc 分发逻辑（传输适配层）。
 * Fix-3：rpc 分支复用 plugin-host 导出的 dispatchHostRpcMessage——与
 * plugin-host / plugin-host-process 生产实现单一真相，主线程分发链变更即时覆盖。
 */
function hostMessagePump(
  port: MessagePort,
  workerId: string,
  service: PluginService,
  hostReceived: Array<Record<string, unknown>>,
): void {
  port.on('message', (m: Record<string, unknown>) => {
    hostReceived.push(m)
    if (m.type !== 'rpc') return
    dispatchHostRpcMessage(service.rpcServer, workerId, m)
  })
}

/** Worker 侧入站泵：等价 parentPort.on('message', m => handleMessage(m)) */
function workerMessagePump(port: MessagePort): void {
  port.on('message', (m: HostToWorkerMessage) => {
    // 对齐 plugin-bootstrap 顶层包装：错误经 post 通道回 fatal_error（post 已注入）
    handleMessage(m).catch(() => {})
  })
}

function createHarness(hostPort: MessagePort, workerId: string, pluginId: string): E2eHarness {
  const service = new PluginService({} as never, createMockBroker())
  const hookRegistry = (service as unknown as { hookPipeline: { registry: Map<string, HookEntry[]> } }).hookPipeline.registry
  const hostReceived: Array<Record<string, unknown>> = []

  // 主线程：RPC 方法 + worker 注册 + 消息泵
  registerHookRpcHandlers(service.rpcServer, {
    hookRegistry,
    getDescriptor: (pid) => ({ pluginId: pid } as PluginDescriptor),
  })
  service.rpcServer.registerWorker(workerId, {
    postMessage: (message: unknown) => hostPort.postMessage(message),
  })
  hostMessagePump(hostPort, workerId, service, hostReceived)

  // host stub：仅替代「线程/进程 spawn」层——把主线程出站消息导向 hostPort。
  // 注意 HookPipeline 在 PluginService 构造时捕获 host 引用（readonly 字段），
  // stub 必须写进 pipeline 内部引用，替换 service.host 属性对 execute 不生效
  ;((service as unknown as { hookPipeline: { host: unknown } }).hookPipeline).host = {
    getWorkerHandle: () => ({
      workerId,
      postMessage: (message: unknown) => hostPort.postMessage(message),
    }),
  }

  return {
    service,
    hookRegistry,
    hostReceived,
    makeAgentApi: (pid: string) => createAgentAPI(pid),
    pluginId,
  }
}

/** 等待条件成立（observe fire-and-forget 断言用） */
async function waitFor(cond: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** 等待消息流静默（无新消息到达，observe「不产生响应」断言用） */
async function settleQuiet(received: Array<unknown>, quietMs = 50): Promise<void> {
  let last = received.length
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, quietMs))
    if (received.length === last) return
    last = received.length
  }
}

// ══════════════════════════════════════════════════════════════════
// 宿主 1：Worker Thread（plugin-bootstrap.handleMessage + parentPort 语义）
// ══════════════════════════════════════════════════════════════════

describe('plugin-hooks e2e — Worker host (plugin-bootstrap.handleMessage)', () => {
  const { port1: portA, port2: portB } = new MessageChannel()
  let harness: E2eHarness

  beforeAll(() => {
    // Worker 侧传输接线（对齐真实 Worker：post 通道 + 入站泵 + rpcClient attach）
    setPostMessage((msg: unknown) => {
      portA.postMessage(msg)
    })
    workerRpcClient.attach({ postMessage: (msg: unknown) => portA.postMessage(msg) })
    workerMessagePump(portA)
    harness = createHarness(portB, 'e2e-worker-1', 'e2e-plugin')
  })

  afterAll(() => {
    harness.hookRegistry.clear()
    disposePluginHooks('e2e-plugin')
    portA.close()
    portB.close()
  })

  it('registers hook via real RPC round-trip (plugin.hooks.register lands in main-thread registry)', async () => {
    const api = harness.makeAgentApi('e2e-plugin')
    await api.hooks.onBeforeSendMessage(async () => ({ proceed: true }))

    const entries = harness.hookRegistry.get('onBeforeSendMessage')
    expect(entries).toBeTruthy()
    expect(entries!.length).toBe(1)
    expect(entries![0].pluginId).toBe('e2e-plugin')
    expect(typeof entries![0].handlerId).toBe('string')
  })

  it('block semantics: handler proceed:false → executeHooks returns blocked with reason (request leg)', async () => {
    const api = harness.makeAgentApi('e2e-plugin')
    await api.hooks.onBeforeToolCall(async () => ({
      proceed: false,
      reason: 'API key detected',
    }))

    const result = await harness.service.executeHooks('onBeforeToolCall', {
      pluginId: '',
      hookType: 'onBeforeToolCall',
      data: { toolName: 'bash' },
      timestamp: Date.now(),
    })

    expect(result.blocked).toBe(true)
    expect(result.blockedBy).toBe('e2e-plugin')
    expect(result.reason).toBe('API key detected')
  })

  it('transform semantics: handler modifiedData → HookResult.transformedData (D2-3 mapping, request leg)', async () => {
    const api = harness.makeAgentApi('e2e-plugin')
    await api.hooks.onBeforeSendMessage(async (ctx) => {
      const content = (ctx.data as { content?: string }).content ?? ''
      return { proceed: true, modifiedData: { content: content.replace('!important', 'IMPORTANT') } }
    })

    const result = await harness.service.executeHooks('onBeforeSendMessage', {
      pluginId: '',
      hookType: 'onBeforeSendMessage',
      data: { content: 'hello !important world' },
      timestamp: Date.now(),
    })

    expect(result.blocked).toBe(false)
    // D2-3：Worker 响应的 modifiedData 经主线程映射层暴露为 transformedData
    expect(result.transformedData).toEqual({ content: 'hello IMPORTANT world' })
  })

  it('observe semantics: onPiEvent dispatched via notify — handler fires, no response produced (D2-2)', async () => {
    const api = harness.makeAgentApi('e2e-plugin')
    const observed: Array<{ eventName: string; data: unknown }> = []
    await api.hooks.onPiEvent('agent_start', async (eventName, data) => {
      observed.push({ eventName, data })
    })
    // 注册 key 已统一泛型（D2-4）：registry 条目在 'onPiEvent' 而非 'onPiEvent:agent_start'
    expect(harness.hookRegistry.has('onPiEvent')).toBe(true)
    expect(harness.hookRegistry.has('onPiEvent:agent_start')).toBe(false)

    harness.hostReceived.length = 0
    const notifySpy = vi.spyOn(harness.service.rpcServer, 'notify')
    const invokeSpy = vi.spyOn(harness.service.rpcServer, 'invoke')
    const result = await harness.service.executeHooks('onPiEvent', {
      pluginId: '',
      hookType: 'onPiEvent',
      data: { eventName: 'agent_start', data: { sessionId: 's-e2e' } },
      timestamp: Date.now(),
    })

    // observe 快捷路径：立即返回不 block；经 notify（无 id 通知）派发，不创建 invoke
    expect(result).toEqual({ blocked: false })
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy.mock.calls[0][1]).toBe('plugin.hooks.invoke')
    expect(invokeSpy).not.toHaveBeenCalled()
    notifySpy.mockRestore()
    invokeSpy.mockRestore()

    // Worker handler 收到通知并执行（事件名/负载形状经 hook-api 包装适配）
    await waitFor(() => observed.length === 1)
    expect(observed[0].eventName).toBe('agent_start')
    expect(observed[0].data).toEqual({ sessionId: 's-e2e' })

    // 关键断言：零往返——Worker 对通知不产生任何响应（hostReceived 只收 Worker 发回的
    // 消息，保持为空 = 无 postRpcResponse、无错误回包）
    await settleQuiet(harness.hostReceived)
    expect(harness.hostReceived.length).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════
// 宿主 2：fork 子进程（plugin-bootstrap-process 顶层 wiring + process.send/on 语义）
// ══════════════════════════════════════════════════════════════════

describe('plugin-hooks e2e — process host (plugin-bootstrap-process)', () => {
  const { port1: portC, port2: portD } = new MessageChannel()
  let harness: E2eHarness
  let wiringLoaded = false

  beforeAll(async () => {
    // mock process.send → 指向端口 C（子进程宿主顶层 wiring 的闭包动态读 process.send，
    // defineProperty 后天然生效——等价 fork channel 的出站方向）
    Object.defineProperty(process, 'send', {
      value: (msg: unknown) => portC.postMessage(msg),
      configurable: true,
      writable: true,
    })

    // 动态 import 触发真实顶层 wiring：setPostMessage(process.send 包装) +
    // workerRpcClient.attach(process.send 包装) + process.on('message', ...)
    await import('../src/services/plugin-service/plugin-bootstrap-process.js')
    wiringLoaded = true

    // 入站方向：fork channel 收到消息触发 process.on('message') —— 内存对等价物是
    // 把到达 portC 的消息经 process.emit('message') 转投（pump 只做传输转接，处理仍是
    // plugin-bootstrap-process 顶层注册的真实 handler → 共享 handleMessage）。
    // process.emit 的 TS 重载不认 'message'（按 Signals 处理），经 EventEmitter 类型
    // 转换调用（运行时 process 就是 EventEmitter）
    portC.on('message', (m: HostToWorkerMessage) => {
      ;(process as unknown as NodeJS.EventEmitter).emit('message', m)
    })

    harness = createHarness(portD, 'e2e-process-1', 'e2e-process-plugin')
  })

  afterAll(() => {
    harness.hookRegistry.clear()
    disposePluginHooks('e2e-process-plugin')
    portC.close()
    portD.close()
    // 恢复 process.send（非 IPC 进程原值为 undefined）
    delete (process as { send?: unknown }).send
  })

  it('plugin-bootstrap-process top-level wiring is active (post + shared rpcClient on process.send)', () => {
    expect(wiringLoaded).toBe(true)
  })

  it('block semantics via process IPC channel (request leg)', async () => {
    const api = harness.makeAgentApi('e2e-process-plugin')
    await api.hooks.onBeforeToolCall(async () => ({
      proceed: false,
      reason: 'blocked by sandbox plugin',
    }))
    expect(harness.hookRegistry.get('onBeforeToolCall')!.length).toBe(1)

    const result = await harness.service.executeHooks('onBeforeToolCall', {
      pluginId: '',
      hookType: 'onBeforeToolCall',
      data: { toolName: 'fs.read' },
      timestamp: Date.now(),
    })

    expect(result.blocked).toBe(true)
    expect(result.blockedBy).toBe('e2e-process-plugin')
    expect(result.reason).toBe('blocked by sandbox plugin')
  })

  it('transform semantics via process IPC channel (D2-3 mapping, request leg)', async () => {
    const api = harness.makeAgentApi('e2e-process-plugin')
    await api.hooks.onAfterToolResult(async (ctx) => {
      const output = (ctx.data as { output?: string }).output ?? ''
      return { proceed: true, modifiedData: { output: output.toUpperCase() } }
    })

    const result = await harness.service.executeHooks('onAfterToolResult', {
      pluginId: '',
      hookType: 'onAfterToolResult',
      data: { output: 'raw result' },
      timestamp: Date.now(),
    })

    expect(result.blocked).toBe(false)
    expect(result.transformedData).toEqual({ output: 'RAW RESULT' })
  })

  it('observe semantics via process IPC channel — no response (D2-2)', async () => {
    const api = harness.makeAgentApi('e2e-process-plugin')
    const observed: string[] = []
    await api.hooks.onPiEvent('session_start', async (eventName) => {
      observed.push(eventName)
    })

    harness.hostReceived.length = 0
    const notifySpy = vi.spyOn(harness.service.rpcServer, 'notify')
    const invokeSpy = vi.spyOn(harness.service.rpcServer, 'invoke')
    await harness.service.executeHooks('onPiEvent', {
      pluginId: '',
      hookType: 'onPiEvent',
      data: { eventName: 'session_start', data: {} },
      timestamp: Date.now(),
    })
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(invokeSpy).not.toHaveBeenCalled()
    notifySpy.mockRestore()
    invokeSpy.mockRestore()

    await waitFor(() => observed.length === 1)
    expect(observed).toEqual(['session_start'])
    // 零往返：Worker 对通知不产生任何响应（hostReceived 只收 Worker 发回的消息）
    await settleQuiet(harness.hostReceived)
    expect(harness.hostReceived.length).toBe(0)
  })
})
