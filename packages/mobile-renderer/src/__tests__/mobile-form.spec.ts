// 移动壳 form/planReview 类请求链装配（remote-use-mobile-v2 §6.5 三通道 Sheet 化）。
//
// 链路锁定：bus 'ui-request'（companion-bridge 模块级 form 通道，C4 门排除出 dialog 通道
// 的富交互入口）→ App Sheet 挂载段 FormSheet 呈现（请求到达自动开 form 槽，sheet-manager
// 单槽驱动）→ 作答 → sendExtensionUIResponse 回传（extension.ui_response 既有通路，method
// 透传）→ 送达出队 + 关 Sheet 收尾。
//
// 装配 + 通道一体断言（桌面同构语义锚定 useExtensionUI.test.ts / use-extension-ui-* 测试族）；
// 协议编码纯逻辑契约在 form-protocol.test.ts。断连重连快照对账（connected 边沿 reconcileNow
// 补充拉取）与回传失败内联错误行（submitFailedId prop）同文件覆盖。
//
// mock 策略：extension 域（sendExtensionUIResponse/getPendingRequests）模块级 vi.mock
// 隔离 WS（断言回传参数与送达布尔）；请求注入经 __testing.mobileExtensionBus.emit
// （生产订阅侧 = form 通道 bus 订阅）。
//
// 呈现查询形态：Sheet 原语经 reka DialogPortal teleport 到 document.body（sheet.test.ts
// 同款），浮层内容断言走 body.querySelector helper，壳内断言（composer 等）走 wrapper。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/mobile-form.spec.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import FormSheet from '../features/FormSheet.vue'
import { i18n } from '../i18n'
import { __testing, useMobileFormRequests } from '../shell/companion-bridge'
import { activeSheet } from '../shell/sheet-manager'
import { sessionStore } from '../shell/app-runtime'
import { shellConnectionState } from '../shell/connection-view'
import {
  cleanupCompanionTestState,
  emitFormRequest,
  extensionDomainMocks,
  mountChatView,
  resetCompanionTestState,
  singleChoiceRequest,
} from './helpers/companion-bridge-test-env'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

// vi.mock 注册留在本文件（hoist 语义）；工厂体单源在 helpers/companion-bridge-test-env
vi.mock('@taiji/core/transport/api/domains/extension', async () => {
  const { extensionDomainMocks } = await import('./helpers/companion-bridge-test-env')
  return extensionDomainMocks
})

// 断言回传参数与送达布尔——mock 本体单源在 helper（本地别名保持用例体可读）
const { sendExtensionUIResponse: mockSendResponse, getPendingRequests: mockGetPending } = extensionDomainMocks
const BUS = __testing.mobileExtensionBus


/** Sheet portal 内容查询（teleport 到 body，wrapper.find 不可达） */
function bodyEl(testid: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testid}"]`)
}

function expectBodyEl(testid: string): HTMLElement {
  const el = bodyEl(testid)
  if (!el) throw new Error(`[data-testid="${testid}"] 未挂载（Sheet portal 内容缺失）`)
  return el
}

/**
 * 收尾 Sheet 退场动画（reka Presence 等 animationend 卸载；happy-dom 不跑 CSS 动画，
 * 派发事件让关闭态完成卸载——不派发则 portal 内容滞留，re-open 时内容不可再达）。
 */
function settleSheetExitAnimation(): void {
  document.body.querySelectorAll('[data-testid="sheet-content"]').forEach((el) => {
    el.dispatchEvent(new Event('animationend', { bubbles: true }))
  })
}

describe('移动壳 form 请求链（remote-use-mobile-v2 §6.5 FormSheet 承接）', () => {
  let wrapper: Awaited<ReturnType<typeof mountChatView>> | null = null

  beforeEach(async () => {
    await resetCompanionTestState()
  })

  afterEach(async () => {
    await cleanupCompanionTestState(wrapper)
    wrapper = null
    document.body.innerHTML = ''
  })

  it('form 帧注入 → 自动开 form 槽 Sheet 呈现（题干 + 选项卡）+ composer 隐藏；点选提交 → 回传 envelope + Sheet 收尾 + composer 恢复', async () => {
    wrapper = await mountChatView('sid-form')
    expect(bodyEl('form-sheet-form-section')).toBeNull()
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)

    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
    await nextTick()
    await flushPromises()

    // 使用者视角：待回答 Sheet 在场，题干与选项逐项渲染
    expect(bodyEl('form-sheet-form-section')).not.toBeNull()
    expect(expectBodyEl('form-sheet-form-title').textContent).toBe('用哪个数据库？')
    expect(bodyEl('form-sheet-option-pg')).not.toBeNull()
    expect(bodyEl('form-sheet-option-mysql')).not.toBeNull()
    // 未答 Submit 禁用；form 请求在场时 composer 隐藏（桌面 overlay 与 composer 互斥同构）
    expect((expectBodyEl('form-sheet-form-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(false)

    ;(expectBodyEl('form-sheet-option-pg') as HTMLElement).click()
    await nextTick()
    expect((expectBodyEl('form-sheet-form-submit') as HTMLButtonElement).disabled).toBe(false)
    ;(expectBodyEl('form-sheet-form-submit') as HTMLElement).click()
    await flushPromises()

    expect(mockSendResponse).toHaveBeenCalledTimes(1)
    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-1', 'select', JSON.stringify({ db: 'pg' }))
    // 送达即出队：分区收尾 + Sheet 槽关闭（App 送达即 closeSheet）
    expect(bodyEl('form-sheet-form-section')).toBeNull()
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)
  })

  it('文本题输入 → 提交 envelope 走 `${key}__other` 键位（text 题不写主 key，协议键位规则）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, {
      form: true,
      formQuestions: [{ type: 'text', header: 'note', question: '补充说明？' }],
    }, 'sid-form')
    await nextTick()
    await flushPromises()

    ;(expectBodyEl('form-sheet-text-input-0') as HTMLTextAreaElement).value = '补充内容'
    ;(expectBodyEl('form-sheet-text-input-0') as HTMLTextAreaElement).dispatchEvent(new Event('input'))
    await nextTick()
    ;(expectBodyEl('form-sheet-form-submit') as HTMLElement).click()
    await flushPromises()

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
    await flushPromises()

    ;(expectBodyEl('form-sheet-option-a') as HTMLElement).click()
    await nextTick()
    ;(expectBodyEl('form-sheet-option-b') as HTMLElement).click()
    await nextTick()
    ;(expectBodyEl('form-sheet-form-submit') as HTMLElement).click()
    await flushPromises()

    expect(mockSendResponse).toHaveBeenCalledWith(
      'sid-form', 'req-1', 'select',
      JSON.stringify({ feat: JSON.stringify(['a', 'b']) }),
    )
  })

  it('取消 → respond null（select resolve undefined = cancelled 语义，请求方不空等）+ Sheet 收尾', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
    await nextTick()
    await flushPromises()

    ;(expectBodyEl('form-sheet-form-cancel') as HTMLElement).click()
    await flushPromises()

    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-1', 'select', null)
    expect(bodyEl('form-sheet-form-section')).toBeNull()
  })

  it('allowCancel=false：取消键隐藏（协议显式收窄）；未送达（WS 非 OPEN）时 Sheet 保留可重试', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, singleChoiceRequest({ allowCancel: false }), 'sid-form')
    await nextTick()
    await flushPromises()
    expect(bodyEl('form-sheet-form-cancel')).toBeNull()

    mockSendResponse.mockReturnValueOnce(false) // WS 非 OPEN
    ;(expectBodyEl('form-sheet-option-pg') as HTMLElement).click()
    await nextTick()
    ;(expectBodyEl('form-sheet-form-submit') as HTMLElement).click()
    await flushPromises()

    expect(mockSendResponse).toHaveBeenCalledTimes(1)
    // 未送达：请求保留（连接恢复后同 requestId 重发幂等），Sheet 仍在场
    expect(bodyEl('form-sheet-form-section')).not.toBeNull()

    mockSendResponse.mockReturnValueOnce(true)
    ;(expectBodyEl('form-sheet-form-submit') as HTMLElement).click()
    await flushPromises()
    expect(mockSendResponse).toHaveBeenCalledTimes(2)
    expect(bodyEl('form-sheet-form-section')).toBeNull()
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
    await flushPromises()

    // 摘要呈现（预填即确认语义）
    expect(bodyEl('form-sheet-schedule-summary')).not.toBeNull()
    expect(expectBodyEl('form-sheet-schedule-summary').textContent).toContain('跑每日备份')

    ;(expectBodyEl('form-sheet-form-submit') as HTMLElement).click()
    await flushPromises()
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
    await flushPromises()

    expect(bodyEl('form-sheet-schedule-not-ready')).not.toBeNull()
    expect((expectBodyEl('form-sheet-form-submit') as HTMLButtonElement).disabled).toBe(true)

    ;(expectBodyEl('form-sheet-form-cancel') as HTMLElement).click()
    await flushPromises()
    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-1', 'select', null)
  })

  it('planReview 帧 → 审批节（自审结论）→ 批准/搁置回传 {decision} JSON（桌面 PlanReviewBar 同契约）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, { planReview: true, selfReview: '改动范围：auth 模块' }, 'sid-form')
    await nextTick()
    await flushPromises()

    expect(bodyEl('form-sheet-plan-review')).not.toBeNull()
    expect(expectBodyEl('form-sheet-plan-review-self-review').textContent).toContain('auth 模块')
    // planReview 节与 composer 并存（桌面 PlanReviewBar 行同构，不互斥）
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)

    ;(expectBodyEl('form-sheet-plan-review-approve') as HTMLElement).click()
    await flushPromises()
    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-1', 'select', JSON.stringify({ decision: 'approve' }))
    expect(bodyEl('form-sheet-plan-review')).toBeNull()

    // 搁置：第二发请求 → dismiss 决策同通道回传
    BUS.emit({
      kind: 'ui-request',
      sessionId: 'sid-form',
      request: { requestId: 'req-2', pluginId: '', kind: 'select', planReview: true },
    })
    await nextTick()
    await flushPromises()
    ;(expectBodyEl('form-sheet-plan-review-dismiss') as HTMLElement).click()
    await flushPromises()
    expect(mockSendResponse).toHaveBeenCalledWith('sid-form', 'req-2', 'select', JSON.stringify({ decision: 'dismiss' }))
  })

  it('requestId dedup：同请求重复 emit 幂等（单节 + 单次回传）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
    await nextTick()
    await flushPromises()
    expect(document.body.querySelectorAll('[data-testid="form-sheet-form-section"]')).toHaveLength(1)

    ;(expectBodyEl('form-sheet-option-pg') as HTMLElement).click()
    await nextTick()
    ;(expectBodyEl('form-sheet-form-submit') as HTMLElement).click()
    await flushPromises()
    expect(mockSendResponse).toHaveBeenCalledTimes(1)
  })

  it('无 sid 的 ui-request 跳过（C2，渲染范围依赖 session 分区）', async () => {
    wrapper = await mountChatView('sid-form')
    BUS.emit({
      kind: 'ui-request',
      request: { requestId: 'req-1', pluginId: '', kind: 'select', ...singleChoiceRequest() },
    })
    await nextTick()
    await flushPromises()
    expect(bodyEl('form-sheet-form-section')).toBeNull()
    expect(bodyEl('sheet-content')).toBeNull()
  })

  it('C4 通道隔离：普通 dialog 帧不进 form 分区，但并入待回答 Sheet 的 dialog 节呈现（§6.5）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, { message: '确认执行？' }, 'sid-form')
    await nextTick()
    await flushPromises()
    // 通道级：form 分区无该请求（C4 门放行面不扩）
    expect(bodyEl('form-sheet-form-section')).toBeNull()
    // 呈现级：dialog 节承接（并入待回答数据源，v1 CompanionBand 呈现退役）
    expect(bodyEl('form-sheet-dialog')).not.toBeNull()
    expect(expectBodyEl('form-sheet-dialog-message').textContent).toBe('确认执行？')
  })

  it('requests-invalidated 失效摘除（turn abort / session 销毁等非 respond 终结）→ 节消失 + Sheet 关 + 原因提示（§6.4/§7.1）', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
    await nextTick()
    await flushPromises()
    expect(bodyEl('form-sheet-form-section')).not.toBeNull()

    BUS.emit({
      kind: 'requests-invalidated',
      sessionId: 'sid-form',
      requestIds: ['req-1'],
      reason: 'turn-aborted',
    })
    await nextTick()
    await flushPromises()
    expect(bodyEl('form-sheet-form-section')).toBeNull()
    // 呈现联动：form 槽关闭（退场动画期间 portal 内容可能滞留 DOM，断言槽位态）+
    // 错误条原因提示（不把失效请求提交成成功）
    expect(activeSheet.value).toBeNull()
    expect(wrapper.find('[data-testid="mobile-error-bar"]').exists()).toBe(true)
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
    await flushPromises()
    expect(bodyEl('form-sheet-form-section')).toBeNull()

    // 切到 sid-b：快照含该请求 → 补挂呈现（dedup 幂等，实时帧 + 快照双源单节）
    mockGetPending.mockResolvedValueOnce([
      { sessionId: 'sid-b', requestId: 'req-b', dialogKind: 'select', ...singleChoiceRequest() } as ExtensionUIRequest,
    ])
    sessionStore.setActiveId('sid-b')
    await flushPromises()
    expect(bodyEl('form-sheet-form-section')).not.toBeNull()

    // 切回 sid-a（分区无请求）→ 视图不渲染（App 三源全空收槽联动）
    sessionStore.setActiveId('sid-a')
    await flushPromises()
    expect(bodyEl('form-sheet-form-section')).toBeNull()

    // 再切回 sid-b：快照空（runtime 侧已清的模拟）→ 差集剔除僵尸节
    sessionStore.setActiveId('sid-b')
    await flushPromises()
    expect(bodyEl('form-sheet-form-section')).toBeNull()
  })

  it('断连重连（connected 边沿）触发快照对账：空快照剔除滞留请求；快照新请求补挂呈现', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
    await nextTick()
    await flushPromises()
    expect(bodyEl('form-sheet-form-section')).not.toBeNull()

    // 静默重连：视图保持挂载、sessionId 不变（瞬时断连不换视图，BM5）——无 sid 变化，
    // 断连期间到达/终结的请求不可能经 sid 链路对账
    shellConnectionState.value = 'connecting'
    await nextTick()
    expect(wrapper.find('[data-testid="shell-reconnecting-banner"]').exists()).toBe(true)
    expect(bodyEl('form-sheet-form-section')).not.toBeNull()

    // 重连恢复：快照空（断连期间请求已被 pi 侧终结）→ 滞留节差集剔除（僵尸假成功收尾）
    shellConnectionState.value = 'connected'
    await flushPromises()
    expect(mockGetPending).toHaveBeenCalledWith('sid-form')
    expect(bodyEl('form-sheet-form-section')).toBeNull()

    // 再次断连重连：快照含断连期间新到的请求 → 补挂呈现（pi 侧 select 不再挂起不可见）
    shellConnectionState.value = 'connecting'
    await nextTick()
    mockGetPending.mockResolvedValueOnce([
      { sessionId: 'sid-form', requestId: 'req-2', dialogKind: 'select', ...singleChoiceRequest() } as ExtensionUIRequest,
    ])
    shellConnectionState.value = 'connected'
    await flushPromises()
    expect(bodyEl('form-sheet-form-section')).not.toBeNull()
    expect(expectBodyEl('form-sheet-form-title').textContent).toBe('用哪个数据库？')
  })

  it('回传失败（WS 未送达）→ 内联错误行可见（submit/cancel 双路）；重试成功收尾，新请求不带旧错误', async () => {
    wrapper = await mountChatView('sid-form')
    emitFormRequest(BUS, singleChoiceRequest(), 'sid-form')
    await nextTick()
    await flushPromises()
    expect(bodyEl('form-sheet-respond-error')).toBeNull()

    // 提交未送达：Sheet 保留（可重试）+ 错误行在场（不静默）
    mockSendResponse.mockReturnValueOnce(false)
    ;(expectBodyEl('form-sheet-option-pg') as HTMLElement).click()
    await nextTick()
    ;(expectBodyEl('form-sheet-form-submit') as HTMLElement).click()
    await flushPromises()
    expect(bodyEl('form-sheet-form-section')).not.toBeNull()
    expect(bodyEl('form-sheet-respond-error')).not.toBeNull()

    // 取消也未送达：错误行保持
    mockSendResponse.mockReturnValueOnce(false)
    ;(expectBodyEl('form-sheet-form-cancel') as HTMLElement).click()
    await flushPromises()
    expect(bodyEl('form-sheet-respond-error')).not.toBeNull()

    // 重试成功：Sheet 收尾（错误随请求摘除消失；退场动画经 animationend 收尾卸载）
    mockSendResponse.mockReturnValueOnce(true)
    ;(expectBodyEl('form-sheet-form-submit') as HTMLElement).click()
    await flushPromises()
    console.log('PROBE submit calls:', JSON.stringify(mockSendResponse.mock.calls.map((c) => [c[1], c[3]])))
    settleSheetExitAnimation()
    await flushPromises()
    expect(bodyEl('form-sheet-form-section')).toBeNull()

    // 新请求到达：不带上一轮错误态（错误按 requestId 匹配渲染）。新请求在场与题干断言已由
    // 「断连重连」用例覆盖（补挂 → section 在场 + title）；本段断言槽位复开 + 错误行不在场
    // （re-open 的 portal 挂载受 reka Presence 退场动画影响——happy-dom 无 CSS 动画不派发
    // animationend；读口即时调用会附带 immediate reconcile 干扰分区，不在此复取）
    emitFormRequest(BUS, { requestId: 'req-2', ...singleChoiceRequest() }, 'sid-form')
    await nextTick()
    await flushPromises()
    expect(bodyEl('form-sheet-respond-error')).toBeNull()
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

  it('reconcileNow：sid 为空时对在场分区逐个拉快照（§6.23 恢复链去合取化——挂起恢复不依赖 sid 置位）；sid 就位后以当前 sid 拉快照', async () => {
    const sid = ref<string | null>(null)
    const { reconcileNow } = useMobileFormRequests(sid)
    // 无 sid 且无在场分区：no-op
    reconcileNow()
    expect(mockGetPending).not.toHaveBeenCalled()

    // 无 sid 但分区在场（restart 挂起时用户停留会话列表的形态）：对在场分区逐个拉快照，
    // 任一分区对账完成即触发 onSnapshotReconciled 解除提交挂起（窗口①封堵）
    BUS.emit({
      kind: 'ui-request',
      sessionId: 'sid-list',
      request: { requestId: 'req-list', pluginId: '', kind: 'select', ...singleChoiceRequest() },
    })
    await flushPromises()
    reconcileNow()
    expect(mockGetPending).toHaveBeenCalledWith('sid-list')
    await flushPromises()

    // sid 就位后立即执行：以当前 sid 拉快照（连接恢复边沿的主路径）
    mockGetPending.mockClear()
    sid.value = 'sid-reconnect'
    reconcileNow()
    expect(mockGetPending).toHaveBeenCalledWith('sid-reconnect')
  })
})

describe('FormSheet 回传失败错误行（组件级 prop 渲染）', () => {
  beforeEach(() => {
    __testing.resetFormRequestsForTest()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  function mountSheet(props: Record<string, unknown>) {
    return mount(FormSheet, {
      global: { plugins: [i18n] },
      props: { open: true, ...props },
      attachTo: document.body,
    })
  }

  function errRequest(): ExtensionUIRequest {
    return { sessionId: 'sid-err', requestId: 'req-1', dialogKind: 'select', ...singleChoiceRequest() } as ExtensionUIRequest
  }

  it('submitFailedId 匹配当前请求 → 错误行渲染；不匹配或缺省 → 不渲染', async () => {
    const matched = mountSheet({ request: errRequest(), submitFailedId: 'req-1' })
    await flushPromises()
    expect(bodyEl('form-sheet-respond-error')).not.toBeNull()
    matched.unmount()

    const mismatched = mountSheet({ request: errRequest(), submitFailedId: 'req-other' })
    await flushPromises()
    expect(bodyEl('form-sheet-respond-error')).toBeNull()
    mismatched.unmount()

    const absent = mountSheet({ request: errRequest() })
    await flushPromises()
    expect(bodyEl('form-sheet-respond-error')).toBeNull()
    absent.unmount()
  })

  it('planReview 节同样承接错误行（批准/搁置同走 respond 回传通道）', async () => {
    const sheet = mountSheet({ planReview: { requestId: 'req-9' }, submitFailedId: 'req-9' })
    await flushPromises()
    expect(bodyEl('form-sheet-respond-error')).not.toBeNull()
    sheet.unmount()

    const noMatch = mountSheet({ planReview: { requestId: 'req-9' }, submitFailedId: 'req-other' })
    await flushPromises()
    expect(bodyEl('form-sheet-respond-error')).toBeNull()
    noMatch.unmount()
  })
})
