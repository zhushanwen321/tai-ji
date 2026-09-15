/**
 * resolveQuotaCredentialSource / supportsExclusiveCredential 单测（D3，coding-plan-quota-config-ux
 * §6.4；专属 Key 适用性判据 §7 残留 11）。
 *
 * 覆盖：显式值优先于标记推断、缺省时按 apiKeySet 推断（历史数据兼容）、
 * undefined 输入兜底 'provider'；以及 supportsExclusiveCredential 的 auth 形态矩阵 —— 两端
 * （UI/runtime）共用该谓词的一致性由这些断言锚定。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/quota-credential-source.test.ts
 */
import { describe, it, expect } from 'vitest'
import { resolveQuotaCredentialSource, supportsExclusiveCredential } from '../quota-types'

describe('resolveQuotaCredentialSource · 显式值优先（D3）', () => {
  it("显式 'provider' 即使 apiKeySet=true 也不被推断覆盖", () => {
    expect(resolveQuotaCredentialSource({ credentialSource: 'provider', apiKeySet: true })).toBe('provider')
  })

  it("显式 'exclusive' 即使 apiKeySet=false/缺省 也不回退 'provider'", () => {
    expect(resolveQuotaCredentialSource({ credentialSource: 'exclusive' })).toBe('exclusive')
    expect(resolveQuotaCredentialSource({ credentialSource: 'exclusive', apiKeySet: false })).toBe('exclusive')
  })
})

describe('resolveQuotaCredentialSource · 缺省按既存标记推断（历史数据兼容）', () => {
  it('未设置 credentialSource 且 apiKeySet=true → exclusive（旧数据继续用专属 Key，行为不变）', () => {
    expect(resolveQuotaCredentialSource({ apiKeySet: true })).toBe('exclusive')
  })

  it('未设置 credentialSource 且 apiKeySet=false → provider', () => {
    expect(resolveQuotaCredentialSource({ apiKeySet: false })).toBe('provider')
  })

  it('quota 无任何标记 → provider（默认复用 provider 凭据）', () => {
    expect(resolveQuotaCredentialSource(undefined)).toBe('provider')
    expect(resolveQuotaCredentialSource({})).toBe('provider')
  })
})

describe('supportsExclusiveCredential · 专属 Key 适用性判据（§7 残留 11）', () => {
  it("['api-key'] → true（纯 api-key 类可选用专属 Key）", () => {
    expect(supportsExclusiveCredential(['api-key'])).toBe(true)
  })

  it("['api-key','oauth'] → true（数组含 api-key 即可，其余形态不影响）", () => {
    expect(supportsExclusiveCredential(['api-key', 'oauth'])).toBe(true)
  })

  it("['cookie'] → false（cookie 类无专属 Key 概念）", () => {
    expect(supportsExclusiveCredential(['cookie'])).toBe(false)
  })

  it("['oauth'] → false（纯 oauth 类无专属 Key 概念；UI 不得显示分段控件）", () => {
    expect(supportsExclusiveCredential(['oauth'])).toBe(false)
  })

  it('undefined → false（auth 未声明时后端不会收窄 exclusive）', () => {
    expect(supportsExclusiveCredential(undefined)).toBe(false)
  })

  it('空数组 → false（同 undefined，无声明即不适用）', () => {
    expect(supportsExclusiveCredential([])).toBe(false)
  })
})
