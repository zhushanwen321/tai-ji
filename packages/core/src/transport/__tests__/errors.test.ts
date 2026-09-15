/**
 * transportUnavailableError 工厂钉住测试（renderer-deepening D10①，A7 钉住清单项）。
 *
 * 锁三条契约：Error 实例语义（catch instanceof Error 路径不破坏）、message 透传
 * （i18n 文案由调用方决定）、code 字面量 'disconnected'（调用方识别传输断开类失败的
 * 唯一字符串契约——识别方 `error.code === 'disconnected'`，工厂是该字面量唯一出处）。
 * 工厂的具体调用路径行为由 request.test.ts（send-fail reject）与
 * use-connection-queue-drop.test.ts（message + code 形状）经调用方覆盖。
 */
import { describe, it, expect } from 'vitest'
import { transportUnavailableError } from '../errors'

describe('transportUnavailableError（D10① 工厂单点）', () => {
  it('Error 实例 + message 透传 + code === "disconnected"', () => {
    const error = transportUnavailableError('transport unavailable (ws not open)')
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('transport unavailable (ws not open)')
    expect(error.code).toBe('disconnected')
  })

  it('i18n 解析后的文案（ports.t 产物）原样透传', () => {
    const error = transportUnavailableError('[connection.disconnectedError]')
    expect(error.message).toBe('[connection.disconnectedError]')
    expect(error.code).toBe('disconnected')
  })

  it('每次调用产出独立实例（不共享可变对象）', () => {
    const a = transportUnavailableError('a')
    const b = transportUnavailableError('b')
    expect(a).not.toBe(b)
    expect(a.message).toBe('a')
    expect(b.message).toBe('b')
  })
})
