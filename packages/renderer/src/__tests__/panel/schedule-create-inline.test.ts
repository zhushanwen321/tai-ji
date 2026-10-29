/**
 * Panel inline 统一表单合并测试（单文件多源合并：2 个源文件同 SUT（Panel.vue overlay 分流）、
 * 同款 useExtensionUI mock 工厂、同构 stubs / mountPanel / beforeEach）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——单文件让全部用例共享一份 Panel + FormOverlay
 * 组件树装载与环境初始化；拆文件会让每个文件各付一次装载，合并后只装一份。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动）：
 *  - schedule-create-inline.test.ts（legacy scheduler 帧 draft 直挂源 + 排队接管序列）
 *  - ask-user-inline-drive.test.ts（questions 源真实 DOM 驱动应答链路）
 *
 * 两源 mockState / stubs / mountPanel / formReq / beforeEach 逐字同构，合并为单份共享声明；
 * 未并入同簇的 composer-btw-button / session-active-state：其与这两源在 @/stores/session、
 * useNewTaskFlow、useChat 上 mock 形态互为相反（实质冲突），保持独立文件。
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=panel npx vitest run src/__tests__/panel/schedule-create-inline.test.ts（本文件登记在 domain-map.json panel 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import Panel from '@/components/panel/Panel.vue'
import { useExtensionUIStore } from '@/stores/extension-ui'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

// ── vi.hoisted：mock 状态在 vi.mock 工厂执行前就绪，且可在 it 中改值 ──
// overlayReq 由工厂初始化为真实 ref：排队接管 / guard 兜底用例在 mount 后推进队列（出队 →
// 后到者接管 / 排空竞态），依赖 ref 响应性驱动 Panel 重渲染（plain object 无响应性）。
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
      currentFormRequest: currentReq,
      respond: mockState.respond,
      cancel: mockState.cancel,
    }),
    formFilter: (req: { form?: boolean }) => req.form === true,
    // PanelModeBar（Panel composer 上方常驻挂载）setup 消费 planReviewFilter——窄 mock 需补齐该导出清单
    planReviewFilter: (req: { planReview?: boolean }) => req.planReview === true,
  }
})

// stub 子组件（FormOverlay 真实挂载，断言其形态）
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

/** form 帧 questions 源造数（legacy askUser 帧经归一后同形——formQuestions 推断产物；两源共用） */
const formReq: ExtensionUIRequest = {
  sessionId: 'session-A',
  requestId: 'req-ask',
  dialogKind: 'select',
  form: true,
  formQuestions: [{ type: 'choice', header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockState.overlayReq.value = undefined
  mockState.respond.mockClear()
  mockState.cancel.mockClear()
})

// ══════════ 来源：schedule-create-inline.test.ts ══════════

const scheduleDraft = {
  kind: 'recurring',
  schedule: '0 9 * * *',
  prompt: '总结昨天的工作进展',
  models: ['m-1', 'm-2'],
  currentModel: 'm-1',
}

/** legacy scheduler 帧归一后入 store 的记录形状（scheduleCreate/scheduleDraft 原键 + form 附加） */
const scheduleCreateReq: ExtensionUIRequest = {
  sessionId: 'session-A',
  requestId: 'req-sc',
  dialogKind: 'select',
  form: true,
  scheduleCreate: true,
  scheduleDraft,
}

describe('Panel overlay 挂载源分流（draft 源 ∨ questions 源互斥）', () => {
  it('legacy scheduler 帧 → FormOverlay（draft 直挂）挂载，Composer 不挂；预填草稿进面板', () => {
    mockState.overlayReq.value = scheduleCreateReq

    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
    // 预填草稿进面板：模型列表渲染 draft.models，当前会话模型带标记
    expect(wrapper.find('[data-testid="schedule-create-model-m-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="schedule-create-model-m-2"]').exists()).toBe(true)
  })

  it('form 帧（questions 源）→ FormOverlay 挂载渲染问题选项（两源同一渲染器）', () => {
    mockState.overlayReq.value = formReq

    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="form-option-Postgres"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })

  it('draft 形状非法（检查失败）→ 不挂 FormOverlay，Composer 兜底', () => {
    mockState.overlayReq.value = { ...scheduleCreateReq, scheduleDraft: { kind: 'bogus' } }

    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
  })

  it('draft 源 submit 回传扁平 FormResult JSON（respond 按 requestId）；cancel 等价 respond null', async () => {
    mockState.overlayReq.value = scheduleCreateReq
    const wrapper = mountPanel('session-A')

    // 取消按钮在 FormOverlay 壳（draft 源 allowCancel 默认 true）
    await wrapper.find('[data-testid="form-cancel"]').trigger('click')
    expect(mockState.cancel).toHaveBeenCalledWith('req-sc')

    // 预填草稿可直接提交（recurring + cron + prompt 非空 + 模型预选；Submit 门 = canSubmit 委托）
    mockState.cancel.mockClear()
    await wrapper.find('[data-testid="form-submit"]').trigger('click')
    expect(mockState.respond).toHaveBeenCalledTimes(1)
    const [reqId, result] = mockState.respond.mock.calls[0] as [string, string]
    expect(reqId).toBe('req-sc')
    const parsed = JSON.parse(result) as Record<string, unknown>
    expect(parsed).toMatchObject({ action: 'create', kind: 'recurring', schedule: '0 9 * * *', prompt: '总结昨天的工作进展' })
  })

  it('三消费方②：scheduler 确认等待期 → store 豁免 getter 语义锁定（hasPendingBlockingOverlay 按 form 键）', async () => {
    // 豁免语义收敛为 store getter——form 键判定锁定在此，消费方 = deriveStatus waiting 状态点判定
    mockState.overlayReq.value = scheduleCreateReq
    const wrapper = mountPanel('session-A')
    const extensionUI = useExtensionUIStore()
    extensionUI.addRequest('session-A', {
      sessionId: 'session-A', requestId: 'req-sc', dialogKind: 'select', form: true, receivedAt: Date.now(),
    })
    await nextTick()

    // scheduler 确认等待期 getter 必为 true（漏接则 waiting 状态点判定失真）
    expect(extensionUI.hasPendingBlockingOverlay('session-A')).toBe(true)
    // overlay 渲染、Composer 隐藏（等待期解释价值由 FormOverlay 在屏承接）
    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })
})

describe('P-INLINE 排队接管序列（DOM 层：先到先渲染 → 出队 → 后到接管）', () => {
  it('questions 源先到挂载 → respond 出队 → 后到 draft 源接管挂载', async () => {
    mockState.overlayReq.value = formReq
    const wrapper = mountPanel('session-A')

    // 先到者渲染
    expect(wrapper.find('[data-testid="form-option-Postgres"]').exists()).toBe(true)

    // 模拟应答出队（Panel 应答入口 = useExtensionUI.respond）+ store 队首推进到后到请求
    mockState.respond('req-ask', '["Postgres"]')
    mockState.overlayReq.value = scheduleCreateReq
    await nextTick()

    // 后到者接管：互斥换挂（draft 源表单），Composer 仍被 overlay 覆盖
    expect(mockState.respond).toHaveBeenCalledWith('req-ask', '["Postgres"]')
    expect(wrapper.find('[data-testid="form-option-Postgres"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="schedule-create-model-m-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })

  it('draft 源先到挂载 → cancel 出队 → 后到 questions 源接管挂载', async () => {
    mockState.overlayReq.value = scheduleCreateReq
    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="schedule-create-model-m-1"]').exists()).toBe(true)

    // 真实 DOM 取消（FormOverlay 壳取消按钮 → Panel handler → useExtensionUI.cancel）+ 队首推进
    await wrapper.find('[data-testid="form-cancel"]').trigger('click')
    expect(mockState.cancel).toHaveBeenCalledWith('req-sc')
    mockState.overlayReq.value = formReq
    await nextTick()

    expect(wrapper.find('[data-testid="schedule-create-model-m-1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="form-option-Postgres"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })
})

// 「cron 预览与提交解耦」组件行为用例（周域英文名 / 6 段含秒 / 非法表达式 / once 清空 /
// once 已过拦截 + 提交复核，8e2a1b06f）已等价迁移为组件级测试
// src/__tests__/components/extension/ScheduleForm.test.ts（u3 统一表单协议迁移）。

// ══════════ 来源：ask-user-inline-drive.test.ts ══════════

describe('Panel 统一表单挂载判据（questions 源）', () => {
  it('表单请求 → FormOverlay 挂载，Composer 互斥不挂', () => {
    mockState.overlayReq.value = formReq

    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
    // 未作答：提交按钮禁用（allAnswered 检查的用户可见形态）
    expect(wrapper.find('[data-testid="form-submit"]').attributes('disabled')).toBeDefined()
  })

  it('allowCancel:false 经 Panel 透传 → cancel 按钮不渲染（prop 接线），submit 仍在', () => {
    mockState.overlayReq.value = { ...formReq, allowCancel: false }

    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="form-cancel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="form-submit"]').exists()).toBe(true)
  })
})

describe('Panel 统一表单双 handler 真实 DOM 驱动（respond/cancel 按 requestId 回传）', () => {
  it('submit 驱动：选中选项 → respond(requestId, answers) 以正确 requestId 与 envelope JSON 回传', async () => {
    mockState.overlayReq.value = formReq
    const wrapper = mountPanel('session-A')

    // 用户选中 Postgres：选项卡 aria-checked 翻转（用户可见选中态），提交按钮解禁
    await wrapper.find('[data-testid="form-option-Postgres"]').trigger('click')
    expect(
      wrapper.find('[data-testid="form-option-Postgres"]').attributes('aria-checked'),
    ).toBe('true')
    expect(wrapper.find('[data-testid="form-submit"]').attributes('disabled')).toBeUndefined()

    // 提交 → Panel handler → respond(req.requestId, answers envelope)
    await wrapper.find('[data-testid="form-submit"]').trigger('click')
    expect(mockState.respond).toHaveBeenCalledTimes(1)
    expect(mockState.cancel).not.toHaveBeenCalled()
    const [reqId, answers] = mockState.respond.mock.calls[0] as [string, string]
    expect(reqId).toBe('req-ask')
    // FormAnswers envelope 编码：主 key = header，值 = 选中项 label（与 extension-protocol 解码契约同形）
    expect(JSON.parse(answers)).toEqual({ db: 'Postgres' })
  })

  it('cancel 驱动：点击取消 → cancel(requestId) 以正确 requestId 回传，respond 不调用', async () => {
    mockState.overlayReq.value = formReq
    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="form-cancel"]').exists()).toBe(true)
    await wrapper.find('[data-testid="form-cancel"]').trigger('click')

    expect(mockState.cancel).toHaveBeenCalledTimes(1)
    expect(mockState.cancel).toHaveBeenCalledWith('req-ask')
    expect(mockState.respond).not.toHaveBeenCalled()
  })
})

describe('guard 失败兜底（队列排空竞态：渲染后点击 → handler 安全 no-op）', () => {
  it('submit 路径：请求排空后点击提交 → respond 不调用，overlay 卸载 composer 回落', async () => {
    mockState.overlayReq.value = formReq
    const wrapper = mountPanel('session-A')
    // 先作答，让 submit 处于可点击态（绕开 allAnswered 禁用，直达 handler guard）
    await wrapper.find('[data-testid="form-option-Postgres"]').trigger('click')

    // 排空队列（另一实例已应答）但 nextTick flush 前元素仍在 DOM ——「渲染后点击」竞态
    mockState.overlayReq.value = undefined
    await wrapper.find('[data-testid="form-submit"]').trigger('click')

    // guard（!req return）兜底：不向 select 通道回传幻影应答
    expect(mockState.respond).not.toHaveBeenCalled()
    // flush 后 overlay 卸载，composer 回落（band 恢复常态）
    await nextTick()
    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
  })

  it('cancel 路径：请求排空后点击取消 → cancel 不调用，overlay 卸载 composer 回落', async () => {
    mockState.overlayReq.value = formReq
    const wrapper = mountPanel('session-A')

    mockState.overlayReq.value = undefined
    await wrapper.find('[data-testid="form-cancel"]').trigger('click')

    expect(mockState.cancel).not.toHaveBeenCalled()
    expect(mockState.respond).not.toHaveBeenCalled()
    await nextTick()
    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
  })
})
