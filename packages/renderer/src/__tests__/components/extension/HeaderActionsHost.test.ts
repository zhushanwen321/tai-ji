/**
 * HeaderActionsHost 测试（plugin-header-action-modal-points u4b，AP-1 渲染契约）。
 *
 * 覆盖（三视角 TEST-STRATEGY §3：每条至少一个用户可见 DOM 断言）：
 * - 声明渲染 N 按钮 + testid 形态（header-action-<pluginId>-<id 段>，设计场景 1 契约）
 * - order 升序排序（缺省排后）
 * - badge ≤4 字符宿主截断 + 全文进 tooltip（AP-1 徽标契约；tooltip = 主题化 Tooltip 浮层，
 *   2026-10-19 原生 title 退役——文案合成断言落 aria-label（与浮层内容同源同串），
 *   浮层渲染本身由 ui 包 Tooltip 原语族保证）
 * - E13 三态：registered 可点 / unregistered 灰置 / unknown 首次缺省可点 + 保持上次值
 * - 运行时镜像 entry.disabled：true 灰置（插件业务态）/ false / undefined 不灰置；
 *   disabled=true 缺 tooltip → 「暂不可用」泛化文案（场景 12，与 unregistered 的
 *   「本会话未加载所需扩展」文案分叉），插件显式 tooltip 优先
 * - 运行时镜像 entry.hidden：true 入口整体不渲染（零 DOM，无任务不显示契约）/
 *   false 推送帧照常渲染；未推送帧（缺省反转 ADR-0155）不渲染
 * - E3 点击 → executeCommand(commandId)；命令缺失（返回 false）→ 本地置灰（禁静默 no-op）；
 *   宿主重判 registered（命令重注册回来）→ 置灰让位、按钮恢复可点（F5）
 * - activation 分派（声明驱动）：'scheduler-overlay' 点击 → openSchedulerTab（模块 mock），
 *   不调 executeCommand、不触 E13 判定（resolveCommandAvailability 零调用）；disabled 单源
 *   = 运行时镜像；hidden 剔除对 overlay/缺省两种声明同样生效；缺省声明点击仍走 executeCommand
 *
 * ── 波 2a 簇 4-13 合并说明 ──
 * 节 2（本文件尾部）= SchedulerQuickCard.test.ts：composer 左簇定时任务快捷面板
 * （hover 160ms 开 / 240ms 收 / pin / Esc）。
 * 两节同域（composer 左簇 header action 宿主），workflow-viz-overlay mock 工厂逐字
 * 相同 → 去重一份；节 2 的 makeSource 与节 1 同名异构 → 按节改名 makeViewSource；
 * 两节原文件级 beforeEach/afterEach 均下沉各自 describe 节内（节 2 的 fake timers
 * 不外溢节 1）。describe/it 名零改动。plan-review-bar.test.ts 的 5 个 mock 泄漏
 * 静态无法排除（波 1 已裁决），保持独立不并入。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/components/extension/HeaderActionsHost.test.ts --pool=threads
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import HeaderActionsHost from '@/components/extension/HeaderActionsHost.vue'
import SchedulerQuickCard from '@/components/extension/SchedulerQuickCard.vue'
import { VIEW_HOST_SOURCE_KEY, type ViewCacheEntry, type ViewHostSource } from '@taiji/ui/extension-host'
// 真模块顶层有 core overlay 绑定/watch 副作用（模块加载即装配），测试只消费
// openSchedulerTab 纯写入口——整体 mock 隔离，装配副作用不进测试环境。
// SCHEDULER_MODAL_VIEW_ID 常量同源保留（SchedulerQuickCard 的 ViewHost 分区键）
vi.mock('@/components/panel/workflow-viz/overlay/workflow-viz-overlay', () => ({
  openSchedulerTab: vi.fn(),
  SCHEDULER_MODAL_VIEW_ID: 'scheduler-modal',
}))
import { openSchedulerTab } from '@/components/panel/workflow-viz/overlay/workflow-viz-overlay'
import {
  HEADER_ACTIONS_SOURCE_KEY,
  type HeaderActionsSource,
  type HeaderActionCommandAvailability,
} from '@/composables/shell/useExtensionHostBridge'
import type { ContributionRecord, HeaderActionEntry } from '@taiji/core'

// ── 测试数据 ──
const schedulerAction: ContributionRecord = {
  pluginId: 'scheduler-manager',
  contributionId: 'scheduler-manager.open',
  type: 'headerAction',
  placement: 'panel.header',
  available: true,
  headerAction: { title: '定时任务', icon: 'clock', commandId: 'scheduler-manager.open', order: 20 },
}

/** overlay 直开声明（activation='scheduler-overlay'，与 builtin scheduler-manager 现值同形状：
 *  点击走 overlay 分派不经命令链，声明无 commandId） */
const schedulerOverlayAction: ContributionRecord = {
  pluginId: 'scheduler-manager',
  contributionId: 'scheduler-manager.open',
  type: 'headerAction',
  placement: 'panel.header',
  available: true,
  headerAction: { title: '定时任务', icon: 'clock', order: 20, activation: 'scheduler-overlay' },
}

function makeSource(overrides: Partial<HeaderActionsSource> = {}): HeaderActionsSource {
  return {
    getDeclarations: () => [schedulerAction],
    // 缺省 = 已推送非 hidden 条目（缺省反转后「未推送 = 不可见」——渲染契约用例一律在
    // 已推送形态下断言；「未推送不渲染」由专门用例承载）
    getRuntimeState: (_sid, id) => ({ headerActionId: id, pluginId: 'scheduler-manager', updatedAt: 1 }),
    resolveCommandAvailability: () => 'registered',
    executeCommand: vi.fn(() => true),
    ...overrides,
  }
}

function mountHost(source: HeaderActionsSource, sessionId = 's1') {
  return mount(HeaderActionsHost, {
    props: { sessionId },
    global: { provide: { [HEADER_ACTIONS_SOURCE_KEY]: source } },
  })
}

describe('HeaderActionsHost', () => {
  beforeEach(() => {
    vi.mocked(openSchedulerTab).mockClear()
  })

  it('按声明渲染按钮，testid 形态 = header-action-<pluginId>-<id 段>', () => {
    const wrapper = mountHost(makeSource())
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.exists()).toBe(true)
    // 用户可见断言：与 demo .cbtn 同规格（size-[30px]，demo composer-bar spec §4——demo 左簇
    // 钮统一 30×30；普通类经 cn 合并压过 size 变体 h-10/w-10；用户裁决 2026-10-06 自
    // panel 顶栏迁入 composer 左簇）+ 声明 title 兜底 tooltip
    expect(btn.classes()).toContain('size-[30px]')
    expect(btn.classes()).toContain('rounded-sm')
    expect(btn.attributes('aria-label')).toBe('定时任务')
    // 无 badge 时不渲染徽标
    expect(btn.find('span').exists()).toBe(false)
  })

  it('多条声明按 order 升序排序（缺省排后）', () => {
    const second: ContributionRecord = {
      pluginId: 'demo-echo',
      contributionId: 'demo-echo.ping',
      type: 'headerAction',
      placement: 'panel.header',
      available: true,
      headerAction: { title: 'Ping', icon: 'bell', commandId: 'demo-echo.ping', order: 5 },
    }
    const appended: ContributionRecord = {
      pluginId: 'late',
      contributionId: 'late.last',
      type: 'headerAction',
      placement: 'panel.header',
      available: true,
      headerAction: { title: 'Last', icon: 'bell', commandId: 'late.last' },
    }
    const source = makeSource({ getDeclarations: () => [schedulerAction, appended, second] })
    const wrapper = mountHost(source)
    const testids = wrapper.findAll('button').map((b) => b.attributes('data-testid'))
    expect(testids).toEqual([
      'header-action-demo-echo-ping',
      'header-action-scheduler-manager-open',
      'header-action-late-last',
    ])
  })

  it('badge 超过 4 字符截断显示，全文进 tooltip', () => {
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      badge: '12345',
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => entry })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.text()).toBe('1234')
    expect(btn.attributes('aria-label')).toContain('12345')
  })

  it('E13 unregistered：按钮灰置 + tooltip「本会话未加载所需扩展」', () => {
    const source = makeSource({ resolveCommandAvailability: () => 'unregistered' })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('aria-label')).toBe('本会话未加载所需扩展')
  })

  it('E13 unknown：首次缺省可点，tooltip「会话恢复中，暂无法判定」', () => {
    const source = makeSource({ resolveCommandAvailability: () => 'unknown' })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.attributes('aria-label')).toBe('会话恢复中，暂无法判定')
  })

  it('E13 unknown：保持上一次 disabled 值（恢复窗口不翻转判定）', async () => {
    const availability = ref<HeaderActionCommandAvailability>('unregistered')
    const source = makeSource({ resolveCommandAvailability: () => availability.value })
    const wrapper = mountHost(source)
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').attributes('disabled')).toBeDefined()
    availability.value = 'unknown'
    await nextTick()
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').attributes('disabled')).toBeDefined()
    // 恢复后重判（registered → 可点）
    availability.value = 'registered'
    await nextTick()
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').attributes('disabled')).toBeUndefined()
  })

  it('E13 registered：运行时 tooltip 优先于声明 title', () => {
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      tooltip: '3 个启用任务',
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => entry })
    const wrapper = mountHost(source)
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').attributes('aria-label')).toBe('3 个启用任务')
  })

  it('运行时镜像 entry.disabled=true 且无 tooltip：灰置 + tooltip「暂不可用」（场景 12，F6 泛化 key）', () => {
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      disabled: true,
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => entry })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeDefined()
    // 灰置按钮缺插件文案时落 disabled 态泛化提示，不得落到声明 title（误导可点语义）
    expect(btn.attributes('aria-label')).toBe('暂不可用')
  })

  it('F6 文案分叉：unregistered →「本会话未加载所需扩展」≠ 业务 disabled 缺 tooltip →「暂不可用」', () => {
    const unregistered = mountHost(makeSource({ resolveCommandAvailability: () => 'unregistered' }))
    expect(unregistered.find('[data-testid=header-action-scheduler-manager-open]').attributes('aria-label')).toBe('本会话未加载所需扩展')

    const businessDisabled: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      disabled: true,
      updatedAt: 1,
    }
    const disabledHost = mountHost(makeSource({ getRuntimeState: () => businessDisabled }))
    expect(disabledHost.find('[data-testid=header-action-scheduler-manager-open]').attributes('aria-label')).toBe('暂不可用')
  })

  it('运行时镜像 entry.disabled=true 且插件推了 tooltip：插件文案优先于泛化提示', () => {
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      disabled: true,
      tooltip: '调度器运行中不可配置',
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => entry })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('aria-label')).toBe('调度器运行中不可配置')
  })

  it('运行时镜像 entry.disabled=false：不灰置且 tooltip 仍落声明 title（现状不变）', () => {
    const disabledEntry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      disabled: false,
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => disabledEntry })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.attributes('aria-label')).toBe('定时任务')
    // 未推送运行时帧（getRuntimeState → undefined）：缺省反转后入口不渲染（不出按钮）
    const noEntry = mountHost(makeSource({ getRuntimeState: () => undefined }))
    expect(noEntry.find('[data-testid=header-action-scheduler-manager-open]').exists()).toBe(false)
  })

  it('运行时镜像 entry.hidden=true：入口整体不渲染（无任务不显示——不出按钮，非灰置）', () => {
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      hidden: true,
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => entry })
    const wrapper = mountHost(source)
    // 用户可见断言：hidden 入口零 DOM（不是 disabled 残留按钮）
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('运行时镜像 entry.hidden=false 推送：按钮照常渲染；未推送帧（缺省反转）：不渲染', () => {
    const hiddenFalse: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      hidden: false,
      updatedAt: 1,
    }
    const explicitSource = mountHost(makeSource({ getRuntimeState: () => hiddenFalse }))
    expect(explicitSource.find('[data-testid=header-action-scheduler-manager-open]').exists()).toBe(true)
    // 未推送（插件从未声明存在）：fail-safe 不渲染（ADR-0155 缺省反转）
    const neverPushed = mountHost(makeSource({ getRuntimeState: () => undefined }))
    expect(neverPushed.find('[data-testid=header-action-scheduler-manager-open]').exists()).toBe(false)
  })

  it('点击 → executeCommand(commandId)（执行器收到命令 id）', async () => {
    const executeCommand = vi.fn(() => true)
    const source = makeSource({ executeCommand })
    const wrapper = mountHost(source)
    await wrapper.find('[data-testid=header-action-scheduler-manager-open]').trigger('click')
    expect(executeCommand).toHaveBeenCalledWith('scheduler-manager.open')
  })

  it('E3 命令缺失（executeCommand 返回 false）→ 按钮置灰，禁静默 no-op', async () => {
    // 生产语境约束：executeCommand 返回 false ⟺ 注册表查无此命令 ⟹ availability 必为
    // unknown/unregistered（bridge 两判定同源同步）。真实可达的失败语境 = unknown
    // （会话命令分区为空），此处按 unknown 构造。
    const executeCommand = vi.fn(() => false)
    const source = makeSource({
      executeCommand,
      resolveCommandAvailability: () => 'unknown',
    })
    const wrapper = mountHost(source)
    const btn = () => wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn().attributes('disabled')).toBeUndefined() // unknown 首次缺省可点
    await btn().trigger('click')
    expect(btn().attributes('disabled')).toBeDefined()
  })

  it('F5 E3 恢复：宿主重判 registered（命令重注册回来）→ missing 让位，按钮恢复可点', async () => {
    const availability = ref<HeaderActionCommandAvailability>('unknown')
    const source = makeSource({
      executeCommand: vi.fn(() => false),
      resolveCommandAvailability: () => availability.value,
    })
    const wrapper = mountHost(source)
    const btn = () => wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    // unknown 语境点击失败 → 本地置灰
    await btn().trigger('click')
    expect(btn().attributes('disabled')).toBeDefined()
    // 命令重注册（宿主判 registered）→ 一次性失败让位于重注册事实
    availability.value = 'registered'
    await nextTick()
    expect(btn().attributes('disabled')).toBeUndefined()
    // 恢复后可正常再点击（executeCommand 收到命令 id）
    await btn().trigger('click')
    expect(source.executeCommand).toHaveBeenCalledWith('scheduler-manager.open')
  })

  it('无声明时整组件零 DOM（不挤压内置按钮）', () => {
    const source = makeSource({ getDeclarations: () => [] })
    const wrapper = mountHost(source)
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('sessionId 为空（landing）不渲染', () => {
    const wrapper = mountHost(makeSource(), '')
    expect(wrapper.find('button').exists()).toBe(false)
  })
})

describe('activation 分派（scheduler-overlay → SchedulerQuickCard 快捷面板，声明驱动）', () => {
  it("activation='scheduler-overlay'：点击 = pin 快捷面板（aria-expanded 翻转），不调 executeCommand/openSchedulerTab、不触 E13 判定", async () => {
    const executeCommand = vi.fn(() => true)
    const resolveCommandAvailability = vi.fn((): HeaderActionCommandAvailability => 'registered')
    const source = makeSource({
      getDeclarations: () => [schedulerOverlayAction],
      executeCommand,
      resolveCommandAvailability,
    })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    // 点击 = pin 快捷面板（面板开：aria-expanded=true）；overlay 直开移入面板底部条
    await btn.trigger('click')
    expect(btn.attributes('aria-expanded')).toBe('true')
    await btn.trigger('click')
    expect(btn.attributes('aria-expanded')).toBe('false')
    expect(executeCommand).not.toHaveBeenCalled()
    expect(openSchedulerTab).not.toHaveBeenCalled()
    // E13 判定有 lastResolved 簿记副作用，overlay 路径不得触碰
    expect(resolveCommandAvailability).not.toHaveBeenCalled()
  })

  it("activation='scheduler-overlay'：命令三态不参与灰置，disabled 单源 = 运行时镜像", () => {
    // 运行时 disabled=true：灰置 + 「暂不可用」泛化文案（与命令链同语义）
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      disabled: true,
      updatedAt: 1,
    }
    const disabledSource = makeSource({
      getDeclarations: () => [schedulerOverlayAction],
      getRuntimeState: () => entry,
      resolveCommandAvailability: () => 'unregistered',
    })
    const disabledWrapper = mountHost(disabledSource)
    const btn = disabledWrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('aria-label')).toBe('暂不可用')
    // 无运行时 disabled：即使命令 unregistered 也不灰置、提示落声明 title
    const noEntrySource = makeSource({
      getDeclarations: () => [schedulerOverlayAction],
      resolveCommandAvailability: () => 'unregistered',
    })
    const noEntryWrapper = mountHost(noEntrySource)
    const cleanBtn = noEntryWrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(cleanBtn.attributes('disabled')).toBeUndefined()
    expect(cleanBtn.attributes('aria-label')).toBe('定时任务')
  })

  it('hidden 剔除对两种声明同样生效（overlay 直开声明 hidden=true 同样零 DOM）', () => {
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      hidden: true,
      updatedAt: 1,
    }
    const source = makeSource({ getDeclarations: () => [schedulerOverlayAction], getRuntimeState: () => entry })
    const wrapper = mountHost(source)
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('缺省声明（无 activation 字段）点击仍走 executeCommand、不触 openSchedulerTab（既有命令链零变化）', async () => {
    const executeCommand = vi.fn(() => true)
    const source = makeSource({ getDeclarations: () => [schedulerAction], executeCommand })
    const wrapper = mountHost(source)
    await wrapper.find('[data-testid=header-action-scheduler-manager-open]').trigger('click')
    expect(executeCommand).toHaveBeenCalledWith('scheduler-manager.open')
    expect(openSchedulerTab).not.toHaveBeenCalled()
  })

  it('无 commandId 且无 activation 的声明无法走命令链 = 不渲染（commandId 可选化的缺省语义）', () => {
    const orphan: ContributionRecord = {
      pluginId: 'demo',
      contributionId: 'demo.nocmd',
      type: 'headerAction',
      placement: 'panel.header',
      available: true,
      headerAction: { title: '无命令', icon: 'bell', order: 1 },
    }
    const source = makeSource({ getDeclarations: () => [orphan] })
    const wrapper = mountHost(source)
    expect(wrapper.find('button').exists()).toBe(false)
  })
})

// ══════════ 节 2/2 — 来源: SchedulerQuickCard.test.ts ══════════

/**
 * SchedulerQuickCard 测试（composer 左簇定时任务快捷面板，2026-10-19 左簇浮层优化）。
 *
 * 覆盖（三视角：每条至少一个用户可见 DOM 断言）：
 * - hover 160ms 开面板 / 离开 240ms 收起（fake timers 驱动状态机）
 * - 点击 = pin（面板常驻），再点解除；pin 态离开不收起
 * - 面板数据 = ViewHost 消费 SCHEDULER_MODAL_VIEW_ID 分区树（与 overlay 定时任务 tab
 *   同源同渲染——用户可见断言：插件推的树内容直接渲染在面板内）
 * - 底部操作条「打开定时任务面板」→ openSchedulerTab(sessionId) + 面板收起
 * - disabled（运行时灰置）hover 不开面板
 * - Esc 关闭（reka DismissableLayer 上报 update:open=false → 收起解 pin）
 *
 * 面板经 reka PopoverPortal Teleport 到 body：attachTo + document.body 查询（与
 * sidebar-assign-project 测试同范式；unmount 后清 body 防 reka 异步 DOM 残留）。
 * workflow-viz-overlay mock 与节 1 同工厂（顶层去重一份）。
 */
function schedulerEntry(): ViewCacheEntry {
  return {
    guiTree: [{ type: 'ansi-text', props: { lines: ['2 启用 · 1 停用 · 共 3'] } }],
  } as ViewCacheEntry
}

function makeViewSource(entry: ViewCacheEntry | undefined): ViewHostSource {
  return {
    getView: vi.fn((sessionId: string, viewId: string) =>
      sessionId === 's1' && viewId === 'scheduler-modal' ? entry : undefined),
    getViewIds: vi.fn(() => (entry ? ['scheduler-modal'] : [])),
  } as unknown as ViewHostSource
}

function mountCard(source: ViewHostSource, over: Record<string, unknown> = {}) {
  return mount(SchedulerQuickCard, {
    attachTo: document.body,
    props: { sessionId: 's1', badge: '3', disabled: false, testid: 'header-action-scheduler-manager-open', tooltip: '定时任务', ...over },
    global: { provide: { [VIEW_HOST_SOURCE_KEY]: source } },
  })
}

const BTN = '[data-testid="header-action-scheduler-manager-open"]'
const ANCHOR = '[data-testid="scheduler-quick-anchor"]'
const PANEL = '[data-testid="scheduler-quick-panel"]'

/** 面板在 Teleport 树（document.body）里，wrapper.find 不达——统一走 body 查询 */
function panelEl(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(PANEL)
}

/** 面板已收起：DOM 移除（reka 无过渡卸载）或 data-state='closed'（出方向过渡中，
 *  jsdom 无 CSS 动画引擎时 reka Presence 可能延迟卸载）都算收起 */
function panelClosed(): boolean {
  const el = panelEl()
  return el === null || el.dataset.state === 'closed'
}

describe('SchedulerQuickCard（hover 快捷面板）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(openSchedulerTab).mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hover 160ms 开面板，插件树内容直接渲染（与 overlay tab 同源数据同渲染）', async () => {
    const wrapper = mountCard(makeViewSource(schedulerEntry()))
    expect(panelEl()).toBeNull()

    await wrapper.find(ANCHOR).trigger('pointerenter')
    vi.advanceTimersByTime(159)
    await nextTick()
    expect(panelEl()).toBeNull() // 160ms 内不开
    vi.advanceTimersByTime(1)
    await nextTick()

    const panel = panelEl()
    expect(panel).not.toBeNull()
    expect(panel!.textContent).toContain('2 启用 · 1 停用 · 共 3')
    expect(wrapper.find(BTN).attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
    await nextTick()
    document.body.innerHTML = ''
  })

  it('指针离开 240ms 收起；pin 态离开不收', async () => {
    const wrapper = mountCard(makeViewSource(schedulerEntry()))
    const anchor = () => wrapper.find(ANCHOR)

    await anchor().trigger('pointerenter')
    vi.advanceTimersByTime(160)
    await nextTick()
    expect(panelEl()).not.toBeNull()

    // 未 pin：离开 → 240ms 后收
    await anchor().trigger('pointerleave')
    vi.advanceTimersByTime(239)
    await nextTick()
    expect(panelEl()).not.toBeNull()
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(panelClosed()).toBe(true)

    // pin：点击开 + 离开不收
    await wrapper.find(BTN).trigger('click')
    await nextTick()
    expect(wrapper.find(BTN).attributes('aria-pressed')).toBe('true')
    expect(panelEl()).not.toBeNull()
    await anchor().trigger('pointerleave')
    vi.advanceTimersByTime(500)
    await nextTick()
    expect(panelEl()).not.toBeNull()

    // 再点解除 pin + 收起
    await wrapper.find(BTN).trigger('click')
    await nextTick()
    expect(panelClosed()).toBe(true)
    wrapper.unmount()
    await nextTick()
    document.body.innerHTML = ''
  })

  it('disabled（运行时灰置）：hover 不开面板', async () => {
    const wrapper = mountCard(makeViewSource(schedulerEntry()), { disabled: true })
    await wrapper.find(ANCHOR).trigger('pointerenter')
    vi.advanceTimersByTime(300)
    await nextTick()
    expect(panelEl()).toBeNull()
    expect(wrapper.find(BTN).attributes('disabled')).toBeDefined()
    wrapper.unmount()
    await nextTick()
    document.body.innerHTML = ''
  })

  it('底部「打开定时任务面板」→ openSchedulerTab(sessionId) 且面板收起', async () => {
    const wrapper = mountCard(makeViewSource(schedulerEntry()))
    await wrapper.find(ANCHOR).trigger('pointerenter')
    vi.advanceTimersByTime(160)
    await nextTick()
    expect(panelEl()).not.toBeNull()

    const openBtn = panelEl()!.querySelector<HTMLButtonElement>('[data-testid="scheduler-quick-open-overlay"]')!
    expect(openBtn.textContent).toContain('打开定时任务面板')
    openBtn.click()
    await nextTick()

    expect(openSchedulerTab).toHaveBeenCalledTimes(1)
    expect(openSchedulerTab).toHaveBeenCalledWith('s1')
    expect(panelClosed()).toBe(true)
    wrapper.unmount()
    await nextTick()
    document.body.innerHTML = ''
  })

  it('Esc 关闭（reka DismissableLayer 上报 update:open=false → 收起解 pin）', async () => {
    const wrapper = mountCard(makeViewSource(schedulerEntry()))
    await wrapper.find(BTN).trigger('click') // pin
    await nextTick()
    expect(panelEl()).not.toBeNull()

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(panelClosed()).toBe(true)
    // pin 已解：再次 hover 走 160ms 正常路径
    await wrapper.find(ANCHOR).trigger('pointerenter')
    vi.advanceTimersByTime(160)
    await nextTick()
    expect(panelEl()).not.toBeNull()
    wrapper.unmount()
    await nextTick()
    document.body.innerHTML = ''
  })
})
