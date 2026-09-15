/**
 * W3 验收测试 - 类型守卫
 *
 * 覆盖验收场景：
 * - W3-A8-type-guard-suggestion: UpdateErrorPayload 和 ProxyTestResult 类型存在且包含 suggestion 字段
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/types/w3-type-guard.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { UpdateErrorPayload, ProxyTestResult } from '@taiji/shared'

describe('W3-A8-type-guard-suggestion', () => {
  it('W3-A8-type-guard-suggestion: UpdateErrorPayload 类型包含 suggestion 字段', () => {
    // 编译时类型检查：如果 suggestion 字段不存在，TypeScript 会报错
    const payload: UpdateErrorPayload = {
      stage: 'downloading',
      message: 'test',
      errorCode: 'UPDATE_PROXY_UNREACHABLE',
      suggestion: 'test suggestion',
    }
    expect(payload.suggestion).toBe('test suggestion')
  })

  it('W3-A8-type-guard-suggestion: ProxyTestResult 类型包含 suggestion 字段', () => {
    // 编译时类型检查：如果 suggestion 字段不存在，TypeScript 会报错
    const result: ProxyTestResult = {
      success: false,
      message: 'test',
      suggestion: 'test suggestion',
    }
    expect(result.suggestion).toBe('test suggestion')
  })

  it('W3-A8-type-guard-suggestion: UpdateErrorPayload 类型可选字段正确', () => {
    // 验证可选字段
    const payload: UpdateErrorPayload = {
      stage: 'downloading',
      message: 'test',
      // errorCode 和 suggestion 是可选的
    }
    expect(payload.errorCode).toBeUndefined()
    expect(payload.suggestion).toBeUndefined()
  })

  it('W3-A8-type-guard-suggestion: ProxyTestResult 类型可选字段正确', () => {
    // 验证可选字段
    const result: ProxyTestResult = {
      success: true,
      // code, message, suggestion 是可选的
    }
    expect(result.code).toBeUndefined()
    expect(result.message).toBeUndefined()
    expect(result.suggestion).toBeUndefined()
  })
})
