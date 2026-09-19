// @vitest-environment jsdom
// [U1 sanitize] DOMPurify 需要 nodeName getter 在 Node.prototype 上（realm 安全缓存 getter
// 依赖它）；happy-dom 把 nodeName 定义在各元素子类，DOMPurify 3.4.11 在 happy-dom 下把
// 所有元素判为不允许标签（P1 探针实证）——markdown 管线测试族统一跑 jsdom。
/**
 * [u4d-truncated-ui] MessageStream 历史预算截断顶部条接线测试（D4 /
 * 场景 T3 / 验收 A5/A6 的单测回归面）。
 *
 * 必测断言（三视角 DOM，挂载真实 MessageStream + 真实 TruncatedHistoryBar）：
 * ① truncated=true → 顶部条渲染「已加载最近 N 轮」+「加载更早」按钮可见
 * ② truncated=false → 顶部条不存在（A6 回归：普通 session 无任何截断提示）
 * ③ 点击「加载更早」→ 既有 loadMoreHistory 通路被调（mock useChat 断言；core 侧
 *   [u6] 游标翻页调用断言见 core __tests__/truncated-window.test.ts——原 getFullHistory
 *   全量通路已退役）
 *
 * mock 边界对齐 MessageStream-kind.test.ts：virtua（happy-dom 无布局）、ChatViewDeps 装配器、
 * useChat 编排（showLoadMore 的 store→hasMoreHistory 派生链由 core truncated-window.test.ts
 * 覆盖；本测断言壳层 v-if/文案/点击路由）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/MessageStream-truncated-bar.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@taiji/shared'

// ── virtua mock：全量渲染 scoped slot 的 stub（happy-dom 无布局，见 kind 测试同款）──
vi.mock('virtua/vue', async () => {
  const { defineComponent, h } = await import('vue')
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
          scrollToIndex: vi.fn(),
          getItemOffset: vi.fn(() => 0),
          getItemSize: vi.fn(() => 200),
          findItemIndex: vi.fn(() => 0),
          scrollTo: vi.fn(),
          scrollBy: vi.fn(),
        }
      },
      render(ctx) {
        const data = ctx.data as unknown[]
        const indexes = new Set<number>((ctx.keepMounted as number[]) ?? [])
        for (let i = 0; i < data.length; i += 1) indexes.add(i)
        return h(
          'div',
          { class: 'mock-virtualizer' },
          [...indexes].flatMap((idx) => ctx.$slots.default?.({ item: data[idx], index: idx }) ?? []),
        )
      },
    }),
  }
})

// loadMoreHistory spy：必测③ 断言点击「加载更早」路由到既有 load-more 通路
const loadMoreHistoryMock = vi.hoisted(() => vi.fn())
const hasMoreMock = vi.hoisted(() => ({ value: false }))

vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    editAndResend: vi.fn(),
    loadMoreHistory: loadMoreHistoryMock,
    hasMoreHistory: () => hasMoreMock.value,
  }),
  resetChatModuleState: vi.fn(),
}))

// 壳 deps mock（MessageStream 装配 useChatViewDeps，本测不关心块渲染）
const chatDepsMock = vi.hoisted(() => ({
  getMessages: vi.fn(() => []),
  isActive: vi.fn(() => false),
  isHandingOff: vi.fn(() => false),
  getChangeSetStatus: vi.fn(() => undefined),
  isExpanded: vi.fn(() => false),
  isTakeover: vi.fn(() => false),
  isPendingSend: vi.fn(() => false),
  toggleExpand: vi.fn(),
  collapse: vi.fn(),
  setTakeover: vi.fn(),
  abortBash: vi.fn(),
  editAndResend: vi.fn(),
  onFork: vi.fn(),
  onForkAsk: vi.fn(),
  onHandoff: vi.fn(),
  onHandoffAsk: vi.fn(),
  openDrawer: vi.fn(),
  onFileClick: vi.fn(),
  onAmbiguousSelect: vi.fn(),
  loadFileCandidates: vi.fn(() => Promise.resolve([])),
  renderMarkdown: vi.fn(() => Promise.resolve([])),
  renderMermaid: vi.fn(() => Promise.resolve({ svg: '' })),
  toMarkdown: vi.fn(() => ''),
}))
vi.mock('@/composables/panel/useChatViewDeps', () => ({
  useChatViewDeps: () => chatDepsMock,
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn(), abortHandoff: vi.fn() }),
}))

import MessageStream from '@/components/panel/MessageStream.vue'
import { useChatStore } from '@/stores/chat'

const SID = 'sess-truncated-bar'

function makeMsg(id: string): Message {
  return { id, role: 'user', content: `msg-${id}`, status: 'complete', timestamp: Date.now() }
}

function mountStream() {
  return mount(MessageStream, {
    props: { sessionId: SID },
    global: {
      stubs: {
        Turn: { name: 'Turn', props: { turn: { type: Object, required: true } }, template: '<div data-testid="turn-stub" />' },
        SystemNotice: { name: 'SystemNotice', template: '<div data-testid="system-notice-stub" />' },
        BashOutputBlock: { name: 'BashOutputBlock', template: '<div data-testid="bash-output-stub" />' },
        ForkNotice: { name: 'ForkNotice', template: '<div />' },
        SkillNoticeInline: { name: 'SkillNoticeInline', template: '<div />' },
      },
    },
    attachTo: document.body,
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  loadMoreHistoryMock.mockReset()
  hasMoreMock.value = false
})

describe('MessageStream 截断顶部条（u4d）', () => {
  it('必测① truncated=true：渲染「已加载最近 20 轮」+「加载更早」按钮可见', () => {
    const store = useChatStore()
    store.hydrate(SID, [makeMsg('m1')])
    // 截断窗口状态（hydrate 接线产物；core 侧字段断言见 truncated-window.test.ts）
    store.setHistoryWindow(SID, { truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    hasMoreMock.value = true

    const wrapper = mountStream()
    const bar = wrapper.find('[data-testid="truncated-history-bar"]')
    expect(bar.exists()).toBe(true)
    // 用户可见文案（N = loadedTurns，zh-CN locale）
    expect(wrapper.find('[data-testid="truncated-history-info"]').text()).toBe('已加载最近 20 轮')
    // 「加载更早」入口可见且可点
    const btn = wrapper.find('[data-testid="load-more-history"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('加载更早')
    wrapper.unmount()
  })

  it('必测② truncated=false：顶部条不存在（A6 回归）', () => {
    const store = useChatStore()
    store.hydrate(SID, [makeMsg('m1')])
    store.setHistoryWindow(SID, { truncated: false, loadedTurns: 20, totalTurnsEstimate: 20 })
    hasMoreMock.value = false

    const wrapper = mountStream()
    expect(wrapper.find('[data-testid="truncated-history-bar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="load-more-history"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('必测③ 点击「加载更早」→ loadMoreHistory(sessionId) 被调（[u6] 游标翻页通路入口）', async () => {
    const store = useChatStore()
    store.hydrate(SID, [makeMsg('m1')])
    store.setHistoryWindow(SID, { truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    hasMoreMock.value = true
    loadMoreHistoryMock.mockResolvedValue(undefined)

    const wrapper = mountStream()
    await wrapper.find('[data-testid="load-more-history"]').trigger('click')
    expect(loadMoreHistoryMock).toHaveBeenCalledTimes(1)
    expect(loadMoreHistoryMock).toHaveBeenCalledWith(SID)
    wrapper.unmount()
  })
})
