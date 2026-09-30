// @vitest-environment node

/**
 * useSidebarSessionActions.onForceQuitSession 测试（sidebar 强制退出 handler）。
 *
 * 锁定：
 * - FQH1: 成功路径 → 调 sessionApi.forceQuit(id)，先置 forced-exit 意图标记（markForcedExit），
 *         不 toast（UI 收敛靠 session.exited 广播，handler 不做 store 操作——与 onStopBranch
 *         同为薄转发层）。成功路径标记按读后即清语义由 session.exited 消费方撤销，本测试
 *         不经 exited 帧，afterEach 复位防跨用例泄漏。
 * - FQH2: RPC 失败 → consumeForcedExit 撤销标记 + toast error 携带 sidebar.forceQuitFailed
 *         文案与错误信息，不抛出
 *
 * mock 策略：mock '@/api'（session.forceQuit）+ useChat + useToast；forced-exit-marks 用
 * 真实实现（标记读写对是本测试承重断言）；其余依赖（pinia store / i18n）走全局 setup 与
 * 真实 pinia。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-sidebar-session-actions-forcequit.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

const forceQuitMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const toastErrorMock = vi.hoisted(() => vi.fn())
const toastSuccessMock = vi.hoisted(() => vi.fn())
const toastInfoMock = vi.hoisted(() => vi.fn())

vi.mock('@/api', () => ({
  session: { forceQuit: forceQuitMock },
}))

// [u3c/D10] forceQuit 全量回收改走内核 drain（delivery.drain RPC）；本文件只锁 RPC 编排，
// 返回空条目集（文本回收与提示断言见 __tests__/sidebar/force-quit-queue-recovery.test.ts）
vi.mock('@/api/domains/delivery', () => ({
  delivery: { drainDelivery: vi.fn(async (sessionId: string) => ({ sessionId, entries: [] })) },
}))

vi.mock('@/composables/features/chat/useChat', () => ({
  // [u5a] 前身 clearQueueState stub（session-dead G1）已删：该 API 随 queueStates 分区退役
  useChat: () => ({ abort: vi.fn() }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock, success: toastSuccessMock, info: toastInfoMock }),
}))

import { useSidebarSessionActions } from '@/composables/features/sidebar/useSidebarSessionActions'
import { consumeForcedExit, resetForcedExitMarks } from '@/composables/effects/forced-exit-marks'

/** 最小注入：onForceQuitSession 不消费这些依赖，stub 即可 */
function makeOptions() {
  return {
    selectSession: vi.fn(),
    restoreSession: vi.fn(),
    newSession: vi.fn(),
    loadSessions: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteFolder: vi.fn(),
    assignSessionToProject: vi.fn(),
    renameOpen: ref(false),
    targetSessionId: ref(''),
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

afterEach(() => {
  // forced-exit 标记是模块级 Set：复位防跨用例泄漏（FQH1 断言本身已 consume，双保险）
  resetForcedExitMarks()
})

describe('useSidebarSessionActions.onForceQuitSession', () => {
  it('FQH1: 成功 → 调 sessionApi.forceQuit(sessionId)，播种意图标记且不被 handler 消费，无 toast', async () => {
    const actions = useSidebarSessionActions(makeOptions())

    await actions.onForceQuitSession('fq-1')

    expect(forceQuitMock).toHaveBeenCalledWith('fq-1')
    // 标记读写对：handler 进入时 markForcedExit 播种；成功路径不消费（消费归 session.exited
    // 帧的 handleSessionExited，读后即清）——consume 命中 = 播种存在且未被 handler 提前消费
    expect(consumeForcedExit('fq-1')).toBe(true)
    // FQH1「无 toast」完整面：error/success/info 三通道均不得出声（UI 收敛靠 session.exited 广播）
    expect(toastErrorMock).not.toHaveBeenCalled()
    expect(toastSuccessMock).not.toHaveBeenCalled()
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it('FQH2: RPC reject → 撤销意图标记 + toast「强制退出失败：<msg>」，不向上抛', async () => {
    forceQuitMock.mockRejectedValueOnce(new Error('session not active'))
    const actions = useSidebarSessionActions(makeOptions())

    await expect(actions.onForceQuitSession('fq-2')).resolves.toBeUndefined()

    // 标记读写对：失败路径 consumeForcedExit 撤销播种——consume 未命中 = 标记已被 handler
    // 撤销（无残留把该 session 下次意外崩溃误判为强制退出）
    expect(consumeForcedExit('fq-2')).toBe(false)
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('强制退出失败')
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('session not active')
  })
})
