/**
 * A4-payload: payload 能力 fail-fast。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { customMsg, makeMockPort } from './helpers.js'

describe('A4-payload payload 能力 fail-fast', () => {
  it('supportedPayloads 不含 "custom" 时 send custom 消息被静默吞（warn 不 throw）', () => {
    const port = makeMockPort({
      supportedPayloads: ['text'],
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)

    handle.send(customMsg('my-type', 'hello'))

    expect(port.sendCalls).toHaveLength(0)
    expect(handle.depth()).toBe(0)
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('supportedPayloads 不含 "custom" 时 sendChecked custom 消息同步 reject', async () => {
    const port = makeMockPort({
      supportedPayloads: ['text'],
    })
    const handle = createDelivery(port)

    await expect(
      handle.sendChecked(customMsg('my-type', 'hello')),
    ).rejects.toThrow('unsupported payload kind: custom')

    expect(port.sendCalls).toHaveLength(0)
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })
})
