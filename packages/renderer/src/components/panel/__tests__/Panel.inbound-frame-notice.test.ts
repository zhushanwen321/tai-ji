/**
 * Panel 入站丢帧终止阀提示条挂载测试（u-init P0 接线，crash-forensics-and-watchdog §3.3 D8）。
 *
 * 缺口背景：InboundFrameDroppedNotice 此前全仓零挂载、installInboundFrameGuard 全仓零调用
 * ——单元测试显式构造状态/组件掩盖了「组合根未装配 + 会话视图未挂载」的集成缺口。本文件
 * 走真实链路的可见性闭环：installInboundFrameGuard（App 装配层等价动作）→ core 丢帧回调
 * → 终止阀投影 → 真实 Panel 会话视图 → 提示条可见；切走切回 → 重试订阅恰好一次 + 提示消失。
 *
 * Mock 策略（Panel 挂载测试最小闭合集，同 Panel.dead-diagnostics-export.test.ts）：
 * - mock core：捕获 onInboundFrameDropped 回调（用真实 useInboundFrameGuard 消费它）+
 *   retryInboundDroppedSession/subscribeSession 调用断言；
 * - mock '@/lib/ipc'（reportRendererLog）——上报面非本用例关注点（unit 文件已覆盖）；
 * - mock 重型子组件（MessageStream/Composer/Landing/FormOverlay）；Panel 与
 *   useInboundFrameGuard/InboundFrameDroppedNotice 均真实渲染；
 * - 真实 Pinia（守卫的 focus watch 数据源 = panel store focusedSessionId）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/Panel.inbound-frame-notice.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { InboundFrameDroppedInfo } from '@taiji/core'
import { ROOT_PANEL_ID, usePanelStore } from '@/stores/panel'
import Panel from '../Panel.vue'
import {
  _resetInboundFrameGuardForTest,
  installInboundFrameGuard,
  isInboundSessionTripped,
} from '@/composables/useInboundFrameGuard'

// ── mock 面 ────────────────────────────────────────────────────────

const coreMock = vi.hoisted(() => ({
  onInboundFrameDropped: vi.fn(),
  retryInboundDroppedSession: vi.fn(),
  subscribeSession: vi.fn(),
}))
const reportMock = vi.hoisted(() => vi.fn())

vi.mock('@taiji/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taiji/core')>()),
  onInboundFrameDropped: coreMock.onInboundFrameDropped,
  retryInboundDroppedSession: coreMock.retryInboundDroppedSession,
  subscribeSession: coreMock.subscribeSession,
}))

vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  reportRendererLog: reportMock,
}))

/** chat store mock：Panel 只消费 readers 面（含 isRespawnPending 过渡条） */
const chatMock = vi.hoisted(() => ({
  getMessages: vi.fn(() => [] as unknown[]),
  isActive: vi.fn(() => false),
  isCompacting: vi.fn(() => false),
  isRespawnPending: vi.fn(() => false),
  // occupancy 投影读口（缺省全 idle，对齐 store.getOccupancy 无记录缺省）
  getOccupancy: vi.fn(() => ({ turn: 'idle', compacting: false, bash: false })),
  failedHistory: new Map<string, boolean>(),
}))
vi.mock('@/stores/chat', () => ({ useChatStore: () => chatMock }))

const sessionMock = vi.hoisted(() => ({
  list: [] as Array<{ id: string; status: string }>,
}))
vi.mock('@/stores/session', () => ({ useSessionStore: () => sessionMock }))

vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ state: ref('idle'), isActive: ref(false) }),
}))

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

vi.mock('@/composables/useExtensionUI', () => ({
  useExtensionUI: () => ({
    currentFormRequest: { value: undefined as unknown },
    respond: vi.fn(),
    cancel: vi.fn(),
  }),
  formFilter: () => true,
}))

const MessageStreamStub = defineComponent({
  name: 'MessageStream',
  render: () => h('div', { 'data-testid': 'message-stream-stub' }),
})

function mountPanel(sessionId: string) {
  return mount(Panel, {
    props: { panelId: 'p1', sessionId, sessionDir: '/tmp/x' },
    global: {
      plugins: [createPinia()],
      stubs: { MessageStream: MessageStreamStub, Composer: true, Landing: true, FormOverlay: true },
    },
  })
}

/** 捕获 core 侧注册的丢帧回调。 */
let dropCallback: ((info: InboundFrameDroppedInfo) => void) | null = null

function fireDrop(overrides: Partial<InboundFrameDroppedInfo> = {}): void {
  expect(dropCallback, 'installInboundFrameGuard 应先绑定 onInboundFrameDropped').toBeTypeOf('function')
  dropCallback?.({
    sessionId: 's1',
    frameSize: 42_000_001,
    kind: 'text',
    valveTripped: true,
    sessionDropCount: 3,
    ...overrides,
  })
}

let panel: ReturnType<typeof usePanelStore>

beforeEach(() => {
  _resetInboundFrameGuardForTest()
  dropCallback = null
  coreMock.onInboundFrameDropped.mockReset()
  coreMock.retryInboundDroppedSession.mockReset().mockReturnValue(false)
  coreMock.subscribeSession.mockReset().mockResolvedValue(undefined)
  reportMock.mockReset()
  coreMock.onInboundFrameDropped.mockImplementation((cb: (info: InboundFrameDroppedInfo) => void) => {
    dropCallback = cb
    return () => {
      if (dropCallback === cb) dropCallback = null
    }
  })
  chatMock.getMessages.mockReturnValue([])
  chatMock.failedHistory.clear()
  sessionMock.list = []
  setActivePinia(createPinia())
  panel = usePanelStore()
})

afterEach(() => {
  _resetInboundFrameGuardForTest()
})

describe('Panel 承接入站丢帧终止阀提示（D8 挂载点闭环）', () => {
  it('安装守卫 + 丢帧触发终止阀 → Panel 会话视图内提示条可见（composer-band 同区），非 tripped session 不渲染', async () => {
    installInboundFrameGuard() // App 装配层等价动作
    fireDrop({ sessionId: 's1' })
    expect(isInboundSessionTripped('s1')).toBe(true)

    const wrapper = mountPanel('s1')
    await nextTick()
    const notice = wrapper.find('[data-testid="inbound-frame-dropped-notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.attributes('role')).toBe('alert')
    expect(wrapper.find('[data-testid="inbound-frame-dropped-title"]').text()).toBe('本会话数据流已暂停')
    // 挂载点在 composer band（与 respawnPending 过渡条同区），非对话流内部
    expect(wrapper.find('.composer-band').find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(true)
    wrapper.unmount()

    // 单 session 作用域：别的 session 视图不渲染（不连坐）
    const other = mountPanel('s2')
    await nextTick()
    expect(other.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(false)
    other.unmount()
  })

  it('未触发终止阀（valveTripped=false）→ Panel 不渲染提示条', async () => {
    installInboundFrameGuard()
    fireDrop({ sessionDropCount: 1, valveTripped: false })
    expect(isInboundSessionTripped('s1')).toBe(false)

    const wrapper = mountPanel('s1')
    await nextTick()
    expect(wrapper.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('切走再切回 tripped session → 重试订阅恰好一次、提示条随恢复动作消失', async () => {
    installInboundFrameGuard()
    coreMock.retryInboundDroppedSession.mockReturnValue(true)
    fireDrop({ sessionId: 's1' })

    const wrapper = mountPanel('s1')
    await nextTick()
    expect(wrapper.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(true)

    panel.loadSession(ROOT_PANEL_ID, 's2') // 切走：非 tripped，零动作
    await nextTick()
    expect(coreMock.retryInboundDroppedSession).not.toHaveBeenCalled()

    panel.loadSession(ROOT_PANEL_ID, 's1') // 切回：恢复触发器命中
    await nextTick()
    expect(coreMock.retryInboundDroppedSession).toHaveBeenCalledTimes(1)
    expect(coreMock.retryInboundDroppedSession).toHaveBeenCalledWith('s1')
    expect(coreMock.subscribeSession).toHaveBeenCalledTimes(1) // 重试订阅一次
    await nextTick()
    expect(wrapper.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
