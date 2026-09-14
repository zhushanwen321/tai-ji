/**
 * subagent.directive live 广播 → 聊天流定向气泡 DOM 集成测试（U2b，§3.3.3a live 链路）。
 *
 * 全链路（真实段）：core createUseChat 的会话级订阅 handler（subagent.directive 分支）→
 * renderer pinia chatStore（appendSubagentDirective）→ MessageStream 渲染 → SystemNotice
 * 定向气泡 DOM。唯一 mock：chatApi RPC 层（streamSubscribe 捕获 handler 供测试 emit 广播）
 * 与 MessageStream 的外围壳依赖（virtua / useChatViewDeps / useChat / useSidebar，
 * 对齐 MessageStream-kind.test.ts 模式）——数据与渲染链路全部真实。
 *
 * 覆盖：
 * - 匹配 sid 的 subagent.directive 广播 → 聊天流出现「@slug：text」定向气泡 DOM
 * - 不匹配 sid 的广播 → 不出现（ADR-0049 per-session 隔离，架构约定 7）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/SubagentDirectiveStream.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createUseChat, resetChatModuleStateForTest } from '@xyz-agent/core'
import type { ChatStoreInstance, UseChatDeps } from '@xyz-agent/core'
import type { ServerMessage, Segment } from '@xyz-agent/shared'
import { useChatStore } from '@/stores/chat'
import MessageStream from '@/components/panel/MessageStream.vue'

// ── virtua mock：Virtualizer → 全量渲染 scoped slot 的 stub（对齐 MessageStream-kind.test.ts；
//    happy-dom 无真实布局，真 <Virtualizer> viewportSize=0 不渲染任何项）──
vi.mock('virtua/vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: { data: { type: Array, default: () => [] } },
      setup() {
        return {
          scrollSize: 600,
          scrollOffset: 0,
          viewportSize: 400,
          cache: {},
          scrollToIndex: vi.fn(),
          getItemOffset: vi.fn(() => 0),
          getItemSize: vi.fn(() => 200),
          findItemIndex: vi.fn(() => 0),
          scrollTo: vi.fn(),
          scrollToItem: vi.fn(),
          scrollBy: vi.fn(),
        }
      },
      render(ctx: { data: unknown[]; $slots: { default?: (args: { item: unknown; index: number }) => unknown[] } }) {
        return h(
          'div',
          { class: 'mock-virtualizer' },
          ctx.data.map((item, index) => ctx.$slots.default?.({ item, index }) ?? []),
        )
      },
    }),
  }
})

// ── 壳依赖 mock（对齐 kind 测试；MessageStream 消息读取走真 pinia chatStore，不经这些 mock）──
vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    editAndResend: vi.fn(),
    loadMoreHistory: vi.fn(),
    hasMoreHistory: () => false,
  }),
  resetChatModuleState: vi.fn(),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn(), abortHandoff: vi.fn() }),
}))

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** stub 仅外围组件；SystemNotice 刻意不 stub——定向气泡 DOM 是断言对象 */
const globalStubs = {
  Turn: { name: 'Turn', template: '<div data-testid="turn-stub" />' },
  BashOutputBlock: { name: 'BashOutputBlock', template: '<div />' },
  TurnRail: { name: 'TurnRail', template: '<div />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
  Button: { name: 'Button', template: '<button><slot /></button>' },
}

interface Fixture {
  useChat: ReturnType<typeof createUseChat>
  chatStore: ReturnType<typeof useChatStore>
  subagentAction: ReturnType<typeof vi.fn>
  emit: (sid: string, m: ServerMessage) => void
  mountStream: () => ReturnType<typeof mount>
  dispose: () => void
}

function makeFixture(sid: string): Fixture {
  const scope = effectScope(true)
  const streamHandlers = new Map<string, (m: ServerMessage) => void>()
  const chatStore = scope.run(() => useChatStore())!
  const chatApi = {
    send: vi.fn().mockResolvedValue(undefined),
    subagentAction: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    bash: vi.fn().mockResolvedValue(undefined),
    abortBash: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
    streamSubscribe: vi.fn((s: string, h: (m: ServerMessage) => void) => {
      streamHandlers.set(s, h)
      return () => streamHandlers.delete(s)
    }),
  }
  const deps: UseChatDeps = {
    chatApi,
    writeSegments: vi.fn().mockResolvedValue(undefined),
    // pinia store → core ChatStoreInstance 的类型鸿沟 cast（renderer useChat.ts 同款，运行时等价）
    getChatStore: () => chatStore as unknown as ChatStoreInstance,
    getSessionStore: () => ({ applySnapshot: vi.fn() }),
    // [session-dead 第三环] warning：defer 重投熔断提示的注入面（本用例不触发）
    toast: { error: vi.fn(), warning: vi.fn() },
    t: (k: string) => k,
    getCompactQueue: () => ({ flush: vi.fn().mockResolvedValue(true) }),
  }
  const useChat = createUseChat(deps)
  return {
    useChat,
    chatStore,
    subagentAction: chatApi.subagentAction,
    emit: (s, m) => streamHandlers.get(s)?.(m),
    mountStream: () =>
      mount(MessageStream, {
        props: { sessionId: sid },
        global: { stubs: globalStubs },
        attachTo: document.body,
      }),
    dispose: () => scope.stop(),
  }
}

function directiveMsg(sid: string, slug: string, text: string): ServerMessage {
  return {
    type: 'subagent.directive',
    payload: { sessionId: sid, subagentId: 'rec-1', slug, direction: 'user', text },
  } as ServerMessage
}

describe('subagent.directive live 广播 → 聊天流定向气泡（U2b 集成）', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    setActivePinia(createPinia())
    resetChatModuleStateForTest()
  })

  it('匹配 sid 的广播 → 聊天流出现「@slug：text」定向气泡 DOM', async () => {
    const sid = 'live-1'
    const f = makeFixture(sid)
    // 定向发送（真实分流链路：subagentAction 而非 send + 建立会话级订阅）
    const segments: Segment[] = [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: '汇报当前进度' },
    ]
    await f.useChat.send(sid, segments)
    expect(f.subagentAction).toHaveBeenCalledTimes(1)
    // runtime 广播到达（extension 留痕 entry 落盘后）
    f.emit(sid, directiveMsg(sid, 'build-api', '汇报当前进度'))
    await flushPromises()

    const wrapper = f.mountStream()
    await nextTick()
    const bubble = wrapper.find('[data-testid="subagent-directive-bubble"]')
    expect(bubble.exists()).toBe(true)
    expect(bubble.find('[data-testid="subagent-directive-slug"]').text()).toBe('@build-api')
    expect(bubble.text()).toContain('汇报当前进度')
    // 定向消息不是对话回合：无 user 气泡 / turn 渲染（主 agent 无新 turn，§3.3.8）
    expect(wrapper.find('[data-testid="turn-stub"]').exists()).toBe(false)
    wrapper.unmount()
    f.dispose()
  })

  it('不匹配 sid 的广播 → 定向气泡不出现（per-session 隔离）', async () => {
    const sid = 'live-2'
    const f = makeFixture(sid)
    await f.useChat.send(sid, [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: 'hi' },
    ])
    // 伪造异 session 广播到达本 session handler（防御层 payload.sessionId 校验）
    f.emit(sid, directiveMsg('other-session', 'build-api', '串台消息'))
    await flushPromises()

    const wrapper = f.mountStream()
    await nextTick()
    expect(wrapper.find('[data-testid="subagent-directive-bubble"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('串台消息')
    wrapper.unmount()
    f.dispose()
  })
})
