/**
 * Panel inline legacy scheduler 帧 draft 直挂源测试（u4 接线版——FormOverlay 单渲染器，
 * D7 上三角「新 taiji + 旧 npm scheduler」兼容路径）。
 *
 * legacy scheduleCreate 帧（SCHEDULE_CREATE_MARKER 广播）经 useExtensionUI 归一附加 form 键
 * 后命中统一判定面，Panel 按挂载源键分流 FormOverlay 的 draft props（应答 = 扁平
 * ScheduleFormResult JSON，今日 Panel onScheduleCreateSubmit 路径等价）。锁定：
 * - legacy scheduler 帧 → FormOverlay（draft 直挂）挂载，Composer 互斥不挂
 * - form 帧与 legacy scheduler 帧互斥分流（questions / draft 两源）
 * - draft 形状非法（isScheduleDraft 守卫失败）→ 不挂 overlay（正常路径不可达，
 *   runtime event-adapter 同守卫预检；防御分支回落 composer）
 * - scheduler 确认等待期 store 豁免 getter 语义锁定（hasPendingBlockingOverlay 按 form 键）
 * - submit/cancel 经 respond/cancel 回传 select 通道（扁平 FormResult / null）
 * - 排队接管序列（DOM 层）：同 session 先后到达两类帧 → 先到者挂载 → respond/cancel
 *   出队 → 后到者接管挂载（两方向各一）
 *
 * mock 策略：vi.mock useExtensionUI（范式同 ask-user-inline.test.ts），vi.hoisted 状态每用例设值。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/schedule-create-inline.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import Panel from '@/components/panel/Panel.vue'
import { useExtensionUIStore } from '@/stores/extension-ui'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

// ── vi.hoisted：mock 状态在 vi.mock 工厂执行前就绪，且可在 it 中改值 ──
// overlayReq 由工厂初始化为真实 ref：排队接管序列用例在 mount 后推进队列（出队 → 后到者
// 接管），依赖 ref 响应性驱动 Panel 重渲染（plain object 无响应性，仅 mount 前设值可行）。
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
  method: 'select',
  form: true,
  scheduleCreate: true,
  scheduleDraft,
}

/** form 帧造数（questions 源） */
const formReq: ExtensionUIRequest = {
  sessionId: 'session-A',
  requestId: 'req-ask',
  method: 'select',
  form: true,
  formQuestions: [{ type: 'choice', header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockState.overlayReq.value = undefined
  mockState.respond.mockClear()
  mockState.cancel.mockClear()
})

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

  it('draft 形状非法（守卫失败）→ 不挂 FormOverlay，Composer 兜底', () => {
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
      sessionId: 'session-A', requestId: 'req-sc', method: 'select', form: true, receivedAt: Date.now(),
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
