/**
 * Hook Serial Execution — TDD tests for BG1 Task 2
 *
 * Tests the serial await execution of hooks with block/transform support:
 *   PluginService.executeHooks
 *     → hookRegistry.get(hookType) → sorted by priority
 *     → serial invoke per handler: rpcServer.invoke(workerId, 'plugin.hooks.invoke', ...)
 *     → block detection (proceed === false)
 *     → content transform (modifiedData)
 *     → timeout/error → skip handler
 *
 * Key design:
 *   - Serial, not parallel (each handler sees transformed context)
 *   - Priority ordering: built-in (0) → trusted (100) → sandbox (200)
 *   - Blocked detection: proceed === false terminates chain
 *   - Transform passing: modifiedData replaces context.data
 *   - Timeout 5s per handler → skip (pass-through)
 *   - Worker crash → skip handler
 */

import { describe, it, expect, vi } from 'vitest'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { HookEntry, HookContext, HookResult } from '../src/services/plugin-service/plugin-types.js'

// ── Helpers ────────────────────────────────────────────────────

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/** Access PluginService internals for test setup（hookRegistry 下沉到 HookPipeline） */
function internals(service: PluginService) {
  const hookPipeline = (service as unknown as { hookPipeline: { registry: Map<string, HookEntry[]> } }).hookPipeline
  const host = (service as unknown as { host: { getWorkerHandle: ReturnType<typeof vi.fn> } }).host
  const rpcServer = (service as unknown as { rpcServer: {
    invoke: ReturnType<typeof vi.fn>
    notify: ReturnType<typeof vi.fn>
    broadcast: ReturnType<typeof vi.fn>
  } }).rpcServer
  return { hookRegistry: hookPipeline.registry, rpcServer, host }
}

function makeContext(data: unknown = {}): HookContext {
  return {
    pluginId: '',
    hookType: 'onBeforeSendMessage',
    data,
    timestamp: Date.now(),
  }
}

// ══════════════════════════════════════════════════════════════════
// executeHooks — serial await with block/transform
// ══════════════════════════════════════════════════════════════════

describe('PluginService.executeHooks (BG1 T2)', () => {
  // ── TC-SH-01: No handlers → immediate { blocked: false } ──────
  it('TC-SH-01: no handlers returns { blocked: false }', async () => {
    const service = new PluginService({} as never, createMockBroker())
    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-SH-02: Single handler passes → { blocked: false } ──────
  it('TC-SH-02: single handler passes returns { blocked: false }', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p1', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn().mockResolvedValue({
      proceed: true,
    })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext({ text: 'hello' }))

    expect(result).toEqual({ blocked: false })
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(1)
    expect(reg.rpcServer.invoke).toHaveBeenCalledWith(
      'worker-1',
      'plugin.hooks.invoke',
      expect.objectContaining({
        handlerId: 'h1',
        hookType: 'onBeforeSendMessage',
      }),
      5_000,
    )
  })

  // ── TC-SH-03: Single handler blocks → { blocked: true, blockedBy, reason } ──
  it('TC-SH-03: single handler blocks returns blocked result', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-blocker', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn().mockResolvedValue({
      proceed: false,
      reason: 'API key detected',
    })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result.blocked).toBe(true)
    expect(result.blockedBy).toBe('p-blocker')
    expect(result.reason).toBe('API key detected')
  })

  // ── TC-SH-04: Priority ordering — trusted before sandbox ──────
  it('TC-SH-04: handlers execute in priority order', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    // D2-5：执行侧不再排序（hook-pipeline.execute 直接遍历），排序职责在注册侧
    // （registerHookRpcHandlers 的 entries.sort，由 plugin-api-hooks.test.ts TC-HK-02 覆盖）。
    // 此处按注册产出的既定顺序（trusted 100 → sandbox 200）set registry。
    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-trusted', handlerId: 'h-trusted', priority: 100 },
      { pluginId: 'p-sandbox', handlerId: 'h-sandbox', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn()
      .mockReturnValueOnce({ workerId: 'worker-trusted', postMessage: vi.fn() })
      .mockReturnValueOnce({ workerId: 'worker-sandbox', postMessage: vi.fn() })

    const invokeOrder: string[] = []
    reg.rpcServer.invoke = vi.fn().mockImplementation(async (_workerId: string, _method: string, params: Record<string, unknown>) => {
      invokeOrder.push(params.handlerId as string)
      return { proceed: true }
    })

    await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(invokeOrder).toEqual(['h-trusted', 'h-sandbox'])
  })

  // ── TC-SH-05: Blocked stops chain — second handler never invoked ──
  it('TC-SH-05: blocked handler stops chain', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-first', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-second', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn()
      .mockResolvedValueOnce({ proceed: false, reason: 'Blocked' })
      .mockResolvedValueOnce({ proceed: true })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result.blocked).toBe(true)
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(1) // second never called
  })

  // ── TC-SH-06: Transform passes — modifiedData flows to next handler ──
  it('TC-SH-06: modifiedData flows to next handler', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-transformer', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-observer', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    const capturedContexts: unknown[] = []
    reg.rpcServer.invoke = vi.fn().mockImplementation(async (_workerId: string, _method: string, params: Record<string, unknown>) => {
      capturedContexts.push(params.context)
      if (params.handlerId === 'h1') {
        return { proceed: true, modifiedData: 'MODIFIED' }
      }
      return { proceed: true }
    })

    await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext('ORIGINAL'))

    // First handler gets original data
    expect((capturedContexts[0] as HookContext).data).toBe('ORIGINAL')
    // Second handler gets modified data
    expect((capturedContexts[1] as HookContext).data).toBe('MODIFIED')
  })

  // ── TC-SH-07: Worker timeout → handler skipped, chain continues ──
  it('TC-SH-07: timeout skips handler, chain continues', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-slow', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-fast', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce({ proceed: true })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result).toEqual({ blocked: false })
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(2)
  })

  // ── TC-SH-08: Worker crashed → handler skipped ──
  it('TC-SH-08: worker crashed skips handler, chain continues', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-crashed', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-alive', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn()
      .mockReturnValueOnce(undefined) // crashed worker
      .mockReturnValueOnce({ workerId: 'worker-2', postMessage: vi.fn() })

    reg.rpcServer.invoke = vi.fn().mockResolvedValue({ proceed: true })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result).toEqual({ blocked: false })
    // Only second handler invoked
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(1)
    expect(reg.rpcServer.invoke).toHaveBeenCalledWith(
      'worker-2',
      'plugin.hooks.invoke',
      expect.objectContaining({ handlerId: 'h2' }),
      5_000,
    )
  })

  // ── TC-SH-09: Mixed — trusted transforms, sandbox blocks ──────
  it('TC-SH-09: mixed scenario — transform then block', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-trusted', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-sandbox', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn()
      .mockResolvedValueOnce({ proceed: true, modifiedData: 'TRANSFORMED' })
      .mockResolvedValueOnce({ proceed: false, reason: 'Sensitive data' })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result.blocked).toBe(true)
    expect(result.blockedBy).toBe('p-sandbox')
    expect(result.reason).toBe('Sensitive data')
  })

  // ── TC-SH-10: Generic error in invoke → handler skipped ──────
  it('TC-SH-10: generic invoke error skips handler', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-error', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn().mockRejectedValue(new Error('Worker crashed'))

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    // Error → treated as pass-through
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-SH-11: Block without reason → default reason includes pluginId ──
  it('TC-SH-11: block without reason uses default message', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-blocker', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    // proceed=false without reason
    reg.rpcServer.invoke = vi.fn().mockResolvedValue({ proceed: false })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result.blocked).toBe(true)
    expect(result.blockedBy).toBe('p-blocker')
    expect(result.reason).toContain('p-blocker')
  })

  // ── TC-SH-12: Transform returns undefined modifiedData → no change ──
  it('TC-SH-12: undefined modifiedData does not change context', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p1', handlerId: 'h1', priority: 100 },
      { pluginId: 'p2', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    const capturedContexts: unknown[] = []
    reg.rpcServer.invoke = vi.fn().mockImplementation(async (_w: string, _m: string, params: Record<string, unknown>) => {
      capturedContexts.push(params.context)
      return { proceed: true } // no modifiedData
    })

    await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext('ORIGINAL'))

    // Second handler should still see ORIGINAL (not undefined)
    expect((capturedContexts[1] as HookContext).data).toBe('ORIGINAL')
  })

  // ── TC-SH-13: D2-3 映射层 — modifiedData → transformedData ──
  it('TC-SH-13: mapping layer exposes modifiedData as HookResult.transformedData', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onAfterToolResult', [
      { pluginId: 'p-transformer', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    const modifiedData = { output: 'REDACTED' }
    reg.rpcServer.invoke = vi.fn().mockResolvedValue({ proceed: true, modifiedData })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onAfterToolResult', makeContext({ output: 'secret' }))

    // Worker 响应的 modifiedData 经映射层暴露为 transformedData（引用恒等）
    expect(result.blocked).toBe(false)
    expect(result.transformedData).toBe(modifiedData)
  })

  // ── TC-SH-14: D2-3 映射层 — block 形态字段映射 ──
  it('TC-SH-14: mapping layer maps proceed:false/reason to blocked/blockedBy/reason', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeToolCall', [
      { pluginId: 'p-blocker', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    // Worker 响应 {proceed:false, reason} → HookResult {blocked:true, blockedBy, reason}
    reg.rpcServer.invoke = vi.fn().mockResolvedValue({ proceed: false, reason: 'not allowed' })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeToolCall', makeContext())

    expect(result).toEqual({ blocked: true, blockedBy: 'p-blocker', reason: 'not allowed' })
  })

  // ── TC-SH-15: P-1 — togglePlugin(false) 清 hook 注册，禁用插件的 hook 不再执行 ──
  it('TC-SH-15: togglePlugin(false) removes hook entries; disabled plugin hooks stop executing (P-1)', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    // 两个插件各持一个 hook（同 hookType）+ 一个只属于 p-disabled 的 hookType
    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-disabled', handlerId: 'h-dis', priority: 100 },
      { pluginId: 'p-alive', handlerId: 'h-alive', priority: 200 },
    ])
    reg.hookRegistry.set('onBeforeToolCall', [
      { pluginId: 'p-disabled', handlerId: 'h-dis-2', priority: 100 },
    ])

    // stub registry（getDescriptor）+ activator（deactivate/stopWatching），隔离生命周期细节
    ;(service as unknown as { registry: unknown }).registry = {
      getDescriptor: vi.fn().mockReturnValue({ pluginId: 'p-disabled', status: 'ACTIVE' }),
      getAllDescriptors: vi.fn().mockReturnValue([]),
    }
    ;(service as unknown as { activator: unknown }).activator = {
      deactivatePlugin: vi.fn().mockResolvedValue(undefined),
      stopWatching: vi.fn(),
      getState: vi.fn().mockReturnValue('ACTIVE'),
    }

    await service.togglePlugin('p-disabled', false)

    // registry 中该 pluginId 的 entries 全部清除；其他插件的保留；清空的 hookType 整键删除
    expect(reg.hookRegistry.get('onBeforeSendMessage')).toEqual([
      { pluginId: 'p-alive', handlerId: 'h-alive', priority: 200 },
    ])
    expect(reg.hookRegistry.has('onBeforeToolCall')).toBe(false)

    // 禁用后 executeHooks 不再为 p-disabled 派发 invoke
    reg.host.getWorkerHandle = vi.fn().mockReturnValue({ workerId: 'worker-1', postMessage: vi.fn() })
    reg.rpcServer.invoke = vi.fn().mockResolvedValue({ proceed: true })
    await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(1)
    expect(reg.rpcServer.invoke).toHaveBeenCalledWith(
      'worker-1',
      'plugin.hooks.invoke',
      expect.objectContaining({ handlerId: 'h-alive' }),
      5_000,
    )
  })

  // ── TC-SH-16: D2-2 — observe 类 hookType（onPiEvent）走 notify 零往返快捷路径 ──
  it('TC-SH-16: observe hookType dispatches via rpcServer.notify without invoke (D2-2)', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onPiEvent', [
      { pluginId: 'p-observer', handlerId: 'h-obs', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({ workerId: 'worker-1', postMessage: vi.fn() })
    reg.rpcServer.notify = vi.fn()
    reg.rpcServer.invoke = vi.fn()

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onPiEvent', makeContext({ eventName: 'agent_start', data: {} }))

    // notify 派发（无 pending/超时），不创建 invoke；返回恒不 block
    expect(reg.rpcServer.notify).toHaveBeenCalledTimes(1)
    expect(reg.rpcServer.notify).toHaveBeenCalledWith(
      'worker-1',
      'plugin.hooks.invoke',
      expect.objectContaining({ handlerId: 'h-obs', hookType: 'onPiEvent' }),
    )
    expect(reg.rpcServer.invoke).not.toHaveBeenCalled()
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-SH-17: Fix-7 — togglePlugin(false) 清 tool/command 注册，bridge 不再路由该插件工具 ──
  it('TC-SH-17: togglePlugin(false) removes tool/command entries; bridge tool call returns not found (Fix-7)', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)
    const toolRegistry = (service as unknown as { toolRegistry: Map<string, import('../src/services/plugin-service/plugin-types.js').ToolEntry> }).toolRegistry
    const commandRegistry = (service as unknown as { commandRegistry: Map<string, import('../src/services/plugin-service/api/commands-api.js').CommandRegistration> }).commandRegistry

    // p-disabled 与 p-alive 各持一个工具 + 命令
    const schema = (name: string) => ({ name, description: '', parameters: {} })
    toolRegistry.set('p-disabled:toolA', { pluginId: 'p-disabled', handlerId: 'p-disabled:toolA', schema: schema('toolA') })
    toolRegistry.set('p-alive:toolB', { pluginId: 'p-alive', handlerId: 'p-alive:toolB', schema: schema('toolB') })
    commandRegistry.set('cmd-a', { pluginId: 'p-disabled', commandId: 'cmd-a', title: 'A' } as import('../src/services/plugin-service/api/commands-api.js').CommandRegistration)
    commandRegistry.set('cmd-b', { pluginId: 'p-alive', commandId: 'cmd-b', title: 'B' } as import('../src/services/plugin-service/api/commands-api.js').CommandRegistration)

    ;(service as unknown as { registry: unknown }).registry = {
      getDescriptor: vi.fn().mockReturnValue({ pluginId: 'p-disabled', status: 'ACTIVE' }),
      getAllDescriptors: vi.fn().mockReturnValue([]),
    }
    ;(service as unknown as { activator: unknown }).activator = {
      deactivatePlugin: vi.fn().mockResolvedValue(undefined),
      stopWatching: vi.fn(),
      getState: vi.fn().mockReturnValue('ACTIVE'),
    }
    const syncSpy = vi.spyOn(service, 'syncToolsToBridge').mockResolvedValue(undefined)

    await service.togglePlugin('p-disabled', false)

    // 该插件的工具/命令条目清除；其他插件的保留
    expect([...toolRegistry.keys()]).toEqual(['p-alive:toolB'])
    expect([...commandRegistry.keys()]).toEqual(['cmd-b'])
    // bridge schema 缓存同步刷新（禁用插件的工具不再出现在同步负载）
    expect(syncSpy).toHaveBeenCalled()
    syncSpy.mockRestore()

    // bridge 调用禁用插件的工具 → not found（不再路由到已 deactivate 的 worker）
    const bridgeResult = await service.handleBridgeToolExecute({ toolName: 'toolA', parameters: {} } as never)
    expect(bridgeResult.isError).toBe(true)
    expect(String(bridgeResult.content)).toContain('Tool not found: toolA')
    // 其他插件工具不受影响（有 worker handle 时正常路由；此处断言 not-found 语义只针对 toolA）
    const bridgeAlive = await service.handleBridgeToolExecute({ toolName: 'toolB', parameters: {} } as never)
    expect(String(bridgeAlive.content)).not.toContain('Tool not found: toolB')
  })

  // ── TC-SH-18: Fix-5 — uninstallPlugin 时 deactivate 抛错不阻断清理 ──
  it('TC-SH-18: uninstallPlugin continues cleanup when deactivatePlugin rejects (Fix-5)', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)
    const toolRegistry = (service as unknown as { toolRegistry: Map<string, import('../src/services/plugin-service/plugin-types.js').ToolEntry> }).toolRegistry
    toolRegistry.set('p-gone:toolX', { pluginId: 'p-gone', handlerId: 'p-gone:toolX', schema: { name: 'toolX', description: '', parameters: {} } })
    reg.hookRegistry.set('onBeforeToolCall', [
      { pluginId: 'p-gone', handlerId: 'h-gone', priority: 100 },
    ])

    ;(service as unknown as { registry: unknown }).registry = {
      getDescriptor: vi.fn().mockReturnValue({ pluginId: 'p-gone', status: 'ACTIVE' }),
      getAllDescriptors: vi.fn().mockReturnValue([]),
      removeDescriptor: vi.fn(),
    }
    ;(service as unknown as { activator: unknown }).activator = {
      deactivatePlugin: vi.fn().mockRejectedValue(new Error('deactivate timeout')),
      stopWatching: vi.fn(),
      getState: vi.fn().mockReturnValue('ACTIVE'),
      removeDescriptor: vi.fn(),
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const syncSpy = vi.spyOn(service, 'syncToolsToBridge').mockResolvedValue(undefined)

    try {
      // 不抛错：清理是 uninstall 的核心语义，deactivate 失败仅记日志
      await expect(service.uninstallPlugin('p-gone')).resolves.toBeTruthy()
      expect(errorSpy).toHaveBeenCalled()
      // 清理全部完成：descriptor 移除 + tool/hook 注册清空 + bridge 同步刷新
      expect((service as unknown as { registry: { removeDescriptor: ReturnType<typeof vi.fn> } }).registry.removeDescriptor).toHaveBeenCalledWith('p-gone')
      expect(toolRegistry.size).toBe(0)
      expect(reg.hookRegistry.has('onBeforeToolCall')).toBe(false)
      expect(syncSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      syncSpy.mockRestore()
    }
  })
})
