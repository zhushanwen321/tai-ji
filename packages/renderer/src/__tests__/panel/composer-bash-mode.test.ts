/**
 * Composer bash 模式集成测试（composer-bash-execute W2）。
 *
 * 验证：
 * - T6: draft='!ls -la' Enter → sendBash('ls -la', false)，send 未被调
 * - T7: draft='!!git status' Enter → sendBash('git status', true)
 * - T8: draft='!' Enter → sendBash 未被调（空命令不提交，保持 bash 模式）
 * - T9: draft 从 'hello' 变 '!ls' → composer-box 获得 composer-bash-mode class
 *
 * 策略：
 * - 真 pinia + 真 chatStore（isActive 派生驱动 onSend 分流守卫）
 * - mock useChat（spy 化 send/sendBash/steer/abort...）
 * - mock ComposerInput（emit input 设 draft + emit keydown Enter 触发 onSend，getSegments 还原 text 段）
 * - 子组件 stub
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-bash-mode.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'

// ── mock useChat（spy 化 send / sendBash）──
const chatApiMock = {
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  followUp: vi.fn(() => Promise.resolve()),
  abort: vi.fn(() => Promise.resolve()),
  compact: vi.fn(() => Promise.resolve()),
  editAndResend: vi.fn(),
  hydrateHistory: vi.fn(),
  sendBash: vi.fn(() => Promise.resolve()),
  abortBash: vi.fn(() => Promise.resolve()),
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

// ── ComposerInput mock：emit input 设 draft + emit keydown Enter 触发 onSend ──
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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
})

function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
  return mount(Composer, { props, global: { stubs: otherStubs } })
}

/** 模拟用户输入文本 + Enter 发送 */
async function typeAndEnter(wrapper: ReturnType<typeof mountComposer>, text: string): Promise<void> {
  wrapper.findComponent(ComposerInputMock).vm.$emit('input', text)
  await wrapper.vm.$nextTick()
  wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick() // onSend 是 async，需 flush
}

describe('Composer bash 模式（! / !! 前缀分流）', () => {
  it('T6: draft="!ls -la" Enter → sendBash("ls -la", false)，send 未被调', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, '!ls -la')

    expect(chatApiMock.sendBash).toHaveBeenCalledOnce()
    expect(chatApiMock.sendBash).toHaveBeenCalledWith('s1', 'ls -la', false)
    // 普通发送未触发（bash 分流短路）
    expect(chatApiMock.send).not.toHaveBeenCalled()
  })

  it('T7: draft="!!git status" Enter → sendBash("git status", true)（excludeFromContext）', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, '!!git status')

    expect(chatApiMock.sendBash).toHaveBeenCalledOnce()
    expect(chatApiMock.sendBash).toHaveBeenCalledWith('s1', 'git status', true)
  })

  it('T8: draft="!" Enter → sendBash 未被调（空命令不提交，保持 bash 模式）', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, '!')

    expect(chatApiMock.sendBash).not.toHaveBeenCalled()
    expect(chatApiMock.send).not.toHaveBeenCalled()
  })

  it('T9: draft 从 "hello" 变 "!ls" → composer-box 获得 composer-bash-mode class', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    const box = () => wrapper.find('[data-testid="composer-box"]')

    // 普通输入：无 bash class
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'hello')
    await wrapper.vm.$nextTick()
    expect(box().classes()).not.toContain('composer-bash-mode')

    // bash 前缀：出现 composer-bash-mode
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '!ls')
    await wrapper.vm.$nextTick()
    expect(box().classes()).toContain('composer-bash-mode')
  })

  /**
   * [W6/S10 PR#116 review] trySendBash 失败时不恢复 draft（已知限制）。
   *
   * useChat.sendBash 内部已 try/catch + toast 且不重抛（与 send/abort/compact 对称），
   * 故 trySendBash 不再 try/catch + restoreInput。失败时草稿不恢复——错误已通过 toast 消化。
   * 本用例锁死该契约：sendBash resolve 后 clearInput 已执行（草稿清空），ComposerInput
   * 的 setText（restore 入口）未被调用。
   */
  it('W6: sendBash resolve 后 clearInput 已清空，setText（恢复入口）未被调', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    const input = wrapper.findComponent(ComposerInputMock)
    await typeAndEnter(wrapper, '!ls -la')

    expect(chatApiMock.sendBash).toHaveBeenCalledOnce()
    expect(chatApiMock.sendBash).toHaveBeenCalledWith('s1', 'ls -la', false)
    // clearInput 被调（乐观 UI：提交前已清空 draft）
    expect(input.vm.clear).toHaveBeenCalled()
    // setText 是 restoreInput 的底层入口（useComposerRestore.restoreInput → inputRef.setText），
    // sendBash resolve 路径下不应被调（无恢复语义）
    expect(input.vm.setText).not.toHaveBeenCalled()
  })
})
