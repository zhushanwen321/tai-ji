/**
 * resolveProviderBaseUrl 两级数据源单测（ai-voice-tts D4「baseUrl 读取通道」的 port 扩展）。
 *
 * 既有 port 测试在 services/auth/__tests__/provider-credential-resolver.test.ts（本单元
 * 领地外），按任务书处置规则另立本文件；本方法不走 auth.json 凭据源链（auth.json 无
 * baseUrl 概念），deps 的凭据通道给恒空 stub 即可，用例聚焦两级 baseUrl 语义：
 *
 * ① models.json providers[id].baseUrl（provider 级网关值）——pi-provider-store 启动归一化
 *    （stripCatalogProviderLevelKeys）后仅在用户显式配网关（extras.gatewayBaseUrl 标记）时
 *    保留，此级读到的必是用户网关实际值，优先级最高；
 * ② 第一级无值时回退内置 catalog（generated/builtin-providers.json）该 provider 的
 *    provider 级 baseUrl——未配网关的内置 provider，此值即 pi 实际生效值（pi 行为锚点：
 *    @earendil-works/pi-coding-agent@0.84.4 dist/core/provider-composer.js:98
 *    `config.baseUrl ?? model.baseUrl` 覆盖式网关语义）；
 * ③ 两级皆无值 → undefined。
 */
import { describe, it, expect } from 'vitest'
import type { ConfigModelsConfig, ConfigProviderConfig } from '../ports/config.js'
import { ProviderCredentialResolver, type ProviderCredentialResolverDeps } from '../auth/provider-credential-resolver.js'

/** deps 工厂：models.json 走内存 fake（本方法唯一走真实数据的通道）；凭据通道恒空 stub。 */
function makeResolver(providers: Record<string, ConfigProviderConfig>): ProviderCredentialResolver {
  const models: ConfigModelsConfig = { providers }
  const deps: ProviderCredentialResolverDeps = {
    authService: { getCredential: async () => undefined },
    authStorage: { hasCredentialSync: () => false, listCredentialIds: () => [] },
    configStore: {
      readModels: () => models,
      getProviderConfig: (providerId: string) => providers[providerId],
    },
  }
  return new ProviderCredentialResolver(deps)
}

describe('resolveProviderBaseUrl 两级数据源', () => {
  it('第一级命中：models.json provider 级 baseUrl（用户网关值）优先返回', () => {
    const resolver = makeResolver({
      'xiaomi-token-plan-cn': { baseUrl: 'https://my-gateway.example.com/v1' },
    })

    expect(resolver.resolveProviderBaseUrl('xiaomi-token-plan-cn')).toBe('https://my-gateway.example.com/v1')
  })

  it('第一级无值回退第二级：models.json 条目无 baseUrl 时返回内置 catalog 的 provider 级 baseUrl', () => {
    // 未配网关的内置 provider 主力形态：models.json 只有 apiKey（联动只带 Key 的场景此级无 baseUrl）
    const resolver = makeResolver({
      'xiaomi-token-plan-cn': { apiKey: 'sk-plan-key' },
      minimax: {},
    })

    expect(resolver.resolveProviderBaseUrl('xiaomi-token-plan-cn')).toBe('https://token-plan-cn.xiaomimimo.com/v1')
    expect(resolver.resolveProviderBaseUrl('minimax')).toBe('https://api.minimax.io/anthropic')
  })

  it('两级皆无值返回 undefined：models.json 无条目且 catalog 无此 id（自定义 provider 无 baseUrl）', () => {
    const resolver = makeResolver({})

    expect(resolver.resolveProviderBaseUrl('my-custom-provider')).toBeUndefined()
  })

  it('models.json baseUrl 为空白串同视未设置（对齐 resolveCatalogDisplayFields 口径），回退 catalog', () => {
    const resolver = makeResolver({
      xiaomi: { baseUrl: '  ' },
    })

    expect(resolver.resolveProviderBaseUrl('xiaomi')).toBe('https://api.xiaomimimo.com/v1')
  })

  it('catalog 该 provider 的 provider 级 baseUrl 为空串（ambient 类）不当生效值，返回 undefined', () => {
    // amazon-bedrock 快照 provider.baseUrl === ""（ambient 鉴权，无单一端点）
    const resolver = makeResolver({ 'amazon-bedrock': {} })

    expect(resolver.resolveProviderBaseUrl('amazon-bedrock')).toBeUndefined()
  })
})
