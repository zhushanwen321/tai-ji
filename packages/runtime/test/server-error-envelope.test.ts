/**
 * RuntimeServer.handleMessage 异常漏斗 + ConnectionManager 兜底（code-harden RT-1#3）。
 *
 * 修复前的缺陷链：
 * 1. `'sessionId' in msg.payload` 在 payload undefined 时抛 TypeError——handler 异常的
 *    catch 块自身二次抛，原异常被 TypeError 替换；
 * 2. 二次抛落到 connection-manager 兜底（onMessage().catch），兜底信封不带 sessionId
 *    （违裁决 7：错误消息必须可归属 session，前端按 session 隔离规则丢弃无主信封）。
 *
 * 修复后锚定：
 * - T1：payload 缺省 + handler 抛错 → handleMessage 正常收口，error envelope 携带原异常
 *   message（不抛 TypeError）；
 * - T2：error envelope 发送自身失败（ws TOCTOU）→ 上抛 Error 的 cause 保留原 handler 异常；
 * - T3：ConnectionManager 兜底信封透传 payload.sessionId。
 *
 * 运行：cd packages/runtime && npx vitest run test/server-error-envelope.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ClientMessage } from '@taiji/shared'
import type { ISessionService, IConfigService, IModelService } from '../src/interfaces.js'
import type { SkillRegistry } from '../src/services/skill-registry.js'
import type { IProviderCredentialResolver } from '../src/services/ports/provider-credential-resolver.js'
import type { IModelConnectionTester } from '../src/services/ports/model-connection-tester.js'
import { RuntimeServer } from '../src/transport/server.js'
import { ConnectionManager } from '../src/transport/connection-manager.js'

/** 最小 mock services：setServices 装配只存引用，具体方法按需补。 */
function makeMockServices(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const sessionService = {
    listPersistedSessions: vi.fn().mockReturnValue([]),
    getRpcClient: vi.fn().mockReturnValue(undefined),
    setOnSessionDestroyed: vi.fn(),
    restoreSession: vi.fn(),
    create: vi.fn(),
    ...overrides,
  } as unknown as ISessionService
  const configService = {
    listProviders: vi.fn().mockReturnValue([]),
  } as unknown as IConfigService
  const modelService = {} as IModelConnectionTester & IModelService
  return { sessionService, configService, modelService }
}

/** 构造已完成 setServices 装配的 server（ConnectionManager 不 listen，无端口占用）。 */
function makeServer(sessionOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const { sessionService, configService, modelService } = makeMockServices(sessionOverrides)
  const server = new RuntimeServer(0, '/mock-project-root', 'token')
  server.setServices(sessionService, configService, modelService, {
    skillRegistry: {} as SkillRegistry,
    providerCredentialResolver: {} as IProviderCredentialResolver,
    connectionTester: {} as IModelConnectionTester,
  })
  const handleMessage = (server as unknown as {
    handleMessage(msg: ClientMessage, ws: WebSocket): Promise<void>
  }).handleMessage.bind(server)
  return { handleMessage, sessionService }
}

function makeWs(opts: { sendThrows?: boolean } = {}): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: opts.sendThrows
      ? vi.fn(() => { throw new Error('ws closed (TOCTOU)') })
      : vi.fn(),
    // ConnectionManager.stop 的优雅关闭路径会调 close（mock no-op）
    close: vi.fn(),
  } as unknown as WebSocket
}

/** 畸形帧：payload 字段缺省（JSON.parse 层不校验形状，路由层此前假设必有 payload 对象）。
 * type 选 session.create：其 case handler 的 catch 对非 MODEL_NOT_CONFIGURED 异常原样
 * rethrow（区别于 session.restore 的内部 sendError 消费），异常直达 handleMessage 主漏斗。 */
function payloadlessMsg(): ClientMessage {
  return { type: 'session.create', id: 'req-1' } as unknown as ClientMessage
}

describe('RuntimeServer.handleMessage 异常漏斗（RT-1#3）', () => {
  it('T1: payload 缺省 + handler 抛错 → 不再二次抛 TypeError，error envelope 携带原异常信息', async () => {
    const { handleMessage, sessionService } = makeServer()
    const ws = makeWs()

    // 求值序：payload 缺省时 `msg.payload.cwd`（service 调用参数）先抛 TypeError(reading 'cwd')
    // → handler catch 原样 rethrow → 主漏斗。
    // 修复前：主漏斗 catch 里 `'sessionId' in msg.payload` 再抛 TypeError(reading 'payload')
    // 替换原异常 → handleMessage reject、信封丢失。修复后可选链消除二次抛。
    await expect(handleMessage(payloadlessMsg(), ws)).resolves.toBeUndefined()

    const sent = JSON.parse(vi.mocked(ws.send).mock.calls[0][0] as string) as {
      type: string
      id: string
      payload: { code: string; message: string }
    }
    expect(sent).toMatchObject({ type: 'error', id: 'req-1', payload: { code: 'handler_error' } })
    // 信封 message 是 handler 层的原 TypeError（reading 'cwd'），不是 catch 块的二次
    // TypeError（reading 'payload'）——原异常未被替换。
    expect(sent.payload.message).toContain("(reading 'cwd')")
    expect(sent.payload.message).not.toContain("(reading 'payload')")
    expect(sessionService.create).not.toHaveBeenCalled()
  })

  it('T2: error envelope 发送自身失败 → 上抛 Error 以 cause 保留原 handler 异常', async () => {
    const { handleMessage } = makeServer()
    const ws = makeWs({ sendThrows: true })

    // handler 抛 TypeError(reading 'cwd') → 主漏斗 → sendError → broker.send → ws.send
    // 抛（TOCTOU）→ 主漏斗以 cause 包装上抛
    const thrown = await handleMessage(payloadlessMsg(), ws).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('envelope send failed')
    expect((thrown as Error).message).toContain('ws closed (TOCTOU)')
    // cause 保留的是原 handler 异常（TypeError reading 'cwd'），而非 envelope 发送错误——归因链不断裂
    const cause = (thrown as Error & { cause?: unknown }).cause
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toContain("(reading 'cwd')")
    expect((cause as Error).message).not.toContain('ws closed')
  })

  it('T3: ConnectionManager 兜底信封透传 payload.sessionId（裁决 7 可归属）', async () => {
    const sendError = vi.fn()
    const conn = new ConnectionManager(0, {
      onConnect: () => {},
      onMessage: () => Promise.reject(new Error('funnel second throw')),
      sendError,
      onDisconnect: () => {},
    }, 'token')
    const ws = makeWs()
    // 窄化注入 authed 状态（绕过 auth 握手，直测 handleRawMessage 的兜底 catch）
    const connInternal = conn as unknown as {
      handleRawMessage(ws: WebSocket, data: unknown): void
      authedConnections: Set<WebSocket>
    }
    connInternal.authedConnections.add(ws)

    connInternal.handleRawMessage(ws, JSON.stringify({ type: 'session.restore', id: 'req-9', payload: { sessionId: 's9' } }))

    // catch 是异步链：等微任务flush后断言
    await vi.waitFor(() => {
      expect(sendError).toHaveBeenCalledTimes(1)
    })
    expect(sendError).toHaveBeenCalledWith(
      ws,
      'handler_error',
      'funnel second throw',
      'req-9',
      { sessionId: 's9' },
    )
    // 清理：stop 清 heartbeat/auth 计时器并关 httpServer（防 45s 心跳 timer 挂住测试进程）
    await conn.stop()
  })
})
