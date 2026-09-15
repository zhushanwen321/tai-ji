/**
 * Composer 三态 UI + B 策略 E2E 测试（T2.2/T2.3/T2.5/T9.14）。
 *
 * 锁定 fix-state-tearing 的 UI 层核心：
 * - D-001 B 策略：busy 时 Enter / 点发送位 → 调 steer（不调 send）
 * - T2.5：busy 时停止按钮始终可见（isActive 驱动 v-if="isActive"）
 * - T9.14：Composer 三态渲染回归（idle=发送按钮 / sending=spinner / busy=停止按钮）
 *
 * 策略：
 * - 真实 chat store（测的就是 store 的派生 isActive 行为）
 * - mock useChat（send/steer/abort/followUp/compact/editAndResend），保留 spy 断言调用
 * - mock useNewTaskFlow（landing 态 submitFirstMessage）
 * - 子组件 stub（CommandPopover 保留 slot，其余空 div）
 * - ComposerInput mock：defineExpose + emit keydown/input（用于触发 Enter → steer）
 *
 * 运行：npx vitest run src/__tests__/panel/composer-three-states.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'

// ── mock useChat（spy 化 send/steer/abort）──
const chatApiMock = {
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  followUp: vi.fn(() => Promise.resolve()),
  abort: vi.fn(() => Promise.resolve()),
  compact: vi.fn(() => Promise.resolve()),
  editAndResend: vi.fn(),
  hydrateHistory: vi.fn(),
}
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => chatApiMock,
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, setPendingModel: vi.fn(), currentCwd: ref(null) }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })) },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
  config: { getGlobalSkills: vi.fn().mockResolvedValue([]), getProjectSkills: vi.fn().mockResolvedValue([]), onSkillCacheInvalidated: () => () => {} },
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))

// ── ComposerInput mock：defineExpose + emit ──
// 追踪 input 事件携带的文本（Composer.onSend/onSteer 调 inputRef.getSegments() 取结构化 segments）。
// 通过 emits 验证器捕获 input payload，getSegments 用 textToSegments 还原（ADR-0043）。
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
    const clear = vi.fn()
    const setText = vi.fn()
    expose({ clear, setText, insertSlashChip: vi.fn(), getSegments: () => textToSegments(lastInputText.value) })
    return { clear, setText }
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

import Composer from '@/components/panel/Composer.vue'
import { useChatStore } from '@/stores/chat'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
})

function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
  return mount(Composer, { props, global: { stubs: otherStubs } })
}

describe('T9.14 Composer 三态渲染回归', () => {
  it('idle 态：显示发送按钮（ArrowUp），无停止按钮', () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    // idle：无 stop-btn，有发送按钮
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
    // 发送位是 Button（最后一个 Button）
    const sendBtn = wrapper.findAll('button').at(-1)
    expect(sendBtn?.attributes('title')).toContain('发送')
  })

  it('busy 态（isActive=true）：显示停止按钮，无发送按钮', () => {
    const chat = useChatStore()
    const sid = 's-busy'
    // 制造 streaming entity → isGenerating=true → isActive=true
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    const wrapper = mountComposer({ sessionId: sid })
    expect(chat.isActive(sid)).toBe(true)
    // 停止按钮存在
    expect(wrapper.find('.stop-btn').exists()).toBe(true)
    // 无发送按钮（v-if isActive 互斥）
    const buttons = wrapper.findAll('button')
    const sendBtns = buttons.filter((b) => b.attributes('title')?.includes('发送'))
    expect(sendBtns.length).toBe(0)
  })

  it('pendingSend 态（isActive=true via pendingSend）：停止按钮也可见', () => {
    const chat = useChatStore()
    const sid = 's-pending'
    chat.addPendingSend(sid)
    const wrapper = mountComposer({ sessionId: sid })
    expect(chat.isActive(sid)).toBe(true)
    expect(wrapper.find('.stop-btn').exists()).toBe(true)
  })
})

describe('T2.5 busy 时停止按钮始终可见', () => {
  it('streaming + pendingSend 同时存在：停止按钮仍只有一个', () => {
    const chat = useChatStore()
    const sid = 's-both'
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    chat.addPendingSend(sid)
    const wrapper = mountComposer({ sessionId: sid })
    expect(wrapper.findAll('.stop-btn')).toHaveLength(1)
  })
})

describe('T2.2 B 策略：busy 时 Enter → steer（不调 send）', () => {
  it('busy 时 Enter → 调 steer，不调 send', async () => {
    const chat = useChatStore()
    const sid = 's-steer-enter'
    // 制造 busy 态
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    const wrapper = mountComposer({ sessionId: sid })
    expect(chat.isActive(sid)).toBe(true)

    // 输入文本（让 hasInput=true，steer guard 放行）
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '补充内容')
    await wrapper.vm.$nextTick()

    // 模拟 Enter 键
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick() // steer 是 async，需 flush

    expect(chatApiMock.steer).toHaveBeenCalledWith('s-steer-enter', textToSegments('补充内容'))
    expect(chatApiMock.send).not.toHaveBeenCalled()
  })
})

describe('T2.3 B 策略：idle 时 Enter → send', () => {
  it('idle 时 Enter → 调 send，不调 steer', async () => {
    const wrapper = mountComposer({ sessionId: 's-send-enter' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '第一条消息')
    await wrapper.vm.$nextTick()

    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    // u5b D6 分发器（core dispatch/send）onSend 是多层 async 链（routeSteer → routeStaging →
    // sendActiveMessage → trySendBash，约 4 个 microtask 拍才到 deps.send）——两拍 nextTick
    // 不够 flush，必须 flushPromises 清空整条 microtask 链后再断言
    await flushPromises()

    expect(chatApiMock.send).toHaveBeenCalledWith('s-send-enter', textToSegments('第一条消息'))
    expect(chatApiMock.steer).not.toHaveBeenCalled()
  })
})

describe('T2.x IME composition 中 Enter 不触发 send/steer', () => {
  it('idle 态 composition 中 Enter 不触发 send', async () => {
    const wrapper = mountComposer({ sessionId: 's-ime-idle' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '你好')
    await wrapper.vm.$nextTick()

    // compositionstart（模拟中文输入法开始）
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown',
      new KeyboardEvent('keydown', { key: 'Process' }))
    // Enter + isComposing: true（拼音未确认）
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown',
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 不应调 send
    expect(chatApiMock.send).not.toHaveBeenCalled()
    expect(chatApiMock.steer).not.toHaveBeenCalled()
  })

  it('idle 态 composition 结束后 Enter 正常 send', async () => {
    const wrapper = mountComposer({ sessionId: 's-ime-idle-end' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '你好世界')
    await wrapper.vm.$nextTick()

    // compositionstart → Enter (isComposing, 不触发)
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown',
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))
    await wrapper.vm.$nextTick()
    expect(chatApiMock.send).not.toHaveBeenCalled()

    // compositionend → 正常 Enter (isComposing=false, 触发 send)
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown',
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: false }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    // 同上：D6 分发器 async 链需 flushPromises 清空后才到 deps.send
    await flushPromises()

    expect(chatApiMock.send).toHaveBeenCalledWith('s-ime-idle-end', textToSegments('你好世界'))
  })

  it('busy 态 composition 中 Enter 不触发 steer', async () => {
    const chat = useChatStore()
    const sid = 's-ime-busy'
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    const wrapper = mountComposer({ sessionId: sid })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '补充')
    await wrapper.vm.$nextTick()

    // composition 中 Enter → 不触发 steer
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown',
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(chatApiMock.steer).not.toHaveBeenCalled()
    expect(chatApiMock.send).not.toHaveBeenCalled()
  })
})

describe('停止按钮点击 → abort', () => {
  it('busy 态点停止按钮 → 调 abort', async () => {
    const chat = useChatStore()
    const sid = 's-abort'
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    const wrapper = mountComposer({ sessionId: sid })
    await wrapper.find('.stop-btn').trigger('click')
    expect(chatApiMock.abort).toHaveBeenCalled()
  })
})
