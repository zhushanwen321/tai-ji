// onRuntimeUnavailable reason 分流（remote-use-mobile-v2 §6.23 断连不清表单请求，A 级）。
//
// 锁定（v1「两 reason 一律清空分区」形态已退役——时间平抑类清空改事件驱动对账）：
//   disconnect 分支 —— 网络断连，runtime 同一实例、挂起表还在：form/planReview 分区保留
//                      （重连后 reconcile 对账收敛），finalizeAllStreaming 收口照常；
//   restart 分支    —— runtime 重启，新实例挂起表已清零：分区保留（Sheet 视图不闪删）+
//                      提交挂起（suspendFormSubmissions）——重连成功后 reconcile 完成前
//                      FormSheet 提交/取消禁用（封住「旧 runtime 对已终结 requestId 静默
//                      忽略、UI 记为已提交」的假成功窗口）；恢复恒经 form 通道
//                      onSnapshotReconciled（对账完成事件，无定时器）；
//   dialog 通道     —— 两 reason 均不清（同 §6.23 分区保留语义）。
//
// 断言面：分区经 useMobileFormRequests 读口 + 挂起态经 useFormSubmitSuspended 读口 +
// FormSheet 提交按钮禁用 DOM（用户可见面）；接线位经源码断言（onRuntimeUnavailable 注入
// 体与 bootstrapTesting.handleRuntimeUnavailable 同源，mobile-shell.spec TC-8 形态）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/runtime-unavailable-form-reset.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { __testing as bootstrapTesting } from '../bootstrap'
import { __testing, isFormSubmitSuspended, useMobileFormRequests } from '../shell/companion-bridge'
import { chatStore } from '../shell/app-runtime'
import {
  cleanupCompanionTestState,
  emitFormRequest,
  mountChatView,
  resetCompanionTestState,
  singleChoiceRequest,
} from './helpers/companion-bridge-test-env'

// vi.mock 注册留在本文件（hoist 语义）；工厂体单源在 helpers/companion-bridge-test-env
vi.mock('@taiji/core/transport/api/domains/extension', async () => {
  const { extensionDomainMocks } = await import('./helpers/companion-bridge-test-env')
  return extensionDomainMocks
})

// vitest 运行时 cwd 即包根（vitest.config.ts 所在目录）
const pkgRoot = process.cwd()

describe('onRuntimeUnavailable reason 分流（§6.23）', () => {
  let wrapper: Awaited<ReturnType<typeof mountChatView>> | null = null

  beforeEach(async () => {
    await resetCompanionTestState()
  })

  afterEach(async () => {
    await cleanupCompanionTestState(wrapper)
    wrapper = null
    document.body.innerHTML = ''
  })

  it("form 帧在场 → onRuntimeUnavailable('disconnect')：分区保留（不清）+ finalizeAllStreaming 收口照常", async () => {
    wrapper = await mountChatView('sid-unavailable')
    emitFormRequest(__testing.mobileExtensionBus, singleChoiceRequest(), 'sid-unavailable')
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(false)

    const finalizeSpy = vi.spyOn(chatStore, 'finalizeAllStreaming')
    bootstrapTesting.handleRuntimeUnavailable('disconnect')
    await nextTick()

    // finalizeAllStreaming 收口不随本决策退役（在途流收尾是独立的正确行为）
    expect(finalizeSpy).toHaveBeenCalledTimes(1)
    expect(finalizeSpy).toHaveBeenCalledWith('disconnect')
    // §6.23 disconnect：分区保留——重连后 reconcile 对账收敛（视图不闪删）
    const form = useMobileFormRequests(ref('sid-unavailable'))
    expect(form.currentFormRequest.value?.requestId).toBe('req-1')
    expect(isFormSubmitSuspended()).toBe(false)
  })

  it("form 帧在场 → onRuntimeUnavailable('restart')：分区保留 + 提交挂起置位；对账完成（空快照差集剔除）后恢复 + 摘除", async () => {
    wrapper = await mountChatView('sid-unavailable')
    emitFormRequest(__testing.mobileExtensionBus, singleChoiceRequest(), 'sid-unavailable')
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(false)

    bootstrapTesting.handleRuntimeUnavailable('restart')
    await nextTick()

    // §6.23 restart：分区保留（Sheet 视图不闪删）+ 提交挂起（假成功窗口封堵）
    const form = useMobileFormRequests(ref('sid-unavailable'))
    expect(form.currentFormRequest.value?.requestId).toBe('req-1')
    expect(isFormSubmitSuspended()).toBe(true)
    // 提交/取消按钮禁用（用户可见面：restart 窗口内不可作答；Sheet 内容 portal 到 body）
    const submitBtn = document.body.querySelector('[data-testid="form-sheet-form-submit"]') as HTMLButtonElement | null
    const cancelBtn = document.body.querySelector('[data-testid="form-sheet-form-cancel"]') as HTMLButtonElement | null
    expect(submitBtn).not.toBeNull()
    expect(submitBtn?.disabled).toBe(true)
    expect(cancelBtn).not.toBeNull()
    expect(cancelBtn?.disabled).toBe(true)

    // 重连成功 → reconcile 空快照（runtime 重启后挂起表已清零的模拟）→ 差集剔除 + 恢复提交
    const { extensionDomainMocks } = await import('./helpers/companion-bridge-test-env')
    extensionDomainMocks.getPendingRequests.mockResolvedValueOnce([])
    form.reconcileNow()
    await flushPromises()

    expect(form.currentFormRequest.value).toBeUndefined()
    expect(isFormSubmitSuspended()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)
  })

  it("restart 后 reconcile 快照仍含该请求 → 补回呈现 + 提交恢复（runtime 同一 requestId 语义延续）", async () => {
    wrapper = await mountChatView('sid-unavailable')
    emitFormRequest(__testing.mobileExtensionBus, singleChoiceRequest(), 'sid-unavailable')
    await nextTick()
    bootstrapTesting.handleRuntimeUnavailable('restart')
    await nextTick()
    expect(isFormSubmitSuspended()).toBe(true)

    // 重连对账：快照仍含该请求（请求方仍挂起）→ 补回 + 恢复提交
    const form = useMobileFormRequests(ref('sid-unavailable'))
    const { extensionDomainMocks } = await import('./helpers/companion-bridge-test-env')
    extensionDomainMocks.getPendingRequests.mockResolvedValueOnce([
      { sessionId: 'sid-unavailable', requestId: 'req-1', dialogKind: 'select', ...singleChoiceRequest() },
    ] as never)
    form.reconcileNow()
    await flushPromises()

    expect(form.currentFormRequest.value?.requestId).toBe('req-1')
    expect(isFormSubmitSuspended()).toBe(false)
  })

  it("planReview 审批帧在场 → onRuntimeUnavailable('restart')：分区保留 + 挂起；恢复路径同源", async () => {
    wrapper = await mountChatView('sid-unavailable')
    emitFormRequest(__testing.mobileExtensionBus, { planReview: true, selfReview: '自审结论' }, 'sid-unavailable')
    await nextTick()

    bootstrapTesting.handleRuntimeUnavailable('restart')
    await nextTick()

    const form = useMobileFormRequests(ref('sid-unavailable'))
    expect(form.currentPlanReviewRequest.value?.requestId).toBe('req-1')
    expect(isFormSubmitSuspended()).toBe(true)

    // 恢复：快照仍含 → 补回 + 解除挂起
    const { extensionDomainMocks } = await import('./helpers/companion-bridge-test-env')
    extensionDomainMocks.getPendingRequests.mockResolvedValueOnce([
      { sessionId: 'sid-unavailable', requestId: 'req-1', dialogKind: 'select', planReview: true, selfReview: '自审结论' },
    ] as never)
    form.reconcileNow()
    await flushPromises()
    expect(form.currentPlanReviewRequest.value?.requestId).toBe('req-1')
    expect(isFormSubmitSuspended()).toBe(false)
  })

  it('未触达分区时调用幂等（两 reason 均不抛错）', async () => {
    wrapper = await mountChatView('sid-unavailable')
    expect(() => bootstrapTesting.handleRuntimeUnavailable('disconnect')).not.toThrow()
    expect(() => bootstrapTesting.handleRuntimeUnavailable('restart')).not.toThrow()
    expect(useMobileFormRequests(ref('sid-unavailable')).currentFormRequest.value).toBeUndefined()
  })

  it('接线位同源：setConnectionPorts 注入的 onRuntimeUnavailable 与 bootstrapTesting.handleRuntimeUnavailable 是同一函数', () => {
    // readFileSync 源码断言（mobile-shell.spec TC-8 形态）：注入体是模块级函数引用而非内联
    // 箭头——测试触达的 bootstrapTesting.handleRuntimeUnavailable 即生产注入体；§6.23 分流
    // 在注入体内（restart → suspendFormSubmissions）
    const source = readFileSync(resolve(pkgRoot, 'src/bootstrap.ts'), 'utf-8')
    expect(source).toMatch(/onRuntimeUnavailable: handleRuntimeUnavailable/)
    expect(source).toMatch(/finalizeAllStreaming\(reason\)[\s\S]*?if \(reason === 'restart'\) suspendFormSubmissions\(\)/)
  })
})
