/**
 * MessageStream → useVirtuaFollow smoothAllowed 接线测试（缺陷① 对抗审查 F1/P2 补口）。
 *
 * 门本体组合层语义（门关降级 / 门开透传 / 缺省放行）在 use-virtua-follow.test.ts（自造
 * 闭包，无法发现接线回归）；本文件钉接线层：MessageStream 注入的 smoothAllowed 观察口径
 * 必须是「全部 renderItems 的 some(isStreaming)」——bash↔streaming 双工作态（streaming
 * 回合退居非末位）时仍要拦 smooth。回归者把注入改回末位单点判定时 TC-3 变红。
 *
 * 捕获方式：vi.mock 包 actual（记录 opts 后透传真实实现，行为零改变）。独立文件不挂
 * MessageStream.wire.test.ts（chat 域档）——shell-mount 头注释约束消费文件不得再 mock
 * 其三个目标（useChatViewDeps/useChat/useSidebar）；本文件 mock 的是 useVirtuaFollow，
 * 无冲突。virtua/vue 简化 mock 按壳约定文件内自注册。
 */
import { describe, it, expect, vi } from 'vitest'
import '@/__tests__/helpers/message-stream-shell-mount'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { virtuaVueMockModule } from '@/__tests__/helpers/chat-stream-mount'
import type { useVirtuaFollow } from '@/composables/panel/useVirtuaFollow'

vi.mock('virtua/vue', () => virtuaVueMockModule())

const { capturedFollowOpts } = vi.hoisted(() => ({
  capturedFollowOpts: [] as Parameters<typeof import('@/composables/panel/useVirtuaFollow')['useVirtuaFollow']>[0][],
}))
vi.mock('@/composables/panel/useVirtuaFollow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/panel/useVirtuaFollow')>()
  return {
    ...actual,
    useVirtuaFollow: (opts: (typeof capturedFollowOpts)[number]) => {
      capturedFollowOpts.push(opts)
      return actual.useVirtuaFollow(opts)
    },
  }
})

import MessageStream from '../../MessageStream.vue'
import { useChatStore } from '@/stores/chat'
import type { Message } from '@taiji/shared'

function msg(id: string, role: 'user' | 'assistant', content: string, status: Message['status']): Message {
  return { id, role, content, status, timestamp: 1 } as Message
}

/** 种消息 + 挂载，返回最近一次捕获的 follow opts（MessageStream setup 同步调 useVirtuaFollow）。 */
async function mountAndCapture(sessionId: string, messages: Message[]) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const chat = useChatStore()
  chat.setMessages(sessionId, messages)
  const before = capturedFollowOpts.length
  const wrapper = mount(MessageStream, { props: { sessionId }, global: { plugins: [pinia] } })
  await nextTick()
  const opts = capturedFollowOpts[before]
  expect(opts, 'useVirtuaFollow 未被 MessageStream 调用（接线断裂）').toBeDefined()
  expect(opts.smoothAllowed, 'smoothAllowed 未注入（缺陷① 防线缺失）').toBeTypeOf('function')
  return { wrapper, opts }
}

describe('MessageStream → useVirtuaFollow smoothAllowed 接线（缺陷① F1）', () => {
  it('TC-1 全部回合静止：smoothAllowed() === true（门开，胶囊点击保留平滑）', async () => {
    const { wrapper, opts } = await mountAndCapture('sess-smooth-gate-1', [
      msg('u1', 'user', 'q1', 'complete'),
      msg('a1', 'assistant', 'r1', 'complete'),
    ])
    expect(opts.smoothAllowed!()).toBe(true)
    wrapper.unmount()
  })

  it('TC-2 末位回合 streaming：smoothAllowed() === false（流式增长期拦 smooth）', async () => {
    const { wrapper, opts } = await mountAndCapture('sess-smooth-gate-2', [
      msg('u1', 'user', 'q1', 'complete'),
      msg('a1', 'assistant', 'r1', 'streaming'),
    ])
    expect(opts.smoothAllowed!()).toBe(false)
    wrapper.unmount()
  })

  it('TC-3 streaming 回合退居非末位（bash↔streaming 双工作态）：smoothAllowed() === false——改回末位单点判定的回归在此变红', async () => {
    const { wrapper, opts } = await mountAndCapture('sess-smooth-gate-3', [
      msg('u1', 'user', 'q1', 'complete'),
      msg('a1', 'assistant', 'r1 long bash work', 'streaming'),
      msg('u2', 'user', 'q2', 'complete'),
    ])
    expect(opts.smoothAllowed!()).toBe(false)
    wrapper.unmount()
  })

  it('TC-4 streaming 翻 complete：门随数据替换开（同 mount 内观察响应性）', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const chat = useChatStore()
    const messages = (status: Message['status']): Message[] => [
      msg('u1', 'user', 'q1', 'complete'),
      msg('a1', 'assistant', 'r1', status),
    ]
    chat.setMessages('sess-smooth-gate-4', messages('streaming'))
    const before = capturedFollowOpts.length
    const wrapper = mount(MessageStream, { props: { sessionId: 'sess-smooth-gate-4' }, global: { plugins: [pinia] } })
    await nextTick()
    const opts = capturedFollowOpts[before]
    expect(opts.smoothAllowed!()).toBe(false)
    chat.setMessages('sess-smooth-gate-4', messages('complete'))
    await nextTick()
    await nextTick()
    expect(opts.smoothAllowed!()).toBe(true)
    wrapper.unmount()
  })
})
