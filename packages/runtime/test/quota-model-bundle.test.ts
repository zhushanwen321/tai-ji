import { ExtensionResolver } from '../src/infra/installers/extension-resolver.js';
import { NpmGitInstaller } from '../src/infra/installers/npm-git-installer.js';
import { ModelApiDiscoverer } from '../src/infra/model-api-discoverer.js';
import { PiExtensionSettings } from '../src/infra/pi/pi-extension-settings.js';
import { setSettingsPath } from '../src/infra/pi/pi-settings-store.js';
import { IConfigService, IMessageBroker, type ISessionService } from '../src/interfaces.js';
import { ExtensionInstallError, ExtensionService } from '../src/services/extension-service.js';
import { ModelDiscoveryError, ModelService, type ModelDiscoveryErrorCode } from '../src/services/model-service.js';
import type { IModelSource } from '../src/services/ports/model.js';
import { QuotaCache } from '../src/services/quota-cache.js';
import { WireSnapshotSchemaError, normalizeWireSnapshot } from '../src/services/session/replicated-state.js';
import { createCommandsStateConfig, createModelIdStateConfig, createThinkingLevelStateConfig, createUsageStateConfig } from '../src/services/session/replicated-states.config.js';
import { ProviderInfo, ServerMessage, type NormalizedQuotaRow, type ProviderId } from '@taiji/shared';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  realReadFileSync: null as unknown,
}))


vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  fsMock.realReadFileSync = actual.readFileSync
  return { ...actual, readFileSync: fsMock.readFileSync }
})


function makeRow(label: string): NormalizedQuotaRow {
  return {
    label,
    wins: [
      { pct: 30, resetSec: 3600 },
      { pct: 50, resetSec: null },
      { pct: null, resetSec: null },
    ],
  }
}


/** 等 update 的 writeChain 完成（update 是 Promise 链，测试需等微任务落盘）。 */
async function flushWriteChain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}


/** readFileSync 累计调用次数（内存命中零磁盘读的观察口径）。 */
function readCallCount(): number {
  return fsMock.readFileSync.mock.calls.length
}


// ======================================================================
// ← test/model-api-discoverer.test.ts
// ======================================================================

/**
 * ModelApiDiscoverer 经 HTTP 探测 LLM API。fetch 在 vitest 环境无原生实现，
 * 用 vi.stubGlobal 注入可控 mock，覆盖两套 provider / URL 构造 / 响应 shape 分支。
 */
type FetchCall = { url: string; headers: Record<string, string> }


function mockFetchJson(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  const ok = init?.ok ?? true
  const status = init?.status ?? 200
  return vi.fn(async (url: string | URL | Request, opts?: RequestInit) => {
    calls.push({ url: String(url), headers: (opts?.headers ?? {}) as Record<string, string> })
    return {
      ok,
      status,
      statusText: init?.statusText ?? '',
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response
  })
}


// calls 必须在每次 mockFetchJson 重建前重置（beforeEach 里清）
let calls: FetchCall[] = []


function stubFetch(fn: ReturnType<typeof mockFetchJson>) {
  vi.stubGlobal('fetch', fn)
}


// ======================================================================
// ← test/model-service.test.ts
// ======================================================================

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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('quota-model-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('quota-cache-memory', () => {
describe('QuotaCache 内存层（W26 微项 11）', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'quota-mem-'))
    // 计数口径：清跨用例残留 calls，实现委托真实 fs
    fsMock.readFileSync.mockClear()
    fsMock.readFileSync.mockImplementation(fsMock.realReadFileSync as typeof import('node:fs')['readFileSync'])
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('重复查询同一 provider 命中内存层：仅首次读磁盘，二次起零磁盘读', async () => {
    const cache = new QuotaCache(dataDir)
    cache.update('p1', makeRow('provider-1'))
    await flushWriteChain()

    const first = cache.getEntry('p1')
    const callsAfterFirst = readCallCount()
    // update 已同步内存镜像（doUpdate 写盘后 memoryCache=cache）→ getEntry 命中内存，零磁盘读
    expect(callsAfterFirst).toBe(0)
    expect(first?.data.label).toBe('provider-1')

    // 二次起：命中内存，零磁盘读
    const second = cache.getEntry('p1')
    expect(readCallCount()).toBe(callsAfterFirst)
    expect(second).toEqual(first)
  })

  it('update 后内存同步：getEntry 立即返回新数据且不再读磁盘', async () => {
    const cache = new QuotaCache(dataDir)
    cache.update('p1', makeRow('v1'))
    await flushWriteChain()
    cache.getEntry('p1') // 加载内存镜像

    cache.update('p1', makeRow('v2'))
    await flushWriteChain()
    const callsAfterUpdate = readCallCount()

    const got = cache.getEntry('p1')
    expect(got?.data.label).toBe('v2')
    // getEntry 命中内存，update 之后的查询零新增磁盘读
    expect(readCallCount()).toBe(callsAfterUpdate)
  })

  it('多 provider 互不干扰：各 provider 独立命中内存', async () => {
    const cache = new QuotaCache(dataDir)
    cache.update('p1', makeRow('one'))
    cache.update('p2', makeRow('two'))
    await flushWriteChain()

    expect(cache.getEntry('p1')?.data.label).toBe('one')
    expect(cache.getEntry('p2')?.data.label).toBe('two')
    expect(cache.getEntry('p1')?.data.label).toBe('one')
    // 仅 update p2 的 doUpdate 读盘一次（p1 首次写盘时文件不存在）；三次 getEntry 全命中内存
    expect(readCallCount()).toBe(1)
  })

  it('磁盘持久化语义不变：update 后文件落盘且内容可读（跨实例重载可见）', async () => {
    const cache = new QuotaCache(dataDir)
    cache.update('p1', makeRow('persisted'))
    await flushWriteChain()

    const filePath = join(dataDir, 'quota-cache.json')
    expect(existsSync(filePath)).toBe(true)
    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(onDisk.providers.p1.data.label).toBe('persisted')

    // 新实例（模拟重启）从磁盘加载
    const fresh = new QuotaCache(dataDir)
    expect(fresh.getEntry('p1')?.data.label).toBe('persisted')
  })

  it('无缓存的 provider 返回 null（内存 miss，不抛）', async () => {
    const cache = new QuotaCache(dataDir)
    cache.update('p1', makeRow('one'))
    await flushWriteChain()
    cache.getEntry('p1') // 加载内存
    expect(cache.getEntry('no-such-provider')).toBeNull()
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('model-api-discoverer', () => {
beforeEach(() => {
  calls = []
  vi.unstubAllGlobals()
})
describe('ModelApiDiscoverer.discoverFromApi', () => {
  it('openai-compatible: appends /v1/models when base lacks /v1', async () => {
    stubFetch(mockFetchJson({ data: [{ id: 'gpt-4', name: 'GPT-4' }] }))
    const models = await new ModelApiDiscoverer().discoverFromApi('https://api.openai.com', 'sk-x')
    expect(calls[0].url).toBe('https://api.openai.com/v1/models')
    expect(calls[0].headers['Authorization']).toBe('Bearer sk-x')
    expect(models).toEqual([{ id: 'gpt-4', name: 'GPT-4' }])
  })

  it('openai-compatible: uses /models when base already ends with /v1', async () => {
    stubFetch(mockFetchJson({ data: [{ id: 'm1' }] }))
    await new ModelApiDiscoverer().discoverFromApi('https://host/v1', 'sk-x')
    expect(calls[0].url).toBe('https://host/v1/models')
  })

  it('openai-compatible: strips trailing slashes before joining', async () => {
    stubFetch(mockFetchJson({ data: [] }))
    await new ModelApiDiscoverer().discoverFromApi('https://host///', undefined)
    expect(calls[0].url).toBe('https://host/v1/models')
    // no apiKey → no Authorization header
    expect(calls[0].headers['Authorization']).toBeUndefined()
  })

  it('anthropic: builds /v1/models with x-api-key + anthropic-version', async () => {
    stubFetch(mockFetchJson({ data: [{ id: 'claude-3' }] }))
    const models = await new ModelApiDiscoverer().discoverFromApi(
      'https://api.anthropic.com',
      'ant-key',
      'anthropic',
    )
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/models')
    expect(calls[0].headers['x-api-key']).toBe('ant-key')
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(calls[0].headers['Authorization']).toBeUndefined()
    expect(models[0].id).toBe('claude-3')
  })

  it('throws when API responds non-2xx', async () => {
    stubFetch(mockFetchJson('upstream error', { ok: false, status: 503, statusText: 'Unavailable' }))
    await expect(new ModelApiDiscoverer().discoverFromApi('https://host', 'k')).rejects.toThrow(/503/)
  })

  it('parses { models: [...] } response shape', async () => {
    stubFetch(mockFetchJson({ models: [{ id: 'llama', name: 'Llama' }] }))
    const models = await new ModelApiDiscoverer().discoverFromApi('https://host/v1', 'k')
    expect(models).toEqual([{ id: 'llama', name: 'Llama' }])
  })

  it('returns [] when response has neither data nor models array', async () => {
    stubFetch(mockFetchJson({ foo: 'bar' }))
    const models = await new ModelApiDiscoverer().discoverFromApi('https://host/v1', 'k')
    expect(models).toEqual([])
  })

  it('filters out entries whose id is not a string', async () => {
    stubFetch(mockFetchJson({ data: [{ id: 'valid' }, { id: 123 }, { name: 'no-id' }] }))
    const models = await new ModelApiDiscoverer().discoverFromApi('https://host/v1', 'k')
    expect(models).toHaveLength(1)
    expect(models[0].id).toBe('valid')
  })

  it('falls back to id when name is absent', async () => {
    stubFetch(mockFetchJson({ data: [{ id: 'only-id' }] }))
    const models = await new ModelApiDiscoverer().discoverFromApi('https://host/v1', 'k')
    expect(models[0].name).toBe('only-id')
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('model-service', () => {
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

  it('其他错误 → ModelDiscoveryError(UNKNOWN) + 「发现失败：」前缀（原始消息保真）', async () => {
    const { svc } = makeServiceWithRejectingSource(new Error('rate limited'))

    await expect(svc.discoverModelsFromApi(BASE_URL, 'k')).rejects.toMatchObject({
      name: 'ModelDiscoveryError',
      code: 'UNKNOWN',
      // RT-7#9：UNKNOWN 分支加中文前缀（原始英文技术串不直传 UI），raw 原样拼在后
      message: '发现失败：rate limited',
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
  it('A2 scopedModels=[] 时返回全部模型（原路径）+ 检查分支存在（scoped 配置被读取）', () => {
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
    // A2 区分力锚点：空列表也必须读 scoped 配置——无此检查读取的旧实现（scoped 引入前）
    // 输出同样全量，仅靠结果断言无法区分，检查调用是 scoped 分支存在的直接证据
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
});
// ======================================================================
// ← test/replicated-states-config.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('replicated-states-config', () => {
describe('projectSessionScalars（get_state wire 派生视图，经 thinkingLevel/modelId 条目）', () => {
  const cfg = (state: unknown) =>
    createThinkingLevelStateConfig(() => Promise.resolve(state as Record<string, unknown> | undefined))

  it('state 非对象（undefined / null / string / number）→ 抛 WireSnapshotSchemaError（协议异常→退避）', async () => {
    for (const bad of [undefined, null, 'oops', 42]) {
      await expect(cfg(bad).fetchSnapshot()).rejects.toBeInstanceOf(WireSnapshotSchemaError)
    }
  })

  it('thinkingLevel 非 string → 丢 key → fetchSnapshot 空快照 + required 归一层抛协议异常', async () => {
    // fetchSnapshot 层职责：类型畸形丢 key（wire 归一前的派生视图，不做语义决策）
    await expect(cfg({ thinkingLevel: 7 }).fetchSnapshot()).resolves.toEqual({})
    await expect(cfg({}).fetchSnapshot()).resolves.toEqual({})
    // required 归一层职责：key 缺失 = 协议异常（ReplicatedState 按快照失败退避，不当字段不动）
    expect(() => normalizeWireSnapshot({}, { thinkingLevel: 'required' })).toThrow(WireSnapshotSchemaError)
  })

  it('thinkingLevel 合法 string → 快照透传', async () => {
    await expect(cfg({ thinkingLevel: 'high' }).fetchSnapshot()).resolves.toEqual({ thinkingLevel: 'high' })
  })
})
describe('projectSessionScalars：model 组合派生视图（modelId 条目）', () => {
  const cfg = (state: unknown) =>
    createModelIdStateConfig(() => Promise.resolve(state as Record<string, unknown> | undefined))

  it('model 对象 provider/id 均非空 string → 组合 provider/id', async () => {
    await expect(cfg({ model: { provider: 'test-provider', id: 'mimo' } }).fetchSnapshot())
      .resolves.toEqual({ modelId: 'test-provider/mimo' })
  })

  it('model 缺失 / 非对象 / 字段畸形 / 空串 → 不产 modelId（碎片不落 wire）+ required 归一层抛', async () => {
    for (const bad of [
      {}, // 无 model
      { model: 'not-object' },
      { model: null },
      { model: { provider: '', id: 'mimo' } }, // provider 空串：碎片 '/mimo' 不落 wire
      { model: { provider: 'p', id: '' } },
      { model: { provider: 1, id: 'mimo' } },
    ]) {
      await expect(cfg(bad).fetchSnapshot()).resolves.toEqual({})
    }
    expect(() => normalizeWireSnapshot({}, { modelId: 'required' })).toThrow(WireSnapshotSchemaError)
  })
})
describe('usage fetchSnapshot（get_session_stats contextUsage 派生视图）', () => {
  const cfg = (stats: unknown) =>
    createUsageStateConfig(() => Promise.resolve(stats as Record<string, unknown> | undefined))

  it('stats 非对象 / contextUsage 缺失或非对象 → 抛 WireSnapshotSchemaError（协议异常）', async () => {
    for (const bad of [undefined, null, 'x', { contextUsage: null }, { contextUsage: 'gone' }]) {
      await expect(cfg(bad).fetchSnapshot()).rejects.toBeInstanceOf(WireSnapshotSchemaError)
    }
  })

  it('tokens 非 number（null = pi compact 后无新 turn）→ 空快照 {}（合法无值，merge 保持旧值）', async () => {
    await expect(cfg({ contextUsage: { tokens: null } }).fetchSnapshot()).resolves.toEqual({})
    await expect(cfg({ contextUsage: {} }).fetchSnapshot()).resolves.toEqual({})
  })

  it('正常派生视图：tokens / contextWindow / percent 三字段（percent 无值 = 字段缺省，不折 0）', async () => {
    await expect(cfg({ contextUsage: { tokens: 1000, contextWindow: 10000, percent: 10 } }).fetchSnapshot())
      .resolves.toEqual({ inputTokens: 1000, contextLimit: 10000, usagePercent: 10 })
    // [R2-b23-2] 无值缺省（RT-4#7 纪律）：null 不折成合法 0% 假信号
    await expect(cfg({ contextUsage: { tokens: 500, contextWindow: 8000 } }).fetchSnapshot())
      .resolves.toEqual({ inputTokens: 500, contextLimit: 8000 })
  })

  it('percent 越界 clamp 100；contextWindow 非 number → 0（派生视图口径对齐 fetchContext）', async () => {
    await expect(cfg({ contextUsage: { tokens: 100, contextWindow: 200, percent: 250 } }).fetchSnapshot())
      .resolves.toEqual({ inputTokens: 100, contextLimit: 200, usagePercent: 100 })
    await expect(cfg({ contextUsage: { tokens: 100, contextWindow: 'big', percent: 3.6 } }).fetchSnapshot())
      .resolves.toEqual({ inputTokens: 100, contextLimit: 0, usagePercent: 4 })
  })
})
describe('commands fetchSnapshot（get_commands 数组包装）', () => {
  const cfg = (result: unknown) => createCommandsStateConfig(() => Promise.resolve(result))

  it('非数组返回（null / object / string）→ 抛 WireSnapshotSchemaError', async () => {
    for (const bad of [null, { commands: [] }, 'x']) {
      await expect(cfg(bad).fetchSnapshot()).rejects.toBeInstanceOf(WireSnapshotSchemaError)
    }
  })

  it('数组（含空数组）→ 包装 { commands }（空数组是合法态，整字段覆盖语义）', async () => {
    await expect(cfg([]).fetchSnapshot()).resolves.toEqual({ commands: [] })
    await expect(cfg([{ name: 'a' }, { name: 'b' }]).fetchSnapshot())
      .resolves.toEqual({ commands: [{ name: 'a' }, { name: 'b' }] })
  })
})
});
});

// ======================================================================
// ← extension-upgrade.test.ts
// ======================================================================

// Mock npm-installer functions
vi.mock('../src/infra/installers/npm-installer.js', () => ({
  installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
  installDependencies: vi.fn(),
  fetchLatestVersion: vi.fn(),
  NpmInstallError: class extends Error {
    code: 'not_found' | 'network' | 'extract' | 'integrity'
    constructor(code: 'not_found' | 'network' | 'extract' | 'integrity', message: string) {
      super(message)
      this.code = code
      this.name = 'NpmInstallError'
    }
  },
}))


// Mock child_process for git
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}))


/**
 * Phase 1 路径迁移适配：extensions/npm/tmp 已从 settingsDir 子树迁出到 dataDir 根层，
 * ExtensionService/ExtensionResolver 不再 join(settingsDir, ...)。此工厂把三个目录注入回
 * testSettingsDir 子目录，让现有 fixture（settingsDir/npm、settingsDir/extensions、settingsDir/tmp）继续生效。
 * 只需传 installer 和 extensionSettings（各测试差异点），路径注入统一在此收尾。
 */
function createExtensionService(
  testSettingsDir: string,
  installer: NpmGitInstaller,
  extensionSettings: PiExtensionSettings,
): ExtensionService {
  return new ExtensionService({
    settingsDir: testSettingsDir,
    projectRoot: process.cwd(),
    installer,
    resolver: new ExtensionResolver({
      settingsDir: testSettingsDir,
      thirdPartyDir: join(testSettingsDir, 'extensions'),
      npmDir: join(testSettingsDir, 'npm'),
    }),
    extensionSettings,
    extensionsDir: join(testSettingsDir, 'extensions'),
    npmDir: join(testSettingsDir, 'npm'),
    tmpDir: join(testSettingsDir, 'tmp'),
  })
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('extension-upgrade', () => {
describe('Extension Upgrade', () => {
  let testSettingsDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    testSettingsDir = mkdtempSync(join(tmpdir(), 'ext-upgrade-test-'))
    // RT-3#12：PiExtensionSettings 构造不再对齐全局 settings 路径（去全局化），
    // 测试显式注入 setSettingsPath 指向 testSettingsDir（全仓测试惯例）。
    setSettingsPath(join(testSettingsDir, 'settings.json'))

    // Create settings.json with a user-installed extension
    writeFileSync(join(testSettingsDir, 'settings.json'), JSON.stringify({
      packages: ['npm:pi-test-ext'],
    }), 'utf-8')

    // Create the installed extension with version 1.0.0
    const extDir = join(testSettingsDir, 'npm', 'node_modules', 'pi-test-ext')
    mkdirSync(extDir, { recursive: true })
    writeFileSync(join(extDir, 'package.json'), JSON.stringify({
      name: 'pi-test-ext',
      version: '1.0.0',
      description: 'Test extension',
      keywords: ['pi-package'],
      peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
    }), 'utf-8')
    writeFileSync(join(extDir, 'index.ts'), '', 'utf-8')

    // npm dir package.json
    writeFileSync(join(testSettingsDir, 'npm', 'package.json'), JSON.stringify({ private: true }), 'utf-8')
  })

  afterEach(() => {
    try { rmSync(testSettingsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
  })

  // ── 1. IExtensionSettings: autoUpgrade 持久化 ─────────────────

  describe('IExtensionSettings: autoUpgrade', () => {
    it('getAutoUpgrade returns empty array when no auto-upgrade config exists', () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      const autoUpgrades = settings.getAutoUpgrade()
      expect(autoUpgrades).toEqual([])
    })

    it('setAutoUpgrade persists auto-upgrade setting to auto-upgrade-packages.json', async () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      // Verify file was written
      const filePath = join(testSettingsDir, 'auto-upgrade-packages.json')
      expect(existsSync(filePath)).toBe(true)

      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(data.autoUpgrade).toContain('npm:pi-test-ext')

      // Verify getAutoUpgrade reads it back
      expect(settings.getAutoUpgrade()).toContain('npm:pi-test-ext')
    })

    it('setAutoUpgrade(false) removes from auto-upgrade list', async () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)
      await settings.setAutoUpgrade('npm:pi-test-ext', false)

      expect(settings.getAutoUpgrade()).not.toContain('npm:pi-test-ext')
    })

    it('setAutoUpgrade is idempotent for same source', async () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      const filePath = join(testSettingsDir, 'auto-upgrade-packages.json')
      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      // Should only appear once
      const count = data.autoUpgrade.filter((s: string) => s === 'npm:pi-test-ext').length
      expect(count).toBe(1)
    })
  })

  // ── 2. IInstaller: getLatestVersion ────────────────────────────

  describe('IInstaller.getLatestVersion', () => {
    it('getLatestVersion returns latest version string from npm registry', async () => {
      const { fetchLatestVersion } = await import('../src/infra/installers/npm-installer.js')
      const mockedFetch = vi.mocked(fetchLatestVersion)
      mockedFetch.mockResolvedValue('2.0.0')

      const installer = new NpmGitInstaller()
      const result = await installer.getLatestVersion('pi-test-ext')
      expect(result).toBe('2.0.0')
    })

    it('getLatestVersion throws NpmInstallError for non-existent package', async () => {
      const { fetchLatestVersion, NpmInstallError } = await import('../src/infra/installers/npm-installer.js')
      const mockedFetch = vi.mocked(fetchLatestVersion)
      mockedFetch.mockRejectedValue(new NpmInstallError('not_found', 'Package not found'))

      const installer = new NpmGitInstaller()
      await expect(installer.getLatestVersion('nonexistent-pkg-foo-12345'))
        .rejects.toMatchObject({ code: 'not_found' })
    })
  })

  // ── 3. ExtensionService.upgradeExtension ──────────────────────

  describe('ExtensionService.upgradeExtension', () => {
    it('upgrades extension when latest version is newer', async () => {
      const { installPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedInstall = vi.mocked(installPackage)

      // Mock installPackage to update the installed version
      mockedInstall.mockImplementation(async (_spec, nodeModulesDir) => {
        const pkgDir = join(nodeModulesDir, 'pi-test-ext')
        mkdirSync(pkgDir, { recursive: true })
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
          name: 'pi-test-ext',
          version: '2.0.0',
          description: 'Test extension upgraded',
          keywords: ['pi-package'],
          peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
        }), 'utf-8')
        writeFileSync(join(pkgDir, 'index.ts'), '', 'utf-8')
      })

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      const result = await service.upgradeExtension('pi-test-ext')
      expect(result).toEqual({ upgraded: true, from: '1.0.0', to: '2.0.0' })
    })

    it('returns upgraded=false when already at latest version', async () => {
      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('1.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      const result = await service.upgradeExtension('pi-test-ext')
      expect(result).toEqual({ upgraded: false, from: '1.0.0', to: '1.0.0' })
    })

    it('throws for non-user-installed (built-in) extensions', async () => {
      // Create a built-in extension in the thirdPartyDir (extensions/)
      // so the resolver can find it, but it's NOT in settings packages[]
      const extDir = join(testSettingsDir, 'extensions', 'pi-builtin-ext')
      mkdirSync(extDir, { recursive: true })
      writeFileSync(join(extDir, 'package.json'), JSON.stringify({
        name: 'pi-builtin-ext',
        version: '1.0.0',
        description: 'Built-in extension',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')
      writeFileSync(join(extDir, 'index.ts'), '', 'utf-8')

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      await expect(service.upgradeExtension('pi-builtin-ext'))
        .rejects.toThrow('Built-in extensions cannot be upgraded')
    })

    it('throws for non-existent extension', async () => {
      const installer = new NpmGitInstaller()

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      await expect(service.upgradeExtension('nonexistent-ext'))
        .rejects.toThrow('Extension not installed')
    })

    it('rolls back and throws not_extension when upgraded package is invalid (U6)', async () => {
      const { installPackage, uninstallPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedInstall = vi.mocked(installPackage)
      const mockedUninstall = vi.mocked(uninstallPackage)

      // Mock installPackage to write an INVALID extension (no pi manifest fields)
      mockedInstall.mockImplementation(async (_spec, nodeModulesDir) => {
        const pkgDir = join(nodeModulesDir, 'pi-test-ext')
        mkdirSync(pkgDir, { recursive: true })
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
          name: 'pi-test-ext',
          version: '2.0.0',
          // Missing keywords/peerDependencies — not a valid pi extension
        }), 'utf-8')
      })

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      await expect(service.upgradeExtension('pi-test-ext'))
        .rejects.toSatisfy((err: unknown) => {
          return err instanceof ExtensionInstallError && err.code === 'not_extension'
        })
      // Rollback uninstall should have been called
      expect(mockedUninstall).toHaveBeenCalledWith('pi-test-ext', expect.any(String))
    })

    it('classifies installNpm network error and does not rollback (U7)', async () => {
      const { NpmInstallError } = await import('../src/infra/installers/npm-installer.js')
      const { installPackage, uninstallPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedInstall = vi.mocked(installPackage)
      const mockedUninstall = vi.mocked(uninstallPackage)

      mockedInstall.mockRejectedValue(new NpmInstallError('network', 'ETIMEDOUT'))

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      await expect(service.upgradeExtension('pi-test-ext'))
        .rejects.toSatisfy((err: unknown) => {
          return err instanceof ExtensionInstallError && err.code === 'network'
        })
      // Network failure before install completes — no rollback
      expect(mockedUninstall).not.toHaveBeenCalled()
    })
  })

  // ── 4. ExtensionService.checkAndAutoUpgrade ───────────────────

  describe('ExtensionService.checkAndAutoUpgrade', () => {
    it('upgrades extensions with autoUpgrade enabled', async () => {
      const { installPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedInstall = vi.mocked(installPackage)

      // Enable auto-upgrade for pi-test-ext
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      // Mock installPackage to update version
      mockedInstall.mockImplementation(async (_spec, nodeModulesDir) => {
        const pkgDir = join(nodeModulesDir, 'pi-test-ext')
        mkdirSync(pkgDir, { recursive: true })
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
          name: 'pi-test-ext',
          version: '2.0.0',
          description: 'Auto-upgraded',
          keywords: ['pi-package'],
          peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
        }), 'utf-8')
        writeFileSync(join(pkgDir, 'index.ts'), '', 'utf-8')
      })

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, settings)

      const results = await service.checkAndAutoUpgrade()
      expect(results).toHaveLength(1)
      expect(results[0]).toEqual({ name: 'pi-test-ext', upgraded: true, from: '1.0.0', to: '2.0.0' })
    })

    it('skips extensions without autoUpgrade enabled', async () => {
      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      const results = await service.checkAndAutoUpgrade()
      expect(results).toHaveLength(0)
    })

    it('does not block startup on upgrade failure', async () => {
      const { installPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedInstall = vi.mocked(installPackage)

      // Enable auto-upgrade
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      // Mock installPackage to throw
      mockedInstall.mockRejectedValue(new Error('Network error'))

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, settings)

      // Should not throw — failures are collected, not propagated
      const results = await service.checkAndAutoUpgrade()
      expect(results).toHaveLength(1)
      expect(results[0].upgraded).toBe(false)
      expect(results[0].error).toBeDefined()
    })

    it('skips built-in extensions even if somehow in autoUpgrade list', async () => {
      // Create a built-in extension
      const builtinDir = join(testSettingsDir, 'npm', 'node_modules', 'pi-builtin-ext')
      mkdirSync(builtinDir, { recursive: true })
      writeFileSync(join(builtinDir, 'package.json'), JSON.stringify({
        name: 'pi-builtin-ext',
        version: '1.0.0',
        description: 'Built-in',
        keywords: ['pi-package'],
      }), 'utf-8')

      // Manually write auto-upgrade file with built-in extension
      writeFileSync(join(testSettingsDir, 'auto-upgrade-packages.json'), JSON.stringify({
        autoUpgrade: ['npm:pi-builtin-ext', 'npm:pi-test-ext'],
      }), 'utf-8')

      const installer = new NpmGitInstaller()
      const spy = vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      const results = await service.checkAndAutoUpgrade()
      // Should only check pi-test-ext (user-installed), not pi-builtin-ext
      expect(spy).not.toHaveBeenCalledWith('pi-builtin-ext')
    })
  })

  // ── 5. Protocol messages ─────────────────────────────────────
  // 此前三个用 `typeof T extends {...}` 的编译期恒真断言（删掉 shared 字段仍全绿），
  // 替换为运行时行为校验：handler 的 handles 清单实际认领了这两个消息类型。

  describe('Protocol: extension.upgrade / extension.setAutoUpgrade routing', () => {
    it('ExtensionMessageHandler.handles 认领 extension.upgrade', async () => {
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      const handler = new ExtensionMessageHandler({} as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
      expect(handler.handles).toContain('extension.upgrade')
    })

    it('ExtensionMessageHandler.handles 认领 extension.setAutoUpgrade', async () => {
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      const handler = new ExtensionMessageHandler({} as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
      expect(handler.handles).toContain('extension.setAutoUpgrade')
    })
  })

  // ── 6. ExtensionMessageHandler ────────────────────────────────
  // 此前两个测试只断言 `typeof ExtensionMessageHandler === 'function'`，无 handler 逻辑覆盖。
  // 替换为真正的 handler 调用测试（参考 workspace-message-handler.test.ts 的 mock ctx 写法）。

  describe('ExtensionMessageHandler: upgrade messages', () => {
    /**
     * 构造 mock ctx + 捕获 reply/sendError。
     * 与 workspace-message-handler.test.ts 同构：reply 走 cap.replies，sendError 走 cap.errors。
     */
    function createMockCtx(overrides?: {
      extensionService?: Partial<Record<string, unknown>> | null
    }) {
      const cap = {
        replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }>,
        errors: [] as Array<{ id: string | undefined; code: string; message: string; details?: unknown }>,
        broadcasts: [] as Array<{ type: string; payload: Record<string, unknown> }>,
      }
      const extensionService = overrides?.extensionService === null
        ? undefined
        : {
            scanExtensions: vi.fn().mockResolvedValue([{ name: 'pi-test-ext', version: '2.0.0' }]),
            upgradeExtension: vi.fn(),
            setAutoUpgrade: vi.fn().mockResolvedValue(undefined),
            ...overrides?.extensionService,
          }
      const ctx = {
        send: vi.fn(),
        sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string, details?: unknown) => {
          cap.errors.push({ id, code, message, details })
        }),
        reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
          cap.replies.push({ id, type, payload })
        }),
        broadcast: vi.fn((msg: { type: string; payload: Record<string, unknown> }) => {
          cap.broadcasts.push({ type: msg.type, payload: msg.payload })
        }),
        nextPushId: vi.fn().mockReturnValue('push_1'),
        sessionService: { getRpcClient: vi.fn().mockReturnValue(undefined) },
        extensionService,
        extensionTimeoutMgr: { removeRequest: vi.fn() },
      }
      return { ctx, cap }
    }

    const WS = {} as never

    it('extension.upgrade → upgradeExtension 成功后 reply config.extensions 含 upgradeResult', async () => {
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      const { ctx, cap } = createMockCtx({
        extensionService: {
          upgradeExtension: vi.fn().mockResolvedValue({ upgraded: true, from: '1.0.0', to: '2.0.0' }),
        },
      })
      const handler = new ExtensionMessageHandler(ctx as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
      const msg = { type: 'extension.upgrade', id: 'req1', payload: { name: 'pi-test-ext' } } as unknown as import('@taiji/shared').ClientMessage

      await handler.handleExtensionMessage(msg, WS)

      expect(ctx.extensionService!.upgradeExtension).toHaveBeenCalledWith('pi-test-ext')
      expect(cap.replies).toHaveLength(1)
      expect(cap.replies[0]).toMatchObject({ id: 'req1', type: 'config.extensions' })
      expect(cap.replies[0].payload.upgradeResult).toEqual({ upgraded: true, from: '1.0.0', to: '2.0.0' })
    })

    it('extension.upgrade 空 name → reply invalid_payload 错误，不调 upgradeExtension', async () => {
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      const { ctx, cap } = createMockCtx()
      const handler = new ExtensionMessageHandler(ctx as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
      const msg = { type: 'extension.upgrade', id: 'req2', payload: { name: '' } } as unknown as import('@taiji/shared').ClientMessage

      await handler.handleExtensionMessage(msg, WS)

      expect(ctx.extensionService!.upgradeExtension).not.toHaveBeenCalled()
      expect(cap.replies).toHaveLength(0)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'req2', code: 'invalid_payload' })
    })

    it('extension.upgrade 底层抛 ExtensionInstallError → 走 sendInstallError 透传 code/hint', async () => {
      const { ExtensionInstallError } = await import('../src/services/extension-service.js')
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      const { ctx, cap } = createMockCtx({
        extensionService: {
          upgradeExtension: vi.fn().mockRejectedValue(
            new ExtensionInstallError('network', 'npm install failed: ETIMEDOUT', 'check network'),
          ),
        },
      })
      const handler = new ExtensionMessageHandler(ctx as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
      const msg = { type: 'extension.upgrade', id: 'req3', payload: { name: 'pi-test-ext' } } as unknown as import('@taiji/shared').ClientMessage

      await handler.handleExtensionMessage(msg, WS)

      // 匹配 ExtensionInstallError 分支：code/message 透传，hint 进 details
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'req3', code: 'network', message: 'npm install failed: ETIMEDOUT' })
      expect(cap.errors[0].details).toMatchObject({ hint: 'check network' })
      // 失败路径不 reply config.extensions
      expect(cap.replies).toHaveLength(0)
    })

    it('extension.setAutoUpgrade → setAutoUpgrade 成功后 reply config.extensions', async () => {
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      const { ctx, cap } = createMockCtx()
      const handler = new ExtensionMessageHandler(ctx as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
      const msg = { type: 'extension.setAutoUpgrade', id: 'req4', payload: { name: 'pi-test-ext', autoUpgrade: true } } as unknown as import('@taiji/shared').ClientMessage

      await handler.handleExtensionMessage(msg, WS)

      expect(ctx.extensionService!.setAutoUpgrade).toHaveBeenCalledWith('pi-test-ext', true)
      expect(cap.replies).toHaveLength(1)
      expect(cap.replies[0]).toMatchObject({ id: 'req4', type: 'config.extensions' })
      // setAutoUpgrade 不带 upgradeResult
      expect(cap.replies[0].payload.upgradeResult).toBeUndefined()
    })
  })

  // ── 7. uninstallExtension 清理 autoUpgrade ───────────────────

  describe('ExtensionService.uninstallExtension: autoUpgrade cleanup', () => {
    it('removes extension from autoUpgrade list on uninstall (U15)', async () => {
      const { uninstallPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedUninstall = vi.mocked(uninstallPackage)

      // Enable auto-upgrade for pi-test-ext first
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)
      expect(settings.getAutoUpgrade()).toContain('npm:pi-test-ext')

      mockedUninstall.mockResolvedValue(undefined)

      const installer = new NpmGitInstaller()
      const service = createExtensionService(testSettingsDir, installer, settings)

      await service.uninstallExtension('pi-test-ext')
      // autoUpgrade list should now be empty after uninstall
      expect(settings.getAutoUpgrade()).not.toContain('npm:pi-test-ext')
    })

    it('uninstall extension not in autoUpgrade list is a no-op (U15b)', async () => {
      const { uninstallPackage } = await import('../src/infra/installers/npm-installer.js')
      vi.mocked(uninstallPackage).mockResolvedValue(undefined)

      const settings = new PiExtensionSettings(testSettingsDir)
      // pi-test-ext not in autoUpgrade list (we never added it)
      expect(settings.getAutoUpgrade()).toEqual([])

      const installer = new NpmGitInstaller()
      const service = createExtensionService(testSettingsDir, installer, settings)

      // Should not throw even though extension not in autoUpgrade list
      await expect(service.uninstallExtension('pi-test-ext')).resolves.toBeUndefined()
    })
  })

  // ── 8. scanExtensions autoUpgrade 字段 ────────────────────────

  describe('ExtensionService.scanExtensions: autoUpgrade field', () => {
    it('sets autoUpgrade=true for extensions in autoUpgrade list (U16)', async () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      const installer = new NpmGitInstaller()
      const service = createExtensionService(testSettingsDir, installer, settings)

      const extensions = await service.scanExtensions()
      const ext = extensions.find(e => e.name === 'pi-test-ext')
      expect(ext).toBeDefined()
      expect(ext!.autoUpgrade).toBe(true)
    })

    it('sets autoUpgrade=false for extensions not in autoUpgrade list (U16)', async () => {
      const installer = new NpmGitInstaller()
      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      const extensions = await service.scanExtensions()
      const ext = extensions.find(e => e.name === 'pi-test-ext')
      expect(ext).toBeDefined()
      expect(ext!.autoUpgrade).toBe(false)
    })
  })
})
});
