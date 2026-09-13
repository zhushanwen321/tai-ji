/**
 * Composer defer 队列 UI 集成测试（compact-queued-messages W2 → session-occupancy u4b/u6b）。
 *
 * 验证（入队行为 + 发送位 queue 态；队列可见性由 composer 上方 QueueBubble 的 defer 行承接——独立 badge
 * 组件已随 u6b/D7 展示统一移除，撤销/预览 UI 由 __tests__/panel/queue-bubble-s8.test.ts 的 defer 行分支覆盖）：
 * - TC11: compact 期间 ⏎ 发送 → 入队 + 输入清空 + 发送位 queue 态（时钟角标按钮）
 * - TC12: compact 期间发送按钮点击 → 入队（按钮可点非 spinner，title=「排队发送 · ⏎」）
 * - TC13: compact 期间 `/` 前缀文本 → 拒绝入队 + toast + draft 保留
 * - TC13b: compact 期间 `!`/`!!` 前缀 bash 命令 → 拒绝入队 + toast + draft 保留（对称于 `/`）
 * - TC15: compacted 成功（flush 清空）→ 提交确认驱动出队
 * - TC16: compacted 失败（队列保留）→ 队列不清
 * - TC17: compact 态无输入 → 发送按钮 disabled + title=sendHint + 点击不入队
 * - TC18: compact 期间 Alt+⏎ → 入队而非 followUp
 * （原 TC14 badge 条数/预览/逐条取消为 badge 专属 UI，随组件移除；× 撤销在
 *   queue-bubble-s8.test.ts 的 defer 行分支覆盖）
 *
 * 策略（对齐 composer-bash-mode.test.ts 结构范本）：
 * - 真 pinia + 真 chatStore（[u5b] isCompacting 由 occupancy 投影派生——驱动方式 =
 *   chat.setOccupancy(sid, { turn:'idle', compacting:true, bash:false })，D6 defer 路由同源）
 * - mock useChat（spy 化 send/steer/followUp/compact...）+ useToast（断言 toastError）
 * - mock ComposerInput（emit input 设 draft + emit keydown Enter 触发 onSend）
 * - stub 子组件；每用例 useCompactQueue()._clearAllForTest() + resetChatModuleState() 隔离
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-compact-queue.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@xyz-agent/shared'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import { useChatStore } from '@/stores/chat'

// ── mock useChat（spy 化 send / steer / followUp / compact）+ useToast ──
const chatApiMock = vi.hoisted(() => ({
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  followUp: vi.fn(() => Promise.resolve()),
  abort: vi.fn(() => Promise.resolve()),
  compact: vi.fn(() => Promise.resolve()),
  editAndResend: vi.fn(),
  hydrateHistory: vi.fn(),
  sendBash: vi.fn(() => Promise.resolve()),
  abortBash: vi.fn(() => Promise.resolve()),
}))
const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }))

vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => chatApiMock,
  resetChatModuleState: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMock,
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, setPendingModel: vi.fn(), currentCwd: ref(null) }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  // chat: useCompactQueue.flush 依赖（TC15 flush 真实路径，非仅 useChat mock）；
  // [u4b] flush 经 submitQueuedEntry 编排（ensureStreamSubscription）需 streamSubscribe
  chat: { send: chatApiMock.send, steer: chatApiMock.steer, streamSubscribe: vi.fn(() => () => {}) },
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
// resetChatModuleState 来自被 mock 的 useChat 模块（vi.fn，测试隔离占位）
import { resetChatModuleState } from '@/composables/features/chat/useChat'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
  // 单例首次创建放 active effect scope（onScopeDispose 注册 cleanup，对齐 W1 测试契约）
  effectScope().run(() => {
    useCompactQueue()
  })
  // 单例跨用例共享，不 reset 会泄漏到下一用例
  useCompactQueue()._clearAllForTest()
  resetChatModuleState()
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

describe('Composer compact 待发队列（TC11-TC18）', () => {
  it('TC11: compact 期间 ⏎ 发送 → 入队 + 输入清空 + 发送位 queue 态', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, 'hello')

    // 入队 'hello'（peek 含该文本）
    expect(useCompactQueue().peek('s1').map((m) => m.text)).toContain('hello')
    // 输入已清空（clearInput → ComposerInput.clear）
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
    // DOM：发送位为 queue 态（时钟角标按钮）
    expect(wrapper.find('.queue-send-btn').exists()).toBe(true)
    // 未走真实发送（send 未被调）
    expect(chatApiMock.send).not.toHaveBeenCalled()
  })

  it('TC12: compact 期间发送按钮点击 → 入队（按钮可点非 spinner，title=排队发送 · ⏎）', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'world')
    await wrapper.vm.$nextTick()

    // 发送位在 compact 态是可点击 queue 按钮（title=queueSend「排队发送 · ⏎」），非 disabled
    const sendBtn = wrapper.find('.queue-send-btn')
    expect(sendBtn.exists()).toBe(true)
    expect(sendBtn.attributes('title')).toBe('排队发送 · ⏎')
    expect(sendBtn.attributes('disabled')).toBeUndefined()

    await sendBtn.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 入队 'world'
    expect(useCompactQueue().peek('s1').map((m) => m.text)).toContain('world')
  })

  it('TC13: compact 期间 `/` 前缀文本 → 拒绝入队 + toast + draft 保留', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, '/compact')

    // 队列为空（enqueue 未被调）+ compact RPC 未被调
    expect(useCompactQueue().count('s1')).toBe(0)
    expect(chatApiMock.compact).not.toHaveBeenCalled()
    // toast 拒绝提示（zh-CN commandQueuedRejected，R3-doc1 泛化：占用维度中性措辞）
    expect(toastMock.error).toHaveBeenCalledWith('会话占用中，命令请等待完成后使用')
    // draft 未清空（clear 未被调）
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).not.toHaveBeenCalled()
  })

  it('TC13b: compact 期间 `!` 前缀 bash 命令 → 拒绝入队 + toast + draft 保留', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, '!ls')

    // 队列为空（enqueue 未被调）+ sendBash 未被调（未静默降级为纯文本，也未执行 bash）
    expect(useCompactQueue().count('s1')).toBe(0)
    expect(chatApiMock.sendBash).not.toHaveBeenCalled()
    // toast 拒绝提示（与 `/` 命令同一文案，zh-CN commandQueuedRejected，R3-doc1 泛化）
    expect(toastMock.error).toHaveBeenCalledWith('会话占用中，命令请等待完成后使用')
    // draft 未清空（clear 未被调）
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).not.toHaveBeenCalled()
  })

  it('TC15: compacted 成功 → flush 提交（确认帧驱动出队）', async () => {
    const chat = useChatStore()
    const queue = useCompactQueue()
    const wrapper = mountComposer({ sessionId: 's1' })
    queue.enqueue('s1', 'm1')
    await wrapper.vm.$nextTick()

    // compacted 成功链路：flush 提交成功（send mock resolve）——[u4b] 提交 ≠ 出队（E2 退役），
    // 条目等确认帧；压缩态结束（[u5b] occupancy compacting=false 驱动）
    await expect(queue.flush('s1')).resolves.toBe(true)
    chat.setOccupancy('s1', { turn: 'idle', compacting: false, bash: false })
    await wrapper.vm.$nextTick()

    expect(queue.count('s1')).toBe(1)

    // 投递确认帧（core ① → confirmDelivery 出队）→ 队列清空
    chat.applyMessageEvent('s1', { type: 'message.message_end', payload: { sessionId: 's1', entry: {
      type: 'message', id: `e-${crypto.randomUUID()}`, parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'm1' }], timestamp: Date.now() },
    } } })
    await wrapper.vm.$nextTick()

    expect(queue.count('s1')).toBe(0)
  })

  it('TC16: compacted 失败（队列保留）→ 队列不清', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const queue = useCompactQueue()
    const wrapper = mountComposer({ sessionId: 's1' })
    queue.enqueue('s1', 'm1')
    await wrapper.vm.$nextTick()
    expect(queue.count('s1')).toBe(1)

    // compacted 失败：压缩态结束但队列未 flush（保留待下次重试；[u5b] 本用例直接驱动
    // store 投影不经 useChat handler，occupancy idle 的 flush 触发在 handler 集成测试覆盖）
    chat.setOccupancy('s1', { turn: 'idle', compacting: false, bash: false })
    await wrapper.vm.$nextTick()

    expect(queue.count('s1')).toBe(1)
  })

  it('TC17: compact 态无输入 → 发送按钮 disabled + title=sendHint + 点击不入队', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    await wrapper.vm.$nextTick()

    // 无输入时 canSend=false：发送位为 disabled Button，title 为 sendHint「输入内容后发送」
    // （TC12 覆盖有输入可点击态 title=queueSend，本用例是负分支）
    const sendBtn = wrapper.find('[title="输入内容后发送"]')
    expect(sendBtn.exists()).toBe(true)
    expect(sendBtn.attributes('disabled')).toBeDefined()

    // 点击不入队（onSend 入口 !canSend 守卫拦截）：count 0
    await sendBtn.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(useCompactQueue().count('s1')).toBe(0)
  })

  it('TC18: compact 期间 Alt+⏎ → 入队而非 followUp', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'alt-msg')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter', altKey: true }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // followUp 未被调（重路由到 onSend → 入队）
    expect(chatApiMock.followUp).not.toHaveBeenCalled()
    expect(useCompactQueue().peek('s1').map((m) => m.text)).toContain('alt-msg')
  })
})
