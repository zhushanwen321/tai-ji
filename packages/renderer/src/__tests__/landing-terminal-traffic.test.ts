/**
 * 合并产物（round5-f S3 簇 1-6 拆对子集；round6 并入 terminal/terminal-view.test.ts）。
 *
 * 来源四文件（describe/it 原样搬运）：
 * - new-task/landing-smoke.test.ts（6 例）
 * - terminal/terminal-view-spawn-error.test.ts（6 例）
 * - shell/TrafficLight.test.ts（7 例）
 * - terminal/terminal-view.test.ts（15 例，round6 并入；与本产物 terminal 节
 *   xterm 系 + useTerminal + @/stores/session mock 脚手架同款——selectInstance
 *   取其带 activeRef 落位实现（超集），xterm 实例登记数组并入，beforeEach 复位集合并）
 * 环境全默认。剔出：assembly-check.test.ts（其真实 useSidebar 链消费
 * @/stores/session 与 @/lib/ipc 成员，与本产物 terminal 节 session 窄 mock、
 * TrafficLight 节 ipc 窄 mock 互斥——单文件保留）。各节 mock 模块互异
 * （useNewTaskDeps / xterm 系+useTerminal+@/stores/session / usePlatformChrome+@/lib/ipc），
 * 复筛已核：Composer 真实链仅读 sessionStore.list（terminal mock 恰提供 list），
 * useNewTaskFlow 的 @/lib/ipc 成员在 landing 测试路径不解引用。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'
import Landing from '@/components/new-task/Landing.vue'
import TerminalView from '@/components/panel/TerminalView.vue'
import TrafficLight from '@/components/shell/TrafficLight.vue'
import { useToast } from '@/composables/useToast'
import { platformChromeMock, expectFullscreenChromePairing } from '@/__tests__/helpers/platform-chrome-mock'
// ═══ 来源：new-task/landing-smoke.test.ts ═══
const flowMock = vi.hoisted(() => ({
  // Landing.vue 的 composerSid/cwd/branch computed 真源；默认空（首次启动态）
  currentSessionId: { value: null as string | null },
  // pi-launch-presets wave2: Landing 透传 launchPresetId 给 PresetSelectChip，需 currentSession
  currentSession: { value: null as { launchPresetId?: string } | null },
  currentCwd: { value: null as string | null },
  currentModel: { value: null as string | null },
  gitInfo: { value: { branch: 'main' } as { branch: string } | null },
  state: { value: 'landing' as string },
  // [perf-landing] 首发提交飞行标记（Landing 创建中过渡视图判据）
  isInflight: { value: false as boolean },
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
  setPinned: vi.fn(),
  defaultSessionDir: { value: '' },
  projects: { value: [] as unknown[] },
  activeProjectId: { value: 'proj-default' },
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

  it('首屏级联入场类挂载（demo 裁决 9A 可落部分：问候语 → composer 卡片两档）', () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', gitBranch: 'main' },
    })
    // 级联档类：问候语首档 + composer 卡片次档（动画参数在 scoped CSS，DOM 断言挂载点）
    expect(wrapper.find('h1.landing-cascade-greet').exists()).toBe(true)
    expect(wrapper.find('.landing-cascade-composer [data-testid="composer-box"]').exists()).toBe(
      true,
    )
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

// ═══ 来源：terminal/terminal-view-spawn-error.test.ts ═══
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

const xtermInstances = vi.hoisted(() => [] as Array<Record<string, ReturnType<typeof vi.fn>>>)
function createMockTerminal() {
  const instance = {
    onData: vi.fn(),
    onResize: vi.fn(),
    onSelectionChange: vi.fn(),
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    focus: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ''),
    getSelectionPosition: vi.fn(() => ({ start: { x: 0, y: 0 }, end: { x: 5, y: 0 } })),
    unicode: { activeVersion: '6' },
  }
  xtermInstances.push(instance)
  return instance
}
vi.mock('@xterm/xterm', () => ({
  Terminal: function MockTerminal() { return createMockTerminal() },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: function MockFitAddon() {
    return { fit: vi.fn(), proposeDimensions: () => ({ cols: 80, rows: 24 }) }
  },
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: function () { return {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: function () { return {} } }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: function () { return {} } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const mockState = {
  buffer: { chunks: [] as string[], version: 0 },
  outputQueue: [] as string[],
  rafPending: false,
  ptyAlive: false,
  cols: 80,
  rows: 24,
}
const currentRef = ref(mockState)
const instancesRef = ref<Array<{ terminalId: string; seq: number; alive: boolean }>>([])
const activeRef = ref<string | null>(null)
const spawnTerminalMock = vi.fn(() => Promise.resolve('term:test-session:1'))
const useTerminalMock = {
  current: currentRef,
  instances: instancesRef,
  activeTerminalId: activeRef,
  spawnTerminal: spawnTerminalMock,
  // spawnTerminalAuto 同一替身：自动新建路径经互斥入口仍委托同一 spawn 面（dmg-r1-3）
  spawnTerminalAuto: spawnTerminalMock,
  selectInstance: vi.fn((terminalId: string) => {
    activeRef.value = terminalId
  }),
  closeInstance: vi.fn(),
  reconcileInstances: vi.fn(async () => ({ ok: true, count: 0 })),
  writeToTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  killTerminal: vi.fn(),
  attachTerminal: vi.fn(),
  partitionOf: vi.fn(() => mockState),
  registerFlushListener: vi.fn(() => () => {}),
}
vi.mock('@/composables/features/terminal/useTerminal', () => ({
  useTerminal: () => useTerminalMock,
  replayChunks: () => null,
  replayChunksBatched: () => null,
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    list: [{ id: 'test-session', cwd: '/tmp/test-cwd' }],
  }),
}))


let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  mockState.buffer = { chunks: [], version: 0 }
  mockState.outputQueue = []
  mockState.rafPending = false
  mockState.ptyAlive = false
  mockState.cols = 80
  mockState.rows = 24
  instancesRef.value = []
  activeRef.value = null
  useToast().toasts.value = []
  spawnTerminalMock.mockReset()
  spawnTerminalMock.mockResolvedValue('term:test-session:1')
  useTerminalMock.reconcileInstances.mockReset()
  useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 0 })
  // ── 源: terminal-view.test.ts 的复位集（与本节共享 mock 单例）──
  xtermInstances.length = 0
  useTerminalMock.spawnTerminal.mockClear()
  useTerminalMock.attachTerminal.mockClear()
  useTerminalMock.killTerminal.mockClear()
  useTerminalMock.selectInstance.mockClear()
  useTerminalMock.closeInstance.mockClear()
  useTerminalMock.registerFlushListener.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('TerminalView spawn 失败 inline 错误条（RD-5#2 挂载自动新建路径）', () => {
  it('spawn resolve → 不显示错误条', async () => {
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(spawnTerminalMock).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeNull()
  })

  it('spawn reject → inline 错误条显示（含错误信息）+ 重试按钮', async () => {
    spawnTerminalMock.mockRejectedValue(new Error('pty limit reached'))
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    const bar = document.body.querySelector('[data-testid="terminal-spawn-error"]')
    expect(bar).toBeTruthy()
    expect(bar?.textContent).toContain('pty limit reached')
    expect(document.body.querySelector('[data-testid="terminal-spawn-retry"]')).toBeTruthy()
  })

  it('点重试 → 清错误条并重发 spawn；重试成功则错误条消失', async () => {
    spawnTerminalMock.mockRejectedValueOnce(new Error('transient'))
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeTruthy()
    expect(spawnTerminalMock).toHaveBeenCalledTimes(1)

    const retry = document.body.querySelector('[data-testid="terminal-spawn-retry"]') as HTMLButtonElement
    retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(spawnTerminalMock).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeNull()
  })

  it('对账清单非空（后台实例存活）→ 不 spawn、不显示错误条', async () => {
    instancesRef.value = [{ terminalId: 'term:test-session:1', seq: 1, alive: true }]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 1 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(spawnTerminalMock).not.toHaveBeenCalled()
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeNull()
  })

  it('「+」手动新建失败 → 走全局错误通道（toast），不出现 inline 错误条', async () => {
    instancesRef.value = [{ terminalId: 'term:test-session:1', seq: 1, alive: true }]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 1 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()
    spawnTerminalMock.mockRejectedValueOnce(new Error('spawn boom'))

    const create = document.body.querySelector('[data-testid="terminal-instance-create"]') as HTMLButtonElement
    create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(useToast().toasts.value).toHaveLength(1)
    expect(useToast().toasts.value[0]!.type).toBe('error')
    expect(useToast().toasts.value[0]!.message).toContain('spawn boom')
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeNull()
  })

  it('挂载路径失败后点「+」新建成功 → 撤下 inline 错误条（错误态不跨路径泄漏）', async () => {
    spawnTerminalMock.mockRejectedValueOnce(new Error('mount boom'))
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeTruthy()

    // 「+」成功（spawnTerminalMock 默认 resolve）——错误态不得跨路径泄漏到已成功新建的场景
    const create = document.body.querySelector('[data-testid="terminal-instance-create"]') as HTMLButtonElement
    create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(document.body.querySelector('[data-testid="terminal-spawn-error"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="terminal-spawn-retry"]')).toBeNull()
    expect(useToast().toasts.value).toHaveLength(0)
  })
})

// ═══ 来源：shell/TrafficLight.test.ts ═══

// usePlatformChrome mock：共享态在 helpers/platform-chrome-mock（isFullscreen 换装真 ref 供测试改值）；
// 本文件默认平台 win（mac 用例逐点覆写 detectPlatform）
vi.mock('@/composables/effects/usePlatformChrome', async () => {
  const { installPlatformChromeMock } = await import('@/__tests__/helpers/platform-chrome-mock')
  return installPlatformChromeMock('win')
})

/** @/lib/ipc mock：窗口控制 spy（TrafficLight 唯一消费方） */
const ipcMock = vi.hoisted(() => ({
  windowClose: vi.fn(),
  windowMinimize: vi.fn(),
  windowToggleMaximize: vi.fn(),
}))
vi.mock('@/lib/ipc', () => ({
  windowClose: ipcMock.windowClose,
  windowMinimize: ipcMock.windowMinimize,
  windowToggleMaximize: ipcMock.windowToggleMaximize,
}))


beforeEach(() => {
  vi.clearAllMocks()
  platformChromeMock.isFullscreen.value = false
  platformChromeMock.detectPlatform.mockReturnValue('win')
})

describe('TrafficLight win/linux 交互路径', () => {
  it('win 态渲染 3 个自绘圆点（红 close / 黄 minimize / 绿 maximize）', () => {
    const wrapper = mount(TrafficLight)
    const dots = wrapper.findAll('.tl-dot')
    expect(dots).toHaveLength(3)
    // aria-label 映射：close / minimize / maximize（i18n zh-CN：关闭/最小化/最大化）
    const labels = dots.map((d) => d.attributes('aria-label'))
    expect(labels).toEqual(['关闭', '最小化', '最大化'])
  })

  it('点击各圆点分别触发 windowClose / windowMinimize / windowToggleMaximize IPC', async () => {
    const wrapper = mount(TrafficLight)
    const dots = wrapper.findAll('.tl-dot')

    // 红点（close）→ windowClose
    await dots[0].trigger('click')
    expect(ipcMock.windowClose).toHaveBeenCalledTimes(1)
    expect(ipcMock.windowMinimize).not.toHaveBeenCalled()
    expect(ipcMock.windowToggleMaximize).not.toHaveBeenCalled()

    // 黄点（minimize）→ windowMinimize
    await dots[1].trigger('click')
    expect(ipcMock.windowMinimize).toHaveBeenCalledTimes(1)

    // 绿点（maximize）→ windowToggleMaximize
    await dots[2].trigger('click')
    expect(ipcMock.windowToggleMaximize).toHaveBeenCalledTimes(1)
  })

  it('mac 态不渲染自绘圆点（红黄绿由 OS 绘制），IPC 不可达', async () => {
    platformChromeMock.detectPlatform.mockReturnValue('mac')
    const wrapper = mount(TrafficLight)

    // 模板 v-if !isMac：无任何按钮/圆点可点击
    expect(wrapper.findAll('.tl-dot')).toHaveLength(0)
    expect(wrapper.findAll('button')).toHaveLength(0)

    // 空占位 div 上点击不触发任何窗口控制 IPC
    await wrapper.find('.traffic-light').trigger('click')
    expect(ipcMock.windowClose).not.toHaveBeenCalled()
    expect(ipcMock.windowMinimize).not.toHaveBeenCalled()
    expect(ipcMock.windowToggleMaximize).not.toHaveBeenCalled()
  })

  it('全屏态根 div opacity-0 + pointer-events-none 成对（review MF-1 防隐形劫持）', async () => {
    const wrapper = mount(TrafficLight)
    await expectFullscreenChromePairing(wrapper.find('.traffic-light'), async (v) => {
      platformChromeMock.isFullscreen.value = v
      await nextTick()
    })
  })
})

describe('TrafficLight issue #24 缺陷修复（悬停同色 / 图标 8px / no-drag）', () => {
  it('缺陷 A 悬停同色覆盖：逐点 hover:!bg-<同色> 在 class 列表，透明化类已移除', async () => {
    const wrapper = mount(TrafficLight)
    const dots = wrapper.findAll('.tl-dot')

    // 旧 hover:bg-transparent 会把圆点自身底色一并透明化（悬停即消失），必须移除
    for (const dot of dots) {
      expect(dot.classes()).not.toContain('hover:bg-transparent')
    }

    // 逐点同色覆盖类与底色类同源同色（红/黄/绿各持 hover:!bg-<色>，压 ghost hover:bg-surface-hover 灰底且保住自身底色）
    const colors = ['#ff5f57', '#febc2e', '#28c840']
    dots.forEach((dot, i) => {
      expect(dot.classes()).toContain(`bg-[${colors[i]}]`)
      expect(dot.classes()).toContain(`hover:!bg-[${colors[i]}]`)
    })

    // 触发 hover：覆盖类保持生效形态（jsdom 不套用 :hover 样式，类列表即确定性证据）
    await dots[0].trigger('mouseenter')
    expect(dots[0].classes()).toContain('hover:!bg-[#ff5f57]')
    expect(dots[0].classes()).not.toContain('hover:bg-transparent')
  })

  it('缺陷 B 图标锁定：圆点内 svg 持普通 size-2 覆盖类（压 lucide :size=8 属性）且实际渲染', () => {
    const wrapper = mount(TrafficLight)
    const dots = wrapper.findAll('.tl-dot')

    // lucide :size=8 写的是 width/height 属性，任何 CSS 规则都会覆盖属性——svg 普通类
    // size-2 即可锁定尺寸（Button 基类图标默认规则已零特异性，不与使用方类竞争）
    dots.forEach((dot) => {
      const svg = dot.find('svg')
      expect(svg.exists()).toBe(true)
      expect(svg.classes()).toContain('size-2')
    })
  })

  it('圆点组容器 no-drag：[-webkit-app-region:no-drag] 保住拖拽条带之上的点击命中', () => {
    const wrapper = mount(TrafficLight)
    const tl = wrapper.find('.traffic-light')
    // 容器叠在侧栏顶部 drag 条带（U2）之上，no-drag 显式声明防点击被拖拽区吞掉
    expect(tl.classes()).toContain('[-webkit-app-region:no-drag]')
  })
})

// ══════════════ 源: src/__tests__/terminal/terminal-view.test.ts ══════════════
// TerminalView 组件级测试（多实例 u2）。mock 脚手架与本产物 terminal 节同款共享
// （xterm 系 / useTerminal / @/stores/session / ResizeObserver polyfill）。
// 三视角（规则 5-8）：
// - 观察者：DOM 渲染（terminal-view / terminal-xterm / toolbar / 实例切换条）
// - 使用者：交互（clear / kill / 切换实例 / 关闭实例）
// - 构建者：mount 后对账 + 自动新建（首挂载不夺焦）；切换实例后焦点落当前实例输入区

describe('TerminalView 渲染 gate（观察者视角）', () => {
  it('TV-1: mount 后 DOM 含 terminal-view + terminal-xterm + head 一行（实例切换条含收起按钮，无独立工具栏行）', async () => {
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(document.body.querySelector('[data-testid="terminal-view"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="terminal-xterm"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="terminal-instance-bar"]')).toBeTruthy()
    // head 一行（三卡化 2026-10-04）：收起按钮在位、独立工具栏行不复存在
    expect(document.body.querySelector('[data-testid="terminal-collapse"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="terminal-toolbar"]')).toBeNull()
  })

  it('TV-2: 空态下收起按钮可用；原工具栏（clear/kill）随 head 一行化不复存在', async () => {
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    const collapse = document.body.querySelector('[data-testid="terminal-collapse"]') as HTMLButtonElement
    expect(collapse).toBeTruthy()
    expect(collapse.disabled).toBe(false)
    expect(document.body.querySelector('[data-testid="terminal-btn-clear"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="terminal-btn-kill"]')).toBeNull()
  })
})

describe('TerminalView 实例激活（构建者视角）', () => {
  it('TV-3: mount → 对账；成功空清单 → 自动新建默认实例（存量会话无感）', async () => {
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(useTerminalMock.reconcileInstances).toHaveBeenCalledTimes(1)
    expect(useTerminalMock.spawnTerminal).toHaveBeenCalledTimes(1)
    expect(useTerminalMock.spawnTerminal.mock.calls[0]![0]).toBe('/tmp/test-cwd')
  })

  it('TV-13: 首挂载自动新建（ack 异步建档落位）不夺焦（设计目标 5：开面板体感不变）', async () => {
    // 生产时序：spawn RPC 异步往返，ack 建档晚于挂载轮——用受控 deferred 复现该时序
    const deferred: { resolve?: (terminalId: string) => void } = {}
    useTerminalMock.spawnTerminal.mockImplementation(
      () => new Promise<string>((resolve) => { deferred.resolve = resolve }),
    )
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises() // 挂载轮（对账 → 发起自动新建）完成

    activeRef.value = 'term:test-session:1' // ack 建档：active 落位
    deferred.resolve?.('term:test-session:1')
    await flushPromises()

    // 实例 xterm 已建立，但首挂载建档沿不落焦（非用户手势）
    expect(xtermInstances.length).toBeGreaterThan(0)
    for (const inst of xtermInstances) expect(inst.focus).not.toHaveBeenCalled()
  })

  it('TV-14: 面板先以 sessionId=null 挂载、后经 loadSession 绑上会话 → 绑定轮不夺焦，绑定完成后切换实例按焦点规则落新实例输入区', async () => {
    // 真实路径：stores/panel.ts initialLeaf.sessionId=null → loadSession(null)（面板先挂载）
    // → 后续 loadSession(sid) 绑上会话（prop 变化）。
    const w = mount(TerminalView, { props: { sessionId: null }, attachTo: document.body })
    wrapper = w
    await flushPromises()
    expect(useTerminalMock.reconcileInstances).not.toHaveBeenCalled()

    // 受控 deferred 复现 ack 异步建档落位（spawn RPC 往返晚于绑定轮）
    const deferred: { resolve?: (terminalId: string) => void } = {}
    useTerminalMock.spawnTerminal.mockImplementation(
      () => new Promise<string>((resolve) => { deferred.resolve = resolve }),
    )

    // 绑上会话（loadSession → sessionId prop 变化）：对账 → 自动新建（ack 挂起）
    await w.setProps({ sessionId: 'test-session' })
    await flushPromises()
    expect(useTerminalMock.reconcileInstances).toHaveBeenCalledTimes(1)

    // ack 建档落位：实例清单 + active 落位
    instancesRef.value = [{ terminalId: 'term:test-session:1', seq: 1, alive: true }]
    activeRef.value = 'term:test-session:1'
    deferred.resolve?.('term:test-session:1')
    await flushPromises()

    // 绑定轮内不夺焦（首挂载语义，设计目标 5）
    expect(xtermInstances.length).toBeGreaterThan(0)
    for (const inst of xtermInstances) expect(inst.focus).not.toHaveBeenCalled()

    // 绑定完成（ack 建档、可写）→ 交互门置位：用户手势切换实例 → 焦点落新显示实例
    // （未置位时本条必红：watcher 因 interactive=false 不调 focus）
    instancesRef.value = [
      { terminalId: 'term:test-session:1', seq: 1, alive: true },
      { terminalId: 'term:test-session:2', seq: 2, alive: true },
    ]
    await flushPromises()
    const items = document.body.querySelectorAll('[data-testid="terminal-instance-item"]')
    expect(items).toHaveLength(2)
    ;(items[1] as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(useTerminalMock.selectInstance).toHaveBeenCalledWith('term:test-session:2')
    const xterm = xtermInstances[xtermInstances.length - 1]!
    expect(xterm.focus).toHaveBeenCalled()
  })

  it('TV-4: 对账清单非空 → 不自动新建（复用后台存活实例）', async () => {
    instancesRef.value = [{ terminalId: 'term:test-session:1', seq: 1, alive: true }]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 1 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(useTerminalMock.reconcileInstances).toHaveBeenCalledTimes(1)
    expect(useTerminalMock.spawnTerminal).not.toHaveBeenCalled()
    expect(useTerminalMock.attachTerminal).toHaveBeenCalled()
  })

  it('TV-5: 对账拉取失败 → 不自动新建（不与后台存活实例撞号并存）', async () => {
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: false, count: -1 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    expect(useTerminalMock.spawnTerminal).not.toHaveBeenCalled()
  })

  it('TV-6: sessionId 为 null 时不渲染 xterm、不对账、不 spawn', async () => {
    wrapper = mount(TerminalView, { props: { sessionId: null }, attachTo: document.body })
    await flushPromises()

    expect(document.body.querySelector('[data-testid="terminal-view"]')).toBeTruthy()
    expect(useTerminalMock.reconcileInstances).not.toHaveBeenCalled()
    expect(useTerminalMock.spawnTerminal).not.toHaveBeenCalled()
  })

  it('TV-16: 对账挂起期间切会话 → 旧激活轮落定后不自动新建（过期响应不把终端开到新会话）', async () => {
    // greptile PR #30 发现 1：reconcileInstances 的 await 窗口内用户切走会话（组件不卸载、
    // sessionId prop 变化），旧轮空清单响应落定后若仍自动新建，spawn 链读到的是切换后的
    // sessionId——PTY 开到别的会话头上。激活轮须锚定发起时会话，过期轮静默放弃，
    // 新会话的新建由其自己的激活轮负责。
    const resolvers: Array<(result: { ok: boolean; count: number }) => void> = []
    useTerminalMock.reconcileInstances.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve) }),
    )
    const w = mount(TerminalView, { props: { sessionId: 'session-a' }, attachTo: document.body })
    wrapper = w
    await flushPromises()
    expect(resolvers).toHaveLength(1)

    // 切到会话 B：新激活轮发起（其自身对账同样挂起）
    await w.setProps({ sessionId: 'session-b' })
    await flushPromises()
    expect(resolvers).toHaveLength(2)

    // 旧轮（session-a）空清单响应落定：不得触发自动新建
    resolvers[0]!({ ok: true, count: 0 })
    await flushPromises()
    expect(useTerminalMock.spawnTerminal).not.toHaveBeenCalled()

    // 新会话（session-b）激活轮空清单响应落定：正常自动新建（新建归属不因旧轮放弃而丢失）
    resolvers[1]!({ ok: true, count: 0 })
    await flushPromises()
    expect(useTerminalMock.spawnTerminal).toHaveBeenCalledTimes(1)
  })
})

describe('TerminalView 交互（使用者视角）', () => {
  it('TV-8: 切换条条目点击 → selectInstance（焦点随 active 变化落当前实例输入区）', async () => {
    instancesRef.value = [
      { terminalId: 'term:test-session:1', seq: 1, alive: true },
      { terminalId: 'term:test-session:2', seq: 2, alive: true },
    ]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 2 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    const items = document.body.querySelectorAll('[data-testid="terminal-instance-item"]')
    expect(items).toHaveLength(2)
    ;(items[1] as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(useTerminalMock.selectInstance).toHaveBeenCalledWith('term:test-session:2')
    // 切换实例 → 新 xterm 重建并落焦点
    const xterm = xtermInstances[xtermInstances.length - 1]!
    expect(xterm.focus).toHaveBeenCalled()
  })

  it('TV-9: 关闭实例按钮在当前实例非最后时可用 → closeInstance', async () => {
    instancesRef.value = [
      { terminalId: 'term:test-session:1', seq: 1, alive: true },
      { terminalId: 'term:test-session:2', seq: 2, alive: true },
    ]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 2 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    const closeBtns = document.body.querySelectorAll('[data-testid="terminal-instance-close"]')
    expect(closeBtns).toHaveLength(2)
    ;(closeBtns[1] as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(useTerminalMock.closeInstance).toHaveBeenCalledWith('term:test-session:2')
  })

  it('TV-10: 最后实例关闭按钮禁用态沿用 u3-bar 组件行为（不 emit close）', async () => {
    instancesRef.value = [{ terminalId: 'term:test-session:1', seq: 1, alive: true }]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 1 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()

    const closeBtn = document.body.querySelector('[data-testid="terminal-instance-close"]') as HTMLButtonElement
    expect(closeBtn.disabled).toBe(true)
    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(useTerminalMock.closeInstance).not.toHaveBeenCalled()
  })

  it('TV-11: 「+」点击 → spawnTerminal 新建 + 自动切到新实例并聚焦其输入区', async () => {
    instancesRef.value = [{ terminalId: 'term:test-session:1', seq: 1, alive: true }]
    activeRef.value = 'term:test-session:1'
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 1 })
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()
    useTerminalMock.spawnTerminal.mockClear()
    useTerminalMock.selectInstance.mockClear()

    // ack 回传新实例编号（终端 2）——不再停留在终端 1
    useTerminalMock.spawnTerminal.mockResolvedValue('term:test-session:2')
    const create = document.body.querySelector('[data-testid="terminal-instance-create"]') as HTMLButtonElement
    create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(useTerminalMock.spawnTerminal).toHaveBeenCalledTimes(1)
    // 2026-10-04 产品裁决：点「+」自动切到新实例
    expect(useTerminalMock.selectInstance).toHaveBeenCalledWith('term:test-session:2')
    expect(activeRef.value).toBe('term:test-session:2')
    // 视图重建到新实例并聚焦其输入区
    const xterm = xtermInstances[xtermInstances.length - 1]!
    expect(xterm.focus).toHaveBeenCalled()
  })

  it('TV-15: 空态点「+」→ 自动激活新实例并聚焦（active 原为 null 也不落空）', async () => {
    instancesRef.value = []
    activeRef.value = null
    useTerminalMock.reconcileInstances.mockResolvedValue({ ok: true, count: 0 })
    // 挂载轮空清单自动新建（mock 的 spawn 不建条目、不置 active）→ 空态、不夺焦
    useTerminalMock.spawnTerminal.mockResolvedValueOnce('term:test-session:1')
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()
    useTerminalMock.spawnTerminal.mockClear()
    useTerminalMock.selectInstance.mockClear()
    xtermInstances.length = 0

    // 空态下点「+」新建得终端 2（序号不回落由 runtime 保证，此处只断自动激活+聚焦）
    useTerminalMock.spawnTerminal.mockResolvedValueOnce('term:test-session:2')
    const create = document.body.querySelector('[data-testid="terminal-instance-create"]') as HTMLButtonElement
    create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(useTerminalMock.selectInstance).toHaveBeenCalledWith('term:test-session:2')
    expect(activeRef.value).toBe('term:test-session:2')
    const xterm = xtermInstances[xtermInstances.length - 1]!
    expect(xterm.focus).toHaveBeenCalled()
  })

  it('TV-12: 无选区时浮动按钮不显示', async () => {
    wrapper = mount(TerminalView, { props: { sessionId: 'test-session' }, attachTo: document.body })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="terminal-send-to-ai"]')).toBeNull()
  })
})
