/**
 * PluginMessageHandler 单测 — plugin.* 表驱动分发全分支锚定。
 *
 * 覆盖（complexity-debt 第二批 U08，handlePluginMessage switch→表驱动重构的行为锚定）：
 * - 前置守卫：pluginService null → sendError('handler_error')，不触分发表
 * - 12 个 plugin.* case 的 reply/error 路径（payload 透传 + 文案逐字节）
 * - plugin.install 的 invalid_params / success / failure(+error 缺省兜底) 三分支
 * - plugin.dismissModal（AP-2 关①，u5b）：三元组校验 + 广播/notify 委托 + 畸形拒绝
 * - E6（AP-3）：executeCommand args 非标量 → INVALID_ARGS，不 dispatch
 * - 落空语义：未知 type 不调用任何 service 方法、无 reply/error（原 switch 无 default）
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/plugin-message-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginMessageHandler } from '../src/transport/plugin-message-handler.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import {
  registerUiRpcHandlers,
  wireRuntimeModalExits,
  resetRuntimeModalSlotForTest,
  getRuntimeModalSlot,
} from '../src/services/plugin-service/api/ui-api.js'
import type { ClientMessage, PluginModalStatePayload } from '@taiji/shared'

/** mock WorkerPort（session-api-read.test.ts 同模式） */
function createMockPort(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

beforeEach(() => {
  // 模块级槽复位：用例间互不残留（出线在 wireExits 内按用例重挂）
  resetRuntimeModalSlotForTest()
})

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
    executeCommand: vi.fn().mockResolvedValue(undefined),
    getPluginConfig: vi.fn().mockResolvedValue({}),
    setPluginConfig: vi.fn().mockResolvedValue(undefined),
    installPlugin: vi.fn().mockResolvedValue({ success: true }),
    handleUiResponse: vi.fn(),
    syncMountPoints: vi.fn(),
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

describe('PluginMessageHandler — 前置守卫（D3）', () => {
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

  it('plugin.approvePermissions → approvePermissions + reply 当前 plugins', async () => {
    const discovered = [{ id: 'p4' }]
    const { replies, handler, pluginService } = makeHandler({ getDiscoveredPlugins: vi.fn().mockReturnValue(discovered) })
    await handler.handlePluginMessage(buildMsg('plugin.approvePermissions', { pluginId: 'p4', permissions: ['fs:read'] }), WS)
    expect(pluginService.approvePermissions).toHaveBeenCalledWith('p4', ['fs:read'])
    expect(replies).toEqual([{ id: 'm1', type: 'config.plugins', payload: { plugins: discovered } }])
  })

  it('plugin.revokePermissions → revokePermissions + reply 当前 plugins', async () => {
    const discovered: unknown[] = []
    const { replies, handler, pluginService } = makeHandler({ getDiscoveredPlugins: vi.fn().mockReturnValue(discovered) })
    await handler.handlePluginMessage(buildMsg('plugin.revokePermissions', { pluginId: 'p5' }), WS)
    expect(pluginService.revokePermissions).toHaveBeenCalledWith('p5')
    expect(replies).toEqual([{ id: 'm1', type: 'config.plugins', payload: { plugins: discovered } }])
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

describe('PluginMessageHandler — plugin.dismissModal（AP-2 关①，u5b）', () => {
  /** 复位 ui-api 的模块级 modal 槽（每用例干净起点），返回捕获广播/notify 的 wire */
  function wireExits() {
    resetRuntimeModalSlotForTest()
    const modalStateFrames: PluginModalStatePayload[] = []
    const headerActionFrames: unknown[] = []
    const notifications: Array<{ workerId: string; payload: unknown }> = []
    wireRuntimeModalExits({
      broadcastModalState: (payload) => { modalStateFrames.push(payload) },
      broadcastHeaderActionUpdate: (payload) => { headerActionFrames.push(payload) },
      notifyModalClosed: (workerId, payload) => { notifications.push({ workerId, payload }) },
    })
    return { modalStateFrames, headerActionFrames, notifications }
  }

  it('三元组匹配 → closed 广播 + plugin.ui.modalClosed notify + reply pong', async () => {
    const exits = wireExits()
    // 预置 open 槽（workerId 'w1'，epoch 1）：经 showModal RPC handler 全链路
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    registerUiRpcHandlers(rpc, {
      showSelect: vi.fn(),
      showConfirm: vi.fn(),
      showInput: vi.fn(),
      notify: vi.fn(),
      updateStatusBarItem: vi.fn(),
    })
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 1, method: 'plugin.ui.showModal',
      params: { pluginId: 'p1', modalId: 'm1', sessionId: 's1' },
    })

    const { replies, handler } = makeHandler()
    await handler.handlePluginMessage(
      buildMsg('plugin.dismissModal', { pluginId: 'p1', modalId: 'm1', epoch: 1, reason: 'dismissed' }),
      WS,
    )
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
    // open 帧来自 showModal 预置（epoch 1）；dismiss 只追加一条 closed 帧
    const closedFrames = exits.modalStateFrames.filter((f) => f.state === 'closed')
    expect(closedFrames).toHaveLength(1)
    expect(closedFrames[0]).toMatchObject({
      pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'closed', epoch: 1, reason: 'dismissed',
    })
    expect(exits.notifications).toEqual([
      { workerId: 'w1', payload: { modalId: 'm1', reason: 'dismissed' } },
    ])
  })

  it('陈旧 epoch（关闭在途时的重开）→ 忽略：零广播零 notify + reply pong', async () => {
    const exits = wireExits()
    // 槽 epoch 已推进到 2（重复 open 递增），陈旧 dismiss(epoch=1) 不误关
    const rpc = new PluginRpcServer()
    rpc.registerWorker('w1', createMockPort())
    registerUiRpcHandlers(rpc, {
      showSelect: vi.fn(), showConfirm: vi.fn(), showInput: vi.fn(), notify: vi.fn(), updateStatusBarItem: vi.fn(),
    })
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 1, method: 'plugin.ui.showModal', params: { pluginId: 'p1', modalId: 'm1', sessionId: 's1' } })
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 2, method: 'plugin.ui.showModal', params: { pluginId: 'p1', modalId: 'm1', sessionId: 's1' } })

    const { replies, handler } = makeHandler()
    await handler.handlePluginMessage(
      buildMsg('plugin.dismissModal', { pluginId: 'p1', modalId: 'm1', epoch: 1, reason: 'dismissed' }),
      WS,
    )
    expect(exits.modalStateFrames.filter((f) => f.state === 'closed')).toHaveLength(0)
    expect(exits.notifications).toHaveLength(0)
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
    // 槽仍在（epoch 2 未被陈旧 dismiss 清掉）
    expect(getRuntimeModalSlot()?.epoch).toBe(2)
    resetRuntimeModalSlotForTest()
  })

  it('槽不存在 / pluginId 或 modalId 不匹配 → 忽略（closed 对已关层 no-op）', async () => {
    const exits = wireExits()
    const { replies, handler } = makeHandler()
    await handler.handlePluginMessage(
      buildMsg('plugin.dismissModal', { pluginId: 'ghost', modalId: 'm1', epoch: 1, reason: 'session-switched' }),
      WS,
    )
    expect(exits.modalStateFrames).toHaveLength(0)
    expect(exits.notifications).toHaveLength(0)
    expect(replies).toHaveLength(1)
    resetRuntimeModalSlotForTest()
  })

  it('畸形 payload（epoch 非正整数 / reason 越界）→ invalid_params error envelope', async () => {
    const exits = wireExits()
    const { errors, handler } = makeHandler()
    await handler.handlePluginMessage(
      buildMsg('plugin.dismissModal', { pluginId: 'p1', modalId: 'm1', epoch: 0, reason: 'dismissed' }),
      WS,
    )
    await handler.handlePluginMessage(
      buildMsg('plugin.dismissModal', { pluginId: 'p1', modalId: 'm1', epoch: 1, reason: 'bogus' }),
      WS,
    )
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({ code: 'invalid_params' })
    expect(errors[1]).toMatchObject({ code: 'invalid_params' })
    expect(exits.modalStateFrames).toHaveLength(0)
    resetRuntimeModalSlotForTest()
  })
})

describe('PluginMessageHandler — 落空语义与 handles 清单', () => {
  it('未知 type（不在分发表）→ 落空：无 service 调用、无 reply/error', async () => {
    const { replies, errors, handler, pluginService } = makeHandler()
    await expect(handler.handlePluginMessage(buildMsg('plugin.unknown.future', {}), WS)).resolves.toBeUndefined()
    expect(replies).toHaveLength(0)
    expect(errors).toHaveLength(0)
    expect(pluginService.getDiscoveredPlugins).not.toHaveBeenCalled()
  })

  it('handles 清单含全部 12 个 plugin.* type', () => {
    const { handler } = makeHandler()
    expect(handler.handles).toHaveLength(12)
    expect(handler.handles).toEqual(expect.arrayContaining([
      'plugin.list', 'plugin.toggle', 'plugin.uninstall', 'plugin.approvePermissions', 'plugin.revokePermissions',
      'plugin.executeCommand', 'plugin.config.get', 'plugin.config.set', 'plugin.install', 'plugin.uiResponse',
      'plugin.mountPoints.sync', 'plugin.dismissModal',
    ]))
  })
})
