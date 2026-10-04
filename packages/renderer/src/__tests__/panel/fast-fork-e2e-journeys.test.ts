/**
 * fast-fork E2E 旅程集成测试（层 1）。
 *
 * 设计依据：.taiji-harness/fast-fork/changes/e2e-test-plan.md §2 层 1。
 * 与现有 4 个隔离测试（fork-entry-behavior / composer-fork-mode / fork-keymap / fork-group）的差异：
 * 现有测试每个只 mount 单组件 + mock 编排层。本文件用**分段断言拼接**覆盖 fork-ask 旅程——
 * 跨 mount 实例的真实链通在此受 jsdom 限制（Turn 与 Composer 各自独立 mount，channel→Composer 的
 * watch 联动由手动调 vm.enterForkMode 短路，非同进程信号传递）。
 *
 * 名实标注：**跨组件 channel 真实联动**（Turn 点击 → channel signal → Composer watch 自动进 fork 模式）
 * 留 Playwright E2E。本文件用分段断言拼接覆盖：
 *   - Turn 断言 signal 更新（点 fork 提问按钮 → useForkModeChannel.signal 携带 srcSessionId/fromMessageId）
 *   - Composer 手动调 enterForkMode 断言 fork 模式三重视觉
 *   - handleForkSend 断言 forkSessionAsk（sessionApi.fork + chatApi.send 新 session id）
 * 非真正跨 mount 实例链通（Turn 与 Composer 未同屏 mount，channel 经 watch 的真实投递未在此验证）。
 *
 * 只 mock 最底层 system boundary：api domain（RPC）+ useChat（流式依赖）。
 *
 * 用例覆盖（按计划 §2 汇总表，只写真正新增的增量）：
 *   E2E-L1-1 fork-ask 完整旅程（P0，最核心）
 *   E2E-L1-2 纯后台 fork 旅程——反馈行 + fresh 高亮增量
 *   E2E-L1-5 运行中 session 软停止——SessionList @abort → abortSession 联动（fork-group R4 已测菜单两段确认 emit，此处补上层 handler 联动）
 *
 * 已标注「已覆盖」的用例（E2E-L1-3 ⌘G/⌘⇧G、E2E-L1-4 Esc 退出、E2E-L1-6 血缘可见）此处不重复。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/fast-fork-e2e-journeys.test.ts
 *
 * 三视角规则（TEST-STRATEGY §3）：每条用例至少 1 个用户可见 DOM 断言（.exists()/.text()/.classes()），
 * 纯 toHaveBeenCalled 不计 DoD。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, ref, h, nextTick } from 'vue'
import type { Message, MessageTurn, SessionSummary, SessionGroup } from '@taiji/shared'
import { textToSegments } from '@taiji/shared'

// ── mock 最底层 api domain（层 1 只 mock RPC 返回，不 mock 编排）──
// 真实 useForkActions / useSidebar 内部 import { chat as chatApi, session as sessionApi } from '@/api'，
// 此 mock 让 fork/send/abort 调用可被 spy 断言，组件间交互保持真实。
// vi.hoisted：mock factory 被 vitest hoist 到文件顶部，引用的 mock 对象也必须 hoisted。
const { sessionApiMock, chatApiMock, useChatAbortMock } = vi.hoisted(() => ({
  sessionApiMock: {
    fork: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
    switchSession: vi.fn().mockResolvedValue(undefined),
    getCommands: vi.fn().mockResolvedValue({ commands: [] }),
    getContext: vi.fn().mockResolvedValue({}),
    setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })),
  },
  chatApiMock: {
    send: vi.fn(() => Promise.resolve()),
    steer: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
    abort: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
  },
  // 软停止上层联动断言锚点（useSidebarSessionActions.onAbortSession → useChat().abort）
  useChatAbortMock: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  session: sessionApiMock,
  chat: chatApiMock,
  model: { switchModel: vi.fn() },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
}))
// main 合并引入 useProjectSkills/useGlobalSkills（landing skill），与 fork 测试无关，stub 掉
vi.mock('@/composables/features/settings/useProjectSkills', () => ({
  useProjectSkills: () => ({ projectSkills: [] }),
  useGlobalSkills: () => ({ globalSkills: [] }),
}))

// ── mock useChat（流式依赖；fork 不走 send/steer，但 Composer setup 取这些引用）──
// 注意：必须返回稳定对象（同 composer-fork-mode.test.ts），避免每帧新引用导致 watch 抖动。
// ensureStreamSubscription 导出作 no-op stub：层 1 只验编排（fork RPC → send RPC），真实流式订阅由 useChat.test.ts 覆盖。
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    send: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: useChatAbortMock,
    compact: vi.fn(),
    editAndResend: vi.fn(),
    disposeSession: vi.fn(),
    hydrateHistory: vi.fn(),
  }),
  ensureStreamSubscription: vi.fn(),
}))
vi.mock('@/composables/features/drawer/useSideDrawer', () => ({ useSideDrawer: () => ({ open: vi.fn() }) }))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    submitFirstMessage: vi.fn(),
    currentModel: { value: null },
    setPendingModel: vi.fn(),
  }),
  resetNewTaskFlow: vi.fn(),
}))

// ── ComposerInput mock（同 composer-fork-mode.test.ts 范式，支持 emit input/keydown + defineExpose）──
const lastInputText = ref('')
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  props: { placeholder: { type: String, default: '' }, disabled: { type: Boolean, default: false } },
  emits: {
    input: (v: string) => { lastInputText.value = v; return true },
    keydown: null,
    'slash-trigger': null,
    'file-trigger': null,
  },
  setup(_, { expose }) {
    expose({
      clear: () => { lastInputText.value = '' },
      setText: vi.fn(),
      insertSlashChip: vi.fn(),
      focus: vi.fn(),
      getSegments: () => textToSegments(lastInputText.value),
      getText: () => lastInputText.value,
      moveCaretVertical: () => 'edge',
    })
    return () => h('div', { 'data-testid': 'composer-input' })
  },
})
const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
const otherComposerStubs = {
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

// ── 消息夹具（复用 fork-entry-behavior 范式）──
function makeAssistant(over: Partial<Message> = {}): Message {
  return {
    id: over.id ?? 'a1',
    role: 'assistant',
    content: over.content ?? 'AI 回复内容',
    status: over.status ?? 'complete',
    timestamp: over.timestamp ?? Date.now(),
    ...over,
  } as Message
}
function makeTurn(assistants: Message[]): MessageTurn {
  return {
    index: 1,
    user: {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: '问题' }],
      status: 'complete',
      timestamp: Date.now(),
    },
    assistants,
    isStreaming: false,
    hasFoldable: false,
  }
}

/** 构造 ⌘/Ctrl + key 的 KeyboardEvent（fork 用 ⌘G；Esc 用 Escape；Enter 用 Enter） */
function keyEvent(
  key: string,
  opts: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    metaKey: !!opts.meta,
    ctrlKey: !!opts.ctrl,
    shiftKey: !!opts.shift,
    bubbles: true,
    cancelable: true,
  })
}

// 延迟到 mock 声明之后 import 被测组件（vi.mock 被 hoist，组件 import 走 mock 后的 api）。
// [w6 chat-ui-and-shell T7] ui 包 Turn 经 deps.onForkAsk inject 消费（channel 触发迁 renderer 壳 useChatViewDeps）
import { Turn } from '@taiji/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'
import Composer from '@/components/panel/Composer.vue'
import { useChatStore } from '@/stores/chat'
import ForkNotice from '@/components/panel/ForkNotice.vue'
import SessionList from '@/components/sidebar/SessionList.vue'
import { useSidebarSessionActions } from '@/composables/features/sidebar/useSidebarSessionActions'

const onForkAskMock = vi.fn()

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

// ════════════════════════════════════════════════════════════════════════
// E2E-L1-1 · fork-ask 完整旅程（P0，最核心）
// 真实链通：renderer 壳 useChatViewDeps.onForkAsk → useForkModeChannel signal → Composer.enterForkMode →
//           handleForkSend → useForkActions.forkSessionAsk → sessionApi.fork + chatApi.send
// ════════════════════════════════════════════════════════════════════════
describe('E2E-L1-1: fork-ask 完整旅程（Turn → channel → Composer → forkSessionAsk）', () => {
  it('每条 assistant 区有 fork 提问按钮（data-testid 始终在 DOM，spec §1 门控已放开）', () => {
    const turn = makeTurn([
      makeAssistant({ id: 'a1', piEntryId: 'pi-a1' }),
      makeAssistant({ id: 'a2', piEntryId: 'pi-a2' }),
    ])
    const wrapper = mount(Turn, {
      props: { turn, sessionId: 's-src' },
      // HoverCard 子组件 stub 成内联渲染（绕开 reka-ui HoverCardPortal 在 happy-dom 不渲染）；
      // fork-ask-btn 现作为 fork split-button 的 hover 第二选项住在 HoverCardContent 内。
      global: {
        provide: mockChatProvide({ onForkAsk: onForkAskMock }),
        stubs: {
          Block: true,
          ChangeSetCard: true,
          MarkdownRenderer: true,
          HoverCard: { template: '<div><slot /></div>' },
          HoverCardTrigger: { template: '<div><slot /></div>' },
          HoverCardContent: { template: '<div><slot /></div>' },
        },
      },
    })
    // 用户可见：summary action 行有 fork 提问按钮（与复制同行，末条 assistant 位 1 组）
    const forkAskBtns = wrapper.findAll('[data-testid="fork-ask-btn"]')
    expect(forkAskBtns.length).toBe(1)
  })

  it('点 fork 提问按钮 → deps.onForkAsk(sessionId, message) 回调（channel signal 编排在 renderer 壳）', async () => {
    onForkAskMock.mockClear()
    const turn = makeTurn([makeAssistant({ id: 'a1', piEntryId: 'pi-a1' })])
    const wrapper = mount(Turn, {
      props: { turn, sessionId: 's-src' },
      global: {
        provide: mockChatProvide({ onForkAsk: onForkAskMock }),
        stubs: {
          Block: true,
          ChangeSetCard: true,
          MarkdownRenderer: true,
          HoverCard: { template: '<div><slot /></div>' },
          HoverCardTrigger: { template: '<div><slot /></div>' },
          HoverCardContent: { template: '<div><slot /></div>' },
        },
      },
    })

    await wrapper.find('[data-testid="fork-ask-btn"]').trigger('click')
    await nextTick()

    // 回调契约：ui TurnSummary 点 fork-ask → deps.onForkAsk(sessionId, message)（携带 srcSessionId + fromMessageId）
    expect(onForkAskMock).toHaveBeenCalledWith('s-src', expect.objectContaining({ id: 'a1' }))
  })

  it('Composer 订阅 channel：signal 命中本 session → 进入 fork 模式（三重视觉 DOM 可见）', async () => {
    const wrapper = mount(Composer, { props: { sessionId: 's-src' }, global: { stubs: otherComposerStubs } })
    const vm = wrapper.vm as unknown as { enterForkMode: (s: string, m: string) => void }
    // 模拟 signal 到达：手动调 enterForkMode（与 Composer watch signal 内部调法一致）
    vm.enterForkMode('s-src', 'a1')
    await nextTick()

    // 用户可见三重视觉：composer-box 含 fork-mode class
    const box = wrapper.find('[data-testid="composer-box"]')
    expect(box.classes()).toContain('fork-mode')
    // mode-chip DOM 存在
    expect(wrapper.find('[data-testid="composer-mode-chip"]').exists()).toBe(true)
    // placeholder 切换为 fork 提问语义（含 fork/提问）
    const placeholderProp = wrapper.findComponent(ComposerInputMock).props('placeholder') as string
    expect(/fork|提问/i.test(placeholderProp)).toBe(true)
  })

  it('fork 模式下输入 + Enter → forkSessionAsk 被调（sessionApi.fork + chatApi.send 新 session）', async () => {
    // 真实 useForkActions.forkSessionAsk 需要 chatStore 有可 fork 的消息
    const chat = useChatStore()
    chat.hydrate('s-src', [makeAssistant({ id: 'a1', piEntryId: 'pi-a1' })])
    // mock fork RPC 返回带血缘字段的 SessionSummary（对齐 runtime toSummary 契约，session-service.ts:706）
    const forkedSummary: SessionSummary = {
      id: 's-forked',
      label: 'fork',
      cwd: '/tmp',
      status: 'idle',
      lastActiveAt: Date.now(),
      parentSession: '/tmp/src.jsonl',
      forkEntryId: 'pi-a1',
    } as SessionSummary
    sessionApiMock.fork.mockResolvedValue(forkedSummary)

    const wrapper = mount(Composer, { props: { sessionId: 's-src' }, global: { stubs: otherComposerStubs } })
    const vm = wrapper.vm as unknown as {
      enterForkMode: (s: string, m: string) => void
      forkMode: { value: boolean }
    }
    vm.enterForkMode('s-src', 'a1')
    await nextTick()
    expect(vm.forkMode.value).toBe(true)

    // 输入 fork 提问内容
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '追问那条回复')
    await nextTick()
    // Enter 发送（fork 模式非活跃 → onSend → handleForkSend 短路，不走普通 send）
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', keyEvent('Enter'))
    await flushPromises()
    await nextTick()

    // fork RPC 被调 1 次，第 1 参 = 's-src'
    expect(sessionApiMock.fork).toHaveBeenCalledTimes(1)
    expect(sessionApiMock.fork.mock.calls[0][0]).toBe('s-src')
    // chat.send 被调，第 1 参 = 新 session id（'s-forked'，非主线 's-src'）
    expect(chatApiMock.send).toHaveBeenCalledTimes(1)
    expect(chatApiMock.send.mock.calls[0][0]).toBe('s-forked')
    // forkMode 自动复位 false（发送后退出 fork 模式）
    expect(vm.forkMode.value).toBe(false)
    // 用户可见：composer-box 已退出 fork-mode class
    expect(wrapper.find('[data-testid="composer-box"]').classes()).not.toContain('fork-mode')
  })
})

// ════════════════════════════════════════════════════════════════════════
// E2E-L1-1 子用例 · 反馈行渲染契约（mount ForkNotice，验证 askedPrefix）
// ════════════════════════════════════════════════════════════════════════
describe('E2E-L1-1 反馈行：fork-ask 成功后 ForkNotice 走 askedPrefix + 提问预览', () => {
  it('preview 模式反馈行：含提问预览文本 + 查看链接可点（文案为「查看分支」）', () => {
    const wrapper = mount(ForkNotice, {
      props: { preview: '追问那条', sessionDeleted: false },
      global: { plugins: [createPinia()] },
    })
    // 反馈行 class（非 banner）
    expect(wrapper.find('.fork-notice').exists()).toBe(true)
    // 含提问预览文本（用户可见）
    expect(wrapper.text()).toContain('追问那条')
    // 查看链接存在且可点（无 disabled）
    const viewLink = wrapper.find('[data-testid="fork-notice-view"]')
    expect(viewLink.exists()).toBe(true)
    expect(viewLink.attributes('disabled')).toBeFalsy()
    // P4：有 preview → 文案为「查看分支」
    expect(viewLink.text()).toContain('查看分支')
  })
})

// ════════════════════════════════════════════════════════════════════════
// E2E-L1-1 子用例 · 侧栏新增分支（mount SessionList，fork session 不聚合——D9 扁平行）
// ════════════════════════════════════════════════════════════════════════
describe('E2E-L1-1 侧栏：forkSessionAsk 成功 → appendSession → SessionList 渲染为扁平行（D9）', () => {
  it('groups 含父 session + fork 分支（parentSession 指向父）→ 两条扁平行 + 分支血缘可见', () => {
    const parent: SessionSummary = {
      id: 's-src', label: '主线会话', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(),
      sessionFile: '/tmp/src.jsonl',
    } as SessionSummary
    const branch: SessionSummary = {
      id: 's-forked', label: '追问那条', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(),
      parentSession: '/tmp/src.jsonl', forkEntryId: 'pi-a1',
    } as SessionSummary
    const groups: SessionGroup[] = [{ cwd: '/tmp', sessions: [parent, branch] }]

    const wrapper = mount(SessionList, {
      props: { groups, activeId: 's-src', statusOf: () => 'done' as never },
    })

    // D9 不聚合：父 + fork 分支各占一行（ForkGroup 退役后分支不再折进聚合容器）
    const rows = wrapper.findAll('.session-item')
    expect(rows).toHaveLength(2)
    const branchRow = rows.find((r) => r.text().includes('追问那条'))
    expect(branchRow).toBeTruthy()
    // 分支自身行展示血缘（用户可见 sub 行）
    expect(branchRow!.text()).toContain('fork 自')
    // 聚合容器退役：无 ForkGroup 组件 / 无 fork-group-* testid
    expect(wrapper.findComponent({ name: 'ForkGroup' }).exists()).toBe(false)
    expect(wrapper.find('[data-testid^="fork-group"]').exists()).toBe(false)
  })

  it('无分支的 session 仍是单行，无聚合容器（spec §4「无分支不渲染空容器」）', () => {
    const plain: SessionSummary = {
      id: 's-plain', label: '普通会话', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(),
    } as SessionSummary
    const groups: SessionGroup[] = [{ cwd: '/tmp', sessions: [plain] }]
    const wrapper = mount(SessionList, {
      props: { groups, activeId: 's-plain', statusOf: () => 'done' as never },
    })
    expect(wrapper.findAll('.session-item')).toHaveLength(1)
    expect(wrapper.findComponent({ name: 'ForkGroup' }).exists()).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════
// E2E-L1-2 · 纯后台 fork 旅程——反馈行端到端增量
// 现有 fork-entry-behavior U8 已测「forkSession 不 split」。此处补：反馈行渲染契约。
// [D9] fork 分支 fresh 高亮随 ForkGroup 退役（fresh 不在两项迁移能力内——只迁未读角标与软停止），
// 原「fresh class 3.2s 淡出」用例随已删元素一并退役，不再对不存在的 testid 断言。
// ════════════════════════════════════════════════════════════════════════
describe('E2E-L1-2: 纯后台 fork 反馈行（forkedPrefix）', () => {
  it('纯后台 fork 反馈行：forkedPrefix 文案 + 查看链接文案为「查看」（P4 区分 fork-ask）', () => {
    const wrapper = mount(ForkNotice, {
      // 纯 fork：只有 branchName 无 preview
      props: { branchName: '主分支 · 分支 1', sessionDeleted: false },
      global: { plugins: [createPinia()] },
    })
    expect(wrapper.find('.fork-notice').exists()).toBe(true)
    // forkedPrefix 文案（i18n key panel.forkNotice.forkedPrefix = 「已 fork 到后台」）
    expect(wrapper.text()).toContain('已 fork 到后台')
    // 分支名可见
    expect(wrapper.text()).toContain('主分支 · 分支 1')
    // P4：无 preview → 文案为「查看」（非「查看分支」）
    const viewLink = wrapper.find('[data-testid="fork-notice-view"]')
    expect(viewLink.exists()).toBe(true)
    expect(viewLink.text()).toContain('查看')
    expect(viewLink.text()).not.toContain('查看分支')
  })
})

// ════════════════════════════════════════════════════════════════════════
// E2E-L1-5 · 运行中 session 软停止——SessionList @abort → abortSession 联动（增量）
// 现有 fork-group R4 已测通用行菜单「停止」两段确认 emit abort。此处补上层联动：
// ① SessionList 消费运行中分支行的 abort → emit abort（带 sessionId）；
// ② Sidebar 的 handler（useSidebarSessionActions.onAbortSession）→ useChat().abort(id)。
// [D9] 原「SessionList @stop → stopBranch」链路随 ForkGroup 退役；软停止入口迁入通用 SessionItem 右键菜单。
// ════════════════════════════════════════════════════════════════════════
describe('E2E-L1-5: 运行中 session 软停止 → SessionList @abort → abortSession', () => {
  it('运行中分支行两段确认「停止」→ SessionList emit abort（带 sessionId）', async () => {
    const parent: SessionSummary = {
      id: 's-src', label: '主线', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(),
      sessionFile: '/tmp/src.jsonl',
    } as SessionSummary
    const runningBranch: SessionSummary = {
      id: 'b-running', label: '运行中分支', cwd: '/tmp', status: 'active', lastActiveAt: Date.now(),
      parentSession: '/tmp/src.jsonl',
    } as SessionSummary
    const groups: SessionGroup[] = [{ cwd: '/tmp', sessions: [parent, runningBranch] }]
    const wrapper = mount(SessionList, {
      attachTo: document.body,
      props: { groups, activeId: 's-src', statusOf: () => 'done' as never },
    })

    // 定位运行中分支行（第二行，status='active' → canStop）并打开右键菜单
    const rows = wrapper.findAll('.session-item')
    expect(rows).toHaveLength(2)
    await rows[1].trigger('contextmenu')
    await nextTick()
    await nextTick()

    const stopItem = document.body.querySelector('[data-testid="session-stop-item"]') as HTMLElement | null
    expect(stopItem).not.toBeNull()
    // 首击 → 进确认态（不 emit）
    stopItem!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('abort')).toBeUndefined()
    // 再击 → SessionList emit abort（上层据此调 abortSession）
    const confirming = document.body.querySelector('[data-testid="session-stop-item"]') as HTMLElement
    confirming.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('abort')).toEqual([['b-running']])
  })

  it('useSidebarSessionActions.onAbortSession(id) → useChat().abort(id)（SessionList 上层 handler 联动）', () => {
    const { onAbortSession } = useSidebarSessionActions({
      selectSession: vi.fn(async () => {}),
      restoreSession: vi.fn(async () => {}),
      newSession: vi.fn(async () => null),
      loadSessions: vi.fn(),
      renameSession: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => {}),
      deleteFolder: vi.fn(async () => ({ failed: [] })),
      assignSessionToProject: vi.fn(async () => {}),
      renameOpen: ref(false),
      targetSessionId: ref(''),
    })

    onAbortSession('b-running')

    expect(useChatAbortMock).toHaveBeenCalledWith('b-running')
  })
})
