// @vitest-environment jsdom
/**
 * useSessionEvents 逐 handler 隔离测试（RD-1#5：帧内多消费方无隔离 → 单 handler 抛错
 * 不得中断同帧后续 registration 分发，范式对齐 core transport/api/events.ts safeForEach）。
 *
 * 覆盖：
 * - 首个 handler 抛错 → 同 type 后续 handler 仍被调用 + console.warn 记录
 * - 异常帧不影响后续帧分发（订阅保持活跃）
 * - 未命中白名单的 type 不触发任何 handler（回归锚）
 *
 * 订阅走真实 @taiji/core/transport/api events 模块（模块级 Map，dispatchSession 直调）；
 * 组件上下文经 mount Host 提供（useSessionEvents 有 getCurrentInstance 守卫）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import type { ServerMessage } from '@taiji/shared'
import * as events from '@taiji/core/transport/api'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'

function sessionMsg(type: string): ServerMessage {
  return { type, payload: { sessionId: 'sess-rd15' } } as unknown as ServerMessage
}

/** 挂一个注册了指定 handler 集的宿主组件（useSessionEvents 必须在组件 setup 内调用） */
function mountHost(sid: string, register: (onMessage: ReturnType<typeof useSessionEvents>) => void) {
  const sidRef = ref(sid)
  const Host = defineComponent({
    setup() {
      register(useSessionEvents(sidRef))
      return () => h('div')
    },
  })
  return mount(Host)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSessionEvents — 逐 handler 隔离（RD-1#5）', () => {
  it('首个 handler 抛错：同帧后续 handler 仍执行 + console.warn 记录', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = vi.fn(() => { throw new Error('handler boom') })
    const second = vi.fn()
    const wrapper = mountHost('sess-rd15-a', (onMessage) => {
      onMessage('session.commands', first)
      onMessage('session.commands', second)
    })
    events.dispatchSession('sess-rd15-a', sessionMsg('session.commands'))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('session.commands')
    wrapper.unmount()
  })

  it('异常帧后订阅保持活跃：下一帧各 handler 照常分发', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = vi.fn(() => { throw new Error('handler boom') })
    const second = vi.fn()
    const wrapper = mountHost('sess-rd15-b', (onMessage) => {
      onMessage('session.commands', first)
      onMessage('session.commands', second)
    })
    events.dispatchSession('sess-rd15-b', sessionMsg('session.commands'))
    events.dispatchSession('sess-rd15-b', sessionMsg('session.commands'))
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('未命中白名单的 type 不分发（回归锚：隔离改造不放宽 type 过滤）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handler = vi.fn()
    const wrapper = mountHost('sess-rd15-c', (onMessage) => {
      onMessage('session.commands', handler)
    })
    events.dispatchSession('sess-rd15-c', sessionMsg('session.state_changed'))
    expect(handler).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
