/**
 * B6 bridgeRequestIds 应答即删单测（memory-leak-remediation §3.2-B6 / 验收 A5 的 L1 层）。
 *
 * 锁定：
 * - 全部回包 method（sync / tool_execute / intercept / malformed / unknown）在应答完成点
 *   调 removeBridgeRequest（成功 + 异常双路——外层 catch 回错包后 finally 同样摘除）
 * - bridge:event 不登记不摘（入口收窄守卫与 finally 对称）
 * - ExtensionTimeoutManager 集成：addBridgeRequest 后 removeBridgeRequest 把
 *   bridgeRequestIds 与 per-session Set 同步清零（trackSessionRequest 对偶）
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/bridge-handler-cleanup.test.ts
 */
import { describe, expect, it, vi, type Mock } from 'vitest'
import { BridgeHandler } from '../bridge-handler.js'
import { ExtensionTimeoutManager } from '../../services/extension-timeout-manager.js'
import type { IPiEngine } from '../../services/ports/pi-engine.js'
import type { IPluginService } from '../../interfaces.js'

const SID = 'sid-bridge-b6'

function makeClient() {
  return {
    sendExtensionUiResponse: vi.fn(),
  } as unknown as IPiEngine & { sendExtensionUiResponse: Mock }
}

function makeHandler(pluginService: IPluginService | null, timeoutManager?: { addBridgeRequest(sessionId: string, requestId: string): void; removeBridgeRequest(requestId: string): void }) {
  return new BridgeHandler(pluginService, timeoutManager)
}

describe('B6 应答即删：各回包点 removeBridgeRequest（成功+异常双路）', () => {
  it('bridge:sync 成功回包后摘除', async () => {
    const remove = vi.fn()
    const add = vi.fn()
    const handler = makeHandler(null, { addBridgeRequest: add, removeBridgeRequest: remove })
    await handler.handleBridgeRequest(SID, 'req-sync', 'bridge:sync', {}, makeClient())
    expect(add).toHaveBeenCalledWith(SID, 'req-sync')
    expect(remove).toHaveBeenCalledWith('req-sync')
  })

  it('bridge:tool_execute 成功路径：await 完成回包后摘除', async () => {
    const remove = vi.fn()
    const pluginService = {
      handleBridgeToolExecute: vi.fn(async () => ({ content: 'ok', isError: false })),
    } as unknown as IPluginService
    const handler = makeHandler(pluginService, { addBridgeRequest: vi.fn(), removeBridgeRequest: remove })
    const client = makeClient()
    await handler.handleBridgeRequest(SID, 'req-tool', 'bridge:tool_execute', { toolName: 't' }, client)
    expect(client.sendExtensionUiResponse).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('req-tool')
  })

  it('bridge:tool_execute 异常路径：外层 catch 回错包后同样摘除', async () => {
    const remove = vi.fn()
    const pluginService = {
      handleBridgeToolExecute: vi.fn(async () => { throw new Error('worker exploded') }),
    } as unknown as IPluginService
    const handler = makeHandler(pluginService, { addBridgeRequest: vi.fn(), removeBridgeRequest: remove })
    const client = makeClient()
    await handler.handleBridgeRequest(SID, 'req-tool-err', 'bridge:tool_execute', { toolName: 't' }, client)
    // catch 腿回错包（不向上抛）+ finally 摘除
    expect(client.sendExtensionUiResponse).toHaveBeenCalledTimes(1)
    expect(String(client.sendExtensionUiResponse.mock.calls[0][1])).toContain('worker exploded')
    expect(remove).toHaveBeenCalledWith('req-tool-err')
  })

  it('bridge:intercept 成功路径：await 完成回包后摘除', async () => {
    const remove = vi.fn()
    const pluginService = {
      handleBridgeIntercept: vi.fn(async () => ({ injectedMessages: [] })),
    } as unknown as IPluginService
    const handler = makeHandler(pluginService, { addBridgeRequest: vi.fn(), removeBridgeRequest: remove })
    await handler.handleBridgeRequest(SID, 'req-int', 'bridge:intercept', { eventName: 'before_agent_start' }, makeClient())
    expect(remove).toHaveBeenCalledWith('req-int')
  })

  it('bridge:intercept 异常路径：回错包后同样摘除', async () => {
    const remove = vi.fn()
    const pluginService = {
      handleBridgeIntercept: vi.fn(async () => { throw new Error('hook timeout') }),
    } as unknown as IPluginService
    const handler = makeHandler(pluginService, { addBridgeRequest: vi.fn(), removeBridgeRequest: remove })
    const client = makeClient()
    await handler.handleBridgeRequest(SID, 'req-int-err', 'bridge:intercept', { eventName: 'before_agent_start' }, client)
    expect(client.sendExtensionUiResponse).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('req-int-err')
  })

  it('bridge:malformed 哨兵回包后摘除', async () => {
    const remove = vi.fn()
    const handler = makeHandler(null, { addBridgeRequest: vi.fn(), removeBridgeRequest: remove })
    await handler.handleBridgeRequest(SID, 'req-mal', 'bridge:malformed', { raw: 'garbage' }, makeClient())
    expect(remove).toHaveBeenCalledWith('req-mal')
  })

  it('unknown method 回包后摘除（已登记的同步往返型不残留）', async () => {
    const remove = vi.fn()
    const handler = makeHandler(null, { addBridgeRequest: vi.fn(), removeBridgeRequest: remove })
    await handler.handleBridgeRequest(SID, 'req-unk', 'bridge:future_method', {}, makeClient())
    expect(remove).toHaveBeenCalledWith('req-unk')
  })

  it('bridge:event：不登记不摘（fire-and-forget 收窄守卫与 finally 对称）', async () => {
    const add = vi.fn()
    const remove = vi.fn()
    const handler = makeHandler(null, { addBridgeRequest: add, removeBridgeRequest: remove })
    await handler.handleBridgeRequest(SID, 'req-evt', 'bridge:event', { eventName: 'x' }, makeClient())
    expect(add).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('B6 ExtensionTimeoutManager：removeBridgeRequest 双集合清理（trackSessionRequest 对偶）', () => {
  it('应答后 bridgeRequestIds 与 per-session Set 归零；跨 session 隔离不受影响', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.addBridgeRequest(SID, 'r1')
    mgr.addBridgeRequest(SID, 'r2')
    mgr.addBridgeRequest('sid-other', 'r3')
    expect(mgr.sessionRequestCount(SID)).toBe(2)

    mgr.removeBridgeRequest('r1')
    expect(mgr.isBridgeRequest('r1')).toBe(false)
    expect(mgr.sessionRequestCount(SID)).toBe(1) // per-session Set 同步删

    mgr.removeBridgeRequest('r2')
    expect(mgr.sessionRequestCount(SID)).toBe(0) // Set 归零（A5 断言）
    expect(mgr.sessionRequestCount('sid-other')).toBe(1) // 其他 session 不误伤
    expect(mgr.isBridgeRequest('r3')).toBe(true)
  })

  it('removeBridgeRequest 幂等（重复摘除 no-op）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.addBridgeRequest(SID, 'r1')
    mgr.removeBridgeRequest('r1')
    expect(() => mgr.removeBridgeRequest('r1')).not.toThrow()
    expect(mgr.sessionRequestCount(SID)).toBe(0)
  })
})
