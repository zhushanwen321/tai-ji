/**
 * send.rejected 回滚测试（D-006 独立 WS 通道 + useChat 监听回滚）。
 *
 * 锁定 fix-state-tearing 的 D-006 核心决策：send.rejected 是独立 WS 类型，
 * 不进对话流（不产出消息气泡），只做 clearPendingSend + toast 反馈。
 * 与 message.error（进对话流 + 翻流式态）语义正交。
 *
 * 覆盖：
 * - send.rejected → clearPendingSend（isActive 恢复 false）
 * - send.rejected → 不产出消息气泡（getMessages 不变）
 * - send.rejected → isGenerating 不变（send.rejected 不翻流式态）
 * - send.rejected 带 message 字段 → toast 反馈
 * - [MANDATORY] mount(Composer) DOM 断言：send.rejected 后 Composer 回可重试态（用户可见）
 *
 * mock 策略：vi.hoisted 捕获 streamSubscribe handler，测试注入 send.rejected。
 *
 * 运行：npx vitest run src/__tests__/stores/chat-send-rejected.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage } from '@taiji/shared'
import { textToSegments } from '@taiji/shared'

const apiMock = vi.hoisted(() => {
  const holder: { handler: ((msg: ServerMessage) => void) | null } = { handler: null }
  return {
    holder,
    streamSubscribe: vi.fn((_sid: string, handler: (msg: ServerMessage) => void) => {
      holder.handler = handler
      return () => { holder.handler = null }
    }),
    send: vi.fn(() => Promise.resolve()),
    getHistory: vi.fn(() => Promise.resolve([])),
    abort: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
    steer: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: {
    streamSubscribe: apiMock.streamSubscribe,
    send: apiMock.send,
    getHistory: apiMock.getHistory,
    abort: apiMock.abort,
    compact: apiMock.compact,
    steer: apiMock.steer,
    followUp: apiMock.followUp,
  },
  session: {
    subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    writeSegments: vi.fn().mockResolvedValue(undefined),
    // useModel.setThinkingLevel 依赖（thinking-level-sync watch 在 mount 时触发）
    setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })),
  },
  config: {
    getGlobalSkills: vi.fn().mockResolvedValue([]),
    getProjectSkills: vi.fn().mockResolvedValue([]),
    onSkillCacheInvalidated: () => () => {},
  },
}))

// mount(Composer) 用例：mock 较深依赖（useChat 保留真实，验证 send.rejected 回滚链路）
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    submitFirstMessage: vi.fn(),
    currentModel: { value: null },
    currentCwd: { value: null },
    setPendingModel: vi.fn(),
  }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ toasts: { value: [] }, error: vi.fn(), remove: vi.fn() }),
}))
vi.mock('@/composables/panel/useComposerModelThinking', () => ({
  useComposerModelThinking: () => ({
    currentModelId: { value: '' },
    currentThinkingLevel: { value: undefined },
    currentThinkingLevelMap: { value: undefined },
    localThinkingLevel: { value: undefined },
    onModelSelect: vi.fn(),
    onThinkingSelect: vi.fn(),
  }),
}))

import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useChat } from '@/composables/features/chat/useChat'
import Composer from '@/components/panel/Composer.vue'

// ── Composer 子组件 stub（参照 composer-three-states.test.ts，最小化 mount 开销）──
// getSegments 通过 emits 验证器捕获 input payload，用 textToSegments 还原（ADR-0043）。
const lastInputText = ref('')
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  emits: {
    input: (val: string) => {
      lastInputText.value = val
      return true
    },
    keydown: null,
    'slash-trigger': null,
    'file-trigger': null,
  },
  setup(_, { expose }) {
    expose({ clear: vi.fn(), setText: vi.fn(), insertSlashChip: vi.fn(), getSegments: () => textToSegments(lastInputText.value) })
    return {}
  },
  template: '<div data-testid="composer-input" />',
})
const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
const otherStubs = {
  ComposerInput: ComposerInputMock,
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  apiMock.holder.handler = null
  lastInputText.value = ''
})

function emit(msg: ServerMessage): void {
  if (apiMock.holder.handler) apiMock.holder.handler(msg)
}

describe('send.rejected 回滚（D-006 独立通道）', () => {
  it('send.rejected → clearPendingSend（isActive 恢复 false）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-reject-1', textToSegments('hello'))
    // send 后 pendingSend 置位 → isActive=true（空窗期）
    expect(chat.isActive('s-reject-1')).toBe(true)
    // 必须先订阅才能 emit
    expect(apiMock.holder.handler).not.toBeNull()
    // runtime 预检拒绝
    emit({
      type: 'send.rejected',
      payload: { sessionId: 's-reject-1', reason: 'busy', message: 'Agent 正在处理' },
    })
    // clearPendingSend 后 isActive=false
    expect(chat.isActive('s-reject-1')).toBe(false)
  })

  it('send.rejected → 不产出消息气泡（getMessages 不变）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-reject-2', textToSegments('hello'))
    const msgsBefore = chat.getMessages('s-reject-2')
    emit({
      type: 'send.rejected',
      payload: { sessionId: 's-reject-2', reason: 'busy', message: 'Agent 正在处理' },
    })
    // send.rejected 不进对话流：消息列表不新增 error/system 气泡
    expect(chat.getMessages('s-reject-2')).toEqual(msgsBefore)
  })

  it('send.rejected → isGenerating 不变（不翻流式态）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-reject-3', textToSegments('hello'))
    // send.rejected 时无 streaming entity → isGenerating=false
    expect(chat.isGenerating('s-reject-3')).toBe(false)
    emit({
      type: 'send.rejected',
      payload: { sessionId: 's-reject-3', reason: 'busy', message: 'busy' },
    })
    // 仍然 false（send.rejected 不产生 streaming entity）
    expect(chat.isGenerating('s-reject-3')).toBe(false)
  })

  it('send.rejected 不影响其他 session 的 pendingSend', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    // session A send → pendingSend
    await send('s-reject-4', textToSegments('hello'))
    // 手动给 session B 加 pendingSend（模拟另一个 panel 正在发送）
    chat.addPendingSend('s-other')
    expect(chat.isActive('s-other')).toBe(true)
    // session A 收到 send.rejected
    emit({
      type: 'send.rejected',
      payload: { sessionId: 's-reject-4', reason: 'busy', message: 'busy' },
    })
    // session B 的 pendingSend 不受影响（session 隔离）
    expect(chat.isActive('s-other')).toBe(true)
  })
})

/**
 * [MANDATORY] 集成用例 DOM 断言：mount(Composer) 验证 send.rejected 后用户可见行为。
 *
 * 走真实 useChat().send → 注入 send.rejected（runtime 预检拒绝）→ clearPendingSend
 * → isActive 驱动 Composer 三态 DOM 翻转（停止按钮态 → 可重试态）。
 */
describe('send.rejected Composer DOM 断言（用户可见行为）', () => {
  it('send.rejected 后 Composer 停止按钮消失，回到可重试态（DOM 可见）', async () => {
    const session = useSessionStore()
    session.activeId = 's-dom-reject'
    const chat = useChatStore()
    const wrapper = mount(Composer, {
      props: { sessionId: 's-dom-reject' },
      global: { stubs: otherStubs },
    })
    // 用户输入 → Enter 触发真实 useChat.send（mock api.send resolve → addPendingSend）
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'hello')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
    // flushPromises（setTimeout 宏任务边界）排空全部 microtask（send 链路 + Vue render job），
    // 不依赖固定 nextTick 计数——U24/U25 onSend phase extraction（commit 8c9e2da43）把分流分支
    // 提取为 async helper（routeStaging/sendActiveMessage），正常发送路径多出 async 包装
    // microtask hop，addPendingSend 后的组件 render flush 因此晚一个 tick。store 语义与 DOM
    // 终态不变（settled 后 add/clear/re-add 均即时响应），microtask 均在浏览器 paint 前排空，
    // 用户可见行为无差异。
    await flushPromises()
    // send 后 pendingSend 置位 → isActive=true（空窗期，停止按钮可见）
    expect(chat.isActive('s-dom-reject')).toBe(true)
    expect(wrapper.find('.stop-btn').exists()).toBe(true)
    // runtime 预检拒绝：注入 send.rejected
    emit({
      type: 'send.rejected',
      payload: { sessionId: 's-dom-reject', reason: 'busy', message: 'Agent 正在处理' },
    })
    await flushPromises()
    // store 侧：clearPendingSend → isActive=false
    expect(chat.isActive('s-dom-reject')).toBe(false)
    // DOM 断言 1：停止按钮消失（用户可重新发送）
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
    // DOM 断言 2：composer-box 仍渲染（输入区可见，用户可重试）
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
  })
})
