// onRuntimeUnavailable reason 分流（remote-use-mobile-v2 §6.23 断连不清表单请求，A 级）。
//
// 锁定（v1「两 reason 一律清空分区」形态已退役——时间平抑类清空改事件驱动对账）：
//   disconnect 分支 —— 网络断连，runtime 同一实例、挂起表还在：form/planReview 分区保留
//                      （重连后 reconcile 对账收敛），finalizeAllStreaming 收口照常；
//   restart 分支    —— runtime 重启，新实例挂起表已清零：分区保留（Sheet 视图不闪删）+
//                      提交挂起（suspendFormSubmissions）——重连成功后 reconcile 完成前
//                      FormSheet 的 form/planReview 节提交/取消禁用（封住「旧 runtime 对
//                      已终结 requestId 静默忽略、UI 记为已提交」的假成功窗口）；恢复恒经
//                      form 通道 onSnapshotReconciled（对账完成事件，无定时器）。恢复链
//                      去合取化：挂起解除不依赖 activeSessionId 置位（reconcileNow 全分区
//                      对账）、RPC 失败重试一轮 + 耗尽置错误条可见反馈、dialog 节禁答与
//                      form 通道恢复事件解耦（FormSheet 组件级测试）；
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
import { errorBarMessage } from '../shell/error-bar'
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

  it('restart 后无活跃会话（用户停留会话列表）→ 全分区对账仍解除挂起（§6.23 恢复链去合取化·窗口①）', async () => {
    // 无 App 挂载：form 通道订阅是模块级的，挂起链经读口断言（activeSessionId 保持 null）
    emitFormRequest(__testing.mobileExtensionBus, singleChoiceRequest(), 'sid-list')
    await nextTick()
    bootstrapTesting.handleRuntimeUnavailable('restart')
    await nextTick()
    expect(isFormSubmitSuspended()).toBe(true)

    // 重连对账（connected 边沿的 reconcileNow）：sid 为 null 时对在场分区逐个拉快照——
    // onSnapshotReconciled 可达 → 挂起解除（此前 sid 守卫使 reconcile 整体跳过 = 永久挂起）
    const { extensionDomainMocks } = await import('./helpers/companion-bridge-test-env')
    extensionDomainMocks.getPendingRequests.mockResolvedValueOnce([])
    const form = useMobileFormRequests(ref(null))
    form.reconcileNow()
    await flushPromises()

    expect(extensionDomainMocks.getPendingRequests).toHaveBeenCalledWith('sid-list')
    expect(isFormSubmitSuspended()).toBe(false)
    // 空快照差集剔除：僵尸条目同步修剪（restart 后 runtime 挂起表已清零的形态）；
    // 以 sid 读口断言（ref(null) 读口恒 undefined，断言不了分区）
    expect(useMobileFormRequests(ref('sid-list')).currentFormRequest.value).toBeUndefined()
  })

  it('restart 后对账 RPC 失败：立即重试一轮，耗尽置错误条可见反馈；连接恢复再对账后解除挂起（窗口②）', async () => {
    emitFormRequest(__testing.mobileExtensionBus, singleChoiceRequest(), 'sid-retry')
    await nextTick()
    bootstrapTesting.handleRuntimeUnavailable('restart')
    await nextTick()
    expect(isFormSubmitSuspended()).toBe(true)

    // 恒拒绝：factory 内立即重试一轮（初次 + 重试共 2 次 RPC）→ 耗尽经 onReconcileFailed
    // 置错误条（不静默停在 console.warn）；对账未完成 → 挂起保持
    const { extensionDomainMocks } = await import('./helpers/companion-bridge-test-env')
    extensionDomainMocks.getPendingRequests.mockRejectedValue(new Error('rpc down'))
    const form = useMobileFormRequests(ref(null))
    form.reconcileNow()
    await vi.waitFor(() => expect(errorBarMessage.value).not.toBeNull())
    expect(
      extensionDomainMocks.getPendingRequests.mock.calls.filter((c) => c[0] === 'sid-retry'),
    ).toHaveLength(2)
    expect(isFormSubmitSuspended()).toBe(true)

    // 连接恢复（重连边沿再次对账）：快照成功 → 挂起解除（事件驱动重试）
    extensionDomainMocks.getPendingRequests.mockReset().mockResolvedValue([])
    form.reconcileNow()
    await flushPromises()
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
