/**
 * OauthMessageHandler 凭据域变更 → zcode provider 镜像重跑触发链（MF-2 第二半）。
 *
 * 覆盖：
 *  - config.oauthLogin 成功（flow 终态回调）→ `ctx.providersMutatedSync` 恰被调用一次；
 *    started:false（无 oauthConfig / 已有 flow）→ 回调不触发、无镜像调用；
 *  - config.oauthLogout 成功 → 触发；logout 抛错 → 不触发（凭据仍在，副本不动）；
 *  - ctx 未注入 providersMutatedSync（存量测试装配形态）→ 不调用、不炸。
 *
 * 语义：OAuth 凭据本身不进镜像（短时 token 不可当静态 api-key，见
 * zcode-provider-sync 的 oauth-credential skip），但登录/退出改变凭据域事实
 * （auth.json 条目 + models.json apiKey 清理），副本须事件驱动跟随（ADR-0122）。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/oauth-message-handler-mirror.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ClientMessage } from '@taiji/shared'
import { OauthMessageHandler } from './oauth-message-handler.js'
import type { SettingsHandlerContext } from './settings-message-handler.js'

const WS = {} as never

function mockCtx(options: {
  providersMutatedSync?: () => Promise<void>
  loginStarted?: boolean
  logoutThrows?: boolean
} = {}) {
  const replies: Array<{ type: string; id?: string; payload: unknown }> = []
  const providersMutatedSync = options.providersMutatedSync ?? vi.fn(async () => {})
  const authService = {
    login: vi.fn((_providerId: string, onAuthenticated?: () => void) => {
      // 模拟流程终态：started 时异步回调（真实实装由 runFlow 在 auth.success 后调用）
      if (options.loginStarted !== false) onAuthenticated?.()
      return options.loginStarted === false
        ? { started: false, error: 'provider "x" 不支持 OAuth' }
        : { started: true }
    }),
    cancel: vi.fn(() => ({ cancelled: false })),
    hasOAuth: vi.fn(async () => false),
    logout: vi.fn(async () => {
      if (options.logoutThrows) throw new Error('EACCES')
    }),
  }
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload })
    }),
    authService,
    providersMutatedSync,
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, authService, providersMutatedSync }
}

function msg(type: string, payload: Record<string, unknown>): ClientMessage {
  return { type, id: 'm1', payload } as unknown as ClientMessage
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OauthMessageHandler · 凭据域变更触发 zcode provider 镜像（MF-2）', () => {
  it('config.oauthLogin 成功（flow 终态回调）→ providersMutatedSync 恰被调用一次', async () => {
    const { ctx, providersMutatedSync, replies } = mockCtx()
    const handler = new OauthMessageHandler(ctx)

    const handled = await handler.handle(msg('config.oauthLogin', { providerId: 'anthropic' }), WS)

    expect(handled).toBe(true)
    expect(replies.some(r => r.type === 'config.oauthLoginReply')).toBe(true)
    expect(providersMutatedSync).toHaveBeenCalledTimes(1)
  })

  it('config.oauthLogin started:false（无 oauthConfig / 已有 flow）→ 回调不触发、无镜像调用', async () => {
    const { ctx, providersMutatedSync } = mockCtx({ loginStarted: false })
    const handler = new OauthMessageHandler(ctx)

    await handler.handle(msg('config.oauthLogin', { providerId: 'anthropic' }), WS)

    expect(providersMutatedSync).not.toHaveBeenCalled()
  })

  it('config.oauthLogout 成功 → 凭据域变更触发一次镜像', async () => {
    const { ctx, providersMutatedSync, replies } = mockCtx()
    const handler = new OauthMessageHandler(ctx)

    const handled = await handler.handle(msg('config.oauthLogout', { providerId: 'anthropic' }), WS)

    expect(handled).toBe(true)
    expect(replies.some(r => r.type === 'config.oauthLogoutReply' && (r.payload as { ok?: boolean }).ok === true)).toBe(true)
    expect(providersMutatedSync).toHaveBeenCalledTimes(1)
  })

  it('config.oauthLogout 失败（凭据可能仍在）→ 不触发镜像', async () => {
    const { ctx, providersMutatedSync } = mockCtx({ logoutThrows: true })
    const handler = new OauthMessageHandler(ctx)

    await handler.handle(msg('config.oauthLogout', { providerId: 'anthropic' }), WS)

    expect(providersMutatedSync).not.toHaveBeenCalled()
  })

  it('ctx 未注入 providersMutatedSync（存量测试装配形态）→ 登录/退出照常应答、不炸', async () => {
    const { ctx, replies } = mockCtx()
    delete (ctx as { providersMutatedSync?: unknown }).providersMutatedSync
    const handler = new OauthMessageHandler(ctx)

    await handler.handle(msg('config.oauthLogin', { providerId: 'anthropic' }), WS)
    await handler.handle(msg('config.oauthLogout', { providerId: 'anthropic' }), WS)

    expect(replies.map(r => r.type)).toEqual(['config.oauthLoginReply', 'config.oauthLogoutReply'])
  })

  it('镜像 reject → catch 只 console.warn（fire-and-forget，不阻断 OAuth 应答）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, replies } = mockCtx({
      providersMutatedSync: vi.fn(async () => { throw new Error('mirror boom') }),
    })
    const handler = new OauthMessageHandler(ctx)

    await handler.handle(msg('config.oauthLogout', { providerId: 'anthropic' }), WS)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      '[oauth-message-handler] zcode provider mirror sync failed:',
      'mirror boom',
    ), { interval: 1 })

    expect(replies.some(r => r.type === 'config.oauthLogoutReply')).toBe(true)
  })

  it('镜像同步 throw（同步异常形态）→ logout 应答仍是单份 ok:true，不回第二份 ok:false（S-8）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, replies } = mockCtx({
      // 同步 throw 而非 rejected promise：挪出主 try 前会走 catch 对同一 msg.id 回
      // 第二份 ok:false；挪出后由 mirrorAfterCredentialMutation 内部捕获只 warn
      providersMutatedSync: vi.fn((): Promise<void> => { throw new Error('sync throw') }),
    })
    const handler = new OauthMessageHandler(ctx)

    const handled = await handler.handle(msg('config.oauthLogout', { providerId: 'anthropic' }), WS)

    expect(handled).toBe(true)
    const logoutReplies = replies.filter(r => r.type === 'config.oauthLogoutReply')
    expect(logoutReplies).toHaveLength(1)
    expect((logoutReplies[0].payload as { ok?: boolean }).ok).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      '[oauth-message-handler] zcode provider mirror sync failed:',
      'sync throw',
    )
  })
})
