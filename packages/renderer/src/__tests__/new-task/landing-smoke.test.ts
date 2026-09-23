/**
 * 首屏冒烟（渲染 gate / 回归防护）。
 *
 * 背景：本次 bug——new-task 80 测试全绿，但 Landing 空态 composer 输入区实际缺失
 * （composer 未被 Landing 渲染），功能不可用。单测全绿是因为它们只验 Landing 自身
 * chip/重试按钮，没验「composer 真的在 DOM」。此用例填补该缺口：mount Landing，
 * 断言真实 Composer 子树（composer-box 输入卡片）+ directory/branch chip 落在 DOM。
 * 若再发生 composer 不渲染，本用例立刻红。
 *
 * 策略：不 stub Composer（要的就是真实 composer 在 DOM）。仅 mock useNewTaskFlow
 * （Landing 的 session/cwd/branch 真源）。Composer 子树 onMounted 的 api 调用全是
 * events 总线订阅注册（@/api/events、model.onModels），不触 WS，happy-dom 下安全。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Landing from '@/components/new-task/Landing.vue'

const flowMock = vi.hoisted(() => ({
  // Landing.vue 的 composerSid/cwd/branch computed 真源；默认空（首次启动态）
  currentSessionId: { value: null as string | null },
  // pi-launch-presets wave2: Landing 透传 launchPresetId 给 PresetSelectChip，需 currentSession
  currentSession: { value: null as { launchPresetId?: string } | null },
  currentCwd: { value: null as string | null },
  currentModel: { value: null as string | null },
  gitInfo: { value: { branch: 'main' } as { branch: string } | null },
  state: { value: 'landing' as string },
  mode: { value: 'plain-repo' as string },
  worktreeItems: { value: [] as Array<{ path: string; branch: string; HEAD: boolean; bare: boolean }> },
  startFlow: vi.fn(),
  presetCwd: vi.fn(),
  openDirPopover: vi.fn(),
  openBranchPopover: vi.fn(),
  openPresetPopover: vi.fn(),
  openCreateWorktree: vi.fn(),
  closeOverlay: vi.fn(),
  selectWorkspace: vi.fn(),
  selectBranch: vi.fn(),
  confirmDirtySwitch: vi.fn(),
  openDirDialog: vi.fn(),
  openBranchModal: vi.fn(),
  setPendingModel: vi.fn(),
  setPendingPreset: vi.fn(),
  // u4b：PendingPreset（显式选择档）是 Landing 的 displayPreset / ui chip 的 resolve 输入
  pendingPreset: { value: null as string | null },
}))
// [w5] NewTaskDeps mock（Landing 经 useNewTaskDeps 构造 + provide NewTaskDepsKey；
// ui 组件（PresetSelectChip 等）inject 消费。flow = flowMock）
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


beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 重置 flow 真源到「有 session / 有 cwd / 有 branch」的常态
  flowMock.currentSessionId.value = 's1'
  flowMock.currentCwd.value = '/repo'
  flowMock.gitInfo.value = { branch: 'main' }
  flowMock.state.value = 'idle'
  flowMock.pendingPreset.value = null
  depsMock.presets.value = []
  depsMock.defaultPresetId.value = ''
})

describe('首屏冒烟（渲染 gate）', () => {
  it('Landing 态 DOM 含 composer 输入卡片 + directory chip + branch chip', () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', gitBranch: 'main' },
    })
    // composer 输入卡片（Composer.vue composer-box，真实子树非 stub）
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    // 顶部 meta-row 元信息 chip（spec §3.1）
    expect(wrapper.find('[data-testid="chip-directory"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chip-branch"]').exists()).toBe(true)
  })

  it('directory chip 文案取末段目录名（与 flow 真源一致）', () => {
    flowMock.currentCwd.value = '/Users/zsw/Code/taiji'
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/stale-prop', gitBranch: 'main' },
    })
    // flow 真源优先于 props（selectWorkspace/openDirDialog create 的 session 不经 useSidebar）
    expect(wrapper.find('[data-testid="chip-directory"]').text()).toContain('taiji')
  })

  it('首次启动 sessionId=null → 发送按钮 disabled（AC-1.7 延迟 create）', () => {
    // 首次启动：无 session、无 cwd → composerSid=null → Composer canSend=false
    flowMock.currentSessionId.value = null
    flowMock.currentCwd.value = null
    const wrapper = mount(Landing, {
      props: { sessionId: null, currentCwd: null, gitBranch: 'main' },
    })
    // composer 仍渲染（variant=landing 容忍 null sid）
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    // 发送位 disabled 态 title 文案
    const sendBtn = wrapper.find('[title="输入内容后发送"]')
    expect(sendBtn.exists()).toBe(true)
    expect(sendBtn.attributes('disabled')).toBeDefined()
  })
})

/**
 * u4b 接线回归：landing 模式 chip 的「含替换提示词」信任标记。
 *
 * 设计 D3b / §7.1：**创建决策点必须常显该标记**（不是 hover 才有）。ui chip（u4a）的
 * `hasReplacePrompt` 缺省 false → 若 Landing 不接线，标记永不出现（静默丢失信任披露）。
 * 本用例补上 renderer 侧的透传断言：选中 replace.enabled && 文案非空的模式 → 出现。
 */
const MODE_PRESETS = [
  { id: 'builtin:full', name: '全工具模式', builtin: true, order: 0, toolMode: 'all', extensionMode: 'all' },
  {
    id: 'custom:dispatch',
    name: '调度模式',
    builtin: false,
    order: 1,
    toolMode: 'allowlist',
    allowedTools: ['read'],
    extensionMode: 'all',
    prompt: { replace: { enabled: true, prompt: '你是调度者，不要自己执行' } },
  },
]

describe('landing 模式 chip 信任标记接线（u4b）', () => {
  it('选中含替换提示词的模式 → chip 上常显「含替换提示词」标记（非 hover）', () => {
    depsMock.presets.value = MODE_PRESETS
    depsMock.defaultPresetId.value = 'builtin:full'
    flowMock.pendingPreset.value = 'custom:dispatch'
    // landing 态 = composerSid 为 null（ui chip 的 landing 分支才渲染可选 Popover chip）
    flowMock.currentSessionId.value = null
    const wrapper = mount(Landing, {
      props: { sessionId: null, currentCwd: '/repo', gitBranch: 'main' },
    })
    const chip = wrapper.find('[data-testid="chip-preset"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('调度模式')
    expect(chip.text()).toContain('含替换提示词')
  })

  it('选中无替换提示词的模式 → chip 不出现该标记（判据 replace.enabled && 文案非空）', () => {
    depsMock.presets.value = MODE_PRESETS
    depsMock.defaultPresetId.value = 'builtin:full'
    flowMock.pendingPreset.value = 'builtin:full'
    flowMock.currentSessionId.value = null
    const wrapper = mount(Landing, {
      props: { sessionId: null, currentCwd: '/repo', gitBranch: 'main' },
    })
    const chip = wrapper.find('[data-testid="chip-preset"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('全工具模式')
    expect(chip.text()).not.toContain('含替换提示词')
  })
})
