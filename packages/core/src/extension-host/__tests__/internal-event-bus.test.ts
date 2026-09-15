/**
 * internal-event-bus.test.ts —— InternalEventBus 契约（TC-3）+ MockMessageSource 契约（TC-6）。
 *
 * TC-3（IF2）：同步 emit 收到 / unsubscribe 后不再收 / 多 consumer / 未订阅 kind 不触发
 * TC-6（IF1）：MockMessageSource emit → handler 收到 → unsubscribe 后不再收（防 listener 翻倍）
 */
import { describe, it, expect, vi } from 'vitest'
import { InternalEventBus } from '../internal-event-bus'
import { MockMessageSource } from '../plugin-message-source'
import type { InternalEvent } from '../types'

describe('InternalEventBus', () => {
  it('TC-3a: emit 后 handler 同步收到（emit 返回即已执行）', () => {
    const bus = new InternalEventBus()
    const handler = vi.fn()
    bus.on('plugin-status-bar-update', handler)
    bus.emit({ kind: 'plugin-status-bar-update', items: [{ id: 's1', pluginId: 'p1', text: 'x', alignment: 'right', priority: 0 }] })
    expect(handler).toHaveBeenCalledTimes(1)
    const e = handler.mock.calls[0]?.[0] as Extract<InternalEvent, { kind: 'plugin-status-bar-update' }>
    expect(e.kind).toBe('plugin-status-bar-update')
    expect(e.items[0].id).toBe('s1')
  })

  it('TC-3b: unsubscribe 后不再收到', () => {
    const bus = new InternalEventBus()
    const handler = vi.fn()
    const unsub = bus.on('plugin-crashed', handler)
    unsub()
    bus.emit({ kind: 'plugin-crashed', pluginId: 'p1', error: 'boom' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('TC-3c: 多 consumer 各自收到', () => {
    const bus = new InternalEventBus()
    const h1 = vi.fn()
    const h2 = vi.fn()
    bus.on('session-destroyed', h1)
    bus.on('session-destroyed', h2)
    bus.emit({ kind: 'session-destroyed', sessionId: 's1' })
    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(1)
  })

  it('TC-3d: 未订阅的 kind 不误触发', () => {
    const bus = new InternalEventBus()
    const handler = vi.fn()
    bus.on('plugin-crashed', handler)
    bus.emit({ kind: 'extension-notify', notification: { pluginId: 'p1', message: 'hi' } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('TC-3e: 同 handler 重复订阅去重（Set 语义）', () => {
    const bus = new InternalEventBus()
    const handler = vi.fn()
    bus.on('plugin-crashed', handler)
    bus.on('plugin-crashed', handler)
    bus.emit({ kind: 'plugin-crashed', pluginId: 'p1', error: 'boom' })
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('MockMessageSource', () => {
  it('TC-6a: emit → handler 收到；unsubscribe 后不再收', () => {
    const src = new MockMessageSource()
    const handler = vi.fn()
    const unsub = src.subscribe(handler)
    src.emit({ type: 'plugin:statusBarUpdate', sessionId: 's1', payload: {} })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ type: 'plugin:statusBarUpdate', sessionId: 's1' })
    unsub()
    src.emit({ type: 'plugin:crashed', payload: {} })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('TC-6b: listenerCount 反映订阅数（防 listener 翻倍）', () => {
    const src = new MockMessageSource()
    const unsub1 = src.subscribe(() => {})
    src.subscribe(() => {})
    expect(src.listenerCount()).toBe(2)
    unsub1()
    expect(src.listenerCount()).toBe(1)
  })
})
