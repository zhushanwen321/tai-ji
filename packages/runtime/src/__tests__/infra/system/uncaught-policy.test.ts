/**
 * uncaughtException 分级策略单测（2026-09-04 整机崩溃事故护栏）。
 *
 * 行为契约：
 * - SAFE_STREAM_ERROR_CODES 内的错误码（流/IO 唯一来源）→ isContainedStreamError true
 *   → index.ts handler log-continue，不整机 shutdown
 * - 逻辑级异常（TypeError / 无 code / 业务错误码）→ false → 维持 graceful shutdown 语义
 */
import { describe, it, expect } from 'vitest'
import { isContainedStreamError, SAFE_STREAM_ERROR_CODES } from '../../../infra/system/uncaught-policy.js'

function codedError(code: string | undefined, message = 'boom'): Error {
  const err = new Error(message)
  if (code !== undefined) (err as NodeJS.ErrnoException).code = code
  return err
}

describe('uncaught-policy：uncaughtException 连接级噪声分级', () => {
  it('流级错误码全部判定为 contained（log-continue）', () => {
    for (const code of SAFE_STREAM_ERROR_CODES) {
      expect(isContainedStreamError(codedError(code))).toBe(true)
    }
  })

  it('真实事故形态：EPIPE + "This socket has been ended by the other party" 文案', () => {
    // 2026-09-04 事故堆栈原始形态（writeAfterFIN 包装出的 genericNodeError）。
    // 事故形态锚定用例：被测函数不读 message，断言与上一用例的 EPIPE 分支判然等价，
    // 无独立判别力——保留价值是锚定真实报文形态，防未来改判定时误删事故场景。
    const err = codedError('EPIPE', 'This socket has been ended by the other party')
    expect(isContainedStreamError(err)).toBe(true)
  })

  it('逻辑级异常不 contained（维持 shutdown 语义）', () => {
    expect(isContainedStreamError(new TypeError('Cannot read properties of undefined'))).toBe(false)
    expect(isContainedStreamError(codedError(undefined))).toBe(false)
    // 业务/未知错误码：不因「看着像系统码」而误豁免
    expect(isContainedStreamError(codedError('ERR_INVALID_ARG_TYPE'))).toBe(false)
    expect(isContainedStreamError(codedError('ENOENT'))).toBe(false)
  })

  it('非 Error 值（字符串/undefined/对象）不 contained，不抛', () => {
    expect(isContainedStreamError('EPIPE')).toBe(false)
    expect(isContainedStreamError(undefined)).toBe(false)
    expect(isContainedStreamError({ code: 'EPIPE' })).toBe(false)
  })
})
