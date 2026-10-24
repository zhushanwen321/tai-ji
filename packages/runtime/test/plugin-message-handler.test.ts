/**
 * PluginMessageHandler 单测 — plugin.* 表驱动分发全分支锚定。
 *
 * 覆盖（complexity-debt 第二批 U08，handlePluginMessage switch→表驱动重构的行为锚定）：
 * - 前置检查：pluginService null → sendError('handler_error')，不触分发表
 * - 12 个 plugin.* case 的 reply/error 路径（payload 透传 + 文案逐字节）
 * - plugin.install 的 invalid_params / success / failure(+error 缺省兜底) 三分支
 * - E6（AP-3）：executeCommand args 非标量 → INVALID_ARGS，不 dispatch
 * - 落空语义：未知 type 不调用任何 service 方法、无 reply/error（原 switch 无 default）
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/plugin-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { PluginMessageHandler } from '../src/transport/plugin-message-handler.js'
import type { ClientMessage } from '@taiji/shared'

interface CapturedReply {
  id: string | undefined
  type: string
  payload: Record<string, unknown>
}

interface CapturedError {
  code: string
  message: string
  id: string | undefined
}

/** 构造 mock ctx + 捕获 reply/error。pluginService 各方法可按用例 override（未给的为 vi.fn()）。 */
function makeHandler(pluginServiceMethods: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const replies: CapturedReply[] = []
  const errors: CapturedError[] = []
  const pluginService = {
    getDiscoveredPlugins: vi.fn().mockReturnValue([]),
    togglePlugin: vi.fn().mockResolvedValue([]),
    uninstallPlugin: vi.fn().mockResolvedValue([]),
    approvePermissions: vi.fn().mockResolvedValue(undefined),
    revokePermissions: vi.fn().mockResolvedValue(undefined),
    denyPermissions: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue(undefined),
    getPluginConfig: vi.fn().mockResolvedValue({}),
    setPluginConfig: vi.fn().mockResolvedValue(undefined),
    installPlugin: vi.fn().mockResolvedValue({ success: true }),
    handleUiResponse: vi.fn(),
    syncMountPoints: vi.fn(),
    // provider-plugin-access D9 / D8 / U5
    invokePlugin: vi.fn().mockResolvedValue(undefined),
    deliverPluginUiEvent: vi.fn().mockResolvedValue(undefined),
    listAvailablePlugins: vi.fn().mockResolvedValue({ plugins: [] }),
    getPluginCatalog: vi.fn().mockResolvedValue({ entries: [] }),
    ...pluginServiceMethods,
  }
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id: string | undefined) => {
      errors.push({ code, message, id })
    }),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      replies.push({ id, type, payload })
    }),
    pluginService,
  }
  const handler = new PluginMessageHandler(ctx as unknown as ConstructorParameters<typeof PluginMessageHandler>[0])
  return { replies, errors, handler, pluginService }
}

function buildMsg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const WS = {} as never

describe('PluginMessageHandler — 前置检查（D3）', () => {
  it('pluginService 为 null → sendError handler_error，不触分发表', async () => {
    const { replies, errors, pluginService } = makeHandler()
    const nullCtx = {
      send: vi.fn(),
      sendError: vi.fn((_ws: unknown, code: string, message: string, id: string | undefined) => {
        errors.push({ code, message, id })
      }),
      reply: vi.fn(),
      pluginService: null,
    }
    const handler = new PluginMessageHandler(nullCtx as unknown as ConstructorParameters<typeof PluginMessageHandler>[0])
    await handler.handlePluginMessage(buildMsg('plugin.list', {}), WS)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'handler_error', message: 'Plugin service not available', id: 'm1' })
    expect(replies).toHaveLength(0)
    expect(pluginService.getDiscoveredPlugins).not.toHaveBeenCalled()
  })
})

describe('PluginMessageHandler — 查询/操作类 case', () => {
  it('plugin.list → reply config.plugins {plugins}', async () => {
    const plugins = [{ id: 'p1' }]
    const { replies, handler, pluginService } = makeHandler({ getDiscoveredPlugins: vi.fn().mockReturnValue(plugins) })
    await handler.handlePluginMessage(buildMsg('plugin.list', {}), WS)
    expect(pluginService.getDiscoveredPlugins).toHaveBeenCalledTimes(1)
    expect(replies).toEqual([{ id: 'm1', type: 'config.plugins', payload: { plugins } }])
  })

  it('plugin.toggle → togglePlugin(pluginId, enabled) + reply config.plugins（toggled 返回值）', async () => {
    const toggled = [{ id: 'p2', enabled: false }]
    const { replies, handler, pluginService } = makeHandler({ togglePlugin: vi.fn().mockResolvedValue(toggled) })
    await handler.handlePluginMessage(buildMsg('plugin.toggle', { pluginId: 'p2', enabled: false }), WS)
    expect(pluginService.togglePlugin).toHaveBeenCalledWith('p2', false)
    expect(replies).toEqual([{ id: 'm1', type: 'config.plugins', payload: { plugins: toggled } }])
  })

  it('plugin.uninstall → uninstallPlugin + reply config.plugins', async () => {
    const uninstalled = [{ id: 'p3' }]
    const { replies, handler, pluginService } = makeHandler({ uninstallPlugin: vi.fn().mockResolvedValue(uninstalled) })
    await handler.handlePluginMessage(buildMsg('plugin.uninstall', { pluginId: 'p3' }), WS)
    expect(pluginService.uninstallPlugin).toHaveBeenCalledWith('p3')
    expect(replies).toEqual([{ id: 'm1', type: 'config.plugins', payload: { plugins: uninstalled } }])
  })

  it('plugin.approvePermissions → approvePermissions + reply pong（列表刷新经广播，不现算）', async () => {
    const { replies, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.approvePermissions', { pluginId: 'p4', permissions: ['fs:read'] }), WS)
    expect(pluginService.approvePermissions).toHaveBeenCalledWith('p4', ['fs:read'])
    // reply = pong ack（对齐 plugin.executeCommand 先例）；插件列表刷新由
    // plugin-service.approvePermissions 广播 config.plugins 承担，handler 不再现算
    expect(pluginService.getDiscoveredPlugins).not.toHaveBeenCalled()
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
  })

  it('plugin.revokePermissions → revokePermissions + reply pong（无列表刷新广播）', async () => {
    const { replies, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.revokePermissions', { pluginId: 'p5' }), WS)
    expect(pluginService.revokePermissions).toHaveBeenCalledWith('p5')
    expect(pluginService.getDiscoveredPlugins).not.toHaveBeenCalled()
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
  })

  it('plugin.denyPermissions → denyPermissions + reply pong（拒绝本次申请，不回收已授权限）', async () => {
    const { replies, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.denyPermissions', { pluginId: 'p5' }), WS)
    expect(pluginService.denyPermissions).toHaveBeenCalledWith('p5')
    expect(pluginService.getDiscoveredPlugins).not.toHaveBeenCalled()
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
  })

  it('plugin.executeCommand → executeCommand + reply pong {}', async () => {
    const { replies, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.executeCommand', { pluginId: 'p6', commandId: 'cmd1', args: { a: 1 } }), WS)
    expect(pluginService.executeCommand).toHaveBeenCalledWith('p6', 'cmd1', { a: 1 })
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
  })

  it('E6: args 含非标量值 → INVALID_ARGS error envelope，不 dispatch handler', async () => {
    const { replies, errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.executeCommand', { pluginId: 'p6', commandId: 'cmd1', args: { nested: { x: 1 } } }), WS)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'INVALID_ARGS', id: 'm1' })
    expect(pluginService.executeCommand).not.toHaveBeenCalled()
    expect(replies).toHaveLength(0)
  })

  it('E6: args 数组形态同样拒绝（非 flat scalar record）', async () => {
    const { errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.executeCommand', { pluginId: 'p6', commandId: 'cmd1', args: ['a'] }), WS)
    expect(errors[0]?.code).toBe('INVALID_ARGS')
    expect(pluginService.executeCommand).not.toHaveBeenCalled()
  })

  it('plugin.uiResponse → handleUiResponse(requestId, result) + reply pong {}', async () => {
    const { replies, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.uiResponse', { requestId: 'req-9', result: { ok: true } }), WS)
    expect(pluginService.handleUiResponse).toHaveBeenCalledWith('req-9', { ok: true })
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
  })

  it('plugin.mountPoints.sync → syncMountPoints（覆盖式整表）+ reply pong {}', async () => {
    const { replies, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.mountPoints.sync', { mountPoints: ['a', 'b'] }), WS)
    expect(pluginService.syncMountPoints).toHaveBeenCalledWith(['a', 'b'])
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
  })
})

describe('PluginMessageHandler — plugin.invoke / plugin.uiEvent / 清单域（provider-plugin-access D8/D9/U5）', () => {
  it('plugin.invoke → invokePlugin(pluginId, method, params) + reply plugin.invoke { result }', async () => {
    const { replies, handler, pluginService } = makeHandler({
      invokePlugin: vi.fn().mockResolvedValue({ loggedIn: true }),
    })
    await handler.handlePluginMessage(buildMsg('plugin.invoke', {
      pluginId: 'wool-workbuddy',
      method: 'getStatus',
      params: { providerId: 'wool-workbuddy' },
    }), WS)
    expect(pluginService.invokePlugin).toHaveBeenCalledWith('wool-workbuddy', 'getStatus', { providerId: 'wool-workbuddy' })
    expect(replies).toEqual([{ id: 'm1', type: 'plugin.invoke', payload: { result: { loggedIn: true } } }])
  })

  it('plugin.invoke method 缺失/空串 → INVALID_ARGS，不触执行链', async () => {
    const { errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.invoke', { pluginId: 'p1', method: '' }), WS)
    expect(errors[0]).toMatchObject({ code: 'INVALID_ARGS', id: 'm1' })
    expect(pluginService.invokePlugin).not.toHaveBeenCalled()
  })

  it('plugin.uiEvent 合法值（标量 / 两层容器）→ deliverPluginUiEvent 原样透传 + reply pong', async () => {
    const { replies, handler, pluginService } = makeHandler()
    // 深度 2 容器（root + 一层）+ 标量叶子 + 标量本身，两种形态都合法
    await handler.handlePluginMessage(buildMsg('plugin.uiEvent', {
      pluginId: 'wool-workbuddy',
      viewId: 'authorize',
      componentId: 'pat',
      event: 'change',
      value: { form: { token: 'abc', remember: true } },
    }), WS)
    expect(pluginService.deliverPluginUiEvent).toHaveBeenCalledWith(
      'wool-workbuddy', 'authorize', 'pat', 'change', { form: { token: 'abc', remember: true } },
    )
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])

    await handler.handlePluginMessage(buildMsg('plugin.uiEvent', {
      pluginId: 'wool-workbuddy', viewId: 'authorize', componentId: 'pat', event: 'change', value: 'scalar-token',
    }), WS)
    expect(pluginService.deliverPluginUiEvent).toHaveBeenCalledTimes(2)
  })

  it('plugin.uiEvent 值深度 > 2 → INVALID_ARGS，不投递（D8 形状校验）', async () => {
    const { errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.uiEvent', {
      pluginId: 'wool-workbuddy',
      viewId: 'authorize',
      componentId: 'pat',
      event: 'change',
      value: { a: { b: { c: 'too-deep' } } },
    }), WS)
    expect(errors[0]).toMatchObject({ code: 'INVALID_ARGS', id: 'm1' })
    expect(errors[0]?.message).toContain('at most 2 levels')
    expect(pluginService.deliverPluginUiEvent).not.toHaveBeenCalled()
  })

  it('plugin.uiEvent 非标量叶子（函数等）→ INVALID_ARGS，不投递', async () => {
    const { errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.uiEvent', {
      pluginId: 'wool-workbuddy',
      viewId: 'authorize',
      componentId: 'pat',
      event: 'change',
      value: { cb: () => undefined },
    }), WS)
    expect(errors[0]).toMatchObject({ code: 'INVALID_ARGS' })
    expect(pluginService.deliverPluginUiEvent).not.toHaveBeenCalled()
  })

  it('plugin.uiEvent 路由字段缺失 → INVALID_ARGS（componentId / event 非空字符串）', async () => {
    const { errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.uiEvent', {
      pluginId: 'wool-workbuddy', viewId: 'authorize', componentId: '', event: 'change', value: 'x',
    }), WS)
    expect(errors[0]).toMatchObject({ code: 'INVALID_ARGS' })
    expect(pluginService.deliverPluginUiEvent).not.toHaveBeenCalled()
  })

  it('plugin.listAvailable / plugin.catalog → reply 同名帧（清单 service 回复透传）', async () => {
    const available = { plugins: [{ packageName: '@acme/plugin-wool-workbuddy', pluginId: 'wool-workbuddy', displayName: 'WorkBuddy', pluginVersion: '1.0.0', installed: false }] }
    const catalog = { entries: [{ packageName: '@acme/plugin-wool-workbuddy', pluginId: 'wool-workbuddy', displayName: 'WorkBuddy', pluginVersion: '1.0.0' }] }
    const { replies, handler } = makeHandler({
      listAvailablePlugins: vi.fn().mockResolvedValue(available),
      getPluginCatalog: vi.fn().mockResolvedValue(catalog),
    })

    await handler.handlePluginMessage(buildMsg('plugin.listAvailable', {}), WS)
    await handler.handlePluginMessage(buildMsg('plugin.catalog', {}), WS)

    expect(replies).toEqual([
      { id: 'm1', type: 'plugin.listAvailable', payload: available },
      { id: 'm1', type: 'plugin.catalog', payload: catalog },
    ])
  })
})

describe('PluginMessageHandler — plugin.config.*', () => {
  it('config.get 带 key → reply plugin:config 单键包装', async () => {
    // key 路径：getPluginConfig(pluginId, key) 返回该 key 的值，handler 包装为 { [key]: value }
    const { replies, handler, pluginService } = makeHandler({ getPluginConfig: vi.fn().mockResolvedValue('dark') })
    await handler.handlePluginMessage(buildMsg('plugin.config.get', { pluginId: 'p7', key: 'theme' }), WS)
    expect(pluginService.getPluginConfig).toHaveBeenCalledWith('p7', 'theme')
    expect(replies).toEqual([{ id: 'm1', type: 'plugin:config', payload: { pluginId: 'p7', config: { theme: 'dark' } } }])
  })

  it('config.get key 缺省 → __all__ 整包路径（config 原样返回）', async () => {
    const allConfig = { theme: 'dark', level: 2 }
    const { replies, handler, pluginService } = makeHandler({ getPluginConfig: vi.fn().mockResolvedValue(allConfig) })
    await handler.handlePluginMessage(buildMsg('plugin.config.get', { pluginId: 'p7' }), WS)
    expect(pluginService.getPluginConfig).toHaveBeenCalledWith('p7', undefined)
    expect(replies).toEqual([{ id: 'm1', type: 'plugin:config', payload: { pluginId: 'p7', config: allConfig } }])
  })

  it('config.set → setPluginConfig + getPluginConfig 全量回读 + reply plugin:config', async () => {
    const allConfig = { key1: 'v1' }
    const { replies, handler, pluginService } = makeHandler({ getPluginConfig: vi.fn().mockResolvedValue(allConfig) })
    await handler.handlePluginMessage(buildMsg('plugin.config.set', { pluginId: 'p8', key: 'key1', value: 'v1' }), WS)
    expect(pluginService.setPluginConfig).toHaveBeenCalledWith('p8', 'key1', 'v1')
    expect(pluginService.getPluginConfig).toHaveBeenCalledTimes(1)
    expect(pluginService.getPluginConfig).toHaveBeenCalledWith('p8')
    expect(replies).toEqual([{ id: 'm1', type: 'plugin:config', payload: { pluginId: 'p8', config: allConfig } }])
  })
})

describe('PluginMessageHandler — plugin.install 三分支', () => {
  it('packageSpec 缺失 → sendError invalid_params Missing packageSpec，不调 installPlugin', async () => {
    const { replies, errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.install', {}), WS)
    expect(errors).toEqual([{ code: 'invalid_params', message: 'Missing packageSpec', id: 'm1' }])
    expect(replies).toHaveLength(0)
    expect(pluginService.installPlugin).not.toHaveBeenCalled()
  })

  it('安装成功 → reply config.plugins（重取 discovered）', async () => {
    const discovered = [{ id: 'p9' }]
    const { replies, errors, handler, pluginService } = makeHandler({
      installPlugin: vi.fn().mockResolvedValue({ success: true }),
      getDiscoveredPlugins: vi.fn().mockReturnValue(discovered),
    })
    await handler.handlePluginMessage(buildMsg('plugin.install', { packageSpec: 'spec-1' }), WS)
    expect(pluginService.installPlugin).toHaveBeenCalledWith('spec-1')
    expect(replies).toEqual([{ id: 'm1', type: 'config.plugins', payload: { plugins: discovered } }])
    expect(errors).toHaveLength(0)
  })

  it('安装失败 → sendError install_failed（result.error 透传）', async () => {
    const { replies, errors, handler, pluginService } = makeHandler({
      installPlugin: vi.fn().mockResolvedValue({ success: false, error: 'registry unreachable' }),
    })
    await handler.handlePluginMessage(buildMsg('plugin.install', { packageSpec: 'spec-2' }), WS)
    expect(errors).toEqual([{ code: 'install_failed', message: 'registry unreachable', id: 'm1' }])
    expect(replies).toHaveLength(0)
  })

  it('安装失败且 error 缺省 → sendError install_failed Install failed（兜底文案）', async () => {
    const { errors, handler } = makeHandler({
      installPlugin: vi.fn().mockResolvedValue({ success: false }),
    })
    await handler.handlePluginMessage(buildMsg('plugin.install', { packageSpec: 'spec-3' }), WS)
    expect(errors).toEqual([{ code: 'install_failed', message: 'Install failed', id: 'm1' }])
  })
})

describe('PluginMessageHandler — 落空语义与 handles 清单', () => {
  it('未知 type（不在分发表）→ sendError(handler_not_registered)：无 service 调用、无 reply（RT-1#6 显形）', async () => {
    const { replies, errors, handler, pluginService } = makeHandler()
    await expect(handler.handlePluginMessage(buildMsg('plugin.unknown.future', {}), WS)).resolves.toBeUndefined()
    expect(replies).toHaveLength(0)
    // 落空不再静默（RT-1#6）：显式 error 信封让前端 pending Promise 立即失败，而非等到泛化超时。
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      id: 'm1',
      code: 'handler_not_registered',
      message: expect.stringContaining('plugin.unknown.future'),
    })
    expect(pluginService.getDiscoveredPlugins).not.toHaveBeenCalled()
  })

  it('handles 清单含全部 17 个 plugin.* type', () => {
    const { handler } = makeHandler()
    expect(handler.handles).toHaveLength(17)
    expect(handler.handles).toEqual(expect.arrayContaining([
      'plugin.list', 'plugin.toggle', 'plugin.uninstall', 'plugin.approvePermissions', 'plugin.revokePermissions',
      'plugin.denyPermissions',
      'plugin.executeCommand', 'plugin.config.get', 'plugin.config.set', 'plugin.install', 'plugin.uiResponse',
      'plugin.mountPoints.sync', 'plugin.ui.snapshot',
      // provider-plugin-access D9/D8/U5：plugin.invoke 业务方法调用、plugin.uiEvent 输入
      // 值回传、清单域两个无参只读 RPC
      'plugin.invoke', 'plugin.uiEvent', 'plugin.listAvailable', 'plugin.catalog',
    ]))
  })
})
