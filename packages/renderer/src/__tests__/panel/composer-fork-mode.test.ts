/**
 * Composer 集成测试合并文件（单文件多源合并：7 个源文件同 SUT（Composer.vue）、同目录、
 * mock 骨架单源 helpers/composer-mount.ts）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——单文件让全部用例共享一份 Composer 全树
 * 装载与环境初始化；拆文件会让每个文件各付一次全树装载（每份秒级 CPU，7 文件合计约
 * 6.4s 装载 CPU，合并后只装一份）。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动；各节以裸块隔离节内 helper/mock 实例）：
 *  - composer-fork-mode.test.ts（fork 模式 U12-U16）
 *  - composer-bash-mode.test.ts（bash 前缀分流 W2）
 *  - composer-staging-banner.test.ts（staging banner 组件级）
 *  - composer-three-states.test.ts（三态 UI + 统一提交）
 *  - composer-focus-ring.test.ts（R3 无焦点边界）
 *  - composer-history-cache.test.ts（历史派生 + R2-A6 草稿保存）
 *  - composer-model-reasoning.test.ts（档位可用集派生）
 *
 * mock 并集（模块图级，全节共享）：
 *  - useChat / useNewTaskFlow / @/stores/session：import helpers/composer-shell-mount
 *    统一注册（useChat 为 composerChatApiSpy 单例超集形态——原 fork 族文件内
 *    composerChatModule 工厂的断言键 send/steer/followUp/abort/compact 均在 spy 内，
 *    断言语义不变；spy 多出的 sendBash/abortBash/resolve 基线对原工厂文件为无害超集）
 *  - @/api（composerApiModule 基础五组）/ useProjectSkills / useSidebar：顶层注册
 *    （原 bash 族三文件未注册后两枚——真实实现经 mock @/api 也返回空态，与 mock 后
 *    行为等价；fork 族同 stubs 形态下挂载已验证）
 *  - @/stores/chat 保持真实（fork / three-states / history-cache 依赖真实 isActive
 *    派生与 hydrate 断言；bash / focus 族原亦真实）
 *
 * 未并入：force-quit-draft-recovery-dom.test.ts——其 mock @/stores/chat
 * （composerChatStoreModule 最小 stub，isActive 恒 false）与族内真实 store 驱动构成
 * 同模块实质冲突，且其 @taiji/ui/features/composer 模块级 mock 与族内 stubs 机制的
 * 组合行为未经验证，保持独立文件。
 *
 * hook 处理：各源顶层 beforeEach 均为幂等重置（pinia 重建 + clearAllMocks + 输入捕获
 * 清空），保留在各节裸块内叠加执行（重复执行无副作用差异），未收敛文件级公共 hook。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-fork-mode.test.ts
 */
// helper import 必须先于一切项目内模块（@/stores 等会在模块图加载期触发 @/api mock
// factory，factory 引用的 helper 绑定彼时必须已初始化，否则 TDZ——vi.mock hoisting 约束）
import '../helpers/composer-shell-mount'
import {
  composerApiModule,
  composerChatApiSpy,
  composerChildStubs,
  composerForkSessionAskSpy,
  composerProjectSkillsModule,
  composerSidebarForkModule,
  enterForkMode,
  expectBannerVisible,
  expectForkModeVisual,
  makeComposerInputMock,
  makeFocusableComposerInputMock,
  makeKeyboardComposerInputMock,
  makeTypeAndEnter,
  mountComposerWithStubs,
  resetComposerMountState,
  setupComposerBaseHarness,
} from '../helpers/composer-mount'
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'
import type { Message, ProviderInfo } from '@taiji/shared'
import { getSettingsStore } from '@taiji/core'
import { useChatStore } from '@/stores/chat'
import { triggerEnterForkMode } from '@/composables/panel/useForkModeChannel'
import { triggerEnterHandoffMode } from '@/composables/panel/useHandoffModeChannel'
import { useChat } from '@/composables/features/chat/useChat'
import { deriveHistoryFromChatStore } from '@/composables/panel/composer-shell'
import Composer from '@/components/panel/Composer.vue'

// ── mock 并集注册（useChat / useNewTaskFlow / @/stores/session 已由 composer-shell-mount 注册）──
vi.mock('@/api', () => composerApiModule())
vi.mock('@/composables/features/settings/useProjectSkills', () => composerProjectSkillsModule())
vi.mock('@/composables/features/sidebar/useSidebar', () => composerSidebarForkModule())

// ══════════ 来源：composer-fork-mode.test.ts ══════════
{
  // spy 句柄：shell-mount 的 composerChatSpyModule 工厂级单例——此处 useChat() 与组件实例共享同一批 vi.fn
  const chatApi = useChat() as unknown as {
    send: Mock
    steer: Mock
    followUp: Mock
    abort: Mock
    compact: Mock
  }

  // ── mock useSidebar：forkSessionAsk（fork 发送编排断言锚点，helper spy 单例）──
  const forkSessionAskMock = composerForkSessionAskSpy

  // ── ComposerInput mock：helper 键盘交互变体单源（props/expose 面同手写版）──
  const { lastInputText, ComposerInputMock } = makeKeyboardComposerInputMock()

  const otherStubs = {
    ComposerInput: ComposerInputMock,
    ...composerChildStubs,
  }

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
}

// ══════════ 来源：composer-bash-mode.test.ts ══════════
{
  // ── ComposerInput mock（emit input 设 draft）+ 壳 stub + 逐用例重置（harness 一并装配）──
  const { ComposerInputMock, otherStubs } = setupComposerBaseHarness()
  const typeAndEnter = makeTypeAndEnter(ComposerInputMock)

  /** 全部用例挂 s1 面板态，签名收窄为实际消费方 */
  function mountComposer() {
    return mount(Composer, { props: { sessionId: 's1' }, global: { stubs: otherStubs } })
  }

  describe('Composer bash 模式（! / !! 前缀分流）', () => {
    it('T6: draft="!ls -la" Enter → sendBash("ls -la", false)，send 未被调', async () => {
      const wrapper = mountComposer()
      await typeAndEnter(wrapper, '!ls -la')

      expect(composerChatApiSpy.sendBash).toHaveBeenCalledOnce()
      expect(composerChatApiSpy.sendBash).toHaveBeenCalledWith('s1', 'ls -la', false)
      // 普通发送未触发（bash 分流短路）
      expect(composerChatApiSpy.send).not.toHaveBeenCalled()
    })

    it('T7: draft="!!git status" Enter → sendBash("git status", true)（excludeFromContext）', async () => {
      const wrapper = mountComposer()
      await typeAndEnter(wrapper, '!!git status')

      expect(composerChatApiSpy.sendBash).toHaveBeenCalledOnce()
      expect(composerChatApiSpy.sendBash).toHaveBeenCalledWith('s1', 'git status', true)
    })

    it('T8: draft="!" Enter → sendBash 未被调（空命令不提交，保持 bash 模式）', async () => {
      const wrapper = mountComposer()
      await typeAndEnter(wrapper, '!')

      expect(composerChatApiSpy.sendBash).not.toHaveBeenCalled()
      expect(composerChatApiSpy.send).not.toHaveBeenCalled()
    })

    it('T9: draft 从 "hello" 变 "!ls" → composer-box 获得 composer-bash-mode class', async () => {
      const wrapper = mountComposer()
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
      const wrapper = mountComposer()
      const input = wrapper.findComponent(ComposerInputMock)
      await typeAndEnter(wrapper, '!ls -la')

      expect(composerChatApiSpy.sendBash).toHaveBeenCalledOnce()
      expect(composerChatApiSpy.sendBash).toHaveBeenCalledWith('s1', 'ls -la', false)
      // clearInput 被调（乐观 UI：提交前已清空 draft）
      expect(input.vm.clear).toHaveBeenCalled()
      // setText 是 restoreInput 的底层入口（useComposerRestore.restoreInput → inputRef.setText），
      // sendBash resolve 路径下不应被调（无恢复语义）
      expect(input.vm.setText).not.toHaveBeenCalled()
    })
  })
}

// ══════════ 来源：composer-staging-banner.test.ts ══════════
{
  // ── ComposerInput mock：helper 键盘交互变体单源（props/expose 面同手写版）──
  const { lastInputText, ComposerInputMock } = makeKeyboardComposerInputMock()

  const mountStubs = {
    ComposerInput: ComposerInputMock,
    ...composerChildStubs,
  }

  beforeEach(() => {
    resetComposerMountState(lastInputText)
  })

  function mountComposer(props: { sessionId: string | null }) {
    return mount(Composer, { props, global: { stubs: mountStubs } })
  }

  // ── 条件渲染：无 staging 不渲染 / fork 态渲染 ─────────────────────────────
  describe('banner 条件渲染（驱动位 staging.activeStaging）', () => {
    it('无 staging（activeStaging null）→ banner 不渲染', () => {
      const wrapper = mountComposer({ sessionId: 's1' })
      expectBannerVisible(wrapper, false)
      expect(wrapper.find('[data-testid="composer-handoff-banner"]').exists()).toBe(false)
    })

    it('fork 态 → 渲染 fork 标题 + GitBranch 图标 + × 退出钮，box 无 fork-mode 染色', async () => {
      const wrapper = mountComposer({ sessionId: 's1' })
      await enterForkMode(wrapper, 's1')

      const banner = wrapper.find('[data-testid="composer-mode-banner"]')
      expect(banner.exists()).toBe(true)
      // 文案 = 粗体标题 + 「 · 」+ 描述（demo 权威 zh 文案；连写断言含空格间距——
      // 模板换行空白经 Vue condense 折叠为单空格，防「标题·描述」贴死形态回归）
      expect(banner.text()).toContain('Fork 新分支')
      expect(banner.text()).toMatch(/新分支 · 当前输入将发到新分支，与主线隔离/)
      // 图标 = GitBranch（fork 映射，demo 权威 git-branch；lucide svg 类名锚点）
      expect(banner.find('svg.lucide-git-branch').exists()).toBe(true)
      // × 退出钮存在（Button ghost 渲染为 button 元素）
      expect(banner.find('button').exists()).toBe(true)
      // box 无 fork-mode 染色（[HISTORICAL] 整框染色档已退役，banner 图标是唯一 accent 染色点）
      expect(wrapper.find('[data-testid="composer-box"]').classes()).not.toContain('fork-mode')
    })
  })

  // ── × 退出：click → staging.exit → banner 消失 ───────────────────────────
  describe('banner × click 触发 staging.exit', () => {
    it('fork 态点 × → banner 消失（模式退出）', async () => {
      const wrapper = mountComposer({ sessionId: 's1' })
      await enterForkMode(wrapper, 's1')
      expectBannerVisible(wrapper, true)

      await wrapper.find('[data-testid="composer-mode-banner"] button').trigger('click')
      await wrapper.vm.$nextTick()

      expectBannerVisible(wrapper, false)
    })
  })

  // ── handoff 态：图标与文案分流 ────────────────────────────────────────────
  describe('handoff 态 banner（图标 ArrowRightLeft + handoff 文案）', () => {
    it('handoff 信号进入 → handoff testid + handoff 标题/描述 + ArrowRightLeft 图标', async () => {
      const wrapper = mountComposer({ sessionId: 's1' })
      triggerEnterHandoffMode('s1')
      await wrapper.vm.$nextTick()

      const banner = wrapper.find('[data-testid="composer-handoff-banner"]')
      expect(banner.exists()).toBe(true)
      expectBannerVisible(wrapper, false)
      // 文案 = handoff 标题 + 描述（demo 权威 zh 文案）
      expect(banner.text()).toContain('Handoff 交接')
      expect(banner.text()).toContain('发送后将生成会话摘要，交接给新会话继续')
      // 图标 = ArrowRightLeft（handoff 映射），且不是 fork 的 GitBranch
      expect(banner.find('svg.lucide-arrow-right-left').exists()).toBe(true)
      expect(banner.find('svg.lucide-git-branch').exists()).toBe(false)
      // 图标染 accent = 模式在途唯一染色点（text-accent 落在 banner svg 上）
      expect(banner.find('svg').classes()).toContain('text-accent')
    })
  })
}

// ══════════ 来源：composer-three-states.test.ts ══════════
{
  // ── ComposerInput mock：defineExpose + emit（共用部分工厂单源 helpers/composer-mount）──
  // 追踪 input 事件携带的文本（Composer.onSend 调 inputRef.getSegments() 取结构化 segments）。
  // 通过 emits 验证器捕获 input payload，getSegments 用 textToSegments 还原（ADR-0043）。
  const { lastInputText, ComposerInputMock } = makeComposerInputMock()

  const otherStubs = { ComposerInput: ComposerInputMock, ...composerChildStubs }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    lastInputText.value = ''
  })

  /** 经 ComposerInput mock 发键盘事件（IME 用例经 isComposing 驱动 composition 态） */
  function emitKeydown(wrapper: VueWrapper, key: string, isComposing = false): void {
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key, isComposing }))
  }

  function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }): VueWrapper {
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

  describe('[u3c/D1] busy 时 Enter → 统一提交（B 策略本地转 steer 已退役）', () => {
    it('busy 时 Enter → 调 send（lane 判定收归内核），不调 steer', async () => {
      const chat = useChatStore()
      const sid = 's-steer-enter'
      // 制造 busy 态
      chat.applyMessageEvent(sid, {
        type: 'message.message_start',
        payload: { sessionId: sid, messageId: 'a1' },
      })
      const wrapper = mountComposer({ sessionId: sid })
      expect(chat.isActive(sid)).toBe(true)

      // 输入文本（让 hasInput=true）
      wrapper.findComponent(ComposerInputMock).vm.$emit('input', '补充内容')
      await wrapper.vm.$nextTick()

      // 模拟 Enter 键
      emitKeydown(wrapper, 'Enter')
      // onSend 是多层 async 链（core D6 分发器），统一单 flushPromises 清空整条 microtask
      // 链后再断言（拍数式 nextTick 不够 flush，全文件断言前统一此形态）
      await flushPromises()

      expect(composerChatApiSpy.send).toHaveBeenCalledWith(sid, textToSegments('补充内容'))
    })
  })

  describe('T2.3 B 策略：idle 时 Enter → send', () => {
    it('idle 时 Enter → 调 send，不调 steer', async () => {
      const wrapper = mountComposer({ sessionId: 's-send-enter' })
      wrapper.findComponent(ComposerInputMock).vm.$emit('input', '第一条消息')
      await wrapper.vm.$nextTick()

      emitKeydown(wrapper, 'Enter')
      // 同 [u3c/D1] 用例：单 flushPromises 清空 D6 分发器整条 async 链后再断言
      await flushPromises()

      expect(composerChatApiSpy.send).toHaveBeenCalledWith('s-send-enter', textToSegments('第一条消息'))
    })
  })

  describe('T2.x IME composition 中 Enter 不触发 send/steer', () => {
    it('idle 态 composition 中 Enter 不触发 send', async () => {
      const wrapper = mountComposer({ sessionId: 's-ime-idle' })
      wrapper.findComponent(ComposerInputMock).vm.$emit('input', '你好')
      await wrapper.vm.$nextTick()

      // compositionstart（模拟中文输入法开始）
      emitKeydown(wrapper, 'Process')
      // Enter + isComposing: true（拼音未确认）
      emitKeydown(wrapper, 'Enter', true)
      await flushPromises()

      // 不应调 send
      expect(composerChatApiSpy.send).not.toHaveBeenCalled()
    })

    it('idle 态 composition 结束后 Enter 正常 send', async () => {
      const wrapper = mountComposer({ sessionId: 's-ime-idle-end' })
      wrapper.findComponent(ComposerInputMock).vm.$emit('input', '你好世界')
      await wrapper.vm.$nextTick()

      // compositionstart → Enter (isComposing, 不触发)
      emitKeydown(wrapper, 'Enter', true)
      await wrapper.vm.$nextTick()
      expect(composerChatApiSpy.send).not.toHaveBeenCalled()

      // compositionend → 正常 Enter (isComposing=false, 触发 send)
      emitKeydown(wrapper, 'Enter', false)
      // 同 [u3c/D1] 用例：单 flushPromises 清空 D6 分发器整条 async 链后再断言
      await flushPromises()

      expect(composerChatApiSpy.send).toHaveBeenCalledWith('s-ime-idle-end', textToSegments('你好世界'))
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

      // composition 中 Enter → 不触发提交
      emitKeydown(wrapper, 'Enter', true)
      await flushPromises()

      expect(composerChatApiSpy.send).not.toHaveBeenCalled()
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
      expect(composerChatApiSpy.abort).toHaveBeenCalled()
    })
  })
}

// ══════════ 来源：composer-focus-ring.test.ts ══════════
{
  // ── ComposerInput mock：defineExpose + emit focus/blur/input（focus/blur 是聚焦行为测试
  //    特有事件 → helper 可聚焦变体工厂）──
  const { lastInputText, ComposerInputMock } = makeFocusableComposerInputMock()

  const otherStubs = { ComposerInput: ComposerInputMock, ...composerChildStubs }

  /** 已退役聚焦边界 class（R3 前旧形态：外框 border-strong 提亮） */
  const RETIRED_FOCUS_CLASS = '!border-[var(--border-strong)]'

  beforeEach(() => resetComposerMountState(lastInputText))

  const mountComposer = mountComposerWithStubs(Composer, otherStubs)

  describe('R3 无焦点边界：聚焦不产生任何聚焦 class', () => {
    it('(a) 聚焦 → composer-box 无聚焦边界（光标即焦点反馈，R3 撤销口径）', async () => {
      const wrapper = mountComposer({ sessionId: 's1' })
      wrapper.findComponent(ComposerInputMock).vm.$emit('focus')
      await wrapper.vm.$nextTick()

      const box = wrapper.find('[data-testid="composer-box"]')
      expect(box.classes()).not.toContain(RETIRED_FOCUS_CLASS)
    })

    it('(b) 聚焦 + bash 活跃 → bash 语义色不受聚焦态影响（accent border 语义色照常在）', async () => {
      const wrapper = mountComposer({ sessionId: 's1' })
      // 输入 ! 前缀触发 bash 模式 → boxClass[0] = composer-bash-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring)]
      wrapper.findComponent(ComposerInputMock).vm.$emit('input', '!ls')
      await wrapper.vm.$nextTick()
      // 同时聚焦
      wrapper.findComponent(ComposerInputMock).vm.$emit('focus')
      await wrapper.vm.$nextTick()

      const box = wrapper.find('[data-testid="composer-box"]')
      // bash 语义色存在（无 ! 前缀的 Tailwind shadow-[] 工具类）
      expect(box.classes()).toContain('shadow-[0_0_0_3px_var(--accent-ring)]')
      // 聚焦态不叠加任何聚焦边界
      expect(box.classes()).not.toContain(RETIRED_FOCUS_CLASS)
    })

    it('(c) 未聚焦 → 无聚焦态（focusRingClass 恒空）', () => {
      const wrapper = mountComposer({ sessionId: 's1' })
      const box = wrapper.find('[data-testid="composer-box"]')
      expect(box.classes()).not.toContain(RETIRED_FOCUS_CLASS)
    })
  })
}

// ══════════ 来源：composer-history-cache.test.ts ══════════
{
  type ChatStore = ReturnType<typeof useChatStore>

  /** 最小 user/assistant 消息构造（派生只读 role/status/content） */
  function userMsg(id: string, text: string, status: Message['status'] = 'complete'): Message {
    return { id, role: 'user', content: text, status, timestamp: 0 }
  }
  function assistantMsg(id: string, text: string): Message {
    return { id, role: 'assistant', content: text, status: 'complete', timestamp: 0 }
  }

  /** 结构化 chatStore stub：deriveHistoryFromChatStore 只消费 getMessages（固定数组引用） */
  function fakeStore(msgs: Message[]): ChatStore {
    return { getMessages: (_sid: string) => msgs } as unknown as ChatStore
  }

  describe('deriveHistoryFromChatStore 派生语义（纯函数基线行为）', () => {
    it('倒序 + 仅 user+complete + 连续相同文本去重', () => {
      const msgs = [
        userMsg('u1', 'first'),
        assistantMsg('a1', 'reply'),
        userMsg('u2', 'second'),
        userMsg('u3', 'second'), // 连续重复 → 去重
        userMsg('u4', 'draft', 'streaming'), // 未 complete → 排除
        assistantMsg('a2', 'as text'),
      ]
      expect(deriveHistoryFromChatStore(fakeStore(msgs), 's1')).toEqual(['second', 'first'])
    })

    it('非连续相同文本不去重', () => {
      const msgs = [userMsg('u1', 'same'), userMsg('u2', 'other'), userMsg('u3', 'same')]
      expect(deriveHistoryFromChatStore(fakeStore(msgs), 's1')).toEqual(['same', 'other', 'same'])
    })

    it('Segment[] content 经 normalizeContent 归一为纯文本', () => {
      const msgs: Message[] = [
        {
          id: 'u1',
          role: 'user',
          content: [
            { type: 'text', text: '带结构 ' },
            { type: 'text', text: '分段' },
          ],
          status: 'complete',
          timestamp: 0,
        },
      ]
      expect(deriveHistoryFromChatStore(fakeStore(msgs), 's1')).toEqual(['带结构 分段'])
    })
  })

  // ── [R2-A6 回归] browsing 态跨 session 切换的草稿保存 ──────────────────────

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
    setup(_, { expose, emit }) {
      expose({
        clear: () => {
          lastInputText.value = ''
          emit('input', '')
        },
        // 对齐真实 ComposerInput 契约：setText 更新输入区并 emit input（contenteditable.ts setText 末尾 emitInput）
        setText: (text: string) => {
          lastInputText.value = text
          emit('input', text)
        },
        insertSlashChip: vi.fn(),
        getSegments: () => (lastInputText.value ? [{ type: 'text' as const, text: lastInputText.value }] : []),
        getText: () => lastInputText.value,
        moveCaretVertical: () => 'at-edge' as const,
      })
      return {}
    },
    template: '<div data-testid="composer-input" />',
  })

  const stubs = {
    ComposerInput: ComposerInputMock,
    ...composerChildStubs,
  }

  describe('R2-A6 回归：browsing 态切 session 后切回，草稿为用户输入而非历史文本', () => {
    beforeEach(() => {
      setActivePinia(createPinia())
      vi.clearAllMocks()
      lastInputText.value = ''
    })

    it('browsing 中切走（草稿存 savedDraft）→ 切回恢复用户真实输入', async () => {
      const chat = useChatStore()
      chat.hydrate('s1', [
        userMsg('u1', '历史消息一'),
        assistantMsg('a1', '回复'),
      ])
      const wrapper = mount(Composer, { props: { sessionId: 's1' }, global: { stubs } })
      await nextTick()
      const input = wrapper.findComponent(ComposerInputMock)

      // 用户输入草稿
      input.vm.$emit('input', '用户的草稿')
      await nextTick()
      // ↑ 进 browsing：输入区被历史条目替换（getText 返回历史文本）
      input.vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
      await nextTick()
      // 前置：browsing 生效——输入区当前显示的是历史条目而非用户草稿
      expect(lastInputText.value).toBe('历史消息一')

      // 切到 s2（此刻保存旧 session 草稿），再切回 s1
      await wrapper.setProps({ sessionId: 's2' })
      await nextTick()
      await wrapper.setProps({ sessionId: 's1' })
      await nextTick()

      // 草稿 = 用户真实输入（history savedDraft），而非 browsing 期输入区显示的历史条目
      expect(lastInputText.value).toBe('用户的草稿')
      expect(lastInputText.value).not.toBe('历史消息一')
    })
  })
}

// ══════════ 来源：composer-model-reasoning.test.ts ══════════
{
  // ── ComposerInput mock：helper 键盘交互变体单源（props/expose 面同手写版）──
  const { lastInputText, ComposerInputMock } = makeKeyboardComposerInputMock()

  // ── ThinkingLevelPopover 透传探针：把 supportedLevels/level 派生落到 DOM 属性 ──
  const ThinkingLevelProbe = defineComponent({
    name: 'ThinkingLevelPopover',
    props: {
      level: { type: String, default: '' },
      levelMap: { type: Object, default: undefined },
      supportedLevels: { type: Array as () => string[] | undefined, default: undefined },
    },
    template:
      '<div data-testid="tlp-probe" :data-supported="supportedLevels === undefined ? \'undef\' : supportedLevels.join(\',\')" :data-level="level" />',
  })

  const otherStubs = {
    ...composerChildStubs,
    ComposerInput: ComposerInputMock,
    ThinkingLevelPopover: ThinkingLevelProbe, // 本文件差异化：档位透传探针覆盖 SIMPLE stub
  }

  /** 构造单 provider 双模型（reasoning true/false）的 providers 快照。 */
  function makeProviders(): ProviderInfo[] {
    return [
      {
        id: 'p1',
        name: 'P1',
        apiKeySet: true,
        status: 'connected',
        models: [
          { id: 'm-r', name: 'reasoning model', reasoning: true, thinkingLevelMap: { off: 'off', high: 'high' }, supportedLevels: ['off', 'high'] },
          { id: 'm-plain', name: 'plain model', reasoning: false, supportedLevels: ['off'] },
        ],
      },
    ]
  }

  function mountComposer() {
    return mount(Composer, { props: { sessionId: null }, global: { stubs: otherStubs } })
  }

  describe('Composer 档位可用集派生（composer-shell getSupportedLevels，U6 切源）', () => {
    beforeEach(() => {
      resetComposerMountState(lastInputText)
    })

    it('defaultModel 指向 reasoning:true 模型 → ThinkingLevelPopover 收到 supportedLevels=["off","high"]', async () => {
      const settings = getSettingsStore()
      settings.providers.value = makeProviders()
      settings.defaultModel.value = 'p1/m-r'

      const wrapper = mountComposer()
      await wrapper.vm.$nextTick()

      const probe = wrapper.find('[data-testid="tlp-probe"]')
      expect(probe.exists()).toBe(true)
      expect(probe.attributes('data-supported')).toBe('off,high')
    })

    it('defaultModel 指向 reasoning:false 模型 → probe 收到 ["off"]（pi 两级门控产物，non-reasoning 只 off 档判据）', async () => {
      const settings = getSettingsStore()
      settings.providers.value = makeProviders()
      settings.defaultModel.value = 'p1/m-plain'

      const wrapper = mountComposer()
      await wrapper.vm.$nextTick()

      const probe = wrapper.find('[data-testid="tlp-probe"]')
      expect(probe.attributes('data-supported')).toBe('off')
    })

    it('模型无 supportedLevels 字段（下发未覆盖的旧数据）→ probe 收到 undef（下游归一默认五档）', async () => {
      const settings = getSettingsStore()
      settings.providers.value = [
        {
          id: 'p1',
          name: 'P1',
          apiKeySet: true,
          status: 'connected',
          models: [{ id: 'm-legacy', name: 'legacy model' }],
        },
      ]
      settings.defaultModel.value = 'p1/m-legacy'

      const wrapper = mountComposer()
      await wrapper.vm.$nextTick()

      const probe = wrapper.find('[data-testid="tlp-probe"]')
      expect(probe.attributes('data-supported')).toBe('undef')
    })
  })
}
