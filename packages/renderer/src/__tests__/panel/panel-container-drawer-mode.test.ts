/**
 * PanelContainer 集成测试 —— 单 panel + Drawer 壳路径（W4 drawer-shell-integration）。
 *
 * 迁移自旧 panel-container-drawer-mode.test.ts（SideDrawer stub → DrawerPanel 真实渲染）
 * + 旧 side-drawer.test.ts / SideDrawer.test.ts 的行为断言壳路径版（D6 triage：行为型迁移
 * 改写为壳路径断言，内部断言/mock spy 型删除）。
 *
 * 壳路径（mount PanelContainer，test-strategy 集成章节要求）：
 * - PanelContainer 渲染跨端共享容器 DrawerPanel（@taiji/ui/features/drawer，W3），
 *   断言 drawer-panel + drawer-content DOM 存在（AC9/AC12 壳层载体）；drawer-tab-* 全量
 *   tab 按钮断言收拢在「注册表契约」用例（右抽屉终态 8 成员，其余用例只断言被测 tab）
 * - drawerOpen=true：DrawerPanel 在 drawer-area wrapper 内挂载（feat-chat-flow-width 手写
 *   flex 布局，替换 reka-ui Splitter：无 drawer main 卡撑满、卡内内容列（对话流 + composer）
 *   限宽 60% 居中（ui-signal-density D10 2026-10-06 修订，720px 下限后撑满）、
 *   有 drawer 双侧 width 动画、handle 拖动/键盘调整 + localStorage 持久化，见下方「动态宽度」describe）
 * - drawerOpen=false：DrawerPanel aside 卸载，drawer-area 收缩为 0%（width 动画承载者常驻）
 * - close 按钮关闭 → drawer 卸载（旧 side-drawer.test.ts 行为迁移；ESC 已随
 *   display-containers §6.7 W1 归栈序编排器，壳层 ESC 零动作有专属负向用例 +
 *   关闭后焦点回 composer 的焦点契约用例）
 * - 内容区 fallback：无面板 tab 不注入内容 → DrawerPanel 空态（drawer-widget-empty）
 *   （[P4 s5 drawer-widget-removal] 旧 widget 缓冲通路已删，由 PluginViewContainer 承接；
 *   browser 内容已迁浮层（display-containers §7.4），右抽屉无 browser tab）
 * - unread badge（AC-13）：chatStore 消息数增长 → header-extra slot 内 drawer-unread-badge
 *   出现并显示计数；关 drawer 清零
 *
 * 控制态经 core drawer 域直连（PanelContainer 自持 bindDrawerSessionId，不消费 useSideDrawer
 * 兼容层——C1）：测试同样直连 core（bindDrawerSessionId + openDrawerTab + _resetDrawerForTest）。
 * 静态依赖隔离：重面板（GitPanel/CommandDocPanel/BackgroundTaskDetailPanel/PlanDocsPanel/
 * BtwPanel）与壳层组件（Panel/PanelHeader/ToastContainer/TraceInspector/SubagentTab/
 * WorkflowTab/StatusBar）vi.mock 占位组件（import 期替换——global.stubs 只在渲染期替换，
 * import 期仍加载原模块触发 PanelContainer 整棵依赖图 transform，四个 PanelContainer 测试
 * 文件的用例时间合计被该 transform 主导；壳层组件零 DOM 断言，占位只保挂载点）。懒加载
 * DetailPane/TerminalView（PanelContainer 动态 import，不在静态图内）保留渲染期 stub。
 * DrawerPanel（@taiji/ui/features/drawer）真实渲染：drawer-panel/tab/空态断言与
 * header-extra slot 承接都在它身上。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/panel-container-drawer-mode.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, ref, computed, nextTick, reactive, type Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import {
  bindDrawerSessionId,
  openDrawerTab,
  setDrawerTab,
  setBackgroundTaskView,
  _resetDrawerForTest,
  CONTAINER_REGISTRY,
  RIGHT_DRAWER_REGISTRY,
  BOTTOM_DRAWER_REGISTRY,
  OVERLAY_REGISTRY,
} from '@taiji/core/domain/drawer'
// drawer-tab 注册表契约：全量 tab 清单收拢在 helpers/drawer-tabs.ts（RightDrawerTab 运行时
// 投影，satisfies Record 双向防漂移），本文件的「注册表契约」用例是唯一全量断言处。其余
// 用例只断言被测 tab 自身按钮，不再各留子集循环。
import { L1_DRAWER_TABS } from '../helpers/drawer-tabs'

// ── mock 壳层依赖（PanelContainer setup 阶段执行，避免真实 WS/session 副作用）──
vi.mock('@/composables/features/file-tree/useGitStatus', () => ({
  GIT_STATUS_KEY: Symbol('git-status'),
  provideGitStatus: () => ({ indicator: { value: undefined }, state: { value: 'clean' }, lines: { value: [] } }),
}))
vi.mock('@/composables/features/chat/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))

// ── 静态重面板 vi.mock（import 期替换：vitest 不再加载原模块，砍掉 PanelContainer 整图
// transform；占位组件与原 global.stubs 等价——同名 testid，接线断言面不变）。工厂零外部
// 引用（普通 options 对象组件），规避 vi.mock hoisting 对顶层绑定的限制。──
vi.mock('@/components/panel/GitPanel.vue', () => ({
  default: { name: 'GitPanel', template: '<div data-testid="git-panel" />' },
}))
vi.mock('@/components/panel/CommandDocPanel.vue', () => ({
  default: { name: 'CommandDocPanel', template: '<div data-testid="doc-panel" />' },
}))
vi.mock('@/components/extension/BackgroundTaskDetailPanel.vue', () => ({
  default: { name: 'BackgroundTaskDetailPanel', template: '<div data-testid="bash-task-detail-panel" />' },
}))
vi.mock('@/components/panel/plan/PlanDocsPanel.vue', () => ({
  default: { name: 'PlanDocsPanel', template: '<div data-testid="plan-docs-panel" />' },
}))
vi.mock('@/components/panel/BtwPanel.vue', () => ({
  default: { name: 'BtwPanel', template: '<div data-testid="btw-panel" />' },
}))

// ── 壳层组件 vi.mock（import 期替换，同上砍整图 transform；七个组件在本文件零 DOM 断言，
// 占位空壳保挂载点即可。Panel 例外：保 testid="panel" + data-panel-id，壳行为用例断言主
// panel 挂载数量。StatusBar 来自 @taiji/ui/extension-host，mock 路径须与 PanelContainer 的
// import 说明符一致。DrawerPanel 不 mock——真实渲染承接全部 drawer 断言与 header-extra slot）──
vi.mock('@/components/panel/Panel.vue', () => ({
  default: {
    name: 'Panel',
    props: { panelId: String, sessionId: { type: String, default: null } },
    template: '<div data-testid="panel" :data-panel-id="panelId" />',
  },
}))
vi.mock('@/components/panel/PanelHeader.vue', () => ({
  default: { name: 'PanelHeader', template: '<div />' },
}))
vi.mock('@/components/ui/ToastContainer.vue', () => ({
  default: { name: 'ToastContainer', template: '<div />' },
}))
vi.mock('@/components/panel/trace/TraceInspector.vue', () => ({
  default: { name: 'TraceInspector', template: '<div />' },
}))
vi.mock('@/components/panel/SubagentTab.vue', () => ({
  default: { name: 'SubagentTab', template: '<div />' },
}))
vi.mock('@/components/panel/WorkflowTab.vue', () => ({
  default: { name: 'WorkflowTab', template: '<div />' },
}))
vi.mock('@taiji/ui/extension-host', () => ({
  StatusBar: { name: 'StatusBar', template: '<div />' },
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

// ── 渲染期 stub（vi.mock 未覆盖的组件）：懒加载 DetailPane/TerminalView（PanelContainer
// 动态 import 的 v-else-if 互斥分支，不在静态依赖图内，渲染期 stub 即可）──
const DesktopStub = (name: string, testid: string) =>
  defineComponent({
    name,
    template: `<div data-testid="${testid}" />`,
  })

async function mountContainer(stubOverrides: Record<string, Component> = {}) {
  // 动态 import 让 vi.mock 先生效
  const PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
  return mount(PanelContainer, {
    global: {
      stubs: {
        DetailPane: DesktopStub('DetailPane', 'detail-panel'),
        TerminalView: DesktopStub('TerminalView', 'terminal-panel'),
        ...stubOverrides,
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

describe('drawer-tab 注册表契约（L1 全量收敛点，display-containers §7.2）', () => {
  it('drawer 打开态渲染注册表投影的全部 L1 tab（8 条终态，terminal/browser 均不在）+ 注册表形状 右 8/底 1/浮 2', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-tab-registry')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()

    for (const key of L1_DRAWER_TABS) {
      expect(wrapper.find(`[data-testid="drawer-tab-${key}"]`).exists(), `drawer-tab-${key} 应存在`).toBe(true)
    }
    // terminal 迁出 L1（用户可见：右抽屉不再有终端图标——入口改底抽屉 ⌃` / StatusBar 按钮）；
    // browser 迁出 L1（用户可见：右抽屉不再有浏览器图标——能力在浮层复活，点 localhost 链接进入）
    expect(L1_DRAWER_TABS).toHaveLength(8)
    expect(wrapper.find('[data-testid="drawer-tab-terminal"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="drawer-tab-browser"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid^="drawer-tab-"]')).toHaveLength(8)

    // 注册表形状机器锚（§8.2：右 8/底 1/浮 2——迁移源侧清空）
    expect(RIGHT_DRAWER_REGISTRY).toHaveLength(8)
    expect(BOTTOM_DRAWER_REGISTRY).toHaveLength(1)
    expect(OVERLAY_REGISTRY).toHaveLength(2)
    expect(CONTAINER_REGISTRY['bottom-drawer'][0]?.content).toBe('terminal')
  }, 60_000)
})

describe('PanelContainer 单 panel + Drawer 壳路径（AC9/AC12 冒烟载体）', () => {
  it('drawerOpen=true：DOM 含 drawer-panel + drawer-content（W4 换新入口；tab 全量归注册表契约用例）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-smoke')
    openDrawerTab('git') // 打开 drawer（git tab）

    const wrapper = await mountContainer()
    await nextTick()

    // DrawerPanel 渲染（@taiji/ui/features/drawer）
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)
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

// 首屏冒烟（TC1）：DrawerPanel 探针 stub 仅本用例覆盖——断言壳派发的 sessionId 落进
// DrawerPanel props 面；其余用例走真实 DrawerPanel（drawer-panel/tab DOM 断言面）。
const DrawerPanelProbe = defineComponent({
  name: 'DrawerPanel',
  props: {
    isOpen: Boolean,
    activeTab: String,
    sessionId: { type: String, default: null },
  },
  template:
    '<div data-testid="drawer-panel" :data-is-open="isOpen" :data-active-tab="activeTab" :data-session-id="sessionId" />',
})

describe('PanelContainer 首屏冒烟（TC1）', () => {
  it('drawerOpen=true：resize handle（separator）+ main/drawer 双区域挂载 + DrawerPanel 收到壳派发的 sessionId', async () => {
    // 先 loadSession 让 panel store 有 focusedSessionId，再 open（分区键为 null 时 open 写入
    // 的 isOpen 落不到 mount 后 active panel 对应的分区）
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-tc1')
    openDrawerTab('git') // 打开 drawer（git tab）

    const wrapper = await mountContainer({ DrawerPanel: DrawerPanelProbe })

    // resize handle 存在（drawer 打开时可拖动调宽，role=separator 键盘可达）
    const handle = wrapper.find('[data-testid="drawer-resize-handle"]')
    expect(handle.exists()).toBe(true)
    expect(handle.attributes('role')).toBe('separator')
    // main-area + drawer-area 双区域挂载（手写 flex，宽度拆分）
    expect(wrapper.find('[data-testid="main-area"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-area"]').exists()).toBe(true)
    // DrawerPanel 探针收到壳派发的 sessionId（分区键跟随 panel）
    expect(wrapper.find('[data-testid="drawer-panel"]').attributes('data-session-id')).toBe('sess-tc1')
  }, 60_000)
})

describe('PanelContainer 壳行为迁移（旧 side-drawer.test.ts 行为断言壳路径版）', () => {
  it('ESC 键不再由壳层消费（display-containers §6.7 唯一属主 = 栈序编排器）——drawer 原样保持', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-esc')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)

    // ESC keydown → 壳层零动作（旧 window keydown 已拆除：Esc 归编排器按层级序/让位路由，
    // 正向行为（Esc 关抽屉）由 key-orchestrator 单测族承载，双监听双触发即回归）
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)
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

  it('点 drawer-close 关闭后焦点回 composer（§6.7 焦点契约右抽屉鼠标通道，TerminalToggleButton（终端开关）同款）', async () => {
    // focusComposer 按 testid/class 查 document——测试内挂真实 composer 锚
    document.body.innerHTML = '<div class="composer-box" data-testid="composer-box" tabindex="0"></div>'
    const composer = document.querySelector('[data-testid="composer-box"]')
    try {
      const panel = usePanelStore()
      panel.loadSession(ROOT_PANEL_ID, 's-close-focus')
      openDrawerTab('git')

      const wrapper = await mountContainer()
      await nextTick()
      expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)

      await wrapper.find('[data-testid="drawer-close"]').trigger('click')
      await nextTick()
      expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)
      // 用户可见行为：键盘输入有归宿（不流失到 body）
      expect(document.activeElement).toBe(composer)
    } finally {
      document.body.innerHTML = ''
    }
  }, 60_000)

  it('PanelHeader 开关按钮：关闭分支焦点回 composer，打开分支不抢焦点（镜像 TerminalToggleButton）', async () => {
    document.body.innerHTML = '<div class="composer-box" data-testid="composer-box" tabindex="0"></div>'
    const composer = document.querySelector('[data-testid="composer-box"]')
    // PanelHeader 已被 vi.mock 成空壳——经 stub 注入可点击的 toggle 发射器（同名替换）
    const ToggleHeader = defineComponent({
      name: 'PanelHeader',
      emits: ['toggle-drawer'],
      template: '<button data-testid="header-toggle" @click="$emit(\'toggle-drawer\')" />',
    })
    try {
      const panel = usePanelStore()
      panel.loadSession(ROOT_PANEL_ID, 's-toggle-focus')

      const wrapper = await mountContainer({ PanelHeader: ToggleHeader })
      await nextTick()
      expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)

      // 打开分支：不调 focusComposer（焦点不迁移）
      await wrapper.find('[data-testid="header-toggle"]').trigger('click')
      await nextTick()
      expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)
      expect(document.activeElement).not.toBe(composer)

      // 关闭分支：焦点回 composer（§6.7 任一容器关闭后焦点回 composer）
      await wrapper.find('[data-testid="header-toggle"]').trigger('click')
      await nextTick()
      expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)
      expect(document.activeElement).toBe(composer)
    } finally {
      document.body.innerHTML = ''
    }
  }, 60_000)
})

// bashTask tab 接线（background-task-sidebar-view D5③：v-if chain 加分支 + 未选中空态 fallback）
describe('PanelContainer bashTask tab 接线（D5③）', () => {
  it('bashTask + 已选中任务 → 注入 BackgroundTaskDetailPanel（stub 面板渲染）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-bash-selected')
    // 模拟列表 item 点击写入（D5④ 写入面：bashTask 内容域选中态 selection/bash-task.ts）
    setBackgroundTaskView('bt-20260906-a1b2c3')
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
    // bashTask tab 按钮随 RightDrawerTab 终态常驻（DrawerPanel D5②）
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
    // plan tab 按钮随右抽屉注册表条目常驻（DrawerPanel TabMeta；全量清单归注册表契约用例）
    expect(wrapper.find('[data-testid="drawer-tab-plan"]').exists()).toBe(true)
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

// ── 动态宽度（feat-chat-flow-width）：无 drawer 卡撑满 + 内容列 60%（720px 下限撑满）/ 有 drawer 拆分 + 拖动/键盘/持久化 ──

/** jsdom 无布局：mock splitArea rect（默认宽 1000px，右缘 x=1000），drawer 宽 = (right - clientX)/width */
function mockSplitAreaRect(wrapper: Awaited<ReturnType<typeof mountContainer>>, width = 1000): void {
  const area = wrapper.find('[data-testid="split-area"]').element
  area.getBoundingClientRect = () =>
    ({ width, right: width, left: 0, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
}

/** mount 前原型级 stub 全部元素 rect 宽度（内容列下限派生的测量输入在挂载期读取，
 *  须先于 mount 就位；返回恢复函数）。height 恒 0：底抽屉显示期 clamp 未测得即回落，与无布局等价 */
function stubAllElementRects(width: number): () => void {
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({ width, right: width, left: 0, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  )
  return () => spy.mockRestore()
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
  it('无 drawer：main-area 撑满 + 内容列 60% 居中（宽 panel），drawer-area 0%，无 resize handle', async () => {
    // 1600 × 60% = 960 ≥ 720 下限 → 比例分支（挂载期测量读取，rect 须先于 mount 就位）
    const restoreRect = stubAllElementRects(1600)
    try {
      const panel = usePanelStore()
      panel.loadSession(ROOT_PANEL_ID, 's-width-closed')

      const wrapper = await mountContainer()
      await nextTick()

      expect(areaWidth(wrapper, 'main-area')).toBe('100%')
      const mainStyle = areaStyle(wrapper, 'main-area')
      // 撑满语义（D10 2026-10-06 修订）：60% 作用对象是卡内内容列（对话流 + composer），
      // 不是卡容器——留白在卡内两侧，卡与 header 横跨全宽
      expect(mainStyle).toContain('margin-left: 0')
      expect(mainStyle).toContain('margin-right: 0')
      expect(mainStyle).toContain('--content-max-w: 60%')
      expect(areaWidth(wrapper, 'drawer-area')).toBe('0%')
      expect(wrapper.find('[data-testid="drawer-resize-handle"]').exists()).toBe(false)
    } finally {
      restoreRect()
    }
  }, 60_000)

  it('无 drawer 窄 panel：60% 实算低于 720px 下限 → 内容列撑满（--content-max-w: 100%）', async () => {
    // 1000 × 60% = 600 < 720 → 下限触发撑满（drawer 挤窄后恒撑满同因）
    const restoreRect = stubAllElementRects(1000)
    try {
      const panel = usePanelStore()
      panel.loadSession(ROOT_PANEL_ID, 's-width-closed-narrow')

      const wrapper = await mountContainer()
      await nextTick()

      expect(areaWidth(wrapper, 'main-area')).toBe('100%')
      expect(areaStyle(wrapper, 'main-area')).toContain('--content-max-w: 100%')
    } finally {
      restoreRect()
    }
  }, 60_000)

  it('有 drawer（默认）：main = calc(100% - 50% - 4px) + margin 0 贴左 + 内容列恒撑满，drawer = 50%，handle 挂载', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-width-open')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()

    expect(areaWidth(wrapper, 'main-area')).toBe('calc(100% - 50% - 4px)')
    // split：main 贴左（drawer 贴右），margin 0；--content-max-w 恒撑满（panel 被挤窄后不按比例收）
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
    expect(wrapper.find('[data-testid="main-area"]').classes().join(' ')).not.toContain('transition-[width]')
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
    expect(wrapper.find('[data-testid="main-area"]').classes().join(' ')).toContain('transition-[width]')
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
    expect(areaWidth(wrapper, 'main-area')).toBe('calc(100% - 35% - 4px)')
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

  it('开合切换：drawer 打开后 main 从撑满（内容列 60%）动画到拆分比例（内容列恒撑满），断言终态', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-width-toggle')

    const wrapper = await mountContainer()
    await nextTick()
    // standalone：卡撑满（未 stub rect → 宽度未测得，内容列走纯比例分支 60%）
    expect(areaWidth(wrapper, 'main-area')).toBe('100%')
    expect(areaStyle(wrapper, 'main-area')).toContain('margin-left: 0')
    expect(areaStyle(wrapper, 'main-area')).toContain('--content-max-w: 60%')

    // 打开 drawer：main 收缩到拆分比例（margin 恒 0 贴左），内容列改撑满
    // [HISTORICAL] 用例原名含「+ layout 事件派发」：taiji:splitter-layout 已随消费方
    // useBrowserRectSync 迁浮层删除而整体退役（终态同步 2026-10-03，§7.3 不造无人读的事件），
    // 派发断言随行为删除——全仓零监听方后保留派发断言等于锁死死事件。
    openDrawerTab('git')
    await nextTick()
    expect(areaWidth(wrapper, 'main-area')).toBe('calc(100% - 50% - 4px)')
    expect(areaStyle(wrapper, 'main-area')).toContain('margin-left: 0')
    expect(areaStyle(wrapper, 'main-area')).toContain('--content-max-w: 100%')
    expect(areaWidth(wrapper, 'drawer-area')).toBe('50%')
  }, 60_000)
})

// btw tab 接线（btw-question D7，M3-a）：v-if chain 加分支 + 面板常驻注入（与 plan 同款
// ——tab 激活即渲染，面板自渲染线列表空态，不经 DrawerPanel 空态 fallback）
describe('PanelContainer btw tab 接线（btw-question D7 M3-a）', () => {
  it('btw tab 激活 → 注入 BtwPanel（常驻容器）；btw tab 按钮常驻（第 10 员）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-btw-wire')
    openDrawerTab('btw')

    const wrapper = await mountContainer()
    await nextTick()

    // 面板注入（内部线列表/空态/fork pill 归 BtwPanel 自身单测）
    expect(wrapper.find('[data-testid="btw-panel"]').exists()).toBe(true)
    // 常驻注入语义：面板存在时空态 fallback 不渲染（与 plan 同款）
    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(false)
    // btw tab 按钮随右抽屉终态 8 员常驻（DrawerPanel TabMeta；全量清单归注册表契约用例）
    expect(wrapper.find('[data-testid="drawer-tab-btw"]').exists()).toBe(true)
  }, 60_000)

  it('切走 tab（git）→ btw 面板卸载（v-if chain 互斥）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-btw-switch')
    openDrawerTab('btw')

    const wrapper = await mountContainer()
    await nextTick()
    expect(wrapper.find('[data-testid="btw-panel"]').exists()).toBe(true)

    setDrawerTab('git')
    await nextTick()
    expect(wrapper.find('[data-testid="btw-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="git-panel"]').exists()).toBe(true)
  }, 60_000)
})
