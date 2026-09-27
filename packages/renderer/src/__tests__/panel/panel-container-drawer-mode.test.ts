/**
 * PanelContainer 集成测试 —— 单 panel + Drawer 壳路径（W4 drawer-shell-integration）。
 *
 * 迁移自旧 panel-container-drawer-mode.test.ts（SideDrawer stub → DrawerPanel 真实渲染）
 * + 旧 side-drawer.test.ts / SideDrawer.test.ts 的行为断言壳路径版（D6 triage：行为型迁移
 * 改写为壳路径断言，内部断言/mock spy 型删除）。
 *
 * 壳路径（mount PanelContainer，test-strategy 集成章节要求）：
 * - PanelContainer 渲染跨端共享容器 DrawerPanel（@taiji/ui/features/drawer，W3），
 *   断言 drawer-tab-* 五 tab 按钮 + drawer-panel + drawer-content DOM 存在（AC9/AC12 壳层载体）
 * - drawerOpen=true：DrawerPanel 在 drawer-area wrapper 内挂载（feat-chat-flow-width 手写
 *   flex 布局，替换 reka-ui Splitter：无 drawer main 占 75%、有 drawer 双侧 width 动画、
 *   handle 拖动/键盘调整 + localStorage 持久化，见下方「动态宽度」describe）
 * - drawerOpen=false：DrawerPanel aside 卸载，drawer-area 收缩为 0%（width 动画承载者常驻）
 * - ESC 关闭（window keydown）+ close 按钮关闭 → drawer 卸载（旧 side-drawer.test.ts 行为迁移）
 * - 内容区 fallback：browser tab 无 URL 不注入 BrowserPane → DrawerPanel 空态（drawer-widget-empty）
 *   （旧 widget 缓冲通路已删，[P4 s5 drawer-widget-removal] 由 PluginViewContainer 承接）
 * - unread badge（AC-13）：chatStore 消息数增长 → header-extra slot 内 drawer-unread-badge
 *   出现并显示计数；关 drawer 清零
 *
 * 控制态经 core drawer 域直连（PanelContainer 自持 bindDrawerSessionId，不消费 useSideDrawer
 * 兼容层——C1）：测试同样直连 core（bindDrawerSessionId + openDrawerTab + _resetDrawerForTest）。
 * 桌面独占面板（GitPanel/CommandDocPanel/DetailPane/BrowserPane/TerminalView）
 * stub 为占位 div（避免真实组件依赖，对齐旧测试 stub 策略）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/panel-container-drawer-mode.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, ref, computed, nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import {
  bindDrawerSessionId,
  openDrawerTab,
  setDrawerTab,
  getDrawerControlState,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'

// ── mock 壳层依赖（PanelContainer setup 阶段执行，避免真实 WS/session 副作用）──
vi.mock('@/composables/features/file-tree/useGitStatus', () => ({
  GIT_STATUS_KEY: Symbol('git-status'),
  provideGitStatus: () => ({ indicator: { value: undefined }, state: { value: 'clean' }, lines: { value: [] } }),
}))
vi.mock('@/composables/features/chat/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))

// ── mock chatStore：unread badge（AC-13）可控消息数 ──
// PanelContainer 用 chatStore.getMessages(sessionId).length 感知 agent 新消息。
// vitest 的 vi.mock 工厂无法引用非 hoisted 顶层 import（reactive），故用 hoisted 容器做转发：
// 响应式 Map（reactiveMessages，模块体创建，vue 已加载）经 registerReader 注册，工厂内 read() 转发。
// 响应式 Map 让 set() 触发 watch 源（panelSessionId + messages.length）重算（普通 Map + 普通数组
// 无响应式依赖，watch 永不触发）。
const chatMock = vi.hoisted(() => {
  let readFn: ((sid: string) => unknown[]) | null = null
  return {
    registerReader(fn: (sid: string) => unknown[]): void {
      readFn = fn
    },
    read(sid: string): unknown[] {
      return readFn ? readFn(sid) : []
    },
  }
})
// 模块级响应式消息表（测试侧 set/clear 的入口；vue 已加载，可安全用 reactive）
const reactiveMessages = reactive(new Map<string, unknown[]>())
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    getMessages: (sid: string) => chatMock.read(sid),
  }),
}))
// 注册 reader：工厂首次执行（PanelContainer 动态 import）时 read() 已能转发到响应式 Map
chatMock.registerReader((sid) => reactiveMessages.get(sid) ?? [])

// ── 桌面独占面板 stub（DrawerPanel 默认 slot 注入的内容；真实组件依赖重，stub 为占位）──
const DesktopStub = (name: string, testid: string) =>
  defineComponent({
    name,
    template: `<div data-testid="${testid}" />`,
  })

// Panel stub：占位，避免 Panel 内部的 chat/session 依赖
const PanelStub = defineComponent({
  name: 'Panel',
  props: { panelId: String, sessionId: { type: String, default: null } },
  template: '<div data-testid="panel" :data-panel-id="panelId" />',
})

async function mountContainer() {
  // 动态 import 让 vi.mock 先生效
  const PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
  return mount(PanelContainer, {
    global: {
      stubs: {
        Panel: PanelStub,
        GitPanel: DesktopStub('GitPanel', 'git-panel'),
        CommandDocPanel: DesktopStub('CommandDocPanel', 'doc-panel'),
        DetailPane: DesktopStub('DetailPane', 'detail-panel'),
        TerminalView: DesktopStub('TerminalView', 'terminal-panel'),
        // bashTask tab 内容面板（background-task-sidebar-view D5③）同样 stub（接线断言面）
        BackgroundTaskDetailPanel: DesktopStub('BackgroundTaskDetailPanel', 'bash-task-detail-panel'),
        // plan tab 内容面板（plan 模式重设计 u1-docs-panel）：PlanDocsPanel 起真面板内含
        // RPC/订阅副作用，接线断言面 stub 同其余桌面面板
        PlanDocsPanel: DesktopStub('PlanDocsPanel', 'plan-docs-panel'),
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  // 直连 core 控制态：绑定分区键（panel store focusedSessionId）+ 清模块级状态（测试隔离）
  bindDrawerSessionId(computed(() => usePanelStore().focusedSessionId))
  _resetDrawerForTest()
  reactiveMessages.clear()
  localStorage.clear() // 动态宽度持久化隔离（taiji:drawer-width）
})

// [HISTORICAL] 用例间 wrapper 必须自动 unmount：PanelContainer 未卸载时其内部 watch（unread
// watch 源含 panelSessionId → leaf → panel.currentLeaf）在下个用例 reset 的 version bump 时
// 排队重算，求值旧 pinia store 的 getter 触发 pinia 内部 setActivePinia(旧 pinia)，污染全局
// activePinia，导致下个用例 usePanelStore() 解析到旧 pinia、读到旧 sid、drawer 打不开。
enableAutoUnmount(afterEach)

describe('PanelContainer 单 panel + Drawer 壳路径（AC9/AC12 冒烟载体）', () => {
  it('drawerOpen=true：DOM 含 drawer-panel + drawer-tab-* 五 tab + drawer-content（W4 换新入口）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-smoke')
    openDrawerTab('git') // 打开 drawer（git tab）

    const wrapper = await mountContainer()
    await nextTick()

    // DrawerPanel 渲染（@taiji/ui/features/drawer）
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)
    // 五基础 tab 按钮（AC9/AC12：drawer-tab-* DOM 断言）
    for (const key of ['terminal', 'browser', 'git', 'doc', 'detail']) {
      expect(wrapper.find(`[data-testid="drawer-tab-${key}"]`).exists()).toBe(true)
    }
    expect(wrapper.find('[data-testid="drawer-content"]').exists()).toBe(true)
    // git tab 内容面板经 slot 注入（C2 v-if chain）
    expect(wrapper.find('[data-testid="git-panel"]').exists()).toBe(true)
  }, 60_000)

  it('drawerOpen=false：无 drawer-panel aside，drawer-area 收缩 0%（内容卸载、宽度承载者常驻）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-closed')

    const wrapper = await mountContainer()
    await nextTick()

    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="panel"]')).toHaveLength(1)
  }, 60_000)
})

describe('PanelContainer 壳行为迁移（旧 side-drawer.test.ts 行为断言壳路径版）', () => {
  it('ESC 键 → drawer 关闭（壳层 window keydown，旧 SideDrawer onKeyDown 迁移）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-esc')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)

    // ESC keydown → PanelContainer closeDrawer → drawer 卸载
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)
    // close 后 keydown 监听已卸（drawer 关闭态不再抢全局 keydown）
    expect(wrapper.find('[data-testid="panel"]').exists()).toBe(true)
  }, 60_000)

  it('close 按钮点击 → drawer 关闭（DrawerPanel emit close → 壳 closeDrawer）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-close-btn')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)

    await wrapper.find('[data-testid="drawer-close"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)
  }, 60_000)
})

// bashTask tab 接线（background-task-sidebar-view D5③：v-if chain 加分支 + 未选中空态 fallback）
describe('PanelContainer bashTask tab 接线（D5③）', () => {
  it('bashTask + 已选中任务 → 注入 BackgroundTaskDetailPanel（stub 面板渲染）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-bash-selected')
    // 模拟列表 item 点击写入（D5④ 写入面：core 分区 selectedBackgroundTaskId）
    getDrawerControlState().selectedBackgroundTaskId = 'bt-20260906-a1b2c3'
    openDrawerTab('bashTask')

    const wrapper = await mountContainer()
    await nextTick()

    expect(wrapper.find('[data-testid="bash-task-detail-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(false)
  }, 60_000)

  it('bashTask + 未选中任务（selectedBackgroundTaskId undefined）→ 不注入 → DrawerPanel 空态 fallback', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-bash-empty')
    openDrawerTab('bashTask')

    const wrapper = await mountContainer()
    await nextTick()

    expect(wrapper.find('[data-testid="bash-task-detail-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(true)
    // bashTask tab 按钮随 SideDrawerTab 扩展常驻（DrawerPanel D5②）
    expect(wrapper.find('[data-testid="drawer-tab-bashTask"]').exists()).toBe(true)
  }, 60_000)
})

// plan tab 接线（plan 模式重设计 u1-drawer-tab + u1-docs-panel：v-if chain 分支 + 面板常驻注入；
// u1-drawer-tab 阶段断言对象是空骨架 plan-docs-panel-skeleton，u1-docs-panel 起由 PlanDocsPanel
// 真面板替换——testid 随被测对象演进为 plan-docs-panel，无条件注入语义不变）
describe('PanelContainer plan tab 接线（u1-drawer-tab + u1-docs-panel）', () => {
  it('plan tab 激活 → 注入 PlanDocsPanel（常驻容器，不经空态 fallback）；plan tab 按钮常驻', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-plan-skeleton')
    openDrawerTab('plan')

    const wrapper = await mountContainer()
    await nextTick()

    // 面板注入（u1-docs-panel 交付面；内部空态/文档渲染归 PlanDocsPanel 自身单测）
    expect(wrapper.find('[data-testid="plan-docs-panel"]').exists()).toBe(true)
    // 无条件注入语义：面板存在时空态 fallback 不渲染（与 bashTask「未选中不注入」相反）
    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(false)
    // plan tab 按钮随 SideDrawerTab 第 9 员常驻（DrawerPanel TabMeta）
    expect(wrapper.find('[data-testid="drawer-tab-plan"]').exists()).toBe(true)
    // 既有 8 tab 无回归
    for (const key of ['terminal', 'browser', 'git', 'doc', 'detail', 'subagent', 'workflow', 'bashTask']) {
      expect(wrapper.find(`[data-testid="drawer-tab-${key}"]`).exists()).toBe(true)
    }
  }, 60_000)

  it('切走 tab（git）→ plan 面板卸载（v-if 按 tab 激活切换）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-plan-switch')
    openDrawerTab('plan')

    const wrapper = await mountContainer()
    await nextTick()
    expect(wrapper.find('[data-testid="plan-docs-panel"]').exists()).toBe(true)

    // 切到 git tab → plan 面板卸载、git 面板注入（v-if chain 互斥）
    setDrawerTab('git')
    await nextTick()
    expect(wrapper.find('[data-testid="plan-docs-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="git-panel"]').exists()).toBe(true)
  }, 60_000)
})

describe('PanelContainer unread badge 壳侧补回（AC-13，旧 SideDrawer 逻辑迁移）', () => {
  it('drawer 打开期间 chatStore 消息数增长 → header-extra slot 内 badge 出现并显示计数', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-badge')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()
    // 初始无消息 → 无 badge
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').exists()).toBe(false)

    // 消息数增长（模拟 agent 新消息到达）→ unreadCount 累加 → badge 出现
    reactiveMessages.set('s-badge', [1, 2])
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').text()).toContain('2')
  }, 60_000)

  it('关 drawer（回对话流）→ unreadCount 清零，badge 消失', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-badge-close')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()
    reactiveMessages.set('s-badge-close', [1, 2])
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').exists()).toBe(true)

    // 关 drawer → 清零 → badge 消失
    await wrapper.find('[data-testid="drawer-close"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').exists()).toBe(false)
  }, 60_000)
})

// ── 动态宽度（feat-chat-flow-width）：无 drawer main 75% / 有 drawer 拆分 + 拖动/键盘/持久化 ──

/** jsdom 无布局：mock splitArea rect（宽 1000px，右缘 x=1000），drawer 宽 = (right - clientX)/width */
function mockSplitAreaRect(wrapper: Awaited<ReturnType<typeof mountContainer>>): void {
  const area = wrapper.find('[data-testid="split-area"]').element
  area.getBoundingClientRect = () =>
    ({ width: 1000, right: 1000, left: 0, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
}

/** 读取区域宽度 style（jsdom 不执行 CSS transition，style.width 即终态） */
function areaWidth(wrapper: Awaited<ReturnType<typeof mountContainer>>, testid: string): string {
  const style = wrapper.find(`[data-testid="${testid}"]`).attributes('style') ?? ''
  return /width:\s*([^;]+);/.exec(style)?.[1] ?? ''
}

/** 读取 style 属性原文（margin / CSS 变量断言用） */
function areaStyle(wrapper: Awaited<ReturnType<typeof mountContainer>>, testid: string): string {
  return wrapper.find(`[data-testid="${testid}"]`).attributes('style') ?? ''
}

describe('PanelContainer 动态宽度（feat-chat-flow-width）', () => {
  it('无 drawer：main-area 75% + margin 居中 + 内容封顶解除，drawer-area 0%，无 resize handle', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-width-closed')

    const wrapper = await mountContainer()
    await nextTick()

    expect(areaWidth(wrapper, 'main-area')).toBe('75%')
    const mainStyle = areaStyle(wrapper, 'main-area')
    // standalone 居中：75% 容器两侧各 (100%-75%)/2 留白（显式 calc 而非 auto，保证开合动画可插值）
    expect(mainStyle).toContain('margin-left: 12.5%')
    expect(mainStyle).toContain('margin-right: 12.5%')
    // 内容列封顶解除（.content-col 消费 --content-max-w；覆盖全局 720px → 内容占满 75% 区域）
    expect(mainStyle).toContain('--content-max-w: 100%')
    expect(areaWidth(wrapper, 'drawer-area')).toBe('0%')
    expect(wrapper.find('[data-testid="drawer-resize-handle"]').exists()).toBe(false)
  }, 60_000)

  it('有 drawer（默认）：main = calc(100% - 50% - 1px) + margin 0 贴左 + 封顶解除不变，drawer = 50%，handle 挂载', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-width-open')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()

    expect(areaWidth(wrapper, 'main-area')).toBe('calc(100% - 50% - 1px)')
    // split：main 贴左（drawer 贴右），margin 0；--content-max-w 两态恒 100%（开合无值切换跳变）
    const mainStyle = areaStyle(wrapper, 'main-area')
    expect(mainStyle).toContain('margin-left: 0')
    expect(mainStyle).toContain('--content-max-w: 100%')
    expect(areaWidth(wrapper, 'drawer-area')).toBe('50%')
    const handle = wrapper.find('[data-testid="drawer-resize-handle"]')
    expect(handle.exists()).toBe(true)
    // separator 可达性（键盘微调入口，对齐原 Splitter 键盘交互）
    expect(handle.attributes('role')).toBe('separator')
    expect(handle.attributes('tabindex')).toBe('0')
  }, 60_000)

  it('拖动：pointerdown+move 更新宽度并 clamp 到 [20,60]，pointerup 持久化 localStorage；拖动期间 transition 移除', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-width-drag')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()
    mockSplitAreaRect(wrapper)

    const handle = wrapper.find('[data-testid="drawer-resize-handle"]')
    await handle.trigger('pointerdown', { pointerId: 1 })
    await nextTick()
    // 拖动期间 transition 移除（跟手，不滞后）+ data-state=drag（高亮反馈）
    expect(wrapper.find('[data-testid="main-area"]').classes().join(' ')).not.toContain('transition-[width,margin]')
    expect(handle.attributes('data-state')).toBe('drag')

    // 指针移到 x=700 → drawer 宽 = (1000-700)/1000 = 30%
    await handle.trigger('pointermove', { pointerId: 1, clientX: 700 })
    await nextTick()
    expect(areaWidth(wrapper, 'drawer-area')).toBe('30%')

    // 越界拖动（x=100 → 名义 90%）→ clamp 到 max 60%；低于 min 同理 clamp
    await handle.trigger('pointermove', { pointerId: 1, clientX: 100 })
    await nextTick()
    expect(areaWidth(wrapper, 'drawer-area')).toBe('60%')
    await handle.trigger('pointermove', { pointerId: 1, clientX: 950 })
    await nextTick()
    expect(areaWidth(wrapper, 'drawer-area')).toBe('20%')

    // pointerup → 持久化最后一次拖动值 + transition 恢复
    await handle.trigger('pointerup', { pointerId: 1 })
    await nextTick()
    expect(localStorage.getItem('taiji:drawer-width')).toBe('20')
    expect(wrapper.find('[data-testid="main-area"]').classes().join(' ')).toContain('transition-[width,margin]')
    expect(handle.attributes('data-state')).toBeUndefined()
  }, 60_000)

  it('键盘微调：ArrowLeft/Right ±2% 并 clamp，同步持久化', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-width-key')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()

    const handle = wrapper.find('[data-testid="drawer-resize-handle"]')
    await handle.trigger('keydown', { key: 'ArrowLeft' })
    await nextTick()
    expect(areaWidth(wrapper, 'drawer-area')).toBe('48%')

    // 连续 ArrowRight 越界 → clamp 60
    for (let i = 0; i < 8; i++) await handle.trigger('keydown', { key: 'ArrowRight' })
    await nextTick()
    expect(areaWidth(wrapper, 'drawer-area')).toBe('60%')
    expect(localStorage.getItem('taiji:drawer-width')).toBe('60')

    // 非方向键不处理（宽度不变）
    await handle.trigger('keydown', { key: 'Enter' })
    await nextTick()
    expect(areaWidth(wrapper, 'drawer-area')).toBe('60%')
  }, 60_000)

  it('持久化恢复：localStorage 预置 35 → mount 后 drawer 35%；非法值回退 50；越界值 clamp', async () => {
    localStorage.setItem('taiji:drawer-width', '35')
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-width-restore')
    openDrawerTab('git')

    let wrapper = await mountContainer()
    await nextTick()
    expect(areaWidth(wrapper, 'drawer-area')).toBe('35%')
    expect(areaWidth(wrapper, 'main-area')).toBe('calc(100% - 35% - 1px)')
    wrapper.unmount()

    // 非法（NaN）→ 默认 50
    localStorage.setItem('taiji:drawer-width', 'abc')
    _resetDrawerForTest()
    const panel2 = usePanelStore()
    panel2.loadSession(ROOT_PANEL_ID, 's-width-restore2')
    openDrawerTab('git')
    wrapper = await mountContainer()
    await nextTick()
    expect(areaWidth(wrapper, 'drawer-area')).toBe('50%')
    wrapper.unmount()

    // 越界（95）→ clamp 60
    localStorage.setItem('taiji:drawer-width', '95')
    _resetDrawerForTest()
    const panel3 = usePanelStore()
    panel3.loadSession(ROOT_PANEL_ID, 's-width-restore3')
    openDrawerTab('git')
    wrapper = await mountContainer()
    await nextTick()
    expect(areaWidth(wrapper, 'drawer-area')).toBe('60%')
  }, 60_000)

  it('开合切换：drawer 打开后 main 从 75% 动画到拆分比例（style 逐帧驱动，断言终态）+ layout 事件派发', async () => {
    const events: string[] = []
    const onLayout = () => events.push('layout')
    window.addEventListener('taiji:splitter-layout', onLayout)

    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-width-toggle')

    const wrapper = await mountContainer()
    await nextTick()
    expect(areaWidth(wrapper, 'main-area')).toBe('75%')
    expect(areaStyle(wrapper, 'main-area')).toContain('margin-left: 12.5%')
    expect(areaStyle(wrapper, 'main-area')).toContain('margin-right: 12.5%')

    // 打开 drawer：main 收缩到 50% 拆分（居中 margin 归 0 贴左）+ rAF 循环派发 layout 事件（BrowserPane rect 同步）
    openDrawerTab('git')
    await nextTick()
    expect(areaWidth(wrapper, 'main-area')).toBe('calc(100% - 50% - 1px)')
    expect(areaStyle(wrapper, 'main-area')).toContain('margin-left: 0')
    expect(areaWidth(wrapper, 'drawer-area')).toBe('50%')

    // rAF 循环逐帧派发（至少一帧）——等待两帧后断言
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    expect(events.length).toBeGreaterThan(0)
    window.removeEventListener('taiji:splitter-layout', onLayout)
  }, 60_000)
})
