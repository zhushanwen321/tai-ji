/**
 * warn 出口参数化（U4 观测补齐，设计 docs/architecture/pi-boundary-reliability.md 附录 D
 * §5 U4）。
 *
 * createDelivery 接受可选 warn 注入（DeliveryConfigWithWarn）：
 *   - 注入后所有内核投递失败警告经注入函数出口（装配方接 extensionLogger 落
 *     `<dataDir>/logs/`），console.warn 零调用——stderr tee 不到日志盘，排查无痕；
 *   - 缺省回落 console.warn（通用包零 logger 依赖，向后兼容锚点）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDelivery } from '../src/delivery.js'
import type { DeliveryPort, SendReceipt } from '../src/types.js'

function makePort(overrides?: Partial<DeliveryPort>): DeliveryPort {
  return {
    supportedPayloads: ['text'],
    isIdle: () => true,
    hasPendingMessages: () => false,
    send: () => {},
    ...overrides,
  }
}

function textMsg(content: string) {
  return { payload: { kind: 'text' as const, content } }
}

describe('createDelivery warn 出口参数化（U4）', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    consoleWarnSpy.mockRestore()
  })

  it('注入 warn：port.send 抛异常 → 警告走注入函数，console.warn 零调用', () => {
    const injectedWarn = vi.fn()
    const port = makePort({
      send: () => {
        throw new Error('channel closed')
      },
    })
    const handle = createDelivery(port, { warn: injectedWarn })

    handle.send(textMsg('m1'))
    // 首次失败即警告（retrying with backoff），同步可见
    expect(injectedWarn).toHaveBeenCalledTimes(1)
    expect(injectedWarn.mock.calls[0]?.[0]).toBe('port.send failed, retrying with backoff')
    expect(consoleWarnSpy).not.toHaveBeenCalled()

    handle.dispose()
  })

  it('注入 warn：退避达上限 settle rejected 的终态警告同样走注入出口', () => {
    const injectedWarn = vi.fn()
    const port = makePort({
      send: (): SendReceipt => ({ accepted: false, reason: 'busy parked' }),
    })
    const handle = createDelivery(port, { warn: injectedWarn, backoff: { ms: 1, max: 1 } })

    handle.send(textMsg('m2'))
    vi.advanceTimersByTime(5)

    const msgs = injectedWarn.mock.calls.map((c) => c[0])
    expect(msgs).toContain('port.send failed, retrying with backoff')
    expect(msgs).toContain('port.send failed after max retries')
    expect(consoleWarnSpy).not.toHaveBeenCalled()

    handle.dispose()
  })

  it('缺省未注入：回落 console.warn（通用包零依赖，向后兼容）', () => {
    const port = makePort({
      send: () => {
        throw new Error('boom')
      },
    })
    const handle = createDelivery(port)

    handle.send(textMsg('m3'))
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
    expect(String(consoleWarnSpy.mock.calls[0]?.[0])).toContain('[session-delivery]')
    expect(String(consoleWarnSpy.mock.calls[0]?.[0])).toContain('port.send failed')

    handle.dispose()
  })
})
