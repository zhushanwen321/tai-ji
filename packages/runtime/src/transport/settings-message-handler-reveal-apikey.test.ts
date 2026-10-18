/**
 * SettingsMessageHandler · config.revealProviderApiKey 测试（2026-10-18 回显已存 API Key）。
 *
 * handler 只做「resolver 唯一通道 raw 读取 → reply 解包」；安全红线（oauth token 不回显、
 * 不向低优先源回落、`$ENV` 原值不展开）由 resolver 单测锁定
 * （services/auth/__tests__/provider-credential-resolver.test.ts 的「回显原值」组）。
 * 本文件锁定协议层契约：命中回明文 + source、未命中 available:false（不报错）、单条 reply。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/settings-message-handler-reveal-apikey.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SettingsMessageHandler, type SettingsHandlerContext } from './settings-message-handler.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'
import { TEST_WS as WS } from './__tests__/helpers/settings-handler-send.js'

function mockCtx(opts: {
  revealed?: { apiKey: string; source: 'auth.json' | 'models.json' }
} = {}) {
  const replies: ServerMessage[] = []
  const resolveProviderApiKeyRaw = vi.fn(async () => opts.revealed)
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload } as unknown as ServerMessage)
    }),
    configService: {},
    sessionService: {},
    modelService: {},
    authService: {},
    providerCredentialResolver: { resolveProviderApiKeyRaw },
    skillRegistry: {},
    projectRoot: '/test',
    nextPushId: vi.fn(() => 'push_1'),
    broadcast: vi.fn(),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, resolveProviderApiKeyRaw }
}

/** 单次 RPC 打点：发请求 → 断言 handled + 恰好一条 reply → 返回该 reply */
async function sendReveal(
  ctx: SettingsHandlerContext,
  replies: ServerMessage[],
  providerId = 'p1',
): Promise<ServerMessage> {
  const handler = new SettingsMessageHandler(ctx)
  const handled = await handler.handleSettingsMessage(
    { type: 'config.revealProviderApiKey', payload: { providerId }, id: 'm1' } as unknown as ClientMessage,
    WS,
  )
  expect(handled).toBe(true)
  expect(replies).toHaveLength(1)
  return replies[0]!
}

describe('SettingsMessageHandler · config.revealProviderApiKey', () => {
  it('resolver 命中 api_key 原值 → 回显明文 + source（按 providerId 查询）', async () => {
    const m = mockCtx({ revealed: { apiKey: 'sk-from-auth', source: 'auth.json' } })
    const reply = await sendReveal(m.ctx, m.replies, 'p-catalog')

    expect(reply).toMatchObject({ type: 'config.providerApiKeyRevealed', id: 'm1' })
    expect(reply.payload).toEqual({ available: true, apiKey: 'sk-from-auth', source: 'auth.json' })
    expect(m.resolveProviderApiKeyRaw).toHaveBeenCalledWith('p-catalog')
  })

  it('resolver 未命中（无凭据 / oauth-only / 不可回显形态）→ available:false，不报错', async () => {
    const m = mockCtx({})
    const reply = await sendReveal(m.ctx, m.replies)

    expect(reply.payload).toEqual({ available: false })
    expect(m.ctx.sendError).not.toHaveBeenCalled()
  })

  it('非法 payload（providerId 非字符串 / 空串）→ invalid_payload，不调 resolver、无 reply', async () => {
    for (const payload of [{ providerId: 42 }, { providerId: '' }, {}] as unknown as Array<{ providerId?: unknown }>) {
      const m = mockCtx({})
      const handler = new SettingsMessageHandler(m.ctx)
      const handled = await handler.handleSettingsMessage(
        { type: 'config.revealProviderApiKey', payload, id: 'm1' } as unknown as ClientMessage,
        WS,
      )
      expect(handled).toBe(true)
      expect(m.ctx.sendError).toHaveBeenCalledWith(WS, 'invalid_payload', expect.any(String), 'm1')
      expect(m.resolveProviderApiKeyRaw).not.toHaveBeenCalled()
      expect(m.replies).toHaveLength(0)
    }
  })
})
