// runtime-unavailable 断连收口清空 form/planReview 挂起分区（MF-1-3，对齐桌面
// useMessageEffects.handleRuntimeUnavailable 双收口形态）。
//
// 锁定：bootstrap 的 onRuntimeUnavailable 在 finalizeAllStreaming（B2 现有断连流收口不变）
// 之后清空 form/planReview 分区（clearAllFormRequests）——runtime 崩溃/重启用尽后移动壳
// 分区不再保留条目，屏上僵尸 form 卡消失（B1），WS 重连窗口内不再出现「提交假成功」。
// dialog 通道 queue 不在此范围（两壳一致不清，B3 exited 分通道重置语义不变、另测）。
//
// 断言面：分区经 useMobileFormRequests 读口（currentFormRequest/currentPlanReviewRequest
// 派生）+ MobileFormCard DOM 消失（用户可见面）；接线位经源码断言（onRuntimeUnavailable
// 注入体与 bootstrapTesting.handleRuntimeUnavailable 同源，mobile-shell.spec TC-8 readFileSync 形态）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/runtime-unavailable-form-reset.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { nextTick, ref } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { __testing as bootstrapTesting } from '../bootstrap'
import { __testing, useMobileFormRequests } from '../shell/companion-bridge'
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
    // readFileSync 源码断言（mobile-shell.spec TC-8 形态）：注入体是模块级函数引用而非内联
    // 箭头——测试触达的 bootstrapTesting.handleRuntimeUnavailable 即生产注入体
    const source = readFileSync(resolve(pkgRoot, 'src/bootstrap.ts'), 'utf-8')
    expect(source).toMatch(/onRuntimeUnavailable: handleRuntimeUnavailable/)
    expect(source).toMatch(/finalizeAllStreaming\(reason\)[\s\S]*clearAllFormRequests\(\)/)
  })
})
