/**
 * Composer 集成测试共享 mock 骨架（范式同 sidebar-mount.ts / chat-stream-mount.ts）。
 *
 * 用法契约：vi.mock 注册留在测试文件（mock 是文件作用域），测试文件以
 * `vi.mock(mod, () => composerXxxModule())` 顶层转发本 helper 导出——同 sidebar-mount.ts
 * 先例。工厂每次调用返回新对象；composerChatModule 的 api 对象在工厂体内创建一次
 * （vi.mock factory 每模块图只执行一次）：测试经 `import { useChat }` 拿到与组件同一
 * 实例的 spy 做断言（每调用新建 = 断言空转假绿）。
 *
 * 现役消费文件与形态（两侧清单并集）：
 * - composer-fork-mode：useChat 委托 composerChatModule + composerChildStubs
 * - composer-slash-injection / composer-file-injection / composer-session-injection /
 *   force-quit-draft-recovery-dom：stores/chat + stores/session 委托工厂或仅
 *   composerChildStubs，mock 段各自内联（见下方差异化清单）
 * - composer-bar-density-wiring / composer-smoke：session mock / 子组件 stub /
 *   ComposerInput 共用面复用
 * - composer-history-cache：仅 composerChildStubs
 *
 * 另供两类变体工厂：makeComposerChatApiMock（useChat 的 spy 对象——断言需直接引用
 * send/steer/followUp 的文件持有单例后自建 vi.mock 包装）；makeFocusableComposerInputMock
 * （emits 增 focus/blur 的 ComposerInput 变体——聚焦行为测试用，expose 面与基型一致）。
 *
 * spy 单例族（bash-mode / compact-queue / dispatch-route / btw-button 四文件的装配形态，
 * useChat / flow / session 注册统一走 composer-shell-mount.ts 副作用模块）：
 * composerChatApiSpy（makeComposerChatApiMock 的单例形态——@/api 工厂执行期就要解引用
 * 它（chat 组转发），本地 const 彼时 TDZ，故必须单例驻本文件）；composerChatSpyModule
 * （useChat 工厂转发单例 + resetChatModuleState 超集键）；composerApiModuleWithChat
 * （@/api 加 chat 组 = spy 转发 + streamSubscribe）；composerApiModuleWithChatAndBtw
 * （再加 getHistory 回放腿 + composerBtwApiSpy 组）。
 *
 * W4：useNewTaskFlow 的 currentCwd 必须是真实 Vue ref（Composer 的
 * useProjectSkills(flow.currentCwd) 对它 watch，裸 { value } 对象触发 Vue warn）——
 * composerFlowModule 与各文件内联 flow mock 的 currentCwd 都必须给真 ref。
 *
 * vitest 按测试文件隔离模块图：本 helper 导出在每个测试文件内是独立实例（文件内 mock
 * 工厂与断言共享同一批 vi.fn）。
 *
 * 差异化部分（有意不收敛，各测试文件自留）：
 * - ComposerInput mock：expose 的 spy 面不同者自留（insertFileChip / insertSessionChip /
 *   insertSlashChip+insertSkillChip / 完整 expose 面带 insertTextAtCursor）；
 *   density-wiring 与 smoke 的共用面（clear/setText/insertSlashChip/getSegments +
 *   input 事件捕获）收敛为 makeComposerInputMock 工厂
 * - composer-session-injection：sessionStore 需可变 active（vi.hoisted sessionState），
 *   保留本地；本 helper 只提供静态 active: undefined 版
 * - composer-file-injection：flow mock 带 pendingPreset（landing 态 launchConfigView
 *   解析消费），相对 composerFlowModule 为超集，内联自足
 */
import { ref } from 'vue'
import { beforeEach, vi } from 'vitest'
import { defineComponent } from 'vue'
import type { Component, Ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'

/** '@/composables/features/chat/useChat' mock 工厂（Composer 消费面 7 键全量）。
 *  api 对象在工厂内创建一次（vi.mock factory 每模块图只执行一次）：测试经
 *  `import { useChat }` 拿到与组件同一实例的 spy 做断言（每调用新建 = 断言空转假绿）。 */
export function composerChatModule() {
  const api = {
    send: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
    compact: vi.fn(),
    editAndResend: vi.fn(),
    hydrateHistory: vi.fn(),
  }
  return { useChat: () => api }
}

/**
 * useChat 的 spy 对象工厂（断言需直接引用 send/steer/followUp 的文件用）：
 * 七个动作方法带 resolve 基线（Composer 内部若 await 链路不悬空）；sendBash/abortBash
 * 是 bash 路文件（send-button-states / smoke 等）的消费面，对其余文件为无害多余键。
 * 持有方式：
 *   const chatApiMock = makeComposerChatApiMock()
 *   vi.mock('@/composables/features/chat/useChat', () => ({ useChat: () => chatApiMock }))
 * （工厂外层闭包不立即解引用 chatApiMock，vi.mock hoisting 下安全——useChat() 在
 * mount 时才求值，彼时模块体已执行。）
 */
export function makeComposerChatApiMock() {
  return {
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
}

/**
 * useChat spy 单例（shell-mount 装配链的文件内共享锚点）：useChat 工厂、@/api 的 chat 组
 * 转发、测试断言三方引用同一批 vi.fn——与原各文件 vi.hoisted chatApiMock 语义一致。
 * 必须驻本文件做模块级单例（不能由测试文件持本地 const 再传入工厂）：@/api mock 工厂
 * 执行期（import 链上）就要解引用它，本地 const 彼时处于 TDZ。
 */
export const composerChatApiSpy = makeComposerChatApiMock()

/**
 * '@/composables/features/chat/useChat' mock 工厂（spy 单例转发形态，注册走
 * composer-shell-mount.ts）：resetChatModuleState 是 queue 链路文件的消费面，
 * 对 bash / btw 文件为无害多余键（超集）。
 */
export function composerChatSpyModule() {
  return {
    useChat: () => composerChatApiSpy,
    resetChatModuleState: vi.fn(),
  }
}

/** @/api 的 chat 组（spy 转发 + streamSubscribe 订阅退订形）——flush 链路共用段。 */
function composerChatApiGroup() {
  const chatApi = composerChatApiSpy
  return {
    send: chatApi.send,
    steer: chatApi.steer,
    streamSubscribe: vi.fn(() => () => {}),
  }
}

/**
 * '@/api' mock 工厂（chat 组增量形态）：compact-queue / dispatch-route 等走真实
 * flush 链路的文件用——queue.flush 内部经 api.chat.send 提交，与 useChat mock 的
 * send 是同一 vi.fn（断言面不分裂）。
 */
export function composerApiModuleWithChat() {
  return {
    ...composerApiModule(),
    chat: composerChatApiGroup(),
  }
}

/** btw 域 api spy 单例（btw-button：beforeEach 重播种 + 用例内 mockResolvedValue 驱动）。 */
export const composerBtwApiSpy = { list: vi.fn(), create: vi.fn(), remove: vi.fn() }

/**
 * '@/api' mock 工厂（chat + btw 组增量形态，btw-button 专用）：chat 组加 getHistory
 * 回放腿（空快照即可，drawer 选中线不走失败告警路径），btw 组为 badge 数据源。
 */
export function composerApiModuleWithChatAndBtw() {
  return {
    ...composerApiModule(),
    chat: {
      ...composerChatApiGroup(),
      getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
    },
    btw: composerBtwApiSpy,
  }
}

/**
 * '@/composables/features/new-task/useNewTaskFlow' mock 工厂（四文件消费面并集超集，
 * 多余键为无害 vi.fn / ref）。W4：currentCwd 统一真 ref 形态（见文件头注释）。
 */
export function composerFlowModule() {
  return {
    useNewTaskFlow: () => ({
      startFlow: vi.fn(),
      submitFirstMessage: vi.fn(),
      currentModel: ref<string | null>(null),
      setPendingModel: vi.fn(),
      pendingPreset: ref(null),
      state: ref('idle'),
      currentSessionId: ref<string | null>(null),
      currentCwd: ref<string | null>(null),
    }),
    resetNewTaskFlow: vi.fn(),
  }
}

/** '@/api' mock 工厂（project/model/session/composer/config 五组；config 供 W4 skill 加载）。 */
export function composerApiModule() {
  return {
    project: {
      load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
      save: vi.fn().mockResolvedValue(undefined),
    },
    model: { switchModel: vi.fn() },
    session: { setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })) },
    composer: {
      getMentionCandidates: vi.fn().mockResolvedValue([]),
      getFileCandidates: vi.fn().mockResolvedValue([]),
    },
    config: {
      // W4：useGlobalSkills/useProjectSkills 调用
      getGlobalSkills: vi.fn().mockResolvedValue([]),
      getProjectSkills: vi.fn().mockResolvedValue([]),
      onSkillCacheInvalidated: () => () => {},
    },
  }
}

/**
 * '@/stores/chat' mock 工厂（Composer 构造期读取不报错的最小 stub）。
 * isActive（合并态）驱动停止按钮/steer guard，恒 false（非活跃）。
 */
export function composerChatStoreModule() {
  return {
    useChatStore: () => ({
      isStreaming: ref(false),
      isActive: () => false,
      getRetryState: () => undefined,
      isCompacting: () => false,
      // [u6b] 发送位四态渲染即读 occupancy 投影（sendButtonState ← effectivePhase），mock 需提供
      sessionPhase: () => ({ turn: 'idle', compacting: false, bash: false }),
      getMessages: () => [],
      getOccupancy: () => ({ turn: 'idle', compacting: false, bash: false }),
    }),
  }
}

/** '@/stores/session' mock 工厂（静态无活跃态；applySnapshot 供 features/useModel 回执写）。 */
export function composerSessionStoreModule() {
  return {
    useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
  }
}

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })

/** Composer 兄弟子组件空 stub（四文件逐字相同；CommandPopover 需透传 slot）。 */
export const composerChildStubs = {
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

/** Composer mount 测试的 beforeEach 状态复位：pinia 重建 + mock 调用清零 + 输入捕获清空。 */
export function resetComposerMountState(lastInputText: Ref<string>) {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
}

/**
 * 基础族装配（bash-mode 形态，hook 注册式——同 app-update-mount 的
 * setupAppUpdateLifecycle 先例）：ComposerInput mock + 壳 stub 组合 + 逐用例重置
 * （resetComposerMountState）一并装配，测试文件不再自写 beforeEach 块——装配段
 * 行数压到 fallow 克隆阈值以下（族内文件脚手架趋同时不构成克隆组）。
 */
export function setupComposerBaseHarness() {
  const { lastInputText, ComposerInputMock } = makeComposerInputMock()
  const otherStubs = { ComposerInput: ComposerInputMock, ...composerChildStubs }
  beforeEach(() => {
    resetComposerMountState(lastInputText)
  })
  return { ComposerInputMock, otherStubs }
}

/** mountComposer 工厂：固定 props 形 + 全局 stubs 注入（各文件 stubs 差异经参数承接）。 */
export function mountComposerWithStubs(
  composer: Component,
  stubs: Record<string, Component>,
): (props: { sessionId: string | null; variant?: 'panel' | 'landing' }) => ReturnType<typeof mount> {
  return (props) => mount(composer, { props, global: { stubs } })
}

/**
 * 「输入文本 + Enter 发送」交互驱动工厂：emit input 设 draft + emit keydown Enter 触发
 * onSend，双 nextTick flush（onSend 是 async 链）。bash-mode / compact-queue 的键路
 * 交互单源——文件持各自 harness 的 ComposerInputMock 后一行建驱动，调用点签名
 * typeAndEnter(wrapper, text) 不变。
 */
export function makeTypeAndEnter(ComposerInputMock: Component) {
  return async (wrapper: ReturnType<typeof mount>, text: string): Promise<void> => {
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', text)
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick() // onSend 是 async，需 flush
  }
}

/**
 * ComposerInput mock 工厂（density-wiring / smoke / bash-mode / compact-queue /
 * dispatch-route / btw-button 共用 expose 面）：input 事件捕获进 lastInputText 供
 * getSegments 读段；testid 锚点供冒烟断言。beforeEach 重置 lastInputText.value = ''
 * 即可复用于下一用例。lastSetText 记录 setText 收到的值（孤儿草稿恢复类用例的落值观察面）。
 * extraEmits 供变体追加事件声明（makeFocusableComposerInputMock
 * 的 focus/blur 即经此注入）。expose 含 getText（Composer.vue 切 session 存草稿读它），
 * setup 返回 clear/setText 供 wrapper.vm 直取断言（bash/queue/dispatch 的 vm.clear 面）。
 */
function buildComposerInputMock(
  extraEmits: Record<string, null> = {},
  opts: { props?: Record<string, unknown>; extendExpose?: (lastInputText: Ref<string>) => Record<string, unknown> } = {},
) {
  const lastInputText = ref('')
  const lastSetText = ref<string | null>(null)
  const ComposerInputMock = defineComponent({
    name: 'ComposerInput',
    props: opts.props,
    emits: { input: (val: string) => { lastInputText.value = val; return true }, keydown: null, 'slash-trigger': null, 'file-trigger': null, ...extraEmits },
    setup(_, { expose }) {
      const clear = vi.fn()
      const setText = vi.fn((text: string) => { lastSetText.value = text })
      expose({ clear, setText, insertSlashChip: vi.fn(), getSegments: () => textToSegments(lastInputText.value), getText: () => lastInputText.value, ...opts.extendExpose?.(lastInputText) })
      return { clear, setText }
    },
    template: '<div data-testid="composer-input" />',
  })
  return { lastInputText, lastSetText, ComposerInputMock }
}

export function makeComposerInputMock() {
  return buildComposerInputMock()
}

/**
 * ComposerInput mock 的聚焦行为变体：emits 声明增 focus/blur（聚焦测试经
 * vm.$emit('focus'/'blur') 驱动 Composer 的 @focus/@blur 监听），expose 面与
 * 基型一致（聚焦测试只发事件，不读 expose 方法）。
 */
export function makeFocusableComposerInputMock() {
  return buildComposerInputMock({ focus: null, blur: null })
}

/**
 * ComposerInput mock 的键盘交互变体：声明 placeholder/disabled props（用例断言
 * input.props('placeholder') 透传，未声明则沦为 attr 读不到）+ expose 补
 * moveCaretVertical（composer-shell inputRef 契约成员，方向键处理消费）。
 */
export function makeKeyboardComposerInputMock() {
  return buildComposerInputMock({}, {
    props: { placeholder: { type: String, default: '' }, disabled: { type: Boolean, default: false } },
    extendExpose: () => ({ moveCaretVertical: () => 'edge' }),
  })
}
