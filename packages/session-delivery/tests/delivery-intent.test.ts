/**
 * A2-intent: intent 映射契约。
 */
import { describe, expect, it } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { makeMockPort, textMsg } from './helpers.js'

describe('A2-intent intent 映射契约', () => {
  it('config.intent 缺省回落 "interrupt-at-turn-boundary"', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.send(textMsg('hello'))

    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.intent).toBe('interrupt-at-turn-boundary')

    handle.dispose()
  })

  it('msg.intent 覆盖 config.intent', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { intent: 'interrupt-at-turn-boundary' })

    handle.send(textMsg('hello', { intent: 'after-run' }))

    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.intent).toBe('after-run')

    handle.dispose()
  })

  it('config.intent 被正确传递到 port.send', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { intent: 'after-run' })

    handle.send(textMsg('hello'))

    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.intent).toBe('after-run')

    handle.dispose()
  })
})
