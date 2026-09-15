import { describe, it, expectTypeOf } from 'vitest'
import type { ProviderInfo, ProviderKind } from '../provider'

/**
 * wave1 类型层断言（DM1/DM2）：ProviderKind 联合 + ProviderInfo.kind/hasOverride 字段类型。
 * 纯编译期断言（expectTypeOf），无运行时依赖。TC4（tsc 不破坏现有构造点）由 shared 包
 * typecheck 兜底——加可选字段对 NEW_PROVIDER_SENTINEL/fixtureProviders 等字面量零侵入。
 */
describe('ProviderKind + ProviderInfo kind/hasOverride (wave1 DM1/DM2)', () => {
  it('TC1: ProviderKind 是 catalog|custom 联合类型', () => {
    expectTypeOf<ProviderKind>().toEqualTypeOf<'catalog' | 'custom'>()
  })

  it('TC2: ProviderInfo.kind 可选 ProviderKind（可选以保证现有字面量构造点不破坏，见 CL1/T1）', () => {
    expectTypeOf<ProviderInfo['kind']>().toEqualTypeOf<ProviderKind | undefined>()
  })

  it('TC3: ProviderInfo.hasOverride 可选 boolean', () => {
    expectTypeOf<ProviderInfo['hasOverride']>().toEqualTypeOf<boolean | undefined>()
  })
})
