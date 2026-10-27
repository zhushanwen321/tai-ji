/**
 * plugin 域新增 RPC 薄封装单测（provider-plugin-access D9 / D8 / U5，验收⑤「core domain
 * 方法」段）：invokePlugin / listAvailablePlugins / getPluginCatalog / sendPluginUiEvent
 * 的帧 type、payload 形状、超时取值与 reply 解包。runtime 注册与 reply 组装由
 * packages/runtime/test/plugin-rpc-bundle.test.ts / plugin-commands-executor-timeout.test.ts 承载；
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

import {
  invokePlugin,
  listAvailablePlugins,
  getPluginCatalog,
  sendPluginUiEvent,
  listPlugins,
  togglePlugin,
  getPluginUiSnapshot,
  clearPluginMountUi,
  executePluginCommand,
  preparePluginInstall,
  confirmPluginInstall,
  cancelPluginInstall,
} from '../domains/plugin'
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

describe('插件运行态封装（S13：list / toggle / ui.snapshot / ui.clearMount）', () => {
  it('listPlugins → plugin.list 无参帧，解包 reply.plugins', async () => {
    const plugins = [{ id: 'wool-workbuddy', status: 'crashed' }]
    mockCommand.mockResolvedValue({ plugins })
    await expect(listPlugins()).resolves.toBe(plugins)
    expect(mockCommand).toHaveBeenCalledWith('plugin.list', {}, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('togglePlugin → plugin.toggle 透传 pluginId/enabled，解包 reply.plugins', async () => {
    const plugins = [{ id: 'wool-workbuddy', status: 'active' }]
    mockCommand.mockResolvedValue({ plugins })
    await expect(togglePlugin('wool-workbuddy', false)).resolves.toBe(plugins)
    expect(mockCommand).toHaveBeenCalledWith('plugin.toggle', { pluginId: 'wool-workbuddy', enabled: false }, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('getPluginUiSnapshot → plugin.ui.snapshot 透传 filter（scope 二选一形态原样）', async () => {
    const snapshot = { partitions: {} }
    mockCommand.mockResolvedValue(snapshot)
    const filter = { mountId: 'mount-1', pluginId: 'wool-workbuddy', viewId: 'authorize' }
    await expect(getPluginUiSnapshot(filter)).resolves.toBe(snapshot)
    expect(mockCommand).toHaveBeenCalledWith('plugin.ui.snapshot', filter, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('getPluginUiSnapshot 缺省 filter = 全量拉取（空对象帧）', async () => {
    mockCommand.mockResolvedValue({ partitions: {} })
    await getPluginUiSnapshot()
    expect(mockCommand).toHaveBeenCalledWith('plugin.ui.snapshot', {}, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('clearPluginMountUi → plugin.ui.clearMount 透传 mountId 并等 pong ack settle', async () => {
    await expect(clearPluginMountUi('mount-1')).resolves.toBeUndefined()
    expect(mockCommand).toHaveBeenCalledWith('plugin.ui.clearMount', { mountId: 'mount-1' }, RPC_BACKSTOP_TIMEOUT_MS)
  })
})

describe('插件命令与两段式安装封装（D7/S7 + U4/U6）', () => {
  it('executePluginCommand → plugin.executeCommand payload 原样透传并等 pong ack settle', async () => {
    const payload = { pluginId: 'wool-workbuddy', commandId: 'probe-command', args: { k: 1 } }
    await expect(executePluginCommand(payload)).resolves.toBeUndefined()
    expect(mockCommand).toHaveBeenCalledWith('plugin.executeCommand', payload, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('preparePluginInstall → plugin.prepareInstall 透传 packageSpec，知情面 reply 原样返回', async () => {
    const reply = { pluginId: 'wool-workbuddy', packageName: '@acme/plugin-wool-workbuddy', version: '1.0.0', capabilities: [], readPaths: [], permissions: [] }
    mockCommand.mockResolvedValue(reply)
    await expect(preparePluginInstall('@acme/plugin-wool-workbuddy')).resolves.toBe(reply)
    expect(mockCommand).toHaveBeenCalledWith('plugin.prepareInstall', { packageSpec: '@acme/plugin-wool-workbuddy' }, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('confirmPluginInstall → plugin.confirmInstall 透传 pluginId，reply 原样返回', async () => {
    const reply = { success: true }
    mockCommand.mockResolvedValue(reply)
    await expect(confirmPluginInstall('wool-workbuddy')).resolves.toBe(reply)
    expect(mockCommand).toHaveBeenCalledWith('plugin.confirmInstall', { pluginId: 'wool-workbuddy' }, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('cancelPluginInstall → plugin.cancelInstall 透传 pluginId 并等 pong ack settle', async () => {
    await expect(cancelPluginInstall('wool-workbuddy')).resolves.toBeUndefined()
    expect(mockCommand).toHaveBeenCalledWith('plugin.cancelInstall', { pluginId: 'wool-workbuddy' }, RPC_BACKSTOP_TIMEOUT_MS)
  })
})
