/**
 * ProviderMessageHandler 测试（本分支新增路由：config.listQuotaPresets +
 * config.setProviderCatalogWatch——W3c quota presets 下发与 W1 缝隙 A 的 handler 契约）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/transport/provider-message-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ClientMessage } from '@taiji/shared'
import type { WebSocket as WsType } from 'ws'
import type { SettingsHandlerContext } from './settings-message-handler.js'
import { ProviderMessageHandler } from './provider-message-handler.js'

// ── mock 域依赖（quota presets 注册表 / models-store mtime watch）──

const { listQuotaPresetsMock, startWatchMock } = vi.hoisted(() => ({
  listQuotaPresetsMock: vi.fn(),
  startWatchMock: vi.fn(),
}))

vi.mock('../services/quota-providers/index.js', () => ({
  listQuotaPresets: listQuotaPresetsMock,
}))
vi.mock('../services/provider-catalog-refresh.js', () => ({
  startModelsStoreMtimeWatch: startWatchMock,
}))

const PRESETS = [
  { fetcher: 'zhipu', label: '智谱 GLM Coding Plan', auth: ['api-key'], match: { baseUrlPattern: 'bigmodel.cn', namePattern: 'zhipu' } },
] as never

function mockWs(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}

/** 最小 ctx（被测路由只消费 reply / broadcastProviderList；其余接口成员零消费不 mock）。 */
function mockContext(): SettingsHandlerContext {
  return {
    reply: vi.fn(),
    sendError: vi.fn(),
    broadcastProviderList: vi.fn(),
    configService: {
      refreshProviderCatalogs: vi.fn().mockResolvedValue({ refreshed: [], failed: [], corrupt: [] }),
      refreshRemoteProviders: vi.fn().mockResolvedValue({ updatedProviders: [] }),
    },
  } as unknown as SettingsHandlerContext
}

const WS = mockWs()

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

beforeEach(() => {
  listQuotaPresetsMock.mockReset().mockReturnValue(PRESETS)
  startWatchMock.mockReset().mockReturnValue(vi.fn())
})

describe('config.listQuotaPresets（W3c quota presets 下发）', () => {
  it('reply config.quotaPresets 携带注册表合并视图，返回 true', async () => {
    const ctx = mockContext()
    const handler = new ProviderMessageHandler(ctx)
    const handled = await handler.handle(msg('config.listQuotaPresets'), WS)

    expect(handled).toBe(true)
    expect(listQuotaPresetsMock).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'msg-1', 'config.quotaPresets', { presets: PRESETS })
  })
})

describe('config.refreshProviderCatalogs（远程目录刷新 + 顺带 remote-config 同步）', () => {
  it('reply 成功 envelope + 广播一次，返回 true', async () => {
    const ctx = mockContext()
    const handler = new ProviderMessageHandler(ctx)
    const handled = await handler.handle(msg('config.refreshProviderCatalogs'), WS)

    expect(handled).toBe(true)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'msg-1', 'config.providerCatalogsRefreshed', {
      refreshed: [], failed: [], corrupt: [],
    })
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(1)
  })

  it('远程同步有 provider 合并写盘 → 再广播一次', async () => {
    const ctx = mockContext()
    ;(ctx.configService.refreshRemoteProviders as ReturnType<typeof vi.fn>).mockResolvedValue({ updatedProviders: ['p1'] })
    const handler = new ProviderMessageHandler(ctx)
    const handled = await handler.handle(msg('config.refreshProviderCatalogs'), WS)

    expect(handled).toBe(true)
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(2)
  })

  it('远程同步失败 → 降级为 warn 留痕、不上抛（reply 已发成功 envelope，不得对同一 msg.id 补发 error）', async () => {
    const ctx = mockContext()
    ;(ctx.configService.refreshRemoteProviders as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('sync boom'))
    const handler = new ProviderMessageHandler(ctx)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 关键断言：handle 不 reject —— 异常若冒泡到 server.ts handleMessage 的 catch，
    // 会对同一 msg.id 补发 error envelope，形成「成功 reply + error」双回复。
    const handled = await handler.handle(msg('config.refreshProviderCatalogs'), WS)

    expect(handled).toBe(true)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'msg-1', 'config.providerCatalogsRefreshed', {
      refreshed: [], failed: [], corrupt: [],
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith('[remote-config] refresh remote providers failed:', 'sync boom')
    warnSpy.mockRestore()
  })
})

describe('config.setProviderCatalogWatch（W1 缝隙 A：models-store mtime watch 启停）', () => {
  it('enable=true → 启动 watch，reply watch-enabled', async () => {
    const ctx = mockContext()
    const handler = new ProviderMessageHandler(ctx)
    const handled = await handler.handle(msg('config.setProviderCatalogWatch', { enable: true }), WS)

    expect(handled).toBe(true)
    expect(startWatchMock).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'msg-1', 'message.status', { status: 'watch-enabled' })
  })

  it('已启用时再次 enable=true → 不重复启动（单布尔最后写者赢，watch 不叠加）', async () => {
    const ctx = mockContext()
    const handler = new ProviderMessageHandler(ctx)
    await handler.handle(msg('config.setProviderCatalogWatch', { enable: true }), WS)
    await handler.handle(msg('config.setProviderCatalogWatch', { enable: true }), WS)

    expect(startWatchMock).toHaveBeenCalledTimes(1)
  })

  it('enable=false → 停止 watch（stop 恰好一次），reply watch-disabled', async () => {
    const ctx = mockContext()
    const handler = new ProviderMessageHandler(ctx)
    await handler.handle(msg('config.setProviderCatalogWatch', { enable: true }), WS)
    const stop = startWatchMock.mock.results[0]!.value as ReturnType<typeof vi.fn>
    await handler.handle(msg('config.setProviderCatalogWatch', { enable: false }), WS)

    expect(stop).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenLastCalledWith(WS, 'msg-1', 'message.status', { status: 'watch-disabled' })
  })

  it('未启用时 enable=false → 不调 stop（幂等关闭），reply watch-disabled', async () => {
    const ctx = mockContext()
    const handler = new ProviderMessageHandler(ctx)
    const handled = await handler.handle(msg('config.setProviderCatalogWatch', { enable: false }), WS)

    expect(handled).toBe(true)
    expect(startWatchMock).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(WS, 'msg-1', 'message.status', { status: 'watch-disabled' })
  })

  it('watch 回调（mtime 变化）→ broadcastProviderList（读侧重读后广播的唯一触发点）', async () => {
    const ctx = mockContext()
    const handler = new ProviderMessageHandler(ctx)
    await handler.handle(msg('config.setProviderCatalogWatch', { enable: true }), WS)

    const onChange = startWatchMock.mock.calls[0]![0] as () => void
    onChange()
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(1)
  })
})
