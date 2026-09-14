/**
 * useMessageBusSubscription —— re-export shim 单元测试（wave:renderer-rebuild-v2 W2, T3）。
 *
 * SSOT 已迁入 @xyz-agent/core（core/coordination/subscription-state.ts，w1 落地），
 * 本文件不再保留本地实现（原 TC1-TC7 行为测试已随实现迁往 core 侧，
 * 见 packages/core/src/coordination/subscription-state.test.ts 与 route-inbound.test.ts）。
 *
 * shim 的正确锁定形态 = 引用恒等 + 防御冒烟（行为断言 S2/S3/S4 与 core 侧用例 ①③④⑤
 * 逐一重复，已删——行为回归由 core 测试承担）：
 * - S3a: 未注入端口防御路径（排他时序：必须在任何 setSubscriptionPorts 之前执行）
 * - S1: 5 个函数导出 === core 同引用（防 shim 退化成本地复制造成双 Map 单例漂移）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useMessageBusSubscription.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as core from '@xyz-agent/core'

import {
  subscribeSession,
  getSubscriptionState,
  clearSubscription,
  updateLastSeenSeq,
  resetSubscriptionStates,
} from '@/composables/useMessageBusSubscription'

beforeEach(() => {
  resetSubscriptionStates()
  vi.clearAllMocks()
})

describe('S3a: 未注入端口防御路径（必须在任何 setSubscriptionPorts 之前执行，core 模块级注入状态泄漏）', () => {
  it('subscribeSession 不抛、console.warn 提示端口未注入', async () => {
    // 不调用 setSubscriptionPorts（保持未注入状态）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(subscribeSession('s1')).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain('ports not injected')
    expect(getSubscriptionState('s1')).toBeUndefined()
    warnSpy.mockRestore()
  })
})

describe('S1: shim 5 导出 === core 同引用（纯转发，无本地实现）', () => {
  it('subscribeSession / getSubscriptionState / clearSubscription / updateLastSeenSeq / resetSubscriptionStates 均直接转发', () => {
    expect(subscribeSession).toBe(core.subscribeSession)
    expect(getSubscriptionState).toBe(core.getSubscriptionState)
    expect(clearSubscription).toBe(core.clearSubscription)
    expect(updateLastSeenSeq).toBe(core.updateLastSeenSeq)
    expect(resetSubscriptionStates).toBe(core.resetSubscriptionStates)
  })
})
