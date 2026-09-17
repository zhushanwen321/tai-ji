/**
 * Landing 组件 + Panel landing 分支单测（#2，T1.6/T1.7/T1.8）。
 *
 * 覆盖：
 * - T1.6 messageCount===0 && !isGenerating → 渲染 landing（Panel v-if 分支）
 * - T1.7 messages 空但 isGenerating=true → 不渲染 landing（生成态优先）
 * - T1.8 getHistory 失败 → landing 有重试按钮，点击 emit retry 不永久卡住
 *
 * mock 策略：
 * - Landing 直挂载（presentational，props/emits），无 store 依赖。
 * - Panel v-if 条件：mount Panel（子组件 stub）+ 真 pinia chat store，操控 messages/派生 isGenerating。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/new-task/landing.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Landing from '@/components/new-task/Landing.vue'
import Panel from '@/components/panel/Panel.vue'
import { useChatStore } from '@/stores/chat'
import type { DerivedStatus } from '@/types'

// Landing 绑定 useNewTaskFlow（chip→popover 渲染绑定 #5/#6）。mock 捕获方法调用
const flowMock = vi.hoisted(() => ({
  // landing 态 session/cwd/branch 真源 computed refs（landing.vue 的 composerSid/cwd/branch 依赖）
  currentSessionId: { value: null as string | null },
  // pi-launch-presets wave2: Landing 透传 launchPresetId 给 PresetSelectChip，需 currentSession
  currentSession: { value: null as { launchPresetId?: string } | null },
  currentCwd: { value: null as string | null },
  presetCwd: vi.fn(),
  gitInfo: { value: null as { branch: string } | null },
  // workspace.detect 三态（landing Git chip 可见性守卫）+ worktree 列表（branch 派生）
  mode: { value: 'not-repo' as string },
  worktreeItems: { value: [] as Array<{ path: string; branch: string; HEAD: boolean; bare: boolean }> },
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
  setPendingPreset: vi.fn(),
  state: { value: 'idle' as string },
  // [D4 卸载守卫] onMounted 自动 startFlow + onUnmounted isActive 才 cancelFlow
  isActive: { value: false as boolean },
  startFlow: vi.fn(),
  cancelFlow: vi.fn(),
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
// Panel.vue 的 isLandingView 读 useNewTaskFlow().state（壳）；mock 回 flowMock 保持与 Landing 同源
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => flowMock,
  resetNewTaskFlow: vi.fn(),
}))


// mock useToast 捕获 error 调用（W3：openDirDialog IPC 招错 → toastError）
const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMock,
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 默认 git 场景（多数测试是 git repo + branch）；非 git 测试单独设 mode='not-repo'
  flowMock.mode.value = 'plain-repo'
  flowMock.gitInfo.value = null
  flowMock.worktreeItems.value = []
  // [D4] 卸载守卫输入默认非活跃（completed/cancelled 路径守卫 noop）；活跃用例单独设 true
  flowMock.isActive.value = false
})

const DONE = 'done' as DerivedStatus

/** mount Panel 时 stub 掉所有重子组件，只验 landing v-if 分支。
 *  Composer stub 带 testid 供「band composer 是否渲染」断言（恢复空 session 回归用）。 */
const panelStubs = {
  PanelHeader: { template: '<div />' },
  MessageStream: { template: '<div />' },
  Composer: { template: '<div data-testid="band-composer" />' },
  SideDrawer: { template: '<div />' },
}

/** Landing 现内嵌 Composer 卡片，directory/branch chip 在 Composer 的 #meta-row slot 内。
 *  mount(Landing) 若渲染真实 Composer 会触发其重依赖（useChat/useChatStore/多个 Popover）崩溃。
 *  解法：stub Composer 为「渲染 meta-row slot」的空壳——chip 仍进 DOM 可查（点 chip 测试依赖），
 *  Composer 内部逻辑不在此测（首屏冒烟 landing-smoke.test.ts 才验真实 composer）。 */
const landingStubs = {
  Composer: { template: '<div data-testid="composer-stub"><slot name="meta-row" /></div>' },
  // pi-launch-presets wave2: PresetSelectChip stub（避免触发其 Popover/HoverCard 重依赖）
  PresetSelectChip: { template: '<div data-testid="chip-preset-stub" />' },
}

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(Panel, {
    props: {
      panelId: 'p1',
      sessionId: 's1',
      sessionLabel: 'label',
      sessionDir: '/repo',
      status: DONE,
      ...overrides,
    },
    global: { stubs: panelStubs },
  })
}

describe('Landing 渲染条件（Panel v-if 分支）', () => {
  it('T1.6 有会话 × flow landing（残留态）→ Landing 不渲染，走 conversation 分支（G2 结构免疫）', () => {
    const chat = useChatStore()
    flowMock.state.value = 'landing' // new-task flow 激活 landing 态
    flowMock.isActive.value = true // panel-view 派生输入：isFlowActive（与 state 同源残留）
    // session 's1' 未 hydrate → getMessages 返回 [] → 无消息
    const wrapper = mountPanel({ sessionId: 's1' })
    // D1：landing 判据需 !sessionId——「有会话 × flow 活跃」在派生上不可表达，
    // 无论 flow 单例因何残留活跃，有会话 panel 恒走 conversation（composer 常驻）
    expect(wrapper.findComponent(Landing).exists()).toBe(false)
    // conversation 无消息 → 空对话态 + band composer（输入面不因 flow 残留消失）
    expect(wrapper.text()).toContain('输入消息开始对话')
    expect(wrapper.find('[data-testid="band-composer"]').exists()).toBe(true)
  })

  it('恢复空 session（有 sid 无消息，flow=idle）→ 不渲染 Landing（无 chip 死锁），渲染空对话态 + band composer', () => {
    const chat = useChatStore()
    flowMock.state.value = 'idle' // 恢复 session 不激活 new-task flow（selectSession 不 startFlow）
    // 僵尸空 session：有 sid 无消息，flow 停 idle
    const wrapper = mountPanel({ sessionId: 'empty-session' })
    // 核心：Landing 不渲染 → directory/branch chip 不存在 → 不会触发 idle→dir-popover 非法 transition
    expect(wrapper.findComponent(Landing).exists()).toBe(false)
    // 空对话态文案（区别于无 session 兑底的「选择左侧会话开始」）
    expect(wrapper.text()).toContain('输入消息开始对话')
    // band composer 渲染（用户直输发该 session，不走 chip 流程）
    expect(wrapper.find('[data-testid="band-composer"]').exists()).toBe(true)
  })

  it('首次启动 new-task（sid=null, flow=landing）→ 渲染 Landing（正向不回归）', () => {
    const chat = useChatStore()
    flowMock.state.value = 'landing'
    flowMock.isActive.value = true // D1：landing ⟺ !sessionId && isFlowActive
    const wrapper = mountPanel({ sessionId: null })
    expect(wrapper.findComponent(Landing).exists()).toBe(true)
    // new-task landing 态 composer 由 Landing 内嵌；band 不重复挂（showPanelComposer=false）。
    // 注：band-composer testid 也出现在 Landing 内嵌 Composer stub 上，无法区分，
    // 改由「恢复空 session」用例验证 band composer 渲染（该用例 Landing 不渲染，testid 唯一）。
  })

  it('T1.7 messages 空但 isGenerating=true → 不渲染 landing（生成态优先）', () => {
    const chat = useChatStore()
    // per-session 生成态：本 Panel 绑定的 session 在流式才算 generating
    // （派生自 message 实体，不再用全局 flag）
    chat.applyMessageEvent('s1', {
      type: 'message.message_start',
      payload: { sessionId: 's1', messageId: 'a1' },
    })
    const wrapper = mountPanel({ sessionId: 's1' })
    expect(wrapper.findComponent(Landing).exists()).toBe(false)
  })

  it('T1.7b 另一 session 流式中，本 Panel（空/landing）→ 仍渲染 landing（不跨 session 误伤）', () => {
    const chat = useChatStore()
    // A 会话在流式，但本 Panel 是 landing 态（sessionId=null）
    chat.applyMessageEvent('session-A', {
      type: 'message.message_start',
      payload: { sessionId: 'session-A', messageId: 'aA' },
    })
    flowMock.state.value = 'landing'
    flowMock.isActive.value = true // D1：landing ⟺ !sessionId && isFlowActive
    const wrapper = mountPanel({ sessionId: null })
    expect(wrapper.findComponent(Landing).exists()).toBe(true)
  })

  it('T1.6 有消息（messageCount>0）→ 不渲染 landing（走对话流）', () => {
    const chat = useChatStore()
    chat.hydrate('s1', [
      { id: 'm1', role: 'user', content: 'hi', status: 'complete', timestamp: 1 },
    ])
    const wrapper = mountPanel({ sessionId: 's1' })
    expect(wrapper.findComponent(Landing).exists()).toBe(false)
  })
})

describe('Landing 组件（presentational）', () => {
  it('渲染问候语 + directory chip（T1.6 landing 内容）', () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', gitBranch: 'main' },
      global: { stubs: landingStubs },
    })
    expect(wrapper.text()).toContain('有什么想让我帮忙的吗')
    expect(wrapper.find('[data-testid="chip-directory"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chip-branch"]').exists()).toBe(true)
  })

  it('gitBranch 为空 → branch chip 隐藏（UC-7 非 git 目录，AC-2.2）', () => {
    flowMock.mode.value = 'not-repo'
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/plain' },
      global: { stubs: landingStubs },
    })
    expect(wrapper.find('[data-testid="chip-branch"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="chip-directory"]').exists()).toBe(true)
  })

  it('currentCwd 为空（首次启动延迟 create）→ directory chip 显空态文案', () => {
    const wrapper = mount(Landing, {
      props: { sessionId: null, currentCwd: null },
      global: { stubs: landingStubs },
    })
    const chip = wrapper.find('[data-testid="chip-directory"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('选择目录')
  })

  it('点 directory chip → 调 useNewTaskFlow.openDirPopover（#5 渲染绑定）', async () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', gitBranch: 'main' },
      global: { stubs: landingStubs },
    })
    await wrapper.find('[data-testid="chip-directory"]').trigger('click')
    expect(flowMock.openDirPopover).toHaveBeenCalled()
  })

  it('点 branch chip → 调 useNewTaskFlow.openBranchPopover（#6 渲染绑定）', async () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', gitBranch: 'main' },
      global: { stubs: landingStubs },
    })
    await wrapper.find('[data-testid="chip-branch"]').trigger('click')
    expect(flowMock.openBranchPopover).toHaveBeenCalled()
  })

  it('TC-6 #meta-row slot 挂载 PresetSelectChip（pi-launch-presets wave2 集成回归）', () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', gitBranch: 'main' },
      global: { stubs: landingStubs },
    })
    // PresetSelectChip stub 带 testid，断言它与 directory/branch chip 同级存在于 meta-row
    expect(wrapper.find('[data-testid="chip-preset-stub"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chip-directory"]').exists()).toBe(true)
  })
})

describe('Landing getHistory 失败重试（T1.8）', () => {
  it('historyError=true → 渲染重试按钮，点击 emit retry（不永久卡住）', async () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', historyError: true },
      global: { stubs: landingStubs },
    })
    const retry = wrapper.find('[data-testid="retry-history"]')
    expect(retry.exists()).toBe(true)
    await retry.trigger('click')
    expect(wrapper.emitted('retry')).toBeTruthy()
  })

  it('historyError=false → 不渲染重试按钮', () => {
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', historyError: false },
      global: { stubs: landingStubs },
    })
    expect(wrapper.find('[data-testid="retry-history"]').exists()).toBe(false)
  })
})

describe('Landing openDirDialog 异常处理（W3: AC-5.6）', () => {
  /** W3 测试用 stubs：Popover 系列无条件渲染 slot + Composer/DirSelectPopover stub，聚焦事件路由 */
  const w3Stubs = {
    Popover: { template: '<div><slot /></div>' },
    PopoverTrigger: { template: '<div><slot /></div>' },
    PopoverContent: { template: '<div><slot /></div>' },
    Composer: { template: '<div data-testid="composer-stub"><slot name="meta-row" /></div>' },
    DirSelectPopover: {
      name: 'DirSelectPopover',
      template: '<div data-testid="dir-select-stub" />',
      emits: ['select', 'open-dir-dialog', 'close'],
    },
    // pi-launch-presets wave2: PresetSelectChip stub（避免触发其重依赖）
    PresetSelectChip: { template: '<div data-testid="chip-preset-stub" />' },
  }

  it('W3-U1: openDirDialog reject → toastError 被调（IPC 招错有反馈，AC-5.6）', async () => {
    flowMock.openDirDialog.mockRejectedValueOnce(new Error('IPC failed'))
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', gitBranch: 'main' },
      global: { stubs: w3Stubs },
    })
    // Popover stub 无条件渲染 slot → DirSelectPopover stub 在 DOM，可 findComponent + emit
    wrapper.findComponent({ name: 'DirSelectPopover' }).vm.$emit('open-dir-dialog')
    await flushPromises()

    expect(flowMock.openDirDialog).toHaveBeenCalledTimes(1)
    expect(depsMock.toast.error).toHaveBeenCalledTimes(1)
    const msg = String(depsMock.toast.error.mock.calls[0]![0])
    expect(msg).toContain('无法打开目录选择器')
    expect(msg).toContain('IPC failed')
  })

  it('W3-U2: openDirDialog resolve → 不调 toastError（成功路径无错误提示）', async () => {
    flowMock.openDirDialog.mockResolvedValueOnce(undefined)
    const wrapper = mount(Landing, {
      props: { sessionId: 's1', currentCwd: '/repo', gitBranch: 'main' },
      global: { stubs: w3Stubs },
    })
    wrapper.findComponent({ name: 'DirSelectPopover' }).vm.$emit('open-dir-dialog')
    await flushPromises()

    expect(flowMock.openDirDialog).toHaveBeenCalledTimes(1)
    expect(depsMock.toast.error).not.toHaveBeenCalled()
  })
})

describe('Landing onUnmounted 卸载守卫（D4：视图卸载即终结 flow）', () => {
  it('D4-U1: 卸载时 flow 活跃（landing/overlay）→ cancelFlow 被调（封死状态漂留）', () => {
    flowMock.isActive.value = true
    const wrapper = mount(Landing, {
      props: { sessionId: null, currentCwd: null },
      global: { stubs: landingStubs },
    })
    expect(flowMock.cancelFlow).not.toHaveBeenCalled() // 挂载期不 cancel
    wrapper.unmount()
    expect(flowMock.cancelFlow).toHaveBeenCalledTimes(1)
  })

  it('D4-U2: 卸载时 flow 非活跃（completed/cancelled）→ 守卫 noop，不产生非法转换', () => {
    flowMock.isActive.value = false
    const wrapper = mount(Landing, {
      props: { sessionId: null, currentCwd: null },
      global: { stubs: landingStubs },
    })
    wrapper.unmount()
    // 正常首发（completed）与切换（cancelled）路径下卸载不触发 cancelFlow——
    // 对已完成流程的二次 cancel 会是非法状态转换
    expect(flowMock.cancelFlow).not.toHaveBeenCalled()
  })
})

// ── [不变式] Landing 全仓唯一挂载点 ─────────────────────────────────────
// D4 卸载守卫（卸载即 cancelFlow）的正确性前提：Landing 只有一个挂载点。
// 多面板（split）拓扑已删除（2026-07-24），唯一挂载点 = Panel.vue landing 分支。
// 静态源码断言（同 sidebar-layout.test.ts 滚动修复先例）：扫描 src 下非测试源文件中
// `<Landing` 模板标签，仅允许出现在 Panel.vue。此断言红 = 正在引入第二个挂载点，
// 必须先重新设计 Landing.vue 的卸载语义（见其 [不变式] 注释——跨实例协调不能靠
// 组件实例变量），不能直接改期望值放行。
// 脆弱性边界（有意接受）：静态扫描看不到动态渲染形态（<component :is> / h(Landing)），
// 它是廉价哨兵不是完备证明；`<Landing` 字面量出现在注释/字符串会误报，失败信息自解释。
describe('[不变式] Landing 唯一挂载点', () => {
  it('<Landing 模板标签仅出现在 Panel.vue（D4 卸载守卫的前提）', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const srcRoot = path.resolve(__dirname, '../..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue
          walk(full)
        } else if (entry.name.endsWith('.vue')) {
          const isTestFile = entry.name.endsWith('.test.vue') || entry.name.endsWith('.spec.vue')
          if (!isTestFile && fs.readFileSync(full, 'utf-8').includes('<Landing')) {
            offenders.push(path.relative(srcRoot, full))
          }
        }
      }
    }
    walk(srcRoot)
    expect(offenders).toEqual(['components/panel/Panel.vue'])
  })
})
