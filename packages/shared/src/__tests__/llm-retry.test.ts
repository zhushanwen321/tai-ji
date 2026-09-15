import { describe, it, expect } from 'vitest'
import { validateLlmRetryConfig, LLM_RETRY_DOMAIN, type LlmRetryConfig } from '../llm-retry'

const valid = (): LlmRetryConfig => ({
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
})

describe('validateLlmRetryConfig', () => {
  it('域内配置通过（各字段取 D8 边界值）', () => {
    expect(validateLlmRetryConfig({ enabled: false, maxRetries: 0, baseDelayMs: 0 })).toEqual({ ok: true })
    expect(validateLlmRetryConfig({ enabled: true, maxRetries: LLM_RETRY_DOMAIN.maxRetries.max, baseDelayMs: LLM_RETRY_DOMAIN.baseDelayMs.max })).toEqual({ ok: true })
    expect(validateLlmRetryConfig({
      ...valid(),
      provider: { timeoutMs: LLM_RETRY_DOMAIN.providerTimeoutMs.min, maxRetries: LLM_RETRY_DOMAIN.providerMaxRetries.max, maxRetryDelayMs: LLM_RETRY_DOMAIN.providerMaxRetryDelayMs.max },
    })).toEqual({ ok: true })
    // provider.maxRetryDelayMs 的两个合法极端：0（不限制）与 1000（非零下限）
    expect(validateLlmRetryConfig({ ...valid(), provider: { maxRetryDelayMs: 0 } })).toEqual({ ok: true })
    expect(validateLlmRetryConfig({ ...valid(), provider: { maxRetryDelayMs: 1000 } })).toEqual({ ok: true })
    // provider 各字段全未设（undefined = pi 默认语义）
    expect(validateLlmRetryConfig({ ...valid(), provider: {} })).toEqual({ ok: true })
    expect(validateLlmRetryConfig(valid())).toEqual({ ok: true })
  })

  it('enabled 非 boolean 拒绝', () => {
    const bad = { ...valid(), enabled: 'yes' } as unknown as LlmRetryConfig
    const r = validateLlmRetryConfig(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('enabled')
  })

  it('maxRetries 越界拒绝（负数 / 超 20 / 非整数）', () => {
    for (const maxRetries of [-1, 21, 3.5, NaN]) {
      const r = validateLlmRetryConfig({ ...valid(), maxRetries })
      expect(r.ok, `maxRetries=${maxRetries}`).toBe(false)
      if (!r.ok) {
        expect(r.error).toContain('maxRetries')
        expect(r.error).toContain(String(maxRetries))
      }
    }
  })

  it('baseDelayMs 越界拒绝（负数 / 超 600000 / 非整数）', () => {
    for (const baseDelayMs of [-1, 600001, 1.5]) {
      const r = validateLlmRetryConfig({ ...valid(), baseDelayMs })
      expect(r.ok, `baseDelayMs=${baseDelayMs}`).toBe(false)
      if (!r.ok) expect(r.error).toContain('baseDelayMs')
    }
  })

  it('provider.timeoutMs 禁止 0 并拒绝越界（0 / 600001 / 非整数）', () => {
    for (const timeoutMs of [0, 600001, 0.5]) {
      const r = validateLlmRetryConfig({ ...valid(), provider: { timeoutMs } })
      expect(r.ok, `timeoutMs=${timeoutMs}`).toBe(false)
      if (!r.ok) {
        expect(r.error).toContain('provider.timeoutMs')
        expect(r.error).toContain(String(timeoutMs))
      }
    }
    // 1 与 600000 是合法边界
    expect(validateLlmRetryConfig({ ...valid(), provider: { timeoutMs: 600000 } })).toEqual({ ok: true })
  })

  it('provider.maxRetries 越界拒绝（-1 / 11 / 非整数）', () => {
    for (const p of [-1, 11, 2.5]) {
      const r = validateLlmRetryConfig({ ...valid(), provider: { maxRetries: p } })
      expect(r.ok, `provider.maxRetries=${p}`).toBe(false)
      if (!r.ok) expect(r.error).toContain('provider.maxRetries')
    }
  })

  it('provider.maxRetryDelayMs 拒绝 1-999 之间的非零值与超上限', () => {
    for (const d of [1, 999, 3600001, 1.5]) {
      const r = validateLlmRetryConfig({ ...valid(), provider: { maxRetryDelayMs: d } })
      expect(r.ok, `maxRetryDelayMs=${d}`).toBe(false)
      if (!r.ok) expect(r.error).toContain('provider.maxRetryDelayMs')
    }
  })

  it('provider 非 plain object 拒绝（null / 字符串 / 数组）', () => {
    for (const provider of [null, 'abc', []]) {
      const r = validateLlmRetryConfig({ ...valid(), provider } as unknown as LlmRetryConfig)
      expect(r.ok, `provider=${String(provider)}`).toBe(false)
      if (!r.ok) {
        expect(r.error).toContain('provider')
        expect(r.error).toContain('类型必须是对象')
      }
    }
    // 合法路径不受影响：普通对象（含空对象）与未设仍通过
    expect(validateLlmRetryConfig({ ...valid(), provider: {} })).toEqual({ ok: true })
    expect(validateLlmRetryConfig(valid())).toEqual({ ok: true })
  })

  it('多字段越界时报第一个（校验顺序 enabled → maxRetries → baseDelayMs → provider.*）', () => {
    const r = validateLlmRetryConfig({ enabled: true, maxRetries: 100, baseDelayMs: -5, provider: { timeoutMs: 0 } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('maxRetries')
      expect(r.error).not.toContain('baseDelayMs')
    }
    const r2 = validateLlmRetryConfig({ enabled: true, maxRetries: 3, baseDelayMs: -5, provider: { timeoutMs: 0 } })
    if (!r2.ok) expect(r2.error).toContain('baseDelayMs')
    const r3 = validateLlmRetryConfig({ enabled: true, maxRetries: 3, baseDelayMs: 2000, provider: { timeoutMs: 0, maxRetries: 99 } })
    if (!r3.ok) {
      expect(r3.error).toContain('provider.timeoutMs')
      expect(r3.error).not.toContain('provider.maxRetries')
    }
  })

  it('错误信封含合法域描述与当前值', () => {
    const r = validateLlmRetryConfig({ enabled: true, maxRetries: 50, baseDelayMs: 2000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('maxRetries 超出范围(整数 0-20): 50')
  })
})
