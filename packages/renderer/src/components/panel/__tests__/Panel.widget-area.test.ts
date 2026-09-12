/**
 * Panel.widget-area.test.ts —— M17 Panel 挂载 WidgetArea 链路测试（design.json TC8/TC9）
 * + D 方案（单行 pill 状态带 + 详情 popover）行为测试。
 *
 * 覆盖：
 *  - TC8 WidgetArea 在 MessageStream 与 composer-band 之间（DOM 顺序断言，消息分支链后）；
 *    D 方案形态：widget-area 内是单行 pill（非多卡面板）
 *  - TC9 挂载条件：①isSessionDead=true 不渲染；②sessionId=null 不渲染（IF4）
 *  - TC10 点击 pill → PopoverContent（teleport 到 body）展开完整列表；再点收起
 *  - TC11 guiTree 有 running 条目 → pill 显示进行中项预览
 *
 * 策略（design WQ1 resolution）：mount 真实 Panel（非 shallowMount）+ stub 重型子组件
 * （MessageStream/Composer/Landing/AskUserOverlay），WidgetArea 不 stub——经 @xyz-agent/ui
 * 真实渲染，保 DOM 顺序断言可行。store/composable mock 对齐 MessageStream.wire.test.ts
 * 模式（vi.hoisted + vi.mock 模块替换，隔离 store 副作用）。
 * reka Popover 的 PopoverContent teleport 到 body：浮层断言在 document.body 内做
 * （对齐 add-menu-popover.test.ts 模式），mount 需 attachTo: document.body。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/Panel.widget-area.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { createPinia } from 'pinia'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import Panel from '../Panel.vue'
import { VIEW_HOST_SOURCE_KEY, type ViewHostSource } from '@xyz-agent/ui/extension-host'

// ── mock 面（Panel script 依赖的最小闭合集）──────────────────────────

/** chat store mock：Panel 消费 getMessages/isActive/isCompacting/failedHistory；
 *  真实子组件 TurnProgressBar 经 core useTurnProgress 另消费 getOccupancy（TurnProgressChatSource
 *  契约双读口）——缺省形态对齐 store.ts getOccupancy 无记录回落值（全 idle） */
const chatMock = vi.hoisted(() => ({
  getMessages: vi.fn(() => [] as unknown[]),
  getOccupancy: vi.fn(() => ({ turn: 'idle' as const, compacting: false, bash: false })),
  isActive: vi.fn(() => false),
  isCompacting: vi.fn(() => false),
  isRespawnPending: vi.fn(() => false),
  failedHistory: new Map<string, boolean>(),
}))
vi.mock('@/stores/chat', () => ({ useChatStore: () => chatMock }))

/** session store mock：Panel 只消费 list（isSessionDead 判据 status === 'dead'） */
const sessionMock = vi.hoisted(() => ({
  list: [] as Array<{ id: string; status: string }>,
}))
vi.mock('@/stores/session', () => ({ useSessionStore: () => sessionMock }))

/** new-task flow mock：state 恒 idle（非 landing 态，TC8 走 MessageStream/空对话分支）。
 *  isActive 供 panel-view 派生消费（D1：landing ⟺ !sessionId && isFlowActive），
 *  恒 false → 本文件的 sid=null 用例落 empty 而非 landing，与 TC9② 断言一致 */
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ state: ref('idle'), isActive: ref(false) }),
}))

/** sidebar mock：Panel setup 内解构 restoreSession/retryHistory/deleteSession */
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({
    restoreSession: vi.fn(async () => {}),
    retryHistory: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
  }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

/** useExtensionUI mock：无 ask-user 请求（currentAskUserRequest 恒 undefined，band 渲染 Composer） */
const extensionUIMock = vi.hoisted(() => ({
  currentAskUserRequest: { value: undefined as unknown },
  respond: vi.fn(),
  cancel: vi.fn(),
}))
vi.mock('@/composables/useExtensionUI', () => ({
  useExtensionUI: () => extensionUIMock,
  askUserFilter: () => true,
}))

// ── 固定 widget source（WidgetArea 经 inject 消费，TC8 真实渲染 pill）──

const WIDGET_GUI: GuiComponent = { type: 'ansi-text', props: { lines: ['widget todo line'] } }
const widgetSource: ViewHostSource = {
  getViewIds: (sessionId: string) => (sessionId === 's1' ? ['todo'] : []),
  getView: (sessionId: string, viewId: string) =>
    sessionId === 's1' && viewId === 'todo'
      ? { viewId: 'todo', pluginId: 'p1', guiTree: [WIDGET_GUI], updatedAt: 1 }
      : undefined,
}

/** TC11 用：list-tree 带 running 条目（活动项预览的数据形态，对齐 todo 扩展 buildGui 产物） */
const LIST_TREE_GUI: GuiComponent = {
  type: 'list-tree',
  props: {
    numbered: true,
    items: [
      { label: '已完成步骤', status: 'done' },
      { label: '正在跑的步骤', status: 'running' },
      { label: '等待中的步骤' },
    ],
  },
}
const listTreeSource: ViewHostSource = {
  getViewIds: (sessionId: string) => (sessionId === 's1' ? ['todo'] : []),
  getView: (sessionId: string, viewId: string) =>
    sessionId === 's1' && viewId === 'todo'
      ? { viewId: 'todo', pluginId: 'p1', guiTree: [LIST_TREE_GUI], updatedAt: 1 }
      : undefined,
}

/** MessageStream stub（render 函数，不依赖运行时模板编译器）——DOM 顺序断言的左侧锚点 */
const MessageStreamStub = defineComponent({
  name: 'MessageStream',
  render: () => h('div', { 'data-testid': 'message-stream-stub' }),
})

function mountPanel(sessionId: string | null, source: ViewHostSource = widgetSource) {
  return mount(Panel, {
    props: { panelId: 'p1', sessionId, sessionDir: '/tmp/x' },
    attachTo: document.body,
    global: {
      plugins: [createPinia()],
      provide: { [VIEW_HOST_SOURCE_KEY as symbol]: source },
      stubs: {
        MessageStream: MessageStreamStub,
        Composer: true,
        Landing: true,
        AskUserOverlay: true,
      },
    },
  })
}

beforeEach(() => {
  chatMock.getMessages.mockReturnValue([])
  chatMock.isActive.mockReturnValue(false)
  chatMock.isCompacting.mockReturnValue(false)
  chatMock.failedHistory.clear()
  sessionMock.list = []
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Panel 挂载 WidgetArea（M17）', () => {
  it('TC8: session 有效且非 dead → widget-area（单行 pill）位于 MessageStream 与 composer-band 之间', async () => {
    // 有消息（messageCount>0 → MessageStream 分支命中）+ session 非 dead
    chatMock.getMessages.mockReturnValue([{ id: 'm1' }])
    sessionMock.list = [{ id: 's1', status: 'idle' }]

    const wrapper = mountPanel('s1')
    await wrapper.vm.$nextTick()

    // WidgetArea 真实渲染（未 stub）：D 方案形态 = 单行 pill 状态带（非多卡面板）
    const area = wrapper.find('[data-testid="widget-area"]')
    expect(area.exists()).toBe(true)
    expect(wrapper.find('[data-testid="widget-pill"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="widget-pill-seg"]').exists()).toBe(true)
    expect(area.text()).toContain('todo')

    // DOM 顺序（section 直接子元素比较）：message-stream-stub < widget-area < composer-band。
    // Panel 是 fragment 根组件（根级注释 + section），wrapper.element 是 test-utils 包的
    // 外层 DIV，需先定位 section 再取其子元素。
    const section = wrapper.find('section')
    expect(section.exists()).toBe(true)
    const kids = Array.from(section.element.children)
    const idxOf = (pred: (el: Element) => boolean): number => kids.findIndex(pred)
    const streamIdx = idxOf((el) => el.getAttribute('data-testid') === 'message-stream-stub')
    const widgetIdx = idxOf((el) => el.getAttribute('data-testid') === 'widget-area')
    const bandIdx = idxOf((el) => el.classList.contains('composer-band'))

    expect(streamIdx).toBeGreaterThanOrEqual(0) // MessageStream 分支命中（防 Landing 误渲染）
    expect(bandIdx).toBeGreaterThanOrEqual(0)
    expect(widgetIdx).toBeGreaterThan(streamIdx)
    expect(widgetIdx).toBeLessThan(bandIdx)
  })

  it('TC9①: isSessionDead=true → widget-area 不渲染（dead 占位接管主区）', async () => {
    // dead 优先于消息分支：即使有消息也渲染 dead 占位，WidgetArea 挂载条件不含 dead
    chatMock.getMessages.mockReturnValue([{ id: 'm1' }])
    sessionMock.list = [{ id: 's1', status: 'dead' }]

    const wrapper = mountPanel('s1')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="widget-area"]').exists()).toBe(false)
  })

  it('TC9②: sessionId=null → widget-area 不渲染（null session 无分区可枚举）', async () => {
    const wrapper = mountPanel(null)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="widget-area"]').exists()).toBe(false)
  })
})

describe('WidgetArea D 方案：pill + 详情 popover', () => {
  it('TC10: 点击 pill → body 内展开浮层显示完整列表；再点收起', async () => {
    chatMock.getMessages.mockReturnValue([{ id: 'm1' }])
    sessionMock.list = [{ id: 's1', status: 'idle' }]

    const wrapper = mountPanel('s1')
    await wrapper.vm.$nextTick()

    // 初始收起：body 无浮层
    expect(document.body.querySelector('[data-testid="widget-popover"]')).toBeNull()

    // 点击 pill → PopoverContent teleport 到 body，渲染 guiTree 完整内容
    const pill = wrapper.find('[data-testid="widget-pill"]')
    await pill.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    const popover = document.body.querySelector('[data-testid="widget-popover"]')
    expect(popover).not.toBeNull()
    expect(popover!.textContent).toContain('widget todo line')
    expect(document.body.querySelector('[data-testid="widget-popover-card"]')).not.toBeNull()

    // 再点 pill → 收起（浮层从 body 移除）
    await pill.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector('[data-testid="widget-popover"]')).toBeNull()

    wrapper.unmount()
  })

  it('TC11: guiTree 有 running 条目 → pill 显示进行中项预览（用户可见的当前项）', async () => {
    chatMock.getMessages.mockReturnValue([{ id: 'm1' }])
    sessionMock.list = [{ id: 's1', status: 'idle' }]

    const wrapper = mountPanel('s1', listTreeSource)
    await wrapper.vm.$nextTick()

    const active = wrapper.find('[data-testid="widget-pill-active"]')
    expect(active.exists()).toBe(true)
    expect(active.text()).toBe('正在跑的步骤')

    wrapper.unmount()
  })

  it('TC12: 无 running 条目（全完成）→ pill 不渲染活动项预览', async () => {
    chatMock.getMessages.mockReturnValue([{ id: 'm1' }])
    sessionMock.list = [{ id: 's1', status: 'idle' }]

    const wrapper = mountPanel('s1') // ansi-text source：无 list-tree 条目
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="widget-pill-active"]').exists()).toBe(false)

    wrapper.unmount()
  })
})
