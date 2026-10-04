// 移动壳 form/planReview 类请求链装配（remote-use D7 form 行恢复：消除「请求方无限等待」）。
//
// 链路锁定：bus 'ui-request'（companion-bridge 模块级 form 通道，C4 门排除出 CompanionBand
// 的富交互面）→ App 聊天视图 MobileFormCard 渲染 → 作答 → sendExtensionUIResponse 回传
// （extension.ui_response 既有通路，method 透传）→ 卡片出队收口。
//
// 装配 + 通道一体断言（桌面同构语义锚定 useExtensionUI.test.ts / use-extension-ui-* 测试族）；
// 协议编码纯逻辑契约在 form-protocol.test.ts。断连重连快照对账（connected 边沿
// reconcileNow 补拉）与回传失败内联错误行（respondFailedId prop，组件级断言独立 describe）
// 同文件覆盖。
//
// mock 策略：extension 域（sendExtensionUIResponse/getPendingRequests）模块级 vi.mock
// 隔离 WS（断言回传参数与送达布尔）；请求注入经 __testing.mobileExtensionBus.emit
// （生产订阅面 = form 通道 bus 订阅）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/mobile-form.spec.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import App from '../App.vue'
import MobileFormCard from '../views/MobileFormCard.vue'
import { i18n } from '../i18n'
import { __testing, useMobileFormRequests } from '../shell/companion-bridge'
import { sessionStore } from '../shell/app-runtime'
import { hasConnectedOnce, shellConnectionState } from '../shell/connection-view'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { mockSendResponse, mockGetPending } = vi.hoisted(() => ({
  mockSendResponse: vi.fn(),
  mockGetPending: vi.fn(),
}))

vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  sendExtensionUIResponse: mockSendResponse,
  getPendingRequests: mockGetPending,
}))

function mountApp() {
  return mount(App, { global: { plugins: [i18n] } })
}

/** 进入聊天视图（connected + hasConnectedOnce + 激活 session + 切 chat tab） */
async function mountChatView(sessionId: string) {
  hasConnectedOnce.value = true
  shellConnectionState.value = 'connected'
  sessionStore.setActiveId(sessionId)
  const wrapper = mountApp()
  await wrapper.get('[data-testid="mobile-tab-chat"]').trigger('click')
  mockGetPending.mockClear()
  return wrapper
}

/** 发一条 bus 归一后的 form 类 ui-request 事件（C4 放行面） */
function emitFormRequest(request: Record<string, unknown>, sessionId = 'sid-form'): void {
  __testing.mobileExtensionBus.emit({
    kind: 'ui-request',
    sessionId,
    request: { requestId: 'req-1', pluginId: '', kind: 'select', ...request },
  })
}

function singleChoiceRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    form: true,
    formQuestions: [
      { type: 'choice', header: 'db', question: '用哪个数据库？', options: [{ label: 'pg' }, { label: 'mysql' }] },
    ],
    ...overrides,
  }
}

describe('移动壳 form 请求链（D7 form 行恢复）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(() => {
    mockSendResponse.mockReset().mockReturnValue(true)
    mockGetPending.mockReset().mockResolvedValue([])
    __testing.resetFormRequestsForTest()
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    __testing.resetFormRequestsForTest()
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  it('form 帧注入 → 表单卡呈现（题干 + 选项卡）+ composer 隐藏；点选提交 → 回传 envelope + 卡收口 + composer 恢复', async () => {
    wrapper = await mountChatView('sid-form')
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)

    emitFormRequest(singleChoiceRequest())
    await nextTick()

    // 使用者视角：表单卡在场，题干与选项逐项渲染
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mobile-form-title"]').text()).toBe('用哪个数据库？')
    expect(wrapper.find('[data-testid="mobile-form-option-pg"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-form-option-mysql"]').exists()).toBe(true)
    // 未答 Submit 禁用；form 请求在场时 composer 隐藏（桌面 overlay 与 composer 互斥同构）
    expect(wrapper.get('[data-testid="mobile-form-submit"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(false)

    await wrapper.get('[data-testid="mobile-form-option-pg"]').trigger('click')
    expect(wrapper.get('[data-testid="mobile-form-submit"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="mobile-form-submit"]').trigger('click')

    expect(mockSendResponse).toHaveBeenCalledTimes(1)
    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-1', 'select', JSON.stringify({ db: 'pg' }))
    // 送达即出队：卡收口 + composer 恢复
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)
  })

  it('文本题输入 → 提交 envelope 走 `${key}__other` 键位（text 题不写主 key，协议键位规则）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest({
      form: true,
      formQuestions: [{ type: 'text', header: 'note', question: '补充说明？' }],
    })
    await nextTick()

    await wrapper.get('[data-testid="mobile-form-text-input-0"]').setValue('补充内容')
    await wrapper.get('[data-testid="mobile-form-submit"]').trigger('click')

    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-1', 'select', JSON.stringify({ note__other: '补充内容' }))
  })

  it('多选提交：envelope 多选序列化为 JSON 数组（label 即选中值）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest({
      form: true,
      formQuestions: [
        { type: 'choice', header: 'feat', question: '要哪些功能？', multi: true, options: [{ label: 'a' }, { label: 'b' }] },
      ],
    })
    await nextTick()

    await wrapper.get('[data-testid="mobile-form-option-a"]').trigger('click')
    await wrapper.get('[data-testid="mobile-form-option-b"]').trigger('click')
    await wrapper.get('[data-testid="mobile-form-submit"]').trigger('click')

    expect(mockSendResponse).toHaveBeenCalledWith(
      'sid-form', 'req-1', 'select',
      JSON.stringify({ feat: JSON.stringify(['a', 'b']) }),
    )
  })

  it('取消 → respond null（select resolve undefined = cancelled 语义，请求方不空等）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(singleChoiceRequest())
    await nextTick()

    await wrapper.get('[data-testid="mobile-form-cancel"]').trigger('click')

    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-1', 'select', null)
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
  })

  it('allowCancel=false：取消键隐藏（协议显式收窄）；未送达（WS 非 OPEN）时卡保留可重试', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(singleChoiceRequest({ allowCancel: false }))
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-cancel"]').exists()).toBe(false)

    mockSendResponse.mockReturnValueOnce(false) // WS 非 OPEN
    await wrapper.get('[data-testid="mobile-form-option-pg"]').trigger('click')
    await wrapper.get('[data-testid="mobile-form-submit"]').trigger('click')

    expect(mockSendResponse).toHaveBeenCalledTimes(1)
    // 未送达：请求保留（连接恢复后同 requestId 重发幂等），卡仍在场
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)

    mockSendResponse.mockReturnValueOnce(true)
    await wrapper.get('[data-testid="mobile-form-submit"]').trigger('click')
    expect(mockSendResponse).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
  })

  it('scheduleCreate draft 帧 → 草稿摘要 + 一键确认回传扁平 ScheduleFormResult JSON', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest({
      form: true,
      scheduleCreate: true,
      scheduleDraft: {
        kind: 'once',
        schedule: '30 14 2 10 *',
        prompt: '跑每日备份',
        models: ['m1'],
        name: '备份任务',
      },
    })
    await nextTick()

    // 摘要呈现（预填即确认语义）
    expect(wrapper.find('[data-testid="mobile-form-schedule-summary"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mobile-form-schedule-summary"]').text()).toContain('跑每日备份')

    await wrapper.get('[data-testid="mobile-form-submit"]').trigger('click')
    expect(mockSendResponse).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(mockSendResponse.mock.calls[0]![3] as string) as Record<string, unknown>
    expect(payload).toMatchObject({ action: 'create', kind: 'once', prompt: '跑每日备份', name: '备份任务' })
    expect(payload.expires).toBeUndefined() // once 不携带 expires
    // 扁平结果（非 FormAnswers envelope）：恰为 ScheduleFormResult 顶层键
    expect(Object.keys(payload).sort()).toEqual(['action', 'kind', 'model', 'name', 'prompt', 'schedule'].sort())
  })

  it('schedule 题无 initial（不可回显）→ 未答禁用提交 + 取消可用（请求方得 cancelled，不无限等待）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest({
      form: true,
      formQuestions: [{ type: 'schedule', question: '什么时候跑？' }],
    })
    await nextTick()

    expect(wrapper.find('[data-testid="mobile-form-schedule-not-ready"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mobile-form-submit"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="mobile-form-cancel"]').trigger('click')
    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-1', 'select', null)
  })

  it('planReview 帧 → 审批卡（自审结论）→ 批准/搁置回传 {decision} JSON（桌面 PlanReviewBar 同契约）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest({ planReview: true, selfReview: '改动范围：auth 模块' })
    await nextTick()

    expect(wrapper.find('[data-testid="mobile-plan-review"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mobile-plan-review-self-review"]').text()).toContain('auth 模块')
    // planReview 卡与 composer 并存（桌面 PlanReviewBar 行同构，不互斥）
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)

    await wrapper.get('[data-testid="mobile-plan-review-approve"]').trigger('click')
    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-1', 'select', JSON.stringify({ decision: 'approve' }))
    expect(wrapper.find('[data-testid="mobile-plan-review"]').exists()).toBe(false)

    // 搁置：第二发请求 → dismiss 决策同通道回传
    __testing.mobileExtensionBus.emit({
      kind: 'ui-request',
      sessionId: 'sid-form',
      request: { requestId: 'req-2', pluginId: '', kind: 'select', planReview: true },
    })
    await nextTick()
    await wrapper.get('[data-testid="mobile-plan-review-dismiss"]').trigger('click')
    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-2', 'select', JSON.stringify({ decision: 'dismiss' }))
  })

  it('requestId dedup：同请求重复 emit 幂等（单卡 + 单次回传）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(singleChoiceRequest())
    emitFormRequest(singleChoiceRequest())
    await nextTick()
    expect(wrapper.findAll('[data-testid="mobile-form-section"]')).toHaveLength(1)

    await wrapper.get('[data-testid="mobile-form-option-pg"]').trigger('click')
    await wrapper.get('[data-testid="mobile-form-submit"]').trigger('click')
    expect(mockSendResponse).toHaveBeenCalledTimes(1)
  })

  it('无 sid 的 ui-request 跳过（C2，渲染面依赖 session 分区）', async () => {
    wrapper = await mountChatView('sid-form')
    __testing.mobileExtensionBus.emit({
      kind: 'ui-request',
      request: { requestId: 'req-1', pluginId: '', kind: 'select', ...singleChoiceRequest() },
    })
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
  })

  it('C4 对称排除：普通 dialog 帧（无 marker）不进 form 卡（CompanionBand 领地）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest({ message: '确认执行？' })
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
  })

  it('requests-invalidated 失效摘除（turn abort / session 销毁等非 respond 终结，僵尸卡不残留）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(singleChoiceRequest())
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)

    __testing.mobileExtensionBus.emit({
      kind: 'requests-invalidated',
      sessionId: 'sid-form',
      requestIds: ['req-1'],
      reason: 'turn-aborted',
    })
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
  })

  it('切 session 快照对账：权威 pending 补挂新会话请求；切回空快照剔除（差集剔除）', async () => {
    wrapper = await mountChatView('sid-a')

    // 后台会话 sid-b 的请求实时到达（分区隔离，当前视图不渲染）
    __testing.mobileExtensionBus.emit({
      kind: 'ui-request',
      sessionId: 'sid-b',
      request: { requestId: 'req-b', pluginId: '', kind: 'select', ...singleChoiceRequest() },
    })
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)

    // 切到 sid-b：快照含该请求 → 补挂呈现（dedup 幂等，实时帧 + 快照双源单卡）
    mockGetPending.mockResolvedValueOnce([
      { sessionId: 'sid-b', requestId: 'req-b', method: 'select', ...singleChoiceRequest() } as ExtensionUIRequest,
    ])
    sessionStore.setActiveId('sid-b')
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)

    // 切回 sid-a（分区无请求）→ 视图不渲染
    sessionStore.setActiveId('sid-a')
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)

    // 再切回 sid-b：快照空（runtime 侧已清的模拟）→ 差集剔除僵尸卡
    sessionStore.setActiveId('sid-b')
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
  })

  it('断连重连（connected 边沿）触发快照对账：空快照剔除滞留请求；快照新请求补挂呈现', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(singleChoiceRequest())
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)

    // 静默重连：视图保持挂载、sessionId 不变（瞬时断连不换视图，BM5）——无 sid 变化，
    // 断连期间到达/终结的请求不可能经 sid 链路对账
    shellConnectionState.value = 'connecting'
    await nextTick()
    expect(wrapper.find('[data-testid="shell-reconnecting-banner"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)

    // 重连恢复：快照空（断连期间请求已被 pi 侧终结）→ 滞留卡差集剔除（僵尸卡假成功收口）
    shellConnectionState.value = 'connected'
    await flushPromises()
    expect(mockGetPending).toHaveBeenCalledWith('sid-form')
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)

    // 再次断连重连：快照含断连期间新到的请求 → 补挂呈现（pi 侧 select 不再挂起不可见）
    shellConnectionState.value = 'connecting'
    await nextTick()
    mockGetPending.mockResolvedValueOnce([
      { sessionId: 'sid-form', requestId: 'req-2', method: 'select', ...singleChoiceRequest() } as ExtensionUIRequest,
    ])
    shellConnectionState.value = 'connected'
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mobile-form-title"]').text()).toBe('用哪个数据库？')
  })

  it('回传失败（WS 未送达）→ 内联错误行可见（submit/cancel 双路）；重试成功收口，新请求不带旧错误', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(singleChoiceRequest())
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-respond-error"]').exists()).toBe(false)

    // 提交未送达：卡保留（可重试）+ 错误行在场（不静默）
    mockSendResponse.mockReturnValueOnce(false)
    await wrapper.get('[data-testid="mobile-form-option-pg"]').trigger('click')
    await wrapper.get('[data-testid="mobile-form-submit"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-form-respond-error"]').exists()).toBe(true)

    // 取消也未送达：错误行保持
    mockSendResponse.mockReturnValueOnce(false)
    await wrapper.get('[data-testid="mobile-form-cancel"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-form-respond-error"]').exists()).toBe(true)

    // 重试成功：卡收口（错误随请求摘除消失）
    mockSendResponse.mockReturnValueOnce(true)
    await wrapper.get('[data-testid="mobile-form-submit"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-form-respond-error"]').exists()).toBe(false)

    // 新请求到达：不带上一轮错误态（错误按 requestId 匹配渲染）
    emitFormRequest({ requestId: 'req-2', ...singleChoiceRequest() })
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-form-respond-error"]').exists()).toBe(false)
  })
})

describe('form 通道 respond 防御面（无 App 装配的通道级断言）', () => {
  beforeEach(() => {
    mockSendResponse.mockReset().mockReturnValue(true)
    mockGetPending.mockReset().mockResolvedValue([])
    __testing.resetFormRequestsForTest()
  })

  it('已终结请求的迟到应答丢弃（respond false，不送达已终结 requestId）', () => {
    const sid = ref<string | null>('sid-late')
    const { respond } = useMobileFormRequests(sid)
    __testing.mobileExtensionBus.emit({
      kind: 'ui-request',
      sessionId: 'sid-late',
      request: { requestId: 'req-1', pluginId: '', kind: 'select', ...singleChoiceRequest() },
    })
    __testing.mobileExtensionBus.emit({
      kind: 'requests-invalidated',
      sessionId: 'sid-late',
      requestIds: ['req-1'],
      reason: 'turn-aborted',
    })
    expect(respond('req-1', 'late')).toBe(false)
    expect(mockSendResponse).not.toHaveBeenCalled()
    // 无 sid 上下文：respond 直接 false（渲染面依赖 session 分区的同构防御）
    sid.value = null
    expect(respond('req-1', 'late')).toBe(false)
  })

  it('reconcileNow：sid 为空跳过快照拉取（连接恢复入口无会话上下文的防御）', () => {
    const sid = ref<string | null>(null)
    const { reconcileNow } = useMobileFormRequests(sid)
    reconcileNow()
    expect(mockGetPending).not.toHaveBeenCalled()

    // sid 就位后立即执行：以当前 sid 拉快照（连接恢复边沿的主路径）
    sid.value = 'sid-reconnect'
    reconcileNow()
    expect(mockGetPending).toHaveBeenCalledWith('sid-reconnect')
  })
})

describe('MobileFormCard 回传失败错误行（组件级 prop 渲染）', () => {
  beforeEach(() => {
    __testing.resetFormRequestsForTest()
  })

  function mountCard(props: Record<string, unknown>) {
    return mount(MobileFormCard, { global: { plugins: [i18n] }, props })
  }

  function errRequest(): ExtensionUIRequest {
    return { sessionId: 'sid-err', requestId: 'req-1', method: 'select', ...singleChoiceRequest() } as ExtensionUIRequest
  }

  it('respondFailedId 匹配当前请求 → 错误行渲染；不匹配或缺省 → 不渲染', () => {
    const matched = mountCard({ request: errRequest(), respondFailedId: 'req-1' })
    expect(matched.find('[data-testid="mobile-form-respond-error"]').exists()).toBe(true)
    matched.unmount()

    const mismatched = mountCard({ request: errRequest(), respondFailedId: 'req-other' })
    expect(mismatched.find('[data-testid="mobile-form-respond-error"]').exists()).toBe(false)
    mismatched.unmount()

    const absent = mountCard({ request: errRequest() })
    expect(absent.find('[data-testid="mobile-form-respond-error"]').exists()).toBe(false)
    absent.unmount()
  })

  it('planReview 审批卡同样承接错误行（批准/搁置同走 respond 回传通道）', () => {
    const card = mountCard({ planReview: { requestId: 'req-9' }, respondFailedId: 'req-9' })
    expect(card.find('[data-testid="mobile-plan-review-respond-error"]').exists()).toBe(true)
    card.unmount()

    const noMatch = mountCard({ planReview: { requestId: 'req-9' }, respondFailedId: 'req-other' })
    expect(noMatch.find('[data-testid="mobile-plan-review-respond-error"]').exists()).toBe(false)
    noMatch.unmount()
  })
})
