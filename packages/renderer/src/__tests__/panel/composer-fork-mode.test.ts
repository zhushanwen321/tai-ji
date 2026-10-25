/**
 * Composer fork 模式集成测试（U12-U16）。
 *
 * 驱动方式：fork/handoff 进入走真实信号链——triggerEnterForkMode / triggerEnterHandoffMode
 * 写 channel signal → Composer 内 watch → staging.enter（与 Sidebar 快捷键同一生产通路）。
 * 模式态断言全部经用户可见 DOM（composer-mode-banner / fork-send-btn·handoff-send-btn 的
 * disabled 形态），不经组件 expose（expose 面生产零消费，已收窄为无）。
 * [HISTORICAL] 断言锚点 composer-mode-chip 与 fork-mode box 染色 class 已随 staging banner
 * 形态退役（demo 裁决：banner 图标染 accent 是模式在途唯一染色点），模式标识迁至 banner。
 *
 * 覆盖：
 * - U12 forkMode 三重视觉 + chip + placeholder（fork-mode class + mode-chip + placeholder 切换）
 * - U13 forkMode 发送后自动退出（调 forkSessionAsk + 模式 chip 消失）
 * - U14 Esc 退出 + 切 session 自动退出
 * - U15 streaming 中 fork 提交（Enter / Alt+Enter 走 fork，steer/followUp 不被调）
 * - U16 提交检查经发送位形态断言（staging 双发锁 / 占用放行 / fork·handoff 空稿规则）
 *
 * mock 骨架收编 helpers/composer-mount.ts 单源（chat 模块工厂 + 兄弟子组件 stubs）；
 * useChat spy 句柄经 import { useChat } 取工厂级单例实例断言（与组件拿到的是同一批 vi.fn）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-fork-mode.test.ts
 */
// helper import 必须先于一切项目内模块（@/stores 等会在模块图加载期触发 @/api mock
// factory，factory 引用的 helper 绑定彼时必须已初始化，否则 TDZ——vi.mock hoisting 约束）
import {
  composerApiModule,
  composerChatModule,
  composerChildStubs,
  composerForkSessionAskSpy,
  composerFlowModule,
  composerProjectSkillsModule,
  composerSessionStoreModule,
  composerSidebarForkModule,
  enterForkMode,
  expectBannerVisible,
  expectForkModeVisual,
  makeKeyboardComposerInputMock,
  makeTypeAndEnter,
  resetComposerMountState,
} from '../helpers/composer-mount'
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { triggerEnterForkMode } from '@/composables/panel/useForkModeChannel'
import { triggerEnterHandoffMode } from '@/composables/panel/useHandoffModeChannel'

vi.mock('@/composables/features/chat/useChat', () => composerChatModule())
// spy 句柄：composerChatModule 工厂级单例——此处 useChat() 与组件实例共享同一批 vi.fn
import { useChat } from '@/composables/features/chat/useChat'
const chatApi = useChat() as unknown as {
  send: Mock
  steer: Mock
  followUp: Mock
  abort: Mock
  compact: Mock
}

vi.mock('@/composables/features/new-task/useNewTaskFlow', () => composerFlowModule())
vi.mock('@/api', () => composerApiModule())
// main 合并引入 useProjectSkills/useGlobalSkills（landing skill），与 fork 测试无关，stub 掉
vi.mock('@/composables/features/settings/useProjectSkills', () => composerProjectSkillsModule())
vi.mock('@/stores/session', () => composerSessionStoreModule())
// ── mock useSidebar：forkSessionAsk（fork 发送编排断言锚点，helper spy 单例）──
const forkSessionAskMock = composerForkSessionAskSpy
vi.mock('@/composables/features/sidebar/useSidebar', () => composerSidebarForkModule())

// ── ComposerInput mock：helper 键盘交互变体单源（props/expose 面同手写版）──
const { lastInputText, ComposerInputMock } = makeKeyboardComposerInputMock()

const otherStubs = {
  ComposerInput: ComposerInputMock,
  ...composerChildStubs,
}

import Composer from '@/components/panel/Composer.vue'

beforeEach(() => {
  resetComposerMountState(lastInputText)
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

/** 「输入 + Enter」驱动（helper 单源，经本文件 harness 的 ComposerInputMock） */
const typeAndEnter = makeTypeAndEnter(ComposerInputMock)

/** 制造 streaming：真实 chat store 写入 message_start → isGenerating=true → isActive=true */
function makeStreaming(sid: string): void {
  const chat = useChatStore()
  chat.applyMessageEvent(sid, {
    type: 'message.message_start',
    payload: { sessionId: sid, messageId: 'a1' },
  })
}

// ── U12：forkMode banner + box 不染色 + placeholder 静态 ────────────────
describe('U12：forkMode 视觉 = staging banner（box 无染色、placeholder 静态）', () => {
  it('channel signal 触发后 banner DOM 存在，composer-box 无 fork-mode 染色', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    await enterForkMode(wrapper, 's1')

    expectForkModeVisual(wrapper)
  })

  it('fork 模式下 placeholder 保持静态（不换文案）', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    await enterForkMode(wrapper, 's1')

    // ComposerInput mock 不渲染 placeholder 属性文本，断言 props 透传的 placeholder 不变
    const input = wrapper.findComponent(ComposerInputMock)
    // [HISTORICAL] staging placeholder 换文案档（forkHint）已随 banner 退役：demo 口径
    // placeholder 静态，仍为常规 inputHint
    const placeholderProp = input.props('placeholder') as string
    expect(placeholderProp).toContain('描述你想让 AI 做什么')
  })
})

// ── U13：forkMode 发送后自动退出 ─────────────────────────────────────────
describe('U13：forkMode 下发送 → 调 forkSessionAsk + 自动退出 fork 模式', () => {
  it('fork 模式下发送 → 在新分支提问并退出 fork 模式', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    await enterForkMode(wrapper, 's1')

    // 输入
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '追问那条回复')
    await wrapper.vm.$nextTick()
    // Enter 发送（fork 模式下不 isActive，走 onSend → forkSessionAsk）
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', keyEvent('Enter'))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // forkSessionAsk 被调（而非 send）
    expect(forkSessionAskMock).toHaveBeenCalled()
    expect(chatApi.send).not.toHaveBeenCalled()
    // 发送后自动退出：staging banner 消失
    expectBannerVisible(wrapper, false)
  })
})

// ── U14：Esc 退出 + 切 session 自动退出 ──────────────────────────────────
describe('U14：Esc 退出 + 切 session 自动退出 forkMode', () => {
  it('forkMode 下按 Esc → 退出 fork 模式', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    await enterForkMode(wrapper, 's1')
    expectBannerVisible(wrapper, true)

    // 按 Esc（经 ComposerInput keydown 事件）
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', keyEvent('Escape'))
    await wrapper.vm.$nextTick()

    expectBannerVisible(wrapper, false)
  })

  it('forkMode 下切 session（sessionId 变化）→ 自动退出', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    await enterForkMode(wrapper, 's1')
    expectBannerVisible(wrapper, true)

    // 切 session：改 sessionId prop（Composer watch → staging.exit()）
    await wrapper.setProps({ sessionId: 's2' })
    await wrapper.vm.$nextTick()

    expectBannerVisible(wrapper, false)
  })
})

// ── U15：streaming 中 fork 模式（staging 优先于 steer）────────────────────
describe('U15：streaming 中 fork 模式：Enter 提交 fork 而非 steer，发送位替换 stop', () => {
  it('streaming + fork 模式 Enter → forkSessionAsk 被调，steer 不被调（草稿不注入当前对话）', async () => {
    const sid = 's-stream-fork'
    makeStreaming(sid)
    const wrapper = mountComposer({ sessionId: sid })
    expect(useChatStore().isActive(sid)).toBe(true) // 前置：session 确在 streaming

    await enterForkMode(wrapper, sid)

    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'fork 那条回复去问')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', keyEvent('Enter'))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(forkSessionAskMock).toHaveBeenCalledWith(
      sid, 'm1', 'fork 那条回复去问', expect.anything(),
    )
    expect(chatApi.steer).not.toHaveBeenCalled()
    expect(chatApi.send).not.toHaveBeenCalled()
  })

  it('streaming + fork 模式 → 发送位显示 fork 发送按钮，stop 按钮被替换', async () => {
    const sid = 's-stream-btn'
    makeStreaming(sid)
    const wrapper = mountComposer({ sessionId: sid })
    await enterForkMode(wrapper, sid)

    // staging 完全替换：fork 发送按钮存在，stop 消失（用户决策：需停止时先 Esc 退出 staging）
    expect(wrapper.find('[data-testid="fork-send-btn"]').exists()).toBe(true)
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
  })

  it('streaming 无 staging → stop 按钮行为不变（回归检查）', () => {
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
    await enterForkMode(wrapper, sid)

    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'alt 提交')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit(
      'keydown', new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }),
    )
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(forkSessionAskMock).toHaveBeenCalled()
    expect(chatApi.followUp).not.toHaveBeenCalled()
  })
})

// ── U16：提交检查（staging 双发锁 / 占用期放行 / 空稿规则）────────────────
describe('U16：提交检查——staging 只看 isSending，非 staging 看「可提交」（占用不拦截）', () => {
  it('staging 活跃 + streaming（isActive）+ 有输入 → fork 发送位可点（fork 提交不受流式拦截）', async () => {
    const sid = 's-can-submit-1'
    makeStreaming(sid)
    const wrapper = mountComposer({ sessionId: sid })
    triggerEnterForkMode(sid, 'm1')
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'fork 提问')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    // canSubmit=true ⇔ 发送位可用（disabled 缺席）
    expect(wrapper.find('[data-testid="fork-send-btn"]').attributes('disabled')).toBeUndefined()
  })

  it('staging 活跃 + isSending（双发锁）→ 发送位被 spinner 接管', async () => {
    // forkSessionAsk 挂起 → handleForkSend 置 isSending=true 未回落
    forkSessionAskMock.mockImplementationOnce(() => new Promise(() => {}))
    const sid = 's-can-submit-2'
    const wrapper = mountComposer({ sessionId: sid })
    triggerEnterForkMode(sid, 'm1')
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'in-flight 内容')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', keyEvent('Enter'))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    // isSending 分支接管发送位：staging 发送按钮消失（换 spinner）
    expect(wrapper.find('[data-testid="fork-send-btn"]').exists()).toBe(false)
  })

  it('非 staging + streaming + 有输入 → Enter 照常提交（[u3c/D1] canSend 收窄：占用不再拦截）', async () => {
    const sid = 's-can-submit-3'
    makeStreaming(sid)
    const wrapper = mountComposer({ sessionId: sid })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '普通输入')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', keyEvent('Enter'))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    // [u3c/D1] 前身 isBusy（= isActive ∨ isSending）拦截占用期提交——该半边是 renderer 侧提交判定
    // 的残留，随「renderer 只提交不判定」退役：提交检查只剩空输入与本地双发锁两类，
    // 占用期（streaming）Enter 照常走统一提交（u3b 收敛后 renderer 不再分 steer 路由，
    // lane 由内核判定），若被检查拦截 send 不会被调。
    expect(chatApi.send).toHaveBeenCalled()
    expect(chatApi.steer).not.toHaveBeenCalled()
  })

  it('fork / handoff staging（allowsEmptySend=true）空稿 → 发送位可点', async () => {
    const sid = 's-can-submit-4'
    const wrapper = mountComposer({ sessionId: sid })
    // fork 允许空提交（空 content 退化为纯 fork，不发送首条 user）——见 fork-mode.ts allowsEmptySend
    await enterForkMode(wrapper, sid)
    expect(wrapper.find('[data-testid="fork-send-btn"]').attributes('disabled')).toBeUndefined()
    // Esc 退 fork → 经 handoff 通道进 handoff（同样允许空 reply）
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', keyEvent('Escape'))
    await wrapper.vm.$nextTick()
    triggerEnterHandoffMode(sid)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="handoff-send-btn"]').attributes('disabled')).toBeUndefined()
  })
})
