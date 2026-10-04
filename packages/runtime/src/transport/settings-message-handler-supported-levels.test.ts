/**
 * SettingsMessageHandler config.getProviders supportedLevels 接线（U5 下发标注）测试。
 *
 * 锁定：getProviders reply 的 providers 与广播链路（message-broker.buildProviderListMsgs）
 * 同标 supportedLevels——modelService 用真实 attachSupportedLevels 纯函数小 fixture（pi-ai 同源
 * 计算），断言端到端 view-ready 值；并锁定 modelService 缺 attachSupportedLevels
 * （方法缺失降级）时原样 reply 不抛。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/settings-message-handler-supported-levels.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SettingsMessageHandler, type SettingsHandlerContext } from './settings-message-handler.js'
import { attachSupportedLevels } from '../services/model-capability.js'
import type { ClientMessage, ProviderId, ProviderInfo, ServerMessage } from '@taiji/shared'

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'kimi-coding' as ProviderId,
    name: 'Kimi Coding',
    apiKeySet: true,
    status: 'connected',
    models: [
      { id: 'k3', name: 'K3', reasoning: true },
      { id: 'k2', name: 'K2' },
    ],
  },
]

/** 真实纯函数小 fixture：attachSupportedLevels 走 pi-ai 同源 computeSupportedLevels。 */
function makeRegistryBackedModelService() {
  return {
    aggregateModels: vi.fn(() => []),
    attachSupportedLevels: vi.fn((providers: ProviderInfo[], _piVersion?: string) =>
      attachSupportedLevels(providers),
    ),
  }
}

function mockCtx(modelService: unknown) {
  const replies: ServerMessage[] = []
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload } as unknown as ServerMessage)
    }),
    configService: {
      listProviders: vi.fn(() => PROVIDERS),
      getScopedModels: vi.fn(() => []),
      // M4/RT-3#4：config.getProviders reply 携带 models.json 降级态标志
      isModelsStoreCorrupted: vi.fn(() => false),
    },
    sessionService: {},
    modelService,
    authService: {},
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
    // D-21 端口化：ctx connectionTester 构造必需——本文件用例不走 mode=test，vi.fn 替身即可
    connectionTester: { supports: vi.fn(), test: vi.fn() },
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies }
}

function getProvidersMsg(): ClientMessage {
  return { type: 'config.getProviders', payload: {}, id: 'm1' } as unknown as ClientMessage
}
const WS = {} as never

describe('SettingsMessageHandler · config.getProviders supportedLevels 接线（U5）', () => {
  it('reply 的 providers 逐模型带 pi-ai 同源 supportedLevels（与广播链路同标）', async () => {
    const modelService = makeRegistryBackedModelService()
    const { ctx, replies } = mockCtx(modelService)
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(getProvidersMsg(), WS)

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const { providers } = replies[0].payload as { providers: ProviderInfo[] }
    // pi 两级门控：reasoning:true 无 thinkingLevelMap → 全档位；缺省 → ['off']
    expect(providers[0].models[0].supportedLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    expect(providers[0].models[1].supportedLevels).toEqual(['off'])
  })

  it('modelService 缺 attachSupportedLevels（调用抛 TypeError）→ providers 原样 reply 不抛（降级兑底）', async () => {
    const { ctx, replies } = mockCtx({ aggregateModels: vi.fn(() => []) })
    const handler = new SettingsMessageHandler(ctx)

    await expect(handler.handleSettingsMessage(getProvidersMsg(), WS)).resolves.toBe(true)

    const { providers } = replies[0].payload as { providers: ProviderInfo[] }
    expect(providers).toEqual(PROVIDERS)
    expect(providers[0].models[0].supportedLevels).toBeUndefined()
  })
})
