/**
 * Composer 统一发送分发器集成测试（session-occupancy u5b D6 六行表 → 投递所有权内核 u3b/D1 收敛）。
 *
 * [u3c 迁移] 原断言「按 D6 行分流到 steer API / defer 入队 / 直发」已随 D1 退役——lane 判定
 * （direct/steer/queued）收归 runtime 投递所有权内核，renderer 只提交不判定：六行占用形态
 * （turn 活跃 / compacting / bash / settling）Enter 一律走**统一提交**（useChat.send →
 * 乐观气泡 + delivery.submit），占用期不再有特殊路径（内核排队/入槽承接）。
 * 保留的 UI 预测面：Alt+⏎ 在 steer 路由行仍走 followUp（下一轮语义，composer-keydown 按
 * sendRoute 分流）——sendRoute 仍是发送位形态的数据源，不再是投递决策。
 *
 * 锁定：
 * - 行 3（generating + compacting）/ 行 2（dispatching）/ 行 4（settling）/ 行 6（bash 忙）
 *   Enter → deps.send 恰一次（steer/followUp 均不被调）
 * - 行 1（全 idle）Enter → deps.send（与占用期同路径）
 * - Alt+⏎：steer 路由行（turn 活跃）→ followUp；其余行 → send
 * - steer 路由行 + 空输入 → 不提交（分发器空输入守卫）
 *
 * occupancy 由 chat.setOccupancy 驱动（store 投影 = composer-shell sendRoute 的数据源）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-dispatch-route.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'
import { useChatStore } from '@/stores/chat'
import { composerChildStubs } from '../helpers/composer-mount'

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

// 兄弟组件 stub 收敛到共享 helper（ComposerInput 本文件 spy 面自留，其余八项委托）
const otherStubs = {
  ComposerInput: ComposerInputMock,
  ...composerChildStubs,
}

import Composer from '@/components/panel/Composer.vue'
// resetChatModuleState 来自被 mock 的 useChat 模块（vi.fn，测试隔离占位）
import { resetChatModuleState } from '@/composables/features/chat/useChat'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
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

describe('Composer 统一发送分发器（占用形态全部收敛 deps.send，u3b/D1）', () => {
  it('行 3：generating + compacting（threshold）⏎ → 统一提交（不本地转 steer）', async () => {
    setPhase('generating', true)
    seedLocalBusy()
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '补充：别忘了加测试')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    // [D1] 占用期照常提交（内核判 lane），renderer 不再本地转 steer
    expect(chatApiMock.send).toHaveBeenCalledTimes(1)
    expect(chatApiMock.send).toHaveBeenCalledWith('s1', textToSegments('补充：别忘了加测试'))
    expect(chatApiMock.steer).not.toHaveBeenCalled()
    // 输入已清空（提交语义完成）
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
  })

  it('行 2：dispatching ⏎ → 统一提交（turn 活跃不再本地转 steer）', async () => {
    setPhase('dispatching')
    seedLocalBusy()
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '追加')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    expect(chatApiMock.send).toHaveBeenCalledTimes(1)
    expect(chatApiMock.steer).not.toHaveBeenCalled()
  })

  it('行 4：settling ⏎ → 统一提交（不再本地 defer 入队，内核 queued 承接）', async () => {
    setPhase('settling')
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'settling 中发送')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    expect(chatApiMock.send).toHaveBeenCalledWith('s1', textToSegments('settling 中发送'))
    expect(chatApiMock.steer).not.toHaveBeenCalled()
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
  })

  it('行 6：bash=true 且 turn=idle ⏎ → 统一提交（占用期无特殊路径）', async () => {
    setPhase('idle', false, true)
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'bash 忙时发送')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    expect(chatApiMock.send).toHaveBeenCalledWith('s1', textToSegments('bash 忙时发送'))
    expect(chatApiMock.steer).not.toHaveBeenCalled()
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
  })

  it('行 1：全 idle ⏎ → 统一提交（与占用期同路径）', async () => {
    setPhase('idle')
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '普通消息')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, {})

    expect(chatApiMock.send).toHaveBeenCalledTimes(1)
    // useChat mock 的 send 签名 = (sid, segments)（底层 RPC 的 clientUuid 透传在 core 编排内）
    expect(chatApiMock.send).toHaveBeenCalledWith('s1', textToSegments('普通消息'))
    expect(chatApiMock.steer).not.toHaveBeenCalled()
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
    expect(chatApiMock.send).not.toHaveBeenCalled()
  })

  it('Alt+⏎ non-steer 路由行（compacting）→ 统一提交（sendRoute 仅 UI 预测，非 followUp）', async () => {
    setPhase('idle', true)
    const wrapper = mountComposer()
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '压缩后发')
    await wrapper.vm.$nextTick()

    await pressKey(wrapper, { altKey: true })

    expect(chatApiMock.followUp).not.toHaveBeenCalled()
    expect(chatApiMock.send).toHaveBeenCalledWith('s1', textToSegments('压缩后发'))
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
