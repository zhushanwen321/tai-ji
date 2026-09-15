/**
 * W3 composer fork 模式红灯测试（TDD：实现缺失，测试必须 fail）。
 *
 * 覆盖 U12-U14：
 * - U12 forkMode 三重视觉 + chip + placeholder（fork-mode class + mode-chip + placeholder 切换）
 * - U13 forkMode 发送后自动退出（调 forkSessionAsk + forkMode ref 复位 false）
 * - U14 Esc 退出 + 切 session 自动退出
 *
 * 红灯预期：Composer 当前无 forkMode ref / enterForkMode 方法，下列用例应全 fail。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-fork-mode.test.ts
 *
 * 范式参照 composer-three-states.test.ts：mock useChat/useNewTaskFlow/api + stub 子组件 +
 * ComposerInput mock（defineExpose + emit keydown/input）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'
import { useChatStore } from '@/stores/chat'

// ── mock useChat（send 等 spy）──
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
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, setPendingModel: vi.fn() }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })) },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
}))
// main 合并引入 useProjectSkills/useGlobalSkills（landing skill），与 fork 测试无关，stub 掉
vi.mock('@/composables/features/settings/useProjectSkills', () => ({
  useProjectSkills: () => ({ projectSkills: [] }),
  useGlobalSkills: () => ({ globalSkills: [] }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))
// ── mock useSidebar：forkSessionAsk（W2 新增，当前不存在）──
const forkSessionAskMock = vi.fn(() => Promise.resolve())
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSessionAsk: forkSessionAskMock, forkSession: vi.fn() }),
}))

// ── ComposerInput mock：defineExpose + emit（同 composer-three-states 范式）──
const lastInputText = ref('')
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  props: {
    placeholder: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
  },
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
    expose({
      clear: vi.fn(),
      setText: vi.fn(),
      insertSlashChip: vi.fn(),
      getSegments: () => textToSegments(lastInputText.value),
      getText: () => lastInputText.value,
      moveCaretVertical: () => 'edge',
    })
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

import Composer from '@/components/panel/Composer.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
})

function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
  return mount(Composer, { props, global: { stubs: otherStubs } })
}

/** 构造 ⌘/Ctrl + key 的 KeyboardEvent（fork 用 ⌘G 触发；Esc 用 Escape） */
function keyEvent(key: string, opts: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    metaKey: !!opts.meta,
    ctrlKey: !!opts.ctrl,
    shiftKey: !!opts.shift,
    bubbles: true,
    cancelable: true,
  })
}

// ── U12：forkMode 三重视觉 + chip + placeholder ─────────────────────────
describe('U12：forkMode 三重视觉 + mode-chip + placeholder 切换', () => {
  it('enterForkMode 后容器含 fork-mode class + mode-chip DOM', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    // enterForkMode 是 W3 新增方法（defineExpose 或组件实例方法）
    // 当前不存在 → vm.enterForkMode 为 undefined → 调用抛 TypeError（红灯）
    const vm = wrapper.vm as unknown as { enterForkMode?: (sessionId: string, messageId: string) => void }
    expect(typeof vm.enterForkMode).toBe('function')
    vm.enterForkMode!('s1', 'm1')
    await wrapper.vm.$nextTick()

    const box = wrapper.find('[data-testid="composer-box"]')
    // 容器含 fork-mode class（三重视觉之一）
    expect(box.classes()).toContain('fork-mode')
    // mode-chip DOM 存在（标识当前为 fork 提问模式）
    expect(wrapper.find('[data-testid="composer-mode-chip"]').exists()).toBe(true)
  })

  it('enterForkMode 后 placeholder 切换为 fork 提问文案', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    const vm = wrapper.vm as unknown as { enterForkMode?: (sessionId: string, messageId: string) => void }
    vm.enterForkMode!('s1', 'm1')
    await wrapper.vm.$nextTick()

    // ComposerInput mock 不渲染 placeholder 属性文本，断言 props 透传的 placeholder 变化
    const input = wrapper.findComponent(ComposerInputMock)
    // fork 模式 placeholder 应不同于普通 inputHint（含「提问」/「fork」语义）
    const placeholderProp = input.props('placeholder') as string
    expect(placeholderProp).not.toContain('描述你想让 AI 做什么')
    // fork 提问文案应含 fork/提问 语义关键词之一
    expect(/fork|提问/i.test(placeholderProp)).toBe(true)
  })
})

// ── U13：forkMode 发送后自动退出 ─────────────────────────────────────────
describe('U13：forkMode 下发送 → 调 forkSessionAsk + forkMode 自动复位 false', () => {
  it('fork 模式下发送 → 在新分支提问并退出 fork 模式', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    const vm = wrapper.vm as unknown as {
      enterForkMode?: (sessionId: string, messageId: string) => void
      forkMode?: { value: boolean }
    }
    vm.enterForkMode!('s1', 'm1')
    await wrapper.vm.$nextTick()

    // 输入
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '追问那条回复')
    await wrapper.vm.$nextTick()
    // Enter 发送（fork 模式下不 isActive，走 onSend → forkSessionAsk）
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', keyEvent('Enter'))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // forkSessionAsk 被调（而非 send）
    expect(forkSessionAskMock).toHaveBeenCalled()
    expect(chatApiMock.send).not.toHaveBeenCalled()
    // forkMode ref 复位 false
    expect(vm.forkMode?.value).toBe(false)
  })
})

// ── U14：Esc 退出 + 切 session 自动退出 ──────────────────────────────────
describe('U14：Esc 退出 + 切 session 自动退出 forkMode', () => {
  it('forkMode 下按 Esc → forkMode 复位 false', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    const vm = wrapper.vm as unknown as {
      enterForkMode?: (sessionId: string, messageId: string) => void
      forkMode?: { value: boolean }
    }
    vm.enterForkMode!('s1', 'm1')
    await wrapper.vm.$nextTick()
    expect(vm.forkMode?.value).toBe(true)

    // 按 Esc（经 ComposerInput keydown 事件）
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', keyEvent('Escape'))
    await wrapper.vm.$nextTick()

    expect(vm.forkMode?.value).toBe(false)
  })

  it('forkMode 下切 session（sessionId 变化）→ forkMode 自动复位 false', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    const vm = wrapper.vm as unknown as {
      enterForkMode?: (sessionId: string, messageId: string) => void
      forkMode?: { value: boolean }
    }
    vm.enterForkMode!('s1', 'm1')
    await wrapper.vm.$nextTick()
    expect(vm.forkMode?.value).toBe(true)

    // 切 session：改 sessionId prop
    await wrapper.setProps({ sessionId: 's2' })
    await wrapper.vm.$nextTick()

    expect(vm.forkMode?.value).toBe(false)
  })
})

// ── U15：streaming 中 fork 模式（staging 优先于 steer，本次修复核心）────────
describe('U15：streaming 中 fork 模式：Enter 提交 fork 而非 steer，发送位替换 stop', () => {
  /** 制造 streaming：真实 chat store 写入 message_start → isGenerating=true → isActive=true */
  function makeStreaming(sid: string): void {
    const chat = useChatStore()
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
  }

  it('streaming + fork 模式 Enter → forkSessionAsk 被调，steer 不被调（草稿不注入当前对话）', async () => {
    const sid = 's-stream-fork'
    makeStreaming(sid)
    const wrapper = mountComposer({ sessionId: sid })
    expect(useChatStore().isActive(sid)).toBe(true) // 前置：session 确在 streaming

    const vm = wrapper.vm as unknown as { enterForkMode?: (sessionId: string, messageId: string) => void }
    vm.enterForkMode!('s1', 'm1')
    await wrapper.vm.$nextTick()

    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'fork 那条回复去问')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', keyEvent('Enter'))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(forkSessionAskMock).toHaveBeenCalledWith(
      's1', 'm1', 'fork 那条回复去问', expect.anything(),
    )
    expect(chatApiMock.steer).not.toHaveBeenCalled()
    expect(chatApiMock.send).not.toHaveBeenCalled()
  })

  it('streaming + fork 模式 → 发送位显示 fork 发送按钮，stop 按钮被替换', async () => {
    const sid = 's-stream-btn'
    makeStreaming(sid)
    const wrapper = mountComposer({ sessionId: sid })
    const vm = wrapper.vm as unknown as { enterForkMode?: (sessionId: string, messageId: string) => void }
    vm.enterForkMode!('s1', 'm1')
    await wrapper.vm.$nextTick()

    // staging 完全替换：fork 发送按钮存在，stop 消失（用户决策：需停止时先 Esc 退出 staging）
    expect(wrapper.find('[data-testid="fork-send-btn"]').exists()).toBe(true)
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
  })

  it('streaming 无 staging → stop 按钮行为不变（回归守卫）', () => {
    const sid = 's-stream-plain'
    makeStreaming(sid)
    const wrapper = mountComposer({ sessionId: sid })

    expect(wrapper.find('.stop-btn').exists()).toBe(true)
    expect(wrapper.find('[data-testid="fork-send-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="handoff-send-btn"]').exists()).toBe(false)
  })

  it('streaming + fork 模式 Alt+Enter → 仍提交 fork（不走 followUp）', async () => {
    const sid = 's-stream-alt'
    makeStreaming(sid)
    const wrapper = mountComposer({ sessionId: sid })
    const vm = wrapper.vm as unknown as { enterForkMode?: (sessionId: string, messageId: string) => void }
    vm.enterForkMode!('s1', 'm1')
    await wrapper.vm.$nextTick()

    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'alt 提交')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit(
      'keydown', new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }),
    )
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(forkSessionAskMock).toHaveBeenCalled()
    expect(chatApiMock.followUp).not.toHaveBeenCalled()
  })
})

// ── U16：canSubmit 派生守卫（staging 双发锁 / streaming 放行 / 空稿规则）────────
describe('U16：canSubmit 派生值——staging 只看 isSending，非 staging 看 isBusy', () => {
  function makeStreaming(sid: string): void {
    const chat = useChatStore()
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
  }

  it('staging 活跃 + streaming（isActive）+ 有输入 → true（fork 提交不受流式拦截）', async () => {
    const sid = 's-can-submit-1'
    makeStreaming(sid)
    const wrapper = mountComposer({ sessionId: sid })
    const vm = wrapper.vm as unknown as {
      enterForkMode: (sid: string, messageId: string) => void
      canSubmit?: boolean
    }
    vm.enterForkMode('s1', 'm1')
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'fork 提问')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(vm.canSubmit).toBe(true)
    expect(wrapper.find('[data-testid="fork-send-btn"]').attributes('disabled')).toBeUndefined()
  })

  it('staging 活跃 + isSending（双发锁）→ false', async () => {
    // forkSessionAsk 挂起 → handleForkSend 置 isSending=true 未回落
    forkSessionAskMock.mockImplementationOnce(() => new Promise(() => {}))
    const sid = 's-can-submit-2'
    const wrapper = mountComposer({ sessionId: sid })
    const vm = wrapper.vm as unknown as {
      enterForkMode: (sid: string, messageId: string) => void
      canSubmit?: boolean
    }
    vm.enterForkMode('s1', 'm1')
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'in-flight 内容')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', keyEvent('Enter'))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(vm.canSubmit).toBe(false)
    // isSending 分支接管发送位：staging 发送按钮消失（换 spinner）
    expect(wrapper.find('[data-testid="fork-send-btn"]').exists()).toBe(false)
  })

  it('非 staging + isBusy（streaming）+ 有输入 → false（canSend 原守卫不回归）', async () => {
    const sid = 's-can-submit-3'
    makeStreaming(sid)
    const wrapper = mountComposer({ sessionId: sid })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '普通输入')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    const vm = wrapper.vm as unknown as { canSubmit?: boolean }
    expect(vm.canSubmit).toBe(false)
  })

  it('fork / handoff staging（allowsEmptySend=true）空稿 → true', async () => {
    const wrapper = mountComposer({ sessionId: 's-can-submit-4' })
    const vm = wrapper.vm as unknown as {
      enterForkMode: (sid: string, messageId: string) => void
      exitForkMode: () => void
      enterHandoffMode: () => void
      canSubmit?: boolean
    }
    // fork 允许空提交（空 content 退化为纯 fork，不发送首条 user）——见 fork-mode.ts allowsEmptySend
    vm.enterForkMode('s1', 'm1')
    await wrapper.vm.$nextTick()
    expect(vm.canSubmit).toBe(true)
    vm.exitForkMode()
    await wrapper.vm.$nextTick()
    vm.enterHandoffMode()
    await wrapper.vm.$nextTick()
    expect(vm.canSubmit).toBe(true) // handoff 允许空 reply
  })
})
