/**
 * MessageStream 单条渲染项错误边界测试（RD-2#1 / code-harden RD-2）。
 *
 * 覆盖（验收 ③：注入抛错 item，断言占位行出现且其余 item 正常渲染）：
 * - 注入 render 抛错的 Turn → StreamItemBoundary 占位行出现 + 其余 item 正常渲染
 *   + 错误被边界拦截（全局 errorHandler 零调用）+ 边界 console.error 记录
 * - 修复数据后点「重试」→ 占位行消失、该 item 恢复渲染（slot 重挂载语义）
 * - 正常项的稳定 :key 挂在边界 vnode 上（M5 stable-key 回归锚，renderKey 空间不变）
 * - buildStreamViewItems 单项求值抛错降级 broken 项（slot 表达式前置求值第一道防线）
 *
 * harness 复用 MessageStream-kind.test.ts 的 virtua 全量渲染 mock（happy-dom 无布局）。
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/MessageStream.render-error.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, h, reactive } from 'vue'
import { useChatStore } from '@/stores/chat'
import MessageStream from '@/components/panel/MessageStream.vue'
import { buildStreamViewItems } from '@/components/panel/message-stream/stream-view-items'
import type { Message } from '@taiji/shared'
import type { MessageTurn } from '@taiji/core/domain/chat'
import type { SkillNoticeStreamItem } from '@/composables/panel/useSkillNoticeStream'

// ── virtua mock：Virtualizer → 全量渲染 scoped slot 的 stub（同 MessageStream-kind）──────
const slotKeyCollector = vi.hoisted(() => ({ keys: [] as (string | number | symbol | null | undefined)[][] }))

vi.mock('virtua/vue', async () => {
  const { defineComponent } = await import('vue')
  const { vi: vitest } = await import('vitest')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: {
        data: { type: Array, default: () => [] },
        keepMounted: { type: Array, default: () => [] },
        scrollRef: { type: Object, default: null },
      },
      setup() {
        return {
          scrollSize: 600,
          scrollOffset: 0,
          viewportSize: 400,
          cache: {},
          scrollToIndex: vitest.fn(),
          getItemOffset: vitest.fn(() => 0),
          getItemSize: vitest.fn(() => 200),
          findItemIndex: vitest.fn(() => 0),
          scrollTo: vitest.fn(),
          scrollBy: vitest.fn(),
        }
      },
      render(ctx) {
        const data = ctx.data as unknown[]
        const indexes = new Set<number>((ctx.keepMounted as number[]) ?? [])
        for (let i = 0; i < data.length; i += 1) indexes.add(i)
        return h(
          'div',
          { class: 'mock-virtualizer' },
          [...indexes].flatMap((idx) => {
            const slot = ctx.$slots.default as ((p: unknown) => unknown[]) | undefined
            const vnodes = slot?.({ item: data[idx], index: idx }) ?? []
            slotKeyCollector.keys.push((vnodes as Array<{ key?: string | null }>).map((v) => v.key))
            return vnodes as never[]
          }),
        )
      },
    }),
  }
})

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

// happy-dom 不提供真实 ResizeObserver 布局测量
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Turn stub：turn.user.content 命中 POISON 且毒开关开 → render 抛错（注入坏渲染项） */
const poison = reactive({ on: true })
const PoisonTurnStub = defineComponent({
  name: 'Turn',
  props: { turn: { type: Object, required: true } },
  setup(props) {
    const userContent = computed(() => {
      const t = props.turn as { user?: { content?: string } }
      return t.user?.content
    })
    return () => {
      if (poison.on && userContent.value === 'POISON') {
        throw new Error('render boom: poisoned turn')
      }
      return h('div', { 'data-testid': `turn-stub-${(props.turn as { index?: number }).index}` })
    }
  },
})

const globalStubs = {
  Turn: PoisonTurnStub,
  SystemNotice: { name: 'SystemNotice', template: '<div data-testid="system-notice-stub" />' },
  BashOutputBlock: { name: 'BashOutputBlock', template: '<div data-testid="bash-output-stub" />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
}

function makeMsg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    role: 'user',
    content: '',
    status: 'complete',
    timestamp: Date.now(),
    ...over,
  } as Message
}

function mountStream(sessionId: string, onError?: (err: unknown) => void) {
  return mount(MessageStream, {
    props: { sessionId },
    global: {
      stubs: globalStubs,
      // errorHandler 收集器：断言边界把错误拦在组件级（return false 不升级到全局）
      ...(onError ? { config: { errorHandler: onError } } : {}),
    },
    attachTo: document.body,
  })
}

describe('MessageStream — 单条渲染项错误边界（RD-2#1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
    poison.on = true
    slotKeyCollector.keys.length = 0
  })

  it('注入 render 抛错的 item：占位行出现、其余 item 正常渲染、全局 errorHandler 零调用', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-rd21', [
      makeMsg({ id: 'u1', content: 'normal question' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'normal answer' }),
      makeMsg({ id: 'u2', content: 'POISON' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'poisoned answer' }),
    ])
    const globalErrors: unknown[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const wrapper = mountStream('sess-rd21', (e) => { globalErrors.push(e) })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 坏 item → 边界占位行；好 item → 正常渲染
    expect(wrapper.find('[data-testid="stream-item-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="turn-stub-1"]').exists()).toBe(true)
    // 错误被边界拦截：不升级全局（RD-2#1 验收核心断言）
    expect(globalErrors).toHaveLength(0)
    expect(errSpy).toHaveBeenCalled()
    // 稳定 key 挂在分支根 vnode（renderKey = t-<首条消息 id> 空间不变，M5 回归锚）。
    // mock 每次 slot 调用收集一组（每项恰 1 个边界 vnode），flat 后逐项断言。
    const allKeys = slotKeyCollector.keys.flat()
    expect(allKeys).toContain('t-u1')
    expect(allKeys).toContain('t-u2')
    wrapper.unmount()
    errSpy.mockRestore()
  })

  it('修复数据后点重试：占位行消失、该 item 恢复渲染（slot 重挂载）', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-rd21-retry', [
      makeMsg({ id: 'u1', content: 'POISON' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'poisoned answer' }),
    ])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mountStream('sess-rd21-retry')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="stream-item-error"]').exists()).toBe(true)

    // 数据修复（坏渲染原因消除）→ 点重试 → slot 重挂载恢复渲染
    poison.on = false
    await wrapper.find('[data-testid="stream-item-error-retry"]').trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="stream-item-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="turn-stub-1"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('buildStreamViewItems — slot 表达式前置求值（RD-2#1 第一道防线）', () => {
  afterEach(() => { vi.restoreAllMocks() })

  function turnFixture(over: Partial<MessageTurn>): MessageTurn {
    return {
      index: 0,
      user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: 0 } as Message,
      assistants: [],
      isStreaming: false,
      ...over,
    } as MessageTurn
  }

  it('正常项：key/canEdit/isLastTurn/preview 前置算好（canEdit 只落最后 user turn）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const items = [
      { kind: 'turn', turn: turnFixture({ index: 0, user: { id: 'u1', role: 'user', content: 'first', status: 'complete', timestamp: 0 } as Message }) },
      { kind: 'turn', turn: turnFixture({ index: 1, user: { id: 'u2', role: 'user', content: 'last', status: 'complete', timestamp: 0 } as Message }) },
    ] as unknown as SkillNoticeStreamItem[]
    const views = buildStreamViewItems(items, 1, items[1]!.turn as MessageTurn)
    expect(views.map((v) => v.key)).toEqual(['t-u1', 't-u2'])
    expect(views[0]).toMatchObject({ kind: 'turn', canEdit: false, isLastTurn: false })
    expect(views[1]).toMatchObject({ kind: 'turn', canEdit: true, isLastTurn: true, preview: 'last' })
  })

  it('单项求值抛错（turn 缺失）→ broken 占位项（1:1 不删位），不炸整个列表构建', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const items = [
      { kind: 'turn', turn: undefined } as unknown as SkillNoticeStreamItem,
      { kind: 'turn', turn: turnFixture({}) } as unknown as SkillNoticeStreamItem,
    ]
    const views = buildStreamViewItems(items, 0, null)
    expect(views).toHaveLength(2)
    expect(views[0]).toMatchObject({ kind: 'broken', key: 'broken-0' })
    expect(views[1]).toMatchObject({ kind: 'turn', key: 't-u1' })
  })
})
