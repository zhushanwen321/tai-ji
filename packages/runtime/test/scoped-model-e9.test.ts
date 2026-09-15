/**
 * scoped-model-e9.test.ts — E9 验收：aggregateModels scoped 行为锁定
 *
 * 测试 describe/test 名含 "E9" 前缀，command 引用该文件并 -t "E9"。
 * 覆盖：
 *   ① aggregateModels 在 scopedModels 非空时过滤+保序（provider 级 disabled 优先压过 scoped）
 *   ② aggregateModels 在 scopedModels 为空时输出不变（回归锁定）
 *   ③ TaijiProviderStore scopedModels 读侧独立容错（E9-4，区分力锚点：providers 域
 *      保留 + 条目级过滤，见 design §3.2 兼容性——基线树整文件 quarantine 版必挂）
 *
 * 红阶段（父 commit + patch 本测试文件）区分力说明：E9-1~3 的 aggregateModels
 * 过滤在父 commit 已存在（U1-U3 已 merge），真正在 evidence commit 才落地的行为
 * 是 scopedModels 读侧独立容错（sanitizeScopedModels）——E9-4 断言 providers 域
 * 在 scopedModels 损坏时原样保留 + 非法条目过滤，父 commit 的整文件 quarantine
 * 实现下 providers 域被清空 → E9-4 挂 → 红阶段有区分力。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelService } from '../src/services/model-service.js'
import { TaijiProviderStore } from '../src/services/provider-extras-store.js'
import type { IModelSource } from '../src/services/ports/model.js'
import type { ISessionService, IConfigService, IMessageBroker } from '../src/interfaces.js'
import type { ProviderInfo, ServerMessage, ProviderId } from '@taiji/shared'

// ── mock 工厂（复用 model-service.test.ts 模式）──────────────────

function makeMockSessionService(): ISessionService {
  return {
    switchModel: vi.fn(async () => 's1'),
    setThinkingLevel: vi.fn(async () => undefined),
    setThinkingLevelCache: vi.fn(),
    getSummary: vi.fn(() => undefined),
    getInputTokens: vi.fn((): number => 0),
    applyContextUpdate: vi.fn(),
    getUsagePercent: vi.fn((): number => 0),
  } as unknown as ISessionService
}

function makeMockConfigService(overrides: Partial<IConfigService> = {}): IConfigService {
  return {
    listProviders: vi.fn(() => []),
    setDefaultModel: vi.fn(),
    getDefaultModel: vi.fn(() => null),
    getScopedModels: vi.fn(() => []),
    ...overrides,
  } as unknown as IConfigService
}

function makeMockBroker(): IMessageBroker {
  return { broadcast: vi.fn() } as unknown as IMessageBroker
}

function makeMockModelSource(): IModelSource {
  return { discoverFromApi: vi.fn(async () => []) }
}

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

// ── R3 / E9 测试 ────────────────────────────────────────────────
// R3 为 root unit 验收 id（词边界命中外层 describe），E9 为 sm-e2e 子 unit 验收 id
//（-t "E9" 过滤内层 describe）。两层共存互不干扰。

describe('R3: aggregateModels scoped 行为锁定', () => {
describe('E9: aggregateModels scoped 行为锁定', () => {
  it('E9-1 scopedModels 非空 → 只输出白名单内模型且保序', () => {
    const providers: ProviderInfo[] = [
      makeProvider('openai', 'OpenAI', ['gpt-4', 'gpt-3.5-turbo', 'o1']),
      makeProvider('anthropic', 'Anthropic', ['claude-opus', 'claude-sonnet']),
    ]
    const configService = makeMockConfigService({
      getScopedModels: vi.fn(() => ['anthropic/claude-opus', 'openai/gpt-4', 'openai/o1']),
    })
    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), configService, makeMockBroker())

    const result = svc.aggregateModels(providers)
    const ids = result.map(m => `${m.providerId}/${m.id}`)

    // 只返回白名单内的 3 个模型，保序（跨 provider 交错）
    expect(ids).toEqual(['anthropic/claude-opus', 'openai/gpt-4', 'openai/o1'])
  })

  it('E9-2 scopedModels 非空 + provider 级 disabled → disabled provider 的模型不显示（优先于 scoped）', () => {
    const providers: ProviderInfo[] = [
      makeProvider('openai', 'OpenAI', ['gpt-4'], true),
      makeProvider('anthropic', 'Anthropic', ['claude-opus'], false), // disabled
    ]
    const configService = makeMockConfigService({
      getScopedModels: vi.fn(() => ['openai/gpt-4', 'anthropic/claude-opus']),
    })
    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), configService, makeMockBroker())

    const result = svc.aggregateModels(providers)
    const ids = result.map(m => `${m.providerId}/${m.id}`)

    // anthropic 被 disabled，即使在 scoped 中也不显示
    expect(ids).toEqual(['openai/gpt-4'])
  })

  it('E9-3 scopedModels 为空 → 输出全量不变（回归锁定）', () => {
    const providers: ProviderInfo[] = [
      makeProvider('openai', 'OpenAI', ['gpt-4', 'gpt-3.5-turbo']),
      makeProvider('anthropic', 'Anthropic', ['claude-opus']),
    ]
    const getScopedModels = vi.fn((): string[] => [])
    const configService = makeMockConfigService({ getScopedModels })
    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), configService, makeMockBroker())

    const result = svc.aggregateModels(providers)
    const ids = result.map(m => m.id)

    // 全量输出，保序
    expect(ids).toEqual(['gpt-4', 'gpt-3.5-turbo', 'claude-opus'])
    // 守卫调用：空列表也必须读 scoped 配置（区分旧实现无读取）
    expect(getScopedModels).toHaveBeenCalledOnce()
  })

  it('E9-4 providers.json scopedModels 损坏 → 独立容错：providers 域保留 + 条目级过滤（不隔离文件）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'scoped-model-e9-'))
    const file = join(dir, 'config', 'providers.json')
    mkdirSync(join(dir, 'config'), { recursive: true })
    const store = new TaijiProviderStore(file)
    try {
      // 非数组 scopedModels：getScopedModelsSync 返回 []，providers 域原样保留
      //（整文件 quarantine 实现下 providers 域被连坐清空——本断言是其区分力反例）
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: { openai: { authMethod: 'api_key' } },
        scopedModels: 'not-an-array',
      }, null, 2))
      expect(store.getScopedModelsSync()).toEqual([])
      expect(store.readAllSync()).toEqual({ openai: { authMethod: 'api_key' } })

      // 条目级容错：非 string / 非 provider/modelId 格式条目被过滤，合法条目保留
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: { openai: { authMethod: 'api_key' } },
        scopedModels: ['openai/gpt-4o', 123, 'invalid-no-slash', 'anthropic/claude-opus'],
      }, null, 2))
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-opus'])
      expect(store.readAllSync()).toEqual({ openai: { authMethod: 'api_key' } })
    } finally {
      warnSpy.mockRestore()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
}) // R3 outer describe
