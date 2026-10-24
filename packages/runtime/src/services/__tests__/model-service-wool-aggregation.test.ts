/**
 * model-service 羊毛聚合特例移除断言（provider-plugin-access D6：目录收敛进 models.json）。
 *
 * 退役不变量（负向守护 + 直读形态锚定）：羊毛 model.list 聚合特例（woolProviderSource
 * 并入 + safeWoolInfos 降级链）已删除——羊毛条目自身持久在 config.providers（providerId
 * 即 wool-<family>），与既有来源同管道零特例；「config.providers ⊕ 目录缓存两源不一致
 * → 0 模型」的病由单一权威源根治。守护面：
 * ① setWoolProviderSource 注入点已不存在（特例回潮即编译红 + 本文件结构断言红）；
 * ② 羊毛条目按普通 provider 直读语义聚合（enabled 过滤 + scoped 白名单同语义）；
 * ③ 聚合输出纯由 providers 输入决定（无隐藏第二源）。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/services/__tests__/model-service-wool-aggregation.test.ts
 */
import { describe, it, expect } from 'vitest'
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

/** 羊毛条目的插件化终态形态：持久在 config.providers 的普通 ProviderInfo（D6 单一权威源）。 */
const WOOL_ENTRY_IN_CONFIG: ProviderInfo = {
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

const PROVIDERS: ProviderInfo[] = [
  provider('openai', [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'gpt-4o-mini', name: 'GPT-4o mini' }]),
  WOOL_ENTRY_IN_CONFIG,
  provider('disabled-p', [{ id: 'x1' }], { enabled: false }),
]

describe('羊毛聚合特例移除后：config.providers 直读形态（provider-plugin-access D6）', () => {
  it('羊毛条目按普通 provider 直读聚合（enabled 过滤 + 同管道，无追加/无特例序）', () => {
    const svc = new ModelService(stubSource)
    const out = svc.aggregateModelsWithScoped(PROVIDERS, [])
    expect(out.map((m) => `${m.providerId}/${m.id}`)).toEqual([
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'wool-qoder/qwen3.8-flash',
      'wool-qoder/qwen3.8-pro',
    ])
  })

  it('scopedModels 白名单对羊毛条目同语义（同一 providers 输入决定输出，无隐藏第二源）', () => {
    const svc = new ModelService(stubSource)
    const scoped = svc.aggregateModelsWithScoped(PROVIDERS, ['wool-qoder/qwen3.8-flash', 'openai/gpt-4o'])
    expect(scoped.map((m) => `${m.providerId}/${m.id}`)).toEqual([
      'wool-qoder/qwen3.8-flash',
      'openai/gpt-4o',
    ])
  })

  it('羊毛条目 enabled=false 时其模型不进结果（与既有来源同过滤语义）', () => {
    const svc = new ModelService(stubSource)
    const out = svc.aggregateModelsWithScoped(
      [WOOL_ENTRY_IN_CONFIG, { ...WOOL_ENTRY_IN_CONFIG, id: 'wool-trae' as ProviderId, enabled: false }],
      [],
    )
    expect(out.map((m) => m.providerId)).toEqual(['wool-qoder', 'wool-qoder'])
  })

  it('退役守护：ModelService 不再有 setWoolProviderSource 注入点（特例回潮即红）', () => {
    expect(Object.prototype.hasOwnProperty.call(ModelService.prototype, 'setWoolProviderSource')).toBe(false)
  })
})
