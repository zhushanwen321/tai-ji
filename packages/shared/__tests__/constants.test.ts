import { describe, it, expect } from 'vitest'
import { PROVIDER_API_TYPES, SUBAGENT_RECORD_CUSTOM_TYPE } from '../src/constants'
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

// SUBAGENT_RECORD_CUSTOM_TYPE 是 core 权威值的 renderer 镜像（shared 不依赖
// core，无法直接 import 互证）——本锁钉死镜像侧字面量，与 core 侧
// record-entry-collect.test.ts 的字面量锁构成双侧等值守卫：任一侧改值即红，
// 报错点就在改动所在的包。
describe('SUBAGENT_RECORD_CUSTOM_TYPE（core 镜像等值锁）', () => {
  it('镜像值与 core 权威源字面量一致（subagent-record）', () => {
    expect(SUBAGENT_RECORD_CUSTOM_TYPE).toBe('subagent-record')
  })
})
