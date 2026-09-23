/**
 * useSessionRespawnRetry —— crash 恢复唯一人工通路的单测（crash-resilience D7）。
 *
 * D7 熔断后 runtime 不再自动重连，用户侧唯一出口 = 提示条「重试」按钮，本 composable
 * 即该按钮的全部行为面，两条分支都必须锁住：
 * - 成功链：session.restore RPC（显式重新 spawn）→ 本地 revive 复位 dead 态，无错误 toast；
 * - 失败链：RPC reject → 异常在内部吞掉（不外抛）、不 revive（dead 态保持，侧栏置灰准确）
 *   + toast 指引（respawnRetryFailed）。
 *
 * mock 策略：@/api / @/stores/session / useToast 全 stub（与同目录 useChatViewDeps.test.ts
 * 同范式——测试目标只有编排与分支，不跑真实 store/RPC）。vue-i18n 不在此 mock：包级
 * setupFiles（vitest-i18n-setup.ts）的 t() 已从 zh-CN locale 解析，断言中文文案——key 漂移
 * 或删除会因回退返回原 key 而使断言失败，自带防漂移面。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { restoreSessionMock, reviveMock, toastErrorMock } = vi.hoisted(() => ({
  restoreSessionMock: vi.fn<(id: string) => Promise<unknown>>(),
  reviveMock: vi.fn<(id: string) => void>(),
  toastErrorMock: vi.fn<(message: string) => void>(),
}))

vi.mock('@/api', () => ({
  session: { restoreSession: (id: string) => restoreSessionMock(id) },
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ revive: reviveMock }),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock }),
}))

import { useSessionRespawnRetry } from '../useSessionRespawnRetry'

describe('useSessionRespawnRetry', () => {
  beforeEach(() => {
    restoreSessionMock.mockReset()
    reviveMock.mockReset()
    toastErrorMock.mockReset()
  })

  it('成功链：restore RPC 成功 → revive 同 sid 复位 dead 态，无错误 toast', async () => {
    restoreSessionMock.mockResolvedValue(undefined)
    const { onRespawnRetry } = useSessionRespawnRetry(() => 's1')

    await onRespawnRetry()

    expect(restoreSessionMock).toHaveBeenCalledTimes(1)
    expect(restoreSessionMock).toHaveBeenCalledWith('s1')
    expect(reviveMock).toHaveBeenCalledTimes(1)
    expect(reviveMock).toHaveBeenCalledWith('s1')
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('失败链：restore RPC reject → 不 revive + toast 指引，异常不外抛', async () => {
    restoreSessionMock.mockRejectedValue(new Error('spawn failed'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { onRespawnRetry } = useSessionRespawnRetry(() => 's1')

    await expect(onRespawnRetry()).resolves.toBeUndefined()

    expect(reviveMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith('恢复失败，请稍后重试或新建会话')
    warnSpy.mockRestore()
  })
})
