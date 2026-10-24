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

const mockWsSend = vi.fn<(msg: unknown) => boolean>()
vi.mock('../../ws-client', () => ({
  send: (msg: unknown) => mockWsSend(msg),
}))

/** pending 手工展开路径（sendPluginUiEvent）的登记/拒绝捕获；其余导出保留真实实现 */
let resolvePending: ((value: void) => void) | undefined
let rejectPending: ((error: unknown) => void) | undefined
const mockCreateCommandId = vi.fn(() => 'cmd-ui-event')
const mockRegister = vi.fn((_id: string, _timeoutMs: number) => new Promise<void>((resolve, reject) => {
  resolvePending = resolve
  rejectPending = reject
}))
const mockReject = vi.fn((id: string, error: unknown) => {
  rejectPending?.(error)
})
vi.mock('../pending', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pending')>()
  return {
    ...actual,
    createCommandId: () => mockCreateCommandId(),
    register: (id: string, timeoutMs: number) => mockRegister(id, timeoutMs),
    reject: (id: string, error: unknown) => mockReject(id, error),
  }
})

import { invokePlugin, listAvailablePlugins, getPluginCatalog, sendPluginUiEvent } from '../domains/plugin'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'

beforeEach(() => {
  vi.clearAllMocks()
  resolvePending = undefined
  rejectPending = undefined
  mockCommand.mockResolvedValue({})
  mockWsSend.mockReturnValue(true)
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

describe('plugin.uiEvent 域封装（D8，手工 pending 展开）', () => {
  it('发 plugin.uiEvent 帧（id + payload 原样）并等 pong settle', async () => {
    const payload = { pluginId: 'wool-workbuddy', viewId: 'authorize', componentId: 'pat', event: 'change', value: 'token' }
    const pendingCall = sendPluginUiEvent(payload)

    expect(mockRegister).toHaveBeenCalledWith('cmd-ui-event', RPC_BACKSTOP_TIMEOUT_MS)
    expect(mockWsSend).toHaveBeenCalledWith({ type: 'plugin.uiEvent', id: 'cmd-ui-event', payload })

    resolvePending?.()
    await expect(pendingCall).resolves.toBeUndefined()
  })

  it('send 返回 false（WS 未 OPEN）→ 立即 reject pending，不留 65s 悬挂窗口', async () => {
    mockWsSend.mockReturnValue(false)
    const pendingCall = sendPluginUiEvent({ pluginId: 'p', viewId: 'v', componentId: 'c', event: 'change', value: 1 })

    expect(mockReject).toHaveBeenCalledTimes(1)
    await expect(pendingCall).rejects.toMatchObject({ code: 'disconnected', notDelivered: true })
  })
})
