/**
 * useSidebarSessionActions.onForceQuitSession 测试（sidebar 强制退出 handler）。
 *
 * 锁定：
 * - FQH1: 成功路径 → 调 sessionApi.forceQuit(id)，不 toast（UI 收敛靠 session.exited 广播，
 *         handler 不做 store 操作——与 onStopBranch 同为薄转发层）
 * - FQH2: RPC 失败 → toast error 携带 sidebar.forceQuitFailed 文案与错误信息，不抛出
 *
 * mock 策略：mock '@/api'（session.forceQuit）+ useChat + useToast；
 *   其余依赖（pinia store / i18n）走全局 setup 与真实 pinia。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-sidebar-session-actions-forcequit.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

const forceQuitMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const toastErrorMock = vi.hoisted(() => vi.fn())

vi.mock('@/api', () => ({
  session: { forceQuit: forceQuitMock },
}))

vi.mock('@/composables/features/chat/useChat', () => ({
  // clearDeferFlushRetryTimer：session-dead D3 起 createUseChat 返回面新增（onForceQuitSession
  // 成功路径清 1s 重投 timer + 失败计数），mock 面须与真实返回结构对齐；
  // clearQueueState：session-dead G1 起新增（成功路径清 pi queue_update 快照残留）
  useChat: () => ({ abort: vi.fn(), clearDeferFlushRetryTimer: vi.fn(), clearQueueState: vi.fn() }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock, success: vi.fn(), info: vi.fn() }),
}))

import { useSidebarSessionActions } from '@/composables/features/sidebar/useSidebarSessionActions'

/** 最小注入：onForceQuitSession 不消费这些依赖，stub 即可 */
function makeOptions() {
  return {
    focusedSessionId: ref<string | null>(null),
    selectSession: vi.fn(),
    restoreSession: vi.fn(),
    newSession: vi.fn(),
    goOverview: vi.fn(),
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

describe('useSidebarSessionActions.onForceQuitSession', () => {
  it('FQH1: 成功 → 调 sessionApi.forceQuit(sessionId)，无 toast', async () => {
    const actions = useSidebarSessionActions(makeOptions())

    await actions.onForceQuitSession('fq-1')

    expect(forceQuitMock).toHaveBeenCalledWith('fq-1')
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('FQH2: RPC reject → toast「强制退出失败：<msg>」，不向上抛', async () => {
    forceQuitMock.mockRejectedValueOnce(new Error('session not active'))
    const actions = useSidebarSessionActions(makeOptions())

    await expect(actions.onForceQuitSession('fq-2')).resolves.toBeUndefined()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('强制退出失败')
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('session not active')
  })
})
