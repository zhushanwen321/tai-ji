/**
 * plugin 域新增 RPC 薄封装单测（provider-plugin-access D9 / D8 / U5，验收⑤「core domain
 * 方法」段）：invokePlugin / listAvailablePlugins / getPluginCatalog / sendPluginUiEvent
 * 的帧 type、payload 形状、超时取值与 reply 解包。runtime 注册与 reply 组装由
 * packages/runtime/test/plugin-catalog-rpc.test.ts / plugin-invoke-channel.test.ts 承载；
 * 本文件只验 renderer 侧发帧契约（两侧合起来 = RPC 往返）。
 *
 * 注意：core 包不在 u-protocol 的 testCommand（runtime plugin + ui rendering-protocol）
 * 覆盖内——本文件由改动者自验后交付，全量回归归 D2 Gate A。
 *
 * 运行：cd packages/core && npx vitest run src/transport/api/__tests__/plugin-domain-rpc.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCommand = vi.fn<(type: string, payload: unknown, timeoutMs: number) => Promise<unknown>>()
vi.mock('../request', () => ({
  command: (type: string, payload: unknown, timeoutMs: number) => mockCommand(type, payload, timeoutMs),
}))

import { invokePlugin, listAvailablePlugins, getPluginCatalog, sendPluginUiEvent } from '../domains/plugin'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'

beforeEach(() => {
  vi.clearAllMocks()
  mockCommand.mockResolvedValue({})
})

describe('plugin.invoke 域封装（D9）', () => {
  it('带 params：透传 pluginId/method/params，控制范围超时，解包 reply.result', async () => {
    mockCommand.mockResolvedValue({ result: { loggedIn: true } })
    const r = await invokePlugin('wool-workbuddy', 'getStatus', { providerId: 'wool-workbuddy' })
    expect(mockCommand).toHaveBeenCalledWith(
      'plugin.invoke',
      { pluginId: 'wool-workbuddy', method: 'getStatus', params: { providerId: 'wool-workbuddy' } },
      RPC_BACKSTOP_TIMEOUT_MS,
    )
    expect(r).toEqual({ loggedIn: true })
  })

  it('无 params：payload 不带 params 键（可选键省略形态）', async () => {
    mockCommand.mockResolvedValue({ result: 'ok' })
    await invokePlugin('wool-workbuddy', 'refreshCatalog')
    expect(mockCommand.mock.calls[0]?.[1]).toEqual({ pluginId: 'wool-workbuddy', method: 'refreshCatalog' })
  })
})

describe('清单域封装（U5）', () => {
  it('listAvailablePlugins → plugin.listAvailable 无参帧 + reply 原样返回', async () => {
    const reply = { plugins: [{ packageName: '@acme/plugin-wool-workbuddy', pluginId: 'wool-workbuddy', displayName: 'WorkBuddy', pluginVersion: '1.0.0', installed: false }] }
    mockCommand.mockResolvedValue(reply)
    const r = await listAvailablePlugins()
    expect(mockCommand).toHaveBeenCalledWith('plugin.listAvailable', {}, RPC_BACKSTOP_TIMEOUT_MS)
    expect(r).toEqual(reply)
  })

  it('getPluginCatalog → plugin.catalog 无参帧 + reply 原样返回', async () => {
    const reply = { entries: [{ packageName: '@acme/plugin-wool-workbuddy', pluginId: 'wool-workbuddy', displayName: 'WorkBuddy', pluginVersion: '1.0.0' }] }
    mockCommand.mockResolvedValue(reply)
    const r = await getPluginCatalog()
    expect(mockCommand).toHaveBeenCalledWith('plugin.catalog', {}, RPC_BACKSTOP_TIMEOUT_MS)
    expect(r).toEqual(reply)
  })
})

describe('plugin.uiEvent 域封装（D8，command 通道）', () => {
  it('经 command 发 plugin.uiEvent 帧（payload 原样）并等 pong ack settle', async () => {
    const payload = { pluginId: 'wool-workbuddy', viewId: 'authorize', componentId: 'pat', event: 'change', value: 'token' }
    await expect(sendPluginUiEvent(payload)).resolves.toBeUndefined()
    expect(mockCommand).toHaveBeenCalledWith('plugin.uiEvent', payload, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('未送达（WS 未 OPEN）→ command 立即 reject 透传，不留 65s 悬挂窗口（语义实装在 request.ts command 本体，此处验证透传）', async () => {
    mockCommand.mockRejectedValue(
      Object.assign(new Error('transport unavailable (ws not open)'), { code: 'disconnected', notDelivered: true }),
    )
    await expect(
      sendPluginUiEvent({ pluginId: 'p', viewId: 'v', componentId: 'c', event: 'change', value: 1 }),
    ).rejects.toMatchObject({ code: 'disconnected', notDelivered: true })
  })
})
