/**
 * useChat 集成测试（T1.4/T1.5/T5.1）—— send 全链 + 失败回滚 + editAndResend pendingSend 对称。
 *
 * T1.4: idle + send(text) → appendUser + addPendingSend + api.send → message_start → clearPendingSend
 * T1.5: send + api.send reject → clearPendingSend（[W2] 不 throw，toast 消化错误）
 * T5.1: editAndResend → truncate + appendUser + addPendingSend + send, catch → clearPendingSend
 *
 * [MANDATORY] 集成用例补 DOM 断言：mount(Composer) 验证 send 全链/失败后 composer-box 可见 + 用户可重试态。
 *
 * 运行：npx vitest run src/__tests__/stores/chat-integration-send.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage } from '@taiji/shared'
import { textToSegments, normalizeContent } from '@taiji/shared'

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
  file: {
    read: vi.fn(() => Promise.resolve({ content: '', truncated: false })),
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

// mount(Composer) 用例：mock 较深依赖（useChat 保留真实，验证 send 全链行为）
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

describe('T1.4 useChat.send 全链', () => {
  it('send(text) → appendUser + addPendingSend + api.send → message_start → clearPendingSend', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-fullchain', textToSegments('hello'))
    // 1. appendUser：消息列表有 user 气泡
    const msgs = chat.getMessages('s-fullchain')
    expect(msgs.some((m) => m.role === 'user' && normalizeContent(m.content) === 'hello')).toBe(true)
    // 2. addPendingSend：isActive=true（空窗期）
    expect(chat.isActive('s-fullchain')).toBe(true)
    // 3. api.send 被调（图片走路径模式，send 第二参数 promptText，无 images 通道）
    // 纯文本轮不加 clientUuid 标记后缀（最小写入：textToSegments 降级渲染等价，无需映射）
    // 第 4 参 options.clientUuid（session-occupancy D2）经 ChatApiPort 适配转发，等于乐观气泡 id
    expect(apiMock.send).toHaveBeenCalledWith(
      's-fullchain',
      'hello',
      undefined,
      { clientUuid: msgs.find((m) => m.role === 'user')!.id },
    )
    // 4. message_start 到达 → clearPendingSend
    emit({ type: 'message.message_start', payload: { sessionId: 's-fullchain', messageId: 'a1' } })
    // message_start 后 isGenerating=true（streaming entity 存在），isActive 仍 true
    expect(chat.isGenerating('s-fullchain')).toBe(true)
    expect(chat.isActive('s-fullchain')).toBe(true)
  })
})

describe('T1.5 send api.send 失败回滚', () => {
  it('api.send reject → clearPendingSend（[W2] 不 throw，toast 消化错误）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    apiMock.send.mockRejectedValueOnce(new Error('ws disconnected'))
    // [W2] send 失败不再 throw（与 steer/followUp/abort 对齐：clearPendingSend + toast，不 throw）；
    // [form-hang-fix] send 契约 Promise<boolean>：直发失败已 toast 消化 → true（false 仅属 B 策略）
    await expect(send('s-fail', textToSegments('hello'))).resolves.toBe(true)
    // clearPendingSend：isActive 恢复 false（无 streaming entity + 无 pendingSend）
    expect(chat.isActive('s-fail')).toBe(false)
  })
})

describe('T5.1 editAndResend pendingSend 对称', () => {
  it('editAndResend → truncate + appendUser + addPendingSend + send', async () => {
    const session = useSessionStore()
    session.activeId = 's-edit'
    const chat = useChatStore()
    // 先注入历史消息（供 truncateFrom 操作）
    chat.appendUser('s-edit', textToSegments('原问题'))
    const userMsg = chat.getMessages('s-edit').find((m) => m.role === 'user')!
    const { editAndResend } = useChat()
    // 阶段 3a：editAndResend 签名从 (sid, id, text: string) 改为 (sid, id, segments: Segment[])，
    // 内部委托 submitSegments（走 segmentsToPrompt + chatApi.send）。
    await editAndResend('s-edit', userMsg.id, textToSegments('edited text'))
    // api.send 被调（editAndResend 内部走 submitSegments → chatApi.send）
    // 纯文本轮不加 clientUuid 标记后缀（最小写入，与 send 同通路）
    // 第 4 参 options.clientUuid（session-occupancy D2）= 编辑重发的新乐观气泡 id
    const resentUserMsg = chat.getMessages('s-edit').filter((m) => m.role === 'user').at(-1)!
    expect(apiMock.send).toHaveBeenCalledWith('s-edit', 'edited text', undefined, {
      clientUuid: resentUserMsg.id,
    })
    // addPendingSend：isActive=true（空窗期）
    expect(chat.isActive('s-edit')).toBe(true)
  })

  it('editAndResend api.send 失败 → clearPendingSend（[W2] 不 throw，不留孤儿）', async () => {
    const session = useSessionStore()
    session.activeId = 's-edit-fail'
    const chat = useChatStore()
    chat.appendUser('s-edit-fail', textToSegments('原问题'))
    const userMsg = chat.getMessages('s-edit-fail').find((m) => m.role === 'user')!
    apiMock.send.mockRejectedValueOnce(new Error('ws disconnected'))
    const { editAndResend } = useChat()
    // [W2] editAndResend 失败不再 throw（与 steer/followUp/abort 对齐）
    await expect(editAndResend('s-edit-fail', userMsg.id, textToSegments('text'))).resolves.toBeUndefined()
    // 失败后 pendingSend 被清（isActive=false，无 streaming）
    expect(chat.isActive('s-edit-fail')).toBe(false)
  })

  it('editAndResend guard：busy 时早退（isActive=true 不执行）', async () => {
    const session = useSessionStore()
    session.activeId = 's-edit-busy'
    const chat = useChatStore()
    chat.addPendingSend('s-edit-busy')
    expect(chat.isActive('s-edit-busy')).toBe(true)
    const { editAndResend } = useChat()
    // busy 时早退，不 throw，不调 send
    await expect(editAndResend('s-edit-busy', 'msg-id', textToSegments('text'))).resolves.toBeUndefined()
    expect(apiMock.send).not.toHaveBeenCalled()
  })
})

/**
 * [MANDATORY] 集成用例 DOM 断言：mount(Composer) 验证 send 全链/失败的用户可见行为。
 *
 * 走真实 useChat().send → Composer.onSend → store 状态驱动 DOM 三态渲染。
 * 断言用户可见 DOM（composer-box / stop-btn / 发送按钮）随 store 状态变化。
 */
describe('T1.4/T1.5 send 全链 Composer DOM 断言（用户可见行为）', () => {
  function mountComposer(sessionId: string) {
    return mount(Composer, { props: { sessionId }, global: { stubs: otherStubs } })
  }

  it('send 后 message_start 到达 → Composer 转停止按钮态（DOM 可见）', async () => {
    const session = useSessionStore()
    session.activeId = 's-dom-start'
    // idle 态先挂载：显示发送按钮、无停止按钮
    const wrapper = mountComposer('s-dom-start')
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
    // 用户输入 → Enter 触发真实 useChat.send（走 mock api.send → resolve）
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '第一条消息')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
    // flushPromises 排空全部 microtask（send 链路 + Vue render job），不依赖固定 nextTick 计数
    // ——U24/U25 onSend phase extraction（commit 8c9e2da43）的 async helper 包装使 render flush
    // 晚一个 microtask hop（详见 chat-send-rejected.test.ts 同注释）。
    await flushPromises()
    // message_start 到达 → isGenerating=true → isActive=true
    emit({ type: 'message.message_start', payload: { sessionId: 's-dom-start', messageId: 'a1' } })
    await flushPromises()
    // DOM 断言：停止按钮可见（用户可中断当前回合）
    expect(wrapper.find('.stop-btn').exists()).toBe(true)
  })

  it('send 失败后 Composer 回到可重试态（composer-box 可见 + 无停止按钮）', async () => {
    const session = useSessionStore()
    session.activeId = 's-dom-fail'
    const chat = useChatStore()
    // api.send reject（useChat.send 内部 catch + clearPendingSend，[W2] 不 throw）
    apiMock.send.mockRejectedValueOnce(new Error('ws disconnected'))
    const wrapper = mountComposer('s-dom-fail')
    // 用户输入 → Enter 触发 send
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '要发的消息')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
    // flushPromises 排空全部 microtask（含 submitSegments await chatApi.send 的 reject + catch
    // + clearPendingSend 后的 render flush），不依赖固定 nextTick 计数（同上注释）。
    await flushPromises()
    // store 侧：pendingSend 已清，无 streaming → isActive=false（用户可重试）
    expect(chat.isActive('s-dom-fail')).toBe(false)
    await flushPromises()
    // DOM 断言 1：composer-box 仍渲染（输入区未消失）
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    // DOM 断言 2：无停止按钮（非活跃态，用户可重新发送）
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
  })
})
