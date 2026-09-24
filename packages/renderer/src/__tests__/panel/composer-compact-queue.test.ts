/**
 * Composer 队列区 UI 集成测试（compact-queued-messages W2 → 投递所有权内核 u3c 迁移）。
 *
 * [u3c/D7 迁移] 原断言（compact 期间 Enter → 本地入队 + flush 提交 + `/`·`!` 拒绝入队）随
 * 「renderer 只提交不判定」（D1）与 defer 队列退役整体改写：
 * - 发送：占用期（compacting）Enter / 发送按钮 → 与 idle 同路径的**统一提交**（useChat.send
 *   → 乐观气泡 + delivery.submit），lane 由 runtime 内核判定（queued/steer 由内核承接）；
 *   占用期不再有 `/`·`!` 例外拒绝分支（命令文本与 idle 态同语义，bash/slash 守卫不变）。
 * - 队列区：数据源 = session.delivery 帧投影（core getDeliveryProjectionRef），真 QueueBubble
 *   渲染 → 行可见 + 状态 chip（排队中/投递中/发送失败）
 * - × 撤销：真 QueueBubble 点击 → useQueueRows.onCancelEntry → delivery.cancel RPC；
 *   成功回草稿（cancel reply 全文 + segments → ComposerInput.setText）
 * - failed 行重试钮：点击 → delivery.resync 单条重报
 *
 * 策略（对齐 composer-bash-mode.test.ts 结构范本）：
 * - 真 pinia + 真 chatStore（occupancy 投影驱动发送位与 sessionPhase）
 * - 真 QueueBubble / 真 useQueueRows（DOM 断言面）+ mock useChat（spy 化 send/steer/...）
 * - mock '@/api/domains/delivery'（cancel/resync RPC 断言面）+ useToast（断言 toastError）
 * - mock ComposerInput（emit input 设 draft + emit keydown Enter 触发 onSend；expose
 *   setText/getSegments 供撤销回草稿断言）
 * - 帧到达模拟：直接写 core 投影 ref（帧消费链路由 core useChat handler 承担，u3b 已覆盖）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-compact-queue.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'
import { getDeliveryProjectionRef } from '@taiji/core'
import type { DeliveryFrameEntry } from '@taiji/core'
import { useChatStore } from '@/stores/chat'

// ── mock useChat（spy 化 send / steer / followUp / compact）+ useToast + delivery 域 ──
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
const deliveryMock = vi.hoisted(() => ({
  cancelDelivery: vi.fn(),
  resyncDelivery: vi.fn(),
  drainDelivery: vi.fn(),
}))

vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => chatApiMock,
  resetChatModuleState: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMock,
}))
vi.mock('@/api/domains/delivery', () => ({ delivery: deliveryMock }))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, setPendingModel: vi.fn(), currentCwd: ref(null) }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
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
    const setText = vi.fn((text: string) => {
      lastInputText.value = text
    })
    expose({ clear, setText, insertSlashChip: vi.fn(), getText: () => lastInputText.value, getSegments: () => textToSegments(lastInputText.value) })
    return { clear, setText }
  },
  template: '<div data-testid="composer-input" />',
})

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
// QueueBubble 不 stub：队列区 DOM 断言走真组件（单源化后行渲染是 u3c 验收面）
const otherStubs = {
  ComposerInput: ComposerInputMock,
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
}

import Composer from '@/components/panel/Composer.vue'
// resetChatModuleState 来自被 mock 的 useChat 模块（vi.fn，测试隔离占位）
import { resetChatModuleState } from '@/composables/features/chat/useChat'

/** 写投递投影（模拟内核 session.delivery 帧到达后的投影状态） */
function setProjection(sid: string, entries: DeliveryFrameEntry[]): void {
  const projection = getDeliveryProjectionRef()
  const next = new Map(projection.value)
  next.set(sid, entries)
  projection.value = next
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
  getDeliveryProjectionRef().value = new Map()
  deliveryMock.cancelDelivery.mockResolvedValue({ clientUuid: 'u-1', cancelled: true, content: '被撤销的文本' })
  deliveryMock.resyncDelivery.mockResolvedValue({ sessionId: 's1', deduped: [] })
  resetChatModuleState()
})

function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
  return mount(Composer, { props, global: { stubs: otherStubs } })
}

/** 模拟用户输入文本（不触发发送；按钮路径 TC12 复用） */
async function typeText(wrapper: ReturnType<typeof mountComposer>, text: string): Promise<void> {
  wrapper.findComponent(ComposerInputMock).vm.$emit('input', text)
  await wrapper.vm.$nextTick()
}

/** 模拟用户输入文本 + Enter 发送（mods 透传 KeyboardEventInit，如 Alt+⏎） */
async function typeAndEnter(
  wrapper: ReturnType<typeof mountComposer>,
  text: string,
  mods: KeyboardEventInit = {},
): Promise<void> {
  await typeText(wrapper, text)
  wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter', ...mods }))
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick() // onSend 是 async，需 flush
}

describe('Composer compact 期间发送（u3c/D1：统一提交，占用不拦截）', () => {
  it('TC11: compact 期间 ⏎ → 走统一提交（useChat.send）+ 输入清空 + 发送位 queue 态', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, 'hello')

    // 统一提交：占用期不再本地判定车道（lane 归内核），提交链与 idle 同路径
    expect(chatApiMock.send).toHaveBeenCalledWith('s1', textToSegments('hello'))
    expect(chatApiMock.steer).not.toHaveBeenCalled()
    // 输入已清空（clearInput → ComposerInput.clear）
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
    // DOM：发送位为 queue 态（时钟角标按钮）
    expect(wrapper.find('.queue-send-btn').exists()).toBe(true)
  })

  it('TC12: compact 期间发送按钮点击 → 统一提交（按钮可点非 spinner，title=排队发送 · ⏎）', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeText(wrapper, 'world')

    const sendBtn = wrapper.find('.queue-send-btn')
    expect(sendBtn.exists()).toBe(true)
    expect(sendBtn.attributes('title')).toBe('排队发送 · ⏎')
    expect(sendBtn.attributes('disabled')).toBeUndefined()

    await sendBtn.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(chatApiMock.send).toHaveBeenCalledWith('s1', textToSegments('world'))
  })

  it('TC17: compact 态无输入 → 发送按钮 disabled + title=sendHint + 点击不提交', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    await wrapper.vm.$nextTick()

    const sendBtn = wrapper.find('[title="输入内容后发送"]')
    expect(sendBtn.exists()).toBe(true)
    expect(sendBtn.attributes('disabled')).toBeDefined()

    await sendBtn.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(chatApiMock.send).not.toHaveBeenCalled()
  })

  it('TC18: compact 期间 Alt+⏎ → 统一提交（非 steer 路由行，不 followUp）', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, 'alt-msg', { altKey: true })

    // sendRoute 在 compacting 行是 queued（UI 预测）→ Alt+⏎ 走统一提交；followUp 不被调
    expect(chatApiMock.followUp).not.toHaveBeenCalled()
    expect(chatApiMock.send).toHaveBeenCalledWith('s1', textToSegments('alt-msg'))
  })
})

describe('Composer 队列区单源渲染 + 撤销 / 重试（u3c/D7 + V9/V10）', () => {
  it('帧投影到达 → 真 QueueBubble 渲染行（状态 chip = 排队中 / 投递中，用户可见）', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(false)

    setProjection('s1', [
      { clientUuid: 'u-a', preview: '第一条排队消息', state: 'queued', lane: 'queued' },
      { clientUuid: 'u-b', preview: '第二条投递中', state: 'in-flight', lane: 'steer' },
    ])
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('第一条排队消息')
    expect(wrapper.text()).toContain('排队中')
    expect(wrapper.text()).toContain('第二条投递中')
    expect(wrapper.text()).toContain('投递中')
  })

  it('direct 车道与已 delivered 条目不出现在队列区（气泡原位 / 已入流）', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    setProjection('s1', [
      { clientUuid: 'u-d', preview: 'direct 待确认气泡', state: 'in-flight', lane: 'direct' },
      { clientUuid: 'u-x', preview: '已送达', state: 'delivered', lane: 'steer' },
    ])
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="queue-bubble"]').exists()).toBe(false)
  })

  it('V9 撤销：点击 × → delivery.cancel(sid, clientUuid) + 文本回输入框（setText DOM 载体）', async () => {
    deliveryMock.cancelDelivery.mockResolvedValueOnce({
      clientUuid: 'u-a',
      cancelled: true,
      content: '被撤销的文本',
      segments: [{ type: 'text', text: '被撤销的文本' }],
    })
    const wrapper = mountComposer({ sessionId: 's1' })
    setProjection('s1', [{ clientUuid: 'u-a', preview: '被撤销的文本', state: 'queued', lane: 'queued' }])
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-testid="queue-cancel-u-a"]').trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(deliveryMock.cancelDelivery).toHaveBeenCalledWith('s1', 'u-a')
    // 草稿回填：空输入态 → restoreSegments 整段恢复（ComposerInput.setText = 输入框可见内容）
    expect(wrapper.findComponent(ComposerInputMock).vm.setText).toHaveBeenCalledWith('被撤销的文本')
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('V10 不可撤（cancelled=false）→ toast 反馈，不回草稿', async () => {
    deliveryMock.cancelDelivery.mockResolvedValueOnce({ clientUuid: 'u-a', cancelled: false, reason: 'already delivered' })
    const wrapper = mountComposer({ sessionId: 's1' })
    setProjection('s1', [{ clientUuid: 'u-a', preview: '已交付的消息', state: 'in-flight', lane: 'steer' }])
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-testid="queue-cancel-u-a"]').trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(toastMock.error).toHaveBeenCalledWith('无法撤销：already delivered')
    expect(wrapper.findComponent(ComposerInputMock).vm.setText).not.toHaveBeenCalled()
  })

  it('failed 行 → 重试钮可见；点击 → delivery.resync 单条重报', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    setProjection('s1', [{ clientUuid: 'u-f', preview: '重试耗尽的文本', state: 'failed', lane: 'queued' }])
    await wrapper.vm.$nextTick()

    // DOM：红色标识 + 重试钮
    expect(wrapper.find('[data-testid="queue-state-u-f"]').text()).toBe('发送失败')
    const retry = wrapper.find('[data-testid="queue-retry-u-f"]')
    expect(retry.exists()).toBe(true)

    await retry.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(deliveryMock.resyncDelivery).toHaveBeenCalledWith('s1', ['u-f'])
  })
})
