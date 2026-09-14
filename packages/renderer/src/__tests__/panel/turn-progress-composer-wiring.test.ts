/**
 * TurnProgressBar → abort 链路接线测试（u4 验收④：「中止操作走既有 abort 链路」）。
 *
 * 断言链路（真实组件树 + 真实 pinia store，仅 RPC 面 mock）：
 * TurnProgressBar「中止此 turn」点击 → emit abort → Panel.onProgressAbort
 * → useChat.abort(sessionId)（core dispatch/submit onAbort 同源原语）
 * → chatApi.abort(sessionId)（既有 abort RPC 通路，与 Composer stop 按钮同一条链——
 * 不新增任何中止通道）。
 *
 * [session-dead V5② / remove-turn-progress-bar §2.2] TurnProgressBar 挂载点自 Composer
 * 内提升到 Panel composer-band（overlay/composer 互斥对之外）；warn 化后组件自判渲染
 * （snapshot && snapshot.warn，常态/ask_user 豁免期零 DOM），挂载点仅承载存在性与 abort
 * 接线（staging abortIfInProgress 优先级不保留，见 Panel.vue 挂载处注释）。本文件同锁
 * dead 排除（A6/W6：dead 优先级吞掉活跃 UI——occupancy 残留非 idle 也不渲染警示条）。
 *
 * mock/stub 集合对齐 composer-smoke.test.ts 既有范式（Panel 真实子树挂 Composer），
 * TurnProgressBar 刻意**不进 stub 表**（接线对象必须真实渲染）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/turn-progress-composer-wiring.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { defineComponent, effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import Panel from '@/components/panel/Panel.vue'
import { useChatStore } from '@/stores/chat'
import { TURN_PROGRESS_WARN_THRESHOLD_MS } from '@xyz-agent/core'

const SID = 's-wire'

// ── useNewTaskFlow mock（Landing + Composer 的 session/cwd/branch/模型真源，同 composer-smoke）──
const flowMock = vi.hoisted(() => ({
  currentSessionId: { value: 's-wire' as string | null },
  currentSession: { value: null as { launchPresetId?: string } | null },
  currentCwd: { value: null as string | null },
  currentModel: { value: null as string | null },
  gitInfo: { value: { branch: 'main' } as { branch: string } | null },
  mode: { value: 'plain-repo' as string },
  worktreeItems: { value: [] as Array<{ path: string; branch: string; HEAD: boolean; bare: boolean }> },
  state: { value: 'landing' as string },
  isActive: { value: true as boolean },
  startFlow: vi.fn(),
  presetCwd: vi.fn(),
  openDirPopover: vi.fn(),
  openBranchPopover: vi.fn(),
  openPresetPopover: vi.fn(),
  closeOverlay: vi.fn(),
  selectWorkspace: vi.fn(),
  selectBranch: vi.fn(),
  setPendingPreset: vi.fn(),
  confirmDirtySwitch: vi.fn(),
  openDirDialog: vi.fn(),
  openBranchModal: vi.fn(),
  openCreateWorktree: vi.fn(),
  setPendingModel: vi.fn(),
  submitFirstMessage: vi.fn(),
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => {
  const currentCwdRef = ref<string | null>(null)
  return {
    useNewTaskFlow: () => ({ ...flowMock, currentCwd: currentCwdRef }),
    resetNewTaskFlow: vi.fn(),
  }
})
const depsMock = vi.hoisted(() => ({
  recentWorkspaces: { value: [] as unknown[] },
  listBranches: vi.fn(),
  createWorktree: vi.fn(),
  detectWorkspace: vi.fn(),
  pickDirectory: vi.fn(),
  presets: { value: [] as unknown[] },
  defaultPresetId: { value: '' },
  presetOpenRequest: { value: 0 },
  loadPresets: vi.fn(),
  setDefaultPreset: vi.fn(),
  toast: { error: vi.fn() },
}))
vi.mock('@/composables/features/new-task/useNewTaskDeps', () => ({
  useNewTaskDeps: () => ({ flow: flowMock, ...depsMock }),
}))

// ── useExtensionUI mock（Panel 的 ask-user 订阅）──
const uiMock = vi.hoisted(() => ({
  askUserReq: { value: undefined as unknown },
  respond: vi.fn(),
  cancel: vi.fn(),
}))
vi.mock('@/composables/useExtensionUI', () => ({
  useExtensionUI: () => ({
    currentAskUserRequest: uiMock.askUserReq,
    respond: uiMock.respond,
    cancel: uiMock.cancel,
  }),
  askUserFilter: (req: { askUser?: boolean } | undefined) => req?.askUser === true,
}))

// ── chat RPC mock：abort 是本测试的断言锚（既有 abort 链路出口）──
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
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { send: chatApiMock.send, steer: chatApiMock.steer },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn() },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
  config: { getGlobalSkills: vi.fn().mockResolvedValue([]), getProjectSkills: vi.fn().mockResolvedValue([]), onSkillCacheInvalidated: () => () => {} },
}))
// session store mock：list 用稳定数组引用（usePanelView 的 isSessionDead 读
 // list.find(...).status === 'dead'——dead 测试挂载前写入，无需响应式）
const sessionList = vi.hoisted(() => [] as Array<{ id: string; status: string }>)
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: sessionList, applySnapshot: vi.fn(), revive: vi.fn() }),
}))

const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  emits: ['input', 'keydown', 'slash-trigger', 'file-trigger'],
  setup(_, { expose }) {
    expose({ clear: vi.fn(), setText: vi.fn(), insertSlashChip: vi.fn(), getSegments: () => [] })
    return {}
  },
  template: '<div data-testid="composer-input" />',
})

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
const stubs = {
  PanelHeader: SIMPLE,
  MessageStream: SIMPLE,
  AskUserOverlay: SIMPLE,
  DirSelectPopover: SIMPLE,
  BranchSelectPopover: SIMPLE,
  CreateBranchModal: SIMPLE,
  CreateWorktreeModal: SIMPLE,
  PresetSelectChip: SIMPLE,
  // Composer 子组件（ComposerInput 保留 mock；TurnProgressBar 刻意不 stub——接线对象真实渲染）
  ComposerInput: ComposerInputMock,
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  GenStatsTriggers: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  sessionList.length = 0
  effectScope().run(() => {
    useCompactQueue()
  })
  useCompactQueue()._clearAllForTest()
})

describe('中止接线（u4 验收④）：TurnProgressBar → 既有 abort 链路', () => {
  it('点击「中止此 turn」→ chatApi.abort(sessionId) 被调（与 stop 按钮同链，无新通道）', async () => {
    const wrapper = mount(Panel, {
      props: {
        panelId: 'panel-root',
        sessionId: SID,
        sessionLabel: SID,
        sessionDir: '/repo',
        status: 'done' as never,
      },
      global: { stubs },
    })
    // 真实 chat store 构造活跃 turn（occupancy 帧 + message_start 事件）
    const store = useChatStore()
    store.setOccupancy(SID, { turn: 'generating', compacting: false, bash: false })
    store.applyMessageEvent(SID, { type: 'message.message_start', payload: { sessionId: SID, messageId: 'a1' } })
    await nextTick()
    // 超阈值 → 操作项出现（用户可见）
    vi.advanceTimersByTime(TURN_PROGRESS_WARN_THRESHOLD_MS + 1_000)
    await nextTick()
    const abortBtn = wrapper.find('[data-testid="turn-progress-abort"]')
    expect(abortBtn.exists()).toBe(true)
    // 用户点击 → emit abort → Panel.onProgressAbort → useChat.abort → chatApi.abort
    await abortBtn.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    await nextTick()
    expect(chatApiMock.abort).toHaveBeenCalledTimes(1)
    expect(chatApiMock.abort).toHaveBeenCalledWith(SID)
  })

  it('A6 dead 排除（W6）：session dead 态即使 occupancy 残留活跃，警示条也不渲染', async () => {
    // dead 事实先于挂载写入（usePanelView 的 isSessionDead 读 sessionList 快照）
    sessionList.push({ id: SID, status: 'dead' })
    const wrapper = mount(Panel, {
      props: {
        panelId: 'panel-root',
        sessionId: SID,
        sessionLabel: SID,
        sessionDir: '/repo',
        status: 'done' as never,
      },
      global: { stubs },
    })
    // pi 异常退出后 occupancy 不被 markSessionError 复位 → turn 维度残留活跃
    const store = useChatStore()
    store.setOccupancy(SID, { turn: 'generating', compacting: false, bash: false })
    store.applyMessageEvent(SID, { type: 'message.message_start', payload: { sessionId: SID, messageId: 'a1' } })
    await nextTick()
    vi.advanceTimersByTime(TURN_PROGRESS_WARN_THRESHOLD_MS + 1_000)
    await nextTick()
    // dead 占位上方不得挂警示条（状态撒谎复发防线）
    expect(wrapper.find('[data-testid="turn-progress-bar"]').exists()).toBe(false)
  })
})
