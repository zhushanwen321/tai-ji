/**
 * B6 bridge 请求应答即删单测（memory-leak-remediation §3.2-B6 / 验收 A5 的 L1 层）。
 *
 * 锁定：
 * - 全部回包 method（sync / tool_execute / intercept / malformed / unknown）在应答完成点
 *   调 removeRequest（成功 + 异常双路——外层 catch 回错包后 finally 同样摘除）
 * - bridge:event 不登记不摘（入口收窄守卫与 finally 对称）
 * - pluginService 消费面的编组入参（tool_execute 请求对象 / intercept / event 三形态）
 *
 * ExtensionTimeoutManager 单表行为（entry 一体摘除 / 幂等 / 跨 session 隔离）归属
 * test/extension-timeout-manager.test.ts，此处不重复。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/bridge-handler-cleanup.test.ts
 */
import { describe, expect, it, vi, type Mock } from 'vitest'
import { BridgeHandler } from '../bridge-handler.js'
import type { IPiEngine } from '../../services/ports/pi-engine.js'
import type { IPluginService } from '../../interfaces.js'

const SID = 'sid-bridge-b6'

function makeClient() {
  return {
    sendExtensionUiResponse: vi.fn(),
  } as unknown as IPiEngine & { sendExtensionUiResponse: Mock }
}

function makeHandler(pluginService: IPluginService | null, timeoutManager?: { addBridgeRequest(sessionId: string, requestId: string): void; removeRequest(requestId: string): void }) {
  return new BridgeHandler(pluginService, timeoutManager)
}

describe('B6 应答即删：各回包点 removeRequest（成功+异常双路）', () => {
  // 三例（sync / malformed / unknown）断言同形仅 method 不同，合并 it.each。
  // 注意 bridge:sync 此处 pluginService=null，实际走 sendBridgeSync 的 not-available
  // 兜底回包分支（非成功回包路径）——成功回包形态见 bridge-marker-channel.test.ts 序列化组。
  it.each([
    ['bridge:sync', 'req-sync', {}],
    ['bridge:malformed', 'req-mal', { raw: 'garbage' }],
    ['bridge:future_method', 'req-unk', {}],
  ] as Array<[string, string, Record<string, unknown>]>)(
    '%s 应答完成后摘除（sync 为 pluginService 缺失兜底回包路径）',
    async (method, reqId, data) => {
      const remove = vi.fn()
      const add = vi.fn()
      const handler = makeHandler(null, { addBridgeRequest: add, removeRequest: remove })
      await handler.handleBridgeRequest(SID, reqId, method, data, makeClient())
      expect(add).toHaveBeenCalledWith(SID, reqId)
      expect(remove).toHaveBeenCalledWith(reqId)
    },
  )

  it('bridge:tool_execute 成功路径：await 完成回包后摘除', async () => {
    const remove = vi.fn()
    const pluginService = {
      handleBridgeToolExecute: vi.fn(async () => ({ content: 'ok', isError: false })),
    } as unknown as IPluginService
    const handler = makeHandler(pluginService, { addBridgeRequest: vi.fn(), removeRequest: remove })
    const client = makeClient()
    await handler.handleBridgeRequest(SID, 'req-tool', 'bridge:tool_execute', { toolName: 't' }, client)
    expect(client.sendExtensionUiResponse).toHaveBeenCalledTimes(1)
    // transport↔service 边界编组形态（bridge-handler sendBridgeToolExecute）：
    // data 里有的字段用具体值断言；params/toolCallId 缺省走兜底 {} / ''
    expect(pluginService.handleBridgeToolExecute as unknown as Mock).toHaveBeenCalledWith({
      type: 'bridge.tool.execute',
      toolName: 't',
      parameters: {},
      toolCallId: '',
      sessionId: SID,
    })
    expect(remove).toHaveBeenCalledWith('req-tool')
  })

  it('bridge:tool_execute 异常路径：外层 catch 回错包后同样摘除', async () => {
    const remove = vi.fn()
    const pluginService = {
      handleBridgeToolExecute: vi.fn(async () => { throw new Error('worker exploded') }),
    } as unknown as IPluginService
    const handler = makeHandler(pluginService, { addBridgeRequest: vi.fn(), removeRequest: remove })
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
    const handler = makeHandler(pluginService, { addBridgeRequest: vi.fn(), removeRequest: remove })
    await handler.handleBridgeRequest(SID, 'req-int', 'bridge:intercept', { eventName: 'before_agent_start' }, makeClient())
    // 编组入参：eventName 直传、data.data 缺省兜底 {}、sessionId 透传
    expect(pluginService.handleBridgeIntercept as unknown as Mock).toHaveBeenCalledWith('before_agent_start', {}, SID)
    expect(remove).toHaveBeenCalledWith('req-int')
  })

  it('bridge:intercept 异常路径：回错包后同样摘除', async () => {
    const remove = vi.fn()
    const pluginService = {
      handleBridgeIntercept: vi.fn(async () => { throw new Error('hook timeout') }),
    } as unknown as IPluginService
    const handler = makeHandler(pluginService, { addBridgeRequest: vi.fn(), removeRequest: remove })
    const client = makeClient()
    await handler.handleBridgeRequest(SID, 'req-int-err', 'bridge:intercept', { eventName: 'before_agent_start' }, client)
    expect(client.sendExtensionUiResponse).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('req-int-err')
  })

  it('bridge:event：不登记不摘（fire-and-forget 收窄守卫与 finally 对称）', async () => {
    const add = vi.fn()
    const remove = vi.fn()
    const pluginService = { handleBridgeEvent: vi.fn() } as unknown as IPluginService
    const handler = makeHandler(pluginService, { addBridgeRequest: add, removeRequest: remove })
    await handler.handleBridgeRequest(SID, 'req-evt', 'bridge:event', { eventName: 'x' }, makeClient())
    expect(add).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    // 编组入参：eventName 直传、data.data 缺省兜底 {}、sessionId 透传
    expect(pluginService.handleBridgeEvent as unknown as Mock).toHaveBeenCalledWith('x', {}, SID)
  })
})
