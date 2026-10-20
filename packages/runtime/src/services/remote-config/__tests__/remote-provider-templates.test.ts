/**
 * remote-provider-templates 单测（isRemoteProvidersConfig 形状 guard：字段级类型校验）。
 *
 * guard 是远程清单进内存/写盘链前的唯一类型拦截点（写盘链 applyValidatedModelFields 只校验
 * reasoning/maxTokens/cost/headers，其余字段直写 models.json——坏值触发 pi schema 整表拒载），
 * 逐字段畸形必须整体拒绝（loadRemoteConfig / refreshRemoteConfig 拒后回退缓存）。
 */
import { describe, it, expect } from 'vitest'
import { isRemoteProvidersConfig } from '../remote-provider-templates.js'

/** 合法最小配置（providers 空 = 现行 configs/remote/builtin-providers.json 骨架形态）。 */
const EMPTY: unknown = { version: 1, providers: [] }

/** 合法全字段模型条目（RemoteProviderModel 全部可选字段取合法值）。 */
function fullModel(): unknown {
  return {
    id: 'm1',
    name: 'Model One',
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: true,
    input: ['text', 'image'],
    thinkingLevelMap: { high: 'high', off: null },
  }
}

function fullConfig(): unknown {
  return {
    version: 1,
    providers: [
      {
        id: 'taiji-demo',
        name: 'Demo',
        api: 'openai-completions',
        baseUrl: 'https://example.com/v1',
        helpUrl: 'https://example.com/help',
        helpText: 'demo',
        models: [fullModel()],
      },
    ],
  }
}

/** 深拷贝合法配置后按 path 改写单个字段（畸形注入用）。 */
function withModel(overrides: Record<string, unknown>): unknown {
  const config = fullConfig() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  config.providers[0].models[0] = { ...config.providers[0].models[0], ...overrides }
  return config
}

describe('isRemoteProvidersConfig 合法基线', () => {
  it('空骨架（providers: []）通过', () => {
    expect(isRemoteProvidersConfig(EMPTY)).toBe(true)
  })

  it('全字段合法配置通过', () => {
    expect(isRemoteProvidersConfig(fullConfig())).toBe(true)
  })

  it('模型仅 id（全可选字段缺省）通过', () => {
    const config = fullConfig() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
    config.providers[0].models[0] = { id: 'm1' }
    expect(isRemoteProvidersConfig(config)).toBe(true)
  })

  it('顶层畸形：非对象 / version 非 1 / providers 非数组 拒绝', () => {
    expect(isRemoteProvidersConfig(null)).toBe(false)
    expect(isRemoteProvidersConfig('nope')).toBe(false)
    expect(isRemoteProvidersConfig({ version: 2, providers: [] })).toBe(false)
    expect(isRemoteProvidersConfig({ version: 1, providers: 'not-an-array' })).toBe(false)
  })
})

describe('isRemoteProvidersConfig models 元素逐字段畸形拒绝', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['id 空串', { id: '' }],
    ['name 非 string', { name: 123 }],
    ['contextWindow 非 number（数值串）', { contextWindow: '200000' }],
    ['contextWindow boolean', { contextWindow: true }],
    ['maxTokens 数值串', { maxTokens: '8192' }],
    ['maxTokens 负数（写盘链同口径非法）', { maxTokens: -5 }],
    ['maxTokens 非整数（写盘链同口径非法）', { maxTokens: 1.5 }],
    ['maxTokens 零（写盘链同口径非法）', { maxTokens: 0 }],
    ['reasoning 数值串', { reasoning: 'true' }],
    ['input 非数组', { input: 'text' }],
    ['input 元素非法类型', { input: ['text', 3] }],
    ['input 元素枚举外', { input: ['video'] }],
    ['thinkingLevelMap 显式 null（接口不含 null）', { thinkingLevelMap: null }],
    ['thinkingLevelMap 数组冒充 Record', { thinkingLevelMap: ['high'] }],
    ['thinkingLevelMap 值非法类型', { thinkingLevelMap: { high: 3 } }],
  ]

  for (const [label, overrides] of cases) {
    it(`${label} → 整体拒绝`, () => {
      expect(isRemoteProvidersConfig(withModel(overrides))).toBe(false)
    })
  }
})

describe('isRemoteProvidersConfig provider 级字段（既有行为防回归）', () => {
  it('provider id 空串 / name 非 string 拒绝', () => {
    const badId = fullConfig() as { providers: Array<Record<string, unknown>> }
    badId.providers[0].id = ''
    expect(isRemoteProvidersConfig(badId)).toBe(false)

    const badName = fullConfig() as { providers: Array<Record<string, unknown>> }
    badName.providers[0].name = 42
    expect(isRemoteProvidersConfig(badName)).toBe(false)
  })

  it('provider 可选标量字段类型漂移拒绝', () => {
    const badApi = fullConfig() as { providers: Array<Record<string, unknown>> }
    badApi.providers[0].api = 123
    expect(isRemoteProvidersConfig(badApi)).toBe(false)
  })

  it('models 非数组 / 元素非对象拒绝', () => {
    const badModels = fullConfig() as { providers: Array<Record<string, unknown>> }
    badModels.providers[0].models = 'm1'
    expect(isRemoteProvidersConfig(badModels)).toBe(false)

    const badElement = fullConfig() as { providers: Array<{ models: unknown[] }> }
    badElement.providers[0].models[0] = 'm1'
    expect(isRemoteProvidersConfig(badElement)).toBe(false)
  })
})
