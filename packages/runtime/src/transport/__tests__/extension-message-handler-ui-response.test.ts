/**
 * extension.ui_response 写 pi 失败路径单测（code-harden M1 环 1 / RT-1#4）。
 *
 * 锁定：
 * - sendExtensionUiResponse 返 false（pi 进程不在或 stdin 写失败）→
 *   ① 带码 error envelope 上行（extension_response_send_failed + details.sessionId，
 *     renderer 经 route-inbound D6b onSessionError 兜底进消息流展示，作答不再石沉大海）
 *   ② pending 缓存即终结（removePendingRequest——本 client 绑定当前进程，pi 恢复后
 *     是全新 pending 表，旧 requestId 永不可投递，保留只会制造「可重投」假象）
 * - 送达成功（返 true）→ 无 sendError，pending 照常收缩（既有行为回归防线）
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/extension-message-handler-ui-response.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebSocket as WsType } from 'ws'
import { ExtensionMessageHandler, type ExtensionHandlerContext } from '../extension-message-handler.js'
import { ExtensionTimeoutManager } from '../../services/extension-timeout-manager.js'
import type { IPiEngine } from '../../services/ports/pi-engine.js'

const SID = 'sid-ui-resp'
const REQUEST_ID = 'ui_req_1'

/** fake rpc client：sendExtensionUiResponse 返值可控（boolean = 是否写进 pi stdin） */
function makeClient(delivered: boolean): IPiEngine {
  return {
    sendExtensionUiResponse: vi.fn(() => delivered),
  } as unknown as IPiEngine
}

function makeCtx(client: IPiEngine | undefined): { ctx: ExtensionHandlerContext; sendError: ReturnType<typeof vi.fn>; mgr: ExtensionTimeoutManager } {
  const mgr = new ExtensionTimeoutManager()
  // 预置 pending：模拟 ui_request 到达时 runtime 的缓存登记（getPendingRequests 据此回推）
  mgr.cachePendingRequest(SID, REQUEST_ID, 'confirm', { title: 'confirm?' })
  mgr.trackUiRequest(SID, REQUEST_ID, 'confirm')
  const sendError = vi.fn()
  const ctx = {
    send: vi.fn(),
    sendError,
    reply: vi.fn(),
    sessionService: { getRpcClient: vi.fn(() => client) },
    extensionService: undefined,
    extensionTimeoutMgr: mgr,
  } as unknown as ExtensionHandlerContext
  return { ctx, sendError, mgr }
}

function makeMsg() {
  return {
    type: 'extension.ui_response',
    id: undefined,
    payload: { sessionId: SID, requestId: REQUEST_ID, method: 'confirm', result: true },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('M1 环 1：extension.ui_response 写 pi 失败（RT-1#4）', () => {
  it('sendExtensionUiResponse 返 false → sendError 带 extension_response_send_failed 上行且含 sessionId', async () => {
    const { ctx, sendError } = makeCtx(makeClient(false))
    await new ExtensionMessageHandler(ctx).handleExtensionMessage(makeMsg(), {} as WsType)

    expect(sendError).toHaveBeenCalledTimes(1)
    const [ws, code, message, id, details] = sendError.mock.calls[0] as unknown as [unknown, string, string, unknown, { sessionId?: string; hint?: string }]
    expect(code).toBe('extension_response_send_failed')
    expect(message).toContain(REQUEST_ID)
    expect(details?.sessionId).toBe(SID)
    expect(typeof details?.hint).toBe('string')
    expect(id).toBeUndefined() // fire-and-forget 无 msg.id，走 onSessionError 兜底而非 pending reject
  })

  it('写失败时 pending 即终结（removePendingRequest）——getPendingRequests 不再回推该请求', async () => {
    const { ctx, mgr } = makeCtx(makeClient(false))
    expect(mgr.getPendingRequests(SID)).toHaveLength(1) // 前置：预置生效

    await new ExtensionMessageHandler(ctx).handleExtensionMessage(makeMsg(), {} as WsType)

    expect(mgr.getPendingRequests(SID)).toHaveLength(0)
    expect(mgr.sessionRequestCount(SID)).toBe(0)
  })

  it('送达成功（返 true）→ 无 sendError，pending 照常收缩（既有行为）', async () => {
    const { ctx, sendError, mgr } = makeCtx(makeClient(true))
    await new ExtensionMessageHandler(ctx).handleExtensionMessage(makeMsg(), {} as WsType)

    expect(sendError).not.toHaveBeenCalled()
    expect(mgr.getPendingRequests(SID)).toHaveLength(0)
  })
})
