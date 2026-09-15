import { describe, it, expect } from 'vitest'
import { PROVIDER_API_TYPES } from '../src/constants'
import type { ProviderApiType } from '../src/constants'

// W1：PROVIDER_API_TYPES 是 pi 支持的 provider api 标识 SSOT，前后端共享。
// runtime 不再翻译别名（mapTypeToApi 已删），前端直接发送此集合内的终值。
describe('PROVIDER_API_TYPES（W1 SSOT）', () => {
  it('包含 pi 支持的两个终值', () => {
    expect(PROVIDER_API_TYPES).toContain('anthropic-messages')
    expect(PROVIDER_API_TYPES).toContain('openai-completions')
  })

  it('是 readonly tuple', () => {
    // as const 编译期保护；运行期断言两个元素
    expect(PROVIDER_API_TYPES.length).toBe(2)
  })

  it('ProviderApiType 类型可赋值为集合成员（编译期校验的运行期投影）', () => {
    const t: ProviderApiType = 'anthropic-messages'
    expect(PROVIDER_API_TYPES).toContain(t)
  })
})
