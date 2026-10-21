/**
 * model-service 羊毛聚合并入单测（wool-provider D6 ③ + S9 零回归硬约束）。
 *
 * 零回归对照锚：同一 providers 输入下，①未注入羊毛源 ②注入空输出源 ③羊毛源抛异常
 * （降级路径）三者的输出与「并入前基线」逐项等价——既有来源（catalog/custom
 * providers + scopedModels 过滤）输出不变由结构保证（羊毛 infos 纯追加），本测试
 * 锚定该结构不被回归破坏。并入语义：羊毛条目复用同一管道（enabled 过滤 + scoped
 * 白名单同语义）。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/services/__tests__/model-service-wool-aggregation.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ProviderId, ProviderInfo } from '@taiji/shared'
import { ModelService } from '../model-service.js'
import type { IModelSource } from '../ports/model.js'

/** 最小 modelSource 桩（aggregateModelsWithScoped 纯变换，不触 discover 链）。 */
const stubSource: IModelSource = {
  discoverModels: async () => [],
} as unknown as IModelSource

function provider(id: string, models: Array<{ id: string; name?: string }>, extra: Partial<ProviderInfo> = {}): ProviderInfo {
  return { id: id as ProviderId, name: id, apiKeySet: true, status: 'connected', models, ...extra }
}

const BASE_PROVIDERS: ProviderInfo[] = [
  provider('openai', [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'gpt-4o-mini', name: 'GPT-4o mini' }]),
  provider('disabled-p', [{ id: 'x1' }], { enabled: false }),
]

const WOOL_INFO: ProviderInfo = {
  id: 'wool-qoder' as ProviderId,
  name: 'Qoder',
  apiKeySet: true,
  status: 'connected',
  enabled: true,
  models: [
    { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', reasoning: true },
    { id: 'qwen3.8-pro', name: 'Qwen3.8 Pro' },
  ],
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('S9 零回归对照（聚合输出对既有来源不变）', () => {
  it('未注入羊毛源 vs 注入空输出源 vs 源抛异常（降级）→ 输出逐项等价（无 scoped）', () => {
    const bare = new ModelService(stubSource)
    const emptySource = new ModelService(stubSource)
    emptySource.setWoolProviderSource({ listWoolProviderInfos: () => [] })
    const throwingSource = new ModelService(stubSource)
    throwingSource.setWoolProviderSource({ listWoolProviderInfos: () => { throw new Error('aux chain broken') } })

    const baseline = bare.aggregateModelsWithScoped(BASE_PROVIDERS, [])
    expect(emptySource.aggregateModelsWithScoped(BASE_PROVIDERS, [])).toEqual(baseline)
    expect(throwingSource.aggregateModelsWithScoped(BASE_PROVIDERS, [])).toEqual(baseline)
    // 基线本身：既有语义（enabled=false 的 provider 被滤、model 带 providerId/name）
    expect(baseline.map((m) => `${m.providerId}/${m.id}`)).toEqual(['openai/gpt-4o', 'openai/gpt-4o-mini'])
  })

  it('注入羊毛源后：既有条目前缀逐项不变 + 羊毛条目追加（scoped 语义对羊毛同效）', () => {
    const before = new ModelService(stubSource)
    const after = new ModelService(stubSource)
    after.setWoolProviderSource({ listWoolProviderInfos: () => [WOOL_INFO] })

    const baseline = before.aggregateModelsWithScoped(BASE_PROVIDERS, [])
    const merged = after.aggregateModelsWithScoped(BASE_PROVIDERS, [])
    // 既有条目前缀不变（零回归）
    expect(merged.slice(0, baseline.length)).toEqual(baseline)
    // 羊毛条目追加在后（2 模型进结果）
    expect(merged.slice(baseline.length).map((m) => `${m.providerId}/${m.id}`)).toEqual([
      'wool-qoder/qwen3.8-flash', 'wool-qoder/qwen3.8-pro',
    ])
  })

  it('scopedModels 白名单过滤对羊毛条目同语义（白名单不含羊毛 → 羊毛被滤；含则按序保留）', () => {
    const svc = new ModelService(stubSource)
    svc.setWoolProviderSource({ listWoolProviderInfos: () => [WOOL_INFO] })

    const scoped = svc.aggregateModelsWithScoped(BASE_PROVIDERS, ['openai/gpt-4o'])
    expect(scoped.map((m) => `${m.providerId}/${m.id}`)).toEqual(['openai/gpt-4o'])

    const scopedWool = svc.aggregateModelsWithScoped(BASE_PROVIDERS, ['wool-qoder/qwen3.8-flash', 'openai/gpt-4o'])
    expect(scopedWool.map((m) => `${m.providerId}/${m.id}`)).toEqual(['wool-qoder/qwen3.8-flash', 'openai/gpt-4o'])
  })

  it('羊毛源抛异常 → warn 降级不拖垮 model.list（辅助链错误分级契约）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = new ModelService(stubSource)
    svc.setWoolProviderSource({ listWoolProviderInfos: () => { throw new Error('boom') } })
    const out = svc.aggregateModelsWithScoped(BASE_PROVIDERS, [])
    expect(out).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('wool provider aggregation failed')
  })
})
