/**
 * 首屏冒烟（渲染 gate，TC19）—— Landing 态 mount(Panel) 含 composer 输入区。
 *
 * 背景（AGENTS.md 首屏冒烟模板 + 2026-06-27 新建任务事故回归防护）：
 * 「新建任务」77 单测 + 24 集成全绿，用户打开却发现 Landing 态根本没有 composer
 * 输入区——测试只验了构建者视角（白盒状态），缺使用者（黑盒 DOM）视角。
 * 本用例 mount Panel 顶层容器，断言 Landing 态下 composer 输入区 + directory chip
 * 真实落在 DOM（真实 Composer 子树，非 stub）。
 *
 * 策略（对齐 landing-smoke.test.ts 既有范式）：
 * - mount(Panel, { sessionId: null })（Landing 态），Landing/Composer 均真实渲染
 * - 仅 mock useNewTaskFlow（Landing + Composer 的 session/cwd/branch 真源）+ useExtensionUI
 *   （Panel 的 ask-user 订阅）+ useChat（Composer 的 chat RPC）
 * - stub 重子组件（PanelHeader/MessageStream/AskUserOverlay + Composer 子组件
 *   + Landing 的 popover/modal 子组件），保留 ComposerInput mock（testid 断言）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-smoke.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import Panel from '@/components/panel/Panel.vue'

// ── useNewTaskFlow mock：Landing + Composer 的 session/cwd/branch/模型真源 ──
const flowMock = vi.hoisted(() => ({
  currentSessionId: { value: null as string | null },
  currentSession: { value: null as { launchPresetId?: string } | null },
  currentCwd: { value: null as string | null },
  currentModel: { value: null as string | null },
  gitInfo: { value: { branch: 'main' } as { branch: string } | null },
  mode: { value: 'plain-repo' as string },
  worktreeItems: { value: [] as Array<{ path: string; branch: string; HEAD: boolean; bare: boolean }> },
  state: { value: 'landing' as string },
  // panel-view 派生消费（D1：landing ⟺ !sessionId && isFlowActive）——TC19 的 Landing
  // 态挂载前提；flow mock 与 chat 解耦，true 恒定即可（挂载前求值，无响应式需求）
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
  // currentCwd 必须是真 ref：useProjectSkills 对它 watch（plain object 触发 Vue warn）
  const currentCwdRef = ref<string | null>(null)
  return {
    useNewTaskFlow: () => ({ ...flowMock, currentCwd: currentCwdRef }),
    resetNewTaskFlow: vi.fn(),
  }
})
// [w5] Landing 经 useNewTaskDeps 构造 NewTaskDeps + provide（ui 组件 inject 消费）；mock 返回 flowMock + deps 字段
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

// ── useExtensionUI mock（Panel 的 ask-user 订阅，ask-user-inline 范式）──
const uiMock = vi.hoisted(() => ({
  askUserReq: { value: undefined as { askUser?: boolean } | undefined },
  dialogReq: { value: undefined as { askUser?: boolean } | undefined },
  respond: () => {},
  cancel: () => {},
}))
vi.mock('@/composables/useExtensionUI', () => ({
  useExtensionUI: () => ({
    currentAskUserRequest: uiMock.askUserReq,
    respond: uiMock.respond,
    cancel: uiMock.cancel,
  }),
  askUserFilter: (req: { askUser?: boolean } | undefined) => req?.askUser === true,
}))

// ── useChat / useToast / @/api / stores mock（Composer 的 chat RPC + 队列 flush）──
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
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn(), revive: vi.fn() }),
}))

// ── ComposerInput mock（data-testid 供冒烟断言；emit keydown 驱动 onSend 范式与集成测试一致）──
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
    expose({ clear: vi.fn(), setText: vi.fn(), insertSlashChip: vi.fn(), getSegments: () => textToSegments(lastInputText.value) })
    return {}
  },
  template: '<div data-testid="composer-input" />',
})

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
const stubs = {
  // Panel 子组件
  PanelHeader: SIMPLE,
  MessageStream: SIMPLE,
  AskUserOverlay: SIMPLE,
  // Landing 子组件（popover/modal 重依赖）
  DirSelectPopover: SIMPLE,
  BranchSelectPopover: SIMPLE,
  CreateBranchModal: SIMPLE,
  CreateWorktreeModal: SIMPLE,
  PresetSelectChip: SIMPLE,
  // Composer 子组件（ComposerInput 保留 mock，badge 保留真实）
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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
  // 单例首次创建放 active effect scope（onScopeDispose 注册 cleanup，防 Vue warn），
  // 并清空所有分区（单例跨用例共享）
  effectScope().run(() => {
    useCompactQueue()
  })
  useCompactQueue()._clearAllForTest()
})

describe('首屏冒烟（TC19）', () => {
  it('Landing 态 mount(Panel) 含 composer 输入区 + directory chip', () => {
    // 真 Landing 态：无 session（首次启动/点新建）
    const wrapper = mount(Panel, {
      props: {
        panelId: 'panel-root',
        sessionId: null,
        sessionLabel: '',
        sessionDir: '',
        status: 'done',
      },
      global: { stubs },
    })

    // 使用者视角：composer 输入区真实在 DOM（Landing 内嵌的 Composer 子树）
    expect(wrapper.find('[data-testid="composer-input"]').exists()).toBe(true)
    // AC12：composer-box 容器（chip 行宿主：已附上下文 ContextChipsBar 渲染位）存在
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    // Landing 顶部元信息 chip（spec §3.1）
    expect(wrapper.find('[data-testid="chip-directory"]').exists()).toBe(true)
  })
})
