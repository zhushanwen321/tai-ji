import { describe, it, expect } from 'vitest'
import { matchQuotaPreset, QUOTA_PRESETS } from '../quota-presets'

describe('QUOTA_PRESETS', () => {
  it('有 5 个预设', () => {
    expect(QUOTA_PRESETS).toHaveLength(5)
  })

  it('每个预设都有必需字段', () => {
    for (const preset of QUOTA_PRESETS) {
      expect(preset.fetcher).toBeTruthy()
      expect(preset.label).toBeTruthy()
      // [A2-1] auth 数组化：非空数组且元素均为合法形态
      expect(Array.isArray(preset.auth)).toBe(true)
      expect(preset.auth.length).toBeGreaterThan(0)
      for (const kind of preset.auth) {
        expect(['api-key', 'oauth', 'cookie']).toContain(kind)
      }
      expect(preset.match.baseUrlPattern || preset.match.namePattern).toBeTruthy()
    }
  })
})

describe('matchQuotaPreset', () => {
  it('baseUrl 匹配 zhipu', () => {
    const result = matchQuotaPreset({ baseUrl: 'https://bigmodel.cn/api' })
    expect(result?.fetcher).toBe('zhipu')
  })

  it('name 匹配 zhipu（不区分大小写）', () => {
    const result = matchQuotaPreset({ name: 'Zhipu' })
    expect(result?.fetcher).toBe('zhipu')
  })

  it('name 匹配 kimi', () => {
    const result = matchQuotaPreset({ name: 'kimi' })
    expect(result?.fetcher).toBe('kimi-coding')
  })

  it('baseUrl 匹配 minimax', () => {
    const result = matchQuotaPreset({ baseUrl: 'https://api.minimaxi.com/v1' })
    expect(result?.fetcher).toBe('minimax')
  })

  it('name 匹配 mimo', () => {
    const result = matchQuotaPreset({ name: 'MiMo' })
    expect(result?.fetcher).toBe('mimo')
  })

  it('name 匹配 opencode', () => {
    const result = matchQuotaPreset({ name: 'opencode' })
    expect(result?.fetcher).toBe('opencode-go')
  })

  it('无匹配返回 undefined', () => {
    const result = matchQuotaPreset({ name: 'openai' })
    expect(result).toBeUndefined()
  })

  it('无参数返回 undefined', () => {
    const result = matchQuotaPreset({})
    expect(result).toBeUndefined()
  })

  it('baseUrl 优先于 name 匹配', () => {
    // baseUrl 匹配 zhipu，name 匹配 kimi
    const result = matchQuotaPreset({ baseUrl: 'https://bigmodel.cn', name: 'kimi' })
    expect(result?.fetcher).toBe('zhipu')
  })

  // [W2] 负向用例：防止 namePattern 作为子串误匹配用户自建 provider
  it('name 含 zai 子串但不匹配 zhipu（lazyai）', () => {
    const result = matchQuotaPreset({ name: 'lazyai' })
    expect(result).toBeUndefined()
  })

  it('name 含 zai 子串但不匹配 zhipu（mozaitest）', () => {
    const result = matchQuotaPreset({ name: 'mozaitest' })
    expect(result).toBeUndefined()
  })

  it('name 含 mimo 子串但不匹配 mimo（mimosa）', () => {
    const result = matchQuotaPreset({ name: 'mimosa' })
    expect(result).toBeUndefined()
  })

  it('name 含 kimi 子串但不匹配 kimi（kimito）', () => {
    const result = matchQuotaPreset({ name: 'kimito' })
    expect(result).toBeUndefined()
  })

  it('name 含 minimax 子串但不匹配 minimax（minimaxified）', () => {
    const result = matchQuotaPreset({ name: 'minimaxified' })
    expect(result).toBeUndefined()
  })

  it('name 含 opencode 子串但不匹配 opencode-go（opencodejs）', () => {
    const result = matchQuotaPreset({ name: 'opencodejs' })
    expect(result).toBeUndefined()
  })

  // [W2] 大小写归一化：baseUrl 大写也应命中（修复后 toLowerCase 归一化）
  it('baseUrl 大写也匹配 zhipu', () => {
    const result = matchQuotaPreset({ baseUrl: 'HTTPS://BIGMODEL.CN/api' })
    expect(result?.fetcher).toBe('zhipu')
  })

  // [W2] trailing slash 应命中
  it('baseUrl 带 trailing slash 也匹配 zhipu', () => {
    const result = matchQuotaPreset({ baseUrl: 'https://bigmodel.cn/' })
    expect(result?.fetcher).toBe('zhipu')
  })

  // [W2] namePattern 多关键字边界：zhipu 的 'zhipu|glm|\bzai\b' 应命中独立 'zai' token
  it('name 为独立 zai token 匹配 zhipu', () => {
    const result = matchQuotaPreset({ name: 'zai' })
    expect(result?.fetcher).toBe('zhipu')
  })

  it('name 含独立 glm token 匹配 zhipu（如 my-glm-service）', () => {
    const result = matchQuotaPreset({ name: 'my-glm-service' })
    expect(result?.fetcher).toBe('zhipu')
  })
})
