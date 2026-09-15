/**
 * Composer D6 统一发送分发器集成测试（session-occupancy u5b，验收②）。
 *
 * 锁定（对齐 composer-compact-queue.test.ts 结构范本，真 pinia + 真 chatStore + mount Composer）：
 * - 行 3（turn=generating + compacting，threshold turn 内压缩）Enter → steer（QueueBubble 路径），
 *   不误入 defer 队列——优先级倒挂消除的核心用户可见断言（现状 isActive→onSteer 恰好命中，
 *   但判定收口进分发器后由本测试锁定不回退）
 * - 行 2（turn=dispatching）Enter → steer
 * - 行 4（turn=settling）Enter → defer 入队（pending 气泡可见）——投影驱动（现状该态走直发）
 * - 行 6（bash=true 且 turn=idle）Enter → defer 入队（R3-U4 集成直测——core 纯函数层
 *   已覆盖，此处锁 composer-shell 分发器对 bash 维度的消费不回退）
 * - Alt+⏎ 经分发器：steer 路由行 → followUp（下一轮语义保留）；defer → 入队
 *
 * occupancy 由 chat.setOccupancy 驱动（store 投影 = composer-shell sendRoute 的数据源）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-dispatch-route.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'
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
  chat: { send: chatApiMock.send, steer: chatApiMock.steer, streamSubscribe: vi.fn(() => () => {}) },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })) },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
  config: { getGlobalSkills: vi.fn().mockResolvedValue([]), getProjectSkills: vi.fn().mockResolvedValue([]), onSkillCacheInvalidated: () => () => {} },
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))

// ── ComposerInput mock：emit input 设 draft + emit keydown ──
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
  effectScope().run(() => {
    useCompactQueue()
  })
  useCompactQueue()._clearAllForTest()
  resetChatModuleState()
})

function mountComposer(): ReturnType<typeof mount> {
  return mount(Composer, { props: { sessionId: 's1' }, global: { stubs: otherStubs } })
}

async function pressKey(wrapper: ReturnType<typeof mountComposer>, init: KeyboardEventInit): Promise<void> {
  wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter', ...init }))
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick() // onSend 是 async，需 flush
}

/** 驱动 occupancy 投影（sessionPhase 数据源） */
function setPhase(turn: 'idle' | 'dispatching' | 'generating' | 'settling', compacting = false, bash = false): void {
  useChatStore().setOccupancy('s1', { turn, compacting, bash })
}

/** 制造本地 busy 视图（streaming 实体 → isActive=true）。真实时序下 turn 活跃（occupancy
 *  generating）必然伴随本地 turn 实体（turn 由本 renderer 的 send 发起）——行 2/3 用例
 *  须同步驱动本地视图，镜像真实投影时序。 */
function seedLocalBusy(sid = 's1'): void {
  useChatStore().applyMessageEvent(sid, {
    type: 'message.message_start',
    payload: { sessionId: sid, messageId: 'a1' },
  })
}

describe('Composer D6 统一发送分发器（路由行为）', () => {
  it('行 3：generating + compacting（threshold）⏎ → steer，不误入 defer 队列（优先级倒挂消除）', async () => {
    setPhase('generating', true)
    seedLocalBusy()
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '补充：别忘了加测试')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    // steer 被调（追加当前回合，压缩后 turn 继续跑——steering 队列压缩完成的下一次 LLM 调用前投递）
    expect(chatApiMock.steer).toHaveBeenCalledTimes(1)
    expect(chatApiMock.steer).toHaveBeenCalledWith('s1', textToSegments('补充：别忘了加测试'))
    // 不误排队（steer 分档正确——无 pending 气泡语义）
    expect(useCompactQueue().count('s1')).toBe(0)
    expect(chatApiMock.send).not.toHaveBeenCalled()
    // 输入已清空（提交语义完成）
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
  })

  it('行 2：dispatching ⏎ → steer（turn 活跃定义含 dispatching）', async () => {
    setPhase('dispatching')
    seedLocalBusy()
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '追加')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    expect(chatApiMock.steer).toHaveBeenCalledTimes(1)
    expect(useCompactQueue().count('s1')).toBe(0)
  })

  it('行 4：settling ⏎ → defer 入队（pending 路径，直发不发生）', async () => {
    setPhase('settling')
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'settling 中发送')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    // 入队（occupancy idle 时自动投递）而非直发（现状该态 isActive=false 走直发被 pi 拒）
    expect(useCompactQueue().peek('s1').map((m) => m.text)).toContain('settling 中发送')
    expect(chatApiMock.send).not.toHaveBeenCalled()
    expect(chatApiMock.steer).not.toHaveBeenCalled()
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
  })

  it('行 6：bash=true 且 turn=idle ⏎ → defer 入队（R3-U4 集成直测，core 纯函数层外的分发器消费锁定）', async () => {
    setPhase('idle', false, true)
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'bash 忙时发送')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    // bash 占用即 defer 路由（D6 表行 6）：入队而非直发
    expect(useCompactQueue().peek('s1').map((m) => m.text)).toContain('bash 忙时发送')
    expect(chatApiMock.send).not.toHaveBeenCalled()
    expect(chatApiMock.steer).not.toHaveBeenCalled()
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
  })

  it('行 1：全 idle ⏎ → 直发（不排队不 steer）', async () => {
    setPhase('idle')
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '普通消息')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    expect(chatApiMock.send).toHaveBeenCalledTimes(1)
    // useChat mock 的 send 签名 = (sid, segments)（底层 RPC 的 clientUuid 透传在 core 编排内）
    expect(chatApiMock.send).toHaveBeenCalledWith('s1', textToSegments('普通消息'))
    expect(chatApiMock.steer).not.toHaveBeenCalled()
    expect(useCompactQueue().count('s1')).toBe(0)
  })

  it('Alt+⏎ steer 路由行（generating）→ followUp（下一轮语义保留，非 steer）', async () => {
    setPhase('generating')
    seedLocalBusy()
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '下一轮再说')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, { altKey: true })

    expect(chatApiMock.followUp).toHaveBeenCalledTimes(1)
    expect(chatApiMock.steer).not.toHaveBeenCalled()
  })

  it('Alt+⏎ defer 路由行（compacting）→ 入队而非 followUp（现状行为保持）', async () => {
    setPhase('idle', true)
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '压缩后发')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, { altKey: true })

    expect(chatApiMock.followUp).not.toHaveBeenCalled()
    expect(useCompactQueue().peek('s1').map((m) => m.text)).toContain('压缩后发')
  })

  it('steer 路由行 + 空输入 ⏎ → 不提交（分发器空输入守卫）', async () => {
    setPhase('generating')
    seedLocalBusy()
    const wrapper = mountComposer()
    await pressKey(wrapper, {})

    expect(chatApiMock.steer).not.toHaveBeenCalled()
    expect(chatApiMock.send).not.toHaveBeenCalled()
  })
})
