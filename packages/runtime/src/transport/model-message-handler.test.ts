/**
 * ModelMessageHandler 凭据形态不支持拦截测试（code-harden RT-7#4 消费方）。
 *
 * 覆盖：resolver 返回 { unsupported } 判别结构时，discover / test 两条链路
 * 均在**发请求前拦截**（modelService.discoverModelsFromApi / testProviderConnections
 * 不被调用——禁止以形态标记串作 Bearer 下发外部请求），错误文案中文 reply 给前端。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/transport/model-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@taiji/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'
import type { IProviderCredentialResolver, ResolvedProviderCredential } from '../services/ports/provider-credential-resolver.js'
import { ModelMessageHandler } from './model-message-handler.js'

function makeCtx(resolved: Promise<ResolvedProviderCredential | undefined>) {
  const discoverFromApi = vi.fn(async () => [{ id: 'm-1', name: 'M1' }])
  const testConnections = vi.fn(async () => ({ success: true, results: [] }))
  const resolver: IProviderCredentialResolver = {
    hasProviderCredential: () => false,
    listCredentialBackedProviderIds: () => new Set<string>(),
    resolveProviderCredential: () => resolved,
  }
  const ctx = {
    reply: vi.fn(),
    sendError: vi.fn(),
    modelService: { discoverModelsFromApi: discoverFromApi, testProviderConnections: testConnections },
    providerCredentialResolver: resolver,
    connectionTester: { supports: () => true, test: vi.fn(async () => ({ api: 'a', modelId: 'm', ok: true })) },
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, discoverFromApi, testConnections, reply: ctx.reply }
}

const ws = {} as WsType

function discoverMsg(mode: 'discover' | 'test'): Extract<ClientMessage, { type: 'config.discoverModels' }> {
  return {
    type: 'config.discoverModels',
    id: 'req-1',
    payload: { baseUrl: 'https://api.example.com', providerId: 'p1', mode },
  } as Extract<ClientMessage, { type: 'config.discoverModels' }>
}

/** handler 的 handle 同步返回（promise 链在后台），flush 微任务后断言 reply。 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('RT-7#4：unsupported 凭据形态在发请求前拦截（禁止下发 HTTP）', () => {
  it('discover 链：resolver 返回 { unsupported: "command" } → reply 失败中文文案，discoverModelsFromApi 零调用', async () => {
    const { ctx, discoverFromApi, reply } = makeCtx(Promise.resolve({ unsupported: 'command' }))
    const handler = new ModelMessageHandler(ctx)

    expect(handler.handle(discoverMsg('discover'), ws)).toBe(true)
    await flush()

    expect(discoverFromApi).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(ws, 'req-1', 'config.discoveredModels', {
      models: [],
      success: false,
      error: expect.stringContaining('command 形态'),
    })
  })

  it('discover 链：unresolved-env → 同拦，文案指向环境变量', async () => {
    const { ctx, discoverFromApi, reply } = makeCtx(Promise.resolve({ unsupported: 'unresolved-env' }))
    const handler = new ModelMessageHandler(ctx)

    expect(handler.handle(discoverMsg('discover'), ws)).toBe(true)
    await flush()

    expect(discoverFromApi).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(ws, 'req-1', 'config.discoveredModels', {
      models: [],
      success: false,
      error: expect.stringContaining('环境变量'),
    })
  })

  it('test 链：resolver 返回 unsupported → reply 顶层失败，testProviderConnections 零调用', async () => {
    const { ctx, testConnections, reply } = makeCtx(Promise.resolve({ unsupported: 'command' }))
    const handler = new ModelMessageHandler(ctx)

    expect(handler.handle(discoverMsg('test'), ws)).toBe(true)
    await flush()

    expect(testConnections).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(ws, 'req-1', 'config.discoveredModels', {
      models: [],
      success: false,
      error: expect.stringContaining('command 形态'),
      results: [],
    })
  })

  it('对照：resolver 返回明文 key → discover 正常发请求（拦截不误伤正常路径）', async () => {
    const { ctx, discoverFromApi, reply } = makeCtx(Promise.resolve({ key: 'sk-ok', source: 'auth.json' }))
    const handler = new ModelMessageHandler(ctx)

    expect(handler.handle(discoverMsg('discover'), ws)).toBe(true)
    await flush()

    expect(discoverFromApi).toHaveBeenCalledWith('https://api.example.com', 'sk-ok', undefined)
    expect(reply).toHaveBeenCalledWith(ws, 'req-1', 'config.discoveredModels', {
      models: [{ id: 'm-1', name: 'M1' }],
      success: true,
    })
  })
})
