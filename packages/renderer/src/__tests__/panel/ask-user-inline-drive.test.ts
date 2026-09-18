/**
 * Panel inline ask-user 真实 DOM 驱动测试（P-INLINE DOM 层，对齐 schedule-create-inline.test.ts 形态）。
 *
 * ask-user-inline.test.ts 只锁定挂载/互斥（不驱动事件），Panel.vue 的 ask-user 双 handler
 * （onAskUserSubmit / onAskUserCancel）与 overlayBandActive/overlayKind 挂载判据此前零 DOM 驱动
 * 覆盖——本文件按 schedule-create-inline 同模式补齐回归网对称性：
 * - 注入 ask-user pending 请求（isAskUserQuestion 形状）→ AskUserOverlay 挂载，ScheduleCreateOverlay
 *   / Composer 互斥不挂（overlayKind==='ask-user' 分型判据）
 * - 驱动真实 submit（选中选项 → 提交按钮解禁 → 点击）→ respond(requestId, answers) 以正确
 *   requestId 与答案 JSON（与 extension-protocol 解码契约同形）回传
 * - 驱动真实 cancel → cancel(requestId) 回传
 * - allowCancel:false 经 Panel 透传 → cancel 按钮不渲染（prop 接线）
 * - guard 失败兜底：请求队列在渲染后、点击前排空（另一实例已应答的真实竞态）→ handler
 *   安全 no-op（respond/cancel 不调用），flush 后 overlay 卸载、composer 回落
 *
 * mock 策略：vi.mock useExtensionUI（范式同 schedule-create-inline.test.ts），vi.hoisted 状态
 * 每用例设值；overlayReq 由工厂初始化为真实 ref——guard 兜底用例在 mount 后排空队列，依赖
 * ref 失效但 flush 前元素仍在 DOM 的时序驱动「渲染后点击」竞态。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/ask-user-inline-drive.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import Panel from '@/components/panel/Panel.vue'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

// ── vi.hoisted：mock 状态在 vi.mock 工厂执行前就绪，且可在 it 中改值 ──
// overlayReq 由工厂初始化为真实 ref（guard 兜底用例 mount 后改值驱动重渲染）。
const mockState = vi.hoisted(() => ({
  overlayReq: undefined as unknown as import('vue').Ref<ExtensionUIRequest | undefined>,
  respond: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('@/composables/useExtensionUI', async () => {
  const { ref } = await import('vue')
  const currentReq = ref<ExtensionUIRequest | undefined>(undefined)
  mockState.overlayReq = currentReq
  return {
    useExtensionUI: () => ({
      currentAskUserRequest: currentReq,
      respond: mockState.respond,
      cancel: mockState.cancel,
    }),
    askUserFilter: (req: { askUser?: boolean }) => req.askUser === true,
    scheduleCreateFilter: (req: { scheduleCreate?: boolean }) => req.scheduleCreate === true,
    overlayFilter: (req: { askUser?: boolean; scheduleCreate?: boolean }) =>
      req.askUser === true || req.scheduleCreate === true,
  }
})

// stub 子组件（AskUserOverlay / ScheduleCreateOverlay 真实挂载，断言其形态）
const stubs = {
  PanelHeader: { template: '<div />' },
  MessageStream: { template: '<div data-testid="msg-stream" />' },
  Composer: { template: '<div data-testid="composer-box" />' },
  Landing: { template: '<div data-testid="landing">landing</div>' },
}

function mountPanel(sessionId: string | null) {
  return mount(Panel, {
    props: {
      panelId: 'panel-root',
      sessionId,
      sessionDir: '/repo',
    },
    global: { stubs },
  })
}

/** isAskUserQuestion 形状的 pending 请求（header 作 answers key，与解码契约同形） */
const askUserReq: ExtensionUIRequest = {
  sessionId: 'session-A',
  requestId: 'req-ask',
  method: 'select',
  askUser: true,
  askUserQuestions: [{ header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockState.overlayReq.value = undefined
  mockState.respond.mockClear()
  mockState.cancel.mockClear()
})

describe('Panel ask-user 挂载判据（overlayKind 分型互斥）', () => {
  it('ask-user 请求 → AskUserOverlay 挂载，ScheduleCreateOverlay / Composer 互斥不挂', () => {
    mockState.overlayReq.value = askUserReq

    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="schedule-create-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
    // 未作答：提交按钮禁用（allAnswered 守卫的用户可见形态）
    expect(wrapper.find('[data-testid="ask-user-submit"]').attributes('disabled')).toBeDefined()
  })

  it('allowCancel:false 经 Panel 透传 → cancel 按钮不渲染（prop 接线），submit 仍在', () => {
    mockState.overlayReq.value = { ...askUserReq, allowCancel: false }

    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ask-user-cancel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ask-user-submit"]').exists()).toBe(true)
  })
})

describe('Panel ask-user 双 handler 真实 DOM 驱动（respond/cancel 按 requestId 回传）', () => {
  it('submit 驱动：选中选项 → respond(requestId, answers) 以正确 requestId 与答案 JSON 回传', async () => {
    mockState.overlayReq.value = askUserReq
    const wrapper = mountPanel('session-A')

    // 用户选中 Postgres：选项卡 aria-checked 翻转（用户可见选中态），提交按钮解禁
    await wrapper.find('[data-testid="ask-user-option-Postgres"]').trigger('click')
    expect(
      wrapper.find('[data-testid="ask-user-option-Postgres"]').attributes('aria-checked'),
    ).toBe('true')
    expect(wrapper.find('[data-testid="ask-user-submit"]').attributes('disabled')).toBeUndefined()

    // 提交 → Panel handler → respond(req.requestId, answers)
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')
    expect(mockState.respond).toHaveBeenCalledTimes(1)
    expect(mockState.cancel).not.toHaveBeenCalled()
    const [reqId, answers] = mockState.respond.mock.calls[0] as [string, string]
    expect(reqId).toBe('req-ask')
    // 单选答案编码：主 key = header，值 = 选中项 label（与 extension-protocol 解码契约同形）
    expect(JSON.parse(answers)).toEqual({ db: 'Postgres' })
  })

  it('cancel 驱动：点击取消 → cancel(requestId) 以正确 requestId 回传，respond 不调用', async () => {
    mockState.overlayReq.value = askUserReq
    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="ask-user-cancel"]').exists()).toBe(true)
    await wrapper.find('[data-testid="ask-user-cancel"]').trigger('click')

    expect(mockState.cancel).toHaveBeenCalledTimes(1)
    expect(mockState.cancel).toHaveBeenCalledWith('req-ask')
    expect(mockState.respond).not.toHaveBeenCalled()
  })
})

describe('guard 失败兜底（队列排空竞态：渲染后点击 → handler 安全 no-op）', () => {
  it('submit 路径：请求排空后点击提交 → respond 不调用，overlay 卸载 composer 回落', async () => {
    mockState.overlayReq.value = askUserReq
    const wrapper = mountPanel('session-A')
    // 先作答，让 submit 处于可点击态（绕开 allAnswered 禁用，直达 handler guard）
    await wrapper.find('[data-testid="ask-user-option-Postgres"]').trigger('click')

    // 排空队列（另一实例已应答）但 nextTick flush 前元素仍在 DOM ——「渲染后点击」竞态
    mockState.overlayReq.value = undefined
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')

    // guard（!req return）兜底：不向 select 通道回传幻影应答
    expect(mockState.respond).not.toHaveBeenCalled()
    // flush 后 overlay 卸载，composer 回落（band 恢复常态）
    await nextTick()
    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
  })

  it('cancel 路径：请求排空后点击取消 → cancel 不调用，overlay 卸载 composer 回落', async () => {
    mockState.overlayReq.value = askUserReq
    const wrapper = mountPanel('session-A')

    mockState.overlayReq.value = undefined
    await wrapper.find('[data-testid="ask-user-cancel"]').trigger('click')

    expect(mockState.cancel).not.toHaveBeenCalled()
    expect(mockState.respond).not.toHaveBeenCalled()
    await nextTick()
    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
  })
})
