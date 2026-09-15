/**
 * ModelService 单测 —— 瘦身后的 switchModel 编排行为验证。
 *
 * session 级状态（modelId/thinkingLevel/inputTokens/usagePercent）单一 owner 是 SessionService；
 * ModelService 瘦身后职责仅为委托 SessionService.switchModel 做 session 级 RPC/缓存/broadcast。
 * D4 移除 config.defaults 广播——全局默认回归 Settings 配置单一语义。
 *
 * 全局默认模型持久化：pi 0.84.4 实装中 setModel 不写 settings.json，
 * taiji 不再冗余写（D1d）。
 *
 * 测试边界：ModelService 是编排层（session 级委托 sessionService）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ModelService, ModelDiscoveryError } from '../src/services/model-service.js'
import type { ModelDiscoveryErrorCode } from '../src/services/model-service.js'
import type { IModelSource } from '../src/services/ports/model.js'
import type { ISessionService, IConfigService, IMessageBroker } from '../src/interfaces.js'
import type { ProviderInfo, ServerMessage, ProviderId } from '@taiji/shared'

// ── mock 工厂 ──────────────────────────────────────────────────

function makeMockSessionService(overrides: Partial<ISessionService> = {}): ISessionService {
  return {
    switchModel: vi.fn(async () => 's1'),
    setThinkingLevel: vi.fn(async () => undefined),
    setThinkingLevelCache: vi.fn(),
    getSummary: vi.fn(() => undefined),
    getInputTokens: vi.fn((): number => 0),
    applyContextUpdate: vi.fn(),
    getUsagePercent: vi.fn((): number => 0),
    ...overrides,
  } as unknown as ISessionService
}

function makeMockConfigService(providers: ProviderInfo[], overrides: Partial<IConfigService> = {}): IConfigService {
  return {
    listProviders: vi.fn(() => providers),
    setDefaultModel: vi.fn(),
    getDefaultModel: vi.fn(() => null),
    getScopedModels: vi.fn(() => []),
    ...overrides,
  } as unknown as IConfigService
}

function makeMockBroker(): { broker: IMessageBroker; broadcasts: ServerMessage[] } {
  const broadcasts: ServerMessage[] = []
  const broker = {
    broadcast: vi.fn((msg: ServerMessage) => { broadcasts.push(msg) }),
  }
  return { broker: broker as unknown as IMessageBroker, broadcasts }
}

function makeMockModelSource(overrides: Partial<IModelSource> = {}): IModelSource {
  return { discoverFromApi: vi.fn(async () => []), ...overrides }
}

/** scoped-model 验收（A1-A4）用：构造带 N 个模型的 ProviderInfo。 */
function makeProvider(id: string, name: string, modelIds: string[], enabled = true): ProviderInfo {
  return {
    id: id as ProviderId,
    name,
    apiKeySet: true,
    status: 'connected',
    enabled,
    models: modelIds.map(mid => ({ id: mid, name: mid })),
  }
}

// ── 测试 ──────────────────────────────────────────────────────

describe('ModelService · switchModel 编排（瘦身后）', () => {
  let modelSource: IModelSource

  beforeEach(() => {
    modelSource = makeMockModelSource()
  })

  it('委托 sessionService.switchModel 做 session 级 RPC/缓存/broadcast', async () => {
    const sessionService = makeMockSessionService()
    const configService = makeMockConfigService([])
    const { broker } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.switchModel('s1', 'anthropic' as ProviderId, 'claude-4')

    expect(sessionService.switchModel).toHaveBeenCalledWith('s1', 'anthropic', 'claude-4')
  })

  it('不再冗余写 configService.setDefaultModel（D1d：pi 0.84.4 setModel 不持久化全局默认，taiji 也不写）', async () => {
    const sessionService = makeMockSessionService()
    const configService = makeMockConfigService([])
    const { broker } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.switchModel('s1', 'anthropic' as ProviderId, 'claude-4')

    // 全局默认模型持久化归 pi RPC setModel（sessionService.switchModel 委托链），
    // configService.setDefaultModel 仅剩 Settings 页保存路径调用
    expect(configService.setDefaultModel).not.toHaveBeenCalled()
  })

  it('D4：switchModel 不再广播 config.defaults（全局默认回归 Settings 配置单一语义）', async () => {
    const sessionService = makeMockSessionService()
    const configService = makeMockConfigService([])
    const { broker, broadcasts } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.switchModel('s1', 'openai' as ProviderId, 'gpt-4')

    // D4：session 级切换不再改全局默认，config.defaults 帧不产生
    const configDefaults = broadcasts.filter((m) => m.type === 'config.defaults')
    expect(configDefaults).toHaveLength(0)
  })

  it('不再自己广播 session.state_changed（交由 sessionService.switchModel 内部负责）', async () => {
    const sessionService = makeMockSessionService()
    const configService = makeMockConfigService([])
    const { broker, broadcasts } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.switchModel('s1', 'anthropic' as ProviderId, 'claude-4')

    // D4：ModelService 不再广播任何消息（config.defaults 已移除，session.state_changed 由 sessionService 负责）
    const types = broadcasts.map((m) => m.type)
    expect(types).not.toContain('config.defaults')
    expect(types).not.toContain('session.state_changed')
  })

  // D1d 移除冗余持久化后，原「setDefaultModel 失败 best-effort 不阻塞」场景不复存在
  //（switchModel 不再触碰该写路径），无对应失败分支需要覆盖。
})

describe('ModelService · setThinkingLevel 委托', () => {
  let modelSource: IModelSource

  beforeEach(() => {
    modelSource = makeMockModelSource()
  })

  it('委托 sessionService.setThinkingLevel', async () => {
    const sessionService = makeMockSessionService()
    const configService = makeMockConfigService([])
    const { broker } = makeMockBroker()

    const svc = new ModelService(modelSource)
    svc.setServices(sessionService, configService, broker)

    await svc.setThinkingLevel('s1', 'high')

    expect(sessionService.setThinkingLevel).toHaveBeenCalledWith('s1', 'high')
  })
})

// ══════════════════════════════════════════════════════════════════
// discoverModelsFromApi · 错误文案翻译（从 settings-handler 下沉）
//
// 原 transport 硬编码的 ByteString/fetch failed → 中文文案，现归 service。
// service 把 infra 抛出的原始错误分类成 ModelDiscoveryError（code + 中文 message）。
// ══════════════════════════════════════════════════════════════════

describe('ModelService · discoverModelsFromApi 错误分类（transport 下沉）', () => {
  const BASE_URL = 'http://x'

  /** 用 reject 的 modelSource 构造 service（discoverFromApi 抛 rawError）。 */
  function makeServiceWithRejectingSource(rawError: unknown): { svc: ModelService; modelSource: IModelSource } {
    const modelSource = makeMockModelSource({ discoverFromApi: vi.fn(async () => { throw rawError }) })
    const svc = new ModelService(modelSource)
    svc.setServices(makeMockSessionService(), makeMockConfigService([]), makeMockBroker().broker)
    return { svc, modelSource }
  }

  it('ByteString 错误 → ModelDiscoveryError(INVALID_AUTH_CHARS) + 中文「不支持的字符」', async () => {
    const { svc, modelSource } = makeServiceWithRejectingSource(new Error('invalid ByteString'))

    await expect(svc.discoverModelsFromApi(BASE_URL, 'k')).rejects.toMatchObject({
      name: 'ModelDiscoveryError',
      code: 'INVALID_AUTH_CHARS',
      message: '请求失败：Base URL 或 API Key 包含 HTTP 不支持的字符',
    })
    expect(modelSource.discoverFromApi).toHaveBeenCalledWith(BASE_URL, 'k', undefined)
  })

  it('fetch failed → ModelDiscoveryError(UNREACHABLE) + 中文「无法访问」(含 baseUrl)', async () => {
    const { svc } = makeServiceWithRejectingSource(new Error('fetch failed'))

    await expect(svc.discoverModelsFromApi(BASE_URL, 'k')).rejects.toMatchObject({
      name: 'ModelDiscoveryError',
      code: 'UNREACHABLE',
      message: '连接失败：无法访问 http://x/v1/models',
    })
  })

  it('其他错误 → ModelDiscoveryError(UNKNOWN) + 原始消息透传', async () => {
    const { svc } = makeServiceWithRejectingSource(new Error('rate limited'))

    await expect(svc.discoverModelsFromApi(BASE_URL, 'k')).rejects.toMatchObject({
      name: 'ModelDiscoveryError',
      code: 'UNKNOWN',
      message: 'rate limited',
    })
  })

  it('成功 → 返回 infra 的模型列表（不抛错）', async () => {
    const modelSource = makeMockModelSource({
      discoverFromApi: vi.fn(async () => [{ id: 'm1', name: 'M1' }]),
    })
    const svc = new ModelService(modelSource)
    svc.setServices(makeMockSessionService(), makeMockConfigService([]), makeMockBroker().broker)

    const models = await svc.discoverModelsFromApi(BASE_URL, 'k')
    expect(models).toEqual([{ id: 'm1', name: 'M1' }])
  })

  it('ModelDiscoveryError 是 Error 子类（code 可读）', () => {
    const err = new ModelDiscoveryError('INVALID_AUTH_CHARS' as ModelDiscoveryErrorCode, 'msg')
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('INVALID_AUTH_CHARS')
    expect(err.name).toBe('ModelDiscoveryError')
  })
})

// ══════════════════════════════════════════════════════════════════
// aggregateModels · enabled 过滤（W2 / U3）
//
// runtime enabled 读写链路的过滤端：listProviders 读出 provider/model 级 enabled，
// aggregateModels 把 enabled===false 的 provider 和 model 过滤掉，不进最终 ModelInfo 结果。
// 过滤规则：
//   - provider.enabled === false → 其下所有 model 不进结果
//   - model.enabled === false → 该 model 不进结果
//   - 缺省（undefined）/ true → 启用（向上兼容存量）
// ══════════════════════════════════════════════════════════════════
describe('ModelService.aggregateModels · enabled 过滤（W2 / U3）', () => {
  it('provider.enabled === false 时其下所有 model 被过滤掉', () => {
    const providers: ProviderInfo[] = [
      {
        id: 'p1' as ProviderId,
        name: 'P1',
        apiKeySet: true,
        status: 'connected',
        enabled: false, // provider 级禁用
        models: [
          { id: 'm1', name: 'M1' },
          { id: 'm2', name: 'M2' },
        ],
      },
      {
        id: 'p2' as ProviderId,
        name: 'P2',
        apiKeySet: true,
        status: 'connected',
        enabled: true,
        models: [{ id: 'm3', name: 'M3' }],
      },
    ]

    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), makeMockConfigService([]), makeMockBroker().broker)
    const result = svc.aggregateModels(providers)

    // p1 整体被禁用，其 m1/m2 不进结果；只留 p2/m3
    expect(result.map(m => m.id)).toEqual(['m3'])
  })

  it('model.enabled === false 时该 model 被过滤掉', () => {
    const providers: ProviderInfo[] = [
      {
        id: 'p1' as ProviderId,
        name: 'P1',
        apiKeySet: true,
        status: 'connected',
        enabled: true,
        models: [
          { id: 'm1', name: 'M1', enabled: false }, // model 级禁用
          { id: 'm2', name: 'M2', enabled: true },
        ],
      },
    ]

    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), makeMockConfigService([]), makeMockBroker().broker)
    const result = svc.aggregateModels(providers)

    // 只留 m2，m1 被 model 级 enabled=false 过滤
    expect(result.map(m => m.id)).toEqual(['m2'])
  })

  it('存量 model 无 enabled 字段时默认启用（向上兼容）', () => {
    const providers: ProviderInfo[] = [
      {
        id: 'p1' as ProviderId,
        name: 'P1',
        apiKeySet: true,
        status: 'connected',
        models: [
          { id: 'm1' }, // 无 enabled 字段（存量）
          { id: 'm2', enabled: true },
        ],
      },
    ]

    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), makeMockConfigService([]), makeMockBroker().broker)
    const result = svc.aggregateModels(providers)

    // 缺省 / true 都视为启用，全保留
    expect(result.map(m => m.id).sort()).toEqual(['m1', 'm2'])
  })

  it('U3 端到端：setProvider 写入 model 级 enabled 后 aggregateModels 过滤正确', () => {
    // 模拟 listProviders 读回的 ProviderInfo（model 级 enabled 已透传）
    const providers: ProviderInfo[] = [
      {
        id: 'p1' as ProviderId,
        name: 'P1',
        apiKeySet: true,
        status: 'connected',
        enabled: true,
        models: [
          { id: 'm1', enabled: false },
          { id: 'm2', enabled: true },
        ],
      },
    ]

    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), makeMockConfigService([]), makeMockBroker().broker)
    const result = svc.aggregateModels(providers)

    expect(result.map(m => m.id)).toEqual(['m2'])
    expect(result.find(m => m.id === 'm1')).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════
// aggregateModels · scoped models 过滤/排序（scoped-model design §4.1 A1-A4）
//
// scopedModels 非空时按白名单过滤 + 按 scopedModels 序重排（跨 provider 交错保留）；
// 解析不到模型的 scoped 条目静默跳过。enabled 过滤优先于 scoped（被禁 provider/model
// 即使在 scoped 中也不显示）。scoped 为空/缺失 → 输出与原路径完全一致（回归 A2）。
// ══════════════════════════════════════════════════════════════════

describe('A1: scoped 非空 → 只输出白名单内模型', () => {
  it('A1 只返回 scopedModels 中列出的模型', () => {
    const providers: ProviderInfo[] = [
      makeProvider('openai', 'OpenAI', ['gpt-4', 'gpt-3.5-turbo']),
      makeProvider('anthropic', 'Anthropic', ['claude-opus', 'claude-sonnet']),
    ]
    const configService = makeMockConfigService([], {
      getScopedModels: vi.fn(() => ['openai/gpt-4', 'anthropic/claude-opus']),
    })
    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), configService, makeMockBroker().broker)

    const result = svc.aggregateModels(providers)

    expect(result.map(m => `${m.providerId}/${m.id}`)).toEqual([
      'openai/gpt-4',
      'anthropic/claude-opus',
    ])
  })

  it('scoped 条目解析不到模型时静默跳过', () => {
    const providers: ProviderInfo[] = [
      makeProvider('p', 'P', ['m1']),
    ]
    const configService = makeMockConfigService([], {
      getScopedModels: vi.fn(() => ['p/m1', 'p/nonexistent']),
    })
    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), configService, makeMockBroker().broker)

    const result = svc.aggregateModels(providers)

    // nonexistent 被跳过
    expect(result.map(m => m.id)).toEqual(['m1'])
  })
})

describe('A2: scoped 为空 → 输出与现状完全一致', () => {
  it('A2 scopedModels=[] 时返回全部模型（原路径）+ 守卫分支存在（scoped 配置被读取）', () => {
    const providers: ProviderInfo[] = [
      makeProvider('openai', 'OpenAI', ['gpt-4', 'gpt-3.5-turbo']),
      makeProvider('anthropic', 'Anthropic', ['claude-opus']),
    ]
    const getScopedModels = vi.fn((): string[] => [])
    const configService = makeMockConfigService([], { getScopedModels })
    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), configService, makeMockBroker().broker)

    const result = svc.aggregateModels(providers)

    expect(result.map(m => m.id)).toEqual(['gpt-4', 'gpt-3.5-turbo', 'claude-opus'])
    // A2 区分力锚点：空列表也必须读 scoped 配置——无此守卫读取的旧实现（scoped 引入前）
    // 输出同样全量，仅靠结果断言无法区分，守卫调用是 scoped 分支存在的直接证据
    expect(getScopedModels).toHaveBeenCalledOnce()
  })
})

describe('A3: 输出序按 scopedModels 序', () => {
  it('A3 scopedModels=[B,A,C] → 输出序 B,A,C', () => {
    const providers: ProviderInfo[] = [
      makeProvider('p', 'P', ['A', 'B', 'C']),
    ]
    const configService = makeMockConfigService([], {
      getScopedModels: vi.fn(() => ['p/B', 'p/A', 'p/C']),
    })
    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), configService, makeMockBroker().broker)

    const result = svc.aggregateModels(providers)

    expect(result.map(m => m.id)).toEqual(['B', 'A', 'C'])
  })

  it('跨 provider 交错序保留', () => {
    const providers: ProviderInfo[] = [
      makeProvider('a', 'A', ['m1', 'm2']),
      makeProvider('b', 'B', ['m3', 'm4']),
    ]
    const configService = makeMockConfigService([], {
      getScopedModels: vi.fn(() => ['b/m3', 'a/m1', 'b/m4', 'a/m2']),
    })
    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), configService, makeMockBroker().broker)

    const result = svc.aggregateModels(providers)

    expect(result.map(m => `${m.providerId}/${m.id}`)).toEqual([
      'b/m3', 'a/m1', 'b/m4', 'a/m2',
    ])
  })
})

describe('A4: provider disabled 优先压过 scoped', () => {
  it('A4 provider.enabled=false 时其模型不显示（即使在 scoped 中），enabled 且在 scoped 的模型显示、enabled 但不在 scoped 的被过滤', () => {
    const providers: ProviderInfo[] = [
      makeProvider('openai', 'OpenAI', ['gpt-4'], false), // disabled
      // claude-sonnet 是 enabled 模型但不在 scoped 中——仅靠 enabled 过滤的旧实现会放行它，
      // scoped 过滤是本实现新语义（A4 区分力锚点）
      makeProvider('anthropic', 'Anthropic', ['claude-opus', 'claude-sonnet'], true),
    ]
    const configService = makeMockConfigService([], {
      getScopedModels: vi.fn(() => ['openai/gpt-4', 'anthropic/claude-opus']),
    })
    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), configService, makeMockBroker().broker)

    const result = svc.aggregateModels(providers)

    // openai 被禁用，其 gpt-4 不进结果（即使在 scoped 中）；claude-sonnet enabled 但不在 scoped，同样不进
    expect(result.map(m => m.id)).toEqual(['claude-opus'])
  })

  it('model.enabled=false 时该模型不显示（即使在 scoped 中）', () => {
    const providers: ProviderInfo[] = [
      {
        id: 'p' as ProviderId,
        name: 'P',
        apiKeySet: true,
        status: 'connected',
        enabled: true,
        models: [
          { id: 'm1', name: 'M1', enabled: false },
          { id: 'm2', name: 'M2' },
        ],
      },
    ]
    const configService = makeMockConfigService([], {
      getScopedModels: vi.fn(() => ['p/m1', 'p/m2']),
    })
    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), configService, makeMockBroker().broker)

    const result = svc.aggregateModels(providers)

    expect(result.map(m => m.id)).toEqual(['m2'])
  })
})
