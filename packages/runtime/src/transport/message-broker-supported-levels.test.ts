/**
 * ServerMessageBroker supportedLevels 接线（U5 下发标注）测试。
 *
 * 锁定：config.providers 下发前经 modelService.attachSupportedLevels 标注（view-ready 字段，
 * renderer 零推导）——
 * - broadcastProviderList / sendInitialState 两条链路（共享 buildProviderListMsgs）都标注；
 * - pi 版本与 app.info 同源（services.appInfo.piVersion）；
 * - 降级：modelService 缺 attachSupportedLevels（调用抛 TypeError）或标注抛错时，
 *   providers 原样下发，config.providers 与 model.list 两帧都不被阻断。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/message-broker-supported-levels.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { ServerMessageBroker } from './message-broker.js'
import type { BrokerServices, ClientPool } from './message-broker.js'
import type { ProviderId, ProviderInfo, ServerMessage } from '@taiji/shared'

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

/** 模拟 ModelCapabilityRegistry.attachSupportedLevels 的 view-ready 标注（逐模型加数组字段）。 */
function makeAnnotatingModelService(levelsByModel: Record<string, string[]>) {
  return {
    aggregateModelsWithScoped: vi.fn((providers: ProviderInfo[]) =>
      providers.flatMap(p => p.models.map(m => ({ id: m.id, providerId: p.id }))),
    ),
    attachSupportedLevels: vi.fn((providers: ProviderInfo[]) =>
      providers.map(p => ({
        ...p,
        models: p.models.map(m => ({ ...m, supportedLevels: levelsByModel[m.id] })),
      })),
    ),
  }
}

function makeBroker(modelService: unknown, appInfo = { appVersion: '1.2.3', piVersion: '9.9.9' }) {
  const sent: string[] = []
  const fakeWs = {
    readyState: 1,
    send: (payload: string) => { sent.push(payload) },
  }
  const pool = { clients: new Set([fakeWs]) } as unknown as ClientPool
  const services = {
    sessionService: { listPersistedSessions: vi.fn(() => []) },
    configService: {
      listProviders: vi.fn(() => PROVIDERS),
      getScopedModels: vi.fn(() => []),
      loadSkills: vi.fn(() => []),
      loadAgents: vi.fn(() => []),
      getSkillPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getAgentPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getExtensionPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getDefaultModel: vi.fn(() => null),
      getSystemPromptConfig: vi.fn(() => ({ config: null, corrupted: false })),
      getTerminalConfig: vi.fn(() => ({ config: null, corrupted: false })),
    },
    modelService,
    pluginService: undefined,
    extensionService: undefined,
    projectRoot: '/test',
    appInfo,
  } as unknown as BrokerServices
  return { broker: new ServerMessageBroker(pool, services), sent, fakeWs }
}

function parseSent(sent: string[]): ServerMessage[] {
  return sent.map((s) => JSON.parse(s) as ServerMessage)
}

describe('ServerMessageBroker supportedLevels 接线（U5）', () => {
  it('broadcastProviderList：config.providers 的 models 带 supportedLevels 数组，pi 版本取 appInfo.piVersion', () => {
    const modelService = makeAnnotatingModelService({ k3: ['off', 'low', 'high'], k2: ['off'] })
    const { broker, sent } = makeBroker(modelService)

    broker.broadcastProviderList()

    const providersMsg = parseSent(sent).find((m) => m.type === 'config.providers')
    expect(providersMsg).toBeDefined()
    const { providers } = providersMsg!.payload as { providers: ProviderInfo[] }
    expect(providers[0].models[0].supportedLevels).toEqual(['off', 'low', 'high'])
    expect(providers[0].models[1].supportedLevels).toEqual(['off'])
    // pi 版本同源 app.info（D8-2 组合根 mutate services.appInfo 后此处读到当前值）
    expect(modelService.attachSupportedLevels).toHaveBeenCalledWith(PROVIDERS, '9.9.9')
  })

  it('sendInitialState：初始推送的 config.providers 同样标注（buildProviderListMsgs 共享）', () => {
    const modelService = makeAnnotatingModelService({ k3: ['off'], k2: ['off'] })
    const { broker, sent, fakeWs } = makeBroker(modelService)

    broker.sendInitialState(fakeWs as unknown as import('ws').WebSocket)

    const providersMsg = parseSent(sent).find((m) => m.type === 'config.providers')
    const { providers } = providersMsg!.payload as { providers: ProviderInfo[] }
    expect(providers[0].models[0].supportedLevels).toEqual(['off'])
  })

  it('model.list 帧：ModelInfo 映射白名单不透传 supportedLevels（model.list 形状不变）', () => {
    const modelService = makeAnnotatingModelService({ k3: ['off'], k2: ['off'] })
    const { broker, sent } = makeBroker(modelService)

    broker.broadcastProviderList()

    const modelListMsg = parseSent(sent).find((m) => m.type === 'model.list')
    const { models } = modelListMsg!.payload as { models: Array<{ id: string; supportedLevels?: string[] }> }
    expect(models).toHaveLength(2)
    for (const m of models) expect(m.supportedLevels).toBeUndefined()
  })

  it('降级 A：modelService 缺 attachSupportedLevels（调用抛 TypeError）→ providers 原样下发不抛', () => {
    const { broker, sent } = makeBroker({ aggregateModelsWithScoped: vi.fn(() => []) })

    expect(() => broker.broadcastProviderList()).not.toThrow()
    const providersMsg = parseSent(sent).find((m) => m.type === 'config.providers')
    const { providers } = providersMsg!.payload as { providers: ProviderInfo[] }
    expect(providers).toEqual(PROVIDERS)
    expect(providers[0].models[0].supportedLevels).toBeUndefined()
  })

  it('降级 B：标注抛错 → warn 不阻断，config.providers 与 model.list 两帧照常下发', () => {
    const modelService = {
      aggregateModelsWithScoped: vi.fn(() => [{ id: 'k3', providerId: 'kimi-coding' }]),
      attachSupportedLevels: vi.fn(() => { throw new Error('builtin mtime unreadable') }),
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { broker, sent } = makeBroker(modelService)

      expect(() => broker.broadcastProviderList()).not.toThrow()
      const types = parseSent(sent).map((m) => m.type)
      expect(types).toContain('config.providers')
      expect(types).toContain('model.list')
      const providersMsg = parseSent(sent).find((m) => m.type === 'config.providers')
      const { providers } = providersMsg!.payload as { providers: ProviderInfo[] }
      expect(providers[0].models[0].supportedLevels).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('attachSupportedLevels failed'), expect.any(Error))
    } finally {
      warnSpy.mockRestore()
    }
  })
})
