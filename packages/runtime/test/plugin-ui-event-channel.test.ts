/**
 * plugin.uiEvent 投递与 plugin:event 上报通道单测（provider-plugin-access D8 / D9）：
 *
 * - uiEvent（D8，renderer → 插件）：WS 帧 handler（plugin-message-handler）→
 *   PluginService.deliverPluginUiEvent → PLUGIN_UI_EVENT_NOTIFY 单向通知发往插件
 *   Worker（fire-and-forget）；插件不存在 / Worker 不可用 → warn 丢弃不崩。
 * - plugin:event（D9，插件 → renderer）：Worker RPC plugin.event → 校验（通道身份
 *   pluginId 优先）→ broadcastPluginEvent 出线广播 'plugin:event' 帧。
 *
 * mock 策略（对齐 plugin-commands-views.test.ts）：真实 PluginRpcServer + mock
 * WorkerPort（记录 postMessage）；PluginService 实例真实装配（registerRpcMethods）。
 *
 * 运行：cd packages/runtime && npx vitest run test/plugin-ui-event-channel.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PLUGIN_UI_EVENT_NOTIFY, PLUGIN_EVENT_RPC_METHOD } from '../src/services/plugin-service/plugin-rpc-setup.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { PluginEventPayload } from '@taiji/shared'

/** 记录 postMessage 收到的消息（plugin-commands-views.test.ts 同款） */
function createMockPort<T extends { postMessage(msg: unknown): void }>(): T & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  } as T & { messages: unknown[] }
}

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/** 可对 registry/host 定制的 PluginService 装配（真实 registerRpcMethods 接线） */
function wiredService(registryOverrides: {
  descriptors?: Record<string, PluginDescriptor>
  workerIds?: Record<string, string>
} = {}, deps?: { broadcastFn?: (type: string, payload: unknown) => void }) {
  const descriptors = registryOverrides.descriptors ?? {
    'wool-workbuddy': { pluginId: 'wool-workbuddy', pluginPath: '/tmp/wool-workbuddy' } as PluginDescriptor,
  }
  const registry = {
    getDescriptor: (pluginId: string) => descriptors[pluginId],
  }
  const service = new PluginService(registry as never, createMockBroker(), deps)
  ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()
  const rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer
  const host = (service as unknown as { host: { getWorkerHandle(id: string): { workerId: string } | undefined } }).host
  host.getWorkerHandle = (pluginId: string) =>
    registryOverrides.workerIds === undefined || registryOverrides.workerIds[pluginId] === undefined
      ? { workerId: 'w1' }
      : { workerId: registryOverrides.workerIds[pluginId] }
  const port = createMockPort<WorkerPort>()
  rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'wool-workbuddy' })
  return { service, rpcServer, port }
}

describe('plugin.uiEvent 值回传投递（D8）', () => {
  let port: ReturnType<typeof createMockPort<WorkerPort>>
  let service: PluginService

  beforeEach(() => {
    const wired = wiredService()
    port = wired.port
    service = wired.service
  })

  it('WS 帧 handler → deliverPluginUiEvent：单向通知发往插件 Worker（viewId/componentId/event/value 原样透传）', async () => {
    await service.deliverPluginUiEvent('wool-workbuddy', 'authorize-view', 'pat-input', 'change', 'token-123')

    expect(port.messages).toHaveLength(1)
    // rpcServer.notify 消息形态：{ type:'rpc', notification: { jsonrpc, method, params } }
    const envelope = port.messages[0] as { type?: string; notification?: { method?: string; params?: { viewId?: string; componentId?: string; event?: string; value?: unknown } } }
    expect(envelope.type).toBe('rpc')
    expect(envelope.notification?.method).toBe(PLUGIN_UI_EVENT_NOTIFY)
    expect(envelope.notification?.params).toEqual({
      viewId: 'authorize-view',
      componentId: 'pat-input',
      event: 'change',
      value: 'token-123',
    })
  })

  it('fire-and-forget：投递不等待插件回执即 resolve（无 pending 链）', async () => {
    // 通知下发后无回传通道——deliverPluginUiEvent 不悬挂即为本语义
    await expect(
      service.deliverPluginUiEvent('wool-workbuddy', 'v', 'c', 'change', 42),
    ).resolves.toBeUndefined()
  })

  it('插件不存在（卸载/禁用后迟到回传）→ warn 丢弃，不崩、不下发', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await service.deliverPluginUiEvent('ghost-plugin', 'v', 'c', 'change', 'x')
      expect(port.messages).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('plugin not found: ghost-plugin'))
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('plugin.event 业务事件上报（D9）', () => {
  it('Worker RPC plugin.event → 校验后广播 plugin:event 帧（payload 透传，宿主不解释）', async () => {
    const broadcasts: PluginEventPayload[] = []
    const { service } = wiredService({}, {
      broadcastFn: (type: string, payload: unknown) => {
        if (type === 'plugin:event') broadcasts.push(payload as PluginEventPayload)
      },
    })
    const rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer

    await rpcServer.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: PLUGIN_EVENT_RPC_METHOD,
      params: { channel: 'credential-status', payload: { loggedIn: false, reason: 'upstream-401' } },
    })

    expect(broadcasts).toEqual([
      { pluginId: 'wool-workbuddy', channel: 'credential-status', payload: { loggedIn: false, reason: 'upstream-401' } },
    ])
  })

  it('sandbox 通道 pluginId 取通道身份（消息体自报不采信）：伪造他人 pluginId 被身份覆写', async () => {
    const broadcasts: PluginEventPayload[] = []
    const { service } = wiredService({}, {
      broadcastFn: (type: string, payload: unknown) => {
        if (type === 'plugin:event') broadcasts.push(payload as PluginEventPayload)
      },
    })
    const rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer

    // params 自报 pluginId='wool-trae'（通道身份是 wool-workbuddy）→ 身份优先
    await rpcServer.dispatch('w1', {
      jsonrpc: '2.0',
      id: 2,
      method: PLUGIN_EVENT_RPC_METHOD,
      params: { pluginId: 'wool-trae', channel: 'status', payload: {} },
    })

    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]?.pluginId).toBe('wool-workbuddy')
  })

  it('channel 缺失/非字符串 → 结构化拒绝（error response 含字段名），不广播', async () => {
    const broadcasts: PluginEventPayload[] = []
    const { service, port } = wiredService({}, {
      broadcastFn: (type: string, payload: unknown) => {
        if (type === 'plugin:event') broadcasts.push(payload as PluginEventPayload)
      },
    })
    const rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer

    // dispatch 恒 resolve（handler 抛错转 error response 回 Worker）
    await rpcServer.dispatch('w1', {
      jsonrpc: '2.0',
      id: 3,
      method: PLUGIN_EVENT_RPC_METHOD,
      params: { channel: 42, payload: {} },
    })

    expect(broadcasts).toHaveLength(0)
    expect(port.messages).toHaveLength(1)
    const errorResponse = port.messages[0] as { response?: { error?: { message?: string } } }
    expect(errorResponse.response?.error?.message).toContain('channel')
  })
})
