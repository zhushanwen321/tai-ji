/**
 * Panel inline schedule-create 分流挂载测试（schedule-create-confirm-modal U6，P-INLINE DOM 层）。
 *
 * Panel 的 overlay 挂载判据收敛在 core derivePanelView（input==='ask-user' 布尔语义已扩为
 * 富交互 overlay：ask-user ∨ schedule-create），组件层按请求标记分流挂载。锁定：
 * - schedule-create 请求 → ScheduleCreateOverlay 挂载，AskUserOverlay / Composer 互斥不挂
 * - askUser 请求 → AskUserOverlay 挂载，ScheduleCreateOverlay 不挂（V7 回归：ask-user 行为零变更）
 * - draft 形状非法（isScheduleDraft 守卫失败）→ 不挂 ScheduleCreateOverlay（正常路径不可达，
 *   runtime event-adapter 同守卫预检；防御分支回落 composer）
 * - schedule-create 确认等待期 turn 活跃 → store 豁免 getter 语义锁定（hasPendingBlockingOverlay
 *   扩义覆盖 schedule-create；消费方 ② 的警示条 UI 已随 remove-turn-progress-bar 移除，
 *   getter 仍是 deriveStatus waiting 状态点的判定源）
 * - submit/cancel 经 respond/cancel 回传 select 通道
 * - 排队接管序列（P-INLINE DOM 层）：同 session 先后到达 ask-user 与 schedule-create →
 *   先到者挂载 → respond/cancel 出队 → 后到者接管挂载（两方向各一）
 * - cron 预览与提交解耦：前端解析子集（支持 5/6 段 + 周域英文名）解析失败仅非阻塞警示，
 *   不拦合法草稿提交（G1 预填草稿可直接确认；once 未选时刻仍拦 = 未补全非预览失败）
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
import { useChatStore } from '@/stores/chat'
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

// stub 子组件（AskUserOverlay / ScheduleCreateOverlay 真实挂载，断言其形态；TurnProgressBar 已随 remove-turn-progress-bar 移除）
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

const scheduleCreateReq: ExtensionUIRequest = {
  sessionId: 'session-A',
  requestId: 'req-sc',
  method: 'select',
  scheduleCreate: true,
  scheduleDraft,
}

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

describe('Panel overlay 分流挂载（schedule-create ∨ ask-user 互斥）', () => {
  it('schedule-create 请求 → ScheduleCreateOverlay 挂载，AskUserOverlay / Composer 不挂', () => {
    mockState.overlayReq.value = scheduleCreateReq

    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="schedule-create-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
    // 预填草稿进面板：模型列表渲染 draft.models，当前会话模型带标记
    expect(wrapper.find('[data-testid="schedule-create-model-m-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="schedule-create-model-m-2"]').exists()).toBe(true)
  })

  it('askUser 请求 → AskUserOverlay 挂载，ScheduleCreateOverlay 不挂（V7：ask-user 零回归 + 互斥反向）', () => {
    mockState.overlayReq.value = askUserReq

    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="schedule-create-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })

  it('draft 形状非法（守卫失败）→ 不挂 ScheduleCreateOverlay，Composer 兜底', () => {
    mockState.overlayReq.value = { ...scheduleCreateReq, scheduleDraft: { kind: 'bogus' } }

    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="schedule-create-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
  })

  it('submit 回传 FormResult JSON（respond 按 requestId）；cancel 等价 respond null', async () => {
    mockState.overlayReq.value = scheduleCreateReq
    const wrapper = mountPanel('session-A')

    await wrapper.find('[data-testid="schedule-create-cancel"]').trigger('click')
    expect(mockState.cancel).toHaveBeenCalledWith('req-sc')

    // 预填草稿可直接提交（recurring + cron + prompt 非空 + 模型预选）
    await wrapper.find('[data-testid="schedule-create-submit"]').trigger('click')
    expect(mockState.respond).toHaveBeenCalledTimes(1)
    const [reqId, result] = mockState.respond.mock.calls[0] as [string, string]
    expect(reqId).toBe('req-sc')
    const parsed = JSON.parse(result) as Record<string, unknown>
    expect(parsed).toMatchObject({ action: 'create', kind: 'recurring', schedule: '0 9 * * *', prompt: '总结昨天的工作进展' })
  })

  it('三消费方②：schedule-create 等待期 → store 豁免 getter 语义锁定（hasPendingBlockingOverlay 扩义）', async () => {
    // TurnProgressBar UI 已随 remove-turn-progress-bar 移除；豁免语义收敛为 store getter——
    // 扩义（askUser ∨ scheduleCreate）锁定在此，消费方 = deriveStatus waiting 状态点判定
    mockState.overlayReq.value = scheduleCreateReq
    const wrapper = mountPanel('session-A')
    const extensionUI = useExtensionUIStore()
    extensionUI.addRequest('session-A', {
      sessionId: 'session-A', requestId: 'req-sc', method: 'select', scheduleCreate: true, receivedAt: Date.now(),
    })
    await nextTick()

    // schedule-create 等待期 getter 必为 true（扩义漏接则 waiting 状态点判定失真）
    expect(extensionUI.hasPendingBlockingOverlay('session-A')).toBe(true)
    // overlay 渲染、Composer 隐藏（等待期解释价值由 ScheduleCreateOverlay 在屏承接）
    expect(wrapper.find('[data-testid="schedule-create-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })
})

describe('P-INLINE 排队接管序列（DOM 层：先到先渲染 → 出队 → 后到接管）', () => {
  it('ask-user 先到挂载 → respond 出队 → 后到 schedule-create 接管挂载', async () => {
    mockState.overlayReq.value = askUserReq
    const wrapper = mountPanel('session-A')

    // 先到者渲染
    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="schedule-create-overlay"]').exists()).toBe(false)

    // 模拟应答出队（Panel 应答入口 = useExtensionUI.respond）+ store 队首推进到后到请求
    mockState.respond('req-ask', '["Postgres"]')
    mockState.overlayReq.value = scheduleCreateReq
    await nextTick()

    // 后到者接管：互斥换挂，Composer 仍被 overlay 覆盖
    expect(mockState.respond).toHaveBeenCalledWith('req-ask', '["Postgres"]')
    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="schedule-create-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })

  it('schedule-create 先到挂载 → cancel 出队 → 后到 ask-user 接管挂载', async () => {
    mockState.overlayReq.value = scheduleCreateReq
    const wrapper = mountPanel('session-A')

    expect(wrapper.find('[data-testid="schedule-create-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(false)

    // 真实 DOM 取消（emit cancel → Panel handler → useExtensionUI.cancel）+ 队首推进
    await wrapper.find('[data-testid="schedule-create-cancel"]').trigger('click')
    expect(mockState.cancel).toHaveBeenCalledWith('req-sc')
    mockState.overlayReq.value = askUserReq
    await nextTick()

    expect(wrapper.find('[data-testid="schedule-create-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })
})

// 「cron 预览与提交解耦」组件行为用例（周域英文名 / 6 段含秒 / 非法表达式 / once 清空 /
// once 已过拦截 + 提交复核，8e2a1b06f）已等价迁移为组件级测试
// src/__tests__/components/extension/ScheduleForm.test.ts（u3 统一表单协议迁移；
// 本文件保留 Panel 分流挂载/排队接管/豁免 getter 断言，随 u4 接线改造）。

