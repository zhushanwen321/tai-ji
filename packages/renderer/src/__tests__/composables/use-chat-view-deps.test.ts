/**
 * useChatViewDeps.onHandoff 忙拦截测试（review round 1 must-fix）。
 *
 * 覆盖：streaming 中点 handoff → 提前拦下（toast handoffBusy 短路，不发 RPC）；
 * 非活跃 → 正常走 handoff RPC；RPC 失败 → toast handoffFailed；
 * [RD-1#8] 文件白名单（file.search）加载失败 → console.warn 留痕（降级为空集行为不变）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-chat-view-deps.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { useChatViewDeps } from '@/composables/panel/useChatViewDeps'

// ── mock：sidebar.handoff（RPC spy）/ toast（错误 toast spy）/ useChat ──
// （u5.2 生产切换 useChatViewDeps → useSidebar，mock 同步改指——原 legacy mock 已被架空）
const handoffMock = vi.fn(() => Promise.resolve())
const toastErrorMock = vi.fn()
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ handoff: handoffMock, forkSession: vi.fn(() => Promise.resolve()) }),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock, info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ abortBash: vi.fn(), editAndResend: vi.fn() }),
}))
// [RD-1#8] 文件白名单加载（file.search）可控失败/成功
const loadFileCandidatesMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
vi.mock('@/composables/features/search/useFileSearch', () => ({
  useFileSearch: () => ({ load: loadFileCandidatesMock }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** useChatViewDeps 内含 watch（immediate，订阅 sessionId）——scope 内装配，用例末 stop 防泄漏 */
function setupDeps(sid: string): { deps: ReturnType<typeof useChatViewDeps>; stop: () => void } {
  const scope = effectScope()
  let deps!: ReturnType<typeof useChatViewDeps>
  scope.run(() => { deps = useChatViewDeps(ref(sid)) })
  return { deps, stop: () => scope.stop() }
}

/** 制造 streaming：真实 chat store 写 message_start → isActive=true */
function makeStreaming(sid: string): void {
  useChatStore().applyMessageEvent(sid, {
    type: 'message.message_start',
    payload: { sessionId: sid, messageId: 'a1' },
  })
}

describe('onHandoff streaming 忙拦截', () => {
  it('session 活跃 → toast handoffBusy 且 handoff RPC 不发出', () => {
    const sid = 's-handoff-busy'
    makeStreaming(sid)
    expect(useChatStore().isActive(sid)).toBe(true)

    const { deps, stop } = setupDeps(sid)
    deps.onHandoff(sid)

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    // i18n mock 从 zh-CN 取文案（panel.composer.handoffBusy）
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('请等待当前回复完成')
    expect(handoffMock).not.toHaveBeenCalled()
    stop()
  })

  it('session 非活跃 → 正常发 handoff RPC，无忙拦截 toast', async () => {
    const sid = 's-handoff-idle'
    const { deps, stop } = setupDeps(sid)
    deps.onHandoff(sid)
    await vi.waitFor(() => expect(handoffMock).toHaveBeenCalledWith(sid))
    expect(toastErrorMock).not.toHaveBeenCalled()
    stop()
  })

  it('handoff RPC 失败 → toast handoffFailed（含错误信息）', async () => {
    handoffMock.mockRejectedValueOnce(new Error('rpc down'))
    const sid = 's-handoff-fail'
    const { deps, stop } = setupDeps(sid)
    deps.onHandoff(sid)
    await vi.waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('rpc down')
    stop()
  })
})

describe('[RD-1#8] 文件白名单加载失败留痕（降级可见，非静默吞噬）', () => {
  it('file.search 失败 → console.warn 留痕 + 不抛错（白名单降级为空集的行为不变）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadFileCandidatesMock.mockRejectedValueOnce(new Error('file.search down'))
    const sid = 's-file-whitelist-fail'

    const { stop } = setupDeps(sid)
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())

    const first = String(warnSpy.mock.calls[0]?.[0])
    expect(first).toContain('[useChatViewDeps] file whitelist load failed for session')
    expect(first).toContain(sid)
    // 留痕携带原始错误（排障可定位）
    expect(warnSpy.mock.calls[0]?.[1]).toBeInstanceOf(Error)

    stop()
    warnSpy.mockRestore()
  })

  it('file.search 成功 → 零 warn（不污染正常流的观测信号）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadFileCandidatesMock.mockResolvedValueOnce([])

    const { stop } = setupDeps('s-file-whitelist-ok')
    await vi.waitFor(() => expect(loadFileCandidatesMock).toHaveBeenCalled())

    expect(warnSpy).not.toHaveBeenCalled()
    stop()
    warnSpy.mockRestore()
  })
})
