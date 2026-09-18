/**
 * Panel inline schedule-create 分流挂载测试（schedule-create-confirm-modal U6，P-INLINE DOM 层）。
 *
 * Panel 的 overlay 挂载判据收敛在 core derivePanelView（input==='ask-user' 布尔语义已扩为
 * 富交互 overlay：ask-user ∨ schedule-create），组件层按请求标记分流挂载。锁定：
 * - schedule-create 请求 → ScheduleCreateOverlay 挂载，AskUserOverlay / Composer 互斥不挂
 * - askUser 请求 → AskUserOverlay 挂载，ScheduleCreateOverlay 不挂（V7 回归：ask-user 行为零变更）
 * - draft 形状非法（isScheduleDraft 守卫失败）→ 不挂 ScheduleCreateOverlay（正常路径不可达，
 *   runtime event-adapter 同守卫预检；防御分支回落 composer）
 * - schedule-create 确认等待期 turn 活跃 → 警示条不渲染（TurnProgressBar 豁免经 store getter
 *   扩义联动，消费方 ②；漏接则等待超 10min 被误挂超时警示 + abort 入口）
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
import { TURN_PROGRESS_WARN_THRESHOLD_MS } from '@taiji/core'
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

// stub 子组件（AskUserOverlay / ScheduleCreateOverlay / TurnProgressBar 真实挂载，断言其形态）
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

  it('三消费方②：schedule-create 等待期 turn 活跃 → 跨警示阈值警示条不渲染（豁免联动）', async () => {
    vi.useFakeTimers()
    try {
      mockState.overlayReq.value = scheduleCreateReq
      const wrapper = mountPanel('session-A')
      // TurnProgressBar 读真实 chat/extension-ui store（Panel overlay 判据走 mock，两处数据源分别喂
      // ——生产运行时同源：useExtensionUI 写 store）
      const store = useChatStore()
      const extensionUI = useExtensionUIStore()
      store.setOccupancy('session-A', { turn: 'generating', compacting: false, bash: false })
      store.applyMessageEvent('session-A', { type: 'message.message_start', payload: { sessionId: 'session-A', messageId: 'a1' } })
      extensionUI.addRequest('session-A', {
        sessionId: 'session-A', requestId: 'req-sc', method: 'select', scheduleCreate: true, receivedAt: Date.now(),
      })
      await nextTick()
      // 跨过警示阈值：schedule-create 等待期 warn 被 core 抑制（getter 扩义联动），警示条不渲染
      vi.advanceTimersByTime(TURN_PROGRESS_WARN_THRESHOLD_MS + 1_000)
      await nextTick()

      expect(wrapper.find('[data-testid="turn-progress-bar"]').exists()).toBe(false)
      // overlay 仍渲染、Composer 仍隐藏（等待期解释价值由 ScheduleCreateOverlay 在屏承接）
      expect(wrapper.find('[data-testid="schedule-create-overlay"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
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

describe('cron 预览与提交解耦（前端解析子集不拦合法草稿，G1）', () => {
  const draftReqWithSchedule = (schedule: string, kind: 'once' | 'recurring' = 'recurring'): ExtensionUIRequest => ({
    sessionId: 'session-A',
    requestId: 'req-sc',
    method: 'select',
    scheduleCreate: true,
    scheduleDraft: { ...scheduleDraft, kind, schedule },
  })

  function assertSubmittable(wrapper: ReturnType<typeof mountPanel>): void {
    expect(
      wrapper.find('[data-testid="schedule-create-submit"]').attributes('disabled'),
    ).toBeUndefined()
  }

  it('周域英文名 draft（0 9 * * MON）→ 预览命中、可直接提交且 schedule 原样回传', async () => {
    mockState.overlayReq.value = draftReqWithSchedule('0 9 * * MON')
    const wrapper = mountPanel('session-A')

    // 预览解析成功（英文名域映射数字后命中）：显示下次运行列表，无警示
    const previewText = wrapper.find('[data-testid="schedule-create-preview"]').text()
    expect(previewText).toContain('下次运行')
    expect(previewText).not.toContain('无法预览')
    assertSubmittable(wrapper)

    await wrapper.find('[data-testid="schedule-create-submit"]').trigger('click')
    expect(mockState.respond).toHaveBeenCalledTimes(1)
    const [, result] = mockState.respond.mock.calls[0] as [string, string]
    expect(JSON.parse(result)).toMatchObject({ action: 'create', kind: 'recurring', schedule: '0 9 * * MON' })
  })

  it('6 段含秒 draft（0 0 9 * * *）→ 跳过秒段预览命中、可直接提交且表达式原样回传', async () => {
    mockState.overlayReq.value = draftReqWithSchedule('0 0 9 * * *')
    const wrapper = mountPanel('session-A')

    const previewText = wrapper.find('[data-testid="schedule-create-preview"]').text()
    expect(previewText).toContain('下次运行')
    expect(previewText).not.toContain('无法预览')
    assertSubmittable(wrapper)

    await wrapper.find('[data-testid="schedule-create-submit"]').trigger('click')
    const [, result] = mockState.respond.mock.calls[0] as [string, string]
    expect(JSON.parse(result)).toMatchObject({ schedule: '0 0 9 * * *' })
  })

  it('真非法表达式 → 非阻塞警示（表达式由创建端验证）且仍可提交（由后端拒）', async () => {
    mockState.overlayReq.value = draftReqWithSchedule('nonsense expr here')
    const wrapper = mountPanel('session-A')

    // 预览失败：非阻塞警示文案（zh locale），但不拦提交（canSubmit 与预览解耦）
    expect(wrapper.find('[data-testid="schedule-create-preview"]').text())
      .toContain('无法预览：表达式将由创建端验证')
    assertSubmittable(wrapper)

    await wrapper.find('[data-testid="schedule-create-submit"]').trigger('click')
    expect(mockState.respond).toHaveBeenCalledTimes(1)
    const [, result] = mockState.respond.mock.calls[0] as [string, string]
    expect(JSON.parse(result)).toMatchObject({ schedule: 'nonsense expr here' })
  })

  it('once 清空时刻后禁止提交（未补全非预览失败；预览区提示选择时刻，重选后恢复）', async () => {
    // onceCronToDate 还原失败（周域非 *）→ 组件既有行为落默认下一整点（草稿可直接确认，G1）
    mockState.overlayReq.value = draftReqWithSchedule('0 9 * * MON', 'once')
    const wrapper = mountPanel('session-A')
    assertSubmittable(wrapper)

    // 用户清空时刻 = 未补全：once 提交体需要时间值，仍拦（区别于 recurring 预览失败）
    await wrapper.find('[data-testid="schedule-create-once-input"]').setValue('')
    await nextTick()
    expect(wrapper.find('[data-testid="schedule-create-preview"]').text()).toContain('请选择执行时间')
    expect(
      wrapper.find('[data-testid="schedule-create-submit"]').attributes('disabled'),
    ).toBeDefined()

    // 重新选定时刻 → 恢复可提交
    await wrapper.find('[data-testid="schedule-create-once-input"]').setValue('2030-01-01T09:00')
    await nextTick()
    assertSubmittable(wrapper)
  })
})
