/**
 * SettingsMessageHandler config.get/setRetryConfig case 测试（设计 llm-retry-settings §3.4）。
 *
 * 锁定：get reply 'config.retryConfig' 形状（config+configured 透传）；set 成功
 * reply + broadcast config.retryConfig；set 校验失败 sendError set_retry_config_failed
 * 且不广播。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/settings-message-handler-llm-retry.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SettingsMessageHandler, type SettingsHandlerContext } from './settings-message-handler.js'
import type { ClientMessage, LlmRetryConfig, ServerMessage } from '@taiji/shared'

const SNAPSHOT = {
  config: { enabled: true, maxRetries: 2, baseDelayMs: 3000, provider: { maxRetries: 0, maxRetryDelayMs: 60000 } } as LlmRetryConfig,
  configured: true,
}

function mockCtx() {
  const replies: ServerMessage[] = []
  const broadcasts: ServerMessage[] = []
  const configService = {
    getRetryConfig: vi.fn(() => SNAPSHOT),
    setRetryConfig: vi.fn(() => ({ ok: true })),
  }
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload } as unknown as ServerMessage)
    }),
    configService,
    sessionService: {},
    modelService: {},
    authService: {},
    skillRegistry: {},
    projectRoot: '/test',
    nextPushId: vi.fn(() => 'push_1'),
    broadcast: vi.fn((m: ServerMessage) => broadcasts.push(m)),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
    // D-21 端口化：ctx connectionTester 构造必需——本文件用例不走 mode=test，vi.fn 替身即可
    connectionTester: { supports: vi.fn(), test: vi.fn() },
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, broadcasts, configService }
}

const WS = {} as never

describe('SettingsMessageHandler · config.getRetryConfig', () => {
  it('reply config.retryConfig 透传 { config, configured } 形状', async () => {
    const { ctx, replies } = mockCtx()
    const handler = new SettingsMessageHandler(ctx)
    const handled = await handler.handleSettingsMessage(
      { type: 'config.getRetryConfig', payload: {}, id: 'm1' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(true)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'config.retryConfig', id: 'm1' })
    expect(replies[0].payload).toEqual(SNAPSHOT)
  })
})

describe('SettingsMessageHandler · config.setRetryConfig', () => {
  it('成功：reply + broadcast config.retryConfig（configured=true），不 sendError', async () => {
    const { ctx, replies, broadcasts } = mockCtx()
    const handler = new SettingsMessageHandler(ctx)
    const config = SNAPSHOT.config
    const handled = await handler.handleSettingsMessage(
      { type: 'config.setRetryConfig', payload: { config }, id: 'm2' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(true)
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(replies[0]).toMatchObject({ type: 'config.retryConfig', id: 'm2' })
    expect(replies[0].payload).toEqual({ config, configured: true })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toMatchObject({ type: 'config.retryConfig' })
    expect(broadcasts[0].payload).toEqual({ config, configured: true })
  })

  it('校验失败：sendError set_retry_config_failed（含校验 error），不广播', async () => {
    const { ctx, broadcasts, configService } = mockCtx()
    configService.setRetryConfig = vi.fn(() => ({ ok: false, error: 'baseDelayMs 超出范围(整数 0-600000): 99999000' }))
    const handler = new SettingsMessageHandler(ctx)
    const config = { ...SNAPSHOT.config, baseDelayMs: 99999000 }
    const handled = await handler.handleSettingsMessage(
      { type: 'config.setRetryConfig', payload: { config }, id: 'm3' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(true)
    expect(ctx.sendError).toHaveBeenCalledWith(WS, 'set_retry_config_failed', 'baseDelayMs 超出范围(整数 0-600000): 99999000', 'm3')
    expect(broadcasts).toHaveLength(0)
  })
})
