/**
 * ChatView AC1 冒烟测试（w6 chat-ui-and-shell T7）。
 *
 * 验证（clarify Q1 方案 2 + 三视角之观察者视角）：
 * - 空 messages：chat-view 容器 + composer 占位 DOM 存在
 * - 有 user+assistant：Turn 渲染（消息列表 DOM 存在）
 *
 * mock 策略（design-review mockStrategyNote）：provide mock ChatViewDeps（vi.fn 各回调），
 * 零真 store。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { ChatView } from '@taiji/ui'
import type { Message } from '@taiji/shared'
import { mockChatProvide } from './helpers'

function mountChatView(messages: Message[]) {
  return mount(ChatView, {
    props: { messages, sessionId: 's1', isSessionActive: false },
    global: {
      provide: mockChatProvide(),
    },
  })
}

describe('ChatView (AC1 冒烟)', () => {
  it('空 messages：渲染 chat-view 容器 + composer 占位', () => {
    const wrapper = mountChatView([])
    expect(wrapper.find('[data-testid="chat-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-placeholder"]').exists()).toBe(true)
  })

  it('有 user+assistant messages：渲染 Turn（消息列表 DOM 存在）', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'hello', status: 'complete' } as unknown as Message,
      { id: 'a1', role: 'assistant', content: 'hi', status: 'complete', thinking: [], toolCalls: [] } as unknown as Message,
    ]
    const wrapper = mountChatView(messages)
    expect(wrapper.find('[data-testid="turn-1"]').exists()).toBe(true)
  })
})
