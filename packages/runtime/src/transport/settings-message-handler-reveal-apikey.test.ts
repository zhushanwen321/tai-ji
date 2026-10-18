/**
 * SettingsMessageHandler · config.revealProviderApiKey 测试（2026-10-18 回显已存 API Key）。
 *
 * 锁定安全红线与读取顺序（实机凭据回显是显式点击触发的单次读取）：
 * - auth.json 的 api_key 凭据 → 回显明文 + source='auth.json'
 * - auth.json 的 oauth 凭据 → **绝不回显 token**；回落 models.json apiKey；两处皆无 → available:false
 * - models.json apiKey（custom 定义权威）→ **原值透传**（`$ENV` 引用不解析成明文，回显即所存）
 * - 无凭据 → available:false（不报错：眼睛按钮静默不动作优于错误面）
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/settings-message-handler-reveal-apikey.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SettingsMessageHandler, type SettingsHandlerContext } from './settings-message-handler.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'
import { TEST_WS as WS } from './__tests__/helpers/settings-handler-send.js'

function mockCtx(opts: {
  credential?: unknown
  providerConfig?: { apiKey?: string }
} = {}) {
  const replies: ServerMessage[] = []
  const authService = { getCredential: vi.fn(async () => opts.credential) }
  const configService = { getProvider: vi.fn(() => opts.providerConfig) }
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload } as unknown as ServerMessage)
    }),
    configService,
    sessionService: {},
    modelService: {},
    authService,
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
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, authService, configService }
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
  it('auth.json api_key 凭据 → 回显明文 + source=auth.json', async () => {
    const m = mockCtx({ credential: { type: 'api_key', key: 'sk-from-auth' } })
    const reply = await sendReveal(m.ctx, m.replies)

    expect(reply).toMatchObject({ type: 'config.providerApiKeyRevealed', id: 'm1' })
    expect(reply.payload).toEqual({ available: true, apiKey: 'sk-from-auth', source: 'auth.json' })
    expect(m.configService.getProvider).not.toHaveBeenCalled()
  })

  it('auth.json 是 OAuth 凭据 → 绝不回显 token；回落 models.json apiKey', async () => {
    const m = mockCtx({
      credential: { type: 'oauth', access: 'oauth-access-token-xyz', expires: 1 },
      providerConfig: { apiKey: 'sk-models' },
    })
    const reply = await sendReveal(m.ctx, m.replies)

    expect(reply.payload).toEqual({ available: true, apiKey: 'sk-models', source: 'models.json' })
    expect(JSON.stringify(reply.payload)).not.toContain('oauth-access-token-xyz')
  })

  it('仅 OAuth、无 models.json key → available:false（不把 token 当 key 回显）', async () => {
    const m = mockCtx({ credential: { type: 'oauth', access: 'oauth-access-token-xyz', expires: 1 } })
    const reply = await sendReveal(m.ctx, m.replies)

    expect(reply.payload).toEqual({ available: false })
    expect(JSON.stringify(reply.payload)).not.toContain('oauth-access-token-xyz')
  })

  it('models.json apiKey 原值透传（$ENV 引用不解析成明文——回显即所存）', async () => {
    const m = mockCtx({ providerConfig: { apiKey: '$OPENAI_API_KEY' } })
    const reply = await sendReveal(m.ctx, m.replies)

    expect(reply.payload).toEqual({ available: true, apiKey: '$OPENAI_API_KEY', source: 'models.json' })
  })

  it('无任何凭据 → available:false（不报错，UI 眼睛静默不动作）', async () => {
    const m = mockCtx({})
    const reply = await sendReveal(m.ctx, m.replies)

    expect(reply.payload).toEqual({ available: false })
    expect(m.ctx.sendError).not.toHaveBeenCalled()
  })
})
