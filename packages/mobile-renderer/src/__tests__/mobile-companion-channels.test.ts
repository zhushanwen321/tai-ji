import App from '../App.vue';
import { __testing as bootstrapTesting } from '../bootstrap';
import { i18n } from '../i18n';
import { chatStore, sessionStore } from '../shell/app-runtime';
import { __testing, resetCompanionChannelsForExitedSession, useMobileFormRequests, useMobilePermissionRequest } from '../shell/companion-bridge';
import { shellConnectionState } from '../shell/connection-view';
import MobileFormCard from '../views/MobileFormCard.vue';
import { cleanupCompanionTestState, emitFormRequest, extensionDomainMocks, mountChatView, resetCompanionTestState, singleChoiceRequest } from './helpers/companion-bridge-test-env';
import { registerSessionCleanup } from '@taiji/core/foundation/use-session-scoped-state';
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← mobile-form.spec.ts
// ======================================================================

// vi.mock 注册留在本文件（hoist 语义）；工厂体单源在 helpers/companion-bridge-test-env
vi.mock('@taiji/core/transport/api/domains/extension', async () => {
  const { extensionDomainMocks } = await import('./helpers/companion-bridge-test-env')
  return extensionDomainMocks
})

// 断言回传参数与送达布尔——mock 本体单源在 helper（本地别名保持用例体可读）
const { sendExtensionUIResponse: mockSendResponse, getPendingRequests: mockGetPending } = extensionDomainMocks
const BUS = __testing.mobileExtensionBus

describe('移动壳 form 请求链（remote-use-mobile D7 form 行恢复）', () => {
  let wrapper: Awaited<ReturnType<typeof mountChatView>> | null = null

  beforeEach(async () => {
    await resetCompanionTestState()
  })

  afterEach(async () => {
    await cleanupCompanionTestState(wrapper)
    wrapper = null
  })

  it('form 帧注入 → 表单卡呈现（题干 + 选项卡）+ composer 隐藏；点选提交 → 回传 envelope + 卡收尾 + composer 恢复', async () => {
    wrapper = await mountChatView('sid-form')
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)

    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
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
    // 送达即出队：卡收尾 + composer 恢复
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)
  })

  it('文本题输入 → 提交 envelope 走 `${key}__other` 键位（text 题不写主 key，协议键位规则）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, {
      form: true,
      formQuestions: [{ type: 'text', header: 'note', question: '补充说明？' }],
    }, 'sid-form')
    await nextTick()

    await wrapper.get('[data-testid="mobile-form-text-input-0"]').setValue('补充内容')
    await wrapper.get('[data-testid="mobile-form-submit"]').trigger('click')

    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-1', 'select', JSON.stringify({ note__other: '补充内容' }))
  })

  it('多选提交：envelope 多选序列化为 JSON 数组（label 即选中值）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, {
      form: true,
      formQuestions: [
        { type: 'choice', header: 'feat', question: '要哪些功能？', multi: true, options: [{ label: 'a' }, { label: 'b' }] },
      ],
    }, 'sid-form')
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
    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
    await nextTick()

    await wrapper.get('[data-testid="mobile-form-cancel"]').trigger('click')

    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-1', 'select', null)
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
  })

  it('allowCancel=false：取消键隐藏（协议显式收窄）；未送达（WS 非 OPEN）时卡保留可重试', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, singleChoiceRequest({ allowCancel: false }), 'sid-form')
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
    emitFormRequest(BUS, {
      form: true,
      scheduleCreate: true,
      scheduleDraft: {
        kind: 'once',
        schedule: '30 14 2 10 *',
        prompt: '跑每日备份',
        models: ['m1'],
        name: '备份任务',
      },
    }, 'sid-form')
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
    emitFormRequest(BUS, {
      form: true,
      formQuestions: [{ type: 'schedule', question: '什么时候跑？' }],
    }, 'sid-form')
    await nextTick()

    expect(wrapper.find('[data-testid="mobile-form-schedule-not-ready"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mobile-form-submit"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="mobile-form-cancel"]').trigger('click')
    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-1', 'select', null)
  })

  it('planReview 帧 → 审批卡（自审结论）→ 批准/搁置回传 {decision} JSON（桌面 PlanReviewBar 同契约）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, { planReview: true, selfReview: '改动范围：auth 模块' }, 'sid-form')
    await nextTick()

    expect(wrapper.find('[data-testid="mobile-plan-review"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mobile-plan-review-self-review"]').text()).toContain('auth 模块')
    // planReview 卡与 composer 并存（桌面 PlanReviewBar 行同构，不互斥）
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)

    await wrapper.get('[data-testid="mobile-plan-review-approve"]').trigger('click')
    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-1', 'select', JSON.stringify({ decision: 'approve' }))
    expect(wrapper.find('[data-testid="mobile-plan-review"]').exists()).toBe(false)

    // 搁置：第二发请求 → dismiss 决策同通道回传
    BUS.emit({
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
    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
    await nextTick()
    expect(wrapper.findAll('[data-testid="mobile-form-section"]')).toHaveLength(1)

    await wrapper.get('[data-testid="mobile-form-option-pg"]').trigger('click')
    await wrapper.get('[data-testid="mobile-form-submit"]').trigger('click')
    expect(mockSendResponse).toHaveBeenCalledTimes(1)
  })

  it('无 sid 的 ui-request 跳过（C2，渲染范围依赖 session 分区）', async () => {
    wrapper = await mountChatView('sid-form')
    BUS.emit({
      kind: 'ui-request',
      request: { requestId: 'req-1', pluginId: '', kind: 'select', ...singleChoiceRequest() },
    })
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
  })

  it('C4 对称排除：普通 dialog 帧（无 marker）不进 form 卡（CompanionBand 领地）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, { message: '确认执行？' }, 'sid-form')
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
  })

  it('requests-invalidated 失效摘除（turn abort / session 销毁等非 respond 终结，僵尸卡不残留）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)

    BUS.emit({
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
    BUS.emit({
      kind: 'ui-request',
      sessionId: 'sid-b',
      request: { requestId: 'req-b', pluginId: '', kind: 'select', ...singleChoiceRequest() },
    })
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)

    // 切到 sid-b：快照含该请求 → 补挂呈现（dedup 幂等，实时帧 + 快照双源单卡）
    mockGetPending.mockResolvedValueOnce([
      { sessionId: 'sid-b', requestId: 'req-b', dialogKind: 'select', ...singleChoiceRequest() } as ExtensionUIRequest,
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
    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)

    // 静默重连：视图保持挂载、sessionId 不变（瞬时断连不换视图，BM5）——无 sid 变化，
    // 断连期间到达/终结的请求不可能经 sid 链路对账
    shellConnectionState.value = 'connecting'
    await nextTick()
    expect(wrapper.find('[data-testid="shell-reconnecting-banner"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)

    // 重连恢复：快照空（断连期间请求已被 pi 侧终结）→ 滞留卡差集剔除（僵尸卡假成功收尾）
    shellConnectionState.value = 'connected'
    await flushPromises()
    expect(mockGetPending).toHaveBeenCalledWith('sid-form')
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)

    // 再次断连重连：快照含断连期间新到的请求 → 补挂呈现（pi 侧 select 不再挂起不可见）
    shellConnectionState.value = 'connecting'
    await nextTick()
    mockGetPending.mockResolvedValueOnce([
      { sessionId: 'sid-form', requestId: 'req-2', dialogKind: 'select', ...singleChoiceRequest() } as ExtensionUIRequest,
    ])
    shellConnectionState.value = 'connected'
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mobile-form-title"]').text()).toBe('用哪个数据库？')
  })

  it('回传失败（WS 未送达）→ 内联错误行可见（submit/cancel 双路）；重试成功收尾，新请求不带旧错误', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
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

    // 重试成功：卡收尾（错误随请求摘除消失）
    mockSendResponse.mockReturnValueOnce(true)
    await wrapper.get('[data-testid="mobile-form-submit"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-form-respond-error"]').exists()).toBe(false)

    // 新请求到达：不带上一轮错误态（错误按 requestId 匹配渲染）
    emitFormRequest(BUS, { requestId: 'req-2', ...singleChoiceRequest() }, 'sid-form')
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-form-respond-error"]').exists()).toBe(false)
  })
})

describe('form 通道 respond 防御机制（无 App 装配的通道级断言）', () => {
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
    // 无 sid 上下文：respond 直接 false（渲染范围依赖 session 分区的同构防御）
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
    return { sessionId: 'sid-err', requestId: 'req-1', dialogKind: 'select', ...singleChoiceRequest() } as ExtensionUIRequest
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

// ======================================================================
// ← runtime-unavailable-form-reset.test.ts
// ======================================================================


// vitest 运行时 cwd 即包根（vitest.config.ts 所在目录）
const pkgRoot = process.cwd()

describe('onRuntimeUnavailable 清空 form/planReview 挂起分区（MF-1-3）', () => {
  let wrapper: Awaited<ReturnType<typeof mountChatView>> | null = null

  beforeEach(async () => {
    await resetCompanionTestState()
  })

  afterEach(async () => {
    await cleanupCompanionTestState(wrapper)
    wrapper = null
  })

  it("form 帧在场 → onRuntimeUnavailable('disconnect')：分区清空（B1）+ 卡消失（B1）+ finalizeAllStreaming 收口照常（B2）", async () => {
    wrapper = await mountChatView('sid-unavailable')
    emitFormRequest(__testing.mobileExtensionBus, singleChoiceRequest(), 'sid-unavailable')
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-card"]').exists()).toBe(true)

    const finalizeSpy = vi.spyOn(chatStore, 'finalizeAllStreaming')
    bootstrapTesting.handleRuntimeUnavailable('disconnect')
    await nextTick()

    // B2：断连流收口先落（streaming 终态化不被本修复削弱）
    expect(finalizeSpy).toHaveBeenCalledTimes(1)
    expect(finalizeSpy).toHaveBeenCalledWith('disconnect')
    // B1：分区清空（读口派生面）+ 屏上僵尸 form 卡消失（用户可见面）
    const form = useMobileFormRequests(ref('sid-unavailable'))
    expect(form.currentFormRequest.value).toBeUndefined()
    expect(form.currentPlanReviewRequest.value).toBeUndefined()
    expect(wrapper.find('[data-testid="mobile-form-card"]').exists()).toBe(false)
  })

  it('planReview 审批帧在场 → onRuntimeUnavailable：审批分区清空 + 审批卡消失（B1）', async () => {
    wrapper = await mountChatView('sid-unavailable')
    emitFormRequest(__testing.mobileExtensionBus, { planReview: true, selfReview: '自审结论' }, 'sid-unavailable')
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-plan-review"]').exists()).toBe(true)

    bootstrapTesting.handleRuntimeUnavailable('restart')
    await nextTick()

    const form = useMobileFormRequests(ref('sid-unavailable'))
    expect(form.currentPlanReviewRequest.value).toBeUndefined()
    expect(wrapper.find('[data-testid="mobile-plan-review"]').exists()).toBe(false)
  })

  it('未触达分区但已清空：分区为空时调用幂等（断连收口无条件收口，不抛错）', async () => {
    wrapper = await mountChatView('sid-unavailable')
    expect(() => bootstrapTesting.handleRuntimeUnavailable('disconnect')).not.toThrow()
    expect(useMobileFormRequests(ref('sid-unavailable')).currentFormRequest.value).toBeUndefined()
  })

  it('接线位同源：setConnectionPorts 注入的 onRuntimeUnavailable 与 bootstrapTesting.handleRuntimeUnavailable 是同一函数', () => {
    // readFileSync 源码断言（mobile-shell-integration.test.ts TC-8 形态）：注入体是模块级函数引用而非内联
    // 箭头——测试触达的 bootstrapTesting.handleRuntimeUnavailable 即生产注入体
    const source = readFileSync(resolve(pkgRoot, 'src/bootstrap.ts'), 'utf-8')
    expect(source).toMatch(/onRuntimeUnavailable: handleRuntimeUnavailable/)
    expect(source).toMatch(/finalizeAllStreaming\(reason\)[\s\S]*clearAllFormRequests\(\)/)
  })
})

// ======================================================================
// ← companion-exited-reset.spec.ts
// ======================================================================

// （extension domain mock 注册见文件顶部：同路径重复注册无行为差异，删重复块）

const SID = 'sid-u6-exited'

/** 发一条 bridge 归一后的 dialog 类 ui-request（confirm 形态；mobile-shell-integration.test.ts 同款） */
function emitDialogRequest(sessionId: string, requestId: string): void {
  __testing.mobileExtensionBus.emit({
    kind: 'ui-request',
    sessionId,
    request: {
      requestId,
      pluginId: 'tasks',
      kind: 'confirm',
      method: 'confirm',
      title: `确认执行？(${requestId})`,
      message: '该操作将应用变更',
    },
  })
}

/** 发一条 form 类 ui-request（C4 放行范围，form 帧；载荷单源 helpers singleChoiceRequest） */
function emitLocalFormRequest(sessionId: string, requestId: string): void {
  __testing.mobileExtensionBus.emit({
    kind: 'ui-request',
    sessionId,
    request: {
      requestId,
      pluginId: '',
      kind: 'select',
      method: 'select',
      ...singleChoiceRequest(),
    },
  })
}

describe('移动壳 exited 分通道重置编排（U6）', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(async () => {
    await resetCompanionTestState()
  })

  afterEach(async () => {
    await cleanupCompanionTestState(wrapper)
    wrapper = null
  })

  it('exited 编排：dialog band 与 form 卡两通道各被清理（composer 恢复），未调 triggerSessionCleanups（canary 不触发）', async () => {
    wrapper = await mountChatView(SID)
    emitDialogRequest(SID, 'req-u6-dialog')
    emitLocalFormRequest(SID, 'req-u6-form')
    await nextTick()
    // 前置：两通道请求均在场（dialog band + form 卡）
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(false)

    // 销毁语义 canary：若编排误走 triggerSessionCleanups，注册表全部回调（含 canary）
    // 都会被触发——本断言把「未调销毁语义」从代码审查约定变成行为断言
    const canary = vi.fn()
    registerSessionCleanup(canary)

    resetCompanionChannelsForExitedSession(SID)
    await nextTick()

    // dialog 通道：band 消失（queue.resetFor 清空分区，句柄登记通路生效）
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(false)
    // form 通道：form 卡消失、composer 恢复（Map 具名清理直调）
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)
    // 销毁语义未触发
    expect(canary).not.toHaveBeenCalled()
  })

  it('重置非销毁（V18 负面变体）：exited 重置后同 sid 新 dialog 请求立即可见可作答（无 deletedSids 拦截）', async () => {
    wrapper = await mountChatView(SID)
    emitDialogRequest(SID, 'req-u6-old')
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band-title"]').text()).toBe('确认执行？(req-u6-old)')

    // exited 重置（崩溃窗口：pi 死亡 → 旧请求清场）
    resetCompanionChannelsForExitedSession(SID)
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(false)

    // 会话恢复后新请求（新 pi 进程、新 requestId）：若误用销毁语义（deletedSids 记入），
    // 入队被 updateFor 首行拦截 → band 不出现，本断言红；重置语义下立即可见
    emitDialogRequest(SID, 'req-u6-post-restore')
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-band-title"]').text()).toBe('确认执行？(req-u6-post-restore)')
    // 可作答（确认按钮在场）
    expect(wrapper.find('[data-testid="companion-confirm-ok"]').exists()).toBe(true)
  })

  it('form 通道重置后新请求同样可达（清理直调不引入跨通道拦截）', async () => {
    wrapper = await mountChatView(SID)
    emitLocalFormRequest(SID, 'req-u6-form-old')
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)

    resetCompanionChannelsForExitedSession(SID)
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)

    emitLocalFormRequest(SID, 'req-u6-form-new')
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)
  })
})

// ======================================================================
// ← mobile-permission.spec.ts
// ======================================================================

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { mockApprove, mockDeny } = vi.hoisted(() => ({ mockApprove: vi.fn(), mockDeny: vi.fn() }))

vi.mock('@taiji/core/transport/api/domains/plugin', () => ({
  approvePermissions: mockApprove,
  denyPermissions: mockDeny,
}))

// Dialog 家族 stub：内联渲染 slot，尊重 open（pending=false 时不渲染内容）
const dialogStubs = {
  Dialog: { props: ['open'], template: '<div><slot v-if="open" /></div>' },
  DialogContent: { template: '<div><slot /></div>' },
  DialogHeader: { template: '<div><slot /></div>' },
  DialogTitle: { template: '<div><slot /></div>' },
  DialogDescription: { template: '<div><slot /></div>' },
}

function mountApp() {
  return mount(App, { global: { plugins: [i18n], stubs: dialogStubs } })
}

/** 发一条 bridge 归一后的合法 permission-request 事件（sessionId 可选，协议性缺省） */
function emitPermissionRequest(pluginId: string, permissions: string[], sessionId?: string): void {
  __testing.mobileExtensionBus.emit({
    kind: 'plugin-permission-request',
    ...(sessionId !== undefined ? { sessionId } : {}),
    request: { pluginId, permissions, requestId: `perm_${pluginId}` },
  })
}

describe('移动壳权限审批链装配（remote-use-mobile D7「权限审批 ✅ 手机可批」行）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(() => {
    mockApprove.mockReset().mockResolvedValue(undefined)
    mockDeny.mockReset().mockResolvedValue(undefined)
    // 模块级弹窗单例复位（跨用例隔离；pending/error 残留会让后续用例误判弹窗来源）
    const perm = useMobilePermissionRequest()
    perm.pending = false
    perm.pluginId = ''
    perm.permissions = []
    perm.error = false
    shellConnectionState.value = 'connecting'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    shellConnectionState.value = 'connecting'
  })

  it('bus 事件 → 弹窗渲染（插件名 + 权限项）→ 部分批准 → transport 回传参数正确 → pending 收尾关弹窗', async () => {
    wrapper = mountApp()
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(false)

    emitPermissionRequest('p1', ['fs.read', 'net.http'], 'sid-a')
    await nextTick()

    // 使用者视角：弹窗可见、插件名与权限项逐项渲染
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="permission-dialog-title"]').text()).toBe('p1')
    const items = wrapper.findAll('[data-testid="permission-item-label"]')
    expect(items).toHaveLength(2)
    expect(items[0]!.text()).toBe('fs.read')
    expect(items[1]!.text()).toBe('net.http')

    // 部分批准：只勾 fs.read
    await wrapper.find('[data-testid="permission-item-fs.read"]').trigger('click')
    await wrapper.find('[data-testid="permission-approve"]').trigger('click')
    await flushPromises()

    expect(mockApprove).toHaveBeenCalledTimes(1)
    expect(mockApprove).toHaveBeenCalledWith('p1', ['fs.read'])
    expect(mockDeny).not.toHaveBeenCalled()
    // 回传成功 → pending=false → 弹窗关闭（状态收尾）
    expect(useMobilePermissionRequest().pending).toBe(false)
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(false)
  })

  it('拒绝 → transport.deny 回传（denyPermissions 命令，拒绝本次申请）→ 弹窗关闭', async () => {
    wrapper = mountApp()
    emitPermissionRequest('p2', ['fs.write'])
    await nextTick()

    await wrapper.find('[data-testid="permission-reject"]').trigger('click')
    await flushPromises()

    expect(mockDeny).toHaveBeenCalledTimes(1)
    expect(mockDeny).toHaveBeenCalledWith('p2')
    expect(mockApprove).not.toHaveBeenCalled()
    expect(useMobilePermissionRequest().pending).toBe(false)
    expect(useMobilePermissionRequest().error).toBe(false)
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(false)
  })

  it('无 sessionId 事件照常弹出（协议事实：permissionRequest 广播无 sessionId，审批全局单例）', async () => {
    wrapper = mountApp()
    emitPermissionRequest('p3', ['net.http'])
    await nextTick()

    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="permission-dialog-title"]').text()).toBe('p3')
  })
})
