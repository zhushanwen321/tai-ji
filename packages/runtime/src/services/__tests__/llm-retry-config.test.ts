/**
 * llm-retry-config-helper（纯函数）测试（设计 llm-retry-settings §3.3 D3/D7/D8）。
 *
 * 锁定：configured 判定（全缺省 false / 半配置 true / 键在值坏 true）、
 * 缺省键合并 pi 默认、写入前校验失败透传（错误信封含字段/范围/当前值）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/__tests__/llm-retry-config.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mergeRetryConfig, resolveRetryConfig, validateRetryConfigForWrite } from '../llm-retry-config-helper.js'

const VALID = { enabled: true, maxRetries: 3, baseDelayMs: 2000 }

describe('resolveRetryConfig · configured 判定（D7）', () => {
  it('全缺省（undefined/空对象/坏值顶层）→ false', () => {
    expect(resolveRetryConfig(undefined).configured).toBe(false)
    expect(resolveRetryConfig({}).configured).toBe(false)
    expect(resolveRetryConfig('abc').configured).toBe(false)
    expect(resolveRetryConfig([1, 2]).configured).toBe(false)
    expect(resolveRetryConfig(null).configured).toBe(false)
  })

  it('顶层任一键显式存在 → true（半配置如仅 provider 一键也 true）', () => {
    expect(resolveRetryConfig({ enabled: false }).configured).toBe(true)
    expect(resolveRetryConfig({ maxRetries: 5 }).configured).toBe(true)
    expect(resolveRetryConfig({ baseDelayMs: 1000 }).configured).toBe(true)
    expect(resolveRetryConfig({ provider: { timeoutMs: 30000 } }).configured).toBe(true)
    expect(resolveRetryConfig({ provider: { maxRetries: 1 } }).configured).toBe(true)
    expect(resolveRetryConfig({ provider: { maxRetryDelayMs: 60000 } }).configured).toBe(true)
  })

  it('provider 层是坏值时 provider 三键不计 configured（但顶层键在仍 true）', () => {
    expect(resolveRetryConfig({ provider: 'abc' }).configured).toBe(false)
    expect(resolveRetryConfig({ enabled: true, provider: 'abc' }).configured).toBe(true)
  })

  it('键在值类型不符仍计 true，且解析回落默认值', () => {
    const { config, configured } = resolveRetryConfig({ maxRetries: 'abc', enabled: 1 })
    expect(configured).toBe(true)
    expect(config.maxRetries).toBe(3)
    expect(config.enabled).toBe(true)
  })
})

describe('resolveRetryConfig · 缺省合并 pi 默认（D7）', () => {
  it('完整合法配置原样返回（含 timeoutMs 出键条件）', () => {
    const { config } = resolveRetryConfig({
      enabled: false,
      maxRetries: 10,
      baseDelayMs: 5000,
      provider: { maxRetryDelayMs: 1800000 },
    })
    expect(config).toEqual({
      enabled: false,
      maxRetries: 10,
      baseDelayMs: 5000,
      provider: { maxRetries: 0, maxRetryDelayMs: 1800000 },
    })
    expect('timeoutMs' in config.provider!).toBe(false)
  })

  it('timeoutMs 数值存在时出现在合并结果（含超域存量值原样返回）', () => {
    const { config } = resolveRetryConfig({ provider: { timeoutMs: 700000 } })
    expect(config.provider!.timeoutMs).toBe(700000)
  })

  it('provider.timeoutMs=0 → 读侧清为未设（写侧必拒值，往返对称闭合：resolved 不含该键回落默认）', () => {
    const { config, configured } = resolveRetryConfig({ provider: { timeoutMs: 0 } })
    // configured 仍 true：键在即「文件里有显式配置意图」（`in` 判定），值回落不改判定
    expect(configured).toBe(true)
    expect('timeoutMs' in config.provider!).toBe(false)
  })
})

describe('mergeRetryConfig · D3 嵌套 merge 纯函数', () => {
  it('null（缺省）→ 仅含已知键的新对象', () => {
    const merged = mergeRetryConfig(null, { ...VALID, provider: { maxRetries: 1 } })
    expect(merged).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000, provider: { maxRetries: 1 } })
  })

  it('数组坏值 → 整体替换，不产生索引键垃圾', () => {
    const merged = mergeRetryConfig([1, 2], VALID)
    expect(merged).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000, provider: {} })
    expect(Object.keys(merged).some(k => /^\d+$/.test(k))).toBe(false)
  })

  it('未知子字段保留，未设 provider 键删键', () => {
    const merged = mergeRetryConfig(
      { future: 'x', provider: { futureSub: 9, timeoutMs: 30000 } },
      VALID,
    ) as { future: string; provider: Record<string, unknown> }
    expect(merged.future).toBe('x')
    expect(merged.provider.futureSub).toBe(9)
    expect(merged.provider.timeoutMs).toBeUndefined()
  })
})

describe('validateRetryConfigForWrite · 校验失败透传（D8）', () => {
  it('合法配置通过', () => {
    expect(validateRetryConfigForWrite({ ...VALID, provider: { timeoutMs: 1, maxRetries: 10, maxRetryDelayMs: 0 } })).toEqual({ ok: true })
  })

  it('越界值失败且错误信封含字段名/范围/当前值', () => {
    const result = validateRetryConfigForWrite({ ...VALID, maxRetries: 21 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('maxRetries')
      expect(result.error).toContain('0-20')
      expect(result.error).toContain('21')
    }
  })

  it('provider.maxRetryDelayMs 落入 (0,1000) 空档拒绝', () => {
    const result = validateRetryConfigForWrite({ ...VALID, provider: { maxRetryDelayMs: 500 } })
    expect(result.ok).toBe(false)
  })
})
