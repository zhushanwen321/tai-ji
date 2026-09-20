/**
 * EventAdapter RT-2 批次加固测试（code-harden 审计批次 4 Wave 1，RT-2 组 #3a/#7）。
 *
 * 锁定：
 * - #3a translate 隔离：attach 内 translate 与 interpret 同处隔离边界——pi 字段漂移致
 *   handler 直读炸掉（queue_update.steering 非数组）时，失败在 adapter 内显形为
 *   message.stream_error{kind:'adapter'}（content 带原因，前端 finalize 收口 + 文案
 *   可见）并留 [ADAPTER-FAIL] 日志，流继续（后续好帧照常翻译）。修复前 translate 在
 *   try 外：异常逃逸进 rpc-client 的 stdout parse catch 被误记「parse error」，本帧对
 *   第二 listener 整帧丢失且无用户可见失败。
 * - #7 未知 extension_ui_request method：不再静默 noop——console.warn 留痕（pi 升级
 *   新增 method 尤其阻塞式时无痕丢弃会让 pi 侧 Promise 永挂）。已知落点 setTitle
 *   （宿主不实现的 fire-and-forget，预决策只补类型与 warn）。
 *
 * translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出消息；attach 路径用
 * 最小 fake client（onEvent 捕获 listener）驱动。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/event-adapter-rt2-hardening.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { EventAdapter, translate } from '../event-adapter.js'
import type { PiExtensionUiRequestEvent, PiQueueUpdateEvent } from '../pi-protocol.js'
import type { PiTranslatedEvent } from '../../../services/session/types.js'

/** 最小 fake client：捕获 attach 注册的 listener，测试经 emit 驱动。 */
function fakeClient() {
  let listener: ((event: unknown) => void) | null = null
  return {
    onEvent: vi.fn((cb: (event: unknown) => void) => {
      listener = cb
      return () => { listener = null }
    }),
    emit(event: unknown): void {
      if (!listener) throw new Error('listener not attached')
      listener(event)
    },
  }
}

/** 从 interpret 收到的批次中取出唯一 message（断言前收窄 kind 联合）。 */
function soleMessage(events: PiTranslatedEvent[]): { type: string; payload: Record<string, unknown> } {
  expect(events).toHaveLength(1)
  const [ev] = events
  if (!ev || ev.kind !== 'message') {
    throw new Error(`expected single message event, got: ${JSON.stringify(ev)}`)
  }
  return ev.message as { type: string; payload: Record<string, unknown> }
}

describe('EventAdapter RT-2 加固：translate 隔离显形（#3a）', () => {
  it('translate 抛错 → [ADAPTER-FAIL] 日志 + message.stream_error{kind:adapter} 显形', () => {
    const interpret = vi.fn()
    const adapter = new EventAdapter('s1', interpret)
    const client = fakeClient()
    adapter.attach(client)

    // 注意：断言须在 mockRestore 之前（restore 清空 mock.calls——先例 fs-guard.test.ts 同款时序）
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let adapterFailLogged = false
    try {
      // 触发面：handleQueueUpdate 的 [...event.steering] 直读（pi 字段漂移致非数组）
      // 修复前此 emit 同步抛出（translate 在 try 外），interpret 收不到任何事件
      client.emit({ type: 'queue_update', steering: null, followUp: [] } as unknown as PiQueueUpdateEvent)
      adapterFailLogged = errSpy.mock.calls.some((c) => String(c[0]).includes('[ADAPTER-FAIL]'))
    } finally {
      errSpy.mockRestore()
    }

    expect(interpret).toHaveBeenCalledTimes(1)
    const msg = soleMessage(interpret.mock.calls[0][0] as PiTranslatedEvent[])
    expect(msg.type).toBe('message.stream_error')
    expect(msg.payload.sessionId).toBe('s1')
    expect(msg.payload.kind).toBe('adapter')
    expect(String(msg.payload.content)).toContain('事件翻译失败')
    expect(adapterFailLogged).toBe(true)
  })

  it('坏帧后流继续：后续合法帧照常翻译（订阅存活）', () => {
    const interpret = vi.fn()
    const adapter = new EventAdapter('s1', interpret)
    const client = fakeClient()
    adapter.attach(client)

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    client.emit({ type: 'queue_update', steering: null, followUp: [] } as unknown as PiQueueUpdateEvent)
    errSpy.mockRestore()

    // 第二帧（合法）正常产出 queue_update 广播帧
    client.emit({ type: 'queue_update', steering: ['hi'], followUp: [] } as PiQueueUpdateEvent)

    expect(interpret).toHaveBeenCalledTimes(2)
    const msg = soleMessage(interpret.mock.calls[1][0] as PiTranslatedEvent[])
    expect(msg.type).toBe('message.queue_update')
    expect(msg.payload.pendingMessageCount).toBe(1)
  })
})

describe('EventAdapter RT-2 加固：未知 ui method warn（#7）', () => {
  it('setTitle（宿主不实现的 fire-and-forget）→ warn 留痕 + noop，不抛错', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let events: PiTranslatedEvent[]
    try {
      events = translate(
        { type: 'extension_ui_request', id: 'r1', method: 'setTitle', title: 'T' } as unknown as PiExtensionUiRequestEvent,
        's1',
      )
      // 断言在 mockRestore 之前（restore 清空 mock.calls）
      expect(warnSpy).toHaveBeenCalledWith('[EventAdapter] Unhandled extension_ui_request method:', 'setTitle')
    } finally {
      warnSpy.mockRestore()
    }
    expect(events).toEqual([{ kind: 'noop' }])
  })

  it('union 内方法（set_editor_text）不走 unknown 分支（穷举修复的运行时对照）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const events = translate(
        { type: 'extension_ui_request', id: 'r2', method: 'set_editor_text', text: 'abc' } as unknown as PiExtensionUiRequestEvent,
        's1',
      )
      const msg = soleMessage(events)
      expect(msg.type).toBe('extension:setEditorText')
      expect(msg.payload).toEqual({ sessionId: 's1', text: 'abc' })
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes('Unhandled extension_ui_request')),
      ).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
